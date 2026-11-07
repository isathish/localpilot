// Segment files of one stream (design §5.2–5.3): `<first seq, 12 digits>.jsonl`, one event per line, the highest-
// numbered file is the active one; `compact-<last seq>.jsonl` is an optional compacted base covering seq 1..last.
// Readers work from any process (the index worker reads streams it does not own). Pure Node, synchronous.
import * as fs from 'fs';
import * as path from 'path';
import { EventEnvelope, EventLoc, validateEnvelope } from '../events';

export const SEGMENT_MAX_BYTES = 8 * 1024 * 1024;
export const SEGMENT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export const pad12 = (n: number): string => String(n).padStart(12, '0');
export const segmentName = (first: number): string => `${pad12(first)}.jsonl`;
export const compactName = (last: number): string => `compact-${pad12(last)}.jsonl`;

export interface SegmentFile {
  /** First seq for a segment; for a compacted base, the negated last seq it covers (see `EventLoc.segment`). */
  segment: number;
  file: string;
  compact: boolean;
}

/** Files of a stream folder in read order: the newest compacted base, then the segments after it. */
export function listSegments(dir: string): SegmentFile[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  let base: SegmentFile | undefined;
  const segs: SegmentFile[] = [];
  for (const n of names) {
    let m = /^(\d{12})\.jsonl$/.exec(n);
    if (m) {
      segs.push({ segment: Number(m[1]), file: path.join(dir, n), compact: false });
      continue;
    }
    m = /^compact-(\d{12})\.jsonl$/.exec(n);
    if (m && (!base || Number(m[1]) > -base.segment)) {
      base = { segment: -Number(m[1]), file: path.join(dir, n), compact: true };
    }
  }
  segs.sort((a, b) => a.segment - b.segment);
  const covered = base ? -base.segment : 0;
  // A segment whose events all lie inside the base (its successor starts at or below the cut) is superseded.
  const live = segs.filter((s, i) => {
    const next = segs[i + 1];
    return !(base && next && next.segment <= covered + 1);
  });
  return base ? [base, ...live] : live;
}

/** The file an event location points into. */
export function segmentFile(streamDir: string, segment: number): string {
  return path.join(streamDir, segment < 0 ? compactName(-segment) : segmentName(segment));
}

export interface LineRecord {
  e: EventEnvelope;
  offset: number;
  length: number;
}

/** Every well-formed event line of a file with its byte range (malformed lines are skipped and counted). */
export function readSegmentLines(file: string, onBad?: (offset: number, reason: string) => void): LineRecord[] {
  let buf: Buffer;
  try {
    buf = fs.readFileSync(file);
  } catch {
    return [];
  }
  const out: LineRecord[] = [];
  let start = 0;
  while (start < buf.length) {
    const nl = buf.indexOf(10, start);
    if (nl < 0) {
      break; // torn last line: ignored by readers, repaired by the owner
    }
    if (nl > start) {
      const text = buf.toString('utf8', start, nl);
      try {
        const e = JSON.parse(text) as EventEnvelope;
        const bad = validateEnvelope(e);
        if (bad) {
          onBad?.(start, bad);
        } else {
          out.push({ e, offset: start, length: nl - start });
        }
      } catch (err) {
        onBad?.(start, String(err));
      }
    }
    start = nl + 1;
  }
  return out;
}

/** Events of a stream folder from `fromSeq` (inclusive) on, with their locations. */
export function* readStreamDir(streamDir: string, fromSeq = 1): Generator<{ e: EventEnvelope; loc: EventLoc }> {
  const stream = path.basename(streamDir);
  const files = listSegments(streamDir);
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    const next = files[i + 1];
    if (f.compact) {
      if (fromSeq > -f.segment) {
        continue;
      }
    } else if (next && !next.compact && next.segment <= fromSeq) {
      continue; // every event of this segment is before fromSeq
    }
    for (const r of readSegmentLines(f.file)) {
      if (r.e.seq >= fromSeq || (f.compact && fromSeq <= -f.segment)) {
        yield { e: r.e, loc: { stream, segment: f.segment, offset: r.offset, length: r.length } };
      }
    }
  }
}

/** Reads one event by location. */
export function readEventAt(root: string, loc: EventLoc): EventEnvelope {
  const file = segmentFile(path.join(root, 'streams', loc.stream), loc.segment);
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(loc.length);
    fs.readSync(fd, buf, 0, loc.length, loc.offset);
    return JSON.parse(buf.toString('utf8')) as EventEnvelope;
  } finally {
    fs.closeSync(fd);
  }
}

/** The last complete, valid event of a file, reading only its tail. */
export function lastEvent(file: string, maxTail = 2 * 1024 * 1024): EventEnvelope | undefined {
  let fd: number;
  try {
    fd = fs.openSync(file, 'r');
  } catch {
    return undefined;
  }
  try {
    const size = fs.fstatSync(fd).size;
    let span = Math.min(size, 64 * 1024);
    for (;;) {
      const buf = Buffer.alloc(span);
      fs.readSync(fd, buf, 0, span, size - span);
      let end = buf.lastIndexOf(10);
      while (end >= 0) {
        const start = buf.lastIndexOf(10, end - 1) + 1;
        if (start === 0 && span < size) {
          break; // the line may begin before the window
        }
        try {
          const e = JSON.parse(buf.toString('utf8', start, end)) as EventEnvelope;
          if (!validateEnvelope(e)) {
            return e;
          }
        } catch {
          // keep looking backwards
        }
        end = start - 1;
      }
      if (span >= size || span >= maxTail) {
        return undefined;
      }
      span = Math.min(size, span * 4, maxTail);
    }
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Crash repair of the active segment (§5.3): a last line without a newline, or one that does not parse, is cut off
 * (`ftruncate` to the last good newline). Returns the file size after repair, the last good event and how many bytes
 * were dropped.
 */
export function repairTail(file: string): { size: number; last?: EventEnvelope; dropped: number } {
  let buf: Buffer;
  try {
    buf = fs.readFileSync(file);
  } catch {
    return { size: 0, dropped: 0 };
  }
  let keep = buf.length;
  let last: EventEnvelope | undefined;
  // Walk back over bad trailing lines.
  for (;;) {
    if (keep === 0) {
      break;
    }
    if (buf[keep - 1] !== 10) {
      keep = buf.lastIndexOf(10, keep - 1) + 1;
      continue;
    }
    const start = keep >= 2 ? buf.lastIndexOf(10, keep - 2) + 1 : 0;
    try {
      const e = JSON.parse(buf.toString('utf8', start, keep - 1)) as EventEnvelope;
      if (!validateEnvelope(e)) {
        last = e;
        break;
      }
    } catch {
      // fall through: drop this line
    }
    keep = start;
  }
  const dropped = buf.length - keep;
  if (dropped > 0) {
    fs.truncateSync(file, keep);
  }
  return { size: keep, last, dropped };
}
