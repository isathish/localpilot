import { ChatMessage } from '../types';

/**
 * The full transcript survives compaction in a sidecar `<sessionId>.archive.jsonl`: one line per message, numbered
 * in conversation order. Every message present when a compaction runs is archived once (`meta.archived` holds its
 * number, and copies of it carry the mark), so the archive plus the messages added since is the whole conversation.
 * Rewinding to a message from before a compaction rebuilds the history from the archive instead of the summary.
 */
export interface ArchiveRecord {
  seq: number;
  /** Which compaction of the session archived it (`session.compactions` at the time). */
  compaction: number;
  at: number;
  message: ChatMessage;
}

/** Where compacted-away messages go (the SessionStore); absent = nothing is archived. */
export interface TranscriptArchive {
  /** Appends `messages` and marks each with its archive number (`meta.archived`). */
  archive(id: string, messages: ChatMessage[], opts: { compactionIndex: number }): void;
}

/** The messages of `before` that a compaction to `after` must archive: everything not archived yet, summaries aside. */
export function messagesToArchive(before: ChatMessage[]): ChatMessage[] {
  return before.filter((m) => !m.meta?.summary && m.meta?.archived === undefined);
}

/**
 * Copies archive marks from `before` onto `after`, whose messages are `before`'s (the same objects, or pruned copies
 * made during compaction) behind the new summary. Walks both from the end: the verbatim window lines up index for
 * index, and a message that kept its identity (the request a mid-turn split preserves) is found by reference.
 */
export function carryArchiveMarks(before: ChatMessage[], after: ChatMessage[]): void {
  let j = before.length - 1;
  for (let i = after.length - 1; i >= 0 && j >= 0; i--) {
    const m = after[i];
    if (m.meta?.summary) {
      continue;
    }
    const same = before.lastIndexOf(m, j);
    const k = same >= 0 ? same : j;
    const seq = before[k].meta?.archived;
    if (seq !== undefined && m.meta?.archived === undefined) {
      m.meta = { ...m.meta, archived: seq };
    }
    j = k - 1;
  }
}

/** Archives what a compaction replaced and carries the marks over; call before `session.messages = after`. */
export function archiveCompaction(store: TranscriptArchive | undefined, sessionId: string, compactionIndex: number, before: ChatMessage[], after: ChatMessage[]): void {
  if (!store) {
    return;
  }
  const fresh = messagesToArchive(before);
  if (fresh.length) {
    store.archive(sessionId, fresh, { compactionIndex });
  }
  carryArchiveMarks(before, after);
}

/**
 * The original conversation before archived message `seq`, or undefined when the archive cannot supply it (missing,
 * or a gap in the numbering — then the summary is the best there is).
 */
export function rebuildBefore(records: ArchiveRecord[], seq: number): ChatMessage[] | undefined {
  const sorted = [...records].sort((a, b) => a.seq - b.seq);
  const before = sorted.filter((r) => r.seq < seq);
  if (!sorted.some((r) => r.seq === seq) || before.some((r, i) => r.seq !== i)) {
    return undefined;
  }
  return before.map((r) => r.message);
}

/** Parses an archive file; corrupt lines (a crash mid-append) are skipped. */
export function parseArchive(text: string): ArchiveRecord[] {
  const out: ArchiveRecord[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) {
      continue;
    }
    try {
      const r = JSON.parse(line) as ArchiveRecord;
      if (typeof r?.seq === 'number' && r.message && typeof r.message.role === 'string') {
        out.push(r);
      }
    } catch {
      /* torn line */
    }
  }
  return out;
}
