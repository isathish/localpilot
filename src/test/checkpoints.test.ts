import * as assert from 'assert';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { ChangeTracker } from '../agent/changeTracker';
import { checkpointRef, CheckpointService, isOrphanCheckpoint, pickOutcome, pruneSnapshotDirs, recordCheckpoint, refSafe, scratchKey, SessionCheckpoints } from '../agent/checkpoints';
import { Session } from '../types';

const git = (cwd: string, ...args: string[]) =>
  cp.execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgSign=false', ...args], { cwd, encoding: 'utf8' }).trim();

const session = (id: string): Session => ({ id, title: 't', createdAt: 0, updatedAt: 0, model: '', mode: 'agent', messageCount: 0, messages: [], contextTokens: 0, compactions: 0, attachments: [] });

suite('checkpoints (pure)', () => {
  test('ref names are per session and run, and ref-safe', () => {
    assert.strictEqual(checkpointRef('s_abc123', 1712), 'refs/localpilot/checkpoints/s_abc123/1712');
    assert.strictEqual(checkpointRef('s_abc::worker 1', 3), 'refs/localpilot/checkpoints/s_abc/3');
    assert.strictEqual(refSafe('a b/c..d'), 'a_b_c__d');
    assert.strictEqual(scratchKey('/repo', 's_1').length, 32);
    assert.notStrictEqual(scratchKey('/repo', 's_1'), scratchKey('/other', 's_1'));
  });

  test('outcome selection', () => {
    assert.deepStrictEqual(pickOutcome({}), { outcome: 'skipped', kind: 'files' });
    assert.deepStrictEqual(pickOutcome({ head: 'h' }), { outcome: 'head_clean', sha: 'h', kind: 'commit' });
    assert.deepStrictEqual(pickOutcome({ head: 'h', stash: 's' }), { outcome: 'stash', sha: 's', kind: 'stash' });
    assert.deepStrictEqual(pickOutcome({ head: 'h', stashFailed: true }), { outcome: 'head_fallback', sha: 'h', kind: 'commit' });
  });

  test('history keeps one entry per run, newest last, capped', () => {
    const st: SessionCheckpoints = { history: [] };
    for (let i = 1; i <= 5; i++) {
      recordCheckpoint(st, { run: i, createdAt: i, kind: 'commit', outcome: 'head_clean' }, 3);
    }
    assert.deepStrictEqual(st.history.map((e) => e.run), [3, 4, 5]);
    const dropped = recordCheckpoint(st, { run: 4, createdAt: 9, kind: 'stash', outcome: 'stash' }, 3);
    assert.strictEqual(dropped.length, 0);
    assert.strictEqual(st.history.find((e) => e.run === 4)?.kind, 'stash');
    assert.strictEqual(st.latest, 5);
  });

  test('orphans: only chats older than the retention, and VS Code chats only when missing from the store', () => {
    const now = Date.now();
    const old = (now - 20 * 86_400_000).toString(36);
    const fresh = (now - 1_000).toString(36);
    assert.ok(isOrphanCheckpoint(`cli-${old}`, undefined, now));
    assert.ok(!isOrphanCheckpoint(`cli-${fresh}`, undefined, now));
    assert.ok(isOrphanCheckpoint(`s_${old}ab12`, new Set(), now));
    assert.ok(!isOrphanCheckpoint(`s_${old}ab12`, new Set([`s_${old}ab12`]), now));
    assert.ok(!isOrphanCheckpoint(`s_${old}ab12`, undefined, now), 'the CLI never prunes VS Code chats');
    assert.ok(!isOrphanCheckpoint(`s_${fresh}ab12`, new Set(), now));
  });
});

suite('checkpoints (git)', function () {
  this.timeout(30_000);
  let tmp: string;
  let repo: string;
  let svc: CheckpointService;
  let enabled = true;

  setup(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lp-ckpt-'));
    repo = path.join(tmp, 'repo');
    fs.mkdirSync(repo);
    git(repo, 'init', '-q');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'A0\n');
    fs.writeFileSync(path.join(repo, '.gitignore'), 'ignored.log\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'init');
    enabled = true;
    svc = new CheckpointService({ globalStorageDir: path.join(tmp, 'global'), enabled: () => enabled });
  });

  teardown(() => fs.rmSync(tmp, { recursive: true, force: true }));

  test('clean tree records HEAD', async () => {
    const s = session('s_clean');
    const e = await svc.snapshot(s, 1, repo);
    assert.strictEqual(e?.outcome, 'head_clean');
    assert.strictEqual(e?.kind, 'commit');
    assert.strictEqual(git(repo, 'rev-parse', checkpointRef(s.id, 1)), git(repo, 'rev-parse', 'HEAD'));
    assert.strictEqual(s.checkpoints?.latest, 1);
  });

  test('dirty tree becomes a stash commit without touching git stash list or the index', async () => {
    fs.writeFileSync(path.join(repo, 'a.txt'), 'A1\n');
    const s = session('s_dirty');
    const e = await svc.snapshot(s, 2, repo);
    assert.strictEqual(e?.outcome, 'stash');
    assert.strictEqual(git(repo, 'show', `${checkpointRef(s.id, 2)}:a.txt`), 'A1');
    assert.strictEqual(git(repo, 'stash', 'list'), '');
    assert.strictEqual(git(repo, 'diff', '--cached', '--name-only'), '');
    assert.strictEqual(fs.readFileSync(path.join(repo, 'a.txt'), 'utf8'), 'A1\n', 'the working tree is left as it was');
  });

  test('untracked files are attached as a third parent; ignored files are not', async () => {
    fs.writeFileSync(path.join(repo, 'new.txt'), 'made by a shell command\n');
    fs.writeFileSync(path.join(repo, 'ignored.log'), 'noise\n');
    const s = session('s_untracked');
    const e = await svc.snapshot(s, 3, repo);
    assert.strictEqual(e?.outcome, 'stash');
    const ref = checkpointRef(s.id, 3);
    assert.strictEqual(git(repo, 'show', `${ref}^3:new.txt`), 'made by a shell command');
    assert.throws(() => git(repo, 'show', `${ref}^3:ignored.log`));
    assert.strictEqual(git(repo, 'stash', 'list'), '');
    assert.strictEqual(git(repo, 'status', '--porcelain', '--untracked-files=all'), '?? new.txt', 'the real index is untouched');
  });

  test('dirty and untracked together keep both', async () => {
    fs.writeFileSync(path.join(repo, 'a.txt'), 'A2\n');
    fs.writeFileSync(path.join(repo, 'b.txt'), 'B\n');
    const s = session('s_both');
    await svc.snapshot(s, 4, repo);
    const ref = checkpointRef(s.id, 4);
    assert.strictEqual(git(repo, 'show', `${ref}:a.txt`), 'A2');
    assert.strictEqual(git(repo, 'show', `${ref}^3:b.txt`), 'B');
  });

  test('deleting the session removes its refs and scratch folder', async () => {
    fs.writeFileSync(path.join(repo, 'c.txt'), 'C\n');
    const s = session('s_gone');
    await svc.snapshot(s, 1, repo);
    await svc.snapshot(s, 2, repo);
    assert.strictEqual((await svc.refs(s.id, repo)).length, 2);
    assert.ok(fs.existsSync(path.join(tmp, 'global', 'checkpoint-scratch', scratchKey(fs.realpathSync(repo), s.id))));
    await svc.deleteSession(s.id);
    assert.strictEqual((await svc.refs(s.id, repo)).length, 0);
    assert.ok(!fs.existsSync(path.join(tmp, 'global', 'checkpoint-scratch', scratchKey(fs.realpathSync(repo), s.id))));
  });

  test('non-git folder falls back to file snapshots; disabled records nothing', async () => {
    const plain = path.join(tmp, 'plain');
    fs.mkdirSync(plain);
    const s = session('s_plain');
    const e = await svc.snapshot(s, 1, plain);
    assert.strictEqual(e?.outcome, 'skipped');
    assert.strictEqual(e?.kind, 'files');
    enabled = false;
    assert.strictEqual(await svc.snapshot(s, 2, repo), undefined);
    assert.strictEqual(s.checkpoints?.history.length, 1);
  });

  test('stale scratch folders and orphaned snapshot folders are pruned', () => {
    const dir = path.join(tmp, 'global', 'checkpoint-scratch', 'x');
    fs.mkdirSync(dir, { recursive: true });
    assert.strictEqual(svc.pruneScratch(14 * 86_400_000, Date.now() + 15 * 86_400_000), 1);
    const snaps = path.join(tmp, 'snaps');
    fs.mkdirSync(path.join(snaps, 'gone'), { recursive: true });
    fs.mkdirSync(path.join(snaps, 'kept'), { recursive: true });
    assert.strictEqual(pruneSnapshotDirs(snaps, (sid) => sid === 'gone'), 1);
    assert.deepStrictEqual(fs.readdirSync(snaps), ['kept']);
  });
});

suite('checkpoints (persisted file snapshots)', () => {
  test('turn snapshots survive a new tracker (reload) and are dropped by forget', async () => {
    const root = vscode.workspace.workspaceFolders![0].uri.fsPath;
    const dir = fs.mkdtempSync(path.join(root, '.lp-ckpt-'));
    const store = fs.mkdtempSync(path.join(os.tmpdir(), 'lp-ckpt-store-'));
    const log = vscode.window.createOutputChannel('lp-ckpt-test', { log: true });
    const sid = 's_persist';
    const f = path.join(dir, 'p.txt');
    try {
      fs.writeFileSync(f, 'P0');
      const t1 = new ChangeTracker(log);
      t1.persistDir = store;
      t1.beginTurn(sid, 7);
      await t1.beforeChange(f, sid);
      fs.writeFileSync(f, 'P1');
      t1.dispose();

      const t2 = new ChangeTracker(log);
      t2.persistDir = store;
      assert.deepStrictEqual(t2.checkpoints(sid), [7]);
      assert.strictEqual(await t2.restoreToTurn(sid, 7), 1);
      assert.strictEqual(fs.readFileSync(f, 'utf8'), 'P0');
      assert.deepStrictEqual(t2.checkpoints(sid), []);
      assert.ok(!fs.existsSync(path.join(store, sid, '7.json')), 'a restored turn is gone from disk too');

      t2.beginTurn(sid, 8);
      await t2.beforeChange(f, sid);
      assert.ok(fs.existsSync(path.join(store, sid, '8.json')));
      t2.forget(sid);
      await new Promise((r) => setTimeout(r, 200));
      assert.ok(!fs.existsSync(path.join(store, sid)));
      t2.dispose();
    } finally {
      log.dispose();
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(store, { recursive: true, force: true });
    }
  });
});
