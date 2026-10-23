import * as vscode from 'vscode';
import { AgentRunner } from './agent/agentLoop';
import { ChangeTracker } from './agent/changeTracker';
import { createMemoryTools, manageTodosTool, MemoryStore } from './agent/memory';
import { SkillManager } from './agent/skills';
import { createAgentTools } from './agent/subagents';
import { getConfig, onConfigChange, setDefaultModel } from './config';
import { WorkspaceContext } from './context/workspaceContext';
import { McpManager } from './mcp/mcpManager';
import { ProviderRegistry } from './providers/registry';
import { SessionStore } from './sessions/sessionStore';
import { editorTools } from './tools/editor';
import { fsTools } from './tools/fs';
import { ToolRegistry } from './tools/registry';
import { searchTools } from './tools/search';
import { terminalTools } from './tools/terminal';
import { webTools } from './tools/web';
import { AgentsTreeProvider } from './ui/agentsView';
import { ChatController } from './ui/chatController';
import { registerChatParticipant } from './ui/chatParticipant';
import { ChatViewProvider } from './ui/chatViewProvider';
import { installCli, registerUriHandler } from './ui/cli';
import { InlineCompletionProvider } from './ui/inlineCompletion';
import { inlineEdit, LocalPilotCodeActions, terminalCommand } from './ui/inlineEdit';
import { LocalModelChatProvider } from './ui/lmProvider';
import { SettingsPanel, SettingsSection, WELCOMED_KEY } from './ui/settingsPanel';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const log = vscode.window.createOutputChannel('LocalPilot', { log: true });
  context.subscriptions.push(log);
  log.info('LocalPilot activating');

  // --- Core services -----------------------------------------------------------------------
  const providers = new ProviderRegistry(log);
  const tools = new ToolRegistry();
  const skills = new SkillManager(log);
  const workspace = new WorkspaceContext(log);
  const store = new SessionStore(context, log);
  const tracker = new ChangeTracker(log);
  const memory = new MemoryStore(context.globalStorageUri, log);
  const runner = new AgentRunner(providers, tools, skills, workspace, log, tracker, memory);
  const controller = new ChatController(store, runner, providers, skills, workspace, tracker, log);
  const mcp = new McpManager(tools, log);
  context.subscriptions.push(providers, tools, skills, workspace, store, tracker, controller, mcp);

  tools.registerAll([...fsTools, ...searchTools, ...terminalTools, ...editorTools, ...webTools, ...createMemoryTools(memory), manageTodosTool]);
  tools.registerAll(createAgentTools(runner, skills, (e) => controller.emitEvent(e), (sid, title, detail, kind) => controller.requestApproval(sid, title, detail, kind)));

  await Promise.all([store.load(), skills.refresh()]);
  void mcp.reload();

  // --- UI ----------------------------------------------------------------------------------
  const view = new ChatViewProvider(context, controller);
  context.subscriptions.push(vscode.window.registerWebviewViewProvider(ChatViewProvider.viewId, view, { webviewOptions: { retainContextWhenHidden: true } }));
  const agentsTree = new AgentsTreeProvider(controller);
  const agentsView = vscode.window.createTreeView('localpilot.agentsView', { treeDataProvider: agentsTree, showCollapseAll: true });
  context.subscriptions.push(agentsTree, agentsView);
  const updateAgentsBadge = () => {
    const n = controller.runningSessionIds.length;
    agentsView.badge = n ? { value: n, tooltip: `${n} agent${n === 1 ? '' : 's'} running` } : undefined;
    void vscode.commands.executeCommand('setContext', 'localpilot.hasChanges', tracker.count > 0);
  };
  context.subscriptions.push(controller.onDidChangeRuns(updateAgentsBadge), tracker.onDidChange(updateAgentsBadge));
  registerChatParticipant(context, controller);
  registerUriHandler(context, controller, () => view.reveal());
  const settingsPanel = new SettingsPanel(context, providers, skills, mcp, memory, store, log);
  context.subscriptions.push(settingsPanel);
  context.subscriptions.push(vscode.lm.registerLanguageModelChatProvider('localpilot', new LocalModelChatProvider(providers, log)));
  context.subscriptions.push(vscode.languages.registerInlineCompletionItemProvider({ pattern: '**' }, new InlineCompletionProvider(providers, log)));
  context.subscriptions.push(vscode.languages.registerCodeActionsProvider({ pattern: '**' }, new LocalPilotCodeActions(), { providedCodeActionKinds: LocalPilotCodeActions.kinds }));

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90);
  status.command = 'localpilot.selectModel';
  context.subscriptions.push(status);
  const refreshStatus = async () => {
    const cfg = getConfig();
    const models = await providers.listModels().catch(() => []);
    const current = cfg.defaultModel || models[0]?.id || 'no model';
    status.text = `$(hubot) ${current.split('/').pop()}`;
    status.tooltip = `LocalPilot · ${models.length} local model(s) from ${providers.all.length} provider(s)${cfg.inlineCompletion.enabled ? ' · inline completions on' : ''}\nClick to switch model`;
    status.show();
  };
  void refreshStatus();
  context.subscriptions.push(providers.onDidChange(() => void refreshStatus()), onConfigChange(() => void refreshStatus()));

  // First run: open the setup screen when nothing has been configured yet and no local model server is reachable.
  if (!context.globalState.get(WELCOMED_KEY) && getConfig().showWelcomeOnStartup) {
    void providers.listModels().catch(() => []).then((models) => {
      if (settingsPanel.isOpen) {
        return; // the user already opened Settings themselves — don't hijack the panel
      }
      if (!models.length || !getConfig().defaultModel) {
        settingsPanel.show('setup');
      } else {
        void context.globalState.update(WELCOMED_KEY, true);
      }
    });
  }

  // --- Commands ----------------------------------------------------------------------------
  const cmd = (id: string, fn: (...a: unknown[]) => unknown) => context.subscriptions.push(vscode.commands.registerCommand(id, fn));

  cmd('localpilot.openSettings', (section?: unknown) => settingsPanel.show('settings', typeof section === 'string' ? (section as SettingsSection) : undefined));
  cmd('localpilot.manageProviders', () => settingsPanel.show('settings', 'providers'));
  cmd('localpilot.openWelcome', () => settingsPanel.show('setup'));
  cmd('localpilot.clearMemory', async () => {
    const notes = await memory.list();
    const pick = await vscode.window.showQuickPick(
      [
        { label: '$(repo) Project memory', description: `${notes.filter((n) => n.scope === 'project').length} note(s) in .localpilot/memory/`, scope: 'project' as const },
        { label: '$(globe) Global memory', description: `${notes.filter((n) => n.scope === 'global').length} note(s) shared across workspaces`, scope: 'global' as const },
      ],
      { title: 'LocalPilot: clear memory', placeHolder: 'Which notes should be deleted?' }
    );
    if (!pick) {
      return;
    }
    const targets = notes.filter((n) => n.scope === pick.scope);
    if (!targets.length) {
      return void vscode.window.showInformationMessage('No notes to delete.');
    }
    const ok = await vscode.window.showWarningMessage(`Delete ${targets.length} ${pick.scope} memory note(s)? This cannot be undone.`, { modal: true }, 'Delete');
    if (ok) {
      let n = 0;
      for (const t of targets) {
        if (await memory.delete(t.name, pick.scope)) {
          n++;
        }
      }
      vscode.window.setStatusBarMessage(`LocalPilot: deleted ${n} memory note(s)`, 3000);
    }
  });

  cmd('localpilot.openChat', () => view.reveal());
  cmd('localpilot.openChatInEditor', () => view.openInEditor());
  cmd('localpilot.newSession', async () => {
    view.reveal();
    await controller.handle({ type: 'newSession' });
  });
  cmd('localpilot.openSession', async (id: unknown) => {
    if (typeof id === 'string') {
      view.reveal();
      await controller.handle({ type: 'selectSession', id });
    }
  });
  cmd('localpilot.showSessions', async () => {
    const running = new Set(controller.runningSessionIds);
    const items = controller.store.list().map((s) => ({
      label: `${running.has(s.id) ? '$(loading~spin) ' : s.pinned ? '$(pinned) ' : ''}${s.title}`,
      description: `${s.mode} · ${s.messageCount} msgs`,
      detail: `${s.model || 'default model'} · ${timeAgo(s.updatedAt)}${tracker.forSession(s.id).length ? ` · ${tracker.forSession(s.id).length} files changed` : ''}`,
      id: s.id,
      buttons: [{ iconPath: new vscode.ThemeIcon('trash'), tooltip: 'Delete' }],
    }));
    const qp = vscode.window.createQuickPick<(typeof items)[number]>();
    qp.title = 'LocalPilot chats';
    qp.placeholder = items.length ? 'Select a chat to open' : 'No chats yet';
    qp.items = items;
    qp.matchOnDescription = true;
    qp.onDidTriggerItemButton(async (e) => {
      await controller.handle({ type: 'deleteSession', id: e.item.id });
      qp.items = qp.items.filter((i) => i.id !== e.item.id);
    });
    qp.onDidAccept(async () => {
      const pick = qp.selectedItems[0];
      qp.hide();
      if (pick) {
        view.reveal();
        await controller.handle({ type: 'selectSession', id: pick.id });
      }
    });
    qp.onDidHide(() => qp.dispose());
    qp.show();
  });
  cmd('localpilot.sessionMenu', async (id?: unknown) => {
    const s = (typeof id === 'string' ? controller.store.get(id) : undefined) ?? controller.activeSession;
    if (!s) {
      return;
    }
    const changed = tracker.forSession(s.id).length;
    const pick = await vscode.window.showQuickPick(
      [
        { label: '$(edit) Rename', action: 'rename' },
        { label: `$(pinned) ${s.pinned ? 'Unpin' : 'Pin'}`, action: 'pin' },
        { label: '$(git-branch) Fork', action: 'fork' },
        { label: '$(export) Export as Markdown', action: 'export' },
        { label: '$(fold) Compact context', action: 'compact' },
        ...(changed ? [{ label: `$(check-all) Keep all ${changed} changes`, action: 'keep' }, { label: `$(discard) Undo all ${changed} changes`, action: 'undo' }] : []),
        { label: '$(clear-all) Clear messages', action: 'clear' },
        { label: '$(trash) Delete chat', action: 'delete' },
      ],
      { title: s.title, placeHolder: 'Chat actions' }
    );
    switch (pick?.action) {
      case 'rename': {
        const title = await vscode.window.showInputBox({ prompt: 'Chat title', value: s.title });
        if (title) {
          await controller.handle({ type: 'renameSession', id: s.id, title });
        }
        break;
      }
      case 'pin':
        return controller.handle({ type: 'pinSession', id: s.id });
      case 'fork':
        return controller.handle({ type: 'forkSession', id: s.id });
      case 'export':
        return controller.handle({ type: 'exportSession', id: s.id });
      case 'compact':
        return controller.handle({ type: 'compactNow', sessionId: s.id });
      case 'keep':
        return controller.handle({ type: 'keepChanges', sessionId: s.id });
      case 'undo':
        return controller.handle({ type: 'undoChanges', sessionId: s.id });
      case 'clear':
        return controller.handle({ type: 'clearSession', sessionId: s.id });
      case 'delete':
        return controller.handle({ type: 'deleteSession', id: s.id });
    }
  });
  cmd('localpilot.runParallelTasks', async () => {
    const input = await vscode.window.showInputBox({
      title: 'Run tasks in parallel',
      prompt: 'Each task runs as its own agent at the same time. Separate tasks with " | ".',
      placeHolder: 'Add input validation to the login form | Write tests for utils/date.ts | Fix all TypeScript errors in src/api',
      ignoreFocusOut: true,
    });
    const tasks = (input ?? '').split('|').map((t) => t.trim()).filter(Boolean);
    if (!tasks.length) {
      return;
    }
    view.reveal();
    await controller.runParallel(tasks);
    void vscode.commands.executeCommand('localpilot.agentsView.focus');
  });
  cmd('localpilot.stopSession', (id?: unknown) => controller.stop(typeof id === 'string' ? id : controller.activeSession?.id ?? ''));
  cmd('localpilot.stopAll', () => controller.runningSessionIds.forEach((id) => controller.stop(id)));
  cmd('localpilot.showDiff', (sessionId: unknown, fsPath: unknown) => typeof sessionId === 'string' && typeof fsPath === 'string' && tracker.showDiff(sessionId, fsPath));
  cmd('localpilot.keepChanges', (node?: unknown) => {
    const n = node as { sessionId?: string; fsPath?: string; session?: { id: string } } | undefined;
    const sid = n?.sessionId ?? n?.session?.id ?? controller.activeSession?.id;
    if (sid) {
      tracker.keep(sid, n?.fsPath);
    }
  });
  cmd('localpilot.undoChanges', async (node?: unknown) => {
    const n = node as { sessionId?: string; fsPath?: string; session?: { id: string } } | undefined;
    const sid = n?.sessionId ?? n?.session?.id ?? controller.activeSession?.id;
    if (sid) {
      const count = await tracker.undo(sid, n?.fsPath);
      vscode.window.setStatusBarMessage(`LocalPilot: reverted ${count} file(s)`, 2500);
    }
  });
  cmd('localpilot.keepAllChanges', () => tracker.all().forEach((c) => tracker.keep(c.sessionId)));
  cmd('localpilot.undoAllChanges', async () => {
    const ok = await vscode.window.showWarningMessage(`Revert all ${tracker.count} file(s) changed by agents?`, { modal: true }, 'Revert');
    if (ok) {
      for (const sid of new Set(tracker.all().map((c) => c.sessionId))) {
        await tracker.undo(sid);
      }
    }
  });
  cmd('localpilot.selectModel', async () => {
    const models = await providers.listModels(true);
    if (!models.length) {
      const pick = await vscode.window.showErrorMessage('No local models found. Is Ollama / LM Studio / llama.cpp / vLLM running?', 'Open settings', 'Retry');
      if (pick === 'Open settings') {
        settingsPanel.show('settings', 'providers');
      } else if (pick === 'Retry') {
        await vscode.commands.executeCommand('localpilot.selectModel');
      }
      return;
    }
    const picked = await vscode.window.showQuickPick(
      models.map((m) => ({
        label: m.name,
        description: m.providerId,
        detail: `${(m.contextWindow / 1024).toFixed(0)}k context${m.supportsTools ? ' · tools' : ' · no native tools (prompt fallback)'}${m.supportsVision ? ' · vision' : ''}`,
        id: m.id,
      })),
      { title: 'LocalPilot: select default model', matchOnDescription: true, matchOnDetail: true }
    );
    if (picked) {
      await setDefaultModel(picked.id);
      const s = controller.activeSession;
      if (s) {
        await controller.handle({ type: 'setModel', sessionId: s.id, model: picked.id });
      }
      void refreshStatus();
    }
  });
  cmd('localpilot.refreshModels', async () => {
    await providers.listModels(true);
    await controller.handle({ type: 'refreshModels' });
    void refreshStatus();
    vscode.window.setStatusBarMessage('LocalPilot: models refreshed', 2000);
  });
  cmd('localpilot.toggleInlineCompletions', async () => {
    const cfg = vscode.workspace.getConfiguration('localpilot');
    const cur = cfg.get<boolean>('inlineCompletion.enabled', false);
    await cfg.update('inlineCompletion.enabled', !cur, vscode.ConfigurationTarget.Global);
    vscode.window.setStatusBarMessage(`LocalPilot inline completions ${!cur ? 'enabled' : 'disabled'}`, 2500);
  });
  cmd('localpilot.reloadSkills', async () => {
    await skills.refresh();
    await mcp.reload();
    vscode.window.showInformationMessage(`LocalPilot: ${skills.allSkills.length} skills, ${skills.allAgents.length} subagents, ${mcp.status.reduce((n, s) => n + s.tools, 0)} MCP tools`);
  });
  cmd('localpilot.showLogs', () => log.show());
  cmd('localpilot.installCli', () => installCli());
  cmd('localpilot.openMemory', async () => {
    const pick = await vscode.window.showQuickPick(
      [
        { label: '$(repo) Project memory', description: '.localpilot/memory/', scope: 'project' as const },
        { label: '$(globe) Global memory', description: 'shared across workspaces', scope: 'global' as const },
      ],
      { title: 'LocalPilot memory' }
    );
    if (!pick) {
      return;
    }
    const dir = memory.openFolder(pick.scope);
    if (!dir) {
      return void vscode.window.showWarningMessage('Open a folder to use project memory.');
    }
    await vscode.workspace.fs.createDirectory(dir);
    const notes = (await memory.list()).filter((n) => n.scope === pick.scope);
    if (!notes.length) {
      await memory.write('README', '# LocalPilot memory\n\nThe agent saves durable notes here with `memory_save`. Edit freely; each file is a note.', pick.scope);
    }
    await vscode.commands.executeCommand('revealInExplorer', dir).then(undefined, () => undefined);
    const first = notes[0] ? vscode.Uri.joinPath(dir, `${notes[0].name}.md`) : vscode.Uri.joinPath(dir, 'README.md');
    await vscode.window.showTextDocument(first);
  });
  cmd('localpilot.inlineEdit', () => inlineEdit(providers, tracker, workspace));
  cmd('localpilot.terminalCommand', () => terminalCommand(providers, workspace));
  cmd('localpilot.captureScreenshot', async (mode?: unknown) => {
    view.reveal();
    type Item = vscode.QuickPickItem & { mode: 'region' | 'vscode' | 'window' | 'screen'; delayMs?: number };
    const pickWindowDesc = process.platform === 'win32' ? 'Switch to the window; it is captured after 3 s' : 'Click a window to capture it';
    const items: Item[] = [
      { label: '$(screen-full) Selection area', description: 'Drag a rectangle', mode: 'region' },
      { label: '$(window) This VS Code window', description: 'Captured immediately', mode: 'vscode' },
      { label: '$(multiple-windows) Pick a window', description: pickWindowDesc, mode: 'window', delayMs: process.platform === 'win32' ? 3000 : 0 },
      { label: '$(device-desktop) Full screen', description: 'Captured immediately', mode: 'screen' },
      { label: '$(clock) Full screen in 5 s', description: 'Time to switch windows or open a menu', mode: 'screen', delayMs: 5000 },
    ];
    const chosen = typeof mode === 'string' ? items.find((i) => i.mode === mode) : await vscode.window.showQuickPick(items, { placeHolder: 'What to capture' });
    if (!chosen) {
      return;
    }
    return controller.handle({ type: 'captureScreenshot', mode: chosen.mode, delayMs: chosen.delayMs });
  });
  cmd('localpilot.attachImage', async (uri?: unknown) => {
    view.reveal();
    if (uri instanceof vscode.Uri) {
      return controller.handle({ type: 'attachUri', uri: uri.toString() });
    }
    return controller.handle({ type: 'pickImage' });
  });
  const diagnosticAction = (prefix: string, mode: 'agent' | 'ask') => async (uri: unknown, diags: unknown) => {
    if (!(uri instanceof vscode.Uri) || !Array.isArray(diags)) {
      return;
    }
    const rel = vscode.workspace.asRelativePath(uri);
    const list = (diags as { line: number; message: string }[]).map((d) => `- line ${d.line}: ${d.message}`).join('\n');
    view.reveal();
    const s = store.create(getConfig().defaultModel, mode);
    s.title = `${mode === 'agent' ? 'Fix' : 'Explain'}: ${rel.split('/').pop()}`;
    await controller.handle({ type: 'selectSession', id: s.id });
    void controller.send(s.id, `${prefix}\n${list}`, [rel]);
  };
  cmd('localpilot.fixDiagnosticAt', diagnosticAction('Fix these problems with edit_file, then re-run get_diagnostics on the file to confirm:', 'agent'));
  cmd('localpilot.explainDiagnosticAt', diagnosticAction('Explain these problems and how to fix them:', 'ask'));

  // Editor context-menu actions: send the selection to a fresh session with a task template.
  const editorAction = (title: string, template: (lang: string) => string, mode: 'agent' | 'ask' = 'ask') => async () => {
    const ed = vscode.window.activeTextEditor;
    if (!ed) {
      return;
    }
    const rel = vscode.workspace.asRelativePath(ed.document.uri);
    const sel = ed.selection.isEmpty ? undefined : ed.selection;
    const ref = sel ? `${rel}#L${sel.start.line + 1}-L${sel.end.line + 1}` : rel;
    view.reveal();
    const s = store.create(getConfig().defaultModel, mode);
    s.title = `${title}: ${rel.split('/').pop()}`;
    await controller.handle({ type: 'selectSession', id: s.id });
    void controller.send(s.id, template(ed.document.languageId), [ref]);
  };
  cmd('localpilot.explainSelection', editorAction('Explain', () => 'Explain what this code does, how it fits into the codebase, and point out anything surprising.'));
  cmd('localpilot.fixSelection', editorAction('Fix', () => 'Find and fix bugs or problems in this code. Apply the fix with edit_file and explain the change.', 'agent'));
  cmd('localpilot.refactorSelection', editorAction('Refactor', () => 'Refactor this code for clarity and maintainability without changing behaviour. Apply the changes with edit_file.', 'agent'));
  cmd('localpilot.generateTests', editorAction('Tests', (lang) => `Write thorough unit tests for this ${lang} code using the test framework already used in this project (check first). Create the test file with write_file.`, 'agent'));
  cmd('localpilot.generateDocs', editorAction('Docs', () => 'Add concise documentation comments to this code (only where they add information). Apply with edit_file.', 'agent'));
  cmd('localpilot.fixDiagnostics', async () => {
    const ed = vscode.window.activeTextEditor;
    if (!ed) {
      return;
    }
    const rel = vscode.workspace.asRelativePath(ed.document.uri);
    view.reveal();
    const s = store.create(getConfig().defaultModel, 'agent');
    s.title = `Fix errors: ${rel.split('/').pop()}`;
    await controller.handle({ type: 'selectSession', id: s.id });
    void controller.send(s.id, `Run get_diagnostics for ${rel}, fix every error with edit_file, then re-run get_diagnostics to confirm.`);
  });
  cmd('localpilot.commitMessage', async () => {
    view.reveal();
    const s = store.create(getConfig().defaultModel, 'agent');
    s.title = 'Commit message';
    await controller.handle({ type: 'selectSession', id: s.id });
    void controller.send(s.id, 'Run `git diff --cached` (fall back to `git diff` if nothing is staged) and write a conventional commit message for the changes. Output only the message in a code block.');
  });

  log.info('LocalPilot activated');
}

export function deactivate(): void {
  /* disposables handle cleanup */
}

function timeAgo(ts: number): string {
  const d = Date.now() - ts;
  if (d < 60e3) {
    return 'just now';
  }
  if (d < 3600e3) {
    return `${Math.floor(d / 60e3)}m ago`;
  }
  if (d < 86400e3) {
    return `${Math.floor(d / 3600e3)}h ago`;
  }
  return `${Math.floor(d / 86400e3)}d ago`;
}
