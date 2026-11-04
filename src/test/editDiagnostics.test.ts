import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import { editFileTool, readFileTool } from '../tools/fs';
import { newErrorLines } from '../tools/editDiagnostics';
import { notebookToCompactText } from '../context/extractors';
import { ToolContext } from '../types';

const root = (): string => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';

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

suite('New errors after an edit', () => {
  test('newErrorLines keeps only errors not seen before, 1-based, at most 10', () => {
    const before = [{ line: 2, message: 'old' }];
    assert.deepStrictEqual(newErrorLines(before, [{ line: 2, message: 'old' }, { line: 4, message: 'Type error\n  detail' }]), ['5: Type error detail']);
    assert.deepStrictEqual(newErrorLines(before, [{ line: 2, message: 'old' }, { line: 7, message: 'old' }]), ['8: old'], 'a second error with an old message is new');
    assert.deepStrictEqual(newErrorLines([], [{ line: 0, message: 'x' }, { line: 0, message: 'x' }]), ['1: x'], 'duplicates collapse');
    const many = Array.from({ length: 15 }, (_, i) => ({ line: i, message: `e${i}` }));
    assert.strictEqual(newErrorLines([], many).length, 10);
    assert.deepStrictEqual(newErrorLines(many, many), []);
  });

  test('newErrorLines does not report old errors that an edit moved to other lines', () => {
    // 3 lines inserted at line 10: the errors at 50 and 60 are now at 53 and 63; a new one appears at 11.
    const before = [{ line: 4, message: 'a' }, { line: 49, message: 'b' }, { line: 59, message: 'b' }];
    const after = [{ line: 4, message: 'a' }, { line: 10, message: 'c' }, { line: 52, message: 'b' }, { line: 62, message: 'b' }];
    assert.deepStrictEqual(newErrorLines(before, after), ['11: c']);
    assert.deepStrictEqual(newErrorLines(before, [...after, { line: 70, message: 'b' }]), ['11: c', '71: b'], 'an extra occurrence of a message is new');
    assert.deepStrictEqual(newErrorLines([{ line: 49, message: 'b' }], [{ line: 46, message: 'b' }]), [], 'lines removed above');
  });

  test('edit_file reports a type error it introduces in a TypeScript file', async function () {
    if (!root() || !vscode.extensions.getExtension('vscode.typescript-language-features')?.isActive) {
      this.skip();
    }
    this.timeout(30_000);
    const file = path.join(root(), `lp-newerr-${Date.now()}.ts`);
    await fs.writeFile(file, 'export const n: number = 1;\n');
    try {
      const doc = await vscode.workspace.openTextDocument(file);
      await vscode.window.showTextDocument(doc);
      // Let the TS server pick the file up before the edit, so the edit's diagnostics are what arrives next.
      await new Promise((r) => setTimeout(r, 2500));
      const r = await editFileTool.execute({ path: file, old_text: '= 1;', new_text: "= 'one';" }, ctx());
      assert.ok(!r.isError, r.content);
      assert.match(r.content, /New problems:\n1: Type 'string' is not assignable to type 'number'/);
    } finally {
      await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
      await fs.rm(file, { force: true });
    }
  });

  test('the setting turns the report off', async function () {
    if (!root()) {
      this.skip();
    }
    const cfg = vscode.workspace.getConfiguration('localpilot');
    await cfg.update('edit.reportNewErrors', false, vscode.ConfigurationTarget.Global);
    const file = path.join(root(), `lp-newerr-off-${Date.now()}.ts`);
    await fs.writeFile(file, 'export const n: number = 1;\n');
    try {
      const started = Date.now();
      const r = await editFileTool.execute({ path: file, old_text: '= 1;', new_text: "= 'one';" }, ctx());
      assert.ok(!/New problems/.test(r.content));
      assert.ok(Date.now() - started < 1500, 'no wait for diagnostics when disabled');
    } finally {
      await cfg.update('edit.reportNewErrors', undefined, vscode.ConfigurationTarget.Global);
      await fs.rm(file, { force: true });
    }
  });
});

suite('Notebook-aware read_file', () => {
  const nb = {
    cells: [
      { cell_type: 'markdown', source: ['# Title\n', 'Intro'] },
      {
        cell_type: 'code',
        execution_count: 12,
        source: 'print(1)\nplot()',
        outputs: [
          { output_type: 'stream', text: ['1\n'] },
          { output_type: 'display_data', data: { 'image/png': 'iVBOR', 'text/plain': '<Figure size 640x480>' } },
          { output_type: 'execute_result', data: { 'text/plain': '42' } },
          { output_type: 'error', ename: 'ValueError', evalue: 'bad' },
        ],
      },
      { cell_type: 'code', execution_count: null, source: 'x', outputs: [{ output_type: 'stream', text: 'y'.repeat(3000) }] },
    ],
  };

  test('notebookToCompactText: cell headers with exec counts, text outputs, images dropped, long output cut', () => {
    const { text, cells } = notebookToCompactText(JSON.stringify(nb));
    assert.strictEqual(cells, 3);
    assert.ok(text.startsWith('# [markdown] cell 1\n# Title\nIntro\n# [code] cell 2 (exec 12)\nprint(1)\nplot()\n# output:\n1\n42\nValueError: bad\n# [code] cell 3\nx\n# output:\n'), text);
    assert.ok(!/Figure|image|iVBOR/.test(text));
    assert.match(text, /y{2000}\n… \[output cut at 2,000 characters\]$/);
    assert.throws(() => notebookToCompactText('{"nbformat": 4}'), /not a Jupyter notebook/);
  });

  test('read_file returns the compact cells and windows them by line; invalid JSON reads as text', async function () {
    if (!root()) {
      this.skip();
    }
    const file = path.join(root(), `lp-nb-${Date.now()}.ipynb`);
    const bad = path.join(root(), `lp-nb-bad-${Date.now()}.ipynb`);
    await fs.writeFile(file, JSON.stringify(nb, null, 1));
    await fs.writeFile(bad, 'not json');
    try {
      const r = await readFileTool.execute({ path: file }, ctx());
      assert.ok(!r.isError, r.content);
      assert.match(r.content, /^Notebook: .*lp-nb-.*\.ipynb \(3 cells as \d+ lines/);
      assert.match(r.content, /# \[code\] cell 2 \(exec 12\)/);
      assert.ok(!/"cell_type"/.test(r.content), 'not the raw JSON');
      const part = await readFileTool.execute({ path: file, start_line: 4, end_line: 4 }, ctx());
      assert.match(part.content, /showing 4-4\)\n\s*4 \| # \[code\] cell 2 \(exec 12\)/);
      const raw = await readFileTool.execute({ path: bad }, ctx());
      assert.match(raw.content, /^File: .*\n\s*1 \| not json/);
    } finally {
      await fs.rm(file, { force: true });
      await fs.rm(bad, { force: true });
    }
  });
});
