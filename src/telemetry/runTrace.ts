// Per-run traces for the chat's "Trace" view: what one turn did, in order, with durations. Built only from the agent
// events the chat already receives plus the approvals the controller asks for, so it works with tracing (OTLP) off and
// sends nothing anywhere. Pure: no vscode, so the CLI and the tests can use it too.
import type { AgentEvent } from '../types';

export type TraceKind = 'model' | 'tool' | 'retry' | 'fallback' | 'approval' | 'steer' | 'compaction' | 'subagent' | 'hook' | 'nudge' | 'error';
export type TraceStatus = 'running' | 'ok' | 'error' | 'denied' | 'cancelled';

/** One row of the trace. Times are milliseconds since the run started; `end` is absent for a point event. */
export interface TraceEntry {
  kind: TraceKind;
  /** What ran: the model's name, the tool's name, the subagent, "Retry 2/3"… */
  name: string;
  start: number;
  end?: number;
  status?: TraceStatus;
  /** One plain line: the tool's main argument, the retry reason, why it fell back, the approval title. */
  detail?: string;
  /** 1 for work a subagent did inside the run. */
  depth?: number;
  /** The subagent the row belongs to (its label), for depth 1 rows. */
  agent?: string;
  /** Model calls: time to the first streamed token. */
  firstTokenMs?: number;
}

export interface RunTrace {
  version: 1;
  id: string;
  sessionId: string;
  /** The request that started the run (first line, shortened). */
  title: string;
  mode?: string;
  /** Wall-clock start (epoch ms). */
  startedAt: number;
  durationMs?: number;
  outcome: 'running' | 'ok' | 'error' | 'stopped';
  /** The model that answered the turn, from turn_end. */
  model?: string;
  promptTokens?: number;
  completionTokens?: number;
  entries: TraceEntry[];
}

export interface TraceTotals {
  modelCalls: number;
  toolCalls: number;
  failedTools: number;
  retries: number;
  fallbacks: number;
  approvals: number;
  errors: number;
  /** Time spent in model calls and in tool calls (top level only, so parallel subagent work is not counted twice). */
  modelMs: number;
  toolMs: number;
}

/** Most rows one trace keeps; a runaway run keeps its first rows and says how many were dropped. */
export const MAX_TRACE_ENTRIES = 2000;
const DETAIL_CHARS = 160;

/** The main argument of a tool call, as one short line (a path, a command, a query). */
export function toolDetail(args: unknown): string | undefined {
  if (!args || typeof args !== 'object') {
    return undefined;
  }
  const a = args as Record<string, unknown>;
  const files = Array.isArray(a.files) ? a.files.map((f) => (f && typeof f === 'object' ? (f as Record<string, unknown>).path : undefined)).filter((p): p is string => typeof p === 'string') : [];
  const pick = ['command', 'path', 'file', 'query', 'pattern', 'url', 'symbol', 'name', 'agent', 'title'].map((k) => a[k]).find((v) => typeof v === 'string' && v.trim());
  const text = typeof pick === 'string' ? pick : files.length ? files.join(', ') : undefined;
  return text ? shorten(text) : undefined;
}

function shorten(s: string, max = DETAIL_CHARS): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

/** Totals for the summary line and the export. */
export function traceTotals(t: RunTrace): TraceTotals {
  const top = t.entries.filter((e) => !e.depth);
  const dur = (e: TraceEntry) => (e.end !== undefined ? Math.max(0, e.end - e.start) : 0);
  return {
    modelCalls: t.entries.filter((e) => e.kind === 'model').length,
    toolCalls: t.entries.filter((e) => e.kind === 'tool').length,
    failedTools: t.entries.filter((e) => e.kind === 'tool' && (e.status === 'error' || e.status === 'denied')).length,
    retries: t.entries.filter((e) => e.kind === 'retry').length,
    fallbacks: t.entries.filter((e) => e.kind === 'fallback').length,
    approvals: t.entries.filter((e) => e.kind === 'approval').length,
    errors: t.entries.filter((e) => e.kind === 'error').length,
    modelMs: top.filter((e) => e.kind === 'model').reduce((n, e) => n + dur(e), 0),
    toolMs: top.filter((e) => e.kind === 'tool').reduce((n, e) => n + dur(e), 0),
  };
}

/** The JSON a user exports: the trace plus its totals, with absolute timestamps so it lines up with logs. */
export function traceExport(t: RunTrace): string {
  return JSON.stringify(
    {
      ...t,
      startedAtIso: new Date(t.startedAt).toISOString(),
      totals: traceTotals(t),
      entries: t.entries.map((e) => ({ ...e, at: new Date(t.startedAt + e.start).toISOString(), ...(e.end !== undefined ? { durationMs: e.end - e.start } : {}) })),
    },
    null,
    2
  );
}

/**
 * Follows one run of one chat. Feed it every event of the run (`event`), the approvals as they are asked and answered,
 * then `finish` it. Model calls end at the next tool call, the next model call or the end of the turn.
 */
export class RunTraceRecorder {
  readonly trace: RunTrace;
  private readonly t0: number;
  private openModel?: TraceEntry;
  private readonly childModels = new Map<string, TraceEntry>();
  private readonly tools = new Map<string, TraceEntry>();
  private readonly subagents = new Map<string, TraceEntry>();
  private readonly approvals = new Map<string, TraceEntry>();
  private readonly hooks = new Map<string, TraceEntry>();
  private dropped = 0;

  constructor(opts: { id: string; sessionId: string; title: string; mode?: string; now?: number }, private readonly clock: () => number = Date.now) {
    this.t0 = opts.now ?? clock();
    this.trace = { version: 1, id: opts.id, sessionId: opts.sessionId, title: shorten(opts.title.split('\n').find((l) => l.trim()) ?? '', 120), mode: opts.mode, startedAt: this.t0, outcome: 'running', entries: [] };
  }

  private now(): number {
    return Math.max(0, this.clock() - this.t0);
  }

  private push(e: TraceEntry): TraceEntry {
    if (this.trace.entries.length >= MAX_TRACE_ENTRIES) {
      this.dropped++;
      return e;
    }
    this.trace.entries.push(e);
    return e;
  }

  private endModel(at: number, status: TraceStatus = 'ok'): void {
    if (this.openModel) {
      this.openModel.end = at;
      this.openModel.status = this.openModel.status === 'running' ? status : this.openModel.status;
      this.openModel = undefined;
    }
  }

  event(e: AgentEvent): void {
    if (this.trace.outcome !== 'running') {
      return;
    }
    const at = this.now();
    const p = (e.payload ?? {}) as Record<string, unknown>;
    const childId = typeof p.childId === 'string' ? p.childId : undefined;
    if (childId && e.type !== 'subagent_start' && e.type !== 'subagent_end') {
      this.childEvent(childId, String(p.agent ?? 'subagent'), String(p.inner ?? e.type), (p.data ?? {}) as Record<string, unknown>, at);
      return;
    }
    switch (e.type) {
      case 'model_request':
        this.endModel(at);
        this.openModel = this.push({ kind: 'model', name: String(p.name ?? p.model ?? 'model'), start: at, status: 'running', ...(Number(p.queued) > 0 ? { detail: `Queued behind ${Number(p.queued)} other request${Number(p.queued) === 1 ? '' : 's'}` } : {}) });
        return;
      case 'assistant_delta':
      case 'thinking_delta':
        if (this.openModel && this.openModel.firstTokenMs === undefined) {
          this.openModel.firstTokenMs = at - this.openModel.start;
        }
        return;
      case 'waiting':
        if (this.openModel && typeof p.phase === 'string' && !this.openModel.detail) {
          this.openModel.detail = p.phase === 'load' ? 'Loaded the model into memory first' : p.phase === 'queue' ? 'Waited for the model: busy with other requests' : undefined;
        }
        return;
      case 'tool_start': {
        this.endModel(at);
        const id = String(p.id ?? '');
        const entry = this.push({ kind: 'tool', name: String(p.name ?? 'tool'), start: at, status: 'running', detail: toolDetail(p.args) });
        if (id) {
          this.tools.set(id, entry);
        }
        return;
      }
      case 'tool_end': {
        const entry = this.tools.get(String(p.id ?? ''));
        if (entry) {
          this.tools.delete(String(p.id));
          entry.end = typeof p.durationMs === 'number' && p.durationMs > 0 ? Math.min(at, entry.start + p.durationMs) : at;
          entry.end = Math.max(entry.end, entry.start);
          entry.status = p.denied ? 'denied' : p.isError ? (/^(cancelled|stopped)/i.test(String(p.content ?? '')) ? 'cancelled' : 'error') : 'ok';
          if (p.isError && typeof p.content === 'string' && p.content.trim()) {
            entry.detail = shorten(`${entry.detail ? `${entry.detail} · ` : ''}${p.content}`);
          }
        }
        return;
      }
      case 'retry': {
        if (this.openModel) {
          this.openModel.status = 'error';
          this.endModel(at, 'error');
        }
        const n = Number(p.attempt) || 0;
        const max = Number(p.max) || 0;
        const why = typeof p.message === 'string' && p.message ? p.message : String(p.reason ?? '');
        this.push({ kind: 'retry', name: `Retry ${n}${max ? `/${max}` : ''}`, start: at, detail: shorten(`${String(p.reason ?? '')}${why && why !== p.reason ? `: ${why}` : ''}${typeof p.delayMs === 'number' ? ` · waited ${Math.round(p.delayMs / 100) / 10}s` : ''}`) });
        return;
      }
      case 'route':
        if (p.fallback || p.reason) {
          this.push({ kind: 'fallback', name: `${String(p.wanted ?? '').split('/').pop() || 'model'} → ${String(p.usedName ?? p.used ?? 'model')}`, start: at, detail: typeof p.reason === 'string' ? shorten(p.reason) : undefined, status: p.fallback ? 'error' : 'ok' });
        }
        return;
      case 'steer':
        this.push({ kind: 'steer', name: `Your message added${Number(p.count) > 1 ? ` (${Number(p.count)})` : ''}`, start: at });
        return;
      case 'compaction':
        this.push({ kind: 'compaction', name: 'Context compacted', start: at, detail: typeof p.before === 'number' && typeof p.after === 'number' ? `${p.before.toLocaleString('en-US')} → ${p.after.toLocaleString('en-US')} tokens` : undefined });
        return;
      case 'nudge':
        this.push({ kind: 'nudge', name: 'Asked the model to act', start: at, detail: typeof p.reason === 'string' ? p.reason : undefined });
        return;
      case 'hook': {
        const id = String(p.id ?? '');
        const status = String(p.status ?? '');
        const prev = id ? this.hooks.get(id) : undefined;
        if (status === 'running' || !prev) {
          const entry = this.push({ kind: 'hook', name: `Hook ${String(p.event ?? '')}${p.name ? ` · ${String(p.name)}` : ''}`.trim(), start: at, status: 'running', detail: typeof p.tool === 'string' ? p.tool : undefined });
          if (id) {
            this.hooks.set(id, entry);
          }
          if (status === 'running') {
            return;
          }
        }
        const entry = this.hooks.get(id) ?? this.trace.entries[this.trace.entries.length - 1];
        this.hooks.delete(id);
        entry.end = typeof p.ms === 'number' ? entry.start + p.ms : at;
        entry.status = status === 'ok' ? 'ok' : status === 'blocked' ? 'denied' : 'error';
        return;
      }
      case 'subagent_start':
        if (childId) {
          const label = typeof p.label === 'string' && p.label ? `${String(p.agent ?? 'subagent')} · ${p.label}` : String(p.agent ?? 'subagent');
          this.subagents.set(childId, this.push({ kind: 'subagent', name: label, start: at, status: 'running', detail: typeof p.prompt === 'string' ? shorten(p.prompt) : undefined }));
        }
        return;
      case 'subagent_end': {
        const entry = childId ? this.subagents.get(childId) : undefined;
        if (entry && childId) {
          this.subagents.delete(childId);
          this.closeChild(childId, at);
          entry.end = at;
          entry.status = p.error ? (/stopped/i.test(String(p.error)) ? 'cancelled' : 'error') : 'ok';
          if (p.error) {
            entry.detail = shorten(String(p.error));
          }
        }
        return;
      }
      case 'error':
        this.endModel(at, 'error');
        this.push({ kind: 'error', name: 'Run error', start: at, status: 'error', detail: shorten(String(p.message ?? (typeof e.payload === 'string' ? e.payload : 'error'))) });
        return;
      case 'turn_end':
        this.endModel(at);
        if (typeof p.model === 'string') {
          this.trace.model = p.model;
        }
        if (typeof p.promptTokens === 'number') {
          this.trace.promptTokens = p.promptTokens;
        }
        if (typeof p.completionTokens === 'number') {
          this.trace.completionTokens = p.completionTokens;
        }
        return;
      default:
        return;
    }
  }

  private childEvent(childId: string, agent: string, inner: string, d: Record<string, unknown>, at: number): void {
    const label = this.subagents.get(childId)?.name ?? agent;
    if (inner === 'model_request') {
      this.endChildModel(childId, at);
      this.childModels.set(childId, this.push({ kind: 'model', name: String(d.name ?? d.model ?? 'model'), start: at, status: 'running', depth: 1, agent: label }));
    } else if (inner === 'tool_start') {
      this.endChildModel(childId, at);
      const entry = this.push({ kind: 'tool', name: String(d.name ?? 'tool'), start: at, status: 'running', depth: 1, agent: label, detail: toolDetail(d.args) });
      if (d.id) {
        this.tools.set(`${childId}:${String(d.id)}`, entry);
      }
    } else if (inner === 'tool_end') {
      const key = `${childId}:${String(d.id ?? '')}`;
      const entry = this.tools.get(key);
      if (entry) {
        this.tools.delete(key);
        entry.end = Math.max(entry.start, at);
        entry.status = d.denied ? 'denied' : d.isError ? 'error' : 'ok';
      }
    } else if (inner === 'retry') {
      this.endChildModel(childId, at, 'error');
      this.push({ kind: 'retry', name: `Retry ${Number(d.attempt) || 0}${Number(d.max) ? `/${Number(d.max)}` : ''}`, start: at, depth: 1, agent: label, detail: typeof d.reason === 'string' ? d.reason : undefined });
    } else if (inner === 'route' && (d.fallback || d.reason)) {
      this.push({ kind: 'fallback', name: `${String(d.wanted ?? '').split('/').pop() || 'model'} → ${String(d.usedName ?? d.used ?? 'model')}`, start: at, depth: 1, agent: label, detail: typeof d.reason === 'string' ? shorten(d.reason) : undefined });
    } else if (inner === 'assistant_delta' || inner === 'thinking_delta') {
      const m = this.childModels.get(childId);
      if (m && m.firstTokenMs === undefined) {
        m.firstTokenMs = at - m.start;
      }
    }
  }

  private endChildModel(childId: string, at: number, status: TraceStatus = 'ok'): void {
    const m = this.childModels.get(childId);
    if (m) {
      m.end = at;
      m.status = status;
      this.childModels.delete(childId);
    }
  }

  private closeChild(childId: string, at: number): void {
    this.endChildModel(childId, at);
    for (const [k, entry] of this.tools) {
      if (k.startsWith(`${childId}:`)) {
        entry.end = at;
        entry.status = 'cancelled';
        this.tools.delete(k);
      }
    }
  }

  /** An approval prompt was shown; `key` identifies it until {@link approvalAnswered}. */
  approvalAsked(key: string, title: string, kind: string): void {
    if (this.trace.outcome !== 'running') {
      return;
    }
    this.approvals.set(key, this.push({ kind: 'approval', name: `Approval: ${kind}`, start: this.now(), status: 'running', detail: shorten(title) }));
  }

  approvalAnswered(key: string, allowed: boolean): void {
    const entry = this.approvals.get(key);
    if (entry) {
      this.approvals.delete(key);
      entry.end = this.now();
      entry.status = allowed ? 'ok' : 'denied';
    }
  }

  /** The run ended: everything still open is closed as cancelled (stopped) or at the end time. */
  finish(outcome: 'ok' | 'error' | 'stopped'): RunTrace {
    if (this.trace.outcome !== 'running') {
      return this.trace;
    }
    const at = this.now();
    const open: TraceStatus = outcome === 'ok' ? 'ok' : 'cancelled';
    this.endModel(at, outcome === 'error' ? 'error' : open);
    for (const id of [...this.childModels.keys()]) {
      this.endChildModel(id, at, open);
    }
    for (const m of [this.tools, this.subagents, this.approvals, this.hooks]) {
      for (const entry of m.values()) {
        entry.end = at;
        entry.status = 'cancelled';
      }
      m.clear();
    }
    if (this.dropped) {
      this.trace.entries.push({ kind: 'error', name: `${this.dropped.toLocaleString('en-US')} more events not kept`, start: at, detail: `A trace keeps its first ${MAX_TRACE_ENTRIES} rows` });
    }
    this.trace.durationMs = at;
    this.trace.outcome = outcome;
    return this.trace;
  }
}
