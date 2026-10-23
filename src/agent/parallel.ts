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
