// Three-way line merge for memory notes, prompt templates and instruction files (design §9.4 `text-merge`).
// Non-overlapping edits from both sides are combined; where both sides changed the same lines differently, the later
// side (`b`) is applied and the merge reports a conflict. Symmetric for non-overlapping edits, deterministic always.
// Pure.

export interface MergeResult {
  text: string;
  conflict: boolean;
}

interface Hunk {
  /** Replaced range of the base, [start, end). */
  start: number;
  end: number;
  lines: string[];
}

const MAX_LINES = 4000;

function split(t: string): string[] {
  return t.split('\n');
}

/** Hunks that turn `base` into `other` (LCS on lines). */
function diff(base: string[], other: string[]): Hunk[] {
  const n = base.length;
  const m = other.length;
  // Common prefix / suffix first: most edits are small.
  let pre = 0;
  while (pre < n && pre < m && base[pre] === other[pre]) {
    pre++;
  }
  let suf = 0;
  while (suf < n - pre && suf < m - pre && base[n - 1 - suf] === other[m - 1 - suf]) {
    suf++;
  }
  const a = base.slice(pre, n - suf);
  const b = other.slice(pre, m - suf);
  const hunks: Hunk[] = [];
  if (!a.length && !b.length) {
    return hunks;
  }
  // LCS table over the middle part.
  const w = b.length + 1;
  const dp = new Uint32Array((a.length + 1) * w);
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      dp[i * w + j] = a[i] === b[j] ? dp[(i + 1) * w + j + 1] + 1 : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
    }
  }
  let i = 0;
  let j = 0;
  let cur: Hunk | undefined;
  const close = () => {
    if (cur) {
      hunks.push(cur);
      cur = undefined;
    }
  };
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      close();
      i++;
      j++;
    } else if (j < b.length && (i >= a.length || dp[i * w + j + 1] >= dp[(i + 1) * w + j])) {
      cur ??= { start: pre + i, end: pre + i, lines: [] };
      cur.lines.push(b[j]);
      j++;
    } else {
      cur ??= { start: pre + i, end: pre + i, lines: [] };
      i++;
      cur.end = pre + i;
    }
  }
  close();
  return hunks;
}

const sameHunk = (x: Hunk, y: Hunk) => x.start === y.start && x.end === y.end && x.lines.join('\n') === y.lines.join('\n');
/** Two hunks touch the same base lines (or insert at the same point). */
const overlaps = (x: Hunk, y: Hunk) => (x.start < y.end && y.start < x.end) || x.start === y.start || (x.start === x.end && x.start > y.start && x.start < y.end) || (y.start === y.end && y.start > x.start && y.start < x.end);

/**
 * Merges `a` and `b`, both edited from `base`. `b` is the later edit: it wins where the two overlap.
 */
export function merge3(base: string, a: string, b: string): MergeResult {
  if (a === b) {
    return { text: a, conflict: false };
  }
  if (a === base) {
    return { text: b, conflict: false };
  }
  if (b === base) {
    return { text: a, conflict: false };
  }
  const bl = split(base);
  const al = split(a);
  const blB = split(b);
  if (bl.length > MAX_LINES || al.length > MAX_LINES || blB.length > MAX_LINES) {
    return { text: b, conflict: true };
  }
  const ha = diff(bl, al);
  const hb = diff(bl, blB);
  let conflict = false;
  const chosen: Hunk[] = [];
  const usedA = new Set<number>();
  for (const y of hb) {
    ha.forEach((x, k) => {
      if (overlaps(x, y)) {
        usedA.add(k);
        if (!sameHunk(x, y)) {
          conflict = true;
        }
      }
    });
    chosen.push(y);
  }
  ha.forEach((x, k) => {
    if (!usedA.has(k)) {
      chosen.push(x);
    }
  });
  // Insertions at the same point from both sides that did not conflict were deduplicated above; apply from the end.
  chosen.sort((x, y) => y.start - x.start || y.end - x.end);
  const out = [...bl];
  for (const h of chosen) {
    out.splice(h.start, h.end - h.start, ...h.lines);
  }
  return { text: out.join('\n'), conflict };
}
