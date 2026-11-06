/**
 * Smoke checks (bundled into scripts/smoke.ts) for the usage pills and CLI turn line, and the history list's sorting,
 * fuzzy title match and paging.
 */
import { formatTokens, turnUsageLabel, usageDelta, usagePills } from '../src/agent/usageFormat';
import { editDistance, queryHistory, titleScore } from '../src/sessions/historyQuery';
import { SessionSummary } from '../src/types';

type Check = (name: string, cond: boolean, detail?: unknown) => void;

export function historySmoke(check: Check): void {
  console.log('\n[usage display / history list]');
  check('formatTokens: 950, 12.3k, 123k, 1.2M', [950, 12_345, 123_456, 1_234_567].map(formatTokens).join() === '950,12.3k,123k,1.2M');
  const before = { promptTokens: 1000, completionTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, requests: 1, costUsd: 0.002 };
  const after = { promptTokens: 4000, completionTokens: 1500, cacheReadTokens: 8000, cacheWriteTokens: 0, requests: 3, costUsd: 0.012 };
  const d = usageDelta(before, after);
  check('usageDelta counts cached input as tokens of the turn', d.total === 12_400 && d.requests === 2, d);
  check('turnUsageLabel: tokens and cost', turnUsageLabel(d) === '(12.4k tok · $0.0100)', turnUsageLabel(d));
  check('turnUsageLabel: no cost for an unpriced (local) model', turnUsageLabel(usageDelta(undefined, { ...after, costUsd: undefined })) === '(13.5k tok)');
  check('turnUsageLabel: empty when no request was made', turnUsageLabel(usageDelta(after, after)) === '');
  const pills = usagePills(after);
  check('usagePills: ↑in ↓out and cost', pills?.tokens === '↑12.0k ↓1.5k' && pills.cost === '$0.0120', pills);

  check('editDistance: a transposition is one edit', editDistance('fxi', 'fix') === 1 && editDistance('login', 'logn') === 1);
  check('titleScore: subsequence', titleScore('rfctr', 'Refactor the parser') !== undefined);
  check('titleScore: a typo still matches', titleScore('athentication', 'Fix authentication bug') !== undefined);
  check('titleScore: unrelated words do not', titleScore('database', 'Fix authentication bug') === undefined);
  const row = (id: string, o: Partial<SessionSummary>): SessionSummary => ({ id, title: id, createdAt: 0, updatedAt: 0, model: '', mode: 'agent', messageCount: 2, ...o });
  const rows = [
    row('a', { updatedAt: 3, bytes: 10, usage: { promptTokens: 10, completionTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, requests: 1 } }),
    row('b', { updatedAt: 2, bytes: 900, pinned: true, usage: { promptTokens: 5000, completionTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, requests: 1, costUsd: 0.5 } }),
    row('c', { updatedAt: 1, bytes: 50 }),
    row('empty', { updatedAt: 9, messageCount: 0 }),
  ];
  check('queryHistory newest: pinned first, empty chats hidden', queryHistory(rows).rows.map((r) => r.id).join() === 'b,a,c');
  check('queryHistory sorts by size, cost and age', queryHistory(rows, { sort: 'size' }).rows[0].id === 'b' && queryHistory(rows, { sort: 'cost' }).rows[0].id === 'b' && queryHistory(rows, { sort: 'oldest' }).rows[0].id === 'c');
  check('queryHistory pinned only', queryHistory(rows, { pinnedOnly: true }).ids.join() === 'b');
  const many = Array.from({ length: 230 }, (_, i) => row(`s${i}`, { updatedAt: i }));
  const p1 = queryHistory(many);
  const p2 = queryHistory(many, { offset: 50, limit: 50 });
  check('queryHistory pages a long history by 50', p1.rows.length === 50 && p1.total === 230 && p2.rows[0].id === 's179', { n: p1.rows.length, first: p2.rows[0]?.id });
  check('queryHistory returns a short history whole', queryHistory(many.slice(0, 120)).rows.length === 120);
  const modes = [row('m1', { mode: 'ask', specialist: 'review' }), row('m2', { mode: 'agent', specialist: 'review' }), row('m3', { mode: 'debug', folder: '/w/b' })];
  check('queryHistory filters by specialist only while it applies', queryHistory(modes, { mode: 'review' }).rows.map((r) => r.id).join() === 'm1');
  check('queryHistory filters by folder (no folder = the first one)', queryHistory(modes, { folder: '/w/a', defaultFolder: '/w/a' }).rows.map((r) => r.id).sort().join() === 'm1,m2' && queryHistory(modes, { folder: '/w/b', defaultFolder: '/w/a' }).total === 1);
}
