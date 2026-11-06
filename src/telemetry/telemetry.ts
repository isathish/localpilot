// Local-only telemetry: what the models, tools and completions did on this machine, kept as daily JSONL files plus a
// mirror of the LocalPilot log. Nothing here talks to the network. Pure Node so the extension and the CLI share it.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SpanData, Tracer } from './tracing';

/**
 * Where events and logs live: `~/.localpilot/telemetry`, shared by the extension and the CLI. `LOCALPILOT_TELEMETRY_DIR`
 * overrides it — the test runner points it at a scratch folder so providers made up by tests never reach the real dashboard.
 */
export function defaultTelemetryDir(): string {
  return process.env.LOCALPILOT_TELEMETRY_DIR || path.join(os.homedir(), '.localpilot', 'telemetry');
}

export type RunOutcome = 'done' | 'stopped' | 'failed';
export type ModelOutcome = 'ok' | 'error' | 'retry' | 'aborted';
export type CompletionAction = 'requested' | 'shown' | 'accepted' | 'cached' | 'empty' | 'error';

interface Base {
  /** Epoch ms. */
  t: number;
  /** The trace span the event happened in (only while trace export is on). */
  traceId?: string;
  spanId?: string;
}
export type TelemetryEvent =
  /** One model request (an attempt; retries record their own event). */
  | (Base & { type: 'model'; sid: string; model: string; provider: string; mode: string; depth: number; promptTokens?: number; completionTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number; /** Priced from the bundled model facts or reported by the provider; absent for local models. */ costUsd?: number; ttftMs?: number; durationMs: number; outcome: ModelOutcome; reason?: string })
  /** One tool execution. */
  | (Base & { type: 'tool'; sid: string; name: string; mode: string; durationMs: number; error: boolean; cached?: boolean })
  /** One agent turn (depth > 0 is a subagent). */
  | (Base & { type: 'run'; sid: string; mode: string; model: string; depth: number; agent?: string; /** Routing role the run was picked for (agent, reasoning, fast, coding…). */ role?: string; outcome: RunOutcome; durationMs: number; steps: number; toolCalls: number; promptTokens: number; completionTokens: number; isolated?: boolean })
  /** Isolated worktree lifecycle. */
  | (Base & { type: 'worktree'; action: 'create' | 'apply' | 'discard'; files?: number; conflicts?: number; durationMs?: number })
  /** Inline completion lifecycle. */
  | (Base & { type: 'completion'; action: CompletionAction; model?: string; language?: string; durationMs?: number })
  /** Provider reachability check. */
  | (Base & { type: 'health'; provider: string; ok: boolean; durationMs: number; models?: number; error?: string })
  /** A chat task's lifecycle: its first request, and how each top-level turn ended. */
  | (Base & { type: 'task'; sid: string; action: TaskAction; mode: string })
  | (Base & { type: 'mode_switch'; sid?: string; from: string; to: string; source: ChoiceSource })
  /** A slash command that was handled (the name only, never its arguments). */
  | (Base & { type: 'slash'; command: string; custom?: boolean })
  /** Context attached with an @ mention or the attach button (the kind only, never the path). */
  | (Base & { type: 'mention'; kind: MentionKind })
  | (Base & { type: 'mcp_call'; server: string; tool: string; durationMs: number; ok: boolean })
  /** `restore` reverts files and the conversation; `rewind` only the conversation (Edit message). */
  | (Base & { type: 'checkpoint'; action: 'create' | 'restore' | 'rewind'; outcome: 'ok' | 'failed' | 'skipped'; files?: number })
  /** One hook command: the event it ran for and how it ended. */
  | (Base & { type: 'hook'; event: string; durationMs: number; outcome: HookRunOutcome })
  /** The user kept or undid agent edits. Lines are counted against the pre-edit snapshot. */
  | (Base & { type: 'edit_decision'; decision: 'accepted' | 'rejected'; added: number; removed: number; files: number })
  | (Base & { type: 'model_selected'; sid?: string; model: string; source: ChoiceSource; makeDefault?: boolean })
  /** A self-healing step. Only the category and the 16-hex signature hash are kept, never code, messages, paths or human keys. */
  | (Base & { type: 'recovery'; sid: string; action: RecoveryAction; category: RecoveryCategory; severity?: RecoverySeverity; signature?: string; attempt?: number; max?: number; durationMs?: number; outcome?: string; delegated?: boolean; depth?: number; /** Resource adjustments made before a retry (`context`, `timeout`, `model`…). */ adjust?: string[] });

export type TaskAction = 'created' | 'completed' | 'aborted' | 'failed' | 'mistake_limit' | 'incomplete' | 'blocked' | 'completed_unverified';
export type RecoveryAction = 'detected' | 'retry' | 'fix_attempt' | 'validated' | 'rolled_back' | 'recovered' | 'duplicate' | 'escalated' | 'blocked' | 'exhausted' | 'resumed' | 'memory_hit' | 'accept_risk';
export type RecoveryCategory =
  | 'model_timeout' | 'model_unavailable' | 'model_overload' | 'model_output'
  | 'compile' | 'typescript' | 'lint' | 'build' | 'dependency'
  | 'unit_test' | 'integration_test' | 'runtime'
  | 'database' | 'data_corruption' | 'mcp' | 'git_conflict' | 'security'
  | 'tool' | 'permission' | 'check_timeout' | 'loop' | 'unknown';
export type RecoverySeverity = 'info' | 'low' | 'medium' | 'high' | 'critical';
export type ChoiceSource = 'picker' | 'slash' | 'plan' | 'cli' | 'auto';
export type MentionKind = 'file' | 'range' | 'folder' | 'url' | 'terminal' | 'workspace' | 'problems' | 'git' | 'selection' | 'editors' | 'codebase' | 'other';
export type HookRunOutcome = 'ok' | 'blocked' | 'failed' | 'timeout';

/** An event as callers record it: the timestamp is optional (defaults to now). Distributes over the union. */
export type TelemetryInput = TelemetryEvent extends infer E ? (E extends Base ? Omit<E, 't'> & { t?: number } : never) : never;

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error';
export interface LogEntry {
  t: number;
  level: LogLevel;
  msg: string;
}

export interface Percentiles {
  p50: number;
  p95: number;
  avg: number;
}
export interface DayPoint {
  day: string;
  runs: number;
  /** Runs that ended in `failed`. */
  failedRuns: number;
  tokens: number;
  promptTokens: number;
  completionTokens: number;
  toolCalls: number;
  toolErrors: number;
  cachedTools: number;
  modelCalls: number;
  modelErrors: number;
  /** Completion tokens per second of generation across the day's successful calls (0 when none). */
  tokPerSec: number;
  completionsShown: number;
  completionsAccepted: number;
  errors: number;
  /** Lines (added + removed) in agent edits the user kept / undid. */
  acceptedLines: number;
  rejectedLines: number;
  hookFailures: number;
  /** US dollars spent on priced model calls that day (0 when every call ran locally). */
  costUsd: number;
  /** The day's spend split by provider id; only providers with priced calls appear. */
  costByProvider: Record<string, number>;
}

export interface ActivitySummary {
  tasks: { created: number; completed: number; aborted: number; failed: number; mistakeLimit: number; incomplete: number; blocked: number; /** `completed_unverified`: done, but a required check could not run. */ unverified: number };
  edits: { accepted: number; rejected: number; acceptedAdded: number; acceptedRemoved: number; rejectedAdded: number; rejectedRemoved: number; acceptedFiles: number; rejectedFiles: number };
  hooks: { runs: number; ok: number; blocked: number; failed: number; timeout: number; duration: Percentiles; byEvent: { event: string; runs: number; failures: number }[] };
  mcp: { calls: number; errors: number; servers: { server: string; calls: number; errors: number; duration: Percentiles }[] };
  checkpoints: { created: number; restores: number; rewinds: number; failed: number; files: number };
  modeSwitches: { to: string; count: number }[];
  modelSelections: { model: string; count: number }[];
  slash: { command: string; count: number }[];
  mentions: { kind: string; count: number }[];
}
/** Self-healing outcomes. `rate` = recovered / (recovered + escalated + exhausted + blocked), 0 when none ended. */
export interface RecoverySummary {
  detected: number;
  recovered: number;
  escalated: number;
  blocked: number;
  exhausted: number;
  rate: number;
  /** Time to recover, from the `durationMs` of `recovered` events. */
  mttr: Percentiles;
  byCategory: { category: string; detected: number; recovered: number; attempts: Percentiles }[];
  /** The most frequent signature hashes (never human keys), top 10. */
  topSignatures: { signature: string; count: number; recovered: number }[];
  memory: { suggested: number; succeeded: number };
  /** The newest 50 events, newest first. */
  recent: { t: number; sid: string; category: string; action: RecoveryAction; signature?: string; attempt?: number }[];
  acceptedRisks: number;
}

export interface TelemetrySummary {
  days: number;
  from: number;
  to: number;
  totals: {
    runs: number;
    done: number;
    stopped: number;
    failed: number;
    subagentRuns: number;
    modelCalls: number;
    modelErrors: number;
    retries: number;
    promptTokens: number;
    completionTokens: number;
    /** US dollars spent on priced (cloud) model calls; 0 when every call ran locally. */
    costUsd: number;
    toolCalls: number;
    toolErrors: number;
    /** Read-only tool calls served from the per-turn cache. */
    cachedTools: number;
    /** Runs that worked in an isolated worktree. */
    isolatedRuns: number;
    /** Days in the range with at least one event. */
    activeDays: number;
    /** Completion tokens per second of generation over every successful model call. */
    tokPerSec: number;
    runTime: Percentiles;
    steps: Percentiles;
  };
  series: DayPoint[];
  /** Model + tool calls per local hour of day (24 buckets), for the activity histogram. */
  hourly: number[];
  /** Subagent runs grouped by agent persona. */
  agents: { agent: string; runs: number; done: number; stopped: number; failed: number; duration: Percentiles; toolCalls: number }[];
  /** Model calls and spend per provider, most expensive first. `pricedCalls` counts calls that carried a price. */
  providers: { provider: string; calls: number; pricedCalls: number; costUsd: number }[];
  models: { model: string; provider: string; calls: number; promptTokens: number; completionTokens: number; /** Absent when no call of this model had a price. */ costUsd?: number; tokPerSec: number; ttft: Percentiles; duration: Percentiles; errors: number; last: number }[];
  tools: { name: string; calls: number; errors: number; cached: number; duration: Percentiles; last: number }[];
  modes: { mode: string; runs: number; done: number; stopped: number; failed: number; duration: Percentiles; steps: Percentiles; toolCalls: number }[];
  completions: { requested: number; shown: number; accepted: number; cached: number; empty: number; error: number; acceptanceRate: number; latency: Percentiles; byLanguage: { language: string; shown: number; accepted: number }[] };
  health: { provider: string; checks: number; ok: number; uptime: number; up: boolean; lastAt: number; latency: Percentiles; lastError?: string; models?: number }[];
  worktrees: { created: number; applied: number; discarded: number; conflicts: number; files: number };
  /** Tasks, edit decisions, hooks, MCP calls, checkpoints and choices the user made. */
  activity: ActivitySummary;
  recovery: RecoverySummary;
  errors: { t: number; kind: 'model' | 'tool' | 'run' | 'health' | 'hook' | 'mcp'; what: string; detail: string }[];
  storage: { events: number; bytes: number; files: number; oldest?: number; dir: string; /** Where new data goes right now. */ backend?: 'files' | 'redis' | 'fallback'; remoteError?: string };
}

export interface TelemetryOptions {
  dir: string;
  /** Days of events and logs to keep; 0 keeps everything. */
  retentionDays: () => number;
  /** Record events at all (logs are always mirrored). */
  enabled?: () => boolean;
  /** Lines of log kept in memory for the dashboard. */
  logBuffer?: number;
  now?: () => number;
  /** Optional external store (Redis Stack); when it is set and reachable, events and log lines go there instead of files. */
  remote?: () => TelemetryRemote | undefined;
  /** A remote write failed and the batch went to files instead. */
  onRemoteError?: (e: unknown) => void;
  /** Extra destinations for every batch (exporters); the built-in store is always the first sink, named `store`. */
  sinks?: { name: string; sink: TelemetrySink }[];
  /** An extra sink failed to write, flush or shut down. The store and the other sinks are unaffected. */
  onSinkError?: (name: string, e: unknown) => void;
}

/** One flush worth of recorded data, oldest first. */
export interface TelemetryBatch {
  events: TelemetryEvent[];
  logs: LogEntry[];
}

export type MetricAttributes = Record<string, string | number | boolean>;

/**
 * A destination for telemetry. `write` receives every flushed batch; `flush` drains anything the sink buffers itself;
 * `shutdown` flushes and releases it. Sinks that understand metrics also take `counter` and `histogram` samples.
 */
export interface TelemetrySink {
  write(batch: TelemetryBatch): Promise<void>;
  flush(): Promise<void>;
  shutdown(): Promise<void>;
  counter?(name: string, value: number, attributes?: MetricAttributes): void;
  histogram?(name: string, value: number, attributes?: MetricAttributes): void;
  /** A finished, sampled trace span. */
  span?(span: SpanData): void;
}

/** Name of the built-in sink (files, or the external store with files as the fallback). It cannot be removed or replaced. */
export const STORE_SINK = 'store';

/** An external event/log store. Must throw from `write` when the batch was not stored, so it can go to files instead. */
export interface TelemetryRemote {
  readonly label: string;
  write(eventLines: string[], logLines: string[], retentionDays: number): Promise<void>;
  /** Streams events recorded at or after `fromMs` (0 = all), oldest first, in batches. */
  events(fromMs: number, onBatch: (events: TelemetryEvent[]) => void): Promise<void>;
  /** The newest `limit` stored log lines, oldest first. */
  recentLogs(limit: number): Promise<string[]>;
  stats(): Promise<{ events: number; bytes: number; oldest?: number }>;
  prune(cutoffMs: number): Promise<void>;
  clear(): Promise<void>;
}

/** After a failed remote write, files take over for this long before the remote is tried again. */
const REMOTE_RETRY_MS = 60_000;

const FLUSH_MS = 400;
const MAX_SUMMARY_DAYS = 365;
const LOG_PREFIX = 'localpilot-';
const EVENT_PREFIX = 'events-';
/** Lines queued for one file between flushes. Only reachable when the disk is stuck; then the oldest lines go rather than memory. */
const MAX_PENDING_LINES = 20_000;

const capPending = (lines: unknown[]): void => {
  if (lines.length > MAX_PENDING_LINES) {
    lines.splice(0, lines.length - MAX_PENDING_LINES);
  }
};

const dayKey = (t: number): string => {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const startOfDay = (t: number): number => {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};
const daysBefore = (t: number, n: number): number => {
  const d = new Date(startOfDay(t));
  d.setDate(d.getDate() - n);
  return d.getTime();
};

export function percentiles(values: number[] | Samples): Percentiles {
  const list = values instanceof Samples ? values.values : values;
  if (!list.length) {
    return { p50: 0, p95: 0, avg: 0 };
  }
  const sorted = [...list].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))];
  const avg = values instanceof Samples ? values.mean : sorted.reduce((a, b) => a + b, 0) / sorted.length;
  return { p50: at(0.5), p95: at(0.95), avg: Math.round(avg) };
}

/** A log entry as one stored line: `ISO [level] msg`, with backslashes, CR and LF escaped. */
export function formatLogLine(e: LogEntry): string {
  return `${new Date(e.t).toISOString()} [${e.level}] ${e.msg.replace(/\\/g, '\\\\').replace(/\r/g, '\\r').replace(/\n/g, '\\n')}`;
}

/** One stored log line (`ISO [level] msg`, newlines escaped) back into an entry. */
export function parseLogLine(line: string): LogEntry | undefined {
  const m = /^(\S+) \[(trace|debug|info|warn|error)\] ([\s\S]*)$/.exec(line);
  return m ? { t: Date.parse(m[1]) || Date.now(), level: m[2] as LogLevel, msg: m[3].replace(/\\([\\nr])/g, (_, c: string) => (c === 'n' ? '\n' : c === 'r' ? '\r' : '\\')) } : undefined;
}

/** Samples kept per percentile series; beyond this a uniform reservoir stands in for the full list. */
export const SAMPLE_CAP = 4096;

/**
 * A bounded sample of a value series: exact until `SAMPLE_CAP` values, a uniform random reservoir after that, so
 * p50/p95 stay accurate to within a percent or so while memory stays flat however long the history is. The mean
 * is always exact.
 */
export class Samples {
  readonly values: number[] = [];
  private n = 0;
  private sum = 0;
  add(x: number): void {
    this.n++;
    this.sum += x;
    if (this.values.length < SAMPLE_CAP) {
      this.values.push(x);
      return;
    }
    const j = Math.floor(Math.random() * this.n);
    if (j < SAMPLE_CAP) {
      this.values[j] = x;
    }
  }
  get count(): number {
    return this.n;
  }
  get mean(): number {
    return this.n ? this.sum / this.n : 0;
  }
}

function linesByDay<T extends { t: number }>(items: T[], line: (x: T) => string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const x of items) {
    const key = dayKey(x.t);
    let lines = out.get(key);
    if (!lines) {
      lines = [];
      out.set(key, lines);
    }
    lines.push(line(x));
  }
  return out;
}

/** The local store: events to `events-YYYY-MM-DD.jsonl`, log lines to `localpilot-YYYY-MM-DD.log`, appended per day. */
export class FileTelemetrySink implements TelemetrySink {
  constructor(readonly dir: string) {}

  async write(batch: TelemetryBatch): Promise<void> {
    if (!batch.events.length && !batch.logs.length) {
      return;
    }
    await fs.promises.mkdir(this.dir, { recursive: true });
    for (const [day, lines] of linesByDay(batch.events, (e) => JSON.stringify(e))) {
      await fs.promises.appendFile(path.join(this.dir, `${EVENT_PREFIX}${day}.jsonl`), `${lines.join('\n')}\n`, 'utf8');
    }
    for (const [day, lines] of linesByDay(batch.logs, formatLogLine)) {
      await fs.promises.appendFile(path.join(this.dir, `${LOG_PREFIX}${day}.log`), `${lines.join('\n')}\n`, 'utf8');
    }
  }

  async flush(): Promise<void> {
    /* appends are written straight away */
  }

  async shutdown(): Promise<void> {
    /* nothing held open */
  }
}

/** An external store (Redis) as a sink. Throws from `write` when the batch was not stored. */
export class RemoteTelemetrySink implements TelemetrySink {
  constructor(
    readonly remote: TelemetryRemote,
    private readonly retentionDays: () => number
  ) {}

  write(batch: TelemetryBatch): Promise<void> {
    return this.remote.write(
      batch.events.map((e) => JSON.stringify(e)),
      batch.logs.map(formatLogLine),
      this.retentionDays()
    );
  }

  async flush(): Promise<void> {
    /* the remote write is complete when `write` resolves */
  }

  async shutdown(): Promise<void> {
    /* the owner of the connection disposes it */
  }
}

/** A signature as telemetry may carry it: the 16-hex hash, never a human key like `TS2345@src/api/user.ts`. */
const SIGNATURE_HASH = /^[0-9a-f]{16}$/;

/**
 * Append-only store of local telemetry events and log lines. Events go to `events-YYYY-MM-DD.jsonl`, log lines to
 * `localpilot-YYYY-MM-DD.log`; both are pruned by the retention setting. Writes are batched and never awaited by
 * callers; `flush()` waits for them (dispose, tests).
 */
export class Telemetry {
  private pendingEvents: TelemetryEvent[] = [];
  private pendingLogs: LogEntry[] = [];
  private readonly sinks = new Map<string, TelemetrySink>();
  private readonly files_: FileTelemetrySink;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private writing: Promise<void> = Promise.resolve();
  private readonly ring: LogEntry[] = [];
  private readonly logListeners = new Set<(e: LogEntry) => void>();
  private readonly eventListeners = new Set<(e: TelemetryEvent) => void>();
  private lastPrune = 0;
  private remoteDownUntil = 0;
  private lastRemoteError: string | undefined;
  readonly dir: string;
  /** Run, model and tool spans; off until an exporter turns it on. Finished spans go to the sinks that take them. */
  readonly tracing = new Tracer((s) => this.metric((sink) => sink.span?.(s)));

  constructor(private readonly opts: TelemetryOptions) {
    this.dir = opts.dir;
    this.files_ = new FileTelemetrySink(opts.dir);
    this.sinks.set(STORE_SINK, { write: (b) => this.writeStore(b), flush: async () => undefined, shutdown: async () => undefined });
    for (const { name, sink } of opts.sinks ?? []) {
      this.add(name, sink);
    }
  }

  private get now(): number {
    return (this.opts.now ?? Date.now)();
  }
  /** False while `localpilot.telemetry.enabled` is off: nothing is recorded or exported then. */
  get enabled(): boolean {
    return this.opts.enabled ? this.opts.enabled() : true;
  }

  // ------------------------------------------------------------------ events
  record(e: TelemetryInput): void {
    if (!this.enabled) {
      return;
    }
    const ev = { ...e, t: e.t ?? this.now } as TelemetryEvent;
    if (ev.type === 'recovery' && ev.signature !== undefined && !SIGNATURE_HASH.test(ev.signature)) {
      delete ev.signature;
    }
    const active = ev.traceId ? undefined : this.tracing.active();
    if (active) {
      ev.traceId = active.traceId;
      ev.spanId = active.spanId;
    }
    this.pendingEvents.push(ev);
    capPending(this.pendingEvents);
    this.schedule();
    this.notify(this.eventListeners, ev);
  }

  onEvent(l: (e: TelemetryEvent) => void): () => void {
    this.eventListeners.add(l);
    return () => this.eventListeners.delete(l);
  }

  // ------------------------------------------------------------------ logs
  log(level: LogLevel, msg: string): void {
    const entry: LogEntry = { t: this.now, level, msg: String(msg) };
    this.ring.push(entry);
    // With an external store the history lives there; keep only a short tail in the extension host.
    const max = this.opts.logBuffer ?? (this.activeRemote() ? 500 : 3000);
    if (this.ring.length > max) {
      this.ring.splice(0, this.ring.length - max);
    }
    this.pendingLogs.push(entry);
    capPending(this.pendingLogs);
    this.schedule();
    this.notify(this.logListeners, entry);
  }

  /** A listener that throws (a dashboard mid-teardown, say) must not take the recorder — or the other listeners — down with it. */
  private notify<T>(listeners: Set<(e: T) => void>, e: T): void {
    for (const l of listeners) {
      try {
        l(e);
      } catch {
        /* the listener's problem, not the recorder's */
      }
    }
  }

  onLog(l: (e: LogEntry) => void): () => void {
    this.logListeners.add(l);
    return () => this.logListeners.delete(l);
  }

  /** Recent log lines (newest last), optionally filtered by minimum level and a case-insensitive needle. */
  logs(filter: { level?: LogLevel; q?: string; limit?: number } = {}): LogEntry[] {
    const order: LogLevel[] = ['trace', 'debug', 'info', 'warn', 'error'];
    const min = filter.level ? order.indexOf(filter.level) : 0;
    const q = filter.q?.toLowerCase();
    const out = this.ring.filter((e) => order.indexOf(e.level) >= min && (!q || e.msg.toLowerCase().includes(q)));
    const limit = filter.limit ?? 500;
    return out.length > limit ? out.slice(out.length - limit) : out;
  }

  /** Path of today's log file (created on first write). */
  logFile(t = this.now): string {
    return path.join(this.dir, `${LOG_PREFIX}${dayKey(t)}.log`);
  }

  /** Seeds the in-memory log with the tail of today's log (file, or the external store when that is where it lives). */
  async loadRecentLogs(limit = 400): Promise<void> {
    const remote = this.activeRemote();
    if (remote) {
      try {
        const lines = await remote.recentLogs(limit);
        if (lines.length) {
          this.ring.unshift(...lines.map(parseLogLine).filter((e): e is LogEntry => !!e));
          return;
        }
      } catch (e) {
        // A store swapped or disposed mid-call failed because of that, not because the new one is down.
        if (this.opts.remote?.() === remote) {
          this.remoteFailed(e);
        }
      }
    }
    try {
      const text = await fs.promises.readFile(this.logFile(), 'utf8');
      const lines = text.split('\n').filter(Boolean);
      const tail = lines.slice(Math.max(0, lines.length - limit));
      this.ring.unshift(...tail.map(parseLogLine).filter((e): e is LogEntry => !!e));
    } catch {
      /* no file yet */
    }
  }

  // ------------------------------------------------------------------ persistence
  private schedule(): void {
    if (this.timer) {
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.writing = this.writing.then(() => this.write()).catch(() => undefined);
    }, FLUSH_MS);
  }

  private async write(): Promise<void> {
    const batch: TelemetryBatch = { events: this.pendingEvents, logs: this.pendingLogs };
    this.pendingEvents = [];
    this.pendingLogs = [];
    if (!batch.events.length && !batch.logs.length) {
      return;
    }
    // The store's own failures propagate as before; an exporter that fails only reports it.
    const extra = [...this.sinks].filter(([name]) => name !== STORE_SINK).map(([name, sink]) => this.guard(name, () => sink.write(batch)));
    try {
      await this.sinks.get(STORE_SINK)!.write(batch);
    } finally {
      await Promise.all(extra);
    }
  }

  /** The built-in sink: the external store when it is set and up, files otherwise (and when it fails mid-write). */
  private async writeStore(batch: TelemetryBatch): Promise<void> {
    const remote = this.activeRemote();
    if (remote) {
      try {
        await new RemoteTelemetrySink(remote, this.opts.retentionDays).write(batch);
        await this.maybePrune();
        return;
      } catch (e) {
        // A store swapped or disposed mid-call failed because of that, not because the new one is down.
        if (this.opts.remote?.() === remote) {
          this.remoteFailed(e);
        }
      }
    }
    await this.files_.write(batch);
    await this.maybePrune();
  }

  private async guard(name: string, op: () => Promise<void>): Promise<void> {
    try {
      await op();
    } catch (e) {
      this.opts.onSinkError?.(name, e);
    }
  }

  // ------------------------------------------------------------------ sinks
  /** Adds (or replaces) a sink; it receives every batch flushed from now on. The `store` sink cannot be replaced. */
  add(name: string, sink: TelemetrySink): void {
    if (name === STORE_SINK) {
      throw new Error(`the "${STORE_SINK}" telemetry sink is built in`);
    }
    const old = this.sinks.get(name);
    this.sinks.set(name, sink);
    if (old && old !== sink) {
      void this.guard(name, () => old.shutdown());
    }
  }

  /** Flushes what is queued to the sink, then detaches and shuts it down. False when no such sink (or the built-in store). */
  async remove(name: string): Promise<boolean> {
    const sink = this.sinks.get(name);
    if (!sink || name === STORE_SINK) {
      return false;
    }
    await this.flush();
    if (this.sinks.get(name) === sink) {
      this.sinks.delete(name);
    }
    await this.guard(name, () => sink.shutdown());
    return true;
  }

  /** Names of the attached sinks, the store first. */
  sinkNames(): string[] {
    return [...this.sinks.keys()];
  }

  /** Adds to a monotonic counter in every sink that keeps metrics. Nothing is recorded while telemetry is off. */
  counter(name: string, value = 1, attributes?: MetricAttributes): void {
    this.metric((s) => s.counter?.(name, value, attributes));
  }

  /** Records one sample of a distribution (durations, sizes) in every sink that keeps metrics. */
  histogram(name: string, value: number, attributes?: MetricAttributes): void {
    this.metric((s) => s.histogram?.(name, value, attributes));
  }

  private metric(fn: (s: TelemetrySink) => void): void {
    if (!this.enabled) {
      return;
    }
    for (const [name, sink] of this.sinks) {
      try {
        fn(sink);
      } catch (e) {
        this.opts.onSinkError?.(name, e);
      }
    }
  }

  /** The external store, unless none is configured or it failed within the last minute. */
  activeRemote(): TelemetryRemote | undefined {
    return this.now < this.remoteDownUntil ? undefined : this.opts.remote?.();
  }

  /** Reads and writes share one back-off, so a dead server is not retried (and logged) on every dashboard refresh. */
  private remoteFailed(e: unknown): void {
    this.remoteDownUntil = this.now + REMOTE_RETRY_MS;
    this.lastRemoteError = e instanceof Error ? e.message : String(e);
    this.opts.onRemoteError?.(e);
  }

  /** Forget an earlier failure (the store's target changed). */
  resetRemote(): void {
    this.remoteDownUntil = 0;
    this.lastRemoteError = undefined;
  }

  private async maybePrune(): Promise<void> {
    if (this.now - this.lastPrune > 6 * 3600_000) {
      this.lastPrune = this.now;
      await this.prune();
    }
  }

  /** Writes everything queued so far. */
  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.writing = this.writing.then(() => this.write()).catch(() => undefined);
    await this.writing;
    await Promise.all([...this.sinks].map(([name, sink]) => this.guard(name, () => sink.flush())));
  }

  /** Writes everything queued, then shuts every sink down. */
  async shutdown(): Promise<void> {
    await this.flush();
    await Promise.all([...this.sinks].map(([name, sink]) => this.guard(name, () => sink.shutdown())));
  }

  dispose(): void {
    void this.shutdown();
  }

  /** Removes event and log files older than the retention window. Returns the number of files removed. */
  async prune(): Promise<number> {
    const days = this.opts.retentionDays();
    if (!days || days <= 0) {
      return 0;
    }
    const cutoff = dayKey(daysBefore(this.now, days - 1));
    let removed = 0;
    for (const f of await this.files()) {
      if (f.day < cutoff) {
        await fs.promises.rm(path.join(this.dir, f.name), { force: true });
        removed++;
      }
    }
    await this.opts.remote?.()?.prune(daysBefore(this.now, days - 1)).catch(() => undefined);
    return removed;
  }

  /** Deletes all recorded events and logs. `remoteError` says the external store could not be cleared. */
  async clear(): Promise<{ remoteError?: string }> {
    await this.flush();
    this.ring.length = 0;
    for (const f of await this.files()) {
      await fs.promises.rm(path.join(this.dir, f.name), { force: true });
    }
    const remote = this.opts.remote?.();
    if (remote) {
      try {
        await remote.clear();
      } catch (e) {
        this.remoteFailed(e);
        return { remoteError: e instanceof Error ? e.message : String(e) };
      }
    }
    return {};
  }

  private async files(): Promise<{ name: string; day: string; kind: 'events' | 'log'; size: number }[]> {
    let names: string[];
    try {
      names = await fs.promises.readdir(this.dir);
    } catch {
      return [];
    }
    const out: { name: string; day: string; kind: 'events' | 'log'; size: number }[] = [];
    for (const name of names) {
      const m = /^(events|localpilot)-(\d{4}-\d{2}-\d{2})\.(jsonl|log)$/.exec(name);
      if (!m) {
        continue;
      }
      let size = 0;
      try {
        size = (await fs.promises.stat(path.join(this.dir, name))).size;
      } catch {
        continue;
      }
      out.push({ name, day: m[2], kind: m[1] === 'events' ? 'events' : 'log', size });
    }
    return out.sort((a, b) => a.day.localeCompare(b.day));
  }

  /** Reads events from the last `days` days (0 = everything on disk), oldest first. */
  async events(days: number): Promise<TelemetryEvent[]> {
    const out: TelemetryEvent[] = [];
    await this.eachEvent(days, (batch) => {
      for (const e of batch) {
        out.push(e);
      }
    });
    return out;
  }

  /**
   * Streams the last `days` days of events (files first, then the external store) in batches, so aggregation never
   * needs the whole history in memory at once.
   */
  async eachEvent(days: number, onBatch: (events: TelemetryEvent[]) => void): Promise<void> {
    await this.flush();
    const span = days > 0 ? Math.min(days, MAX_SUMMARY_DAYS) : MAX_SUMMARY_DAYS;
    const cutoff = days > 0 ? dayKey(daysBefore(this.now, span - 1)) : '';
    for (const f of await this.files()) {
      if (f.kind !== 'events' || f.day < cutoff) {
        continue;
      }
      let text: string;
      try {
        text = await fs.promises.readFile(path.join(this.dir, f.name), 'utf8');
      } catch {
        continue;
      }
      const batch: TelemetryEvent[] = [];
      for (const line of text.split('\n')) {
        if (!line) {
          continue;
        }
        try {
          const ev = JSON.parse(line) as TelemetryEvent;
          if (ev && typeof ev.t === 'number' && typeof ev.type === 'string') {
            batch.push(ev);
          }
        } catch {
          /* a torn line from a crash mid-write */
        }
      }
      onBatch(batch);
    }
    const remote = this.activeRemote();
    if (remote) {
      await remote.events(days > 0 ? daysBefore(this.now, span - 1) : 0, onBatch).catch((e) => {
        if (this.opts.remote?.() === remote) {
          this.remoteFailed(e);
        }
      });
    }
  }

  /** Everything on disk as one JSON document (for Export). */
  async exportJson(): Promise<string> {
    const events = await this.events(0);
    const logs = this.ring.slice();
    return JSON.stringify({ exportedAt: new Date(this.now).toISOString(), dir: this.dir, events, logs }, null, 1);
  }

  /** The same document as `exportJson`, written to `file` batch by batch so a long history never sits in memory as one string. */
  async exportTo(file: string): Promise<number> {
    const out = fs.createWriteStream(file, 'utf8');
    const done = new Promise<void>((resolve, reject) => {
      out.on('finish', resolve);
      out.on('error', reject);
    });
    let n = 0;
    out.write(`{\n "exportedAt": ${JSON.stringify(new Date(this.now).toISOString())},\n "dir": ${JSON.stringify(this.dir)},\n "events": [`);
    await this.eachEvent(0, (batch) => {
      for (const e of batch) {
        out.write(`${n++ ? ',' : ''}\n  ${JSON.stringify(e)}`);
      }
    });
    out.write(`\n ],\n "logs": ${JSON.stringify(this.ring)}\n}\n`);
    out.end();
    await done;
    return n;
  }

  // ------------------------------------------------------------------ aggregation
  /**
   * Aggregates the last `days` days. `filter.providers` restricts model and health rows (and the totals they feed) to
   * those provider ids, so the dashboard shows only providers that are configured and enabled right now.
   */
  async summary(days: number, filter?: SummaryFilter): Promise<TelemetrySummary> {
    const files = await this.files();
    const now = this.now;
    let first: number | undefined;
    const agg = aggregator({ days, from: days > 0 ? daysBefore(now, days - 1) : now, to: now }, filter);
    await this.eachEvent(days, (batch) => {
      for (const e of batch) {
        first = first === undefined ? e.t : Math.min(first, e.t);
        agg.add(e);
      }
    });
    const s = agg.finish(days > 0 ? undefined : first ?? now);
    const configured = this.opts.remote?.();
    const remote = this.activeRemote();
    const rs = remote ? await remote.stats().catch((e) => void (this.opts.remote?.() === remote && this.remoteFailed(e))) : undefined;
    const fileOldest = files.length ? Date.parse(`${files[0].day}T00:00:00`) || undefined : undefined;
    const backend = !configured ? 'files' : rs ? 'redis' : 'fallback';
    s.storage = {
      events: s.storage.events,
      bytes: files.reduce((a, f) => a + f.size, 0) + (rs?.bytes ?? 0),
      files: files.length,
      oldest: [fileOldest, rs?.oldest].filter((x): x is number => !!x).sort((a, b) => a - b)[0],
      dir: backend === 'redis' ? `${this.dir} + ${configured!.label}` : backend === 'fallback' ? `${this.dir} (${configured!.label} unreachable — writing to files)` : this.dir,
      backend,
      remoteError: backend === 'fallback' ? this.lastRemoteError : undefined,
    };
    return s;
  }
}

export interface SummaryFilter {
  /** Only count model calls and health checks from these provider ids; `undefined` keeps everything. */
  providers?: Iterable<string>;
}

/** Pure aggregation over a list of events (exported for tests and the preview). */
export function summarize(events: Iterable<TelemetryEvent>, range: { days: number; from: number; to: number }, filter?: SummaryFilter): TelemetrySummary {
  const agg = aggregator(range, filter);
  for (const e of events) {
    agg.add(e);
  }
  return agg.finish();
}

/** The one recovery-rate definition: recovered / (recovered + escalated + exhausted + blocked), in percent, 0 when none ended. */
export function recoveryRate(r: { recovered: number; escalated: number; exhausted: number; blocked: number }): number {
  const ended = r.recovered + r.escalated + r.exhausted + r.blocked;
  return ended ? Math.round((r.recovered / ended) * 1000) / 10 : 0;
}

/** Incremental form of `summarize`: feed events in any number of batches, then `finish()` (optionally with the real start). */
export function aggregator(range: { days: number; from: number; to: number }, filter?: SummaryFilter): { add(e: TelemetryEvent): void; finish(from?: number): TelemetrySummary } {
  const onlyProviders = filter?.providers ? new Set(filter.providers) : undefined;
  const byDay = new Map<string, DayPoint>();
  const dayOf = (t: number) => {
    const k = dayKey(t);
    let p = byDay.get(k);
    if (!p) {
      p = { day: k, runs: 0, failedRuns: 0, tokens: 0, promptTokens: 0, completionTokens: 0, toolCalls: 0, toolErrors: 0, cachedTools: 0, modelCalls: 0, modelErrors: 0, tokPerSec: 0, completionsShown: 0, completionsAccepted: 0, errors: 0, acceptedLines: 0, rejectedLines: 0, hookFailures: 0, costUsd: 0, costByProvider: {} };
      byDay.set(k, p);
    }
    return p;
  };
  // Pre-create the days in range so sparklines have a point per day (and zero days show as zero).
  if (range.days > 0) {
    for (const d = new Date(startOfDay(range.from)); d.getTime() <= range.to; d.setDate(d.getDate() + 1)) {
      dayOf(d.getTime());
    }
  }

  type ModelAgg = { model: string; provider: string; calls: number; promptTokens: number; completionTokens: number; costUsd?: number; genMs: number; ttft: Samples; dur: Samples; errors: number; last: number };
  const models = new Map<string, ModelAgg>();
  type ToolAgg = { name: string; calls: number; errors: number; cached: number; dur: Samples; last: number };
  const tools = new Map<string, ToolAgg>();
  type ModeAgg = { mode: string; runs: number; done: number; stopped: number; failed: number; dur: Samples; steps: Samples; toolCalls: number };
  const modes = new Map<string, ModeAgg>();
  type HealthAgg = { provider: string; checks: number; ok: number; up: boolean; lastAt: number; dur: Samples; lastError?: string; models?: number };
  const health = new Map<string, HealthAgg>();
  const providers = new Map<string, { provider: string; calls: number; pricedCalls: number; costUsd: number }>();
  const completions = { requested: 0, shown: 0, accepted: 0, cached: 0, empty: 0, error: 0, latency: new Samples() };
  const langs = new Map<string, { language: string; shown: number; accepted: number }>();
  const worktrees = { created: 0, applied: 0, discarded: 0, conflicts: 0, files: 0 };
  const errors: TelemetrySummary['errors'] = [];
  // Only the newest 25 are reported; trim as we go so a year of failures does not pile up before the final slice.
  const noteError = (e: TelemetrySummary['errors'][number]): void => {
    errors.push(e);
    if (errors.length > 200) {
      errors.sort((a, b) => b.t - a.t).length = 25;
    }
  };
  const totals = { runs: 0, done: 0, stopped: 0, failed: 0, subagentRuns: 0, modelCalls: 0, modelErrors: 0, retries: 0, promptTokens: 0, completionTokens: 0, costUsd: 0, toolCalls: 0, toolErrors: 0, cachedTools: 0, isolatedRuns: 0 };
  const runTimes = new Samples();
  const runSteps = new Samples();
  const hourly = new Array<number>(24).fill(0);
  const dayGenMs = new Map<string, number>();
  let genMsTotal = 0;
  type AgentAgg = { agent: string; runs: number; done: number; stopped: number; failed: number; dur: Samples; toolCalls: number };
  const agents = new Map<string, AgentAgg>();
  const tasks = { created: 0, completed: 0, aborted: 0, failed: 0, mistakeLimit: 0, incomplete: 0, blocked: 0, unverified: 0 };
  const recovery = { detected: 0, recovered: 0, escalated: 0, blocked: 0, exhausted: 0, acceptedRisks: 0, suggested: 0, succeeded: 0, mttr: new Samples() };
  const recoveryCategories = new Map<string, { category: string; detected: number; recovered: number; attempts: Samples }>();
  const signatures = new Map<string, { signature: string; count: number; recovered: number }>();
  const recoveryRecent: RecoverySummary['recent'] = [];
  const edits = { accepted: 0, rejected: 0, acceptedAdded: 0, acceptedRemoved: 0, rejectedAdded: 0, rejectedRemoved: 0, acceptedFiles: 0, rejectedFiles: 0 };
  const hooks = { runs: 0, ok: 0, blocked: 0, failed: 0, timeout: 0, dur: new Samples() };
  const hookEvents = new Map<string, { event: string; runs: number; failures: number }>();
  const mcpServers = new Map<string, { server: string; calls: number; errors: number; dur: Samples }>();
  const checkpoints = { created: 0, restores: 0, rewinds: 0, failed: 0, files: 0 };
  const modeSwitches = new Map<string, number>();
  const modelSelections = new Map<string, number>();
  const slash = new Map<string, number>();
  const mentions = new Map<string, number>();
  const bump = (m: Map<string, number>, k: string): void => void m.set(k, (m.get(k) ?? 0) + 1);
  const ranked = <K extends string>(m: Map<string, number>, key: K, limit = 10): ({ count: number } & Record<K, string>)[] =>
    [...m].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([k, count]) => ({ [key]: k, count }) as { count: number } & Record<K, string>);
  let count = 0;

  const add = (e: TelemetryEvent): void => {
    count++;
    if (onlyProviders && (e.type === 'model' || e.type === 'health') && !onlyProviders.has(e.provider)) {
      return;
    }
    const day = dayOf(e.t);
    switch (e.type) {
      case 'model': {
        const key = `${e.provider}/${e.model}`;
        let m = models.get(key);
        if (!m) {
          m = { model: e.model, provider: e.provider, calls: 0, promptTokens: 0, completionTokens: 0, genMs: 0, ttft: new Samples(), dur: new Samples(), errors: 0, last: 0 };
          models.set(key, m);
        }
        m.calls++;
        m.last = Math.max(m.last, e.t);
        let pv = providers.get(e.provider);
        if (!pv) {
          pv = { provider: e.provider, calls: 0, pricedCalls: 0, costUsd: 0 };
          providers.set(e.provider, pv);
        }
        pv.calls++;
        day.modelCalls++;
        totals.modelCalls++;
        hourly[new Date(e.t).getHours()]++;
        if (e.outcome === 'ok') {
          m.promptTokens += e.promptTokens ?? 0;
          m.completionTokens += e.completionTokens ?? 0;
          totals.promptTokens += e.promptTokens ?? 0;
          totals.completionTokens += e.completionTokens ?? 0;
          if (typeof e.costUsd === 'number' && Number.isFinite(e.costUsd)) {
            m.costUsd = (m.costUsd ?? 0) + e.costUsd;
            totals.costUsd += e.costUsd;
            day.costUsd += e.costUsd;
            day.costByProvider[e.provider] = (day.costByProvider[e.provider] ?? 0) + e.costUsd;
            pv.pricedCalls++;
            pv.costUsd += e.costUsd;
          }
          day.tokens += (e.promptTokens ?? 0) + (e.completionTokens ?? 0);
          day.promptTokens += e.promptTokens ?? 0;
          day.completionTokens += e.completionTokens ?? 0;
          m.dur.add(e.durationMs);
          let gen = 0;
          if (e.ttftMs !== undefined) {
            m.ttft.add(e.ttftMs);
            if (e.completionTokens) {
              gen = Math.max(1, e.durationMs - e.ttftMs);
            }
          } else if (e.completionTokens) {
            gen = Math.max(1, e.durationMs);
          }
          if (gen) {
            m.genMs += gen;
            genMsTotal += gen;
            dayGenMs.set(day.day, (dayGenMs.get(day.day) ?? 0) + gen);
          }
        } else if (e.outcome === 'retry') {
          totals.retries++;
        } else if (e.outcome === 'error') {
          m.errors++;
          totals.modelErrors++;
          day.modelErrors++;
          day.errors++;
          noteError({ t: e.t, kind: 'model', what: e.model, detail: e.reason ?? 'error' });
        }
        break;
      }
      case 'tool': {
        let t = tools.get(e.name);
        if (!t) {
          t = { name: e.name, calls: 0, errors: 0, cached: 0, dur: new Samples(), last: 0 };
          tools.set(e.name, t);
        }
        t.calls++;
        t.last = Math.max(t.last, e.t);
        day.toolCalls++;
        totals.toolCalls++;
        hourly[new Date(e.t).getHours()]++;
        if (e.cached) {
          t.cached++;
          totals.cachedTools++;
          day.cachedTools++;
        } else {
          t.dur.add(e.durationMs);
        }
        if (e.error) {
          t.errors++;
          totals.toolErrors++;
          day.toolErrors++;
          day.errors++;
        }
        break;
      }
      case 'run': {
        if (e.depth > 0) {
          totals.subagentRuns++;
          const name = e.agent || 'subagent';
          let a = agents.get(name);
          if (!a) {
            a = { agent: name, runs: 0, done: 0, stopped: 0, failed: 0, dur: new Samples(), toolCalls: 0 };
            agents.set(name, a);
          }
          a.runs++;
          a[e.outcome]++;
          a.dur.add(e.durationMs);
          a.toolCalls += e.toolCalls;
        }
        if (e.isolated) {
          totals.isolatedRuns++;
        }
        totals.runs++;
        totals[e.outcome]++;
        day.runs++;
        if (e.outcome === 'failed') {
          day.failedRuns++;
        }
        runTimes.add(e.durationMs);
        runSteps.add(e.steps);
        let m = modes.get(e.mode);
        if (!m) {
          m = { mode: e.mode, runs: 0, done: 0, stopped: 0, failed: 0, dur: new Samples(), steps: new Samples(), toolCalls: 0 };
          modes.set(e.mode, m);
        }
        m.runs++;
        m[e.outcome]++;
        m.dur.add(e.durationMs);
        m.steps.add(e.steps);
        m.toolCalls += e.toolCalls;
        if (e.outcome === 'failed') {
          noteError({ t: e.t, kind: 'run', what: `${e.mode} run`, detail: `${e.model} · failed after ${e.steps} step${e.steps === 1 ? '' : 's'}` });
        }
        break;
      }
      case 'completion': {
        completions[e.action]++;
        if (e.action === 'shown' || e.action === 'cached') {
          day.completionsShown++;
        }
        if (e.action === 'accepted') {
          day.completionsAccepted++;
        }
        if (e.action === 'shown' && e.durationMs !== undefined) {
          completions.latency.add(e.durationMs);
        }
        if (e.language && (e.action === 'shown' || e.action === 'cached' || e.action === 'accepted')) {
          let l = langs.get(e.language);
          if (!l) {
            l = { language: e.language, shown: 0, accepted: 0 };
            langs.set(e.language, l);
          }
          if (e.action === 'accepted') {
            l.accepted++;
          } else {
            l.shown++;
          }
        }
        break;
      }
      case 'health': {
        let h = health.get(e.provider);
        if (!h) {
          h = { provider: e.provider, checks: 0, ok: 0, up: false, lastAt: 0, dur: new Samples() };
          health.set(e.provider, h);
        }
        h.checks++;
        if (e.ok) {
          h.ok++;
          h.dur.add(e.durationMs);
        }
        if (e.t >= h.lastAt) {
          h.lastAt = e.t;
          h.up = e.ok;
          h.lastError = e.ok ? undefined : e.error ?? 'unreachable';
          h.models = e.models ?? h.models;
        }
        if (!e.ok) {
          noteError({ t: e.t, kind: 'health', what: e.provider, detail: e.error ?? 'unreachable' });
        }
        break;
      }
      case 'worktree':
        if (e.action === 'create') {
          worktrees.created++;
        } else if (e.action === 'apply') {
          worktrees.applied++;
          worktrees.files += e.files ?? 0;
          worktrees.conflicts += e.conflicts ?? 0;
        } else {
          worktrees.discarded++;
        }
        break;
      case 'task':
        tasks[e.action === 'mistake_limit' ? 'mistakeLimit' : e.action === 'completed_unverified' ? 'unverified' : e.action]++;
        break;
      case 'recovery': {
        const sig = e.signature && SIGNATURE_HASH.test(e.signature) ? e.signature : undefined;
        let c = recoveryCategories.get(e.category);
        if (!c) {
          c = { category: e.category, detected: 0, recovered: 0, attempts: new Samples() };
          recoveryCategories.set(e.category, c);
        }
        let s = sig ? signatures.get(sig) : undefined;
        if (sig && !s && e.action === 'detected') {
          s = { signature: sig, count: 0, recovered: 0 };
          signatures.set(sig, s);
        }
        switch (e.action) {
          case 'detected':
            recovery.detected++;
            c.detected++;
            if (s) {
              s.count++;
            }
            break;
          case 'recovered':
            recovery.recovered++;
            c.recovered++;
            if (s) {
              s.recovered++;
            }
            if (e.durationMs !== undefined) {
              recovery.mttr.add(e.durationMs);
            }
            if (e.outcome === 'memory') {
              recovery.succeeded++;
            }
            break;
          case 'escalated':
            recovery.escalated++;
            day.errors++;
            noteError({ t: e.t, kind: 'run', what: 'self-healing', detail: `${e.category} escalated${e.attempt ? ` after ${e.attempt} attempt${e.attempt === 1 ? '' : 's'}` : ''}` });
            break;
          case 'blocked':
            recovery.blocked++;
            break;
          case 'exhausted':
            recovery.exhausted++;
            break;
          case 'memory_hit':
            recovery.suggested++;
            break;
          case 'accept_risk':
            recovery.acceptedRisks++;
            break;
        }
        if (e.attempt !== undefined && (e.action === 'recovered' || e.action === 'escalated' || e.action === 'exhausted' || e.action === 'blocked')) {
          c.attempts.add(e.attempt);
        }
        recoveryRecent.push({ t: e.t, sid: e.sid, category: e.category, action: e.action, signature: sig, attempt: e.attempt });
        if (recoveryRecent.length > 400) {
          recoveryRecent.sort((a, b) => b.t - a.t).length = 50;
        }
        break;
      }
      case 'edit_decision': {
        const lines = e.added + e.removed;
        if (e.decision === 'accepted') {
          edits.accepted++;
          edits.acceptedAdded += e.added;
          edits.acceptedRemoved += e.removed;
          edits.acceptedFiles += e.files;
          day.acceptedLines += lines;
        } else {
          edits.rejected++;
          edits.rejectedAdded += e.added;
          edits.rejectedRemoved += e.removed;
          edits.rejectedFiles += e.files;
          day.rejectedLines += lines;
        }
        break;
      }
      case 'hook': {
        hooks.runs++;
        hooks[e.outcome]++;
        hooks.dur.add(e.durationMs);
        let h = hookEvents.get(e.event);
        if (!h) {
          h = { event: e.event, runs: 0, failures: 0 };
          hookEvents.set(e.event, h);
        }
        h.runs++;
        if (e.outcome === 'failed' || e.outcome === 'timeout') {
          h.failures++;
          day.hookFailures++;
          day.errors++;
          noteError({ t: e.t, kind: 'hook', what: e.event, detail: e.outcome === 'timeout' ? 'timed out' : 'exited with an error' });
        }
        break;
      }
      case 'mcp_call': {
        let m = mcpServers.get(e.server);
        if (!m) {
          m = { server: e.server, calls: 0, errors: 0, dur: new Samples() };
          mcpServers.set(e.server, m);
        }
        m.calls++;
        m.dur.add(e.durationMs);
        if (!e.ok) {
          m.errors++;
          day.errors++;
          noteError({ t: e.t, kind: 'mcp', what: `${e.server}/${e.tool}`, detail: 'call failed' });
        }
        break;
      }
      case 'checkpoint':
        if (e.action === 'create') {
          checkpoints.created++;
        } else if (e.outcome === 'failed') {
          checkpoints.failed++;
        } else {
          checkpoints[e.action === 'restore' ? 'restores' : 'rewinds']++;
          checkpoints.files += e.files ?? 0;
        }
        break;
      case 'mode_switch':
        bump(modeSwitches, e.to);
        break;
      case 'model_selected':
        bump(modelSelections, e.model);
        break;
      case 'slash':
        bump(slash, e.command);
        break;
      case 'mention':
        bump(mentions, e.kind);
        break;
    }
  };

  const finish = (from = range.from): TelemetrySummary => {
    const shownTotal = completions.shown + completions.cached;
    errors.sort((a, b) => b.t - a.t);
    const series = [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day));
    for (const d of series) {
      const gen = dayGenMs.get(d.day);
      d.tokPerSec = gen ? Math.round((d.completionTokens / gen) * 1000 * 10) / 10 : 0;
    }
    const activeDays = series.filter((d) => d.runs || d.modelCalls || d.toolCalls || d.completionsShown).length;
    return {
      days: range.days,
      from,
      to: range.to,
      totals: { ...totals, activeDays, tokPerSec: genMsTotal ? Math.round((totals.completionTokens / genMsTotal) * 1000 * 10) / 10 : 0, runTime: percentiles(runTimes), steps: percentiles(runSteps) },
      series,
      hourly,
      agents: [...agents.values()].map((a) => ({ agent: a.agent, runs: a.runs, done: a.done, stopped: a.stopped, failed: a.failed, duration: percentiles(a.dur), toolCalls: a.toolCalls })).sort((a, b) => b.runs - a.runs),
      providers: [...providers.values()].sort((a, b) => b.costUsd - a.costUsd || b.calls - a.calls),
      models: [...models.values()]
        .map((m) => ({ model: m.model, provider: m.provider, calls: m.calls, promptTokens: m.promptTokens, completionTokens: m.completionTokens, costUsd: m.costUsd, tokPerSec: m.genMs ? Math.round((m.completionTokens / m.genMs) * 1000 * 10) / 10 : 0, ttft: percentiles(m.ttft), duration: percentiles(m.dur), errors: m.errors, last: m.last }))
        .sort((a, b) => b.calls - a.calls),
      tools: [...tools.values()].map((t) => ({ name: t.name, calls: t.calls, errors: t.errors, cached: t.cached, duration: percentiles(t.dur), last: t.last })).sort((a, b) => b.calls - a.calls),
      modes: [...modes.values()].map((m) => ({ mode: m.mode, runs: m.runs, done: m.done, stopped: m.stopped, failed: m.failed, duration: percentiles(m.dur), steps: percentiles(m.steps), toolCalls: m.toolCalls })).sort((a, b) => b.runs - a.runs),
      completions: {
        requested: completions.requested,
        shown: completions.shown,
        accepted: completions.accepted,
        cached: completions.cached,
        empty: completions.empty,
        error: completions.error,
        acceptanceRate: shownTotal ? Math.round((completions.accepted / shownTotal) * 1000) / 10 : 0,
        latency: percentiles(completions.latency),
        byLanguage: [...langs.values()].sort((a, b) => b.shown - a.shown).slice(0, 8),
      },
      health: [...health.values()].map((h) => ({ provider: h.provider, checks: h.checks, ok: h.ok, uptime: h.checks ? Math.round((h.ok / h.checks) * 1000) / 10 : 0, up: h.up, lastAt: h.lastAt, latency: percentiles(h.dur), lastError: h.lastError, models: h.models })).sort((a, b) => a.provider.localeCompare(b.provider)),
      worktrees,
      activity: {
        tasks: { ...tasks },
        edits: { ...edits },
        hooks: { runs: hooks.runs, ok: hooks.ok, blocked: hooks.blocked, failed: hooks.failed, timeout: hooks.timeout, duration: percentiles(hooks.dur), byEvent: [...hookEvents.values()].sort((a, b) => b.runs - a.runs) },
        mcp: {
          calls: [...mcpServers.values()].reduce((a, m) => a + m.calls, 0),
          errors: [...mcpServers.values()].reduce((a, m) => a + m.errors, 0),
          servers: [...mcpServers.values()].map((m) => ({ server: m.server, calls: m.calls, errors: m.errors, duration: percentiles(m.dur) })).sort((a, b) => b.calls - a.calls),
        },
        checkpoints: { ...checkpoints },
        modeSwitches: ranked(modeSwitches, 'to'),
        modelSelections: ranked(modelSelections, 'model'),
        slash: ranked(slash, 'command', 15),
        mentions: ranked(mentions, 'kind'),
      },
      recovery: {
        detected: recovery.detected,
        recovered: recovery.recovered,
        escalated: recovery.escalated,
        blocked: recovery.blocked,
        exhausted: recovery.exhausted,
        rate: recoveryRate(recovery),
        mttr: percentiles(recovery.mttr),
        byCategory: [...recoveryCategories.values()]
          .filter((c) => c.detected || c.recovered || c.attempts.count)
          .map((c) => ({ category: c.category, detected: c.detected, recovered: c.recovered, attempts: percentiles(c.attempts) }))
          .sort((a, b) => b.detected - a.detected || b.recovered - a.recovered),
        topSignatures: [...signatures.values()].sort((a, b) => b.count - a.count || b.recovered - a.recovered).slice(0, 10),
        memory: { suggested: recovery.suggested, succeeded: recovery.succeeded },
        recent: recoveryRecent.sort((a, b) => b.t - a.t).slice(0, 50),
        acceptedRisks: recovery.acceptedRisks,
      },
      errors: errors.slice(0, 25),
      storage: { events: count, bytes: 0, files: 0, dir: '' },
    };
  };
  return { add, finish };
}

/** Collects the numbers for one agent turn; the runner records a `run` event from it when the turn ends. */
export class RunStats {
  readonly startedAt: number;
  model = '';
  steps = 0;
  toolCalls = 0;
  promptTokens = 0;
  completionTokens = 0;
  /** Time spent generating (first token to end of stream) and the tokens produced then, summed over the run's steps. */
  genMs = 0;
  genTokens = 0;
  /** The run stopped at the consecutive-mistake limit; its task outcome is `mistake_limit`, not `completed`. */
  mistakeLimited = false;
  constructor(now = Date.now()) {
    this.startedAt = now;
  }
}
