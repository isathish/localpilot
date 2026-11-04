/** Pure ranking for the chat's `@` menu: a subsequence fuzzy match over workspace paths (no `vscode` import). */

export interface MentionEntry {
  /** What goes into the draft after `@`: a workspace-relative path (`folder/path` in a multi-root workspace). */
  ref: string;
  /** What the menu shows: the same path, `folder:/path` in a multi-root workspace; folders end in `/`. */
  display: string;
  kind: 'file' | 'folder';
}

export interface MentionHit {
  ref: string;
  /** The base name (folders keep their trailing `/`). */
  label: string;
  desc: string;
  kind: 'file' | 'folder';
  /** Matched character offsets in `label` and `desc`, for highlighting. */
  labelHl: number[];
  hl: number[];
  open?: boolean;
  recent?: boolean;
}

export interface FuzzyMatch {
  score: number;
  positions: number[];
}

const isSep = (c: string) => c === '/' || c === '\\' || c === '.' || c === '_' || c === '-' || c === ' ' || c === ':';

/** A word starts here: the string start, after a separator, or a lower→upper camelCase step. */
function boundary(text: string, i: number): boolean {
  if (i === 0) {
    return true;
  }
  const prev = text[i - 1];
  const cur = text[i];
  return isSep(prev) || (prev >= 'a' && prev <= 'z' && cur >= 'A' && cur <= 'Z') || (/[a-zA-Z]/.test(prev) && /[0-9]/.test(cur));
}

/**
 * Case-insensitive subsequence match of `query` in `text`. The leftmost complete match is tightened backwards (as fzf
 * v1 does), then scored: consecutive runs and word starts earn bonuses, gaps and a late start cost a little.
 */
export function fuzzyMatch(query: string, text: string): FuzzyMatch | undefined {
  const q = query.toLowerCase();
  if (!q) {
    return { score: 0, positions: [] };
  }
  const t = text.toLowerCase();
  let qi = 0;
  let end = -1;
  for (let i = 0; i < t.length; i++) {
    if (t[i] === q[qi] && ++qi === q.length) {
      end = i;
      break;
    }
  }
  if (end < 0) {
    return undefined;
  }
  // Walk back from the end to the latest start that still contains the whole query.
  qi = q.length - 1;
  let start = end;
  for (let i = end; i >= 0; i--) {
    if (t[i] === q[qi]) {
      start = i;
      if (--qi < 0) {
        break;
      }
    }
  }
  // Forward again inside the window, preferring a word start when the same letter appears at one later on.
  const positions: number[] = [];
  qi = 0;
  for (let i = start; i <= end && qi < q.length; i++) {
    if (t[i] !== q[qi]) {
      continue;
    }
    const prevMatched = positions.length > 0 && positions[positions.length - 1] === i - 1;
    if (!prevMatched && !boundary(text, i) && q.length - qi <= end - i) {
      const later = t.indexOf(q[qi], i + 1);
      if (later > 0 && later <= end && boundary(text, later) && remainingFits(t, q, qi + 1, later + 1, end)) {
        continue;
      }
    }
    positions.push(i);
    qi++;
  }
  if (qi < q.length) {
    return undefined;
  }
  let score = 0;
  for (let k = 0; k < positions.length; k++) {
    const i = positions[k];
    score += 1;
    if (boundary(text, i)) {
      score += 8;
    }
    if (k > 0) {
      const gap = i - positions[k - 1] - 1;
      score += gap === 0 ? 6 : -Math.min(gap, 6);
    }
    if (text[i] === query[k]) {
      score += 0.5;
    }
  }
  score -= Math.min(positions[0], 10) * 0.5;
  return { score, positions };
}

/** Whether `q[from..]` is still a subsequence of `t[at..end]`. */
function remainingFits(t: string, q: string, from: number, at: number, end: number): boolean {
  let qi = from;
  for (let i = at; i <= end && qi < q.length; i++) {
    if (t[i] === q[qi]) {
      qi++;
    }
  }
  return qi === q.length;
}

/** Every ancestor folder of the given files, as folder entries (`src/`, `src/ui/` …). */
export function foldersOf(files: readonly MentionEntry[]): MentionEntry[] {
  const seen = new Map<string, MentionEntry>();
  for (const f of files) {
    const ref = f.ref.split('/');
    const display = f.display.split('/');
    for (let n = 1; n < ref.length; n++) {
      const r = ref.slice(0, n).join('/');
      if (!seen.has(r)) {
        // The multi-root `name:` prefix is not a folder of its own.
        const d = display.slice(0, n).join('/');
        if (d && !d.endsWith(':')) {
          seen.set(r, { ref: r, display: `${d}/`, kind: 'folder' });
        }
      }
    }
  }
  return [...seen.values()];
}

/**
 * The best `limit` entries for `query`. Open editors come first, then recently attached files, then everything else;
 * inside a tier the fuzzy score decides, with base-name matches well ahead of matches spread over the path.
 */
export function rankMentions(query: string, entries: readonly MentionEntry[], opts: { open?: readonly string[]; recent?: readonly string[]; limit?: number } = {}): MentionHit[] {
  const q = query.trim().replace(/^"/, '');
  const open = new Set(opts.open ?? []);
  const recent = new Set(opts.recent ?? []);
  const limit = opts.limit ?? 20;
  const scored: { hit: MentionHit; tier: number; score: number }[] = [];
  for (const e of entries) {
    const trimmed = e.kind === 'folder' ? e.display.slice(0, -1) : e.display;
    const cut = trimmed.lastIndexOf('/') + 1;
    const base = e.display.slice(cut);
    let match: FuzzyMatch | undefined;
    let score = 0;
    const onBase = q.includes('/') ? undefined : fuzzyMatch(q, base);
    if (onBase) {
      match = { score: onBase.score, positions: onBase.positions.map((p) => p + cut) };
      score = onBase.score + 40 + (onBase.positions.length && onBase.positions[0] === 0 ? 10 : 0);
    } else {
      match = fuzzyMatch(q, e.display);
      score = match?.score ?? 0;
    }
    if (!match) {
      continue;
    }
    if (e.kind === 'folder') {
      score -= 5;
    }
    const isOpen = e.kind === 'file' && open.has(e.ref);
    const isRecent = !isOpen && recent.has(e.ref);
    const hit: MentionHit = { ref: e.ref, label: base, desc: e.display, kind: e.kind, hl: match.positions, labelHl: match.positions.filter((p) => p >= cut).map((p) => p - cut) };
    if (isOpen) {
      hit.open = true;
    }
    if (isRecent) {
      hit.recent = true;
    }
    scored.push({ hit, tier: isOpen ? 0 : isRecent ? 1 : 2, score });
  }
  scored.sort((a, b) => a.tier - b.tier || b.score - a.score || a.hit.desc.length - b.hit.desc.length || (a.hit.desc < b.hit.desc ? -1 : 1));
  return scored.slice(0, limit).map((s) => s.hit);
}
