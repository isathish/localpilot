// Trash purge, version-history window, compaction and blob GC (design §10, §5.6–5.7, §26). Runs at start-up and every
// 24 h. Purge is terminal: a durable `purge` event, then the hooks other modules registered (CONVERSATION removes the
// JSON cache, archive, traces, drafts and checkpoint refs), then redaction of the purged payloads in every local stream
// no live process writes (this process's own, ended processes', other devices' copies, compacted bases). A purge that
// arrives through sync is redacted the same way (`redactRemote`). Each pass also redacts this process's stream for
// every purge the index knows (purges made by other live processes reach it this way), compacts this stream and every
// stream nobody writes, and drops run details older than the window. Pure Node.
import type { EntityKind } from '../events';
import type { BlobStore } from './blobs';
import { compactOtherStreams, compactOwnStream, redactEverywhere, redactOwnStream } from './compaction';
import type { FileEventLog, LogLike } from './eventLog';
import type { IndexClient } from './index/indexClient';

const DAY = 86_400_000;

export type PurgeHook = (ent: EntityKind, id: string) => Promise<void> | void;

export interface RetentionSettings {
  trashRetentionDays: number;
  historyDays: number;
}

export interface RetentionResult {
  purged: number;
  versions: number;
  blobs: { removed: number; bytes: number };
  compacted: number;
  redacted: number;
}

export class Retention {
  private readonly hooks = new Set<PurgeHook>();
  private timer?: NodeJS.Timeout;
  private readonly now: () => number;
  private running?: Promise<RetentionResult>;

  constructor(private readonly o: { log: FileEventLog; index: IndexClient; blobs: BlobStore; settings: () => RetentionSettings; now?: () => number; logger?: LogLike }) {
    this.now = o.now ?? Date.now;
  }

  /** Registers cleanup for purged entities (files outside the log). */
  onPurge(hook: PurgeHook): { dispose(): void } {
    this.hooks.add(hook);
    return { dispose: () => this.hooks.delete(hook) };
  }

  /** Permanently deletes entities (Trash → Delete permanently, retention, Empty Trash). */
  async purge(items: { ent: EntityKind; id: string }[], reason = 'user'): Promise<number> {
    if (!items.length) {
      return 0;
    }
    for (const it of items) {
      this.o.log.append(it.ent, it.id, 'purge', { at: this.now(), reason }, { durable: true });
    }
    await this.o.log.flush();
    await this.cleanup(items);
    await this.o.index.catchUp().catch(() => 0);
    await this.redact(new Set(items.map((i) => i.id)));
    return items.length;
  }

  private async cleanup(items: { ent: EntityKind; id: string }[]): Promise<void> {
    for (const it of items) {
      for (const h of this.hooks) {
        try {
          await h(it.ent, it.id);
        } catch (e) {
          this.o.logger?.warn(`continuity: purge cleanup for ${it.id}: ${String(e)}`);
        }
      }
    }
  }

  private async redact(ids: ReadonlySet<string>): Promise<number> {
    try {
      const r = await redactEverywhere(this.o.log, ids);
      if (r.deferred.length) {
        this.o.logger?.info(`continuity: redaction of ${r.deferred.length} stream(s) written by other processes is left to them (next retention pass): ${r.deferred.join(', ')}`);
      }
      return r.redacted;
    } catch (e) {
      this.o.logger?.warn(`continuity: redaction: ${String(e)}`);
      return 0;
    }
  }

  /**
   * Purges that arrived from another device (sync): their files go (the hooks) and their content is redacted from every
   * local stream, as for a purge made here.
   */
  async redactRemote(items: { ent: EntityKind; id: string }[]): Promise<number> {
    if (!items.length) {
      return 0;
    }
    await this.cleanup(items);
    return this.redact(new Set(items.map((i) => i.id)));
  }

  /** Everything in Trash, now. */
  async emptyTrash(): Promise<number> {
    const rows = await this.o.index.query<{ ent: EntityKind; id: string }>('trashedBefore', { before: Number.MAX_SAFE_INTEGER });
    return this.purge(rows.map((r) => ({ ent: r.ent, id: r.id })), 'empty-trash');
  }

  /** One retention pass. */
  run(): Promise<RetentionResult> {
    this.running ??= this.runOnce().finally(() => (this.running = undefined));
    return this.running;
  }

  private async runOnce(): Promise<RetentionResult> {
    const s = this.o.settings();
    const r: RetentionResult = { purged: 0, versions: 0, blobs: { removed: 0, bytes: 0 }, compacted: 0, redacted: 0 };
    await this.o.index.ready;
    if (s.trashRetentionDays > 0) {
      const rows = await this.o.index.query<{ ent: EntityKind; id: string }>('trashedBefore', { before: this.now() - s.trashRetentionDays * DAY });
      r.purged = await this.purge(rows.map((x) => ({ ent: x.ent, id: x.id })), 'retention');
    }
    r.versions = await this.o.index.pruneVersions(Math.max(7, s.historyDays));
    await this.o.log.flush();
    // Purges made elsewhere (another process, another device) reach this process's stream here.
    const purged = new Set(await this.o.index.query<string>('purgedEntities', {}).catch(() => [] as string[]));
    if (purged.size) {
      r.redacted = await redactOwnStream(this.o.log, purged).catch((e) => {
        this.o.logger?.warn(`continuity: redaction: ${String(e)}`);
        return 0;
      });
    }
    const days = Math.max(7, s.historyDays);
    const c = compactOwnStream(this.o.log, { historyDays: days, now: this.now, purged });
    let others = { streams: 0, segments: 0 };
    try {
      others = compactOtherStreams(this.o.log, { historyDays: days, now: this.now, purged });
    } catch (e) {
      this.o.logger?.warn(`continuity: compaction of other streams: ${String(e)}`);
    }
    if (c.segments || others.segments) {
      r.compacted = c.segments + others.segments;
      // Bodies of compacted events moved: the index re-reads the log.
      await this.o.index.rebuild();
    }
    r.blobs = await this.gc();
    return r;
  }

  /** Removes blobs no event references any more (older than 7 days); the index catches up first. */
  async gc(): Promise<{ removed: number; bytes: number }> {
    await this.o.log.flush();
    await this.o.index.catchUp().catch(() => 0);
    const refs = new Set(await this.o.index.query<string>('referencedBlobs', {}));
    return this.o.blobs.gc(refs, 7);
  }

  /** Runs now (after a short delay) and every 24 h. */
  start(firstDelayMs = 30_000): void {
    const tick = () => void this.run().catch((e) => this.o.logger?.warn(`continuity retention: ${String(e)}`));
    const first = setTimeout(tick, firstDelayMs);
    first.unref?.();
    this.timer = setInterval(tick, DAY);
    this.timer.unref?.();
  }

  dispose(): void {
    clearInterval(this.timer);
  }
}
