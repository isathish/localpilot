// Local-only telemetry: what the models, tools and completions did on this machine, kept as daily JSONL files plus a
// mirror of the LocalPilot log. Nothing here talks to the network. Pure Node so the extension and the CLI share it.
import * as fs from 'fs';
import * as path from 'path';

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
  | (Base & { type: 'run'; sid: string; mode: string; model: string; depth: number; agent?: string; outcome: RunOutcome; durationMs: number; steps: number; toolCalls: number; promptTokens: number; completionTokens: number; isolated?: boolean })
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
  storage: { events: number; bytes: number; files: number; oldest?: number; dir: string };
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
}

const FLUSH_MS = 400;
const MAX_SUMMARY_DAYS = 365;
const LOG_PREFIX = 'localpilot-';
const EVENT_PREFIX = 'events-';

const dayKey = (t: number): string => {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const startOfDay = (t: number): number => {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

export function percentiles(values: number[]): Percentiles {
  if (!values.length) {
    return { p50: 0, p95: 0, avg: 0 };
  }
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))];
  return { p50: at(0.5), p95: at(0.95), avg: Math.round(sorted.reduce((a, b) => a + b, 0) / sorted.length) };
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
    this.schedule();
    for (const l of this.eventListeners) {
      l(ev);
    }
  }

  onEvent(l: (e: TelemetryEvent) => void): () => void {
    this.eventListeners.add(l);
    return () => this.eventListeners.delete(l);
  }

  // ------------------------------------------------------------------ logs
  log(level: LogLevel, msg: string): void {
    const entry: LogEntry = { t: this.now, level, msg: String(msg) };
    this.ring.push(entry);
    const max = this.opts.logBuffer ?? 3000;
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
    this.schedule();
    for (const l of this.logListeners) {
      l(entry);
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

  /** Seeds the in-memory log with the tail of today's file so the dashboard shows lines from before this start. */
  async loadRecentLogs(limit = 400): Promise<void> {
    try {
      const text = await fs.promises.readFile(this.logFile(), 'utf8');
      const lines = text.split('\n').filter(Boolean);
      const tail = lines.slice(Math.max(0, lines.length - limit));
      const parsed: LogEntry[] = [];
      for (const line of tail) {
        const m = /^(\S+) \[(trace|debug|info|warn|error)\] (.*)$/.exec(line);
        if (m) {
          parsed.push({ t: Date.parse(m[1]) || this.now, level: m[2] as LogLevel, msg: m[3].replace(/\\n/g, '\n') });
        }
      }
      this.ring.unshift(...parsed);
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
    await fs.promises.mkdir(this.dir, { recursive: true });
    for (const [day, lines] of events) {
      await fs.promises.appendFile(path.join(this.dir, `${EVENT_PREFIX}${day}.jsonl`), `${lines.join('\n')}\n`, 'utf8');
    }
    for (const [day, lines] of logs) {
      await fs.promises.appendFile(path.join(this.dir, `${LOG_PREFIX}${day}.log`), `${lines.join('\n')}\n`, 'utf8');
    }
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
    return removed;
  }

  /** Deletes all recorded events and logs. */
  async clear(): Promise<void> {
    await this.flush();
    this.ring.length = 0;
    for (const f of await this.files()) {
      await fs.promises.rm(path.join(this.dir, f.name), { force: true });
    }
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
    await this.flush();
    const span = days > 0 ? Math.min(days, MAX_SUMMARY_DAYS) : MAX_SUMMARY_DAYS;
    const cutoff = days > 0 ? dayKey(startOfDay(this.now) - (span - 1) * 86400_000) : '';
    const out: TelemetryEvent[] = [];
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
      for (const line of text.split('\n')) {
        if (!line) {
          continue;
        }
        try {
          const ev = JSON.parse(line) as TelemetryEvent;
          if (ev && typeof ev.t === 'number' && typeof ev.type === 'string') {
            out.push(ev);
          }
        } catch {
          /* a torn line from a crash mid-write */
        }
      }
    }
    return out;
  }

  /** Everything on disk as one JSON document (for Export). */
  async exportJson(): Promise<string> {
    const events = await this.events(0);
    const logs = this.ring.slice();
    return JSON.stringify({ exportedAt: new Date(this.now).toISOString(), dir: this.dir, events, logs }, null, 1);
  }

  // ------------------------------------------------------------------ aggregation
  async summary(days: number): Promise<TelemetrySummary> {
    const events = await this.events(days);
    const files = await this.files();
    const now = this.now;
    const from = days > 0 ? startOfDay(now) - (days - 1) * 86400_000 : events[0]?.t ?? now;
    const s = summarize(events, { days, from, to: now });
    s.storage = {
      events: events.length,
      bytes: files.reduce((a, f) => a + f.size, 0),
      files: files.length,
      oldest: files.length ? Date.parse(`${files[0].day}T00:00:00`) || undefined : undefined,
      dir: this.dir,
    };
    return s;
  }
}

/** Pure aggregation over a list of events (exported for tests and the preview). */
export function summarize(events: TelemetryEvent[], range: { days: number; from: number; to: number }): TelemetrySummary {
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

  type ModelAgg = { model: string; provider: string; calls: number; promptTokens: number; completionTokens: number; genMs: number; ttft: number[]; dur: number[]; errors: number; last: number };
  const models = new Map<string, ModelAgg>();
  type ToolAgg = { name: string; calls: number; errors: number; cached: number; dur: number[]; last: number };
  const tools = new Map<string, ToolAgg>();
  type ModeAgg = { mode: string; runs: number; done: number; stopped: number; failed: number; dur: number[]; steps: number[]; toolCalls: number };
  const modes = new Map<string, ModeAgg>();
  type HealthAgg = { provider: string; checks: number; ok: number; up: boolean; lastAt: number; dur: number[]; lastError?: string; models?: number };
  const health = new Map<string, HealthAgg>();
  const completions = { requested: 0, shown: 0, accepted: 0, cached: 0, empty: 0, error: 0, latency: [] as number[] };
  const langs = new Map<string, { language: string; shown: number; accepted: number }>();
  const worktrees = { created: 0, applied: 0, discarded: 0, conflicts: 0, files: 0 };
  const errors: TelemetrySummary['errors'] = [];
  const totals = { runs: 0, done: 0, stopped: 0, failed: 0, subagentRuns: 0, modelCalls: 0, modelErrors: 0, retries: 0, promptTokens: 0, completionTokens: 0, toolCalls: 0, toolErrors: 0, cachedTools: 0, isolatedRuns: 0 };
  const runTimes: number[] = [];
  const runSteps: number[] = [];
  const hourly = new Array<number>(24).fill(0);
  const dayGenMs = new Map<string, number>();
  let genMsTotal = 0;
  type AgentAgg = { agent: string; runs: number; done: number; stopped: number; failed: number; dur: number[]; toolCalls: number };
  const agents = new Map<string, AgentAgg>();

  for (const e of events) {
    const day = dayOf(e.t);
    switch (e.type) {
      case 'model': {
        const key = `${e.provider}/${e.model}`;
        let m = models.get(key);
        if (!m) {
          m = { model: e.model, provider: e.provider, calls: 0, promptTokens: 0, completionTokens: 0, genMs: 0, ttft: [], dur: [], errors: 0, last: 0 };
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
          m.dur.push(e.durationMs);
          let gen = 0;
          if (e.ttftMs !== undefined) {
            m.ttft.push(e.ttftMs);
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
          errors.push({ t: e.t, kind: 'model', what: e.model, detail: e.reason ?? 'error' });
        }
        break;
      }
      case 'tool': {
        let t = tools.get(e.name);
        if (!t) {
          t = { name: e.name, calls: 0, errors: 0, cached: 0, dur: [], last: 0 };
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
          t.dur.push(e.durationMs);
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
            a = { agent: name, runs: 0, done: 0, stopped: 0, failed: 0, dur: [], toolCalls: 0 };
            agents.set(name, a);
          }
          a.runs++;
          a[e.outcome]++;
          a.dur.push(e.durationMs);
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
        runTimes.push(e.durationMs);
        runSteps.push(e.steps);
        let m = modes.get(e.mode);
        if (!m) {
          m = { mode: e.mode, runs: 0, done: 0, stopped: 0, failed: 0, dur: [], steps: [], toolCalls: 0 };
          modes.set(e.mode, m);
        }
        m.runs++;
        m[e.outcome]++;
        m.dur.push(e.durationMs);
        m.steps.push(e.steps);
        m.toolCalls += e.toolCalls;
        if (e.outcome === 'failed') {
          errors.push({ t: e.t, kind: 'run', what: `${e.mode} run`, detail: `${e.model} · failed after ${e.steps} step${e.steps === 1 ? '' : 's'}` });
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
          completions.latency.push(e.durationMs);
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
          h = { provider: e.provider, checks: 0, ok: 0, up: false, lastAt: 0, dur: [] };
          health.set(e.provider, h);
        }
        h.checks++;
        if (e.ok) {
          h.ok++;
          h.dur.push(e.durationMs);
        }
        if (e.t >= h.lastAt) {
          h.lastAt = e.t;
          h.up = e.ok;
          h.lastError = e.ok ? undefined : e.error ?? 'unreachable';
          h.models = e.models ?? h.models;
        }
        if (!e.ok) {
          errors.push({ t: e.t, kind: 'health', what: e.provider, detail: e.error ?? 'unreachable' });
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
  }

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
    from: range.from,
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
    storage: { events: events.length, bytes: 0, files: 0, dir: '' },
  };
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
