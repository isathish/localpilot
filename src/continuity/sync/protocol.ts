// The remote layout and object formats of sync (design §14.1). Every object but `format.json` and `keyring.json` is
// sealed (`LPE1`, AES-256-GCM, AAD = its key) with the remote's data key, so storage sees only ciphertext, sizes and
// random-looking names. Objects are deterministic: the IV is derived from the key, the object name and the plaintext
// (a synthetic IV), so a retried upload writes byte-for-byte the same object and the same plaintext under the same
// name never reuses an IV with different content. Pure Node.
import * as crypto from 'crypto';
import type { EventEnvelope } from '../events';
import { blobName, open as openSealed, seal, sealedKeyId } from '../data/crypto/envelope';
import { DataKey, KeyringFile, subKeys } from '../data/crypto/keyring';
import { pad12 } from '../data/segment';
import { BackendError, SyncBackend } from './backends/backend';

export const FORMAT_KEY = 'format.json';
export const KEYRING_KEY = 'keyring.json';
export const FORMAT_NAME = 'localpilot-sync';

/** Largest chunk: 2 MiB of plaintext or 5,000 events (§14.2). */
export const CHUNK_MAX_BYTES = 2 * 1024 * 1024;
export const CHUNK_MAX_EVENTS = 5000;

export interface FormatFile {
  format: typeof FORMAT_NAME;
  v: 1;
  createdAt: number;
  /** Random; names this remote's keys in the SecretBox. Not secret. */
  remoteId: string;
}

/** `devices/<id>.json.lpe`: written only by that device. */
export interface DeviceFile {
  v: 1;
  deviceId: string;
  name: string;
  platform: string;
  appVersions: Partial<Record<'vscode' | 'cli', string>>;
  lastSeen: number;
  /** Per stream of this device: the last uploaded seq, and the newest uploaded compacted base. */
  streams: Record<string, { head: number; base?: number }>;
  revokedAt?: number;
}

export const deviceKey = (deviceId: string): string => `devices/${deviceId}.json.lpe`;
export const streamPrefix = (stream: string): string => `streams/${stream}/`;
export const chunkKey = (stream: string, from: number, to: number): string => `streams/${stream}/${pad12(from)}-${pad12(to)}.lpe`;
export const baseKey = (stream: string, to: number): string => `streams/${stream}/base-${pad12(to)}.lpe`;
/** Remote blob name: HMAC(blobKey, sha256) so storage cannot test for known content. */
export const blobKey = (key: DataKey, sha: string): string => `blobs/${blobName(subKeys(key.dek).blob, sha)}.lpe`;

/** Parses a key under `streams/<id>/`: a chunk `<from>-<to>.lpe` or a base `base-<to>.lpe`. */
export function parseStreamObject(key: string): { stream: string; kind: 'chunk'; from: number; to: number } | { stream: string; kind: 'base'; to: number } | undefined {
  let m = /^streams\/(dev_[\w-]+\.\d+)\/(\d{12})-(\d{12})\.lpe$/.exec(key);
  if (m) {
    return { stream: m[1], kind: 'chunk', from: Number(m[2]), to: Number(m[3]) };
  }
  m = /^streams\/(dev_[\w-]+\.\d+)\/base-(\d{12})\.lpe$/.exec(key);
  return m ? { stream: m[1], kind: 'base', to: Number(m[2]) } : undefined;
}

const ivKeys = new WeakMap<Buffer, Buffer>();
function ivKey(k: DataKey): Buffer {
  let v = ivKeys.get(k.dek);
  if (!v) {
    v = Buffer.from(crypto.hkdfSync('sha256', k.dek, Buffer.alloc(0), Buffer.from('localpilot/sync-iv', 'utf8'), 32));
    ivKeys.set(k.dek, v);
  }
  return v;
}

/** Seals an object with a synthetic IV (same key + name + plaintext = same bytes). */
export function sealObject(key: DataKey, objectKey: string, plaintext: Uint8Array | string): Buffer {
  const body = typeof plaintext === 'string' ? Buffer.from(plaintext, 'utf8') : Buffer.from(plaintext);
  const iv = crypto.createHmac('sha256', ivKey(key)).update(objectKey, 'utf8').update('\u0000').update(body).digest().subarray(0, 12);
  return seal(key, objectKey, body, { iv });
}

/** Opens a sealed object (throws SealError: unknown key, damaged, or moved). */
export function openObject(keys: (keyId: string) => DataKey | undefined, objectKey: string, data: Uint8Array): Buffer {
  return openSealed(keys, objectKey, data);
}

export { sealedKeyId };

export function encodeEvents(events: EventEnvelope[]): string {
  return events.map((e) => JSON.stringify(e)).join('\n') + (events.length ? '\n' : '');
}

export function decodeEvents(text: string): EventEnvelope[] {
  return text
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as EventEnvelope);
}

/** Cuts events into chunks of at most CHUNK_MAX_BYTES of JSONL and CHUNK_MAX_EVENTS events. */
export function cutChunks(events: EventEnvelope[], maxBytes = CHUNK_MAX_BYTES, maxEvents = CHUNK_MAX_EVENTS): EventEnvelope[][] {
  const out: EventEnvelope[][] = [];
  let cur: EventEnvelope[] = [];
  let bytes = 0;
  for (const e of events) {
    const n = Buffer.byteLength(JSON.stringify(e)) + 1;
    if (cur.length && (cur.length >= maxEvents || bytes + n > maxBytes)) {
      out.push(cur);
      cur = [];
      bytes = 0;
    }
    cur.push(e);
    bytes += n;
  }
  if (cur.length) {
    out.push(cur);
  }
  return out;
}

export async function readJson<T>(backend: SyncBackend, key: string): Promise<T | undefined> {
  const b = await backend.get(key);
  if (!b) {
    return undefined;
  }
  try {
    return JSON.parse(Buffer.from(b).toString('utf8')) as T;
  } catch {
    throw new BackendError('other', `${key} on the remote is not valid JSON`);
  }
}

export function isFormat(f: unknown): f is FormatFile {
  const x = f as FormatFile;
  return !!x && x.format === FORMAT_NAME && x.v === 1 && typeof x.remoteId === 'string';
}

export function isKeyring(k: unknown): k is KeyringFile {
  const x = k as KeyringFile;
  return !!x && x.v === 1 && x.kdf?.alg === 'scrypt' && Array.isArray(x.keys) && typeof x.current === 'string';
}

export const newRemoteId = (): string => `r${crypto.randomBytes(8).toString('hex')}`;
