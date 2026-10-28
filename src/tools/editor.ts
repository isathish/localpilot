import * as vscode from 'vscode';
import { Tool } from '../types';
import { resolveWorkspacePath } from './fs';

/** Resolves when the language server next publishes diagnostics for `uri` (plus a short settle), or after `maxMs`. */
function waitForDiagnostics(uri: vscode.Uri, maxMs: number): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    let sub: vscode.Disposable | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (): void => {
      if (!done) {
        done = true;
        clearTimeout(timer);
        sub?.dispose();
        resolve();
      }
    };
    // Subscribe before arming the timeout: a host without the event (the CLI) must not leave a timer that later
    // touches an unassigned `sub` and takes the process down.
    if (typeof vscode.languages.onDidChangeDiagnostics !== 'function') {
      return resolve();
    }
    sub = vscode.languages.onDidChangeDiagnostics((e) => {
      if (e.uris.some((u) => u.toString() === uri.toString())) {
        setTimeout(finish, 120);
      }
    });
    timer = setTimeout(finish, maxMs);
  });
}

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
      // Ensure the document is open so the language server has analysed it, then give it a moment to
      // report — returning as soon as diagnostics for this file change instead of always waiting the maximum.
      await vscode.workspace.openTextDocument(uri);
      await waitForDiagnostics(uri, 400);
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
    description:
      'Ask the user one clarifying question and wait for the answer. Last resort: first try to resolve the ambiguity from gather_context, the editor state and the code. Use only when two plausible interpretations would lead to materially different work; offer 2–4 concrete options when possible.',
    parameters: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'One specific question, phrased so a short answer settles it' },
        options: { type: 'array', items: { type: 'string' }, description: 'Optional fixed choices (2–4). The user may still type a free-form answer.' },
        recommended: { type: 'string', description: 'Which option you would pick if the user has no preference' },
      },
      required: ['question'],
    },
  },
  async execute(args) {
    const q = String(args.question ?? '').trim();
    if (!q) {
      return { content: 'ask_user needs a question.', isError: true };
    }
    const options = Array.isArray(args.options) ? (args.options as unknown[]).map(String).filter(Boolean) : [];
    const recommended = typeof args.recommended === 'string' ? args.recommended.trim() : '';
    let answer: string | undefined;
    if (options.length) {
      const other = '$(edit) Something else…';
      const items: vscode.QuickPickItem[] = options.map((o) => ({ label: o, description: o === recommended ? 'recommended' : undefined }));
      const picked = await vscode.window.showQuickPick([...items, { label: other, alwaysShow: true }], { title: 'LocalPilot asks', placeHolder: q, ignoreFocusOut: true });
      if (picked?.label === other) {
        answer = await vscode.window.showInputBox({ title: 'LocalPilot asks', prompt: q, ignoreFocusOut: true });
      } else {
        answer = picked?.label;
      }
    } else {
      answer = await vscode.window.showInputBox({ title: 'LocalPilot asks', prompt: q, ignoreFocusOut: true });
    }
    if (answer === undefined) {
      return { content: `User dismissed the question without answering.${recommended ? ` Proceed with the recommended option ("${recommended}") and state that assumption.` : ' Proceed with the most plausible interpretation and state that assumption.'}` };
    }
    return { content: `User answered: ${answer}` };
  },
};

export const editorTools: Tool[] = [getDiagnosticsTool, openEditorsTool, openFileTool, askUserTool];
