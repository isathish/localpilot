/** Bounded-concurrency task pool used for parallel tool execution and parallel subagents. */
export class ParallelPool {
  private running = 0;
  private queue: (() => void)[] = [];

  constructor(public readonly maxConcurrency: number) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.running >= this.maxConcurrency) {
      await new Promise<void>((resolve) => this.queue.push(resolve));
    }
    this.running++;
    try {
      return await fn();
    } finally {
      this.running--;
      this.queue.shift()?.();
    }
  }

  /** Runs all tasks with bounded concurrency; preserves input order in the result. */
  async map<T, R>(items: readonly T[], fn: (item: T, index: number) => Promise<R>): Promise<PromiseSettledResult<R>[]> {
    return Promise.allSettled(items.map((item, i) => this.run(() => fn(item, i))));
  }

  get active(): number {
    return this.running;
  }
  get pending(): number {
    return this.queue.length;
  }
}

export interface WaveItem {
  id: string;
  dependsOn?: string[];
}

export interface Wave<T> {
  /** Items whose prerequisites are all satisfied — run these concurrently. */
  ready: T[];
  /** Items that can never run because a prerequisite failed or was skipped. */
  blocked: T[];
  /** Items that only depend on each other (a cycle) — nothing can start them. */
  cyclic: T[];
}

/**
 * Dependency-wave scheduling for a checklist. Given the items still to run, the ids already satisfied (done, or
 * outside the run set) and the ids that failed, returns the next wave. Callers loop: run `ready`, add their ids
 * to `satisfied` or `failed`, call again until `ready` is empty. Items waiting on an id that is neither
 * satisfied, failed nor part of `items` stay out of every bucket (they wait for work someone else must do).
 */
export function nextWave<T extends WaveItem>(items: readonly T[], satisfied: ReadonlySet<string>, failed: ReadonlySet<string>): Wave<T> {
  const inSet = new Set(items.map((i) => i.id));
  const ready: T[] = [];
  const blocked: T[] = [];
  const waiting: T[] = [];
  for (const item of items) {
    const deps = (item.dependsOn ?? []).filter((d) => d !== item.id);
    if (deps.some((d) => failed.has(d))) {
      blocked.push(item);
    } else if (deps.every((d) => satisfied.has(d))) {
      ready.push(item);
    } else {
      waiting.push(item);
    }
  }
  // A cycle is a waiting item whose unmet deps are all themselves waiting items in this set.
  const waitingIds = new Set(waiting.map((w) => w.id));
  const cyclic = ready.length
    ? []
    : waiting.filter((w) => (w.dependsOn ?? []).filter((d) => !satisfied.has(d)).every((d) => waitingIds.has(d) && inSet.has(d)));
  return { ready, blocked, cyclic };
}

/**
 * Splits `items` into at most `parts` groups of roughly equal weight, keeping each item whole — used to shard a
 * workspace (by top-level folder, weighted by file count) across parallel subagents.
 */
export function balancedShards<T>(items: readonly T[], weight: (item: T) => number, parts: number): T[][] {
  const n = Math.max(1, Math.min(parts, items.length));
  const shards: { items: T[]; weight: number }[] = Array.from({ length: n }, () => ({ items: [], weight: 0 }));
  for (const item of [...items].sort((a, b) => weight(b) - weight(a))) {
    const lightest = shards.reduce((best, s) => (s.weight < best.weight ? s : best), shards[0]);
    lightest.items.push(item);
    lightest.weight += weight(item);
  }
  return shards.filter((s) => s.items.length).map((s) => s.items);
}
