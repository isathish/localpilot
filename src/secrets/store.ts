// The secret store every LocalPilot process shares (the extension in every window, and the CLI): provider API keys,
// MCP sign-in tokens, sync credentials. One sql.js database in `<dir>/secrets.db`, sealed as a whole file with
// AES-256-GCM, so neither the values nor the names are readable on disk. The 32-byte key lives in the OS keychain;
// without one, it comes from a passphrase (scrypt). There is no plain-text fallback: a store that cannot be unlocked
// throws SecretStoreLockedError with what to do about it. Pure Node + sql.js.
//
// File: "LPSEC1" | mode (1 = keychain, 2 = passphrase) | salt 16 | iv 12 | tag 16 | ciphertext. The 35-byte header
// before the tag is authenticated as additional data, so the mode or salt cannot be swapped without detection.
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Database, SqlJsStatic } from 'sql.js';
import { loadSqlJs } from '../continuity/data/index/sqljsLoader';
import { Keychain, systemKeychain } from './keychain';

const MAGIC = Buffer.from('LPSEC1', 'ascii');
const MODE_KEYCHAIN = 1;
const MODE_PASSPHRASE = 2;
const HEADER = MAGIC.length + 1 + 16 + 12;
const TAG = 16;
/** Keychain account of the store's key (base64). */
export const MASTER_KEY_ACCOUNT = 'secret-store-key';
const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
/** A lock older than this is from a process that died mid-write. */
const LOCK_STALE_MS = 10_000;
const LOCK_WAIT_MS = 8_000;
/** `touch` writes the file at most this often per secret. */
const TOUCH_EVERY_MS = 60_000;

export type UnlockMode = 'keychain' | 'passphrase';

/** The store cannot be opened: no keychain and no passphrase, the key is gone, or the file does not decrypt. */
export class SecretStoreLockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecretStoreLockedError';
  }
}

export interface SecretMeta {
  name: string;
  /** Where it came from: `vscode`, `cli`, `env:OPENAI_API_KEY`, `migrated:keys.json`… */
  source: string;
  createdAt: number;
  updatedAt: number;
  lastUsedAt?: number;
  /** Characters in the value (never the value). */
  length: number;
}

export interface SecretStoreStatus {
  file: string;
  exists: boolean;
  cipher: 'AES-256-GCM';
  mode: UnlockMode;
  /** "macOS Keychain", "Windows Credential Manager"… or "passphrase". */
  unlockedBy: string;
  count: number;
  bytes: number;
}

export interface SecretStoreOptions {
  /** Folder of secrets.db; default `defaultSecretsDir()`. */
  dir?: string;
  /** The keychain holding the store's key; `null` = none (passphrase only). Default: this machine's. */
  keychain?: Keychain | null;
  /** Unlocks the store when there is no keychain; default LOCALPILOT_SECRETS_PASSPHRASE. */
  passphrase?: string;
  wasmPath?: string;
  sqlJs?: SqlJsStatic;
  now?: () => number;
}

/** `LOCALPILOT_SECRETS_DIR`, else `LOCALPILOT_DATA_DIR`, else `~/.localpilot`: the same folder for the extension and the CLI. */
export function defaultSecretsDir(env: NodeJS.ProcessEnv = process.env): string {
  const dir = env.LOCALPILOT_SECRETS_DIR || env.LOCALPILOT_DATA_DIR;
  return dir ? path.resolve(dir) : path.join(os.homedir(), '.localpilot');
}

interface Stamp {
  mtimeMs: number;
  size: number;
  ino: number;
}

const sleepCell = new Int32Array(new SharedArrayBuffer(4));
function sleepSync(ms: number): void {
  Atomics.wait(sleepCell, 0, 0, ms);
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Opens of the same file in one process run one at a time, so two of them never both create a key. */
const opening = new Map<string, Promise<unknown>>();

export class SecretStore {
  readonly file: string;
  private readonly lockFile: string;
  private db!: Database;
  private key!: Buffer;
  private salt!: Buffer;
  private mode!: UnlockMode;
  private unlockedBy = '';
  private stamp: Stamp | undefined;
  private closed = false;
  private readonly listeners = new Set<(names: string[]) => void>();
  private readonly now: () => number;

  private constructor(
    private readonly SQL: SqlJsStatic,
    readonly dir: string,
    now?: () => number
  ) {
    this.file = path.join(dir, 'secrets.db');
    this.lockFile = `${this.file}.lock`;
    this.now = now ?? Date.now;
  }

  /** Opens (creating on first use) the store. Throws SecretStoreLockedError when it cannot be unlocked. */
  static async open(opts: SecretStoreOptions = {}): Promise<SecretStore> {
    const dir = path.resolve(opts.dir ?? defaultSecretsDir());
    const SQL = opts.sqlJs ?? (await loadSqlJs(opts.wasmPath));
    const s = new SecretStore(SQL, dir, opts.now);
    const prev = opening.get(s.file) ?? Promise.resolve();
    const run = prev.catch(() => undefined).then(() => s.unlock(opts));
    opening.set(s.file, run);
    try {
      await run;
    } finally {
      if (opening.get(s.file) === run) {
        opening.delete(s.file);
      }
    }
    return s;
  }

  // ------------------------------------------------------------------ unlocking

  private async unlock(opts: SecretStoreOptions): Promise<void> {
    const keychain = opts.keychain === undefined ? systemKeychain() : opts.keychain ?? undefined;
    const passphrase = opts.passphrase ?? process.env.LOCALPILOT_SECRETS_PASSPHRASE ?? undefined;
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const existing = this.readFile();
    if (existing) {
      const mode = existing[MAGIC.length];
      this.salt = Buffer.from(existing.subarray(MAGIC.length + 1, MAGIC.length + 17));
      if (mode === MODE_KEYCHAIN) {
        this.key = await this.keyFromKeychain(keychain, false);
        this.mode = 'keychain';
        this.unlockedBy = keychain!.label;
      } else if (mode === MODE_PASSPHRASE) {
        if (!passphrase) {
          throw new SecretStoreLockedError(`${this.file} is protected by a passphrase. Set LOCALPILOT_SECRETS_PASSPHRASE to unlock it.`);
        }
        this.key = derive(passphrase, this.salt);
        this.mode = 'passphrase';
        this.unlockedBy = 'passphrase';
      } else {
        throw new SecretStoreLockedError(`${this.file} uses an unknown protection mode (${mode}); it was written by a newer LocalPilot.`);
      }
      this.load(existing);
      return;
    }
    // First use: under the lock, so two processes starting together agree on one key and one file.
    await this.lockAsync();
    try {
      const raced = this.readFile();
      if (raced) {
        this.unlockLater = true;
      } else {
        await this.create(keychain, passphrase);
      }
    } finally {
      this.unlockSync();
    }
    if (this.unlockLater) {
      this.unlockLater = false;
      await this.unlock(opts);
    }
  }

  private unlockLater = false;

  private async create(keychain: Keychain | undefined, passphrase: string | undefined): Promise<void> {
    this.salt = crypto.randomBytes(16);
    let keychainError: string | undefined;
    if (keychain && (await keychain.available().catch(() => false))) {
      try {
        this.key = await this.keyFromKeychain(keychain, true);
        this.mode = 'keychain';
        this.unlockedBy = keychain.label;
      } catch (e) {
        keychainError = e instanceof Error ? e.message : String(e);
      }
    }
    if (!this.key) {
      if (!passphrase) {
        throw new SecretStoreLockedError(
          keychainError
            ? `LocalPilot cannot keep secrets: the ${keychain!.label} did not work (${keychainError}). Fix it, or set LOCALPILOT_SECRETS_PASSPHRASE to protect ${this.file} with a passphrase instead.`
            : `LocalPilot cannot keep secrets: this machine has no keychain it can use${process.platform === 'linux' ? ' (install libsecret-tools for secret-tool, with GNOME Keyring or KWallet running)' : ''}. Set LOCALPILOT_SECRETS_PASSPHRASE to protect ${this.file} with a passphrase instead.`
        );
      }
      this.key = derive(passphrase, this.salt);
      this.mode = 'passphrase';
      this.unlockedBy = 'passphrase';
    }
    this.db = new this.SQL.Database();
    this.schema();
    this.persist();
  }

  /** The store's key from the keychain; with `create`, a new one is made, saved and read back when there is none. */
  private async keyFromKeychain(keychain: Keychain | undefined, create: boolean): Promise<Buffer> {
    if (!keychain) {
      throw new SecretStoreLockedError(`${this.file} is unlocked by a key in the system keychain, which is turned off here (LOCALPILOT_KEYCHAIN=none).`);
    }
    let stored: string | undefined;
    try {
      stored = await keychain.get(MASTER_KEY_ACCOUNT);
    } catch (e) {
      throw new SecretStoreLockedError(`Could not read the key of ${this.file} from the ${keychain.label}: ${e instanceof Error ? e.message : String(e)}`);
    }
    const parsed = stored ? Buffer.from(stored.trim(), 'base64') : undefined;
    if (parsed && parsed.length === 32) {
      return parsed;
    }
    if (!create) {
      throw new SecretStoreLockedError(
        `The key that unlocks ${this.file} is missing from the ${keychain.label}. If it was deleted, the stored secrets cannot be recovered: delete ${this.file} and enter your keys again.`
      );
    }
    const key = crypto.randomBytes(32);
    await keychain.set(MASTER_KEY_ACCOUNT, key.toString('base64'));
    // Only trust a key the keychain gives back: a keychain that silently dropped it would lose every secret later.
    const back = await keychain.get(MASTER_KEY_ACCOUNT);
    if (!back || !Buffer.from(back.trim(), 'base64').equals(key)) {
      throw new Error(`the ${keychain.label} did not keep the key that was written to it`);
    }
    return key;
  }

  // ------------------------------------------------------------------ file

  private readFile(): Buffer | undefined {
    let raw: Buffer;
    try {
      raw = fs.readFileSync(this.file);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
        return undefined;
      }
      throw e;
    }
    if (raw.length < HEADER + TAG || !raw.subarray(0, MAGIC.length).equals(MAGIC)) {
      throw new SecretStoreLockedError(`${this.file} is not a LocalPilot secret store (or it is damaged).`);
    }
    return raw;
  }

  private open(raw: Buffer): Uint8Array {
    const header = raw.subarray(0, HEADER);
    const iv = raw.subarray(MAGIC.length + 17, HEADER);
    const tag = raw.subarray(HEADER, HEADER + TAG);
    try {
      const d = crypto.createDecipheriv('aes-256-gcm', this.key, iv);
      d.setAAD(header);
      d.setAuthTag(tag);
      return Buffer.concat([d.update(raw.subarray(HEADER + TAG)), d.final()]);
    } catch {
      throw new SecretStoreLockedError(
        this.mode === 'passphrase'
          ? `${this.file} could not be decrypted: the passphrase is wrong, or the file was changed outside LocalPilot.`
          : `${this.file} could not be decrypted with the key in the ${this.unlockedBy}: the key was replaced, or the file was changed outside LocalPilot.`
      );
    }
  }

  private seal(plain: Uint8Array): Buffer {
    const iv = crypto.randomBytes(12);
    const header = Buffer.concat([MAGIC, Buffer.from([this.mode === 'keychain' ? MODE_KEYCHAIN : MODE_PASSPHRASE]), this.salt, iv]);
    const c = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    c.setAAD(header);
    const body = Buffer.concat([c.update(plain), c.final()]);
    return Buffer.concat([header, c.getAuthTag(), body]);
  }

  private statFile(): Stamp | undefined {
    try {
      const st = fs.statSync(this.file);
      return { mtimeMs: st.mtimeMs, size: st.size, ino: st.ino };
    } catch {
      return undefined;
    }
  }

  private load(raw: Buffer): void {
    const plain = this.open(raw);
    const next = new this.SQL.Database(plain);
    this.db?.close();
    this.db = next;
    this.schema();
    this.stamp = this.statFile();
  }

  private schema(): void {
    this.db.run(`CREATE TABLE IF NOT EXISTS secrets (name TEXT PRIMARY KEY, value TEXT NOT NULL, source TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, last_used_at INTEGER);
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
      INSERT OR IGNORE INTO meta (key, value) VALUES ('schema', '1');`);
  }

  /** Writes the database sealed: a temp file (0600) renamed over the old one, so a crash never leaves half a file. */
  private persist(): void {
    const sealed = this.seal(this.db.export());
    const tmp = `${this.file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    const fd = fs.openSync(tmp, 'w', 0o600);
    try {
      fs.writeSync(fd, sealed);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    try {
      fs.renameSync(tmp, this.file);
    } catch (e) {
      fs.rmSync(tmp, { force: true });
      throw e;
    }
    try {
      fs.chmodSync(this.file, 0o600);
    } catch {
      // not supported (Windows): the folder's ACL applies
    }
    this.stamp = this.statFile();
  }

  // ------------------------------------------------------------------ locking

  private tryLock(): boolean {
    try {
      const fd = fs.openSync(this.lockFile, 'wx', 0o600);
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, host: os.hostname(), at: Date.now() }));
      fs.closeSync(fd);
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw e;
      }
    }
    // Held: break it when its owner died or it is too old to be a live write.
    try {
      const st = fs.statSync(this.lockFile);
      let dead = false;
      try {
        const info = JSON.parse(fs.readFileSync(this.lockFile, 'utf8')) as { pid?: number; host?: string };
        dead = info.host === os.hostname() && typeof info.pid === 'number' && info.pid !== process.pid && !pidAlive(info.pid);
      } catch {
        // half-written lock file: judged by its age
      }
      if (dead || Date.now() - st.mtimeMs > LOCK_STALE_MS) {
        fs.rmSync(this.lockFile, { force: true });
      }
    } catch {
      // gone already
    }
    return false;
  }

  private lockSync(): void {
    const deadline = Date.now() + LOCK_WAIT_MS;
    while (!this.tryLock()) {
      if (Date.now() > deadline) {
        throw new Error(`${this.file} is busy (another LocalPilot process holds ${path.basename(this.lockFile)}); try again`);
      }
      sleepSync(15);
    }
  }

  private async lockAsync(): Promise<void> {
    const deadline = Date.now() + LOCK_WAIT_MS;
    while (!this.tryLock()) {
      if (Date.now() > deadline) {
        throw new Error(`${this.file} is busy (another LocalPilot process holds ${path.basename(this.lockFile)}); try again`);
      }
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  private unlockSync(): void {
    fs.rmSync(this.lockFile, { force: true });
  }

  // ------------------------------------------------------------------ changes from other processes

  private snapshot(): Map<string, string> {
    const out = new Map<string, string>();
    const st = this.db.prepare('SELECT name, value, updated_at FROM secrets');
    try {
      while (st.step()) {
        const [name, value, updated] = st.get();
        out.set(String(name), `${updated}:${value}`);
      }
    } finally {
      st.free();
    }
    return out;
  }

  /** Reloads when another process wrote the file since this one last read or wrote it. Returns the names that changed. */
  private reloadIfChanged(): string[] {
    this.assertOpen();
    const now = this.statFile();
    const same = (a?: Stamp, b?: Stamp) => (!a && !b) || (!!a && !!b && a.mtimeMs === b.mtimeMs && a.size === b.size && a.ino === b.ino);
    if (same(now, this.stamp)) {
      return [];
    }
    const before = this.snapshot();
    const raw = this.readFile();
    if (raw) {
      this.load(raw);
    } else {
      // Deleted outside LocalPilot: empty until the next write creates it again.
      this.db.close();
      this.db = new this.SQL.Database();
      this.schema();
      this.stamp = undefined;
    }
    const after = this.snapshot();
    return [...new Set([...before.keys(), ...after.keys()])].filter((n) => before.get(n) !== after.get(n));
  }

  private emit(names: string[]): void {
    if (!names.length) {
      return;
    }
    for (const l of [...this.listeners]) {
      try {
        l(names);
      } catch {
        // a listener's failure is its own
      }
    }
  }

  private read<T>(fn: () => T): T {
    const changed = this.reloadIfChanged();
    const out = fn();
    this.emit(changed);
    return out;
  }

  /** A read-modify-write under the lock, on the latest file. `fn` returns the names it changed. */
  private mutate(fn: () => string[]): string[] {
    this.assertOpen();
    this.lockSync();
    let changed: string[];
    let mine: string[];
    try {
      changed = this.reloadIfChanged();
      mine = fn();
      if (mine.length) {
        this.persist();
      }
    } finally {
      this.unlockSync();
    }
    this.emit([...new Set([...changed, ...mine])]);
    return mine;
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new Error('The secret store is closed');
    }
  }

  // ------------------------------------------------------------------ API

  get(name: string): string | undefined {
    return this.read(() => this.value(name));
  }

  private value(name: string): string | undefined {
    const st = this.db.prepare('SELECT value FROM secrets WHERE name = ?', [name]);
    try {
      return st.step() ? String(st.get()[0]) : undefined;
    } finally {
      st.free();
    }
  }

  has(name: string): boolean {
    return this.get(name) !== undefined;
  }

  /** Every secret by name. */
  all(): Record<string, string> {
    return this.read(() => {
      const out: Record<string, string> = {};
      const st = this.db.prepare('SELECT name, value FROM secrets ORDER BY name');
      try {
        while (st.step()) {
          const [n, v] = st.get();
          out[String(n)] = String(v);
        }
      } finally {
        st.free();
      }
      return out;
    });
  }

  /** What is stored, without the values. */
  list(): SecretMeta[] {
    return this.read(() => {
      const out: SecretMeta[] = [];
      const st = this.db.prepare('SELECT name, source, created_at, updated_at, last_used_at, length(value) FROM secrets ORDER BY name');
      try {
        while (st.step()) {
          const [name, source, created, updated, used, length] = st.get();
          out.push({ name: String(name), source: String(source ?? ''), createdAt: Number(created), updatedAt: Number(updated), lastUsedAt: used === null ? undefined : Number(used), length: Number(length) });
        }
      } finally {
        st.free();
      }
      return out;
    });
  }

  set(name: string, value: string, source = ''): void {
    this.setMany({ [name]: value }, source);
  }

  /** Stores several at once (one write). An empty value is refused: delete instead. */
  setMany(values: Record<string, string>, source = ''): void {
    const entries = Object.entries(values);
    for (const [name, value] of entries) {
      if (!name || typeof value !== 'string' || !value) {
        throw new Error(`Cannot store an empty secret${name ? ` for ${name}` : ''}`);
      }
    }
    this.mutate(() => {
      const t = this.now();
      const changed: string[] = [];
      for (const [name, value] of entries) {
        if (this.value(name) === value) {
          continue;
        }
        this.db.run(
          `INSERT INTO secrets (name, value, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(name) DO UPDATE SET value = excluded.value, source = excluded.source, updated_at = excluded.updated_at`,
          [name, value, source, t, t]
        );
        changed.push(name);
      }
      return changed;
    });
  }

  /** Removes a secret; true when there was one. */
  delete(name: string): boolean {
    return (
      this.mutate(() => {
        if (this.value(name) === undefined) {
          return [];
        }
        this.db.run('DELETE FROM secrets WHERE name = ?', [name]);
        return [name];
      }).length > 0
    );
  }

  /** Records that a secret was used, writing at most once a minute per secret. Never throws. */
  touch(name: string): void {
    try {
      const t = this.now();
      const fresh = () => {
        const st = this.db.prepare('SELECT last_used_at FROM secrets WHERE name = ?', [name]);
        try {
          return !st.step() || (st.get()[0] !== null && t - Number(st.get()[0]) < TOUCH_EVERY_MS);
        } finally {
          st.free();
        }
      };
      if (this.read(fresh)) {
        return;
      }
      this.assertOpen();
      this.lockSync();
      try {
        this.reloadIfChanged();
        if (!fresh()) {
          this.db.run('UPDATE secrets SET last_used_at = ? WHERE name = ?', [t, name]);
          this.persist();
        }
      } finally {
        this.unlockSync();
      }
    } catch {
      // "last used" is a convenience: never fail the request that used the key
    }
  }

  status(): SecretStoreStatus {
    const count = this.read(() => {
      const r = this.db.exec('SELECT count(*) FROM secrets');
      return Number(r[0]?.values[0]?.[0] ?? 0);
    });
    const st = this.statFile();
    return { file: this.file, exists: !!st, cipher: 'AES-256-GCM', mode: this.mode, unlockedBy: this.unlockedBy, count, bytes: st?.size ?? 0 };
  }

  /** Picks up another process's changes now (also done on every read); returns the names that changed. */
  refresh(): string[] {
    const changed = this.reloadIfChanged();
    this.emit(changed);
    return changed;
  }

  /** Names that changed: written here, or by another process (seen on a read or `refresh`). */
  onDidChange(listener: (names: string[]) => void): { dispose(): void } {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  close(): void {
    if (!this.closed) {
      this.closed = true;
      this.listeners.clear();
      this.db?.close();
    }
  }
}

function derive(passphrase: string, salt: Buffer): Buffer {
  return crypto.scryptSync(passphrase.normalize('NFKC'), salt, 32, SCRYPT);
}
