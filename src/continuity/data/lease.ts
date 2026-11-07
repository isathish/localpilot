// File leases shared by the log streams, the index persister, migration and backups (design §5.2). Same semantics as
// RecoveryStore's owner lock: `{ pid, host, kind, at }`, refreshed every 30 s, stale after 120 s or when its pid is dead
// on this host. Claimed with an exclusive create; a stale lease is first renamed aside so only one taker wins.
// Synchronous on purpose: claimed once at start-up (activation budget) and refreshed from a timer. Pure Node.
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

export function readLease(file: string): LeaseInfo | undefined {
  try {
    const v = JSON.parse(fs.readFileSync(file, 'utf8')) as LeaseInfo;
    return typeof v?.pid === 'number' && typeof v.host === 'string' && typeof v.at === 'number' ? v : undefined;
  } catch {
    return undefined;
  }
}

/** True when nobody live holds the lease: absent, unreadable for a while, older than the stale age, or a dead pid here. */
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
  return now - l.at > (o.staleMs ?? LOCK_STALE_MS) || (l.host === host && !isPidAlive(l.pid));
}

export class Lease {
  private timer?: NodeJS.Timeout;
  private held = false;
  readonly pid: number;
  readonly host: string;
  readonly token = crypto.randomBytes(8).toString('hex');
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
    return JSON.stringify({ pid: this.pid, host: this.host, kind: this.o.kind, at: this.now(), token: this.token } satisfies LeaseInfo);
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
        fs.writeFileSync(this.file, this.body(), { flag: 'wx' });
        return this.claimed();
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
      // Stale: move it aside (only one racer's rename succeeds), then retry the exclusive create.
      const aside = `${this.file}.stale-${this.pid}-${i}`;
      try {
        fs.renameSync(this.file, aside);
        fs.rmSync(aside, { force: true });
      } catch {
        // Another process moved it first; the next exclusive create decides.
      }
    }
    return false;
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

  /** Rewrites the lease's time (tmp + rename) while we hold it. */
  refresh(): void {
    const cur = readLease(this.file);
    if (cur && cur.token !== this.token) {
      // Taken over (we were considered dead): stop pretending to hold it.
      this.held = false;
      this.stop();
      return;
    }
    const tmp = `${this.file}.tmp-${this.pid}`;
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
