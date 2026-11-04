// Helpers for the richer telemetry events (task, mention, hook, mcp_call, edit_decision…). Pure Node, so the extension,
// the CLI and the smoke tests share it. Nothing here records a path, a command line or a branch name.
import * as fs from 'fs';
import type { MentionKind, Telemetry, TelemetryInput } from './telemetry';

let recorder: Pick<Telemetry, 'record'> | undefined;

/** Sets the recorder modules without an injected `telemetry` (hooks, MCP, mentions) report to; undefined detaches it. */
export function setTelemetryRecorder(r: Pick<Telemetry, 'record'> | undefined): void {
  recorder = r;
}

/** Records an event on the shared recorder, if one is attached. Never throws. */
export function recordTelemetry(e: TelemetryInput): void {
  try {
    recorder?.record(e);
  } catch {
    /* telemetry must never break the caller */
  }
}

const SPECIAL_MENTIONS = new Set<MentionKind>(['terminal', 'workspace', 'problems', 'git', 'selection', 'editors']);

/** What kind of context an attachment reference is, without keeping the reference itself. */
export function mentionKind(ref: string): MentionKind {
  const r = ref.trim().replace(/^@/, '');
  if (!r) {
    return 'other';
  }
  if (SPECIAL_MENTIONS.has(r as MentionKind)) {
    return r as MentionKind;
  }
  if (/^[a-z][\w+.-]*:\/\//i.test(r)) {
    return /^file:/i.test(r) ? 'file' : 'url';
  }
  if (/#L\d+/.test(r)) {
    return 'range';
  }
  return /[\\/]$/.test(r) ? 'folder' : 'file';
}

const splitLines = (text: string | undefined): string[] => (text ? text.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n') : []);

/**
 * Lines added and removed between two versions of a file, counted as a multiset difference: a moved line counts as
 * neither, a changed line as one of each. Undefined means the file did not exist.
 */
export function lineDelta(before: string | undefined, after: string | undefined): { added: number; removed: number } {
  const counts = new Map<string, number>();
  for (const l of splitLines(before)) {
    counts.set(l, (counts.get(l) ?? 0) + 1);
  }
  let added = 0;
  for (const l of splitLines(after)) {
    const n = counts.get(l);
    if (n) {
      counts.set(l, n - 1);
    } else {
      added++;
    }
  }
  let removed = 0;
  for (const n of counts.values()) {
    removed += n;
  }
  return { added, removed };
}

/** Files past this size count as decided but add no lines (reading them just for a metric is not worth it). */
const MAX_MEASURED_BYTES = 4 * 1024 * 1024;

/** A tracked change to measure; `live` is the text of an open (possibly unsaved) editor, which wins over the disk copy. */
export type MeasuredChange = { fsPath: string; original?: string; live?: string };

/** Sums the line delta of agent-changed files: each file's snapshot against its open editor text, or what is on disk now. */
export async function measureEdits(changes: MeasuredChange[]): Promise<{ added: number; removed: number; files: number }> {
  let added = 0;
  let removed = 0;
  for (const c of changes) {
    let current: string | undefined;
    if (c.live !== undefined) {
      const d = lineDelta(c.original, c.live);
      added += d.added;
      removed += d.removed;
      continue;
    }
    try {
      const st = await fs.promises.stat(c.fsPath);
      if (!st.isFile() || st.size > MAX_MEASURED_BYTES || (c.original?.length ?? 0) > MAX_MEASURED_BYTES) {
        continue;
      }
      current = await fs.promises.readFile(c.fsPath, 'utf8');
    } catch {
      current = undefined;
    }
    const d = lineDelta(c.original, current);
    added += d.added;
    removed += d.removed;
  }
  return { added, removed, files: changes.length };
}

/** The `edit_decision` for one in-buffer edit (Ctrl+I) that replaced `before` with `after`. */
export function inlineEditDecision(decision: 'accepted' | 'rejected', before: string, after: string): TelemetryInput {
  return { type: 'edit_decision', decision, ...lineDelta(before, after), files: 1 };
}

/** Records an `edit_decision` for the given agent changes (on the shared recorder by default). Await it before an undo rewrites the files. */
export async function recordEditDecision(decision: 'accepted' | 'rejected', changes: MeasuredChange[], rec = recorder): Promise<void> {
  if (!rec || !changes.length) {
    return;
  }
  try {
    rec.record({ type: 'edit_decision', decision, ...(await measureEdits(changes)) });
  } catch {
    /* telemetry must never break the caller */
  }
}
