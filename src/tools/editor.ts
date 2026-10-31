import * as vscode from 'vscode';
import { Tool, UserAnswer, UserQuestion } from '../types';
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

/** Reads ask_user arguments: `questions` (current form) or a single `question` / `options` / `recommended` (older form). */
export function parseQuestions(args: Record<string, unknown>): UserQuestion[] {
  const one = (q: Record<string, unknown>): UserQuestion | undefined => {
    const question = String(q.question ?? '').trim();
    if (!question) {
      return undefined;
    }
    const options = (Array.isArray(q.options) ? q.options : [])
      .map((o) => (typeof o === 'string' ? { label: o } : o && typeof o === 'object' ? { label: String((o as { label?: unknown }).label ?? ''), description: (o as { description?: unknown }).description ? String((o as { description?: unknown }).description) : undefined } : undefined))
      .filter((o): o is { label: string; description?: string } => !!o && !!o.label.trim())
      .slice(0, 6);
    const recommended = typeof q.recommended === 'string' && options.some((o) => o.label === q.recommended) ? q.recommended : undefined;
    const header = typeof q.header === 'string' && q.header.trim() ? q.header.trim().slice(0, 24) : undefined;
    return { header, question, options, multiSelect: q.multiSelect === true, recommended };
  };
  const list = Array.isArray(args.questions) ? (args.questions as Record<string, unknown>[]) : [args];
  return list.map((q) => (q && typeof q === 'object' ? one(q) : undefined)).filter((q): q is UserQuestion => !!q).slice(0, 4);
}

/** The tool result the model reads: one "question → answer" line per question. */
export function formatAnswers(answers: UserAnswer[]): string {
  return `The user answered:\n${answers.map((a) => `- ${a.question}\n  → ${[...a.selected, ...(a.other ? [`(in their words) ${a.other}`] : [])].join('; ') || '(no answer)'}`).join('\n')}\nUse these answers; do not ask about the same points again.`;
}

/** Native fallback when no chat surface is attached (CLI, chat participant): one picker per question. */
async function askNatively(questions: UserQuestion[]): Promise<UserAnswer[] | undefined> {
  const answers: UserAnswer[] = [];
  for (const [i, q] of questions.entries()) {
    const title = `LocalPilot asks${questions.length > 1 ? ` (${i + 1}/${questions.length})` : ''}${q.header ? ` · ${q.header}` : ''}`;
    if (!q.options.length) {
      const text = await vscode.window.showInputBox({ title, prompt: q.question, ignoreFocusOut: true });
      if (text === undefined) {
        return undefined;
      }
      answers.push({ question: q.question, selected: [], other: text });
      continue;
    }
    const other = '$(edit) Something else…';
    const items: vscode.QuickPickItem[] = [...q.options.map((o) => ({ label: o.label, description: o.label === q.recommended ? 'recommended' : undefined, detail: o.description, picked: q.multiSelect && o.label === q.recommended })), { label: other, alwaysShow: true }];
    const picked = q.multiSelect
      ? await vscode.window.showQuickPick(items, { title, placeHolder: q.question, ignoreFocusOut: true, canPickMany: true })
      : await vscode.window.showQuickPick(items, { title, placeHolder: q.question, ignoreFocusOut: true }).then((p) => (p ? [p] : undefined));
    if (!picked) {
      return undefined;
    }
    const wantsOther = picked.some((p) => p.label === other);
    const text = wantsOther ? await vscode.window.showInputBox({ title, prompt: q.question, ignoreFocusOut: true }) : undefined;
    answers.push({ question: q.question, selected: picked.filter((p) => p.label !== other).map((p) => p.label), other: text || undefined });
  }
  return answers;
}

export const askUserTool: Tool = {
  definition: {
    name: 'ask_user',
    description:
      'Ask the user up to 4 questions at once and wait for the answers. Each question gets 2–4 concrete options with a one-line description of what choosing it means (trade-offs, consequences), and "recommended" naming the option you would pick. The user can always answer in their own words. Ask all the questions you need in ONE call — never one per turn. Do not ask what the code, the editor or gather_context can tell you.',
    parameters: {
      type: 'object',
      properties: {
        questions: {
          type: 'array',
          description: '1–4 questions, most important first',
          items: {
            type: 'object',
            properties: {
              header: { type: 'string', description: 'Very short topic label (max 12 chars), e.g. "Storage", "Auth"' },
              question: { type: 'string', description: 'One specific question ending with "?"' },
              options: {
                type: 'array',
                description: '2–4 choices',
                items: {
                  type: 'object',
                  properties: {
                    label: { type: 'string', description: '1–5 words' },
                    description: { type: 'string', description: 'What picking this means: effect, trade-off, effort' },
                  },
                  required: ['label'],
                },
              },
              multiSelect: { type: 'boolean', description: 'true when several options can apply together' },
              recommended: { type: 'string', description: 'The label of the option you would choose' },
            },
            required: ['question', 'options'],
          },
        },
      },
      required: ['questions'],
    },
  },
  async execute(args, ctx) {
    const questions = parseQuestions(args);
    if (!questions.length) {
      return { content: 'ask_user needs at least one question in "questions".', isError: true };
    }
    let answers = ctx.askUser ? await ctx.askUser(questions) : undefined;
    if (answers === undefined) {
      answers = (await askNatively(questions)) ?? null;
    }
    if (answers === null) {
      const picks = questions.filter((q) => q.recommended).map((q) => `"${q.recommended}" for "${q.question}"`);
      return { content: `The user skipped the questions. Proceed with ${picks.length ? `the recommended options (${picks.join(', ')})` : 'the most plausible interpretation'} and state those assumptions in one line.` };
    }
    return { content: formatAnswers(answers), data: { questions, answers } };
  },
};

export const editorTools: Tool[] = [getDiagnosticsTool, openEditorsTool, openFileTool, askUserTool];
