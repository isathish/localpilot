import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CommandRun, commandLogDir, commandLogPrefix, deleteCommandLogs, setCommandLogDir } from '../terminal/commandRun';
import { editDistance, HISTORY_PAGE, queryHistory, titleScore } from '../sessions/historyQuery';
import { formatTokens, turnUsageLabel, usageDelta, usagePills, usageTotals } from '../agent/usageFormat';
import { SessionSummary, SessionUsage } from '../types';

const usage = (prompt: number, completion: number, extra: Partial<SessionUsage> = {}): SessionUsage => ({ promptTokens: prompt, completionTokens: completion, cacheReadTokens: 0, cacheWriteTokens: 0, requests: 1, ...extra });
const row = (id: string, o: Partial<SessionSummary> = {}): SessionSummary => ({ id, title: id, createdAt: 0, updatedAt: 0, model: '', mode: 'agent', messageCount: 2, ...o });

suite('Usage display', () => {
  test('token counts are compact', () => {
    assert.deepStrictEqual([0, 999, 1000, 12_345, 123_456, 1_234_567, 12_345_678].map(formatTokens), ['0', '999', '1.0k', '12.3k', '123k', '1.2M', '12M']);
  });

  test('input counts cached tokens; cost is kept only when priced', () => {
    const t = usageTotals(usage(100, 50, { cacheReadTokens: 900, cacheWriteTokens: 10 }));
    assert.deepStrictEqual(t, { input: 1010, output: 50, total: 1060, costUsd: undefined, requests: 1 });
    assert.strictEqual(usagePills(usage(100, 50))?.cost, '');
    assert.strictEqual(usagePills(usage(1200, 50, { costUsd: 0.01234 }))?.tokens, '↑1.2k ↓50');
    assert.strictEqual(usagePills(undefined), undefined);
  });

  test('the CLI turn line shows what the turn added', () => {
    const before = usage(1000, 100, { costUsd: 0.001 });
    const after = usage(5000, 600, { costUsd: 0.011, requests: 4, cacheReadTokens: 7800 });
    assert.strictEqual(turnUsageLabel(usageDelta(before, after)), '(12.3k tok · $0.0100)');
    assert.strictEqual(turnUsageLabel(usageDelta(undefined, usage(900, 100))), '(1.0k tok)');
    assert.strictEqual(turnUsageLabel(usageDelta(after, after)), '');
  });
});

suite('History list query', () => {
  test('edit distance tolerates one typo or transposition', () => {
    assert.strictEqual(editDistance('kitten', 'sitten'), 1);
    assert.strictEqual(editDistance('teh', 'the'), 1);
    assert.ok(editDistance('abcdef', 'uvwxyz', 2) > 2);
  });

  test('title match: subsequence, word typos, word prefixes', () => {
    assert.ok(titleScore('auth', 'Fix authentication bug')! > titleScore('fab', 'Fix authentication bug')!);
    assert.notStrictEqual(titleScore('athentication fix', 'Fix authentication bug'), undefined);
    assert.notStrictEqual(titleScore('authen', 'Fix authentication bug'), undefined);
    assert.strictEqual(titleScore('payments', 'Fix authentication bug'), undefined);
    assert.strictEqual(titleScore('', 'anything'), 0);
  });

  test('sorts: newest (running, pinned first), oldest, tokens, cost, size', () => {
    const rows = [
      row('a', { updatedAt: 30, bytes: 100, usage: usage(10, 10) }),
      row('b', { updatedAt: 20, bytes: 5000, usage: usage(9000, 10, { costUsd: 0.2 }) }),
      row('c', { updatedAt: 10, pinned: true, bytes: 50, usage: usage(500, 10, { costUsd: 0.9 }) }),
      row('d', { updatedAt: 5 }),
    ];
    const ids = (sort?: Parameters<typeof queryHistory>[1]) => queryHistory(rows, sort).rows.map((r) => r.id).join();
    assert.strictEqual(ids(), 'c,a,b,d');
    assert.strictEqual(ids({ first: ['d'] }), 'd,c,a,b');
    assert.strictEqual(ids({ sort: 'oldest' }), 'd,c,b,a');
    assert.strictEqual(ids({ sort: 'tokens' }), 'b,c,a,d');
    assert.strictEqual(ids({ sort: 'cost' }), 'c,b,a,d');
    assert.strictEqual(ids({ sort: 'size' }), 'b,a,c,d');
    assert.strictEqual(ids({ sort: 'relevance' }), 'c,a,b,d', 'relevance without a query is newest');
  });

  test('filters: empty chats, pinned only, query with content hits', () => {
    const rows = [row('Fix login'), row('Write docs'), row('empty', { messageCount: 0 }), row('Pinned plan', { pinned: true })];
    assert.deepStrictEqual(queryHistory(rows).ids.sort(), ['Fix login', 'Pinned plan', 'Write docs']);
    assert.deepStrictEqual(queryHistory(rows, { keep: ['empty'] }).ids.includes('empty'), true);
    assert.deepStrictEqual(queryHistory(rows, { pinnedOnly: true }).ids, ['Pinned plan']);
    const page = queryHistory(rows, { query: 'logn', sort: 'relevance' }, [{ id: 'Write docs', snippet: 'the logn page', role: 'user' }]);
    assert.deepStrictEqual(page.ids, ['Fix login', 'Write docs'], 'title matches rank above content-only hits');
    assert.strictEqual(page.rows[1].snippet, 'the logn page');
  });

  test('pages: all of a short history, 50 at a time beyond 200', () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => row(`s${i}`, { updatedAt: i, bytes: 10 }));
    assert.strictEqual(queryHistory(many(200)).rows.length, 200);
    const long = queryHistory(many(201));
    assert.strictEqual(long.rows.length, HISTORY_PAGE);
    assert.strictEqual(long.total, 201);
    assert.strictEqual(long.ids.length, 201);
    assert.strictEqual(long.bytes, 2010);
    const next = queryHistory(many(201), { offset: 200, limit: 50 });
    assert.deepStrictEqual(next.rows.map((r) => r.id), ['s0']);
  });
});

suite('Deleting a chat removes its command logs', () => {
  test('only the logs of that chat go, and its detached commands stop', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lp-cmdlogs-'));
    const prev = commandLogDir();
    setCommandLogDir(dir);
    try {
      let killed = 0;
      const run = new CommandRun({ id: 'del-1', sessionId: 's_gone', command: 'serve', kill: () => killed++ });
      run.detach();
      const o = await run.result;
      assert.ok(o.detached && path.basename(o.detached.logPath).startsWith(commandLogPrefix('s_gone')), JSON.stringify(o));
      fs.writeFileSync(path.join(dir, `${commandLogPrefix('s_kept')}x.log`), 'keep');
      assert.ok(deleteCommandLogs('s_gone') > 0);
      assert.strictEqual(killed, 1);
      assert.deepStrictEqual(fs.readdirSync(dir), [`${commandLogPrefix('s_kept')}x.log`]);
    } finally {
      setCommandLogDir(prev);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
