import * as vscode from 'vscode';
import { CellInfo, describeCells } from '../tools/notebookCells';

export const NO_NOTEBOOK = 'No active Jupyter notebook. Open a .ipynb file first.';

/** Starts a chat session with `prompt` in `mode` (wired to the chat controller by the extension). */
export type StartNotebookChat = (title: string, prompt: string, mode: 'agent' | 'ask') => Promise<void>;

const decoder = new TextDecoder();

/** One output as text: images become `[image output]`, errors `Name: message`, other rich outputs their mime type. */
function outputText(output: vscode.NotebookCellOutput): string {
  const items = output.items;
  if (items.some((i) => i.mime.startsWith('image/'))) {
    return '[image output]';
  }
  const err = items.find((i) => i.mime === 'application/vnd.code.notebook.error');
  if (err) {
    try {
      const e = JSON.parse(decoder.decode(err.data)) as { name?: string; message?: string };
      return `${e.name ?? 'Error'}: ${e.message ?? ''}`;
    } catch {
      return '[error output]';
    }
  }
  const text = items.filter((i) => /^(text\/plain|text\/markdown|application\/vnd\.code\.notebook\.(stdout|stderr))$/.test(i.mime));
  if (text.length) {
    return text.map((i) => decoder.decode(i.data)).join('');
  }
  return items.length ? `[${items[0].mime} output]` : '';
}

export function cellInfo(cell: vscode.NotebookCell): CellInfo {
  const code = cell.kind === vscode.NotebookCellKind.Code;
  return {
    kind: code ? 'code' : 'markdown',
    language: code ? cell.document.languageId : undefined,
    source: cell.document.getText(),
    executionCount: cell.executionSummary?.executionOrder,
    outputs: cell.outputs.map(outputText),
  };
}

const isJupyter = (nb: vscode.NotebookDocument | undefined): nb is vscode.NotebookDocument => nb?.notebookType === 'jupyter-notebook';

/**
 * The notebook and cell a command acts on: a cell-toolbar argument (a NotebookCell), a notebook-toolbar argument
 * (an editor or document), else the active notebook editor and its selected cell. Undefined without a Jupyter notebook.
 */
function target(arg: unknown): { nb: vscode.NotebookDocument; index?: number } | undefined {
  const a = arg as Partial<vscode.NotebookCell & vscode.NotebookEditor & { notebookEditor: { notebookUri?: vscode.Uri } }> | undefined;
  const active = vscode.window.activeNotebookEditor;
  if (a && typeof a.index === 'number' && isJupyter(a.notebook)) {
    return { nb: a.notebook, index: a.index };
  }
  if (a && isJupyter(a.notebook) && a.selection) {
    return { nb: a.notebook, index: a.notebook.cellCount ? a.selection.start : undefined };
  }
  const uri = a?.notebookEditor?.notebookUri;
  const nb = uri ? vscode.workspace.notebookDocuments.find((d) => d.uri.toString() === uri.toString()) : active?.notebook;
  if (!isJupyter(nb)) {
    return undefined;
  }
  const sel = active?.notebook === nb ? active.selection : undefined;
  return { nb, index: nb.cellCount ? Math.min(sel?.start ?? nb.cellCount - 1, nb.cellCount - 1) : undefined };
}

function context(nb: vscode.NotebookDocument, index: number): string {
  return describeCells(nb.getCells().map(cellInfo), index);
}

/** Prompt for "Generate cell": insert after `index` (or as cell 1 into an empty notebook). */
export function generatePrompt(rel: string, ask: string, index: number | undefined, ctx: string): string {
  const at = index === undefined ? 1 : index + 2;
  return [
    `In the Jupyter notebook ${rel}, add a new cell: ${ask}`,
    `Insert it as cell ${at} with notebook_edit (action "insert", cell ${at}); do not edit the .ipynb JSON. Use a markdown cell only if the request is for prose.`,
    ctx ? `Nearby cells:\n${ctx}` : 'The notebook is empty.',
  ].join('\n\n');
}

export function improvePrompt(rel: string, ask: string, index: number, ctx: string): string {
  return [
    `Improve cell ${index + 1} of the Jupyter notebook ${rel}${ask ? `: ${ask}` : ' (clarity, correctness and performance, keeping its behaviour)'}.`,
    `Replace it with notebook_edit (action "replace", cell ${index + 1}); do not edit the .ipynb JSON. Then explain the change briefly.`,
    `Cells:\n${ctx}`,
  ].join('\n\n');
}

export function explainPrompt(rel: string, index: number, ctx: string): string {
  return `Explain cell ${index + 1} of the Jupyter notebook ${rel}: what it does, how it uses the cells around it, and what its output shows.\n\nCells:\n${ctx}`;
}

/** Registers the Jupyter cell commands (notebook toolbar: generate; cell title: explain, improve). */
export function registerNotebookCommands(start: StartNotebookChat): vscode.Disposable[] {
  const resolve = (arg: unknown) => {
    const t = target(arg);
    if (!t) {
      void vscode.window.showWarningMessage(NO_NOTEBOOK);
    }
    return t;
  };
  const rel = (nb: vscode.NotebookDocument) => vscode.workspace.asRelativePath(nb.uri, false);
  const name = (nb: vscode.NotebookDocument) => rel(nb).split('/').pop() ?? rel(nb);
  return [
    vscode.commands.registerCommand('localpilot.notebook.generateCell', async (arg?: unknown) => {
      const t = resolve(arg);
      if (!t) {
        return;
      }
      const ask = await vscode.window.showInputBox({ title: 'Generate notebook cell', prompt: 'Describe the cell to add', placeHolder: 'e.g. plot the monthly totals as a bar chart' });
      if (!ask?.trim()) {
        return;
      }
      await start(`Notebook: ${name(t.nb)}`, generatePrompt(rel(t.nb), ask.trim(), t.index, t.index === undefined ? '' : context(t.nb, t.index)), 'agent');
    }),
    vscode.commands.registerCommand('localpilot.notebook.improveCell', async (arg?: unknown) => {
      const t = resolve(arg);
      if (!t) {
        return;
      }
      if (t.index === undefined) {
        return void vscode.window.showInformationMessage('The notebook has no cells to improve.');
      }
      const ask = await vscode.window.showInputBox({ title: `Improve cell ${t.index + 1}`, prompt: 'What should change? Leave empty for a general clean-up', placeHolder: 'e.g. vectorise the loop' });
      if (ask === undefined) {
        return;
      }
      await start(`Improve cell ${t.index + 1}: ${name(t.nb)}`, improvePrompt(rel(t.nb), ask.trim(), t.index, context(t.nb, t.index)), 'agent');
    }),
    vscode.commands.registerCommand('localpilot.notebook.explainCell', async (arg?: unknown) => {
      const t = resolve(arg);
      if (!t) {
        return;
      }
      if (t.index === undefined) {
        return void vscode.window.showInformationMessage('The notebook has no cells to explain.');
      }
      await start(`Explain cell ${t.index + 1}: ${name(t.nb)}`, explainPrompt(rel(t.nb), t.index, context(t.nb, t.index)), 'ask');
    }),
  ];
}
