import * as vscode from 'vscode';
import { TREE_EXCLUDE } from './workspaceContext';
import { foldersOf, MentionEntry, MentionHit, rankMentions } from './mentionSearch';

/**
 * The workspace's files and folders for the `@` menu: one cached `findFiles` listing, dropped when files are created
 * or deleted and rebuilt on the next search (the stale list answers meanwhile so typing never waits on a rescan).
 */
export class FileIndex implements vscode.Disposable {
  private entries?: MentionEntry[];
  private building?: Promise<MentionEntry[]>;
  private stale = false;
  private recent: string[] = [];
  private readonly watcher: vscode.FileSystemWatcher;

  constructor(private readonly maxFiles = 5000) {
    this.watcher = vscode.workspace.createFileSystemWatcher('**/*', false, true, false);
    const invalidate = () => (this.stale = true);
    this.watcher.onDidCreate(invalidate);
    this.watcher.onDidDelete(invalidate);
  }

  dispose(): void {
    this.watcher.dispose();
  }

  /** Remembers attached files so they rank right after the open editors. */
  noteAttached(refs: readonly string[]): void {
    const files = refs.map((r) => r.replace(/#L\d+(?:-L?\d+)?$/, '')).filter((r) => r && !r.startsWith('@'));
    this.recent = [...new Set([...files.reverse(), ...this.recent])].slice(0, 50);
  }

  async search(query: string, open: readonly string[] = [], limit = 20): Promise<MentionHit[]> {
    return rankMentions(query, await this.list(), { open, recent: this.recent, limit });
  }

  /** Files then folders; awaits a scan only when there is no earlier listing to answer from. */
  async list(): Promise<MentionEntry[]> {
    if (this.entries && !this.stale) {
      return this.entries;
    }
    if (!this.building) {
      this.stale = false;
      this.building = this.build().then(
        (e) => ((this.entries = e), e),
        () => this.entries ?? [],
      ).finally(() => (this.building = undefined));
    }
    return this.entries ?? this.building;
  }

  private async build(): Promise<MentionEntry[]> {
    if (!vscode.workspace.workspaceFolders?.length) {
      return [];
    }
    const multi = vscode.workspace.workspaceFolders.length > 1;
    const uris = await vscode.workspace.findFiles('**/*', TREE_EXCLUDE, this.maxFiles);
    const files: MentionEntry[] = uris.map((u) => {
      // asRelativePath prefixes the folder name in a multi-root workspace, which readAttachment resolves.
      const ref = vscode.workspace.asRelativePath(u, multi);
      return { ref, display: multi ? ref.replace('/', ':/') : ref, kind: 'file' };
    });
    files.sort((a, b) => (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0));
    return [...files, ...foldersOf(files)];
  }
}
