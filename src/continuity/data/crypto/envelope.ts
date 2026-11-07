// Sealed objects (design §15): `LPE1 | keyId (16) | iv (12) | ciphertext | tag (16)`, AES-256-GCM with the data key's
// `enc` sub-key, AAD `LPE1/<object key>` so an object cannot be swapped or replayed under another name, plaintext
// gzip-compressed before encryption. Pure Node.
import * as crypto from 'crypto';
import * as zlib from 'zlib';
import { DataKey, subKeys } from './keyring';

export const MAGIC = Buffer.from('LPE1', 'ascii');
const HEADER = 4 + 16 + 12;
const TAG = 16;

export class SealError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SealError';
  }
}

const encKeys = new WeakMap<Buffer, Buffer>();
function encKey(k: DataKey): Buffer {
  let e = encKeys.get(k.dek);
  if (!e) {
    e = subKeys(k.dek).enc;
    encKeys.set(k.dek, e);
  }
  return e;
}

const aad = (objectKey: string) => Buffer.from(`LPE1/${objectKey}`, 'utf8');

export function seal(key: DataKey, objectKey: string, plaintext: Uint8Array | string, o: { iv?: Buffer } = {}): Buffer {
  const iv = o.iv ?? crypto.randomBytes(12);
  const keyIdBytes = Buffer.from(key.keyId, 'hex');
  if (keyIdBytes.length !== 16) {
    throw new SealError('key id must be 16 bytes');
  }
  const c = crypto.createCipheriv('aes-256-gcm', encKey(key), iv);
  c.setAAD(aad(objectKey));
  const body = zlib.gzipSync(typeof plaintext === 'string' ? Buffer.from(plaintext, 'utf8') : Buffer.from(plaintext));
  const ct = Buffer.concat([c.update(body), c.final()]);
  return Buffer.concat([MAGIC, keyIdBytes, iv, ct, c.getAuthTag()]);
}

/** The key id an object was sealed with (to pick the key, or report a missing one). */
export function sealedKeyId(data: Uint8Array): string {
  const b = Buffer.from(data);
  if (b.length < HEADER + TAG || !b.subarray(0, 4).equals(MAGIC)) {
    throw new SealError('not a sealed LocalPilot object');
  }
  return b.subarray(4, 20).toString('hex');
}

/** Opens a sealed object; throws SealError when the key is unknown, the object was changed or moved. */
export function open(keys: readonly DataKey[] | ((keyId: string) => DataKey | undefined), objectKey: string, data: Uint8Array): Buffer {
  const b = Buffer.from(data);
  const keyId = sealedKeyId(b);
  const key = typeof keys === 'function' ? keys(keyId) : keys.find((k) => k.keyId === keyId);
  if (!key) {
    throw new SealError(`sealed with a key this device does not have (${keyId.slice(0, 8)}…)`);
  }
  const iv = b.subarray(20, HEADER);
  const ct = b.subarray(HEADER, b.length - TAG);
  const tag = b.subarray(b.length - TAG);
  let body: Buffer;
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', encKey(key), iv);
    d.setAAD(aad(objectKey));
    d.setAuthTag(tag);
    body = Buffer.concat([d.update(ct), d.final()]);
  } catch {
    throw new SealError(`${objectKey} failed authentication (damaged, tampered with, or stored under another name)`);
  }
  return zlib.gunzipSync(body);
}

/** Remote name of a blob: HMAC-SHA256(blobKey, sha256 of the plaintext), so storage cannot test for known content. */
export function blobName(blobKey: Buffer, sha: string): string {
  return crypto.createHmac('sha256', blobKey).update(sha).digest('hex');
}
