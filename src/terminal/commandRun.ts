import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/** Removes CSI colour/cursor codes and OSC sequences (titles, hyperlinks, shell-integration 633/133 markers). */
export function stripAnsi(s: string): string {
  return s
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, '')
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\u001b[=>NOM78]/g, '');
}

/** Keeps the start and a rolling end of long output: failures and summaries are reported last. */
export class OutputCapture {
  private head = '';
  private tail = '';
  private dropped = 0;

  constructor(private readonly headMax = 16_000, private readonly tailMax = 48_000) {}

  push(chunk: string): void {
    if (this.head.length < this.headMax) {
      const take = chunk.slice(0, this.headMax - this.head.length);
      this.head += take;
      chunk = chunk.slice(take.length);
    }
    this.tail += chunk;
    if (this.tail.length > this.tailMax) {
      this.dropped += this.tail.length - this.tailMax;
      this.tail = this.tail.slice(-this.tailMax);
    }
  }

  text(): string {
    return this.dropped ? `${this.head}\n…[${this.dropped} characters of output omitted]…\n${this.tail}` : this.head + this.tail;
  }
}

export const COMMAND_LOG_CAP_BYTES = 10 * 1024 * 1024;
const COMMAND_LOG_MAX_AGE_MS = 24 * 60 * 60 * 1000;

let logDir: string | undefined;
/** Where detached commands write their output (`<globalStorage>/cmd-logs` in VS Code, `~/.localpilot/cmd-logs` in the CLI). */
export function setCommandLogDir(dir: string | undefined): void {
  logDir = dir;
}
export function commandLogDir(): string {
  return logDir ?? path.join(os.tmpdir(), 'localpilot-cmd-logs');
}

/** Deletes command logs older than `maxAgeMs` (never one a running command still writes). Returns how many went. */
export function pruneCommandLogs(dir = commandLogDir(), maxAgeMs = COMMAND_LOG_MAX_AGE_MS, now = Date.now()): number {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return 0;
  }
  const live = new Set([...runs.values()].map((r) => r.logPath).filter(Boolean));
  let removed = 0;
  for (const name of names) {
    const file = path.join(dir, name);
    if (!name.endsWith('.log') || live.has(file)) {
      continue;
    }
    try {
      if (now - fs.statSync(file).mtimeMs > maxAgeMs) {
        fs.unlinkSync(file);
        removed++;
      }
    } catch {
      /* raced with another window: nothing to do */
    }
  }
  return removed;
}

/** Append-only log of a detached command, capped in size with a note where it stopped. */
export class CommandLog {
  private fd: number | undefined;
  private bytes = 0;
  private full = false;

  constructor(readonly file: string, private readonly cap = COMMAND_LOG_CAP_BYTES) {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      this.fd = fs.openSync(file, 'a');
    } catch {
      this.fd = undefined;
    }
  }

  get ok(): boolean {
    return this.fd !== undefined;
  }

  write(text: string): void {
    if (this.fd === undefined || this.full || !text) {
      return;
    }
    let buf = Buffer.from(text, 'utf8');
    if (this.bytes + buf.length > this.cap) {
      buf = buf.subarray(0, Math.max(0, this.cap - this.bytes));
      this.full = true;
    }
    try {
      fs.writeSync(this.fd, buf);
      this.bytes += buf.length;
      if (this.full) {
        fs.writeSync(this.fd, `\n[log truncated at ${Math.round(this.cap / 1024 / 1024)} MB; later output was dropped]\n`);
      }
    } catch {
      this.close();
    }
  }

  /** Writes `footer` even when the cap was reached (the exit code belongs at the end), then closes. */
  close(footer?: string): void {
    if (this.fd === undefined) {
      return;
    }
    try {
      if (footer) {
        fs.writeSync(this.fd, footer);
      }
      fs.closeSync(this.fd);
    } catch {
      /* the disk went away: nothing more to keep */
    }
    this.fd = undefined;
  }
}

export interface CommandOutcome {
  output: string;
  exitCode?: number | null;
  /** The command keeps running; later output goes to this log. */
  detached?: { logPath: string; id: string };
  /** It could not be started at all. */
  failed?: string;
  /** It was killed at its hard timeout (set only then). */
  timedOut?: boolean;
}

export interface CommandRunOptions {
  /** Tool call id: the chat's Proceed While Running / Stop buttons address the command by it. */
  id: string;
  sessionId: string;
  command: string;
  /** Kills the command's whole process tree (or its terminal). */
  kill(): void;
  /** Live output (ANSI codes removed) while the agent still waits for the command. */
  onOutput?(chunk: string): void;
  /** Proceed While Running on its own after this long; 0 or unset = never. */
  detachAfterMs?: number;
  /** Hard kill after this long, while the command was not detached; 0 or unset = never. */
  timeoutMs?: number;
  signal?: AbortSignal;
  capture?: OutputCapture;
  /** Never detach (self-healing checks): a detach request (button, Ctrl+B) stops the command instead. */
  noDetach?: boolean;
}

export type CommandRunState = 'running' | 'detached' | 'done';

const runs = new Map<string, CommandRun>();
const listeners = new Set<(run: CommandRun) => void>();

/**
 * One `run_command` invocation, whichever way it executes (child process or integrated terminal). The executor feeds
 * output and the exit; the run answers the tool with the full result, or with the partial output once it is detached
 * (button, Ctrl+B, the auto-detach timer, or `background: true`), after which output goes to a log file.
 */
export class CommandRun {
  readonly id: string;
  readonly sessionId: string;
  readonly command: string;
  readonly startedAt = Date.now();
  state: CommandRunState = 'running';
  logPath?: string;
  readonly result: Promise<CommandOutcome>;
  private settleResult!: (o: CommandOutcome) => void;
  private readonly cap: OutputCapture;
  private log?: CommandLog;
  private note = '';
  private timedOut = false;
  private readonly timers: NodeJS.Timeout[] = [];
  private readonly onAbort = () => this.interrupt('[cancelled]');

  get noDetach(): boolean {
    return this.o.noDetach === true;
  }

  constructor(private readonly o: CommandRunOptions) {
    let id = o.id;
    for (let n = 2; runs.has(id); n++) {
      id = `${o.id}-${n}`;
    }
    this.id = id;
    this.sessionId = o.sessionId;
    this.command = o.command;
    this.cap = o.capture ?? new OutputCapture();
    this.result = new Promise((resolve) => (this.settleResult = resolve));
    runs.set(id, this);
    if (o.detachAfterMs && o.detachAfterMs > 0) {
      this.timers.push(setTimeout(() => this.detach(), o.detachAfterMs));
    } else if (o.timeoutMs && o.timeoutMs > 0) {
      this.timers.push(
        setTimeout(() => {
          this.timedOut = this.state === 'running';
          this.interrupt(`[timed out after ${Math.round(o.timeoutMs! / 1000)}s]`);
        }, o.timeoutMs)
      );
    }
    if (o.signal?.aborted) {
      queueMicrotask(this.onAbort);
    } else {
      o.signal?.addEventListener('abort', this.onAbort, { once: true });
    }
    fire(this);
  }

  push(chunk: string): void {
    if (!chunk || this.state === 'done') {
      return;
    }
    if (this.state === 'detached') {
      this.log?.write(clean(chunk));
      return;
    }
    this.cap.push(chunk);
    const text = clean(chunk);
    if (text) {
      try {
        this.o.onOutput?.(text);
      } catch {
        /* a closed chat must not break the command */
      }
    }
  }

  /** The command ended (exit code from the process or terminal; undefined when unknown). */
  finish(exitCode: number | null | undefined): void {
    if (this.state === 'done') {
      return;
    }
    if (this.state === 'detached') {
      this.log?.close(`\n[exit code ${exitCode ?? 'null'}]\n`);
      this.end();
      return;
    }
    const output = clean(this.cap.text() + (this.note ? `\n${this.note}` : ''));
    this.end();
    this.settleResult(this.timedOut ? { output, exitCode, timedOut: true } : { output, exitCode });
  }

  /** The command could not be started. */
  fail(message: string): void {
    if (this.state === 'done') {
      return;
    }
    const wasRunning = this.state === 'running';
    this.log?.close(`\n[${message}]\n`);
    this.end();
    if (wasRunning) {
      this.settleResult({ output: '', failed: message });
    }
  }

  /** Proceed While Running: answer the tool now and keep the command going, its output appended to a log. */
  detach(): boolean {
    if (this.state !== 'running') {
      return false;
    }
    if (this.o.noDetach) {
      this.interrupt('[stopped: verification checks cannot run in the background]');
      return false;
    }
    this.clearTimers();
    this.o.signal?.removeEventListener('abort', this.onAbort);
    const output = clean(this.cap.text());
    const file = path.join(commandLogDir(), `${commandLogPrefix(this.sessionId)}${this.id.replace(/[^\w.-]+/g, '_').slice(0, 80)}.log`);
    const log = new CommandLog(file);
    log.write(`$ ${this.command}\n${output}${output && !output.endsWith('\n') ? '\n' : ''}`);
    this.log = log;
    this.logPath = log.ok ? file : undefined;
    this.state = 'detached';
    this.settleResult({ output, detached: { logPath: this.logPath ?? '(log unavailable)', id: this.id } });
    fire(this);
    return true;
  }

  /** Stop button: kill the process tree, whether the agent still waits for it or it was detached. */
  stop(): void {
    if (this.state === 'detached') {
      this.log?.write('\n[stopped by the user]\n');
      this.safeKill();
      this.timers.push(setTimeout(() => this.finish(undefined), 1000));
    } else {
      this.interrupt('[stopped by the user]');
    }
  }

  private interrupt(note: string): void {
    if (this.state !== 'running') {
      return;
    }
    this.note ||= note;
    this.safeKill();
    // The exit normally arrives at once; a terminal that ignores ^C must not hold the agent.
    this.timers.push(setTimeout(() => this.finish(undefined), 1500));
  }

  private safeKill(): void {
    try {
      this.o.kill();
    } catch {
      /* already gone */
    }
  }

  private clearTimers(): void {
    this.timers.splice(0).forEach((t) => clearTimeout(t));
  }

  private end(): void {
    this.clearTimers();
    this.o.signal?.removeEventListener('abort', this.onAbort);
    this.state = 'done';
    runs.delete(this.id);
    fire(this);
  }
}

function clean(s: string): string {
  return stripAnsi(s).replace(/\r\n?/g, '\n');
}

function fire(run: CommandRun): void {
  for (const l of listeners) {
    try {
      l(run);
    } catch {
      /* a listener's failure is its own */
    }
  }
}

/** Called whenever a command starts, is detached or ends. Returns the unsubscribe function. */
export function onCommandRunChange(listener: (run: CommandRun) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Commands still running (waited for or detached), optionally those of one chat. */
export function runningCommands(sessionId?: string): CommandRun[] {
  return [...runs.values()].filter((r) => !sessionId || r.sessionId === sessionId);
}

export function detachCommand(id: string): boolean {
  return runs.get(id)?.detach() ?? false;
}

export function stopCommand(id: string): boolean {
  const r = runs.get(id);
  r?.stop();
  return !!r;
}

/** Detaches every command the agent is waiting for (the CLI's Ctrl+B). Returns how many. */
export function detachWaiting(sessionId?: string): number {
  return runningCommands(sessionId).filter((r) => r.state === 'running' && !r.noDetach && r.detach()).length;
}

/** Log file names start with the chat they belong to (`<session>~<call id>.log`), so deleting the chat finds them. */
export function commandLogPrefix(sessionId: string): string {
  return `${(sessionId || 'none').replace(/[^\w.-]+/g, '_').slice(0, 60)}~`;
}

/** A deleted chat's command logs: stops its detached commands and removes their logs. Returns the bytes freed. */
export function deleteCommandLogs(sessionId: string, dir = commandLogDir()): number {
  runningCommands(sessionId).forEach((r) => r.stop());
  const prefix = commandLogPrefix(sessionId);
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return 0;
  }
  let freed = 0;
  for (const name of names) {
    if (!name.startsWith(prefix) || !name.endsWith('.log')) {
      continue;
    }
    const file = path.join(dir, name);
    try {
      freed += fs.statSync(file).size;
      fs.unlinkSync(file);
    } catch {
      /* already gone */
    }
  }
  return freed;
}

/** Kills every command still running, detached ones included (window closing, CLI exiting). */
export function stopAllCommands(): void {
  runningCommands().forEach((r) => r.stop());
}

/** The tool result text for a finished, detached or failed command. */
export function formatCommandOutcome(command: string, o: CommandOutcome): { content: string; isError: boolean; data: Record<string, unknown> } {
  if (o.failed) {
    return { content: `Failed to start: ${o.failed}`, isError: true, data: { exitCode: null } };
  }
  const out = o.output.trim();
  if (o.detached) {
    return {
      content: `$ ${command}\n${out || '(no output yet)'}\n[Command is still running. Further output goes to ${o.detached.logPath}; read it with read_file.]`,
      isError: false,
      data: { detached: true, logPath: o.detached.logPath, commandId: o.detached.id },
    };
  }
  return { content: `$ ${command}\n${out || '(no output)'}\n[exit code ${o.exitCode ?? 'null'}]`, isError: o.exitCode !== 0, data: { exitCode: o.exitCode ?? null } };
}
