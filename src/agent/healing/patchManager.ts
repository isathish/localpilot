import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { unifiedDiff } from '../../tools/lineDiff';
import type { Failure, PatchRecord, Severity } from './types';
import { renameWithRetry } from './fsRetry';

/**
 * Per-attempt patch isolation (design §5.4): the first write to each file inside an attempt scope records its
 * pre-attempt content (in memory, and on disk when under 2 MB), so an attempt that made things worse can be rolled
 * back newest-first without touching files the user edited meanwhile.
 */

export const MAX_PERSIST_BYTES = 2 * 1024 * 1024;
export const SELF_WRITER = 'self';
/** `TreeSnapshot` diff of an `unknown` snapshot: something changed, nobody knows what. */
export const UNKNOWN_CHANGES = '*';

export interface PatchManagerOptions {
  root: string;
  /** Session whose attempt folders `persistDir` resolves (passed through as its second argument). */
  sessionId?: string;
  /** Folder of an attempt's persisted snapshots, e.g. `recovery/<sid>/attempt-<n>`. */
  persistDir?: (attempt: number, sessionId?: string) => string;
  /** File content, `undefined` when missing. Defaults to fs (binary files kept as bytes). */
  readFile?: (fsPath: string) => Promise<string | undefined>;
  writeFile?: (fsPath: string, content: string) => Promise<void>;
  /** ChangeTracker-compatible restore (`undefined` = the file did not exist, delete it). */
  restoreFile?: (fsPath: string, content: string | undefined) => Promise<void>;
  settle?: () => void | Promise<void>;
  now?: () => number;
  /** Paths outside the changed-file scope besides `.localpilot/` (e.g. the recovery storage dir). */
  isExcluded?: (rel: string) => boolean;
}

export interface SerialisedPatches {
  changedFiles: string[];
  agentWrites: Record<string, string | null>;
  activeScope?: { attempt: number; files: string[] };
}

export interface RollbackResult {
  restored: string[];
  skipped: { file: string; attempt: number; reason: 'user_edited' | 'unknown' | 'error'; detail?: string }[];
}

/** File content as read: text, or base64 bytes for files that are not valid UTF-8. */
interface Content {
  text: string;
  base64?: boolean;
}

interface FileSnapshot {
  rel: string;
  /** Pre-attempt content; `null` = the file did not exist. Unset when unknown (changed by a command). */
  before?: Content | null;
  known: boolean;
  /** Set once rollback put the pre-attempt content back (a retried rollback skips it). */
  restored?: boolean;
}

interface Scope {
  attempt: number;
  files: Map<string, FileSnapshot>;
  pending: Map<string, Promise<void>>;
  openedAt: number;
  rolledBack?: PatchRecord[];
  /** Records taken before the first, partly failed rollback (retried rollbacks report against them). */
  pendingRecords?: PatchRecord[];
}

interface PersistedSnapshot {
  v: 1;
  file: string;
  existed: boolean;
  content?: string;
  base64?: boolean;
  at: number;
}

const SEVERITY_WEIGHT: Record<Severity, number> = { critical: 100, high: 10, medium: 3, low: 1, info: 0 };

const sha1 = (data: string | Buffer) => createHash('sha1').update(data).digest('hex');

const bytesOf = (c: Content) => (c.base64 ? Buffer.from(c.text, 'base64') : Buffer.from(c.text, 'utf8'));

const hashOf = (c: Content | null) => (c ? sha1(bytesOf(c)) : null);

const sameContent = (a: Content | null | undefined, b: Content | null) =>
  a === null || b === null ? a === b : a !== undefined && hashOf(a) === hashOf(b);

/** `critical*100 + high*10 + medium*3 + low` over failures that are neither preexisting nor foreign. */
export function failureScore(failures: readonly Pick<Failure, 'severity' | 'preexisting' | 'foreign'>[]): number {
  return failures.reduce((s, f) => (f.preexisting || f.foreign ? s : s + SEVERITY_WEIGHT[f.severity]), 0);
}

function lineCount(text: string): number {
  if (!text) {
    return 0;
  }
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  return lines[lines.length - 1] === '' ? lines.length - 1 : lines.length;
}

function prefixed(text: string, op: '+' | '-'): string[] {
  const lines = text.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n');
  return text ? lines.map((l) => `${op}${l}`) : [];
}

/** Full diff body (no headers) and +/- counts between two contents. */
function fileDiff(before: Content | null, after: Content | null): { body: string[]; added: number; removed: number } {
  if (before?.base64 || after?.base64) {
    return { body: [`Binary file changed (${hashOf(before)?.slice(0, 8) ?? 'none'} -> ${hashOf(after)?.slice(0, 8) ?? 'none'})`], added: 0, removed: 0 };
  }
  if (!before) {
    const body = prefixed(after?.text ?? '', '+');
    return { body: body.length ? [`@@ -0,0 +1,${body.length} @@`, ...body] : [], added: lineCount(after?.text ?? ''), removed: 0 };
  }
  if (!after) {
    const body = prefixed(before.text, '-');
    return { body: body.length ? [`@@ -1,${body.length} +0,0 @@`, ...body] : [], added: 0, removed: lineCount(before.text) };
  }
  const text = unifiedDiff(before.text, after.text, { maxLines: Number.MAX_SAFE_INTEGER });
  const body = text ? text.split('\n') : [];
  let added = 0;
  let removed = 0;
  for (const l of body) {
    if (l.startsWith('@@')) {
      continue;
    }
    if (l.startsWith('+')) {
      added++;
    } else if (l.startsWith('-')) {
      removed++;
    }
  }
  return { body, added, removed };
}

async function defaultRead(fsPath: string): Promise<Content | null> {
  let buf: Buffer;
  try {
    buf = await fs.promises.readFile(fsPath);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT' || (e as NodeJS.ErrnoException).code === 'ENOTDIR') {
      return null;
    }
    throw e;
  }
  const text = buf.toString('utf8');
  return Buffer.from(text, 'utf8').equals(buf) ? { text } : { text: buf.toString('base64'), base64: true };
}

async function writeAtomic(fsPath: string, data: string | Buffer): Promise<void> {
  await fs.promises.mkdir(path.dirname(fsPath), { recursive: true });
  const tmp = `${fsPath}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  await fs.promises.writeFile(tmp, data);
  await renameWithRetry(tmp, fsPath);
}

export class PatchManager {
  private readonly root: string;
  private readonly scopes = new Map<number, Scope>();
  private active: number | undefined;
  private readonly changed = new Set<string>();
  private turn = new Set<string>();
  /** Content of each file before its first write of the current turn (for `diffFor`). */
  private turnOriginals = new Map<string, Content | null>();
  private turnPending = new Map<string, Promise<void>>();
  private readonly agentWrites = new Map<string, string | null>();
  private readonly writers = new Map<string, Set<string>>();

  constructor(private readonly opts: PatchManagerOptions) {
    this.root = path.resolve(opts.root);
  }

  /** Rebuilds the state persisted in `RecoveryState` after a restart; call `restoreFromDisk` for the snapshots. */
  static restore(serialised: SerialisedPatches, opts: PatchManagerOptions): PatchManager {
    const pm = new PatchManager(opts);
    for (const f of serialised.changedFiles) {
      pm.changed.add(f);
    }
    for (const [f, h] of Object.entries(serialised.agentWrites)) {
      pm.agentWrites.set(f, h);
    }
    if (serialised.activeScope) {
      const scope = pm.scopeOf(serialised.activeScope.attempt);
      for (const f of serialised.activeScope.files) {
        scope.files.set(f, { rel: f, known: false });
      }
      pm.active = serialised.activeScope.attempt;
    }
    return pm;
  }

  serialise(): SerialisedPatches {
    const scope = this.active !== undefined ? this.scopes.get(this.active) : undefined;
    return {
      changedFiles: [...this.changed],
      agentWrites: Object.fromEntries(this.agentWrites),
      activeScope: scope ? { attempt: scope.attempt, files: [...scope.files.keys()] } : undefined,
    };
  }

  /** Loads the persisted pre-attempt snapshots of `attempt`; returns how many files became restorable. */
  async restoreFromDisk(sessionId: string | undefined, attempt: number): Promise<number> {
    if (!this.opts.persistDir) {
      return 0;
    }
    const dir = this.opts.persistDir(attempt, sessionId ?? this.opts.sessionId);
    let names: string[];
    try {
      names = await fs.promises.readdir(dir);
    } catch {
      return 0;
    }
    const scope = this.scopeOf(attempt);
    let loaded = 0;
    for (const name of names.filter((n) => n.endsWith('.json'))) {
      try {
        const p = JSON.parse(await fs.promises.readFile(path.join(dir, name), 'utf8')) as PersistedSnapshot;
        if (p.v !== 1 || typeof p.file !== 'string' || (p.existed && typeof p.content !== 'string')) {
          continue;
        }
        if (this.relOf(p.file) !== p.file || `${sha1(p.file)}.json` !== name) {
          continue;
        }
        scope.files.set(p.file, { rel: p.file, known: true, before: p.existed ? { text: p.content!, base64: p.base64 } : null });
        loaded++;
      } catch {
        // A torn or foreign file: that path stays unknown (reported, not rolled back).
      }
    }
    return loaded;
  }

  openScope(attempt: number): void {
    this.scopeOf(attempt);
    this.active = attempt;
  }

  closeScope(): void {
    this.active = undefined;
  }

  activeAttempt(): number | undefined {
    return this.active;
  }

  /** Starts a new turn: `turnChangedFiles` and `diffFor` only cover writes from here on. */
  startTurn(): void {
    this.turn = new Set();
    this.turnOriginals = new Map();
    this.turnPending = new Map();
  }

  /** Workspace-relative `/` path, or undefined for paths outside the root or excluded from the changed-file scope. */
  relOf(file: string): string | undefined {
    const abs = path.isAbsolute(file) ? path.resolve(file) : path.resolve(this.root, file);
    const rel = path.relative(this.root, abs).split(path.sep).join('/');
    if (!rel || rel === '..' || rel.startsWith('../') || path.isAbsolute(rel)) {
      return undefined;
    }
    if (rel === '.localpilot' || rel.startsWith('.localpilot/') || this.opts.isExcluded?.(rel)) {
      return undefined;
    }
    return rel;
  }

  /** Records the pre-attempt (and pre-turn) content of a file before its first write. Awaited before the write. */
  async beforeWrite(fsPath: string, writer?: string): Promise<void> {
    const rel = this.relOf(fsPath);
    if (!rel) {
      return;
    }
    this.markChanged(rel, writer);
    const scope = this.active !== undefined ? this.scopes.get(this.active) : undefined;
    const tasks: Promise<void>[] = [];
    if (!this.turnOriginals.has(rel)) {
      tasks.push(this.once(this.turnPending, rel, async () => {
        if (!this.turnOriginals.has(rel)) {
          this.turnOriginals.set(rel, await this.read(rel));
        }
      }));
    }
    if (scope && !scope.files.has(rel)) {
      tasks.push(this.once(scope.pending, rel, async () => {
        if (scope.files.has(rel)) {
          return;
        }
        const before = await this.read(rel);
        scope.files.set(rel, { rel, before, known: true });
        await this.persist(scope.attempt, rel, before);
      }));
    } else if (scope?.pending.has(rel)) {
      tasks.push(scope.pending.get(rel)!);
    }
    await Promise.all(tasks);
  }

  /** Hashes the agent's resulting content of successfully written/deleted files (`null` = deleted). */
  async afterWrite(paths: readonly string[], writer?: string): Promise<void> {
    await Promise.all(
      paths.map(async (p) => {
        const rel = this.relOf(p);
        if (!rel) {
          return;
        }
        this.markChanged(rel, writer);
        const scope = this.active !== undefined ? this.scopes.get(this.active) : undefined;
        await scope?.pending.get(rel);
        if (scope && !scope.files.has(rel)) {
          scope.files.set(rel, { rel, known: false });
        }
        this.agentWrites.set(rel, hashOf(await this.read(rel)));
      }),
    );
  }

  /** Files touched by a model `run_command` (tree snapshot diff): changed, reported, never rolled back. */
  async noteCommandChanges(relPaths: readonly string[], writer?: string): Promise<void> {
    if (relPaths.includes(UNKNOWN_CHANGES)) {
      this.changed.add(UNKNOWN_CHANGES);
      this.turn.add(UNKNOWN_CHANGES);
    }
    await this.afterWrite(relPaths.filter((p) => p !== UNKNOWN_CHANGES), writer);
  }

  /** Files changed in `attempt`'s scope, or every changed file of the task (`*` = an unknown tree change). */
  changedFiles(scope?: number): string[] {
    const files = scope === undefined ? [...this.changed] : [...(this.scopes.get(scope)?.files.keys() ?? [])];
    return files.filter((f) => f === UNKNOWN_CHANGES || this.relOf(f) !== undefined).sort();
  }

  turnChangedFiles(): string[] {
    return [...this.turn].filter((f) => f === UNKNOWN_CHANGES || this.relOf(f) !== undefined).sort();
  }

  writersOf(file: string): string[] {
    const rel = this.relOf(file) ?? file;
    return [...(this.writers.get(rel) ?? [])];
  }

  agentHash(file: string): string | null | undefined {
    return this.agentWrites.get(this.relOf(file) ?? file);
  }

  /** True when the file's current content is not what the agent last wrote (false when the agent never wrote it). */
  async userEdited(file: string): Promise<boolean> {
    const rel = this.relOf(file) ?? file;
    if (!this.agentWrites.has(rel)) {
      return false;
    }
    return hashOf(await this.read(rel)) !== this.agentWrites.get(rel);
  }

  /** Patch records of an attempt (files whose pre-attempt content is known and differs from now). */
  async patches(attempt: number, previewLines = 80): Promise<PatchRecord[]> {
    const scope = this.scopes.get(attempt);
    if (!scope) {
      return [];
    }
    if (scope.rolledBack) {
      return scope.rolledBack.map((p) => ({ ...p }));
    }
    if (scope.pendingRecords) {
      return scope.pendingRecords.map((p) => ({ ...p, result: scope.files.get(p.file)?.restored ? 'rolled_back' : 'kept' }));
    }
    await Promise.all(scope.pending.values());
    const out: PatchRecord[] = [];
    for (const snap of [...scope.files.values()].sort((a, b) => (a.rel < b.rel ? -1 : 1))) {
      if (!snap.known || snap.before === undefined) {
        continue;
      }
      const now = await this.read(snap.rel);
      if (sameContent(snap.before, now)) {
        continue;
      }
      const d = fileDiff(snap.before, now);
      out.push({
        attempt,
        file: snap.rel,
        added: d.added,
        removed: d.removed,
        diffHash: sha1(`${snap.rel}\0${d.body.join('\n')}`).slice(0, 16),
        preview: truncate(d.body, previewLines),
      });
    }
    return out;
  }

  /** Order-independent hash of an attempt's whole patch set (identical patch => identical hash); '' when empty. */
  async attemptHash(attempt: number): Promise<string> {
    const ps = await this.patches(attempt);
    return ps.length ? sha1(ps.map((p) => p.diffHash).sort().join(',')).slice(0, 16) : '';
  }

  /** The turn's diff of `files` against their pre-turn content, `---`/`+++` headers per file, at most `maxLines`. */
  async diffFor(files: readonly string[], maxLines = 80): Promise<string> {
    const out: string[] = [];
    for (const f of files) {
      const rel = this.relOf(f);
      if (!rel || !this.turnPending.has(rel)) {
        continue;
      }
      await this.turnPending.get(rel);
      if (!this.turnOriginals.has(rel)) {
        continue;
      }
      const before = this.turnOriginals.get(rel)!;
      const now = await this.read(rel);
      if (sameContent(before, now)) {
        continue;
      }
      out.push(`--- ${before ? `a/${rel}` : '/dev/null'}`, `+++ ${now ? `b/${rel}` : '/dev/null'}`, ...fileDiff(before, now).body);
    }
    return truncate(out, maxLines);
  }

  score(failures: readonly Pick<Failure, 'severity' | 'preexisting' | 'foreign'>[]): number {
    return failureScore(failures);
  }

  /**
   * Restores pre-attempt contents of `attempt` and every later scope, newest first (all scopes when omitted).
   * Files that did not exist are deleted; files the user edited since the agent's last write, and files whose
   * pre-attempt content is unknown, are skipped. A scope with failed restores stays eligible: a later call retries
   * only the files not restored yet.
   */
  async rollback(attempt?: number): Promise<RollbackResult> {
    const res: RollbackResult = { restored: [], skipped: [] };
    const targets = [...this.scopes.values()]
      .filter((s) => !s.rolledBack && (attempt === undefined || s.attempt >= attempt))
      .sort((a, b) => b.attempt - a.attempt);
    for (const scope of targets) {
      await Promise.all(scope.pending.values());
      const records = scope.pendingRecords ?? (await this.patches(scope.attempt));
      for (const snap of [...scope.files.values()].reverse()) {
        if (snap.restored) {
          continue;
        }
        if (!snap.known || snap.before === undefined) {
          res.skipped.push({ file: snap.rel, attempt: scope.attempt, reason: 'unknown' });
          continue;
        }
        try {
          const now = await this.read(snap.rel);
          if (sameContent(snap.before, now)) {
            this.agentWrites.set(snap.rel, hashOf(now));
            snap.restored = true;
            continue;
          }
          // No agent hash = the write failed or was never confirmed, so a difference may be the user's.
          if (!this.agentWrites.has(snap.rel) || hashOf(now) !== this.agentWrites.get(snap.rel)) {
            res.skipped.push({ file: snap.rel, attempt: scope.attempt, reason: 'user_edited' });
            continue;
          }
          await this.restore(snap.rel, snap.before);
          this.agentWrites.set(snap.rel, hashOf(snap.before));
          snap.restored = true;
          if (!res.restored.includes(snap.rel)) {
            res.restored.push(snap.rel);
          }
        } catch (e) {
          res.skipped.push({ file: snap.rel, attempt: scope.attempt, reason: 'error', detail: e instanceof Error ? e.message : String(e) });
        }
      }
      const mine = res.skipped.filter((s) => s.attempt === scope.attempt);
      if (mine.some((s) => s.reason === 'error')) {
        scope.pendingRecords = records;
      } else {
        const skipped = new Set(mine.map((s) => s.file));
        scope.rolledBack = records.map((p) => ({ ...p, result: skipped.has(p.file) || !scope.files.get(p.file)?.restored ? 'kept' : 'rolled_back' }));
        scope.pendingRecords = undefined;
      }
      if (this.active === scope.attempt) {
        this.active = undefined;
      }
    }
    if (targets.length) {
      await this.opts.settle?.();
    }
    return res;
  }

  /** Removes the persisted snapshots of `attempt`, or of every attempt of the session (also ones not in memory). */
  async clearPersisted(attempt?: number, sessionId?: string): Promise<void> {
    const persistDir = this.opts.persistDir;
    if (!persistDir) {
      return;
    }
    const sid = sessionId ?? this.opts.sessionId;
    const dirs = new Set((attempt !== undefined ? [attempt] : [...this.scopes.keys()]).map((n) => persistDir(n, sid)));
    if (attempt === undefined) {
      const probe = persistDir(0, sid);
      if (path.basename(probe) === 'attempt-0') {
        const parent = path.dirname(probe);
        const names = await fs.promises.readdir(parent).catch(() => [] as string[]);
        for (const n of names.filter((x) => /^attempt-\d+$/.test(x))) {
          dirs.add(path.join(parent, n));
        }
      }
    }
    await Promise.all([...dirs].map((d) => fs.promises.rm(d, { recursive: true, force: true })));
  }

  private scopeOf(attempt: number): Scope {
    let s = this.scopes.get(attempt);
    if (!s) {
      s = { attempt, files: new Map(), pending: new Map(), openedAt: this.opts.now?.() ?? Date.now() };
      this.scopes.set(attempt, s);
    }
    return s;
  }

  private markChanged(rel: string, writer?: string): void {
    this.changed.add(rel);
    this.turn.add(rel);
    let w = this.writers.get(rel);
    if (!w) {
      w = new Set();
      this.writers.set(rel, w);
    }
    w.add(writer ?? SELF_WRITER);
  }

  private once(map: Map<string, Promise<void>>, rel: string, fn: () => Promise<void>): Promise<void> {
    let p = map.get(rel);
    if (!p) {
      p = fn().catch(() => undefined);
      map.set(rel, p);
    }
    return p;
  }

  private async read(rel: string): Promise<Content | null> {
    const fsPath = path.join(this.root, rel);
    if (this.opts.readFile) {
      const text = await this.opts.readFile(fsPath);
      return text === undefined ? null : { text };
    }
    return defaultRead(fsPath);
  }

  private async restore(file: string, before: Content | null): Promise<void> {
    const rel = this.relOf(file);
    if (rel === undefined || rel !== file) {
      throw new Error(`refusing to restore a path outside the workspace: ${file}`);
    }
    const fsPath = path.join(this.root, rel);
    if (before?.base64 || !this.opts.restoreFile) {
      if (before === null) {
        await fs.promises.rm(fsPath, { force: true });
      } else if (!before.base64 && this.opts.writeFile) {
        await fs.promises.mkdir(path.dirname(fsPath), { recursive: true });
        await this.opts.writeFile(fsPath, before.text);
      } else {
        await fs.promises.mkdir(path.dirname(fsPath), { recursive: true });
        await fs.promises.writeFile(fsPath, bytesOf(before));
      }
      return;
    }
    await this.opts.restoreFile(fsPath, before === null ? undefined : before.text);
  }

  private async persist(attempt: number, rel: string, before: Content | null): Promise<void> {
    if (!this.opts.persistDir || (before && before.text.length > MAX_PERSIST_BYTES * (before.base64 ? 4 / 3 : 1))) {
      return;
    }
    const rec: PersistedSnapshot = { v: 1, file: rel, existed: before !== null, at: this.opts.now?.() ?? Date.now() };
    if (before) {
      rec.content = before.text;
      if (before.base64) {
        rec.base64 = true;
      }
    }
    try {
      await writeAtomic(path.join(this.opts.persistDir(attempt, this.opts.sessionId), `${sha1(rel)}.json`), JSON.stringify(rec));
    } catch {
      // Persistence is best effort: the in-memory snapshot still allows rollback in this process.
    }
  }
}

function truncate(lines: string[], max: number): string {
  return lines.length > max ? `${lines.slice(0, max).join('\n')}\n… (${lines.length - max} more diff lines)` : lines.join('\n');
}
