// The CLI's side of the shared secret store: opened once per process, before anything reads a key. On first open the
// plain-text files older versions wrote (~/.localpilot/keys.json for API keys and sync keys, secrets.json for MCP
// sign-in tokens) are moved in, and each file is deleted only once every value in it reads back from the store.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { defaultSecretsDir, SecretStore, SecretStoreOptions } from './store';
import { StoreSecretStorage } from './storeStorage';

/** Plain-text key file of LocalPilot 1.7 and earlier (`${secret:NAME}` values for the CLI, sync keys). */
export const LEGACY_KEYS_PATH = path.join(os.homedir(), '.localpilot', 'keys.json');
/** Plain-text MCP sign-in tokens of the CLI in 1.7 and earlier. */
export const LEGACY_SECRETS_PATH = path.join(os.homedir(), '.localpilot', 'secrets.json');

let opening: Promise<SecretStore | undefined> | undefined;
let current: SecretStore | undefined;
let openError: string | undefined;
let migration: LegacyMigration[] = [];

export interface LegacyMigration {
  file: string;
  /** Names moved into the store. */
  moved: string[];
  /** The file was removed after every value read back. */
  deleted: boolean;
  /** Why the file was left alone (unreadable JSON, a value that did not read back…). */
  error?: string;
}

/**
 * Opens the store for this process (once) and moves the legacy files in. Never throws: when the store cannot be
 * opened, `cliSecretError()` says why and key writes fail with that message.
 */
export function openCliSecrets(opts: SecretStoreOptions = {}, legacy = [LEGACY_KEYS_PATH, LEGACY_SECRETS_PATH]): Promise<SecretStore | undefined> {
  opening ??= SecretStore.open({ wasmPath: process.env.LOCALPILOT_SQLJS_WASM || path.join(__dirname, 'sqljs', 'sql-wasm.wasm'), ...opts }).then(
    (store) => {
      current = store;
      migration = legacy.map((f) => migrateLegacyFile(store, f)).filter((m): m is LegacyMigration => !!m);
      return store;
    },
    (e) => {
      openError = e instanceof Error ? e.message : String(e);
      return undefined;
    }
  );
  return opening;
}

/** The open store, if `openCliSecrets` succeeded. */
export function cliSecretStore(): SecretStore | undefined {
  return current;
}

/** Why the store could not be opened. */
export function cliSecretError(): string | undefined {
  return openError;
}

/** What this process moved out of the legacy files. */
export function cliMigration(): LegacyMigration[] {
  return migration;
}

/** Forgets the open store (tests). */
export function resetCliSecrets(): void {
  current?.close();
  current = undefined;
  opening = undefined;
  openError = undefined;
  migration = [];
}

function readLegacy(file: string): Record<string, string> | undefined {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('not a JSON object');
  }
  return Object.fromEntries(Object.entries(raw as Record<string, unknown>).filter((e): e is [string, string] => typeof e[1] === 'string' && !!e[1]));
}

/**
 * Moves one legacy file into the store. A name the store already holds with another value keeps the store's value;
 * the file's goes in as `<name>.from-<file>` so nothing is lost. The file is deleted only after every value reads back.
 */
export function migrateLegacyFile(store: SecretStore, file: string): LegacyMigration | undefined {
  if (!fs.existsSync(file)) {
    return undefined;
  }
  const base = path.basename(file);
  let entries: Record<string, string>;
  try {
    entries = readLegacy(file)!;
  } catch (e) {
    // Unreadable: left exactly as it is, for the user to look at.
    return { file, moved: [], deleted: false, error: `${base} is not valid JSON (${e instanceof Error ? e.message : String(e)}); left as it is` };
  }
  const have = store.all();
  const plan: Record<string, string> = {};
  for (const [name, value] of Object.entries(entries)) {
    const target = have[name] === undefined || have[name] === value ? name : `${name}.from-${base.replace(/\.json$/, '')}`;
    plan[target] = value;
  }
  try {
    const todo = Object.fromEntries(Object.entries(plan).filter(([n, v]) => have[n] !== v));
    if (Object.keys(todo).length) {
      store.setMany(todo, `migrated:${base}`);
    }
    const after = store.all();
    const missing = Object.entries(plan).filter(([n, v]) => after[n] !== v);
    if (missing.length) {
      return { file, moved: [], deleted: false, error: `${missing.length} value(s) from ${base} did not read back from the secret store; ${base} was kept` };
    }
    fs.rmSync(file, { force: true });
    return { file, moved: Object.keys(plan), deleted: true };
  } catch (e) {
    return { file, moved: [], deleted: false, error: `${base} could not be moved into the secret store (${e instanceof Error ? e.message : String(e)}); it was kept` };
  }
}

/**
 * Values for `${secret:NAME}` references. From the store; only when it cannot be opened, from a legacy keys.json that
 * is still there, so an upgrade on a machine without a keychain never loses access to the keys.
 */
export function readCliKeys(): Record<string, string> {
  if (current) {
    return current.all();
  }
  try {
    return (fs.existsSync(LEGACY_KEYS_PATH) && readLegacy(LEGACY_KEYS_PATH)) || {};
  } catch {
    return {};
  }
}

/** Stores (or with `undefined`, removes) a secret. Throws when the store is not open: there is no plain-text fallback. */
export async function writeCliKey(name: string, key: string | undefined, source = 'cli'): Promise<void> {
  const store = current ?? (await openCliSecrets());
  if (!store) {
    throw new Error(`Cannot save the key: ${openError ?? 'the secret store is not open'}`);
  }
  if (key) {
    store.set(name, key, source);
  } else {
    store.delete(name);
  }
}

/** The CLI's MCP sign-in token storage: the shared store, or (store not open) a stand-in that refuses to keep tokens. */
export function cliSecretStorage(): StoreSecretStorage | LockedSecretStorage {
  return current ? new StoreSecretStorage(current, 'cli') : new LockedSecretStorage(openError ?? 'the secret store is not open');
}

/** SecretStorage-shaped stand-in when the store is locked: reads find nothing, writes fail with the reason. */
export class LockedSecretStorage {
  constructor(private readonly reason: string) {}
  async get(): Promise<string | undefined> {
    return undefined;
  }
  async store(): Promise<void> {
    throw new Error(`Cannot save the sign-in: ${this.reason}`);
  }
  async delete(): Promise<void> {
    return undefined;
  }
  onDidChange = (): { dispose(): void } => ({ dispose: () => undefined });
}

/** Where the CLI's secrets are, for messages. */
export function cliSecretsFile(): string {
  return current?.file ?? path.join(defaultSecretsDir(), 'secrets.db');
}
