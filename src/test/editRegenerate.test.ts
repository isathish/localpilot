import * as assert from 'assert';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CheckpointService } from '../agent/checkpoints';
import { ChatController } from '../ui/chatController';
import { removeTemp } from './removeTemp';

suite('Inline edit and regenerate (Reset Chat / Reset Code)', () => {
  const root = path.resolve('/repo');
  const make = (opts: { git?: boolean; snapshots?: number[]; gitExists?: boolean } = {}) => {
    const s: any = {
      id: 's1',
      messages: [
        { role: 'user', content: 'first', meta: { checkpoint: 1 } },
        { role: 'assistant', content: 'ok' },
        { role: 'user', content: 'fix it\n<attachment path="src/a.ts">\nx\n</attachment>', images: ['aW1n'], meta: { checkpoint: 3, display: 'fix it' } },
        { role: 'assistant', content: 'done' },
        { role: 'user', content: 'more', meta: { checkpoint: 5 } },
        { role: 'assistant', content: 'sure' },
      ],
      checkpoints: opts.git ? { history: [{ run: 3, kind: 'stash', sha: 'abc', root }] } : undefined,
    };
    const calls = { restoreTurn: [] as number[], restoreWorkspace: 0, sent: [] as any[], posted: [] as any[], broadcast: [] as any[] };
    const c = Object.create(ChatController.prototype) as any;
    Object.assign(c, {
      compacting: new Set(),
      runs: new Map(),
      replays: new Map(),
      offers: new Map(),
      store: { get: () => s, historyBefore: async (x: any, i: number) => x.messages.slice(0, i), save() {} },
      tracker: {
        restoreTurn: async (_sid: string, turn: number) => (calls.restoreTurn.push(turn), { restored: 1, failed: 0 }),
        dropTurnsFrom() {},
        settle: async () => undefined,
        checkpoints: () => opts.snapshots ?? [],
      },
      runner: {
        checkpoints: opts.git
          ? { exists: async () => opts.gitExists !== false, restoreWorkspace: async () => (calls.restoreWorkspace++, { ok: true, files: 2 }), dropFrom: async () => undefined }
          : undefined,
      },
      log: { warn() {} },
      broadcast: (m: any) => calls.broadcast.push(m),
      pushChanges() {},
      send: async (...args: any[]) => (calls.sent.push(args), ''),
    });
    return { c, s, calls, sink: { post: (m: any) => calls.posted.push(m) } };
  };

  test('Reset Chat on message 3 of 6 keeps the earlier turns, sends the edit and leaves the files alone', async () => {
    const t = make({ git: true });
    await t.c.handle({ type: 'editAndRegenerate', sessionId: 's1', index: 2, text: '  fix it properly ', images: ['aW1n'], attachments: ['src/a.ts', 'src/a.ts'], restoreWorkspace: false }, t.sink);
    assert.strictEqual(t.s.messages.length, 2, 'the edited message and everything after it are removed before the resend');
    assert.deepStrictEqual(t.calls.sent, [['s1', 'fix it properly', ['src/a.ts'], ['aW1n']]]);
    assert.strictEqual(t.calls.restoreWorkspace, 0);
    assert.deepStrictEqual(t.calls.restoreTurn, []);
    assert.ok(!t.calls.posted.some((m) => m.type === 'draft') && !t.calls.broadcast.some((m) => m.type === 'draft'), 'the composer is not refilled');
    assert.ok(!t.calls.broadcast.some((m) => m.type === 'toast'), 'no rewind toast on a successful edit');
  });

  test('Reset Code restores the checkpoint first; with no checkpoint it is refused and nothing is cut', async () => {
    const t = make({ git: true });
    await t.c.handle({ type: 'editAndRegenerate', sessionId: 's1', index: 2, text: 'again', restoreWorkspace: true }, t.sink);
    assert.strictEqual(t.calls.restoreWorkspace, 1);
    assert.strictEqual(t.s.messages.length, 2);
    assert.strictEqual(t.calls.sent[0][1], 'again');

    const none = make({ git: false, snapshots: [1] });
    await none.c.handle({ type: 'editAndRegenerate', sessionId: 's1', index: 2, text: 'again', restoreWorkspace: true }, none.sink);
    assert.strictEqual(none.s.messages.length, 6);
    assert.strictEqual(none.calls.sent.length, 0);
    assert.match(none.calls.broadcast.find((m) => m.type === 'toast')?.text ?? '', /No checkpoint/);
  });

  test('an empty edit is rejected without touching the chat', async () => {
    const t = make();
    await t.c.handle({ type: 'editAndRegenerate', sessionId: 's1', index: 2, text: '   ', images: [], restoreWorkspace: false }, t.sink);
    assert.strictEqual(t.s.messages.length, 6);
    assert.strictEqual(t.calls.sent.length, 0);
    assert.match(t.calls.broadcast.find((m) => m.type === 'toast')?.text ?? '', /empty/);
  });

  test('an edit that is not resent releases the inline editor (compaction running, target gone)', async () => {
    const t = make({ git: true });
    t.c.compacting = new Map([['s1', Promise.resolve()]]);
    await t.c.handle({ type: 'editAndRegenerate', sessionId: 's1', index: 2, text: 'again', restoreWorkspace: false }, t.sink);
    assert.strictEqual(t.s.messages.length, 6);
    assert.strictEqual(t.calls.sent.length, 0);
    assert.match(t.calls.broadcast.find((m) => m.type === 'toast')?.text ?? '', /compaction/);
    assert.deepStrictEqual(t.calls.posted, [{ type: 'editAndRegenerateResult', sessionId: 's1', index: 2, ok: false }]);

    const gone = make({ git: true });
    await gone.c.handle({ type: 'editAndRegenerate', sessionId: 's1', index: 1, text: 'again', restoreWorkspace: false }, gone.sink);
    assert.strictEqual(gone.calls.sent.length, 0);
    assert.deepStrictEqual(gone.calls.posted.filter((m) => m.type === 'editAndRegenerateResult'), [{ type: 'editAndRegenerateResult', sessionId: 's1', index: 1, ok: false }]);

    const ok = make({ git: true });
    await ok.c.handle({ type: 'editAndRegenerate', sessionId: 's1', index: 2, text: 'again', restoreWorkspace: false }, ok.sink);
    assert.ok(!ok.calls.posted.some((m) => m.type === 'editAndRegenerateResult'), 'a resent edit is not released by a result message');
  });

  test('checkpointExists answers from the git checkpoint or the file snapshots, with the editable draft', async () => {
    const git = make({ git: true });
    await git.c.handle({ type: 'checkpointExists', sessionId: 's1', index: 2 }, git.sink);
    assert.deepStrictEqual(git.calls.posted[0], { type: 'checkpointExistsResult', sessionId: 's1', index: 2, exists: true, text: 'fix it', attachments: ['src/a.ts'] });

    const gone = make({ git: true, gitExists: false, snapshots: [1] });
    await gone.c.handle({ type: 'checkpointExists', sessionId: 's1', index: 2 }, gone.sink);
    assert.strictEqual(gone.calls.posted[0].exists, false, 'a pruned ref and no later snapshots: nothing to restore');
    assert.ok(gone.calls.posted[0].reason);

    const snaps = make({ snapshots: [5] });
    await snaps.c.handle({ type: 'checkpointExists', sessionId: 's1', index: 2 }, snaps.sink);
    assert.strictEqual(snaps.calls.posted[0].exists, true, 'snapshots of a later turn are restorable from this one');

    const notUser = make();
    await notUser.c.handle({ type: 'checkpointExists', sessionId: 's1', index: 1 }, notUser.sink);
    assert.strictEqual(notUser.calls.posted[0].exists, false);
  });

  test('a git checkpoint exists while its ref or commit is in the repository', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lp-edit-'));
    const git = (...args: string[]) => cp.execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgSign=false', ...args], { cwd: dir, encoding: 'utf8' }).trim();
    try {
      git('init', '-q');
      git('config', 'core.autocrlf', 'false');
      fs.writeFileSync(path.join(dir, 'a.txt'), 'a\n');
      git('add', '.');
      git('commit', '-qm', 'init');
      fs.writeFileSync(path.join(dir, 'a.txt'), 'changed\n');
      const svc = new CheckpointService({ globalStorageDir: path.join(dir, '.storage'), enabled: () => true });
      const s: any = { id: 's_edit', messages: [] };
      const entry = await svc.snapshot(s, 7, dir);
      assert.ok(entry?.sha && entry.kind === 'stash');
      assert.strictEqual(await svc.exists(entry!), true);
      git('update-ref', '-d', entry!.ref!);
      assert.strictEqual(await svc.exists(entry!), true, 'the commit itself is still there');
      assert.strictEqual(await svc.exists({ ...entry!, ref: undefined, sha: '0'.repeat(40) }), false);
      assert.strictEqual(await svc.exists({ ...entry!, kind: 'files' }), false);
    } finally {
      removeTemp(dir);
    }
  });
});
