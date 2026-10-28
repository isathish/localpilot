// Local-only telemetry: what the models, tools and completions did on this machine, kept as daily JSONL files plus a
// mirror of the LocalPilot log. Nothing here talks to the network. Pure Node so the extension and the CLI share it.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

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
}
export type TelemetryEvent =
  /** One model request (an attempt; retries record their own event). */
  | (Base & { type: 'model'; sid: string; model: string; provider: string; mode: string; depth: number; promptTokens?: number; completionTokens?: number; ttftMs?: number; durationMs: number; outcome: ModelOutcome; reason?: string })
  /** One tool execution. */
  | (Base & { type: 'tool'; sid: string; name: string; mode: string; durationMs: number; error: boolean; cached?: boolean })
  /** One agent turn (depth > 0 is a subagent). */
  | (Base & { type: 'run'; sid: string; mode: string; model: string; depth: number; agent?: string; /** Routing role the run was picked for (agent, reasoning, fast, coding…). */ role?: string; outcome: RunOutcome; durationMs: number; steps: number; toolCalls: number; promptTokens: number; completionTokens: number; isolated?: boolean })
  /** Isolated worktree lifecycle. */
  | (Base & { type: 'worktree'; action: 'create' | 'apply' | 'discard'; files?: number; conflicts?: number; durationMs?: number })
  /** Inline completion lifecycle. */
  | (Base & { type: 'completion'; action: CompletionAction; model?: string; language?: string; durationMs?: number })
  /** Provider reachability check. */
  | (Base & { type: 'health'; provider: string; ok: boolean; durationMs: number; models?: number; error?: string });

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
  models: { model: string; provider: string; calls: number; promptTokens: number; completionTokens: number; tokPerSec: number; ttft: Percentiles; duration: Percentiles; errors: number; last: number }[];
  tools: { name: string; calls: number; errors: number; cached: number; duration: Percentiles; last: number }[];
  modes: { mode: string; runs: number; done: number; stopped: number; failed: number; duration: Percentiles; steps: Percentiles; toolCalls: number }[];
  completions: { requested: number; shown: number; accepted: number; cached: number; empty: number; error: number; acceptanceRate: number; latency: Percentiles; byLanguage: { language: string; shown: number; accepted: number }[] };
  health: { provider: string; checks: number; ok: number; uptime: number; up: boolean; lastAt: number; latency: Percentiles; lastError?: string; models?: number }[];
  worktrees: { created: number; applied: number; discarded: number; conflicts: number; files: number };
  errors: { t: number; kind: 'model' | 'tool' | 'run' | 'health'; what: string; detail: string }[];
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
}

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

const capPending = (lines: string[]): void => {
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

/** One stored log line (`ISO [level] msg`, newlines escaped) back into an entry. */
export function parseLogLine(line: string): LogEntry | undefined {
  const m = /^(\S+) \[(trace|debug|info|warn|error)\] (.*)$/.exec(line);
  return m ? { t: Date.parse(m[1]) || Date.now(), level: m[2] as LogLevel, msg: m[3].replace(/\\n/g, '\n') } : undefined;
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

/**
 * Append-only store of local telemetry events and log lines. Events go to `events-YYYY-MM-DD.jsonl`, log lines to
 * `localpilot-YYYY-MM-DD.log`; both are pruned by the retention setting. Writes are batched and never awaited by
 * callers; `flush()` waits for them (dispose, tests).
 */
export class Telemetry {
  private pendingEvents = new Map<string, string[]>();
  private pendingLogs = new Map<string, string[]>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private writing: Promise<void> = Promise.resolve();
  private readonly ring: LogEntry[] = [];
  private readonly logListeners = new Set<(e: LogEntry) => void>();
  private readonly eventListeners = new Set<(e: TelemetryEvent) => void>();
  private lastPrune = 0;
  private remoteDownUntil = 0;
  private lastRemoteError: string | undefined;
  readonly dir: string;

  constructor(private readonly opts: TelemetryOptions) {
    this.dir = opts.dir;
  }

  private get now(): number {
    return (this.opts.now ?? Date.now)();
  }
  private get enabled(): boolean {
    return this.opts.enabled ? this.opts.enabled() : true;
  }

  // ------------------------------------------------------------------ events
  record(e: TelemetryInput): void {
    if (!this.enabled) {
      return;
    }
    const ev = { ...e, t: e.t ?? this.now } as TelemetryEvent;
    const key = dayKey(ev.t);
    let lines = this.pendingEvents.get(key);
    if (!lines) {
      lines = [];
      this.pendingEvents.set(key, lines);
    }
    lines.push(JSON.stringify(ev));
    capPending(lines);
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
    const key = dayKey(entry.t);
    let lines = this.pendingLogs.get(key);
    if (!lines) {
      lines = [];
      this.pendingLogs.set(key, lines);
    }
    lines.push(`${new Date(entry.t).toISOString()} [${level}] ${entry.msg.replace(/\r?\n/g, '\\n')}`);
    capPending(lines);
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
        this.remoteFailed(e);
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
    const events = this.pendingEvents;
    const logs = this.pendingLogs;
    this.pendingEvents = new Map();
    this.pendingLogs = new Map();
    if (!events.size && !logs.size) {
      return;
    }
    const remote = this.activeRemote();
    if (remote) {
      try {
        await remote.write([...events.values()].flat(), [...logs.values()].flat(), this.opts.retentionDays());
        await this.maybePrune();
        return;
      } catch (e) {
        this.remoteFailed(e);
      }
    }
    await fs.promises.mkdir(this.dir, { recursive: true });
    for (const [day, lines] of events) {
      await fs.promises.appendFile(path.join(this.dir, `${EVENT_PREFIX}${day}.jsonl`), `${lines.join('\n')}\n`, 'utf8');
    }
    for (const [day, lines] of logs) {
      await fs.promises.appendFile(path.join(this.dir, `${LOG_PREFIX}${day}.log`), `${lines.join('\n')}\n`, 'utf8');
    }
    await this.maybePrune();
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
  }

  dispose(): void {
    void this.flush();
  }

  /** Removes event and log files older than the retention window. Returns the number of files removed. */
  async prune(): Promise<number> {
    const days = this.opts.retentionDays();
    if (!days || days <= 0) {
      return 0;
    }
    const cutoff = dayKey(startOfDay(this.now) - (days - 1) * 86400_000);
    let removed = 0;
    for (const f of await this.files()) {
      if (f.day < cutoff) {
        await fs.promises.rm(path.join(this.dir, f.name), { force: true });
        removed++;
      }
    }
    await this.opts.remote?.()?.prune(startOfDay(this.now) - (days - 1) * 86400_000).catch(() => undefined);
    return removed;
  }

  /** Deletes all recorded events and logs. */
  async clear(): Promise<void> {
    await this.flush();
    this.ring.length = 0;
    for (const f of await this.files()) {
      await fs.promises.rm(path.join(this.dir, f.name), { force: true });
    }
    await this.opts.remote?.()?.clear().catch(() => undefined);
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
    const cutoff = days > 0 ? dayKey(startOfDay(this.now) - (span - 1) * 86400_000) : '';
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
      await remote.events(days > 0 ? startOfDay(this.now) - (span - 1) * 86400_000 : 0, onBatch).catch((e) => this.remoteFailed(e));
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
    const agg = aggregator({ days, from: days > 0 ? startOfDay(now) - (days - 1) * 86400_000 : now, to: now }, filter);
    await this.eachEvent(days, (batch) => {
      for (const e of batch) {
        first = first === undefined ? e.t : Math.min(first, e.t);
        agg.add(e);
      }
    });
    const s = agg.finish(days > 0 ? undefined : first ?? now);
    const configured = this.opts.remote?.();
    const remote = this.activeRemote();
    const rs = remote ? await remote.stats().catch((e) => void this.remoteFailed(e)) : undefined;
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

/** Incremental form of `summarize`: feed events in any number of batches, then `finish()` (optionally with the real start). */
export function aggregator(range: { days: number; from: number; to: number }, filter?: SummaryFilter): { add(e: TelemetryEvent): void; finish(from?: number): TelemetrySummary } {
  const onlyProviders = filter?.providers ? new Set(filter.providers) : undefined;
  const byDay = new Map<string, DayPoint>();
  const dayOf = (t: number) => {
    const k = dayKey(t);
    let p = byDay.get(k);
    if (!p) {
      p = { day: k, runs: 0, failedRuns: 0, tokens: 0, promptTokens: 0, completionTokens: 0, toolCalls: 0, toolErrors: 0, cachedTools: 0, modelCalls: 0, modelErrors: 0, tokPerSec: 0, completionsShown: 0, completionsAccepted: 0, errors: 0 };
      byDay.set(k, p);
    }
    return p;
  };
  // Pre-create the days in range so sparklines have a point per day (and zero days show as zero).
  if (range.days > 0) {
    for (let d = startOfDay(range.from); d <= range.to; d += 86400_000) {
      dayOf(d);
    }
  }

  type ModelAgg = { model: string; provider: string; calls: number; promptTokens: number; completionTokens: number; genMs: number; ttft: Samples; dur: Samples; errors: number; last: number };
  const models = new Map<string, ModelAgg>();
  type ToolAgg = { name: string; calls: number; errors: number; cached: number; dur: Samples; last: number };
  const tools = new Map<string, ToolAgg>();
  type ModeAgg = { mode: string; runs: number; done: number; stopped: number; failed: number; dur: Samples; steps: Samples; toolCalls: number };
  const modes = new Map<string, ModeAgg>();
  type HealthAgg = { provider: string; checks: number; ok: number; up: boolean; lastAt: number; dur: Samples; lastError?: string; models?: number };
  const health = new Map<string, HealthAgg>();
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
  const totals = { runs: 0, done: 0, stopped: 0, failed: 0, subagentRuns: 0, modelCalls: 0, modelErrors: 0, retries: 0, promptTokens: 0, completionTokens: 0, toolCalls: 0, toolErrors: 0, cachedTools: 0, isolatedRuns: 0 };
  const runTimes = new Samples();
  const runSteps = new Samples();
  const hourly = new Array<number>(24).fill(0);
  const dayGenMs = new Map<string, number>();
  let genMsTotal = 0;
  type AgentAgg = { agent: string; runs: number; done: number; stopped: number; failed: number; dur: Samples; toolCalls: number };
  const agents = new Map<string, AgentAgg>();
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
        day.modelCalls++;
        totals.modelCalls++;
        hourly[new Date(e.t).getHours()]++;
        if (e.outcome === 'ok') {
          m.promptTokens += e.promptTokens ?? 0;
          m.completionTokens += e.completionTokens ?? 0;
          totals.promptTokens += e.promptTokens ?? 0;
          totals.completionTokens += e.completionTokens ?? 0;
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
      models: [...models.values()]
        .map((m) => ({ model: m.model, provider: m.provider, calls: m.calls, promptTokens: m.promptTokens, completionTokens: m.completionTokens, tokPerSec: m.genMs ? Math.round((m.completionTokens / m.genMs) * 1000 * 10) / 10 : 0, ttft: percentiles(m.ttft), duration: percentiles(m.dur), errors: m.errors, last: m.last }))
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
  constructor(now = Date.now()) {
    this.startedAt = now;
  }
}
