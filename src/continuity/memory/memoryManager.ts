// MemoryManager (design §7, §16.2): every memory type through one API — the Memory manager page, the agent's memory
// tools (as MemoryStore's `typed`), the CLI `memory` command. Project and developer notes are files first (writes go
// through MemoryStore so its caps apply and the MemoryBridge logs them); conversation, task, knowledge and agent items
// live in the log only. Pure Node: no vscode.
import type { FileEventLog } from '../data/eventLog';
import { Emitter } from '../data/eventLog';
import type { IndexClient } from '../data/index/indexClient';
import type { MemoryRow, SearchHit, VersionRow } from '../data/index/queries';
import type { Retention } from '../data/retention';
import type { MemoryItemFields, MemoryType } from '../events';
import { memoryItemId } from '../conversation/payloads';
import type { MemoryBridge } from './memoryBridge';
import { AGENT_MAX, checkScope, DEFAULT_TASK_EXPIRY_DAYS, fileScope, isExpired, normalizeType, promptRule, safeNoteName, scopeKey, ScopeRefs, summaryOf, taskExpiry, taskRefOf, TYPE_INFO } from './memoryTypes';
import type { TypedMemory, TypedMemoryItem } from '../../agent/memory';

/** The note files (MemoryStore): writes there keep the 1.6 caps and reach the bridge through `onChange`. */
export interface NoteFiles {
  write(name: string, body: string, scope: 'project' | 'global', mode?: 'replace' | 'append', source?: 'user' | 'agent' | 'auto'): Promise<{ path: string; unchanged?: boolean }>;
  delete(name: string, scope: 'project' | 'global'): Promise<boolean>;
  read(name: string, scope: 'project' | 'global'): Promise<string | undefined>;
  /** The folder of a scope on this machine (undefined: no project folder open). */
  folder(scope: 'project' | 'global'): string | undefined;
}

export interface MemoryItem extends MemoryRow {
  /** The note file on this machine (project notes of this project, developer notes). */
  path?: string;
  expired?: boolean;
}

export interface MemoryCreate {
  name: string;
  body: string;
  projectId?: string;
  conversationId?: string;
  taskRef?: string;
  localOnly?: boolean;
  pinned?: boolean;
  expiresAt?: number;
  source?: MemoryItemFields['source'];
  mode?: 'replace' | 'append';
}

export interface MemoryVersion {
  hlc: string;
  at: number;
  device: string;
  op: string;
  /** Body as of this version (fields only: absent when the event did not set it). */
  body?: string;
  changes: string[];
}

export interface MemoryManagerOptions {
  log: FileEventLog;
  index: IndexClient;
  bridge: MemoryBridge;
  retention: Retention;
  /** MemoryStore (absent in tests that only use log-only types). */
  files?: NoteFiles;
  /** This process's project (its first folder). */
  project: () => Promise<string | undefined>;
  /** `localpilot.memory.taskExpiryDays`. */
  taskExpiryDays?: () => number;
  /** Writes the conversation `summary` field (conversation memory). */
  now?: () => number;
  warn?: (m: string) => void;
}

const DAY = 86_400_000;
const NAME_MAX = 80;

function cleanName(name: string): string {
  return name.replace(/\s+/g, ' ').trim().slice(0, NAME_MAX);
}

function appendBody(existing: string, addition: string): string {
  const a = addition.trim();
  if (!existing.trim()) {
    return `${a}\n`;
  }
  const have = new Set(existing.split('\n').map((l) => l.trim().toLowerCase()).filter((l) => l.length >= 8));
  const fresh = a.split('\n').filter((l) => l.trim().length < 8 || !have.has(l.trim().toLowerCase()));
  return fresh.join('\n').trim() ? `${existing.trimEnd()}\n\n${fresh.join('\n').trim()}\n` : existing;
}

export class MemoryManager {
  private readonly now: () => number;
  private readonly remote = new Emitter<string[]>();
  /** Items changed by other processes or devices (after the bridge wrote file-backed notes back). */
  readonly onRemoteChange = this.remote.event;
  private readonly local = new Emitter<string[]>();
  /** Any change (this process included): the Memory manager page refreshes. */
  readonly onDidChange = this.local.event;
  /** Plans / todo lists each chat works on (task memory). */
  private readonly tasks = new Map<string, string>();
  private readonly subs: { dispose(): unknown }[] = [];
  private timer?: NodeJS.Timeout;

  constructor(private readonly o: MemoryManagerOptions) {
    this.now = o.now ?? Date.now;
    this.subs.push(
      o.index.onApplied((n) => {
        if (n.remoteMemory.length) {
          void o.bridge
            .applyRemote(n.remoteMemory)
            .catch(() => undefined)
            .then(() => {
              this.remote.fire(n.remoteMemory);
              this.local.fire(n.remoteMemory);
            });
        }
      }),
      o.bridge.onDidChange((ids) => this.local.fire(ids))
    );
  }

  /** Expired task items go to Trash now and every 24 h. */
  start(): void {
    void this.expireTasks().catch(() => 0);
    this.timer = setInterval(() => void this.expireTasks().catch(() => 0), DAY);
    this.timer.unref?.();
  }

  dispose(): void {
    clearInterval(this.timer);
    this.subs.forEach((d) => d.dispose());
    this.remote.dispose();
    this.local.dispose();
  }

  private get index(): IndexClient {
    return this.o.index;
  }

  /** Brings the index up to date with this process's events. */
  async sync(): Promise<void> {
    await this.o.bridge.settle();
    await this.o.log.flush();
    await this.index.catchUp().catch(() => 0);
  }

  private notePath(row: Pick<MemoryRow, 'type' | 'name' | 'file' | 'projectId'>, currentProject?: string): string | undefined {
    const scope = fileScope(row.type as MemoryType);
    if (!scope || !this.o.files) {
      return undefined;
    }
    if (scope === 'project' && row.projectId !== currentProject) {
      return undefined;
    }
    const dir = this.o.files.folder(scope);
    return dir ? `${dir.replace(/[\\/]+$/, '')}${dir.includes('\\') ? '\\' : '/'}${row.file || `${safeNoteName(row.name)}.md`}` : undefined;
  }

  private decorate(rows: MemoryRow[], project?: string): MemoryItem[] {
    const now = this.now();
    return rows.map((r) => ({ ...r, ...(this.notePath(r, project) ? { path: this.notePath(r, project) } : {}), ...(isExpired(r, now) ? { expired: true } : {}) }));
  }

  // ---------------------------------------------------------------------------------------------- read

  /**
   * Items for the Memory manager / CLI: this project's and the user's (or every project's with `projectId: 'all'`).
   * Conversation items of chats in other projects are included only with 'all'.
   */
  async list(q: { type?: string; projectId?: string | 'all'; conversationId?: string; text?: string; trash?: boolean; limit?: number } = {}): Promise<MemoryItem[]> {
    const current = await this.o.project().catch(() => undefined);
    const projectId = q.projectId === 'all' ? undefined : q.projectId ?? current;
    const type = q.type ? normalizeType(q.type) ?? q.type : undefined;
    const rows = await this.index.memory({ type, projectId, conversationId: q.conversationId, text: q.text, trashedOnly: q.trash, limit: q.limit ?? 500 });
    return this.decorate(rows, current);
  }

  async counts(projectId?: string | 'all'): Promise<Record<MemoryType, number>> {
    const rows = await this.list({ projectId, limit: 2000 });
    const out = Object.fromEntries(Object.keys(TYPE_INFO).map((k) => [k, 0])) as Record<MemoryType, number>;
    for (const r of rows) {
      if (r.type in out) {
        out[r.type as MemoryType]++;
      }
    }
    return out;
  }

  /** An item by id, or by name (and type) in this project / the user's scope. */
  async get(ref: string, o: { type?: string; includeTrash?: boolean; conversationId?: string } = {}): Promise<MemoryItem | undefined> {
    const current = await this.o.project().catch(() => undefined);
    const byId = ref.startsWith('mem_') ? await this.index.memory({ id: ref, includeTrash: o.includeTrash ?? true, limit: 1 }) : [];
    if (byId.length) {
      return this.decorate(byId, current)[0];
    }
    const type = o.type ? normalizeType(o.type) : undefined;
    const rows = await this.index.memory({ name: ref, type, projectId: current, includeTrash: o.includeTrash, limit: 20 });
    const fit = rows.filter((r) => r.type !== 'conversation' || !o.conversationId || r.conversationId === o.conversationId);
    // Most specific first: this chat, this project, then the user's.
    fit.sort((a, b) => Number(b.conversationId === o.conversationId) - Number(a.conversationId === o.conversationId) || Number(!!b.projectId) - Number(!!a.projectId) || (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
    if (fit.length) {
      return this.decorate(fit, current)[0];
    }
    const prefix = ref.length >= 6 ? (await this.index.memory({ includeTrash: true, limit: 2000 })).filter((r) => r.id.startsWith(ref)) : [];
    return prefix.length === 1 ? this.decorate(prefix, current)[0] : undefined;
  }

  search(text: string, o: { projectId?: string | 'all'; limit?: number } = {}): Promise<SearchHit[]> {
    return (async () => this.index.searchMemory(text, { projectId: o.projectId === 'all' ? undefined : o.projectId ?? (await this.o.project().catch(() => undefined)), limit: o.limit ?? 30 }))();
  }

  // ---------------------------------------------------------------------------------------------- write

  /**
   * Creates (or, for an existing name in the same scope, replaces / appends to) an item. Project and developer notes
   * are written to their files (the bridge logs them); the others go to the log. Returns the item id.
   */
  async create(typeIn: string, f: MemoryCreate): Promise<string> {
    const type = normalizeType(typeIn);
    if (!type) {
      throw new Error(`Unknown memory type "${typeIn}" (conversation, project, developer, task, knowledge, agent).`);
    }
    const name = TYPE_INFO[type].fileBacked ? safeNoteName(f.name) : cleanName(f.name);
    if (!name || !f.body.trim()) {
      throw new Error('A memory item needs a name and some text.');
    }
    const projectId = type === 'project' ? f.projectId ?? (await this.o.project()) : f.projectId;
    const refs: ScopeRefs = { projectId, conversationId: f.conversationId, taskRef: f.taskRef };
    checkScope(type, refs);
    const id = memoryItemId(type, scopeKey(type, refs), name);
    const scope = fileScope(type);
    if (scope) {
      if (!this.o.files) {
        throw new Error('Note files are not available here.');
      }
      if (type === 'project' && projectId !== (await this.o.project())) {
        throw new Error('Project notes of another project are edited in that project.');
      }
      await this.o.files.write(name, f.body, scope, f.mode ?? 'replace', f.source === 'auto' ? 'auto' : f.source === 'agent' ? 'agent' : 'user');
      await this.sync();
      const flags = { ...(f.localOnly !== undefined ? { localOnly: f.localOnly } : {}), ...(f.pinned !== undefined ? { pinned: f.pinned } : {}) };
      if (Object.keys(flags).length) {
        this.o.log.append('memory', id, 'patch', flags, { durable: true });
        await this.sync();
      }
      this.local.fire([id]);
      return id;
    }
    const existing = (await this.index.memory({ id, includeTrash: true, limit: 1 }))[0];
    const body = f.mode === 'append' && existing && !existing.trashedAt ? appendBody(existing.body, f.body) : `${f.body.trim()}\n`;
    if (existing?.trashedAt) {
      this.o.log.append('memory', id, 'restore', { at: this.now() }, { durable: true });
    }
    if (existing) {
      if (existing.body !== body || existing.trashedAt) {
        this.o.log.append('memory', id, 'patch', { body, summary: summaryOf(body), ...(f.expiresAt !== undefined ? { expiresAt: f.expiresAt } : {}), source: f.source ?? 'user' }, { durable: true });
      }
    } else {
      const fields: MemoryItemFields = {
        type,
        name,
        body,
        summary: summaryOf(body),
        ...(projectId ? { projectId } : {}),
        ...(f.conversationId ? { conversationId: f.conversationId } : {}),
        ...(f.taskRef ? { taskRef: f.taskRef } : {}),
        source: f.source ?? 'user',
        ...(f.localOnly ? { localOnly: true } : {}),
        ...(f.pinned ? { pinned: true } : {}),
        ...(f.expiresAt ? { expiresAt: f.expiresAt } : {}),
        tags: {},
        createdAt: this.now(),
      };
      this.o.log.append('memory', id, 'create', fields, { durable: true });
    }
    await this.sync();
    if (type === 'agent') {
      await this.capAgent();
    }
    this.local.fire([id]);
    return id;
  }

  /** At most AGENT_MAX agent items: the least recently updated (unpinned) go to Trash. */
  private async capAgent(): Promise<number> {
    const rows = await this.index.memory({ type: 'agent', limit: 2000 });
    if (rows.length <= AGENT_MAX) {
      return 0;
    }
    const drop = rows.filter((r) => !r.pinned).sort((a, b) => (a.updatedAt ?? 0) - (b.updatedAt ?? 0)).slice(0, rows.length - AGENT_MAX);
    for (const r of drop) {
      this.o.log.append('memory', r.id, 'trash', { at: this.now(), reason: 'cap' }, { durable: true });
    }
    await this.sync();
    return drop.length;
  }

  private async need(id: string): Promise<MemoryItem> {
    const it = await this.get(id);
    if (!it) {
      throw new Error(`No memory item "${id}".`);
    }
    return it;
  }

  /** Changes body, name (log-only types), flags or expiry. A note file of this machine is rewritten (and logged). */
  async update(id: string, f: { body?: string; name?: string; localOnly?: boolean; pinned?: boolean; expiresAt?: number | null; tags?: Record<string, boolean> }): Promise<void> {
    const it = await this.need(id);
    const scope = fileScope(it.type as MemoryType);
    const patch: Record<string, unknown> = {};
    if (f.body !== undefined && f.body.replace(/\r\n?/g, '\n').trim() !== it.body.replace(/\r\n?/g, '\n').trim()) {
      if (scope && it.path && this.o.files) {
        await this.o.files.write(path0(it), f.body, scope, 'replace', 'user');
      } else {
        const body = `${f.body.trim()}\n`;
        Object.assign(patch, { body, summary: summaryOf(body), source: 'user' });
      }
    }
    if (f.name !== undefined && !scope && cleanName(f.name) && cleanName(f.name) !== it.name) {
      patch.name = cleanName(f.name);
    }
    if (f.localOnly !== undefined && f.localOnly !== it.localOnly) {
      patch.localOnly = f.localOnly;
    }
    if (f.pinned !== undefined && f.pinned !== it.pinned) {
      patch.pinned = f.pinned;
    }
    if (f.expiresAt !== undefined) {
      patch.expiresAt = f.expiresAt ?? null;
    }
    if (f.tags) {
      patch.tags = f.tags;
    }
    await this.o.bridge.settle();
    if (Object.keys(patch).length) {
      this.o.log.append('memory', it.id, 'patch', patch, { durable: true });
    }
    await this.sync();
    this.local.fire([it.id]);
  }

  setLocalOnly(ids: string[], on: boolean): Promise<void> {
    return this.each(ids, (id) => this.update(id, { localOnly: on }));
  }

  pin(ids: string[], on: boolean): Promise<void> {
    return this.each(ids, (id) => this.update(id, { pinned: on }));
  }

  private async each(ids: string[], fn: (id: string) => Promise<unknown>): Promise<void> {
    for (const id of ids) {
      await fn(id);
    }
  }

  /** Moves an item to another type: a new item with the same name, text and flags; the old one goes to Trash. */
  async moveType(id: string, to: string, scope: { conversationId?: string; taskRef?: string } = {}): Promise<string> {
    const it = await this.need(id);
    const type = normalizeType(to);
    if (!type) {
      throw new Error(`Unknown memory type "${to}".`);
    }
    if (type === it.type) {
      return it.id;
    }
    const nid = await this.create(type, {
      name: it.name,
      body: it.body,
      projectId: type === 'project' ? undefined : it.projectId,
      conversationId: scope.conversationId ?? it.conversationId,
      taskRef: scope.taskRef ?? it.taskRef,
      localOnly: it.localOnly || undefined,
      pinned: it.pinned || undefined,
      source: 'user',
    });
    if (nid !== it.id) {
      await this.trash([it.id]);
    }
    return nid;
  }

  /** To Trash; a note file of this machine is deleted (the bridge logs the trash). */
  async trash(ids: string[]): Promise<number> {
    let n = 0;
    for (const id of ids) {
      const it = await this.get(id);
      if (!it || it.trashedAt) {
        continue;
      }
      const scope = fileScope(it.type as MemoryType);
      if (scope && it.path && this.o.files && (await this.o.files.delete(path0(it), scope))) {
        await this.sync();
      }
      // The bridge logs the deleted file; a file it could not see (or one that was gone already) is trashed here.
      if (!(await this.index.memory({ id: it.id, trashedOnly: true, limit: 1 })).length) {
        this.o.log.append('memory', it.id, 'trash', { at: this.now(), reason: 'user' }, { durable: true });
      }
      n++;
    }
    await this.sync();
    this.local.fire(ids);
    return n;
  }

  /** Back from Trash; a project or developer note of this machine gets its file back. */
  async restore(ids: string[]): Promise<number> {
    let n = 0;
    for (const id of ids) {
      const it = await this.get(id, { includeTrash: true });
      if (!it?.trashedAt) {
        continue;
      }
      this.o.log.append('memory', it.id, 'restore', { at: this.now() }, { durable: true });
      await this.sync();
      const scope = fileScope(it.type as MemoryType);
      if (scope && it.path && this.o.files) {
        await this.o.files.write(path0(it), it.body, scope, 'replace', 'user');
      }
      n++;
    }
    await this.sync();
    this.local.fire(ids);
    return n;
  }

  /** Deletes permanently (from Trash or retention). */
  async purge(ids: string[]): Promise<number> {
    const n = await this.o.retention.purge(ids.map((id) => ({ ent: 'memory' as const, id })), 'user');
    await this.sync();
    this.local.fire(ids);
    return n;
  }

  /** Purges the conversation items of a purged conversation (they live and die with it). */
  async purgeConversation(conversationId: string): Promise<number> {
    const rows = await this.index.memory({ conversationId, type: 'conversation', includeTrash: true, limit: 500 });
    return rows.length ? this.o.retention.purge(rows.map((r) => ({ ent: 'memory' as const, id: r.id })), 'conversation-purged') : 0;
  }

  // ---------------------------------------------------------------------------------------------- versions

  async versions(id: string): Promise<MemoryVersion[]> {
    const it = await this.need(id);
    const rows: VersionRow[] = await this.index.versions('memory', it.id);
    return rows.map((v) => {
      const f = v.fields ?? {};
      return {
        hlc: v.hlc,
        at: v.at,
        device: v.device,
        op: v.op,
        ...(typeof f.body === 'string' ? { body: f.body } : {}),
        changes: Object.keys(f).filter((k) => !['summary', 'source', 'file', 'createdAt', 'tags', '__clocks', '__bases', '__edits'].includes(k)),
      };
    });
  }

  /** Puts the body of an earlier version back as a new change (the newer one stays in the history). */
  async restoreVersion(id: string, hlc: string): Promise<void> {
    const vs = (await this.versions(id)).filter((v) => v.body !== undefined && v.hlc <= hlc).sort((a, b) => (a.hlc < b.hlc ? 1 : -1));
    if (!vs.length) {
      throw new Error('That version has no text to restore.');
    }
    await this.update(id, { body: vs[0].body });
  }

  // ---------------------------------------------------------------------------------------------- prompt, tasks

  /**
   * The chat's memory beyond the note files (§7): its conversation items and task items inline, the agent's index
   * lines. Pinned first, newest first. `localOnly` items are filtered by CONTEXT's policy for cloud providers.
   */
  async promptItems(conversationId: string | undefined, projectId: string | undefined): Promise<{ inline: MemoryItem[]; index: MemoryItem[] }> {
    const rows = await this.index.memory({ types: ['conversation', 'task', 'agent'], limit: 600 });
    const taskRef = conversationId ? this.tasks.get(conversationId) : undefined;
    const ctx = { conversationId, projectId, taskRefs: taskRef ? [taskRef] : [], now: this.now() };
    const inline: MemoryItem[] = [];
    const index: MemoryItem[] = [];
    for (const r of rows) {
      const rule = promptRule(r, ctx);
      if (rule === 'inline') {
        inline.push(r);
      } else if (rule === 'index') {
        index.push(r);
      }
    }
    const order = (a: MemoryRow, b: MemoryRow) => Number(b.pinned) - Number(a.pinned) || (b.updatedAt ?? 0) - (a.updatedAt ?? 0);
    return { inline: inline.sort(order), index: index.sort(order) };
  }

  /** Task items whose expiry passed go to Trash. */
  async expireTasks(now = this.now()): Promise<number> {
    const rows = await this.index.memory({ type: 'task', limit: 2000 });
    const due = rows.filter((r) => isExpired(r, now));
    for (const r of due) {
      this.o.log.append('memory', r.id, 'trash', { at: now, reason: 'expired' }, { durable: true });
    }
    if (due.length) {
      await this.sync();
      this.local.fire(due.map((r) => r.id));
    }
    return due.length;
  }

  /**
   * A chat's plan / todo list changed (§7 task memory): the task item `taskRef` keeps the checklist, and gets an
   * expiry `taskExpiryDays` after every todo is done (cleared again when one reopens).
   */
  async taskProgress(o: { sessionId: string; todos: readonly { id?: string; title: string; status: string }[]; plan?: { file?: string; title?: string; summary?: string }; projectId?: string }): Promise<string | undefined> {
    if (!o.todos.length) {
      return undefined;
    }
    const taskRef = taskRefOf({ plan: o.plan, sessionId: o.sessionId });
    this.tasks.set(o.sessionId, taskRef);
    const projectId = o.projectId ?? (await this.o.project().catch(() => undefined));
    const name = cleanName(o.plan?.title || `Task: ${o.todos[0].title}`);
    const mark = (s: string) => (s === 'done' ? 'x' : s === 'in_progress' ? '>' : s === 'skipped' ? '-' : ' ');
    const body = `${o.plan?.summary ? `${o.plan.summary.trim()}\n\n` : ''}${o.todos.map((t) => `- [${mark(t.status)}] ${t.title}`).join('\n')}\n`;
    const expires = taskExpiry(o.todos, this.now(), this.o.taskExpiryDays?.() ?? DEFAULT_TASK_EXPIRY_DAYS);
    const id = memoryItemId('task', scopeKey('task', { projectId, taskRef }), 'checklist');
    const existing = (await this.index.memory({ id, includeTrash: true, limit: 1 }))[0];
    if (!existing) {
      this.o.log.append('memory', id, 'create', { type: 'task', name, body, summary: summaryOf(body), ...(projectId ? { projectId } : {}), conversationId: o.sessionId, taskRef, source: 'auto', ...(expires ? { expiresAt: expires } : {}), tags: {}, createdAt: this.now() } satisfies MemoryItemFields, { durable: true });
    } else {
      const patch: Record<string, unknown> = {};
      if (existing.body !== body) {
        Object.assign(patch, { body, summary: summaryOf(body) });
      }
      if (existing.name !== name) {
        patch.name = name;
      }
      // The expiry is set once when the task completes (not moved on every later save), and cleared when it reopens.
      if (expires && !existing.expiresAt) {
        patch.expiresAt = expires;
      } else if (!expires && existing.expiresAt) {
        // null (not undefined, which JSON drops) clears the field.
        patch.expiresAt = null;
      }
      if (existing.trashedAt && !expires) {
        this.o.log.append('memory', id, 'restore', { at: this.now() }, { durable: true });
      }
      if (Object.keys(patch).length) {
        this.o.log.append('memory', id, 'patch', patch, { durable: true });
      }
    }
    // The task's other notes (memory_save type task) share its lifetime.
    for (const r of await this.index.memory({ type: 'task', taskRef, limit: 200 })) {
      if (r.id !== id && (expires ? !r.expiresAt : !!r.expiresAt)) {
        this.o.log.append('memory', r.id, 'patch', { expiresAt: expires ?? null }, { durable: true });
      }
    }
    await this.sync();
    this.local.fire([id]);
    return id;
  }

  /** The taskRef a chat works on (set by `taskProgress`). */
  taskOf(sessionId: string): string | undefined {
    return this.tasks.get(sessionId);
  }

  /**
   * Conversation memory: the summary of a chat (after a compaction or every 20 messages) as its `conversation`
   * item "summary", plus the conversation's `summary` field (search, `#chat:` mentions, the navigator).
   */
  async conversationSummary(conversationId: string, summary: string, projectId?: string): Promise<string> {
    const text = summary.trim();
    const id = await this.create('conversation', { name: 'Conversation summary', body: text, conversationId, projectId, source: 'auto' });
    // Only for a conversation the log knows (a chat not logged yet gets its summary field with a later summary).
    if (await this.index.conversation(conversationId).catch(() => undefined)) {
      this.o.log.append('conversation', conversationId, 'patch', { summary: text.slice(0, 4000), summaryAt: this.now() });
      await this.sync();
    }
    return id;
  }

  /** A healing outcome (what fixed which failure category) as an `agent` item. */
  async recordFix(o: { category: string; signature: string; message: string; strategy: string; ecosystem?: string; successes: number; failures: number; projectId?: string }): Promise<string | undefined> {
    if (!o.strategy.trim()) {
      return undefined;
    }
    const name = cleanName(`fix: ${o.category} ${o.message.replace(/\s+/g, ' ').slice(0, 48)}`);
    const body = `When a ${o.category} failure like "${o.message.replace(/\s+/g, ' ').slice(0, 300)}"${o.ecosystem ? ` (${o.ecosystem})` : ''} occurs:\n- What fixed it: ${o.strategy.trim().slice(0, 600)}\n- Worked ${o.successes} time${o.successes === 1 ? '' : 's'}${o.failures ? `, failed ${o.failures}` : ''}.\n`;
    return this.create('agent', { name, body, projectId: o.projectId, source: 'auto' });
  }

  // ---------------------------------------------------------------------------------------------- tools adapter

  /** The adapter MemoryStore's tools and prompt use (`MemoryStore.typed`). */
  typed(o: { projectOf?: (sessionId?: string) => Promise<string | undefined> } = {}): TypedMemory {
    const projectOf = async (sid?: string) => (o.projectOf ? await o.projectOf(sid).catch(() => undefined) : undefined) ?? (await this.o.project().catch(() => undefined));
    const toItem = (r: MemoryRow, snippet?: string): TypedMemoryItem => ({ id: r.id, type: r.type, name: r.name, summary: r.summary, body: r.body, chars: r.body.length, pinned: r.pinned, ...(r.localOnly ? { localOnly: true } : {}), ...(snippet ? { snippet } : {}) });
    const visible = (r: MemoryRow, sid?: string) => r.type !== 'conversation' || r.conversationId === sid;
    return {
      save: async (a) => {
        const type = normalizeType(a.type) ?? 'knowledge';
        const projectId = await projectOf(a.sessionId);
        const taskRef = type === 'task' ? this.tasks.get(a.sessionId ?? '') : undefined;
        if (type === 'task' && !taskRef) {
          throw new Error('No plan or todo list is running in this chat; create one with manage_todos first, or save the note as "conversation".');
        }
        const id = await this.create(type, { name: a.name, body: a.content, mode: a.mode, projectId: type === 'knowledge' || type === 'agent' ? undefined : projectId, conversationId: type === 'conversation' || type === 'task' ? a.sessionId : undefined, taskRef, source: a.source ?? 'agent' });
        return `Saved ${type} memory "${cleanName(a.name)}" (${id}).`;
      },
      read: async (name, a) => {
        const type = a.type ? normalizeType(a.type) : undefined;
        const ok = (r: MemoryRow) => visible(r, a.sessionId) && !TYPE_INFO[r.type as MemoryType]?.fileBacked;
        let rows = (await this.index.memory({ name, type, limit: 20 })).filter(ok);
        if (!rows.length) {
          // `#memory:my-note` names "My note": compare with spaces as dashes.
          const slug = (s: string) => s.trim().toLowerCase().replace(/\s+/g, '-');
          rows = (await this.index.memory({ type, types: type ? undefined : ['conversation', 'task', 'knowledge', 'agent'], limit: 1000 })).filter((r) => ok(r) && slug(r.name) === slug(name));
        }
        return rows.map((r) => toItem(r));
      },
      list: async (a) => {
        const projectId = await projectOf(a.sessionId);
        const t = a.type ? normalizeType(a.type) : undefined;
        const rows = await this.index.memory({ type: t, types: t ? undefined : ['conversation', 'task', 'knowledge', 'agent'], projectId, limit: 300 });
        return rows.filter((r) => visible(r, a.sessionId) && !isExpired(r, this.now())).map((r) => toItem(r));
      },
      delete: async (name, a) => {
        const rows = (await this.index.memory({ name, type: normalizeType(a.type), limit: 20 })).filter((r) => visible(r, a.sessionId));
        if (!rows.length) {
          return false;
        }
        await this.trash(rows.map((r) => r.id));
        return true;
      },
      search: async (query, a) => {
        const projectId = a.allProjects ? undefined : await projectOf(a.sessionId);
        const hits = await this.index.searchMemory(query, { projectId, limit: (a.limit ?? 12) * 2 });
        const rows = hits.length ? await this.index.memory({ ids: hits.map((h) => h.memoryId!).filter(Boolean), limit: 200 }) : [];
        const byId = new Map(rows.map((r) => [r.id, r]));
        const t = a.type ? normalizeType(a.type) : undefined;
        return hits
          .map((h) => ({ h, r: byId.get(h.memoryId ?? '') }))
          .filter((x): x is { h: SearchHit; r: MemoryRow } => !!x.r && visible(x.r, a.sessionId) && (!t || x.r.type === t))
          .slice(0, a.limit ?? 12)
          .map(({ h, r }) => toItem(r, h.snippet));
      },
      prompt: async (a) => {
        const p = await this.promptItems(a.sessionId, await projectOf(a.sessionId));
        return { inline: p.inline.map((r) => toItem(r)), index: p.index.map((r) => toItem(r)) };
      },
      // CONTEXT's policy: every note marked "local only" (file notes by their file stem, as the store names them).
      localOnly: async () => (await this.index.memory({ localOnly: true, limit: 2000 })).filter((r) => r.localOnly).map((r) => ({ type: r.type, name: TYPE_INFO[r.type as MemoryType]?.fileBacked ? path0(r) : r.name })),
    };
  }
}

/** The file stem of a note row. */
function path0(it: Pick<MemoryRow, 'file' | 'name'>): string {
  return (it.file || it.name).replace(/\.md$/, '');
}
