/**
 * File-by-file review of a chat's changes: which pending file comes next, and what the summary says once the queue is
 * empty. Pure, so the chat, the diff editor commands and the tests share one definition.
 */

export interface ReviewRow {
  fsPath: string;
  state: 'accepted' | 'rejected';
}

/**
 * The pending files the queue walks, in list order: all of them, or only those in `scope` (the files of the turn the
 * review was started from; empty once all of those are decided).
 */
export function queueFiles(pending: string[], scope?: ReadonlySet<string>): string[] {
  return scope ? pending.filter((f) => scope.has(f)) : pending;
}

/**
 * The file to open after `current` in direction `dir` (wrapping), or undefined when nothing else is pending. `current`
 * may already be reviewed (it just left the list): the next file is then the first pending one after where it sat in
 * `order` (the full list it was part of).
 */
export function nextInQueue(queue: string[], current: string | undefined, dir: 1 | -1 = 1, order: string[] = queue): string | undefined {
  if (!queue.length) {
    return undefined;
  }
  if (current === undefined) {
    return dir === 1 ? queue[0] : queue[queue.length - 1];
  }
  const i = queue.indexOf(current);
  if (i >= 0) {
    if (queue.length === 1) {
      return undefined;
    }
    return queue[(i + dir + queue.length) % queue.length];
  }
  // `current` is no longer pending: continue from its place in the full order (or its sort position as a fallback).
  const at = order.indexOf(current);
  const rank = (f: string) => (at >= 0 ? order.indexOf(f) : f.localeCompare(current));
  const pivot = at >= 0 ? at : 0;
  if (dir === 1) {
    return queue.find((f) => rank(f) > pivot) ?? queue[0];
  }
  return [...queue].reverse().find((f) => rank(f) < pivot) ?? queue[queue.length - 1];
}

/** "All 5 files reviewed: 4 accepted, 1 rejected" (or "1 file reviewed: accepted"). */
export function reviewSummary(rows: ReviewRow[]): string {
  const acc = rows.filter((r) => r.state === 'accepted').length;
  const rej = rows.length - acc;
  const n = rows.length;
  if (n === 1) {
    return `1 file reviewed: ${acc ? 'accepted' : 'rejected'}`;
  }
  const parts = [acc ? `${acc} accepted` : '', rej ? `${rej} rejected` : ''].filter(Boolean).join(', ');
  return `All ${n} files reviewed: ${parts}`;
}
