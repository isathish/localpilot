import * as cp from 'child_process';
import { shellInvocation } from '../terminal/shell';
import { killTree } from '../tools/terminal';
import { HookCommand, HookEvent, HookMatcher, ProjectSettings } from './settings';
import { recordTelemetry } from '../telemetry/catalog';
import type { HookRunOutcome } from '../telemetry/telemetry';

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
 * the trigger for SessionStart (startup|resume|clear|compact), PreCompact (manual|auto) and SessionEnd
 * (clear|prompt_input_exit|other), and ignored elsewhere.
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
  /** Told when each hook starts and how it ended (the chat's hook rows). */
  onRun?: (info: HookRunInfo) => void;
}

/** One hook run, as shown in the chat: "⚙ PreToolUse lint-guard → blocked". */
export interface HookRunInfo {
  id: string;
  event: HookEvent;
  name: string;
  tool?: string;
  status: 'running' | 'ok' | 'failed' | 'blocked';
  ms?: number;
}

let hookRunSeq = 0;

/** A hook's row label: its own name, else the start of its command. */
export const hookLabel = (h: HookCommand) => h.name ?? h.command.split(/\s+/).slice(0, 3).join(' ');

/** How one finished hook reads in the chat: blocked when it blocked or denied, failed when it errored or timed out. */
export function hookRunStatus(event: HookEvent, r: HookExecResult): 'ok' | 'failed' | 'blocked' {
  const one: HookOutcome = { block: false, reasons: [], context: [], messages: [], ran: 0 };
  applyHookResult(one, event, r, '');
  return one.block || one.permission === 'deny' ? 'blocked' : r.timedOut || r.code !== 0 ? 'failed' : 'ok';
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
  let command = hook.pluginRoot ? hook.command.replace(/\$\{CLAUDE_PLUGIN_ROOT\}|\$CLAUDE_PLUGIN_ROOT/g, hook.pluginRoot) : hook.command;
  const projectDir = opts.env?.CLAUDE_PROJECT_DIR;
  if (process.platform === 'win32' && projectDir) {
    // cmd.exe does not expand $VARS.
    command = command.replace(/\$\{CLAUDE_PROJECT_DIR\}|\$CLAUDE_PROJECT_DIR/g, projectDir);
  }
  const sh = shellInvocation(command, { posixShell: '/bin/sh' });
  const timeoutMs = (hook.timeout ?? DEFAULT_TIMEOUT_S) * 1000;
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let child: cp.ChildProcess;
    try {
      child = cp.spawn(sh.file, sh.args, {
        cwd: opts.cwd,
        env: { ...process.env, ...(opts.env ?? {}), ...(hook.pluginRoot ? { CLAUDE_PLUGIN_ROOT: hook.pluginRoot } : {}) },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        windowsVerbatimArguments: sh.windowsVerbatimArguments,
        detached: process.platform !== 'win32',
      });
    } catch (e) {
      resolve({ code: null, stdout: '', stderr: e instanceof Error ? e.message : String(e), timedOut: false });
      return;
    }
    let done = false;
    let grace: NodeJS.Timeout | undefined;
    let backstop: NodeJS.Timeout | undefined;
    const finish = (code: number | null) => {
      if (done) {
        return;
      }
      done = true;
      clearTimeout(timer);
      clearTimeout(grace);
      clearTimeout(backstop);
      opts.signal?.removeEventListener('abort', onAbort);
      resolve({ code, stdout, stderr, timedOut });
    };
    // A killed group may leave the pipes open (or never report 'exit'): give up on it after a second.
    const kill = () => {
      killTree(child);
      backstop ??= setTimeout(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
        finish(null);
      }, 1000);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, timeoutMs);
    const onAbort = () => kill();
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (d: string) => {
      if (stdout.length < MAX_STDOUT) {
        stdout += d;
      }
    });
    child.stderr?.on('data', (d: string) => {
      if (stderr.length < MAX_STDOUT) {
        stderr += d;
      }
    });
    child.on('error', (e) => {
      stderr ||= e.message;
      finish(null);
    });
    // A background process the hook started can hold the pipes open after the shell exits: don't wait for it.
    child.on('exit', (code) => {
      grace ??= setTimeout(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
        finish(code);
      }, 500);
    });
    child.on('close', (code) => finish(code));
    for (const s of [child.stdin, child.stdout, child.stderr]) {
      s?.on('error', () => undefined);
    }
    child.stdin?.end(JSON.stringify(input));
  });
}

/** How one hook command ended, for telemetry: exit 2 blocks, any other non-zero exit is a failure. */
export function hookRunOutcome(r: HookExecResult): HookRunOutcome {
  return r.timedOut ? 'timeout' : r.code === 2 ? 'blocked' : r.code === 0 ? 'ok' : 'failed';
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
    const needsMatch = event === 'PreToolUse' || event === 'PostToolUse' || event === 'SessionStart' || event === 'PreCompact' || event === 'Notification' || event === 'SessionEnd';
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
    const tool = typeof input.localpilot_tool_name === 'string' ? input.localpilot_tool_name : undefined;
    const results = await Promise.all(
      hooks.map(async (h) => {
        const started = Date.now();
        const info = { id: `hook${++hookRunSeq}`, event, name: hookLabel(h), ...(tool ? { tool } : {}) };
        opts.onRun?.({ ...info, status: 'running' });
        const r = await execHook(h, payload, { cwd, env, signal: opts.signal });
        recordTelemetry({ type: 'hook', event, durationMs: Date.now() - started, outcome: hookRunOutcome(r) });
        opts.onRun?.({ ...info, status: hookRunStatus(event, r), ms: Date.now() - started });
        return r;
      })
    );
    results.forEach((r, i) => applyHookResult(out, event, r, hookLabel(hooks[i]), this.log));
    for (const m of out.messages) {
      this.onMessage?.(m, event);
    }
    return out;
  }

  /**
   * Fires `SessionEnd` for a conversation that is being cleared or deleted (or whose CLI is exiting). Hooks cannot
   * block it; their output is only surfaced. Resolves once every hook has finished.
   */
  async sessionEnd(sessionId: string, reason: SessionEndReason, cwd: string | undefined, opts: { signal?: AbortSignal } = {}): Promise<void> {
    if (!this.has('SessionEnd')) {
      return;
    }
    try {
      await this.run('SessionEnd', { session_id: sessionId, reason }, { cwd, matchKey: reason, signal: opts.signal });
    } catch (e) {
      this.log.warn(`hooks: SessionEnd failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

/** Why a session ended — Claude Code's values; `other` covers deleting a chat. */
export type SessionEndReason = 'clear' | 'prompt_input_exit' | 'other';
