// The append-only event log (design §5.2–5.4). One data root per machine; each writing process owns one stream
// (`<deviceId>.<n>`, claimed with a lease) and appends to it; streams of other processes and devices are read-only here
// (`importRemote` adds to local copies of remote streams for sync and backup restore). Pure Node: no vscode.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { EntityKind, EventEnvelope, EventLoc, MAX_LINE_BYTES, Op, SCHEMA_VERSIONS, validateEnvelope } from '../events';
import { Hlc } from '../hlc';
import { newId } from '../ids';
import { Lease, leaseIsFree } from './lease';
import { lastEvent, listSegments, readEventAt, readStreamDir, repairTail, SEGMENT_MAX_AGE_MS, SEGMENT_MAX_BYTES, segmentFile } from './segment';

export interface DeviceInfo {
  v: 1;
  deviceId: string;
  name: string;
  platform: string;
  createdAt: number;
}

export interface StreamInfo {
  id: string;
  device: string;
  lastSeq: number;
  own: boolean;
}

export interface AppendOptions {
  base?: string;
  cause?: string;
  /** Written and fdatasync'ed right away (message finalised, run start/end, trash, purge, conflict resolution). */
  durable?: boolean;
  /** Never synced (drafts, local diagnostics). */
  local?: boolean;
}

export interface LogLike {
  info(m: string): void;
  warn(m: string): void;
  error(m: string): void;
}

/** A tiny event emitter shaped like vscode.Event, without vscode. */
export type Listener<T> = (v: T) => void;
export interface Subscribable<T> {
  (listener: Listener<T>): { dispose(): void };
}
export class Emitter<T> {
  private listeners = new Set<Listener<T>>();
  readonly event: Subscribable<T> = (l) => {
    this.listeners.add(l);
    return { dispose: () => this.listeners.delete(l) };
  };
  fire(v: T): void {
    for (const l of [...this.listeners]) {
      try {
        l(v);
      } catch {
        // a listener's failure is its own
      }
    }
  }
  dispose(): void {
    this.listeners.clear();
  }
}

export interface EventLog {
  readonly root: string;
  readonly device: DeviceInfo;
  readonly stream: string;
  append(ent: EntityKind, eid: string, op: Op, p: object, o?: AppendOptions): EventEnvelope;
  flush(): Promise<void>;
  read(stream: string, fromSeq?: number): AsyncIterable<EventEnvelope>;
  readAt(loc: EventLoc): Promise<EventEnvelope>;
  streams(): Promise<StreamInfo[]>;
  onAppend: Subscribable<EventEnvelope[]>;
  importRemote(stream: string, events: EventEnvelope[]): Promise<{ imported: number; skipped: number }>;
  observeHlc(hlc: string): { skewMs?: number };
  dispose(): Promise<void>;
}

export interface OpenLogOptions {
  root: string;
  writer: 'vscode' | 'cli';
  log?: LogLike;
  now?: () => number;
  /** Device name for a new device.json (default: host name). */
  deviceName?: string;
  /** Tests: shorter buffering, other host/pid. */
  flushMs?: number;
  host?: string;
  pid?: number;
  segmentMaxBytes?: number;
}

/** A process-wide lock for `importRemote` into a stream nobody owns. */
const importing = new Set<string>();

const noLog: LogLike = { info: () => undefined, warn: () => undefined, error: () => undefined };

/** Reads (or creates, exclusively) the data root's device identity. Throws when the file exists but is corrupt. */
export function readOrCreateDevice(root: string, name?: string, now = Date.now): DeviceInfo {
  const file = path.join(root, 'device.json');
  fs.mkdirSync(root, { recursive: true });
  const read = (): DeviceInfo | undefined => {
    let raw: string;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch {
      return undefined;
    }
    const d = JSON.parse(raw) as DeviceInfo;
    if (d?.v !== 1 || typeof d.deviceId !== 'string' || !/^dev_[\w-]+$/.test(d.deviceId)) {
      throw new Error(`device.json in ${root} is not a LocalPilot device file`);
    }
    return d;
  };
  const existing = read();
  if (existing) {
    return existing;
  }
  const d: DeviceInfo = { v: 1, deviceId: newId('dev', now()), name: name || os.hostname(), platform: `${process.platform}-${process.arch}`, createdAt: now() };
  try {
    fs.writeFileSync(file, `${JSON.stringify(d, null, 2)}\n`, { flag: 'wx' });
    return d;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') {
      // Another process created it first: use theirs.
      const theirs = read();
      if (theirs) {
        return theirs;
      }
    }
    throw e;
  }
}

interface Pending {
  line: string;
  segment: number;
  e: EventEnvelope;
}

export class FileEventLog implements EventLog {
  readonly device: DeviceInfo;
  readonly stream: string;
  private readonly streamsDir: string;
  private readonly ownDir: string;
  private readonly lease: Lease;
  private readonly hlc: Hlc;
  private readonly now: () => number;
  private readonly log: LogLike;
  private readonly flushMs: number;
  private readonly maxBytes: number;
  private lastSeq = 0;
  private activeSegment = 0;
  private activeSize = 0;
  private activeOpenedAt = 0;
  private pending: Pending[] = [];
  private pendingDurable = false;
  private timer?: NodeJS.Timeout;
  private chain: Promise<void> = Promise.resolve();
  private disposed = false;
  private readonly emitter = new Emitter<EventEnvelope[]>();
  readonly onAppend = this.emitter.event;
  /** Events dropped by crash repair when the stream was opened (bytes). */
  readonly repairedBytes: number;
  private readonly exitHook = () => this.flushSync();

  private constructor(readonly root: string, o: OpenLogOptions, device: DeviceInfo, stream: string, lease: Lease) {
    this.device = device;
    this.stream = stream;
    this.lease = lease;
    this.now = o.now ?? Date.now;
    this.log = o.log ?? noLog;
    this.flushMs = o.flushMs ?? 250;
    this.maxBytes = o.segmentMaxBytes ?? SEGMENT_MAX_BYTES;
    this.streamsDir = path.join(root, 'streams');
    this.ownDir = path.join(this.streamsDir, stream);
    this.hlc = new Hlc(device.deviceId, this.now);
    // Crash repair + where to continue.
    const files = listSegments(this.ownDir).filter((f) => !f.compact);
    const active = files[files.length - 1];
    let repaired = 0;
    if (active) {
      const r = repairTail(active.file);
      repaired = r.dropped;
      if (r.dropped) {
        this.log.warn(`continuity: repaired stream ${stream}: dropped ${r.dropped} byte(s) of a torn last line`);
      }
      this.activeSegment = active.segment;
      this.activeSize = r.size;
      this.activeOpenedAt = fs.statSync(active.file).birthtimeMs || fs.statSync(active.file).mtimeMs;
      let last = r.last;
      // An active segment emptied by repair: continue after the previous one.
      for (let i = files.length - 2; !last && i >= 0; i--) {
        last = lastEvent(files[i].file);
      }
      if (last) {
        this.lastSeq = last.seq;
        this.hlc.observe(last.hlc);
      }
      if (!r.size && !last) {
        this.activeSegment = 0;
      }
    }
    const base = listSegments(this.ownDir).find((f) => f.compact);
    if (base && -base.segment > this.lastSeq) {
      this.lastSeq = -base.segment;
    }
    this.repairedBytes = repaired;
    // Stay ahead of every stamp already on this machine (other processes' streams).
    for (const s of safeReaddir(this.streamsDir)) {
      if (s !== stream) {
        const segs = listSegments(path.join(this.streamsDir, s)).filter((f) => !f.compact);
        const last = segs.length ? lastEvent(segs[segs.length - 1].file) : undefined;
        if (last) {
          this.hlc.observe(last.hlc);
        }
      }
    }
    process.once('exit', this.exitHook);
  }

  /**
   * Opens the data root: device identity, a stream of our own (the lowest free `<deviceId>.<n>`), crash repair of
   * its active segment. Synchronous file work only (activation budget). Throws when the root is unusable.
   */
  static open(o: OpenLogOptions): FileEventLog {
    const root = path.resolve(o.root);
    const device = readOrCreateDevice(root, o.deviceName, o.now);
    const streamsDir = path.join(root, 'streams');
    fs.mkdirSync(streamsDir, { recursive: true });
    for (let n = 1; n < 1000; n++) {
      const id = `${device.deviceId}.${n}`;
      const dir = path.join(streamsDir, id);
      const leaseFile = path.join(dir, 'lease.json');
      if (fs.existsSync(dir) && !leaseIsFree(leaseFile, { now: o.now, host: o.host })) {
        continue;
      }
      fs.mkdirSync(dir, { recursive: true });
      const lease = new Lease(leaseFile, { kind: o.writer, now: o.now, host: o.host, pid: o.pid });
      if (lease.tryClaim()) {
        return new FileEventLog(root, o, device, id, lease);
      }
    }
    throw new Error('no free log stream (999 streams are in use)');
  }

  append(ent: EntityKind, eid: string, op: Op, p: object, o: AppendOptions = {}): EventEnvelope {
    if (this.disposed) {
      throw new Error('event log is closed');
    }
    const seq = this.lastSeq + 1;
    const e: EventEnvelope = {
      v: 1,
      id: `${this.stream}:${seq}`,
      stream: this.stream,
      seq,
      hlc: this.hlc.tick(),
      dev: this.device.deviceId,
      ent,
      eid,
      op,
      sv: SCHEMA_VERSIONS[ent] ?? 1,
      p: p as Record<string, unknown>,
      ...(o.base ? { base: o.base } : {}),
      ...(o.cause ? { cause: o.cause } : {}),
      ...(o.local ? { local: true as const } : {}),
    };
    const bad = validateEnvelope(e);
    if (bad) {
      throw new Error(`invalid event: ${bad}`);
    }
    const line = JSON.stringify(e);
    const bytes = Buffer.byteLength(line) + 1;
    if (bytes - 1 > MAX_LINE_BYTES) {
      throw new Error(`event too large (${bytes} bytes); put big payloads in blobs`);
    }
    this.lastSeq = seq;
    // Rotation is decided here so every event's location is known at once.
    const now = this.now();
    if (!this.activeSegment || (this.activeSize > 0 && (this.activeSize + bytes > this.maxBytes || now - this.activeOpenedAt > SEGMENT_MAX_AGE_MS))) {
      this.activeSegment = seq;
      this.activeSize = 0;
      this.activeOpenedAt = now;
    }
    this.pending.push({ line, segment: this.activeSegment, e });
    locs.set(e, { stream: this.stream, segment: this.activeSegment, offset: this.activeSize, length: bytes - 1 });
    this.activeSize += bytes;
    if (o.durable) {
      this.pendingDurable = true;
      void this.flush();
    } else if (!this.timer) {
      this.timer = setTimeout(() => {
        this.timer = undefined;
        void this.flush();
      }, this.flushMs);
      this.timer.unref?.();
    }
    return e;
  }

  /** Location of an event appended by this process (known at append time). */
  locOf(e: EventEnvelope): EventLoc | undefined {
    return locs.get(e);
  }

  get lastSequence(): number {
    return this.lastSeq;
  }

  flush(): Promise<void> {
    this.chain = this.chain.then(() => this.writeOut()).catch((err) => this.log.error(`continuity: log write failed: ${String(err)}`));
    return this.chain;
  }

  private async writeOut(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    const batch = this.pending;
    const durable = this.pendingDurable;
    this.pending = [];
    this.pendingDurable = false;
    if (!batch.length) {
      return;
    }
    const groups = new Map<number, string[]>();
    for (const b of batch) {
      (groups.get(b.segment) ?? groups.set(b.segment, []).get(b.segment)!).push(b.line);
    }
    for (const [segment, lines] of groups) {
      const fh = await fs.promises.open(segmentFile(this.ownDir, segment), 'a');
      try {
        await fh.write(`${lines.join('\n')}\n`);
        if (durable) {
          await fh.datasync().catch(() => undefined);
        }
      } finally {
        await fh.close();
      }
    }
    this.emitter.fire(batch.map((b) => b.e));
  }

  /** Last-chance synchronous write (process exit). */
  flushSync(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    const batch = this.pending;
    this.pending = [];
    for (const b of batch) {
      try {
        fs.appendFileSync(segmentFile(this.ownDir, b.segment), `${b.line}\n`);
      } catch {
        // nothing more can be done at exit
      }
    }
  }

  async *read(stream: string, fromSeq = 1): AsyncIterable<EventEnvelope> {
    if (stream === this.stream) {
      await this.flush();
    }
    for (const { e } of readStreamDir(path.join(this.streamsDir, stream), fromSeq)) {
      yield e;
    }
  }

  /** Like `read`, with each event's location (index catch-up, materialisation). */
  *readWithLoc(stream: string, fromSeq = 1): Generator<{ e: EventEnvelope; loc: EventLoc }> {
    yield* readStreamDir(path.join(this.streamsDir, stream), fromSeq);
  }

  async readAt(loc: EventLoc): Promise<EventEnvelope> {
    if (loc.stream === this.stream && this.pending.length) {
      await this.flush();
    }
    return readEventAt(this.root, loc);
  }

  async streams(): Promise<StreamInfo[]> {
    await this.flush();
    return safeReaddir(this.streamsDir).filter((s) => /^dev_[\w-]+\.\d+$/.test(s)).map((id) => ({
      id,
      device: id.slice(0, id.lastIndexOf('.')),
      lastSeq: id === this.stream ? this.lastSeq : streamLastSeq(path.join(this.streamsDir, id)),
      own: id === this.stream,
    }));
  }

  /**
   * Appends events of a stream this process does not write (sync pull, backup restore). Events at or below the local
   * copy's last seq are skipped (dedup); the rest must continue it without a gap. Streams owned by a live writer on
   * this machine are refused.
   */
  async importRemote(stream: string, events: EventEnvelope[]): Promise<{ imported: number; skipped: number }> {
    if (!/^dev_[\w-]+\.\d+$/.test(stream)) {
      throw new Error(`not a stream id: ${stream}`);
    }
    if (stream === this.stream) {
      // Our own stream: only events we already have can arrive here (restore of a backup of this device).
      await this.flush();
      const ahead = events.filter((e) => e.seq > this.lastSeq);
      if (ahead.length) {
        throw new Error(`stream ${stream} is written by this process; ${ahead.length} newer event(s) cannot be imported into it`);
      }
      return { imported: 0, skipped: events.length };
    }
    const dir = path.join(this.streamsDir, stream);
    if (fs.existsSync(path.join(dir, 'lease.json')) && !leaseIsFree(path.join(dir, 'lease.json'))) {
      throw new Error(`stream ${stream} is being written by another process on this machine`);
    }
    if (importing.has(dir)) {
      throw new Error(`stream ${stream} is being imported already`);
    }
    importing.add(dir);
    try {
      fs.mkdirSync(dir, { recursive: true });
      const files = listSegments(dir);
      const segs = files.filter((f) => !f.compact);
      const active = segs[segs.length - 1];
      let last = active ? repairTail(active.file).last : undefined;
      for (let i = segs.length - 2; !last && i >= 0; i--) {
        last = lastEvent(segs[i].file);
      }
      const base = files.find((f) => f.compact);
      let lastSeq = Math.max(last?.seq ?? 0, base ? -base.segment : 0);
      const sorted = [...events].sort((a, b) => a.seq - b.seq);
      const fresh = sorted.filter((e) => e.seq > lastSeq);
      for (const e of fresh) {
        const bad = validateEnvelope(e);
        if (bad || e.stream !== stream) {
          throw new Error(`invalid event ${e?.id}: ${bad ?? 'wrong stream'}`);
        }
        if (e.seq !== lastSeq + 1) {
          throw new Error(`gap in stream ${stream}: expected seq ${lastSeq + 1}, got ${e.seq}`);
        }
        lastSeq = e.seq;
      }
      if (fresh.length) {
        let segment = active?.segment ?? fresh[0].seq;
        let size = active ? fs.statSync(active.file).size : 0;
        let buf: string[] = [];
        const write = () => {
          if (buf.length) {
            fs.appendFileSync(segmentFile(dir, segment), `${buf.join('\n')}\n`);
            buf = [];
          }
        };
        for (const e of fresh) {
          const line = JSON.stringify(e);
          const bytes = Buffer.byteLength(line) + 1;
          if (size > 0 && size + bytes > this.maxBytes) {
            write();
            segment = e.seq;
            size = 0;
          }
          buf.push(line);
          size += bytes;
          this.hlc.observe(e.hlc);
        }
        write();
        const fd = fs.openSync(segmentFile(dir, segment), 'r');
        try {
          fs.fdatasyncSync(fd);
        } catch {
          // best effort
        } finally {
          fs.closeSync(fd);
        }
      }
      return { imported: fresh.length, skipped: events.length - fresh.length };
    } finally {
      importing.delete(dir);
    }
  }

  /**
   * Installs a compacted base of a stream this process does not write (backup restore, sync of a new device): only when
   * the local copy has nothing beyond the base yet. Local segments the base covers are removed.
   */
  importBase(stream: string, cut: number, events: EventEnvelope[]): boolean {
    if (stream === this.stream || !/^dev_[\w-]+\.\d+$/.test(stream)) {
      return false;
    }
    const dir = path.join(this.streamsDir, stream);
    if (fs.existsSync(path.join(dir, 'lease.json')) && !leaseIsFree(path.join(dir, 'lease.json'))) {
      return false;
    }
    if (streamLastSeq(dir) >= cut) {
      return false;
    }
    fs.mkdirSync(dir, { recursive: true });
    const target = path.join(dir, `compact-${String(cut).padStart(12, '0')}.jsonl`);
    const tmp = `${target}.tmp-${process.pid}`;
    // The base is in place before the segments it covers go: a crash in between leaves both, never neither.
    const old = listSegments(dir).filter((f) => path.resolve(f.file) !== path.resolve(target));
    fs.writeFileSync(tmp, events.map((e) => JSON.stringify(e)).join('\n') + (events.length ? '\n' : ''));
    fs.renameSync(tmp, target);
    for (const f of old) {
      fs.rmSync(f.file, { force: true });
    }
    for (const e of events) {
      this.hlc.observe(e.hlc);
    }
    return true;
  }

  observeHlc(hlc: string): { skewMs?: number } {
    return this.hlc.observe(hlc);
  }

  /** The highest stamp this process has issued or observed. */
  peekHlc(): string {
    return this.hlc.peek();
  }

  /** Physical size of this stream's files and how many segments it has. */
  ownSegments(): string[] {
    return listSegments(this.ownDir).map((f) => f.file);
  }

  get ownStreamDir(): string {
    return this.ownDir;
  }

  async dispose(): Promise<void> {
    if (this.disposed) {
      return;
    }
    await this.flush();
    this.disposed = true;
    process.removeListener('exit', this.exitHook);
    this.lease.release();
    this.emitter.dispose();
  }
}

const locs = new WeakMap<EventEnvelope, EventLoc>();

function safeReaddir(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

/** Last seq of a stream folder (its newest event, or the end of its compacted base). */
export function streamLastSeq(dir: string): number {
  const files = listSegments(dir);
  const segs = files.filter((f) => !f.compact);
  for (let i = segs.length - 1; i >= 0; i--) {
    const last = lastEvent(segs[i].file);
    if (last) {
      return last.seq;
    }
  }
  const base = files.find((f) => f.compact);
  return base ? -base.segment : 0;
}
