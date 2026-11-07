// DataManager (design §10, §16.3): what Settings → Continuity & sync and `localpilot data …` show and do — sizes, backups
// (manual and automatic), restore, index rebuild, migration status / retry / backup removal, Empty Trash, GC.
// Pure Node.
import * as fs from 'fs';
import * as path from 'path';
import type { BlobStore } from './blobs';
import { BackupResult, listBackups, pruneBackups, RestoreResult, restoreBackup, writeBackup } from './backup';
import type { FileEventLog, LogLike } from './eventLog';
import type { IndexStatus } from './index/engine';
import type { IndexClient } from './index/indexClient';
import { Lease } from './lease';
import { dirSize, Migration, MigrationStatus } from './migration';
import type { Retention } from './retention';

export interface BackupSettings {
  enabled: boolean;
  intervalDays: number;
  keep: number;
}

export interface DataStats {
  dataDir: string;
  deviceId: string;
  deviceName: string;
  stream: string;
  streams: number;
  bytes: { logs: number; index: number; blobs: number; backups: number; migrationBackup: number; drafts: number; total: number };
  index?: IndexStatus;
  conversations?: number;
  messages?: number;
  memory?: number;
  trash?: number;
  lastBackup?: { file: string; at: number; bytes: number };
  backups: number;
  migration: MigrationStatus;
}

const DAY = 86_400_000;

export class DataManager {
  readonly backupsDir: string;
  private timer?: NodeJS.Timeout;
  private readonly now: () => number;

  constructor(
    private readonly o: {
      root: string;
      log: FileEventLog;
      index: IndexClient;
      blobs: BlobStore;
      migration: Migration;
      retention: Retention;
      backup: () => BackupSettings;
      appVersion?: string;
      now?: () => number;
      logger?: LogLike;
    }
  ) {
    this.backupsDir = path.join(o.root, 'backups');
    this.now = o.now ?? Date.now;
  }

  get root(): string {
    return this.o.root;
  }

  async stats(): Promise<DataStats> {
    const r = this.o.root;
    const logs = dirSize(path.join(r, 'streams'));
    const index = dirSize(path.join(r, 'index'));
    const blobs = dirSize(path.join(r, 'blobs'));
    const backups = dirSize(this.backupsDir);
    const migrationBackup = dirSize(path.join(r, 'migration', 'legacy-backup'));
    const drafts = dirSize(path.join(r, 'drafts'));
    const list = listBackups(this.backupsDir);
    const streams = await this.o.log.streams();
    let idx: IndexStatus | undefined;
    let sizes: { conversations: number; messages: number; memory: number; trash: number } | undefined;
    try {
      idx = await Promise.race([this.o.index.status(), new Promise<undefined>((res) => setTimeout(() => res(undefined), 3000).unref?.())]);
      if (idx?.state === 'ready') {
        sizes = (await this.o.index.query<{ conversations: number; messages: number; memory: number; trash: number }>('sizes'))[0];
      }
    } catch {
      // index failed: sizes from the folders only
    }
    return {
      dataDir: r,
      deviceId: this.o.log.device.deviceId,
      deviceName: this.o.log.device.name,
      stream: this.o.log.stream,
      streams: streams.length,
      bytes: { logs, index, blobs, backups, migrationBackup, drafts, total: dirSize(r) },
      index: idx,
      ...(sizes ?? {}),
      lastBackup: list[0] ? { file: list[0].file, at: list[0].at, bytes: list[0].bytes } : undefined,
      backups: list.length,
      migration: this.o.migration.status(),
    };
  }

  /** Writes a backup now (to `file`, else backups/<stamp>.lpbackup) and keeps the newest `backup.keep`. */
  async backup(o: { passphrase?: string; file?: string } = {}): Promise<BackupResult> {
    const r = await writeBackup({ log: this.o.log, blobs: this.o.blobs, dir: this.backupsDir, file: o.file, passphrase: o.passphrase, now: this.now, appVersion: this.o.appVersion });
    if (!o.file) {
      pruneBackups(this.backupsDir, this.o.backup().keep);
    }
    return r;
  }

  listBackups(): { file: string; bytes: number; at: number }[] {
    return listBackups(this.backupsDir);
  }

  async restore(file: string, passphrase?: string): Promise<RestoreResult> {
    const r = await restoreBackup({ log: this.o.log, blobs: this.o.blobs, file, passphrase });
    await this.o.index.catchUp().catch(() => 0);
    return r;
  }

  rebuildIndex(): Promise<void> {
    return this.o.index.rebuild();
  }

  migrationStatus(): MigrationStatus {
    return this.o.migration.status();
  }

  async retryMigration(): Promise<MigrationStatus> {
    await this.o.migration.run({ retry: true });
    await this.o.index.catchUp().catch(() => 0);
    return this.o.migration.status();
  }

  removeMigrationBackup(): number {
    return this.o.migration.removeBackup();
  }

  emptyTrash(): Promise<number> {
    return this.o.retention.emptyTrash();
  }

  gc(): Promise<{ removed: number; bytes: number }> {
    return this.o.retention.gc();
  }

  /** The automatic backup, when it is due (one process at a time). */
  async autoBackup(): Promise<BackupResult | undefined> {
    const s = this.o.backup();
    if (!s.enabled) {
      return undefined;
    }
    const last = listBackups(this.backupsDir)[0];
    if (last && this.now() - last.at < Math.max(1, s.intervalDays) * DAY) {
      return undefined;
    }
    const lease = new Lease(path.join(this.backupsDir, 'lease.json'), { kind: 'backup', now: this.now, refreshMs: 0 });
    fs.mkdirSync(this.backupsDir, { recursive: true });
    if (!lease.tryClaim()) {
      return undefined;
    }
    try {
      const r = await this.backup();
      this.o.logger?.info(`continuity: automatic backup ${path.basename(r.file)} (${r.events} events)`);
      return r;
    } finally {
      lease.release();
    }
  }

  /** Checks the automatic backup a minute after start-up, then every 6 h. */
  start(firstDelayMs = 60_000): void {
    const tick = () => void this.autoBackup().catch((e) => this.o.logger?.warn(`continuity backup: ${String(e)}`));
    const first = setTimeout(tick, firstDelayMs);
    first.unref?.();
    this.timer = setInterval(tick, 6 * 3600_000);
    this.timer.unref?.();
  }

  dispose(): void {
    clearInterval(this.timer);
  }
}
