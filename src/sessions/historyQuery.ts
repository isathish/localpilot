/** Pure sorting, filtering and paging of the chat history list (no `vscode` import, so smoke tests can load it). */
import { SessionSummary } from '../types';
import { fuzzyMatch } from '../context/mentionSearch';

export type HistorySort = 'newest' | 'oldest' | 'tokens' | 'cost' | 'size' | 'relevance';
export const HISTORY_SORTS: readonly HistorySort[] = ['newest', 'oldest', 'tokens', 'cost', 'size', 'relevance'];

/** Up to this many chats load at once; a longer history loads in pages of `HISTORY_PAGE` as the list scrolls. */
export const HISTORY_ALL_UP_TO = 200;
export const HISTORY_PAGE = 50;

export interface HistoryQuery {
  offset?: number;
  /** Rows wanted; unset = everything for a short history, the first page for a long one. */
  limit?: number;
  sort?: HistorySort;
  query?: string;
  pinnedOnly?: boolean;
  /** Chats listed even when empty (the open one, running ones). */
  keep?: readonly string[];
  /** Chats sorted first under Newest (running ones). */
  first?: readonly string[];
}

/** A content-search hit: the line of the conversation that matched. */
export interface HistoryHit {
  id: string;
  snippet: string;
  role: 'user' | 'assistant';
}

export type HistoryRow = SessionSummary & { score?: number; snippet?: string; role?: 'user' | 'assistant' };

export interface HistoryPage {
  rows: HistoryRow[];
  /** Every matching chat, not just this page. */
  total: number;
  offset: number;
  limit: number;
  sort: HistorySort;
  query: string;
  pinnedOnly: boolean;
  /** Ids of every match in order (Select all), with the bytes each takes on disk. */
  ids: string[];
  bytes: number;
}

/** Levenshtein distance with adjacent transpositions, giving up (returning `max + 1`) once it exceeds `max`. */
export function editDistance(a: string, b: string, max = 2): number {
  if (Math.abs(a.length - b.length) > max) {
    return max + 1;
  }
  let prev2: number[] = [];
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        v = Math.min(v, prev2[j - 2] + 1);
      }
      cur.push(v);
      best = Math.min(best, v);
    }
    if (best > max) {
      return max + 1;
    }
    prev2 = prev;
    prev = cur;
  }
  return prev[b.length];
}

/** Typos a query word may have: none below 4 letters, one up to 7, two from 8. */
const typoBudget = (len: number): number => (len < 4 ? 0 : len < 8 ? 1 : 2);

/**
 * How well a title matches the query; undefined = no match. The whole query as a subsequence (the `@` menu's scorer)
 * scores best; otherwise every query word must appear in the title as a substring, a subsequence, or within a typo or
 * two of one of its words (or of a word's start, while it is still being typed).
 */
export function titleScore(query: string, title: string): number | undefined {
  const q = query.trim().toLowerCase();
  if (!q) {
    return 0;
  }
  const t = title.toLowerCase();
  const whole = fuzzyMatch(q, title);
  if (whole) {
    return 20 + whole.score + (t.includes(q) ? 20 : 0);
  }
  const words = t.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  let score = 0;
  for (const w of q.split(/\s+/).filter(Boolean)) {
    if (t.includes(w)) {
      score += 10 + w.length;
      continue;
    }
    const sub = fuzzyMatch(w, title);
    if (sub) {
      score += Math.max(1, sub.score / 2);
      continue;
    }
    const budget = typoBudget(w.length);
    const near = budget > 0 && words.some((tw) => editDistance(w, tw, budget) <= budget || (tw.length > w.length && editDistance(w, tw.slice(0, w.length), budget) <= budget));
    if (!near) {
      return undefined;
    }
    score += 4;
  }
  return score;
}

const tokensOf = (s: SessionSummary): number => {
  const u = s.usage;
  return u ? u.promptTokens + u.completionTokens + u.cacheReadTokens + u.cacheWriteTokens : 0;
};

/** Whether the history lists a chat: untouched empty ones are noise, unless open or running. */
function listed(s: SessionSummary, keep: ReadonlySet<string>): boolean {
  return s.messageCount > 0 || !!s.pinned || !!s.plan || keep.has(s.id);
}

/**
 * One page of the history: filtered (pinned only, title fuzzy match or a content hit), sorted, then sliced. Relevance
 * ranks title matches above content-only ones; without a query it falls back to Newest.
 */
export function queryHistory(all: readonly SessionSummary[], q: HistoryQuery = {}, hits: readonly HistoryHit[] = []): HistoryPage {
  const query = (q.query ?? '').trim();
  const sort: HistorySort = q.sort && HISTORY_SORTS.includes(q.sort) ? q.sort : 'newest';
  const keep = new Set(q.keep ?? []);
  const first = new Set(q.first ?? []);
  const hitBy = new Map(hits.map((h) => [h.id, h]));
  const rows: HistoryRow[] = [];
  for (const s of all) {
    if (!listed(s, keep) || (q.pinnedOnly && !s.pinned)) {
      continue;
    }
    if (!query) {
      rows.push({ ...s });
      continue;
    }
    const title = titleScore(query, s.title || 'New chat');
    const hit = hitBy.get(s.id);
    if (title === undefined && !hit) {
      continue;
    }
    rows.push({ ...s, score: (title ?? 0) + (hit ? (title === undefined ? 3 : 5) : 0), ...(hit?.snippet ? { snippet: hit.snippet, role: hit.role } : {}) });
  }
  const newest = (a: HistoryRow, b: HistoryRow) => Number(first.has(b.id)) - Number(first.has(a.id)) || Number(!!b.pinned) - Number(!!a.pinned) || b.updatedAt - a.updatedAt;
  const by: Record<HistorySort, (a: HistoryRow, b: HistoryRow) => number> = {
    newest,
    oldest: (a, b) => a.updatedAt - b.updatedAt,
    tokens: (a, b) => tokensOf(b) - tokensOf(a) || b.updatedAt - a.updatedAt,
    cost: (a, b) => (b.usage?.costUsd ?? -1) - (a.usage?.costUsd ?? -1) || tokensOf(b) - tokensOf(a) || b.updatedAt - a.updatedAt,
    size: (a, b) => (b.bytes ?? 0) - (a.bytes ?? 0) || b.updatedAt - a.updatedAt,
    relevance: (a, b) => (query ? (b.score ?? 0) - (a.score ?? 0) || b.updatedAt - a.updatedAt : newest(a, b)),
  };
  rows.sort(by[sort]);
  const total = rows.length;
  const offset = Math.max(0, Math.min(Math.floor(q.offset ?? 0), total));
  const limit = q.limit !== undefined && q.limit > 0 ? Math.floor(q.limit) : total <= HISTORY_ALL_UP_TO ? Math.max(total, 1) : HISTORY_PAGE;
  return {
    rows: rows.slice(offset, offset + limit),
    total,
    offset,
    limit,
    sort,
    query,
    pinnedOnly: !!q.pinnedOnly,
    ids: rows.map((r) => r.id),
    bytes: rows.reduce((n, r) => n + (r.bytes ?? 0), 0),
  };
}
