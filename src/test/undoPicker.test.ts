import * as assert from 'assert';
import * as path from 'path';
import { formatUndoRow, nextTurnKey, parseRestoreType, parseUndoChoice, undoPicker, undoTo, undoTurns, UndoContext } from '../cli/undoPicker';

const plain = { bold: (s: string) => s, dim: (s: string) => s, red: (s: string) => s, green: (s: string) => s, yellow: (s: string) => s, amber: (s: string) => s, cyan: (s: string) => s };

suite('CLI /undo turn picker', () => {
  const root = path.resolve('/repo');
  const session = (): any => ({
    id: 'cli-1',
    messages: [
      { role: 'user', content: 'first task', meta: { checkpoint: 100 } },
      { role: 'assistant', content: 'ok' },
      { role: 'user', content: 'summary of earlier turns', meta: { summary: true } },
      { role: 'user', content: `<attachment path="a.ts">\nx\n</attachment>\n\n${'refactor the parser '.repeat(5)}`, meta: { checkpoint: 200 } },
      { role: 'assistant', content: 'done' },
      { role: 'user', content: 'old turn without a key' },
      { role: 'assistant', content: 'fine' },
    ],
    checkpoints: { history: [{ run: 200, kind: 'stash', sha: 'abc', root }] },
  });

  test('turns, row formatting and input parsing', () => {
    const turns = undoTurns(session());
    assert.deepStrictEqual(turns.map((t) => [t.n, t.index, t.key]), [[1, 0, 100], [2, 3, 200], [3, 5, undefined]], 'compaction summaries are not turns');
    assert.ok(turns[1].prompt.startsWith('refactor the parser'), 'inlined attachments are not part of the prompt');
    const row = formatUndoRow({ ...turns[1], files: 2 }, plain, 2);
    assert.ok(row.includes(' 2. refactor the parser') && row.includes('…') && row.endsWith('2 files changed since'), row);
    assert.ok(formatUndoRow(turns[2], plain).endsWith('no checkpoint'));
    assert.deepStrictEqual(parseUndoChoice('2', 3), { n: 2 });
    assert.deepStrictEqual(parseUndoChoice('3 f', 3), { n: 3, type: 'workspace' });
    assert.deepStrictEqual(parseUndoChoice('#1c', 3), { n: 1, type: 'task' });
    assert.strictEqual(parseUndoChoice('4', 3), undefined);
    assert.strictEqual(parseUndoChoice('2 x', 3), undefined);
    assert.strictEqual(parseRestoreType(''), 'both');
    assert.strictEqual(parseRestoreType('B'), 'both');
    assert.strictEqual(parseRestoreType('files'), 'workspace');
    assert.strictEqual(parseRestoreType('chat'), 'task');
    assert.strictEqual(parseRestoreType('q'), undefined);
    assert.strictEqual(nextTurnKey(session(), 0, 50), 201, 'above every key already in the chat');
    assert.strictEqual(nextTurnKey(session(), 0, 5000), 5000);
  });

  const ctx = (s: any, answers: string[] = []) => {
    const calls = { restoreWorkspace: 0, restoreTurn: [] as number[], dropped: [] as number[], prefill: [] as string[], out: '' };
    const c: UndoContext = {
      session: s,
      store: { historyBefore: async (x: any, i: number) => x.messages.slice(0, i), save() {} },
      tracker: {
        restoreTurn: async (_sid: string, turn: number) => (calls.restoreTurn.push(turn), { restored: 1, failed: 0 }),
        dropTurnsFrom: (_sid: string, t: number) => void calls.dropped.push(t),
        turnOriginals: () => new Map([[path.resolve('/elsewhere/x.ts'), 'x']]),
        settle: async () => undefined,
      } as any,
      checkpoints: {
        changedFiles: async () => [{ path: 'a.ts', status: 'M' }, { path: 'b.txt', status: 'A' }],
        restoreWorkspace: async () => (calls.restoreWorkspace++, { ok: true, files: 2 }),
        dropFrom: async () => undefined,
      } as any,
      ask: async () => answers.shift(),
      style: plain,
      out: { write: (x: string) => ((calls.out += x), true) } as any,
      prefill: (t) => calls.prefill.push(t),
    };
    return { c, calls };
  };

  test('files only restores the git checkpoint and keeps the chat; chat only keeps the files and refills the prompt', async () => {
    const s = session();
    const t = ctx(s);
    const files = await undoTo(undoTurns(s)[1], 'workspace', t.c);
    assert.ok(files.ok, files.message);
    assert.strictEqual(t.calls.restoreWorkspace, 1);
    assert.deepStrictEqual(t.calls.restoreTurn, [200], 'edits outside the repository come back from the snapshots');
    assert.strictEqual(s.messages.length, 7);
    assert.match(files.message, /reverted 3 files/);

    const s2 = session();
    const t2 = ctx(s2);
    const chat = await undoTo(undoTurns(s2)[1], 'task', t2.c);
    assert.ok(chat.ok);
    assert.strictEqual(s2.messages.length, 3);
    assert.strictEqual(t2.calls.restoreWorkspace, 0);
    assert.deepStrictEqual(t2.calls.dropped, [200]);
    assert.ok(t2.calls.prefill[0].startsWith('refactor the parser'));

    const s3 = session();
    const noKey = await undoTo(undoTurns(s3)[2], 'both', ctx(s3).c);
    assert.ok(!noKey.ok && /no checkpoint/.test(noKey.message));
    assert.strictEqual(s3.messages.length, 7, 'nothing is cut when the files cannot be restored');
  });

  test('the picker lists turns with their file counts, then asks for a number and a type', async () => {
    const s = session();
    const t = ctx(s, ['2', 'b']);
    await undoPicker('', t.c);
    assert.match(t.calls.out, /1\. first task/);
    assert.match(t.calls.out, /2\. refactor the parser.*3 files changed since/);
    assert.strictEqual(t.calls.restoreWorkspace, 1);
    assert.strictEqual(s.messages.length, 3);

    const cancel = ctx(session(), ['']);
    await undoPicker('', cancel.c);
    assert.strictEqual(cancel.calls.restoreWorkspace + cancel.calls.restoreTurn.length, 0, 'Enter cancels');

    const direct = ctx(session());
    await undoPicker('1 c', direct.c);
    assert.strictEqual(direct.c.session.messages.length, 0);
    assert.strictEqual(direct.calls.restoreWorkspace, 0);
  });
});
