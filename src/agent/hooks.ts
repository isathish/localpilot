import * as cp from 'child_process';
import { HookCommand, HookEvent, HookMatcher, ProjectSettings } from './settings';

/**
 * Claude Code hooks: shell commands configured per event in settings.json. Each hook receives a JSON description of
 * the event on stdin and talks back through its exit code and stdout:
 *
 *   exit 0  — success. stdout may be JSON ({ decision, reason, continue, stopReason, systemMessage,
 *             hookSpecificOutput: { permissionDecision, permissionDecisionReason, updatedInput, additionalContext } });
 *             plain stdout is added as context for UserPromptSubmit / SessionStart and shown to the user otherwise.
 *   exit 2  — block the action (tool call, prompt, stopping); stderr is the reason fed back to the model / user.
 *   other   — non-blocking failure; stderr is logged.
 *
 * `matcher` is a regex (or exact name, `*` / empty = all) tested against the tool name for PreToolUse / PostToolUse,
 * the trigger for SessionStart (startup|resume|clear|compact) and PreCompact (manual|auto), and ignored elsewhere.
 */

export interface HookOutcome {
  /** A hook asked to block the action; `reasons` explain why. */
  block: boolean;
  reasons: string[];
  /** PreToolUse: a hook decided the permission (replaces the normal approval flow). */
  permission?: 'allow' | 'deny' | 'ask';
  /** PreToolUse: replacement tool arguments. */
  updatedInput?: Record<string, unknown>;
  /** Text to hand to the model (additionalContext, or plain stdout for prompt / session-start hooks). */
  context: string[];
  /** Text to show the user (systemMessage, plain stdout of other events). */
  messages: string[];
  /** `continue: false` — the whole run should stop after this. */
  stop?: string;
  /** Hooks that ran. */
  ran: number;
}

export interface HookRunOptions {
  cwd?: string;
  /** Value the matcher is tested against (tool name / trigger). */
  matchKey?: string;
  signal?: AbortSignal;
  /** Additional environment for the hook process. */
  env?: Record<string, string>;
}

const DEFAULT_TIMEOUT_S = 60;
const MAX_STDOUT = 50_000;

/** `*`, empty, exact name, or a regex. Tool-name matchers also accept our native name (`run_command`) for `Bash`. */
export function hookMatches(matcher: string | undefined, keys: string[]): boolean {
  const m = (matcher ?? '').trim();
  if (!m || m === '*') {
    return true;
  }
  if (keys.includes(m)) {
    return true;
  }
  try {
    const re = new RegExp(`^(?:${m})$`);
    return keys.some((k) => re.test(k));
  } catch {
    return keys.some((k) => m.split('|').map((x) => x.trim()).includes(k));
  }
}

interface HookJson {
  continue?: boolean;
  stopReason?: string;
  suppressOutput?: boolean;
  systemMessage?: string;
  decision?: 'approve' | 'block' | 'allow' | 'deny' | 'ask';
  reason?: string;
  hookSpecificOutput?: {
    hookEventName?: string;
    permissionDecision?: 'allow' | 'deny' | 'ask';
    permissionDecisionReason?: string;
    updatedInput?: Record<string, unknown>;
    additionalContext?: string;
  };
}

function parseHookJson(stdout: string): HookJson | undefined {
  const t = stdout.trim();
  if (!t.startsWith('{') || !t.endsWith('}')) {
    return undefined;
  }
  try {
    const v = JSON.parse(t) as unknown;
    return v && typeof v === 'object' ? (v as HookJson) : undefined;
  } catch {
    return undefined;
  }
}

export interface HookExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/** Runs one hook command with the event JSON on stdin. */
export function execHook(hook: HookCommand, input: unknown, opts: { cwd?: string; env?: Record<string, string>; signal?: AbortSignal }): Promise<HookExecResult> {
  const command = hook.pluginRoot ? hook.command.replace(/\$\{CLAUDE_PLUGIN_ROOT\}|\$CLAUDE_PLUGIN_ROOT/g, hook.pluginRoot) : hook.command;
  const shell = process.platform === 'win32' ? process.env.ComSpec ?? 'cmd.exe' : '/bin/sh';
  const args = process.platform === 'win32' ? ['/d', '/s', '/c', command] : ['-c', command];
  const timeoutMs = (hook.timeout ?? DEFAULT_TIMEOUT_S) * 1000;
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let child: cp.ChildProcess;
    try {
      child = cp.spawn(shell, args, {
        cwd: opts.cwd,
        env: { ...process.env, ...(opts.env ?? {}), ...(hook.pluginRoot ? { CLAUDE_PLUGIN_ROOT: hook.pluginRoot } : {}) },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (e) {
      resolve({ code: null, stdout: '', stderr: e instanceof Error ? e.message : String(e), timedOut: false });
      return;
    }
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    const onAbort = () => child.kill('SIGKILL');
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout?.on('data', (d: Buffer) => {
      if (stdout.length < MAX_STDOUT) {
        stdout += d.toString();
      }
    });
    child.stderr?.on('data', (d: Buffer) => {
      if (stderr.length < MAX_STDOUT) {
        stderr += d.toString();
      }
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      resolve({ code: null, stdout, stderr: stderr || e.message, timedOut });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      resolve({ code, stdout, stderr, timedOut });
    });
    for (const s of [child.stdin, child.stdout, child.stderr]) {
      s?.on('error', () => undefined);
    }
    child.stdin?.end(JSON.stringify(input));
  });
}

/** Folds one hook's result into the aggregate outcome. */
export function applyHookResult(out: HookOutcome, event: HookEvent, r: HookExecResult, label: string, log?: { warn(m: string): void; debug(m: string): void }): void {
  out.ran++;
  const stderr = r.stderr.trim();
  const stdout = r.stdout.trim();
  if (r.timedOut) {
    log?.warn(`hook ${label} (${event}) timed out`);
    out.messages.push(`Hook "${label}" timed out.`);
    return;
  }
  if (r.code === 2) {
    out.block = true;
    out.reasons.push(stderr || stdout || `Blocked by hook "${label}".`);
    if (event === 'PreToolUse') {
      out.permission = 'deny';
    }
    return;
  }
  if (r.code !== 0) {
    log?.warn(`hook ${label} (${event}) exited ${r.code}: ${stderr || stdout}`);
    if (stderr) {
      out.messages.push(`Hook "${label}" failed: ${stderr.split('\n')[0]}`);
    }
    return;
  }
  const json = parseHookJson(stdout);
  if (!json) {
    if (stdout) {
      if (event === 'UserPromptSubmit' || event === 'SessionStart') {
        out.context.push(stdout);
      } else {
        out.messages.push(stdout);
      }
    }
    return;
  }
  if (json.systemMessage) {
    out.messages.push(json.systemMessage);
  }
  if (json.continue === false) {
    out.stop = json.stopReason || `Stopped by hook "${label}".`;
  }
  const hs = json.hookSpecificOutput;
  if (hs?.additionalContext) {
    out.context.push(hs.additionalContext);
  }
  if (hs?.updatedInput && typeof hs.updatedInput === 'object') {
    out.updatedInput = { ...(out.updatedInput ?? {}), ...hs.updatedInput };
  }
  const decision = hs?.permissionDecision ?? (json.decision === 'approve' ? 'allow' : json.decision === 'block' ? 'deny' : json.decision);
  const reason = hs?.permissionDecisionReason ?? json.reason;
  if (event === 'PreToolUse') {
    // deny beats ask beats allow across hooks.
    if (decision === 'deny') {
      out.permission = 'deny';
      out.block = true;
      out.reasons.push(reason || `Denied by hook "${label}".`);
    } else if (decision === 'ask' && out.permission !== 'deny') {
      out.permission = 'ask';
    } else if (decision === 'allow' && !out.permission) {
      out.permission = 'allow';
    }
    if (reason && decision === 'allow') {
      out.messages.push(reason);
    }
  } else if (json.decision === 'block' || decision === 'deny') {
    out.block = true;
    out.reasons.push(reason || `Blocked by hook "${label}".`);
  } else if (reason) {
    out.messages.push(reason);
  }
}

export class HookRunner {
  constructor(
    private readonly settings: () => ProjectSettings,
    private readonly log: { info(m: string): void; warn(m: string): void; debug(m: string): void },
    /** Shown to the user (toast / status) when a hook has something to say. */
    public onMessage?: (text: string, event: HookEvent) => void
  ) {}

  /** The hook commands registered for an event (before matching). */
  hooksFor(event: HookEvent): HookMatcher[] {
    return this.settings().hooks[event] ?? [];
  }

  has(event: HookEvent): boolean {
    return this.hooksFor(event).length > 0;
  }

  /**
   * Runs every hook registered for `event` whose matcher fits `matchKeys` (parallel, identical commands once) and
   * aggregates their verdicts. Never throws.
   */
  async run(event: HookEvent, input: Record<string, unknown>, opts: HookRunOptions & { matchKeys?: string[] } = {}): Promise<HookOutcome> {
    const out: HookOutcome = { block: false, reasons: [], context: [], messages: [], ran: 0 };
    const matchers = this.hooksFor(event);
    if (!matchers.length) {
      return out;
    }
    const keys = opts.matchKeys ?? (opts.matchKey ? [opts.matchKey] : []);
    const needsMatch = event === 'PreToolUse' || event === 'PostToolUse' || event === 'SessionStart' || event === 'PreCompact' || event === 'Notification';
    const seen = new Set<string>();
    const hooks: HookCommand[] = [];
    for (const m of matchers) {
      if (needsMatch && !hookMatches(m.matcher, keys)) {
        continue;
      }
      for (const h of m.hooks) {
        const key = `${h.pluginRoot ?? ''}|${h.command}`;
        if (!seen.has(key)) {
          seen.add(key);
          hooks.push(h);
        }
      }
    }
    if (!hooks.length) {
      return out;
    }
    const cwd = opts.cwd ?? process.cwd();
    const env: Record<string, string> = { ...this.settings().env, ...(opts.env ?? {}), CLAUDE_PROJECT_DIR: cwd, LOCALPILOT_PROJECT_DIR: cwd };
    const payload = { hook_event_name: event, cwd, ...input };
    this.log.debug(`hooks: ${event} → ${hooks.length} hook(s)${keys.length ? ` for ${keys[0]}` : ''}`);
    const results = await Promise.all(hooks.map((h) => execHook(h, payload, { cwd, env, signal: opts.signal })));
    results.forEach((r, i) => applyHookResult(out, event, r, hooks[i].command.split(/\s+/).slice(0, 3).join(' '), this.log));
    for (const m of out.messages) {
      this.onMessage?.(m, event);
    }
    return out;
  }
}
