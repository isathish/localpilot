/**
 * Jupyter cell logic shared by the notebook_edit tool and the notebook commands, free of the VS Code API: argument
 * parsing, the raw `.ipynb` JSON edit (the CLI, and a fallback when no notebook serializer is available), and the cell
 * context a notebook command sends to the model.
 */

export type NotebookEditAction = 'insert' | 'replace' | 'delete';
export type NotebookCellKind = 'code' | 'markdown';

export interface NotebookEditOp {
  action: NotebookEditAction;
  /** 1-based cell number, as read_file shows it; an insert at `cells + 1` appends. */
  cell: number;
  cellType?: NotebookCellKind;
  source?: string;
}

/** The validated notebook_edit arguments, or the error to return to the model. */
export function parseNotebookEditArgs(args: Record<string, unknown>): NotebookEditOp | string {
  const action = args.action;
  if (action !== 'insert' && action !== 'replace' && action !== 'delete') {
    return 'notebook_edit needs "action": "insert", "replace" or "delete".';
  }
  const cell = typeof args.cell === 'string' && /^\d+$/.test(args.cell.trim()) ? Number(args.cell) : args.cell;
  if (typeof cell !== 'number' || !Number.isInteger(cell) || cell < 1) {
    return 'notebook_edit needs "cell": the 1-based cell number (read_file shows "# [code] cell 3").';
  }
  const type = typeof args.cell_type === 'string' ? args.cell_type.toLowerCase() : undefined;
  if (type !== undefined && type !== 'code' && type !== 'markdown') {
    return '"cell_type" must be "code" or "markdown".';
  }
  if (action !== 'delete' && typeof args.source !== 'string') {
    return `notebook_edit ${action} needs "source": the complete cell text.`;
  }
  return { action, cell, cellType: type, source: action === 'delete' ? undefined : (args.source as string) };
}

/** A problem with the cell number for a notebook of `count` cells; undefined when the edit fits. */
export function cellRangeError(op: NotebookEditOp, count: number): string | undefined {
  const max = op.action === 'insert' ? count + 1 : count;
  if (op.cell > max) {
    return count === 0 && op.action !== 'insert'
      ? 'The notebook has no cells. Use action "insert" with cell 1.'
      : `Cell ${op.cell} is out of range: the notebook has ${count} cell${count === 1 ? '' : 's'}${op.action === 'insert' ? ` (insert at ${count + 1} to append)` : ''}.`;
  }
  return undefined;
}

type RawCell = { cell_type?: string; id?: string; metadata?: Record<string, unknown>; source?: string | string[]; outputs?: unknown[]; execution_count?: number | null; attachments?: unknown };
type RawNotebook = { cells?: RawCell[]; metadata?: Record<string, unknown>; nbformat?: number; nbformat_minor?: number };

const joined = (v: unknown): string => (Array.isArray(v) ? v.join('') : typeof v === 'string' ? v : '');

/** nbformat stores source as lines that keep their newline (the last one without). */
export function sourceLines(text: string): string[] {
  return text === '' ? [] : text.split(/(?<=\n)/);
}

const cellId = (): string => Math.random().toString(16).slice(2, 10).padEnd(8, '0');

/** A fresh notebook (nbformat 4.5) for an insert into a file that does not exist yet. */
export function emptyNotebook(language = 'python'): string {
  return `${JSON.stringify({ cells: [], metadata: { language_info: { name: language } }, nbformat: 4, nbformat_minor: 5 }, null, 1)}\n`;
}

/**
 * Applies one cell edit to `.ipynb` JSON, keeping the file's indentation. A replaced code cell loses its outputs and
 * execution count (they belong to the old source); a cell keeps its id and metadata when its type is unchanged.
 * Throws when the text is not notebook JSON or the cell number is out of range.
 */
export function applyNotebookJsonEdit(json: string, op: NotebookEditOp): { json: string; before?: string; cells: number } {
  const nb = JSON.parse(json) as RawNotebook;
  if (!nb || typeof nb !== 'object' || !Array.isArray(nb.cells)) {
    throw new Error('not a Jupyter notebook (no "cells" array)');
  }
  const cells = nb.cells;
  const bad = cellRangeError(op, cells.length);
  if (bad) {
    throw new Error(bad);
  }
  const i = op.cell - 1;
  const withIds = (nb.nbformat ?? 4) > 4 || ((nb.nbformat ?? 4) === 4 && (nb.nbformat_minor ?? 0) >= 5);
  const make = (type: NotebookCellKind, source: string, prev?: RawCell): RawCell => {
    const keep = prev && prev.cell_type === type;
    const base: RawCell = { cell_type: type };
    if (withIds) {
      base.id = keep && prev.id ? prev.id : cellId();
    }
    base.metadata = keep && prev.metadata ? prev.metadata : {};
    if (type === 'code') {
      return { ...base, execution_count: null, outputs: [], source: sourceLines(source) };
    }
    return { ...base, ...(keep && prev.attachments ? { attachments: prev.attachments } : {}), source: sourceLines(source) };
  };
  let before: string | undefined;
  if (op.action === 'insert') {
    cells.splice(i, 0, make(op.cellType ?? 'code', op.source ?? ''));
  } else if (op.action === 'replace') {
    const prev = cells[i];
    before = joined(prev.source);
    cells[i] = make(op.cellType ?? (prev.cell_type === 'markdown' ? 'markdown' : 'code'), op.source ?? '', prev);
  } else {
    before = joined(cells[i].source);
    cells.splice(i, 1);
  }
  const indent = /^\s*\{\r?\n([ \t]+)"/.exec(json)?.[1] ?? (json.trim().includes('\n') ? 1 : 0);
  const out = JSON.stringify(nb, null, indent);
  return { json: /\n\s*$/.test(json) ? `${out}\n` : out, before, cells: cells.length };
}

/** One cell as the notebook commands see it; `outputs` are already text (`[image output]` for images). */
export interface CellInfo {
  kind: NotebookCellKind;
  language?: string;
  source: string;
  executionCount?: number;
  outputs: string[];
}

/** One output's text, capped at `max` characters. */
export function capOutput(text: string, max = 2000): string {
  const t = text.replace(/\s+$/, '');
  return t.length > max ? `${t.slice(0, max)}\n… [output cut at ${max.toLocaleString()} characters]` : t;
}

/**
 * The context for a cell command: the target cell (1-based `index` + 1 in the header) and up to `neighbours` cells
 * before and after it, each with its type, source, execution count and capped text outputs.
 */
export function describeCells(cells: CellInfo[], index: number, neighbours = 2, maxOutput = 2000): string {
  const from = Math.max(0, index - neighbours);
  const to = Math.min(cells.length - 1, index + neighbours);
  const out: string[] = [];
  for (let i = from; i <= to; i++) {
    const c = cells[i];
    const facts = [c.kind, c.kind === 'code' && c.language ? c.language : '', c.kind === 'code' && typeof c.executionCount === 'number' ? `exec ${c.executionCount}` : ''].filter(Boolean).join(', ');
    out.push(`### Cell ${i + 1} (${facts})${i === index ? ' <- target' : ''}`);
    const fence = c.source.includes('```') ? '~~~~' : '```';
    out.push(`${fence}${c.kind === 'code' ? (c.language ?? '') : 'markdown'}\n${c.source.replace(/\s+$/, '')}\n${fence}`);
    const texts = c.outputs.map((o) => capOutput(o, maxOutput)).filter(Boolean);
    if (texts.length) {
      out.push(`Output:\n${texts.join('\n')}`);
    }
  }
  return out.join('\n');
}
