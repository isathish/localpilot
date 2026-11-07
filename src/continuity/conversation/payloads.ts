// Payload builders shared by migration (DATA) and the SessionBridge (CONVERSATION): Session / ChatMessage / RunTrace /
// checkpoint / memory note / custom command -> event payloads, and back. Deterministic ids for data that already
// exists, so a chat migrated once and saved again later by the bridge keeps the same message ids. Pure: no vscode.
import * as crypto from 'crypto';
import type { ChatMessage, Session } from '../../types';
import type { CheckpointEntry } from '../../agent/checkpoints';
import type { RunTrace, TraceEntry } from '../../telemetry/runTrace';
import type { AgentSessionFields, AttachmentFields, CheckpointFields, ConversationFields, ExecutionEventFields, MemoryItemFields, MemoryType, MessageFields, MessagePart, ProjectFields, PromptTemplateFields } from '../events';
import { mainBranchId, stableId } from '../ids';

/** Text parts bigger than this go to a blob (the event keeps a preview); tool outputs per design §5.1. */
export const INLINE_TEXT_MAX = 64 * 1024;
const PREVIEW = 4 * 1024;

export interface BlobSink {
  put(data: Uint8Array | string): string;
}
export interface BlobSource {
  get(sha: string): Buffer | undefined;
}

/**
 * Id of a message that has none yet (`meta.id` unset): deterministic from the conversation, its position and content.
 * Messages that a compaction archived are identified by their archive number, which never changes.
 */
export function legacyMessageId(conversationId: string, m: ChatMessage, index: number): string {
  if (m.meta?.id) {
    return m.meta.id;
  }
  if (m.meta?.archived !== undefined) {
    // Not the content: the verbatim copy a compaction keeps may be pruned, and must still be the same message.
    return stableId('m', conversationId, 'archived', String(m.meta.archived), m.role);
  }
  return stableId('m', conversationId, String(index), m.role, m.content ?? '');
}

export function conversationOrigin(s: Pick<Session, 'origin'>, fallback: ConversationFields['origin'] = 'vscode'): ConversationFields['origin'] {
  return s.origin ?? fallback;
}

/** The conversation entity of a session (summary fields only; messages are their own entities). */
export function conversationFields(s: Session, o: { projectId?: string; origin?: ConversationFields['origin']; activeBranchId?: string } = {}): ConversationFields {
  return {
    title: s.title || 'New chat',
    ...(o.projectId ? { projectId: o.projectId } : {}),
    ...(s.folder ? { folder: s.folder } : {}),
    model: s.model ?? '',
    mode: s.mode ?? 'agent',
    ...(s.specialist ? { specialist: s.specialist } : {}),
    ...(s.autoMode ? { autoMode: true } : {}),
    ...(s.think ? { think: s.think } : {}),
    pinned: !!s.pinned,
    favorite: false,
    archived: false,
    tags: {},
    activeBranchId: o.activeBranchId ?? mainBranchId(s.id),
    ...(s.parentId ? { parentId: s.parentId } : {}),
    ...(s.parentTitle ? { parentTitle: s.parentTitle } : {}),
    origin: o.origin ?? conversationOrigin(s),
    ...(s.group ? { group: s.group } : {}),
    ...(s.plan ? { plan: s.plan } : {}),
    ...(s.usage ? { usage: s.usage } : {}),
    createdAt: s.createdAt ?? Date.now(),
    updatedAt: s.updatedAt ?? s.createdAt ?? Date.now(),
  };
}

/** Image mime type from the first bytes of a base64 image. */
export function imageMime(b64: string): string {
  const head = Buffer.from(b64.slice(0, 24), 'base64');
  if (head[0] === 0x89 && head[1] === 0x50) {
    return 'image/png';
  }
  if (head[0] === 0xff && head[1] === 0xd8) {
    return 'image/jpeg';
  }
  if (head.subarray(0, 4).toString('ascii') === 'GIF8') {
    return 'image/gif';
  }
  if (head.subarray(0, 4).toString('ascii') === 'RIFF') {
    return 'image/webp';
  }
  return 'application/octet-stream';
}

function bigText(kind: 'text' | 'thinking', text: string, blobs?: BlobSink): MessagePart {
  if (text.length <= INLINE_TEXT_MAX || !blobs) {
    return { kind, text };
  }
  return { kind, text: text.slice(0, PREVIEW), blob: blobs.put(text), truncated: true };
}

export interface MessagePayload {
  fields: MessageFields;
  attachments: { id: string; fields: AttachmentFields }[];
}

/** A ChatMessage -> message payload (+ attachment entities for its images, stored as blobs). */
export function messageFields(conversationId: string, branchId: string, parentId: string | undefined, m: ChatMessage, o: { blobs?: BlobSink; createdAt?: number } = {}): MessagePayload {
  const parts: MessagePart[] = [];
  const attachments: MessagePayload['attachments'] = [];
  const createdAt = m.meta?.timestamp ?? o.createdAt ?? Date.now();
  if (m.role === 'tool') {
    const text = m.content ?? '';
    parts.push(
      text.length > INLINE_TEXT_MAX && o.blobs
        ? { kind: 'tool_result', callId: m.toolCallId ?? '', name: m.toolName ?? '', text: text.slice(0, PREVIEW), blob: o.blobs.put(text), truncated: true, ...(m.meta?.failed ? { isError: true } : {}) }
        : { kind: 'tool_result', callId: m.toolCallId ?? '', name: m.toolName ?? '', text, ...(m.meta?.failed ? { isError: true } : {}) }
    );
  } else if (m.content) {
    parts.push(bigText('text', m.content, o.blobs));
  }
  if (m.thinking) {
    parts.push(bigText('thinking', m.thinking, o.blobs));
  }
  for (const tc of m.toolCalls ?? []) {
    parts.push({ kind: 'tool_call', callId: tc.id, name: tc.name, args: tc.arguments ?? '', ...(tc.extra ? { extra: tc.extra } : {}) });
  }
  for (const img of m.images ?? []) {
    if (!o.blobs) {
      continue;
    }
    const bytes = Buffer.from(img, 'base64');
    const sha = o.blobs.put(bytes);
    const id = stableId('att', conversationId, sha);
    const mime = imageMime(img);
    attachments.push({ id, fields: { blob: sha, mime, bytes: bytes.length, conversationId, createdAt } });
    parts.push({ kind: 'image', attachmentId: id, mime });
  }
  const { id: _id, ...meta } = m.meta ?? {};
  void _id;
  return {
    fields: {
      conversationId,
      branchId,
      ...(parentId ? { parentId } : {}),
      role: m.role as MessageFields['role'],
      parts,
      meta,
      ...(m.meta?.model ? { model: m.meta.model } : {}),
      // SESSION: a generation cut off by a crash or a closed laptop (kept from its draft), indexed as such.
      ...(m.meta?.partial ? { partial: true } : {}),
      createdAt,
    },
    attachments,
  };
}

/**
 * The inverse of `messageFields`: a ChatMessage from a message payload. Blob-backed text is read back when a blob
 * source is given (else the preview stays); images are resolved through `image(attachmentId)` (base64).
 */
export function chatMessageOf(id: string, f: MessageFields, o: { blobs?: BlobSource; image?: (attachmentId: string) => string | undefined } = {}): ChatMessage {
  const full = (p: { text: string; blob?: string }) => (p.blob && o.blobs ? (o.blobs.get(p.blob)?.toString('utf8') ?? p.text) : p.text);
  const m: ChatMessage = { role: f.role, content: '' };
  const toolCalls: NonNullable<ChatMessage['toolCalls']> = [];
  const images: string[] = [];
  for (const p of f.parts ?? []) {
    switch (p.kind) {
      case 'text':
        m.content += full(p);
        break;
      case 'thinking':
        m.thinking = (m.thinking ?? '') + full(p);
        break;
      case 'tool_call':
        toolCalls.push({ id: p.callId, name: p.name, arguments: p.args, ...(p.extra ? { extra: p.extra } : {}) });
        break;
      case 'tool_result':
        m.content += full(p);
        m.toolCallId = p.callId || undefined;
        m.toolName = p.name || undefined;
        break;
      case 'image': {
        const b64 = o.image?.(p.attachmentId);
        if (b64) {
          images.push(b64);
        }
        break;
      }
    }
  }
  if (toolCalls.length) {
    m.toolCalls = toolCalls;
  }
  if (images.length) {
    m.images = images;
  }
  if (m.toolCallId === undefined) {
    delete m.toolCallId;
  }
  if (m.toolName === undefined) {
    delete m.toolName;
  }
  m.meta = { ...(f.meta ?? {}), id };
  return m;
}

// ---------------------------------------------------------------------------------------------- projects

export function pathHash(normalizedPath: string): string {
  return crypto.createHash('sha256').update(normalizedPath).digest('hex');
}

/** `git@github.com:Org/Repo.git`, `https://user:tok@GitHub.com/Org/Repo` -> `github.com/Org/Repo`. */
export function normalizeGitRemote(url: string): string {
  let u = url.trim().replace(/\.git$/i, '').replace(/\/+$/, '');
  const scp = /^[\w.-]+@([^:/]+):(.+)$/.exec(u);
  if (scp) {
    return `${scp[1].toLowerCase()}/${scp[2]}`;
  }
  try {
    const p = new URL(u);
    return `${p.hostname.toLowerCase()}${p.port ? `:${p.port}` : ''}${p.pathname}`.replace(/\/+$/, '');
  } catch {
    u = u.replace(/^[a-z]+:\/\//i, '').replace(/^[^@/]+@/, '');
    return u;
  }
}

/**
 * Project id: from the git fingerprint when both parts are known (the same repository on every device gets the same
 * id), else from the path hash of the first device that saw it.
 */
export function projectIdFor(fp: { gitRemote?: string; rootCommit?: string; pathHash?: string }): string {
  if (fp.gitRemote && fp.rootCommit) {
    return stableId('prj', 'git', fp.gitRemote, fp.rootCommit);
  }
  return stableId('prj', 'path', fp.pathHash ?? '');
}

export function projectFields(o: { name: string; path: string; normalizedPath: string; deviceId: string; gitRemote?: string; rootCommit?: string; createdAt?: number }): ProjectFields {
  return {
    name: o.name,
    fingerprints: { ...(o.gitRemote ? { gitRemote: o.gitRemote } : {}), ...(o.rootCommit ? { rootCommit: o.rootCommit } : {}), pathHash: { [o.deviceId]: pathHash(o.normalizedPath) } },
    paths: { [o.deviceId]: o.path },
    createdAt: o.createdAt ?? Date.now(),
  };
}

// ---------------------------------------------------------------------------------------------- agent state

export function agentSessionFromTrace(t: RunTrace, conversationId: string, writer: string, run?: number): AgentSessionFields {
  return {
    conversationId,
    run: run ?? 0,
    mode: t.mode ?? 'agent',
    ...(t.model ? { model: t.model } : {}),
    startedAt: t.startedAt,
    ...(t.durationMs !== undefined ? { endedAt: t.startedAt + t.durationMs } : {}),
    outcome: t.outcome === 'running' ? 'interrupted' : t.outcome,
    writer,
    ...(t.promptTokens !== undefined ? { promptTokens: t.promptTokens } : {}),
    ...(t.completionTokens !== undefined ? { completionTokens: t.completionTokens } : {}),
    traceId: t.id,
    title: t.title,
  };
}

/** Agent session id of a trace: the trace id when it is a safe id, else derived from it. */
export function agentSessionId(traceId: string): string {
  return /^as_[\w-]+$/.test(traceId) ? traceId : stableId('as', traceId);
}

export function executionEventId(agentSessionId: string, seq: number): string {
  return stableId('ex', agentSessionId, String(seq));
}

export function executionEventFromTrace(t: RunTrace, e: TraceEntry, seq: number, conversationId: string, asId: string): ExecutionEventFields {
  return {
    agentSessionId: asId,
    conversationId,
    seq,
    kind: e.kind,
    name: e.name,
    ...(e.status ? { status: e.status } : {}),
    start: t.startedAt + e.start,
    ...(e.end !== undefined ? { end: t.startedAt + e.end } : {}),
    ...(e.detail ? { detail: e.detail } : {}),
    ...(e.status === 'error' && e.detail ? { error: e.detail } : {}),
    ...(e.depth ? { depth: e.depth } : {}),
    ...(e.agent ? { agent: e.agent } : {}),
  };
}

/** Deterministic checkpoint id (design §3). */
export function checkpointId(conversationId: string, run: number): string {
  return `cp_${conversationId}_${run}`.replace(/[^\w.-]/g, '_').slice(0, 120);
}

export function checkpointFields(e: CheckpointEntry, conversationId: string, device: string, projectId?: string): CheckpointFields {
  return {
    conversationId,
    run: e.run,
    kind: e.kind,
    outcome: e.outcome,
    ...(e.ref ? { ref: e.ref } : {}),
    ...(e.sha ? { sha: e.sha } : {}),
    ...(e.root ? { root: e.root } : {}),
    ...(projectId ? { projectId } : {}),
    device,
    createdAt: e.createdAt,
  };
}

// ---------------------------------------------------------------------------------------------- memory and prompts

/** Memory item id of a note (design §3): the same note on two devices is the same entity. `global` = `developer`. */
export function memoryItemId(type: MemoryType | 'global', scopeKey: string, name: string): string {
  return stableId('mem', type === 'global' ? 'developer' : type, scopeKey, name);
}

export function noteSummary(body: string): string {
  return (body.split('\n').map((l) => l.replace(/^#+\s*/, '').trim()).find(Boolean) ?? '').slice(0, 200);
}

export function memoryNoteFields(o: { type: MemoryType; name: string; body: string; projectId?: string; file?: string; source: MemoryItemFields['source']; createdAt: number }): MemoryItemFields {
  return {
    type: o.type,
    name: o.name,
    body: o.body,
    summary: noteSummary(o.body),
    ...(o.projectId ? { projectId: o.projectId } : {}),
    source: o.source,
    ...(o.file ? { file: o.file } : {}),
    tags: {},
    createdAt: o.createdAt,
  };
}

export function promptTemplateId(scope: 'user' | 'workspace', scopeKey: string, name: string): string {
  return stableId('pt', scope, scopeKey, name);
}

/** A custom command file (`---\ndescription: …\n---\nbody`) -> prompt template payload. */
export function promptTemplateFields(o: { name: string; text: string; scope: 'user' | 'workspace'; file?: string; projectId?: string }): PromptTemplateFields {
  const fm = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(o.text);
  const description = fm ? (/^description:\s*(.+)$/m.exec(fm[1])?.[1] ?? '').trim().replace(/^["']|["']$/g, '') : '';
  return { name: o.name, description, body: o.text, scope: o.scope, ...(o.file ? { file: o.file } : {}), ...(o.projectId ? { projectId: o.projectId } : {}) };
}
