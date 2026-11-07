// Backups (design §10): `.lpbackup` = gzip of JSONL — a header line, then every event of every stream (compacted bases
// as one `base` line per stream), then `{ kind: 'blob', sha, b64 }` lines. Optionally sealed with a passphrase:
// `LPBK1\n<kdf json>\n` + an LPE1 object (§15). Restoring merges like a sync pull: events are deduplicated by id, a
// stream already ahead locally is skipped, nothing newer is removed. Pure Node.
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';
import type { EventEnvelope } from '../events';
import type { BlobStore } from './blobs';
import { open as openSealed, seal } from './crypto/envelope';
import { deriveKek, KdfParams, newKdf } from './crypto/keyring';
import type { FileEventLog } from './eventLog';
import { listSegments, readSegmentLines } from './segment';

const SEALED_MAGIC = 'LPBK1\n';

export interface BackupHeader {
  kind: 'header';
  v: 1;
  deviceId: string;
  createdAt: number;
  streams: { id: string; lastSeq: number }[];
  appVersion?: string;
}

export interface BackupResult {
  file: string;
  events: number;
  blobs: number;
  bytes: number;
  encrypted: boolean;
}

export interface RestoreResult {
  streams: number;
  imported: number;
  skipped: number;
  blobs: number;
  /** Streams that could not be merged (written by a live process here, or out of order), with why. */
  refused: { stream: string; reason: string }[];
}

export class WrongBackupPassphraseError extends Error {
  constructor() {
    super('This passphrase does not open the backup');
    this.name = 'WrongBackupPassphraseError';
  }
}

export function backupStamp(at: number): string {
  return new Date(at).toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
}

async function sealKey(passphrase: string, kdf: KdfParams) {
  const dek = await deriveKek(passphrase, kdf);
  return { keyId: crypto.createHash('sha256').update(kdf.salt).digest('hex').slice(0, 32), dek };
}

/** Writes a backup of every stream (and, by default, every blob) of the data root. */
export async function writeBackup(o: { log: FileEventLog; blobs: BlobStore; dir: string; file?: string; passphrase?: string; now?: () => number; includeBlobs?: boolean; appVersion?: string; kdfN?: number }): Promise<BackupResult> {
  await o.log.flush();
  const now = (o.now ?? Date.now)();
  const streamsDir = path.join(o.log.root, 'streams');
  const streams = (await o.log.streams()).sort((a, b) => (a.id < b.id ? -1 : 1));
  const lines: string[] = [];
  const header: BackupHeader = { kind: 'header', v: 1, deviceId: o.log.device.deviceId, createdAt: now, streams: streams.map((s) => ({ id: s.id, lastSeq: s.lastSeq })), ...(o.appVersion ? { appVersion: o.appVersion } : {}) };
  lines.push(JSON.stringify(header));
  let events = 0;
  for (const s of streams) {
    for (const f of listSegments(path.join(streamsDir, s.id))) {
      const recs = readSegmentLines(f.file);
      if (f.compact) {
        lines.push(JSON.stringify({ kind: 'base', stream: s.id, cut: -f.segment, events: recs.map((r) => r.e) }));
        events += recs.length;
        continue;
      }
      for (const r of recs) {
        lines.push(JSON.stringify(r.e));
        events++;
      }
    }
  }
  let blobs = 0;
  if (o.includeBlobs !== false) {
    for (const b of o.blobs.list()) {
      const data = o.blobs.get(b.sha);
      if (data) {
        lines.push(JSON.stringify({ kind: 'blob', sha: b.sha, b64: data.toString('base64') }));
        blobs++;
      }
    }
  }
  const plain = Buffer.from(`${lines.join('\n')}\n`, 'utf8');
  let body: Buffer;
  if (o.passphrase) {
    const kdf = newKdf({ N: o.kdfN });
    const key = await sealKey(o.passphrase, kdf);
    body = Buffer.concat([Buffer.from(SEALED_MAGIC + JSON.stringify(kdf) + '\n', 'utf8'), seal(key, 'localpilot-backup', plain)]);
  } else {
    body = zlib.gzipSync(plain);
  }
  fs.mkdirSync(o.dir, { recursive: true });
  const file = o.file ?? path.join(o.dir, `${backupStamp(now)}.lpbackup`);
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, body);
  fs.renameSync(tmp, file);
  return { file, events, blobs, bytes: body.length, encrypted: !!o.passphrase };
}

export function isEncryptedBackup(file: string): boolean {
  const fd = fs.openSync(file, 'r');
  try {
    const b = Buffer.alloc(SEALED_MAGIC.length);
    fs.readSync(fd, b, 0, b.length, 0);
    return b.toString('utf8') === SEALED_MAGIC;
  } finally {
    fs.closeSync(fd);
  }
}

/** Parses a backup file (decrypting it with the passphrase when it is sealed). */
export async function readBackup(file: string, passphrase?: string): Promise<{ header: BackupHeader; events: Map<string, EventEnvelope[]>; bases: Map<string, { cut: number; events: EventEnvelope[] }>; blobs: { sha: string; data: Buffer }[] }> {
  const raw = fs.readFileSync(file);
  let plain: Buffer;
  if (raw.subarray(0, SEALED_MAGIC.length).toString('utf8') === SEALED_MAGIC) {
    if (!passphrase) {
      throw new WrongBackupPassphraseError();
    }
    const nl = raw.indexOf(10, SEALED_MAGIC.length);
    const kdf = JSON.parse(raw.subarray(SEALED_MAGIC.length, nl).toString('utf8')) as KdfParams;
    const key = await sealKey(passphrase, kdf);
    try {
      plain = openSealed([key], 'localpilot-backup', raw.subarray(nl + 1));
    } catch {
      throw new WrongBackupPassphraseError();
    }
  } else {
    plain = zlib.gunzipSync(raw);
  }
  const lines = plain.toString('utf8').split('\n').filter(Boolean);
  const header = JSON.parse(lines[0] ?? '{}') as BackupHeader;
  if (header.kind !== 'header' || header.v !== 1) {
    throw new Error('Not a LocalPilot backup');
  }
  const events = new Map<string, EventEnvelope[]>();
  const bases = new Map<string, { cut: number; events: EventEnvelope[] }>();
  const blobs: { sha: string; data: Buffer }[] = [];
  for (const line of lines.slice(1)) {
    const x = JSON.parse(line) as Record<string, unknown>;
    if (x.kind === 'blob') {
      blobs.push({ sha: String(x.sha), data: Buffer.from(String(x.b64), 'base64') });
    } else if (x.kind === 'base') {
      bases.set(String(x.stream), { cut: Number(x.cut), events: x.events as EventEnvelope[] });
    } else {
      const e = x as unknown as EventEnvelope;
      (events.get(e.stream) ?? events.set(e.stream, []).get(e.stream)!).push(e);
    }
  }
  return { header, events, bases, blobs };
}

/** Merges a backup into the data root. */
export async function restoreBackup(o: { log: FileEventLog; blobs: BlobStore; file: string; passphrase?: string }): Promise<RestoreResult> {
  const b = await readBackup(o.file, o.passphrase);
  const r: RestoreResult = { streams: 0, imported: 0, skipped: 0, blobs: 0, refused: [] };
  const ids = new Set([...b.events.keys(), ...b.bases.keys()]);
  for (const stream of [...ids].sort()) {
    r.streams++;
    const base = b.bases.get(stream);
    if (base) {
      o.log.importBase(stream, base.cut, base.events);
    }
    const events = b.events.get(stream) ?? [];
    try {
      const x = await o.log.importRemote(stream, events);
      r.imported += x.imported;
      r.skipped += x.skipped;
    } catch (e) {
      r.skipped += events.length;
      r.refused.push({ stream, reason: e instanceof Error ? e.message : String(e) });
    }
  }
  for (const x of b.blobs) {
    if (!o.blobs.has(x.sha)) {
      o.blobs.put(x.data);
      r.blobs++;
    }
  }
  return r;
}

export function listBackups(dir: string): { file: string; bytes: number; at: number }[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((n) => n.endsWith('.lpbackup'))
    .map((n) => {
      const st = fs.statSync(path.join(dir, n));
      return { file: path.join(dir, n), bytes: st.size, at: st.mtimeMs };
    })
    .sort((a, b) => b.at - a.at);
}

/** Keeps the newest `keep` backups in `dir`. */
export function pruneBackups(dir: string, keep: number): number {
  const list = listBackups(dir);
  let removed = 0;
  for (const b of list.slice(Math.max(1, keep))) {
    fs.rmSync(b.file, { force: true });
    removed++;
  }
  return removed;
}
