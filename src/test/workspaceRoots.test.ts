import * as assert from 'assert';
import * as fs from 'fs/promises';
import { existsSync } from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { formatRootsOverview, resolveRootPath, splitRootPrefix } from '../tools/rootPaths';
import { excludedBy, ignoreFor, IgnoreMatcher, invalidateIgnore, loadIgnore, parseIgnoreRules } from '../agent/ignoreFile';
import { editFileTool, listDirTool, readFileTool, writeFileTool } from '../tools/fs';
import { fileSearchTool, grepSearchTool } from '../tools/search';
import { applyPatchTool } from '../tools/applyPatchTool';
import { ToolContext } from '../types';

const ctx = (workspaceRoot?: string): ToolContext =>
  ({
    sessionId: 'test',
    workspaceRoot,
    signal: new AbortController().signal,
    depth: 0,
    requestApproval: async () => true,
    progress() {},
    trackChange: async () => undefined,
  }) as unknown as ToolContext;

suite('Multi-root path resolution', () => {
  let tmp = '';
  let roots: { name: string; path: string }[] = [];
  suiteSetup(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'lp-roots-'));
    roots = ['web', 'backend', 'docs'].map((name) => ({ name, path: path.join(tmp, name) }));
    for (const r of roots) {
      await fs.mkdir(path.join(r.path, 'src'), { recursive: true });
    }
    await fs.writeFile(path.join(tmp, 'web', 'src', 'app.ts'), '');
    await fs.writeFile(path.join(tmp, 'backend', 'src', 'x.ts'), '');
    await fs.writeFile(path.join(tmp, 'backend', 'src', 'both.ts'), '');
    await fs.writeFile(path.join(tmp, 'docs', 'src', 'both.ts'), '');
  });
  suiteTeardown(() => fs.rm(tmp, { recursive: true, force: true }));
  const resolve = (p: string) => resolveRootPath(p, roots[0].path, roots, existsSync);

  test('name:rel resolves against the named root (also name:/rel), drive letters are not names', () => {
    assert.deepStrictEqual(resolve('backend:src/x.ts'), { abs: path.join(tmp, 'backend', 'src', 'x.ts'), root: roots[1] });
    assert.strictEqual((resolve('backend:/src/x.ts') as { abs: string }).abs, path.join(tmp, 'backend', 'src', 'x.ts'));
    assert.strictEqual(splitRootPrefix('C:\\x\\y.ts', [{ name: 'C', path: '/c' }]), undefined);
    assert.strictEqual(splitRootPrefix('unknown:src/a.ts', roots), undefined);
  });

  test('a bare path in the primary stays there; in exactly one other root it resolves there with a note', () => {
    assert.deepStrictEqual(resolve('src/app.ts'), { abs: path.join(roots[0].path, 'src', 'app.ts') });
    const r = resolve('src/x.ts') as { abs: string; note?: string };
    assert.strictEqual(r.abs, path.join(tmp, 'backend', 'src', 'x.ts'));
    assert.match(r.note ?? '', /backend:src\/x\.ts/);
    assert.strictEqual((resolve('backend/src/x.ts') as { abs: string }).abs, path.join(tmp, 'backend', 'src', 'x.ts'), 'asRelativePath form');
    assert.deepStrictEqual(resolveRootPath('src/x.ts', roots[0].path, roots, existsSync, true), { abs: path.join(roots[0].path, 'src', 'x.ts') }, 'a file to create stays in the primary');
    assert.strictEqual((resolveRootPath('backend:src/y.ts', roots[0].path, roots, existsSync, true) as { abs: string }).abs, path.join(tmp, 'backend', 'src', 'y.ts'));
  });

  test('a bare path in several other roots is an error naming the candidates; a new file stays in the primary', () => {
    const r = resolve('src/both.ts') as { error?: string };
    assert.match(r.error ?? '', /backend:src\/both\.ts, docs:src\/both\.ts/);
    assert.deepStrictEqual(resolve('src/new.ts'), { abs: path.join(roots[0].path, 'src', 'new.ts') });
    assert.deepStrictEqual(resolveRootPath('src/x.ts', roots[0].path, [roots[0]], existsSync), { abs: path.join(roots[0].path, 'src', 'x.ts') }, 'single root: no lookup');
  });

  test('the overview lists name, path and git branch@sha', () => {
    assert.strictEqual(formatRootsOverview([{ name: 'web', path: '/w', git: { branch: 'main', sha: 'abc1234' } }, { name: 'notes', path: '/n' }]), 'web — /w — git main@abc1234\nnotes — /n');
  });
  // The agent's root is a temporary folder; the test workspace folder is the second root it reaches.
  suite('tools across two roots', () => {
    const ws = (): string => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
    const dirName = `roots-tools-${Date.now()}`;
    let primary = '';
    suiteSetup(async () => {
      assert.ok(ws(), 'tests need a workspace folder');
      primary = await fs.mkdtemp(path.join(os.tmpdir(), 'lp-primary-'));
      await fs.mkdir(path.join(primary, dirName, 'src'), { recursive: true });
      await fs.mkdir(path.join(ws(), dirName, 'src'), { recursive: true });
      await fs.writeFile(path.join(primary, dirName, 'src', 'a.ts'), 'const a = "needle-roots";\n');
      await fs.writeFile(path.join(ws(), dirName, 'src', 'b.ts'), 'const b = "needle-roots";\n');
      await fs.writeFile(path.join(ws(), dirName, 'other.md'), 'needle-roots\n');
      await fs.writeFile(path.join(ws(), dirName, 'src', 'dup.ts'), 'other folder\n');
      await fs.writeFile(path.join(ws(), dirName, 'src', 'edit.ts'), 'before\n');
    });
    suiteTeardown(async () => {
      await fs.rm(path.join(ws(), dirName), { recursive: true, force: true });
      await fs.rm(primary, { recursive: true, force: true });
    });

    test('grep_search finds hits in both roots, also with a path-scoped include_pattern; read_file opens them', async () => {
      const otherHit = path.join(path.relative(primary, ws()), dirName, 'src', 'b.ts');
      for (const include of [undefined, `${dirName}/src/**/*.ts`]) {
        const r = await grepSearchTool.execute({ query: 'needle-roots', include_pattern: include }, ctx(primary));
        assert.ok(!r.isError, r.content);
        const lines = r.content.split('\n');
        assert.ok(lines.some((l) => l.startsWith(`${path.join(dirName, 'src', 'a.ts')}:1:`)), `${include}: ${r.content}`);
        assert.ok(lines.some((l) => l.startsWith(`${otherHit}:1:`)), `${include}: ${r.content}`);
        assert.strictEqual(lines.some((l) => l.includes(path.join(dirName, 'other.md'))), !include, `${include}: ${r.content}`);
      }
      const read = await readFileTool.execute({ path: otherHit }, ctx(primary));
      assert.ok(!read.isError && read.content.includes('const b'), read.content);
    });

    test('write_file and apply_patch add keep a bare path in the primary; edit_file in another root says so', async () => {
      const dup = `${dirName}/src/dup.ts`;
      const w = await writeFileTool.execute({ path: dup, content: 'primary\n' }, ctx(primary));
      assert.ok(!w.isError, w.content);
      assert.strictEqual(await fs.readFile(path.join(primary, dup), 'utf8'), 'primary\n');
      assert.strictEqual(await fs.readFile(path.join(ws(), dup), 'utf8'), 'other folder\n', 'the other folder is untouched');

      const added = `${dirName}/src/added.ts`;
      await fs.writeFile(path.join(ws(), added), 'other folder\n');
      const p = await applyPatchTool.execute({ input: `*** Begin Patch\n*** Add File: ${added}\n+new\n*** End Patch` }, ctx(primary));
      assert.ok(!p.isError, p.content);
      assert.strictEqual(await fs.readFile(path.join(primary, added), 'utf8'), 'new\n');
      assert.strictEqual(await fs.readFile(path.join(ws(), added), 'utf8'), 'other folder\n');

      const e = await editFileTool.execute({ path: `${dirName}/src/edit.ts`, old_text: 'before', new_text: 'after' }, ctx(primary));
      assert.ok(!e.isError, e.content);
      assert.match(e.content, /is not in the primary folder; using workspace folder/);
      assert.strictEqual(await fs.readFile(path.join(ws(), dirName, 'src', 'edit.ts'), 'utf8'), 'after\n');
    });
  });
});

suite('Agent ignore file', () => {
  test('gitignore syntax: comments, negation, folders, anchoring, last rule wins', () => {
    const m = new IgnoreMatcher(parseIgnoreRules('# secrets\n*.env\n!sample.env\nbuild/\n/top.txt\ndocs/private/**\n\\#hash\n', '.localpilotignore'));
    assert.strictEqual(m.match('a/b/prod.env'), '.localpilotignore');
    assert.strictEqual(m.match('sample.env'), undefined);
    assert.strictEqual(m.match('build/out.js'), '.localpilotignore', 'a file inside an excluded folder');
    assert.strictEqual(m.match('build', false), undefined, 'build/ only matches folders');
    assert.strictEqual(m.match('build', true), '.localpilotignore');
    assert.strictEqual(m.match('top.txt'), '.localpilotignore');
    assert.strictEqual(m.match('sub/top.txt'), undefined, 'a leading / anchors to the folder');
    assert.strictEqual(m.match('docs/private/a/b.md'), '.localpilotignore');
    assert.strictEqual(m.match('#hash'), '.localpilotignore');
    assert.strictEqual(m.match('../outside.env'), undefined);
  });

  test('!include pulls in another file; .clineignore and .cursorignore are read too', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lp-ignore-'));
    try {
      await fs.writeFile(path.join(dir, '.localpilotignore'), '!include .gitignore\n!keep.log\n');
      await fs.writeFile(path.join(dir, '.gitignore'), '*.log\n');
      await fs.writeFile(path.join(dir, '.cursorignore'), 'vendor/\n');
      const m = loadIgnore(dir);
      assert.strictEqual(m.match('x/debug.log'), '.localpilotignore');
      assert.strictEqual(m.match('keep.log'), undefined);
      assert.strictEqual(m.match('vendor/lib.js'), '.cursorignore');
      assert.strictEqual(excludedBy(path.join(dir, 'a.log'), [dir]), '.localpilotignore');
      await fs.writeFile(path.join(dir, '.localpilotignore'), 'other.txt\n');
      invalidateIgnore();
      assert.strictEqual(ignoreFor(dir).match('x/debug.log'), undefined, 'reloaded after a change');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  suite('file tools', () => {
    const root = (): string => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
    const dirName = `ignore-tools-${Date.now()}`;
    const ignoreFile = () => path.join(root(), '.localpilotignore');
    let previous: string | undefined;
    suiteSetup(async () => {
      assert.ok(root(), 'tests need a workspace folder');
      previous = await fs.readFile(ignoreFile(), 'utf8').catch(() => undefined);
      await fs.mkdir(path.join(root(), dirName), { recursive: true });
      await fs.writeFile(path.join(root(), dirName, 'secret.txt'), 'needle-secret\n');
      await fs.writeFile(path.join(root(), dirName, 'open.txt'), 'needle-open\n');
      await fs.writeFile(ignoreFile(), `${previous ?? ''}\n${dirName}/secret.txt\n`);
      invalidateIgnore();
    });
    suiteTeardown(async () => {
      await fs.rm(path.join(root(), dirName), { recursive: true, force: true });
      await (previous === undefined ? fs.rm(ignoreFile(), { force: true }) : fs.writeFile(ignoreFile(), previous));
      invalidateIgnore();
    });

    test('read_file, write_file and edit_file refuse excluded files', async () => {
      const p = `${dirName}/secret.txt`;
      for (const [tool, args] of [
        [readFileTool, { path: p }],
        [writeFileTool, { path: p, content: 'x' }],
        [editFileTool, { path: p, old_text: 'needle', new_text: 'x' }],
      ] as const) {
        const r = await tool.execute(args, ctx());
        assert.ok(r.isError, tool.definition.name);
        assert.match(r.content, /is excluded by \.localpilotignore/);
      }
      assert.strictEqual(await fs.readFile(path.join(root(), p), 'utf8'), 'needle-secret\n', 'nothing was changed');
      assert.ok(!(await readFileTool.execute({ path: `${dirName}/open.txt` }, ctx())).isError);
    });

    test('list_dir lock-marks, file_search and grep_search omit excluded files', async () => {
      const list = await listDirTool.execute({ path: dirName }, ctx());
      assert.match(list.content, /secret\.txt 🔒/);
      assert.match(list.content, /^open\.txt$/m);
      const files = await fileSearchTool.execute({ pattern: `${dirName}/*.txt` }, ctx());
      assert.ok(files.content.includes('open.txt') && !files.content.includes('secret.txt'), files.content);
      const grep = await grepSearchTool.execute({ query: 'needle-', include_pattern: `${dirName}/**` }, ctx());
      assert.ok(grep.content.includes('needle-open') && !grep.content.includes('needle-secret'), grep.content);
    });
  });
});
