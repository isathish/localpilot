// File leases shared by the log streams, the index persister, migration, backups and imports (design §5.2, §26). Same
// semantics as RecoveryStore's owner lock: `{ pid, host, kind, at, since, token }`, refreshed every 30 s. A lease is
// free when it is absent, when its pid is dead on this host, or (another host only, where a pid cannot be checked)
// when it was not refreshed for 120 s. A live pid on this host keeps its lease however old its time is: age alone never
// frees it here (a process paused in a debugger or on a sleeping laptop still owns its stream).
// Claimed with an exclusive create. A stale lease is taken over under an exclusive `<file>.claim`: only the process
// holding the claim may remove the stale lease, so two takers never both win; every claim is verified by reading the
// token back. Synchronous on purpose: claimed once at start-up (activation budget) and refreshed from a timer. Pure Node.
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { isPidAlive, LOCK_REFRESH_MS, LOCK_STALE_MS } from '../../agent/healing/recoveryStore';

export interface LeaseInfo {
  pid: number;
  host: string;
  kind: string;
  at: number;
  /** When this holder claimed it (tells a new holder of a reused stream from the one that died). */
  since?: number;
  /** Random per holder, so two holders in one process (tests, two logs) are told apart. */
  token?: string;
}

export interface LeaseOptions {
  kind: string;
  pid?: number;
  host?: string;
  now?: () => number;
  /** Refresh period; 0 = no timer (callers refresh themselves). */
  refreshMs?: number;
  staleMs?: number;
}

/** A take-over claim older than this belongs to a taker that died in the middle (claims live for milliseconds). */
const CLAIM_STALE_MS = 10_000;

export function readLease(file: string): LeaseInfo | undefined {
  try {
    const v = JSON.parse(fs.readFileSync(file, 'utf8')) as LeaseInfo;
    return typeof v?.pid === 'number' && typeof v.host === 'string' && typeof v.at === 'number' ? v : undefined;
  } catch {
    return undefined;
  }
}

/**
 * True when nobody live holds the lease: absent, unreadable for a while, a dead pid on this host, or (other hosts,
 * whose pids cannot be checked) not refreshed for the stale age.
 */
export function leaseIsFree(file: string, o: { now?: () => number; host?: string; staleMs?: number; pid?: number; token?: string } = {}): boolean {
  const now = (o.now ?? Date.now)();
  const host = o.host ?? os.hostname();
  const l = readLease(file);
  if (!l) {
    try {
      // Between another process's exclusive create and its body write: give it a moment.
      return now - fs.statSync(file).mtimeMs > 2000;
    } catch {
      return true;
    }
  }
  if (o.token && l.token === o.token) {
    return true;
  }
  if (l.host === host) {
    return !isPidAlive(l.pid);
  }
  return now - l.at > (o.staleMs ?? LOCK_STALE_MS);
}

/**
 * Whether the process that wrote something (a draft, a run) as `pid` at `startedAt` still holds the stream's lease. A
 * stream id is reused by the next process once its writer died, so a held lease alone proves nothing: the holder must
 * be that pid (and, when the lease says when it was claimed, have held it since before `startedAt`).
 */
export function leaseHeldBy(file: string, pid: number | undefined, startedAt?: number, o: { now?: () => number; host?: string } = {}): boolean {
  if (leaseIsFree(file, o)) {
    return false;
  }
  const l = readLease(file);
  if (!l) {
    return true; // being written right now: assume its writer is alive
  }
  if (pid !== undefined && l.pid !== pid) {
    return false;
  }
  if (startedAt !== undefined && l.since !== undefined && l.since > startedAt) {
    return false; // claimed again after the run began: its writer died and the stream was reused
  }
  return true;
}

export class Lease {
  private timer?: NodeJS.Timeout;
  private held = false;
  readonly pid: number;
  readonly host: string;
  readonly token = crypto.randomBytes(8).toString('hex');
  private since = 0;
  private readonly now: () => number;

  constructor(readonly file: string, private readonly o: LeaseOptions) {
    this.pid = o.pid ?? process.pid;
    this.host = o.host ?? os.hostname();
    this.now = o.now ?? Date.now;
  }

  get isHeld(): boolean {
    return this.held;
  }

  private body(): string {
    return JSON.stringify({ pid: this.pid, host: this.host, kind: this.o.kind, at: this.now(), since: this.since, token: this.token } satisfies LeaseInfo);
  }

  /** Exclusive create of the lease file, verified by reading the token back. Throws EEXIST when it exists. */
  private create(): boolean {
    this.since = this.now();
    fs.writeFileSync(this.file, this.body(), { flag: 'wx' });
    return readLease(this.file)?.token === this.token;
  }

  /** Takes the lease when it is free (or already ours). Never throws; false = someone live holds it. */
  tryClaim(): boolean {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
    } catch {
      return false;
    }
    for (let i = 0; i < 4; i++) {
      try {
        return this.create() ? this.claimed() : false;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') {
          return false;
        }
      }
      const cur = readLease(this.file);
      if (cur && cur.token === this.token) {
        this.refresh();
        return this.claimed();
      }
      if (!leaseIsFree(this.file, { now: this.now, host: this.host, staleMs: this.o.staleMs, pid: this.pid, token: this.token })) {
        return false;
      }
      // Stale: taken over under an exclusive claim, so only one taker removes it.
      const r = this.takeOver();
      if (r !== 'retry') {
        return r === 'won' ? this.claimed() : false;
      }
    }
    return false;
  }

  /** Removes a stale lease and creates ours while holding `<file>.claim`. */
  private takeOver(): 'won' | 'lost' | 'retry' {
    const claim = `${this.file}.claim`;
    try {
      fs.writeFileSync(claim, JSON.stringify({ pid: this.pid, token: this.token, at: Date.now() }), { flag: 'wx' });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') {
        return 'lost';
      }
      // Another taker is at it. A claim left behind by a taker that died is cleared after a while.
      try {
        if (Date.now() - fs.statSync(claim).mtimeMs > CLAIM_STALE_MS) {
          fs.rmSync(claim, { force: true });
          return 'retry';
        }
      } catch {
        return 'retry';
      }
      return 'lost';
    }
    try {
      // Still stale now that we hold the claim (another taker may have finished just before we got it)?
      if (fs.existsSync(this.file) && !leaseIsFree(this.file, { now: this.now, host: this.host, staleMs: this.o.staleMs, pid: this.pid, token: this.token })) {
        return 'lost';
      }
      fs.rmSync(this.file, { force: true });
      try {
        return this.create() ? 'won' : 'lost';
      } catch {
        return 'lost';
      }
    } finally {
      try {
        if ((JSON.parse(fs.readFileSync(claim, 'utf8')) as { token?: string }).token === this.token) {
          fs.rmSync(claim, { force: true });
        }
      } catch {
        // gone
      }
    }
  }

  private claimed(): boolean {
    this.held = true;
    const every = this.o.refreshMs ?? LOCK_REFRESH_MS;
    if (every > 0 && !this.timer) {
      this.timer = setInterval(() => this.refresh(), every);
      this.timer.unref?.();
    }
    return true;
  }

  /**
   * Whether we still hold it, checked on disk. A lease file removed under us is created again; one that names another
   * holder means we were taken over (`isHeld` turns false).
   */
  verify(): boolean {
    if (!this.held) {
      return false;
    }
    const cur = readLease(this.file);
    if (cur?.token === this.token) {
      return true;
    }
    if (!cur) {
      if (!fs.existsSync(this.file)) {
        try {
          if (this.create()) {
            return true;
          }
        } catch {
          // another process created it first: read below
        }
      }
      const again = readLease(this.file);
      if (!again || again.token === this.token) {
        return true; // another process between its create and its write, or ours after all
      }
    }
    this.held = false;
    this.stop();
    return false;
  }

  /** Rewrites the lease's time (tmp + rename) while we hold it. */
  refresh(): void {
    const cur = readLease(this.file);
    if (cur && cur.token !== this.token) {
      // Taken over (we were considered dead): stop pretending to hold it.
      this.held = false;
      this.stop();
      return;
    }
    const tmp = `${this.file}.tmp-${this.pid}-${this.token}`;
    try {
      fs.writeFileSync(tmp, this.body());
      fs.renameSync(tmp, this.file);
    } catch {
      fs.rmSync(tmp, { force: true });
    }
  }

  private stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /** Releases the lease if we still hold it. */
  release(): void {
    this.stop();
    if (!this.held) {
      return;
    }
    this.held = false;
    const cur = readLease(this.file);
    if (cur && cur.token === this.token) {
      fs.rmSync(this.file, { force: true });
    }
  }
}

/**
 * Runs `fn` holding a short lock file `<file>.lock` (exclusive create; a lock older than `staleMs` is broken). For
 * small read-modify-write files several processes share (`seen.json`). Waits up to `waitMs`, then runs `fn` anyway
 * (a rare lost update is better than a stuck sync).
 */
export function withFileLock<T>(file: string, fn: () => T, o: { waitMs?: number; staleMs?: number } = {}): T {
  const lock = `${file}.lock`;
  const deadline = Date.now() + (o.waitMs ?? 2000);
  const token = crypto.randomBytes(6).toString('hex');
  let held = false;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  } catch {
    // the caller's write reports it
  }
  for (;;) {
    try {
      fs.writeFileSync(lock, token, { flag: 'wx' });
      held = true;
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') {
        break;
      }
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > (o.staleMs ?? 10_000)) {
          fs.rmSync(lock, { force: true });
          continue;
        }
      } catch {
        continue;
      }
      if (Date.now() > deadline) {
        break;
      }
      sleepSync(5);
    }
  }
  try {
    return fn();
  } finally {
    if (held) {
      try {
        if (fs.readFileSync(lock, 'utf8') === token) {
          fs.rmSync(lock, { force: true });
        }
      } catch {
        // gone
      }
    }
  }
}

const sleeper = new Int32Array(new SharedArrayBuffer(4));
function sleepSync(ms: number): void {
  Atomics.wait(sleeper, 0, 0, ms);
}
