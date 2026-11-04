import * as assert from 'assert';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { checkpointChanges, checkpointFile, checkpointRef, CheckpointService, gitCheckpoint, parseNameStatus, relativeIn } from '../agent/checkpoints';
import { rewindAttachments } from '../ui/rewindDraft';
import { Session } from '../types';

const git = (cwd: string, ...args: string[]) =>
  cp.execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgSign=false', ...args], { cwd, encoding: 'utf8' }).trim();

const session = (id: string): Session => ({ id, title: 't', createdAt: 0, updatedAt: 0, model: '', mode: 'agent', messageCount: 0, messages: [], contextTokens: 0, compactions: 0, attachments: [] });

suite('checkpoint restore (pure)', () => {
  test('name-status parsing and change listing', () => {
    const ns = parseNameStatus('M\0a.txt\0D\0b.txt\0A\0c d.txt\0T\0e\0');
    assert.deepStrictEqual([...ns], [['a.txt', 'M'], ['b.txt', 'D'], ['c d.txt', 'A'], ['e', 'M']]);
    const changed = checkpointChanges(new Map([['a.txt', 'D']]), new Map([['u.txt', 'b1'], ['v.txt', 'b2'], ['w.txt', 'b3']]), ['u.txt', 'v.txt', 'x.txt'], new Map([['u.txt', 'b1'], ['v.txt', 'b9'], ['w.txt', undefined]]));
    assert.deepStrictEqual(changed, [
      { path: 'a.txt', status: 'D' },
      { path: 'v.txt', status: 'M' },
      { path: 'w.txt', status: 'D' },
      { path: 'x.txt', status: 'A' },
    ]);
  });

  test('only git checkpoints restore through git; paths stay inside the root', () => {
    const st = { history: [{ run: 1, createdAt: 0, kind: 'files' as const, outcome: 'skipped' as const }, { run: 2, createdAt: 0, kind: 'commit' as const, outcome: 'head_clean' as const, sha: 'abc', root: '/r' }] };
    assert.strictEqual(gitCheckpoint(st, 1), undefined);
    assert.strictEqual(gitCheckpoint(st, 2)?.sha, 'abc');
    assert.strictEqual(gitCheckpoint(undefined, 2), undefined);
    assert.strictEqual(relativeIn(path.resolve('/r'), path.resolve('/r/a/b.ts')), 'a/b.ts');
    assert.strictEqual(relativeIn(path.resolve('/r'), path.resolve('/x/b.ts')), undefined);
    assert.strictEqual(relativeIn(path.resolve('/r'), path.resolve('/r')), undefined);
  });

  test('a rewound message gets its attachments back', () => {
    const content =
      'fix it\n<attachment path="src/a.ts">\nx\n</attachment>\n<attachment path="b.ts" lines="3-9">\ny\n</attachment>' +
      '<attachment path="d.pdf" kind="pdf" pages="2-4 of 9">\nz\n</attachment><attachment path="e.pdf" kind="pdf" pages="1-3 of 3">\nz\n</attachment>' +
      '<directory path="lib">\nq\n</directory><workspace_tree root="/r">\nt\n</workspace_tree><problems>\nnone\n</problems><attachment path="src/a.ts">\nx\n</attachment>';
    assert.deepStrictEqual(rewindAttachments(content), ['src/a.ts', 'b.ts#L3-9', 'd.pdf#page=2-4', 'e.pdf', 'lib', '@workspace', '@problems']);
    assert.deepStrictEqual(rewindAttachments('no context'), []);
  });
});

suite('checkpoint restore (git)', function () {
  this.timeout(30_000);
  let tmp: string;
  let repo: string;
  let svc: CheckpointService;
  const read = (f: string) => fs.readFileSync(path.join(repo, f), 'utf8');
  const has = (f: string) => fs.existsSync(path.join(repo, f));

  setup(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lp-restore-'));
    repo = path.join(tmp, 'repo');
    fs.mkdirSync(repo);
    git(repo, 'init', '-q');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'A0\n');
    fs.writeFileSync(path.join(repo, '.gitignore'), 'ignored.log\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'init');
    svc = new CheckpointService({ globalStorageDir: path.join(tmp, 'global'), enabled: () => true });
  });

  teardown(() => fs.rmSync(tmp, { recursive: true, force: true }));

  test('files-only restore undoes what a shell command did, and keeps a safety stash', async () => {
    const s = session('s_cmd');
    await svc.snapshot(s, 1, repo);
    // The turn ran `rm a.txt && echo x > b.txt`.
    fs.rmSync(path.join(repo, 'a.txt'));
    fs.writeFileSync(path.join(repo, 'b.txt'), 'x\n');
    const entry = gitCheckpoint(s.checkpoints, 1)!;
    assert.deepStrictEqual(await svc.changedFiles(entry), [
      { path: 'a.txt', status: 'D' },
      { path: 'b.txt', status: 'A' },
    ]);
    const r = await svc.restoreWorkspace(entry);
    assert.ok(r.ok, r.error);
    assert.strictEqual(r.files, 2);
    assert.strictEqual(read('a.txt'), 'A0\n');
    assert.ok(!has('b.txt'));
    assert.ok(r.safetyStash);
    assert.match(git(repo, 'stash', 'list'), /localpilot pre-restore/);
    assert.strictEqual(git(repo, 'show', 'stash@{0}^3:b.txt'), 'x', 'the state before the restore is recoverable');
    assert.deepStrictEqual(await svc.changedFiles(entry), []);
  });

  test('dirty and untracked state at the checkpoint comes back; ignored files are left alone', async () => {
    fs.writeFileSync(path.join(repo, 'a.txt'), 'A1\n');
    fs.writeFileSync(path.join(repo, 'u.txt'), 'U0\n');
    const s = session('s_dirty');
    await svc.snapshot(s, 1, repo);
    fs.writeFileSync(path.join(repo, 'a.txt'), 'A2\n');
    fs.writeFileSync(path.join(repo, 'u.txt'), 'U1\n');
    fs.writeFileSync(path.join(repo, 'n.txt'), 'new\n');
    fs.writeFileSync(path.join(repo, 'ignored.log'), 'keep me\n');
    const entry = gitCheckpoint(s.checkpoints, 1)!;
    assert.deepStrictEqual(
      (await svc.changedFiles(entry)).map((f) => `${f.status} ${f.path}`),
      ['M a.txt', 'A n.txt', 'M u.txt']
    );
    assert.strictEqual(await checkpointFile(fs.realpathSync(repo), entry.sha!, entry.kind, path.join(fs.realpathSync(repo), 'u.txt')), 'U0\n', 'untracked content is read from the third parent');
    assert.strictEqual(await checkpointFile(fs.realpathSync(repo), entry.sha!, entry.kind, path.join(tmp, 'outside.txt')), '');
    const r = await svc.restoreWorkspace(entry);
    assert.ok(r.ok, r.error);
    assert.strictEqual(read('a.txt'), 'A1\n');
    assert.strictEqual(read('u.txt'), 'U0\n');
    assert.ok(!has('n.txt'));
    assert.strictEqual(read('ignored.log'), 'keep me\n');
    assert.deepStrictEqual(await svc.changedFiles(entry), []);
  });

  test('refuses when HEAD moved past the checkpoint, and changes nothing', async () => {
    const s = session('s_moved');
    await svc.snapshot(s, 1, repo);
    fs.writeFileSync(path.join(repo, 'a.txt'), 'committed\n');
    git(repo, 'commit', '-q', '-am', 'agent commit');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'dirty\n');
    const r = await svc.restoreWorkspace(gitCheckpoint(s.checkpoints, 1)!);
    assert.ok(!r.ok);
    assert.match(r.error ?? '', /HEAD moved since this checkpoint/);
    assert.strictEqual(read('a.txt'), 'dirty\n');
    assert.strictEqual(git(repo, 'stash', 'list'), '', 'no safety stash when nothing was restored');
  });

  test('a HEAD reset behind the checkpoint is moved forward again', async () => {
    fs.writeFileSync(path.join(repo, 'a.txt'), 'second\n');
    git(repo, 'commit', '-q', '-am', 'second');
    const s = session('s_behind');
    await svc.snapshot(s, 1, repo);
    git(repo, 'reset', '-q', '--hard', 'HEAD~1');
    const r = await svc.restoreWorkspace(gitCheckpoint(s.checkpoints, 1)!);
    assert.ok(r.ok, r.error);
    assert.strictEqual(read('a.txt'), 'second\n');
    assert.strictEqual(git(repo, 'log', '-1', '--format=%s'), 'second');
  });

  test('dropping later checkpoints deletes their refs', async () => {
    const s = session('s_drop');
    await svc.snapshot(s, 1, repo);
    await svc.snapshot(s, 2, repo);
    await svc.snapshot(s, 3, repo);
    await svc.dropFrom(s, 2);
    assert.deepStrictEqual(s.checkpoints?.history.map((e) => e.run), [1]);
    assert.strictEqual(s.checkpoints?.latest, 1);
    assert.deepStrictEqual(await svc.refs(s.id, repo), [checkpointRef(s.id, 1)]);
  });
});
