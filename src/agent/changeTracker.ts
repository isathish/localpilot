import * as vscode from 'vscode';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { deleteUri } from '../tools/fs';
import { recordEditDecision } from '../telemetry/catalog';
import { checkpointFile, CheckpointKind } from './checkpoints';
import { registerProposedContent } from '../ui/editPreview';

/** Same file: VS Code reports Windows drive letters in lower case and Windows paths are case-insensitive. */
const samePath = (a: string, b: string): boolean => (process.platform === 'win32' ? vscode.Uri.file(a).fsPath.toLowerCase() === vscode.Uri.file(b).fsPath.toLowerCase() : a === b);

export interface TrackedChange {
  sessionId: string;
  fsPath: string;
  /** Content before the agent's first modification in this session (undefined = file did not exist). */
  original?: string;
  changedAt: number;
}

/** A file the user accepted or rejected, listed in the review queue (until the next turn or Clear reviewed). */
export interface ReviewedFile {
  fsPath: string;
  state: 'accepted' | 'rejected';
  /** What the change was when it was reviewed: created, edited or deleted by the agent. */
  kind: 'create' | 'modify' | 'delete';
  at: number;
  /** The reject's redo token (rejected files only). */
  token?: number;
  /** The tracked change itself, so an Undo of the review can put it back. */
  change: TrackedChange;
}

/** A review row as the chat lists it: `redoUntil` is when Restore edits stops working (absent once it has). */
export interface ReviewedRow {
  fsPath: string;
  state: 'accepted' | 'rejected';
  kind: 'create' | 'modify' | 'delete';
  redoUntil?: number;
}

const SCHEME = 'localpilot-original';
/** Reviewed rows kept per chat; the oldest drop off first. */
const MAX_REVIEWED = 200;
/** Files above this size get no +/− line counts (the diff would cost more than the number is worth). */
const MAX_STAT_CHARS = 1024 * 1024;
/** Before-contents larger than this stay in memory only (same limit as untracked files in git checkpoints). */
const MAX_PERSISTED_CHARS = 20 * 1024 * 1024;
/** How long the agent's version of rejected files is kept so the toast's Undo can put it back. */
export const REDO_WINDOW_MS = 5 * 60_000;

/**
 * Records the pre-edit snapshot of every file an agent touches so the user can review (diff),
 * keep, or undo changes per file or per agent session — Cursor/Copilot-style.
 */
export class ChangeTracker implements vscode.Disposable {
  private changes = new Map<string, TrackedChange>(); // key: sessionId|fsPath
  /** Per-session, per-turn snapshots of files before the first edit in that turn (for "Restore checkpoint"). */
  private turns = new Map<string, Map<number, Map<string, string | undefined>>>();
  private currentTurn = new Map<string, number>();
  /** Sessions whose persisted turn snapshots were read back from disk. */
  private loadedTurns = new Set<string>();
  /**
   * Where turn snapshots are persisted (`<dir>/<session>/<turn>/<sha1 of path>.json`, one file per snapshot, written
   * once), so Restore checkpoint survives a reload; unset = memory only.
   */
  persistDir?: string;
  /** Pending snapshot writes and deletes per session, run in order. */
  private io = new Map<string, Promise<void>>();
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;
  private readonly addedDeco: vscode.TextEditorDecorationType;
  private readonly modifiedDeco: vscode.TextEditorDecorationType;
  private readonly disposables: vscode.Disposable[] = [];
  /** Per reject (keyed by the token {@link reject} returns): the files it reverted, with the content they had just before it. */
  private redoBuf = new Map<number, { entries: { change: TrackedChange; content: string | undefined }[]; until: number; timer: ReturnType<typeof setTimeout> }>();
  private redoSeq = 0;
  /** Per session: files accepted or rejected since the session's current turn began. */
  private reviewed = new Map<string, ReviewedFile[]>();
  /** +/− line counts by file, valid while the file's size and mtime and the original's length stay the same. */
  private statCache = new Map<string, { sig: string; added: number; removed: number }>();
  /** Clock for the redo window; tests replace it. */
  now: () => number = () => Date.now();

  constructor(private readonly log: vscode.LogOutputChannel) {
    this.addedDeco = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      backgroundColor: new vscode.ThemeColor('diffEditor.insertedLineBackground'),
      overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.addedForeground'),
      overviewRulerLane: vscode.OverviewRulerLane.Left,
    });
    this.modifiedDeco = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      backgroundColor: new vscode.ThemeColor('diffEditor.insertedTextBackground'),
      overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.modifiedForeground'),
      overviewRulerLane: vscode.OverviewRulerLane.Left,
    });
    this.disposables.push(
      vscode.workspace.registerTextDocumentContentProvider(SCHEME, {
        provideTextDocumentContent: (uri) => this.leftContent(uri),
      }),
      // Both sides of the diff an edit tool opens before its approval (localpilot.diffPreview).
      registerProposedContent(),
      vscode.window.onDidChangeActiveTextEditor(() => {
        this.decorateVisible();
        this.syncReviewContext();
      }),
      vscode.window.tabGroups.onDidChangeTabs(() => this.syncReviewContext()),
      this._onDidChange.event(() => this.syncReviewContext()),
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (vscode.window.visibleTextEditors.some((ed) => ed.document === e.document)) {
          this.decorateVisible();
        }
      })
    );
  }

  /**
   * Left side of a diff: `sid=` the session's original, `sid=&turn=` the content before that turn, `ref=&root=&kind=`
   * the file in a git checkpoint (a bare query is the session id, as older diff tabs used).
   */
  private leftContent(uri: vscode.Uri): string | Promise<string> {
    if (!uri.query.includes('=')) {
      return this.changes.get(`${decodeURIComponent(uri.query)}|${uri.path}`)?.original ?? '';
    }
    const q = new URLSearchParams(uri.query);
    const ref = q.get('ref');
    const root = q.get('root');
    if (ref && root) {
      return checkpointFile(root, ref, (q.get('kind') as CheckpointKind | null) ?? 'commit', uri.fsPath).catch(() => '');
    }
    if (q.get('empty') === '1') {
      return ''; // the right side of a deleted file's diff
    }
    const sid = q.get('sid') ?? '';
    const turn = q.get('turn');
    return (turn !== null ? this.turnOriginals(sid, Number(turn)).get(uri.path) : this.changes.get(`${sid}|${uri.path}`)?.original) ?? '';
  }

  /** Diff-editor URI for the content of `fsPath` before the session (no `turn`) or before `turn`. */
  static originalUri(sessionId: string, fsPath: string, turn?: number): vscode.Uri {
    const q = new URLSearchParams({ sid: ChangeTracker.rootSession(sessionId), ...(turn !== undefined ? { turn: String(turn) } : {}) });
    return vscode.Uri.from({ scheme: SCHEME, path: fsPath, query: q.toString() });
  }

  /** Diff-editor URI for the content of `fsPath` in a git checkpoint. */
  static checkpointUri(root: string, sha: string, kind: CheckpointKind, fsPath: string): vscode.Uri {
    return vscode.Uri.from({ scheme: SCHEME, path: fsPath, query: new URLSearchParams({ ref: sha, root, kind }).toString() });
  }

  /** The root session id for a (possibly nested) subagent session id. */
  static rootSession(sessionId: string): string {
    return sessionId.split('::')[0];
  }

  /** Snapshot a file before the agent modifies it (no-op if already tracked for this session). */
  async beforeChange(fsPath: string, sessionId: string): Promise<void> {
    const sid = ChangeTracker.rootSession(sessionId);
    this.loadPersisted(sid);
    const key = `${sid}|${fsPath}`;
    const turn = this.currentTurn.get(sid);
    const needTurnSnap = turn !== undefined && !this.turns.get(sid)?.get(turn)?.has(fsPath);
    if (this.changes.has(key) && !needTurnSnap) {
      return;
    }
    // Directories have no text snapshot: tracking one would list it as added and undo would claim to revert it.
    const stat = await Promise.resolve(vscode.workspace.fs.stat(vscode.Uri.file(fsPath))).catch(() => undefined);
    if (stat && stat.type & vscode.FileType.Directory) {
      return;
    }
    let current: string | undefined;
    const open = vscode.workspace.textDocuments.find((d) => samePath(d.uri.fsPath, fsPath));
    if (open) {
      current = open.getText();
    } else {
      // Decode with the encoding VS Code will save it back with on undo/restore; utf8 for what it will not open.
      try {
        current = (await vscode.workspace.openTextDocument(vscode.Uri.file(fsPath))).getText();
      } catch {
        try {
          current = Buffer.from(await vscode.workspace.fs.readFile(vscode.Uri.file(fsPath))).toString('utf8').replace(/^\uFEFF/, '');
        } catch {
          current = undefined;
        }
      }
    }
    if (needTurnSnap) {
      const byTurn = this.turns.get(sid) ?? new Map();
      const files = byTurn.get(turn!) ?? new Map<string, string | undefined>();
      files.set(fsPath, current);
      byTurn.set(turn!, files);
      this.turns.set(sid, byTurn);
      this.persistFile(sid, turn!, fsPath, current);
    }
    if (!this.changes.has(key)) {
      this.changes.set(key, { sessionId: sid, fsPath, original: current, changedAt: Date.now() });
      this._onDidChange.fire();
      setTimeout(() => this.decorateVisible(), 300);
    }
  }

  /** Mark the start of a user turn (index of the user message) so edits can be rolled back to it. */
  beginTurn(sessionId: string, turn: number): void {
    const sid = ChangeTracker.rootSession(sessionId);
    this.currentTurn.set(sid, turn);
    // The review queue lists what the user decided since the last message; a new message starts a fresh list.
    if (this.reviewed.delete(sid)) {
      this._onDidChange.fire();
    }
  }

  /** Release everything held for a session (it was deleted): pending changes stay on disk as they are, snapshots go. */
  forget(sessionId: string): void {
    const sid = ChangeTracker.rootSession(sessionId);
    for (const [k, c] of this.changes) {
      if (c.sessionId === sid) {
        this.changes.delete(k);
      }
    }
    this.turns.delete(sid);
    this.currentTurn.delete(sid);
    this.loadedTurns.delete(sid);
    this.reviewed.delete(sid);
    const dir = this.turnDir(sid);
    if (dir) {
      this.queue(sid, () => fs.promises.rm(dir, { recursive: true, force: true }));
    }
    this._onDidChange.fire();
    this.decorateVisible();
  }

  /** Drop the checkpoint snapshots of `turn` and later (those messages were removed, so nothing can restore them). */
  dropTurnsFrom(sessionId: string, turn: number): void {
    const sid = ChangeTracker.rootSession(sessionId);
    this.loadPersisted(sid);
    const byTurn = this.turns.get(sid);
    for (const t of [...(byTurn?.keys() ?? [])]) {
      if (t >= turn) {
        byTurn!.delete(t);
        this.unpersist(sid, t);
      }
    }
    this._onDidChange.fire();
  }

  /** Which turns of a session have file snapshots (i.e. are restorable checkpoints). */
  checkpoints(sessionId: string): number[] {
    const sid = ChangeTracker.rootSession(sessionId);
    this.loadPersisted(sid);
    return [...(this.turns.get(sid)?.keys() ?? [])].sort((a, b) => a - b);
  }

  /** The turn key last passed to beginTurn for a session. */
  currentTurnOf(sessionId: string): number | undefined {
    return this.currentTurn.get(ChangeTracker.rootSession(sessionId));
  }

  private turnDir(sid: string): string | undefined {
    return this.persistDir ? path.join(this.persistDir, sid.replace(/[^A-Za-z0-9_-]/g, '_')) : undefined;
  }

  /** Resolves once every pending snapshot write and delete has reached the disk. */
  async flush(): Promise<void> {
    await Promise.all([...this.io.values()]);
  }

  private queue(sid: string, op: () => Promise<unknown>): void {
    const next = (this.io.get(sid) ?? Promise.resolve())
      .then(op)
      .then(
        () => undefined,
        (e) => this.log.warn(`checkpoint snapshot I/O for ${sid}: ${String(e)}`)
      );
    this.io.set(sid, next);
    void next.then(() => {
      if (this.io.get(sid) === next) {
        this.io.delete(sid);
      }
    });
  }

  private static snapFile(fsPath: string): string {
    return `${crypto.createHash('sha1').update(fsPath).digest('hex')}.json`;
  }

  /** Persists one file's before-content of a turn (written once, asynchronously). */
  private persistFile(sid: string, turn: number, fsPath: string, content: string | undefined): void {
    const dir = this.turnDir(sid);
    if (!dir) {
      return;
    }
    if (content !== undefined && content.length > MAX_PERSISTED_CHARS) {
      this.log.warn(`checkpoint ${turn}: ${fsPath} is too large to persist; it can be restored only until the window reloads`);
      return;
    }
    const tdir = path.join(dir, String(turn));
    const body = JSON.stringify({ path: fsPath, content: content ?? null });
    this.queue(sid, async () => {
      await fs.promises.mkdir(tdir, { recursive: true });
      await fs.promises.writeFile(path.join(tdir, ChangeTracker.snapFile(fsPath)), body);
    });
  }

  /** Deletes the persisted snapshots of a turn: all of them, or only those of `paths`. */
  private unpersist(sid: string, turn: number, paths?: string[]): void {
    const dir = this.turnDir(sid);
    if (!dir) {
      return;
    }
    const tdir = path.join(dir, String(turn));
    this.queue(sid, async () => {
      await fs.promises.rm(path.join(dir, `${turn}.json`), { force: true });
      if (!paths) {
        await fs.promises.rm(tdir, { recursive: true, force: true });
        return;
      }
      for (const p of paths) {
        await fs.promises.rm(path.join(tdir, ChangeTracker.snapFile(p)), { force: true });
      }
      await fs.promises.rmdir(tdir).catch(() => undefined);
    });
  }

  /** Reads a session's persisted turn snapshots once (after a reload); snapshots taken since win over the disk copy. */
  private loadPersisted(sid: string): void {
    const dir = this.turnDir(sid);
    if (!dir || this.loadedTurns.has(sid)) {
      return;
    }
    this.loadedTurns.add(sid);
    let names: string[];
    try {
      names = fs.readdirSync(dir);
    } catch {
      return;
    }
    const byTurn = this.turns.get(sid) ?? new Map<number, Map<string, string | undefined>>();
    const add = (turn: number, p: unknown, c: unknown) => {
      if (typeof p !== 'string') {
        return;
      }
      const files = byTurn.get(turn) ?? new Map<string, string | undefined>();
      if (!files.has(p)) {
        files.set(p, typeof c === 'string' ? c : undefined);
      }
      byTurn.set(turn, files);
    };
    for (const name of names) {
      const full = path.join(dir, name);
      try {
        if (/^\d+$/.test(name)) {
          for (const f of fs.readdirSync(full).filter((n) => n.endsWith('.json'))) {
            try {
              const raw = JSON.parse(fs.readFileSync(path.join(full, f), 'utf8')) as { path?: unknown; content?: unknown };
              add(Number(name), raw.path, raw.content);
            } catch (e) {
              this.log.warn(`unreadable checkpoint ${path.join(full, f)}: ${String(e)}`);
            }
          }
        } else if (/^\d+\.json$/.test(name)) {
          // Earlier layout (one JSON per turn): moved to one file per snapshot.
          const turn = Number(name.slice(0, -5));
          const raw = JSON.parse(fs.readFileSync(full, 'utf8')) as { files?: [string, string | null][] };
          for (const [p, c] of raw.files ?? []) {
            if (typeof p === 'string' && !byTurn.get(turn)?.has(p)) {
              add(turn, p, c);
              this.persistFile(sid, turn, p, typeof c === 'string' ? c : undefined);
            }
          }
          this.queue(sid, () => fs.promises.rm(full, { force: true }));
        }
      } catch (e) {
        this.log.warn(`unreadable checkpoint ${full}: ${String(e)}`);
      }
    }
    if (byTurn.size) {
      this.turns.set(sid, byTurn);
    }
  }

  /** Every file touched in `turn` or later, with its content at the start of the earliest such turn (undefined = did not exist). */
  turnOriginals(sessionId: string, turn: number): Map<string, string | undefined> {
    const sid = ChangeTracker.rootSession(sessionId);
    this.loadPersisted(sid);
    const byTurn = this.turns.get(sid);
    const earliest = new Map<string, string | undefined>();
    for (const t of [...(byTurn?.keys() ?? [])].filter((k) => k >= turn).sort((a, b) => a - b)) {
      for (const [fsPath, content] of byTurn!.get(t)!) {
        if (!earliest.has(fsPath)) {
          earliest.set(fsPath, content);
        }
      }
    }
    return earliest;
  }

  /** After files were put back by other means (a git checkpoint): pending changes that now match their original are settled. */
  async settle(sessionId: string): Promise<void> {
    let n = 0;
    for (const c of this.forSession(sessionId)) {
      const now = await fs.promises.readFile(c.fsPath, 'utf8').then(
        (t) => t.replace(/^\uFEFF/, ''),
        () => undefined
      );
      if (now === c.original) {
        this.changes.delete(`${c.sessionId}|${c.fsPath}`);
        n++;
      }
    }
    if (n) {
      this._onDidChange.fire();
      this.decorateVisible();
    }
  }

  /** Revert every file touched in `turn` or later to its content at the start of the earliest such turn. */
  async restoreToTurn(sessionId: string, turn: number): Promise<number> {
    return (await this.restoreTurn(sessionId, turn)).restored;
  }

  /**
   * {@link restoreToTurn}, also reporting how many files could not be restored (their snapshots are kept for a retry).
   * With `only`, just the files it accepts are restored; the other snapshots are left as they are.
   */
  async restoreTurn(sessionId: string, turn: number, only?: (fsPath: string) => boolean): Promise<{ restored: number; failed: number }> {
    const sid = ChangeTracker.rootSession(sessionId);
    this.loadPersisted(sid);
    const byTurn = this.turns.get(sid);
    if (!byTurn) {
      return { restored: 0, failed: 0 };
    }
    const turns = [...byTurn.keys()].filter((t) => t >= turn).sort((a, b) => a - b);
    const earliest = this.turnOriginals(sid, turn);
    let n = 0;
    const failed = new Set<string>();
    const kept = new Set<string>();
    for (const [fsPath, content] of earliest) {
      if (only && !only(fsPath)) {
        kept.add(fsPath);
        continue;
      }
      try {
        await restoreFile(vscode.Uri.file(fsPath), content);
        n++;
        const tracked = this.changes.get(`${sid}|${fsPath}`);
        if (tracked && tracked.original === content) {
          this.changes.delete(`${sid}|${fsPath}`);
        }
      } catch (e) {
        failed.add(fsPath);
        this.log.error(`checkpoint restore failed for ${fsPath}: ${String(e)}`);
      }
    }
    // Snapshots of files that could not be restored stay, so the checkpoint can be retried.
    for (const t of turns) {
      const files = byTurn.get(t)!;
      const restored = [...files.keys()].filter((p) => !failed.has(p) && !kept.has(p));
      restored.forEach((p) => files.delete(p));
      if (!files.size) {
        byTurn.delete(t);
        this.unpersist(sid, t);
      } else {
        this.unpersist(sid, t, restored);
      }
    }
    this._onDidChange.fire();
    this.decorateVisible();
    return { restored: n, failed: failed.size };
  }

  forSession(sessionId: string): TrackedChange[] {
    return [...this.changes.values()].filter((c) => c.sessionId === ChangeTracker.rootSession(sessionId)).sort((a, b) => a.fsPath.localeCompare(b.fsPath));
  }

  all(): TrackedChange[] {
    return [...this.changes.values()];
  }

  get count(): number {
    return this.changes.size;
  }

  /** Changes paired with their unsaved editor text, so unsaved edits (Ctrl+I) are measured rather than the disk copy. */
  private withLiveText(changes: TrackedChange[]): { fsPath: string; original?: string; live?: string }[] {
    return changes.map((c) => ({ fsPath: c.fsPath, original: c.original, live: vscode.workspace.textDocuments.find((d) => d.isDirty && samePath(d.uri.fsPath, c.fsPath))?.getText() }));
  }

  /** Accept the change: forget the snapshot. */
  keep(sessionId: string, fsPath?: string, record = true): void {
    const kept: TrackedChange[] = [];
    for (const [k, c] of this.changes) {
      if (c.sessionId === ChangeTracker.rootSession(sessionId) && (!fsPath || c.fsPath === fsPath)) {
        this.changes.delete(k);
        kept.push(c);
      }
    }
    if (record) {
      void recordEditDecision('accepted', this.withLiveText(kept));
      this.noteReviewed(kept.map((c) => ({ fsPath: c.fsPath, state: 'accepted', kind: kindOf(c), at: this.now(), change: c })));
    }
    this._onDidChange.fire();
    this.decorateVisible();
  }

  /** Revert the file(s) to the snapshot taken before the agent touched them. */
  async undo(sessionId: string, fsPath?: string): Promise<number> {
    return (await this.reject(sessionId, fsPath)).count;
  }

  /** {@link undo}, plus a token that {@link redo} takes to put back exactly these files; each reject keeps its own window. */
  async reject(sessionId: string, fsPath?: string): Promise<{ count: number; token?: number }> {
    let n = 0;
    const undone = this.forSession(sessionId).filter((c) => !fsPath || c.fsPath === fsPath);
    // Measured before the files are rewritten.
    await recordEditDecision('rejected', this.withLiveText(undone));
    const redo: { change: TrackedChange; content: string | undefined }[] = [];
    const kinds = new Map<TrackedChange, ReviewedFile['kind']>();
    for (const c of undone) {
      try {
        kinds.set(c, kindOf(c));
        const content = await currentText(c.fsPath);
        await restoreFile(vscode.Uri.file(c.fsPath), c.original);
        n++;
        this.changes.delete(`${c.sessionId}|${c.fsPath}`);
        redo.push({ change: c, content });
      } catch (e) {
        this.log.error(`undo failed for ${c.fsPath}: ${String(e)}`);
      }
    }
    const token = redo.length ? this.setRedo(redo) : undefined;
    this.noteReviewed(redo.map(({ change }) => ({ fsPath: change.fsPath, state: 'rejected', kind: kinds.get(change) ?? 'modify', at: this.now(), token, change })));
    this._onDidChange.fire();
    this.decorateVisible();
    return { count: n, token };
  }

  private setRedo(entries: { change: TrackedChange; content: string | undefined }[]): number {
    const token = ++this.redoSeq;
    const timer = setTimeout(() => this.clearRedo(token), REDO_WINDOW_MS);
    timer.unref?.();
    this.redoBuf.set(token, { entries, until: this.now() + REDO_WINDOW_MS, timer });
    return token;
  }

  private clearRedo(token: number): void {
    const b = this.redoBuf.get(token);
    if (b) {
      clearTimeout(b.timer);
      this.redoBuf.delete(token);
    }
  }

  /**
   * Undo one reject (by its token) within {@link REDO_WINDOW_MS}: the agent's content goes back and the files are tracked
   * again. With `fsPath`, only that file comes back; the reject's other files stay restorable.
   */
  async redo(token: number, fsPath?: string): Promise<number> {
    const b = this.redoBuf.get(token);
    if (!b || this.now() > b.until) {
      this.clearRedo(token);
      return 0;
    }
    const take = fsPath ? b.entries.filter((e) => samePath(e.change.fsPath, fsPath)) : b.entries;
    if (!take.length) {
      return 0;
    }
    b.entries = b.entries.filter((e) => !take.includes(e));
    if (!b.entries.length) {
      this.clearRedo(token);
    }
    let n = 0;
    for (const { change, content } of take) {
      try {
        await restoreFile(vscode.Uri.file(change.fsPath), content);
        n++;
        const key = `${change.sessionId}|${change.fsPath}`;
        if (!this.changes.has(key)) {
          this.changes.set(key, change);
        }
        this.unreview(change.sessionId, change.fsPath);
      } catch (e) {
        this.log.error(`redo failed for ${change.fsPath}: ${String(e)}`);
      }
    }
    this._onDidChange.fire();
    this.decorateVisible();
    return n;
  }

  /** Records review decisions; a file reviewed again replaces its earlier row. */
  private noteReviewed(rows: ReviewedFile[]): void {
    for (const r of rows) {
      const sid = r.change.sessionId;
      const list = (this.reviewed.get(sid) ?? []).filter((x) => !samePath(x.fsPath, r.fsPath));
      list.push(r);
      this.reviewed.set(sid, list.slice(-MAX_REVIEWED));
    }
  }

  private unreview(sessionId: string, fsPath: string): void {
    const sid = ChangeTracker.rootSession(sessionId);
    const list = this.reviewed.get(sid);
    if (list) {
      this.reviewed.set(sid, list.filter((x) => !samePath(x.fsPath, fsPath)));
    }
  }

  /** The files accepted or rejected in a session since its current turn began, in the order they were reviewed. */
  reviewedFor(sessionId: string): ReviewedRow[] {
    return (this.reviewed.get(ChangeTracker.rootSession(sessionId)) ?? []).map((r) => {
      const b = r.token !== undefined ? this.redoBuf.get(r.token) : undefined;
      const restorable = !!b && b.until > this.now() && b.entries.some((e) => e.change === r.change);
      return { fsPath: r.fsPath, state: r.state, kind: r.kind, ...(restorable ? { redoUntil: b.until } : {}) };
    });
  }

  /** Restore edits on a rejected row: the agent's version of that one file comes back while the redo window holds it. */
  async restoreRejected(sessionId: string, fsPath: string): Promise<number> {
    const r = (this.reviewed.get(ChangeTracker.rootSession(sessionId)) ?? []).find((x) => x.state === 'rejected' && samePath(x.fsPath, fsPath));
    return r?.token !== undefined ? this.redo(r.token, r.fsPath) : 0;
  }

  /** Drops the reviewed rows of a session (Clear reviewed); the decisions themselves stand. */
  clearReviewed(sessionId: string): void {
    if (this.reviewed.delete(ChangeTracker.rootSession(sessionId))) {
      this._onDidChange.fire();
    }
  }

  /**
   * Takes back the review decisions of a session: accepted files are tracked again (their diff and Accept / Reject come
   * back), rejected files get the agent's edits back while the redo window holds them. `expired` counts those it could not.
   */
  async undoReview(sessionId: string): Promise<{ accepted: number; rejected: number; expired: number }> {
    const sid = ChangeTracker.rootSession(sessionId);
    const rows = [...(this.reviewed.get(sid) ?? [])];
    let accepted = 0;
    let rejected = 0;
    let expired = 0;
    for (const r of rows) {
      if (r.state === 'accepted') {
        const key = `${sid}|${r.change.fsPath}`;
        if (!this.changes.has(key)) {
          this.changes.set(key, r.change);
          accepted++;
        }
        this.unreview(sid, r.fsPath);
      } else if (r.token !== undefined && (await this.redo(r.token, r.fsPath))) {
        rejected++;
      } else {
        expired++;
      }
    }
    this._onDidChange.fire();
    this.decorateVisible();
    return { accepted, rejected, expired };
  }

  /** +/− line counts of a tracked change against the file now (cached by size and mtime; undefined for huge or unreadable files). */
  async lineStats(c: TrackedChange): Promise<{ added: number; removed: number } | undefined> {
    const st = await fs.promises.stat(c.fsPath).catch(() => undefined);
    if (!st) {
      return c.original === undefined ? undefined : { added: 0, removed: c.original === '' ? 0 : c.original.split('\n').length };
    }
    if (st.size > MAX_STAT_CHARS || (c.original?.length ?? 0) > MAX_STAT_CHARS) {
      return undefined;
    }
    const key = `${c.sessionId}|${c.fsPath}`;
    const sig = `${st.size}:${st.mtimeMs}:${c.original?.length ?? -1}`;
    const hit = this.statCache.get(key);
    if (hit && hit.sig === sig) {
      return { added: hit.added, removed: hit.removed };
    }
    const now = await fs.promises.readFile(c.fsPath, 'utf8').catch(() => undefined);
    if (now === undefined) {
      return undefined;
    }
    const a = c.original === undefined || c.original === '' ? [] : c.original.split('\n');
    const b = now === '' ? [] : now.replace(/^\uFEFF/, '').split('\n');
    const d = diffLines(a, b);
    const added = d.added.length + d.modified.length;
    const removed = Math.max(0, a.length - (b.length - added));
    if (this.statCache.size > 500) {
      this.statCache.clear();
    }
    this.statCache.set(key, { sig, added, removed });
    return { added, removed };
  }

  /** The tracked change shown in the active editor tab, when it is one of our review diffs. */
  activeReview(): { sessionId: string; fsPath: string } | undefined {
    const input = vscode.window.tabGroups.activeTabGroup?.activeTab?.input as unknown;
    if (!input || !(input instanceof vscode.TabInputTextDiff) || input.original.scheme !== SCHEME) {
      return undefined;
    }
    const q = input.original.query.includes('=') ? new URLSearchParams(input.original.query) : undefined;
    if (q && (q.has('ref') || q.has('turn'))) {
      return undefined; // a checkpoint or turn diff, not the review of a pending change
    }
    const sid = q ? (q.get('sid') ?? '') : decodeURIComponent(input.original.query);
    const fsPath = input.modified.scheme === 'file' ? input.modified.fsPath : input.original.path;
    const c = this.forSession(sid).find((x) => samePath(x.fsPath, fsPath) || samePath(x.fsPath, input.original.path));
    return c ? { sessionId: c.sessionId, fsPath: c.fsPath } : undefined;
  }

  private reviewing: boolean | undefined;
  /** `localpilot.reviewing`: the active tab is the diff of a change still waiting for Accept / Reject (drives the title-bar actions). */
  private syncReviewContext(): void {
    const on = !!this.activeReview();
    if (on !== this.reviewing) {
      this.reviewing = on;
      void vscode.commands.executeCommand('setContext', 'localpilot.reviewing', on);
    }
  }

  /**
   * Open a side-by-side diff of original vs current; the right side is the file itself, so it can be edited before
   * accepting. A deleted file shows its original against an empty, read-only side.
   */
  async showDiff(sessionId: string, fsPath: string): Promise<boolean> {
    const c = this.changes.get(`${ChangeTracker.rootSession(sessionId)}|${fsPath}`) ?? this.forSession(sessionId).find((x) => samePath(x.fsPath, fsPath));
    if (!c) {
      return false;
    }
    const left = ChangeTracker.originalUri(c.sessionId, c.fsPath);
    const deleted = c.original !== undefined && !fs.existsSync(c.fsPath);
    const right = deleted ? vscode.Uri.from({ scheme: SCHEME, path: c.fsPath, query: new URLSearchParams({ sid: c.sessionId, empty: '1' }).toString() }) : vscode.Uri.file(c.fsPath);
    const title = `${path.basename(c.fsPath)}: original ↔ LocalPilot ${deleted ? '(deleted)' : '(editable)'}`;
    await vscode.commands.executeCommand('vscode.diff', left, right, title, { preview: true });
    this.syncReviewContext();
    return true;
  }

  /** Highlight lines that differ from the snapshot in all visible editors. */
  private decorateVisible(): void {
    for (const ed of vscode.window.visibleTextEditors) {
      const tracked = [...this.changes.values()].find((c) => samePath(c.fsPath, ed.document.uri.fsPath));
      if (!tracked) {
        ed.setDecorations(this.addedDeco, []);
        ed.setDecorations(this.modifiedDeco, []);
        continue;
      }
      const { added, modified } = diffLines((tracked.original ?? '').split('\n'), ed.document.getText().split('\n'));
      ed.setDecorations(this.addedDeco, added.map((l) => ed.document.lineAt(Math.min(l, ed.document.lineCount - 1)).range));
      ed.setDecorations(this.modifiedDeco, modified.map((l) => ed.document.lineAt(Math.min(l, ed.document.lineCount - 1)).range));
    }
  }

  dispose(): void {
    [...this.redoBuf.keys()].forEach((t) => this.clearRedo(t));
    this.disposables.forEach((d) => d.dispose());
    this.addedDeco.dispose();
    this.modifiedDeco.dispose();
    this._onDidChange.dispose();
  }
}

/** What a tracked change is right now: a file the agent created, edited, or deleted. */
export function kindOf(c: TrackedChange): 'create' | 'modify' | 'delete' {
  return c.original === undefined ? 'create' : fs.existsSync(c.fsPath) ? 'modify' : 'delete';
}

/** A file's text as the user sees it (unsaved editor text over the disk copy), or undefined when it does not exist. */
async function currentText(fsPath: string): Promise<string | undefined> {
  const dirty = vscode.workspace.textDocuments.find((d) => d.isDirty && samePath(d.uri.fsPath, fsPath));
  if (dirty) {
    return dirty.getText();
  }
  try {
    return Buffer.from(await vscode.workspace.fs.readFile(vscode.Uri.file(fsPath))).toString('utf8').replace(/^\uFEFF/, '');
  } catch {
    return undefined;
  }
}

/** Put a file back to `content` (undefined = it did not exist): recreated when it was deleted since. */
async function restoreFile(uri: vscode.Uri, content: string | undefined): Promise<void> {
  const exists = await Promise.resolve(vscode.workspace.fs.stat(uri)).then(
    () => true,
    () => false
  );
  if (content === undefined) {
    if (exists) {
      await deleteUri(uri);
    }
  } else if (!exists) {
    await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf8'));
  } else {
    const doc = await vscode.workspace.openTextDocument(uri);
    const edit = new vscode.WorkspaceEdit();
    edit.replace(uri, new vscode.Range(0, 0, doc.lineCount, 0), content);
    await vscode.workspace.applyEdit(edit);
    await doc.save();
    // The document may not have caught up with a change made on disk (a tool, a terminal, another process): the edit
    // is then a no-op on the stale text and save() writes nothing. The disk decides; write the snapshot directly.
    const disk = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
    if (disk !== content) {
      await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf8'));
    }
  }
}

/**
 * Line diff: returns indices (in `b`) of lines that are new or changed. Uses LCS when the inputs are
 * small enough, otherwise a cheap prefix/suffix trim so huge files still get a usable highlight.
 */
export function diffLines(a: string[], b: string[]): { added: number[]; modified: number[] } {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) {
    start++;
  }
  let endA = a.length - 1;
  let endB = b.length - 1;
  while (endA >= start && endB >= start && a[endA] === b[endB]) {
    endA--;
    endB--;
  }
  const midA = a.slice(start, endA + 1);
  const midB = b.slice(start, endB + 1);
  const added: number[] = [];
  const modified: number[] = [];
  if (midA.length * midB.length > 4_000_000) {
    for (let i = 0; i < midB.length; i++) {
      (i < midA.length ? modified : added).push(start + i);
    }
    return { added, modified };
  }
  const n = midA.length;
  const m = midB.length;
  const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = midA[i] === midB[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  let i = 0;
  let j = 0;
  let pendingRemoved = 0;
  while (i < n && j < m) {
    if (midA[i] === midB[j]) {
      i++;
      j++;
      pendingRemoved = 0;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      i++;
      pendingRemoved++;
    } else {
      (pendingRemoved > 0 ? modified : added).push(start + j);
      if (pendingRemoved > 0) {
        pendingRemoved--;
      }
      j++;
    }
  }
  while (j < m) {
    added.push(start + j++);
  }
  return { added, modified };
}
