import * as path from "path";
import type { Failure } from "./types";

/** Per-workspace-root semaphore for heavy checks plus the recovery bus that rolls child sessions up to their root (design §5.3). */

interface Waiter {
  resolve: (release: () => void) => void;
  reject: (err: Error) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

interface Lane {
  key: string;
  permits: number;
  active: number;
  queue: Waiter[];
}

export interface SemaphoreStats {
  /** Highest number of concurrently held permits observed for any single root. */
  maxConcurrent: number;
  /** Holders and waiters per root right now. */
  roots: Record<string, { active: number; waiting: number; permits: number }>;
}

function abortError(): Error {
  const err = new Error(
    "Check cancelled while waiting for the check semaphore",
  );
  err.name = "AbortError";
  return err;
}

export function semaphoreKey(root: string): string {
  const resolved = path.resolve(root);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

export class CheckSemaphore {
  private readonly lanes = new Map<string, Lane>();
  private maxConcurrent = 0;

  constructor(private readonly defaultPermits = 1) {}

  /** Sets the permit count for a root (min 1); takes effect for the next grants. */
  setPermits(root: string, permits: number): void {
    const lane = this.lane(semaphoreKey(root));
    lane.permits = Math.max(1, Math.floor(permits) || 1);
    this.drain(lane);
  }

  /** Resolves with an idempotent release function once a permit for `root` is free; FIFO. Rejects (AbortError) on abort without consuming a permit. */
  acquire(root: string, signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) {
      return Promise.reject(abortError());
    }
    const key = semaphoreKey(root);
    const lane = this.lane(key);
    if (lane.active < lane.permits && lane.queue.length === 0) {
      return Promise.resolve(this.grant(key, lane));
    }
    return new Promise<() => void>((resolve, reject) => {
      const waiter: Waiter = { resolve, reject, signal };
      if (signal) {
        waiter.onAbort = () => {
          const i = lane.queue.indexOf(waiter);
          if (i < 0) {
            return;
          }
          lane.queue.splice(i, 1);
          reject(abortError());
          this.prune(key, lane);
        };
        signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
      lane.queue.push(waiter);
    });
  }

  /** Runs `fn` while holding a permit for `root`. */
  async run<T>(
    root: string,
    fn: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    const release = await this.acquire(root, signal);
    try {
      return await fn();
    } finally {
      release();
    }
  }

  stats(): SemaphoreStats {
    const roots: SemaphoreStats["roots"] = {};
    for (const [key, lane] of this.lanes) {
      roots[key] = {
        active: lane.active,
        waiting: lane.queue.length,
        permits: lane.permits,
      };
    }
    return { maxConcurrent: this.maxConcurrent, roots };
  }

  /** Clears the observed maximum (tests). */
  resetStats(): void {
    this.maxConcurrent = 0;
  }

  private lane(key: string): Lane {
    let lane = this.lanes.get(key);
    if (!lane) {
      lane = { key, permits: this.defaultPermits, active: 0, queue: [] };
      this.lanes.set(key, lane);
    }
    return lane;
  }

  private grant(key: string, lane: Lane): () => void {
    lane.active++;
    if (lane.active > this.maxConcurrent) {
      this.maxConcurrent = lane.active;
    }
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      lane.active--;
      this.drain(lane);
      this.prune(key, lane);
    };
  }

  private drain(lane: Lane): void {
    while (lane.active < lane.permits && lane.queue.length) {
      const waiter = lane.queue.shift()!;
      if (waiter.signal && waiter.onAbort) {
        waiter.signal.removeEventListener("abort", waiter.onAbort);
      }
      if (waiter.signal?.aborted) {
        waiter.reject(abortError());
        continue;
      }
      waiter.resolve(this.grant(lane.key, lane));
    }
  }

  private prune(key: string, lane: Lane): void {
    if (
      lane.active === 0 &&
      lane.queue.length === 0 &&
      lane.permits === this.defaultPermits
    ) {
      this.lanes.delete(key);
    }
  }
}

export const checkSemaphore = new CheckSemaphore(1);

/** Workers roll up full failures so the root can query failure memory (`generic`), write RCA briefs and apply its budgets. */
export type BusFailure = Failure;

export type RecoveryBusMessage =
  | {
      type: "worker_result";
      childId: string;
      healthy: boolean;
      failures: BusFailure[];
    }
  | { type: "worker_failure_detected"; childId: string; failures: BusFailure[] }
  | {
      type: "child_write";
      childId: string;
      phase: "before" | "after";
      paths: string[];
    };

export type RecoveryBusHandler = (
  msg: RecoveryBusMessage,
  fromSessionId: string,
) => void;

export function rootSessionId(sessionId: string): string {
  return sessionId.split("::")[0];
}

export class RecoveryBus {
  private readonly handlers = new Map<string, Set<RecoveryBusHandler>>();

  /** Subscribes to messages published by `rootSessionId` or any of its children; returns an unsubscribe function. */
  subscribe(rootSid: string, handler: RecoveryBusHandler): () => void {
    const key = rootSessionId(rootSid);
    let set = this.handlers.get(key);
    if (!set) {
      set = new Set();
      this.handlers.set(key, set);
    }
    set.add(handler);
    return () => {
      const cur = this.handlers.get(key);
      if (!cur) {
        return;
      }
      cur.delete(handler);
      if (!cur.size) {
        this.handlers.delete(key);
      }
    };
  }

  /** Delivers `msg` to the subscribers of the publisher's root session; returns how many handlers received it. Handler errors are isolated. */
  publish(sessionId: string, msg: RecoveryBusMessage): number {
    const set = this.handlers.get(rootSessionId(sessionId));
    if (!set) {
      return 0;
    }
    let delivered = 0;
    for (const handler of [...set]) {
      try {
        handler(msg, sessionId);
        delivered++;
      } catch {
        // one failing engine must not starve the others
      }
    }
    return delivered;
  }

  hasSubscribers(sessionId: string): boolean {
    return (this.handlers.get(rootSessionId(sessionId))?.size ?? 0) > 0;
  }
}

export const recoveryBus = new RecoveryBus();
