import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { HOOK_EVENTS } from './settings';
import type { HookCommand, HookEvent, HookMatcher } from './settings';

/**
 * Hook scripts in hook folders (Cline style): a file named after the event it hooks (`PreToolUse.sh`, `taskstart.py`,
 * `Stop`), matched case-insensitively with an optional script extension. Each runnable script becomes a `HookCommand`
 * for the normal `HookRunner`, so it speaks the same JSON-on-stdin / exit-code protocol as a settings.json hook.
 * On Unix a script without the executable bit is listed but not run (the Customize switch flips it). On every
 * platform a script whose name ends in `.disabled` is listed but not run; Windows has no executable bit, so the switch
 * renames the file there.
 */

export const WORKSPACE_HOOK_DIRS = ['.localpilot/hooks', '.clinerules/hooks', '.cline/hooks'];
export const USER_HOOK_DIRS = ['.localpilot/hooks', '.cline/hooks', 'Documents/Cline/Hooks'];
export const HOOK_SCRIPT_EXT = /\.(sh|bash|zsh|js|mjs|cjs|ts|py|ps1)$/i;
/** Extra hook folders, separated like PATH; the CLI's `--hooks-dir` adds to these. */
export const HOOKS_DIR_ENV = 'LOCALPILOT_HOOKS_DIR';
/** Appended to a hook script's name to switch it off (`PreToolUse.ps1.disabled`). */
export const HOOK_DISABLED_SUFFIX = '.disabled';

/** The script's name without a `.disabled` suffix. */
export function hookScriptName(fileName: string): string {
  return fileName.toLowerCase().endsWith(HOOK_DISABLED_SUFFIX) ? fileName.slice(0, -HOOK_DISABLED_SUFFIX.length) : fileName;
}

/** Cline's event names that have a LocalPilot equivalent (TaskStart / TaskResume are SessionStart with a trigger). */
const CLINE_EVENTS: Record<string, { event: HookEvent; matcher?: string }> = {
  taskstart: { event: 'SessionStart', matcher: 'startup' },
  taskresume: { event: 'SessionStart', matcher: 'resume' },
  taskcomplete: { event: 'Stop' },
};

/** The event a script file name hooks (and the SessionStart trigger it is limited to), or undefined. */
export function scriptEvent(fileName: string): { event: HookEvent; matcher?: string } | undefined {
  const base = fileName.replace(HOOK_SCRIPT_EXT, '').toLowerCase();
  const native = HOOK_EVENTS.find((e) => e.toLowerCase() === base);
  return native ? { event: native } : CLINE_EVENTS[base];
}

/** Interpreter argv for a script: its shebang, else its extension, else bash. */
export function scriptInterpreter(file: string, head: string, platform: NodeJS.Platform = process.platform): string[] {
  const first = head.split(/\r?\n/, 1)[0] ?? '';
  if (first.startsWith('#!')) {
    const parts = first.slice(2).trim().split(/\s+/).filter(Boolean);
    if (parts.length && path.posix.basename(parts[0]) === 'env') {
      parts.shift();
      while (parts[0]?.startsWith('-')) {
        parts.shift();
      }
    } else if (parts.length && platform === 'win32') {
      // `/bin/bash` does not exist there: look the program up on PATH.
      parts[0] = path.posix.basename(parts[0]);
    }
    if (parts.length) {
      return parts;
    }
  }
  const ext = path.extname(file).toLowerCase();
  switch (ext) {
    case '.js':
    case '.mjs':
    case '.cjs':
      return ['node'];
    case '.ts':
      return ['node', '--experimental-strip-types'];
    case '.py':
      return [platform === 'win32' ? 'python' : 'python3'];
    case '.ps1':
      return ['pwsh', '-NoProfile', '-File'];
    case '.zsh':
      return ['zsh'];
    default:
      return ['bash'];
  }
}

/** Quotes one argument for the shell `execHook` runs the command in (`/bin/sh` or `cmd.exe`). */
export function quoteHookArg(arg: string, platform: NodeJS.Platform = process.platform): string {
  if (/^[\w@%+=:,./\\-]+$/.test(arg)) {
    return arg;
  }
  return platform === 'win32' ? `"${arg.replace(/"/g, '""')}"` : `'${arg.replace(/'/g, `'\\''`)}'`;
}

export interface HookScript {
  file: string;
  /** File name (`PreToolUse.sh`). */
  name: string;
  scope: 'workspace' | 'global';
  /** The event it hooks; undefined = the name is not an event (listed, never run). */
  event?: HookEvent;
  /** SessionStart trigger for TaskStart / TaskResume scripts. */
  matcher?: string;
  /** Not named `….disabled` and, on Unix, has the executable bit. */
  enabled: boolean;
  /** Shell command that runs it. */
  command: string;
}

/** Hook folders to scan, workspace first; duplicates (the home folder opened as the workspace) once. */
export function hookScriptDirs(roots: string[], home = os.homedir(), extraDirs: string[] = [], env: NodeJS.ProcessEnv = process.env): { dir: string; scope: 'workspace' | 'global' }[] {
  const fromEnv = (env[HOOKS_DIR_ENV] ?? '').split(path.delimiter).map((d) => d.trim()).filter(Boolean);
  const out = [
    ...roots.flatMap((r) => WORKSPACE_HOOK_DIRS.map((d) => ({ dir: path.join(r, d), scope: 'workspace' as const }))),
    ...USER_HOOK_DIRS.map((d) => ({ dir: path.join(home, d), scope: 'global' as const })),
    ...[...extraDirs, ...fromEnv].map((d) => ({ dir: path.resolve(d), scope: 'global' as const })),
  ];
  const seen = new Set<string>();
  return out.filter((d) => !seen.has(d.dir) && !!seen.add(d.dir));
}

export async function discoverHookScripts(roots: string[], opts: { home?: string; extraDirs?: string[]; platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv } = {}): Promise<HookScript[]> {
  const platform = opts.platform ?? process.platform;
  const out: HookScript[] = [];
  const seen = new Set<string>();
  for (const { dir, scope } of hookScriptDirs(roots, opts.home, opts.extraDirs, opts.env)) {
    let names: string[];
    try {
      names = (await fs.readdir(dir)).filter((n) => !n.startsWith('.')).sort();
    } catch {
      continue;
    }
    for (const name of names) {
      const file = path.join(dir, name);
      // Symlinked scripts are followed; the same script reached twice (a linked folder) runs once.
      const st = await fs.stat(file).catch(() => undefined);
      const id = st ? `${st.dev}:${st.ino}` : file;
      if (!st?.isFile() || seen.has(id)) {
        continue;
      }
      seen.add(id);
      const bare = hookScriptName(name);
      const ev = scriptEvent(bare);
      let head = '';
      if (ev) {
        const fh = await fs.open(file, 'r').catch(() => undefined);
        if (fh) {
          try {
            const buf = Buffer.alloc(256);
            const { bytesRead } = await fh.read(buf, 0, 256, 0);
            head = buf.subarray(0, bytesRead).toString('utf8');
          } finally {
            await fh.close();
          }
        }
      }
      const command = [...scriptInterpreter(bare, head, platform), file].map((a) => quoteHookArg(a, platform)).join(' ');
      const enabled = bare === name && (platform === 'win32' || (st.mode & 0o111) !== 0);
      out.push({ file, name, scope, event: ev?.event, matcher: ev?.matcher, enabled, command });
    }
  }
  return out;
}

/** The runnable scripts as settings-style hooks (to merge with the settings.json layers). */
export function hookScriptHooks(scripts: HookScript[]): Partial<Record<HookEvent, HookMatcher[]>> {
  const out: Partial<Record<HookEvent, HookMatcher[]>> = {};
  for (const s of scripts) {
    if (!s.event || !s.enabled) {
      continue;
    }
    const hook: HookCommand = { type: 'command', command: s.command, name: s.name };
    (out[s.event] ??= []).push({ matcher: s.matcher, hooks: [hook] });
  }
  return out;
}

/** The JSON fields each event's hook receives on stdin (besides `hook_event_name` and `cwd`). */
export const HOOK_INPUT_FIELDS: Record<HookEvent, string[]> = {
  PreToolUse: ['session_id', 'tool_name', 'tool_input', 'localpilot_tool_name'],
  PostToolUse: ['session_id', 'tool_name', 'tool_input', 'tool_response', 'localpilot_tool_name'],
  UserPromptSubmit: ['session_id', 'prompt'],
  Stop: ['session_id', 'stop_hook_active', 'last_assistant_message'],
  SubagentStop: ['session_id', 'stop_hook_active', 'last_assistant_message'],
  SessionStart: ['session_id', 'source'],
  SessionEnd: ['session_id', 'reason'],
  PreCompact: ['session_id', 'trigger', 'custom_instructions'],
  Notification: ['session_id', 'message', 'notification_type'],
  TaskCancel: ['session_id'],
  TaskError: ['session_id', 'error'],
};

/**
 * A new hook script for `event`: commented, it logs the input fields to stderr and prints a response that changes
 * nothing. Bash, or PowerShell for `.ps1`.
 */
export function hookTemplate(event: string, shell: 'bash' | 'powershell'): string {
  const known = HOOK_EVENTS.find((e) => e.toLowerCase() === event.toLowerCase());
  const name = known ?? event;
  const fields = ['hook_event_name', 'cwd', ...(known ? HOOK_INPUT_FIELDS[known] : ['session_id'])];
  const block = known === 'PreToolUse' ? 'block this tool call' : known === 'UserPromptSubmit' ? 'block this prompt' : known === 'Stop' || known === 'SubagentStop' ? 'send the agent back to work' : 'block';
  if (shell === 'powershell') {
    return [
      `# LocalPilot ${name} hook. Created switched off: turn it on in Settings > Customize > Hooks (on Windows: or drop ".disabled" from the file name).`,
      '# The event arrives as one JSON object on stdin with these fields:',
      `#   ${fields.join(', ')}`,
      `# Exit 0 to go on (stdout may be a JSON response); exit 2 to ${block} (stderr is the reason given to the agent).`,
      '$payload = [Console]::In.ReadToEnd() | ConvertFrom-Json',
      'foreach ($p in $payload.PSObject.Properties) {',
      '  [Console]::Error.WriteLine("$($p.Name)=$($p.Value | ConvertTo-Json -Compress -Depth 5)")',
      '}',
      ...(known === 'PreToolUse' ? ['# Deny a tool call instead:', '# \'{"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "deny", "permissionDecisionReason": "Not allowed"}}\'; exit 0'] : []),
      `'{"continue": true}'`,
      'exit 0',
      '',
    ].join('\n');
  }
  return [
    '#!/usr/bin/env bash',
    `# LocalPilot ${name} hook. Created switched off: turn it on in Settings > Customize > Hooks (or chmod +x this file).`,
    '# The event arrives as one JSON object on stdin with these fields:',
    `#   ${fields.join(', ')}`,
    `# Exit 0 to go on (stdout may be a JSON response); exit 2 to ${block} (stderr is the reason given to the agent).`,
    'input=$(cat)',
    'if command -v jq >/dev/null 2>&1; then',
    `  printf '%s' "$input" | jq -r 'to_entries[] | "\\(.key)=\\(.value | tojson)"' >&2`,
    'else',
    `  for f in ${fields.join(' ')}; do`,
    `    printf '%s=%s\\n' "$f" "$(printf '%s' "$input" | sed -n "s/.*\\"$f\\": *\\"\\([^\\"]*\\)\\".*/\\1/p" | head -n 1)" >&2`,
    '  done',
    'fi',
    ...(known === 'PreToolUse' ? ['# Deny a tool call instead:', `# echo '{"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "deny", "permissionDecisionReason": "Not allowed"}}'; exit 0`] : []),
    `echo '{"continue": true}'`,
    'exit 0',
    '',
  ].join('\n');
}
