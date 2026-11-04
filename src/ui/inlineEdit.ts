import * as vscode from 'vscode';
import { ChangeTracker } from '../agent/changeTracker';
import { getConfig } from '../config';
import { effectiveContextWindow } from '../context/contextManager';
import { WorkspaceContext } from '../context/workspaceContext';
import { ProviderRegistry } from '../providers/registry';
import { ChatMessage } from '../types';

/** One-shot model call without tools; streams text into `onDelta`. */
export async function quickPrompt(
  providers: ProviderRegistry,
  messages: ChatMessage[],
  opts: { modelRef?: string; signal?: AbortSignal; onDelta?: (t: string) => void; onFinish?: (reason?: string) => void; maxTokens?: number; temperature?: number } = {}
): Promise<string> {
  const { provider, model } = await providers.resolve(opts.modelRef);
  const cfg = getConfig();
  let out = '';
  for await (const ev of provider.chat({
    model: model.modelId,
    messages,
    temperature: opts.temperature ?? 0.1,
    // A quick helper the user is waiting on: no reasoning pass (see thinkFor).
    think: false,
    maxTokens: opts.maxTokens ?? cfg.maxOutputTokens,
    contextWindow: effectiveContextWindow(model, cfg.contextWindow),
    keepAlive: cfg.keepAlive || undefined,
    signal: opts.signal,
  })) {
    if (ev.type === 'text') {
      out += ev.text;
      opts.onDelta?.(ev.text);
    } else if (ev.type === 'done') {
      opts.onFinish?.(ev.finishReason);
    }
  }
  return out;
}

/**
 * Extracts the first fenced code block (nested fences with an info string stay inside it), or the
 * whole text if there is no fence. Undefined when the block never closes, i.e. the reply was cut off.
 */
export function extractCode(text: string): string | undefined {
  const lines = text.split(/\r?\n/);
  const fence = /^\s*(`{3,}|~{3,})(.*)$/;
  const start = lines.findIndex((l) => fence.test(l));
  if (start < 0) {
    return text.trim();
  }
  const open = fence.exec(lines[start])![1];
  const stack = [{ ch: open[0], len: open.length }];
  for (let i = start + 1; i < lines.length; i++) {
    const m = fence.exec(lines[i]);
    if (!m) {
      continue;
    }
    const info = m[2].trim();
    const top = stack[stack.length - 1];
    if (info) {
      stack.push({ ch: m[1][0], len: m[1].length });
    } else if (m[1][0] === top.ch && m[1].length >= top.len) {
      stack.pop();
      if (!stack.length) {
        return lines.slice(start + 1, i).join('\n').replace(/\s+$/, '');
      }
    }
  }
  return undefined;
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
  const sel = ed.selection;
  const hasSel = !sel.isEmpty;
  // A full-line selection ends at column 0 of the next line; that line is not part of it.
  const selEnd = hasSel && sel.end.character === 0 && sel.end.line > sel.start.line ? sel.end.line - 1 : sel.end.line;
  // Without a selection, operate on a window around the cursor so the model has something to edit.
  let range = hasSel
    ? new vscode.Range(sel.start.line, 0, selEnd, doc.lineAt(selEnd).text.length)
    : new vscode.Range(Math.max(0, sel.active.line - 15), 0, Math.min(doc.lineCount - 1, sel.active.line + 15), doc.lineAt(Math.min(doc.lineCount - 1, sel.active.line + 15)).text.length);
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
  const version = doc.version;
  const before = doc.getText(new vscode.Range(new vscode.Position(Math.max(0, range.start.line - 40), 0), range.start));
  const afterLine = Math.min(doc.lineCount - 1, range.end.line + 40);
  const after = doc.getText(new vscode.Range(range.end, doc.lineAt(afterLine).range.end));
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

  // The progress covers generation only; applying and the Keep/Undo prompt happen after it closes.
  const code = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'LocalPilot: editing…', cancellable: true }, async (progress, token) => {
    const abort = new AbortController();
    const cancel = token.onCancellationRequested(() => abort.abort());
    let chars = 0;
    let finish: string | undefined;
    try {
      const raw = await quickPrompt(providers, messages, { signal: abort.signal, onDelta: (t) => { chars += t.length; progress.report({ message: `${chars} chars` }); }, onFinish: (r) => { finish = r; } });
      if (token.isCancellationRequested) {
        return undefined;
      }
      const out = extractCode(raw);
      if (finish === 'length' || out === undefined) {
        void vscode.window.showWarningMessage('The reply was cut off; select less or raise localpilot.maxOutputTokens.');
        return undefined;
      }
      if (!out.trim()) {
        void vscode.window.showWarningMessage('LocalPilot returned no code.');
        return undefined;
      }
      return out;
    } catch (e) {
      if (!token.isCancellationRequested) {
        void vscode.window.showErrorMessage(`LocalPilot inline edit failed: ${e instanceof Error ? e.message : String(e)}`);
      }
      return undefined;
    } finally {
      cancel.dispose();
    }
  });
  if (code === undefined) {
    return;
  }
  if (doc.isClosed) {
    void vscode.window.showWarningMessage('The document was closed while LocalPilot was editing; nothing was applied.');
    return;
  }
  if (doc.version !== version && doc.getText(range) !== target) {
    const text = doc.getText();
    const idx = text.indexOf(target);
    if (idx < 0 || text.indexOf(target, idx + 1) >= 0) {
      void vscode.window.showWarningMessage('The code changed while LocalPilot was editing; nothing was applied.');
      return;
    }
    range = new vscode.Range(doc.positionAt(idx), doc.positionAt(idx + target.length));
  }
  const isFile = doc.uri.scheme === 'file';
  const sid = `inline_${Date.now().toString(36)}`;
  let ok = false;
  try {
    if (isFile) {
      await tracker.beforeChange(doc.uri.fsPath, sid);
    }
    const we = new vscode.WorkspaceEdit();
    we.replace(doc.uri, range, code);
    ok = await vscode.workspace.applyEdit(we);
    if (!ok) {
      void vscode.window.showErrorMessage('LocalPilot inline edit failed: the edit could not be applied.');
    }
  } catch (e) {
    void vscode.window.showErrorMessage(`LocalPilot inline edit failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!ok) {
    if (isFile) {
      tracker.keep(sid);
    }
    return;
  }
  const inserted = new vscode.Range(range.start, doc.positionAt(doc.offsetAt(range.start) + code.length));
  const active = vscode.window.activeTextEditor;
  if (active?.document === doc) {
    active.selection = new vscode.Selection(inserted.start, inserted.end);
  }
  const choice = await vscode.window.showInformationMessage(`Applied: ${instruction.slice(0, 60)}`, 'Keep', 'Undo');
  if (choice === 'Undo') {
    if (!doc.isClosed && doc.getText(inserted) === code) {
      const back = new vscode.WorkspaceEdit();
      back.replace(doc.uri, inserted, target);
      await vscode.workspace.applyEdit(back);
      if (isFile) {
        tracker.keep(sid);
      }
    } else if (isFile) {
      await tracker.undo(sid);
    }
  } else if (isFile) {
    tracker.keep(sid);
  }
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
  const command = (extractCode(raw) ?? '').split('\n').filter((l) => l.trim() && !l.trim().startsWith('#')).join(' && ').trim();
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
