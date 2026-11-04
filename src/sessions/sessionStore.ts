import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { Session, SessionSummary } from '../types';
import { userText } from '../agent/clarify';

/** A chat with nothing in it yet: no messages, no plan, not pinned — nothing would be lost by removing it. */
export function isEmptySession(s: Pick<Session, 'messages' | 'pinned' | 'plan'>): boolean {
  return !s.messages.length && !s.pinned && !s.plan;
}

/** The list row of a session: everything but the transcript and other per-turn state. */
function summaryOf(s: Session, bytes?: number): SessionSummary {
  const { id, title, createdAt, updatedAt, model, mode, plan, pinned, worktree, isolated, group, skills } = s;
  const usage = s.usage ? { ...s.usage, subagentTokens: s.usage.subagentTokens && { ...s.usage.subagentTokens } } : undefined;
  return { id, title, createdAt, updatedAt, model, mode, plan, messageCount: s.messages.length, pinned, worktree, isolated, group, skills, usage, bytes };
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

  constructor(ctx: vscode.ExtensionContext, private readonly log: vscode.LogOutputChannel) {
    const base = ctx.storageUri ?? ctx.globalStorageUri;
    this.dir = vscode.Uri.joinPath(base, 'sessions');
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
      this.loadedOk = true;
    } catch (e) {
      this.log.error(`Failed to load sessions: ${String(e)}`);
    }
    this._onDidChange.fire();
  }

  list(): SessionSummary[] {
    return [...this.index.values()].map((s) => ({ ...s })).sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || b.updatedAt - a.updatedAt);
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
      const s = JSON.parse(fs.readFileSync(path.join(this.dir.fsPath, `${id}.json`), 'utf8')) as Session;
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
      id: `s_${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`,
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
    s.messages = structuredClone(uptoIndex === undefined ? src.messages : src.messages.slice(0, uptoIndex + 1));
    s.attachments = [...src.attachments];
    this.save(s, true);
    return s;
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
    try {
      await vscode.workspace.fs.delete(vscode.Uri.joinPath(this.dir, `${id}.json`));
    } catch {
      /* already gone */
    }
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
    const candidates = [...this.index.values()].filter((s) => !s.pinned && !safe.has(s.id)).sort((a, b) => b.updatedAt - a.updatedAt);
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
        bytes += (await vscode.workspace.fs.stat(vscode.Uri.joinPath(this.dir, `${s.id}.json`))).size;
      } catch {
        bytes += JSON.stringify(this.sessions.get(s.id) ?? s).length;
      }
    }
    return { count: this.index.size, bytes, messages, oldest, inMemory: this.sessions.size };
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
