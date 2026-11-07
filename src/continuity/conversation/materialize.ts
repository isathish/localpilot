// Materialisation: a SessionStore `Session` rebuilt from the index (rows, reduced states) and the log (message bodies
// read at their locations). Used to restore a chat from Trash, open a chat of another project or an archived one,
// switch branches, show versions, and apply changes made on another device or by another process. Pure Node.
import type { ChatMessage, Session } from '../../types';
import type { BlobStore } from '../data/blobs';
import type { FileEventLog } from '../data/eventLog';
import type { IndexClient } from '../data/index/indexClient';
import type { ConversationRow, MessageRow } from '../data/index/queries';
import type { ConversationFields, MessageFields, MessagePart } from '../events';
import { chatMessageOf } from './payloads';
import { ContextSnapshot, restoreInto } from '../context/contextSnapshots';
import { viewOfPath } from './sessionBridge';

export interface Materialized {
  session: Session;
  row: ConversationRow;
  branchId: string;
  /** The log path of the branch (message ids, root first); `session.messages` is its view (§ compaction keeps). */
  path: string[];
  /** Newest event clock of the conversation (stamped as `session.meta.lastHlc`). */
  version?: string;
}

export interface MaterializeDeps {
  index: IndexClient;
  log: Pick<FileEventLog, 'readAt'>;
  blobs?: BlobStore;
}

interface StateRow {
  id: string;
  ent: string;
  version: string;
  state: string;
}

async function states(index: IndexClient, ids: string[]): Promise<Map<string, { fields: Record<string, unknown>; version: string }>> {
  const out = new Map<string, { fields: Record<string, unknown>; version: string }>();
  for (let i = 0; i < ids.length; i += 4000) {
    for (const r of await index.query<StateRow>('entityStates', { ids: ids.slice(i, i + 4000) })) {
      try {
        out.set(r.id, { fields: (JSON.parse(r.state) as { fields: Record<string, unknown> }).fields ?? {}, version: r.version });
      } catch {
        // a damaged row: that message is skipped
      }
    }
  }
  return out;
}

/** The ChatMessages of a list of message rows (bodies from the log, images from blobs). */
export async function messagesOf(d: MaterializeDeps, rows: MessageRow[]): Promise<{ messages: ChatMessage[]; keeps: Map<string, string[]> }> {
  const st = await states(d.index, rows.map((r) => r.id));
  const keeps = new Map<string, string[]>();
  const bodies = new Map<string, MessagePart[]>();
  for (const r of rows) {
    try {
      const e = await d.log.readAt(r.loc);
      const parts = (e.p as { parts?: MessagePart[] }).parts;
      if (Array.isArray(parts)) {
        bodies.set(r.id, parts);
      }
    } catch {
      // body not readable (redacted, log damaged): the message keeps what the index has
    }
  }
  const attIds = [...bodies.values()].flat().filter((p): p is Extract<MessagePart, { kind: 'image' }> => p.kind === 'image').map((p) => p.attachmentId);
  const atts = new Map<string, string>();
  if (attIds.length) {
    for (const a of await d.index.query<{ id: string; blob: string }>('attachments', { ids: attIds })) {
      atts.set(a.id, a.blob);
    }
  }
  const messages: ChatMessage[] = [];
  for (const r of rows) {
    const f = (st.get(r.id)?.fields ?? {}) as Partial<MessageFields>;
    if (Array.isArray(f.keeps)) {
      keeps.set(r.id, f.keeps.map(String));
    }
    const fields: MessageFields = {
      conversationId: r.conversationId,
      branchId: r.branchId,
      role: (f.role ?? r.role) as MessageFields['role'],
      parts: bodies.get(r.id) ?? [],
      meta: (f.meta ?? {}) as MessageFields['meta'],
      createdAt: f.createdAt ?? r.createdAt,
    };
    const m = chatMessageOf(r.id, fields, {
      blobs: d.blobs,
      image: (id) => {
        const sha = atts.get(id);
        return sha ? d.blobs?.get(sha)?.toString('base64') : undefined;
      },
    });
    if (f.partial || r.partial) {
      m.meta = { ...m.meta, partial: true };
    }
    messages.push(m);
  }
  return { messages, keeps };
}

const ORIGINS = new Set(['cli', 'claude-code', 'codex']);

/** Rebuilds a conversation (its active branch, or `branchId`) as a Session; undefined when the index has no such chat. */
export async function materialize(d: MaterializeDeps, conversationId: string, o: { branchId?: string } = {}): Promise<Materialized | undefined> {
  const row = await d.index.conversation(conversationId);
  if (!row) {
    return undefined;
  }
  const branchId = o.branchId ?? row.activeBranchId ?? `br_${conversationId}`;
  const rows = await d.index.messages(conversationId, branchId);
  const { messages, keeps } = await messagesOf(d, rows);
  const byId = new Map(messages.map((m) => [m.meta!.id!, m]));
  const path = rows.map((r) => r.id);
  const view = viewOfPath(path, keeps).map((id) => byId.get(id)).filter((m): m is ChatMessage => !!m);
  const conv = (await states(d.index, [conversationId])).get(conversationId);
  const f = (conv?.fields ?? {}) as Partial<ConversationFields>;
  const versions = await d.index.query<{ id: string; version: string }>('conversationVersions', { ids: [conversationId] });
  const version = versions[0]?.version ?? conv?.version;
  const session: Session = {
    id: conversationId,
    title: row.title || 'New chat',
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    model: f.model ?? row.model ?? '',
    mode: (f.mode ?? row.mode ?? 'agent') as Session['mode'],
    ...(f.specialist ? { specialist: f.specialist as Session['specialist'] } : {}),
    ...(f.autoMode ? { autoMode: true } : {}),
    ...(f.plan ? { plan: f.plan } : {}),
    messageCount: view.length,
    ...(row.pinned ? { pinned: true } : {}),
    ...(f.group ? { group: f.group } : {}),
    ...(f.usage ? { usage: f.usage } : {}),
    ...(row.origin && ORIGINS.has(row.origin) ? { origin: row.origin as Session['origin'] } : {}),
    ...(row.parentId ? { parentId: row.parentId } : {}),
    ...(row.parentTitle ? { parentTitle: row.parentTitle } : {}),
    ...(f.think ? { think: f.think as Session['think'] } : {}),
    ...(f.folder ? { folder: f.folder } : {}),
    messages: view,
    contextTokens: 0,
    compactions: view.filter((m) => m.meta?.summary).length,
    attachments: [],
    ...(version ? { meta: { lastHlc: version } } : {}),
  };
  // CONTEXT (§8.1): the chat's working set, todos, attachments and breakdown come back from its latest snapshot.
  const snap = (await d.index.query<{ id: string; state?: string }>('contextSnapshots', { conversationId, limit: 1 }).catch(() => []))[0];
  if (snap?.state) {
    try {
      const f = (JSON.parse(snap.state) as { fields?: ContextSnapshot }).fields;
      if (f?.conversationId) {
        restoreInto(session, { ...f, id: snap.id, items: f.items ?? [], attachments: f.attachments ?? [], workingSet: f.workingSet ?? [] }, undefined);
      }
    } catch {
      // a damaged state row: the chat opens without it
    }
  }
  return { session, row, branchId, path, version };
}
