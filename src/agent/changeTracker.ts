import * as vscode from 'vscode';
import * as path from 'path';

export interface TrackedChange {
  sessionId: string;
  fsPath: string;
  /** Content before the agent's first modification in this session (undefined = file did not exist). */
  original?: string;
  changedAt: number;
}

const SCHEME = 'localpilot-original';

/**
 * Records the pre-edit snapshot of every file an agent touches so the user can review (diff),
 * keep, or undo changes per file or per agent session — Cursor/Copilot-style.
 */
export class ChangeTracker implements vscode.Disposable {
  private changes = new Map<string, TrackedChange>(); // key: sessionId|fsPath
  /** Per-session, per-turn snapshots of files before the first edit in that turn (for "Restore checkpoint"). */
  private turns = new Map<string, Map<number, Map<string, string | undefined>>>();
  private currentTurn = new Map<string, number>();
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;
  private readonly addedDeco: vscode.TextEditorDecorationType;
  private readonly modifiedDeco: vscode.TextEditorDecorationType;
  private readonly disposables: vscode.Disposable[] = [];

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
        provideTextDocumentContent: (uri) => this.changes.get(`${decodeURIComponent(uri.query)}|${uri.path}`)?.original ?? '',
      }),
      vscode.window.onDidChangeActiveTextEditor(() => this.decorateVisible()),
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (vscode.window.visibleTextEditors.some((ed) => ed.document === e.document)) {
          this.decorateVisible();
        }
      })
    );
  }

  /** The root session id for a (possibly nested) subagent session id. */
  static rootSession(sessionId: string): string {
    return sessionId.split('::')[0];
  }

  /** Snapshot a file before the agent modifies it (no-op if already tracked for this session). */
  async beforeChange(fsPath: string, sessionId: string): Promise<void> {
    const sid = ChangeTracker.rootSession(sessionId);
    const key = `${sid}|${fsPath}`;
    const turn = this.currentTurn.get(sid);
    const needTurnSnap = turn !== undefined && !this.turns.get(sid)?.get(turn)?.has(fsPath);
    if (this.changes.has(key) && !needTurnSnap) {
      return;
    }
    let current: string | undefined;
    try {
      const doc = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === fsPath);
      current = doc ? doc.getText() : Buffer.from(await vscode.workspace.fs.readFile(vscode.Uri.file(fsPath))).toString('utf8');
    } catch {
      current = undefined;
    }
    if (needTurnSnap) {
      const byTurn = this.turns.get(sid) ?? new Map();
      const files = byTurn.get(turn!) ?? new Map<string, string | undefined>();
      files.set(fsPath, current);
      byTurn.set(turn!, files);
      this.turns.set(sid, byTurn);
    }
    if (!this.changes.has(key)) {
      this.changes.set(key, { sessionId: sid, fsPath, original: current, changedAt: Date.now() });
      this._onDidChange.fire();
      setTimeout(() => this.decorateVisible(), 300);
    }
  }

  /** Mark the start of a user turn (index of the user message) so edits can be rolled back to it. */
  beginTurn(sessionId: string, turn: number): void {
    this.currentTurn.set(ChangeTracker.rootSession(sessionId), turn);
  }

  /** Which turns of a session have file snapshots (i.e. are restorable checkpoints). */
  checkpoints(sessionId: string): number[] {
    return [...(this.turns.get(ChangeTracker.rootSession(sessionId))?.keys() ?? [])].sort((a, b) => a - b);
  }

  /** Revert every file touched in `turn` or later to its content at the start of the earliest such turn. */
  async restoreToTurn(sessionId: string, turn: number): Promise<number> {
    const sid = ChangeTracker.rootSession(sessionId);
    const byTurn = this.turns.get(sid);
    if (!byTurn) {
      return 0;
    }
    const earliest = new Map<string, string | undefined>();
    for (const t of [...byTurn.keys()].sort((a, b) => a - b)) {
      if (t < turn) {
        continue;
      }
      for (const [fsPath, content] of byTurn.get(t)!) {
        if (!earliest.has(fsPath)) {
          earliest.set(fsPath, content);
        }
      }
      byTurn.delete(t);
    }
    let n = 0;
    for (const [fsPath, content] of earliest) {
      const uri = vscode.Uri.file(fsPath);
      try {
        if (content === undefined) {
          await vscode.workspace.fs.delete(uri, { useTrash: true });
        } else {
          const doc = await vscode.workspace.openTextDocument(uri);
          const edit = new vscode.WorkspaceEdit();
          edit.replace(uri, new vscode.Range(0, 0, doc.lineCount, 0), content);
          await vscode.workspace.applyEdit(edit);
          await doc.save();
        }
        n++;
        const tracked = this.changes.get(`${sid}|${fsPath}`);
        if (tracked && tracked.original === content) {
          this.changes.delete(`${sid}|${fsPath}`);
        }
      } catch (e) {
        this.log.error(`checkpoint restore failed for ${fsPath}: ${String(e)}`);
      }
    }
    this._onDidChange.fire();
    this.decorateVisible();
    return n;
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

  /** Accept the change: forget the snapshot. */
  keep(sessionId: string, fsPath?: string): void {
    for (const [k, c] of this.changes) {
      if (c.sessionId === ChangeTracker.rootSession(sessionId) && (!fsPath || c.fsPath === fsPath)) {
        this.changes.delete(k);
      }
    }
    this._onDidChange.fire();
    this.decorateVisible();
  }

  /** Revert the file(s) to the snapshot taken before the agent touched them. */
  async undo(sessionId: string, fsPath?: string): Promise<number> {
    let n = 0;
    for (const c of this.forSession(sessionId)) {
      if (fsPath && c.fsPath !== fsPath) {
        continue;
      }
      const uri = vscode.Uri.file(c.fsPath);
      try {
        if (c.original === undefined) {
          await vscode.workspace.fs.delete(uri, { useTrash: true });
        } else {
          const edit = new vscode.WorkspaceEdit();
          const doc = await vscode.workspace.openTextDocument(uri);
          edit.replace(uri, new vscode.Range(0, 0, doc.lineCount, 0), c.original);
          await vscode.workspace.applyEdit(edit);
          await doc.save();
        }
        n++;
      } catch (e) {
        this.log.error(`undo failed for ${c.fsPath}: ${String(e)}`);
      }
      this.changes.delete(`${c.sessionId}|${c.fsPath}`);
    }
    this._onDidChange.fire();
    this.decorateVisible();
    return n;
  }

  /** Open a side-by-side diff of original vs current. */
  async showDiff(sessionId: string, fsPath: string): Promise<void> {
    const c = this.changes.get(`${ChangeTracker.rootSession(sessionId)}|${fsPath}`);
    if (!c) {
      return;
    }
    const left = vscode.Uri.from({ scheme: SCHEME, path: fsPath, query: encodeURIComponent(c.sessionId) });
    const title = `${path.basename(fsPath)} (original ↔ LocalPilot)`;
    await vscode.commands.executeCommand('vscode.diff', left, vscode.Uri.file(fsPath), title, { preview: true });
  }

  /** Highlight lines that differ from the snapshot in all visible editors. */
  private decorateVisible(): void {
    for (const ed of vscode.window.visibleTextEditors) {
      const tracked = [...this.changes.values()].find((c) => c.fsPath === ed.document.uri.fsPath);
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
    this.disposables.forEach((d) => d.dispose());
    this.addedDeco.dispose();
    this.modifiedDeco.dispose();
    this._onDidChange.dispose();
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
