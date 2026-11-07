// Where data keys live on this device (design §15): VS Code SecretStorage (the OS keychain) or the CLI's keys.json
// (0600). Only data keys and backend credentials go here, never the passphrase. Pure: the VS Code adapter takes any
// object shaped like vscode.SecretStorage.
import type { DataKey } from './keyring';

export interface SecretBox {
  get(key: string): Promise<string | undefined>;
  store(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
  /** Name of a sync data key in this box. */
  dataKeyName(remoteId: string, keyId: string): string;
}

export interface SecretStorageLike {
  get(key: string): Thenable<string | undefined> | Promise<string | undefined>;
  store(key: string, value: string): Thenable<void> | Promise<void>;
  delete(key: string): Thenable<void> | Promise<void>;
}

/** VS Code: `localpilot.sync.<remoteId>.key.<keyId>` in SecretStorage. */
export function secretStorageBox(s: SecretStorageLike): SecretBox {
  return {
    get: async (k) => s.get(k),
    store: async (k, v) => s.store(k, v),
    delete: async (k) => s.delete(k),
    dataKeyName: (remoteId, keyId) => `localpilot.sync.${remoteId}.key.${keyId}`,
  };
}

/** CLI: entries `sync:<remoteId>:<keyId>` of ~/.localpilot/keys.json (readCliKeys / writeCliKey). */
export function cliKeysBox(read: () => Record<string, string>, write: (name: string, value: string | undefined) => Promise<void>): SecretBox {
  return {
    get: async (k) => read()[k],
    store: (k, v) => write(k, v),
    delete: (k) => write(k, undefined),
    dataKeyName: (remoteId, keyId) => `sync:${remoteId}:${keyId}`,
  };
}

/** In memory (tests, degraded mode). */
export function memorySecretBox(): SecretBox {
  const m = new Map<string, string>();
  return {
    get: async (k) => m.get(k),
    store: async (k, v) => void m.set(k, v),
    delete: async (k) => void m.delete(k),
    dataKeyName: (remoteId, keyId) => `sync:${remoteId}:${keyId}`,
  };
}

export async function storeDataKeys(box: SecretBox, remoteId: string, keys: readonly DataKey[]): Promise<void> {
  for (const k of keys) {
    await box.store(box.dataKeyName(remoteId, k.keyId), k.dek.toString('base64'));
  }
}

export async function loadDataKeys(box: SecretBox, remoteId: string, keyIds: readonly string[]): Promise<DataKey[]> {
  const out: DataKey[] = [];
  for (const keyId of keyIds) {
    const v = await box.get(box.dataKeyName(remoteId, keyId));
    if (v) {
      out.push({ keyId, dek: Buffer.from(v, 'base64') });
    }
  }
  return out;
}
