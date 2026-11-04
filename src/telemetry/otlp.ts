// OTLP export over HTTP/JSON, with no OpenTelemetry dependency: events and log lines become log records, events and
// explicit samples feed cumulative metrics, and finished spans become traces. Batches of up to 512 items go out every
// 5 s (sooner when a batch fills); at most 2048 items wait, the oldest are dropped first. Pure Node, so the extension
// and the CLI share it.
import type { LogEntry, MetricAttributes, TelemetryBatch, TelemetryEvent, TelemetrySink } from './telemetry';
import type { SpanData } from './tracing';

export type OtlpExporter = 'otlp' | 'console' | 'traces';

/** `localpilot.telemetry.otlp.*` as read from the settings. */
export interface OtlpSettings {
  enabled: boolean;
  endpoint: string;
  headers: Record<string, string>;
  /** Seconds between metric exports. */
  metricsInterval: number;
  exporters: string[];
  traceSamplePercent: number;
  recordContent: boolean;
  /** Set by the organisation's policy: the OTEL_* variables (including OTEL_SDK_DISABLED) cannot redirect or stop it. */
  managed?: boolean;
}

/** The settings after the standard `OTEL_*` variables are applied. */
export interface OtlpConfig {
  enabled: boolean;
  endpoint: string;
  urls: { logs: string; metrics: string; traces: string };
  headers: Record<string, string>;
  metricsIntervalMs: number;
  /** Logs and metrics over HTTP. */
  otlp: boolean;
  /** Every export also printed as JSON. */
  console: boolean;
  /** Spans over HTTP (and printed with `console`). */
  traces: boolean;
  traceSamplePercent: number;
  recordContent: boolean;
  resource: Record<string, string>;
  /** Problems found while resolving (an unsupported protocol, a bad URL). */
  warnings: string[];
  /** Settings an environment variable replaced. */
  fromEnv: string[];
}

export const OTLP_BATCH_SIZE = 512;
export const OTLP_BATCH_DELAY_MS = 5000;
export const OTLP_MAX_QUEUE = 2048;
const EXPORT_TIMEOUT_MS = 10_000;

/** `k=v,k2=v2` with URL-encoded values (the `OTEL_EXPORTER_OTLP_HEADERS` / `OTEL_RESOURCE_ATTRIBUTES` format). */
export function parseKeyValues(s: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (s ?? '').split(',')) {
    const i = part.indexOf('=');
    if (i <= 0) {
      continue;
    }
    const decode = (x: string) => {
      try {
        return decodeURIComponent(x.trim());
      } catch {
        return x.trim();
      }
    };
    out[decode(part.slice(0, i))] = decode(part.slice(i + 1));
  }
  return out;
}

/** `<endpoint>/v1/<signal>`; an endpoint that already names one signal path is reduced to its base first. */
export function signalUrl(endpoint: string, signal: 'logs' | 'metrics' | 'traces'): string {
  const base = endpoint.trim().replace(/\/+$/, '').replace(/\/v1\/(logs|metrics|traces)$/, '');
  return `${base}/v1/${signal}`;
}

export function resolveOtlpConfig(s: OtlpSettings, env: NodeJS.ProcessEnv = process.env, version = '0.0.0'): OtlpConfig {
  const warnings: string[] = [];
  const fromEnv: string[] = [];
  const envVal = (k: string) => {
    const v = s.managed ? undefined : env[k]?.trim();
    if (v) {
      fromEnv.push(k);
    }
    return v || undefined;
  };
  const endpoint = envVal('OTEL_EXPORTER_OTLP_ENDPOINT') ?? (s.endpoint?.trim() || 'http://localhost:4318');
  const headers = { ...(s.headers ?? {}), ...parseKeyValues(envVal('OTEL_EXPORTER_OTLP_HEADERS')) };
  for (const [k, v] of Object.entries(headers)) {
    if (typeof v !== 'string') {
      delete headers[k];
    }
  }
  const protocol = envVal('OTEL_EXPORTER_OTLP_PROTOCOL');
  if (protocol && protocol !== 'http/json') {
    warnings.push(`OTEL_EXPORTER_OTLP_PROTOCOL=${protocol} is not supported; LocalPilot exports http/json`);
  }
  const envInterval = Number(envVal('OTEL_METRIC_EXPORT_INTERVAL'));
  const metricsIntervalMs = Math.max(1000, Number.isFinite(envInterval) && envInterval > 0 ? envInterval : (Number(s.metricsInterval) || 60) * 1000);
  const exporters = new Set((Array.isArray(s.exporters) ? s.exporters : ['otlp']).map((e) => String(e).toLowerCase()));
  for (const e of exporters) {
    if (!['otlp', 'console', 'traces'].includes(e)) {
      warnings.push(`unknown OTLP exporter "${e}" (use otlp, console or traces)`);
    }
  }
  const urls = {
    logs: envVal('OTEL_EXPORTER_OTLP_LOGS_ENDPOINT') ?? signalUrl(endpoint, 'logs'),
    metrics: envVal('OTEL_EXPORTER_OTLP_METRICS_ENDPOINT') ?? signalUrl(endpoint, 'metrics'),
    traces: envVal('OTEL_EXPORTER_OTLP_TRACES_ENDPOINT') ?? signalUrl(endpoint, 'traces'),
  };
  let enabled = !!s.enabled && (!!s.managed || !/^true$/i.test(env.OTEL_SDK_DISABLED ?? ''));
  for (const u of Object.values(urls)) {
    if (!/^https?:\/\/[^/\s]+/i.test(u)) {
      warnings.push(`OTLP endpoint "${u}" is not an http(s) URL; export is off`);
      enabled = false;
    }
  }
  const resource: Record<string, string> = { ...parseKeyValues(envVal('OTEL_RESOURCE_ATTRIBUTES')), 'service.name': envVal('OTEL_SERVICE_NAME') ?? 'localpilot', 'service.version': version, 'telemetry.sdk.name': 'localpilot', 'telemetry.sdk.language': 'nodejs' };
  return {
    enabled,
    endpoint,
    urls,
    headers,
    metricsIntervalMs,
    otlp: exporters.has('otlp'),
    console: exporters.has('console'),
    traces: exporters.has('traces'),
    traceSamplePercent: Math.max(0, Math.min(100, Number.isFinite(Number(s.traceSamplePercent)) ? Number(s.traceSamplePercent) : 100)),
    recordContent: !!s.recordContent,
    resource,
    warnings,
    fromEnv,
  };
}

/** The resolved config for a debug line, with header values hidden. */
export function describeOtlpConfig(c: OtlpConfig): string {
  const headers = Object.keys(c.headers).map((k) => `${k}=***`).join(',') || 'none';
  const exporters = [c.otlp && 'otlp', c.console && 'console', c.traces && 'traces'].filter(Boolean).join(',') || 'none';
  return `OTLP ${c.enabled ? 'on' : 'off'} · exporters ${exporters} · logs ${c.urls.logs} · metrics ${c.urls.metrics} every ${c.metricsIntervalMs / 1000}s · traces ${c.urls.traces} (${c.traceSamplePercent}% sampled${c.recordContent ? ', with content' : ''}) · headers ${headers}${c.fromEnv.length ? ` · from env: ${c.fromEnv.join(', ')}` : ''}`;
}

// ------------------------------------------------------------------ OTLP/JSON encoding
type AnyValue = { stringValue: string } | { boolValue: boolean } | { intValue: string } | { doubleValue: number } | { arrayValue: { values: AnyValue[] } };
type KeyValue = { key: string; value: AnyValue };

export function anyValue(v: unknown): AnyValue {
  if (typeof v === 'boolean') {
    return { boolValue: v };
  }
  if (typeof v === 'number') {
    return Number.isInteger(v) ? { intValue: String(v) } : { doubleValue: v };
  }
  if (Array.isArray(v)) {
    return { arrayValue: { values: v.map(anyValue) } };
  }
  if (typeof v === 'string') {
    return { stringValue: v };
  }
  try {
    return { stringValue: JSON.stringify(v) ?? String(v) };
  } catch {
    return { stringValue: String(v) };
  }
}

export function keyValues(attrs: Record<string, unknown>): KeyValue[] {
  return Object.entries(attrs)
    .filter(([, v]) => v !== undefined && v !== null && !(typeof v === 'number' && !Number.isFinite(v)))
    .map(([key, v]) => ({ key, value: anyValue(v) }));
}

const nanos = (ms: number): string => `${Math.max(0, Math.round(ms))}000000`;

export interface OtlpLogRecord {
  t: number;
  severity: LogEntry['level'];
  body: string;
  attributes: Record<string, unknown>;
  traceId?: string;
  spanId?: string;
}

const SEVERITY: Record<LogEntry['level'], number> = { trace: 1, debug: 5, info: 9, warn: 13, error: 17 };

/** An event as a log record: body and `event.name` are `localpilot.<type>`, the fields are attributes. */
export function eventRecord(e: TelemetryEvent): OtlpLogRecord {
  const { t, type, traceId, spanId, ...fields } = e;
  const failed = ('outcome' in e && (e.outcome === 'error' || e.outcome === 'failed')) || ('error' in e && e.error === true) || ('ok' in e && e.ok === false);
  return { t, severity: failed ? 'warn' : 'info', body: `localpilot.${type}`, attributes: { 'event.name': `localpilot.${type}`, ...fields }, traceId, spanId };
}

export function logRecord(l: LogEntry): OtlpLogRecord {
  return { t: l.t, severity: l.level, body: l.msg, attributes: { 'log.source': 'localpilot' } };
}

const scope = (version: string) => ({ name: 'localpilot', version });
const resourceOf = (c: Pick<OtlpConfig, 'resource'>) => ({ attributes: keyValues(c.resource) });

export function logsPayload(c: Pick<OtlpConfig, 'resource'>, version: string, records: OtlpLogRecord[]): unknown {
  return {
    resourceLogs: [
      {
        resource: resourceOf(c),
        scopeLogs: [
          {
            scope: scope(version),
            logRecords: records.map((r) => ({
              timeUnixNano: nanos(r.t),
              observedTimeUnixNano: nanos(r.t),
              severityNumber: SEVERITY[r.severity] ?? 9,
              severityText: (r.severity ?? 'info').toUpperCase(),
              body: { stringValue: r.body },
              attributes: keyValues(r.attributes),
              ...(r.traceId && r.spanId ? { traceId: r.traceId, spanId: r.spanId } : {}),
            })),
          },
        ],
      },
    ],
  };
}

export function tracesPayload(c: Pick<OtlpConfig, 'resource'>, version: string, spans: SpanData[]): unknown {
  return {
    resourceSpans: [
      {
        resource: resourceOf(c),
        scopeSpans: [
          {
            scope: scope(version),
            spans: spans.map((s) => ({
              traceId: s.traceId,
              spanId: s.spanId,
              ...(s.parentSpanId ? { parentSpanId: s.parentSpanId } : {}),
              name: s.name,
              kind: s.kind === 'client' ? 3 : 1,
              startTimeUnixNano: nanos(s.startMs),
              endTimeUnixNano: nanos(s.endMs),
              attributes: keyValues(s.attributes),
              status: { code: s.status === 'error' ? 2 : s.status === 'ok' ? 1 : 0, ...(s.statusMessage ? { message: s.statusMessage } : {}) },
            })),
          },
        ],
      },
    ],
  };
}

// ------------------------------------------------------------------ metrics
/** Bucket bounds for histograms (durations in ms, token counts). */
export const HISTOGRAM_BOUNDS = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10_000, 30_000, 60_000, 120_000, 300_000];

type SumPoint = { name: string; unit: string; attributes: MetricAttributes; value: number };
type HistPoint = { name: string; unit: string; attributes: MetricAttributes; count: number; sum: number; min: number; max: number; buckets: number[] };

const UNITS: Record<string, string> = { 'localpilot.model.duration': 'ms', 'localpilot.model.ttft': 'ms', 'localpilot.tool.duration': 'ms', 'localpilot.run.duration': 'ms', 'localpilot.hook.duration': 'ms', 'localpilot.mcp.duration': 'ms', 'localpilot.tokens': '{token}', 'localpilot.cost': 'USD', 'localpilot.edit.lines': '{line}' };

/** Cumulative counters and histograms, keyed by name and attributes. */
export class MetricStore {
  private readonly sums = new Map<string, SumPoint>();
  private readonly hists = new Map<string, HistPoint>();
  readonly startMs: number;

  constructor(now = Date.now()) {
    this.startMs = now;
  }

  get size(): number {
    return this.sums.size + this.hists.size;
  }

  add(name: string, value: number, attributes: MetricAttributes = {}): void {
    if (!Number.isFinite(value)) {
      return;
    }
    const k = seriesKey(name, attributes);
    const p = this.sums.get(k);
    if (p) {
      p.value += value;
    } else {
      this.sums.set(k, { name, unit: UNITS[name] ?? '1', attributes, value });
    }
  }

  record(name: string, value: number, attributes: MetricAttributes = {}): void {
    if (!Number.isFinite(value)) {
      return;
    }
    const k = seriesKey(name, attributes);
    let p = this.hists.get(k);
    if (!p) {
      p = { name, unit: UNITS[name] ?? '1', attributes, count: 0, sum: 0, min: value, max: value, buckets: new Array<number>(HISTOGRAM_BOUNDS.length + 1).fill(0) };
      this.hists.set(k, p);
    }
    p.count++;
    p.sum += value;
    p.min = Math.min(p.min, value);
    p.max = Math.max(p.max, value);
    const i = HISTOGRAM_BOUNDS.findIndex((b) => value <= b);
    p.buckets[i < 0 ? HISTOGRAM_BOUNDS.length : i]++;
  }

  payload(c: Pick<OtlpConfig, 'resource'>, version: string, now = Date.now()): unknown {
    const byName = new Map<string, { name: string; unit: string; sum?: SumPoint[]; hist?: HistPoint[] }>();
    const metric = (name: string, unit: string) => {
      let m = byName.get(name);
      if (!m) {
        m = { name, unit };
        byName.set(name, m);
      }
      return m;
    };
    for (const p of this.sums.values()) {
      (metric(p.name, p.unit).sum ??= []).push(p);
    }
    for (const p of this.hists.values()) {
      (metric(`${p.name}`, p.unit).hist ??= []).push(p);
    }
    const base = (attrs: MetricAttributes) => ({ startTimeUnixNano: nanos(this.startMs), timeUnixNano: nanos(now), attributes: keyValues(attrs) });
    const metrics = [...byName.values()].flatMap((m) => [
      ...(m.sum ? [{ name: m.name, unit: m.unit, sum: { aggregationTemporality: 2, isMonotonic: true, dataPoints: m.sum.map((p) => ({ ...base(p.attributes), ...(Number.isInteger(p.value) ? { asInt: String(p.value) } : { asDouble: p.value }) })) } }] : []),
      ...(m.hist ? [{ name: m.name, unit: m.unit, histogram: { aggregationTemporality: 2, dataPoints: m.hist.map((p) => ({ ...base(p.attributes), count: String(p.count), sum: p.sum, min: p.min, max: p.max, bucketCounts: p.buckets.map(String), explicitBounds: HISTOGRAM_BOUNDS })) } }] : []),
    ]);
    return { resourceMetrics: [{ resource: resourceOf(c), scopeMetrics: [{ scope: scope(version), metrics }] }] };
  }
}

const seriesKey = (name: string, attrs: MetricAttributes): string => `${name}|${JSON.stringify(Object.keys(attrs).sort().map((k) => [k, attrs[k]]))}`;

/** The metric samples an event stands for. Attributes are names and outcomes only, never paths or arguments. */
export function eventMetrics(e: TelemetryEvent, m: Pick<MetricStore, 'add' | 'record'>): void {
  m.add('localpilot.events', 1, { type: e.type });
  switch (e.type) {
    case 'model': {
      const a = { model: e.model, provider: e.provider };
      m.add('localpilot.model.requests', 1, { ...a, outcome: e.outcome });
      m.record('localpilot.model.duration', e.durationMs, a);
      if (e.ttftMs !== undefined) {
        m.record('localpilot.model.ttft', e.ttftMs, a);
      }
      if (e.promptTokens) {
        m.add('localpilot.tokens', e.promptTokens, { ...a, direction: 'input' });
      }
      if (e.completionTokens) {
        m.add('localpilot.tokens', e.completionTokens, { ...a, direction: 'output' });
      }
      if (e.costUsd) {
        m.add('localpilot.cost', e.costUsd, a);
      }
      break;
    }
    case 'tool':
      m.add('localpilot.tool.calls', 1, { tool: e.name, error: e.error, cached: !!e.cached });
      if (!e.cached) {
        m.record('localpilot.tool.duration', e.durationMs, { tool: e.name });
      }
      break;
    case 'run':
      m.add('localpilot.runs', 1, { mode: e.mode, outcome: e.outcome, subagent: e.depth > 0 });
      m.record('localpilot.run.duration', e.durationMs, { mode: e.mode });
      break;
    case 'completion':
      m.add('localpilot.completions', 1, { action: e.action });
      break;
    case 'task':
      m.add('localpilot.tasks', 1, { action: e.action, mode: e.mode });
      break;
    case 'hook':
      m.add('localpilot.hook.runs', 1, { event: e.event, outcome: e.outcome });
      m.record('localpilot.hook.duration', e.durationMs, { event: e.event });
      break;
    case 'mcp_call':
      m.add('localpilot.mcp.calls', 1, { server: e.server, tool: e.tool, ok: e.ok });
      m.record('localpilot.mcp.duration', e.durationMs, { server: e.server });
      break;
    case 'edit_decision':
      m.add('localpilot.edit.lines', e.added, { decision: e.decision, change: 'added' });
      m.add('localpilot.edit.lines', e.removed, { decision: e.decision, change: 'removed' });
      break;
    case 'health':
      m.add('localpilot.health.checks', 1, { provider: e.provider, ok: e.ok });
      break;
  }
}

// ------------------------------------------------------------------ transport and sink
export type OtlpTransport = (url: string, body: string, headers: Record<string, string>) => Promise<{ status: number; body?: string }>;

export const fetchTransport: OtlpTransport = async (url, body, headers) => {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body, signal: AbortSignal.timeout(EXPORT_TIMEOUT_MS) });
  const text = await r.text().catch(() => '');
  return { status: r.status, body: text.slice(0, 300) };
};

/** Worth another try: no answer, throttled, or the collector is briefly down. */
const retryable = (status: number | undefined) => status === undefined || status === 429 || status === 502 || status === 503 || status === 504;

export interface OtlpSinkOptions {
  version: string;
  transport?: OtlpTransport;
  /** Where the `console` exporter prints. */
  out?: (line: string) => void;
  /** Diagnostics (`LOCALPILOT_OTEL_DEBUG=1`): one line per export. Must not feed back into the telemetry log. */
  debug?: (line: string) => void;
  now?: () => number;
}

export interface OtlpExportResult {
  signal: 'logs' | 'metrics' | 'traces';
  url: string;
  items: number;
  status?: number;
  error?: string;
}

export class OtlpSink implements TelemetrySink {
  private logs: OtlpLogRecord[] = [];
  private spans: SpanData[] = [];
  private readonly metrics: MetricStore;
  private batchTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly metricTimer: ReturnType<typeof setInterval> | undefined;
  private chain: Promise<unknown> = Promise.resolve();
  private closed = false;
  /** Items dropped because the queue was full. */
  dropped = 0;
  last: OtlpExportResult | undefined;

  constructor(
    readonly config: OtlpConfig,
    private readonly o: OtlpSinkOptions
  ) {
    this.metrics = new MetricStore(this.now);
    if (config.otlp || config.console) {
      this.metricTimer = setInterval(() => void this.enqueueExport(() => this.exportMetrics()), config.metricsIntervalMs);
      this.metricTimer.unref?.();
    }
  }

  private get now(): number {
    return (this.o.now ?? Date.now)();
  }
  private get logsOn(): boolean {
    return this.config.otlp || this.config.console;
  }

  async write(batch: TelemetryBatch): Promise<void> {
    if (this.closed || !this.logsOn) {
      return;
    }
    for (const e of batch.events) {
      eventMetrics(e, this.metrics);
    }
    this.push(this.logs, [...batch.events.map(eventRecord), ...batch.logs.map(logRecord)]);
  }

  counter(name: string, value: number, attributes?: MetricAttributes): void {
    if (this.logsOn) {
      this.metrics.add(name, value, attributes);
    }
  }

  histogram(name: string, value: number, attributes?: MetricAttributes): void {
    if (this.logsOn) {
      this.metrics.record(name, value, attributes);
    }
  }

  span(s: SpanData): void {
    if (!this.closed && this.config.traces) {
      this.push(this.spans, [s]);
    }
  }

  private push<T>(queue: T[], items: T[]): void {
    queue.push(...items);
    if (queue.length > OTLP_MAX_QUEUE) {
      this.dropped += queue.length - OTLP_MAX_QUEUE;
      queue.splice(0, queue.length - OTLP_MAX_QUEUE);
    }
    if (queue.length >= OTLP_BATCH_SIZE) {
      void this.enqueueExport(() => this.exportQueues());
    } else if (!this.batchTimer && queue.length) {
      this.batchTimer = setTimeout(() => {
        this.batchTimer = undefined;
        void this.enqueueExport(() => this.exportQueues());
      }, OTLP_BATCH_DELAY_MS);
      this.batchTimer.unref?.();
    }
  }

  /** Exports run one at a time, in order. */
  private enqueueExport<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.chain.then(fn, fn);
    this.chain = p.catch(() => undefined);
    return p;
  }

  /** Everything queued now, in batches; failed batches that are worth retrying go back to the queue. */
  private async exportQueues(): Promise<OtlpExportResult[]> {
    const out: OtlpExportResult[] = [];
    const logs = this.logs.splice(0);
    const spans = this.spans.splice(0);
    for (let i = 0; i < logs.length; i += OTLP_BATCH_SIZE) {
      const part = logs.slice(i, i + OTLP_BATCH_SIZE);
      const r = await this.send('logs', this.config.otlp ? this.config.urls.logs : undefined, logsPayload(this.config, this.o.version, part), part.length);
      out.push(r);
      if (!this.closed && r.error !== undefined && retryable(r.status)) {
        this.requeue(this.logs, logs.slice(i));
        break;
      }
    }
    for (let i = 0; i < spans.length; i += OTLP_BATCH_SIZE) {
      const part = spans.slice(i, i + OTLP_BATCH_SIZE);
      const r = await this.send('traces', this.config.urls.traces, tracesPayload(this.config, this.o.version, part), part.length);
      out.push(r);
      if (!this.closed && r.error !== undefined && retryable(r.status)) {
        this.requeue(this.spans, spans.slice(i));
        break;
      }
    }
    return out;
  }

  private requeue<T>(queue: T[], items: T[]): void {
    const room = Math.max(0, OTLP_MAX_QUEUE - queue.length);
    this.dropped += Math.max(0, items.length - room);
    queue.unshift(...items.slice(Math.max(0, items.length - room)));
    if (!this.batchTimer && queue.length) {
      this.batchTimer = setTimeout(() => {
        this.batchTimer = undefined;
        void this.enqueueExport(() => this.exportQueues());
      }, OTLP_BATCH_DELAY_MS);
      this.batchTimer.unref?.();
    }
  }

  private async exportMetrics(): Promise<OtlpExportResult | undefined> {
    if (!this.logsOn || !this.metrics.size) {
      return undefined;
    }
    return this.send('metrics', this.config.otlp ? this.config.urls.metrics : undefined, this.metrics.payload(this.config, this.o.version, this.now), this.metrics.size);
  }

  /** Prints with `console`, posts when `url` is set. */
  private async send(signal: OtlpExportResult['signal'], url: string | undefined, payload: unknown, items: number): Promise<OtlpExportResult> {
    const body = JSON.stringify(payload);
    if (this.config.console) {
      this.o.out?.(`[otlp ${signal}] ${body}`);
    }
    if (!url) {
      return { signal, url: 'console', items };
    }
    let r: OtlpExportResult;
    try {
      const res = await (this.o.transport ?? fetchTransport)(url, body, this.config.headers);
      r = { signal, url, items, status: res.status, ...(res.status >= 200 && res.status < 300 ? {} : { error: `HTTP ${res.status}${res.body ? `: ${res.body.replace(/\s+/g, ' ').slice(0, 200)}` : ''}` }) };
    } catch (e) {
      r = { signal, url, items, error: e instanceof Error ? (e.cause instanceof Error ? `${e.message} (${e.cause.message})` : e.message) : String(e) };
    }
    this.last = r;
    this.o.debug?.(`OTLP ${signal} → ${url}: ${items} item(s), ${r.error ?? `HTTP ${r.status}`}${this.dropped ? ` · ${this.dropped} dropped so far` : ''}`);
    return r;
  }

  /** Exports everything queued and the current metrics now. */
  async flush(): Promise<void> {
    if (this.batchTimer) {
      clearTimeout(this.batchTimer);
      this.batchTimer = undefined;
    }
    await this.enqueueExport(async () => {
      await this.exportQueues();
      await this.exportMetrics();
    });
  }

  /** Sends one `localpilot.test.connection` log record straight away and reports how the collector answered. */
  async test(): Promise<OtlpExportResult> {
    const record: OtlpLogRecord = { t: this.now, severity: 'info', body: 'localpilot.test.connection', attributes: { 'event.name': 'localpilot.test.connection' } };
    return this.enqueueExport(() => this.send('logs', this.config.urls.logs, logsPayload(this.config, this.o.version, [record]), 1));
  }

  async shutdown(): Promise<void> {
    if (this.metricTimer) {
      clearInterval(this.metricTimer);
    }
    // Closed first, so a failed final export is dropped rather than queued for a retry that never comes.
    this.closed = true;
    await this.flush();
    this.logs = [];
    this.spans = [];
  }
}
