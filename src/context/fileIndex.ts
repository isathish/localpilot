import * as vscode from 'vscode';
import { TREE_EXCLUDE } from './workspaceContext';
import { foldersOf, MentionEntry, MentionHit, rankMentions } from './mentionSearch';

/** Top-level folders never worth a scan of their own (TREE_EXCLUDE would return nothing from them anyway). */
const SKIP_TOP = new Set(['node_modules', '.git', 'dist', 'out', 'build', '.venv', '__pycache__', '.next', 'target', 'coverage', '.vscode-test']);
/** Files counted past the listing limit, so a large repository can say "5,000 of 12,400"; beyond this it says "200,000+". */
export const COUNT_CAP = 200_000;

/**
 * Where the file index is: `indexing` while a scan runs (`pct` of the top-level folders scanned, `files` found so far),
 * then `ready` with `files` counted and `listed` kept for the `@` menu (fewer than `files` on a large repository).
 * `capped`: there were at least COUNT_CAP files and counting stopped there.
 */
export interface FileIndexStatus {
  state: 'idle' | 'indexing' | 'ready';
  files: number;
  listed: number;
  pct: number;
  capped?: boolean;
  limit: number;
}

/** One unit of a scan: the files directly in a workspace folder (`*`), or everything under one of its top-level folders. */
export interface ScanUnit {
  folder: vscode.Uri;
  pattern: string;
}

/**
 * Scans `units` one after another, keeping up to `limit` files and counting up to `cap`, and reports progress after
 * each unit. Pure apart from `find`, so the counting and the progress arithmetic are testable without a workspace.
 */
export async function scanUnits<T>(units: readonly ScanUnit[], find: (u: ScanUnit, max: number) => Promise<T[]>, limit: number, cap: number, progress: (s: { done: number; total: number; files: number }) => void): Promise<{ kept: T[]; files: number; capped: boolean }> {
  const kept: T[] = [];
  let files = 0;
  for (let i = 0; i < units.length && files < cap; i++) {
    let found: T[] = [];
    try {
      found = await find(units[i], cap - files);
    } catch {
      /* an unreadable folder counts as empty */
    }
    files += found.length;
    for (const f of found) {
      if (kept.length >= limit) {
        break;
      }
      kept.push(f);
    }
    progress({ done: i + 1, total: units.length, files });
  }
  return { kept, files, capped: files >= cap };
}

/**
 * The workspace's files and folders for the `@` menu: one cached listing, dropped when files are created or deleted
 * and rebuilt on the next search (the stale list answers meanwhile so typing never waits on a rescan). The scan goes
 * folder by folder so the chat and the status bar can show its progress, and it counts the files past the listing
 * limit so a large repository says how much of it the menu covers.
 */
export class FileIndex implements vscode.Disposable {
  private entries?: MentionEntry[];
  private building?: Promise<MentionEntry[]>;
  private stale = false;
  /**
   * Whether the next scan counts past the listing limit (up to COUNT_CAP) and reports its progress: the first scan and
   * an explicit rebuild. Rescans after files are created or deleted (often, while an agent works) stop at the limit
   * and keep the earlier count, so a large repository is not walked in full each time.
   */
  private fullScan = true;
  private recent: string[] = [];
  private readonly watcher: vscode.FileSystemWatcher;
  private current: FileIndexStatus;
  private readonly changed = new vscode.EventEmitter<FileIndexStatus>();
  /** Fires as a scan progresses and when it finishes. */
  readonly onDidChangeStatus = this.changed.event;

  constructor(private readonly maxFiles = 5000) {
    this.current = { state: 'idle', files: 0, listed: 0, pct: 0, limit: maxFiles };
    this.watcher = vscode.workspace.createFileSystemWatcher('**/*', false, true, false);
    const invalidate = () => (this.stale = true);
    this.watcher.onDidCreate(invalidate);
    this.watcher.onDidDelete(invalidate);
  }

  dispose(): void {
    this.watcher.dispose();
    this.changed.dispose();
  }

  get status(): FileIndexStatus {
    return this.current;
  }

  private setStatus(s: Partial<FileIndexStatus>): void {
    this.current = { ...this.current, ...s };
    this.changed.fire(this.current);
  }

  /** Remembers attached files so they rank right after the open editors. */
  noteAttached(refs: readonly string[]): void {
    const files = refs.map((r) => r.replace(/#L\d+(?:-L?\d+)?$/, '')).filter((r) => r && !r.startsWith('@'));
    this.recent = [...new Set([...files.reverse(), ...this.recent])].slice(0, 50);
  }

  /**
   * `folder` (a multi-root chat's workspace folder name): its files and folders rank first, the other folders' after,
   * so the chat's own folder drives the menu without hiding the rest.
   */
  async search(query: string, open: readonly string[] = [], limit = 20, folder?: string): Promise<MentionHit[]> {
    const all = await this.list();
    if (!folder || (vscode.workspace.workspaceFolders?.length ?? 0) < 2) {
      return rankMentions(query, all, { open, recent: this.recent, limit });
    }
    const prefix = `${folder}/`;
    const own = all.filter((e) => e.ref.startsWith(prefix) || e.ref === folder);
    const hits = rankMentions(query, own, { open, recent: this.recent, limit });
    return hits.length >= limit ? hits : hits.concat(rankMentions(query, all.filter((e) => !own.includes(e)), { open, recent: this.recent, limit: limit - hits.length }));
  }

  /** Rescans now (the status bar's "Rebuild file index"), even when the listing is current. */
  rebuild(): Promise<MentionEntry[]> {
    this.stale = true;
    this.fullScan = true;
    const now = this.list();
    return this.building ?? now;
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
        () => {
          this.setStatus({ state: this.entries ? 'ready' : 'idle' });
          return this.entries ?? [];
        },
      ).finally(() => (this.building = undefined));
    }
    return this.entries ?? this.building;
  }

  private async build(): Promise<MentionEntry[]> {
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (!folders.length) {
      this.setStatus({ state: 'idle', files: 0, listed: 0, pct: 0, capped: false });
      return [];
    }
    const multi = folders.length > 1;
    const full = this.fullScan;
    this.fullScan = false;
    if (full) {
      this.setStatus({ state: 'indexing', files: 0, pct: 0, capped: false });
    }
    const units: ScanUnit[] = [];
    for (const f of folders) {
      units.push({ folder: f.uri, pattern: '*' });
      let children: [string, vscode.FileType][] = [];
      try {
        children = await vscode.workspace.fs.readDirectory(f.uri);
      } catch {
        /* unreadable folder: only its root files (none) */
      }
      for (const [name, type] of children.sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
        if (type & vscode.FileType.Directory && !SKIP_TOP.has(name)) {
          units.push({ folder: f.uri, pattern: `${name}/**/*` });
        }
      }
    }
    const scan = await scanUnits(
      units,
      (u, max) => Promise.resolve(vscode.workspace.findFiles(new vscode.RelativePattern(u.folder, u.pattern), TREE_EXCLUDE, max)),
      this.maxFiles,
      full ? COUNT_CAP : this.maxFiles + 1,
      (p) => full && this.setStatus({ state: 'indexing', files: p.files, pct: Math.round((p.done / Math.max(1, p.total)) * 100) })
    );
    const { kept } = scan;
    // A quick rescan that reached the limit only knows "more than the limit": keep the last full count.
    const quickOver = !full && scan.files > this.maxFiles;
    const files = quickOver ? Math.max(scan.files, this.current.files) : scan.files;
    const capped = quickOver ? !!this.current.capped : scan.capped;
    const entries: MentionEntry[] = kept.map((u) => {
      // asRelativePath prefixes the folder name in a multi-root workspace, which readAttachment resolves.
      const ref = vscode.workspace.asRelativePath(u, multi);
      return { ref, display: multi ? ref.replace('/', ':/') : ref, kind: 'file' };
    });
    entries.sort((a, b) => (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0));
    this.setStatus({ state: 'ready', files, listed: entries.length, pct: 100, capped });
    return [...entries, ...foldersOf(entries)];
  }
}

/** One line for the status bar tooltip, the chat's ctx strip and the context menu; empty while there is nothing to say. */
export function indexStatusText(s: FileIndexStatus): string {
  if (s.state === 'indexing') {
    return `Indexing ${s.files.toLocaleString()} files… ${s.pct}%`;
  }
  if (s.state === 'ready' && s.files > s.listed) {
    return `Large repo: ${s.listed.toLocaleString()} of ${s.files.toLocaleString()}${s.capped ? '+' : ''} files listed`;
  }
  return '';
}
