import * as assert from 'assert';
import * as cp from 'child_process';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { WorktreeManager } from '../agent/worktrees';

function git(args: string[], cwd: string): string {
  return cp.execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
}

function hasGit(): boolean {
  try {
    cp.execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** Fresh repo with one commit: README.md + src/app.ts, plus an uncommitted edit and an untracked file. */
async function makeRepo(): Promise<string> {
  const repo = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'lp-repo-')));
  git(['init', '-q', '-b', 'main'], repo);
  await fs.mkdir(path.join(repo, 'src'));
  await fs.writeFile(path.join(repo, 'README.md'), '# Demo\n');
  await fs.writeFile(path.join(repo, 'src', 'app.ts'), 'export const a = 1;\nexport const b = 2;\nexport const c = 3;\n');
  git(['add', '-A'], repo);
  git(['commit', '-q', '-m', 'init'], repo);
  await fs.writeFile(path.join(repo, 'README.md'), '# Demo\n\nWork in progress.\n');
  await fs.writeFile(path.join(repo, 'untracked.txt'), 'scratch\n');
  return repo;
}

suite('WorktreeManager (isolated agent checkouts)', function () {
  this.timeout(60_000);
  let home = '';
  let repo = '';
  let mgr: WorktreeManager;

  suiteSetup(async function () {
    if (!hasGit()) {
      this.skip();
    }
    home = await fs.mkdtemp(path.join(os.tmpdir(), 'lp-wt-home-'));
    mgr = new WorktreeManager(home);
  });
  setup(async () => {
    repo = await makeRepo();
  });
  teardown(async () => {
    await fs.rm(repo, { recursive: true, force: true }).catch(() => undefined);
  });
  suiteTeardown(async () => {
    await fs.rm(home, { recursive: true, force: true }).catch(() => undefined);
  });

  test('repoRoot resolves the repository from a subfolder and is undefined outside git', async () => {
    assert.strictEqual(await mgr.repoRoot(path.join(repo, 'src')), repo);
    const plain = await fs.mkdtemp(path.join(os.tmpdir(), 'lp-plain-'));
    try {
      assert.strictEqual(await mgr.repoRoot(plain), undefined);
    } finally {
      await fs.rm(plain, { recursive: true, force: true });
    }
    assert.ok(mgr.dirFor(repo).startsWith(home), 'worktrees live under the manager home, outside the repo');
    assert.notStrictEqual(mgr.dirFor(repo), mgr.dirFor(repo + 'x'), 'different repos hash to different folders');
  });

  test('create seeds the worktree with committed + uncommitted + untracked state and records a base; changes() starts empty', async () => {
    const progress: string[] = [];
    const wt = await mgr.create(repo, 'session-1', { progress: (t) => progress.push(t) });
    try {
      assert.ok(wt.path.startsWith(home) && !wt.path.startsWith(repo), 'outside the repository');
      assert.strictEqual(wt.repo, repo);
      assert.ok(/^[0-9a-f]{40}$/.test(wt.base));
      assert.ok(progress.some((p) => /isolated copy/.test(p)));
      assert.strictEqual(await fs.readFile(path.join(wt.path, 'README.md'), 'utf8'), '# Demo\n\nWork in progress.\n', 'uncommitted edit carried over');
      assert.strictEqual(await fs.readFile(path.join(wt.path, 'untracked.txt'), 'utf8'), 'scratch\n', 'untracked file carried over');
      assert.strictEqual(await fs.readFile(path.join(wt.path, 'src', 'app.ts'), 'utf8'), 'export const a = 1;\nexport const b = 2;\nexport const c = 3;\n');
      assert.deepStrictEqual(await mgr.changes(wt), [], 'the seeded state is the base, not a change');
      assert.strictEqual(await mgr.baseContent(wt, 'README.md'), '# Demo\n\nWork in progress.\n');
      assert.strictEqual(await mgr.baseContent(wt, 'nope.txt'), '');
      const listed = await mgr.list(repo);
      assert.deepStrictEqual(listed.map((l) => l.id), ['session-1']);
      assert.strictEqual(listed[0].info.base, wt.base);
      // Creating again for the same id replaces the old worktree instead of failing.
      await fs.writeFile(path.join(wt.path, 'junk.txt'), 'x');
      const again = await mgr.create(repo, 'session-1');
      assert.strictEqual(again.path, wt.path);
      await assert.rejects(fs.stat(path.join(again.path, 'junk.txt')), 'fresh copy');
    } finally {
      await mgr.remove(wt);
    }
  });

  test('changes() classifies creates, modifies, deletes and renames with line counts', async () => {
    const wt = await mgr.create(repo, 'session-2');
    try {
      await fs.writeFile(path.join(wt.path, 'src', 'app.ts'), 'export const a = 10;\nexport const b = 2;\nexport const c = 3;\nexport const d = 4;\n');
      await fs.writeFile(path.join(wt.path, 'src', 'new.ts'), 'export const n = 1;\n');
      await fs.rm(path.join(wt.path, 'untracked.txt'));
      await fs.rename(path.join(wt.path, 'README.md'), path.join(wt.path, 'READ.md'));
      const ch = await mgr.changes(wt);
      const by = Object.fromEntries(ch.map((c) => [c.path, c]));
      assert.strictEqual(by['src/app.ts'].kind, 'modify');
      assert.deepStrictEqual([by['src/app.ts'].added, by['src/app.ts'].removed], [2, 1]);
      assert.strictEqual(by['src/new.ts'].kind, 'create');
      assert.strictEqual(by['src/new.ts'].added, 1);
      assert.strictEqual(by['untracked.txt'].kind, 'delete');
      assert.strictEqual(by['READ.md'].kind, 'rename');
      assert.strictEqual(by['READ.md'].from, 'README.md');
      assert.strictEqual(Object.keys(by).length, 4);
      const patch = (await mgr.patch(wt)).toString('utf8');
      assert.match(patch, /^diff --git a\/src\/app\.ts b\/src\/app\.ts/m);
      assert.match(patch, /rename from README\.md/);
    } finally {
      await mgr.remove(wt);
    }
  });

  test('apply brings clean changes onto the main checkout as uncommitted edits and rebase resets the base', async () => {
    const wt = await mgr.create(repo, 'session-3');
    try {
      await fs.writeFile(path.join(wt.path, 'src', 'app.ts'), 'export const a = 1;\nexport const b = 2;\nexport const c = 3;\nexport const d = 4;\n');
      await fs.writeFile(path.join(wt.path, 'src', 'new.ts'), 'export const n = 1;\n');
      const snapshots: string[] = [];
      const res = await mgr.apply(wt, async (p) => {
        snapshots.push(path.relative(repo, p));
      });
      assert.deepStrictEqual(res.conflicts, []);
      assert.deepStrictEqual(res.files.map((f) => f.path).sort(), ['src/app.ts', 'src/new.ts']);
      assert.deepStrictEqual(snapshots.sort(), ['src/app.ts', 'src/new.ts'], 'beforeWrite sees every touched main-checkout path');
      assert.match(await fs.readFile(path.join(repo, 'src', 'app.ts'), 'utf8'), /export const d = 4;/);
      assert.strictEqual(await fs.readFile(path.join(repo, 'src', 'new.ts'), 'utf8'), 'export const n = 1;\n');
      assert.strictEqual(await fs.readFile(path.join(repo, 'README.md'), 'utf8'), '# Demo\n\nWork in progress.\n', 'untouched files keep the user\'s WIP');
      assert.ok(wt.appliedAt);
      const status = git(['status', '--porcelain'], repo);
      assert.match(status, /^ M src\/app\.ts$/m, 'applied as an unstaged modification');
      assert.match(status, /^\?\? src\/new\.ts$/m, 'new files stay untracked, nothing is committed');
      assert.strictEqual(git(['log', '--oneline'], repo).trim().split('\n').length, 1);

      const before = wt.base;
      await mgr.rebase(wt);
      assert.notStrictEqual(wt.base, before);
      assert.deepStrictEqual(await mgr.changes(wt), [], 'after rebase the applied work is the new base');
      assert.strictEqual((await mgr.list(repo))[0].info.base, wt.base, 'bookkeeping follows the new base');
    } finally {
      await mgr.remove(wt);
    }
  });

  test('apply falls back to a 3-way merge and reports conflicts instead of giving up', async () => {
    const wt = await mgr.create(repo, 'session-4');
    try {
      // Agent and user both change the same line.
      await fs.writeFile(path.join(wt.path, 'src', 'app.ts'), 'export const a = 100;\nexport const b = 2;\nexport const c = 3;\n');
      await fs.writeFile(path.join(repo, 'src', 'app.ts'), 'export const a = 200;\nexport const b = 2;\nexport const c = 3;\n');
      const res = await mgr.apply(wt);
      assert.deepStrictEqual(res.conflicts, ['src/app.ts']);
      const merged = await fs.readFile(path.join(repo, 'src', 'app.ts'), 'utf8');
      assert.match(merged, /<<<<<<< /, 'conflict markers left for the merge editor');
      assert.match(merged, /a = 100/);
      assert.match(merged, /a = 200/);
    } finally {
      await mgr.remove(wt);
    }
  });

  test('apply merges non-overlapping edits to the same file the user changed meanwhile', async () => {
    const wt = await mgr.create(repo, 'session-5');
    try {
      await fs.writeFile(path.join(wt.path, 'src', 'app.ts'), 'export const a = 1;\nexport const b = 2;\nexport const c = 30;\n');
      await fs.writeFile(path.join(repo, 'src', 'app.ts'), 'export const a = 10;\nexport const b = 2;\nexport const c = 3;\n');
      const res = await mgr.apply(wt);
      assert.deepStrictEqual(res.conflicts, []);
      assert.strictEqual(await fs.readFile(path.join(repo, 'src', 'app.ts'), 'utf8'), 'export const a = 10;\nexport const b = 2;\nexport const c = 30;\n');
      assert.doesNotMatch(git(['status', '--porcelain'], repo), /^M  /m, 'nothing left staged after a clean 3-way merge');
    } finally {
      await mgr.remove(wt);
    }
  });

  test('setup commands from .localpilot/worktrees.json run inside the new worktree and failures do not abort', async () => {
    await fs.mkdir(path.join(repo, '.localpilot'), { recursive: true });
    const marker = process.platform === 'win32' ? 'echo ok> setup-ran.txt' : 'echo ok > setup-ran.txt';
    await fs.writeFile(path.join(repo, '.localpilot', 'worktrees.json'), JSON.stringify({ setup: [marker, 'definitely-not-a-command-xyz'] }));
    assert.deepStrictEqual(mgr.readSetup(repo)?.setup?.length, 2);
    assert.strictEqual(mgr.readSetup(os.tmpdir()), undefined);
    const progress: string[] = [];
    const wt = await mgr.create(repo, 'session-6', { progress: (t) => progress.push(t), setupTimeoutMs: 20_000 });
    try {
      assert.match((await fs.readFile(path.join(wt.path, 'setup-ran.txt'), 'utf8')).trim(), /^ok/);
      assert.ok(progress.some((p) => /Setup command failed \(continuing\)/.test(p)), progress.join('\n'));
      assert.deepStrictEqual(await mgr.changes(wt), [], 'setup output is part of the base, not an agent change');
    } finally {
      await mgr.remove(wt);
    }
  });

  test('remove is idempotent and prune drops worktrees whose session is gone', async () => {
    const a = await mgr.create(repo, 'keep-me');
    const b = await mgr.create(repo, 'gone');
    assert.deepStrictEqual((await mgr.list(repo)).map((l) => l.id).sort(), ['gone', 'keep-me']);
    assert.strictEqual(await mgr.prune(repo, new Set(['keep-me'])), 1);
    assert.deepStrictEqual((await mgr.list(repo)).map((l) => l.id), ['keep-me']);
    await assert.rejects(fs.stat(b.path));
    assert.doesNotMatch(git(['worktree', 'list'], repo), /gone/);
    await mgr.remove(a);
    await mgr.remove(a);
    assert.deepStrictEqual(await mgr.list(repo), []);
    assert.deepStrictEqual(await mgr.changes(a), [], 'changes() on a removed worktree is empty, not an error');
  });

  test('an empty repository (no commits) still gets an isolated worktree', async () => {
    const empty = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'lp-empty-')));
    try {
      git(['init', '-q', '-b', 'main'], empty);
      await fs.writeFile(path.join(empty, 'first.txt'), 'hello\n');
      const wt = await mgr.create(empty, 'fresh');
      try {
        assert.strictEqual(await fs.readFile(path.join(wt.path, 'first.txt'), 'utf8'), 'hello\n', 'untracked files carried over');
        await fs.writeFile(path.join(wt.path, 'second.txt'), 'x\n');
        assert.deepStrictEqual((await mgr.changes(wt)).map((c) => [c.path, c.kind]), [['second.txt', 'create']]);
      } finally {
        await mgr.remove(wt);
      }
    } finally {
      await fs.rm(empty, { recursive: true, force: true });
    }
  });
});
