import * as vscode from 'vscode';
import { Session, SessionSummary } from '../types';

/**
 * Persists chat sessions as individual JSON files under the extension's workspace storage
 * (so sessions are scoped to the workspace, like Copilot/Claude Code). Multiple sessions can be
 * active and streaming at the same time; the store only cares about persistence.
 */
export class SessionStore implements vscode.Disposable {
  private sessions = new Map<string, Session>();
  private readonly dir: vscode.Uri;
  private saveTimers = new Map<string, NodeJS.Timeout>();
  private changeTimer?: NodeJS.Timeout;
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;

  constructor(ctx: vscode.ExtensionContext, private readonly log: vscode.LogOutputChannel) {
    const base = ctx.storageUri ?? ctx.globalStorageUri;
    this.dir = vscode.Uri.joinPath(base, 'sessions');
  }

  async load(): Promise<void> {
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
          if (s?.id) {
            this.sessions.set(s.id, s);
          }
        } catch (e) {
          this.log.warn(`Skipping corrupt session file ${name}: ${String(e)}`);
        }
      }
    } catch (e) {
      this.log.error(`Failed to load sessions: ${String(e)}`);
    }
    this._onDidChange.fire();
  }

  list(): SessionSummary[] {
    return [...this.sessions.values()]
      .map(({ messages: _m, ...rest }) => ({ ...rest, messageCount: _m.length }))
      .sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || b.updatedAt - a.updatedAt);
  }

  get(id: string): Session | undefined {
    return this.sessions.get(id);
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
    const src = this.sessions.get(id);
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
    const s = this.sessions.get(id);
    if (s) {
      s.title = title.slice(0, 120);
      this.save(s, true);
    }
  }

  togglePin(id: string): void {
    const s = this.sessions.get(id);
    if (s) {
      s.pinned = !s.pinned;
      this.save(s, true);
    }
  }

  async delete(id: string): Promise<void> {
    this.sessions.delete(id);
    try {
      await vscode.workspace.fs.delete(vscode.Uri.joinPath(this.dir, `${id}.json`));
    } catch {
      /* already gone */
    }
    this._onDidChange.fire();
  }

  async clearAll(): Promise<void> {
    for (const id of [...this.sessions.keys()]) {
      await this.delete(id);
    }
  }

  /** Delete every session except the given ids (running or pinned chats survive "Clear chat history"). */
  async clearExcept(keep: Iterable<string>): Promise<number> {
    const keepSet = new Set(keep);
    let n = 0;
    for (const id of [...this.sessions.keys()]) {
      if (!keepSet.has(id)) {
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
    const candidates = [...this.sessions.values()].filter((s) => !s.pinned && !safe.has(s.id)).sort((a, b) => b.updatedAt - a.updatedAt);
    const extra = candidates.slice(max);
    for (const s of extra) {
      await this.delete(s.id);
    }
    return extra.length;
  }

  /** Storage footprint of the session files (for the Settings → Memory page). */
  async stats(): Promise<{ count: number; bytes: number; messages: number; oldest?: number }> {
    let bytes = 0;
    let messages = 0;
    let oldest: number | undefined;
    for (const s of this.sessions.values()) {
      messages += s.messages.length;
      oldest = oldest === undefined ? s.createdAt : Math.min(oldest, s.createdAt);
      try {
        bytes += (await vscode.workspace.fs.stat(vscode.Uri.joinPath(this.dir, `${s.id}.json`))).size;
      } catch {
        bytes += JSON.stringify(s).length;
      }
    }
    return { count: this.sessions.size, bytes, messages, oldest };
  }

  /** Debounced write so streaming turns do not hammer the disk. `immediate` notifies listeners right away (new / renamed / pinned chat). */
  save(s: Session, immediate = false): void {
    s.updatedAt = Date.now();
    s.messageCount = s.messages.length;
    if (s.title === 'New chat') {
      const firstUser = s.messages.find((m) => m.role === 'user');
      if (firstUser) {
        s.title = firstUser.content.replace(/\s+/g, ' ').trim().slice(0, 60) || 'New chat';
      }
    }
    clearTimeout(this.saveTimers.get(s.id));
    this.saveTimers.set(
      s.id,
      setTimeout(() => void this.flush(s), 400)
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

  async flush(s: Session): Promise<void> {
    try {
      await vscode.workspace.fs.createDirectory(this.dir);
      await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(this.dir, `${s.id}.json`), Buffer.from(JSON.stringify(s), 'utf8'));
    } catch (e) {
      this.log.error(`Failed to save session ${s.id}: ${String(e)}`);
    }
  }

  async exportMarkdown(id: string): Promise<string> {
    const s = this.sessions.get(id);
    if (!s) {
      return '';
    }
    const lines = [`# ${s.title}`, `_Model: ${s.model} · ${new Date(s.createdAt).toLocaleString()}_`, ''];
    for (const m of s.messages) {
      if (m.role === 'tool') {
        lines.push(`<details><summary>Tool result: ${m.toolName}</summary>\n\n\`\`\`\n${m.content.slice(0, 4000)}\n\`\`\`\n</details>\n`);
      } else {
        lines.push(`### ${m.role === 'user' ? 'You' : 'LocalPilot'}\n\n${m.content}\n`);
        for (const tc of m.toolCalls ?? []) {
          lines.push(`> **tool** \`${tc.name}(${tc.arguments.slice(0, 200)})\`\n`);
        }
      }
    }
    return lines.join('\n');
  }

  dispose(): void {
    for (const [, t] of this.saveTimers) {
      clearTimeout(t);
    }
    clearTimeout(this.changeTimer);
    this._onDidChange.dispose();
  }
}
