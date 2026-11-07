// Per-stream compaction and redaction (design §5.6). Only this process's own stream is touched (single writer, no
// coordination). Sealed segments older than `historyDays` are replaced by `compact-<lastSeq>.jsonl`: one `create` per
// entity with its reduced fields as of the cut (each field's original HLC in `p.__clocks`), tombstones for purged
// entities, nothing for the children of purged conversations. Version history older than the window is lost by design.
// Redaction rewrites the lines of purged entities in place, padded to the same length, so every event location the
// index holds stays valid. Pure Node.
import * as fs from 'fs';
import * as path from 'path';
import type { EventEnvelope } from '../events';
import { Hlc } from '../hlc';
import type { FileEventLog } from './eventLog';
import { DEFAULT_RULES, EntityState, noteEdit, reduce } from './reducer';
import { compactName, listSegments, readSegmentLines } from './segment';

export interface CompactionResult {
  segments: number;
  events: number;
  entities: number;
  cut?: number;
}

const DAY = 86_400_000;

/** Compacts this process's stream. Call after `log.flush()`; the index must be rebuilt when `segments > 0`. */
export function compactOwnStream(log: FileEventLog, o: { historyDays: number; now?: () => number }): CompactionResult {
  const now = (o.now ?? Date.now)();
  const dir = log.ownStreamDir;
  const files = listSegments(dir);
  const base = files.find((f) => f.compact);
  const segs = files.filter((f) => !f.compact);
  const sealed = segs.slice(0, -1); // the newest segment is the active one
  const cutoff = now - o.historyDays * DAY;
  const take: typeof sealed = [];
  let cut = 0;
  for (const s of sealed) {
    const lines = readSegmentLines(s.file);
    const last = lines[lines.length - 1];
    if (!last || Hlc.physical(last.e.hlc) >= cutoff) {
      break;
    }
    take.push(s);
    cut = last.e.seq;
  }
  if (!take.length) {
    return { segments: 0, events: 0, entities: 0 };
  }
  const states = new Map<string, EntityState>();
  let events = 0;
  const input = [...(base ? readSegmentLines(base.file).map((r) => r.e) : []), ...take.flatMap((s) => readSegmentLines(s.file).map((r) => r.e))];
  for (const e of input) {
    events++;
    states.set(e.eid, reduce(states.get(e.eid), e, DEFAULT_RULES).state);
    const conv = (e.p as { conversationId?: unknown }).conversationId;
    if (e.ent === 'message' && e.op === 'create' && typeof conv === 'string') {
      states.set(conv, noteEdit(states.get(conv), conv, e).state);
    }
  }
  const purgedConvs = new Set([...states.values()].filter((s) => s.purged && s.ent === 'conversation').map((s) => s.id));
  const out: EventEnvelope[] = [];
  const sorted = [...states.values()].sort((a, b) => (a.version < b.version ? -1 : a.version > b.version ? 1 : 0));
  for (const s of sorted) {
    if (!s.version) {
      continue;
    }
    const conv = s.fields.conversationId;
    if (!s.purged && typeof conv === 'string' && purgedConvs.has(conv)) {
      continue; // redacted with its conversation
    }
    const env = {
      v: 1 as const,
      id: `${log.stream}:${cut}.${out.length}`,
      stream: log.stream,
      seq: cut,
      hlc: s.purged ?? s.version,
      dev: log.device.deviceId,
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
  for (const s of take) {
    fs.rmSync(s.file, { force: true });
  }
  if (base && base.file !== target) {
    fs.rmSync(base.file, { force: true });
  }
  return { segments: take.length, events, entities: out.length, cut };
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
  let redacted = 0;
  for (const s of listSegments(log.ownStreamDir)) {
    const lines = readSegmentLines(s.file);
    const hits = lines.filter((r) => r.e.op !== 'purge' && !(r.e.p as { redacted?: boolean }).redacted && (ids.has(r.e.eid) || ids.has(String((r.e.p as { conversationId?: unknown }).conversationId ?? ''))));
    if (!hits.length) {
      continue;
    }
    const fd = fs.openSync(s.file, 'r+');
    try {
      for (const r of hits) {
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
