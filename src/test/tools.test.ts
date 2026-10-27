import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { createDirTool, deleteTool, diffPreview, displayPath, editFileTool, fsTools, listDirTool, readFileTool, resolveWorkspacePath, writeFileTool } from '../tools/fs';
import { fileSearchTool, grepSearchTool, looksLikeRegex } from '../tools/search';
import { getDiagnosticsTool, openEditorsTool, openFileTool } from '../tools/editor';
import { ToolContext } from '../types';

const root = (): string => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';

/** Tool context that auto-approves (or declines) and records what it was asked. */
function ctx(opts: { approve?: boolean; workspaceRoot?: string } = {}): ToolContext & { approvals: { title: string; kind: string }[]; tracked: string[] } {
  const c = {
    sessionId: 'test',
    workspaceRoot: opts.workspaceRoot,
    signal: new AbortController().signal,
    depth: 0,
    approvals: [] as { title: string; kind: string }[],
    tracked: [] as string[],
    async requestApproval(title: string, _detail: string, kind: string) {
      c.approvals.push({ title, kind });
      return opts.approve !== false;
    },
    progress() {},
    async trackChange(p: string) {
      c.tracked.push(p);
    },
  };
  return c;
}

let dir = '';
suite('Filesystem tools', () => {
  suiteSetup(async () => {
    assert.ok(root(), 'tests need a workspace folder');
    dir = path.join(root(), `fs-tools-${Date.now()}`);
    await fs.mkdir(dir, { recursive: true });
  });
  suiteTeardown(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  const rel = (p: string) => path.relative(root(), path.join(dir, p));

  test('resolveWorkspacePath keeps the agent inside the workspace (and inside its worktree when isolated)', async () => {
    const c = ctx();
    assert.strictEqual(resolveWorkspacePath('a/b.ts', c).fsPath, path.join(root(), 'a', 'b.ts'));
    assert.strictEqual(resolveWorkspacePath(path.join(root(), 'x.ts'), c).fsPath, path.join(root(), 'x.ts'), 'absolute paths inside the root are fine');
    assert.throws(() => resolveWorkspacePath('../../etc/passwd', c), /outside the workspace/);
    assert.throws(() => resolveWorkspacePath('/etc/passwd', c), /outside the workspace/);
    assert.strictEqual(resolveWorkspacePath('', c).fsPath, root(), 'empty path is the root itself');
    // Isolated: an absolute path into the real workspace is redirected into the worktree copy.
    const wt = await fs.mkdtemp(path.join(os.tmpdir(), 'lp-wt-'));
    try {
      const iso = ctx({ workspaceRoot: wt });
      assert.strictEqual(resolveWorkspacePath(path.join(root(), 'src', 'a.ts'), iso).fsPath, path.join(wt, 'src', 'a.ts'));
      assert.strictEqual(resolveWorkspacePath('src/a.ts', iso).fsPath, path.join(wt, 'src', 'a.ts'));
      assert.strictEqual(displayPath(vscode.Uri.file(path.join(wt, 'src', 'a.ts')), iso), path.join('src', 'a.ts'));
      assert.strictEqual(displayPath(vscode.Uri.file(wt), iso), '.');
    } finally {
      await fs.rm(wt, { recursive: true, force: true });
    }
    assert.strictEqual(displayPath(vscode.Uri.file(path.join(root(), 'src', 'a.ts')), c), 'src/a.ts', 'falls back to the workspace-relative path');
    assert.strictEqual(displayPath(vscode.Uri.file('/somewhere/else.ts'), c), '/somewhere/else.ts', 'outside everything: absolute');
  });

  test('write_file creates (with parents), overwrites, asks for approval and refuses directories', async () => {
    const c = ctx();
    let r = await writeFileTool.execute({ path: rel('deep/one/file.txt'), content: 'a\nb\nc' }, c);
    assert.ok(!r.isError, r.content);
    assert.match(r.content, /^Created .*file\.txt \(3 lines\)/);
    assert.deepStrictEqual(c.approvals.map((a) => a.kind), ['write']);
    assert.match(c.approvals[0].title, /^Create /);
    assert.strictEqual(await fs.readFile(path.join(dir, 'deep/one/file.txt'), 'utf8'), 'a\nb\nc');
    assert.strictEqual(c.tracked.length, 1, 'the change is tracked before writing');

    r = await writeFileTool.execute({ path: rel('deep/one/file.txt'), content: 'x' }, c);
    assert.match(r.content, /^Updated /);
    assert.match(c.approvals[1].title, /^Overwrite /);
    assert.strictEqual(await fs.readFile(path.join(dir, 'deep/one/file.txt'), 'utf8'), 'x');

    r = await writeFileTool.execute({ path: rel('deep/one'), content: 'x' }, c);
    assert.ok(r.isError && /is a directory/.test(r.content), r.content);

    const declined = ctx({ approve: false });
    r = await writeFileTool.execute({ path: rel('never.txt'), content: 'x' }, declined);
    assert.ok(r.isError && /declined/.test(r.content));
    await assert.rejects(fs.stat(path.join(dir, 'never.txt')), 'declined writes do not touch disk');
    await assert.rejects(writeFileTool.execute({ content: 'x' }, c), /Missing required string argument "path"/);
  });

  test('read_file numbers lines and honours ranges', async () => {
    const c = ctx();
    await fs.writeFile(path.join(dir, 'read.txt'), Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join('\n'));
    const all = await readFileTool.execute({ path: rel('read.txt') }, c);
    assert.match(all.content, /\(20 lines total, showing 1-20\)/);
    assert.match(all.content, /^ {4}1 \| line 1$/m);
    const part = await readFileTool.execute({ path: rel('read.txt'), start_line: 5, end_line: 7 }, c);
    assert.match(part.content, /showing 5-7\)/);
    const body = part.content.split('\n').slice(1);
    assert.deepStrictEqual(body.map((l) => l.replace(/^\s*\d+ \| /, '')), ['line 5', 'line 6', 'line 7']);
    const clamped = await readFileTool.execute({ path: rel('read.txt'), start_line: 0, end_line: 999 }, c);
    assert.match(clamped.content, /showing 1-20\)/);
    await assert.rejects(readFileTool.execute({ path: rel('missing.txt') }, c));
  });

  test('edit_file replaces a unique snippet, tolerates indentation drift, appends, and reports ambiguity', async () => {
    const c = ctx();
    const file = path.join(dir, 'edit.ts');
    await fs.writeFile(file, 'function a() {\n    return 1;\n}\nfunction b() {\n    return 2;\n}\n');
    let r = await editFileTool.execute({ path: rel('edit.ts'), old_text: '    return 1;', new_text: '    return 10;' }, c);
    assert.ok(!r.isError, r.content);
    assert.match(r.content, /at line 2/);
    assert.match(await fs.readFile(file, 'utf8'), /return 10;/);

    // Whitespace-insensitive fallback: the model used two spaces where the file has four.
    r = await editFileTool.execute({ path: rel('edit.ts'), old_text: 'function b() {\n  return 2;\n}', new_text: 'function b() {\n    return 20;\n}' }, c);
    assert.ok(!r.isError, r.content);
    assert.match(await fs.readFile(file, 'utf8'), /return 20;/);

    r = await editFileTool.execute({ path: rel('edit.ts'), old_text: '}', new_text: '};' }, c);
    assert.ok(r.isError && /more than once/.test(r.content), r.content);

    r = await editFileTool.execute({ path: rel('edit.ts'), old_text: 'nothing like this', new_text: 'x' }, c);
    assert.ok(r.isError && /not found/.test(r.content), r.content);

    r = await editFileTool.execute({ path: rel('edit.ts'), old_text: '', new_text: '// tail' }, c);
    assert.ok(!r.isError, r.content);
    assert.ok((await fs.readFile(file, 'utf8')).trimEnd().endsWith('// tail'), 'empty old_text appends');

    // Appending to a file that does not exist creates it; replacing in one does not.
    r = await editFileTool.execute({ path: rel('new-by-edit.txt'), old_text: '', new_text: 'hello' }, c);
    assert.ok(!r.isError && /Created/.test(r.content), r.content);
    assert.strictEqual(await fs.readFile(path.join(dir, 'new-by-edit.txt'), 'utf8'), 'hello');
    r = await editFileTool.execute({ path: rel('still-missing.txt'), old_text: 'a', new_text: 'b' }, c);
    assert.ok(r.isError && /does not exist/.test(r.content), r.content);

    const declined = ctx({ approve: false });
    r = await editFileTool.execute({ path: rel('edit.ts'), old_text: 'return 10;', new_text: 'return 11;' }, declined);
    assert.ok(r.isError && /declined/.test(r.content));
    assert.match(await fs.readFile(file, 'utf8'), /return 10;/, 'declined edits leave the file alone');
  });

  test('list_dir, create_directory and delete_path', async () => {
    const c = ctx();
    await fs.mkdir(path.join(dir, 'ls/sub'), { recursive: true });
    await fs.mkdir(path.join(dir, 'ls/node_modules'), { recursive: true });
    await fs.writeFile(path.join(dir, 'ls/b.txt'), '');
    await fs.writeFile(path.join(dir, 'ls/a.txt'), '');
    const ls = await listDirTool.execute({ path: rel('ls') }, c);
    assert.deepStrictEqual(ls.content.split('\n'), ['sub/', 'a.txt', 'b.txt'], 'folders first, sorted, node_modules hidden');
    assert.strictEqual((await listDirTool.execute({ path: rel('ls/sub') }, c)).content, '(empty directory)');

    const mk = await createDirTool.execute({ path: rel('made/nested/dir') }, c);
    assert.match(mk.content, /^Created .*dir\/$/);
    assert.ok((await fs.stat(path.join(dir, 'made/nested/dir'))).isDirectory());

    const declined = ctx({ approve: false });
    let del = await deleteTool.execute({ path: rel('ls/a.txt') }, declined);
    assert.ok(del.isError && /declined/.test(del.content));
    await fs.stat(path.join(dir, 'ls/a.txt'));
    del = await deleteTool.execute({ path: rel('ls/a.txt') }, c);
    assert.match(del.content, /^Deleted /);
    assert.deepStrictEqual(c.approvals.map((a) => a.kind), ['delete']);
    await assert.rejects(fs.stat(path.join(dir, 'ls/a.txt')));
  });

  test('diffPreview and the tool roster', () => {
    assert.strictEqual(diffPreview('a\nb', 'c'), '- a\n- b\n+ c');
    assert.deepStrictEqual(fsTools.map((t) => t.definition.name), ['read_file', 'write_file', 'edit_file', 'list_dir', 'create_directory', 'delete_path']);
    for (const t of fsTools) {
      assert.ok(t.parallelSafe ? !t.approvalKind : t.approvalKind, `${t.definition.name}: read-only tools are parallelSafe, mutating ones carry an approvalKind`);
    }
  });
});

suite('Search tools', () => {
  let sdir = '';
  suiteSetup(async () => {
    sdir = path.join(root(), `search-tools-${Date.now()}`);
    await fs.mkdir(path.join(sdir, 'src'), { recursive: true });
    await fs.mkdir(path.join(sdir, 'node_modules/pkg'), { recursive: true });
    await fs.writeFile(path.join(sdir, 'src/alpha.ts'), 'export function greetUser(name: string) {\n  return `hi ${name}`;\n}\n');
    await fs.writeFile(path.join(sdir, 'src/beta.ts'), 'import { greetUser } from "./alpha";\nconsole.log(greetUser("x"));\n');
    await fs.writeFile(path.join(sdir, 'notes.md'), '# greetUser\nDocs for GreetUser.\n');
    await fs.writeFile(path.join(sdir, 'node_modules/pkg/index.js'), 'greetUser();\n');
  });
  suiteTeardown(async () => {
    await fs.rm(sdir, { recursive: true, force: true });
  });
  const base = () => path.relative(root(), sdir);

  test('file_search matches names/globs, skips node_modules and hints when the pattern looks like a symbol', async () => {
    const c = ctx();
    const r = await fileSearchTool.execute({ pattern: `${base()}/**/*.ts` }, c);
    assert.deepStrictEqual(r.content.split('\n'), [`${base()}/src/alpha.ts`, `${base()}/src/beta.ts`]);
    const none = await fileSearchTool.execute({ pattern: `${base()}/**/*.py` }, c);
    assert.match(none.content, /^No files match/);
    assert.doesNotMatch(none.content, /grep_search/, 'a real glob gets no symbol hint');
    const sym = await fileSearchTool.execute({ pattern: 'greetUser' }, c);
    assert.match(sym.content, /use grep_search with that text/);
    const capped = await fileSearchTool.execute({ pattern: `${base()}/**/*`, max_results: 1 }, c);
    assert.strictEqual(capped.content.split('\n').length, 1);
  });

  test('grep_search finds text (case-insensitive by default), honours include globs and retries escaped regexes', async () => {
    const c = ctx();
    const r = await grepSearchTool.execute({ query: 'greetUser', include_pattern: `${base()}/**` }, c);
    const lines = r.content.split('\n');
    assert.ok(lines.some((l) => /src\/alpha\.ts:1: .*function greetUser/.test(l)), r.content);
    assert.ok(lines.some((l) => /notes\.md:2: /.test(l)), 'case-insensitive: GreetUser in notes.md');
    assert.ok(!lines.some((l) => /node_modules/.test(l)), 'node_modules excluded');

    const cs = await grepSearchTool.execute({ query: 'GreetUser', case_sensitive: true, include_pattern: `${base()}/**` }, c);
    assert.deepStrictEqual(cs.content.split('\n').filter((l) => /alpha|beta/.test(l)), [], 'case-sensitive excludes the code files');

    const only = await grepSearchTool.execute({ query: 'greetUser', include_pattern: `${base()}/src/beta.ts` }, c);
    assert.ok(only.content.split('\n').every((l) => /beta\.ts/.test(l)), only.content);

    const escaped = await grepSearchTool.execute({ query: 'greetUser\\(', include_pattern: `${base()}/**` }, c);
    assert.ok(/alpha\.ts:1/.test(escaped.content) || /beta\.ts:2/.test(escaped.content), `escaped regex retried: ${escaped.content}`);

    const none = await grepSearchTool.execute({ query: 'zzz-not-here-zzz', include_pattern: `${base()}/**` }, c);
    assert.match(none.content, /^No matches/);
    const empty = await grepSearchTool.execute({ query: '' }, c);
    assert.ok(empty.isError);
  });

  test('looksLikeRegex spots escaped metacharacters and alternation but not plain words', () => {
    assert.ok(looksLikeRegex('def foo\\('));
    assert.ok(looksLikeRegex('(a|b)'));
    assert.ok(looksLikeRegex('foo.*bar'));
    assert.ok(looksLikeRegex('[A-Z]+'));
    assert.ok(!looksLikeRegex('plain words'));
    assert.ok(!looksLikeRegex('getUser('), 'an unbalanced paren is not a valid regex');
  });
});

suite('Editor tools', () => {
  test('open_file shows the document at a line; get_editor_state reports it', async () => {
    const c = ctx();
    const file = path.join(root(), `editor-tools-${Date.now()}.txt`);
    await fs.writeFile(file, 'one\ntwo\nthree\n');
    try {
      const r = await openFileTool.execute({ path: path.basename(file), line: 3 }, c);
      assert.match(r.content, /^Opened /);
      const ed = vscode.window.activeTextEditor;
      assert.ok(ed && ed.document.uri.fsPath === file, 'the file is the active editor');
      assert.strictEqual(ed.selection.active.line, 2);
      ed.selection = new vscode.Selection(new vscode.Position(1, 0), new vscode.Position(1, 3));
      const state = await openEditorsTool.execute({}, c);
      assert.match(state.content, new RegExp(`Active: ${path.basename(file).replace('.', '\\.')} line 2`));
      assert.match(state.content, /Selection:\ntwo/);
      assert.match(state.content, new RegExp(`Open editors:[\\s\\S]*${path.basename(file).replace('.', '\\.')}`));
    } finally {
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      await fs.rm(file, { force: true });
    }
  });

  test('get_diagnostics filters by severity and file', async () => {
    const c = ctx();
    const file = path.join(root(), `diag-${Date.now()}.txt`);
    await fs.writeFile(file, 'x\n');
    const coll = vscode.languages.createDiagnosticCollection('lp-test');
    try {
      const uri = vscode.Uri.file(file);
      coll.set(uri, [
        new vscode.Diagnostic(new vscode.Range(0, 0, 0, 1), 'bad thing', vscode.DiagnosticSeverity.Error),
        new vscode.Diagnostic(new vscode.Range(0, 0, 0, 1), 'meh thing', vscode.DiagnosticSeverity.Warning),
      ]);
      const errors = await getDiagnosticsTool.execute({ path: path.basename(file) }, c);
      assert.match(errors.content, /:1:1 \[Error\] bad thing/);
      assert.doesNotMatch(errors.content, /meh thing/, 'default severity is error');
      const warnings = await getDiagnosticsTool.execute({ path: path.basename(file), severity: 'warning' }, c);
      assert.match(warnings.content, /meh thing/);
      coll.clear();
      const none = await getDiagnosticsTool.execute({ path: path.basename(file), severity: 'all' }, c);
      assert.strictEqual(none.content, 'No diagnostics.');
    } finally {
      coll.dispose();
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      await fs.rm(file, { force: true });
    }
  });
});
