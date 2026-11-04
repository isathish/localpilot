import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import { editFileTool, readFileTool } from '../tools/fs';
import { normalizeReadArgs, renderWindow, lenientMatch, looksBinary, MAX_READ_FILES } from '../tools/readArgs';
import { unifiedDiff } from '../tools/lineDiff';
import { toolResultCache, ToolResultCache } from '../context/toolResultCache';
import { ContextManager } from '../context/contextManager';
import { toAnthropicMessages } from '../providers/anthropic';
import { ToolContext } from '../types';

const root = (): string => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';

function ctx(approve = true): ToolContext {
  return {
    sessionId: 'test',
    signal: new AbortController().signal,
    depth: 0,
    requestApproval: async () => approve,
    progress() {},
    trackChange: async () => {},
  };
}

suite('read_file arguments and windows', () => {
  test('normalizeReadArgs accepts path, files, aliases, bare strings and string line numbers', () => {
    assert.deepStrictEqual(normalizeReadArgs({ path: 'a.ts' }), [{ path: 'a.ts', start: undefined, end: undefined }]);
    assert.deepStrictEqual(normalizeReadArgs('a.ts'), [{ path: 'a.ts', start: undefined, end: undefined }]);
    assert.deepStrictEqual(normalizeReadArgs({ _raw: '"a.ts"' }), [{ path: 'a.ts', start: undefined, end: undefined }]);
    assert.deepStrictEqual(normalizeReadArgs({ file_path: 'b.ts', start_line: '3', end_line: '9' }), [{ path: 'b.ts', start: 3, end: 9 }]);
    assert.deepStrictEqual(normalizeReadArgs({ filePath: 'c.ts' }), [{ path: 'c.ts', start: undefined, end: undefined }]);
    const many = normalizeReadArgs({ files: [{ path: 'a', start_line: 2 }, 'b', { path: 'c', end_line: '5' }] });
    assert.deepStrictEqual(many, [
      { path: 'a', start: 2, end: undefined },
      { path: 'b', start: undefined, end: undefined },
      { path: 'c', start: undefined, end: 5 },
    ]);
    assert.strictEqual((normalizeReadArgs({ paths: ['x', 'y'] }) as unknown[]).length, 2);
    assert.strictEqual((normalizeReadArgs({ file_paths: '["x","y","z"]' }) as unknown[]).length, 3);
    assert.match(normalizeReadArgs({}) as string, /needs "path"/);
    assert.match(normalizeReadArgs({ files: Array.from({ length: MAX_READ_FILES + 1 }, (_, i) => `f${i}`) }) as string, /at most 8 files/);
  });

  test('renderWindow caps lines and characters, truncates long lines and says how to continue', () => {
    const lines = Array.from({ length: 3000 }, (_, i) => `line ${i + 1}`);
    const w = renderWindow((i) => lines[i], lines.length);
    assert.strictEqual(w.end, 2000);
    assert.match(w.text, /\[Showing lines 1-2000 of 3000\. Use start_line\/end_line to read more\.\]$/);
    const tail = renderWindow((i) => lines[i], lines.length, 2990);
    assert.ok(!/Showing lines/.test(tail.text), 'no footer when nothing remains');
    const wide = Array.from({ length: 100 }, () => 'x'.repeat(1500));
    const cut = renderWindow((i) => wide[i], wide.length);
    assert.ok(cut.end < 100 && cut.text.length <= 48_200, 'the window stops at 48,000 characters');
    const long = renderWindow(() => 'y'.repeat(2500), 1);
    assert.match(long.text, /y{2000} \[line truncated\]$/);
  });

  test('lenientMatch folds Unicode spaces; looksBinary spots NUL bytes', () => {
    const shot = 'Screenshot 2026-11-04 at 10.00.00\u202FAM.png';
    assert.strictEqual(lenientMatch('Screenshot 2026-11-04 at 10.00.00 AM.png', [shot, 'other.png']), shot);
    assert.strictEqual(lenientMatch('missing.png', [shot]), undefined);
    assert.ok(looksBinary(new Uint8Array([0x89, 0x50, 0x00, 0x47])));
    assert.ok(!looksBinary(new TextEncoder().encode('plain text\n')));
  });

  test('unifiedDiff produces hunks with context and caps the length', () => {
    assert.strictEqual(unifiedDiff('a\nb', 'a\nb'), '');
    assert.strictEqual(unifiedDiff('a\nb\nc', 'a\nB\nc'), '@@ -1,3 +1,3 @@\n a\n-b\n+B\n c');
    const a = Array.from({ length: 50 }, (_, i) => `l${i}`);
    const b = a.map((l, i) => (i === 5 || i === 40 ? `${l}!` : l));
    const d = unifiedDiff(a.join('\n'), b.join('\n'));
    assert.strictEqual(d.match(/^@@/gm)?.length, 2, d);
    assert.match(d, /^@@ -38,7 \+38,7 @@$/m);
    const big = unifiedDiff('', Array.from({ length: 500 }, (_, i) => `n${i}`).join('\n'), { maxLines: 200 });
    assert.match(big, /more diff lines\)$/);
  });
});

suite('Tool output cache', () => {
  test('clampToolOutput keeps the full text and read_file reads it back', async () => {
    const cm = new ContextManager({ compactionThreshold: 0.8, maxToolOutputChars: 200, sessionId: 'cache-sess' });
    const full = Array.from({ length: 100 }, (_, i) => `row ${i + 1}`).join('\n');
    const out = cm.clampToolOutput(full);
    assert.ok(out.length < 600, out);
    const ref = /lp-cache:\/\/cache-sess\/[0-9a-z]+\.txt/.exec(out)?.[0];
    assert.ok(ref && /\[Output truncated: [\d,]+ characters omitted\. Full text: lp-cache:/.test(out), out);
    const line = Number(/start_line=(\d+)/.exec(out)?.[1]);
    const r = await readFileTool.execute({ path: ref, start_line: line, end_line: line + 2 }, ctx());
    assert.ok(!r.isError, r.content);
    assert.match(r.content, new RegExp(`${line} \\| row ${line}$`, 'm'));
    assert.match(r.content, /\(100 lines total/);
  });

  test('pruned tool results point to the cache; idle entries expire with a clear message', async () => {
    const cm = new ContextManager({ compactionThreshold: 0.8, maxToolOutputChars: 1000, keepRecent: 1, sessionId: 'prune-sess' });
    const history = [
      { role: 'tool' as const, content: 'x'.repeat(2000), toolCallId: '1', toolName: 'run_command' },
      { role: 'user' as const, content: 'next' },
    ];
    const { messages } = cm.pruneToolOutputs(history);
    const ref = /lp-cache:\/\/prune-sess\/[0-9a-z]+\.txt/.exec(messages[0].content)?.[0];
    assert.ok(ref, messages[0].content);
    assert.strictEqual(toolResultCache.get(ref!), 'x'.repeat(2000));
    for (let i = 0; i < 6; i++) {
      toolResultCache.tick('prune-sess');
    }
    const r = await readFileTool.execute({ path: ref }, ctx());
    assert.ok(r.isError && /Cache expired\. Make a new tool call; DO NOT repeat side-effecting commands\./.test(r.content), r.content);
  });

  test('the cache evicts the least recently used entries past its size cap', () => {
    const c = new ToolResultCache(1000, 5);
    const a = c.put('s', 'a'.repeat(200));
    const b = c.put('s', 'b'.repeat(200));
    c.get(a);
    const d = c.put('s', 'd'.repeat(200));
    assert.ok(c.size('s') <= 1000);
    assert.strictEqual(c.get(b), undefined, 'the least recently used entry went first');
    assert.ok(c.get(a) && c.get(d));
    c.tick('s');
    assert.ok(c.get(a), 'one iteration is not idle enough');
  });
});

suite('read_file batches, images and edit_file', () => {
  let dir = '';
  const rel = (p: string) => path.relative(root(), path.join(dir, p));
  suiteSetup(async () => {
    assert.ok(root(), 'tests need a workspace folder');
    dir = path.join(root(), `read-edit-${Date.now()}`);
    await fs.mkdir(dir, { recursive: true });
  });
  suiteTeardown(() => fs.rm(dir, { recursive: true, force: true }));

  test('one call reads several files; a missing one is reported without failing the rest', async () => {
    await fs.writeFile(path.join(dir, 'a.txt'), 'alpha\n');
    await fs.writeFile(path.join(dir, 'b.txt'), 'beta 1\nbeta 2\nbeta 3\n');
    await fs.writeFile(path.join(dir, 'c.txt'), 'gamma\n');
    const r = await readFileTool.execute({ files: [{ path: rel('a.txt') }, { path: rel('b.txt'), start_line: '2', end_line: '2' }, rel('c.txt'), rel('none.txt')] }, ctx());
    assert.ok(!r.isError, r.content);
    assert.match(r.content, /1 \| alpha/);
    assert.match(r.content, /2 \| beta 2/);
    assert.ok(!/beta 1/.test(r.content));
    assert.match(r.content, /1 \| gamma/);
    assert.match(r.content, /File: .*none\.txt\nError: /);
  });

  test('Unicode spaces, binary files and images', async () => {
    const name = 'Shot 1.00\u202FPM.txt';
    await fs.writeFile(path.join(dir, name), 'lenient\n');
    const r = await readFileTool.execute({ path: rel('Shot 1.00 PM.txt') }, ctx());
    assert.match(r.content, /1 \| lenient/);
    await fs.writeFile(path.join(dir, 'blob.bin'), Buffer.from([1, 0, 2, 3, 0, 4]));
    const bin = await readFileTool.execute({ path: rel('blob.bin') }, ctx());
    assert.ok(bin.isError && /binary file, 6 bytes/.test(bin.content), bin.content);
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
    await fs.writeFile(path.join(dir, 'dot.png'), png);
    const img = await readFileTool.execute({ path: rel('dot.png') }, ctx());
    assert.ok(!img.isError && img.images?.length === 1 && img.images[0].mime === 'image/png' && img.images[0].data === png.toString('base64'), img.content);
  });

  test('images from tool results go inside the Anthropic tool_result', () => {
    const { messages } = toAnthropicMessages([
      { role: 'user', content: 'look' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'read_file', arguments: '{"path":"dot.png"}' }] },
      { role: 'tool', content: '[image dot.png: png, 70 bytes]', toolCallId: 'c1', toolName: 'read_file' },
      { role: 'user', content: '[Image dot.png from read_file]', images: ['iVBORw0KGgo='], meta: { toolImages: ['c1'] } },
    ]);
    const last = messages[messages.length - 1];
    const result = last.content.find((b) => b.type === 'tool_result');
    assert.ok(result?.type === 'tool_result' && Array.isArray(result.content) && result.content.some((b) => b.type === 'image'), JSON.stringify(last));
    assert.ok(!last.content.some((b) => b.type === 'image'), 'not repeated outside the tool_result');
  });

  test('edit_file inserts at a line, keeps CRLF, refuses huge text, writes $ literally and returns a diff', async () => {
    const file = path.join(dir, 'ins.txt');
    await fs.writeFile(file, 'one\ntwo\nthree\n');
    let r = await editFileTool.execute({ path: rel('ins.txt'), insert_line: 2, new_text: 'between' }, ctx());
    assert.ok(!r.isError, r.content);
    assert.strictEqual(await fs.readFile(file, 'utf8'), 'one\nbetween\ntwo\nthree\n');
    assert.match(r.content, /Diff:\n@@ .* @@\n one\n\+between\n two/);
    r = await editFileTool.execute({ path: rel('ins.txt'), insert_line: '5', new_text: 'end' }, ctx());
    assert.ok(!r.isError, r.content);
    assert.strictEqual(await fs.readFile(file, 'utf8'), 'one\nbetween\ntwo\nthree\nend\n');
    r = await editFileTool.execute({ path: rel('ins.txt'), insert_line: 9, new_text: 'x' }, ctx());
    assert.ok(r.isError && /use 1-6/.test(r.content), r.content);

    const crlf = path.join(dir, 'crlf.txt');
    await fs.writeFile(crlf, 'a\r\nb\r\n');
    r = await editFileTool.execute({ path: rel('crlf.txt'), insert_line: 2, new_text: 'x\ny' }, ctx());
    assert.ok(!r.isError, r.content);
    assert.strictEqual(await fs.readFile(crlf, 'utf8'), 'a\r\nx\r\ny\r\nb\r\n');
    const lf = path.join(dir, 'lf.txt');
    await fs.writeFile(lf, 'a\nb\n');
    r = await editFileTool.execute({ path: rel('lf.txt'), old_text: 'b', new_text: 'b\r\nc' }, ctx());
    assert.ok(!r.isError, r.content);
    assert.strictEqual(await fs.readFile(lf, 'utf8'), 'a\nb\nc\n', 'CRLF from the model becomes LF in an LF file');

    r = await editFileTool.execute({ path: rel('lf.txt'), old_text: 'a', new_text: 'z'.repeat(6001) }, ctx());
    assert.ok(r.isError && /Split the edit/.test(r.content), r.content);

    r = await editFileTool.execute({ path: rel('lf.txt'), old_text: 'c', new_text: "price = '$&$1 $$'" }, ctx());
    assert.ok(!r.isError, r.content);
    assert.strictEqual(await fs.readFile(lf, 'utf8'), "a\nb\nprice = '$&$1 $$'\n");
  });
});
