// MemoryBridge (design §9.2): project and developer notes stay Markdown files (the editable surface, as in 1.6); every
// write or delete through MemoryStore, every hand edit and every git checkout of a note becomes a memory event. Remote
// changes (another window, the CLI with another developer folder, another device through sync) are written back to the
// note file only when the file still holds what this machine last saw of it (its hash); otherwise a `text-merge`
// conflict is recorded and the file is left alone. Project notes that git tracks are never written: git moves them.
// Pure Node: no vscode (VS Code passes a FileSystemWatcher-based `watch`).
import { execFile } from 'child_process';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { memoryItemId, memoryNoteFields } from '../conversation/payloads';
import type { FileEventLog } from '../data/eventLog';
import { Emitter } from '../data/eventLog';
import type { IndexClient } from '../data/index/indexClient';
import type { MemoryRow } from '../data/index/queries';
import { stableId } from '../ids';
import { safeNoteName, scopeKey, summaryOf } from './memoryTypes';

export interface NoteFolder {
  type: 'project' | 'developer';
  /** The memory folder (`<root>/.localpilot/memory`, `<globalStorage>/memory`, `~/.localpilot/memory`). */
  dir: string;
  /** Project notes: the project and its folder (for the git check). */
  projectId?: string;
  root?: string;
}

export interface Disposable {
  dispose(): unknown;
}

/** Calls `onChange` (debounced by the caller) when something in `dir` changes; the folder may not exist yet. */
export type WatchFactory = (dir: string, onChange: () => void) => Disposable;
export type GitTracked = (root: string, file: string) => Promise<boolean>;

/** `git ls-files --error-unmatch`: true when git tracks the file (it then moves the note, not sync). */
export const gitTracked: GitTracked = (root, file) =>
  new Promise((resolve) => {
    const rel = path.relative(root, file);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
      resolve(false);
      return;
    }
    execFile('git', ['-C', root, 'ls-files', '--error-unmatch', '--', rel.split(path.sep).join('/')], { timeout: 5000, windowsHide: true }, (err) => resolve(!err));
  });

/** fs.watch on the folder (polling every 3 s until it exists, and as a fallback where fs.watch fails). */
export const nodeWatch: WatchFactory = (dir, onChange) => {
  let w: fs.FSWatcher | undefined;
  let sig = '';
  const signature = () => {
    try {
      return fs
        .readdirSync(dir)
        .filter((f) => f.endsWith('.md'))
        .map((f) => {
          const st = fs.statSync(path.join(dir, f));
          return `${f}:${st.mtimeMs}:${st.size}`;
        })
        .join('|');
    } catch {
      return '';
    }
  };
  const start = () => {
    if (w) {
      return;
    }
    try {
      w = fs.watch(dir, { persistent: false }, () => onChange());
      w.on('error', () => {
        w?.close();
        w = undefined;
      });
    } catch {
      w = undefined;
    }
  };
  sig = signature();
  start();
  const poll = setInterval(() => {
    start();
    const s = signature();
    if (s !== sig) {
      sig = s;
      onChange();
    }
  }, 3000);
  poll.unref?.();
  return {
    dispose: () => {
      clearInterval(poll);
      w?.close();
    },
  };
};

/** sha256 of a note body with LF line ends (the index's `project_memory.content_hash`). */
export function bodyHash(text: string): string {
  return createHash('sha256').update(text.replace(/\r\n?/g, '\n')).digest('hex');
}

export interface NoteChange {
  type: 'project' | 'developer';
  /** File stem (`build-and-test` for build-and-test.md). */
  name: string;
  /** Absolute path of the note file. */
  file: string;
  op: 'write' | 'delete';
  body?: string;
  /** Who wrote it (default: the agent's memory tools). */
  source?: 'user' | 'agent' | 'auto';
}

export interface WriteBackResult {
  written: number;
  deleted: number;
  conflicts: number;
  skipped: number;
}

export interface MemoryBridgeOptions {
  log: FileEventLog;
  index: IndexClient;
  /** Continuity data root (the seen-hash file lives in `<root>/memory/`). */
  root: string;
  ready: Promise<unknown>;
  healthy: () => boolean;
  /** Folder watcher; false = none (tests drive `scan`). Default fs.watch + poll. */
  watch?: WatchFactory | false;
  gitTracked?: GitTracked;
  now?: () => number;
  warn?: (m: string) => void;
}

interface Seen {
  id: string;
  hash: string;
}

/** Writes `text` to `file` through a temp file and a rename. */
function writeAtomic(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now().toString(36)}.tmp`;
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, file);
}

function readText(file: string): string | undefined {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
}

export class MemoryBridge implements Disposable {
  private folders: NoteFolder[] = [];
  private readonly watchers = new Map<string, Disposable>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private chain: Promise<unknown> = Promise.resolve();
  /** Last content this machine logged or wrote per note file (absolute path). Shared by the processes of the machine. */
  private seen: Record<string, Seen> = {};
  private readonly dirty = new Set<string>();
  private saveTimer?: NodeJS.Timeout;
  /** Ids logged by this process (the index may not have caught up yet: patch, not create). */
  private readonly logged = new Set<string>();
  private readonly gitCache = new Map<string, { at: number; tracked: boolean }>();
  private readonly changed = new Emitter<string[]>();
  /** Memory items this bridge logged or wrote back (the Memory manager refreshes). */
  readonly onDidChange = this.changed.event;
  private disposed = false;
  private readonly now: () => number;

  constructor(private readonly o: MemoryBridgeOptions) {
    this.now = o.now ?? Date.now;
    try {
      const raw = JSON.parse(fs.readFileSync(this.seenFile, 'utf8')) as { files?: Record<string, Seen> };
      this.seen = raw.files && typeof raw.files === 'object' ? raw.files : {};
    } catch {
      this.seen = {};
    }
  }

  private get seenFile(): string {
    return path.join(this.o.root, 'memory', 'seen.json');
  }

  /** The note folders of this process: watched, and scanned once now (notes the 1.6 import never saw get logged). */
  setFolders(folders: NoteFolder[]): Promise<void> {
    const want = new Map(folders.map((f) => [path.resolve(f.dir), { ...f, dir: path.resolve(f.dir) }]));
    for (const [dir, w] of this.watchers) {
      if (!want.has(dir)) {
        w.dispose();
        this.watchers.delete(dir);
      }
    }
    this.folders = [...want.values()];
    const watch = this.o.watch === undefined ? nodeWatch : this.o.watch;
    for (const f of this.folders) {
      if (watch && !this.watchers.has(f.dir)) {
        this.watchers.set(f.dir, watch(f.dir, () => this.scheduleScan(f.dir)));
      }
    }
    return this.queue(async () => {
      for (const f of this.folders) {
        await this.scanNow(f);
      }
    });
  }

  get noteFolders(): readonly NoteFolder[] {
    return this.folders;
  }

  private scheduleScan(dir: string): void {
    clearTimeout(this.timers.get(dir));
    const t = setTimeout(() => {
      this.timers.delete(dir);
      const f = this.folders.find((x) => x.dir === dir);
      if (f) {
        void this.queue(() => this.scanNow(f));
      }
    }, 400);
    t.unref?.();
    this.timers.set(dir, t);
  }

  /** Runs `fn` after everything queued before it (one note at a time, in order). */
  private queue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(async () => {
      await this.o.ready;
      if (this.disposed || !this.o.healthy()) {
        return undefined as T;
      }
      return fn();
    });
    this.chain = run.catch((e) => this.o.warn?.(`memory: ${e instanceof Error ? e.message : String(e)}`));
    return run;
  }

  /** Everything queued so far has been logged (tests, shutdown). */
  async settle(): Promise<void> {
    await this.chain.catch(() => undefined);
    await this.o.log.flush();
  }

  /** A MemoryStore write or delete (its `onChange`). */
  noteChanged(c: NoteChange): Promise<void> {
    const folder = this.folders.find((f) => f.dir === path.resolve(path.dirname(c.file)));
    const f: NoteFolder = folder ?? { type: c.type, dir: path.resolve(path.dirname(c.file)) };
    if (!folder && c.type === 'project') {
      // A project folder this bridge was not told about: its project id is unknown, so it is picked up on the next scan.
      return Promise.resolve();
    }
    return this.queue(() => this.logNote(f, c.name, c.op === 'delete' ? undefined : c.body ?? readText(c.file) ?? '', c.op === 'write' ? c.source ?? 'agent' : 'file')).then(() => undefined);
  }

  /** Scans a folder: changed or new files are logged, files this machine had that are gone are trashed. */
  scan(dir: string): Promise<number> {
    const f = this.folders.find((x) => x.dir === path.resolve(dir));
    return f ? this.queue(() => this.scanNow(f)) : Promise.resolve(0);
  }

  private async scanNow(f: NoteFolder): Promise<number> {
    let names: string[] = [];
    try {
      names = fs.readdirSync(f.dir).filter((n) => n.endsWith('.md') && !n.startsWith('.'));
    } catch {
      names = [];
    }
    let n = 0;
    const present = new Set<string>();
    for (const file of names) {
      const abs = path.join(f.dir, file);
      present.add(abs);
      const body = readText(abs);
      if (body !== undefined && (await this.logNote(f, file.slice(0, -3), body, 'file'))) {
        n++;
      }
    }
    for (const [abs, s] of Object.entries(this.seen)) {
      if (path.dirname(abs) === f.dir && !present.has(abs) && s.id === this.idOf(f, path.basename(abs, '.md'))) {
        if (await this.logNote(f, path.basename(abs, '.md'), undefined, 'file')) {
          n++;
        }
      }
    }
    return n;
  }

  idOf(f: Pick<NoteFolder, 'type' | 'projectId'>, stem: string): string {
    return memoryItemId(f.type, scopeKey(f.type, { projectId: f.projectId }), stem);
  }

  private async row(id: string): Promise<MemoryRow | undefined> {
    return (await this.o.index.memory({ id, includeTrash: true, limit: 1 }).catch(() => []))[0];
  }

  /** Logs one note's state (body, or undefined = gone). Returns true when an event was written. */
  private async logNote(f: NoteFolder, stem: string, body: string | undefined, source: 'user' | 'agent' | 'auto' | 'file'): Promise<boolean> {
    if (f.type === 'project' && !f.projectId) {
      return false;
    }
    const id = this.idOf(f, stem);
    const abs = path.join(f.dir, `${stem}.md`);
    const { log } = this.o;
    if (body === undefined) {
      const row = await this.row(id);
      this.forgetSeen(abs);
      if (row && !row.trashedAt) {
        log.append('memory', id, 'trash', { at: this.now(), reason: source === 'file' ? 'file-removed' : 'user' }, { durable: true });
        this.changed.fire([id]);
        return true;
      }
      return false;
    }
    const hash = bodyHash(body);
    if (this.seen[abs]?.hash === hash && this.seen[abs].id === id) {
      return false;
    }
    const row = this.logged.has(id) ? undefined : await this.row(id);
    if (row && !row.trashedAt && bodyHash(row.body) === hash) {
      this.markSeen(abs, id, hash);
      return false;
    }
    if (row?.trashedAt) {
      log.append('memory', id, 'restore', { at: this.now() }, { durable: true });
    }
    if (!row && !this.logged.has(id)) {
      log.append('memory', id, 'create', memoryNoteFields({ type: f.type, name: stem, body, projectId: f.projectId, file: `${stem}.md`, source, createdAt: this.now() }), { durable: true });
    } else {
      log.append('memory', id, 'patch', { body, summary: summaryOf(body), file: `${stem}.md`, source }, { durable: true });
    }
    this.logged.add(id);
    this.markSeen(abs, id, hash);
    this.changed.fire([id]);
    return true;
  }

  // ---------------------------------------------------------------------------------------------- remote changes

  private folderFor(row: MemoryRow): NoteFolder | undefined {
    if (row.type === 'developer') {
      return this.folders.find((f) => f.type === 'developer');
    }
    if (row.type === 'project') {
      return this.folders.find((f) => f.type === 'project' && f.projectId === row.projectId);
    }
    return undefined;
  }

  private async tracked(f: NoteFolder, file: string): Promise<boolean> {
    if (f.type !== 'project' || !f.root) {
      return false;
    }
    const hit = this.gitCache.get(file);
    if (hit && this.now() - hit.at < 60_000) {
      return hit.tracked;
    }
    const tracked = await (this.o.gitTracked ?? gitTracked)(f.root, file).catch(() => false);
    this.gitCache.set(file, { at: this.now(), tracked });
    return tracked;
  }

  /**
   * Remote changes of memory items (other processes or devices): writes file-backed notes back when the file still
   * holds what this machine last saw; otherwise records a conflict and leaves the file alone.
   */
  applyRemote(ids: string[]): Promise<WriteBackResult> {
    return this.queue(async () => {
      const r: WriteBackResult = { written: 0, deleted: 0, conflicts: 0, skipped: 0 };
      for (const id of [...new Set(ids)]) {
        const row = await this.row(id);
        if (!row) {
          // Purged: a note file this machine still has unchanged goes too.
          for (const [abs, s] of Object.entries(this.seen)) {
            if (s.id === id) {
              const cur = readText(abs);
              if (cur !== undefined && bodyHash(cur) === s.hash) {
                fs.rmSync(abs, { force: true });
                r.deleted++;
              }
              this.forgetSeen(abs);
            }
          }
          continue;
        }
        const f = this.folderFor(row);
        if (!f) {
          r.skipped++;
          continue;
        }
        const abs = path.join(f.dir, path.basename(row.file || `${safeNoteName(row.name)}.md`));
        if (await this.tracked(f, abs)) {
          r.skipped++;
          continue;
        }
        const cur = readText(abs);
        const curHash = cur === undefined ? undefined : bodyHash(cur);
        const seen = this.seen[abs]?.id === id ? this.seen[abs].hash : undefined;
        if (row.trashedAt) {
          if (cur === undefined) {
            this.forgetSeen(abs);
          } else if (curHash === seen) {
            fs.rmSync(abs, { force: true });
            this.forgetSeen(abs);
            r.deleted++;
          } else {
            this.conflict(id, 'trash-vs-edit', cur, '', row);
            r.conflicts++;
          }
          continue;
        }
        const want = bodyHash(row.body);
        if (curHash === want) {
          this.markSeen(abs, id, want);
          continue;
        }
        if (cur === undefined || curHash === seen) {
          writeAtomic(abs, row.body);
          this.markSeen(abs, id, want);
          r.written++;
        } else {
          this.conflict(id, 'text-merge', cur, row.body, row);
          r.conflicts++;
        }
      }
      if (r.written || r.deleted) {
        this.changed.fire(ids);
      }
      return r;
    });
  }

  /** A note file edited here while another copy changed elsewhere: a `conflict` entity (shown by SYNC's Conflicts). */
  private conflict(id: string, kind: 'text-merge' | 'trash-vs-edit', ours: string, theirs: string, row: MemoryRow): void {
    const here = this.o.log.device.deviceId;
    const cf = stableId('cf', 'memory', id, 'body', bodyHash(ours), bodyHash(theirs));
    this.o.log.append(
      'conflict',
      cf,
      'create',
      {
        entity: 'memory',
        entityId: id,
        field: 'body',
        kind,
        ours: { value: ours, hlc: this.o.log.peekHlc(), device: here },
        theirs: { value: theirs, hlc: '', device: 'remote', name: row.name },
        applied: 'ours',
      },
      { durable: true }
    );
    this.o.warn?.(`memory: "${row.name}" changed here and elsewhere; kept this machine's file and recorded a conflict`);
  }

  // ---------------------------------------------------------------------------------------------- seen hashes

  private markSeen(abs: string, id: string, hash: string): void {
    this.seen[abs] = { id, hash };
    this.dirty.add(abs);
    this.scheduleSave();
  }

  private forgetSeen(abs: string): void {
    if (abs in this.seen) {
      delete this.seen[abs];
      this.dirty.add(abs);
      this.scheduleSave();
    }
  }

  private scheduleSave(): void {
    if (!this.saveTimer) {
      this.saveTimer = setTimeout(() => {
        this.saveTimer = undefined;
        this.saveSeen();
      }, 500);
      this.saveTimer.unref?.();
    }
  }

  /** Merges this process's changes into the shared file (other processes write theirs). */
  private saveSeen(): void {
    if (!this.dirty.size) {
      return;
    }
    try {
      let disk: Record<string, Seen> = {};
      try {
        disk = (JSON.parse(fs.readFileSync(this.seenFile, 'utf8')) as { files?: Record<string, Seen> }).files ?? {};
      } catch {
        disk = {};
      }
      for (const k of this.dirty) {
        if (this.seen[k]) {
          disk[k] = this.seen[k];
        } else {
          delete disk[k];
        }
      }
      this.dirty.clear();
      this.seen = { ...disk, ...this.seen };
      writeAtomic(this.seenFile, JSON.stringify({ v: 1, files: disk }));
    } catch (e) {
      this.o.warn?.(`memory: could not save ${this.seenFile}: ${String(e)}`);
    }
  }

  dispose(): void {
    this.disposed = true;
    for (const w of this.watchers.values()) {
      w.dispose();
    }
    this.watchers.clear();
    for (const t of this.timers.values()) {
      clearTimeout(t);
    }
    clearTimeout(this.saveTimer);
    this.saveTimer = undefined;
    this.saveSeen();
    this.changed.dispose();
  }
}
