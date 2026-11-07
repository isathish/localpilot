// RunBridge (design §9.3, SESSION): a chat's agent runs become `agent_session` entities, what they did
// `execution_event`s, the checkpoint taken before each turn a `checkpoint`, contiguous use of one model a
// `model_session`; the answer being streamed goes to a draft (drafts.ts). Everything is optional for the loop: hooks only
// (src/agent/sessionHooks.ts), and a failure here never breaks a run. Pure Node (no vscode).
import type { CheckpointEntry } from '../../agent/checkpoints';
import type { RunEndInfo, RunHandle, RunStartInfo, SessionRunHooks } from '../../agent/sessionHooks';
import { toolDetail, type RunTrace } from '../../telemetry/runTrace';
import type { AgentEvent, ChatMessage, Session } from '../../types';
import type { AppendOptions } from '../data/eventLog';
import type { EntityKind, ExecutionEventFields, Op } from '../events';
import { newId } from '../ids';
import { agentSessionId, checkpointFields, checkpointId, executionEventId } from '../conversation/payloads';
import type { DraftStore } from './drafts';

/** `localpilot.continuity.captureToolOutput`: what of a tool's output the execution event keeps. */
export type CaptureMode = 'errors' | 'summary' | 'full';
/** `summary` keeps the first 2 KiB of a tool's output (and of an error). */
export const OUTPUT_SUMMARY_CHARS = 2048;

export type ModelSwitchReason = 'user' | 'auto' | 'fallback' | 'provider-down';

export interface RunLog {
  readonly stream: string;
  append(ent: EntityKind, eid: string, op: Op, p: object, o?: AppendOptions): unknown;
}

export interface RunBridgeOptions {
  log: RunLog;
  blobs: { put(data: Uint8Array | string): string };
  deviceId: string;
  capture: () => CaptureMode;
  drafts?: DraftStore;
  now?: () => number;
  /** Whether a model runs locally, and its window (model sessions); unknown = local, no window. */
  modelInfo?: (modelId: string) => { local?: boolean; window?: number } | undefined;
  /** The project of a folder, when already known (checkpoint entities). */
  projectOf?: (root: string) => string | undefined;
  /** The open model session of a conversation, read from the index (a run after a restart continues it). */
  lastModelSession?: (conversationId: string) => Promise<OpenModelSession | undefined>;
  warn?: (m: string) => void;
}

export interface OpenModelSession {
  id: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
}

interface RunState {
  id: string;
  conversationId: string;
  session: Session;
  run: number;
  seq: number;
  startedAt: number;
  chatModel: string;
  messageId?: string;
  /** Open tool calls: call id -> execution event. */
  tools: Map<string, { eid: string; start: number }>;
  subagents: Map<string, { eid: string }>;
  checkpointId?: string;
  /** Model sessions are written in order, after the conversation's open one is known. */
  chain: Promise<void>;
  /** The current response has streamed text (its draft has begun). */
  drafting: boolean;
  ended: boolean;
}

const rootId = (sid: string) => sid.split('::')[0];
const cut = (s: string, n = OUTPUT_SUMMARY_CHARS) => (s.length > n ? `${s.slice(0, n)}…` : s);
const lastMessageId = (s: Session): string | undefined => {
  for (let i = s.messages.length - 1; i >= 0; i--) {
    const id = s.messages[i].meta?.id;
    if (id) {
      return id;
    }
  }
  return undefined;
};

export class RunBridge implements SessionRunHooks {
  private readonly now: () => number;
  /** Runs in progress in this process, per conversation. */
  private readonly active = new Map<string, RunState>();
  /** The last agent session of each conversation this process ran (recovery patches after the run). */
  private readonly lastRun = new Map<string, string>();
  /** Agent sessions started here with a trace id (only those get `traceId` when their trace is stored). */
  private readonly traced = new Set<string>();
  /** The open model session per conversation (undefined = none yet; absent = not looked up). */
  private readonly models = new Map<string, OpenModelSession | undefined>();
  /** Why the next model change of a conversation happens (a user switch, a fallback). */
  private readonly reasons = new Map<string, ModelSwitchReason>();
  /** The last recovery phase recorded per agent session (patches only on phase or attempt changes). */
  private readonly recoveries = new Map<string, string>();

  constructor(private readonly o: RunBridgeOptions) {
    this.now = o.now ?? Date.now;
  }

  private append(ent: EntityKind, eid: string, op: Op, p: object, opts?: AppendOptions): void {
    try {
      this.o.log.append(ent, eid, op, p, opts);
    } catch (e) {
      this.o.warn?.(`continuity: ${ent} ${op}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** True while this process runs that agent session (crash recovery leaves it alone). */
  isActive(agentSessionId: string): boolean {
    for (const st of this.active.values()) {
      if (st.id === agentSessionId) {
        return true;
      }
    }
    return false;
  }

  /** True while this process runs that conversation. */
  isRunning(conversationId: string): boolean {
    return this.active.has(rootId(conversationId));
  }

  activeId(conversationId: string): string | undefined {
    return this.active.get(rootId(conversationId))?.id;
  }

  start(r: RunStartInfo): RunHandle | undefined {
    const conv = rootId(r.session.id);
    const at = this.now();
    const id = r.traceId ? agentSessionId(r.traceId) : newId('as', at);
    if (r.traceId) {
      this.traced.add(id);
    }
    const st: RunState = { id, conversationId: conv, session: r.session, run: r.run ?? 0, seq: 0, startedAt: at, chatModel: r.model ?? '', tools: new Map(), subagents: new Map(), chain: Promise.resolve(), drafting: false, ended: false };
    this.active.set(conv, st);
    const title = (typeof r.userMessage.content === 'string' ? (r.userMessage.meta?.display ?? r.userMessage.content) : '').split('\n').find((l) => l.trim())?.trim().slice(0, 120);
    this.append(
      'agent_session',
      id,
      'create',
      {
        conversationId: conv,
        run: st.run,
        mode: r.mode,
        ...(r.specialist ? { specialist: r.specialist } : {}),
        ...(r.model ? { model: r.model, provider: r.model.split('/')[0] } : {}),
        startedAt: at,
        outcome: 'running',
        writer: this.o.log.stream,
        ...(r.session.worktree ? { worktree: r.session.worktree } : {}),
        ...(title ? { title } : {}),
      },
      { durable: true }
    );
    return {
      userMessage: (m) => this.userMessage(st, m),
      event: (e) => this.event(st, e),
      end: (x) => this.end(st, x),
    };
  }

  private userMessage(st: RunState, m: ChatMessage): void {
    const mid = m.meta?.id;
    if (mid && mid !== st.messageId) {
      st.messageId = mid;
      this.append('agent_session', st.id, 'patch', { messageId: mid });
    }
  }

  private exec(st: RunState, f: Omit<ExecutionEventFields, 'agentSessionId' | 'conversationId' | 'seq'>): string {
    const seq = ++st.seq;
    const eid = executionEventId(st.id, seq);
    this.append('execution_event', eid, 'create', { agentSessionId: st.id, conversationId: st.conversationId, seq, ...f });
    return eid;
  }

  /** Output kept per `captureToolOutput`: errors only, the first 2 KiB, or everything (a blob beyond 2 KiB). */
  private output(content: string, isError: boolean): Partial<ExecutionEventFields> {
    const mode = this.o.capture();
    if (!content) {
      return {};
    }
    if (isError) {
      const out: Partial<ExecutionEventFields> = { error: cut(content) };
      if (mode === 'full' && content.length > OUTPUT_SUMMARY_CHARS) {
        out.outputBlob = this.o.blobs.put(content);
      }
      return out;
    }
    if (mode === 'errors') {
      return {};
    }
    if (mode === 'full') {
      return { output: cut(content), ...(content.length > OUTPUT_SUMMARY_CHARS ? { outputBlob: this.o.blobs.put(content) } : {}) };
    }
    return { output: cut(content) };
  }

  private event(st: RunState, e: AgentEvent): void {
    if (st.ended) {
      return;
    }
    const at = this.now();
    const raw = e.payload;
    const p = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const child = typeof p.childId === 'string' ? p.childId : undefined;
    const drafts = this.o.drafts;
    switch (e.type) {
      case 'assistant_delta':
      case 'thinking_delta':
        if (drafts && typeof raw === 'string') {
          if (!st.drafting) {
            st.drafting = true;
            drafts.begin(st.conversationId, { model: st.session.model || undefined, agentSessionId: st.id, afterMessageId: lastMessageId(st.session), afterCount: st.session.messages.length });
          }
          drafts.append(st.conversationId, raw, e.type === 'thinking_delta' ? 'thinking' : 'text');
        }
        return;
      case 'nudge':
        if (!child) {
          drafts?.reset(st.conversationId);
          this.exec(st, { kind: 'nudge', name: 'Asked the model to act', start: at, ...(typeof p.reason === 'string' ? { detail: cut(p.reason, 200) } : {}) });
        }
        return;
      case 'model_request': {
        if (child) {
          return;
        }
        // A new response: the previous one was finalised (and is saved with the chat by its tool results).
        st.drafting = false;
        const model = typeof p.model === 'string' ? p.model : '';
        this.exec(st, { kind: 'model', name: String(p.name ?? model ?? 'model'), start: at, ...(Number(p.queued) > 0 ? { detail: `Queued behind ${Number(p.queued)} other request${Number(p.queued) === 1 ? '' : 's'}` } : {}) });
        if (model) {
          this.useModel(st, model);
        }
        return;
      }
      case 'tool_start': {
        if (child) {
          return;
        }
        const eid = this.exec(st, { kind: 'tool', name: String(p.name ?? 'tool'), status: 'running', start: at, ...(toolDetail(p.args) ? { detail: toolDetail(p.args) } : {}) });
        if (typeof p.id === 'string' || typeof p.id === 'number') {
          st.tools.set(String(p.id), { eid, start: at });
        }
        return;
      }
      case 'tool_end': {
        if (child) {
          return;
        }
        const t = st.tools.get(String(p.id ?? ''));
        if (!t) {
          return;
        }
        st.tools.delete(String(p.id));
        const isError = !!p.isError;
        const content = typeof p.content === 'string' ? p.content : '';
        const status = p.denied ? 'denied' : isError ? (/^(cancelled|stopped)/i.test(content) ? 'cancelled' : 'error') : 'ok';
        this.append('execution_event', t.eid, 'patch', { status, end: at, ...this.output(content, isError && status === 'error') });
        return;
      }
      case 'retry':
        if (!child) {
          const why = typeof p.message === 'string' && p.message ? p.message : String(p.reason ?? '');
          this.exec(st, { kind: 'retry', name: `Retry ${Number(p.attempt) || 0}${Number(p.max) ? `/${Number(p.max)}` : ''}`, start: at, ...(why ? { detail: cut(why, 200) } : {}) });
        }
        return;
      case 'route':
        if (!child && (p.fallback || p.reason)) {
          this.exec(st, { kind: 'fallback', name: `${String(p.wanted ?? '').split('/').pop() || 'model'} → ${String(p.usedName ?? p.used ?? 'model')}`, start: at, status: p.fallback ? 'error' : 'ok', ...(typeof p.reason === 'string' && p.reason ? { detail: cut(p.reason, 200) } : {}) });
          if (p.fallback) {
            this.reasons.set(st.conversationId, p.unavailable ? 'provider-down' : 'fallback');
          }
        }
        return;
      case 'compaction':
        if (!child) {
          this.exec(st, { kind: 'compaction', name: 'Context compacted', start: at, ...(typeof p.before === 'number' && typeof p.after === 'number' ? { detail: `${p.before} → ${p.after} tokens` } : {}) });
        }
        return;
      case 'approval_request':
        if (!child) {
          this.exec(st, { kind: 'approval', name: `Approval: ${String(p.kind ?? 'action')}`, start: at });
        }
        return;
      case 'steer':
        if (!child) {
          this.exec(st, { kind: 'steer', name: 'Your message added', start: at });
        }
        return;
      case 'error':
        if (!child) {
          const msg = typeof raw === 'string' ? raw : String(p.message ?? 'error');
          this.exec(st, { kind: 'error', name: 'Run error', status: 'error', start: at, error: cut(msg) });
        }
        return;
      case 'subagent_start':
        if (child) {
          const label = typeof p.label === 'string' && p.label ? `${String(p.agent ?? 'subagent')} · ${p.label}` : String(p.agent ?? 'subagent');
          st.subagents.set(child, { eid: this.exec(st, { kind: 'subagent', name: label, status: 'running', start: at, depth: 1, ...(typeof p.prompt === 'string' ? { detail: cut(p.prompt, 200) } : {}) }) });
        }
        return;
      case 'subagent_end': {
        const s = child ? st.subagents.get(child) : undefined;
        if (s && child) {
          st.subagents.delete(child);
          this.append('execution_event', s.eid, 'patch', { end: at, status: p.error ? (/stopped/i.test(String(p.error)) ? 'cancelled' : 'error') : 'ok', ...(p.error ? { error: cut(String(p.error)) } : {}) });
        }
        return;
      }
      case 'turn_end': {
        if (child) {
          return;
        }
        st.drafting = false;
        const pt = Number(p.promptTokens) || 0;
        const ct = Number(p.completionTokens) || 0;
        if (pt || ct) {
          st.chain = st.chain.then(() => {
            const cur = this.models.get(st.conversationId);
            if (cur) {
              cur.promptTokens += pt;
              cur.completionTokens += ct;
              this.append('model_session', cur.id, 'patch', { promptTokens: cur.promptTokens, completionTokens: cur.completionTokens });
            }
          });
        }
        return;
      }
      default:
        return;
    }
  }

  /** A model answers this conversation: continue its open model session, or end it and start one with the reason. */
  private useModel(st: RunState, model: string): void {
    const conv = st.conversationId;
    // Why this request's model is used is known now (a route event just before it); the chain runs later.
    const pending = this.reasons.get(conv);
    this.reasons.delete(conv);
    st.chain = st.chain
      .then(async () => {
        if (!this.models.has(conv)) {
          this.models.set(conv, await this.o.lastModelSession?.(conv).catch(() => undefined));
        }
        const cur = this.models.get(conv);
        if (cur?.model === model) {
          return;
        }
        const reason: ModelSwitchReason = pending ?? (st.chatModel && st.chatModel === model ? 'user' : 'auto');
        const at = this.now();
        const last = lastMessageId(st.session);
        if (cur) {
          this.append('model_session', cur.id, 'patch', { endedAt: at, ...(last ? { toMessageId: last } : {}) });
        }
        const id = newId('ms', at);
        const info = this.o.modelInfo?.(model);
        this.append('model_session', id, 'create', {
          conversationId: conv,
          provider: model.includes('/') ? model.slice(0, model.indexOf('/')) : '',
          model,
          local: info?.local ?? true,
          ...(info?.window ? { window: info.window } : {}),
          fromMessageId: st.messageId ?? last ?? '',
          startedAt: at,
          promptTokens: 0,
          completionTokens: 0,
          reason,
        });
        this.models.set(conv, { id, model, promptTokens: 0, completionTokens: 0 });
      })
      .catch((e) => this.o.warn?.(`continuity: model session: ${e instanceof Error ? e.message : String(e)}`));
  }

  /** The user picked another model for a chat: the next model session says `user`. */
  modelChanged(conversationId: string): void {
    this.reasons.set(rootId(conversationId), 'user');
  }

  private end(st: RunState, r: RunEndInfo): void {
    if (st.ended) {
      return;
    }
    st.ended = true;
    const at = this.now();
    // Tool calls still open when the run ended were cut off.
    for (const t of st.tools.values()) {
      this.append('execution_event', t.eid, 'patch', { status: 'cancelled', end: at });
    }
    for (const s of st.subagents.values()) {
      this.append('execution_event', s.eid, 'patch', { status: 'cancelled', end: at });
    }
    if (!st.messageId) {
      const userMsg = [...st.session.messages].reverse().find((m) => m.role === 'user' && !m.meta?.hidden && m.meta?.id);
      st.messageId = userMsg?.meta?.id;
    }
    const files = r.filesTouched ?? [];
    this.append(
      'agent_session',
      st.id,
      'patch',
      {
        outcome: r.outcome,
        endedAt: at,
        ...(r.model ? { model: r.model, provider: r.model.split('/')[0] } : {}),
        ...(r.promptTokens ? { promptTokens: r.promptTokens } : {}),
        ...(r.completionTokens ? { completionTokens: r.completionTokens } : {}),
        filesTouched: files.map((f) => f.path),
        ...(st.messageId ? { messageId: st.messageId } : {}),
      },
      { durable: true }
    );
    if (st.checkpointId && files.length) {
      this.append('checkpoint', st.checkpointId, 'patch', { files });
    }
    // A shutdown keeps the draft (the partial answer survives the reload); any other end drops it.
    if (r.outcome === 'interrupted') {
      this.o.drafts?.flush(st.conversationId);
    } else {
      this.o.drafts?.clear(st.conversationId);
    }
    if (this.active.get(st.conversationId) === st) {
      this.active.delete(st.conversationId);
    }
    this.lastRun.set(st.conversationId, st.id);
  }

  /** CheckpointService.onSnapshot: the checkpoint taken before a turn, linked to its run and user message. */
  checkpoint(session: Session, entry: CheckpointEntry): void {
    const conv = rootId(session.id);
    const st = this.active.get(conv);
    const id = checkpointId(conv, entry.run);
    const user = [...session.messages].reverse().find((m) => m.role === 'user' && m.meta?.checkpoint === entry.run);
    const fields = checkpointFields(entry, conv, this.o.deviceId, entry.root ? this.o.projectOf?.(entry.root) : undefined);
    // `restoredAt: null`: a turn retaken after a rewind reuses the id and starts unrestored.
    this.append('checkpoint', id, 'create', { ...fields, ...(st ? { agentSessionId: st.id } : {}), ...(user?.meta?.id ? { messageId: user.meta.id } : {}), restoredAt: null });
    if (st) {
      st.checkpointId = id;
    }
  }

  /** A checkpoint's files were put back. `entry`, when known, (re)creates an entity a 1.6 checkpoint never had. */
  restored(sessionId: string, run: number, entry?: CheckpointEntry): void {
    const conv = rootId(sessionId);
    const id = checkpointId(conv, run);
    if (entry) {
      this.append('checkpoint', id, 'create', checkpointFields(entry, conv, this.o.deviceId, entry.root ? this.o.projectOf?.(entry.root) : undefined));
    }
    this.append('checkpoint', id, 'patch', { conversationId: conv, run, restoredAt: this.now() }, { durable: true });
  }

  /** RecoveryStore.onSave: the run's self-healing phase (patched only when the phase or the attempt changes). */
  recovery(state: { sessionId: string; phase: string; attempts?: { category?: string }[]; active?: { category?: string }[] }): void {
    const conv = rootId(state.sessionId);
    const id = this.active.get(conv)?.id ?? this.lastRun.get(conv);
    if (!id) {
      return;
    }
    const attempt = state.attempts?.length ?? 0;
    const category = state.attempts?.[attempt - 1]?.category ?? state.active?.[0]?.category;
    const key = `${state.phase}:${attempt}`;
    if (this.recoveries.get(id) === key) {
      return;
    }
    this.recoveries.set(id, key);
    this.append('agent_session', id, 'patch', { recovery: { phase: state.phase, attempt, ...(category ? { category } : {}) } });
  }

  /** TraceStore.onAdd: the run's trace is stored (the Trace card can open it from the agent session). */
  traceAdded(trace: Pick<RunTrace, 'id'>): void {
    const id = agentSessionId(trace.id);
    if (this.traced.delete(id)) {
      this.append('agent_session', id, 'patch', { traceId: trace.id });
    }
  }

  dispose(): void {
    this.o.drafts?.dispose();
  }
}
