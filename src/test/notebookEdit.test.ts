import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import { notebookEditTool } from '../tools/notebook';
import { applyNotebookJsonEdit, cellRangeError, describeCells, parseNotebookEditArgs, sourceLines } from '../tools/notebookCells';
import { generatePrompt, improvePrompt, NO_NOTEBOOK } from '../ui/notebook';
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

const NB = {
  cells: [
    { cell_type: 'markdown', id: 'aaaa0001', metadata: {}, source: ['# Title\n', 'intro'] },
    { cell_type: 'code', id: 'aaaa0002', metadata: { tags: ['x'] }, execution_count: 4, outputs: [{ output_type: 'stream', name: 'stdout', text: ['hi\n'] }], source: ['print("hi")'] },
  ],
  metadata: { language_info: { name: 'python' } },
  nbformat: 4,
  nbformat_minor: 5,
};

suite('Jupyter notebook_edit and cell commands', () => {
  test('parseNotebookEditArgs validates action, 1-based cell, type and source', () => {
    assert.deepStrictEqual(parseNotebookEditArgs({ action: 'insert', cell: '2', source: 'x' }), { action: 'insert', cell: 2, cellType: undefined, source: 'x' });
    assert.deepStrictEqual(parseNotebookEditArgs({ action: 'delete', cell: 1, source: 'ignored' }), { action: 'delete', cell: 1, cellType: undefined, source: undefined });
    assert.match(parseNotebookEditArgs({ action: 'move', cell: 1 }) as string, /action/);
    assert.match(parseNotebookEditArgs({ action: 'insert', cell: 0, source: '' }) as string, /1-based/);
    assert.match(parseNotebookEditArgs({ action: 'replace', cell: 1 }) as string, /source/);
    assert.match(parseNotebookEditArgs({ action: 'insert', cell: 1, cell_type: 'raw', source: '' }) as string, /cell_type/);
    assert.strictEqual(cellRangeError({ action: 'insert', cell: 3 }, 2), undefined);
    assert.match(cellRangeError({ action: 'replace', cell: 3 }, 2) ?? '', /out of range: the notebook has 2 cells/);
  });

  test('applyNotebookJsonEdit inserts, replaces (outputs cleared, id kept) and deletes, keeping the indentation', () => {
    const json = `${JSON.stringify(NB, null, 1)}\n`;
    const ins = applyNotebookJsonEdit(json, { action: 'insert', cell: 3, source: 'x = 1\ny = 2\n' });
    const a = JSON.parse(ins.json);
    assert.strictEqual(ins.cells, 3);
    assert.deepStrictEqual(a.cells[2].source, ['x = 1\n', 'y = 2\n']);
    assert.strictEqual(a.cells[2].cell_type, 'code');
    assert.match(a.cells[2].id, /^[0-9a-f]{8}$/);
    assert.ok(ins.json.startsWith('{\n "cells"') && ins.json.endsWith('}\n'), 'one-space indent and trailing newline kept');

    const rep = applyNotebookJsonEdit(json, { action: 'replace', cell: 2, source: 'print("bye")' });
    const b = JSON.parse(rep.json);
    assert.strictEqual(rep.before, 'print("hi")');
    assert.deepStrictEqual(b.cells[1], { cell_type: 'code', id: 'aaaa0002', metadata: { tags: ['x'] }, execution_count: null, outputs: [], source: ['print("bye")'] });

    const del = applyNotebookJsonEdit(json, { action: 'delete', cell: 1 });
    assert.strictEqual(del.cells, 1);
    assert.strictEqual(del.before, '# Title\nintro');
    assert.throws(() => applyNotebookJsonEdit('{"a":1}', { action: 'delete', cell: 1 }), /not a Jupyter notebook/);
    assert.deepStrictEqual(sourceLines(''), []);
  });

  test('describeCells: target and two neighbours each side, exec count, outputs capped, images as a marker', () => {
    const cells = Array.from({ length: 7 }, (_, i) => ({ kind: 'code' as const, language: 'python', source: `c${i}`, executionCount: i, outputs: i === 3 ? ['y'.repeat(2500), '[image output]'] : [] }));
    const text = describeCells(cells, 3);
    assert.ok(!/Cell 1 /.test(text) && /### Cell 2 /.test(text) && /### Cell 6 /.test(text) && !/Cell 7 /.test(text), text);
    assert.match(text, /### Cell 4 \(code, python, exec 3\) <- target/);
    assert.match(text, /output cut at 2,000 characters/);
    assert.match(text, /\[image output\]/);
  });

  test('cell command prompts point the agent at notebook_edit with the right cell number', () => {
    assert.match(generatePrompt('a.ipynb', 'plot it', 2, 'ctx'), /action "insert", cell 4/);
    assert.match(generatePrompt('a.ipynb', 'plot it', undefined, ''), /cell 1\b[\s\S]*The notebook is empty/);
    assert.match(improvePrompt('a.ipynb', '', 0, 'ctx'), /Improve cell 1 [\s\S]*action "replace", cell 1/);
    assert.strictEqual(NO_NOTEBOOK, 'No active Jupyter notebook. Open a .ipynb file first.');
  });

  test('notebook_edit edits a real notebook through the notebook API', async function () {
    if (!root()) {
      this.skip();
    }
    this.timeout(20_000);
    const file = path.join(root(), `lp-nbedit-${Date.now()}.ipynb`);
    await fs.writeFile(file, JSON.stringify(NB, null, 1));
    try {
      const rel = path.basename(file);
      let r = await notebookEditTool.execute({ path: rel, action: 'insert', cell: 3, source: 'z = 3' }, ctx());
      assert.ok(!r.isError, r.content);
      assert.match(r.content, /Inserted cell 3 into .*it now has 3 cells/);
      r = await notebookEditTool.execute({ path: rel, action: 'replace', cell: 1, cell_type: 'markdown', source: '# New title' }, ctx());
      assert.ok(!r.isError, r.content);
      r = await notebookEditTool.execute({ path: rel, action: 'delete', cell: 2 }, ctx());
      assert.ok(!r.isError, r.content);
      const out = await notebookEditTool.execute({ path: rel, action: 'replace', cell: 9, source: 'x' }, ctx());
      assert.ok(out.isError && /out of range/.test(out.content), out.content);
      const declined = await notebookEditTool.execute({ path: rel, action: 'delete', cell: 1 }, ctx(false));
      assert.ok(declined.isError && /declined/.test(declined.content));

      const doc = await vscode.workspace.openNotebookDocument(vscode.Uri.file(file));
      assert.deepStrictEqual(
        doc.getCells().map((c) => [c.kind === vscode.NotebookCellKind.Code ? 'code' : 'markdown', c.document.getText()]),
        [
          ['markdown', '# New title'],
          ['code', 'z = 3'],
        ]
      );
      const saved = JSON.parse(await fs.readFile(file, 'utf8'));
      assert.strictEqual(saved.cells.length, 2, 'saved to disk');
      assert.match((await notebookEditTool.execute({ path: 'x.txt', action: 'delete', cell: 1 }, ctx())).content, /\.ipynb/);
    } finally {
      await fs.rm(file, { force: true });
    }
  });

  test('notebook_edit creates a new notebook with an insert at cell 1', async function () {
    if (!root()) {
      this.skip();
    }
    const file = path.join(root(), `lp-nbnew-${Date.now()}.ipynb`);
    try {
      const r = await notebookEditTool.execute({ path: path.basename(file), action: 'insert', cell: 1, cell_type: 'markdown', source: '# Hello' }, ctx());
      assert.ok(!r.isError && /new notebook/.test(r.content), r.content);
      const nb = JSON.parse(await fs.readFile(file, 'utf8'));
      assert.deepStrictEqual(nb.cells.map((c: { cell_type: string }) => c.cell_type), ['markdown']);
      const missing = await notebookEditTool.execute({ path: 'lp-missing.ipynb', action: 'replace', cell: 1, source: '' }, ctx());
      assert.ok(missing.isError && /does not exist/.test(missing.content));
    } finally {
      await fs.rm(file, { force: true });
    }
  });

  test('the cell commands are registered and warn without a notebook', async () => {
    const all = await vscode.commands.getCommands(true);
    for (const id of ['localpilot.notebook.generateCell', 'localpilot.notebook.explainCell', 'localpilot.notebook.improveCell']) {
      assert.ok(all.includes(id), id);
    }
  });
});
