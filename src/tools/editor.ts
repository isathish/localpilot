import * as vscode from 'vscode';
import { Tool } from '../types';
import { resolveWorkspacePath } from './fs';

export const getDiagnosticsTool: Tool = {
  parallelSafe: true,
  definition: {
    name: 'get_diagnostics',
    description: 'Get compiler/linter errors and warnings reported by VS Code language servers. Optionally filter to one file.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Restrict to this file (optional)' },
        severity: { type: 'string', enum: ['error', 'warning', 'all'], description: 'Default "error"' },
      },
    },
  },
  async execute(args, ctx) {
    const sev = String(args.severity ?? 'error');
    const minSev = sev === 'all' ? vscode.DiagnosticSeverity.Hint : sev === 'warning' ? vscode.DiagnosticSeverity.Warning : vscode.DiagnosticSeverity.Error;
    let entries: [vscode.Uri, vscode.Diagnostic[]][];
    if (typeof args.path === 'string' && args.path) {
      const uri = resolveWorkspacePath(args.path, ctx);
      // Ensure the document is open so the language server has analysed it.
      await vscode.workspace.openTextDocument(uri);
      await new Promise((r) => setTimeout(r, 400));
      entries = [[uri, vscode.languages.getDiagnostics(uri)]];
    } else {
      entries = vscode.languages.getDiagnostics();
    }
    const lines: string[] = [];
    for (const [uri, diags] of entries) {
      for (const d of diags) {
        if (d.severity <= minSev) {
          lines.push(`${vscode.workspace.asRelativePath(uri)}:${d.range.start.line + 1}:${d.range.start.character + 1} [${vscode.DiagnosticSeverity[d.severity]}] ${d.message}${d.source ? ` (${d.source})` : ''}`);
        }
        if (lines.length >= 200) {
          break;
        }
      }
    }
    return { content: lines.length ? lines.join('\n') : 'No diagnostics.' };
  },
};

export const openEditorsTool: Tool = {
  parallelSafe: true,
  definition: {
    name: 'get_editor_state',
    description: 'Get the active file, cursor position, selected text and the list of open editors.',
    parameters: { type: 'object', properties: {} },
  },
  async execute() {
    const ed = vscode.window.activeTextEditor;
    const open = vscode.window.tabGroups.all
      .flatMap((g) => g.tabs)
      .map((t) => (t.input instanceof vscode.TabInputText ? vscode.workspace.asRelativePath(t.input.uri) : null))
      .filter(Boolean);
    let out = `Open editors:\n${open.join('\n') || '(none)'}`;
    if (ed) {
      out += `\n\nActive: ${vscode.workspace.asRelativePath(ed.document.uri)} line ${ed.selection.active.line + 1}`;
      if (!ed.selection.isEmpty) {
        out += `\nSelection:\n${ed.document.getText(ed.selection).slice(0, 8000)}`;
      }
    }
    return { content: out };
  },
};

export const openFileTool: Tool = {
  definition: {
    name: 'open_file',
    description: 'Open a file in the editor for the user, optionally at a line.',
    parameters: { type: 'object', properties: { path: { type: 'string' }, line: { type: 'integer' } }, required: ['path'] },
  },
  async execute(args, ctx) {
    const uri = resolveWorkspacePath(String(args.path), ctx);
    const doc = await vscode.workspace.openTextDocument(uri);
    const ed = await vscode.window.showTextDocument(doc, { preview: false });
    if (args.line) {
      const pos = new vscode.Position(Math.max(0, Number(args.line) - 1), 0);
      ed.selection = new vscode.Selection(pos, pos);
      ed.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
    }
    return { content: `Opened ${vscode.workspace.asRelativePath(uri)}` };
  },
};

export const askUserTool: Tool = {
  definition: {
    name: 'ask_user',
    description: 'Ask the user a clarifying question and wait for their answer. Use sparingly, only when genuinely blocked.',
    parameters: {
      type: 'object',
      properties: { question: { type: 'string' }, options: { type: 'array', items: { type: 'string' }, description: 'Optional fixed choices' } },
      required: ['question'],
    },
  },
  async execute(args) {
    const q = String(args.question ?? '');
    const options = Array.isArray(args.options) ? (args.options as string[]) : [];
    let answer: string | undefined;
    if (options.length) {
      answer = await vscode.window.showQuickPick(options, { title: 'LocalPilot asks', placeHolder: q, ignoreFocusOut: true });
    } else {
      answer = await vscode.window.showInputBox({ title: 'LocalPilot asks', prompt: q, ignoreFocusOut: true });
    }
    return answer === undefined ? { content: 'User dismissed the question without answering.' } : { content: `User answered: ${answer}` };
  },
};

export const editorTools: Tool[] = [getDiagnosticsTool, openEditorsTool, openFileTool, askUserTool];
