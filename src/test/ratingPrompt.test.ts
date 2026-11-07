import * as assert from 'assert';
import { DAYS_BEFORE_ASK, DAYS_BETWEEN_ASKS, MAX_ASKS, MarketplaceStats, parseGalleryStats, RatingPrompt, REVIEW_URL, REPO_URL, RUNS_BEFORE_ASK, shouldAsk, storeFor } from '../ui/ratingPrompt';

const DAY = 86_400_000;
/** Read through a call: TypeScript would keep the narrowing of an earlier `assert.strictEqual(p.pending, undefined)`. */
const card = (p: RatingPrompt) => p.pending;

function memento() {
  const data = new Map<string, unknown>();
  return { data, get: <T>(k: string) => data.get(k) as T | undefined, update: (k: string, v: unknown) => (data.set(k, v), Promise.resolve()) };
}

suite('Rating prompt', () => {
  test('asks only after real use, never too soon, and never after a rating or "Don\'t ask again"', () => {
    const now = 100 * DAY;
    const used = { runs: RUNS_BEFORE_ASK, firstRunAt: now - DAYS_BEFORE_ASK * DAY, asks: 0 };
    assert.strictEqual(shouldAsk(used, now), true);
    assert.strictEqual(shouldAsk({ ...used, runs: RUNS_BEFORE_ASK - 1 }, now), false, 'not enough runs');
    assert.strictEqual(shouldAsk({ ...used, firstRunAt: now - DAY }, now), false, 'too soon after the first run');
    assert.strictEqual(shouldAsk({ ...used, lastAskedAt: now - DAY }, now), false, 'put off recently');
    assert.strictEqual(shouldAsk({ ...used, lastAskedAt: now - DAYS_BETWEEN_ASKS * DAY }, now), true, 'asked again after the pause');
    assert.strictEqual(shouldAsk({ ...used, asks: MAX_ASKS }, now), false, 'at most three asks');
    assert.strictEqual(shouldAsk({ ...used, never: true }, now), false);
    assert.strictEqual(shouldAsk({ ...used, rated: { stars: 5, at: now, version: '1.0.0' } }, now), false);
  });

  test('counts successful runs, shows the card when it is time, with the Marketplace stats', async () => {
    const mem = memento();
    let now = 10 * DAY;
    let fetched = 0;
    const stats: MarketplaceStats = { average: 4.6, count: 23, at: 0 };
    const p = new RatingPrompt(mem, '1.6.2', 'Visual Studio Code', { now: () => now, fetchStats: async (t) => (fetched++, { ...stats, at: t }) });
    const seen: unknown[] = [];
    p.subscribe(() => seen.push(p.pending));
    for (let i = 0; i < RUNS_BEFORE_ASK; i++) {
      await p.noteRun(true);
    }
    await p.noteRun(false);
    assert.strictEqual(p.pending, undefined, 'not before the first-ask delay');
    assert.strictEqual(p.state.runs, RUNS_BEFORE_ASK, 'failed or stopped runs do not count');
    now += DAYS_BEFORE_ASK * DAY;
    await p.noteRun(true);
    assert.ok(card(p), 'the card shows');
    assert.strictEqual(card(p)!.store, 'marketplace');
    assert.strictEqual(card(p)!.reviewUrl, REVIEW_URL);
    assert.deepStrictEqual([card(p)!.stats?.average, card(p)!.stats?.count], [4.6, 23]);
    assert.ok(seen.length >= 2, 'the chat is told when it appears and again with the stats');
    await p.stats();
    assert.strictEqual(fetched, 1, 'the stats are cached for a day');
  });

  test('a rating closes the card for good; 1–3 stars also get a prefilled issue, 4–5 only the review form', async () => {
    const mem = memento();
    const p = new RatingPrompt(mem, '1.6.2', 'Visual Studio Code', { now: () => 5 * DAY, fetchStats: async () => undefined });
    await p.show();
    const low = await p.rate(2, 'darwin arm64');
    assert.strictEqual(p.pending, undefined);
    assert.strictEqual(low.reviewUrl, REVIEW_URL, 'the review form is offered whatever the rating');
    assert.ok(low.issueUrl?.startsWith(`${REPO_URL}/issues/new?`), low.issueUrl);
    assert.match(decodeURIComponent(low.issueUrl!), /LocalPilot 1\.6\.2 · Visual Studio Code · darwin arm64/);
    assert.strictEqual(p.state.rated?.stars, 2);
    assert.strictEqual(shouldAsk({ ...p.state, runs: 99, firstRunAt: 0 }, 999 * DAY), false, 'never asked again after a rating');
    const high = await p.rate(5, 'linux x64');
    assert.strictEqual(high.issueUrl, undefined);
    assert.strictEqual((await p.rate(9, 'x')).issueUrl, undefined, 'out-of-range stars are clamped (9 → 5)');
    await p.show();
    assert.strictEqual(card(p)?.rated, 5, 'the command shows the card again with the rating to change');
  });

  test('"Later" and "Don\'t ask again"', async () => {
    const mem = memento();
    const p = new RatingPrompt(mem, '1.6.2', 'Visual Studio Code', { now: () => 50 * DAY, fetchStats: async () => undefined });
    await p.show();
    await p.dismiss(false);
    assert.deepStrictEqual([p.pending, p.state.asks, p.state.lastAskedAt, p.state.never], [undefined, 1, 50 * DAY, undefined]);
    await p.dismiss(true);
    assert.strictEqual(p.state.never, true);
  });

  test('editors without the VS Code Marketplace get the repository; gallery statistics are parsed', () => {
    assert.deepStrictEqual(storeFor('Visual Studio Code'), { store: 'marketplace', reviewUrl: REVIEW_URL });
    assert.deepStrictEqual(storeFor('Visual Studio Code - Insiders').store, 'marketplace');
    assert.deepStrictEqual(storeFor('Cursor'), { store: 'github', reviewUrl: REPO_URL });
    assert.deepStrictEqual(storeFor('VSCodium').store, 'github');
    const json = { results: [{ extensions: [{ statistics: [{ statisticName: 'install', value: 1520 }, { statisticName: 'averagerating', value: 4.5714 }, { statisticName: 'ratingcount', value: 7 }] }] }] };
    assert.deepStrictEqual(parseGalleryStats(json, 1), { average: 4.6, count: 7, installs: 1520, at: 1 });
    assert.strictEqual(parseGalleryStats({ results: [{ extensions: [] }] }, 1), undefined);
  });
});
