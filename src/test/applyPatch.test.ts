import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import { applyHunks, parsePatch, patchArg, PatchHunk, patchPaths, patchSummary, planPatch, seekLines, unwrapPatch } from '../tools/applyPatch';
import { evaluatePermission } from '../agent/permissions';
import { emptySettings } from '../agent/settings';
import { applyPatchTool } from '../tools/applyPatchTool';
import { editToolsToOmit, prefersApplyPatch } from '../agent/toolRelevance';
import { writePreview } from '../tools/lineDiff';
import { ToolContext } from '../types';

const patch = (...body: string[]) => ['*** Begin Patch', ...body, '*** End Patch'].join('\n');
const hunk = (lines: string[], anchors: string[] = [], eof = false): PatchHunk => ({ anchors, eof, lines: lines.map((l) => ({ op: l[0] as ' ' | '-' | '+', text: l.slice(1) })) });
const files = (m: Record<string, string>) => (p: string) => m[p];

suite('apply_patch: parser', () => {
  test('update with an anchor and context', () => {
    const ops = parsePatch(patch('*** Update File: a.ts', '@@ function main', ' keep', '-old', '+new'));
    assert.deepStrictEqual(ops, [{ type: 'update', path: 'a.ts', moveTo: undefined, hunks: [hunk([' keep', '-old', '+new'], ['function main'])] }]);
  });

  test('add file: every line starts with "+", ends with a newline', () => {
    const [op] = parsePatch(patch('*** Add File: n.txt', '+one', '+two'));
    assert.deepStrictEqual(op, { type: 'add', path: 'n.txt', content: 'one\ntwo\n' });
  });

  test('add file: an empty line without "+" is an empty line, trailing blanks are dropped', () => {
    const [op] = parsePatch(patch('*** Add File: n.txt', '+a', '', '+b', '', ''));
    assert.strictEqual(op.type === 'add' && op.content, 'a\n\nb\n');
  });

  test('add file: a line without "+" is an error naming the line', () => {
    assert.throws(() => parsePatch(patch('*** Add File: n.txt', '+a', 'oops')), /Line 4: every line of an added file/);
  });

  test('delete file', () => {
    assert.deepStrictEqual(parsePatch(patch('*** Delete File: gone.ts')), [{ type: 'delete', path: 'gone.ts' }]);
  });

  test('move to', () => {
    const [op] = parsePatch(patch('*** Update File: a.ts', '*** Move to: b.ts', '@@', '-x', '+y'));
    assert.ok(op.type === 'update' && op.moveTo === 'b.ts' && op.hunks.length === 1);
  });

  test('a pure move needs no hunks', () => {
    const [op] = parsePatch(patch('*** Update File: a.ts', '*** Move to: b.ts'));
    assert.ok(op.type === 'update' && op.moveTo === 'b.ts' && op.hunks.length === 0);
  });

  test('several anchors stack on one hunk; a new @@ after lines starts a new hunk', () => {
    const [op] = parsePatch(patch('*** Update File: a.ts', '@@ class A', '@@ method()', '-x', '+y', '@@ other()', '-p', '+q'));
    assert.ok(op.type === 'update');
    assert.deepStrictEqual(op.hunks.map((h) => h.anchors), [['class A', 'method()'], ['other()']]);
  });

  test('a unified "@@ -1,3 +1,4 @@" header is not an anchor', () => {
    const [op] = parsePatch(patch('*** Update File: a.ts', '@@ -1,3 +1,4 @@', '-x', '+y'));
    assert.ok(op.type === 'update' && op.hunks[0].anchors.length === 0);
    const [op2] = parsePatch(patch('*** Update File: a.ts', '@@ -10,3 +10,4 @@ function f()', '-x', '+y'));
    assert.ok(op2.type === 'update' && op2.hunks[0].anchors[0] === 'function f()');
  });

  test('"*** End of File" marks the hunk', () => {
    const [op] = parsePatch(patch('*** Update File: a.ts', '@@', ' last', '+appended', '*** End of File'));
    assert.ok(op.type === 'update' && op.hunks[0].eof);
  });

  test('an empty context line that lost its space is accepted', () => {
    const [op] = parsePatch(patch('*** Update File: a.ts', ' a', '', '-b', '+c'));
    assert.ok(op.type === 'update');
    assert.deepStrictEqual(op.hunks[0].lines.map((l) => l.op + l.text), [' a', ' ', '-b', '+c']);
  });

  test('blank lines between sections are not context', () => {
    const ops = parsePatch(patch('*** Update File: a.ts', '-x', '+y', '', '*** Delete File: b.ts'));
    assert.ok(ops[0].type === 'update' && ops[0].hunks[0].lines.length === 2 && ops[1].type === 'delete');
  });

  test('%%bash and apply_patch <<"EOF" wrappers', () => {
    const wrapped = `%%bash\napply_patch <<"EOF"\n${patch('*** Delete File: x')}\nEOF\n`;
    assert.deepStrictEqual(parsePatch(wrapped), [{ type: 'delete', path: 'x' }]);
    assert.deepStrictEqual(parsePatch(`apply_patch <<'PATCH'\n${patch('*** Delete File: y')}\nPATCH`), [{ type: 'delete', path: 'y' }]);
  });

  test('a code fence around the patch', () => {
    assert.strictEqual(unwrapPatch('```diff\n*** Begin Patch\n*** End Patch\n```'), '*** Begin Patch\n*** End Patch');
  });

  test('CRLF patch text', () => {
    assert.deepStrictEqual(parsePatch(patch('*** Delete File: x').replace(/\n/g, '\r\n')), [{ type: 'delete', path: 'x' }]);
  });

  test('lenient: no "*** Begin Patch" or "*** End Patch"', () => {
    assert.strictEqual(parsePatch('*** Update File: a.ts\n-x\n+y').length, 1);
    assert.strictEqual(parsePatch('*** Begin Patch\n*** Delete File: a.ts').length, 1);
  });

  test('errors: no sections, stray line, duplicate file, update without changes', () => {
    assert.throws(() => parsePatch('hello'), /must start with "\*\*\* Begin Patch"/);
    assert.throws(() => parsePatch(patch('')), /no file sections/);
    assert.throws(() => parsePatch(patch('*** Update File: a.ts', 'no prefix')), /Line 3: in a.ts/);
    assert.throws(() => parsePatch(patch('*** Delete File: a.ts', '*** Delete File: a.ts')), /more than once/);
    assert.throws(() => parsePatch(patch('*** Update File: a.ts', ' only context')), /no "-" or "\+" lines/);
  });

  test('patchPaths and patchSummary name every file, move targets included', () => {
    const p = patch('*** Update File: a.ts', '*** Move to: b.ts', '-x', '+y', '*** Add File: c.ts', '+z');
    assert.deepStrictEqual(patchPaths(p), ['a.ts', 'b.ts', 'c.ts']);
    assert.strictEqual(patchSummary(p), 'a.ts, b.ts, c.ts');
    assert.deepStrictEqual(patchPaths(42), []);
  });

  test('patchArg takes the first non-empty of input, patch, diff, content', () => {
    assert.strictEqual(patchArg({ input: '', patch: 'P' }), 'P');
    assert.strictEqual(patchArg({ diff: 'D', content: 'C' }), 'D');
    assert.strictEqual(patchArg({ input: '  ' }), undefined);
  });

  test('path rules see the patch in any argument; a patch naming no file fails closed for deny/ask', () => {
    const perm = { ...emptySettings().permissions, deny: ['Edit(secrets/**)'] };
    const p = patch('*** Update File: secrets/key', '-a', '+b');
    for (const args of [{ diff: p }, { content: p }, { input: '', patch: p }]) {
      assert.strictEqual(evaluatePermission(perm, 'apply_patch', args).decision, 'deny');
    }
    assert.strictEqual(evaluatePermission(perm, 'apply_patch', { input: 'garbage' }).decision, 'deny');
    assert.strictEqual(evaluatePermission({ ...perm, deny: [], allow: ['Edit(src/**)'] }, 'apply_patch', { input: 'garbage' }).decision, 'none');
    assert.strictEqual(evaluatePermission(perm, 'apply_patch', { input: patch('*** Update File: src/a', '-a', '+b') }).decision, 'none');
  });
});

suite('apply_patch: applier', () => {
  test('exact match', () => {
    assert.deepStrictEqual(applyHunks('a\nb\nc\n', [hunk([' a', '-b', '+B', ' c'])]), { content: 'a\nB\nc\n', fuzz: 0 });
  });

  test('trailing whitespace is fuzz 1', () => {
    const r = applyHunks('a  \nb\n', [hunk([' a', '-b', '+B'])]);
    assert.deepStrictEqual(r, { content: 'a  \nB\n', fuzz: 1 });
  });

  test('surrounding whitespace is fuzz 2', () => {
    const r = applyHunks('    a\n    b\n', [hunk([' a', '-b', '+    B'])]);
    assert.deepStrictEqual(r, { content: '    a\n    B\n', fuzz: 2 });
  });

  test('NFC normalization: composed and decomposed accents match', () => {
    const r = applyHunks('caf\u00e9\nx\n', [hunk([' cafe\u0301', '-x', '+y'])]);
    assert.strictEqual(r.content, 'caf\u00e9\ny\n', 'the file keeps its own spelling of the context line');
    assert.strictEqual(r.fuzz, 1);
  });

  test('an anchor picks the occurrence after it', () => {
    const src = 'function a() {\n  return 1;\n}\nfunction b() {\n  return 1;\n}\n';
    const r = applyHunks(src, [hunk(['-  return 1;', '+  return 2;'], ['function b() {'])]);
    assert.strictEqual(r.content, 'function a() {\n  return 1;\n}\nfunction b() {\n  return 2;\n}\n');
  });

  test('without an anchor the first occurrence changes', () => {
    assert.strictEqual(applyHunks('x\nx\n', [hunk(['-x', '+y'])]).content, 'y\nx\n');
  });

  test('two hunks apply in order', () => {
    assert.strictEqual(applyHunks('a\nb\nc\nd\n', [hunk(['-a', '+A']), hunk(['-c', '+C'])]).content, 'A\nb\nC\nd\n');
  });

  test('a hunk is searched after the previous one', () => {
    assert.throws(() => applyHunks('a\nb\n', [hunk(['-b', '+B']), hunk(['-a', '+A'])], 'f.ts'), /f.ts: these lines were not found after the previous hunk/);
  });

  test('missing context is an error with the lines', () => {
    assert.throws(() => applyHunks('a\n', [hunk(['-zzz', '+y'])], 'f.ts'), /f.ts: these lines were not found:\n {2}zzz/);
  });

  test('missing anchor is an error', () => {
    assert.throws(() => applyHunks('a\n', [hunk(['-a', '+b'], ['nope'])], 'f.ts'), /"@@ nope" line was not found/);
  });

  test('CRLF files stay CRLF', () => {
    assert.strictEqual(applyHunks('a\r\nb\r\n', [hunk([' a', '-b', '+B', '+C'])]).content, 'a\r\nB\r\nC\r\n');
  });

  test('a file without a final newline keeps it that way', () => {
    assert.strictEqual(applyHunks('a\nb', [hunk(['-b', '+B'])]).content, 'a\nB');
  });

  test('a pure addition goes to the end, or after its anchor', () => {
    assert.strictEqual(applyHunks('a\nb\n', [hunk(['+c'])]).content, 'a\nb\nc\n');
    assert.strictEqual(applyHunks('a\nb\n', [hunk(['+z'], ['a'])]).content, 'a\nz\nb\n');
  });

  test('an anchored insert lands before a later hunk that starts on the same line', () => {
    const ops = parsePatch(patch('*** Update File: f', '@@ head', '+inserted', '@@', ' b', '-c', '+C'));
    assert.strictEqual(ops[0].type === 'update' && applyHunks('head\nb\nc\nd\n', ops[0].hunks).content, 'head\ninserted\nb\nC\nd\n');
    assert.strictEqual(applyHunks('a\n', [hunk(['+x']), hunk(['+y'])]).content, 'a\nx\ny\n');
  });

  test('"*** End of File" matches the last lines first', () => {
    assert.strictEqual(applyHunks('x\ny\nx\n', [hunk(['-x', '+END'], [], true)]).content, 'x\ny\nEND\n');
  });

  test('a trailing empty context line stands for the end of the file', () => {
    assert.strictEqual(applyHunks('a\nb\n', [hunk([' b', '+c', ' '])]).content, 'a\nb\nc\n');
  });

  test('seekLines prefers exact over loose matches', () => {
    assert.deepStrictEqual(seekLines(['x ', 'x'], ['x'], 0), { at: 1, fuzz: 0 });
    assert.strictEqual(seekLines(['a'], ['a', 'b'], 0), undefined);
  });

  test('applying to an empty file', () => {
    assert.strictEqual(applyHunks('', [hunk(['+first'])]).content, 'first\n');
  });
});

suite('apply_patch: plan', () => {
  test('update, add, delete and move', () => {
    const ops = parsePatch(patch('*** Update File: a', '-1', '+2', '*** Add File: n', '+new', '*** Delete File: d', '*** Update File: m', '*** Move to: m2', '-x', '+y'));
    const plan = planPatch(ops, files({ a: '1\n', d: 'gone\n', m: 'x\n' }));
    assert.deepStrictEqual(
      plan.map((f) => [f.kind, f.path, f.after]),
      [['update', 'a', '2\n'], ['add', 'n', 'new\n'], ['delete', 'd', undefined], ['move', 'm', 'y\n']]
    );
  });

  test('every problem is reported at once and nothing is planned', () => {
    const ops = parsePatch(patch('*** Update File: missing', '-a', '+b', '*** Delete File: also-missing', '*** Update File: m', '*** Move to: taken', '-x', '+y'));
    assert.throws(
      () => planPatch(ops, files({ m: 'x\n', taken: '' })),
      (e: Error) => /missing does not exist; use "\*\*\* Add File:"/.test(e.message) && /also-missing does not exist\./.test(e.message) && /taken already exists/.test(e.message)
    );
  });

  test('adding over a CRLF file writes CRLF', () => {
    const [f] = planPatch(parsePatch(patch('*** Add File: w', '+a', '+b')), files({ w: 'old\r\n' }));
    assert.strictEqual(f.after, 'a\r\nb\r\n');
  });

  test('fuzz is reported per file', () => {
    const [f] = planPatch(parsePatch(patch('*** Update File: a', ' k', '-v', '+w')), files({ a: 'k \nv\n' }));
    assert.strictEqual(f.fuzz, 1);
  });
});

suite('apply_patch: routing and previews', () => {
  test('GPT, Codex and gpt-oss models prefer apply_patch', () => {
    assert.ok(prefersApplyPatch('gpt-oss:20b') && prefersApplyPatch('openai/gpt-4.1') && prefersApplyPatch('codex-mini'));
    assert.ok(!prefersApplyPatch('qwen2.5-coder:7b') && !prefersApplyPatch('llama3.1'));
  });

  test('editToolsToOmit follows localpilot.editTool', () => {
    const all = ['read_file', 'edit_file', 'write_file', 'apply_patch'];
    assert.deepStrictEqual([...editToolsToOmit(all, 'gpt-oss:20b', 'auto')].sort(), ['edit_file', 'write_file']);
    assert.deepStrictEqual([...editToolsToOmit(all, 'qwen3', 'auto')], ['apply_patch']);
    assert.deepStrictEqual([...editToolsToOmit(all, 'qwen3', 'apply_patch')].sort(), ['edit_file', 'write_file']);
    assert.deepStrictEqual([...editToolsToOmit(all, 'gpt-oss:20b', 'edit_file')], ['apply_patch']);
    assert.strictEqual(editToolsToOmit(['read_file', 'edit_file'], 'gpt-oss:20b', 'auto').size, 0, 'no apply_patch to swap in: keep edit_file');
  });

  test('writePreview: a diff for an existing file, the first lines of a new one', () => {
    assert.strictEqual(writePreview('a\nb\n', 'a\nc\n'), '@@ -1,2 +1,2 @@\n a\n-b\n+c');
    assert.strictEqual(writePreview(undefined, '1\n2\n3\n', 2), '+1\n+2\n… 1 more lines');
    assert.match(writePreview('same', 'same'), /no changes/);
  });
});

suite('apply_patch: tool', () => {
  const root = (): string => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
  let dir = '';
  const rel = (p: string) => path.relative(root(), path.join(dir, p)).split(path.sep).join('/');
  const ctx = (approve = true) => {
    const c = {
      sessionId: 'test',
      signal: new AbortController().signal,
      depth: 0,
      approvals: [] as { title: string; detail: string; kind: string; preview?: number }[],
      tracked: [] as string[],
      async requestApproval(title: string, detail: string, kind: string, opts?: { preview?: unknown[] }) {
        c.approvals.push({ title, detail, kind, preview: opts?.preview?.length });
        return approve;
      },
      progress() {},
      async trackChange(p: string) {
        c.tracked.push(p);
      },
    };
    return c as ToolContext & typeof c;
  };

  suiteSetup(async () => {
    assert.ok(root(), 'tests need a workspace folder');
    dir = path.join(root(), `apply-patch-${Date.now()}`);
    await fs.mkdir(dir, { recursive: true });
  });
  suiteTeardown(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  test('a two-file rename-and-edit in one patch, after one approval', async () => {
    await fs.writeFile(path.join(dir, 'old.py'), 'def helper():\n    return 1\n');
    await fs.writeFile(path.join(dir, 'main.py'), 'from old import helper\nprint(helper())\n');
    const c = ctx();
    const input = patch(`*** Update File: ${rel('old.py')}`, `*** Move to: ${rel('new.py')}`, '@@ def helper():', '-    return 1', '+    return 2', `*** Update File: ${rel('main.py')}`, '-from old import helper', '+from new import helper');
    const r = await applyPatchTool.execute({ input }, c);
    assert.ok(!r.isError, r.content);
    assert.strictEqual(c.approvals.length, 1);
    assert.strictEqual(c.approvals[0].kind, 'write');
    assert.strictEqual(c.approvals[0].preview, 2);
    assert.match(c.approvals[0].detail, /Moved .*old\.py → .*new\.py/);
    assert.strictEqual(await fs.readFile(path.join(dir, 'new.py'), 'utf8'), 'def helper():\n    return 2\n');
    assert.strictEqual(await fs.readFile(path.join(dir, 'main.py'), 'utf8'), 'from new import helper\nprint(helper())\n');
    await assert.rejects(fs.stat(path.join(dir, 'old.py')));
    assert.deepStrictEqual(c.tracked.sort(), [path.join(dir, 'main.py'), path.join(dir, 'new.py'), path.join(dir, 'old.py')].sort());
  });

  test('a delete asks with the delete kind; declining changes nothing', async () => {
    await fs.writeFile(path.join(dir, 'keep.txt'), 'x\n');
    const c = ctx(false);
    const r = await applyPatchTool.execute({ input: patch(`*** Delete File: ${rel('keep.txt')}`) }, c);
    assert.ok(r.isError);
    assert.strictEqual(c.approvals[0].kind, 'delete');
    assert.strictEqual(await fs.readFile(path.join(dir, 'keep.txt'), 'utf8'), 'x\n');
  });

  test('a bad hunk fails before asking, with nothing written', async () => {
    await fs.writeFile(path.join(dir, 'a.txt'), 'one\n');
    const c = ctx();
    const r = await applyPatchTool.execute({ input: patch(`*** Update File: ${rel('a.txt')}`, '-two', '+three', `*** Add File: ${rel('b.txt')}`, '+b') }, c);
    assert.ok(r.isError && /not found/.test(r.content) && /Nothing was changed/.test(r.content), r.content);
    assert.strictEqual(c.approvals.length, 0);
    await assert.rejects(fs.stat(path.join(dir, 'b.txt')));
  });

  test('CRLF files keep CRLF', async () => {
    await fs.writeFile(path.join(dir, 'win.txt'), 'a\r\nb\r\n');
    const r = await applyPatchTool.execute({ input: patch(`*** Update File: ${rel('win.txt')}`, ' a', '-b', '+c') }, ctx());
    assert.ok(!r.isError, r.content);
    assert.strictEqual(await fs.readFile(path.join(dir, 'win.txt'), 'utf8'), 'a\r\nc\r\n');
  });
});
