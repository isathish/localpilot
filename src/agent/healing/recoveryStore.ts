import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import type { FailureCategory, InterventionRecord, RecoveryPhase, RecoveryState } from './types';
import { isTerminalPhase } from './types';

/**
 * Persistent per-session recovery state (design §7.1): one `<sid>.json` per root session, written atomically
 * (tmp + rename) on a per-session promise chain with a revision counter, a `<sid>.lock` owner lock for
 * cross-process use (VS Code window + CLI on the same storage), per-attempt snapshot folders and the
 * `interventions.json` index. No vscode import.
 */

export interface StoreLog {
  info?(msg: string): void;
  warn(msg: string): void;
}

export interface RecoveryStoreOptions {
  owner: { kind: 'vscode' | 'cli' };
  now?: () => number;
  log?: StoreLog;
  /** Overrides for tests. */
  pid?: number;
  host?: string;
  /** Attempt budget shown as M in "attempt N/M" for scanned states (default 3). */
  maxAttempts?: (state: RecoveryState) => number;
}

export interface LockInfo {
  pid: number;
  host: string;
  at: number;
  kind?: 'vscode' | 'cli';
}

export type AcquireResult = 'owned' | 'readonly';

export interface UnfinishedSummary {
  sid: string;
  phase: RecoveryPhase;
  attempt: number;
  max: number;
  category?: FailureCategory;
}

interface InterventionsFile {
  version: 1;
  items: InterventionRecord[];
}

export const LOCK_REFRESH_MS = 30_000;
export const LOCK_STALE_MS = 120_000;
const DAY_MS = 86_400_000;
const INTERVENTIONS_FILE = 'interventions.json';
const INTERVENTIONS_LOCK = 'interventions.lock';
/** The interventions lock only guards a read + write, so an older one belongs to a crashed writer. */
const INTERVENTIONS_LOCK_STALE_MS = 5_000;
const INTERVENTIONS_LOCK_WAIT_MS = 8_000;
/** A lock file that can't be parsed yet is another process between its exclusive create and the body write. */
const LOCK_WRITE_GRACE_MS = 5_000;

/** Tmp files being written by any store instance of this process (never promoted or removed by load()). */
const inflightTmps = new Set<string>();
let tmpSeq = 0;

/** Sub-agent ids are `<root>::<child>`; everything is stored under the root session. */
export function rootSessionId(sid: string): string {
  return sid.split('::')[0];
}

function fileKey(sid: string): string {
  return encodeURIComponent(rootSessionId(sid)).replace(/[!'()*~]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

function fromFileKey(key: string): string {
  try {
    return decodeURIComponent(key);
  } catch {
    return key;
  }
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function isNotFound(e: unknown): boolean {
  return (e as NodeJS.ErrnoException)?.code === 'ENOENT';
}

function isExists(e: unknown): boolean {
  return (e as NodeJS.ErrnoException)?.code === 'EEXIST';
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Pid encoded in a tmp name suffix (`<pid>.<seq>.tmp`); undefined for the legacy `.tmp` name. */
function tmpPid(suffix: string): number | undefined {
  const m = /^(\d+)\.\d+\.tmp$/.exec(suffix);
  return m ? Number(m[1]) : undefined;
}

export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException)?.code === 'EPERM';
  }
}

function isState(v: unknown): v is RecoveryState {
  const s = v as RecoveryState | undefined;
  return !!s && typeof s === 'object' && s.version === 1 && typeof s.sessionId === 'string' && typeof s.phase === 'string';
}

/** Fills fields missing from states written by older builds so callers can rely on them. */
function normalise(s: RecoveryState): RecoveryState {
  s.rev = typeof s.rev === 'number' ? s.rev : 0;
  s.checks ??= {};
  s.changedFiles ??= [];
  s.agentWrites ??= {};
  s.approvals ??= [];
  s.acceptedRisks ??= [];
  s.attempts ??= [];
  s.perCategory ??= {};
  s.seen ??= {};
  s.active ??= [];
  s.extraStepsUsed ??= 0;
  return s;
}

export class RecoveryStore {
  private readonly now: () => number;
  private readonly log?: StoreLog;
  private readonly pid: number;
  private readonly host: string;
  private readonly kind: 'vscode' | 'cli';
  private readonly maxAttempts: (state: RecoveryState) => number;
  private readonly chains = new Map<string, Promise<unknown>>();
  private readonly revs = new Map<string, number>();
  private readonly owned = new Map<string, ReturnType<typeof setInterval>>();
  private readonly readonly = new Set<string>();
  private interventionsChain: Promise<boolean> = Promise.resolve(true);

  constructor(
    readonly dir: string,
    opts: RecoveryStoreOptions,
  ) {
    this.now = opts.now ?? Date.now;
    this.log = opts.log;
    this.pid = opts.pid ?? process.pid;
    this.host = opts.host ?? os.hostname();
    this.kind = opts.owner.kind;
    this.maxAttempts = opts.maxAttempts ?? (() => 3);
  }

  statePath(sid: string): string {
    return path.join(this.dir, `${fileKey(sid)}.json`);
  }

  lockPath(sid: string): string {
    return path.join(this.dir, `${fileKey(sid)}.lock`);
  }

  /** Folder of attempt `n`'s pre-attempt snapshots (`<sid>/attempt-<n>/`). */
  attemptDir(sid: string, n: number): string {
    return path.join(this.dir, fileKey(sid), `attempt-${n}`);
  }

  // ---- State ----

  async load(sid: string): Promise<RecoveryState | undefined> {
    const key = rootSessionId(sid);
    await this.chains.get(key);
    const file = this.statePath(key);
    let state = await this.readState(file);
    const fromTmp = await this.recoverTmp(key, file, state);
    if (fromTmp) {
      state = fromTmp;
    }
    if (state) {
      this.revs.set(key, Math.max(this.revs.get(key) ?? 0, state.rev));
    }
    return state;
  }

  /**
   * Persists `state` (rev + 1, updatedAt = now, owner = this process). The body is captured synchronously, so later
   * mutations of the object don't leak into this write; writes of one session land in call order. Resolves to false
   * when the state was not written (read-only session or a write error), so the caller can skip the side effect.
   */
  save(state: RecoveryState): Promise<boolean> {
    const key = rootSessionId(state.sessionId);
    if (this.readonly.has(key)) {
      this.log?.warn(`Recovery store: ${key} is owned by another process; not saving`);
      return Promise.resolve(false);
    }
    state.rev = Math.max(state.rev ?? 0, this.revs.get(key) ?? 0) + 1;
    state.updatedAt = this.now();
    state.owner = { pid: this.pid, host: this.host, kind: this.kind };
    this.revs.set(key, state.rev);
    const body = JSON.stringify(state, null, 2);
    const file = this.statePath(key);
    return this.enqueue(key, () => this.writeAtomic(file, body));
  }

  /** Resolves once every pending write (states and interventions) has reached disk. */
  async flush(): Promise<void> {
    await Promise.all([...this.chains.values(), this.interventionsChain]);
  }

  /** Every readable state, newest first; `since` filters on `updatedAt`. */
  async listStates(opts: { since?: number } = {}): Promise<RecoveryState[]> {
    await this.flush();
    const out: RecoveryState[] = [];
    for (const key of await this.stateKeys()) {
      const s = await this.load(fromFileKey(key));
      if (s && (opts.since === undefined || s.updatedAt >= opts.since)) {
        out.push(s);
      }
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /**
   * Marks non-terminal states whose owner is gone (no live lock held by someone else), and states already
   * `interrupted`, as `interrupted` and returns their summaries. `idle` states have nothing to resume.
   */
  async scanUnfinished(): Promise<UnfinishedSummary[]> {
    const out: UnfinishedSummary[] = [];
    for (const s of await this.listStates()) {
      const key = rootSessionId(s.sessionId);
      if (isTerminalPhase(s.phase) || s.phase === 'idle') {
        continue;
      }
      if (s.phase !== 'interrupted') {
        const lock = await this.readLock(key);
        if (lock && !this.isOurs(lock) && !this.isStale(lock)) {
          continue;
        }
        if (lock && this.isOurs(lock) && this.owned.has(key)) {
          continue;
        }
        s.phase = 'interrupted';
        await this.writeOwnerless(s);
        this.log?.info?.(`Recovery store: ${key} was interrupted; marked resumable`);
      }
      const last = s.attempts[s.attempts.length - 1];
      out.push({
        sid: s.sessionId,
        phase: s.phase,
        attempt: last?.n ?? s.attempts.length,
        max: Math.max(this.maxAttempts(s), last?.n ?? 0),
        category: last?.category ?? s.active[0]?.category,
      });
    }
    return out;
  }

  /** Shutdown path: persist `phase: 'interrupted'` for a running (non-terminal) state and release the owner lock. */
  async markInterrupted(sid: string, state?: RecoveryState): Promise<RecoveryState | undefined> {
    const key = rootSessionId(sid);
    const s = state ?? (await this.load(key));
    if (s && !isTerminalPhase(s.phase) && s.phase !== 'interrupted') {
      s.phase = 'interrupted';
      if (!(await this.save(s))) {
        this.log?.warn(`Recovery store: could not persist the interrupted state of ${key}`);
      }
    }
    await this.chains.get(key);
    await this.release(key);
    return s;
  }

  async deleteSession(sid: string): Promise<void> {
    const key = rootSessionId(sid);
    await this.chains.get(key);
    this.stopRefresh(key);
    this.readonly.delete(key);
    this.revs.delete(key);
    const file = this.statePath(key);
    const tmps = await this.tmpFiles(file);
    await Promise.all([
      fs.rm(file, { force: true }),
      ...tmps.map((t) => fs.rm(t.path, { force: true })),
      fs.rm(this.lockPath(key), { force: true }),
      fs.rm(path.join(this.dir, fileKey(key)), { recursive: true, force: true }),
    ]).catch((e) => this.log?.warn(`Recovery store: could not delete ${key}: ${errMsg(e)}`));
    await this.updateInterventions((items) => items.filter((i) => rootSessionId(i.sessionId) !== key));
  }

  /** Removes the attempt snapshot folders of a session. */
  async removeAttempts(sid: string): Promise<void> {
    await fs
      .rm(path.join(this.dir, fileKey(sid)), { recursive: true, force: true })
      .catch((e) => this.log?.warn(`Recovery store: could not remove attempts of ${rootSessionId(sid)}: ${errMsg(e)}`));
  }

  /** Drops states (and their attempts), corrupt copies and resolved interventions older than `maxAgeDays`. */
  async prune(maxAgeDays = 30): Promise<number> {
    const cutoff = this.now() - maxAgeDays * DAY_MS;
    let removed = 0;
    for (const s of await this.listStates()) {
      const key = rootSessionId(s.sessionId);
      if (s.updatedAt >= cutoff || this.owned.has(key)) {
        continue;
      }
      const lock = await this.readLock(key);
      if (lock && !this.isOurs(lock) && !this.isStale(lock)) {
        continue;
      }
      await this.deleteSession(key);
      removed++;
    }
    for (const name of await this.entries()) {
      if (name.endsWith('.corrupt')) {
        const p = path.join(this.dir, name);
        const st = await fs.stat(p).catch(() => undefined);
        if (st && st.mtimeMs < cutoff) {
          await fs.rm(p, { force: true }).catch(() => undefined);
        }
      }
    }
    await this.updateInterventions((items) => items.filter((i) => !i.resolvedAt || i.resolvedAt >= cutoff));
    return removed;
  }

  // ---- Owner lock ----

  /**
   * Takes the owner lock (absent, ours, stale or dead owner) or opens the session read-only. The lock is created
   * with an exclusive create, and a stale one is first renamed aside, so of two racing processes only one owns it.
   */
  async acquire(sid: string): Promise<AcquireResult> {
    const key = rootSessionId(sid);
    const result = await this.claimLock(key);
    if (result === 'readonly') {
      this.readonly.add(key);
      return 'readonly';
    }
    this.readonly.delete(key);
    if (!this.owned.has(key)) {
      const timer = setInterval(() => void this.refresh(key), LOCK_REFRESH_MS);
      timer.unref?.();
      this.owned.set(key, timer);
    }
    return 'owned';
  }

  isOwned(sid: string): boolean {
    return this.owned.has(rootSessionId(sid));
  }

  isReadonly(sid: string): boolean {
    return this.readonly.has(rootSessionId(sid));
  }

  async release(sid: string): Promise<void> {
    const key = rootSessionId(sid);
    this.stopRefresh(key);
    this.readonly.delete(key);
    const lock = await this.readLock(key);
    if (lock && this.isOurs(lock)) {
      await fs.rm(this.lockPath(key), { force: true }).catch((e) => this.log?.warn(`Recovery store: could not release ${key}: ${errMsg(e)}`));
    }
  }

  /** Stops every refresh timer and releases the locks this process holds. */
  async dispose(): Promise<void> {
    await this.flush();
    await Promise.all([...this.owned.keys()].map((k) => this.release(k)));
  }

  // ---- Interventions index ----

  /** Resolves to false when the index could not be written. */
  addIntervention(record: InterventionRecord): Promise<boolean> {
    return this.updateInterventions((items) => [...items.filter((i) => i.id !== record.id), record]);
  }

  async resolveIntervention(id: string, at = this.now()): Promise<boolean> {
    let found = false;
    await this.updateInterventions((items) =>
      items.map((i) => {
        if (i.id !== id || i.resolvedAt) {
          return i;
        }
        found = true;
        return { ...i, resolvedAt: at };
      }),
    );
    return found;
  }

  /** Open items, newest first; `includeResolved` adds resolved ones; `sessionId` filters by root session. */
  async listInterventions(opts: { includeResolved?: boolean; sessionId?: string } = {}): Promise<InterventionRecord[]> {
    await this.interventionsChain;
    const root = opts.sessionId === undefined ? undefined : rootSessionId(opts.sessionId);
    return (await this.readInterventions())
      .filter((i) => (opts.includeResolved || !i.resolvedAt) && (root === undefined || rootSessionId(i.sessionId) === root))
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  // ---- Internals ----

  private enqueue<T>(key: string, job: () => Promise<T>): Promise<T> {
    const next = (this.chains.get(key) ?? Promise.resolve()).then(job, job);
    this.chains.set(key, next);
    void next.then(() => {
      if (this.chains.get(key) === next) {
        this.chains.delete(key);
      }
    });
    return next;
  }

  /** Each write uses its own `<file>.<pid>.<seq>.tmp`, so concurrent writers and readers never share a tmp file. */
  private uniqueTmp(file: string): string {
    return `${file}.${this.pid}.${++tmpSeq}.tmp`;
  }

  /** tmp + rename; false (logged) when the write failed. */
  private async writeAtomic(file: string, body: string): Promise<boolean> {
    const tmp = this.uniqueTmp(file);
    inflightTmps.add(tmp);
    try {
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(tmp, body, 'utf8');
      await fs.rename(tmp, file);
      return true;
    } catch (e) {
      this.log?.warn(`Recovery store: could not write ${path.basename(file)}: ${errMsg(e)}`);
      await fs.rm(tmp, { force: true }).catch(() => undefined);
      return false;
    } finally {
      inflightTmps.delete(tmp);
    }
  }

  /** Rewrites a state without claiming ownership (scan results): rev + 1, owner kept. */
  private writeOwnerless(s: RecoveryState): Promise<boolean> {
    const key = rootSessionId(s.sessionId);
    s.rev = Math.max(s.rev, this.revs.get(key) ?? 0) + 1;
    s.updatedAt = this.now();
    this.revs.set(key, s.rev);
    const body = JSON.stringify(s, null, 2);
    return this.enqueue(key, () => this.writeAtomic(this.statePath(key), body));
  }

  private async readState(file: string): Promise<RecoveryState | undefined> {
    let text: string;
    try {
      text = await fs.readFile(file, 'utf8');
    } catch (e) {
      if (!isNotFound(e)) {
        this.log?.warn(`Recovery store: could not read ${path.basename(file)}: ${errMsg(e)}`);
      }
      return undefined;
    }
    try {
      const v: unknown = JSON.parse(text);
      if (isState(v)) {
        return normalise(v);
      }
      throw new Error('not a recovery state');
    } catch (e) {
      this.log?.warn(`Recovery store: ${path.basename(file)} is corrupt (${errMsg(e)}); kept as .corrupt and ignored`);
      await fs.rename(file, `${file}.corrupt`).catch(() => undefined);
      return undefined;
    }
  }

  /**
   * A crash between the tmp write and the rename leaves a tmp file: promote the newest complete one when it is newer
   * than `current`, and drop the rest. Tmp files are only touched when nobody can still be writing them: no pending
   * write of this process for the key, no live foreign lock, not in flight here, and a foreign writer pid that is dead
   * (or a file older than the stale-lock age).
   */
  private async recoverTmp(key: string, file: string, current: RecoveryState | undefined): Promise<RecoveryState | undefined> {
    const tmps = await this.tmpFiles(file);
    if (!tmps.length || this.chains.has(key)) {
      return undefined;
    }
    const lock = await this.readLock(key);
    if (lock && !this.isOurs(lock) && !this.isStale(lock)) {
      return undefined;
    }
    const candidates: { path: string; state?: RecoveryState }[] = [];
    for (const t of tmps) {
      if (this.chains.has(key)) {
        return undefined;
      }
      if (!(await this.abandonedTmp(t))) {
        continue;
      }
      let state: RecoveryState | undefined;
      try {
        const v: unknown = JSON.parse(await fs.readFile(t.path, 'utf8'));
        state = isState(v) ? normalise(v) : undefined;
      } catch {
        state = undefined;
      }
      candidates.push({ path: t.path, state });
    }
    if (this.chains.has(key)) {
      return undefined;
    }
    let best: { path: string; state: RecoveryState } | undefined;
    for (const c of candidates) {
      if (c.state && (!current || c.state.rev > current.rev) && (!best || c.state.rev > best.state.rev)) {
        best = { path: c.path, state: c.state };
      }
    }
    let recovered: RecoveryState | undefined;
    if (best) {
      try {
        await fs.rename(best.path, file);
        this.log?.info?.(`Recovery store: recovered ${path.basename(file)} rev ${best.state.rev} from an interrupted write`);
        recovered = best.state;
      } catch (e) {
        this.log?.warn(`Recovery store: could not recover ${path.basename(best.path)}: ${errMsg(e)}`);
      }
    }
    await Promise.all(candidates.filter((c) => c.path !== best?.path).map((c) => fs.rm(c.path, { force: true }).catch(() => undefined)));
    return recovered;
  }

  /** Tmp files of a state file: `<file>.<pid>.<seq>.tmp`, or `<file>.tmp` from older builds. */
  private async tmpFiles(file: string): Promise<{ path: string; pid?: number }[]> {
    const base = `${path.basename(file)}.`;
    const out: { path: string; pid?: number }[] = [];
    for (const name of await this.entries()) {
      if (!name.startsWith(base)) {
        continue;
      }
      const suffix = name.slice(base.length);
      if (suffix === 'tmp' || tmpPid(suffix) !== undefined) {
        out.push({ path: path.join(this.dir, name), pid: tmpPid(suffix) });
      }
    }
    return out;
  }

  private async abandonedTmp(t: { path: string; pid?: number }): Promise<boolean> {
    if (inflightTmps.has(t.path)) {
      return false;
    }
    if (t.pid === undefined || t.pid === this.pid || !isPidAlive(t.pid)) {
      return true;
    }
    const st = await fs.stat(t.path).catch(() => undefined);
    return !!st && Date.now() - st.mtimeMs > LOCK_STALE_MS;
  }

  private async entries(): Promise<string[]> {
    try {
      return await fs.readdir(this.dir);
    } catch {
      return [];
    }
  }

  private async stateKeys(): Promise<string[]> {
    const keys = new Set<string>();
    for (const name of await this.entries()) {
      const m = /^(.+)\.json(?:\.(?:\d+\.\d+\.)?tmp)?$/.exec(name);
      if (m && m[1] !== 'interventions' && m[1] !== 'memory') {
        keys.add(m[1]);
      }
    }
    return [...keys];
  }

  private isOurs(lock: LockInfo): boolean {
    return lock.pid === this.pid && lock.host === this.host;
  }

  private isStale(lock: LockInfo): boolean {
    if (this.now() - lock.at > LOCK_STALE_MS) {
      return true;
    }
    return lock.host === this.host && !isPidAlive(lock.pid);
  }

  private async readLock(key: string): Promise<LockInfo | undefined> {
    try {
      return this.parseLock(await fs.readFile(this.lockPath(key), 'utf8'));
    } catch {
      // Missing or unreadable lock: no owner.
      return undefined;
    }
  }

  private parseLock(raw: string): LockInfo | undefined {
    try {
      const v = JSON.parse(raw) as LockInfo;
      if (typeof v?.pid === 'number' && typeof v.host === 'string' && typeof v.at === 'number') {
        return v;
      }
    } catch {
      // Partially written or corrupt.
    }
    return undefined;
  }

  private lockBody(): string {
    return JSON.stringify({ pid: this.pid, host: this.host, at: this.now(), kind: this.kind } satisfies LockInfo);
  }

  /** Refreshes a lock we hold (tmp + rename). */
  private async writeLock(key: string): Promise<void> {
    const file = this.lockPath(key);
    const tmp = this.uniqueTmp(file);
    try {
      await fs.writeFile(tmp, this.lockBody(), 'utf8');
      await fs.rename(tmp, file);
    } catch (e) {
      this.log?.warn(`Recovery store: could not write lock for ${key}: ${errMsg(e)}`);
      await fs.rm(tmp, { force: true }).catch(() => undefined);
    }
  }

  /** Exclusive create of the lock file; false when it already exists (or could not be created). */
  private async createLock(key: string): Promise<boolean> {
    try {
      await fs.mkdir(this.dir, { recursive: true });
      await fs.writeFile(this.lockPath(key), this.lockBody(), { encoding: 'utf8', flag: 'wx' });
      return true;
    } catch (e) {
      if (!isExists(e)) {
        this.log?.warn(`Recovery store: could not create lock for ${key}: ${errMsg(e)}`);
      }
      return false;
    }
  }

  private async claimLock(key: string): Promise<AcquireResult> {
    const file = this.lockPath(key);
    for (let i = 0; i < 5; i++) {
      if (await this.createLock(key)) {
        return 'owned';
      }
      let raw: string;
      try {
        raw = await fs.readFile(file, 'utf8');
      } catch (e) {
        if (isNotFound(e)) {
          continue;
        }
        return 'readonly';
      }
      const existing = this.parseLock(raw);
      if (existing && this.isOurs(existing)) {
        await this.writeLock(key);
        return 'owned';
      }
      if (existing && !this.isStale(existing)) {
        return 'readonly';
      }
      if (!existing) {
        // Another process is between its exclusive create and the body write; a long-unreadable lock is stale.
        const st = await fs.stat(file).catch(() => undefined);
        if (st && Date.now() - st.mtimeMs < LOCK_WRITE_GRACE_MS) {
          await sleep(20);
          continue;
        }
      }
      if (!(await this.breakLock(file, raw))) {
        return 'readonly';
      }
      this.log?.info?.(`Recovery store: took over stale lock of ${key}${existing ? ` (pid ${existing.pid} on ${existing.host})` : ''}`);
    }
    return 'readonly';
  }

  /**
   * Moves a stale lock aside (rename is atomic, so one process wins) and removes it. False when the lock moved was
   * not the stale one we saw (someone took it over first); that lock is put back when the path is still free.
   */
  private async breakLock(file: string, staleRaw: string): Promise<boolean> {
    const aside = `${file}.${this.pid}.${++tmpSeq}.stale`;
    try {
      await fs.rename(file, aside);
    } catch (e) {
      return isNotFound(e);
    }
    const moved = await fs.readFile(aside, 'utf8').catch(() => undefined);
    if (moved !== staleRaw) {
      await fs.link(aside, file).catch(() => undefined);
      await fs.rm(aside, { force: true }).catch(() => undefined);
      return false;
    }
    await fs.rm(aside, { force: true }).catch(() => undefined);
    return true;
  }

  private async refresh(key: string): Promise<void> {
    if (!this.owned.has(key)) {
      return;
    }
    const lock = await this.readLock(key);
    if (lock && this.isOurs(lock)) {
      await this.writeLock(key);
      return;
    }
    if (!lock && (await this.createLock(key))) {
      return;
    }
    const by = lock ? `pid ${lock.pid} on ${lock.host}` : 'another process';
    this.log?.warn(`Recovery store: lock of ${key} was taken by ${by}; now read-only`);
    this.stopRefresh(key);
    this.readonly.add(key);
  }

  private stopRefresh(key: string): void {
    const timer = this.owned.get(key);
    if (timer) {
      clearInterval(timer);
      this.owned.delete(key);
    }
  }

  private async readInterventions(): Promise<InterventionRecord[]> {
    const file = path.join(this.dir, INTERVENTIONS_FILE);
    let text: string;
    try {
      text = await fs.readFile(file, 'utf8');
    } catch (e) {
      if (!isNotFound(e)) {
        this.log?.warn(`Recovery store: could not read ${INTERVENTIONS_FILE}: ${errMsg(e)}`);
      }
      return [];
    }
    try {
      const v = JSON.parse(text) as InterventionsFile;
      if (!Array.isArray(v?.items)) {
        throw new Error('no items');
      }
      return v.items.filter((i) => i && typeof i.id === 'string' && typeof i.sessionId === 'string');
    } catch (e) {
      this.log?.warn(`Recovery store: ${INTERVENTIONS_FILE} is corrupt (${errMsg(e)}); kept as .corrupt and ignored`);
      await fs.rename(file, `${file}.corrupt`).catch(() => undefined);
      return [];
    }
  }

  /** Read-modify-write of the shared index under `interventions.lock` (shared by every session and process). */
  private updateInterventions(fn: (items: InterventionRecord[]) => InterventionRecord[]): Promise<boolean> {
    const file = path.join(this.dir, INTERVENTIONS_FILE);
    const job = async (): Promise<boolean> => {
      const token = await this.lockInterventions();
      if (!token) {
        return false;
      }
      try {
        const before = await this.readInterventions();
        const after = fn(before);
        if (after === before || (after.length === before.length && after.every((x, i) => x === before[i]))) {
          return true;
        }
        return await this.writeAtomic(file, JSON.stringify({ version: 1, items: after } satisfies InterventionsFile, null, 2));
      } finally {
        await this.unlockInterventions(token);
      }
    };
    this.interventionsChain = this.interventionsChain.then(job, job);
    return this.interventionsChain;
  }

  /**
   * Exclusive create of `interventions.lock` with a bounded backoff; a lock older than a few seconds or held by a dead
   * pid on this host is broken. The body carries the real process pid (liveness) and a token (release check).
   */
  private async lockInterventions(): Promise<string | undefined> {
    const file = path.join(this.dir, INTERVENTIONS_LOCK);
    const token = `${this.pid}.${++tmpSeq}.${Math.random().toString(36).slice(2)}`;
    const body = JSON.stringify({ pid: process.pid, host: this.host, at: Date.now(), token });
    const deadline = Date.now() + INTERVENTIONS_LOCK_WAIT_MS;
    try {
      await fs.mkdir(this.dir, { recursive: true });
    } catch (e) {
      this.log?.warn(`Recovery store: could not create ${this.dir}: ${errMsg(e)}`);
      return undefined;
    }
    for (let i = 0; ; i++) {
      try {
        const h = await fs.open(file, 'wx');
        try {
          await h.writeFile(body, 'utf8');
        } finally {
          await h.close();
        }
        return token;
      } catch (e) {
        if (!isExists(e)) {
          this.log?.warn(`Recovery store: could not lock ${INTERVENTIONS_FILE}: ${errMsg(e)}`);
          return undefined;
        }
      }
      const raw = await fs.readFile(file, 'utf8').catch(() => undefined);
      if (raw === undefined) {
        if (Date.now() > deadline) {
          this.log?.warn(`Recovery store: could not lock ${INTERVENTIONS_FILE}`);
          return undefined;
        }
        await sleep(5);
        continue;
      }
      const st = await fs.stat(file).catch(() => undefined);
      let holder: { pid?: number; host?: string } = {};
      try {
        holder = JSON.parse(raw) as typeof holder;
      } catch {
        // Being written; judged by age.
      }
      const dead = holder.host === this.host && typeof holder.pid === 'number' && !isPidAlive(holder.pid);
      const old = !!st && Date.now() - st.mtimeMs > INTERVENTIONS_LOCK_STALE_MS;
      if (dead || old || Date.now() > deadline) {
        this.log?.info?.(`Recovery store: breaking stale ${INTERVENTIONS_LOCK}`);
        await this.breakLock(file, raw);
        continue;
      }
      await sleep(Math.min(5 * 2 ** i, 100) + Math.random() * 10);
    }
  }

  private async unlockInterventions(token: string): Promise<void> {
    const file = path.join(this.dir, INTERVENTIONS_LOCK);
    try {
      const v = JSON.parse(await fs.readFile(file, 'utf8')) as { token?: string };
      if (v.token === token) {
        await fs.rm(file, { force: true });
      }
    } catch {
      // Already gone or taken over.
    }
  }
}
