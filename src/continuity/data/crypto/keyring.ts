// Passphrase-derived key encryption (design §15). The passphrase never leaves this machine and is never stored: scrypt
// turns it into a key-encryption key (KEK) that wraps random data keys (DEKs, one per key id) with AES-256-GCM. The
// keyring file holds only wrapped keys and KDF parameters, so storage can keep it in the clear. Pure Node.
import * as crypto from 'crypto';

export interface KdfParams {
  alg: 'scrypt';
  N: number;
  r: number;
  p: number;
  /** base64, 16 bytes. */
  salt: string;
}
export interface WrappedKey {
  keyId: string;
  iv: string;
  ct: string;
  tag: string;
  createdAt: number;
}
export interface KeyringFile {
  v: 1;
  kdf: KdfParams;
  current: string;
  keys: WrappedKey[];
}
export interface DataKey {
  /** 32 hex characters (16 random bytes). */
  keyId: string;
  dek: Buffer;
}

export class WrongPassphraseError extends Error {
  constructor() {
    super('This passphrase does not unlock the keyring');
    this.name = 'WrongPassphraseError';
  }
}

export const DEFAULT_SCRYPT = { N: 2 ** 17, r: 8, p: 1 } as const;
const MAXMEM = 256 * 1024 * 1024;

export function normalizePassphrase(p: string): string {
  return p.normalize('NFKC');
}

/** scrypt KEK (async: runs on the libuv pool, off the main thread). */
export function deriveKek(passphrase: string, kdf: KdfParams): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    crypto.scrypt(normalizePassphrase(passphrase), Buffer.from(kdf.salt, 'base64'), 32, { N: kdf.N, r: kdf.r, p: kdf.p, maxmem: MAXMEM }, (err, key) => (err ? reject(err) : resolve(key)))
  );
}

export function newKdf(o: { N?: number; r?: number; p?: number; salt?: Buffer } = {}): KdfParams {
  return { alg: 'scrypt', N: o.N ?? DEFAULT_SCRYPT.N, r: o.r ?? DEFAULT_SCRYPT.r, p: o.p ?? DEFAULT_SCRYPT.p, salt: (o.salt ?? crypto.randomBytes(16)).toString('base64') };
}

const wrapAad = (keyId: string) => Buffer.from(`localpilot-keyring/v1/${keyId}`, 'utf8');

export function wrapKey(kek: Buffer, key: DataKey, now = Date.now(), iv = crypto.randomBytes(12)): WrappedKey {
  const c = crypto.createCipheriv('aes-256-gcm', kek, iv);
  c.setAAD(wrapAad(key.keyId));
  const ct = Buffer.concat([c.update(key.dek), c.final()]);
  return { keyId: key.keyId, iv: iv.toString('base64'), ct: ct.toString('base64'), tag: c.getAuthTag().toString('base64'), createdAt: now };
}

export function unwrapKey(kek: Buffer, w: WrappedKey): DataKey {
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', kek, Buffer.from(w.iv, 'base64'));
    d.setAAD(wrapAad(w.keyId));
    d.setAuthTag(Buffer.from(w.tag, 'base64'));
    return { keyId: w.keyId, dek: Buffer.concat([d.update(Buffer.from(w.ct, 'base64')), d.final()]) };
  } catch {
    throw new WrongPassphraseError();
  }
}

export function newDataKey(): DataKey {
  return { keyId: crypto.randomBytes(16).toString('hex'), dek: crypto.randomBytes(32) };
}

/** A new keyring with one data key. */
export async function createKeyring(passphrase: string, o: { N?: number; now?: number } = {}): Promise<{ file: KeyringFile; keys: DataKey[] }> {
  const kdf = newKdf({ N: o.N });
  const kek = await deriveKek(passphrase, kdf);
  const key = newDataKey();
  return { file: { v: 1, kdf, current: key.keyId, keys: [wrapKey(kek, key, o.now)] }, keys: [key] };
}

/** Every data key of the keyring; throws WrongPassphraseError when the passphrase does not match. */
export async function unlockKeyring(file: KeyringFile, passphrase: string): Promise<DataKey[]> {
  if (file?.v !== 1 || file.kdf?.alg !== 'scrypt' || !Array.isArray(file.keys)) {
    throw new Error('Not a LocalPilot keyring');
  }
  const kek = await deriveKek(passphrase, file.kdf);
  return file.keys.map((w) => unwrapKey(kek, w));
}

/** Re-wraps every data key under a new passphrase (new salt); data keys and objects stay the same. */
export async function changePassphrase(file: KeyringFile, oldPassphrase: string, newPassphrase: string, o: { N?: number; now?: number } = {}): Promise<KeyringFile> {
  const keys = await unlockKeyring(file, oldPassphrase);
  const kdf = newKdf({ N: o.N ?? file.kdf.N, r: file.kdf.r, p: file.kdf.p });
  const kek = await deriveKek(newPassphrase, kdf);
  const createdAt = new Map(file.keys.map((w) => [w.keyId, w.createdAt]));
  return { v: 1, kdf, current: file.current, keys: keys.map((k) => wrapKey(kek, k, createdAt.get(k.keyId) ?? o.now)) };
}

/** Adds a new current data key; old keys stay so history remains readable. */
export async function rotateKey(file: KeyringFile, passphrase: string, o: { now?: number } = {}): Promise<{ file: KeyringFile; key: DataKey; keys: DataKey[] }> {
  const keys = await unlockKeyring(file, passphrase);
  const kek = await deriveKek(passphrase, file.kdf);
  const key = newDataKey();
  return { file: { ...file, current: key.keyId, keys: [...file.keys, wrapKey(kek, key, o.now)] }, key, keys: [...keys, key] };
}

/** HKDF-SHA256 sub-keys of a data key: `enc` encrypts objects, `blob` names blobs. */
export function subKeys(dek: Buffer): { enc: Buffer; blob: Buffer } {
  const derive = (info: string) => Buffer.from(crypto.hkdfSync('sha256', dek, Buffer.alloc(0), Buffer.from(`localpilot/${info}`, 'utf8'), 32));
  return { enc: derive('enc'), blob: derive('blob') };
}

export function currentKey(file: KeyringFile, keys: DataKey[]): DataKey {
  const k = keys.find((x) => x.keyId === file.current);
  if (!k) {
    throw new Error('The current key of the keyring is not available');
  }
  return k;
}
