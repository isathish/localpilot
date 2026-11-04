import * as assert from 'assert';
import * as vscode from 'vscode';
import { postProcess, suffixRange } from '../ui/inlineCompletion';

async function suffixAt(content: string, line: number, character: number): Promise<string> {
  const doc = await vscode.workspace.openTextDocument({ content, language: 'typescript' });
  return doc.getText(suffixRange(doc, new vscode.Position(line, character)));
}

suite('Inline completion suffix', () => {
  test('cursor at the end of the last line has an empty suffix', async () => {
    assert.strictEqual(await suffixAt('const a = 1;\nconst b = 2;', 1, 12), '');
  });
  test('a single-line file keeps the rest of the line', async () => {
    assert.strictEqual(await suffixAt('foo(x)', 0, 4), 'x)');
  });
  test('a file without a final newline keeps its last line', async () => {
    assert.strictEqual(await suffixAt('function f() {\n  return 1;\n}', 0, 14), '\n  return 1;\n}');
  });
});

suite('Inline completion post-processing', () => {
  test('mid-line: text that repeats what follows the cursor is dropped', () => {
    assert.strictEqual(postProcess('bar)\nnext line', ')'), 'bar');
    assert.strictEqual(postProcess('bar(x))', ')'), 'bar(x)');
    assert.strictEqual(postProcess('x, y) {', ') {'), 'x, y');
    assert.strictEqual(postProcess('user.name)', ')'), 'user.name');
  });
  test('mid-line: a closer that pairs an opener in the completion is kept', () => {
    assert.strictEqual(postProcess('getValue()', ')'), 'getValue()');
    assert.strictEqual(postProcess('JSON.stringify(obj)', ')'), 'JSON.stringify(obj)');
    assert.strictEqual(postProcess('bar()', ');'), 'bar()');
    assert.strictEqual(postProcess('1, 2, [3]', '];'), '1, 2, [3]');
    assert.strictEqual(postProcess('"a"', '"'), '"a"');
  });
});
