// The sync engine (design §14): moves this device's event streams to a remote and other devices' streams back,
// end-to-end encrypted. One cycle at a time per data root (`sync/lease.json`): push (own streams in sealed chunks whose
// boundaries are saved before upload, so a retry writes the same objects; then the blobs they refer to; then this
// device's file with its heads), pull (other devices' files, then their new chunks, imported gapless into local copies
// of their streams), apply (the index catches up; the reducer finds conflicts; managers' onRemoteChange fire),
// housekeeping (daily: own old chunks replaced by a compacted base). The offline queue is the log itself plus
// `sync/state.json`. Nothing here imports vscode.
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { EventEnvelope } from '../events';
import { isWithheld, withheldStandIn } from '../events';
import type { BlobStore } from '../data/blobs';
import { sha256 } from '../data/blobs';
import { SealError } from '../data/crypto/envelope';
import { changePassphrase, createKeyring, DataKey, KeyringFile, rotateKey, unlockKeyring, WrongPassphraseError } from '../data/crypto/keyring';
import type { SecretBox } from '../data/crypto/secretBox';
import { loadDataKeys, storeDataKeys } from '../data/crypto/secretBox';
import { Emitter, FileEventLog, Subscribable } from '../data/eventLog';
import type { IndexClient } from '../data/index/indexClient';
import { Lease, leaseIsFree } from '../data/lease';
import { DEFAULT_RULES, EntityState, noteEdit, reduce } from '../data/reducer';
import { listSegments, readSegmentLines, readStreamDir } from '../data/segment';
import { BackendError, BackendKind, CheckResult, reasonOf, SyncBackend, SyncBackendConfig } from './backends/backend';
import { createBackend } from './backends/create';
import { ConflictEffects, ConflictService } from './conflicts';
import { DeviceRegistry, DeviceRow } from './devices';
import { blobRefs, categoryOfEntity, DEFAULT_CATEGORIES, normalizeCategories, SyncCategories, SyncCategory, withholdReason } from './merge';
import {
  baseKey,
  blobKey,
  chunkKey,
  cutChunks,
  decodeEvents,
  DeviceFile,
  deviceKey,
  encodeEvents,
  FORMAT_KEY,
  FORMAT_NAME,
  FormatFile,
  isFormat,
  isKeyring,
  KEYRING_KEY,
  newRemoteId,
  openObject,
  parseStreamObject,
  readJson,
  sealObject,
  streamPrefix,
} from './protocol';
import { SyncScheduler, Trigger } from './scheduler';

export interface SyncSettings {
  enabled: boolean;
  backend: BackendKind;
  folder: { path: string };
  git: { url: string; branch: string };
  s3: { endpoint: string; region: string; bucket: string; prefix: string; accessKeyId: string; pathStyle?: boolean };
  webdav: { url: string; username: string };
  intervalMinutes: number;
  categories: SyncCategories;
  maxAttachmentMB: number;
  deviceName: string;
}

export const DEFAULT_SYNC_SETTINGS: SyncSettings = {
  enabled: false,
  backend: 'folder',
  folder: { path: '' },
  git: { url: '', branch: 'localpilot-sync' },
  s3: { endpoint: '', region: 'us-east-1', bucket: '', prefix: '', accessKeyId: '' },
  webdav: { url: '', username: '' },
  intervalMinutes: 5,
  categories: { ...DEFAULT_CATEGORIES },
  maxAttachmentMB: 20,
  deviceName: '',
};

export type SyncStateName = 'off' | 'idle' | 'syncing' | 'offline' | 'paused' | 'error';

export interface SyncStatus {
  state: SyncStateName;
  /** Local changes not uploaded yet. */
  pending: number;
  /** Attachments waiting to upload or download. */
  pendingBlobs: number;
  conflicts: number;
  lastSync?: number;
  lastAttempt?: number;
  /** Machine-readable cause of paused / offline / error (`auth`, `passphrase`, `remote-replaced`, `user`…). */
  reason?: string;
  message?: string;
  /** Sync is set up here but the data key is missing (key rotated elsewhere, or not joined). */
  needsPassphrase?: boolean;
  backend?: BackendKind;
  label?: string;
  nextAt?: number;
  /** Another window or the CLI runs the cycles right now. */
  elsewhere?: boolean;
  configured: boolean;
}

interface OwnStreamState {
  uploaded: number;
  base?: number;
  /** Chunk boundaries saved before upload (a retry uploads the same objects). */
  pending?: { from: number; to: number; sig: string }[];
}

interface RemoteDeviceState {
  name?: string;
  lastSeen?: number;
  heads: Record<string, number>;
  bases?: Record<string, number>;
  revokedAt?: number;
  etag?: string;
}

export interface SyncStateFile {
  v: 1;
  remoteId?: string;
  backendSig?: string;
  keyIds: string[];
  current?: string;
  joinedAt?: number;
  own: Record<string, OwnStreamState>;
  devices: Record<string, RemoteDeviceState>;
  /** Entities whose events were withheld because their category was off: re-sent when it is turned on. */
  withheld: Partial<Record<SyncCategory, string[]>>;
  uploadedBlobs: string[];
  pendingBlobs: Record<string, number>;
  lastSync?: number;
  lastAttempt?: number;
  lastError?: { reason: string; message: string; at: number };
  paused?: { reason: string; message: string; at: number };
  lastHousekeeping?: number;
  categoriesSeen?: SyncCategories;
  needsPassphrase?: string;
  /** Last cycle's numbers (Sync manager). */
  last?: { uploaded: number; downloaded: number; bytes: number };
}

const emptyState = (): SyncStateFile => ({ v: 1, keyIds: [], own: {}, devices: {}, withheld: {}, uploadedBlobs: [], pendingBlobs: {} });

export interface SyncEngineOptions {
  log: FileEventLog;
  index: IndexClient;
  blobs: BlobStore;
  /** The data root. */
  root: string;
  secrets: SecretBox;
  settings: () => SyncSettings;
  writer: 'vscode' | 'cli';
  appVersion: string;
  now?: () => number;
  fetch?: typeof fetch;
  gitPath?: string;
  /** Tests: a backend instead of the one the settings name. */
  backend?: SyncBackend;
  /** Tests: scrypt cost. */
  kdfN?: number;
  warn?: (m: string) => void;
  info?: (m: string) => void;
  effects?: () => ConflictEffects;
  /** A passphrase from the environment (CLI: LOCALPILOT_SYNC_PASSPHRASE) to unlock a rotated key without asking. */
  passphraseHint?: () => string | undefined;
  /** Blob bytes downloaded per cycle (lazy beyond). */
  blobBudgetBytes?: number;
}

const DAY = 86_400_000;
const HOUR = 3_600_000;
const MAX_EVENTS_PER_CYCLE = 50_000;
const GIT_MAX_BLOB = 5 * 1024 * 1024;

/** The backend config the settings name (no secrets). */
export function backendConfig(s: SyncSettings): SyncBackendConfig {
  switch (s.backend) {
    case 'git':
      return { kind: 'git', git: { url: s.git.url.trim(), branch: s.git.branch.trim() || 'localpilot-sync' } };
    case 's3':
      return { kind: 's3', s3: { ...s.s3, endpoint: s.s3.endpoint.trim(), bucket: s.s3.bucket.trim(), prefix: s.s3.prefix.trim(), accessKeyId: s.s3.accessKeyId.trim(), region: s.s3.region.trim() || 'us-east-1' } };
    case 'webdav':
      return { kind: 'webdav', webdav: { url: s.webdav.url.trim(), username: s.webdav.username.trim() } };
    default:
      return { kind: 'folder', folder: { path: s.folder.path.trim() } };
  }
}

export function backendSig(cfg: SyncBackendConfig): string {
  return crypto.createHash('sha256').update(JSON.stringify(cfg)).digest('hex').slice(0, 16);
}

/** A thrown reason the Sync manager shows as "paused" rather than "error". */
class Paused extends Error {
  constructor(readonly reason: string, message: string) {
    super(message);
  }
}

export class SyncEngine {
  readonly conflicts: ConflictService;
  readonly devices: DeviceRegistry;
  readonly scheduler: SyncScheduler;
  private readonly dir: string;
  private readonly stateFile: string;
  private readonly leaseFile: string;
  private st: SyncStateFile;
  private keys = new Map<string, DataKey>();
  private syncing = false;
  private disposed = false;
  private readonly statusEmitter = new Emitter<SyncStatus>();
  readonly onStatus: Subscribable<SyncStatus> = this.statusEmitter.event;
  private readonly appliedEmitter = new Emitter<{ events: number; devices: string[] }>();
  /** After a cycle imported events from other devices (ids of the devices). */
  readonly onPulled: Subscribable<{ events: number; devices: string[] }> = this.appliedEmitter.event;
  private conflictCount = 0;
  private reported = new Set<string>();
  private subs: { dispose(): void }[] = [];
  private lastStatus = '';
  private backendCache?: { sig: string; backend: SyncBackend };

  constructor(private readonly o: SyncEngineOptions) {
    this.dir = path.join(o.root, 'sync');
    this.stateFile = path.join(this.dir, 'state.json');
    this.leaseFile = path.join(this.dir, 'lease.json');
    this.st = this.readState();
    this.conflicts = new ConflictService({ log: o.log, index: o.index, effects: o.effects, now: o.now });
    this.devices = new DeviceRegistry({ log: o.log, index: o.index, writer: o.writer, appVersion: o.appVersion, now: o.now });
    this.scheduler = new SyncScheduler({ run: (why) => this.cycle(why), intervalMinutes: () => this.settings().intervalMinutes });
    // A durable local change: sync 15 s after the last one (other processes' changes are seen by the interval).
    this.subs.push(o.log.onAppend((batch) => (batch.some((e) => !e.local) ? this.scheduler.changed() : undefined)));
    this.subs.push(o.index.onApplied((n) => {
      if (n.conflicts) {
        void this.refreshConflicts();
      }
    }));
  }

  private get now(): number {
    return (this.o.now ?? Date.now)();
  }

  settings(): SyncSettings {
    const s = this.o.settings();
    return { ...DEFAULT_SYNC_SETTINGS, ...s, categories: normalizeCategories(s.categories) };
  }

  /** Sync is set up on this data root (a remote joined and a data key here). */
  get configured(): boolean {
    return !!this.st.remoteId && this.st.keyIds.length > 0;
  }

  get remoteId(): string | undefined {
    return this.st.remoteId;
  }

  get state(): Readonly<SyncStateFile> {
    return this.st;
  }

  // ---------------------------------------------------------------------------------------------- state file

  private readState(): SyncStateFile {
    try {
      const v = JSON.parse(fs.readFileSync(path.join(this.o.root, 'sync', 'state.json'), 'utf8')) as SyncStateFile;
      return v?.v === 1 ? { ...emptyState(), ...v } : emptyState();
    } catch {
      return emptyState();
    }
  }

  private saveState(): void {
    fs.mkdirSync(this.dir, { recursive: true });
    const tmp = `${this.stateFile}.tmp-${process.pid}-${crypto.randomBytes(3).toString('hex')}`;
    fs.writeFileSync(tmp, `${JSON.stringify(this.st, null, 1)}\n`);
    fs.renameSync(tmp, this.stateFile);
  }

  /** Re-reads state another process (the lease holder) wrote. */
  reload(): void {
    if (!this.syncing) {
      this.st = this.readState();
    }
  }

  // ---------------------------------------------------------------------------------------------- keys

  private async loadKeys(): Promise<void> {
    if (!this.st.remoteId) {
      this.keys.clear();
      return;
    }
    const want = this.st.keyIds.filter((k) => !this.keys.has(k));
    if (want.length) {
      for (const k of await loadDataKeys(this.o.secrets, this.st.remoteId, want)) {
        this.keys.set(k.keyId, k);
      }
    }
  }

  private keyOf = (keyId: string): DataKey | undefined => this.keys.get(keyId);

  private currentKey(): DataKey {
    const k = this.st.current ? this.keys.get(this.st.current) : undefined;
    if (!k) {
      throw new Paused('passphrase', 'Enter your sync passphrase on this device to keep syncing');
    }
    return k;
  }

  private async rememberKeys(remoteId: string, file: KeyringFile, keys: DataKey[]): Promise<void> {
    await storeDataKeys(this.o.secrets, remoteId, keys);
    for (const k of keys) {
      this.keys.set(k.keyId, k);
    }
    this.st.keyIds = [...new Set([...this.st.keyIds, ...keys.map((k) => k.keyId)])];
    this.st.current = file.current;
  }

  // ---------------------------------------------------------------------------------------------- backend

  private async backend(): Promise<SyncBackend> {
    if (this.o.backend) {
      return this.o.backend;
    }
    const cfg = backendConfig(this.settings());
    const sig = backendSig(cfg);
    if (this.backendCache?.sig === sig) {
      return this.backendCache.backend;
    }
    this.backendCache?.backend.dispose();
    const backend = await createBackend(cfg, { secrets: this.o.secrets, fetch: this.o.fetch, gitPath: this.o.gitPath, workDir: this.dir, deviceName: this.o.log.device.name });
    this.backendCache = { sig, backend };
    return backend;
  }

  /** Forgets the cached backend (credentials or settings changed). */
  resetBackend(): void {
    this.backendCache?.backend.dispose();
    this.backendCache = undefined;
  }

  /** Test connection: reachability, credentials, and whether the remote already holds LocalPilot data. */
  async inspect(): Promise<CheckResult & { initialised?: boolean; joined?: boolean; label?: string }> {
    let backend: SyncBackend;
    try {
      this.resetBackend();
      backend = await this.backend();
    } catch (e) {
      return { ok: false, reason: reasonOf(e), message: (e as Error).message };
    }
    const c = await backend.check();
    if (!c.ok) {
      return { ...c, label: backend.label };
    }
    try {
      await backend.begin?.();
      const f = await readJson<FormatFile>(backend, FORMAT_KEY);
      return { ok: true, initialised: isFormat(f), joined: isFormat(f) && f.remoteId === this.st.remoteId, label: backend.label };
    } catch (e) {
      return { ok: false, reason: reasonOf(e), message: (e as Error).message, label: backend.label };
    }
  }

  // ---------------------------------------------------------------------------------------------- set up / join

  /** Creates a new remote (format, keyring) on empty storage, with a passphrase. Throws when the storage has one. */
  async create(passphrase: string): Promise<void> {
    if (passphrase.length < 8) {
      throw new Error('Use a passphrase of at least 8 characters');
    }
    const backend = await this.backend();
    await backend.begin?.();
    if (isFormat(await readJson<FormatFile>(backend, FORMAT_KEY))) {
      throw new BackendError('precondition', 'This storage already holds LocalPilot sync data: join it with its passphrase instead');
    }
    const { file, keys } = await createKeyring(passphrase, { N: this.o.kdfN, now: this.now });
    const format: FormatFile = { format: FORMAT_NAME, v: 1, createdAt: this.now, remoteId: newRemoteId() };
    await backend.put(FORMAT_KEY, Buffer.from(`${JSON.stringify(format, null, 2)}\n`), { ifAbsent: true });
    await backend.put(KEYRING_KEY, Buffer.from(`${JSON.stringify(file, null, 2)}\n`), { ifAbsent: true });
    await backend.commit?.(this.commitMessage('set up'));
    await this.joined(format.remoteId, file, keys, true);
  }

  /** Joins an existing remote: the passphrase unlocks its keyring (a wrong one writes nothing). */
  async join(passphrase: string): Promise<void> {
    const backend = await this.backend();
    await backend.begin?.();
    const format = await readJson<FormatFile>(backend, FORMAT_KEY);
    if (!isFormat(format)) {
      throw new BackendError('not-found', 'This storage holds no LocalPilot sync data yet: set it up instead');
    }
    const file = await readJson<KeyringFile>(backend, KEYRING_KEY);
    if (!isKeyring(file)) {
      throw new BackendError('other', 'The keyring on this storage is missing or damaged');
    }
    const keys = await unlockKeyring(file, passphrase); // WrongPassphraseError: nothing written
    await this.joined(format.remoteId, file, keys, format.remoteId !== this.st.remoteId);
  }

  private async joined(remoteId: string, file: KeyringFile, keys: DataKey[], fresh: boolean): Promise<void> {
    if (fresh) {
      this.st = { ...emptyState(), withheld: this.st.withheld };
    }
    this.st.remoteId = remoteId;
    this.st.backendSig = backendSig(backendConfig(this.settings()));
    this.st.joinedAt ??= this.now;
    this.st.needsPassphrase = undefined;
    this.st.paused = undefined;
    this.st.lastError = undefined;
    await this.rememberKeys(remoteId, file, keys);
    this.saveState();
    await this.devices.register({ name: this.settings().deviceName || undefined, streams: this.ownStreams() });
    this.scheduler.resume();
    this.emitStatus();
  }

  /** After another device rotated the key: the passphrase unlocks the new key here. */
  async unlock(passphrase: string): Promise<void> {
    if (!this.st.remoteId) {
      return this.join(passphrase);
    }
    const backend = await this.backend();
    await backend.begin?.();
    const format = await readJson<FormatFile>(backend, FORMAT_KEY);
    if (!isFormat(format)) {
      throw new BackendError('not-found', 'The sync data on this storage is gone');
    }
    if (format.remoteId !== this.st.remoteId) {
      // Started over elsewhere: this is a new remote; join it (this device uploads everything again).
      return this.join(passphrase);
    }
    const file = await readJson<KeyringFile>(backend, KEYRING_KEY);
    if (!isKeyring(file)) {
      throw new BackendError('other', 'The keyring on this storage is missing or damaged');
    }
    const keys = await unlockKeyring(file, passphrase);
    await this.rememberKeys(this.st.remoteId, file, keys);
    this.st.needsPassphrase = undefined;
    if (this.st.paused?.reason === 'passphrase' || this.st.paused?.reason === 'remote-replaced') {
      this.st.paused = undefined;
    }
    this.saveState();
    this.scheduler.resume();
    this.emitStatus();
  }

  /** New passphrase: the data keys are wrapped again (compare-and-swap of keyring.json); objects stay as they are. */
  async changePassphrase(oldPassphrase: string, newPassphrase: string): Promise<void> {
    if (newPassphrase.length < 8) {
      throw new Error('Use a passphrase of at least 8 characters');
    }
    await this.updateKeyring(async (file) => ({ file: await changePassphrase(file, oldPassphrase, newPassphrase, { N: this.o.kdfN, now: this.now }) }), 'change passphrase');
  }

  /** A new data key for everything uploaded from now on (old keys stay, so history stays readable). */
  async rotateKey(passphrase: string): Promise<void> {
    await this.updateKeyring(async (file) => {
      const r = await rotateKey(file, passphrase, { now: this.now });
      return { file: r.file, keys: r.keys };
    }, 'rotate key');
  }

  private async updateKeyring(change: (f: KeyringFile) => Promise<{ file: KeyringFile; keys?: DataKey[] }>, what: string): Promise<void> {
    if (!this.st.remoteId) {
      throw new Error('Sync is not set up');
    }
    await this.withLease(async () => {
      const backend = await this.backend();
      for (let attempt = 1; ; attempt++) {
        await backend.begin?.();
        const head = await backend.head?.(KEYRING_KEY);
        const cur = await readJson<KeyringFile>(backend, KEYRING_KEY);
        if (!isKeyring(cur)) {
          throw new BackendError('other', 'The keyring on this storage is missing or damaged');
        }
        const r = await change(cur);
        try {
          await backend.put(KEYRING_KEY, Buffer.from(`${JSON.stringify(r.file, null, 2)}\n`), head?.etag ? { ifMatch: head.etag } : {});
          await backend.commit?.(this.commitMessage(what));
        } catch (e) {
          if (attempt < 3 && e instanceof BackendError && (e.code === 'precondition' || e.code === 'other')) {
            continue; // changed meanwhile: read it again
          }
          throw e;
        }
        if (r.keys) {
          await this.rememberKeys(this.st.remoteId!, r.file, r.keys);
        }
        this.st.current = r.file.current;
        this.saveState();
        return;
      }
    });
  }

  /**
   * Starts over: removes everything on the remote (every device's data) and sets it up again from this device with a
   * new passphrase. Other devices must join again. Explicit confirmation is the caller's job.
   */
  async startOver(passphrase: string): Promise<void> {
    await this.withLease(async () => {
      const backend = await this.backend();
      await backend.begin?.();
      for (const e of await backend.list('')) {
        await backend.delete(e.key);
      }
      await backend.commit?.(this.commitMessage('start over'));
      this.st = { ...emptyState(), withheld: this.st.withheld };
      this.saveState();
      await this.create(passphrase);
    });
  }

  /** Turns sync off on this device: data keys forgotten, state cleared; the remote's data stays. */
  async turnOff(): Promise<void> {
    this.scheduler.pause();
    if (this.st.remoteId) {
      for (const k of this.st.keyIds) {
        await this.o.secrets.delete(this.o.secrets.dataKeyName(this.st.remoteId, k)).catch(() => undefined);
      }
    }
    this.keys.clear();
    this.st = emptyState();
    this.saveState();
    this.resetBackend();
    this.emitStatus();
  }

  private commitMessage(what: string): string {
    return `LocalPilot sync from ${this.o.log.device.name}${what ? ` (${what})` : ''}`;
  }

  // ---------------------------------------------------------------------------------------------- status

  /** Local events not uploaded yet (the offline queue). */
  pendingCount(): number {
    let n = 0;
    for (const s of this.ownStreams()) {
      const last = this.streamLast(s);
      n += Math.max(0, last - (this.st.own[s]?.uploaded ?? 0));
    }
    return n;
  }

  status(): SyncStatus {
    const s = this.settings();
    const st = this.st;
    const configured = this.configured;
    const base = {
      pending: configured ? this.pendingCount() : 0,
      pendingBlobs: Object.keys(st.pendingBlobs ?? {}).length,
      conflicts: this.conflictCount,
      lastSync: st.lastSync,
      lastAttempt: st.lastAttempt,
      backend: s.backend,
      configured,
      nextAt: this.scheduler.nextAt,
    };
    if (!s.enabled || !configured) {
      return { ...base, state: 'off', ...(st.remoteId && !st.keyIds.length ? { needsPassphrase: true } : {}) };
    }
    if (st.needsPassphrase || (st.current && !this.keys.has(st.current) && this.keys.size === 0 && st.paused?.reason === 'passphrase')) {
      return { ...base, state: 'paused', reason: 'passphrase', message: 'Enter your sync passphrase on this device to keep syncing', needsPassphrase: true };
    }
    if (st.paused) {
      return { ...base, state: 'paused', reason: st.paused.reason, message: st.paused.message };
    }
    if (this.syncing) {
      return { ...base, state: 'syncing' };
    }
    if (this.scheduler.isPaused) {
      return { ...base, state: 'paused', reason: 'user', message: 'Paused' };
    }
    const elsewhere = !this.syncing && fs.existsSync(this.leaseFile) && !leaseIsFree(this.leaseFile);
    if (st.lastError && (!st.lastSync || st.lastError.at > st.lastSync)) {
      return { ...base, state: st.lastError.reason === 'offline' ? 'offline' : 'error', reason: st.lastError.reason, message: st.lastError.message, elsewhere };
    }
    return { ...base, state: elsewhere ? 'syncing' : 'idle', elsewhere };
  }

  private emitStatus(): void {
    const s = this.status();
    const sig = JSON.stringify({ ...s, nextAt: undefined });
    if (sig !== this.lastStatus) {
      this.lastStatus = sig;
      this.statusEmitter.fire(s);
    }
  }

  private async refreshConflicts(): Promise<void> {
    const n = await this.conflicts.count().catch(() => this.conflictCount);
    if (n !== this.conflictCount) {
      this.conflictCount = n;
      this.emitStatus();
    }
  }

  // ---------------------------------------------------------------------------------------------- scheduling

  /** Starts the automatic cycles (when sync is on and set up). */
  start(delayMs?: number): void {
    if (this.st.paused?.reason === 'user') {
      this.scheduler.pause();
    }
    this.scheduler.start(delayMs);
    void this.refreshConflicts();
  }

  /** "Sync now". Resolves true when the cycle succeeded. */
  async syncNow(): Promise<boolean> {
    return this.scheduler.now();
  }

  pause(): void {
    this.scheduler.pause();
    this.st.paused = { reason: 'user', message: 'Paused', at: this.now };
    this.saveState();
    this.emitStatus();
  }

  resume(): void {
    this.st.paused = undefined;
    this.st.lastError = undefined;
    this.saveState();
    this.resetBackend();
    this.scheduler.resume();
    this.emitStatus();
  }

  private async withLease<T>(fn: () => Promise<T>): Promise<T> {
    const lease = new Lease(this.leaseFile, { kind: this.o.writer, now: this.o.now, refreshMs: 30_000 });
    // Another process may hold it for a cycle: wait a little.
    for (let i = 0; i < 50 && !lease.tryClaim(); i++) {
      await new Promise((r) => setTimeout(r, 200));
    }
    if (!lease.isHeld) {
      throw new Error('Another LocalPilot window or the CLI is syncing; try again in a moment');
    }
    try {
      return await fn();
    } finally {
      lease.release();
    }
  }

  /** One cycle. Never throws; true = done (or nothing to do). */
  async cycle(why: Trigger = 'now'): Promise<boolean> {
    if (this.disposed || this.syncing) {
      return false;
    }
    const s = this.settings();
    if (!s.enabled || !this.st.remoteId) {
      return true;
    }
    if (this.st.paused && why !== 'now') {
      return true;
    }
    const lease = new Lease(this.leaseFile, { kind: this.o.writer, now: this.o.now, refreshMs: 30_000 });
    if (!lease.tryClaim()) {
      // Another window or the CLI is syncing this data root; its imports reach our index through the log.
      this.reload();
      this.emitStatus();
      return true;
    }
    this.st = this.readState();
    this.syncing = true;
    this.emitStatus();
    const t0 = this.now;
    let up = 0;
    let down = 0;
    let bytes = 0;
    try {
      await this.loadKeys();
      if (why === 'now' && this.st.paused?.reason !== 'user') {
        this.st.paused = undefined;
      }
      const backend = await this.backend();
      await backend.begin?.();
      const format = await readJson<FormatFile>(backend, FORMAT_KEY);
      if (!isFormat(format)) {
        throw new Paused('remote-missing', 'The sync data on this storage is gone (deleted, or a different folder / bucket). Set sync up again.');
      }
      if (format.remoteId !== this.st.remoteId) {
        throw new Paused('remote-replaced', 'Sync was started over on another device. Enter the new passphrase to join again.');
      }
      const ring = await readJson<KeyringFile>(backend, KEYRING_KEY);
      if (isKeyring(ring) && !this.keys.has(ring.current)) {
        const hint = this.o.passphraseHint?.();
        if (hint) {
          await this.rememberKeys(this.st.remoteId, ring, await unlockKeyring(ring, hint));
        } else {
          this.st.needsPassphrase = 'key-rotated';
          throw new Paused('passphrase', 'The sync key was changed on another device. Enter your sync passphrase on this device to keep syncing.');
        }
      } else if (isKeyring(ring)) {
        this.st.current = ring.current;
      }
      // Categories turned on since the last cycle: what they withheld is sent now.
      this.resendWithheld(s.categories);
      await this.devices.register({ name: s.deviceName || undefined, streams: this.ownStreams() });
      await this.o.log.flush();
      // ---- push
      const pushed = await this.push(backend, s);
      up = pushed.events;
      bytes += pushed.bytes;
      // ---- pull
      const pulled = await this.pull(backend, s);
      down = pulled.events;
      bytes += pulled.bytes;
      await backend.commit?.(this.commitMessage(''));
      // Uploads count only once committed (git pushes here).
      for (const [stream, to] of Object.entries(pushed.advanced)) {
        const o = (this.st.own[stream] ??= { uploaded: 0 });
        o.uploaded = Math.max(o.uploaded, to);
        o.pending = o.pending?.filter((p) => p.to > o.uploaded);
        if (!o.pending?.length) {
          delete o.pending;
        }
      }
      for (const [stream, cut] of Object.entries(pushed.bases)) {
        (this.st.own[stream] ??= { uploaded: 0 }).base = cut;
      }
      this.st.uploadedBlobs = [...new Set([...this.st.uploadedBlobs, ...pushed.blobs])].slice(-50_000);
      // ---- apply
      if (down) {
        await this.o.index.catchUp().catch(() => 0);
        this.appliedEmitter.fire({ events: down, devices: pulled.devices });
      }
      bytes += await this.downloadBlobs(backend);
      // ---- housekeeping
      if (!this.st.lastHousekeeping || this.now - this.st.lastHousekeeping > DAY) {
        await this.housekeeping(backend, s).catch((e) => this.o.warn?.(`sync housekeeping: ${(e as Error).message}`));
        await backend.commit?.(this.commitMessage('housekeeping')).catch(() => undefined);
        this.st.lastHousekeeping = this.now;
      }
      this.st.categoriesSeen = s.categories;
      this.st.lastSync = this.now;
      this.st.lastAttempt = this.now;
      this.st.lastError = undefined;
      this.st.last = { uploaded: up, downloaded: down, bytes };
      this.saveState();
      await this.o.index.syncEvent({ at: this.now, kind: 'sync', remote: backend.label, uploaded: up, downloaded: down, bytes }).catch(() => undefined);
      if (up || down) {
        this.o.info?.(`sync: sent ${up}, received ${down} change(s) in ${this.now - t0} ms`);
      }
      return true;
    } catch (e) {
      const paused = e instanceof Paused;
      const reason = paused ? (e as Paused).reason : reasonOf(e);
      const message = e instanceof WrongPassphraseError ? 'The passphrase from LOCALPILOT_SYNC_PASSPHRASE does not unlock this remote' : (e as Error).message ?? String(e);
      this.st.lastAttempt = this.now;
      if (paused || reason === 'auth' || reason === 'forbidden' || reason === 'not-found') {
        // Needs the user: no automatic retries until it is fixed (Resume / Update credentials… / passphrase).
        this.st.paused = { reason: paused ? reason : reason, message: reason === 'auth' ? `Sync paused: sign-in failed — ${message}` : message, at: this.now };
        this.scheduler.pause();
      } else {
        this.st.lastError = { reason, message, at: this.now };
      }
      this.saveState();
      await this.o.index.syncEvent({ at: this.now, kind: paused ? 'paused' : reason === 'offline' ? 'offline' : 'error', remote: this.backendCache?.backend.label, uploaded: up, downloaded: down, bytes, error: message.slice(0, 500) }).catch(() => undefined);
      this.o.warn?.(`sync: ${message}`);
      if (reason === 'auth' || reason === 'other') {
        this.resetBackend();
      }
      return paused || reason === 'auth' || reason === 'forbidden';
    } finally {
      this.syncing = false;
      lease.release();
      this.emitStatus();
      void this.refreshConflicts();
    }
  }

  // ---------------------------------------------------------------------------------------------- push

  /** This device's streams on this machine (every window's and the CLI's). */
  ownStreams(): string[] {
    const me = `${this.o.log.device.deviceId}.`;
    try {
      return fs.readdirSync(path.join(this.o.root, 'streams')).filter((s) => s.startsWith(me) && /^dev_[\w-]+\.\d+$/.test(s)).sort();
    } catch {
      return [];
    }
  }

  private streamDir(stream: string): string {
    return path.join(this.o.root, 'streams', stream);
  }

  private streamLast(stream: string): number {
    if (stream === this.o.log.stream) {
      return this.o.log.lastSequence;
    }
    const files = listSegments(this.streamDir(stream));
    const segs = files.filter((f) => !f.compact);
    for (let i = segs.length - 1; i >= 0; i--) {
      const lines = readSegmentLines(segs[i].file);
      if (lines.length) {
        return lines[lines.length - 1].e.seq;
      }
    }
    const base = files.find((f) => f.compact);
    return base ? -base.segment : 0;
  }

  private cats(s: SyncSettings): string {
    return JSON.stringify(s.categories);
  }

  /** The upload form of an event: itself, or a stand-in when it stays here (local, or its category is off). */
  private outgoing(e: EventEnvelope, s: SyncSettings, withheld: Map<SyncCategory, Set<string>>): EventEnvelope {
    const why = withholdReason(e, s.categories);
    if (!why) {
      return e;
    }
    if (why !== 'local') {
      const set = withheld.get(why as SyncCategory) ?? new Set<string>();
      set.add(e.eid);
      withheld.set(why as SyncCategory, set);
    }
    return withheldStandIn(e, why);
  }

  private wantBlob(ref: { category: SyncCategory }, s: SyncSettings): boolean {
    return !!s.categories[ref.category];
  }

  private async push(backend: SyncBackend, s: SyncSettings): Promise<{ events: number; bytes: number; advanced: Record<string, number>; bases: Record<string, number>; blobs: string[] }> {
    const key = this.currentKey();
    const advanced: Record<string, number> = {};
    const bases: Record<string, number> = {};
    const withheld = new Map<SyncCategory, Set<string>>();
    const blobShas = new Map<string, SyncCategory>();
    let events = 0;
    let bytes = 0;
    let budget = MAX_EVENTS_PER_CYCLE;
    const heads: Record<string, { head: number; base?: number }> = {};
    for (const stream of this.ownStreams()) {
      const own = (this.st.own[stream] ??= { uploaded: 0 });
      let uploaded = own.uploaded;
      const files = listSegments(this.streamDir(stream));
      const base = files.find((f) => f.compact);
      // Events this device compacted before they were uploaded travel as a compacted base.
      if (base && -base.segment > uploaded) {
        const cut = -base.segment;
        const entries = readSegmentLines(base.file).map((r) => r.e).map((e) => ({ e, why: withholdReason(e, s.categories) }));
        for (const x of entries) {
          if (x.why && x.why !== 'local') {
            const set = withheld.get(x.why as SyncCategory) ?? new Set<string>();
            set.add(x.e.eid);
            withheld.set(x.why as SyncCategory, set);
          }
        }
        const kept = entries.filter((x) => !x.why).map((x) => x.e);
        const objKey = baseKey(stream, cut);
        const body = sealObject(key, objKey, encodeEvents(kept));
        await backend.put(objKey, body);
        bytes += body.length;
        bases[stream] = cut;
        for (const e of kept) {
          for (const r of blobRefs(e)) {
            if (this.wantBlob(r, s)) {
              blobShas.set(r.sha, r.category);
            }
          }
        }
        uploaded = cut;
        advanced[stream] = cut;
        own.pending = undefined;
      }
      const last = this.streamLast(stream);
      if (last > uploaded && budget > 0) {
        const list: EventEnvelope[] = [];
        const gen = stream === this.o.log.stream ? this.o.log.readWithLoc(stream, uploaded + 1) : readStreamDir(this.streamDir(stream), uploaded + 1);
        for (const { e } of gen) {
          if (e.seq <= uploaded || e.id !== `${e.stream}:${e.seq}`) {
            continue; // compacted entries were sent with the base
          }
          if (e.seq !== uploaded + list.length + 1) {
            break; // a hole (never in own streams): stop at the last contiguous event
          }
          list.push(e);
          if (list.length >= budget) {
            break;
          }
        }
        budget -= list.length;
        // Chunk boundaries: the saved ones first (a retry writes the same objects), then new ones, saved before upload.
        const sig = this.cats(s);
        const chunks: { from: number; to: number; events: EventEnvelope[] }[] = [];
        let i = 0;
        for (const p of own.pending ?? []) {
          if (p.from !== uploaded + i + 1 || p.sig !== sig) {
            break;
          }
          const slice = list.slice(i, i + (p.to - p.from + 1));
          if (slice.length !== p.to - p.from + 1) {
            break;
          }
          chunks.push({ from: p.from, to: p.to, events: slice });
          i += slice.length;
        }
        for (const c of cutChunks(list.slice(i).map((e) => this.outgoing(e, s, new Map())))) {
          chunks.push({ from: c[0].seq, to: c[c.length - 1].seq, events: list.slice(c[0].seq - uploaded - 1, c[c.length - 1].seq - uploaded) });
        }
        own.pending = chunks.map((c) => ({ from: c.from, to: c.to, sig }));
        this.saveState();
        for (const c of chunks) {
          const out = c.events.map((e) => this.outgoing(e, s, withheld));
          const objKey = chunkKey(stream, c.from, c.to);
          const body = sealObject(key, objKey, encodeEvents(out));
          await backend.put(objKey, body);
          bytes += body.length;
          events += out.filter((e) => !isWithheld(e)).length;
          advanced[stream] = c.to;
          for (const e of out) {
            if (!isWithheld(e)) {
              for (const r of blobRefs(e)) {
                if (this.wantBlob(r, s)) {
                  blobShas.set(r.sha, r.category);
                }
              }
            }
          }
        }
      }
      heads[stream] = { head: advanced[stream] ?? own.uploaded, ...((bases[stream] ?? own.base) ? { base: bases[stream] ?? own.base } : {}) };
    }
    // Remember what was withheld (re-sent when its category is turned on).
    for (const [cat, ids] of withheld) {
      this.st.withheld[cat] = [...new Set([...(this.st.withheld[cat] ?? []), ...ids])];
    }
    // Blobs of what was sent (attachments within the size cap; git keeps them under 5 MB).
    const done = new Set(this.st.uploadedBlobs);
    const sent: string[] = [];
    const maxBytes = s.maxAttachmentMB * 1024 * 1024;
    for (const [sha, cat] of blobShas) {
      if (done.has(sha)) {
        continue;
      }
      const data = this.o.blobs.get(sha);
      if (!data) {
        continue; // not on this machine (pulled metadata only)
      }
      if (cat === 'attachments' && data.length > maxBytes) {
        continue;
      }
      if (backend.kind === 'git' && data.length > GIT_MAX_BLOB) {
        continue;
      }
      const objKey = blobKey(key, sha);
      try {
        await backend.put(objKey, sealObject(key, objKey, data), { ifAbsent: true });
        bytes += data.length;
      } catch (e) {
        if (!(e instanceof BackendError && e.code === 'precondition')) {
          throw e;
        }
      }
      sent.push(sha);
    }
    // This device's file: heads (what others may pull), last seen.
    const devFile: DeviceFile = {
      v: 1,
      deviceId: this.o.log.device.deviceId,
      name: this.settings().deviceName || this.o.log.device.name,
      platform: this.o.log.device.platform,
      appVersions: { [this.o.writer]: this.o.appVersion },
      lastSeen: this.now,
      streams: heads,
    };
    const prev = this.st.devices[devFile.deviceId];
    const changed = !prev || JSON.stringify(prev.heads) !== JSON.stringify(Object.fromEntries(Object.entries(heads).map(([k, v]) => [k, v.head]))) || !prev.lastSeen || this.now - prev.lastSeen > HOUR;
    if (changed) {
      const dk = deviceKey(devFile.deviceId);
      await backend.put(dk, sealObject(key, dk, JSON.stringify(devFile)));
      this.st.devices[devFile.deviceId] = { name: devFile.name, lastSeen: devFile.lastSeen, heads: Object.fromEntries(Object.entries(heads).map(([k, v]) => [k, v.head])) };
    }
    return { events, bytes, advanced, bases, blobs: sent };
  }

  // ---------------------------------------------------------------------------------------------- pull

  private async pull(backend: SyncBackend, s: SyncSettings): Promise<{ events: number; bytes: number; devices: string[] }> {
    const me = this.o.log.device.deviceId;
    let events = 0;
    let bytes = 0;
    const from = new Set<string>();
    const list = await backend.list('devices/');
    for (const entry of list) {
      const m = /^devices\/(dev_[\w-]+)\.json\.lpe$/.exec(entry.key);
      if (!m || m[1] === me) {
        continue;
      }
      const id = m[1];
      const known = this.st.devices[id];
      let file: DeviceFile | undefined;
      if (known?.etag && entry.etag && known.etag === entry.etag) {
        file = undefined; // unchanged since the last cycle
      } else {
        const raw = await backend.get(entry.key);
        if (!raw) {
          continue;
        }
        bytes += raw.length;
        try {
          file = JSON.parse(openObject(this.keyOf, entry.key, raw).toString('utf8')) as DeviceFile;
        } catch (e) {
          this.damaged(entry.key, id, e);
          continue;
        }
        this.st.devices[id] = {
          name: file.name,
          lastSeen: file.lastSeen,
          heads: Object.fromEntries(Object.entries(file.streams ?? {}).map(([k, v]) => [k, v.head])),
          bases: Object.fromEntries(Object.entries(file.streams ?? {}).filter(([, v]) => v.base).map(([k, v]) => [k, v.base!])),
          revokedAt: file.revokedAt,
          etag: entry.etag,
        };
      }
      const dev = this.st.devices[id];
      for (const [stream, head] of Object.entries(dev?.heads ?? {})) {
        if (!stream.startsWith(`${id}.`)) {
          continue; // a device only publishes its own streams
        }
        const local = this.localLast(stream);
        if (head <= local) {
          continue;
        }
        const r = await this.pullStream(backend, stream, local, s);
        events += r.events;
        bytes += r.bytes;
        if (r.events) {
          from.add(id);
        }
      }
    }
    return { events, bytes, devices: [...from] };
  }

  private localLast(stream: string): number {
    return this.streamLast(stream);
  }

  private async pullStream(backend: SyncBackend, stream: string, local: number, s: SyncSettings): Promise<{ events: number; bytes: number }> {
    const objs = (await backend.list(streamPrefix(stream))).map((e) => ({ e, p: parseStreamObject(e.key) })).filter((x) => x.p && x.p.stream === stream);
    let last = local;
    let events = 0;
    let bytes = 0;
    // A compacted base when this device is behind it (a new device, or chunks the owner replaced).
    const chunks = objs.filter((x) => x.p!.kind === 'chunk').map((x) => ({ key: x.e.key, from: (x.p as { from: number }).from, to: x.p!.to })).sort((a, b) => a.from - b.from || a.to - b.to);
    const bases = objs.filter((x) => x.p!.kind === 'base').map((x) => ({ key: x.e.key, to: x.p!.to })).sort((a, b) => b.to - a.to);
    const continues = chunks.some((c) => c.from <= last + 1 && c.to > last);
    const base = bases[0];
    if (base && base.to > last && !continues) {
      const raw = await backend.get(base.key);
      if (raw) {
        bytes += raw.length;
        let list: EventEnvelope[];
        try {
          list = decodeEvents(openObject(this.keyOf, base.key, raw).toString('utf8'));
        } catch (e) {
          this.damaged(base.key, stream, e);
          return { events, bytes };
        }
        if (this.o.log.importBase(stream, base.to, list)) {
          events += list.length;
          last = base.to;
          this.queueBlobs(list, s);
          for (const ev of list) {
            this.observe(ev);
          }
        }
      }
    }
    for (const c of chunks) {
      if (c.to <= last) {
        continue;
      }
      if (c.from > last + 1) {
        break; // a gap: the missing chunk is not uploaded yet (or was replaced by a base we could not use)
      }
      const raw = await backend.get(c.key);
      if (!raw) {
        break;
      }
      bytes += raw.length;
      let list: EventEnvelope[];
      try {
        list = decodeEvents(openObject(this.keyOf, c.key, raw).toString('utf8'));
      } catch (e) {
        this.damaged(c.key, stream, e);
        break;
      }
      const r = await this.o.log.importRemote(stream, list);
      events += list.filter((ev) => ev.seq > last && !isWithheld(ev)).length;
      if (r.imported) {
        last = Math.max(last, ...list.map((ev) => ev.seq));
        this.queueBlobs(list, s);
        for (const ev of list) {
          this.observe(ev);
        }
      }
    }
    return { events, bytes };
  }

  /** HLC skew of another device beyond 10 minutes is reported once (clock-skew). */
  private observe(e: EventEnvelope): void {
    const r = this.o.log.observeHlc(e.hlc);
    if (r.skewMs && !this.reported.has(`skew:${e.dev}`)) {
      this.reported.add(`skew:${e.dev}`);
      this.conflicts.report('clock-skew', e.dev, { value: Math.round(r.skewMs / 1000), device: e.dev });
    }
  }

  private damaged(key: string, owner: string, e: unknown): void {
    const msg = e instanceof SealError ? e.message : (e as Error)?.message ?? String(e);
    this.o.warn?.(`sync: skipped ${key}: ${msg}`);
    if (!this.reported.has(key)) {
      this.reported.add(key);
      this.conflicts.report('remote-damaged', key, { value: msg, device: owner.replace(/\.\d+$/, '') });
    }
  }

  private queueBlobs(list: EventEnvelope[], s: SyncSettings): void {
    for (const e of list) {
      if (isWithheld(e)) {
        continue;
      }
      for (const r of blobRefs(e)) {
        if (this.wantBlob(r, s) && !this.o.blobs.has(r.sha)) {
          this.st.pendingBlobs[r.sha] ??= 0;
        }
      }
    }
  }

  /** Downloads pending blobs (newest-referenced first) within the per-cycle budget; the rest wait (lazy). */
  private async downloadBlobs(backend: SyncBackend): Promise<number> {
    let budget = this.o.blobBudgetBytes ?? 64 * 1024 * 1024;
    let bytes = 0;
    for (const sha of Object.keys(this.st.pendingBlobs)) {
      if (budget <= 0) {
        break;
      }
      if (this.o.blobs.has(sha)) {
        delete this.st.pendingBlobs[sha];
        continue;
      }
      const got = await this.fetchBlobFrom(backend, sha);
      if (got) {
        bytes += got;
        budget -= got;
        delete this.st.pendingBlobs[sha];
      } else if (++this.st.pendingBlobs[sha] >= 20) {
        delete this.st.pendingBlobs[sha]; // never uploaded (over the size cap, or its device stopped syncing)
      }
    }
    return bytes;
  }

  private async fetchBlobFrom(backend: SyncBackend, sha: string): Promise<number> {
    const keys = [...this.keys.values()].sort((a, b) => Number(b.keyId === this.st.current) - Number(a.keyId === this.st.current));
    for (const k of keys) {
      const objKey = blobKey(k, sha);
      const raw = await backend.get(objKey);
      if (!raw) {
        continue;
      }
      try {
        const data = openObject(this.keyOf, objKey, raw);
        if (sha256(data) !== sha) {
          throw new SealError('content does not match its name');
        }
        this.o.blobs.put(data);
        return data.length;
      } catch (e) {
        this.damaged(objKey, 'blob', e);
      }
    }
    return 0;
  }

  /** Fetches one blob now (an attachment being opened). */
  async fetchBlob(sha: string): Promise<boolean> {
    if (this.o.blobs.has(sha)) {
      return true;
    }
    if (!this.configured) {
      return false;
    }
    await this.loadKeys();
    const backend = await this.backend();
    return (await this.fetchBlobFrom(backend, sha)) > 0;
  }

  // ---------------------------------------------------------------------------------------------- categories

  /**
   * Re-sends entities withheld while their category was off: their current state as written by this device, as one
   * create each (field clocks kept in `__clocks`, as compaction does), so last-writer-wins still holds everywhere.
   */
  private resendWithheld(cats: SyncCategories): number {
    const turnedOn = (Object.keys(this.st.withheld) as SyncCategory[]).filter((c) => cats[c] && this.st.withheld[c]?.length);
    if (!turnedOn.length) {
      return 0;
    }
    const ids = new Set(turnedOn.flatMap((c) => this.st.withheld[c] ?? []));
    const states = new Map<string, EntityState>();
    const all: EventEnvelope[] = [];
    for (const stream of this.ownStreams()) {
      for (const { e } of readStreamDir(this.streamDir(stream), 1)) {
        if (ids.has(e.eid)) {
          all.push(e);
        }
      }
    }
    all.sort((a, b) => (a.hlc < b.hlc ? -1 : a.hlc > b.hlc ? 1 : 0));
    for (const e of all) {
      states.set(e.eid, reduce(states.get(e.eid), e, DEFAULT_RULES).state);
      const conv = (e.p as { conversationId?: unknown }).conversationId;
      if (e.ent === 'message' && e.op === 'create' && typeof conv === 'string' && ids.has(conv)) {
        states.set(conv, noteEdit(states.get(conv), conv, e).state);
      }
    }
    let n = 0;
    for (const st of [...states.values()].sort((a, b) => (a.version < b.version ? -1 : 1))) {
      if (!st.version) {
        continue;
      }
      if (st.purged) {
        this.o.log.append(st.ent, st.id, 'purge', { at: this.now, reason: 'resent' });
      } else {
        const p: Record<string, unknown> = { ...st.fields, __clocks: st.clocks };
        if (st.bases) {
          p.__bases = st.bases;
        }
        if (st.edits?.length) {
          p.__edits = st.edits;
        }
        if (st.clocks.trashedAt && st.fields.trashedAt === undefined) {
          p.trashedAt = null;
        }
        this.o.log.append(st.ent, st.id, 'create', p, { cause: 'sync:resend' });
      }
      n++;
    }
    for (const c of turnedOn) {
      delete this.st.withheld[c];
    }
    this.o.info?.(`sync: re-sending ${n} item(s) of ${turnedOn.join(', ')} (turned on)`);
    return n;
  }

  // ---------------------------------------------------------------------------------------------- housekeeping

  /**
   * Daily: when this device compacted a stream locally past what the remote has as a base, upload the base and delete
   * the own chunks it covers (never other devices' objects).
   */
  private async housekeeping(backend: SyncBackend, s: SyncSettings): Promise<void> {
    const key = this.currentKey();
    for (const stream of this.ownStreams()) {
      const own = this.st.own[stream];
      const base = listSegments(this.streamDir(stream)).find((f) => f.compact);
      if (!own || !base) {
        continue;
      }
      const cut = -base.segment;
      if (cut > own.uploaded || (own.base ?? 0) >= cut) {
        continue;
      }
      const kept = readSegmentLines(base.file)
        .map((r) => r.e)
        .filter((e) => {
          const why = withholdReason(e, s.categories);
          if (why && why !== 'local') {
            (this.st.withheld[why as SyncCategory] ??= []).push(e.eid);
          }
          return !why;
        });
      const objKey = baseKey(stream, cut);
      await backend.put(objKey, sealObject(key, objKey, encodeEvents(kept)));
      for (const e of await backend.list(streamPrefix(stream))) {
        const p = parseStreamObject(e.key);
        if (p && ((p.kind === 'chunk' && p.to <= cut) || (p.kind === 'base' && p.to < cut))) {
          await backend.delete(e.key);
        }
      }
      own.base = cut;
    }
    for (const c of Object.keys(this.st.withheld) as SyncCategory[]) {
      this.st.withheld[c] = [...new Set(this.st.withheld[c])];
    }
  }

  /** Uploads every own stream again from the start (after a remote object of this device was damaged). */
  reupload(): void {
    for (const s of Object.keys(this.st.own)) {
      this.st.own[s] = { uploaded: 0 };
    }
    this.st.uploadedBlobs = [];
    this.saveState();
  }

  /** Remote device info (last seen, heads) for the device list. */
  remoteDevices(): Record<string, { name?: string; lastSeen?: number; heads?: Record<string, number>; revokedAt?: number }> {
    return this.st.devices;
  }

  async listDevices(): Promise<DeviceRow[]> {
    return this.devices.list(this.st.devices);
  }

  /** The category an entity's events belong to (Sync manager explanations). */
  static categoryOf = categoryOfEntity;

  dispose(): void {
    this.disposed = true;
    this.scheduler.dispose();
    this.subs.forEach((d) => d.dispose());
    this.statusEmitter.dispose();
    this.appliedEmitter.dispose();
    this.backendCache?.backend.dispose();
  }
}
