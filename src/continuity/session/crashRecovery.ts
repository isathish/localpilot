// Crash recovery (design §13 "VS Code crashes during an agent task", SESSION brief item 4): agent sessions still marked
// `running` whose writer is gone (its stream's lease is free, or it is this process's own stream and the run is not in
// progress here) are patched to `interrupted`. What the Run interrupted card shows about such a run ("What ran",
// "Changed files") is read here too. Pure Node (no vscode).
import * as path from 'path';
import type { IndexClient } from '../data/index/indexClient';
import { leaseIsFree } from '../data/lease';
import type { RunLog } from './runBridge';

export interface AgentSessionRow {
  id: string;
  conversationId: string;
  messageId?: string;
  run: number;
  mode?: string;
  model?: string;
  startedAt: number;
  endedAt?: number;
  outcome: 'running' | 'ok' | 'error' | 'stopped' | 'interrupted';
  writer?: string;
  filesTouched: string[];
  promptTokens?: number;
  completionTokens?: number;
  recovery?: { phase: string; attempt: number; category?: string };
  traceId?: string;
  title?: string;
}

export interface ExecutionEventRow {
  id: string;
  seq: number;
  kind: string;
  name: string;
  status?: string;
  start: number;
  end?: number;
  detail?: string;
  error?: string;
  output?: string;
  outputBlob?: string;
  depth?: number;
}

export interface CheckpointRow {
  id: string;
  conversationId: string;
  agentSessionId?: string;
  messageId?: string;
  run: number;
  kind?: string;
  outcome?: string;
  ref?: string;
  sha?: string;
  root?: string;
  projectId?: string;
  files: { path: string; status: 'A' | 'M' | 'D' }[];
  contentBlob?: string;
  device?: string;
  createdAt: number;
  restoredAt?: number;
}

export interface ModelSessionRow {
  id: string;
  conversationId: string;
  provider?: string;
  model: string;
  local: boolean;
  window?: number;
  fromMessageId?: string;
  toMessageId?: string;
  startedAt: number;
  endedAt?: number;
  promptTokens: number;
  completionTokens: number;
  reason?: string;
}

const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined);
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
function parse<T>(v: unknown, fallback: T): T {
  if (typeof v !== 'string' || !v) {
    return fallback;
  }
  try {
    return JSON.parse(v) as T;
  } catch {
    return fallback;
  }
}

export function agentSessionRow(r: Record<string, unknown>): AgentSessionRow {
  return {
    id: String(r.id),
    conversationId: String(r.conversation_id ?? ''),
    messageId: str(r.message_id),
    run: num(r.run) ?? 0,
    mode: str(r.mode),
    model: str(r.model),
    startedAt: num(r.started_at) ?? 0,
    endedAt: num(r.ended_at),
    outcome: (str(r.outcome) ?? 'running') as AgentSessionRow['outcome'],
    writer: str(r.writer),
    filesTouched: parse<string[]>(r.files_touched, []),
    promptTokens: num(r.prompt_tokens),
    completionTokens: num(r.completion_tokens),
    recovery: parse<AgentSessionRow['recovery']>(r.recovery, undefined),
    traceId: str(r.trace_id),
    title: str(r.title),
  };
}

export function executionEventRow(r: Record<string, unknown>): ExecutionEventRow {
  return {
    id: String(r.id),
    seq: num(r.seq) ?? 0,
    kind: String(r.kind ?? ''),
    name: String(r.name ?? ''),
    status: str(r.status),
    start: num(r.start) ?? 0,
    end: num(r.end),
    detail: str(r.detail),
    error: str(r.error),
    output: str(r.output),
    outputBlob: str(r.output_blob),
    depth: num(r.depth),
  };
}

export function checkpointRow(r: Record<string, unknown>): CheckpointRow {
  return {
    id: String(r.id),
    conversationId: String(r.conversation_id ?? ''),
    agentSessionId: str(r.agent_session_id),
    messageId: str(r.message_id),
    run: num(r.run) ?? 0,
    kind: str(r.kind),
    outcome: str(r.outcome),
    ref: str(r.ref),
    sha: str(r.sha),
    root: str(r.root),
    projectId: str(r.project_id),
    files: parse<CheckpointRow['files']>(r.files, []),
    contentBlob: str(r.content_blob),
    device: str(r.device),
    createdAt: num(r.created_at) ?? 0,
    restoredAt: num(r.restored_at),
  };
}

export function modelSessionRow(r: Record<string, unknown>): ModelSessionRow {
  return {
    id: String(r.id),
    conversationId: String(r.conversation_id ?? ''),
    provider: str(r.provider),
    model: String(r.model ?? ''),
    local: r.local === 1 || r.local === true,
    window: num(r.window),
    fromMessageId: str(r.from_message_id),
    toMessageId: str(r.to_message_id),
    startedAt: num(r.started_at) ?? 0,
    endedAt: num(r.ended_at),
    promptTokens: num(r.prompt_tokens) ?? 0,
    completionTokens: num(r.completion_tokens) ?? 0,
    reason: str(r.reason),
  };
}

export interface WriterCheck {
  /** Data root (stream leases live in `<root>/streams/<stream>/lease.json`). */
  root: string;
  deviceId: string;
  /** This process's stream (a stream taken over after a crash has the same id as the writer that died). */
  ownStream: string;
  /** True while this process runs that agent session. */
  isActive: (agentSessionId: string) => boolean;
  now?: () => number;
}

/**
 * Whether the writer of a `running` agent session is gone: on this machine, its stream's lease is free (or it is this
 * process's stream and the run is not in progress here). Other devices' runs are never judged here (that device will
 * mark them when it starts again), so `false`.
 */
export function writerGone(row: Pick<AgentSessionRow, 'id' | 'writer'>, w: WriterCheck): boolean {
  const writer = row.writer;
  if (!writer) {
    return true;
  }
  if (writer === w.ownStream) {
    return !w.isActive(row.id);
  }
  const device = writer.slice(0, writer.lastIndexOf('.'));
  if (device !== w.deviceId) {
    return false;
  }
  return leaseIsFree(path.join(w.root, 'streams', writer, 'lease.json'), { now: w.now });
}

/** Patches every `running` agent session whose writer is gone to `interrupted`; returns their ids. */
export async function markInterrupted(index: IndexClient, log: RunLog, w: WriterCheck): Promise<AgentSessionRow[]> {
  const rows = (await index.query<Record<string, unknown>>('runningAgentSessions', {})).map(agentSessionRow);
  const out: AgentSessionRow[] = [];
  for (const r of rows) {
    if (writerGone(r, w)) {
      log.append('agent_session', r.id, 'patch', { outcome: 'interrupted' }, { durable: true });
      out.push({ ...r, outcome: 'interrupted' });
    }
  }
  return out;
}

export interface InterruptedRun {
  agentSession: AgentSessionRow;
  /** What ran, in order (the last `limit`). */
  events: ExecutionEventRow[];
  /** Events left out before the shown ones. */
  more: number;
  checkpoint?: CheckpointRow;
}

/** The chat's last run when it did not finish (interrupted, or `running` with its writer gone), with what ran. */
export async function interruptedRun(index: IndexClient, conversationId: string, w: WriterCheck, limit = 30): Promise<InterruptedRun | undefined> {
  const rows = (await index.query<Record<string, unknown>>('agentSessions', { conversationId })).map(agentSessionRow);
  const last = rows[0];
  if (!last || !(last.outcome === 'interrupted' || (last.outcome === 'running' && writerGone(last, w)))) {
    return undefined;
  }
  const events = (await index.query<Record<string, unknown>>('executionEvents', { agentSessionId: last.id })).map(executionEventRow);
  const cps = (await index.query<Record<string, unknown>>('checkpoints', { conversationId })).map(checkpointRow);
  const checkpoint = cps.find((c) => c.agentSessionId === last.id) ?? cps.find((c) => c.run === last.run);
  return { agentSession: last, events: events.slice(-limit), more: Math.max(0, events.length - limit), ...(checkpoint ? { checkpoint } : {}) };
}
