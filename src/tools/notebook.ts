import * as vscode from 'vscode';
import * as fsp from 'fs/promises';
import * as path from 'path';
import { Tool, ToolContext, ToolResult } from '../types';
import { displayPath, excludedRefusal, resolveWorkspacePath } from './fs';
import { writePreview } from './lineDiff';
import { applyNotebookJsonEdit, cellRangeError, emptyNotebook, NotebookEditOp, parseNotebookEditArgs } from './notebookCells';

/** True when the notebook API can edit cells (VS Code; the CLI shim has no notebooks and edits the JSON). */
function hasNotebookApi(): boolean {
  return typeof vscode.NotebookEdit === 'function' && typeof vscode.workspace.openNotebookDocument === 'function';
}

async function openNotebook(uri: vscode.Uri): Promise<vscode.NotebookDocument | undefined> {
  if (!hasNotebookApi()) {
    return undefined;
  }
  try {
    return await vscode.workspace.openNotebookDocument(uri);
  } catch {
    // No serializer for the file (the built-in ipynb extension is off): edit the JSON instead.
    return undefined;
  }
}

/** Applies `op` through the notebook API, so an open notebook editor updates in place, then saves. */
async function applyWithApi(doc: vscode.NotebookDocument, op: NotebookEditOp): Promise<boolean> {
  const i = op.cell - 1;
  const prev = op.action === 'replace' ? doc.cellAt(i) : undefined;
  const kind = op.cellType ?? (prev ? (prev.kind === vscode.NotebookCellKind.Markup ? 'markdown' : 'code') : 'code');
  const codeLang = doc.getCells().find((c) => c.kind === vscode.NotebookCellKind.Code)?.document.languageId ?? 'python';
  const data = () => {
    const cell = new vscode.NotebookCellData(kind === 'markdown' ? vscode.NotebookCellKind.Markup : vscode.NotebookCellKind.Code, op.source ?? '', kind === 'markdown' ? 'markdown' : codeLang);
    if (prev && (prev.kind === vscode.NotebookCellKind.Markup) === (kind === 'markdown')) {
      cell.metadata = prev.metadata;
    }
    return cell;
  };
  const edit =
    op.action === 'insert'
      ? vscode.NotebookEdit.insertCells(i, [data()])
      : op.action === 'replace'
        ? vscode.NotebookEdit.replaceCells(new vscode.NotebookRange(i, i + 1), [data()])
        : vscode.NotebookEdit.deleteCells(new vscode.NotebookRange(i, i + 1));
  const we = new vscode.WorkspaceEdit();
  we.set(doc.uri, [edit]);
  if (!(await vscode.workspace.applyEdit(we))) {
    return false;
  }
  await doc.save();
  return true;
}

function summary(op: NotebookEditOp, rel: string, cells: number, created: boolean): string {
  const what = op.action === 'delete' ? 'Deleted' : op.action === 'insert' ? 'Inserted' : 'Replaced';
  const type = op.action !== 'delete' && op.cellType ? `${op.cellType} ` : '';
  return `${what} ${type}cell ${op.cell} ${op.action === 'insert' ? 'into' : 'of'} ${rel}${created ? ' (new notebook)' : ''}; it now has ${cells} cell${cells === 1 ? '' : 's'}.`;
}

export const notebookEditTool: Tool = {
  approvalKind: 'write',
  definition: {
    name: 'notebook_edit',
    description:
      'Insert, replace or delete one cell of a Jupyter notebook (.ipynb). Cells are numbered from 1 as read_file shows them ("# [code] cell 3"). insert puts the new cell at that number (cells count + 1 appends); replace swaps the cell\'s whole source (its outputs are cleared). Use this instead of editing the notebook JSON.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'The .ipynb file.' },
        action: { type: 'string', enum: ['insert', 'replace', 'delete'] },
        cell: { type: 'integer', description: '1-based cell number.' },
        cell_type: { type: 'string', enum: ['code', 'markdown'], description: 'Default: code for insert, the current type for replace.' },
        source: { type: 'string', description: 'The complete cell text (insert and replace).' },
      },
      required: ['path', 'action', 'cell'],
    },
  },
  async execute(args, ctx: ToolContext): Promise<ToolResult> {
    if (typeof args.path !== 'string' || !/\.ipynb$/i.test(args.path)) {
      return { content: 'notebook_edit needs "path": a .ipynb file. Use edit_file for other files.', isError: true };
    }
    const op = parseNotebookEditArgs(args);
    if (typeof op === 'string') {
      return { content: op, isError: true };
    }
    const refused = excludedRefusal(args.path, ctx);
    if (refused) {
      return refused;
    }
    const uri = resolveWorkspacePath(args.path, ctx);
    const rel = displayPath(uri, ctx);
    let raw: string | undefined;
    try {
      raw = await fsp.readFile(uri.fsPath, 'utf8');
    } catch {
      raw = undefined;
    }
    if (raw === undefined && !(op.action === 'insert' && op.cell === 1)) {
      return { content: `${rel} does not exist. To start a notebook, insert cell 1.`, isError: true };
    }
    const doc = raw === undefined ? undefined : await openNotebook(uri);
    let count: number;
    let before: string | undefined;
    if (doc) {
      count = doc.cellCount;
      const bad = cellRangeError(op, count);
      if (bad) {
        return { content: bad, isError: true };
      }
      before = op.action === 'insert' ? undefined : doc.cellAt(op.cell - 1).document.getText();
    } else {
      try {
        const dry = applyNotebookJsonEdit(raw ?? emptyNotebook(), op);
        count = dry.cells;
        before = dry.before;
      } catch (e) {
        return { content: `Cannot edit ${rel}: ${e instanceof Error ? e.message : String(e)}`, isError: true };
      }
    }
    const verb = op.action === 'insert' ? 'Insert cell' : op.action === 'replace' ? 'Replace cell' : 'Delete cell';
    const ok = await ctx.requestApproval(`${verb} ${op.cell} in ${rel}`, op.action === 'delete' ? (before ?? '').split('\n').map((l) => `-${l}`).join('\n') : writePreview(before, op.source ?? ''), 'write');
    if (!ok) {
      return { content: 'User declined the notebook edit.', isError: true };
    }
    await ctx.trackChange(uri.fsPath);
    if (doc) {
      if (!(await applyWithApi(doc, op))) {
        return { content: 'Failed to apply the notebook edit.', isError: true };
      }
      count = doc.cellCount;
    } else {
      const next = applyNotebookJsonEdit(raw ?? emptyNotebook(), op);
      await fsp.mkdir(path.dirname(uri.fsPath), { recursive: true });
      await fsp.writeFile(uri.fsPath, next.json, 'utf8');
      count = next.cells;
    }
    return { content: summary(op, rel, count, raw === undefined), data: { path: uri.fsPath, kind: raw === undefined ? 'create' : 'update' } };
  },
};

export const notebookTools: Tool[] = [notebookEditTool];
