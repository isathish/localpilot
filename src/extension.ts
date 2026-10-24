import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { AgentRunner } from './agent/agentLoop';
import { ChangeTracker } from './agent/changeTracker';
import { createGatherContextTool } from './agent/clarify';
import { createSkillPrompt, SkillLearner } from './agent/skillRecommender';
import { describeSource, discoverSkills, installSkills, parseSkillSource, skillsDestination } from './agent/skillInstaller';
import { CatalogEntry, SkillCatalog, sourceFor } from './agent/skillCatalog';
import { createMemoryTools, manageTodosTool, MemoryStore } from './agent/memory';
import { SkillManager } from './agent/skills';
import { createAgentTools } from './agent/subagents';
import { getConfig, onConfigChange, setDefaultModel, setModelEnabled } from './config';
import { WorkspaceContext } from './context/workspaceContext';
import { McpManager } from './mcp/mcpManager';
import { catalogForSystem, installId, InstallTarget, MODEL_CATALOG } from './providers/catalog';
import { autoDetectProviders } from './providers/discovery';
import { AutoSetupResult, ModelManager } from './providers/modelManager';
import { ProviderRegistry } from './providers/registry';
import { getSystemProfile } from './providers/system';
import { SessionStore } from './sessions/sessionStore';
import { browserTools, captureUrl, inspectUrl, openInBrowser } from './tools/browser';
import { InspectReport } from './tools/cdp';
import { editorTools } from './tools/editor';
import { fsTools } from './tools/fs';
import { createAnalyzeWorkspaceTool } from './tools/workspace';
import { ToolRegistry } from './tools/registry';
import { searchTools } from './tools/search';
import { terminalTools } from './tools/terminal';
import { webTools } from './tools/web';
import { ModelInfo, Session } from './types';
import { AgentsTreeProvider } from './ui/agentsView';
import { ChatController } from './ui/chatController';
import { registerChatParticipant } from './ui/chatParticipant';
import { AGENTS_VIEW_IDS, agentsViewIdFor, CHAT_LOCATIONS, CHAT_VIEW_IDS, ChatViewProvider, getChatLocation } from './ui/chatViewProvider';
import { cliShim, installCli, registerUriHandler } from './ui/cli';
import { TerminalManager } from './terminal/terminalManager';
import { setIntegratedTerminalRunner } from './tools/terminal';
import { InlineCompletionProvider } from './ui/inlineCompletion';
import { inlineEdit, LocalPilotCodeActions, terminalCommand } from './ui/inlineEdit';
import { LocalModelChatProvider } from './ui/lmProvider';
import { createShowMarkdownTool, MarkdownViewer } from './ui/markdownViewer';
import { SettingsPanel, SettingsSection, WELCOMED_KEY } from './ui/settingsPanel';

export async function activate(context: vscode.ExtensionContext): Promise<LocalPilotApi> {
  const log = vscode.window.createOutputChannel('LocalPilot', { log: true });
  context.subscriptions.push(log);
  log.info('LocalPilot activating');

  // --- Core services -----------------------------------------------------------------------
  const providers = new ProviderRegistry(log);
  const tools = new ToolRegistry();
  const skills = new SkillManager(log, path.join(context.extensionPath, 'skills'));
  const workspace = new WorkspaceContext(log);
  const store = new SessionStore(context, log);
  const tracker = new ChangeTracker(log);
  const memory = new MemoryStore(context.globalStorageUri, log);
  const learner = new SkillLearner(path.join(context.globalStorageUri.fsPath, 'skill-learning.json'), log);
  // The catalog index lives in ~/.localpilot so the CLI and the extension share one copy.
  const catalog = new SkillCatalog({ cacheFile: path.join(os.homedir(), '.localpilot', 'skill-catalog.json'), repositories: () => getConfig().skillRepositories, log });
  const runner = new AgentRunner(providers, tools, skills, workspace, log, tracker, memory, learner, catalog);
  const controller = new ChatController(store, runner, providers, skills, workspace, tracker, log);
  controller.learner = learner;
  controller.catalog = catalog;
  context.subscriptions.push(learner);
  const extensionVersion = String((context.extension.packageJSON as { version?: string }).version ?? '0.0.0');
  const mcp = new McpManager(tools, log, extensionVersion);
  const modelManager = new ModelManager(providers, log);
  context.subscriptions.push(providers, tools, skills, workspace, store, tracker, controller, mcp, modelManager);

  // Register the chat hosts before anything is awaited: VS Code shows a bare progress bar in the view until the
  // provider exists, so this must not queue behind session/skill loading or model discovery.
  const view = new ChatViewProvider(context, controller);
  // The same chat/agents views exist once per container (sidebar, secondary side bar, panel); `when` clauses show one set.
  for (const id of CHAT_VIEW_IDS) {
    context.subscriptions.push(vscode.window.registerWebviewViewProvider(id, view, { webviewOptions: { retainContextWhenHidden: true } }));
  }

  // --- Terminal integration ------------------------------------------------------------------
  const terminals = new TerminalManager(context, log);
  context.subscriptions.push(terminals, new vscode.Disposable(() => setIntegratedTerminalRunner(undefined)));
  setIntegratedTerminalRunner(terminals);
  workspace.terminalContext = () => terminals.format(terminals.lastExecution());
  // A private bin dir with the `localpilot` shim so LocalPilot terminals have the CLI on PATH without installing it.
  void (async () => {
    try {
      const bin = vscode.Uri.joinPath(context.globalStorageUri, 'bin');
      await vscode.workspace.fs.createDirectory(bin);
      const shim = cliShim(context);
      const file = vscode.Uri.joinPath(bin, process.platform === 'win32' ? 'localpilot.cmd' : 'localpilot');
      await vscode.workspace.fs.writeFile(file, Buffer.from(process.platform === 'win32' ? shim.windows : shim.posix, 'utf8'));
      if (process.platform !== 'win32') {
        await (await import('fs/promises')).chmod(file.fsPath, 0o755);
      }
      const sep = process.platform === 'win32' ? ';' : ':';
      terminals.cliEnv = { ...shim.env, PATH: `${bin.fsPath}${sep}${process.env.PATH ?? ''}` };
    } catch (e) {
      log.warn(`could not prepare the localpilot CLI shim: ${String(e)}`);
    }
  })();
  context.subscriptions.push(
    vscode.window.registerTerminalProfileProvider('localpilot.terminalProfile', {
      provideTerminalProfile: () => new vscode.TerminalProfile(terminals.profileOptions()),
    })
  );


  tools.registerAll([...fsTools, ...searchTools, ...terminalTools, ...editorTools, ...webTools, ...browserTools, ...createMemoryTools(memory), manageTodosTool, createGatherContextTool(workspace, store), createAnalyzeWorkspaceTool(() => getConfig().parallel.maxConcurrency)]);
  tools.registerAll(createAgentTools(runner, skills, (e) => controller.emitEvent(e), (sid, title, detail, kind) => controller.requestApproval(sid, title, detail, kind)));
  const markdownViewer = new MarkdownViewer(context, log);
  controller.markdownViewer = markdownViewer;
  context.subscriptions.push(markdownViewer);
  tools.register(createShowMarkdownTool(markdownViewer, (p) => (path.isAbsolute(p) ? vscode.Uri.file(p) : workspace.root ? vscode.Uri.joinPath(vscode.Uri.file(workspace.root), p) : undefined)));

  await (controller.loaded = Promise.all([store.load(), skills.refresh()]));
  void mcp.reload();
  // Index the skill catalog off the critical path so the first request can already match uninstalled skills.
  if (getConfig().skillAutoInstall !== 'off') {
    setTimeout(() => void catalog.refresh().catch((e) => log.warn(`skill catalog: ${String(e)}`)), 5_000);
  }
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('localpilot.skillsPaths') || e.affectsConfiguration('localpilot.skills.builtin')) {
        void skills.refresh();
      }
      if (e.affectsConfiguration('localpilot.skills.repositories')) {
        void catalog.refresh().catch((err) => log.warn(`skill catalog: ${String(err)}`));
      }
    })
  );

  // --- UI ----------------------------------------------------------------------------------
  const agentsTree = new AgentsTreeProvider(controller);
  const agentsViews = AGENTS_VIEW_IDS.map((id) => vscode.window.createTreeView(id, { treeDataProvider: agentsTree, showCollapseAll: true }));
  context.subscriptions.push(agentsTree, ...agentsViews);
  const updateAgentsBadge = () => {
    const n = controller.runningSessionIds.length;
    for (const v of agentsViews) {
      v.badge = n ? { value: n, tooltip: `${n} agent${n === 1 ? '' : 's'} running` } : undefined;
    }
    void vscode.commands.executeCommand('setContext', 'localpilot.hasChanges', tracker.count > 0);
  };
  context.subscriptions.push(controller.onDidChangeRuns(updateAgentsBadge), tracker.onDidChange(updateAgentsBadge));
  registerChatParticipant(context, controller);
  registerUriHandler(context, controller, () => view.reveal());
  const settingsPanel = new SettingsPanel(context, providers, modelManager, skills, mcp, memory, store, log, () => controller.runningSessionIds);
  settingsPanel.learner = learner;
  context.subscriptions.push(settingsPanel);
  const lmProvider = new LocalModelChatProvider(providers, log);
  context.subscriptions.push(vscode.lm.registerLanguageModelChatProvider('localpilot', lmProvider), lmProvider);
  const inline = new InlineCompletionProvider(providers, log);
  context.subscriptions.push(vscode.languages.registerInlineCompletionItemProvider({ pattern: '**' }, inline), inline);
  context.subscriptions.push(vscode.languages.registerCodeActionsProvider({ pattern: '**' }, new LocalPilotCodeActions(), { providedCodeActionKinds: LocalPilotCodeActions.kinds }));

  const status = vscode.window.createStatusBarItem('localpilot.status', vscode.StatusBarAlignment.Right, 90);
  status.name = 'LocalPilot';
  status.command = 'localpilot.statusMenu';
  context.subscriptions.push(status);
  const refreshStatus = async () => {
    const cfg = getConfig();
    const models = await providers.listModels().catch(() => []);
    // Show what will actually answer: the router substitutes an offline/disabled default with the best available model.
    const routed = models.length ? await providers.route({}).catch(() => undefined) : undefined;
    const current = routed?.model.id ?? cfg.defaultModel ?? 'no model';
    const pulling = modelManager.activeJobs.find((j) => j.kind === 'pull');
    const running = controller.runningSessionIds.length;
    const name = current.split('/').pop();
    // Brand glyph when idle, animated spinner while agents run or a model downloads, warning colour when nothing is usable.
    status.text = pulling
      ? `$(sync~spin) ${pulling.model}${pulling.progress >= 0 ? ` ${Math.round(pulling.progress * 100)}%` : ''}`
      : running
        ? `$(loading~spin) ${running} agent${running === 1 ? '' : 's'} · ${name}`
        : `$(localpilot-logo) ${name}`;
    status.backgroundColor = models.length || pulling ? undefined : new vscode.ThemeColor('statusBarItem.warningBackground');
    status.tooltip = pulling
      ? `LocalPilot · downloading ${pulling.model} — ${pulling.detail}`
      : `LocalPilot · ${models.length} local model(s) from ${providers.all.length} provider(s)${routed?.reason ? `\n${routed.reason}` : ''}${cfg.inlineCompletion.enabled ? ' · inline completions on' : ''}\nClick for chat, models, layout and settings`;
    status.show();
  };
  void refreshStatus();
  context.subscriptions.push(providers.onDidChange(() => void refreshStatus()), onConfigChange(() => void refreshStatus()), modelManager.onDidChange(() => void refreshStatus()), controller.onDidChangeRuns(() => void refreshStatus()));

  // Auto-detect running model servers (settings, well-known ports, Docker containers, Docker Model Runner)
  // and merge new ones into the provider list. Runs at startup and on every "Refresh models".
  const DMR_HINT_KEY = 'localpilot.dmrHintDismissed';
  const autoDetect = async (): Promise<void> => {
    const report = await autoDetectProviders(log).catch((e) => {
      log.warn(`auto-detect failed: ${String(e)}`);
      return undefined;
    });
    if (!report) {
      return;
    }
    if (report.added.length) {
      const names = report.added.map((a) => a.displayName ?? a.id).join(', ');
      const n = report.results.filter((r) => report.added.some((a) => a.baseUrl === r.baseUrl)).reduce((s, r) => s + r.models.length, 0);
      void vscode.window
        .showInformationMessage(`LocalPilot found ${names} (${n} model${n === 1 ? '' : 's'}) and added ${report.added.length === 1 ? 'it' : 'them'} to your providers.`, 'Open providers')
        .then((pick) => pick && vscode.commands.executeCommand('localpilot.openSettings', 'providers'));
    }
    if (report.dockerModelRunner === 'no-tcp' && !context.globalState.get(DMR_HINT_KEY)) {
      void vscode.window
        .showInformationMessage('Docker Model Runner is running but only reachable from containers. Enable host access on port 12434 so LocalPilot can use its models?', 'Enable', 'Not now', "Don't ask again")
        .then(async (pick) => {
          if (pick === 'Enable') {
            const term = vscode.window.createTerminal({ name: 'LocalPilot · Docker' });
            term.show(true);
            term.sendText('docker desktop enable model-runner --tcp=12434');
            setTimeout(() => void autoDetect(), 8000);
          } else if (pick === "Don't ask again") {
            await context.globalState.update(DMR_HINT_KEY, true);
          }
        });
    }
    const cfg = getConfig();
    const available = report.results.filter((r) => r.ok && r.enabled).flatMap((r) => r.models);
    if (cfg.defaultModel && available.length && !available.some((m) => m.id === cfg.defaultModel) && report.recommended) {
      void vscode.window
        .showWarningMessage(`Default model "${cfg.defaultModel}" is not available right now; LocalPilot will use ${report.recommended.split('/').pop()} meanwhile.`, 'Make it the default')
        .then((pick) => pick && setDefaultModel(report.recommended!));
    }
    if (report.added.length) {
      await providers.listModels(true);
      await controller.handle({ type: 'refreshModels' });
      void refreshStatus();
    }
  };
  const detection = autoDetect();

  // First run: open the setup screen when nothing has been configured yet and no local model server is reachable.
  if (!context.globalState.get(WELCOMED_KEY) && getConfig().showWelcomeOnStartup) {
    void detection.then(() => providers.listModels().catch(() => [])).then((models) => {
      if (settingsPanel.isOpen) {
        return; // the user already opened Settings themselves — don't hijack the panel
      }
      if (!models.length || !getConfig().defaultModel) {
        settingsPanel.show('setup');
      } else {
        void context.globalState.update(WELCOMED_KEY, true);
      }
    });
  } else {
    // Returning user with no model anywhere (server stopped, models deleted): offer the one-click fix once per session.
    void detection.then(() => providers.listModels().catch(() => [])).then((models) => {
      if (!models.length && getConfig().autoSetupModels && !settingsPanel.isOpen) {
        void vscode.window
          .showWarningMessage('LocalPilot found no local models. Set up Ollama and a starter model that fits this machine automatically?', 'Set up automatically', 'Open Models')
          .then((pick) => {
            if (pick === 'Set up automatically') {
              void vscode.commands.executeCommand('localpilot.autoSetupModels');
            } else if (pick === 'Open Models') {
              settingsPanel.show('settings', 'models');
            }
          });
      }
    });
  }

  /** Runs the auto-setup with a cancellable progress notification; returns what happened. */
  const runAutoSetup = async (opts: { installRuntime?: boolean; target?: InstallTarget; force?: boolean } = {}): Promise<AutoSetupResult> => {
    const result = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'LocalPilot: setting up models', cancellable: true }, async (progress, token) => {
      const sub = modelManager.onDidChange(() => {
        const job = modelManager.activeJobs.find((j) => j.kind === 'pull' || j.kind === 'install-runtime' || j.kind === 'start') ?? modelManager.activeJobs.find((j) => j.kind === 'setup');
        if (job) {
          progress.report({ message: `${job.kind === 'pull' ? `${job.model}: ` : job.kind === 'install-runtime' ? 'Ollama: ' : ''}${job.detail}${job.progress >= 0 ? ` (${Math.round(job.progress * 100)}%)` : ''}` });
        }
      });
      token.onCancellationRequested(() => modelManager.activeJobs.forEach((j) => modelManager.cancel(j.id)));
      try {
        return await modelManager.autoSetup(opts);
      } finally {
        sub.dispose();
      }
    });
    await providers.listModels(true);
    await controller.handle({ type: 'refreshModels' });
    void refreshStatus();
    return result;
  };

  // --- Commands ----------------------------------------------------------------------------
  const cmd = (id: string, fn: (...a: unknown[]) => unknown) => context.subscriptions.push(vscode.commands.registerCommand(id, fn));

  cmd('localpilot.openSettings', (section?: unknown) => settingsPanel.show('settings', typeof section === 'string' ? (section as SettingsSection) : undefined));
  cmd('localpilot.openMarkdownViewer', async (arg?: unknown) => {
    // Explorer / editor-title pass a Uri; the palette uses the active editor.
    const uri = arg instanceof vscode.Uri ? arg : vscode.window.activeTextEditor?.document.uri;
    if (!uri) {
      void vscode.window.showInformationMessage('Open a Markdown file first, or use "Open as document" on a chat answer.');
      return;
    }
    await markdownViewer.showFile(uri);
  });
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
  cmd('localpilot.moveChat', () => view.pickLocation());
  // The views switch containers through their `when` clauses; a settings change (from Move Chat To…, the Settings
  // UI or settings.json) only needs the chat revealed in its new home — a container is hidden until something focuses it.
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((e) => e.affectsConfiguration('localpilot.chat.location') && void view.applyLocation(getChatLocation())));
  // Copilot-style status bar menu: one click reaches the chat, model, layout and settings.
  cmd('localpilot.statusMenu', async () => {
    const cfg = getConfig();
    const where = CHAT_LOCATIONS.find((l) => l.id === getChatLocation());
    const items: (vscode.QuickPickItem & { run?: () => unknown })[] = [
      { label: '$(localpilot-logo) Open Chat', description: where ? `in the ${where.label}` : undefined, run: () => view.reveal() },
      { label: '$(add) New Chat', run: () => vscode.commands.executeCommand('localpilot.newSession') },
      { label: '$(run-all) Run Tasks in Parallel…', run: () => vscode.commands.executeCommand('localpilot.runParallelTasks') },
      { label: '', kind: vscode.QuickPickItemKind.Separator },
      { label: '$(server) Select Model…', description: cfg.defaultModel || 'auto', run: () => vscode.commands.executeCommand('localpilot.selectModel') },
      { label: '$(library) Manage Models', run: () => vscode.commands.executeCommand('localpilot.manageModels') },
      { label: `$(${cfg.inlineCompletion.enabled ? 'check' : 'circle-large-outline'}) Inline Completions`, description: cfg.inlineCompletion.enabled ? 'on' : 'off', run: () => vscode.commands.executeCommand('localpilot.toggleInlineCompletions') },
      { label: '', kind: vscode.QuickPickItemKind.Separator },
      { label: '$(layout) Move Chat To…', description: where?.label, run: () => view.pickLocation() },
      { label: '$(settings-gear) Settings', run: () => vscode.commands.executeCommand('localpilot.openSettings') },
      { label: '$(output) Show Logs', run: () => vscode.commands.executeCommand('localpilot.showLogs') },
    ];
    const pick = await vscode.window.showQuickPick(items, { title: 'LocalPilot', placeHolder: 'Everything runs on your machine' });
    await pick?.run?.();
  });
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
    void vscode.commands.executeCommand(`${agentsViewIdFor(getChatLocation())}.focus`);
  });
  cmd('localpilot.clearHistory', async () => {
    const all = controller.store.list();
    const running = new Set(controller.runningSessionIds);
    const pinned = all.filter((s) => s.pinned && !running.has(s.id)).length;
    const idle = all.filter((s) => !running.has(s.id) && !s.pinned).length;
    if (!idle && !pinned) {
      return void vscode.window.showInformationMessage(running.size ? 'Only running chats are open — stop them first to delete them.' : 'No chat history to clear.');
    }
    const stats = await controller.store.stats();
    const size = stats.bytes > 1048576 ? `${(stats.bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(stats.bytes / 1024))} KB`;
    const choice = await vscode.window.showWarningMessage(
      `Clear chat history for this workspace?`,
      { modal: true, detail: `${idle} chat${idle === 1 ? '' : 's'} (${stats.messages} messages, ${size}) will be deleted permanently.${pinned ? ` ${pinned} pinned chat${pinned === 1 ? '' : 's'} can be kept.` : ''}${running.size ? ` ${running.size} running agent${running.size === 1 ? '' : 's'} will keep going.` : ''}` },
      pinned ? 'Clear, keep pinned' : 'Clear',
      ...(pinned ? ['Clear everything'] : [])
    );
    if (!choice) {
      return;
    }
    await controller.clearHistory({ keepPinned: choice !== 'Clear everything' });
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
      const pick = await vscode.window.showErrorMessage('No local models found. Is Ollama / LM Studio / llama.cpp / vLLM running?', 'Set up automatically', 'Open settings', 'Retry');
      if (pick === 'Set up automatically') {
        await vscode.commands.executeCommand('localpilot.autoSetupModels');
      } else if (pick === 'Open settings') {
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
  cmd('localpilot.manageModels', () => settingsPanel.show('settings', 'models'));
  cmd('localpilot.enableOllamaParallel', async () => {
    const slots = ModelManager.ollamaParallelSlots();
    const job = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Restarting Ollama with ${slots} parallel request slots…` }, () => modelManager.restartOllamaWithParallelSlots());
    if (job.status === 'done') {
      void vscode.window.showInformationMessage(`Ollama now serves up to ${slots} requests at once, so parallel subagents run concurrently. Lower localpilot.parallel.maxConcurrency if memory gets tight.`);
    } else if (job.status === 'error') {
      void vscode.window.showWarningMessage(job.error ?? 'Could not restart Ollama.', 'Open docs').then((p) => p && vscode.env.openExternal(vscode.Uri.parse('https://isathish.github.io/localpilot/docs/parallel-agents/#parallel-requests')));
    }
    return job;
  });
  // The runner noticed concurrent requests queuing at the server (Ollama's default is one slot per model).
  runner.onSerialServer = (model) => {
    const provider = getConfig().providers.find((p) => p.id === model.providerId);
    const isOllama = provider?.type === 'ollama';
    const msg = `${model.name} is answering one request at a time, so parallel subagents are queuing instead of running concurrently.${isOllama ? ` LocalPilot can restart Ollama with ${ModelManager.ollamaParallelSlots()} parallel slots.` : ' Enable parallel requests on the server (e.g. OLLAMA_NUM_PARALLEL, or more replicas) to speed this up.'}`;
    void vscode.window.showWarningMessage(msg, ...(isOllama ? ['Restart Ollama with parallel slots'] : []), 'Learn more').then((p) => {
      if (p === 'Restart Ollama with parallel slots') {
        void vscode.commands.executeCommand('localpilot.enableOllamaParallel');
      } else if (p === 'Learn more') {
        void vscode.env.openExternal(vscode.Uri.parse('https://isathish.github.io/localpilot/docs/parallel-agents/#parallel-requests'));
      }
    });
  };
  cmd('localpilot.autoSetupModels', async (arg?: unknown) => {
    const o = (arg && typeof arg === 'object' ? arg : {}) as { installRuntime?: boolean; target?: InstallTarget; force?: boolean };
    const profile = await getSystemProfile();
    const plan = await modelManager.plan();
    const r = await runAutoSetup(o);
    switch (r.status) {
      case 'already':
        void vscode.window.showInformationMessage(`LocalPilot already has ${r.models} local model(s). Install more from the catalog in Settings → Models.`, 'Open Models').then((p) => p && settingsPanel.show('settings', 'models'));
        return r;
      case 'installed':
        void vscode.window.showInformationMessage(`LocalPilot is ready: ${r.agent.split('/').pop()} is the default model${r.completion ? `, ${r.completion.split('/').pop()} handles inline completions` : ''}${r.vision ? `, ${r.vision.split('/').pop()} handles images` : ''}.`, 'Open chat').then((p) => p && view.reveal());
        void context.globalState.update(WELCOMED_KEY, true);
        return r;
      case 'needs-runtime': {
        // Nothing to run models on: install Ollama in the background (user-space, no sudo/UAC) and continue with the
        // starter download — the whole thing is one click. The progress notification has Cancel.
        if (o.installRuntime === false) {
          settingsPanel.show('settings', 'providers');
          return r;
        }
        vscode.window.setStatusBarMessage(`LocalPilot: installing Ollama and ${plan.agent.entry.name} ${plan.agent.variant.tag} (${plan.agent.variant.gb} GB) for this ${profile.ramGb} GB machine…`, 6000);
        return vscode.commands.executeCommand('localpilot.autoSetupModels', { ...o, installRuntime: true });
      }
      case 'error':
        void vscode.window.showErrorMessage(`Model setup failed: ${r.error}`, 'Show logs', 'Open Models').then((p) => (p === 'Show logs' ? log.show() : p && settingsPanel.show('settings', 'models')));
        return r;
      default:
        return r;
    }
  });
  cmd('localpilot.installModel', async () => {
    const profile = await getSystemProfile();
    const installed = await providers.listAllModels().catch(() => []);
    const rows = catalogForSystem(profile, installed).filter((r) => r.fits || r.tight);
    type Item = vscode.QuickPickItem & { row?: (typeof rows)[number] };
    const items: Item[] = [];
    for (const entry of MODEL_CATALOG) {
      const variants = rows.filter((r) => r.entry === entry);
      if (!variants.length) {
        continue;
      }
      items.push({ label: entry.name, kind: vscode.QuickPickItemKind.Separator });
      for (const r of variants) {
        items.push({
          label: `${r.recommendedFor.length ? '$(star-full) ' : ''}${entry.name} ${r.variant.tag}`,
          description: `${r.variant.gb} GB · ${r.fits ? 'fits' : 'tight'}${r.installed.length ? ' · installed' : ''}`,
          detail: `${entry.description} ${entry.roles.join(', ')}`,
          row: r,
        });
      }
    }
    const picked = await vscode.window.showQuickPick(items, { title: `Install a model · ${profile.summary} · budget ${profile.modelBudgetGb} GB`, matchOnDescription: true, matchOnDetail: true });
    if (!picked?.row) {
      return;
    }
    const runtimes = (await modelManager.detectRuntimes()).filter((rt) => rt.running && installId(picked.row!, rt.target));
    if (!runtimes.length) {
      const p = await vscode.window.showWarningMessage('No running runtime can install this model. Start Ollama, Docker Model Runner or LM Studio first.', 'Set up automatically');
      if (p) {
        await vscode.commands.executeCommand('localpilot.autoSetupModels');
      }
      return;
    }
    const target = runtimes.length === 1 ? runtimes[0] : await vscode.window.showQuickPick(runtimes.map((rt) => ({ label: rt.label, description: rt.baseUrl, rt })), { title: 'Install to' }).then((x) => x?.rt);
    if (!target) {
      return;
    }
    settingsPanel.show('settings', 'models');
    const job = await modelManager.pull(target.target, installId(picked.row, target.target)!, target.providerId);
    if (job.status === 'done') {
      await providers.listModels(true);
      await controller.handle({ type: 'refreshModels' });
      void vscode.window.showInformationMessage(`${job.model} installed on ${target.label}.`);
    } else if (job.status === 'error') {
      void vscode.window.showErrorMessage(`Install failed: ${job.error}`);
    }
  });
  cmd('localpilot.removeModel', async () => {
    const runtimes = await modelManager.detectRuntimes();
    const models = (await providers.listAllModels(true).catch(() => [])).filter((m) => runtimes.some((rt) => rt.providerId === m.providerId && rt.canRemove && rt.running));
    if (!models.length) {
      return void vscode.window.showInformationMessage('No removable models (only Ollama and Docker Model Runner models can be deleted from here).');
    }
    const picked = await vscode.window.showQuickPick(
      models.map((m) => ({ label: m.name, description: `${m.providerId}${m.sizeBytes ? ` · ${(m.sizeBytes / 1024 ** 3).toFixed(1)} GB` : ''}`, m })),
      { title: 'Remove a local model', placeHolder: 'Deletes the model files from the runtime' }
    );
    if (!picked) {
      return;
    }
    const ok = await vscode.window.showWarningMessage(`Delete ${picked.m.name} from ${picked.m.providerId}? You can download it again later.`, { modal: true }, 'Delete');
    if (!ok) {
      return;
    }
    const rt = runtimes.find((x) => x.providerId === picked.m.providerId)!;
    const job = await modelManager.remove(rt.target, picked.m.modelId, rt.providerId);
    if (job.status === 'done') {
      await providers.listModels(true);
      await controller.handle({ type: 'refreshModels' });
      void refreshStatus();
    } else {
      void vscode.window.showErrorMessage(`Remove failed: ${job.error}`);
    }
  });
  cmd('localpilot.toggleModel', async (id?: unknown) => {
    const all = await providers.listAllModels().catch(() => []);
    let target = typeof id === 'string' ? all.find((m) => m.id === id) : undefined;
    if (!target) {
      const picked = await vscode.window.showQuickPick(
        all.map((m) => ({ label: `${m.disabled ? '$(circle-slash) ' : '$(check) '}${m.name}`, description: m.providerId, detail: m.disabled ? 'disabled — select to enable' : 'enabled — select to disable', m })),
        { title: 'Enable / disable a model' }
      );
      target = picked?.m;
    }
    if (target) {
      await setModelEnabled(target.id, !!target.disabled);
      vscode.window.setStatusBarMessage(`LocalPilot: ${target.name} ${target.disabled ? 'enabled' : 'disabled'}`, 2500);
    }
  });
  cmd('localpilot.refreshModels', async () => {
    await autoDetect();
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
  cmd('localpilot.createSkill', async (suggestion?: unknown) => {
    const s = suggestion as { slug?: string; topic?: string; count?: number; samples?: string[] } | undefined;
    if (!s?.slug) {
      return;
    }
    view.reveal();
    await new Promise((r) => setTimeout(r, 300));
    controller.draft(createSkillPrompt({ slug: s.slug, topic: s.topic ?? s.slug, count: s.count ?? 1, samples: s.samples ?? [] }));
  });
  cmd('localpilot.dismissSkillTopic', async (topic?: unknown) => {
    if (typeof topic === 'string') {
      await learner.dismiss(topic);
    }
  });
  cmd('localpilot.installSkill', async (arg?: unknown) => {
    const o = (arg && typeof arg === 'object' ? arg : typeof arg === 'string' ? { source: arg } : {}) as { source?: string; scope?: 'workspace' | 'user'; only?: string[] };
    const source =
      o.source?.trim() ||
      (await vscode.window.showInputBox({
        title: 'Install a skill',
        prompt: 'GitHub repository or folder (owner/repo, owner/repo/skills/name, a github.com URL), a URL to a SKILL.md, or a local skill folder',
        placeHolder: 'owner/repo/skills/my-skill',
        ignoreFocusOut: true,
      }));
    if (!source) {
      return undefined;
    }
    const src = parseSkillSource(source);
    if (!src) {
      void vscode.window.showErrorMessage(`"${source}" is not a skill source.`);
      return undefined;
    }
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    let scope = o.scope;
    if (!scope) {
      const pick = await vscode.window.showQuickPick(
        [
          ...(root ? [{ label: 'This workspace', description: path.join(root, '.localpilot', 'skills'), detail: 'Shared with everyone who opens this project', scope: 'workspace' as const }] : []),
          { label: 'My skills (all workspaces)', description: skillsDestination('user'), scope: 'user' as const },
        ],
        { title: `Install ${describeSource(src)} into…`, ignoreFocusOut: true }
      );
      if (!pick) {
        return undefined;
      }
      scope = pick.scope;
    }
    const dest = skillsDestination(scope, root);
    try {
      const installed = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Installing skill from ${describeSource(src)}…`, cancellable: true }, async (progress, token) => {
        const ac = new AbortController();
        token.onCancellationRequested(() => ac.abort());
        const found = await discoverSkills(src, { signal: ac.signal });
        let only: string[] | undefined = o.only?.length ? o.only : undefined;
        if (found.length > 1 && !only) {
          const picked = await vscode.window.showQuickPick(
            found.map((f) => ({ label: f.name, description: f.description.slice(0, 100), detail: f.dir || undefined, picked: true })),
            { title: `${found.length} skills found — choose which to install`, canPickMany: true, ignoreFocusOut: true }
          );
          if (!picked?.length) {
            return [];
          }
          only = picked.map((p) => p.label);
        }
        return installSkills(src, {
          dest,
          only,
          signal: ac.signal,
          progress: (t) => progress.report({ message: t }),
          onExists: async (name) => (await vscode.window.showWarningMessage(`A skill named "${name}" is already installed there. Replace it?`, { modal: true }, 'Replace')) === 'Replace',
        });
      });
      await skills.refresh();
      if (installed.length) {
        const names = installed.map((i) => `"${i.name}"`).join(', ');
        void vscode.window.showInformationMessage(`Installed ${names} into ${dest}. The agent loads it when a request matches, or force it with /skill ${installed[0].name} <task>.`, 'Open SKILL.md', 'Open chat').then((p) => {
          if (p === 'Open SKILL.md') {
            void vscode.window.showTextDocument(vscode.Uri.file(path.join(installed[0].dir, 'SKILL.md')));
          } else if (p === 'Open chat') {
            view.reveal();
          }
        });
      }
      return installed;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log.error(`install skill ${source}: ${msg}`);
      void vscode.window.showErrorMessage(`Could not install the skill: ${msg}`);
      return undefined;
    }
  });
  // Browse the configured skill repositories: type to filter, pick one or more, choose where to install.
  cmd('localpilot.browseSkills', async (arg?: unknown) => {
    const preset = typeof arg === 'string' ? arg : '';
    type Item = vscode.QuickPickItem & { entry?: CatalogEntry };
    const qp = vscode.window.createQuickPick<Item>();
    qp.title = 'Skill catalog';
    qp.placeholder = 'Type to search skills by name or description…';
    qp.matchOnDescription = true;
    qp.matchOnDetail = true;
    qp.canSelectMany = true;
    qp.ignoreFocusOut = true;
    qp.value = preset;
    const refreshBtn: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('refresh'), tooltip: 'Re-index the skill repositories' };
    const settingsBtn: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('gear'), tooltip: 'Edit localpilot.skills.repositories' };
    qp.buttons = [refreshBtn, settingsBtn];
    const render = async () => {
      const have = new Set(skills.allSkills.map((s) => s.name));
      const entries = await catalog.entries();
      const status = await catalog.status();
      const items: Item[] = [];
      for (const s of status) {
        const own = entries.filter((e) => e.repo === s.repo);
        items.push({ label: s.repo, kind: vscode.QuickPickItemKind.Separator, description: s.error ? `⚠ ${s.error}` : `${own.length} skills` });
        for (const e of own) {
          items.push({ label: `${have.has(e.name) ? '$(check) ' : '$(book) '}${e.name}`, description: e.description.replace(/\s+/g, ' ').slice(0, 120), detail: have.has(e.name) ? 'Installed' : undefined, entry: e });
        }
      }
      if (!entries.length) {
        items.push({ label: status.some((s) => s.error) ? 'The catalog could not be fetched — check the repositories and your connection' : 'Indexing the skill repositories…', description: '', alwaysShow: true });
      }
      qp.items = items;
    };
    qp.busy = true;
    qp.show();
    await render();
    if (!(await catalog.ready())) {
      await catalog.refresh();
      await render();
    }
    qp.busy = false;
    qp.onDidTriggerButton(async (b) => {
      if (b === settingsBtn) {
        void vscode.commands.executeCommand('workbench.action.openSettings', 'localpilot.skills.repositories');
        return;
      }
      qp.busy = true;
      await catalog.refresh(true).catch((e) => log.warn(`skill catalog: ${String(e)}`));
      await render();
      qp.busy = false;
    });
    const picked = await new Promise<Item[]>((resolve) => {
      qp.onDidAccept(() => resolve([...qp.selectedItems]));
      qp.onDidHide(() => resolve([]));
    });
    qp.dispose();
    const entries = picked.flatMap((p) => (p.entry ? [p.entry] : []));
    if (!entries.length) {
      return undefined;
    }
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const scopePick = await vscode.window.showQuickPick(
      [
        ...(root ? [{ label: 'This workspace', description: path.join(root, '.localpilot', 'skills'), scope: 'workspace' as const }] : []),
        { label: 'My skills (all workspaces)', description: skillsDestination('user'), scope: 'user' as const },
      ],
      { title: `Install ${entries.map((e) => e.name).join(', ')} into…`, ignoreFocusOut: true }
    );
    if (!scopePick) {
      return undefined;
    }
    const dest = skillsDestination(scopePick.scope, root);
    const done: string[] = [];
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Installing skills…', cancellable: true }, async (progress, token) => {
      const ac = new AbortController();
      token.onCancellationRequested(() => ac.abort());
      for (const e of entries) {
        try {
          const exists = await vscode.workspace.fs.stat(vscode.Uri.file(path.join(dest, e.name))).then(() => true, () => false);
          const replace = !exists || (await vscode.window.showWarningMessage(`A skill named "${e.name}" is already installed there. Replace it?`, { modal: true }, 'Replace')) === 'Replace';
          const one = replace ? await catalog.install(e, dest, { signal: ac.signal, replace: true, progress: (t) => progress.report({ message: t }) }) : undefined;
          if (one) {
            done.push(one.name);
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          log.error(`install skill ${describeSource(sourceFor(e))}: ${msg}`);
          void vscode.window.showErrorMessage(`Could not install "${e.name}": ${msg}`);
        }
      }
    });
    await skills.refresh();
    if (done.length) {
      void vscode.window.showInformationMessage(`Installed ${done.map((n) => `"${n}"`).join(', ')} into ${dest}. The agent loads them when a request matches, or force one with /skill ${done[0]} <task>.`, 'Open chat').then((p) => p === 'Open chat' && view.reveal());
    }
    return done;
  });
  cmd('localpilot.reloadSkills', async () => {
    await skills.refresh();
    await mcp.reload();
    vscode.window.showInformationMessage(`LocalPilot: ${skills.allSkills.length} skills, ${skills.allAgents.length} subagents, ${mcp.status.reduce((n, s) => n + s.tools, 0)} MCP tools`);
  });
  cmd('localpilot.showLogs', () => log.show());
  cmd('localpilot.installCli', () => installCli(context));
  cmd('localpilot.openTerminal', (run?: unknown) => {
    const term = terminals.openCliTerminal(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath);
    if (typeof run === 'string' && run.trim()) {
      term.sendText(run.trim());
    }
    return term;
  });
  // Terminal context-menu actions: hand the last command + output of the clicked terminal to a new chat.
  const terminalAction = (title: string, instruction: string, mode: 'agent' | 'ask', preferFailure: boolean) => async (terminal?: unknown) => {
    const t = terminal && typeof terminal === 'object' && 'name' in terminal ? (terminal as vscode.Terminal) : vscode.window.activeTerminal;
    const rec = (preferFailure ? terminals.lastFailure() : undefined) ?? terminals.lastExecution(t);
    if (!rec) {
      const pick = await vscode.window.showWarningMessage('No terminal command captured yet. Shell integration must be enabled (it is by default for bash, zsh, fish and PowerShell); run a command in the terminal and try again.', 'Learn more');
      if (pick) {
        void vscode.env.openExternal(vscode.Uri.parse('https://code.visualstudio.com/docs/terminal/shell-integration'));
      }
      return;
    }
    view.reveal();
    const s = store.create(getConfig().defaultModel, mode);
    s.title = `${title}: ${rec.command.slice(0, 40)}`;
    await controller.handle({ type: 'selectSession', id: s.id });
    void controller.send(s.id, `${terminals.format(rec)}\n\n${instruction}`);
  };
  cmd('localpilot.explainTerminal', terminalAction('Explain', 'Explain what this terminal output means. If it is an error, say what caused it and how to fix it.', 'ask', false));
  cmd('localpilot.fixTerminal', terminalAction('Fix', 'This command failed. Find the cause in the workspace, fix it (edit files or suggest the corrected command), then re-run the command with run_command to verify.', 'agent', true));
  cmd('localpilot.attachTerminal', async (terminal?: unknown) => {
    const t = terminal && typeof terminal === 'object' && 'name' in terminal ? (terminal as vscode.Terminal) : vscode.window.activeTerminal;
    if (!terminals.lastExecution(t)) {
      return void vscode.window.showWarningMessage('No terminal command captured yet in this terminal.');
    }
    view.reveal();
    await controller.handle({ type: 'attachRef', ref: 'terminal' });
  });
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
  cmd('localpilot.openBrowser', async (url?: unknown) => {
    const target = typeof url === 'string' ? url : await vscode.window.showInputBox({ title: 'LocalPilot: open in browser view', prompt: 'http(s) URL — e.g. a local dev server', placeHolder: 'http://localhost:3000', ignoreFocusOut: true });
    if (!target) {
      return;
    }
    try {
      await openInBrowser(target);
    } catch (e) {
      void vscode.window.showErrorMessage(e instanceof Error ? e.message : String(e));
    }
  });
  cmd('localpilot.screenshotUrl', async (url?: unknown) => {
    view.reveal();
    await controller.captureUrl(typeof url === 'string' ? url : undefined);
  });
  cmd('localpilot.inspectUrl', async (url?: unknown) => {
    view.reveal();
    await controller.inspectUrl(typeof url === 'string' ? url : undefined);
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

  return {
    version: extensionVersion,
    runPrompt: (prompt, mode, attachments) => controller.runPrompt(prompt, mode, attachments),
    runParallel: (tasks, mode) => controller.runParallel(tasks, mode),
    send: (sessionId, text) => controller.send(sessionId, text),
    stop: (sessionId) => controller.stop(sessionId),
    getSession: (id) => store.get(id),
    get runningSessionIds() {
      return controller.runningSessionIds;
    },
    onDidChangeRuns: controller.onDidChangeRuns,
    listModels: () => providers.listModels(),
    autoSetupModels: (opts) => runAutoSetup(opts),
    screenshotUrl: (url, opts) => captureUrl(url, opts).then((s) => ({ name: s.name, data: s.data, mime: s.mime, url: s.url, width: s.width, height: s.height })),
    inspectUrl: (url, opts) => inspectUrl(url, opts),
    installModel: (target, model) => modelManager.pull(target, model).then((j) => j.status === 'done'),
    get chatHost() {
      return view.host;
    },
  };
}

/** Programmatic API returned by `activate()` — `vscode.extensions.getExtension('localpilot.localpilot-agent').exports`. */
export interface LocalPilotApi {
  readonly version: string;
  /** Starts a new session for `prompt` and returns its id; the run streams in the background. */
  runPrompt(prompt: string, mode?: Session['mode'], attachments?: string[]): Promise<string>;
  /** Starts one independent agent session per task, all running concurrently. */
  runParallel(tasks: string[], mode?: Session['mode']): Promise<string[]>;
  /** Sends a follow-up to an existing session and resolves with the final assistant text. */
  send(sessionId: string, text: string): Promise<string>;
  stop(sessionId: string): void;
  getSession(id: string): Session | undefined;
  readonly runningSessionIds: string[];
  readonly onDidChangeRuns: vscode.Event<void>;
  listModels(): Promise<ModelInfo[]>;
  /** Installs a starter model set sized for this machine (no-op when models already exist unless `force`). */
  autoSetupModels(opts?: { installRuntime?: boolean; target?: InstallTarget; force?: boolean }): Promise<AutoSetupResult>;
  /** Pulls a model onto a runtime; resolves true on success. */
  installModel(target: InstallTarget, model: string): Promise<boolean>;
  /** Renders a URL with a local headless Chromium browser and returns the PNG (base64). */
  screenshotUrl(url: string, opts?: { width?: number; height?: number; fullPage?: boolean; mobile?: boolean; waitMs?: number }): Promise<{ name: string; data: string; mime: string; url: string; width: number; height: number }>;
  /** DevTools inspection of a URL: screenshot, console, network trace, performance and layout checks (optionally after actions). */
  inspectUrl(url: string, opts?: { width?: number; height?: number; fullPage?: boolean; mobile?: boolean; waitMs?: number; includeText?: boolean; actions?: { click?: string; type?: { selector: string; text: string }; scroll?: 'top' | 'bottom' | number; eval?: string; wait?: number }[] }): Promise<InspectReport>;
  /** The view hosting the chat right now (`localpilot.chatView`, `.secondary`, `.panel`), whether it is visible and whether its UI has booted; undefined before the view is first shown or when the chat lives in an editor tab. */
  readonly chatHost: { viewId: string; visible: boolean; ready: boolean } | undefined;
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
