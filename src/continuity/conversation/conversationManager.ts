// ConversationManager (design §9.1, §10, §16.1): the conversation side of continuity. Lists, counts and searches
// conversations through the index (every project, archived and trashed ones too); sets flags and tags; trash, restore
// and purge; duplicate, continue from a message, branches and their switcher; version history and restore; merge;
// and remote changes (another device, the CLI) applied to this workspace's chats. Chats of this workspace live in the
// SessionStore (its JSON is the cache); others are materialised from the log when opened. Pure Node: no vscode.
import * as fs from 'fs';
import * as path from 'path';
import type { Session } from '../../types';
import type { SaveHint } from '../../sessions/sessionShape';
import type { SessionStore } from '../../sessions/sessionStore';
import type { BlobStore } from '../data/blobs';
import { Emitter, FileEventLog } from '../data/eventLog';
import type { IndexClient } from '../data/index/indexClient';
import type { BranchRow, ConversationRow, IndexHistoryPage, IndexHistoryQuery, NavCounts, SearchHit, SearchQuery, VersionRow } from '../data/index/queries';
import type { Retention } from '../data/retention';
import type { BranchFields } from '../events';
import { Hlc } from '../hlc';
import { newId } from '../ids';
import { ConversationExport, exportAs, ExportFormat, parseExport, sessionFromExport } from './export';
import { materialize, Materialized, messagesOf } from './materialize';
import { extractSummary, mergeSessions, MERGE_PROMPT, transcriptText } from './merge';
import type { ProjectResolver } from './projects';
import type { SessionBridge } from './sessionBridge';

export interface Siblings {
  /** 1-based position of this message among its siblings (same parent, same role), and how many there are. */
  index: number;
  total: number;
  ids: string[];
  /** The branch each sibling lives on (switching to it shows that sibling). */
  branches: string[];
}

export interface BranchInfo {
  conversationId: string;
  active: string;
  branches: (BranchRow & { messageCount?: number })[];
  /** Keyed by message id, for messages of the active path that have siblings. */
  siblings: Record<string, Siblings>;
}

export interface RemoteChange {
  id: string;
  /** Device id of the newest change (`this` = another window or the CLI on this machine). */
  device: string;
  local: boolean;
  /** `updated`: new messages / fields; `continued`: a device branch appeared (both continued the chat). */
  kind: 'updated' | 'continued';
  /** The chat was reloaded here (false: in use, the banner offers Reload). */
  applied: boolean;
}

export interface ManagerOptions {
  log: FileEventLog;
  index: IndexClient;
  blobs?: BlobStore;
  retention: Retention;
  store: SessionStore;
  bridge: SessionBridge;
  projects?: ProjectResolver;
  /** Data root (drafts live in `<root>/drafts`). */
  root: string;
  /** This process's project folder: chats of its project started or continued on another device are added to the store. */
  defaultFolder?: () => string | undefined;
  now?: () => number;
  /** Model-written summary for merge; absent = an extract. */
  summarize?: (prompt: string, text: string) => Promise<string>;
  warn?: (m: string) => void;
}

const DAY = 86_400_000;

export class ConversationManager {
  private readonly now: () => number;
  private readonly remote = new Emitter<RemoteChange>();
  /** Remote changes to chats that were in use: applied when `reloadIfIdle` is called (after the run). */
  private readonly waiting = new Map<string, RemoteChange>();
  readonly onRemoteChange = this.remote.event;
  summarize?: (prompt: string, text: string) => Promise<string>;
  private sub?: { dispose(): void };

  constructor(private readonly o: ManagerOptions) {
    this.now = o.now ?? Date.now;
    this.summarize = o.summarize;
    this.sub = o.index.onApplied((n) => {
      if (n.remoteConversations.length) {
        void this.applyRemote(n.remoteConversations).catch((e) => o.warn?.(`continuity: remote update: ${String(e)}`));
      }
    });
  }

  dispose(): void {
    this.sub?.dispose();
    this.remote.dispose();
  }

  private get index(): IndexClient {
    return this.o.index;
  }

  /** Own events reach the index before the next read. */
  async sync(): Promise<void> {
    await this.o.log.flush();
    await this.index.catchUp().catch(() => 0);
  }

  // ---------------------------------------------------------------------------------------------- lists

  list(q: IndexHistoryQuery): Promise<IndexHistoryPage> {
    return this.index.history(q);
  }

  counts(projectId?: string): Promise<NavCounts> {
    return this.index.counts(projectId);
  }

  search(q: SearchQuery | string): Promise<SearchHit[]> {
    return this.index.search(q);
  }

  conversation(id: string): Promise<ConversationRow | undefined> {
    return this.index.conversation(id);
  }

  // ---------------------------------------------------------------------------------------------- flags

  async setFlags(ids: string[], f: { pinned?: boolean; favorite?: boolean; archived?: boolean }): Promise<void> {
    for (const id of ids) {
      const live = this.o.store.has(id) ? this.o.store.get(id) : undefined;
      if (f.pinned !== undefined && live) {
        // Pin is the chat's own field: through the store so the tab bar and the JSON agree.
        if (!!live.pinned !== f.pinned) {
          this.o.store.togglePin(id);
        }
      }
      const patch: Record<string, unknown> = {};
      if (f.pinned !== undefined && !live) {
        patch.pinned = f.pinned;
      }
      if (f.favorite !== undefined) {
        patch.favorite = f.favorite;
      }
      if (f.archived !== undefined) {
        patch.archived = f.archived;
      }
      if (Object.keys(patch).length) {
        this.o.log.append('conversation', id, 'patch', patch, { durable: true });
      }
    }
    await this.sync();
  }

  async setTags(ids: string[], add: string[] = [], remove: string[] = []): Promise<void> {
    const norm = (t: string) => t.trim().replace(/\s+/g, '-').toLowerCase().slice(0, 40);
    const tags: Record<string, boolean> = {};
    for (const t of add.map(norm).filter(Boolean)) {
      tags[t] = true;
    }
    for (const t of remove.map(norm).filter(Boolean)) {
      tags[t] = false;
    }
    if (!Object.keys(tags).length) {
      return;
    }
    for (const id of ids) {
      this.o.log.append('conversation', id, 'patch', { tags }, { durable: true });
    }
    await this.sync();
  }

  async rename(id: string, title: string): Promise<void> {
    const t = title.trim().slice(0, 120);
    if (!t) {
      return;
    }
    if (this.o.store.has(id)) {
      this.o.store.rename(id, t);
    } else {
      this.o.log.append('conversation', id, 'patch', { title: t }, { durable: true });
    }
    await this.sync();
  }

  // ---------------------------------------------------------------------------------------------- trash

  /**
   * Moves conversations to Trash. Chats of this workspace go through the store's delete (the caller stops their
   * runs first); others are trashed in the log directly.
   */
  async trash(ids: string[]): Promise<number> {
    let n = 0;
    for (const id of ids) {
      if (this.o.store.has(id)) {
        await this.o.store.delete(id);
      } else {
        this.o.log.append('conversation', id, 'trash', { at: this.now(), reason: 'user' }, { durable: true });
      }
      n++;
    }
    await this.sync();
    return n;
  }

  /** Back from Trash; a chat of this workspace (or any, with `open`) returns to the store. */
  async restore(ids: string[], o: { into?: (row: ConversationRow) => boolean } = {}): Promise<number> {
    let n = 0;
    for (const id of ids) {
      this.o.log.append('conversation', id, 'restore', { at: this.now() }, { durable: true });
      n++;
    }
    await this.sync();
    for (const id of ids) {
      const row = await this.index.conversation(id);
      if (row && (o.into?.(row) ?? true)) {
        await this.load(id);
      }
    }
    return n;
  }

  /** Deletes permanently: the purge event, then files (JSON cache, transcript archive, traces, checkpoints, drafts). */
  async purge(ids: string[]): Promise<number> {
    const n = await this.o.retention.purge(ids.map((id) => ({ ent: 'conversation' as const, id })), 'user');
    return n;
  }

  /** File cleanup for a purged conversation (registered as a retention purge hook). */
  async cleanupPurged(id: string): Promise<void> {
    this.o.bridge.forget(id);
    await this.o.store.purge(id);
    fs.rmSync(path.join(this.o.root, 'drafts', `${id}.json`), { force: true });
  }

  // ---------------------------------------------------------------------------------------------- open

  /**
   * Puts a conversation from the log into this workspace's store (another project, archived away by retention,
   * restored from Trash, a remote update). Returns the session, or undefined when the index has no such chat.
   */
  async load(id: string, o: { branchId?: string } = {}): Promise<Session | undefined> {
    const m = await materialize({ index: this.index, log: this.o.log, blobs: this.o.blobs }, id, o);
    if (!m) {
      return undefined;
    }
    if (m.row.trashedAt) {
      return undefined;
    }
    const live = this.o.store.has(id) ? this.o.store.get(id) : undefined;
    if (live && !this.o.store.importRemote(m.session)) {
      // In use: switch the live object in place (the bridge is told so it does not see a new branch).
      await this.o.bridge.reset(id, m.branchId);
      live.messages = m.session.messages;
      live.title = m.session.title;
      live.meta = { ...live.meta, lastHlc: m.version };
      this.o.bridge.accept(live);
      this.o.store.save(live, true);
      return live;
    }
    if (!live && !this.o.store.importRemote(m.session)) {
      return undefined;
    }
    await this.o.bridge.reset(id, m.branchId);
    const s = this.o.store.get(id) ?? m.session;
    this.o.bridge.accept(s);
    return s;
  }

  materialize(id: string, branchId?: string): Promise<Materialized | undefined> {
    return materialize({ index: this.index, log: this.o.log, blobs: this.o.blobs }, id, { branchId });
  }

  // ---------------------------------------------------------------------------------------------- copies

  /** A new conversation with copies of the messages (up to and including `uptoMessageId`). */
  async duplicate(id: string, uptoMessageId?: string): Promise<Session | undefined> {
    const src = this.o.store.has(id) ? this.o.store.get(id) : (await this.materialize(id))?.session;
    if (!src) {
      return undefined;
    }
    const upto = uptoMessageId ? src.messages.findIndex((m) => m.meta?.id === uptoMessageId) : -1;
    const s = this.o.store.create(src.model, src.mode);
    s.title = `${src.title} (copy)`.slice(0, 120);
    s.parentId = src.id;
    s.parentTitle = src.title;
    s.messages = structuredClone(upto >= 0 ? src.messages.slice(0, upto + 1) : src.messages).map((m) => ({ ...m, meta: { ...m.meta, id: undefined, ...(m.meta?.id ? { copiedFrom: m.meta.id } : {}) } }));
    s.think = src.think;
    s.folder = src.folder;
    s.attachments = [...(src.attachments ?? [])];
    this.o.store.save(s, true);
    if (uptoMessageId) {
      this.o.log.append('conversation', s.id, 'patch', { parentMessageId: uptoMessageId });
    }
    return s;
  }

  /** Continue from a message: a branch inside the conversation whose head is that message; the chat switches to it. */
  async continueFrom(id: string, messageId: string, reason: BranchFields['reason'] = 'continue'): Promise<Session | undefined> {
    const branch = newId('br', this.now());
    this.o.log.append('branch', branch, 'create', { conversationId: id, forkedFromMessageId: messageId, headId: messageId, reason, label: reason === 'restore-version' ? 'Restored version' : undefined, createdAt: this.now() } satisfies BranchFields, { durable: true });
    this.o.log.append('conversation', id, 'patch', { activeBranchId: branch }, { durable: true });
    await this.sync();
    return this.load(id, { branchId: branch });
  }

  async switchBranch(id: string, branchId: string): Promise<Session | undefined> {
    this.o.log.append('conversation', id, 'patch', { activeBranchId: branchId }, { durable: true });
    await this.sync();
    return this.load(id, { branchId });
  }

  async renameBranch(branchId: string, label: string): Promise<void> {
    this.o.log.append('branch', branchId, 'patch', { label: label.trim().slice(0, 80) });
    await this.sync();
  }

  /** Branches of a conversation and, for the active path, which messages have siblings (the `< n/m >` switcher). */
  async branches(id: string): Promise<BranchInfo> {
    const row = await this.index.conversation(id);
    const active = this.o.bridge.activeBranch(id) ?? row?.activeBranchId ?? `br_${id}`;
    const branches = await this.index.branches(id);
    const children = await this.index.query<{ id: string; parent_id: string; branch_id: string; role: string; hlc: string }>('children', { conversationId: id });
    const path = new Set((await this.index.messages(id, active)).map((m) => m.id));
    const byParent = new Map<string, typeof children>();
    for (const c of children) {
      const list = byParent.get(c.parent_id) ?? [];
      list.push(c);
      byParent.set(c.parent_id, list);
    }
    const siblings: Record<string, Siblings> = {};
    for (const list of byParent.values()) {
      const onPath = list.find((c) => path.has(c.id));
      if (!onPath) {
        continue;
      }
      const same = list.filter((c) => c.role === onPath.role);
      if (same.length > 1) {
        siblings[onPath.id] = { index: same.findIndex((c) => c.id === onPath.id) + 1, total: same.length, ids: same.map((c) => c.id), branches: same.map((c) => c.branch_id) };
      }
    }
    return { conversationId: id, active, branches, siblings };
  }

  /** The other sibling `delta` steps away (wrapping): switches to its branch. */
  async stepSibling(id: string, messageId: string, delta: number): Promise<Session | undefined> {
    const info = await this.branches(id);
    const sib = info.siblings[messageId];
    if (!sib) {
      return undefined;
    }
    const i = (sib.index - 1 + delta + sib.total) % sib.total;
    // The newest branch whose path goes through that sibling: its own branch, or a later one forked below it.
    return this.switchBranch(id, await this.branchThrough(id, sib.ids[i], sib.branches[i]));
  }

  private async branchThrough(id: string, messageId: string, own: string): Promise<string> {
    const branches = await this.index.branches(id);
    for (const b of [...branches].reverse()) {
      if (b.id === own) {
        return own;
      }
      const path = await this.index.messages(id, b.id);
      if (path.some((m) => m.id === messageId)) {
        return b.id;
      }
    }
    return own;
  }

  /** Assistant answers to the same request (siblings), with their text, for Compare. */
  async compare(id: string, messageId: string): Promise<{ id: string; model?: string; text: string; createdAt: number; current: boolean }[]> {
    const rows = await this.index.query<{ id: string; parent_id: string; branch_id: string; role: string; hlc: string; created_at: number; model: string | null }>('children', { conversationId: id });
    const me = rows.find((r) => r.id === messageId);
    const sibs = me ? rows.filter((r) => r.parent_id === me.parent_id && r.role === me.role) : [];
    if (sibs.length < 2) {
      return [];
    }
    const full = (await this.index.messages(id, me!.branch_id)).filter((r) => r.id === messageId);
    const others: typeof full = [];
    for (const s of sibs) {
      if (s.id === messageId) {
        continue;
      }
      const p = await this.index.messages(id, s.branch_id);
      const hit = p.find((r) => r.id === s.id);
      if (hit) {
        others.push(hit);
      }
    }
    const { messages } = await messagesOf({ index: this.index, log: this.o.log, blobs: this.o.blobs }, [...full, ...others]);
    return messages.map((m, i) => ({ id: m.meta!.id!, model: m.meta?.model, text: m.content, createdAt: [...full, ...others][i].createdAt, current: m.meta!.id === messageId }));
  }

  // ---------------------------------------------------------------------------------------------- versions

  async versions(id: string): Promise<{ versions: VersionRow[]; branches: BranchRow[] }> {
    return { versions: await this.index.versions('conversation', id), branches: await this.index.branches(id) };
  }

  /**
   * Restores a conversation as it was at a version: the title, flags and tags of that moment (a patch: the history
   * keeps the current values too) and, when the active branch differed, back to that branch. Never rewrites.
   */
  async restoreVersion(id: string, hlc: string): Promise<Session | undefined> {
    const rows = [...(await this.index.versions('conversation', id))].sort((a, b) => Hlc.compare(a.hlc, b.hlc));
    const at: Record<string, unknown> = {};
    for (const r of rows) {
      if (Hlc.compare(r.hlc, hlc) > 0) {
        break;
      }
      if (r.op === 'trash') {
        at.trashed = true;
      } else if (r.op === 'restore') {
        at.trashed = false;
      }
      for (const [k, v] of Object.entries(r.fields ?? {})) {
        if (k === 'tags' && v && typeof v === 'object') {
          at.tags = { ...(at.tags as Record<string, boolean> | undefined), ...(v as Record<string, boolean>) };
        } else {
          at[k] = v;
        }
      }
    }
    if (!rows.some((r) => r.hlc === hlc)) {
      throw new Error('That version is no longer in the history.');
    }
    const cur = await this.index.conversation(id);
    const patch: Record<string, unknown> = {};
    for (const k of ['title', 'pinned', 'favorite', 'archived'] as const) {
      if (k in at && at[k] !== (cur as unknown as Record<string, unknown> | undefined)?.[k]) {
        patch[k] = at[k];
      }
    }
    if (at.tags) {
      const want = at.tags as Record<string, boolean>;
      const tags: Record<string, boolean> = {};
      for (const t of new Set([...Object.keys(want), ...(cur?.tags ?? [])])) {
        if (!!want[t] !== (cur?.tags ?? []).includes(t)) {
          tags[t] = !!want[t];
        }
      }
      if (Object.keys(tags).length) {
        patch.tags = tags;
      }
    }
    if (Object.keys(patch).length) {
      this.o.log.append('conversation', id, 'patch', patch, { durable: true });
    }
    if (cur?.trashedAt && at.trashed === false) {
      this.o.log.append('conversation', id, 'restore', { at: this.now() }, { durable: true });
    }
    const branch = typeof at.activeBranchId === 'string' ? at.activeBranchId : undefined;
    await this.sync();
    if (branch && branch !== cur?.activeBranchId) {
      return this.switchBranch(id, branch);
    }
    if (this.o.store.has(id) && patch.title) {
      this.o.store.rename(id, String(patch.title));
    }
    return this.o.store.has(id) ? this.o.store.get(id) : undefined;
  }

  // ---------------------------------------------------------------------------------------------- merge

  /** A new conversation: A's messages, then a summary of B (model-written when possible), `mergedFrom: [a, b]`. */
  async merge(a: string, b: string): Promise<Session | undefined> {
    const sa = this.o.store.has(a) ? this.o.store.get(a) : (await this.materialize(a))?.session;
    const sb = this.o.store.has(b) ? this.o.store.get(b) : (await this.materialize(b))?.session;
    if (!sa || !sb) {
      return undefined;
    }
    let summary = '';
    if (this.summarize) {
      summary = await this.summarize(MERGE_PROMPT, transcriptText(sb)).catch((e) => {
        this.o.warn?.(`continuity: merge summary: ${String(e)}`);
        return '';
      });
    }
    const merged = mergeSessions(sa, sb, summary.trim() || extractSummary(sb), { now: this.now() });
    const s = this.o.store.create(merged.model, merged.mode);
    const { mergedFrom, ...rest } = merged;
    Object.assign(s, rest, { id: s.id });
    this.o.store.save(s, true);
    // The bridge logs the chat on its first save; the merge link goes on the conversation.
    await this.o.store.flush(s);
    await this.o.bridge.settle();
    this.o.log.append('conversation', s.id, 'patch', { mergedFrom }, { durable: true });
    await this.sync();
    return s;
  }

  // ---------------------------------------------------------------------------------------------- export / import

  async exportText(id: string, format: ExportFormat): Promise<{ title: string; text: string; ext: string } | undefined> {
    const m = await this.materialize(id);
    const live = this.o.store.has(id) ? this.o.store.get(id) : undefined;
    const s = live ?? m?.session;
    if (!s) {
      return undefined;
    }
    let branches: (BranchRow & { messages: Session['messages'] })[] = [];
    if (format === 'json' && m) {
      for (const b of await this.index.branches(id)) {
        if (b.id === m.branchId) {
          continue;
        }
        const rows = await this.index.messages(id, b.id);
        const from = b.forkedFromMessageId ? rows.findIndex((r) => r.id === b.forkedFromMessageId) + 1 : 0;
        const { messages } = await messagesOf({ index: this.index, log: this.o.log, blobs: this.o.blobs }, rows.slice(from));
        branches.push({ ...b, messages });
      }
      branches = branches.filter((b) => b.messages.length);
    }
    const out = exportAs(format, s, { row: m?.row, branches });
    return { title: s.title, ...out };
  }

  /** Imports a JSON export (or a share): a new chat in this workspace, logged through the store. */
  importDoc(doc: ConversationExport, origin?: Session['origin'] | 'share'): Session {
    const s = sessionFromExport(doc, { exists: (id) => this.o.store.has(id), newId: () => `${this.o.store.idPrefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, origin: origin === 'share' ? undefined : origin });
    this.o.store.importRemote(s);
    // importRemote does not log: save once so the bridge records it as a new conversation.
    const live = this.o.store.get(s.id)!;
    this.o.store.save(live, true);
    if (origin === 'share' || doc.conversation) {
      void this.o.store.flush(live).then(async () => {
        await this.o.bridge.settle();
        const patch: Record<string, unknown> = {};
        if (origin === 'share') {
          patch.origin = 'share';
        }
        if (doc.conversation?.favorite) {
          patch.favorite = true;
        }
        if (doc.conversation?.tags?.length) {
          patch.tags = Object.fromEntries(doc.conversation.tags.map((t) => [t, true]));
        }
        if (Object.keys(patch).length) {
          this.o.log.append('conversation', live.id, 'patch', patch, { durable: true });
        }
      });
    }
    return live;
  }

  importText(text: string, origin?: Session['origin'] | 'share'): Session {
    return this.importDoc(parseExport(text), origin);
  }

  // ---------------------------------------------------------------------------------------------- remote changes

  /** Applies changes made elsewhere to this workspace's chats; in-use ones wait (banner) until `reloadIfIdle`. */
  async applyRemote(ids: string[]): Promise<void> {
    const me = this.o.log.device.deviceId;
    let mine: string | undefined | null = null;
    for (const id of ids) {
      if (!this.o.store.has(id)) {
        // A chat of this project from another device: added so it can be listed and continued here.
        mine = mine === null ? await this.currentProject() : mine;
        const row = mine ? await this.index.conversation(id) : undefined;
        if (row && this.adoptable(row, mine, me) && (await this.load(id))) {
          this.remote.fire({ id, device: row.lastDevice ?? '', local: false, kind: 'updated', applied: true });
        }
        continue;
      }
      const live = this.o.store.get(id);
      const row = await this.index.conversation(id);
      if (!live) {
        continue;
      }
      // Deleted for good on another device: its files go here too (a chat not indexed yet has no row either, so only
      // an explicit purge counts).
      if (!row) {
        const [gone] = await this.index.query<{ id: string }>('purgedConversations', { ids: [id] });
        if (gone && !this.o.store.inUse(id)) {
          await this.cleanupPurged(id);
          this.remote.fire({ id, device: '', local: false, kind: 'updated', applied: true });
        }
        continue;
      }
      // Moved to Trash or archived on another device: it leaves this chat list, as it would after doing it here.
      if (row.trashedAt || row.archived) {
        if (await this.o.store.dropRemote(id)) {
          this.remote.fire({ id, device: row.lastDevice ?? '', local: false, kind: 'updated', applied: true });
        }
        continue;
      }
      const [v] = await this.index.query<{ version: string }>('conversationVersions', { ids: [id] });
      if (!v?.version || (live.meta?.lastHlc && Hlc.compare(v.version, live.meta.lastHlc) <= 0)) {
        continue;
      }
      const device = Hlc.device(v.version);
      const branches = await this.index.branches(id);
      const continued = branches.some((b) => b.reason === 'device-split' && b.createdAt > this.now() - DAY);
      const change: RemoteChange = { id, device, local: device === me, kind: continued ? 'continued' : 'updated', applied: false };
      if (this.o.store.inUse(id)) {
        this.waiting.set(id, change);
      } else {
        change.applied = !!(await this.load(id));
      }
      this.remote.fire(change);
    }
  }

  /** After a run ends: applies a remote change that waited for the chat to be idle. */
  async reloadIfIdle(id: string, force = false): Promise<boolean> {
    const w = this.waiting.get(id);
    if (!w || (!force && this.o.store.inUse(id))) {
      return false;
    }
    this.waiting.delete(id);
    const s = await this.load(id);
    this.remote.fire({ ...w, applied: !!s });
    return !!s;
  }

  /** Startup check: chats whose log is newer than their JSON (changed while this window was closed). */
  async refreshStale(): Promise<number> {
    const ids = this.o.store.list().map((r) => r.id);
    if (!ids.length) {
      return 0;
    }
    const versions = new Map((await this.index.query<{ id: string; version: string }>('conversationVersions', { ids })).map((r) => [r.id, r.version]));
    // Newer in the log than here, or gone from the index (purged elsewhere, or only not indexed yet: applyRemote
    // tells the two apart). Trash and archive on another device show up as a newer version.
    const stale = ids.filter((id) => {
      const v = versions.get(id);
      const at = this.o.store.peek(id)?.meta?.lastHlc;
      return !v || (!!at && Hlc.compare(v, at) > 0);
    });
    await this.applyRemote(stale);
    return stale.length;
  }

  /** The project of this process's folder (undefined without a folder or a project resolver). */
  private async currentProject(): Promise<string | undefined> {
    const f = this.o.defaultFolder?.();
    return f && this.o.projects ? (await this.o.projects.resolve(f).catch(() => undefined))?.id : undefined;
  }

  /** A chat of this project last written by another device, live (not archived or in Trash), not in the store yet. */
  private adoptable(r: ConversationRow, project: string | undefined, me: string): boolean {
    return !!project && r.projectId === project && !!r.lastDevice && r.lastDevice !== me && !r.trashedAt && !r.archived && !this.o.store.has(r.id);
  }

  /**
   * Chats of this project that another device started or continued and this store does not have yet (after a sync, a
   * restored backup, or a CLI session in another window): materialised into the store so the chat list and
   * `localpilot -c/-r` show them and they can be continued here. Returns how many were added.
   */
  async adoptRemote(): Promise<number> {
    const project = await this.currentProject();
    if (!project) {
      return 0;
    }
    const me = this.o.log.device.deviceId;
    let n = 0;
    for (let offset = 0; ; ) {
      const page = await this.index.history({ projectId: project, offset, limit: 200 });
      for (const r of page.rows) {
        if (this.adoptable(r, project, me) && (await this.load(r.id))) {
          n++;
        }
      }
      offset += page.rows.length;
      if (!page.rows.length || offset >= page.total) {
        return n;
      }
    }
  }

  /** The hint for the next save (the bridge reads it): why history changes. */
  hint(id: string, reason: SaveHint): void {
    this.o.store.hint(id, reason);
  }
}
