/** Pure helpers behind "Add to Chat" (editor selection, code actions, terminal selection); no `vscode` import. */

export interface LineSpan {
  /** 0-based, inclusive. */
  start: number;
  end: number;
}

export interface ProblemLine {
  /** 0-based line of the diagnostic's start. */
  line: number;
  /** `vscode.DiagnosticSeverity`: 0 error, 1 warning, 2 information, 3 hint. */
  severity: number;
  message: string;
  source?: string;
}

/** Lines a selection covers; a selection ending at column 0 of a later line does not include that line. */
export function selectionLines(startLine: number, endLine: number, endCharacter: number): LineSpan {
  return { start: startLine, end: endLine > startLine && endCharacter === 0 ? endLine - 1 : endLine };
}

/** The cursor line plus `pad` lines either side, clamped to the document (an empty selection in a code action). */
export function expandAroundLine(line: number, lineCount: number, pad = 3): LineSpan {
  const last = Math.max(0, lineCount - 1);
  return { start: Math.max(0, line - pad), end: Math.min(last, line + pad) };
}

/** The `rel#Lx-Ly` chip for a span. */
export function selectionRef(rel: string, span: LineSpan): string {
  return `${rel}#L${span.start + 1}-L${span.end + 1}`;
}

const SEVERITY = ['error', 'warning', 'info', 'hint'];

/** A "Problems:" draft block for the diagnostics in a selection, or '' when there are none. */
export function problemsDraft(rel: string, problems: ProblemLine[], max = 20): string {
  if (!problems.length) {
    return '';
  }
  const sorted = [...problems].sort((a, b) => a.severity - b.severity || a.line - b.line);
  const lines = sorted.slice(0, max).map((p) => `- ${rel}:${p.line + 1} [${SEVERITY[p.severity] ?? 'info'}${p.source ? ` ${p.source}` : ''}] ${p.message.split('\n')[0].trim()}`);
  if (sorted.length > max) {
    lines.push(`- …and ${sorted.length - max} more`);
  }
  return `Problems:\n${lines.join('\n')}`;
}

/** A fenced block that cannot be closed early by backticks inside `text`. */
export function fenced(text: string, lang = ''): string {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((r) => r.length));
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return `${fence}${lang}\n${text.replace(/\s+$/, '')}\n${fence}`;
}

/** The draft for a terminal selection, trimmed to `maxChars` (head and tail kept). */
export function terminalSelectionDraft(selection: string, maxChars = 12_000): string {
  let out = selection.replace(/\r\n/g, '\n').trim();
  if (out.length > maxChars) {
    out = `${out.slice(0, maxChars / 2)}\n…[${out.length - maxChars} chars omitted]…\n${out.slice(-maxChars / 2)}`;
  }
  return `Terminal output:\n${fenced(out)}`;
}

export interface ClipboardDeps {
  readText(): Thenable<string> | Promise<string>;
  writeText(text: string): Thenable<void> | Promise<void>;
  /** Copies the active terminal's selection to the clipboard (does nothing without a selection). */
  copySelection(): Thenable<unknown> | Promise<unknown>;
}

/**
 * The active terminal's selected text, or '' without one. A sentinel tells "nothing selected" apart from a clipboard
 * that already held text, and the user's clipboard is restored either way.
 */
export async function readTerminalSelection(deps: ClipboardDeps): Promise<string> {
  const saved = await Promise.resolve(deps.readText()).catch(() => undefined);
  const sentinel = `localpilot-no-selection-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  try {
    await deps.writeText(sentinel);
    await Promise.resolve(deps.copySelection()).catch(() => undefined);
    const text = await deps.readText();
    return text === sentinel ? '' : text;
  } catch {
    return '';
  } finally {
    if (saved !== undefined) {
      await Promise.resolve(deps.writeText(saved)).catch(() => undefined);
    }
  }
}
