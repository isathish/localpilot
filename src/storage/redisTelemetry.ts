// Optional Redis Stack backend for telemetry: events and log lines go to capped Redis streams instead of daily files,
// and numeric metrics also become RedisTimeSeries series (when the module is loaded) for Grafana / RedisInsight.
import type { TelemetryEvent, TelemetryRemote } from '../telemetry/telemetry';
import { RedisClient, RedisError, RedisReply, redactRedisUrl } from './redis';

export const EVENTS_KEY = 'localpilot:events';
export const LOGS_KEY = 'localpilot:logs';
export const TS_PREFIX = 'localpilot:ts:';
/** Log lines kept when retention is unlimited. */
const LOG_MAXLEN = 100_000;
const BATCH = 2000;

export interface RedisProbe {
  ok: boolean;
  timeseries: boolean;
  version?: string;
  usedMemory?: string;
  error?: string;
}

type Sample = { key: string; value: number; labels: Record<string, string>; sum?: boolean };

/** Numeric samples an event contributes to the time series. */
export function samplesOf(e: TelemetryEvent): Sample[] {
  const out: Sample[] = [];
  const add = (key: string, value: number | undefined, labels: Record<string, string>, sum = false) => {
    if (typeof value === 'number' && Number.isFinite(value)) {
      out.push({ key: `${TS_PREFIX}${key}`, value, labels, sum });
    }
  };
  switch (e.type) {
    case 'model': {
      const id = `${e.provider}/${e.model}`;
      const l = (metric: string) => ({ kind: 'model', model: e.model, provider: e.provider, metric });
      if (e.outcome === 'ok') {
        add(`model:${id}:duration_ms`, e.durationMs, l('duration_ms'));
        add(`model:${id}:ttft_ms`, e.ttftMs, l('ttft_ms'));
        add(`model:${id}:completion_tokens`, e.completionTokens, l('completion_tokens'), true);
        add(`model:${id}:prompt_tokens`, e.promptTokens, l('prompt_tokens'), true);
      } else if (e.outcome === 'error') {
        add(`model:${id}:errors`, 1, l('errors'), true);
      }
      break;
    }
    case 'tool':
      if (!e.cached) {
        add(`tool:${e.name}:duration_ms`, e.durationMs, { kind: 'tool', tool: e.name, metric: 'duration_ms' });
      }
      if (e.error) {
        add(`tool:${e.name}:errors`, 1, { kind: 'tool', tool: e.name, metric: 'errors' }, true);
      }
      break;
    case 'run':
      add(`run:${e.mode}:duration_ms`, e.durationMs, { kind: 'run', mode: e.mode, metric: 'duration_ms' });
      add(`run:${e.mode}:steps`, e.steps, { kind: 'run', mode: e.mode, metric: 'steps' });
      break;
    case 'health':
      add(`health:${e.provider}:up`, e.ok ? 1 : 0, { kind: 'health', provider: e.provider, metric: 'up' });
      if (e.ok) {
        add(`health:${e.provider}:latency_ms`, e.durationMs, { kind: 'health', provider: e.provider, metric: 'latency_ms' });
      }
      break;
    case 'completion':
      add(`completion:${e.action}`, 1, { kind: 'completion', action: e.action, metric: 'count' }, true);
      break;
    default:
      break;
  }
  return out;
}

/** Stream entries as `[id, fields]` → the `e` field parsed as an event. */
function parseEntries(reply: RedisReply): { lastId?: string; events: TelemetryEvent[]; count: number } {
  const events: TelemetryEvent[] = [];
  let lastId: string | undefined;
  let count = 0;
  for (const entry of Array.isArray(reply) ? reply : []) {
    if (!Array.isArray(entry) || typeof entry[0] !== 'string') {
      continue;
    }
    count++;
    lastId = entry[0];
    const fields = Array.isArray(entry[1]) ? entry[1] : [];
    const at = fields.indexOf('e');
    const raw = at >= 0 ? fields[at + 1] : undefined;
    if (typeof raw !== 'string') {
      continue;
    }
    try {
      const ev = JSON.parse(raw) as TelemetryEvent;
      if (ev && typeof ev.t === 'number' && typeof ev.type === 'string') {
        events.push(ev);
      }
    } catch {
      /* not ours */
    }
  }
  return { lastId, events, count };
}

export class RedisTelemetry implements TelemetryRemote {
  readonly label: string;
  private readonly client: RedisClient;
  private timeseries: Promise<boolean> | undefined;

  constructor(readonly url: string) {
    this.client = new RedisClient(url);
    this.label = `Redis ${redactRedisUrl(url)}`;
  }

  /** Reachability, server version and whether the RedisTimeSeries module is loaded. */
  async probe(): Promise<RedisProbe> {
    try {
      const [pong, info] = await this.client.pipeline([['PING'], ['INFO', 'server']]);
      if (pong instanceof RedisError) {
        return { ok: false, timeseries: false, error: pong.message };
      }
      const mem = await this.client.command('INFO', 'memory').catch(() => '');
      this.timeseries = undefined;
      return {
        ok: true,
        timeseries: await this.hasTimeSeries(),
        version: typeof info === 'string' ? /redis_version:(\S+)/.exec(info)?.[1] : undefined,
        usedMemory: typeof mem === 'string' ? /used_memory_human:(\S+)/.exec(mem)?.[1] : undefined,
      };
    } catch (e) {
      return { ok: false, timeseries: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  private hasTimeSeries(): Promise<boolean> {
    // TS.INFO on a missing key answers "key does not exist" when the module is there, "unknown command" when not.
    this.timeseries ??= this.client
      .pipeline([['TS.INFO', `${TS_PREFIX}__probe__`]])
      .then(([r]) => !(r instanceof RedisError && /unknown command/i.test(r.message)))
      .catch(() => false);
    return this.timeseries;
  }

  async write(eventLines: string[], logLines: string[], retentionDays: number): Promise<void> {
    const cutoff = retentionDays > 0 ? Date.now() - retentionDays * 86400_000 : 0;
    const trim = cutoff ? ['MINID', '~', String(cutoff)] : [];
    const cmds: (string | number)[][] = [];
    for (const line of eventLines) {
      cmds.push(['XADD', EVENTS_KEY, ...trim, '*', 'e', line]);
    }
    for (const line of logLines) {
      cmds.push(['XADD', LOGS_KEY, ...(cutoff ? trim : ['MAXLEN', '~', String(LOG_MAXLEN)]), '*', 'l', line]);
    }
    const streamWrites = cmds.length;
    if (eventLines.length && (await this.hasTimeSeries())) {
      const retention = retentionDays > 0 ? ['RETENTION', String(retentionDays * 86400_000)] : [];
      for (const line of eventLines) {
        let ev: TelemetryEvent;
        try {
          ev = JSON.parse(line) as TelemetryEvent;
        } catch {
          continue;
        }
        for (const s of samplesOf(ev)) {
          const labels = Object.entries({ app: 'localpilot', ...s.labels }).flat();
          cmds.push(['TS.ADD', s.key, ev.t, s.value, ...retention, 'ON_DUPLICATE', s.sum ? 'SUM' : 'LAST', 'LABELS', ...labels]);
        }
      }
    }
    const replies = await this.client.pipeline(cmds);
    // Stream writes must land (the caller falls back to files otherwise); a rejected sample only loses a chart point.
    const failed = replies.slice(0, streamWrites).find((r) => r instanceof RedisError);
    if (failed) {
      throw failed;
    }
  }

  async events(fromMs: number, onBatch: (events: TelemetryEvent[]) => void): Promise<void> {
    let start = fromMs > 0 ? String(fromMs) : '-';
    for (;;) {
      const r = parseEntries(await this.client.command('XRANGE', EVENTS_KEY, start, '+', 'COUNT', BATCH));
      if (r.events.length) {
        onBatch(r.events);
      }
      if (r.count < BATCH || !r.lastId) {
        return;
      }
      start = `(${r.lastId}`;
    }
  }

  async recentLogs(limit: number): Promise<string[]> {
    const r = await this.client.command('XREVRANGE', LOGS_KEY, '+', '-', 'COUNT', Math.max(1, limit));
    const out: string[] = [];
    for (const entry of Array.isArray(r) ? r : []) {
      const fields = Array.isArray(entry) && Array.isArray(entry[1]) ? entry[1] : [];
      const at = fields.indexOf('l');
      if (at >= 0 && typeof fields[at + 1] === 'string') {
        out.push(fields[at + 1] as string);
      }
    }
    return out.reverse();
  }

  async stats(): Promise<{ events: number; bytes: number; oldest?: number }> {
    const [len, memE, memL, first] = await this.client.pipeline([['XLEN', EVENTS_KEY], ['MEMORY', 'USAGE', EVENTS_KEY], ['MEMORY', 'USAGE', LOGS_KEY], ['XRANGE', EVENTS_KEY, '-', '+', 'COUNT', 1]]);
    const num = (v: RedisReply) => (typeof v === 'number' ? v : 0);
    const firstId = Array.isArray(first) && Array.isArray(first[0]) && typeof first[0][0] === 'string' ? first[0][0] : undefined;
    return { events: num(len), bytes: num(memE) + num(memL), oldest: firstId ? Number(firstId.split('-')[0]) || undefined : undefined };
  }

  async prune(cutoffMs: number): Promise<void> {
    await this.client.pipeline([
      ['XTRIM', EVENTS_KEY, 'MINID', '~', String(cutoffMs)],
      ['XTRIM', LOGS_KEY, 'MINID', '~', String(cutoffMs)],
    ]);
    if (!(await this.hasTimeSeries())) {
      return;
    }
    // Series keep the retention they were created with; a shorter (or longer) retention setting is applied here.
    const retention = String(Math.max(0, Date.now() - cutoffMs));
    for (const keys of await this.seriesKeys()) {
      await this.client.pipeline(keys.map((k) => ['TS.ALTER', k, 'RETENTION', retention]));
    }
  }

  /** Every `localpilot:ts:*` key, in SCAN-sized chunks. */
  private async seriesKeys(): Promise<string[][]> {
    const chunks: string[][] = [];
    let cursor = '0';
    do {
      const r = await this.client.command('SCAN', cursor, 'MATCH', `${TS_PREFIX}*`, 'COUNT', 500);
      const [next, keys] = Array.isArray(r) ? r : ['0', []];
      cursor = typeof next === 'string' ? next : '0';
      const list = Array.isArray(keys) ? keys.filter((k): k is string => typeof k === 'string') : [];
      if (list.length) {
        chunks.push(list);
      }
    } while (cursor !== '0');
    return chunks;
  }

  async clear(): Promise<void> {
    await this.client.command('DEL', EVENTS_KEY, LOGS_KEY);
    for (const keys of await this.seriesKeys()) {
      await this.client.command('DEL', ...keys);
    }
  }

  dispose(): void {
    this.client.close();
  }
}
