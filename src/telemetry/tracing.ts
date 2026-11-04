// Trace spans for agent runs, model calls and tool calls, with OpenTelemetry `gen_ai.*` attributes. Pure Node (no
// OpenTelemetry SDK): the active span follows async work through AsyncLocalStorage, so a subagent's run nests under the
// tool call that started it. Nothing is created while tracing is off.
import { AsyncLocalStorage } from 'async_hooks';
import { randomBytes } from 'crypto';

export type SpanValue = string | number | boolean | string[];
export type SpanAttributes = Record<string, SpanValue | undefined>;
export type SpanKind = 'internal' | 'client';

/** A finished span, as exporters receive it. Ids are lowercase hex (16 bytes for the trace, 8 for the span). */
export interface SpanData {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: SpanKind;
  startMs: number;
  endMs: number;
  attributes: Record<string, SpanValue>;
  status: 'unset' | 'ok' | 'error';
  statusMessage?: string;
}

export interface TracingOptions {
  enabled: boolean;
  /** Share of new traces kept, 0–100; spans inside a kept trace are always kept. */
  samplePercent: number;
  /** Record prompts, replies, tool arguments and results on spans. */
  recordContent: boolean;
}

/** Longest content attribute; longer text keeps its start and end. */
export const MAX_CONTENT_CHARS = 32_000;

export class Span {
  private ended = false;
  readonly attributes: Record<string, SpanValue> = {};

  constructor(
    private readonly tracer: Tracer | undefined,
    readonly traceId: string,
    readonly spanId: string,
    readonly parentSpanId: string | undefined,
    readonly name: string,
    readonly kind: SpanKind,
    readonly startMs: number
  ) {}

  /** False for the placeholder handed out while tracing is off or the trace was not sampled. */
  get recording(): boolean {
    return !!this.tracer;
  }

  /** True when content (prompts, results, error text) may go on this span. */
  get recordsContent(): boolean {
    return !!this.tracer?.recordContent;
  }

  setAttributes(attrs: SpanAttributes): this {
    if (this.tracer && !this.ended) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v !== undefined && !(typeof v === 'number' && !Number.isFinite(v))) {
          this.attributes[k] = v;
        }
      }
    }
    return this;
  }

  /** Content attributes are only kept with `recordContent`; long values are shortened. */
  setContent(attrs: Record<string, string | undefined>): this {
    if (this.tracer?.recordContent) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v !== undefined) {
          this.setAttributes({ [k]: clip(v) });
        }
      }
    }
    return this;
  }

  /** Ends the span once; later calls are ignored. An `error` marks it failed. */
  end(o: { error?: string; ok?: boolean; endMs?: number } = {}): void {
    if (!this.tracer || this.ended) {
      return;
    }
    this.ended = true;
    this.tracer.finish({
      traceId: this.traceId,
      spanId: this.spanId,
      parentSpanId: this.parentSpanId,
      name: this.name,
      kind: this.kind,
      startMs: this.startMs,
      endMs: Math.max(this.startMs, o.endMs ?? Date.now()),
      attributes: this.attributes,
      status: o.error !== undefined ? 'error' : o.ok ? 'ok' : 'unset',
      statusMessage: o.error || undefined,
    });
  }
}

const NOOP = new Span(undefined, '', '', undefined, '', 'internal', 0);

const clip = (s: string): string => (s.length > MAX_CONTENT_CHARS ? `${s.slice(0, MAX_CONTENT_CHARS / 2)}\n…[${s.length - MAX_CONTENT_CHARS} chars omitted]…\n${s.slice(-MAX_CONTENT_CHARS / 2)}` : s);

export const newTraceId = (): string => randomBytes(16).toString('hex');
export const newSpanId = (): string => randomBytes(8).toString('hex');

export class Tracer {
  private opts: TracingOptions = { enabled: false, samplePercent: 100, recordContent: false };
  private readonly als = new AsyncLocalStorage<Span>();

  constructor(
    private readonly onEnd: (s: SpanData) => void,
    private readonly random: () => number = Math.random
  ) {}

  configure(o: Partial<TracingOptions>): void {
    this.opts = { ...this.opts, ...o };
    this.opts.samplePercent = Math.max(0, Math.min(100, Number(this.opts.samplePercent) || 0));
  }

  get enabled(): boolean {
    return this.opts.enabled;
  }
  get recordContent(): boolean {
    return this.opts.enabled && this.opts.recordContent;
  }

  /** The recording span the current async work runs in, if any. */
  active(): Span | undefined {
    const s = this.als.getStore();
    return s?.recording ? s : undefined;
  }

  /**
   * Starts a span under `parent` (default: the active span). A new trace is kept with probability `samplePercent`;
   * a span in a dropped trace is a placeholder too, so a trace is kept or dropped as a whole.
   */
  start(name: string, attrs: SpanAttributes = {}, o: { kind?: SpanKind; startMs?: number; parent?: Span } = {}): Span {
    if (!this.opts.enabled) {
      return NOOP;
    }
    const parent = o.parent ?? this.als.getStore();
    if (parent && !parent.recording) {
      return NOOP;
    }
    if (!parent && !(this.random() * 100 < this.opts.samplePercent)) {
      return NOOP;
    }
    return new Span(this, parent?.traceId ?? newTraceId(), newSpanId(), parent?.spanId, name, o.kind ?? 'internal', o.startMs ?? Date.now()).setAttributes(attrs);
  }

  /** Runs `fn` with `span` as the active span (a placeholder makes nested spans placeholders too). */
  with<T>(span: Span, fn: () => T): T {
    return !this.opts.enabled && !span.recording ? fn() : this.als.run(span, fn);
  }

  /** Starts a span, runs `fn` inside it and ends it (failed when `fn` throws). */
  async inSpan<T>(name: string, attrs: SpanAttributes, fn: (span: Span) => Promise<T>, o: { kind?: SpanKind } = {}): Promise<T> {
    const span = this.start(name, attrs, o);
    try {
      return await this.with(span, () => fn(span));
    } catch (e) {
      span.end({ error: (this.recordContent && (e instanceof Error ? e.message : String(e))) || 'error' });
      throw e;
    } finally {
      span.end();
    }
  }

  /** @internal Called by `Span.end`. */
  finish(s: SpanData): void {
    try {
      this.onEnd(s);
    } catch {
      /* exporting must never break the traced work */
    }
  }
}

/** Chat messages as `gen_ai.input.messages` / `gen_ai.output.messages` JSON: the newest `limit`, text parts only. */
export function messagesJson(messages: { role: string; content?: string }[], limit = 20): string {
  return JSON.stringify(messages.slice(-limit).map((m) => ({ role: m.role, parts: [{ type: 'text', content: clip(m.content ?? '') }] })));
}

/** The span around one tool call. Arguments and results are content (only with `recordContent`). */
export async function traceTool<R extends { isError: boolean; msg: { content?: string } }>(tracer: Tracer | undefined, call: { id: string; name: string }, args: unknown, run: () => Promise<R>): Promise<R> {
  if (!tracer?.enabled) {
    return run();
  }
  return tracer.inSpan(`execute_tool ${call.name}`, { 'gen_ai.operation.name': 'execute_tool', 'gen_ai.tool.name': call.name, 'gen_ai.tool.call.id': call.id, 'gen_ai.tool.type': 'function' }, async (span) => {
    span.setContent({ 'gen_ai.tool.call.arguments': safeJson(args), 'input.value': safeJson(args) });
    const r = await run();
    span.setContent({ 'gen_ai.tool.call.result': r.msg.content, 'output.value': r.msg.content });
    // The result is content: without `recordContent` a failure carries a fixed message, not the tool's output.
    span.end(r.isError ? { error: (tracer.recordContent && firstLine(r.msg.content)) || 'tool error' } : { ok: true });
    return r;
  });
}

const firstLine = (s: string | undefined): string => (s ?? '').split('\n', 1)[0].slice(0, 300);

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v) ?? '';
  } catch {
    return String(v);
  }
}

/** A span's ids for a telemetry event; none for a placeholder. */
export const spanIds = (span: Span): { traceId?: string; spanId?: string } => (span.recording ? { traceId: span.traceId, spanId: span.spanId } : {});

/** The span around one agent run (`invoke_agent`); a subagent's nests under the tool call that started it. */
export function startRunSpan(tracer: Tracer | undefined, r: { sid: string; mode: string; depth: number; agent?: string; input?: () => string | undefined }): Span {
  if (!tracer?.enabled) {
    return NOOP;
  }
  const span = tracer.start(`invoke_agent ${r.agent ?? 'localpilot'}`, { 'gen_ai.operation.name': 'invoke_agent', 'gen_ai.agent.name': r.agent ?? 'localpilot', 'gen_ai.conversation.id': r.sid, 'localpilot.mode': r.mode, 'localpilot.depth': r.depth });
  if (tracer.recordContent && span.recording) {
    span.setContent({ 'input.value': r.input?.() });
  }
  return span;
}

export function endRunSpan(span: Span, r: { model?: string; outcome: string; error?: string; steps: number; toolCalls: number; promptTokens: number; completionTokens: number; output?: string }): void {
  if (!span.recording) {
    return;
  }
  span.setAttributes({ 'gen_ai.request.model': r.model || undefined, 'gen_ai.usage.input_tokens': r.promptTokens, 'gen_ai.usage.output_tokens': r.completionTokens, 'localpilot.outcome': r.outcome, 'localpilot.steps': r.steps, 'localpilot.tool_calls': r.toolCalls });
  span.setContent({ 'output.value': r.output });
  // Error text can quote tool output or paths, so it is content too; otherwise the outcome stands in for it.
  span.end(r.outcome === 'failed' || r.error ? { error: (span.recordsContent && r.error) || r.outcome } : { ok: r.outcome === 'done' });
}

/** One finished model request (`chat`), recorded after the fact from its start time. Returns its ids for the `model` event. */
export function recordModelSpan(
  tracer: Tracer | undefined,
  r: { sid: string; model: string; provider: string; startMs: number; outcome: string; reason?: string; finishReason?: string; promptTokens?: number; completionTokens?: number; ttftMs?: number; maxTokens?: number; temperature?: number; input?: () => { role: string; content?: string }[]; output?: string }
): { traceId?: string; spanId?: string } {
  if (!tracer?.enabled) {
    return {};
  }
  const span = tracer.start(`chat ${r.model}`, {}, { kind: 'client', startMs: r.startMs });
  if (!span.recording) {
    return {};
  }
  span.setAttributes({
    'gen_ai.operation.name': 'chat',
    'gen_ai.system': r.provider,
    'gen_ai.provider.name': r.provider,
    'gen_ai.request.model': r.model,
    'gen_ai.response.model': r.model,
    'gen_ai.conversation.id': r.sid,
    'gen_ai.request.max_tokens': r.maxTokens,
    'gen_ai.request.temperature': r.temperature,
    'gen_ai.response.finish_reasons': r.finishReason ? [r.finishReason] : undefined,
    'gen_ai.usage.input_tokens': r.promptTokens,
    'gen_ai.usage.output_tokens': r.completionTokens,
    'localpilot.ttft_ms': r.ttftMs,
    'localpilot.outcome': r.outcome,
    'localpilot.reason': r.reason,
  });
  if (tracer.recordContent) {
    const input = r.input?.();
    span.setContent({ 'gen_ai.input.messages': input && messagesJson(input), 'input.value': input && messagesJson(input), 'gen_ai.output.messages': r.output !== undefined ? messagesJson([{ role: 'assistant', content: r.output }]) : undefined, 'output.value': r.output });
  }
  span.end(r.outcome === 'error' || r.outcome === 'retry' ? { error: r.reason ?? r.outcome } : { ok: r.outcome === 'ok' });
  return spanIds(span);
}
