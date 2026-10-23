import * as vscode from 'vscode';
import { ChangeTracker } from '../agent/changeTracker';
import { getConfig } from '../config';
import { WorkspaceContext } from '../context/workspaceContext';
import { ProviderRegistry } from '../providers/registry';
import { ChatMessage } from '../types';

/** One-shot model call without tools; streams text into `onDelta`. */
export async function quickPrompt(
  providers: ProviderRegistry,
  messages: ChatMessage[],
  opts: { modelRef?: string; signal?: AbortSignal; onDelta?: (t: string) => void; maxTokens?: number; temperature?: number } = {}
): Promise<string> {
  const { provider, model } = await providers.resolve(opts.modelRef);
  const cfg = getConfig();
  let out = '';
  for await (const ev of provider.chat({
    model: model.modelId,
    messages,
    temperature: opts.temperature ?? 0.1,
    maxTokens: opts.maxTokens ?? cfg.maxOutputTokens,
    contextWindow: Math.min(model.contextWindow, cfg.contextWindow),
    signal: opts.signal,
  })) {
    if (ev.type === 'text') {
      out += ev.text;
      opts.onDelta?.(ev.text);
    }
  }
  return out;
}

/** Extracts the first fenced code block, or the whole text if none. */
export function extractCode(text: string): string {
  const m = /```[\w+#.-]*\s*\n([\s\S]*?)\n?```/.exec(text);
  return (m ? m[1] : text).replace(/\s+$/, '');
}

/**
 * Cursor ⌘K / Copilot inline-chat style edit: describe a change, the model rewrites the selection
 * (or the enclosing region) in place. Changes are tracked so Keep/Undo and highlights work.
 */
export async function inlineEdit(providers: ProviderRegistry, tracker: ChangeTracker, workspace: WorkspaceContext): Promise<void> {
  const ed = vscode.window.activeTextEditor;
  if (!ed) {
    return;
  }
  const doc = ed.document;
  const hasSel = !ed.selection.isEmpty;
  // Without a selection, operate on a window around the cursor so the model has something to edit.
  const range = hasSel
    ? new vscode.Range(ed.selection.start.line, 0, ed.selection.end.line, doc.lineAt(ed.selection.end.line).text.length)
    : new vscode.Range(Math.max(0, ed.selection.active.line - 15), 0, Math.min(doc.lineCount - 1, ed.selection.active.line + 15), doc.lineAt(Math.min(doc.lineCount - 1, ed.selection.active.line + 15)).text.length);
  const instruction = await vscode.window.showInputBox({
    title: hasSel ? `Edit selection (lines ${range.start.line + 1}–${range.end.line + 1})` : 'Edit code around cursor',
    prompt: 'Describe the change, e.g. "add error handling", "convert to async/await", "write a docstring"',
    placeHolder: 'What should change?',
    ignoreFocusOut: true,
  });
  if (!instruction?.trim()) {
    return;
  }
  const target = doc.getText(range);
  const before = doc.getText(new vscode.Range(new vscode.Position(Math.max(0, range.start.line - 40), 0), range.start));
  const after = doc.getText(new vscode.Range(range.end, new vscode.Position(Math.min(doc.lineCount - 1, range.end.line + 40), 0)));
  const rules = await workspace.loadInstructions(4000);
  const messages: ChatMessage[] = [
    {
      role: 'system',
      content: `You are an expert ${doc.languageId} programmer performing a precise in-place code edit inside VS Code.
Rewrite ONLY the code between <edit> tags according to the instruction. Preserve indentation style, surrounding behaviour and imports unless asked.
Return the replacement code in a single fenced code block and nothing else — no explanations.${rules ? `\n\nProject rules:\n${rules}` : ''}`,
    },
    {
      role: 'user',
      content: `File: ${vscode.workspace.asRelativePath(doc.uri)}\n\n<before>\n${before}\n</before>\n<edit>\n${target}\n</edit>\n<after>\n${after}\n</after>\n\nInstruction: ${instruction}`,
    },
  ];

  await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'LocalPilot: editing…', cancellable: true }, async (progress, token) => {
    const abort = new AbortController();
    token.onCancellationRequested(() => abort.abort());
    let chars = 0;
    try {
      const raw = await quickPrompt(providers, messages, { signal: abort.signal, onDelta: (t) => { chars += t.length; progress.report({ message: `${chars} chars` }); } });
      if (token.isCancellationRequested) {
        return;
      }
      const code = extractCode(raw);
      if (!code.trim()) {
        void vscode.window.showWarningMessage('LocalPilot returned no code.');
        return;
      }
      const sid = `inline_${Date.now().toString(36)}`;
      await tracker.beforeChange(doc.uri.fsPath, sid);
      await ed.edit((b) => b.replace(range, code));
      const newEnd = doc.positionAt(doc.offsetAt(range.start) + code.length);
      ed.selection = new vscode.Selection(range.start, newEnd);
      const choice = await vscode.window.showInformationMessage(`Applied: ${instruction.slice(0, 60)}`, 'Keep', 'Undo');
      if (choice === 'Undo') {
        await tracker.undo(sid);
      } else if (choice === 'Keep') {
        tracker.keep(sid);
      }
    } catch (e) {
      if (!token.isCancellationRequested) {
        void vscode.window.showErrorMessage(`LocalPilot inline edit failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  });
}

/** Natural language → shell command, with Run / Insert / Copy choices. */
export async function terminalCommand(providers: ProviderRegistry, workspace: WorkspaceContext): Promise<void> {
  const ask = await vscode.window.showInputBox({ title: 'Generate terminal command', prompt: 'Describe what you want to do', placeHolder: 'e.g. find all TODOs in src and count them', ignoreFocusOut: true });
  if (!ask?.trim()) {
    return;
  }
  const shell = process.env.SHELL ?? (process.platform === 'win32' ? 'powershell' : 'bash');
  const messages: ChatMessage[] = [
    { role: 'system', content: `You translate requests into a single ${shell} command for ${process.platform}. Working directory: ${workspace.root ?? '~'}. Respond with ONLY the command in a fenced code block. Prefer safe, non-destructive flags; never use sudo or rm -rf without being asked.` },
    { role: 'user', content: ask },
  ];
  const raw = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'LocalPilot: generating command…' }, () => quickPrompt(providers, messages, { maxTokens: 300 }));
  const command = extractCode(raw).split('\n').filter((l) => l.trim() && !l.trim().startsWith('#')).join(' && ').trim();
  if (!command) {
    return;
  }
  const choice = await vscode.window.showQuickPick(
    [
      { label: '$(play) Run in terminal', action: 'run', detail: command },
      { label: '$(insert) Insert into terminal (don\'t run)', action: 'insert' },
      { label: '$(copy) Copy', action: 'copy' },
    ],
    { title: command, placeHolder: 'Review the command before running' }
  );
  if (!choice) {
    return;
  }
  if (choice.action === 'copy') {
    await vscode.env.clipboard.writeText(command);
    return;
  }
  const term = vscode.window.activeTerminal ?? vscode.window.createTerminal('LocalPilot');
  term.show();
  term.sendText(command, choice.action === 'run');
}

/** Quick-fix / refactor light-bulb actions. */
export class LocalPilotCodeActions implements vscode.CodeActionProvider {
  static readonly kinds = [vscode.CodeActionKind.QuickFix, vscode.CodeActionKind.RefactorRewrite];

  provideCodeActions(doc: vscode.TextDocument, range: vscode.Range | vscode.Selection, ctx: vscode.CodeActionContext): vscode.CodeAction[] {
    const actions: vscode.CodeAction[] = [];
    const diags = ctx.diagnostics.filter((d) => d.severity <= vscode.DiagnosticSeverity.Warning);
    if (diags.length) {
      const fix = new vscode.CodeAction(`Fix with LocalPilot: ${diags[0].message.slice(0, 50)}${diags[0].message.length > 50 ? '…' : ''}`, vscode.CodeActionKind.QuickFix);
      fix.command = { command: 'localpilot.fixDiagnosticAt', title: 'Fix with LocalPilot', arguments: [doc.uri, diags.map((d) => ({ line: d.range.start.line + 1, message: d.message }))] };
      fix.diagnostics = diags;
      fix.isPreferred = false;
      actions.push(fix);
      const explain = new vscode.CodeAction('Explain with LocalPilot', vscode.CodeActionKind.QuickFix);
      explain.command = { command: 'localpilot.explainDiagnosticAt', title: 'Explain with LocalPilot', arguments: [doc.uri, diags.map((d) => ({ line: d.range.start.line + 1, message: d.message }))] };
      explain.diagnostics = diags;
      actions.push(explain);
    }
    if (!range.isEmpty) {
      const edit = new vscode.CodeAction('Edit with LocalPilot…', vscode.CodeActionKind.RefactorRewrite);
      edit.command = { command: 'localpilot.inlineEdit', title: 'Edit with LocalPilot' };
      actions.push(edit);
    }
    return actions;
  }
}
