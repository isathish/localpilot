// Event envelope and payload shapes of every continuity entity (design §4.1, §5.1). One event = one line of a stream
// segment. Readers ignore unknown payload fields; writers never remove a field without bumping the entity's schema
// version (`sv`) and adding an upgrade step to `upgradePayload`. Pure: no vscode (type-only imports below).
import type { ChatMessage, CompactionDetails, SessionUsage, TodoItem } from '../types';
import type { ContextBreakdown } from '../context/contextBreakdown';
import type { WorktreeInfo } from '../agent/worktrees';
import type { CheckpointKind, CheckpointOutcome } from '../agent/checkpoints';
import type { TraceKind, TraceStatus } from '../telemetry/runTrace';

export const ENVELOPE_VERSION = 1;

export type EntityKind =
  | 'conversation' | 'branch' | 'message' | 'project' | 'memory' | 'context_snapshot' | 'context_item'
  | 'attachment' | 'agent_session' | 'execution_event' | 'checkpoint' | 'model_session' | 'prompt_template'
  | 'instruction_file' | 'preference' | 'device' | 'conflict' | 'migration';
export type Op = 'create' | 'patch' | 'trash' | 'restore' | 'purge';

export const ENTITY_KINDS: readonly EntityKind[] = [
  'conversation', 'branch', 'message', 'project', 'memory', 'context_snapshot', 'context_item', 'attachment', 'agent_session',
  'execution_event', 'checkpoint', 'model_session', 'prompt_template', 'instruction_file', 'preference', 'device', 'conflict', 'migration',
];
const OPS: readonly Op[] = ['create', 'patch', 'trash', 'restore', 'purge'];

/** Payload schema version this build writes and understands, per entity. */
export const SCHEMA_VERSIONS: Readonly<Record<EntityKind, number>> = Object.fromEntries(ENTITY_KINDS.map((k) => [k, 1])) as Record<EntityKind, number>;

export interface EventEnvelope<P = Record<string, unknown>> {
  v: 1;
  /** `${stream}:${seq}`; compacted bases use `${stream}:${seq}.${i}` (§5.6). */
  id: string;
  stream: string;
  seq: number;
  hlc: string;
  dev: string;
  ent: EntityKind;
  eid: string;
  op: Op;
  sv: number;
  p: P;
  base?: string;
  cause?: string;
  local?: true;
}

/** Where an event's line lives, for random access (materialising message bodies). */
export interface EventLoc {
  stream: string;
  segment: number;
  offset: number;
  length: number;
}

// ---------------------------------------------------------------------------------------------- payloads (§4.1)

export interface ConversationFields {
  title: string;
  projectId?: string;
  folder?: string;
  model: string;
  mode: string;
  specialist?: string;
  autoMode?: boolean;
  think?: string;
  pinned: boolean;
  favorite: boolean;
  archived: boolean;
  trashedAt?: number;
  tags: Record<string, boolean>;
  activeBranchId: string;
  parentId?: string;
  parentMessageId?: string;
  parentTitle?: string;
  mergedFrom?: string[];
  origin?: 'cli' | 'claude-code' | 'codex' | 'vscode' | 'import' | 'share';
  summary?: string;
  summaryAt?: number;
  group?: { id: string; kind: 'bestOf' | 'batch'; prompt: string; size: number };
  plan?: { file: string; title: string; summary: string };
  usage?: SessionUsage;
  createdAt: number;
  /** Last activity (the session's updatedAt); the index also derives it from event times. */
  updatedAt?: number;
}
export interface BranchFields {
  conversationId: string;
  label?: string;
  forkedFromMessageId?: string;
  headId?: string;
  reason?: 'edit' | 'regenerate' | 'continue' | 'device-split' | 'restore-version' | 'manual';
  createdAt: number;
}
export type MessagePart =
  | { kind: 'text'; text: string; blob?: string; truncated?: boolean }
  | { kind: 'thinking'; text: string; blob?: string; truncated?: boolean }
  | { kind: 'image'; attachmentId: string; mime: string }
  | { kind: 'tool_call'; callId: string; name: string; args: string; extra?: Record<string, unknown> }
  | { kind: 'tool_result'; callId: string; name: string; text: string; isError?: boolean; blob?: string; truncated?: boolean };
export interface MessageFields {
  conversationId: string;
  branchId: string;
  parentId?: string;
  role: 'system' | 'user' | 'assistant' | 'tool';
  parts: MessagePart[];
  meta: Omit<NonNullable<ChatMessage['meta']>, 'id'>;
  supersedes?: string;
  model?: string;
  provider?: string;
  agentSessionId?: string;
  partial?: boolean;
  /** On a compaction summary: the ids of the earlier messages the chat kept verbatim after it (CONVERSATION). */
  keeps?: string[];
  /** Tool call arguments were cut to fit the line limit. */
  truncated?: boolean;
  createdAt: number;
}
export interface ProjectFields {
  name: string;
  fingerprints: { gitRemote?: string; rootCommit?: string; pathHash: Record<string, string> };
  paths: Record<string, string>;
  createdAt: number;
}
export type MemoryType = 'conversation' | 'project' | 'developer' | 'task' | 'knowledge' | 'agent';
export interface MemoryItemFields {
  type: MemoryType;
  name: string;
  body: string;
  summary: string;
  projectId?: string;
  conversationId?: string;
  taskRef?: string;
  source: 'user' | 'agent' | 'auto' | 'file' | 'migration';
  file?: string;
  localOnly?: boolean;
  expiresAt?: number;
  pinned?: boolean;
  tags: Record<string, boolean>;
  trashedAt?: number;
  createdAt: number;
}
export interface ContextSnapshotFields {
  conversationId: string;
  agentSessionId?: string;
  messageId?: string;
  model: string;
  provider: string;
  window: number;
  usedTokens: number;
  breakdown?: ContextBreakdown;
  items: { kind: 'file' | 'selection' | 'memory' | 'rule' | 'summary' | 'library' | 'history' | 'tool'; ref: string; tokens: number; hash?: string }[];
  excluded?: { ref: string; reason: 'localOnly' | 'budget' | 'ignored' }[];
  compaction?: CompactionDetails;
  attachments: string[];
  workingSet: string[];
  todos?: TodoItem[];
  createdAt: number;
  /** CONTEXT (as built): which request this is (the turn's last one, or either side of a compaction). */
  phase?: 'turn' | 'before-compaction' | 'after-compaction';
  /** The model is served by a cloud API (the local -> cloud notice and the local-only policy). */
  remote?: boolean;
  /** The folder relative paths are resolved against, on the device that recorded it. */
  root?: string;
  /** sha256 of working-set and attached files when the snapshot was taken (restoration marks the ones that changed). */
  fileHashes?: Record<string, string>;
}
export interface ContextLibraryFields {
  name: string;
  description?: string;
  projectId?: string;
  items: { kind: 'file' | 'glob' | 'snippet' | 'memory' | 'conversation' | 'url'; ref: string; text?: string }[];
  createdAt: number;
  trashedAt?: number;
  /** CONTEXT (as built): never sent to a cloud model (the context policy strips it). */
  localOnly?: boolean;
}
export interface AttachmentFields {
  blob: string;
  mime: string;
  bytes: number;
  name?: string;
  conversationId?: string;
  createdAt: number;
}
export interface AgentSessionFields {
  conversationId: string;
  messageId?: string;
  run: number;
  mode: string;
  specialist?: string;
  model?: string;
  provider?: string;
  startedAt: number;
  endedAt?: number;
  outcome: 'running' | 'ok' | 'error' | 'stopped' | 'interrupted';
  writer: string;
  worktree?: WorktreeInfo;
  recovery?: { phase: string; attempt: number; category?: string };
  filesTouched?: string[];
  promptTokens?: number;
  completionTokens?: number;
  costUsd?: number;
  traceId?: string;
  title?: string;
}
export interface ExecutionEventFields {
  agentSessionId: string;
  conversationId: string;
  seq: number;
  kind: TraceKind | 'approval_answer' | 'file_edit' | 'command_output';
  name: string;
  status?: TraceStatus;
  start: number;
  end?: number;
  detail?: string;
  error?: string;
  output?: string;
  outputBlob?: string;
  depth?: number;
  agent?: string;
}
export interface CheckpointFields {
  conversationId: string;
  agentSessionId?: string;
  messageId?: string;
  run: number;
  kind: CheckpointKind;
  outcome: CheckpointOutcome;
  ref?: string;
  sha?: string;
  root?: string;
  projectId?: string;
  files?: { path: string; status: 'A' | 'M' | 'D' }[];
  contentBlob?: string;
  device: string;
  createdAt: number;
  restoredAt?: number;
}
export interface ModelSessionFields {
  conversationId: string;
  provider: string;
  model: string;
  local: boolean;
  window?: number;
  fromMessageId: string;
  toMessageId?: string;
  startedAt: number;
  endedAt?: number;
  promptTokens: number;
  completionTokens: number;
  costUsd?: number;
  reason?: 'user' | 'auto' | 'fallback' | 'provider-down';
}
export interface PromptTemplateFields {
  name: string;
  description: string;
  body: string;
  scope: 'user' | 'workspace';
  projectId?: string;
  file?: string;
  trashedAt?: number;
}
export interface InstructionFileFields {
  scope: 'user' | 'project';
  projectId?: string;
  path: string;
  body: string;
  gitTracked: boolean;
}
export interface PreferenceFields {
  key: string;
  value: unknown;
}
export interface DeviceFields {
  name: string;
  platform: string;
  appVersions: Partial<Record<'vscode' | 'cli', string>>;
  lastSeen: number;
  revokedAt?: number;
  streams: string[];
}
export type ConflictKind = 'field' | 'branch-split' | 'trash-vs-edit' | 'text-merge' | 'remote-damaged' | 'clock-skew';
export interface ConflictFields {
  entity: EntityKind;
  entityId: string;
  field: string;
  kind: ConflictKind;
  ours: { value: unknown; hlc: string; device: string };
  theirs: { value: unknown; hlc: string; device: string };
  applied: 'ours' | 'theirs' | 'both' | 'merged';
  resolvedAt?: number;
  resolution?: 'keep-applied' | 'ours' | 'theirs' | 'both' | 'merged';
}
/** Migration progress markers (one per source file), so other devices and the index know where data came from. */
export interface MigrationFields {
  source: string;
  path: string;
  sha256: string;
  events: number;
  at: number;
}

/** Payload of a trash / restore / purge event. */
export interface LifecyclePayload {
  at: number;
  reason?: string;
}

export type FieldsOf<E extends EntityKind> = E extends 'conversation' ? ConversationFields
  : E extends 'branch' ? BranchFields
  : E extends 'message' ? MessageFields
  : E extends 'project' ? ProjectFields
  : E extends 'memory' ? MemoryItemFields
  : E extends 'context_snapshot' ? ContextSnapshotFields
  : E extends 'context_item' ? ContextLibraryFields
  : E extends 'attachment' ? AttachmentFields
  : E extends 'agent_session' ? AgentSessionFields
  : E extends 'execution_event' ? ExecutionEventFields
  : E extends 'checkpoint' ? CheckpointFields
  : E extends 'model_session' ? ModelSessionFields
  : E extends 'prompt_template' ? PromptTemplateFields
  : E extends 'instruction_file' ? InstructionFileFields
  : E extends 'preference' ? PreferenceFields
  : E extends 'device' ? DeviceFields
  : E extends 'conflict' ? ConflictFields
  : MigrationFields;

// ---------------------------------------------------------------------------------------------- validation

/** Longest event line (bytes, newline excluded); bigger payloads go to blobs. */
export const MAX_LINE_BYTES = 1024 * 1024;

/** Why an envelope is malformed, or undefined when it is well-formed. Unknown kinds and newer `sv` are well-formed. */
export function validateEnvelope(e: unknown): string | undefined {
  if (!e || typeof e !== 'object') {
    return 'not an object';
  }
  const x = e as Partial<EventEnvelope>;
  if (x.v !== ENVELOPE_VERSION) {
    return `envelope version ${String(x.v)}`;
  }
  if (typeof x.stream !== 'string' || !x.stream) {
    return 'missing stream';
  }
  if (typeof x.seq !== 'number' || !Number.isInteger(x.seq) || x.seq < 1) {
    return 'bad seq';
  }
  if (typeof x.id !== 'string' || !x.id.startsWith(`${x.stream}:${x.seq}`)) {
    return 'bad id';
  }
  if (typeof x.hlc !== 'string' || !/^[0-9a-f]{12}-[0-9a-f]{4}-.+$/.test(x.hlc)) {
    return 'bad hlc';
  }
  if (typeof x.dev !== 'string' || typeof x.ent !== 'string' || typeof x.eid !== 'string' || !x.eid) {
    return 'missing dev/ent/eid';
  }
  if (!OPS.includes(x.op as Op)) {
    return `unknown op ${String(x.op)}`;
  }
  if (typeof x.sv !== 'number' || x.sv < 1) {
    return 'bad sv';
  }
  if (!x.p || typeof x.p !== 'object' || Array.isArray(x.p)) {
    return 'bad payload';
  }
  return undefined;
}

/** Whether this build can apply the event (known entity, schema version it understands). */
/**
 * SYNC: the stand-in a writer uploads for an event it does not sync (marked `local`, or its sync category is off), so
 * the remote copy of the stream stays gapless. Same id, seq and HLC; the payload is only `{ __withheld: reason }`.
 * Every reader skips it (reducer, index); the real event may reach other devices later as a re-sent copy.
 */
export function withheldStandIn(e: EventEnvelope, reason: string): EventEnvelope {
  return { v: e.v, id: e.id, stream: e.stream, seq: e.seq, hlc: e.hlc, dev: e.dev, ent: e.ent, eid: e.eid, op: 'patch', sv: 1, p: { __withheld: reason } };
}

/** True for a SYNC stand-in (`withheldStandIn`): nothing to apply. */
export function isWithheld(e: Pick<EventEnvelope, 'p'>): boolean {
  return !!e.p && typeof e.p === 'object' && typeof (e.p as { __withheld?: unknown }).__withheld === 'string';
}

export function isKnown(e: Pick<EventEnvelope, 'ent' | 'sv'>): boolean {
  return ENTITY_KINDS.includes(e.ent) && e.sv <= SCHEMA_VERSIONS[e.ent];
}

/**
 * Brings a payload written with schema version `sv` up to the version this build writes. Returns undefined for a
 * version newer than this build (the event stays in the log and is skipped; the Sync manager reports it).
 */
export function upgradePayload(ent: EntityKind, sv: number, p: Record<string, unknown>): Record<string, unknown> | undefined {
  const target = SCHEMA_VERSIONS[ent];
  if (target === undefined || sv > target) {
    return undefined;
  }
  // Version 1 is the first schema of every entity: nothing to upgrade yet. Add steps here as `if (sv < 2) {...}`.
  return p;
}
