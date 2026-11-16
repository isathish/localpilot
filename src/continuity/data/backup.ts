// Backups (design §10, §26): JSONL — a header line, then every event of every stream (compacted bases as one `base`
// line per stream), then `{ kind: 'blob', sha, b64 }` lines — written and read as a stream, never held in memory whole.
// Plain: gzip of the JSONL. Encrypted with a passphrase: `LPBK2\n<kdf json>\n` + frames `<u32 length><LPE1 object>`,
// each sealing up to 4 MiB of lines under `localpilot-backup/2/<n>` (the last one `…/<n>/end`, so a cut file is
// detected); 1.7.0's `LPBK1\n<kdf json>\n<one LPE1 object>` is still read. The content of entities purged before the
// backup is left out (their lines are written redacted). Restoring merges like a sync pull: events are deduplicated by
// id, a stream already ahead locally is skipped, nothing newer is removed. Pure Node.
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { Readable } from 'stream';
import * as zlib from 'zlib';
import type { EventEnvelope } from '../events';
import type { BlobStore } from './blobs';
import { open as openSealed, seal } from './crypto/envelope';
import { deriveKek, KdfParams, newKdf } from './crypto/keyring';
import type { FileEventLog } from './eventLog';
import { listSegments, readSegmentLines } from './segment';

const SEALED_MAGIC = 'LPBK1\n';
const SEALED_MAGIC_2 = 'LPBK2\n';
/** Plaintext per encrypted frame. */
const FRAME_BYTES = 4 * 1024 * 1024;

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

const frameKey = (n: number, last: boolean) => `localpilot-backup/2/${n}${last ? '/end' : ''}`;

/** Ids purged in any stream (a pass over the purge events), when the caller has no index to ask. */
function scanPurged(streamsDir: string, streams: string[]): Set<string> {
  const out = new Set<string>();
  for (const s of streams) {
    for (const f of listSegments(path.join(streamsDir, s))) {
      for (const r of readSegmentLines(f.file)) {
        if (r.e.op === 'purge') {
          out.add(r.e.eid);
        }
      }
    }
  }
  return out;
}

function redactFor(ids: ReadonlySet<string>): (e: EventEnvelope) => EventEnvelope {
  if (!ids.size) {
    return (e) => e;
  }
  return (e) => {
    const conv = (e.p as { conversationId?: unknown }).conversationId;
    return e.op !== 'purge' && (ids.has(e.eid) || (typeof conv === 'string' && ids.has(conv))) ? { ...e, p: { redacted: true } } : e;
  };
}

/** Where the lines of a backup go: a gzip stream, or sealed frames. */
interface Sink {
  write(line: string): Promise<void>;
  end(): Promise<void>;
}

function gzipSink(out: fs.WriteStream): Sink {
  const gz = zlib.createGzip();
  gz.pipe(out);
  const done = new Promise<void>((resolve, reject) => {
    out.on('finish', resolve);
    out.on('error', reject);
    gz.on('error', reject);
  });
  return {
    write: async (line) => {
      if (!gz.write(`${line}\n`)) {
        await new Promise<void>((r) => gz.once('drain', () => r()));
      }
    },
    end: async () => {
      gz.end();
      await done;
    },
  };
}

function sealedSink(out: fs.WriteStream, key: { keyId: string; dek: Buffer }): Sink {
  let buf: string[] = [];
  let size = 0;
  let n = 0;
  const done = new Promise<void>((resolve, reject) => {
    out.on('finish', resolve);
    out.on('error', reject);
  });
  const frame = async (last: boolean) => {
    const body = seal(key, frameKey(n++, last), Buffer.from(buf.join(''), 'utf8'));
    buf = [];
    size = 0;
    const len = Buffer.alloc(4);
    len.writeUInt32BE(body.length);
    if (!out.write(Buffer.concat([len, body]))) {
      await new Promise<void>((r) => out.once('drain', () => r()));
    }
  };
  return {
    write: async (line) => {
      buf.push(`${line}\n`);
      size += Buffer.byteLength(line) + 1;
      if (size >= FRAME_BYTES) {
        await frame(false);
      }
    },
    end: async () => {
      await frame(true);
      out.end();
      await done;
    },
  };
}

/**
 * Writes a backup of every stream (and, by default, every blob) of the data root. `purged` names entities whose
 * content must not be in it (the index's purged entities); without it the streams' purge events are scanned.
 */
export async function writeBackup(o: { log: FileEventLog; blobs: BlobStore; dir: string; file?: string; passphrase?: string; now?: () => number; includeBlobs?: boolean; appVersion?: string; kdfN?: number; purged?: ReadonlySet<string> }): Promise<BackupResult> {
  await o.log.flush();
  const now = (o.now ?? Date.now)();
  const streamsDir = path.join(o.log.root, 'streams');
  const streams = (await o.log.streams()).sort((a, b) => (a.id < b.id ? -1 : 1));
  const redact = redactFor(o.purged ?? scanPurged(streamsDir, streams.map((s) => s.id)));
  fs.mkdirSync(o.dir, { recursive: true });
  const file = o.file ?? path.join(o.dir, `${backupStamp(now)}.lpbackup`);
  const tmp = `${file}.tmp-${process.pid}`;
  const out = fs.createWriteStream(tmp);
  let sink: Sink;
  if (o.passphrase) {
    const kdf = newKdf({ N: o.kdfN });
    const key = await sealKey(o.passphrase, kdf);
    out.write(Buffer.from(SEALED_MAGIC_2 + JSON.stringify(kdf) + '\n', 'utf8'));
    sink = sealedSink(out, key);
  } else {
    sink = gzipSink(out);
  }
  let events = 0;
  let blobs = 0;
  try {
    const header: BackupHeader = { kind: 'header', v: 1, deviceId: o.log.device.deviceId, createdAt: now, streams: streams.map((s) => ({ id: s.id, lastSeq: s.lastSeq })), ...(o.appVersion ? { appVersion: o.appVersion } : {}) };
    await sink.write(JSON.stringify(header));
    for (const s of streams) {
      for (const f of listSegments(path.join(streamsDir, s.id))) {
        const recs = readSegmentLines(f.file);
        if (f.compact) {
          await sink.write(JSON.stringify({ kind: 'base', stream: s.id, cut: -f.segment, events: recs.map((r) => redact(r.e)) }));
          events += recs.length;
          continue;
        }
        for (const r of recs) {
          await sink.write(JSON.stringify(redact(r.e)));
          events++;
        }
      }
    }
    if (o.includeBlobs !== false) {
      for (const b of o.blobs.list()) {
        const data = o.blobs.get(b.sha);
        if (data) {
          await sink.write(JSON.stringify({ kind: 'blob', sha: b.sha, b64: data.toString('base64') }));
          blobs++;
        }
      }
    }
    await sink.end();
    fs.renameSync(tmp, file);
  } catch (e) {
    out.destroy();
    fs.rmSync(tmp, { force: true });
    throw e;
  }
  return { file, events, blobs, bytes: fs.statSync(file).size, encrypted: !!o.passphrase };
}

function magicOf(file: string): string {
  const fd = fs.openSync(file, 'r');
  try {
    const b = Buffer.alloc(SEALED_MAGIC.length);
    const n = fs.readSync(fd, b, 0, b.length, 0);
    return b.subarray(0, n).toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

export function isEncryptedBackup(file: string): boolean {
  const m = magicOf(file);
  return m === SEALED_MAGIC || m === SEALED_MAGIC_2;
}

/** The lines of a backup, one parsed object at a time (decrypting with the passphrase when it is sealed). */
export async function* backupLines(file: string, passphrase?: string): AsyncGenerator<Record<string, unknown>> {
  const magic = magicOf(file);
  if (magic === SEALED_MAGIC || magic === SEALED_MAGIC_2) {
    if (!passphrase) {
      throw new WrongBackupPassphraseError();
    }
    const fh = await fs.promises.open(file, 'r');
    try {
      // Header: magic + kdf json + newline (small).
      const head = Buffer.alloc(64 * 1024);
      const { bytesRead } = await fh.read(head, 0, head.length, 0);
      const nl = head.subarray(0, bytesRead).indexOf(10, SEALED_MAGIC.length);
      if (nl < 0) {
        throw new Error('Not a LocalPilot backup');
      }
      const kdf = JSON.parse(head.subarray(SEALED_MAGIC.length, nl).toString('utf8')) as KdfParams;
      const key = await sealKey(passphrase, kdf);
      if (magic === SEALED_MAGIC) {
        // 1.7.0: one sealed object for the whole file.
        const raw = await fs.promises.readFile(file);
        let plain: Buffer;
        try {
          plain = openSealed([key], 'localpilot-backup', raw.subarray(nl + 1));
        } catch {
          throw new WrongBackupPassphraseError();
        }
        for (const line of plain.toString('utf8').split('\n')) {
          if (line) {
            yield JSON.parse(line) as Record<string, unknown>;
          }
        }
        return;
      }
      let pos = nl + 1;
      const size = (await fh.stat()).size;
      let ended = false;
      for (let n = 0; pos < size; n++) {
        const len = Buffer.alloc(4);
        await fh.read(len, 0, 4, pos);
        const body = Buffer.alloc(len.readUInt32BE(0));
        const r = await fh.read(body, 0, body.length, pos + 4);
        if (r.bytesRead !== body.length) {
          throw new Error('This backup is cut short (the file is incomplete)');
        }
        pos += 4 + body.length;
        let plain: Buffer;
        const last = pos >= size;
        try {
          plain = openSealed([key], frameKey(n, last), body);
        } catch {
          if (n === 0) {
            throw new WrongBackupPassphraseError();
          }
          throw new Error(last ? 'This backup is cut short or damaged (its last part does not close it)' : `This backup is damaged (part ${n + 1})`);
        }
        ended = last;
        for (const line of plain.toString('utf8').split('\n')) {
          if (line) {
            yield JSON.parse(line) as Record<string, unknown>;
          }
        }
      }
      if (!ended) {
        throw new Error('This backup is cut short (the file is incomplete)');
      }
    } finally {
      await fh.close();
    }
    return;
  }
  const rl = readline.createInterface({ input: (fs.createReadStream(file).pipe(zlib.createGunzip()) as Readable), crlfDelay: Infinity });
  for await (const line of rl) {
    if (line) {
      yield JSON.parse(line) as Record<string, unknown>;
    }
  }
}

/** Parses a whole backup file into memory (tests, small backups; restore streams with `backupLines`). */
export async function readBackup(file: string, passphrase?: string): Promise<{ header: BackupHeader; events: Map<string, EventEnvelope[]>; bases: Map<string, { cut: number; events: EventEnvelope[] }>; blobs: { sha: string; data: Buffer }[] }> {
  let header: BackupHeader | undefined;
  const events = new Map<string, EventEnvelope[]>();
  const bases = new Map<string, { cut: number; events: EventEnvelope[] }>();
  const blobs: { sha: string; data: Buffer }[] = [];
  for await (const x of backupLines(file, passphrase)) {
    if (!header) {
      header = x as unknown as BackupHeader;
      if (header.kind !== 'header' || header.v !== 1) {
        throw new Error('Not a LocalPilot backup');
      }
      continue;
    }
    if (x.kind === 'blob') {
      blobs.push({ sha: String(x.sha), data: Buffer.from(String(x.b64), 'base64') });
    } else if (x.kind === 'base') {
      bases.set(String(x.stream), { cut: Number(x.cut), events: x.events as EventEnvelope[] });
    } else {
      const e = x as unknown as EventEnvelope;
      (events.get(e.stream) ?? events.set(e.stream, []).get(e.stream)!).push(e);
    }
  }
  if (!header) {
    throw new Error('Not a LocalPilot backup');
  }
  return { header, events, bases, blobs };
}

/** Merges a backup into the data root, reading it as a stream (events imported in batches per stream). */
export async function restoreBackup(o: { log: FileEventLog; blobs: BlobStore; file: string; passphrase?: string }): Promise<RestoreResult> {
  const r: RestoreResult = { streams: 0, imported: 0, skipped: 0, blobs: 0, refused: [] };
  const seen = new Set<string>();
  const refused = new Set<string>();
  let batch: EventEnvelope[] = [];
  let batchStream = '';
  const note = (stream: string) => {
    if (!seen.has(stream)) {
      seen.add(stream);
      r.streams++;
    }
  };
  const flush = async () => {
    if (!batch.length) {
      return;
    }
    const events = batch;
    const stream = batchStream;
    batch = [];
    if (refused.has(stream)) {
      r.skipped += events.length;
      return;
    }
    try {
      const x = await o.log.importRemote(stream, events);
      r.imported += x.imported;
      r.skipped += x.skipped;
    } catch (e) {
      r.skipped += events.length;
      refused.add(stream);
      r.refused.push({ stream, reason: e instanceof Error ? e.message : String(e) });
    }
  };
  let first = true;
  for await (const x of backupLines(o.file, o.passphrase)) {
    if (first) {
      first = false;
      if (x.kind !== 'header' || x.v !== 1) {
        throw new Error('Not a LocalPilot backup');
      }
      continue;
    }
    if (x.kind === 'blob') {
      await flush();
      const sha = String(x.sha);
      if (!o.blobs.has(sha)) {
        o.blobs.put(Buffer.from(String(x.b64), 'base64'));
        r.blobs++;
      }
    } else if (x.kind === 'base') {
      await flush();
      note(String(x.stream));
      o.log.importBase(String(x.stream), Number(x.cut), x.events as EventEnvelope[]);
    } else {
      const e = x as unknown as EventEnvelope;
      if (e.stream !== batchStream || batch.length >= 5000) {
        await flush();
        batchStream = e.stream;
      }
      note(e.stream);
      batch.push(e);
    }
  }
  await flush();
  if (first) {
    throw new Error('Not a LocalPilot backup');
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
