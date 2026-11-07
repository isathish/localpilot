// When sync runs (design §14.2): 10 s after start-up, every `intervalMinutes`, 15 s after the last durable change
// (debounced), on window focus, on "Sync now", and when the network comes back. A failed cycle backs off 5 s, 15 s,
// 1 min, 5 min, 15 min (a later success resets it). Pause stops every automatic trigger; "Sync now" still runs. Pure.

export const BACKOFF_MS = [5_000, 15_000, 60_000, 300_000, 900_000] as const;
export const STARTUP_DELAY_MS = 10_000;
export const AFTER_CHANGE_MS = 15_000;
/** Focus triggers at most this often. */
export const FOCUS_MIN_GAP_MS = 60_000;

export type Trigger = 'startup' | 'interval' | 'change' | 'focus' | 'now' | 'online' | 'retry';

export interface Timers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(h: unknown): void;
  now(): number;
}

const realTimers: Timers = {
  setTimeout: (fn, ms) => {
    const h = setTimeout(fn, ms);
    h.unref?.();
    return h;
  },
  clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout),
  now: () => Date.now(),
};

export interface SchedulerOptions {
  /** Runs one cycle; resolves true on success. Never called twice at once. */
  run: (why: Trigger) => Promise<boolean>;
  intervalMinutes: () => number;
  timers?: Timers;
}

export class SyncScheduler {
  private readonly t: Timers;
  private timer?: unknown;
  private changeTimer?: unknown;
  private running = false;
  private current?: Promise<boolean>;
  private queued?: Trigger;
  private failures = 0;
  private paused = false;
  private started = false;
  private disposed = false;
  private lastFocus = 0;
  /** When the next automatic cycle is due (status line). */
  nextAt?: number;

  constructor(private readonly o: SchedulerOptions) {
    this.t = o.timers ?? realTimers;
  }

  get isPaused(): boolean {
    return this.paused;
  }

  get failureCount(): number {
    return this.failures;
  }

  /** Arms the start-up trigger and the interval. */
  start(delayMs = STARTUP_DELAY_MS): void {
    if (this.started || this.disposed) {
      return;
    }
    this.started = true;
    this.arm(delayMs, 'startup');
  }

  private arm(ms: number, why: Trigger): void {
    if (this.timer !== undefined) {
      this.t.clearTimeout(this.timer);
    }
    this.nextAt = this.t.now() + ms;
    this.timer = this.t.setTimeout(() => {
      this.timer = undefined;
      void this.fire(why);
    }, ms);
  }

  private intervalMs(): number {
    return Math.max(1, this.o.intervalMinutes()) * 60_000;
  }

  /** A durable local change: sync 15 s after the last one. */
  changed(): void {
    if (!this.started || this.paused || this.disposed) {
      return;
    }
    if (this.changeTimer !== undefined) {
      this.t.clearTimeout(this.changeTimer);
    }
    this.changeTimer = this.t.setTimeout(() => {
      this.changeTimer = undefined;
      void this.fire('change');
    }, AFTER_CHANGE_MS);
  }

  focused(): void {
    const now = this.t.now();
    if (!this.started || this.paused || now - this.lastFocus < FOCUS_MIN_GAP_MS) {
      return;
    }
    this.lastFocus = now;
    void this.fire('focus');
  }

  /** The network is back (netHint): retry at once if the last cycle failed. */
  online(): void {
    if (this.started && !this.paused && this.failures > 0) {
      void this.fire('online');
    }
  }

  /** "Sync now": runs even while paused; resolves when that cycle (or the one running) ends. */
  async now(): Promise<boolean> {
    return this.fire('now');
  }

  pause(): void {
    this.paused = true;
    if (this.timer !== undefined) {
      this.t.clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.nextAt = undefined;
  }

  resume(): void {
    if (!this.paused) {
      return;
    }
    this.paused = false;
    this.failures = 0;
    if (this.started) {
      this.arm(1_000, 'now');
    }
  }

  private async fire(why: Trigger): Promise<boolean> {
    if (this.disposed || (this.paused && why !== 'now')) {
      return false;
    }
    if (this.running) {
      if (why === 'now' && this.current) {
        // "Sync now" during a cycle: wait for it, then run one that sees everything up to now.
        return this.current.then(() => this.fire('now'));
      }
      this.queued = why;
      return false;
    }
    this.running = true;
    let ok = false;
    const p = this.o.run(why).catch(() => false);
    this.current = p;
    try {
      ok = await p;
    } finally {
      this.running = false;
      this.current = undefined;
    }
    if (this.disposed) {
      return ok;
    }
    this.failures = ok ? 0 : this.failures + 1;
    if (!this.paused) {
      this.arm(ok ? this.intervalMs() : BACKOFF_MS[Math.min(this.failures, BACKOFF_MS.length) - 1], ok ? 'interval' : 'retry');
    }
    const q = this.queued;
    this.queued = undefined;
    if (q && !this.paused) {
      void this.fire(q);
    }
    return ok;
  }

  /** Backoff after `n` consecutive failures (tests, status line). */
  static backoff(n: number): number {
    return n <= 0 ? 0 : BACKOFF_MS[Math.min(n, BACKOFF_MS.length) - 1];
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer !== undefined) {
      this.t.clearTimeout(this.timer);
    }
    if (this.changeTimer !== undefined) {
      this.t.clearTimeout(this.changeTimer);
    }
  }
}
