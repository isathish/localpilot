import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { ChatMessage, Session, SessionSummary } from '../types';
import { userText } from '../agent/clarify';
import { ArchiveRecord, parseArchive, rebuildBefore } from './transcriptArchive';
import { HistoryPage, HistoryQuery, queryHistory } from './historyQuery';

const ARCHIVE_SUFFIX = '.archive.jsonl';

/** A chat with nothing in it yet: no messages, no plan, not pinned — nothing would be lost by removing it. */
export function isEmptySession(s: Pick<Session, 'messages' | 'pinned' | 'plan'>): boolean {
  return !s.messages.length && !s.pinned && !s.plan;
}

/** The list row of a session: everything but the transcript and other per-turn state. */
function summaryOf(s: Session, bytes?: number): SessionSummary {
  const { id, title, createdAt, updatedAt, model, mode, specialist, plan, pinned, worktree, isolated, group, skills, origin, parentId, parentTitle, folder } = s;
  const usage = s.usage ? { ...s.usage, subagentTokens: s.usage.subagentTokens && { ...s.usage.subagentTokens } } : undefined;
  return { id, title, createdAt, updatedAt, model, mode, ...(specialist ? { specialist } : {}), plan, messageCount: s.messages.length, pinned, worktree, isolated, group, skills, usage, bytes, origin, parentId, parentTitle, ...(folder ? { folder } : {}) };
}

const escHtml = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Wraps a chat's Markdown export in a standalone page: the text as written, readable in light and dark themes. */
export function sessionHtml(title: string, markdown: string): string {
  const css = [
    ':root{color-scheme:light dark;--fg:#1f2328;--bg:#ffffff;--muted:#59636e;--border:#d1d9e0;--code:#f6f8fa}',
    '@media (prefers-color-scheme:dark){:root{--fg:#e6edf3;--bg:#0d1117;--muted:#9198a1;--border:#3d444d;--code:#151b23}}',
    'body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif}',
    'main{max-width:860px;margin:0 auto;padding:32px 24px}',
    'header{color:var(--muted);font-size:13px;border-bottom:1px solid var(--border);padding-bottom:8px;margin-bottom:16px}',
    'pre{white-space:pre-wrap;word-wrap:break-word;background:var(--code);border:1px solid var(--border);border-radius:6px;padding:16px;font:13px/1.55 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}',
  ].join('\n');
  return `<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">\n<title>${escHtml(title)}</title>\n<style>\n${css}\n</style>\n</head>\n<body>\n<main>\n<header>Exported from LocalPilot · ${escHtml(new Date().toLocaleString())}</header>\n<pre>${escHtml(markdown)}</pre>\n</main>\n</body>\n</html>\n`;
}

export interface SessionSearchHit {
  id: string;
  /** The matching line, trimmed around the first occurrence. */
  snippet: string;
  /** Which side said it. */
  role: 'user' | 'assistant';
}

/**
 * Persists chat sessions as individual JSON files under the extension's workspace storage
 * (so sessions are scoped to the workspace, like Copilot/Claude Code). Multiple sessions can be
 * active and streaming at the same time; the store only cares about persistence.
 *
 * Memory: every chat's list row stays in memory, but full transcripts only for the most recently used ones
 * (`maxInMemory`); the rest are read back from disk when something asks for them. Chats that are `inUse` (running,
 * on screen) or have a write pending are never dropped, so callers holding a session object keep the live one.
 */
export class SessionStore implements vscode.Disposable {
  /** Full sessions, least recently used first. */
  private sessions = new Map<string, Session>();
  /** List rows for every session on disk or in memory. */
  private index = new Map<string, SessionSummary>();
  private readonly dir: vscode.Uri;
  private saveTimers = new Map<string, NodeJS.Timeout>();
  private writing = new Set<string>();
  /** Deleted ids: a late save from a run that was still finishing must not bring the chat back. */
  private deleted = new Set<string>();
  private changeTimer?: NodeJS.Timeout;
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;
  private readonly _onDidDelete = new vscode.EventEmitter<string>();
  /** Fires with the id of every deleted session (explicit delete, clear history, retention pruning). */
  readonly onDidDelete = this._onDidDelete.event;
  /** How many full transcripts to keep in memory; read on every eviction so the setting applies live. */
  maxInMemory: () => number = () => 16;
  /** Sessions that must stay in memory (running, active). */
  inUse: (id: string) => boolean = () => false;
  /** Prefix of new session ids (the CLI uses `cli-`, so its checkpoints are pruned by age, not against VS Code's chats). */
  idPrefix = 's_';
  /** Stamped on every chat this store creates (the CLI's are `cli`). */
  origin?: Session['origin'];
  /**
   * Read-only folders whose chats are listed too (VS Code reads the CLI's sessions for the same folder). Writes always go
   * to this store's own folder; the newer copy of a chat wins when both have it.
   */
  extraDirs: vscode.Uri[] = [];
  /** Chats read from one of `extraDirs`, and the folder each lives in. */
  private external = new Map<string, vscode.Uri>();
  /** Modification times of the files last read from `extraDirs`, so a rescan parses only what changed. */
  private externalSeen = new Map<string, number>();

  /** The folder a session's file is in. */
  private dirOf(id: string): vscode.Uri {
    return this.external.get(id) ?? this.dir;
  }

  /** Whether the store knows this chat (on disk or in memory). */
  has(id: string): boolean {
    return this.index.has(id);
  }

  /** Whether the chat was read from one of the read-only `extraDirs`. */
  isExternal(id: string): boolean {
    return this.external.has(id);
  }

  constructor(ctx: vscode.ExtensionContext, private readonly log: vscode.LogOutputChannel) {
    const base = ctx.storageUri ?? ctx.globalStorageUri;
    this.dir = vscode.Uri.joinPath(base, 'sessions');
  }

  /** Folder for the chats' run traces (`traces/` next to `sessions/`); undefined outside a file system. */
  get tracesDir(): string | undefined {
    return this.dir.scheme === 'file' ? path.join(path.dirname(this.dir.fsPath), 'traces') : undefined;
  }

  /** True once `load()` read the sessions folder; worktree pruning must not run against a store that failed to load. */
  loadedOk = false;

  async load(): Promise<void> {
    // Only the newest transcripts are kept while reading, so start-up never holds the whole history at once.
    const cap = this.dir.scheme === 'file' ? Math.max(2, Math.floor(this.maxInMemory())) : Infinity;
    const keep: Session[] = [];
    const empty: string[] = [];
    try {
      await vscode.workspace.fs.createDirectory(this.dir);
      const entries = await vscode.workspace.fs.readDirectory(this.dir);
      for (const [name, type] of entries) {
        if (type === vscode.FileType.File && name.endsWith(ARCHIVE_SUFFIX) && this.dir.scheme === 'file') {
          this.archiveSize.set(name.slice(0, -ARCHIVE_SUFFIX.length), await fs.promises.stat(path.join(this.dir.fsPath, name)).then((st) => st.size, () => 0));
          continue;
        }
        if (type !== vscode.FileType.File || !name.endsWith('.json')) {
          continue;
        }
        try {
          const raw = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(this.dir, name));
          const s = JSON.parse(Buffer.from(raw).toString('utf8')) as Session;
          if (!s?.id) {
            continue;
          }
          // Every window reload used to leave another untouched "New chat" behind; they only clutter the history.
          if (isEmptySession(s)) {
            empty.push(s.id);
            continue;
          }
          this.index.set(s.id, summaryOf(s, raw.byteLength));
          keep.push(s);
          if (keep.length > cap) {
            keep.sort((a, b) => b.updatedAt - a.updatedAt).length = cap;
          }
        } catch (e) {
          this.log.warn(`Skipping corrupt session file ${name}: ${String(e)}`);
        }
      }
      // Oldest first, so the newest chats end up as the most recently used.
      for (const s of keep.sort((a, b) => a.updatedAt - b.updatedAt)) {
        this.sessions.set(s.id, s);
      }
      for (const id of empty) {
        await this.delete(id, false);
      }
      for (const dir of this.extraDirs) {
        for (const { s } of await this.readExternal(dir)) {
          const own = this.index.get(s.id);
          if (own && own.updatedAt >= s.updatedAt) {
            continue;
          }
          this.sessions.delete(s.id);
          this.external.set(s.id, dir);
          this.index.set(s.id, summaryOf(s));
        }
      }
      this.loadedOk = true;
    } catch (e) {
      this.log.error(`Failed to load sessions: ${String(e)}`);
    }
    this._onDidChange.fire();
  }

  /** Non-empty chats in a read-only folder whose files changed since the last read (all of them the first time). */
  private async readExternal(dir: vscode.Uri): Promise<{ s: Session; key: string }[]> {
    const out: { s: Session; key: string }[] = [];
    let entries: [string, vscode.FileType][];
    try {
      entries = await vscode.workspace.fs.readDirectory(dir);
    } catch {
      return out;
    }
    for (const [name, type] of entries) {
      if (type !== vscode.FileType.File || !name.endsWith('.json')) {
        continue;
      }
      const file = vscode.Uri.joinPath(dir, name);
      try {
        const mtime = (await vscode.workspace.fs.stat(file)).mtime;
        if (this.externalSeen.get(file.toString()) === mtime) {
          continue;
        }
        this.externalSeen.set(file.toString(), mtime);
        const s = JSON.parse(Buffer.from(await vscode.workspace.fs.readFile(file)).toString('utf8')) as Session;
        if (s?.id && `${s.id}.json` === name && !isEmptySession(s) && !this.deleted.has(s.id)) {
          out.push({ s, key: file.toString() });
        }
      } catch (e) {
        this.log.warn(`Skipping unreadable session file ${file.fsPath}: ${String(e)}`);
      }
    }
    return out;
  }

  /**
   * Picks up chats written to `extraDirs` since the last look (another process, e.g. the CLI, saved them): new ones are
   * listed, changed ones replace the copy here unless it is in use, deleted ones disappear.
   */
  async refreshExternal(): Promise<boolean> {
    if (!this.loadedOk) {
      return false;
    }
    let changed = false;
    for (const dir of this.extraDirs) {
      for (const { s, key } of await this.readExternal(dir)) {
        const row = this.index.get(s.id);
        const busy = this.inUse(s.id) || this.saveTimers.has(s.id) || this.writing.has(s.id);
        if (row && busy) {
          this.externalSeen.delete(key); // look again next time
          continue;
        }
        if (row && !this.external.has(s.id) && row.updatedAt >= s.updatedAt) {
          continue;
        }
        this.sessions.delete(s.id);
        this.searchCache.delete(s.id);
        this.external.set(s.id, dir);
        this.index.set(s.id, summaryOf(s));
        changed = true;
      }
    }
    for (const [id, dir] of this.external) {
      if (dir.scheme === 'file' && !fs.existsSync(path.join(dir.fsPath, `${id}.json`)) && !this.inUse(id)) {
        this.external.delete(id);
        this.index.delete(id);
        this.sessions.delete(id);
        this.searchCache.delete(id);
        changed = true;
      }
    }
    if (changed) {
      this._onDidChange.fire();
    }
    return changed;
  }

  /** Watches `extraDirs` and rescans them when a file there changes (debounced). */
  watchExternal(): vscode.Disposable {
    let timer: NodeJS.Timeout | undefined;
    const kick = () => {
      clearTimeout(timer);
      timer = setTimeout(() => void this.refreshExternal().catch((e) => this.log.warn(`CLI history refresh: ${String(e)}`)), 300);
    };
    const watchers = this.extraDirs.map((dir) => {
      // The watcher needs the folder to exist; the CLI may not have run here yet.
      try {
        fs.mkdirSync(dir.fsPath, { recursive: true });
      } catch {
        // unwritable: changes are picked up on the next window reload
      }
      const w = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(dir, '*.json'));
      w.onDidCreate(kick);
      w.onDidChange(kick);
      w.onDidDelete(kick);
      return w;
    });
    return new vscode.Disposable(() => {
      clearTimeout(timer);
      watchers.forEach((w) => w.dispose());
    });
  }

  /** Every chat's list row; `bytes` is what it takes on disk, its transcript archive included. */
  list(): SessionSummary[] {
    return [...this.index.values()]
      .map((s) => ({ ...s, bytes: s.bytes === undefined && !this.archiveSize.get(s.id) ? undefined : (s.bytes ?? 0) + (this.archiveSize.get(s.id) ?? 0) }))
      .sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || b.updatedAt - a.updatedAt);
  }

  /** One page of the history list: sorted, filtered by pinned and by a fuzzy title match or what was said. */
  listSessions(q: HistoryQuery = {}): HistoryPage {
    const query = (q.query ?? '').trim();
    return queryHistory(this.list(), q, query.length >= 2 ? this.search(query, Number.MAX_SAFE_INTEGER) : []);
  }

  /** The full session, read back from disk if it was dropped from memory. */
  get(id: string): Session | undefined {
    const hot = this.sessions.get(id);
    if (hot) {
      this.sessions.delete(id);
      this.sessions.set(id, hot);
      return hot;
    }
    const cold = this.index.has(id) ? this.readSync(id) : undefined;
    if (cold) {
      this.sessions.set(id, cold);
      this.evict(id);
    }
    return cold;
  }

  /** Full transcripts currently held in memory (for the Memory page and tests). */
  get loadedCount(): number {
    return this.sessions.size;
  }

  /** Reads a session without keeping it in memory (search, scans over every chat). */
  peek(id: string): Session | undefined {
    return this.sessions.get(id) ?? this.readSync(id);
  }

  private readSync(id: string): Session | undefined {
    if (this.dir.scheme !== 'file') {
      return undefined;
    }
    try {
      const s = JSON.parse(fs.readFileSync(path.join(this.dirOf(id).fsPath, `${id}.json`), 'utf8')) as Session;
      return s?.id === id ? s : undefined;
    } catch (e) {
      this.log.warn(`Cannot read session ${id}: ${String(e)}`);
      return undefined;
    }
  }

  /** Drops the least recently used transcripts beyond the limit (never `keep`, in-use or unsaved ones). */
  private evict(keep?: string): void {
    // Without a local file to read back from, everything stays in memory.
    const max = this.dir.scheme === 'file' ? Math.max(2, Math.floor(this.maxInMemory())) : Infinity;
    if (this.sessions.size <= max) {
      return;
    }
    for (const id of [...this.sessions.keys()]) {
      if (this.sessions.size <= max) {
        break;
      }
      if (id === keep || this.saveTimers.has(id) || this.writing.has(id) || this.inUse(id)) {
        continue;
      }
      this.sessions.delete(id);
    }
  }

  /** Re-applies the memory limit (after the setting changed or a run ended). */
  trim(): void {
    this.evict();
  }

  /**
   * Full-text search over what was said (not tool output or hidden steering), newest chat first. A chat appears once,
   * with the first matching line; title matches count too so the result set is a superset of the title filter.
   */
  /**
   * The searchable text of a chat (what the user and the agent wrote), kept between queries and rebuilt only when the
   * chat changed. Search runs on every keystroke in the history panel; reading and parsing every transcript from disk
   * each time blocked the extension host with a long history.
   */
  private searchCache = new Map<string, { updatedAt: number; parts: { role: 'user' | 'assistant'; text: string; lower: string }[] }>();
  private searchText(id: string, updatedAt: number): { role: 'user' | 'assistant'; text: string; lower: string }[] {
    const hit = this.searchCache.get(id);
    if (hit && hit.updatedAt === updatedAt) {
      return hit.parts;
    }
    const parts: { role: 'user' | 'assistant'; text: string; lower: string }[] = [];
    for (const m of this.peek(id)?.messages ?? []) {
      if ((m.role !== 'user' && m.role !== 'assistant') || m.meta?.hidden || m.meta?.summary || m.meta?.toolImages || m.meta?.toolResults) {
        continue;
      }
      const text = (m.role === 'user' ? userText(m.content) : m.content).slice(0, 20_000);
      parts.push({ role: m.role, text, lower: text.toLowerCase() });
    }
    this.searchCache.set(id, { updatedAt, parts });
    return parts;
  }

  search(query: string, limit = 20): SessionSearchHit[] {
    const q = query.trim().toLowerCase();
    if (q.length < 2) {
      return [];
    }
    const hits: SessionSearchHit[] = [];
    for (const row of [...this.index.values()].sort((a, b) => b.updatedAt - a.updatedAt)) {
      let hit: SessionSearchHit | undefined;
      if (row.title.toLowerCase().includes(q)) {
        hit = { id: row.id, snippet: '', role: 'user' };
      }
      for (const { role, text, lower } of this.searchText(row.id, row.updatedAt)) {
        const m = { role };
        const at = lower.indexOf(q);
        if (at < 0) {
          continue;
        }
        const lineStart = text.lastIndexOf('\n', at) + 1;
        const lineEnd = (text.indexOf('\n', at) + 1 || text.length + 1) - 1;
        const from = Math.max(lineStart, at - 40);
        const snippet = `${from > lineStart ? '…' : ''}${text.slice(from, Math.min(lineEnd, at + q.length + 80)).replace(/\s+/g, ' ').trim()}${Math.min(lineEnd, at + q.length + 80) < lineEnd ? '…' : ''}`;
        hit = { id: row.id, snippet, role: m.role };
        break;
      }
      if (hit) {
        hits.push(hit);
        if (hits.length >= limit) {
          break;
        }
      }
    }
    return hits;
  }

  create(model: string, mode: Session['mode'] = 'agent'): Session {
    const now = Date.now();
    const s: Session = {
      id: `${this.idPrefix}${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      title: 'New chat',
      createdAt: now,
      updatedAt: now,
      model,
      messageCount: 0,
      messages: [],
      contextTokens: 0,
      compactions: 0,
      mode,
      attachments: [],
      ...(this.origin ? { origin: this.origin } : {}),
    };
    this.sessions.set(s.id, s);
    this.save(s, true);
    return s;
  }

  /** Branch a session: copy messages up to (and including) index into a new session. */
  fork(id: string, uptoIndex?: number): Session | undefined {
    const src = this.get(id);
    if (!src) {
      return undefined;
    }
    const s = this.create(src.model, src.mode);
    s.title = `${src.title} (fork)`;
    s.parentId = src.id;
    s.parentTitle = src.title;
    s.messages = structuredClone(uptoIndex === undefined ? src.messages : src.messages.slice(0, uptoIndex + 1));
    s.attachments = [...src.attachments];
    s.think = src.think;
    s.folder = src.folder;
    this.forkArchive(src.id, s);
    this.save(s, true);
    return s;
  }

  /**
   * The fork's messages carry the parent's archive numbers: copy the parent's records up to the last of them into the
   * fork's own archive, so a rewind there rebuilds the same history (without an archive, the marks are dropped).
   */
  private forkArchive(parentId: string, s: Session): void {
    const last = s.messages.reduce((max, m) => Math.max(max, m.meta?.archived ?? -1), -1);
    if (last < 0) {
      return;
    }
    if (this.dir.scheme !== 'file') {
      for (const m of s.messages) {
        if (m.meta?.archived !== undefined) {
          const { archived: _archived, ...rest } = m.meta;
          m.meta = rest;
        }
      }
      return;
    }
    this.archiveNext.set(s.id, last + 1);
    void this.queueArchive(s.id, async () => {
      await this.archiveChains.get(parentId)?.catch(() => undefined);
      const text = await fs.promises.readFile(this.archiveFile(parentId), 'utf8').catch(() => '');
      const kept = parseArchive(text).filter((r) => r.seq <= last).sort((a, b) => a.seq - b.seq);
      if (kept.length) {
        const out = `${kept.map((r) => JSON.stringify(r)).join('\n')}\n`;
        await fs.promises.writeFile(this.archiveFile(s.id), out, 'utf8');
        this.archiveSize.set(s.id, Buffer.byteLength(out));
      }
    });
  }

  /** Forgets a chat's whole transcript archive: the conversation was cleared. */
  clearArchive(id: string): Promise<void> {
    return this.truncateArchive(id, 0);
  }

  rename(id: string, title: string): void {
    const s = this.get(id);
    if (s) {
      s.title = title.slice(0, 120);
      this.save(s, true);
    }
  }

  togglePin(id: string): void {
    const s = this.get(id);
    if (s) {
      s.pinned = !s.pinned;
      this.save(s, true);
    }
  }

  async delete(id: string, notify = true): Promise<void> {
    this.deleted.add(id);
    this.sessions.delete(id);
    this.index.delete(id);
    this.searchCache.delete(id);
    clearTimeout(this.saveTimers.get(id));
    this.saveTimers.delete(id);
    // A save still writing would otherwise recreate the file after it is deleted, and the chat would come back.
    await this.chains.get(id)?.catch(() => undefined);
    const ext = this.external.get(id);
    this.external.delete(id);
    // A chat continued here from the CLI has a copy in both folders: remove both, or the other would come back.
    for (const dir of ext ? [this.dir, ext] : [this.dir]) {
      try {
        await vscode.workspace.fs.delete(vscode.Uri.joinPath(dir, `${id}.json`));
      } catch {
        /* already gone */
      }
    }
    for (const dir of this.extraDirs) {
      if (dir !== ext && this.dir.scheme === 'file' && fs.existsSync(path.join(dir.fsPath, `${id}.json`))) {
        await vscode.workspace.fs.delete(vscode.Uri.joinPath(dir, `${id}.json`)).then(undefined, () => undefined);
      }
    }
    // The transcript archive goes with the chat.
    this.archiveNext.delete(id);
    await this.archiveChains.get(id);
    if (this.dir.scheme === 'file') {
      await fs.promises.rm(this.archiveFile(id), { force: true }).catch(() => undefined);
    }
    this.archiveSize.delete(id);
    this._onDidDelete.fire(id);
    if (notify) {
      this._onDidChange.fire();
    }
  }

  async clearAll(): Promise<void> {
    for (const id of [...this.index.keys()]) {
      await this.delete(id);
    }
  }

  /** Delete every session except the given ids (running or pinned chats survive "Clear chat history"). */
  async clearExcept(keep: Iterable<string> | ((id: string) => boolean)): Promise<number> {
    const keeps = typeof keep === 'function' ? keep : ((set: Set<string>) => (id: string) => set.has(id))(new Set(keep));
    let n = 0;
    for (const id of [...this.index.keys()]) {
      // A predicate is asked just before each delete, so a chat that became busy meanwhile is spared.
      if (this.index.has(id) && !keeps(id)) {
        await this.delete(id);
        n++;
      }
    }
    return n;
  }

  /**
   * Retention: keep at most `max` sessions (pinned ones never count, and `protect` — running chats — are never
   * removed). Oldest idle chats go first. Called after every new chat so storage cannot grow without bound.
   */
  async prune(max: number, protect: Iterable<string> = []): Promise<number> {
    if (!Number.isFinite(max) || max <= 0) {
      return 0;
    }
    const safe = new Set(protect);
    // Chats read from another tool's folder (the CLI's) are its to keep or prune.
    const candidates = [...this.index.values()].filter((s) => !s.pinned && !safe.has(s.id) && !this.external.has(s.id)).sort((a, b) => b.updatedAt - a.updatedAt);
    const extra = candidates.slice(max);
    for (const s of extra) {
      await this.delete(s.id);
    }
    return extra.length;
  }

  /** Storage footprint of the session files (for the Settings → Memory page). */
  async stats(): Promise<{ count: number; bytes: number; messages: number; oldest?: number; inMemory: number }> {
    let bytes = 0;
    let messages = 0;
    let oldest: number | undefined;
    for (const s of this.index.values()) {
      messages += s.messageCount;
      oldest = oldest === undefined ? s.createdAt : Math.min(oldest, s.createdAt);
      try {
        bytes += (await vscode.workspace.fs.stat(vscode.Uri.joinPath(this.dirOf(s.id), `${s.id}.json`))).size;
      } catch {
        bytes += JSON.stringify(this.sessions.get(s.id) ?? s).length;
      }
      if (this.dir.scheme === 'file') {
        bytes += await fs.promises.stat(this.archiveFile(s.id)).then((st) => st.size, () => 0);
      }
    }
    return { count: this.index.size, bytes, messages, oldest, inMemory: this.sessions.size };
  }

  /** Next archive number per chat (the records in its archive), read from disk on first use. */
  private archiveNext = new Map<string, number>();
  /** One write chain per archive: appends and truncations land in order. */
  private archiveChains = new Map<string, Promise<void>>();
  /** Bytes of each chat's archive file, for the sizes in the history list. */
  private archiveSize = new Map<string, number>();

  private archiveFile(id: string): string {
    return path.join(this.dir.fsPath, `${id}${ARCHIVE_SUFFIX}`);
  }

  private queueArchive(id: string, op: () => Promise<void>): Promise<void> {
    const run = (this.archiveChains.get(id) ?? Promise.resolve()).then(op).catch((e) => this.log.error(`Transcript archive of ${id}: ${String(e)}`));
    this.archiveChains.set(id, run);
    return run.finally(() => {
      if (this.archiveChains.get(id) === run) {
        this.archiveChains.delete(id);
      }
    });
  }

  /**
   * Appends messages a compaction is about to replace to `<id>.archive.jsonl` and numbers them (`meta.archived`), so
   * rewinding past the compaction can bring the originals back. Chats this store does not hold (subagents) are skipped.
   */
  archive(id: string, messages: ChatMessage[], opts: { compactionIndex: number }): void {
    if (this.dir.scheme !== 'file' || !this.index.has(id) || this.deleted.has(id) || !messages.length) {
      return;
    }
    let next = this.archiveNext.get(id);
    if (next === undefined) {
      let text = '';
      try {
        text = fs.readFileSync(this.archiveFile(id), 'utf8');
      } catch {
        // no archive yet
      }
      next = parseArchive(text).reduce((max, r) => Math.max(max, r.seq + 1), 0);
    }
    const at = Date.now();
    const lines: string[] = [];
    for (const m of messages) {
      m.meta = { ...m.meta, archived: next };
      lines.push(JSON.stringify({ seq: next, compaction: opts.compactionIndex, at, message: m } satisfies ArchiveRecord));
      next++;
    }
    this.archiveNext.set(id, next);
    void this.queueArchive(id, async () => {
      await fs.promises.mkdir(this.dir.fsPath, { recursive: true });
      const text = `${lines.join('\n')}\n`;
      await fs.promises.appendFile(this.archiveFile(id), text, 'utf8');
      this.archiveSize.set(id, (this.archiveSize.get(id) ?? 0) + Buffer.byteLength(text));
    });
  }

  /** Every archived message of a chat, oldest first (empty when nothing was ever compacted). */
  async loadArchive(id: string): Promise<ArchiveRecord[]> {
    await this.archiveChains.get(id);
    if (this.dir.scheme !== 'file') {
      return [];
    }
    const text = await fs.promises.readFile(this.archiveFile(id), 'utf8').catch(() => '');
    return parseArchive(text).sort((a, b) => a.seq - b.seq);
  }

  /** Drops archive records from `seq` on: the conversation was rewound to before them. */
  truncateArchive(id: string, seq: number): Promise<void> {
    if (this.dir.scheme !== 'file') {
      return Promise.resolve();
    }
    this.archiveNext.set(id, Math.min(this.archiveNext.get(id) ?? seq, seq));
    return this.queueArchive(id, async () => {
      const file = this.archiveFile(id);
      const text = await fs.promises.readFile(file, 'utf8').catch(() => '');
      const kept = parseArchive(text).filter((r) => r.seq < seq);
      if (!kept.length) {
        await fs.promises.rm(file, { force: true });
        this.archiveSize.delete(id);
        return;
      }
      const out = `${kept.map((r) => JSON.stringify(r)).join('\n')}\n`;
      await fs.promises.writeFile(`${file}.tmp`, out, 'utf8');
      await fs.promises.rename(`${file}.tmp`, file);
      this.archiveSize.set(id, Buffer.byteLength(out));
    });
  }

  /**
   * The conversation to keep when rewinding to `messageIndex`: normally the messages before it, but when compaction
   * replaced earlier ones with a summary and the target is from before that compaction, the originals from the archive.
   */
  async historyBefore(s: Session, messageIndex: number): Promise<ChatMessage[]> {
    const kept = s.messages.slice(0, messageIndex);
    const seq = s.messages[messageIndex]?.meta?.archived;
    if (seq === undefined || !kept.some((m) => m.meta?.summary)) {
      return kept;
    }
    const original = rebuildBefore(await this.loadArchive(s.id), seq);
    if (!original) {
      return kept;
    }
    await this.truncateArchive(s.id, seq);
    return original;
  }

  /** Debounced write so streaming turns do not hammer the disk. `immediate` notifies listeners right away (new / renamed / pinned chat). */
  save(s: Session, immediate = false): void {
    if (this.deleted.has(s.id)) {
      return;
    }
    s.updatedAt = Date.now();
    s.messageCount = s.messages.length;
    if (s.title === 'New chat') {
      // The first thing the user said — their own words, not the attachment or context blocks the UI prepended.
      const firstUser = s.messages.find((m) => m.role === 'user' && !m.meta?.hidden && !m.meta?.toolImages && !m.meta?.toolResults);
      if (firstUser) {
        s.title = userText(firstUser.content).replace(/\s+/g, ' ').trim().slice(0, 60) || 'New chat';
      }
    }
    clearTimeout(this.saveTimers.get(s.id));
    // The caller's object is the live one: make sure it is the one the store hands out (and lists) from now on.
    this.sessions.delete(s.id);
    this.sessions.set(s.id, s);
    this.index.set(s.id, summaryOf(s, this.index.get(s.id)?.bytes));
    this.saveTimers.set(
      s.id,
      setTimeout(() => {
        this.saveTimers.delete(s.id);
        void this.flush(s);
      }, 400)
    );
    // Listeners rebuild session lists / tree views; while agents stream, save() runs after every tool result,
    // so coalesce the notification to a few times per second.
    if (immediate) {
      clearTimeout(this.changeTimer);
      this.changeTimer = undefined;
      this._onDidChange.fire();
      return;
    }
    if (!this.changeTimer) {
      this.changeTimer = setTimeout(() => {
        this.changeTimer = undefined;
        this._onDidChange.fire();
      }, 250);
    }
  }

  /** One write chain per chat: writes land in order, and `delete` waits for the one in flight. */
  private chains = new Map<string, Promise<void>>();

  flush(s: Session): Promise<void> {
    // This write carries the latest state, so a debounced one still pending is redundant.
    clearTimeout(this.saveTimers.get(s.id));
    this.saveTimers.delete(s.id);
    this.writing.add(s.id);
    const run = (this.chains.get(s.id) ?? Promise.resolve()).then(async () => {
      if (this.deleted.has(s.id)) {
        return;
      }
      // Written beside and renamed over: a crash or a concurrent reader never sees half a transcript.
      const target = vscode.Uri.joinPath(this.dir, `${s.id}.json`);
      const tmp = vscode.Uri.joinPath(this.dir, `${s.id}.json.tmp`);
      try {
        await vscode.workspace.fs.createDirectory(this.dir);
        const data = Buffer.from(JSON.stringify(s), 'utf8');
        await vscode.workspace.fs.writeFile(tmp, data);
        await vscode.workspace.fs.rename(tmp, target, { overwrite: true });
        // Saved here now: this folder's copy is the live one.
        this.external.delete(s.id);
        const row = this.index.get(s.id);
        if (row) {
          row.bytes = data.byteLength;
        }
      } catch (e) {
        this.log.error(`Failed to save session ${s.id}: ${String(e)}`);
      }
    });
    this.chains.set(s.id, run);
    return run.finally(() => {
      if (this.chains.get(s.id) === run) {
        this.chains.delete(s.id);
        this.writing.delete(s.id);
      }
      this.evict();
    });
  }

  async exportMarkdown(id: string): Promise<string> {
    const s = this.get(id);
    if (!s) {
      return '';
    }
    const lines = [`# ${s.title}`, `_Model: ${s.model} · ${new Date(s.createdAt).toLocaleString()}_`, ''];
    for (const m of s.messages) {
      if (m.role === 'tool') {
        lines.push(`<details><summary>Tool result: ${m.toolName}</summary>\n\n\`\`\`\n${m.content.slice(0, 4000)}\n\`\`\`\n</details>\n`);
      } else if (m.role === 'user' && (m.meta?.hidden || m.meta?.toolImages || m.meta?.toolResults)) {
        continue;
      } else if (m.meta?.summary) {
        lines.push('_Conversation compacted_\n');
      } else if (m.role === 'user') {
        const attached = [...m.content.matchAll(/<(attachment|directory|workspace_tree|problems|git|open_editors|terminal_output|selection)\b([^>]*)>[\s\S]*?<\/\1>/g)].map(
          (b) => /\bpath="([^"]*)"/.exec(b[2])?.[1] ?? `@${b[1]}`
        );
        lines.push(`### You\n\n${m.meta?.display ?? userText(m.content)}\n`);
        if (attached.length) {
          lines.push(`Attached: ${[...new Set(attached)].join(', ')}\n`);
        }
      } else {
        lines.push(`### LocalPilot\n\n${m.content}\n`);
        for (const tc of m.toolCalls ?? []) {
          lines.push(`> **tool** \`${tc.name}(${tc.arguments.slice(0, 200)})\`\n`);
        }
      }
    }
    return lines.join('\n');
  }

  /** A self-contained HTML page of the Markdown export (no scripts, no external resources). */
  async exportHtml(id: string): Promise<string> {
    const md = await this.exportMarkdown(id);
    if (!md) {
      return '';
    }
    return sessionHtml(this.peek(id)?.title ?? 'Chat', md);
  }

  dispose(): void {
    // Saves still waiting for their debounce carry the last moments of a chat (often the final turn): write them now,
    // synchronously, since the window is closing and nothing after dispose() is awaited.
    for (const [id, t] of this.saveTimers) {
      clearTimeout(t);
      const s = this.sessions.get(id);
      if (s && !this.deleted.has(id)) {
        try {
          const file = path.join(this.dir.fsPath, `${id}.json`);
          fs.mkdirSync(this.dir.fsPath, { recursive: true });
          fs.writeFileSync(`${file}.tmp`, JSON.stringify(s), 'utf8');
          fs.renameSync(`${file}.tmp`, file);
        } catch (e) {
          this.log.error(`Failed to save session ${id} on shutdown: ${String(e)}`);
        }
      }
    }
    this.saveTimers.clear();
    clearTimeout(this.changeTimer);
    this._onDidChange.dispose();
    this._onDidDelete.dispose();
  }
}
