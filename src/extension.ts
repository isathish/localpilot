import * as crypto from 'crypto';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { createIndexStatusBar, REBUILD_INDEX_COMMAND } from './ui/indexStatusBar';
import { AgentRunner } from './agent/agentLoop';
import { ChangeTracker } from './agent/changeTracker';
import { CheckpointService, isOrphanCheckpoint, pruneSnapshotDirs } from './agent/checkpoints';
import { createGatherContextTool } from './agent/clarify';
import { createSkillPrompt, SkillLearner } from './agent/skillRecommender';
import { describeSource, discoverSkills, installSkills, parseSkillSource, skillsDestination } from './agent/skillInstaller';
import { CatalogEntry, SkillCatalog, sourceFor } from './agent/skillCatalog';
import { createMemoryTools, manageTodosTool, MemoryStore } from './agent/memory';
import { gitTools } from './tools/git';
import { teamBoardTool } from './tools/teamBoard';
import { createScheduleTool } from './tools/schedule';
import { extensionLauncher, registerSessionImport } from './ui/automation';
import { repoGraphTool } from './tools/repoGraph';
import { SkillManager } from './agent/skills';
import { createAgentTools } from './agent/subagents';
import { ProjectSettingsManager } from './agent/settings';
import { setWorkspaceApprovalStore } from './agent/workspaceApprovals';
import { HookRunner } from './agent/hooks';
import { PluginManager } from './agent/plugins';
import { CommandManager } from './agent/commands';
import { configTarget, editableProviders, getConfig, onConfigChange, setDefaultModel, setModelEnabled } from './config';
import { WorkspaceContext } from './context/workspaceContext';
import { McpManager } from './mcp/mcpManager';
import { showMcpFileProblems, workspaceMcpTrust } from './mcp/trust';
import { catalogForSystem, installId, InstallTarget, MODEL_CATALOG } from './providers/catalog';
import { autoDetectProviders, recommendModel } from './providers/discovery';
import { AutoSetupResult, findOllamaBinary, ModelManager, ollamaModelsOnDisk, ollamaUp } from './providers/modelManager';
import { ServiceSupervisor } from './providers/supervisor';
import { onLmModelsChanged } from './providers/vscodeLm';
import { ProviderRegistry } from './providers/registry';
import { ConnectivityMonitor, proxyConfigured } from './providers/connectivity';
import { isCloudProvider, resolveApiKey, secretEnvName, secretRefs } from './providers/cloud';
import { ProviderSecrets } from './providers/secrets';
import { ColibriLauncher } from './ui/colibriCommand';
import { GatewayLauncher } from './ui/gatewayCommand';
import { ModelTuner } from './ui/modelAutoTune';
import { getSystemProfile } from './providers/system';
import { SessionStore } from './sessions/sessionStore';
import { browserTools, captureUrl, inspectUrl, openInBrowser } from './tools/browser';
import { InspectReport } from './tools/cdp';
import { editorTools } from './tools/editor';
import { deleteUri, fsTools } from './tools/fs';
import { notebookTools } from './tools/notebook';
import { registerNotebookCommands } from './ui/notebook';
import { generateCommitMessage, stopCommitMessage } from './ui/commitMessage';
import { applyPatchTool } from './tools/applyPatchTool';
import { pdfTools } from './tools/pdf';
import { PdfEditorProvider } from './ui/pdf/pdfEditor';
import { openPdf } from './ui/pdf/open';
import { createAnalyzeWorkspaceTool } from './tools/workspace';
import { ToolRegistry } from './tools/registry';
import { searchTools } from './tools/search';
import { terminalTools } from './tools/terminal';
import { webTools } from './tools/web';
import { ModelInfo, Session } from './types';
import { AgentsTreeProvider } from './ui/agentsView';
import { ChatController, ToWebview } from './ui/chatController';
import { WhatsNew } from './ui/whatsNew';
import { registerChatParticipant } from './ui/chatParticipant';
import { AGENTS_VIEW_ID, ATTACH_FILTERS, CHAT_LOCATIONS, CHAT_VIEW_ID, ChatViewProvider, getChatLocation } from './ui/chatViewProvider';
import { WorktreeManager } from './agent/worktrees';
import { cliSessionsDir } from './sessions/cliStorage';
import { cliShim, installCli, registerUriHandler } from './ui/cli';
import { TerminalManager } from './terminal/terminalManager';
import { setIntegratedTerminalRunner } from './tools/terminal';
import { deleteCommandLogs, pruneCommandLogs, setCommandLogDir, stopAllCommands } from './terminal/commandRun';
import { InlineCompletionProvider } from './ui/inlineCompletion';
import { inlineEdit, LocalPilotCodeActions, terminalCommand } from './ui/inlineEdit';
import { problemsDraft, readTerminalSelection, selectionLines, selectionRef, terminalSelectionDraft } from './ui/addToChat';
import { LocalModelChatProvider } from './ui/lmProvider';
import { createShowMarkdownTool, MarkdownViewer } from './ui/markdownViewer';
import { MarkdownCustomEditor } from './ui/markdown/customEditor';
import { registerMarkdownCommands } from './ui/markdown/commands';
import { SettingsPanel, SettingsSection, WELCOMED_KEY } from './ui/settingsPanel';
import { mirrorLog } from './telemetry/logMirror';
import { defaultTelemetryDir, LogEntry, LogLevel, Telemetry, TelemetrySummary } from './telemetry/telemetry';
import { RedisTelemetry } from './storage/redisTelemetry';
import { setTelemetryRecorder } from './telemetry/catalog';
import { attachOtlp } from './telemetry/otlpSetup';
import { resolveOtlpConfig } from './telemetry/otlp';
import { probeRedis, restartRedis, setupRedis } from './storage/redisSetup';
import { TaskQueue, type QueueTaskStatus } from './agent/taskQueue';
import type { InterventionRecord, RecoveryState, RollbackResult, TaskOutcome } from './agent/healing';
import { createHealingHost, ensureChecksFile, registerRecoverySnapshots } from './healingHost';
import { healingView } from './ui/healingChecksView';
import { RecoveryCommands, queueTaskFor } from './ui/recoveryCommands';
import { AutoReviewer } from './agent/autoReviewer';
import { reposTool } from './tools/repos';
import { securityScanTool } from './tools/security';
import { selectTerminalProfile } from './terminal/profileSetting';
import { describePlugin, loadMarketplace, Marketplace, searchPlugins, setPluginEnabled } from './agent/pluginInstaller';
import { installMarketplacePlugin } from './ui/pluginInstallFlow';
import { McpOAuth } from './mcp/oauth';
import { editMcpConfiguration } from './ui/mcpConfigEditor';

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

let shutdown: (() => Promise<void>) | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<LocalPilotApi> {
  // "Always allow in this workspace" grants live in this workspace's extension state; getConfig() reads them.
  setWorkspaceApprovalStore(context.workspaceState);
  const channel = vscode.window.createOutputChannel('LocalPilot', { log: true });
  context.subscriptions.push(channel);
  // Local-only metrics and a readable copy of the log for the dashboard; shared with the CLI under ~/.localpilot.
  // With `storage.redis.enabled` they go to Redis (Stack) instead, so the history never sits in this process.
  let redisTelemetry: RedisTelemetry | undefined;
  /** Re-reads the Redis settings; true when the store changed. */
  const syncRedis = (): boolean => {
    const r = getConfig().storage.redis;
    if (r.enabled && redisTelemetry?.url === r.url) {
      return false;
    }
    const had = !!redisTelemetry;
    redisTelemetry?.dispose();
    redisTelemetry = undefined;
    if (r.enabled) {
      try {
        redisTelemetry = new RedisTelemetry(r.url);
      } catch (e) {
        channel.warn(`Telemetry: invalid localpilot.storage.redis.url (${e instanceof Error ? e.message : String(e)}); writing to files`);
      }
    }
    return had || !!redisTelemetry;
  };
  syncRedis();
  const telemetry = new Telemetry({
    dir: defaultTelemetryDir(),
    retentionDays: () => getConfig().telemetry.retentionDays,
    enabled: () => getConfig().telemetry.enabled,
    remote: () => redisTelemetry,
    // Straight to the channel: a mirrored log line about a failing write would only queue another write.
    onRemoteError: (e) => channel.warn(`Telemetry: ${redisTelemetry?.label ?? 'Redis'} unavailable, writing to files for a minute (${e instanceof Error ? e.message : String(e)})`),
  });
  shutdown = async () => {
    await telemetry.flush();
    redisTelemetry?.dispose();
    redisTelemetry = undefined;
  };
  const log = mirrorLog(channel, telemetry);
  context.subscriptions.push(telemetry);
  setTelemetryRecorder(telemetry);
  // Straight to the channel again: an export report mirrored into telemetry would be exported, and reported, forever.
  const otlp = attachOtlp(telemetry, { settings: () => getConfig().telemetry.otlp, version: String((context.extension.packageJSON as { version?: string }).version ?? '0.0.0'), out: (l) => channel.info(l), warn: (m) => channel.warn(m) });
  context.subscriptions.push(new vscode.Disposable(() => redisTelemetry?.dispose()));
  context.subscriptions.push(
    onConfigChange(() => {
      void otlp.sync().then((changed) => changed && log.info(otlp.sink ? `Telemetry: exporting over OTLP to ${otlp.config.endpoint}` : 'Telemetry: OTLP export off'));
      if (syncRedis()) {
        // A new target deserves a fresh try, not the old one's back-off.
        telemetry.resetRemote();
        log.info(redisTelemetry ? `Telemetry: storing events and the log in ${redisTelemetry.label}` : `Telemetry: storing events and the log in ${telemetry.dir}`);
      }
    })
  );
  void telemetry.loadRecentLogs();
  setTimeout(() => void telemetry.prune().then((n) => n && log.info(`removed ${n} expired telemetry file(s)`)), 8000);
  log.info('LocalPilot activating');

  // --- Core services -----------------------------------------------------------------------
  const providers = new ProviderRegistry(log);
  providers.telemetry = telemetry;
  // API keys entered in Settings live in the OS keychain; settings.json holds only `${secret:<id>}` references.
  const providerSecrets = new ProviderSecrets(context.secrets, context.globalState);
  const loadSecrets = () => void providerSecrets.load().catch((e) => log.warn(`provider keys: ${e instanceof Error ? e.message : String(e)}`));
  context.subscriptions.push(providerSecrets, onConfigChange(loadSecrets));
  loadSecrets();
  // The CLI reads this snapshot of the user-level settings, so it follows the active profile and VS Code flavour.
  const writeCliSettings = () => {
    const props = (context.extension.packageJSON as { contributes?: { configuration?: { properties?: Record<string, unknown> } } }).contributes?.configuration?.properties ?? {};
    const conf = vscode.workspace.getConfiguration();
    const snapshot: Record<string, unknown> = {};
    for (const key of Object.keys(props)) {
      const value = conf.inspect(key)?.globalValue;
      if (value !== undefined) {
        snapshot[key] = value;
      }
    }
    void Promise.resolve(vscode.workspace.fs.writeFile(vscode.Uri.joinPath(context.globalStorageUri, 'cli-settings.json'), Buffer.from(JSON.stringify(snapshot, null, 2))))
      .catch((e) => log.warn(`CLI settings snapshot: ${e instanceof Error ? e.message : String(e)}`));
  };
  context.subscriptions.push(onConfigChange(writeCliSettings));
  writeCliSettings();
  const tools = new ToolRegistry();
  const skills = new SkillManager(log, path.join(context.extensionPath, 'skills'));
  const workspace = new WorkspaceContext(log);
  const store = new SessionStore(context, log);
  store.maxInMemory = () => getConfig().storage.sessionsInMemory;
  // Chats started with the `localpilot` CLI in the same folder show up in the history (read-only source).
  if (getConfig().historyIncludeCli) {
    store.extraDirs = (vscode.workspace.workspaceFolders ?? []).filter((f) => f.uri.scheme === 'file').map((f) => vscode.Uri.file(cliSessionsDir(f.uri.fsPath)));
    context.subscriptions.push(store.watchExternal(), vscode.window.onDidChangeWindowState((s) => s.focused && store.loadedOk && void store.refreshExternal().catch(() => undefined)));
  }
  context.subscriptions.push(onConfigChange(() => store.trim()));
  const tracker = new ChangeTracker(log);
  const memory = new MemoryStore(context.globalStorageUri, log, () => getConfig().memoryLimits);
  const learner = new SkillLearner(path.join(context.globalStorageUri.fsPath, 'skill-learning.json'), log);
  // The catalog index lives in ~/.localpilot so the CLI and the extension share one copy.
  const catalog = new SkillCatalog({ cacheFile: process.env.LOCALPILOT_SKILL_CATALOG || path.join(os.homedir(), '.localpilot', 'skill-catalog.json'), repositories: () => getConfig().skillRepositories, log });
  const runner = new AgentRunner(providers, tools, skills, workspace, log, tracker, memory, learner, catalog);
  const worktrees = new WorktreeManager(() => process.env.LOCALPILOT_WORKTREES_DIR || getConfig().worktrees.location, log);
  const controller = new ChatController(store, runner, providers, skills, workspace, tracker, log, worktrees);
  controller.modelPrefs = context.globalState;
  // After an update the empty chat shows the top bullets of the bundled CHANGELOG section once.
  controller.whatsNew = WhatsNew.forExtension(context.globalState, String((context.extension.packageJSON as { version?: string }).version ?? '0.0.0'), context.extensionPath);
  // Each window prunes only its own worktrees: other windows on the same repository and the CLI keep theirs.
  controller.worktreeOwner = `vscode:${crypto.createHash('sha1').update((context.storageUri ?? context.globalStorageUri).toString()).digest('hex').slice(0, 8)}`;
  runner.telemetry = telemetry;
  runner.archive = store;
  runner.autoReviewer = new AutoReviewer(providers, log);
  tracker.persistDir = path.join((context.storageUri ?? context.globalStorageUri).fsPath, 'checkpoints');
  const checkpoints = new CheckpointService({
    globalStorageDir: context.globalStorageUri.fsPath,
    enabled: () => getConfig().checkpointsEnabled,
    log,
    defaultRoot: () => workspace.root,
    multiRoot: () => (vscode.workspace.workspaceFolders?.length ?? 0) > 1,
    warn: (m) => void vscode.window.showWarningMessage(m),
  });
  runner.checkpoints = checkpoints;
  let checkpointCleanup: Promise<unknown> = Promise.resolve();
  context.subscriptions.push(store.onDidDelete((id) => {
    const done = checkpoints.deleteSession(id).catch((e) => log.warn(`checkpoint cleanup: ${String(e)}`));
    checkpointCleanup = Promise.all([checkpointCleanup, done]);
  }));
  // The logs of its detached commands go with a deleted chat too (the store removes its transcript archive).
  context.subscriptions.push(store.onDidDelete((id) => deleteCommandLogs(id)));
  controller.telemetry = telemetry;
  // Claude Code-compatible project configuration: settings.json (permission rules, hooks), plugins and custom
  // slash commands from both `.claude/` and `.localpilot/`.
  const projectSettings = new ProjectSettingsManager(log);
  const plugins = new PluginManager(log);
  plugins.extraDirs = () => getConfig().pluginPaths;
  plugins.enabledPlugins = () => projectSettings.current.enabledPlugins;
  const commands = new CommandManager(log, plugins);
  skills.plugins = plugins;
  runner.projectSettings = () => projectSettings.current;
  controller.reloadPermissionRules = () => projectSettings.reload();
  // A hook that prints on every tool call would bury the chat in toasts: repeats within 30 s and bursts are log-only.
  const hookToasts = new Map<string, number>();
  let lastHookToast = 0;
  runner.hooks = new HookRunner(() => (getConfig().hooksEnabled ? projectSettings.current : { ...projectSettings.current, hooks: {} }), log, (text, event) => {
    log.info(`[hook:${event}] ${text}`);
    const now = Date.now();
    if (now - (hookToasts.get(text) ?? 0) < 30_000 || now - lastHookToast < 3_000) {
      return;
    }
    hookToasts.set(text, now);
    lastHookToast = now;
    if (hookToasts.size > 100) {
      hookToasts.delete(hookToasts.keys().next().value!);
    }
    controller.toast(text.length > 160 ? `${text.slice(0, 160)}…` : text);
  });
  controller.commands = commands;
  context.subscriptions.push(projectSettings, plugins, commands);
  // "Before" side of worktree diffs: the file as the agent found it (the worktree's base commit).
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider('localpilot-wtbase', {
      provideTextDocumentContent: async (uri) => {
        const s = store.get(decodeURIComponent(uri.query));
        return s?.worktree ? worktrees.baseContent(s.worktree, uri.path.replace(/^\//, '')) : '';
      },
    })
  );
  controller.learner = learner;
  controller.catalog = catalog;
  context.subscriptions.push(learner);
  const extensionVersion = String((context.extension.packageJSON as { version?: string }).version ?? '0.0.0');
  const mcp = new McpManager(tools, log, extensionVersion);
  mcp.extraServers = () => plugins.mcpServers();
  mcp.trust = workspaceMcpTrust(context.workspaceState);
  mcp.onFileProblems = showMcpFileProblems;
  mcp.loadSecrets = (names) => providerSecrets.loadNames(names);
  // OAuth tokens of remote MCP servers live in the OS keychain, keyed by server URL so every window shares them.
  const mcpOAuth = new McpOAuth(context.secrets, { openExternal: (url) => vscode.env.openExternal(vscode.Uri.parse(url)), log: (m) => log.info(m) });
  mcp.oauth = mcpOAuth;
  context.subscriptions.push(mcpOAuth);
  controller.mcp = mcp;
  const modelManager = new ModelManager(providers, log);
  // Self-healing: one service per window; the agent loop runs its engine, the chat shows its cards and actions.
  const healing = createHealingHost({
    storageDir: (context.storageUri ?? context.globalStorageUri).fsPath,
    log,
    telemetry,
    providers,
    tracker,
    mcp,
    liveSessions: () => controller.runningSessionIds,
    root: () => workspace.root,
  });
  runner.healing = healing.service;
  controller.healing = healing.service;
  setTimeout(() => void healing.store.prune().then((n) => n && log.info(`removed ${n} expired recovery state(s)`)).catch(() => undefined), 10_000);
  // Disposed in order: the task queue stops recording results before the controller stops the runs for shutdown, so
  // interrupted tasks stay `running` on disk and resume next time; the store releases its locks after the runs saved.
  let taskQueueRef: TaskQueue | undefined;
  const disposeQueue = () => taskQueueRef?.dispose();
  const previousShutdown = shutdown;
  shutdown = async () => {
    disposeQueue();
    await previousShutdown?.();
  };
  context.subscriptions.push({ dispose: disposeQueue });
  context.subscriptions.push(providers, tools, skills, workspace, store, tracker, controller, mcp, modelManager);
  context.subscriptions.push({ dispose: () => void healing.store.dispose().catch(() => undefined) }, registerRecoverySnapshots(healing.store));

  // --- Background services -------------------------------------------------------------------
  // Keeps the local model server and (when enabled) Redis running while VS Code is open; see ServiceSupervisor.
  const isLocalUrl = (u: string) => /^\w+:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::|\/|$)/i.test(u);
  const ollamaCfg = () => getConfig().providers.find((p) => p.type === 'ollama' && isLocalUrl(p.baseUrl));
  // A stopped Ollama that has models downloaded is one the user works with: keep it running from the start.
  let ollamaHasModels = false;
  void ollamaModelsOnDisk().then((v) => (ollamaHasModels = v));
  // A run that needs a model on a local Ollama that is installed but stopped starts it instead of failing.
  providers.startLocalServer = async (p) => {
    if (p.type !== 'ollama' || !isLocalUrl(p.baseUrl) || !(await findOllamaBinary())) {
      return undefined;
    }
    const job = await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: 'LocalPilot: starting Ollama…' }, () => modelManager.startOllama(p.id));
    if (job.status !== 'done') {
      log.warn(`Could not start Ollama: ${job.error ?? job.status}`);
      return false;
    }
    log.info('Started Ollama for a request that needed it');
    return true;
  };
  const supervisor = new ServiceSupervisor(
    [
      {
        id: 'ollama',
        label: 'Ollama',
        wanted: (seenUp) => {
          const cfg = getConfig();
          const o = ollamaCfg();
          // Only a local Ollama LocalPilot actually uses: seen running this session, serving the default model, or
          // holding downloaded models (so a machine where it is stopped gets it back without a manual start).
          return cfg.supervisor.enabled && !!o && isLocalUrl(o.baseUrl) && (seenUp || cfg.defaultModel.startsWith(`${o.id}/`) || ollamaHasModels);
        },
        isUp: async () => {
          const o = ollamaCfg();
          return !!o && ollamaUp(o.baseUrl.replace(/\/+$/, ''));
        },
        start: async () => {
          if (!(await findOllamaBinary())) {
            throw new Error('Ollama is not installed');
          }
          const job = await modelManager.startOllama();
          if (job.status !== 'done') {
            throw new Error(job.error ?? 'did not start');
          }
          providers.invalidate();
          void providers.listModels(true).catch(() => undefined);
          return true;
        },
      },
      {
        id: 'redis',
        label: 'Redis',
        wanted: () => getConfig().supervisor.enabled && getConfig().storage.redis.enabled,
        isUp: async () => (await probeRedis(getConfig().storage.redis.url)).ok,
        start: () => restartRedis(getConfig().storage.redis.url, log),
      },
    ],
    () => getConfig().supervisor.intervalSeconds * 1000,
    log,
    (st, retry) => {
      void vscode.window
        .showWarningMessage(`LocalPilot could not restart ${st.label} after ${st.failures} tries${st.lastError ? `: ${st.lastError}` : ''}. It will stop trying until you retry.`, 'Retry', 'Show Logs')
        .then((pick) => (pick === 'Retry' ? retry() : pick === 'Show Logs' ? log.show() : undefined));
    }
  );
  context.subscriptions.push(supervisor);
  supervisor.start();

  // Settings first (plugins may be disabled there), then plugins (they contribute skills, agents, commands, hooks,
  // MCP servers), then everything that reads them. Assigned before the chat hosts exist so an early webview waits
  // for the sessions instead of seeing an empty store.
  controller.loaded = (async () => {
    await projectSettings.reload();
    await plugins.refresh();
    projectSettings.pluginLayers = plugins.settingsLayers();
    await projectSettings.reload();
    await Promise.all([store.load(), skills.refresh(), commands.refresh()]);
  })();

  // Register the chat hosts before anything is awaited: VS Code shows a bare progress bar in the view until the
  // provider exists, so this must not queue behind session/skill loading or model discovery.
  const view = new ChatViewProvider(context, controller);
  context.subscriptions.push(vscode.window.registerWebviewViewProvider(CHAT_VIEW_ID, view, { webviewOptions: { retainContextWhenHidden: true } }));
  context.subscriptions.push(vscode.window.registerWebviewPanelSerializer(ChatViewProvider.panelViewType, { deserializeWebviewPanel: async (panel) => view.adoptPanel(panel) }));

  // --- Terminal integration ------------------------------------------------------------------
  const terminals = new TerminalManager(context, log);
  context.subscriptions.push(terminals, new vscode.Disposable(() => setIntegratedTerminalRunner(undefined)));
  setIntegratedTerminalRunner(terminals);
  // Detached commands log under global storage; a day-old log is of no use to anyone. They die with the window.
  setCommandLogDir(path.join(context.globalStorageUri.fsPath, 'cmd-logs'));
  setTimeout(() => pruneCommandLogs(), 5_000).unref?.();
  context.subscriptions.push(new vscode.Disposable(() => stopAllCommands()));
  workspace.terminalContext = () => terminals.format(terminals.lastExecution());
  workspace.approveUrl = async (url) => (await vscode.window.showWarningMessage(`Fetch ${url} for the chat?`, { modal: true, detail: 'The page is attached to your message (localpilot.approvals.network is "ask").' }, 'Fetch')) === 'Fetch';
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


  tools.registerAll([...fsTools, ...notebookTools, applyPatchTool, ...pdfTools, ...searchTools, ...terminalTools, ...editorTools, ...webTools, ...browserTools, ...createMemoryTools(memory), manageTodosTool, createGatherContextTool(workspace, store), createAnalyzeWorkspaceTool(() => getConfig().parallel.maxConcurrency), repoGraphTool, ...gitTools, teamBoardTool, reposTool, securityScanTool]);
  tools.registerAll(createAgentTools(runner, skills, (e) => controller.emitEvent(e), (sid, title, detail, kind) => controller.requestApproval(sid, title, detail, kind)));
  tools.registerAll([createScheduleTool(() => extensionLauncher(context))]);
  registerSessionImport(context, store);
  const markdownViewer = new MarkdownViewer(context, log, controller);
  controller.markdownViewer = markdownViewer;
  // Before any awaited work, so readers restored with the window resolve.
  context.subscriptions.push(markdownViewer, MarkdownViewer.registerSerializer(context), MarkdownCustomEditor.register(context, log, controller), ...registerMarkdownCommands(markdownViewer, controller));
  tools.register(createShowMarkdownTool(markdownViewer));
  const pdfViewer = PdfEditorProvider.register(context, log, {
    addToComposer: (text, refs) => {
      view.reveal();
      controller.addToComposer(text, refs);
    },
    attachImage: (img) => {
      view.reveal();
      controller.attachImage(img);
    },
  });
  context.subscriptions.push(
    pdfViewer.disposable,
    vscode.commands.registerCommand('localpilot.openPdf', async (arg?: unknown) => {
      const uri = arg instanceof vscode.Uri ? arg : (await vscode.window.showOpenDialog({ canSelectMany: false, openLabel: 'Open PDF', filters: { PDF: ['pdf'] }, defaultUri: vscode.workspace.workspaceFolders?.[0]?.uri }))?.[0];
      if (uri) {
        // `file.pdf#page=3` opens at that page (and reuses an open viewer of the file).
        const page = /(?:^|&)page=(\d+)/.exec(uri.fragment)?.[1];
        await openPdf(uri, page ? Number(page) : undefined);
      }
    }),
    vscode.commands.registerCommand('localpilot.pdf.attachPageImage', () => {
      if (!pdfViewer.provider.attachActivePageImage()) {
        void vscode.window.showInformationMessage('Open a PDF in the LocalPilot PDF Viewer first.');
      }
    })
  );

  await controller.loaded;
  // Worktrees of sessions that no longer exist (crash, manual deletion of the chat store) are removed on start —
  // only once the sessions are loaded, so a live chat's worktree is never mistaken for an orphan.
  // Checkpoint refs of chats deleted while LocalPilot was not running, and stale private indexes.
  void controller.loaded
    .then(async () => {
      checkpoints.pruneScratch();
      const root = workspace.root;
      if (store.loadedOk) {
        const live = new Set(store.list().map((s) => s.id));
        pruneSnapshotDirs(tracker.persistDir!, (sid) => isOrphanCheckpoint(sid, live));
        const n = root ? await checkpoints.pruneRefs(root, (sid, last) => isOrphanCheckpoint(sid, live, Date.now(), last)) : 0;
        if (n) {
          log.info(`removed the checkpoints of ${n} deleted chat(s)`);
        }
      }
    })
    .catch((e) => log.warn(`checkpoint prune: ${e instanceof Error ? e.message : String(e)}`));
  void controller.loaded
    .then(() => new Promise((r) => setTimeout(r, 5000)))
    .then(() => controller.pruneWorktrees())
    .then((n) => n && log.info(`removed ${n} orphaned worktree(s)`))
    .catch((e) => log.warn(`worktree prune: ${e instanceof Error ? e.message : String(e)}`));
  /** Background refreshes must never surface as unhandled rejections: one failing layer is logged, the others still apply. */
  const refresh = (what: string, p: Promise<unknown>) => void p.catch((e) => log.warn(`${what}: ${e instanceof Error ? e.message : String(e)}`));
  refresh('mcp', mcp.reload());
  context.subscriptions.push(
    plugins.onDidChange(() => {
      projectSettings.pluginLayers = plugins.settingsLayers();
      refresh('settings', projectSettings.reload());
      refresh('skills', skills.refresh());
      refresh('commands', commands.refresh());
      refresh('mcp', mcp.reloadIfChanged());
    }),
    projectSettings.onDidChange(() => refresh('plugins', plugins.refresh()))
  );
  // Index the skill catalog off the critical path so the first request can already match uninstalled skills.
  if (getConfig().skillAutoInstall !== 'off') {
    setTimeout(() => refresh('skill catalog', catalog.refresh()), 5_000);
  }
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('localpilot.skillsPaths') || e.affectsConfiguration('localpilot.skills.builtin') || e.affectsConfiguration('localpilot.skills.disabled') || e.affectsConfiguration('localpilot.skills.autoInstall')) {
        refresh('skills', skills.refresh());
      }
      if (e.affectsConfiguration('localpilot.skills.repositories')) {
        refresh('skill catalog', catalog.refresh());
      }
      if (e.affectsConfiguration('localpilot.pluginPaths')) {
        refresh('plugins', plugins.refresh());
      }
    })
  );

  // --- UI ----------------------------------------------------------------------------------
  // Persistent task queue: tasks run as chats one after another (or `queue.concurrency` at a time).
  const taskQueue = new TaskQueue(
    path.join((context.storageUri ?? context.globalStorageUri).fsPath, 'task-queue.json'),
    (task, started) => controller.runQueuedTask({ id: task.id, prompt: task.prompt, mode: task.mode, model: task.model, sessionId: task.sessionId, resume: task.resume }, started, getConfig().queue.concurrency > 1),
    () => getConfig().queue.concurrency,
    log,
    { resumable: (sid) => healing.service.resumeInfo(sid)?.phase === 'interrupted' }
  );
  taskQueueRef = taskQueue;
  // Interrupted recoveries are indexed before the queue loads, so its interrupted tasks continue in their own chat.
  const queueLoaded = controller.loaded
    .then(() => healing.service.scanUnfinished().catch((e) => log.warn(`Self-healing: could not scan for interrupted recoveries: ${e instanceof Error ? e.message : String(e)}`)))
    .then(() => taskQueue.load());
  const agentsTree = new AgentsTreeProvider(controller, taskQueue, { recovery: true });
  const agentsView = vscode.window.createTreeView(AGENTS_VIEW_ID, { treeDataProvider: agentsTree, showCollapseAll: true });
  context.subscriptions.push(agentsTree, agentsView);
  const updateAgentsBadge = () => {
    const n = controller.runningSessionIds.length;
    agentsView.badge = n ? { value: n, tooltip: `${n} agent${n === 1 ? '' : 's'} running` } : undefined;
    void vscode.commands.executeCommand('setContext', 'localpilot.hasChanges', tracker.count > 0);
    // Drive the Agents title bar: Pause/Resume/Stop All and Compare Results only show when they would do something.
    void vscode.commands.executeCommand('setContext', 'localpilot.anyRunning', n > 0);
    void vscode.commands.executeCommand('setContext', 'localpilot.anyPaused', controller.pausedSessionIds.length > 0);
    void vscode.commands.executeCommand('setContext', 'localpilot.hasBatches', store.list().some((s) => s.group));
  };
  context.subscriptions.push(controller.onDidChangeRuns(updateAgentsBadge), tracker.onDidChange(updateAgentsBadge), store.onDidChange(updateAgentsBadge));
  updateAgentsBadge();
  registerChatParticipant(context, controller);
  registerUriHandler(context, controller, () => view.reveal());
  const settingsPanel = new SettingsPanel(context, providers, modelManager, skills, mcp, memory, store, log, () => controller.runningSessionIds, telemetry, providerSecrets, () => tools.list().map((t) => ({ name: t.definition.name, description: t.definition.description.split(/(?<=\.)\s/)[0].slice(0, 160) })),
    () => otlp.test(),
    // Resolved fresh: the state push after a settings change can run before otlp.sync() has caught up.
    () => {
      const t = getConfig().telemetry;
      const c = resolveOtlpConfig(t.otlp, process.env, String((context.extension.packageJSON as { version?: string }).version ?? '0.0.0'));
      const offBecause = !c.enabled ? 'localpilot.telemetry.otlp.enabled' : !t.enabled ? 'localpilot.telemetry.enabled' : undefined;
      return { enabled: !offBecause, offBecause, endpoint: c.endpoint, fromEnv: c.fromEnv };
    });
  settingsPanel.learner = learner;
  // Learns from local telemetry which installed models work best per role; feeds Auto routing and tunes the settings.
  const tuner = new ModelTuner(telemetry, providers, context.globalState, log);
  context.subscriptions.push(tuner);
  settingsPanel.tuner = tuner;
  settingsPanel.catalog = catalog;
  settingsPanel.plugins = plugins;
  const recovery = new RecoveryCommands({
    controller,
    queue: taskQueue,
    healing: healing.service,
    store: healing.store,
    memory: healing.memory,
    root: () => workspace.root,
    log,
    reveal: () => view.reveal(),
    showDashboard: () => settingsPanel.show('settings', 'dashboard'),
    showProviders: () => settingsPanel.show('settings', 'providers'),
    pickModel: () => vscode.commands.executeCommand('localpilot.selectModel'),
    startServer: async () => {
      const job = await modelManager.startOllama();
      providers.invalidate();
      return job.status === 'done';
    },
  });
  context.subscriptions.push(...recovery.register());
  settingsPanel.recoveryDashboard = async (days) => {
    const summary = await telemetry.summary(days).catch(() => undefined);
    return healing.service.dashboard(days, summary, workspace.root);
  };
  settingsPanel.onRecoveryAction = (sid, action, interventionId) => recovery.action(sid, action, interventionId);
  settingsPanel.onMemoryReuse = (id, allowed) => recovery.memoryReuse(id, allowed);
  settingsPanel.openRecoveryDiff = (sid, attempt, file) => recovery.openDiff(sid, attempt, file);
  settingsPanel.loadChecks = () => {
    const i = vscode.workspace.getConfiguration('localpilot').inspect<unknown>('healing.checks');
    return healingView(workspace.root, { user: i?.globalValue, workspace: i?.workspaceValue ?? i?.workspaceFolderValue }, vscode.workspace.isTrusted);
  };
  settingsPanel.openChecks = async () => {
    const root = workspace.root;
    if (!root) {
      void vscode.window.showErrorMessage('Open a folder first: .localpilot/checks.json belongs to a workspace.');
      return;
    }
    const { file, created } = await ensureChecksFile(root);
    await vscode.window.showTextDocument(vscode.Uri.file(file), { preview: false });
    if (!vscode.workspace.isTrusted) {
      void vscode.window.showWarningMessage('This workspace is not trusted: .localpilot/checks.json is ignored until you trust it.');
    } else if (created) {
      log.info(`Created ${file}`);
    }
  };
  // Once the index is filled: the restored chat's interrupted card, and one notification for the recoveries left over.
  void queueLoaded
    .then(() => {
      controller.refreshInterrupted();
      recovery.notifyInterrupted(!!view.host?.visible);
    })
    .catch((e) => log.warn(`Self-healing: ${e instanceof Error ? e.message : String(e)}`));
  // Settings pushes state on every change; the git walk behind the checkpoint size is cached for a minute.
  let checkpointSize: { at: number; bytes: Promise<number> } | undefined;
  settingsPanel.reloadPermissionRules = () => projectSettings.reload();
  settingsPanel.checkpointBytes = () => {
    if (!checkpointSize || Date.now() - checkpointSize.at > 60_000) {
      checkpointSize = { at: Date.now(), bytes: checkpoints.diskUsage({ snapshotDir: tracker.persistDir }).then((u) => u.total) };
    }
    return checkpointSize.bytes;
  };
  // Deleted chats free their checkpoints: drop the cached size once the cleanup is done and show the new figure.
  let sizeRefresh: ReturnType<typeof setTimeout> | undefined;
  context.subscriptions.push(
    store.onDidDelete(() => {
      checkpointSize = undefined;
      clearTimeout(sizeRefresh);
      sizeRefresh = setTimeout(() => void checkpointCleanup.then(() => {
        checkpointSize = undefined;
        settingsPanel.refresh();
      }), 200);
    }),
    { dispose: () => clearTimeout(sizeRefresh) }
  );
  // Settings → Customize switched, created or deleted a rule, command, hook or plugin: user-level files have no watcher.
  settingsPanel.onCustomized = () => {
    workspace.invalidateInstructions();
    void commands.refresh();
    // Hook scripts are switched with chmod, which file watchers do not report; a plugin switch is read from settings.json.
    refresh('customize', projectSettings.reload().then(() => plugins.refresh()));
  };
  context.subscriptions.push(settingsPanel);
  const lmProvider = new LocalModelChatProvider(providers, log);
  context.subscriptions.push(vscode.lm.registerLanguageModelChatProvider('localpilot', lmProvider), lmProvider);
  // Copilot (or another model extension) signed in or out: list the `vscode-lm` provider's models again.
  context.subscriptions.push(
    onLmModelsChanged(() => {
      if (getConfig().providers.some((p) => p.type === 'vscode-lm')) {
        providers.invalidate();
        void providers.listModels().catch(() => undefined);
      }
    })
  );
  const inline = new InlineCompletionProvider(providers, log);
  inline.telemetry = telemetry;
  context.subscriptions.push(
    vscode.languages.registerInlineCompletionItemProvider({ pattern: '**' }, inline),
    inline,
    vscode.commands.registerCommand(InlineCompletionProvider.ACCEPTED_COMMAND, (model?: unknown, language?: unknown) => inline.accepted(typeof model === 'string' ? model : undefined, typeof language === 'string' ? language : undefined))
  );
  context.subscriptions.push(vscode.languages.registerCodeActionsProvider({ pattern: '**' }, new LocalPilotCodeActions(), { providedCodeActionKinds: LocalPilotCodeActions.kinds }));

  // The @ file index: scan progress, and how much of a large repository the @ menu lists. Click rescans.
  context.subscriptions.push(createIndexStatusBar(controller));
  const status = vscode.window.createStatusBarItem('localpilot.status', vscode.StatusBarAlignment.Right, 90);
  status.name = 'LocalPilot';
  status.command = 'localpilot.statusMenu';
  context.subscriptions.push(status);
  // What the status bar last showed, so its menu offers setup when no model is reachable and names the same model.
  let statusModels = -1;
  let statusModel: string | undefined;
  const refreshStatus = async () => {
    const cfg = getConfig();
    const models = await providers.listModels().catch(() => []);
    statusModels = models.length;
    void vscode.commands.executeCommand('setContext', 'localpilot.hasModels', models.length > 0);
    // Show what will actually answer: the router substitutes an offline/disabled default with the best available model.
    const routed = models.length ? await providers.route({ start: false }).catch(() => undefined) : undefined;
    const current = routed?.model.id ?? cfg.defaultModel ?? 'no model';
    statusModel = routed?.model.id ?? cfg.defaultModel;
    const pulling = modelManager.activeJobs.find((j) => j.kind === 'pull');
    const running = controller.runningSessionIds.length;
    const name = current.split('/').pop();
    // Brand glyph when idle, animated spinner while agents run or a model downloads, warning colour when nothing is usable.
    status.text = pulling
      ? `$(sync~spin) ${pulling.model}${pulling.progress >= 0 ? ` ${Math.round(pulling.progress * 100)}%` : ''}`
      : running
        ? `$(loading~spin) ${running} agent${running === 1 ? '' : 's'} · ${name}`
        : `$(localpilot-logo) ${name}`;
    if (cfg.autoMode.enabled) {
      status.text += ' $(zap)';
    }
    status.backgroundColor = models.length || pulling ? undefined : new vscode.ThemeColor('statusBarItem.warningBackground');
    status.tooltip = pulling
      ? `LocalPilot · downloading ${pulling.model} — ${pulling.detail}`
      : !models.length
        ? 'LocalPilot: no model server found. Click to set one up.'
        : `LocalPilot · ${plural(models.length, 'local model')} from ${plural(providers.all.length, 'provider')}${routed?.reason ? `\n${routed.reason}` : ''}${cfg.inlineCompletion.enabled ? ' · inline completions on' : ''}${cfg.autoMode.enabled ? '\nAuto mode on: a local reviewer approves safe actions' : ''}\nClick for chat, models, layout and settings`;
    if (connectivity.current.offline) {
      status.tooltip = `Offline: cloud models are skipped while a local model exists\n${status.tooltip}`;
    }
    const waiting = controller.pendingCount();
    if (waiting) {
      status.text += ` $(bell-dot) ${waiting}`;
      status.tooltip = `${waiting === 1 ? '1 agent needs' : `${waiting} agents need`} your approval\n${status.tooltip}`;
    }
    status.show();
  };
  // Offline: a status-bar indicator, the chat's banner and the router's local-only fallback follow the network.
  const connectivity = new ConnectivityMonitor({ providers: () => getConfig().providers, proxy: () => proxyConfigured(vscode.workspace.getConfiguration('http').get<string>('proxy')) });
  const offlineItem = vscode.window.createStatusBarItem('localpilot.offline', vscode.StatusBarAlignment.Right, 91);
  offlineItem.name = 'LocalPilot offline';
  offlineItem.text = '$(debug-disconnect) Offline';
  offlineItem.command = 'localpilot.checkConnection';
  const syncConnectivity = (checking = false) => {
    const st = connectivity.current;
    const local = providers.cachedModels().some((m) => !m.remote);
    providers.offline = st.offline;
    offlineItem.tooltip = new vscode.MarkdownString(
      `**LocalPilot: offline** since ${new Date(st.since).toLocaleTimeString()}\n\n${local ? 'Using local models only: chats on a cloud model switch to a local one until the network is back.' : 'No local model to fall back on: cloud models need the network.'} Web search and fetch are unavailable.\n\nClick to check again.`
    );
    if (st.offline) {
      offlineItem.show();
    } else {
      offlineItem.hide();
    }
    controller.setConnectivity({ offline: st.offline, since: st.since, local, checking });
  };
  context.subscriptions.push(
    offlineItem,
    { dispose: () => connectivity.dispose() },
    connectivity.onChange((st) => {
      syncConnectivity();
      log.info(st.offline ? 'Network: offline — cloud models are skipped while a local model exists' : 'Network: back online');
      void refreshStatus();
    }),
    providers.onDidChange(() => syncConnectivity()),
    vscode.commands.registerCommand('localpilot.checkConnection', async () => {
      syncConnectivity(true);
      const st = await connectivity.check();
      syncConnectivity();
      void vscode.window.setStatusBarMessage(st.offline ? '$(debug-disconnect) LocalPilot: still offline' : '$(check) LocalPilot: online', 4000);
    })
  );
  controller.connectivityHooks = { hint: (online) => connectivity.hint(online), check: () => void vscode.commands.executeCommand('localpilot.checkConnection') };
  connectivity.start();
  void refreshStatus();
  context.subscriptions.push(providers.onDidChange(() => void refreshStatus()), onConfigChange(() => void refreshStatus()), modelManager.onDidChange(() => void refreshStatus()), controller.onDidChangeRuns(() => void refreshStatus()));
  // Models pulled or removed in a terminal (`ollama pull/rm`) show up when the user comes back to the window.
  context.subscriptions.push(vscode.window.onDidChangeWindowState((s) => s.focused && void providers.listModels().catch(() => undefined)));
  // …and while the window is focused, without any action: new models within a minute, a server started later within seconds.
  context.subscriptions.push(providers.startAutoRefresh(() => vscode.window.state.focused));

  // Auto-detect running model servers (settings, well-known ports, Docker containers, Docker Model Runner)
  // and merge new ones into the provider list. Runs at startup and on every "Refresh models".
  const DMR_HINT_KEY = 'localpilot.dmrHintDismissed';
  const DEFAULT_HINT_KEY = 'localpilot.defaultUnavailableDismissed';
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
    const quietDefaults = context.globalState.get<string[]>(DEFAULT_HINT_KEY, []);
    // A default missing from an Ollama server is uninstalled, not offline: the registry clears it back to Auto.
    const defaultPid = cfg.defaultModel.split('/')[0];
    const defaultProvider = providers.get(defaultPid);
    const ollamaDefault = defaultProvider?.type === 'ollama' && report.results.some((r) => r.ok && r.id === defaultPid);
    // A stopped Ollama on this machine is started on demand by the first request: nothing is unavailable.
    const loopback = (url: string) => {
      try {
        return /^(localhost|127\.\d+\.\d+\.\d+|\[::1\])$/i.test(new URL(url).hostname);
      } catch {
        return false;
      }
    };
    const startable = defaultProvider?.type === 'ollama' && loopback(defaultProvider.baseUrl) && !!(await findOllamaBinary().catch(() => undefined));
    if (cfg.defaultModel && !ollamaDefault && !startable && available.length && !available.some((m) => m.id === cfg.defaultModel) && !quietDefaults.includes(cfg.defaultModel)) {
      const missing = cfg.defaultModel;
      // Never suggest sending prompts off the machine in place of a local default.
      const local = report.results.filter((r) => r.ok && r.enabled && !isCloudProvider({ ...r, cloud: cfg.providers.find((p) => p.id === r.id)?.cloud })).flatMap((r) => r.models);
      const replacement = recommendModel(local);
      void vscode.window
        .showWarningMessage(
          replacement ? `Default model "${missing}" is not available right now; LocalPilot will use ${replacement.split('/').pop()} meanwhile.` : `Default model "${missing}" is not available right now.`,
          ...(replacement ? ['Make it the default'] : []),
          "Don't ask again"
        )
        .then(async (pick) => {
          if (pick === 'Make it the default' && replacement) {
            await setDefaultModel(replacement);
          } else if (pick === "Don't ask again") {
            await context.globalState.update(DEFAULT_HINT_KEY, [...quietDefaults, missing].slice(-50));
          }
        });
    }
    if (report.added.length) {
      await providers.listModels(true);
      await controller.handle({ type: 'refreshModels' });
      void refreshStatus();
    }
  };
  const detection = autoDetect();
  void detection.then(() => tuner.start());
  // Inline completions: load the completion model up front, otherwise the first suggestions pay the weight load
  // (and the next keystroke usually aborts them). Throttled per model in the registry.
  const warmCompletion = () => {
    const cfg = getConfig();
    if (cfg.inlineCompletion.enabled && cfg.prewarm) {
      void providers.warm(undefined, 'completion', undefined, false).catch(() => undefined);
    }
  };
  void detection.then(warmCompletion);
  context.subscriptions.push(vscode.window.onDidChangeWindowState((s) => s.focused && warmCompletion()));

  // Once ever, when the first run already finds a model: say which one answers and offer the walkthrough.
  const READY_SHOWN_KEY = 'localpilot.readyShown';
  const offerTour = async () => {
    if (context.globalState.get(READY_SHOWN_KEY)) {
      return;
    }
    await context.globalState.update(READY_SHOWN_KEY, true);
    const routed = await providers.route({ start: false }).catch(() => undefined);
    const model = (routed?.model.id ?? getConfig().defaultModel ?? 'a local model').split('/').pop();
    const pkg = context.extension.packageJSON as { publisher?: string; name?: string };
    const pick = await vscode.window.showInformationMessage(`LocalPilot is ready with ${model}.`, 'Open chat', 'Take the tour');
    if (pick === 'Open chat') {
      void vscode.commands.executeCommand('localpilot.openChat');
    } else if (pick === 'Take the tour') {
      void vscode.commands.executeCommand('workbench.action.openWalkthrough', `${pkg.publisher ?? 'localpilot'}.${pkg.name ?? 'localpilot-agent'}#localpilot.gettingStarted`, false);
    }
  };
  // First run: open the setup screen when nothing has been configured yet and no local model server is reachable.
  if (!context.globalState.get(WELCOMED_KEY) && getConfig().showWelcomeOnStartup) {
    void detection.then(() => providers.listModels().catch(() => [])).then((models) => {
      if (settingsPanel.isOpen) {
        return; // the user already opened Settings themselves — don't hijack the panel
      }
      if (!models.length) {
        settingsPanel.show('setup');
      } else {
        void context.globalState.update(WELCOMED_KEY, true);
        void offerTour();
      }
    });
  } else {
    // Returning user with no model anywhere (server stopped, models deleted): offer the one-click fix once per session.
    void detection.then(() => providers.listModels().catch(() => [])).then((models) => {
      if (!models.length && getConfig().supervisor.autoInstall) {
        // Opted in: install Ollama and a starter model in the background, with a cancellable progress notification.
        log.info('supervisor: no local models found — installing Ollama and a starter model (localpilot.supervisor.autoInstall)');
        void vscode.commands.executeCommand('localpilot.autoSetupModels', { installRuntime: true });
      } else if (!models.length && getConfig().autoSetupModels && !settingsPanel.isOpen) {
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
      token.onCancellationRequested(() => modelManager.activeJobs.filter((j) => j.kind === 'setup').forEach((j) => modelManager.cancel(j.id)));
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

  cmd(REBUILD_INDEX_COMMAND, async () => {
    if (!vscode.workspace.workspaceFolders?.length) {
      void vscode.window.showInformationMessage('LocalPilot: open a folder first; there are no files to index.');
      return;
    }
    await controller.rebuildFileIndex();
    const st = controller.indexStatus;
    if (st) {
      void vscode.window.setStatusBarMessage(`LocalPilot: ${st.files > st.listed ? `listed ${st.listed.toLocaleString()} of ${st.files.toLocaleString()}${st.capped ? '+' : ''} files for @ mentions` : `indexed ${st.files.toLocaleString()} files`}`, 4000);
    }
  });
  // A second argument `{ key?, expand? }` deep-links to one setting (scrolled to and highlighted) or opens a provider card.
  cmd('localpilot.openSettings', (section?: unknown, focus?: unknown) => {
    const f = focus && typeof focus === 'object' ? (focus as { key?: unknown; expand?: unknown }) : {};
    settingsPanel.show('settings', typeof section === 'string' ? (section as SettingsSection) : undefined, { key: typeof f.key === 'string' ? f.key : undefined, expand: typeof f.expand === 'string' ? f.expand : undefined });
  });
  cmd('localpilot.openMarkdownViewer', async (arg?: unknown) => {
    // Explorer / editor-title pass a Uri; the palette uses the active editor, then a Markdown file on screen (the
    // Settings page has the focus when its button runs this), then asks for a file.
    const uri =
      arg instanceof vscode.Uri
        ? arg
        : (vscode.window.activeTextEditor?.document.uri ??
          vscode.window.visibleTextEditors.find((e) => e.document.languageId === 'markdown')?.document.uri ??
          (await vscode.window.showOpenDialog({ canSelectMany: false, openLabel: 'Open in Markdown Reader', filters: { Markdown: ['md', 'markdown', 'mdx'] }, defaultUri: vscode.workspace.workspaceFolders?.[0]?.uri }))?.[0]);
    if (!uri) {
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
        { label: '$(repo) Project memory', description: `${plural(notes.filter((n) => n.scope === 'project').length, 'note')} in .localpilot/memory/`, scope: 'project' as const },
        { label: '$(globe) Global memory', description: `${plural(notes.filter((n) => n.scope === 'global').length, 'note')} shared across workspaces`, scope: 'global' as const },
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
    const ok = await vscode.window.showWarningMessage(`Delete ${plural(targets.length, `${pick.scope} memory note`)}? This cannot be undone.`, { modal: true }, 'Delete');
    if (ok) {
      let n = 0;
      for (const t of targets) {
        if (await memory.delete(t.name, pick.scope)) {
          n++;
        }
      }
      vscode.window.setStatusBarMessage(`LocalPilot: deleted ${plural(n, 'memory note')}`, 3000);
    }
  });

  cmd('localpilot.openChat', () => view.reveal());
  cmd('localpilot.openChatInEditor', async (arg?: unknown) => {
    // From an Agents-view row: open that chat, not the one on screen.
    const id = (arg as { session?: { id: string } } | undefined)?.session?.id;
    if (id) {
      await controller.handle({ type: 'selectSession', id });
    }
    view.openInEditor();
  });
  cmd('localpilot.moveChat', () => view.pickLocation());
  // The views switch containers through their `when` clauses; a settings change (from Move Chat To…, the Settings
  // UI or settings.json) only needs the chat revealed in its new home — a container is hidden until something focuses it.
  const LOCATION_APPLIED = 'localpilot.chat.locationApplied';
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration('localpilot.chat.location')) {
      void context.globalState.update(LOCATION_APPLIED, getChatLocation());
      void view.applyLocation(getChatLocation());
    }
  }));
  // The setting is applied once per value: VS Code itself remembers where the views were dragged afterwards, and
  // re-applying on every start would yank a view the user moved by hand back to the setting's container.
  if (getChatLocation() !== 'editor' && context.globalState.get<string>(LOCATION_APPLIED) !== getChatLocation()) {
    void context.globalState.update(LOCATION_APPLIED, getChatLocation());
    if (getChatLocation() !== 'sidebar') {
      setTimeout(() => void view.applyLocation(getChatLocation()), 1500);
    }
  }
  // Copilot-style status bar menu: one click reaches the chat, model, layout and settings.
  cmd('localpilot.statusMenu', async () => {
    const cfg = getConfig();
    const where = CHAT_LOCATIONS.find((l) => l.id === getChatLocation());
    const modelName = statusModel?.split('/').pop();
    const items: (vscode.QuickPickItem & { run?: () => unknown })[] = [
      ...(statusModels === 0
        ? [
            { label: '$(rocket) Set Up Models Automatically', description: 'installs Ollama and a starter model', run: () => vscode.commands.executeCommand('localpilot.autoSetupModels') },
            { label: '$(refresh) Check for model servers again', run: () => vscode.commands.executeCommand('localpilot.refreshModels') },
            { label: '$(gear) Open Setup', run: () => vscode.commands.executeCommand('localpilot.openWelcome') },
            { label: '', kind: vscode.QuickPickItemKind.Separator },
          ]
        : []),
      { label: '$(localpilot-logo) Open Chat', description: where ? `in the ${where.label}` : undefined, run: () => view.reveal() },
      { label: '$(add) New Chat', run: () => vscode.commands.executeCommand('localpilot.newSession') },
      { label: '$(run-all) Run Tasks in Parallel…', run: () => vscode.commands.executeCommand('localpilot.runParallelTasks') },
      { label: '', kind: vscode.QuickPickItemKind.Separator },
      { label: '$(server) Select Default Model…', description: modelName ? `${modelName}${statusModel === cfg.defaultModel ? ' (default)' : ''}` : statusModels === 0 ? 'no model' : 'auto', run: () => vscode.commands.executeCommand('localpilot.selectModel') },
      { label: '$(library) Manage Models', run: () => vscode.commands.executeCommand('localpilot.manageModels') },
      { label: '$(search) Browse Ollama Model Gallery…', run: () => vscode.commands.executeCommand('localpilot.browseModelGallery') },
      { label: '$(book) Manage Skills', run: () => vscode.commands.executeCommand('localpilot.manageSkills') },
      { label: `$(${cfg.autoMode.enabled ? 'check' : 'circle-large-outline'}) Auto Mode`, description: cfg.autoMode.enabled ? 'on — safe actions approved by a local reviewer' : 'off', run: () => vscode.commands.executeCommand('localpilot.toggleAutoMode') },
      { label: '$(list-ordered) Queue Agent Task…', description: taskQueue.list.length ? `${taskQueue.activeCount} running, ${taskQueue.pendingCount} waiting` : undefined, run: () => vscode.commands.executeCommand('localpilot.queue.add') },
      { label: `$(${cfg.inlineCompletion.enabled ? 'check' : 'circle-large-outline'}) Inline Completions`, description: cfg.inlineCompletion.enabled ? 'on' : 'off', run: () => vscode.commands.executeCommand('localpilot.toggleInlineCompletions') },
      { label: 'Tools', kind: vscode.QuickPickItemKind.Separator },
      { label: '$(extensions) Plugins…', run: () => vscode.commands.executeCommand('localpilot.browsePlugins') },
      { label: '$(plug) MCP Servers…', run: () => vscode.commands.executeCommand('localpilot.openSettings', 'mcp') },
      { label: '$(server-process) Background Services', run: () => vscode.commands.executeCommand('localpilot.showBackgroundServices') },
      { label: '', kind: vscode.QuickPickItemKind.Separator },
      { label: '$(layout) Move Chat To…', description: where?.label, run: () => view.pickLocation() },
      { label: '$(settings-gear) Settings', run: () => vscode.commands.executeCommand('localpilot.openSettings') },
      { label: '$(dashboard) Dashboard', description: 'usage, latency, provider health, logs', run: () => vscode.commands.executeCommand('localpilot.openDashboard') },
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
  const sessionAction = async (s: Session, action: string): Promise<void> => {
    const changed = tracker.forSession(s.id).length;
    switch (action) {
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
        if ((await vscode.window.showWarningMessage(`Undo all ${changed} changes of "${s.title}"?`, { modal: true }, 'Undo all')) === 'Undo all') {
          return controller.handle({ type: 'undoChanges', sessionId: s.id });
        }
        return;
      case 'clear':
        return controller.handle({ type: 'clearSession', sessionId: s.id });
      case 'delete':
        if ((await vscode.window.showWarningMessage(`Delete "${s.title}"?`, { modal: true, detail: s.worktree ? 'Its isolated worktree and any changes not applied to the workspace are deleted too.' : 'This cannot be undone.' }, 'Delete')) === 'Delete') {
          return controller.handle({ type: 'deleteSession', id: s.id });
        }
        return;
    }
  };
  cmd('localpilot.sessionMenu', async (arg?: unknown) => {
    // From the Agents view the argument is the row's tree node: act on that chat, not the one on screen.
    const node = arg as { sessionId?: string; session?: { id: string } } | undefined;
    const id = typeof arg === 'string' ? arg : node?.session?.id ?? node?.sessionId;
    const s = id ? controller.store.get(id) : controller.activeSession;
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
    if (pick) {
      await sessionAction(s, pick.action);
    }
  });
  // Rename / pin / fork / export / delete straight from an Agents-view row's context menu.
  for (const action of ['rename', 'pin', 'fork', 'export', 'delete'] as const) {
    cmd(`localpilot.${action}Session`, async (arg?: unknown) => {
      const node = arg as { sessionId?: string; session?: { id: string } } | undefined;
      const id = typeof arg === 'string' ? arg : node?.session?.id ?? node?.sessionId;
      const s = id ? controller.store.get(id) : controller.activeSession;
      if (s) {
        await sessionAction(s, action);
      }
    });
  }
  // Session argument: id (palette / API) or an Agents-view node.
  const worktreeSession = (arg: unknown): string | undefined => {
    if (typeof arg === 'string') {
      return arg;
    }
    const n = arg as { sessionId?: string; session?: { id: string } } | undefined;
    return n?.sessionId ?? n?.session?.id ?? controller.activeSession?.id;
  };
  cmd('localpilot.applyWorktree', async (arg?: unknown) => {
    const id = worktreeSession(arg);
    if (!id) {
      return;
    }
    const s = store.get(id);
    if (!s?.worktree) {
      void vscode.window.showInformationMessage(`"${s?.title ?? 'This chat'}" has no isolated worktree, so its changes are already in the workspace.`);
      return;
    }
    if (controller.runningSessionIds.includes(id) && !controller.isPaused(id)) {
      if ((await vscode.window.showInformationMessage('Pause or stop the agent before applying its changes.', 'Pause')) === 'Pause') {
        controller.pause(id);
      }
      return;
    }
    const res = await controller.applyWorktree(id);
    if (res?.conflicts.length) {
      const open = await vscode.window.showWarningMessage(`${res.conflicts.length === 1 ? '1 file has' : `${res.conflicts.length} files have`} conflict markers.`, 'Open first conflict');
      // Conflict paths are relative to the repository, which may be above the workspace folder.
      const repo = store.get(id)?.worktree?.repo ?? workspace.root;
      if (open && repo) {
        await vscode.window.showTextDocument(vscode.Uri.file(path.join(repo, res.conflicts[0])));
      }
    }
  });
  cmd('localpilot.discardWorktree', async (arg?: unknown) => {
    const id = worktreeSession(arg);
    const s = id ? store.get(id) : undefined;
    if (!s?.worktree) {
      void vscode.window.showInformationMessage(`"${s?.title ?? 'This chat'}" has no isolated worktree to discard.`);
      return;
    }
    const n = (await worktrees.changes(s.worktree).catch(() => [])).length;
    const ok = !n || (await vscode.window.showWarningMessage(`Discard the agent's ${n} unapplied file change${n === 1 ? '' : 's'}?`, { modal: true }, 'Discard')) === 'Discard';
    if (ok) {
      await controller.discardWorktree(s.id);
    }
  });
  cmd('localpilot.openWorktree', (arg?: unknown) => {
    const id = worktreeSession(arg);
    const s = id ? store.get(id) : undefined;
    if (s?.worktree) {
      void vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(s.worktree.path), { forceNewWindow: true });
    }
  });
  cmd('localpilot.runBestOfN', async (preset?: unknown) => {
    const prompt = typeof preset === 'string' && preset.trim() ? preset : await vscode.window.showInputBox({ title: 'Best of N: one task, several models', prompt: 'The same task runs on every model you pick, each in its own isolated worktree. Compare the results and apply the best.', placeHolder: 'Refactor the payment module to use the new API client', ignoreFocusOut: true });
    if (!prompt?.trim()) {
      return;
    }
    const models = await providers.listModels().catch(() => []);
    const picks = await vscode.window.showQuickPick(
      models.filter((m) => m.supportsTools).map((m) => ({ label: m.name, description: m.providerId, detail: `${Math.round(m.contextWindow / 1024)}k context${m.parameterSize ? ` · ${m.parameterSize}` : ''}`, id: m.id })),
      { title: 'Which models should attempt it? (up to 8)', canPickMany: true, placeHolder: 'Pick two or more models', ignoreFocusOut: true }
    );
    if (!picks?.length) {
      return;
    }
    view.reveal();
    await controller.runBestOfN(prompt.trim(), picks.slice(0, 8).map((p) => p.id));
  });
  cmd('localpilot.compareResults', async (groupArg?: unknown) => {
    const groups = new Map<string, { prompt: string; size: number; kind: 'bestOf' | 'batch' }>();
    for (const s of store.list()) {
      if (s.group) {
        groups.set(s.group.id, { prompt: s.group.prompt, size: s.group.size, kind: s.group.kind });
      }
    }
    let groupId = typeof groupArg === 'string' ? groupArg : controller.activeSession?.group?.id;
    if (!groupId || !groups.has(groupId)) {
      const pick = await vscode.window.showQuickPick([...groups].map(([id, g]) => ({ label: g.prompt.slice(0, 80), description: `${g.size} agents · ${g.kind === 'bestOf' ? 'same task' : 'split tasks'}`, id })), { title: 'Review parallel agents', placeHolder: groups.size ? 'Which batch?' : 'No batches yet — start agents with Run Tasks in Parallel or Best of N first' });
      groupId = pick?.id;
    }
    if (!groupId) {
      return;
    }
    const sessions = controller.groupSessions(groupId);
    const items = await Promise.all(
      sessions.map(async (s) => {
        const changes = s.worktree ? await worktrees.changes(s.worktree).catch(() => []) : [];
        const added = changes.reduce((n, c) => n + c.added, 0);
        const removed = changes.reduce((n, c) => n + c.removed, 0);
        const last = [...s.messages].reverse().find((m) => m.role === 'assistant' && m.content.trim())?.content.replace(/\s+/g, ' ').trim() ?? '';
        const running = controller.isRunning(s.id);
        const kind = groups.get(groupId!)?.kind ?? 'bestOf';
        return {
          label: `$(${running ? 'loading~spin' : s.worktree?.appliedAt ? 'check' : 'git-compare'}) ${kind === 'bestOf' ? (s.model.split('/').pop() ?? s.model) : s.title}`,
          description: running ? 'still running' : `${changes.length} file${changes.length === 1 ? '' : 's'} · +${added} −${removed}${s.worktree?.appliedAt ? ' · applied' : ''}`,
          detail: last.slice(0, 160) || '(no answer yet)',
          session: s,
        };
      })
    );
    const g = groups.get(groupId)!;
    const pick = await vscode.window.showQuickPick(items, { title: g.kind === 'bestOf' ? `Best of ${sessions.length}: ${g.prompt.slice(0, 60)}` : `${sessions.length} agents: ${g.prompt.slice(0, 60)}`, placeHolder: g.kind === 'bestOf' ? 'Pick the result you like; you can apply it right away' : 'Pick an agent to review its changes; apply the ones you like', matchOnDescription: true, matchOnDetail: true });
    if (pick) {
      await controller.handle({ type: 'selectSession', id: pick.session.id });
      view.reveal();
      const action = await vscode.window.showInformationMessage(`${pick.label.replace(/^\$\([^)]*\)\s*/, '')}: ${pick.description}`, ...(g.kind === 'bestOf' ? ['Apply this result', 'Apply and discard the others'] : ['Apply this result']));
      if (action) {
        const res = await controller.applyWorktree(pick.session.id);
        if (action === 'Apply and discard the others') {
          if (!res) {
            void vscode.window.showWarningMessage('Apply failed — the other results were kept.');
            return;
          }
          if (res.conflicts.length && (await vscode.window.showWarningMessage(`Applied with conflicts in ${res.conflicts.length} file${res.conflicts.length === 1 ? '' : 's'}. Discard the other results anyway?`, { modal: true }, 'Discard')) !== 'Discard') {
            return;
          }
          for (const s of sessions) {
            if (s.id !== pick.session.id) {
              await controller.discardWorktree(s.id);
            }
          }
        }
      }
    }
  });
  cmd('localpilot.runParallelTasks', async () => {
    // The chat UI has the friendly launcher (task ideas, model picker); the input box is the fallback without it.
    view.reveal();
    if (controller.openLauncher('tasks')) {
      return;
    }
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
    void vscode.commands.executeCommand(`${AGENTS_VIEW_ID}.focus`);
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
  // Session commands take a session id (palette / API) or the Agents-view node they were invoked on.
  const sessionIdArg = (arg: unknown): string | undefined => {
    if (typeof arg === 'string') {
      return arg;
    }
    const n = arg as { sessionId?: string; session?: { id: string } } | undefined;
    return n?.sessionId ?? n?.session?.id ?? controller.activeSession?.id;
  };
  const childArg = (arg: unknown): { sessionId: string; childId: string } | undefined => {
    const n = arg as { sessionId?: string; childId?: string } | undefined;
    return n?.sessionId && n?.childId ? { sessionId: n.sessionId, childId: n.childId } : undefined;
  };
  // --- Task queue ----------------------------------------------------------------------------
  const queueTaskArg = (arg: unknown): string | undefined => (typeof arg === 'string' ? arg : (arg as { task?: { id: string } } | undefined)?.task?.id);
  cmd('localpilot.queue.add', async () => {
    const prompt = await vscode.window.showInputBox({
      title: 'Queue an agent task (1/3)',
      prompt: 'What should the agent do? Queued tasks run in order, each as its own chat. Separate several tasks with " | ".',
      placeHolder: 'Write tests for utils/date.ts | Fix all TypeScript errors in src/api',
      ignoreFocusOut: true,
    });
    const prompts = (prompt ?? '').split('|').map((t) => t.trim()).filter(Boolean);
    if (!prompts.length) {
      return;
    }
    const modes = [
      { label: 'Agent', description: 'edit files and run commands', mode: 'agent' as const },
      { label: 'Debug', description: 'reproduce, fix and verify', mode: 'debug' as const },
      { label: 'Plan', description: 'read-only plan', mode: 'plan' as const },
      { label: 'Ask', description: 'read-only answer', mode: 'ask' as const },
      { label: 'Multitask', description: 'split across parallel workers', mode: 'multitask' as const },
    ];
    const mode = await vscode.window.showQuickPick(modes, { title: 'Queue an agent task (2/3): mode', ignoreFocusOut: true });
    if (!mode) {
      return;
    }
    const models = await providers.listModels().catch(() => []);
    const model = await vscode.window.showQuickPick(
      [{ label: '$(sparkle) Auto', description: 'the router picks per task', id: '' }, ...models.map((m) => ({ label: m.name, description: m.providerId, id: m.id }))],
      { title: 'Queue an agent task (3/3): model', ignoreFocusOut: true, matchOnDescription: true }
    );
    if (!model) {
      return;
    }
    // Dependencies: chain the new tasks after each other, and optionally after tasks already waiting.
    const open = taskQueue.list.filter((t) => t.status === 'queued' || t.status === 'running');
    let after: string[] = [];
    if (open.length) {
      const picks = await vscode.window.showQuickPick(
        open.map((t) => ({ label: t.prompt.slice(0, 80), description: t.status, id: t.id })),
        { title: 'Start only after these tasks succeed (optional)', canPickMany: true, ignoreFocusOut: true, placeHolder: 'Press Enter with nothing selected to run as soon as a slot is free' }
      );
      if (!picks) {
        return;
      }
      after = picks.map((p) => p.id);
    }
    for (const p of prompts) {
      taskQueue.add({ prompt: p, mode: mode.mode, model: model.id, dependsOn: after });
    }
    void vscode.commands.executeCommand(`${AGENTS_VIEW_ID}.focus`);
    if (taskQueue.paused) {
      void vscode.window.showInformationMessage('Task queued. The queue is paused — resume it to start.', 'Resume').then((r) => r && taskQueue.setPaused(false));
    }
  });
  cmd('localpilot.toggleAutoMode', async () => {
    await vscode.workspace.getConfiguration('localpilot').update('autoMode.enabled', !getConfig().autoMode.enabled, configTarget('autoMode.enabled'));
    void vscode.window.showInformationMessage(
      getConfig().autoMode.enabled
        ? 'Auto mode on: a local reviewer model approves safe actions; risky ones (pushes, sudo, rm -rf, secrets…) still ask you.'
        : 'Auto mode off: actions set to "ask" prompt you again.'
    );
  });
  cmd('localpilot.showBackgroundServices', async () => {
    await supervisor.tick();
    const items = supervisor.status.map((st) => ({
      label: `$(${st.up ? 'pass-filled' : st.gaveUp ? 'error' : st.wanted ? 'sync~spin' : 'circle-large-outline'}) ${st.label}`,
      description: st.up ? 'running' : st.gaveUp ? 'stopped — gave up restarting' : st.wanted ? `down — restarting (attempt ${st.failures + 1})` : 'not supervised',
      detail: `${st.restarts ? `restarted ${st.restarts}× this session · ` : ''}${st.lastError ?? (st.wanted || st.up ? 'kept running while VS Code is open' : st.id === 'redis' ? 'turn on localpilot.storage.redis.enabled to supervise it' : 'supervised once it has run this session or serves the default model')}`,
      id: st.id,
    }));
    const pick = await vscode.window.showQuickPick(items, { title: 'LocalPilot: background services', placeHolder: getConfig().supervisor.enabled ? 'Pick a service to retry it now' : 'Supervision is off (localpilot.supervisor.enabled)' });
    if (pick) {
      void supervisor.retry(pick.id);
    }
  });
  cmd('localpilot.queue.pause', () => taskQueue.setPaused(true));
  cmd('localpilot.queue.resume', () => taskQueue.setPaused(false));
  cmd('localpilot.queue.cancel', (arg?: unknown) => {
    const t = taskQueue.cancel(queueTaskArg(arg) ?? '');
    if (t?.sessionId) {
      controller.stop(t.sessionId);
    }
  });
  cmd('localpilot.queue.retry', (arg?: unknown) => taskQueue.retry(queueTaskArg(arg) ?? ''));
  cmd('localpilot.queue.remove', (arg?: unknown) => taskQueue.remove(queueTaskArg(arg) ?? ''));
  cmd('localpilot.queue.clearFinished', () => taskQueue.clearFinished());
  cmd('localpilot.stopSession', (arg?: unknown) => controller.stop(sessionIdArg(arg) ?? ''));
  cmd('localpilot.stopAll', () => {
    // Pause first so stopping a queued task's chat does not let the queue start the next one.
    const hadQueued = !taskQueue.paused && taskQueue.pendingCount > 0;
    taskQueue.setPaused(true);
    const ids = controller.runningSessionIds;
    ids.forEach((id) => controller.stop(id));
    if (ids.length) {
      vscode.window.setStatusBarMessage(`LocalPilot: stopped ${plural(ids.length, 'agent')}`, 2500);
    }
    if (hadQueued) {
      void vscode.window.showInformationMessage('Queue paused — Resume Queue to continue.', 'Resume Queue').then((r) => r && taskQueue.setPaused(false));
    }
  });
  cmd('localpilot.pauseSession', (arg?: unknown) => controller.pause(sessionIdArg(arg) ?? ''));
  cmd('localpilot.resumeSession', (arg?: unknown) => controller.resume(sessionIdArg(arg) ?? ''));
  cmd('localpilot.togglePause', (arg?: unknown) => {
    const id = sessionIdArg(arg) ?? '';
    const paused = controller.togglePause(id);
    if (paused === undefined) {
      void vscode.window.showInformationMessage('No agent is running in the current chat.');
    }
  });
  cmd('localpilot.pauseAll', () => {
    const ids = controller.runningSessionIds.filter((id) => !controller.isPaused(id));
    ids.forEach((id) => controller.pause(id));
    vscode.window.setStatusBarMessage(ids.length ? `LocalPilot: paused ${plural(ids.length, 'agent')}` : 'LocalPilot: no running agents to pause', 2500);
  });
  cmd('localpilot.resumeAll', () => {
    const ids = controller.pausedSessionIds;
    ids.forEach((id) => controller.resume(id));
    vscode.window.setStatusBarMessage(ids.length ? `LocalPilot: resumed ${plural(ids.length, 'agent')}` : 'LocalPilot: no paused agents to resume', 2500);
  });
  cmd('localpilot.pauseChild', (arg?: unknown) => { const c = childArg(arg); if (c) { void controller.handle({ type: 'pauseChild', ...c }); } });
  cmd('localpilot.resumeChild', (arg?: unknown) => { const c = childArg(arg); if (c) { void controller.handle({ type: 'resumeChild', ...c }); } });
  cmd('localpilot.stopChild', (arg?: unknown) => { const c = childArg(arg); if (c) { void controller.handle({ type: 'stopChild', ...c }); } });
  cmd('localpilot.showDiff', (sessionId: unknown, fsPath: unknown) => {
    // Agents-view context menu passes the file node instead of (sessionId, fsPath).
    const n = sessionId as { sessionId?: string; fsPath?: string } | undefined;
    const [sid, file] = typeof sessionId === 'string' ? [sessionId, fsPath] : [n?.sessionId, n?.fsPath];
    return typeof sid === 'string' && typeof file === 'string' && tracker.showDiff(sid, file);
  });
  cmd('localpilot.openChangedFile', (node?: unknown) => {
    const fsPath = (node as { fsPath?: string } | undefined)?.fsPath;
    if (fsPath) {
      void vscode.commands.executeCommand('vscode.open', vscode.Uri.file(fsPath));
    }
  });
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
      vscode.window.setStatusBarMessage(`LocalPilot: rejected ${plural(count, 'file')}`, 2500);
    }
  });
  // File-by-file review in the diff editor (title bar actions while localpilot.reviewing): decide, then move on.
  cmd('localpilot.review.acceptFile', () => controller.reviewInEditor('accept'));
  cmd('localpilot.review.rejectFile', () => controller.reviewInEditor('reject'));
  cmd('localpilot.review.nextFile', () => controller.reviewInEditor('next'));
  cmd('localpilot.review.prevFile', () => controller.reviewInEditor('prev'));
  cmd('localpilot.keepAllChanges', () => tracker.all().forEach((c) => tracker.keep(c.sessionId)));
  cmd('localpilot.undoAllChanges', async () => {
    const ok = await vscode.window.showWarningMessage(`Revert ${tracker.count === 1 ? 'the file' : `all ${tracker.count} files`} changed by agents?`, { modal: true }, 'Revert');
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
  cmd('localpilot.browseModelGallery', () => settingsPanel.show('settings', 'gallery'));
  cmd('localpilot.manageSkills', () => settingsPanel.show('settings', 'skills'));
  cmd('localpilot.openDashboard', () => settingsPanel.show('settings', 'dashboard'));
  cmd('localpilot.setupRedis', () => setupRedis(log));
  cmd('localpilot.telemetry.testOtlp', async () => {
    const r = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'LocalPilot: sending a test record to the OTLP endpoint…' }, () => otlp.test());
    const where = `${r.url}${otlp.offBecause ? ` (export is off: ${otlp.offBecause})` : ''}`;
    if (r.error === undefined) {
      log.info(`OTLP test: HTTP ${r.status} from ${r.url}`);
      void vscode.window.showInformationMessage(`OTLP collector answered HTTP ${r.status} — ${where}`);
    } else {
      log.warn(`OTLP test to ${r.url} failed: ${r.error}`);
      void vscode.window.showErrorMessage(`OTLP test failed: ${r.error} — ${where}`, 'Open Settings').then((a) => a && settingsPanel.show('settings', 'telemetry'));
    }
  });
  cmd('localpilot.tuneModels', () => tuner.runCommand());
  // colibri: install, configure and start through its own `coli setup`; reuse a server that already runs.
  const colibri = new ColibriLauncher({
    log,
    onReady: async (port) => {
      await autoDetect();
      await providers.listModels(true);
      await controller.handle({ type: 'refreshModels' });
      void refreshStatus();
      return (await providers.listModels()).filter((m) => m.runtime === 'colibri' && m.providerId && new RegExp(`:${port}(/|$)`).test(providers.get(m.providerId)?.baseUrl ?? '')).map((m) => m.name);
    },
  });
  context.subscriptions.push(colibri);
  cmd('localpilot.startColibri', () => colibri.start());
  // Gateways (OmniRoute, LiteLLM): install if needed, start on 127.0.0.1, register as a cloud provider.
  const gateways = new GatewayLauncher({
    log,
    onReady: async () => {
      await providers.listModels(true).catch(() => []);
      await controller.handle({ type: 'refreshModels' });
      void refreshStatus();
    },
  });
  context.subscriptions.push(gateways);
  cmd('localpilot.startGateway', (id?: unknown) => gateways.start(id === 'omniroute' || id === 'litellm' ? id : undefined));
  cmd('localpilot.stopGateway', (id?: unknown) => gateways.stop(id === 'omniroute' || id === 'litellm' ? id : undefined));
  cmd('localpilot.stopColibri', () => colibri.stop());
  cmd('localpilot.enableOllamaParallel', async () => {
    const slots = ModelManager.ollamaParallelSlots();
    const job = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Restarting Ollama with ${slots} parallel request slots…` }, () => modelManager.restartOllamaWithParallelSlots());
    if (job.status === 'done') {
      runner.clearServedSerially();
      void vscode.window.showInformationMessage(`Ollama now serves up to ${slots} requests at once, so parallel subagents run concurrently. Lower localpilot.parallel.maxConcurrency if memory gets tight.`);
    } else if (job.status === 'error') {
      void vscode.window.showWarningMessage(job.error ?? 'Could not restart Ollama.', 'Open docs').then((p) => p && vscode.env.openExternal(vscode.Uri.parse('https://isathish.github.io/localpilot/docs/parallel-agents/#parallel-requests')));
    }
    return job;
  });
  // The runner noticed concurrent requests queuing at the server (Ollama's default is one slot per model).
  runner.onSerialServer = (model) => {
    const SERIAL_HINT_KEY = 'localpilot.serialHintDismissed';
    const quiet = context.globalState.get<string[]>(SERIAL_HINT_KEY, []);
    if (quiet.includes(model.id)) {
      return;
    }
    const provider = getConfig().providers.find((p) => p.id === model.providerId);
    const isOllama = provider?.type === 'ollama';
    const msg = `${model.name} is answering one request at a time. LocalPilot now spreads extra workers to comparable idle models that fit in memory alongside; for several workers on ${model.name} itself,${isOllama ? ` it can restart Ollama with ${ModelManager.ollamaParallelSlots()} parallel slots.` : ' enable parallel requests on the server (e.g. OLLAMA_NUM_PARALLEL, or more replicas).'}`;
    void vscode.window.showWarningMessage(msg, ...(isOllama ? ['Restart Ollama with parallel slots'] : []), 'Learn more', "Don't ask again").then(async (p) => {
      if (p === 'Restart Ollama with parallel slots') {
        void vscode.commands.executeCommand('localpilot.enableOllamaParallel');
      } else if (p === 'Learn more') {
        void vscode.env.openExternal(vscode.Uri.parse('https://isathish.github.io/localpilot/docs/parallel-agents/#parallel-requests'));
      } else if (p === "Don't ask again") {
        await context.globalState.update(SERIAL_HINT_KEY, [...quiet, model.id].slice(-50));
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
        if (r.started) {
          void vscode.window.showInformationMessage(`Started Ollama: ${plural(r.models, 'local model')} ready.`, 'Open chat').then((p) => p && view.reveal());
          return r;
        }
        void vscode.window.showInformationMessage(`LocalPilot already has ${plural(r.models, 'local model')}. Install more from the catalog in Settings → Models.`, 'Open Models').then((p) => p && settingsPanel.show('settings', 'models'));
        return r;
      case 'installed':
        void vscode.window.showInformationMessage(`LocalPilot is ready: ${r.agent.split('/').pop()} is the default model${r.completion ? `, ${r.completion.split('/').pop()} handles inline completions` : ''}${r.vision ? `, ${r.vision.split('/').pop()} handles images` : ''}.`, 'Open chat').then((p) => p && view.reveal());
        void context.globalState.update(WELCOMED_KEY, true);
        return r;
      case 'needs-runtime': {
        // Nothing to run models on: install Ollama in the background (user-space, no sudo/UAC) and continue with the
        // starter download — the whole thing is one click. The progress notification has Cancel.
        if (o.installRuntime === false) {
          void vscode.window.showWarningMessage('No model runtime is installed or running.', 'Install Ollama', 'Open Providers').then((p) => {
            if (p === 'Install Ollama') {
              void vscode.commands.executeCommand('localpilot.autoSetupModels', { ...o, installRuntime: true });
            } else if (p === 'Open Providers') {
              settingsPanel.show('settings', 'providers');
            }
          });
          return r;
        }
        if (o.installRuntime === undefined && r.runtimes.find((rt) => rt.target === 'ollama')?.installed === false) {
          vscode.window.setStatusBarMessage(`LocalPilot: installing Ollama and ${plan.agent.entry.name} ${plan.agent.variant.tag} (${plan.agent.variant.gb} GB) for this ${profile.ramGb} GB machine…`, 6000);
          return vscode.commands.executeCommand('localpilot.autoSetupModels', { ...o, installRuntime: true });
        }
        void vscode.window.showErrorMessage('Model setup could not find or start a model runtime.', 'Show logs', 'Open Models').then((p) => (p === 'Show logs' ? log.show() : p && settingsPanel.show('settings', 'models')));
        return r;
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
  cmd('localpilot.setProviderApiKey', async (providerId?: unknown) => {
    const cfg = vscode.workspace.getConfiguration('localpilot');
    const { list, target: scope } = editableProviders();
    let target = typeof providerId === 'string' ? list.find((p) => p.id === providerId) : undefined;
    if (!target) {
      const picked = await vscode.window.showQuickPick(
        list.map((p) => ({ label: p.displayName || p.id, description: p.baseUrl, detail: p.apiKey ? (secretRefs(p.apiKey).length ? 'key in secret storage' : /\$\{env:/.test(p.apiKey) ? `key from ${p.apiKey}` : 'key in settings.json') : 'no key', p })),
        { title: 'Set the API key of a provider' }
      );
      target = picked?.p;
    }
    if (!target) {
      return;
    }
    const key = await vscode.window.showInputBox({ title: `API key for ${target.displayName || target.id}`, prompt: 'Stored in VS Code secret storage (your OS keychain), not in settings.json. Leave empty to remove it.', password: true, ignoreFocusOut: true });
    if (key === undefined) {
      return;
    }
    const id = target.id;
    const before = secretRefs(target.apiKey);
    const ref = key.trim() ? (await providerSecrets.protect([{ ...target, apiKey: key.trim() }], scope === vscode.ConfigurationTarget.Global ? 'user' : 'workspace'))[0].apiKey : undefined;
    const next = list.map((p) => {
      if (p.id !== id) {
        return p;
      }
      const out = { ...p, apiKey: ref };
      if (!ref) {
        delete out.apiKey;
      }
      return out;
    });
    await cfg.update('providers', next, scope);
    await providerSecrets.prune(undefined, before);
    await providers.listModels(true).catch(() => []);
    vscode.window.setStatusBarMessage(`LocalPilot: API key for ${target.displayName || id} ${ref ? 'saved' : 'removed'}`, 2500);
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
    await cfg.update('inlineCompletion.enabled', !cur, configTarget('inlineCompletion.enabled'));
    vscode.window.setStatusBarMessage(`LocalPilot inline completions ${getConfig().inlineCompletion.enabled ? 'enabled' : 'disabled'}`, 2500);
  });
  cmd('localpilot.createSkill', async (suggestion?: unknown) => {
    const s = suggestion as { slug?: string; topic?: string; count?: number; samples?: string[] } | undefined;
    if (!s?.slug) {
      return;
    }
    view.reveal();
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
    let hidden = false;
    const picked = new Promise<Item[]>((resolve) => {
      qp.onDidAccept(() => resolve([...qp.selectedItems]));
      qp.onDidHide(() => {
        hidden = true;
        resolve([]);
      });
    });
    const render = async () => {
      const have = new Set(skills.allSkills.map((s) => s.name));
      const entries = await catalog.entries();
      const status = await catalog.status();
      const items: Item[] = [];
      for (const s of status) {
        const own = entries.filter((e) => e.repo === s.repo);
        items.push({ label: s.repo, kind: vscode.QuickPickItemKind.Separator, description: s.error ? `$(warning) ${s.error}` : `${own.length} skills` });
        for (const e of own) {
          items.push({ label: `${have.has(e.name) ? '$(check) ' : '$(book) '}${e.name}`, description: e.description.replace(/\s+/g, ' ').slice(0, 120), detail: have.has(e.name) ? 'Installed' : undefined, entry: e });
        }
      }
      if (!entries.length) {
        items.push({ label: status.some((s) => s.error) ? 'The catalog could not be fetched — check the repositories and your connection' : 'Indexing the skill repositories…', description: '', alwaysShow: true });
      }
      qp.items = items;
    };
    qp.onDidTriggerButton(async (b) => {
      if (b === settingsBtn) {
        void vscode.commands.executeCommand('workbench.action.openSettings', 'localpilot.skills.repositories');
        return;
      }
      qp.busy = true;
      await catalog.refresh(true).catch((e) => log.warn(`skill catalog: ${String(e)}`));
      if (!hidden) {
        await render();
        qp.busy = false;
      }
    });
    let chosen: Item[];
    try {
      qp.busy = true;
      qp.show();
      await render();
      if (hidden) {
        return undefined;
      }
      if (!(await catalog.ready())) {
        if (hidden) {
          return undefined;
        }
        await catalog.refresh();
        if (hidden) {
          return undefined;
        }
        await render();
      }
      qp.busy = false;
      chosen = await picked;
    } finally {
      qp.dispose();
    }
    const entries = chosen.flatMap((p) => (p.entry ? [p.entry] : []));
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
    await plugins.refresh();
    await skills.refresh();
    await mcp.reload();
    vscode.window.showInformationMessage(`LocalPilot: ${skills.allSkills.length} skills, ${skills.allAgents.length} subagents, ${mcp.status.reduce((n, s) => n + s.tools, 0)} MCP tools`);
  });
  cmd('localpilot.editMcpConfig', (kind?: unknown) => editMcpConfiguration(kind === 'user' || kind === 'project' || kind === 'settings' ? kind : undefined));
  cmd('localpilot.authenticateMcpServer', async (name?: unknown) => {
    const waiting = mcp.status.filter((s) => s.state === 'auth_required').map((s) => s.name);
    const target = typeof name === 'string' ? name : waiting.length === 1 ? waiting[0] : await vscode.window.showQuickPick(waiting, { title: 'Sign in to an MCP server', placeHolder: waiting.length ? 'Servers waiting for you to sign in' : 'No server is waiting for a sign-in' });
    if (!target) {
      return;
    }
    try {
      const ok = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Signing in to ${target} in your browser…`, cancellable: true }, (_p, token) => {
        const ctl = new AbortController();
        token.onCancellationRequested(() => ctl.abort());
        return mcp.authenticate(target, ctl.signal);
      });
      void vscode.window.showInformationMessage(ok ? `LocalPilot: signed in to ${target}.` : `LocalPilot: signed in to ${target}, but it did not start: ${mcp.status.find((s) => s.name === target)?.error ?? 'see the log'}`);
    } catch (e) {
      void vscode.window.showErrorMessage(`LocalPilot: signing in to ${target} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  });
  cmd('localpilot.showLogs', () => log.show());
  cmd('localpilot.installCli', () => installCli(context));
  // Plugins from marketplaces (Claude Code's format): browse, show what a plugin runs, install, then reload.
  cmd('localpilot.browsePlugins', async () => {
    const markets = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Loading plugin marketplaces…' }, async () => {
      const out: Marketplace[] = [];
      for (const spec of getConfig().pluginMarketplaces) {
        try {
          out.push(await loadMarketplace(spec, { refresh: true }));
        } catch (e) {
          log.warn(`plugins: marketplace ${spec}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      return out;
    });
    if (!markets.length) {
      void vscode.window.showWarningMessage('No plugin marketplace could be loaded. Check localpilot.plugins.marketplaces and that git is installed.');
      return;
    }
    const installed = new Set(plugins.all.map((p) => p.name));
    const pick = await vscode.window.showQuickPick(
      searchPlugins(markets, '').map(({ entry, market }) => ({ label: `${installed.has(entry.name) ? '$(check) ' : ''}${entry.name}`, description: [entry.category, entry.version, market.name].filter(Boolean).join(' · '), detail: entry.description, entry, market })),
      { title: `Plugins (${markets.map((m) => m.name).join(', ')})`, placeHolder: 'Search by name, category or description', matchOnDescription: true, matchOnDetail: true }
    );
    if (!pick) {
      return;
    }
    try {
      const r = await installMarketplacePlugin(pick.entry, pick.market);
      if (!r) {
        return;
      }
      await plugins.refresh();
      await vscode.commands.executeCommand('localpilot.reloadSkills');
      void vscode.window.showInformationMessage(`Installed ${describePlugin(r.plugin).summary}.`);
    } catch (e) {
      void vscode.window.showErrorMessage(`Could not install ${pick.entry.name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  });
  cmd('localpilot.managePlugins', async () => {
    await plugins.refresh();
    if (!plugins.all.length) {
      void vscode.window.showInformationMessage('No plugins installed. Use LocalPilot: Browse Plugins… to find some.');
      return;
    }
    const pick = await vscode.window.showQuickPick(plugins.all.map((p) => ({ label: `${p.enabled ? '$(check)' : '$(circle-slash)'} ${p.name}`, description: `${p.version ?? ''} · ${p.source === 'user' ? 'for me' : 'this workspace'}`, detail: describePlugin(p).summary, p })), { title: 'Plugins' });
    if (!pick) {
      return;
    }
    const action = await vscode.window.showQuickPick([pick.p.enabled ? 'Disable' : 'Enable', 'Remove', 'Open folder'], { title: pick.p.name });
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const settingsFile = pick.p.source === 'user' || !root ? path.join(os.homedir(), '.localpilot', 'settings.json') : path.join(root, '.localpilot', 'settings.json');
    if (action === 'Enable' || action === 'Disable') {
      await setPluginEnabled(settingsFile, pick.p.name, action === 'Enable');
    } else if (action === 'Remove') {
      if ((await vscode.window.showWarningMessage(`Remove ${pick.p.name}?`, { modal: true }, 'Remove')) !== 'Remove') {
        return;
      }
      await deleteUri(vscode.Uri.file(pick.p.root), true);
    } else if (action === 'Open folder') {
      await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(pick.p.root));
      return;
    } else {
      return;
    }
    await plugins.refresh();
    await vscode.commands.executeCommand('localpilot.reloadSkills');
  });
  // A worker for the shared board (`localpilot work`) in its own terminal; run the command again for more workers.
  cmd('localpilot.workOnBoard', () => {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) {
      void vscode.window.showWarningMessage('Open a folder first: the shared board lives in its .localpilot/board.');
      return;
    }
    const n = vscode.window.terminals.filter((t) => t.name.startsWith('LocalPilot Worker')).length + 1;
    vscode.window.createTerminal({ name: `LocalPilot Worker ${n}`, cwd: root, shellPath: process.execPath, shellArgs: [vscode.Uri.joinPath(context.extensionUri, 'dist', 'cli.js').fsPath, 'work', '-y', '-C', root], env: { ELECTRON_RUN_AS_NODE: '1' } }).show();
  });
  // The benchmark (`localpilot eval`) in a terminal: same agent loop, run by the bundled CLI on the extension host's Node.
  cmd('localpilot.runBenchmark', async () => {
    const models = (await providers.listModels().catch(() => [])).filter((m) => m.supportsTools && !/embed/i.test(m.modelId));
    if (!models.length) {
      void vscode.window.showWarningMessage('No tool-capable model is available to benchmark. Start a model server first.');
      return;
    }
    const def = getConfig().defaultModel;
    const picked = await vscode.window.showQuickPick(
      models.map((m) => ({ label: m.name, description: `${m.id}${m.remote ? ' · cloud' : ''}`, id: m.id, providerId: m.providerId, picked: m.id === def })),
      { canPickMany: true, title: 'Benchmark models', placeHolder: 'Pick the models to compare on the built-in coding tasks (each task takes a minute or two per model)' }
    );
    if (!picked?.length) {
      return;
    }
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.homedir();
    // The CLI has no secret storage: hand it the picked cloud models' keys as LOCALPILOT_KEY_<NAME>.
    const env: Record<string, string> = { ELECTRON_RUN_AS_NODE: '1' };
    for (const p of picked) {
      const cfg = getConfig().providers.find((c) => c.id === p.providerId);
      for (const name of secretRefs(cfg?.apiKey)) {
        const v = resolveApiKey({ apiKey: `\${secret:${name}}` });
        if (v) {
          env[secretEnvName(name)] = v;
        }
      }
    }
    const term = vscode.window.createTerminal({
      name: 'LocalPilot Benchmark',
      cwd: root,
      shellPath: process.execPath,
      shellArgs: [vscode.Uri.joinPath(context.extensionUri, 'dist', 'cli.js').fsPath, 'eval', '-C', root, '--suite', 'builtin', '--models', picked.map((p) => p.id).join(',')],
      env,
    });
    term.show();
  });
  cmd('localpilot.openTerminal', (run?: unknown) => {
    const term = terminals.openCliTerminal(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath);
    if (typeof run === 'string' && run.trim()) {
      term.sendText(run.trim());
    }
    return term;
  });
  cmd('localpilot.selectTerminalProfile', () => selectTerminalProfile());
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
    // Selected text wins; `copySelection` only sees the active terminal, so a different clicked one falls back.
    const selection = !t || t === vscode.window.activeTerminal ? await readTerminalSelection({ readText: () => vscode.env.clipboard.readText(), writeText: (v) => vscode.env.clipboard.writeText(v), copySelection: () => vscode.commands.executeCommand('workbench.action.terminal.copySelection') }) : '';
    if (selection.trim()) {
      view.reveal();
      return controller.addToComposer(terminalSelectionDraft(selection));
    }
    if (!terminals.lastExecution(t)) {
      return void vscode.window.showWarningMessage('No terminal text selected and no command captured yet in this terminal.');
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
  // Any file or folder from the Explorer (several when multi-selected); images join the vision row, the rest become chips.
  cmd('localpilot.attachFile', async (uri?: unknown, uris?: unknown) => {
    const list = Array.isArray(uris) && uris.every((u) => u instanceof vscode.Uri) && uris.length ? (uris as vscode.Uri[]) : uri instanceof vscode.Uri ? [uri] : await vscode.window.showOpenDialog({ canSelectMany: true, openLabel: 'Attach', defaultUri: vscode.workspace.workspaceFolders?.[0]?.uri, filters: ATTACH_FILTERS });
    if (!list?.length) {
      return;
    }
    view.reveal();
    for (const u of list) {
      await controller.handle({ type: 'attachUri', uri: u.toString() });
    }
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

  // The code an editor command acts on: a code action's (uri, range), else the active editor's selection (none when empty).
  const editorTarget = async (uri?: unknown, range?: unknown): Promise<{ doc: vscode.TextDocument; range?: vscode.Range } | undefined> => {
    if (uri instanceof vscode.Uri && range instanceof vscode.Range) {
      return { doc: await vscode.workspace.openTextDocument(uri), range };
    }
    const ed = vscode.window.activeTextEditor;
    return ed && { doc: ed.document, range: ed.selection.isEmpty ? undefined : ed.selection };
  };
  const rangeRef = (doc: vscode.TextDocument, range?: vscode.Range): string => {
    const rel = vscode.workspace.asRelativePath(doc.uri);
    return range ? selectionRef(rel, selectionLines(range.start.line, range.end.line, range.end.character)) : rel;
  };
  // Editor context-menu actions: send the selection to a fresh session with a task template.
  const editorAction = (title: string, template: (lang: string) => string, mode: 'agent' | 'ask' = 'ask') => async (uri?: unknown, range?: unknown) => {
    const target = await editorTarget(uri, range);
    if (!target) {
      return;
    }
    const rel = vscode.workspace.asRelativePath(target.doc.uri);
    view.reveal();
    const s = store.create(getConfig().defaultModel, mode);
    s.title = `${title}: ${rel.split('/').pop()}`;
    await controller.handle({ type: 'selectSession', id: s.id });
    void controller.send(s.id, template(target.doc.languageId), [rangeRef(target.doc, target.range)]);
  };
  // Cmd/Ctrl+': the selection becomes a chip in the current chat, with the problems inside it drafted below; nothing is sent.
  cmd('localpilot.addToChat', async (uri?: unknown, range?: unknown) => {
    const target = await editorTarget(uri, range);
    view.reveal();
    if (!target?.range) {
      return controller.addToComposer('');
    }
    const span = selectionLines(target.range.start.line, target.range.end.line, target.range.end.character);
    const problems = vscode.languages
      .getDiagnostics(target.doc.uri)
      .filter((d) => d.range.end.line >= span.start && d.range.start.line <= span.end)
      .map((d) => ({ line: d.range.start.line, severity: d.severity, message: d.message, source: d.source }));
    controller.addToComposer(problemsDraft(vscode.workspace.asRelativePath(target.doc.uri), problems), [rangeRef(target.doc, target.range)]);
  });
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
  const commitWithAgent = async () => {
    view.reveal();
    const s = store.create(getConfig().defaultModel, 'agent');
    s.title = 'Commit message';
    s.direct = true;
    await controller.handle({ type: 'selectSession', id: s.id });
    void controller.send(s.id, 'Run `git diff --cached` (fall back to `git diff` if nothing is staged) and write a conventional commit message for the changes. Output only the message in a code block.');
  };
  // One model call straight into the Source Control input box; the agent session is the fallback without the Git extension.
  cmd('localpilot.commitMessage', async (sourceControl?: unknown) => {
    if (!(await generateCommitMessage(providers, sourceControl))) {
      await commitWithAgent();
    }
  });
  cmd('localpilot.commitMessage.stop', () => stopCommitMessage());
  cmd('localpilot.commitWithAgent', commitWithAgent);
  context.subscriptions.push(
    ...registerNotebookCommands(async (title, prompt, mode) => {
      view.reveal();
      const s = store.create(getConfig().defaultModel, mode);
      s.title = title;
      await controller.handle({ type: 'selectSession', id: s.id });
      void controller.send(s.id, prompt);
    })
  );

  log.info('LocalPilot activated');

  return {
    version: extensionVersion,
    runPrompt: (prompt, mode, attachments) => controller.runPrompt(prompt, mode, attachments),
    runParallel: (tasks, mode) => controller.runParallel(tasks, mode),
    send: (sessionId, text) => controller.send(sessionId, text),
    stop: (sessionId) => controller.stop(sessionId),
    getSession: (id) => store.get(id),
    applyWorktree: (id) => controller.applyWorktree(id),
    discardWorktree: (id) => controller.discardWorktree(id),
    runBestOfN: (prompt, models, mode) => controller.runBestOfN(prompt, models, mode),
    queue: taskQueue,
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
    observeChat: (post) => controller.attach({ post, visible: () => false }),
    telemetry: { summary: (days) => telemetry.summary(days), logs: (filter) => telemetry.logs(filter), dir: telemetry.dir },
    lastOutcome: (sessionId) => controller.lastOutcome(sessionId),
    recovery: {
      state: (sessionId) => healing.store.load(sessionId),
      interventions: (opts) => healing.store.listInterventions(opts),
      resume: (sessionId) => resumeRecoveryApi(sessionId, taskQueue, controller, store),
      // The chat's own guard: restoring files under a live engine would pull the ground from under its fix or validation.
      rollback: async (sessionId, attempt) => {
        if (controller.isRunning(sessionId)) {
          throw new Error('chat is running — stop it before rolling back');
        }
        const wt = store.get(sessionId)?.worktree;
        return healing.service.rollback(sessionId, attempt, wt ? path.join(wt.path, wt.subdir ?? '') : workspace.root);
      },
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
  /** Bring an isolated session's worktree changes onto the workspace (uncommitted). */
  applyWorktree(sessionId: string): Promise<{ files: number; conflicts: string[] } | undefined>;
  discardWorktree(sessionId: string): Promise<void>;
  /** Run one prompt on several models at once (each isolated); returns the session ids. */
  runBestOfN(prompt: string, models: string[], mode?: Session['mode']): Promise<string[]>;
  /** The persistent task queue (Agents view → Queue): tasks run as chats, `queue.concurrency` at a time, after their dependencies. */
  readonly queue: Pick<TaskQueue, 'add' | 'list' | 'cancel' | 'retry' | 'remove' | 'paused' | 'setPaused' | 'onDidChange'>;
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
  /** The chat view (`localpilot.chatView`, wherever VS Code currently places it), whether it is visible and whether its UI has booted; undefined before the view is first shown or when the chat lives in an editor tab. */
  readonly chatHost: { viewId: string; visible: boolean; ready: boolean } | undefined;
  /** Receives every message the chat surfaces are sent (drafts, sessions, run events) until disposed. */
  observeChat(post: (msg: ToWebview) => void): vscode.Disposable;
  /** Local-only metrics and log mirror behind the Dashboard (nothing leaves the machine). */
  readonly telemetry: { summary(days: number): Promise<TelemetrySummary>; logs(filter?: { level?: LogLevel; q?: string; limit?: number }): LogEntry[]; readonly dir: string };
  /** Self-healing outcome of the chat's last turn (`completed`, `completed_unverified`, `incomplete`, `blocked`, …); undefined when none was reported. */
  lastOutcome(sessionId: string): TaskOutcome | undefined;
  /** Self-healing recovery state of a chat and the human-intervention queue. */
  readonly recovery: {
    /** The persisted recovery state of the chat's current or last task. */
    state(sessionId: string): Promise<RecoveryState | undefined>;
    /** Open intervention items (newest first); `includeResolved` adds closed ones. */
    interventions(opts?: { includeResolved?: boolean; sessionId?: string }): Promise<InterventionRecord[]>;
    /** Continues an interrupted or incomplete recovery in its chat (checks rerun first); a queue task goes back to the queue. Resolves with the final answer. */
    resume(sessionId: string): Promise<string>;
    /** Restores the files of the fix attempts (from `attempt` on, default all); files changed since by others are kept. Rejects while the chat runs. */
    rollback(sessionId: string, attempt?: number): Promise<RollbackResult>;
  };
}

export function deactivate(): Promise<void> | undefined {
  return shutdown?.();
}

const QUEUE_RESUMABLE: ReadonlySet<QueueTaskStatus> = new Set(['incomplete', 'needs_input', 'failed', 'cancelled']);

/**
 * `api.recovery.resume`, the same way as the Resume command: a queue task goes back to the queue (Retry keeps its chat)
 * so its status and dependents follow; the promise settles with the chat's last answer once the queued run ends.
 */
export async function resumeRecoveryApi(
  sessionId: string,
  queue: Pick<TaskQueue, 'list' | 'retry' | 'onDidChange'>,
  controller: Pick<ChatController, 'resumeRecovery'>,
  store: Pick<SessionStore, 'get'>
): Promise<string> {
  const task = queueTaskFor(queue, { sessionId });
  if (!task || !QUEUE_RESUMABLE.has(task.status)) {
    return controller.resumeRecovery(sessionId);
  }
  if (!queue.retry(task.id)) {
    throw new Error('this task cannot be resumed right now');
  }
  const id = task.id;
  await new Promise<void>((resolve) => {
    const done = () => {
      const t = queue.list.find((x) => x.id === id);
      return !t || (t.status !== 'queued' && t.status !== 'running');
    };
    if (done()) {
      resolve();
      return;
    }
    const sub = queue.onDidChange(() => {
      if (done()) {
        sub.dispose();
        resolve();
      }
    });
  });
  const sid = queue.list.find((x) => x.id === id)?.sessionId ?? sessionId;
  const last = [...(store.get(sid)?.messages ?? [])].reverse().find((m) => m.role === 'assistant' && m.content.trim());
  return last?.content ?? '';
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
