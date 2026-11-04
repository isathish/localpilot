import * as assert from 'assert';
import { claudeToolInput, evaluatePermission } from '../agent/permissions';
import { getConfig } from '../config';
import { ContextManager } from '../context/contextManager';
import { readFileTool } from '../tools/fs';
import { renderWindow, windowBudget } from '../tools/readArgs';
import { ToolContext } from '../types';

function ctx(): ToolContext {
  return {
    sessionId: 'test',
    signal: new AbortController().signal,
    depth: 0,
    requestApproval: async () => true,
    progress() {},
    trackChange: async () => {},
  };
}

const perm = (deny: string[], allow: string[] = []) => ({ deny, ask: [], allow, additionalDirectories: [] });

suite('read_file permissions see every batched path', () => {
  test('deny Read(.env) blocks batched and aliased reads', () => {
    const p = perm(['Read(.env)', 'Read(**/*.pem)']);
    assert.strictEqual(evaluatePermission(p, 'read_file', { files: [{ path: '.env' }] }, { root: '/w' }).decision, 'deny');
    assert.strictEqual(evaluatePermission(p, 'read_file', { paths: ['.env'] }, { root: '/w' }).decision, 'deny');
    assert.strictEqual(evaluatePermission(p, 'read_file', { path: 'README.md', files: [{ path: 'secrets/key.pem' }] }, { root: '/w' }).decision, 'deny');
    assert.strictEqual(evaluatePermission(p, 'read_file', { path: 'README.md' }, { root: '/w' }).decision, 'none');
  });

  test('allow applies only when every read path matches', () => {
    const p = perm([], ['Read(src/**)']);
    assert.strictEqual(evaluatePermission(p, 'read_file', { files: [{ path: 'src/a.ts' }, { path: 'src/b.ts' }] }, { root: '/w' }).decision, 'allow');
    assert.strictEqual(evaluatePermission(p, 'read_file', { files: [{ path: 'src/a.ts' }, { path: '.env' }] }, { root: '/w' }).decision, 'none');
  });

  test('hooks get file_path and file_paths for batched reads', () => {
    const input = claudeToolInput('read_file', { files: [{ path: 'a.ts' }, { path: 'b.ts' }] });
    assert.strictEqual(input.file_path, 'a.ts');
    assert.deepStrictEqual(input.file_paths, ['a.ts', 'b.ts']);
    assert.strictEqual(claudeToolInput('read_file', { path: 'c.ts' }).file_path, 'c.ts');
  });
});

suite('read_file windows fit the tool-output limit', () => {
  test('windowBudget splits the limit across files and keeps room for headers', () => {
    assert.ok(windowBudget(24_000) <= 24_000 - 400);
    assert.ok(windowBudget(24_000, 8) * 8 + 8 * 400 <= 24_000);
    assert.ok(renderWindow((i) => 'x'.repeat(100 + (i % 3)), 5000, 1, undefined, 3000).text.length <= 3000 + 120);
  });

  test('following an lp-cache reference continues at start_line and is not cut again', async () => {
    const max = getConfig().maxToolOutputChars;
    const cm = new ContextManager({ compactionThreshold: 0.8, maxToolOutputChars: max, sessionId: 'limit-sess' });
    const full = Array.from({ length: 2000 }, (_, i) => `row ${i + 1} ${'y'.repeat(40)}`).join('\n');
    assert.ok(full.length > 90_000);
    const out = cm.clampToolOutput(full);
    const ref = /lp-cache:\/\/limit-sess\/[0-9a-z]+\.txt/.exec(out)?.[0];
    const k = Number(/start_line=(\d+)/.exec(out)?.[1]);
    assert.ok(ref && k > 1, out.slice(0, 200));
    const r = await readFileTool.execute({ path: ref, start_line: k }, ctx());
    assert.ok(!r.isError, r.content);
    assert.ok(r.content.length <= max, `${r.content.length} > ${max}`);
    assert.strictEqual(cm.clampToolOutput(r.content), r.content);
    assert.ok(!r.content.split('\n').slice(1).join('\n').includes('lp-cache://'));
    assert.match(r.content.split('\n')[1], new RegExp(`^\\s*${k} \\| row ${k} `));
    assert.match(r.content, /\[Showing lines \d+-\d+ of 2000\. Use start_line\/end_line to read more\.\]/);
  });
});
