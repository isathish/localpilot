// Per-stream compaction and redaction (design §5.6, §26). A stream is compacted by whoever holds its lease: the owner
// (this process's own stream), or any process for a stream nobody writes (another process's stream after it ended, a
// local copy of another device's stream), under that stream's lease so no writer, import or second compaction runs
// at the same time. Sealed segments older than `historyDays` are replaced by `compact-<lastSeq>.jsonl`: one `create`
// per entity with its reduced fields as of the cut (each field's original HLC in `p.__clocks`), tombstones for purged
// entities, nothing for purged entities of other streams or the children of purged conversations, nothing for run
// details (execution events, context snapshots, model sessions) whose last change is older than the window. Events
// this build cannot apply (an unknown kind, op or a newer schema written by a newer LocalPilot) are kept as they are.
// Version history older than the window is lost by design.
// Redaction rewrites the lines of purged entities in place, padded to the same length, so every event location the
// index holds stays valid. It reaches every local stream that no live process writes (own, ended processes', other
// devices' copies, compacted bases); a stream another live process writes is redacted by that process at its next
// retention pass (it sees the purge through the index), and backups leave purged content out on their own. Pure Node.
import * as fs from 'fs';
import * as path from 'path';
import { EventEnvelope, isKnown, isWithheld } from '../events';
import { Hlc } from '../hlc';
import { FileEventLog, withStreamLease } from './eventLog';
import { leaseIsFree } from './lease';
import { DEFAULT_RULES, EntityState, noteEdit, reduce } from './reducer';
import { compactName, listSegments, readSegmentLines } from './segment';

export interface CompactionResult {
  segments: number;
  events: number;
  entities: number;
  cut?: number;
}

const DAY = 86_400_000;

/** Run details pruned with the history window (their run, checkpoints and the chat stay). */
export const RUN_DETAIL_KINDS: ReadonlySet<string> = new Set(['execution_event', 'context_snapshot', 'model_session']);

export interface CompactOptions {
  historyDays: number;
  now?: () => number;
  /** Entities purged anywhere (the index knows them): left out with their conversations' children. */
  purged?: ReadonlySet<string>;
  /** The newest segment too (a stream nobody writes any more). */
  includeActive?: boolean;
}

/** Compacts this process's stream. Call after `log.flush()`; the index must be rebuilt when `segments > 0`. */
export function compactOwnStream(log: FileEventLog, o: CompactOptions): CompactionResult {
  return compactStreamDir(log.ownStreamDir, log.stream, log.device.deviceId, { ...o, includeActive: false });
}

/** Compacts one stream folder; the caller writes it or holds its lease. */
export function compactStreamDir(dir: string, stream: string, device: string, o: CompactOptions): CompactionResult {
  const now = (o.now ?? Date.now)();
  const files = listSegments(dir);
  const base = files.find((f) => f.compact);
  const segs = files.filter((f) => !f.compact);
  const sealed = o.includeActive ? segs : segs.slice(0, -1); // the newest segment is the active one
  const cutoff = now - o.historyDays * DAY;
  const covered = base ? -base.segment : 0;
  const take: typeof sealed = [];
  let cut = 0;
  for (const s of sealed) {
    const lines = readSegmentLines(s.file);
    const last = lines[lines.length - 1];
    if (!last || Hlc.physical(last.e.hlc) >= cutoff) {
      break;
    }
    take.push(s);
    cut = Math.max(cut, last.e.seq);
  }
  if (!take.length || cut <= covered) {
    return { segments: 0, events: 0, entities: 0 };
  }
  const states = new Map<string, EntityState>();
  const kept: EventEnvelope[] = [];
  let events = 0;
  const input = [...(base ? readSegmentLines(base.file).map((r) => r.e) : []), ...take.flatMap((s) => readSegmentLines(s.file).map((r) => r.e).filter((e) => e.seq > covered))];
  for (const e of input) {
    events++;
    if (!isKnown(e) && !isWithheld(e)) {
      kept.push(e); // a newer LocalPilot's event: carried as it is
      continue;
    }
    states.set(e.eid, reduce(states.get(e.eid), e, DEFAULT_RULES).state);
    const conv = (e.p as { conversationId?: unknown }).conversationId;
    if (e.ent === 'message' && e.op === 'create' && typeof conv === 'string') {
      states.set(conv, noteEdit(states.get(conv), conv, e).state);
    }
  }
  const purgedConvs = new Set([...states.values()].filter((s) => s.purged && s.ent === 'conversation').map((s) => s.id));
  const elsewhere = o.purged ?? new Set<string>();
  const out: EventEnvelope[] = [...kept];
  const sorted = [...states.values()].sort((a, b) => (a.version < b.version ? -1 : a.version > b.version ? 1 : 0));
  for (const s of sorted) {
    if (!s.version) {
      continue;
    }
    const conv = s.fields.conversationId;
    if (!s.purged && ((typeof conv === 'string' && (purgedConvs.has(conv) || elsewhere.has(conv))) || elsewhere.has(s.id))) {
      continue; // redacted with its conversation (or purged by another stream)
    }
    if (!s.purged && RUN_DETAIL_KINDS.has(s.ent) && Hlc.physical(s.version) < cutoff) {
      continue; // run details older than the window
    }
    const env = {
      v: 1 as const,
      id: `${stream}:${cut}.${out.length}`,
      stream,
      seq: cut,
      hlc: s.purged ?? s.version,
      dev: device,
      ent: s.ent,
      eid: s.id,
      sv: 1,
    };
    if (s.purged) {
      out.push({ ...env, op: 'purge', p: { at: Hlc.physical(s.purged) } });
      continue;
    }
    const p: Record<string, unknown> = { ...s.fields, __clocks: s.clocks };
    if (s.bases) {
      p.__bases = s.bases;
    }
    if (s.edits?.length) {
      p.__edits = s.edits;
    }
    if (s.clocks.trashedAt && s.fields.trashedAt === undefined) {
      p.trashedAt = null; // restored: keep the register's clock
    }
    out.push({ ...env, op: 'create', p });
  }
  const target = path.join(dir, compactName(cut));
  const tmp = `${target}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, out.map((e) => JSON.stringify(e)).join('\n') + (out.length ? '\n' : ''));
  fs.renameSync(tmp, target);
  // The base is in place before what it covers goes: a crash in between leaves both (readers skip the overlap).
  for (const s of take) {
    fs.rmSync(s.file, { force: true });
  }
  if (base && base.file !== target) {
    fs.rmSync(base.file, { force: true });
  }
  return { segments: take.length, events, entities: out.length, cut };
}

/**
 * Compacts the local streams nobody writes (streams of processes that ended, local copies of other devices' streams),
 * each under its lease. Streams with a live writer are left to their owner. Returns the number of segments folded.
 */
export function compactOtherStreams(log: FileEventLog, o: Omit<CompactOptions, 'includeActive'>): { streams: number; segments: number } {
  const dir = path.join(log.root, 'streams');
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter((s) => /^dev_[\w-]+\.\d+$/.test(s) && s !== log.stream);
  } catch {
    return { streams: 0, segments: 0 };
  }
  let streams = 0;
  let segments = 0;
  for (const s of names) {
    const sdir = path.join(dir, s);
    if (fs.existsSync(path.join(sdir, 'lease.json')) && !leaseIsFree(path.join(sdir, 'lease.json'))) {
      continue;
    }
    const r = withStreamLease(sdir, 'compact', () => compactStreamDir(sdir, s, s.slice(0, s.lastIndexOf('.')), { ...o, includeActive: true }));
    if (r?.segments) {
      streams++;
      segments += r.segments;
    }
  }
  return { streams, segments };
}

/** Whether an event belongs to one of the purged entities (itself, or a child of a purged conversation). */
function hits(e: EventEnvelope, ids: ReadonlySet<string>): boolean {
  return e.op !== 'purge' && !(e.p as { redacted?: boolean }).redacted && (ids.has(e.eid) || ids.has(String((e.p as { conversationId?: unknown }).conversationId ?? '')));
}

/** Redacts the purged entities' lines in every file of one stream folder (the caller writes it or holds its lease). */
export function redactStreamDir(dir: string, ids: ReadonlySet<string>): number {
  let redacted = 0;
  for (const s of listSegments(dir)) {
    const lines = readSegmentLines(s.file);
    const found = lines.filter((r) => hits(r.e, ids));
    if (!found.length) {
      continue;
    }
    const fd = fs.openSync(s.file, 'r+');
    try {
      for (const r of found) {
        const slim = JSON.stringify({ ...r.e, p: { redacted: true } });
        const bytes = Buffer.byteLength(slim);
        if (bytes > r.length) {
          continue;
        }
        fs.writeSync(fd, Buffer.from(slim + ' '.repeat(r.length - bytes), 'utf8'), 0, r.length, r.offset);
        redacted++;
      }
      fs.fdatasyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  }
  return redacted;
}

/**
 * Redacts, in this process's own segments, every event of the given entities and of their conversations' children
 * (messages, branches, attachments, runs…), except the purge events themselves. Lines keep their byte length.
 */
export async function redactOwnStream(log: FileEventLog, ids: ReadonlySet<string>): Promise<number> {
  if (!ids.size) {
    return 0;
  }
  await log.flush();
  return redactStreamDir(log.ownStreamDir, ids);
}

/**
 * Redacts the purged entities in every local stream: this process's own, and every other one no live process writes
 * (under its lease). Streams a live process writes are listed in `deferred`: their owner redacts them at its next
 * retention pass.
 */
export async function redactEverywhere(log: FileEventLog, ids: ReadonlySet<string>): Promise<{ redacted: number; deferred: string[] }> {
  if (!ids.size) {
    return { redacted: 0, deferred: [] };
  }
  let redacted = await redactOwnStream(log, ids);
  const deferred: string[] = [];
  const dir = path.join(log.root, 'streams');
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter((s) => /^dev_[\w-]+\.\d+$/.test(s) && s !== log.stream);
  } catch {
    names = [];
  }
  for (const s of names) {
    const sdir = path.join(dir, s);
    const n = withStreamLease(sdir, 'redact', () => redactStreamDir(sdir, ids));
    if (n === undefined) {
      deferred.push(s);
    } else {
      redacted += n;
    }
  }
  return { redacted, deferred };
}
