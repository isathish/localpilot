import * as vscode from 'vscode';
import { MemoryStore } from '../agent/memory';
import { SkillCreateSuggestion, SkillLearner } from '../agent/skillRecommender';
import { SkillManager } from '../agent/skills';
import { DEFAULT_PROVIDERS, getConfig, McpServerConfig, setModelEnabled } from '../config';
import { McpManager } from '../mcp/mcpManager';
import { CatalogRow, catalogForSystem, InstallTarget, installId, lookupCatalog, modelFootprintGb, starterPlan } from '../providers/catalog';
import { autoDetectProviders, ProbeResult, probeProvider, recommendModel } from '../providers/discovery';
import { ModelJob, ModelManager, RuntimeStatus } from '../providers/modelManager';
import { createGalleryRegistries, GallerySource, isValidInstallRef } from '../providers/modelGallery';
import { RegistryCapability, RegistryModel, RegistrySort, RegistryTag } from '../providers/ollamaRegistry';
import { pickForRole, ProviderRegistry } from '../providers/registry';
import { getSystemProfile, SystemProfile } from '../providers/system';
import { SessionStore } from '../sessions/sessionStore';
import { ModelInfo, ProviderConfig } from '../types';

export { probeProvider, recommendModel };
export type { ProbeResult };

export type SettingsPage = 'settings' | 'setup';
export type SettingsSection = 'providers' | 'models' | 'gallery' | 'agent' | 'completions' | 'web' | 'memory' | 'mcp' | 'advanced';

/** One setting as shown in the UI: effective value plus where it comes from. */
interface SettingEntry {
  value: unknown;
  default: unknown;
  scope: 'default' | 'user' | 'workspace';
  userValue?: unknown;
  workspaceValue?: unknown;
}

/** Installed model as shown in the manager: discovery info plus footprint, fit and auto-assigned roles. */
export interface ManagedModel extends ModelInfo {
  gb?: number;
  fit: 'ok' | 'tight' | 'over' | 'unknown';
  /** Roles the router would currently pick this model for (with no overrides). */
  autoRoles: ('agent' | 'completion' | 'vision' | 'reasoning' | 'fast')[];
  /** Catalog family/size if recognised. */
  catalog?: { key: string; name: string; vendor: string; tag: string };
  /** Runtime that can delete it, if any. */
  removable?: InstallTarget;
}

/** Catalog row flattened for the webview. */
export interface CatalogItem {
  key: string;
  name: string;
  vendor: string;
  description: string;
  roles: string[];
  tag: string;
  paramsB: number;
  gb: number;
  fits: boolean;
  tight: boolean;
  recommendedFor: string[];
  installed: string[];
  /** Runtimes that know how to install this size, with the id they use. */
  targets: { target: InstallTarget; id: string }[];
}

export interface ModelsState {
  system: SystemProfile;
  runtimes: RuntimeStatus[];
  installed: ManagedModel[];
  catalog: CatalogItem[];
  jobs: ModelJob[];
  starter: { agent: string; completion?: string; vision?: string };
}

type ToSettings =
  | { type: 'state'; page: SettingsPage; section?: SettingsSection; navigate?: boolean; version: string; hasWorkspace: boolean; settings: Record<string, SettingEntry>; models: ModelInfo[]; skills: { name: string; description: string; source: string; used?: number }[]; learning: { recurring: SkillCreateSuggestion[] }; agents: { name: string; description: string; source: string }[]; mcp: { name: string; tools: number; error?: string }[]; memory: { project: number; global: number; notes: { name: string; scope: 'project' | 'global'; summary: string; updatedAt: number; chars: number }[] }; sessions: { count: number; bytes: number; messages: number; running: number; pinned: number; oldest?: number }; welcomed: boolean }
  | { type: 'probe'; results: ProbeResult[]; dockerModelRunner?: string; runtimes?: RuntimeStatus[]; starter?: { agent: string; completion?: string; gb: number; platformNote: string } }
  | { type: 'testResult'; id: string; result: ProbeResult }
  | { type: 'models'; models: ModelsState }
  | { type: 'jobs'; jobs: ModelJob[] }
  | { type: 'gallery'; source: GallerySource; q: string; capability: string; sort: string; page: number; models: RegistryModel[]; hasMore: boolean; error?: string }
  | { type: 'galleryTags'; source: GallerySource; name: string; tags: RegistryTag[]; description?: string; error?: string }
  | { type: 'busy'; busy: boolean }
  | { type: 'toast'; level: 'info' | 'error'; text: string };

type FromSettings =
  | { type: 'ready' }
  | { type: 'set'; key: string; value: unknown; scope: 'user' | 'workspace' }
  | { type: 'reset'; key: string; scope: 'user' | 'workspace' }
  | { type: 'test'; provider: ProviderConfig }
  | { type: 'probe' }
  | { type: 'refreshModels' }
  | { type: 'loadModels' }
  | { type: 'installModel'; target: InstallTarget; model: string }
  | { type: 'gallerySearch'; source?: string; q?: string; capability?: string; sort?: string; page?: number }
  | { type: 'galleryTags'; source?: string; name: string }
  | { type: 'removeModel'; target: InstallTarget; model: string; providerId: string; name?: string }
  | { type: 'toggleModel'; id: string; enabled: boolean }
  | { type: 'cancelJob'; id: string }
  | { type: 'clearJobs' }
  | { type: 'autoSetup'; installRuntime?: boolean; target?: InstallTarget }
  | { type: 'startRuntime'; target: InstallTarget }
  | { type: 'command'; id: string; args?: unknown[] }
  | { type: 'deleteNote'; name: string; scope: 'project' | 'global' }
  | { type: 'openNote'; name: string; scope: 'project' | 'global' }
  | { type: 'finishSetup'; model?: string; approvals?: 'safe' | 'balanced' | 'autonomous'; inlineCompletion?: boolean; providers?: ProviderConfig[] }
  | { type: 'openExternal'; url: string };

/** Keys (relative to `localpilot.`) that the UI may read and write. Anything else is rejected. */
const SETTING_KEYS = [
  'providers', 'defaultModel', 'contextWindow', 'maxOutputTokens', 'temperature', 'thinking', 'keepAlive', 'compactionThreshold', 'maxToolOutputChars',
  'approvals.terminal', 'approvals.write', 'approvals.delete', 'approvals.network', 'parallel.maxConcurrency', 'parallel.maxSubagentDepth', 'autoClarify', 'worktrees.mode', 'worktrees.location',
  'webSearch.provider', 'webSearch.searxngUrl', 'webSearch.apiKey', 'webSearch.maxResults',
  'inlineCompletion.enabled', 'inlineCompletion.model', 'inlineCompletion.debounceMs', 'inlineCompletion.maxTokens',
  'mcpServers', 'skillsPaths', 'skills.builtin', 'skills.repositories', 'skills.autoInstall', 'skills.autoInstallScope', 'memory.enabled', 'sessions.retention', 'systemPromptAppend', 'showWelcomeOnStartup', 'chat.location', 'terminal.runInIntegratedTerminal', 'terminal.reveal',
  'models.disabled', 'models.autoSetup', 'routing.enabled', 'routing.vision', 'routing.reasoning', 'routing.fast', 'routing.coding',
] as const;

/** Commands the webview is allowed to trigger. */
const ALLOWED_COMMANDS = new Set([
  'localpilot.openChat', 'localpilot.newSession', 'localpilot.openMemory', 'localpilot.clearMemory', 'localpilot.clearHistory', 'localpilot.showSessions', 'localpilot.reloadSkills', 'localpilot.showLogs', 'localpilot.installCli',
  'localpilot.refreshModels', 'localpilot.openWelcome', 'localpilot.openSettings', 'localpilot.openTerminal', 'workbench.action.openSettingsJson', 'workbench.action.openWorkspaceSettingsFile',
  'workbench.action.openWalkthrough', 'workbench.action.openSettings', 'localpilot.autoSetupModels', 'localpilot.installModel', 'localpilot.removeModel', 'localpilot.manageModels', 'localpilot.browseModelGallery',
  'localpilot.createSkill', 'localpilot.dismissSkillTopic', 'localpilot.installSkill', 'localpilot.browseSkills',
]);

const PRESETS: Record<'safe' | 'balanced' | 'autonomous', Record<'terminal' | 'write' | 'delete' | 'network', 'ask' | 'always' | 'never'>> = {
  safe: { terminal: 'ask', write: 'ask', delete: 'ask', network: 'ask' },
  balanced: { terminal: 'ask', write: 'always', delete: 'ask', network: 'always' },
  autonomous: { terminal: 'always', write: 'always', delete: 'ask', network: 'always' },
};

export const WELCOMED_KEY = 'localpilot.welcomed';

const TARGET_LABEL: Record<InstallTarget, string> = { ollama: 'Ollama', docker: 'Docker Model Runner', lmstudio: 'LM Studio' };
const GALLERY_CAPABILITIES = new Set<string>(['tools', 'vision', 'thinking', 'embedding']);
const GALLERY_SORTS = new Set<string>(['popular', 'newest', 'name']);
const GALLERY_SOURCES = new Set<string>(['ollama', 'docker', 'huggingface']);
const GALLERY_SITE: Record<GallerySource, string> = { ollama: 'ollama.com', docker: 'hub.docker.com', huggingface: 'huggingface.co' };

/**
 * Settings, provider manager and first-run setup — one webview panel with two pages.
 * The webview never touches configuration directly; every change is validated here and written with the VS Code API.
 */
export class SettingsPanel implements vscode.Disposable {
  /** Skill usage / recurring-request tracker (set by the extension host). */
  learner?: SkillLearner;
  private panel?: vscode.WebviewPanel;
  private page: SettingsPage = 'settings';
  private section?: SettingsSection;
  private navigate = false;
  private modelsLoaded = false;
  private modelsRefresh?: ReturnType<typeof setTimeout>;
  private jobsTimer?: ReturnType<typeof setTimeout>;
  private readonly registries = createGalleryRegistries();
  private readonly gallerySearchAbort = new Map<GallerySource, AbortController>();
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly ctx: vscode.ExtensionContext,
    private readonly providers: ProviderRegistry,
    private readonly models: ModelManager,
    private readonly skills: SkillManager,
    private readonly mcp: McpManager,
    private readonly memory: MemoryStore,
    private readonly store: SessionStore,
    private readonly log: vscode.LogOutputChannel,
    /** Ids of chats currently streaming (they are never deleted by "Clear chat history"). */
    private readonly running: () => string[] = () => []
  ) {
    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('localpilot') && this.panel) {
          void this.pushState();
        }
      }),
      providers.onDidChange(() => this.panel && void this.pushState()),
      mcp.onDidChange(() => this.panel && void this.pushState()),
      skills.onDidChange(() => this.panel && void this.pushState()),
      models.onDidChange(() => {
        // Pull progress arrives per chunk; coalesce so the webview repaints at most ~6×/s.
        if (this.panel && !this.jobsTimer) {
          this.jobsTimer = setTimeout(() => {
            this.jobsTimer = undefined;
            this.post({ type: 'jobs', jobs: models.allJobs });
          }, 150);
        }
      }),
      // A finished pull/remove changes the installed list: refresh the models view once discovery settles.
      models.onDidChange(() => {
        if (this.panel && !models.activeJobs.length && this.modelsLoaded) {
          clearTimeout(this.modelsRefresh);
          this.modelsRefresh = setTimeout(() => void this.pushModels(), 400);
        }
      })
    );
  }

  /** True while the panel exists (visible or in a background tab). */
  get isOpen(): boolean {
    return !!this.panel;
  }

  show(page: SettingsPage = 'settings', section?: SettingsSection): void {
    this.page = page;
    this.section = section;
    this.navigate = true;
    if (this.panel) {
      this.panel.title = this.title();
      this.panel.reveal();
      void this.pushState();
      return;
    }
    const panel = vscode.window.createWebviewPanel('localpilot.settings', this.title(), vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(this.ctx.extensionUri, 'media')],
    });
    panel.iconPath = vscode.Uri.joinPath(this.ctx.extensionUri, 'media', 'icon.svg');
    panel.webview.html = this.html(panel.webview);
    this.panel = panel;
    panel.webview.onDidReceiveMessage((m: FromSettings) => void this.handle(m).catch((e) => this.post({ type: 'toast', level: 'error', text: e instanceof Error ? e.message : String(e) })));
    panel.onDidDispose(() => {
      this.panel = undefined;
      this.modelsLoaded = false;
    });
  }

  private title(): string {
    return this.page === 'setup' ? 'Welcome to LocalPilot' : 'LocalPilot Settings';
  }

  private post(m: ToSettings): void {
    void this.panel?.webview.postMessage(m);
  }

  // ------------------------------------------------------------------ messages
  private async handle(m: FromSettings): Promise<void> {
    switch (m.type) {
      case 'ready':
        this.navigate = true;
        return this.pushState();
      case 'set':
        return this.update(m.key, m.value, m.scope);
      case 'reset':
        return this.update(m.key, undefined, m.scope);
      case 'test': {
        const result = await probeProvider(sanitizeProvider(m.provider), true);
        return this.post({ type: 'testResult', id: result.id, result });
      }
      case 'probe':
        return this.probeAll();
      case 'refreshModels':
        this.post({ type: 'busy', busy: true });
        await this.providers.listModels(true).catch(() => []);
        this.post({ type: 'busy', busy: false });
        await this.pushState();
        return this.modelsLoaded ? this.pushModels() : undefined;
      case 'loadModels':
        return this.pushModels();
      case 'installModel':
        if (!isValidInstallRef(m.target, m.model)) {
          throw new Error(`Not a valid ${TARGET_LABEL[m.target] ?? m.target} model reference: ${m.model}`);
        }
        void this.models.pull(m.target, m.model, this.runtimeProvider(m.target)).then((job) => {
          if (job.status === 'done') {
            this.post({ type: 'toast', level: 'info', text: `${job.model} installed` });
          } else if (job.status === 'error') {
            this.post({ type: 'toast', level: 'error', text: `Install failed: ${job.error}` });
          }
        });
        return;
      case 'gallerySearch':
        return this.gallerySearch(m);
      case 'galleryTags': {
        const source = GALLERY_SOURCES.has(String(m.source)) ? (m.source as GallerySource) : 'ollama';
        try {
          const r = await this.registries[source].tags(m.name);
          this.post({ type: 'galleryTags', source, name: m.name, tags: r.tags, description: r.description });
        } catch (e) {
          this.post({ type: 'galleryTags', source, name: m.name, tags: [], error: galleryError(e, source) });
        }
        return;
      }
      case 'removeModel': {
        // Webviews cannot show `confirm()` dialogs (it silently returns false), so the host asks instead.
        const label = m.name || m.model;
        const ok = await vscode.window.showWarningMessage(`Delete ${label} from ${TARGET_LABEL[m.target]}?`, { modal: true, detail: 'The model files are removed from the runtime. You can download it again from the catalog.' }, 'Delete');
        if (ok !== 'Delete') {
          return;
        }
        void this.models.remove(m.target, m.model, m.providerId).then((job) => {
          if (job.status === 'done') {
            this.post({ type: 'toast', level: 'info', text: `${label} deleted` });
          } else if (job.status === 'error') {
            this.post({ type: 'toast', level: 'error', text: job.error ?? 'Remove failed' });
          }
        });
        return;
      }
      case 'toggleModel':
        // The config change re-fires provider discovery listeners, so the chat picker and status bar follow.
        await setModelEnabled(m.id, m.enabled);
        return this.pushModels();
      case 'cancelJob':
        return this.models.cancel(m.id);
      case 'clearJobs':
        return this.models.clearFinished();
      case 'autoSetup':
        await vscode.commands.executeCommand('localpilot.autoSetupModels', { installRuntime: m.installRuntime, target: m.target, force: true });
        if (this.page === 'setup') {
          await this.probeAll();
        }
        return this.pushModels();
      case 'startRuntime':
        if (m.target === 'ollama') {
          const job = await this.models.startOllama();
          this.post({ type: 'toast', level: job.status === 'done' ? 'info' : 'error', text: job.status === 'done' ? 'Ollama is running' : job.error ?? 'Could not start Ollama' });
          await this.providers.listModels(true).catch(() => []);
          return this.pushModels();
        }
        return;
      case 'command':
        if (!ALLOWED_COMMANDS.has(m.id)) {
          throw new Error(`Command not allowed: ${m.id}`);
        }
        await vscode.commands.executeCommand(m.id, ...(m.args ?? []));
        if (m.id.startsWith('localpilot.')) {
          void this.pushState();
        }
        return;
      case 'deleteNote': {
        const ok = await this.memory.delete(m.name, m.scope);
        this.post({ type: 'toast', level: ok ? 'info' : 'error', text: ok ? `Deleted note “${m.name}”` : `Note “${m.name}” not found` });
        return this.pushState();
      }
      case 'openNote': {
        const dir = this.memory.openFolder(m.scope);
        if (dir) {
          await vscode.window.showTextDocument(vscode.Uri.joinPath(dir, `${m.name}.md`), { preview: true }).then(undefined, () => this.post({ type: 'toast', level: 'error', text: `Cannot open ${m.name}.md` }));
        }
        return;
      }
      case 'finishSetup':
        return this.finishSetup(m);
      case 'openExternal':
        if (/^https?:\/\//i.test(m.url)) {
          await vscode.env.openExternal(vscode.Uri.parse(m.url));
        }
        return;
    }
  }

  private async update(key: string, value: unknown, scope: 'user' | 'workspace'): Promise<void> {
    if (!(SETTING_KEYS as readonly string[]).includes(key)) {
      throw new Error(`Unknown setting: ${key}`);
    }
    if (scope === 'workspace' && !vscode.workspace.workspaceFolders?.length) {
      throw new Error('Open a folder to use workspace settings');
    }
    const clean = key === 'providers' && Array.isArray(value) ? value.map((p) => sanitizeProvider(p as ProviderConfig)) : key === 'mcpServers' && value !== undefined ? sanitizeMcpServers(value) : value;
    await vscode.workspace.getConfiguration('localpilot').update(key, clean, scope === 'user' ? vscode.ConfigurationTarget.Global : vscode.ConfigurationTarget.Workspace);
    this.log.info(`settings: ${key} ${clean === undefined ? 'reset' : 'updated'} (${scope})`);
  }

  /** Searches a registry for the gallery. A newer search on the same source cancels the one in flight so a fast typist never sees stale pages land. */
  private async gallerySearch(m: Extract<FromSettings, { type: 'gallerySearch' }>): Promise<void> {
    const source = GALLERY_SOURCES.has(String(m.source)) ? (m.source as GallerySource) : 'ollama';
    this.gallerySearchAbort.get(source)?.abort(new Error('superseded'));
    const ctrl = new AbortController();
    this.gallerySearchAbort.set(source, ctrl);
    const q = String(m.q ?? '').slice(0, 100);
    const capability = GALLERY_CAPABILITIES.has(String(m.capability)) ? (m.capability as RegistryCapability) : '';
    const sort = GALLERY_SORTS.has(String(m.sort)) ? (m.sort as RegistrySort) : 'popular';
    const page = Math.max(1, Math.min(50, Math.floor(Number(m.page) || 1)));
    try {
      const r = await this.registries[source].search({ q, capability, sort, page }, ctrl.signal);
      if (ctrl.signal.aborted) {
        return;
      }
      this.post({ type: 'gallery', source, q, capability, sort, page, models: r.models, hasMore: r.hasMore });
    } catch (e) {
      if (ctrl.signal.aborted) {
        return;
      }
      this.log.warn(`gallery: ${source} search failed: ${e instanceof Error ? e.message : String(e)}`);
      this.post({ type: 'gallery', source, q, capability, sort, page, models: [], hasMore: false, error: galleryError(e, source) });
    } finally {
      if (this.gallerySearchAbort.get(source) === ctrl) {
        this.gallerySearchAbort.delete(source);
      }
    }
  }

  private async finishSetup(m: Extract<FromSettings, { type: 'finishSetup' }>): Promise<void> {
    const cfg = vscode.workspace.getConfiguration('localpilot');
    if (m.providers?.length) {
      // Merge: keep everything the user already configured, add newly detected servers.
      const existing = cfg.get<ProviderConfig[]>('providers', DEFAULT_PROVIDERS).map(sanitizeProvider);
      const known = new Set(existing.map((p) => p.baseUrl.replace(/\/+$/, '')));
      const added = m.providers.map(sanitizeProvider).filter((p) => !known.has(p.baseUrl));
      if (added.length) {
        await cfg.update('providers', [...existing, ...added], vscode.ConfigurationTarget.Global);
      }
    }
    if (m.model) {
      await cfg.update('defaultModel', m.model, vscode.ConfigurationTarget.Global);
    }
    if (m.approvals) {
      for (const [k, v] of Object.entries(PRESETS[m.approvals])) {
        await cfg.update(`approvals.${k}`, v, vscode.ConfigurationTarget.Global);
      }
    }
    if (typeof m.inlineCompletion === 'boolean') {
      await cfg.update('inlineCompletion.enabled', m.inlineCompletion, vscode.ConfigurationTarget.Global);
    }
    await this.ctx.globalState.update(WELCOMED_KEY, true);
    this.panel?.dispose();
    await vscode.commands.executeCommand('localpilot.openChat');
    vscode.window.setStatusBarMessage('LocalPilot is ready — start chatting', 4000);
  }

  private async probeAll(): Promise<void> {
    this.post({ type: 'busy', busy: true });
    // Settings + well-known endpoints + Docker containers; nothing is written from here (the wizard merges on finish).
    const [report, runtimes, system] = await Promise.all([autoDetectProviders(this.log, { write: false }), this.models.detectRuntimes().catch(() => [] as RuntimeStatus[]), getSystemProfile().catch(() => undefined)]);
    const plan = system ? starterPlan(system) : undefined;
    const label = (p: { entry: { name: string }; variant: { tag: string; gb: number } }) => `${p.entry.name} ${p.variant.tag}`;
    const platformNote = process.platform === 'darwin' ? 'official Ollama.app into /Applications' : process.platform === 'win32' ? 'official installer, per-user' : 'official build into ~/.local/share/localpilot';
    this.post({
      type: 'probe',
      results: report.results,
      dockerModelRunner: report.dockerModelRunner,
      runtimes,
      starter: plan ? { agent: label(plan.agent), completion: plan.completion ? label(plan.completion) : undefined, gb: Math.round((plan.agent.variant.gb + (plan.completion?.variant.gb ?? 0)) * 10) / 10, platformNote } : undefined,
    });
    this.post({ type: 'busy', busy: false });
  }

  private runtimeProvider(target: InstallTarget): string | undefined {
    const providers = getConfig().providers;
    return target === 'ollama' ? providers.find((p) => p.type === 'ollama')?.id : target === 'docker' ? providers.find((p) => /:12434\//.test(p.baseUrl) || p.id === 'docker')?.id : providers.find((p) => /:1234\//.test(p.baseUrl) || p.id === 'lmstudio')?.id;
  }

  /** Builds the model-manager view: machine profile, runtimes, installed models with roles, catalog and jobs. */
  async modelsState(): Promise<ModelsState> {
    const [system, runtimes, all] = await Promise.all([getSystemProfile(), this.models.detectRuntimes(), this.providers.listAllModels().catch(() => [] as ModelInfo[])]);
    const enabled = all.filter((m) => !m.disabled);
    // Plan mode keeps the session model unless `routing.reasoning` is set, so there is no "auto" reasoning pick to show.
    const auto = { agent: pickForRole(enabled, 'agent', system)?.id, completion: pickForRole(enabled, 'completion', system)?.id, vision: pickForRole(enabled, 'vision', system)?.id, fast: pickForRole(enabled, 'fast', system)?.id };
    const installed: ManagedModel[] = all.map((m) => {
      const gb = modelFootprintGb(m);
      const cat = lookupCatalog(m);
      const rt = runtimes.find((r) => r.providerId === m.providerId && r.canRemove && r.running);
      return {
        ...m,
        gb,
        fit: gb === undefined ? 'unknown' : gb <= system.modelBudgetGb ? 'ok' : gb <= system.modelBudgetGb * 1.25 ? 'tight' : 'over',
        autoRoles: (['agent', 'completion', 'vision', 'fast'] as const).filter((r) => auto[r] === m.id),
        catalog: cat ? { key: cat.entry.key, name: cat.entry.name, vendor: cat.entry.vendor, tag: cat.variant.tag } : undefined,
        removable: rt?.target,
      };
    });
    const running = runtimes.filter((r) => r.running);
    const catalog: CatalogItem[] = catalogForSystem(system, all).map((r: CatalogRow) => ({
      key: r.entry.key,
      name: r.entry.name,
      vendor: r.entry.vendor,
      description: r.entry.description,
      roles: r.entry.roles,
      tag: r.variant.tag,
      paramsB: r.variant.paramsB,
      gb: r.variant.gb,
      fits: r.fits,
      tight: r.tight,
      recommendedFor: r.recommendedFor,
      installed: r.installed,
      targets: running.map((rt) => ({ target: rt.target, id: installId(r, rt.target) })).filter((t): t is { target: InstallTarget; id: string } => !!t.id),
    }));
    const plan = starterPlan(system);
    const label = (p: { entry: { name: string }; variant: { tag: string; gb: number } }) => `${p.entry.name} ${p.variant.tag} (${p.variant.gb} GB)`;
    return { system, runtimes, installed, catalog, jobs: this.models.allJobs, starter: { agent: label(plan.agent), completion: plan.completion ? label(plan.completion) : undefined, vision: plan.vision ? label(plan.vision) : undefined } };
  }

  private async pushModels(): Promise<void> {
    if (!this.panel) {
      return;
    }
    this.modelsLoaded = true;
    try {
      this.post({ type: 'models', models: await this.modelsState() });
    } catch (e) {
      this.post({ type: 'toast', level: 'error', text: e instanceof Error ? e.message : String(e) });
    }
  }

  private async pushState(): Promise<void> {
    if (!this.panel) {
      return;
    }
    const cfg = vscode.workspace.getConfiguration('localpilot');
    const settings: Record<string, SettingEntry> = {};
    for (const key of SETTING_KEYS) {
      const i = cfg.inspect<unknown>(key);
      const scope = i?.workspaceValue !== undefined || i?.workspaceFolderValue !== undefined ? 'workspace' : i?.globalValue !== undefined ? 'user' : 'default';
      settings[key] = { value: cfg.get(key), default: i?.defaultValue, scope, userValue: i?.globalValue, workspaceValue: i?.workspaceValue ?? i?.workspaceFolderValue };
    }
    const models = await this.providers.listAllModels().catch(() => []);
    const notes = await this.memory.list().catch(() => []);
    const learning = await this.learner?.usage().catch(() => undefined);
    const stats = await this.store.stats().catch(() => ({ count: this.store.list().length, bytes: 0, messages: 0 }));
    this.post({
      type: 'state',
      page: this.page,
      section: this.section,
      // Only an explicit show()/ready moves the webview; refreshes after a settings change leave the user where they are.
      navigate: this.navigate,
      version: String((this.ctx.extension.packageJSON as { version?: string }).version ?? ''),
      hasWorkspace: !!vscode.workspace.workspaceFolders?.length,
      settings,
      models,
      skills: this.skills.allSkills.map((s) => ({ name: s.name, description: s.description, source: s.source, used: learning?.skillUse[s.name]?.count })),
      learning: { recurring: learning?.recurring ?? [] },
      agents: this.skills.allAgents.map((a) => ({ name: a.name, description: a.description, source: a.source })),
      mcp: this.mcp.status,
      memory: { project: notes.filter((n) => n.scope === 'project').length, global: notes.filter((n) => n.scope === 'global').length, notes: notes.slice(0, 200).map((n) => ({ name: n.name, scope: n.scope, summary: n.summary, updatedAt: n.updatedAt, chars: n.chars })) },
      sessions: { ...stats, running: this.running().length, pinned: this.store.list().filter((x) => x.pinned).length },
      welcomed: !!this.ctx.globalState.get(WELCOMED_KEY),
    });
    this.section = undefined;
    this.navigate = false;
  }

  // ------------------------------------------------------------------ html
  private html(webview: vscode.Webview): string {
    const media = (f: string) => webview.asWebviewUri(vscode.Uri.joinPath(this.ctx.extensionUri, 'media', f));
    const nonce = Array.from({ length: 24 }, () => 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'[Math.floor(Math.random() * 62)]).join('');
    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src ${webview.cspSource} data:; font-src ${webview.cspSource};" />
<link rel="stylesheet" href="${media('settings.css')}" />
<title>LocalPilot</title>
</head>
<body data-logo="${media('logo.svg')}">
<div id="app" aria-busy="true"><div class="loading" role="status"><div class="boot-logo"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3h11A2.5 2.5 0 0 1 20 5.5v8a2.5 2.5 0 0 1-2.5 2.5H13l-4.5 4v-4h-2A2.5 2.5 0 0 1 4 13.5z"/><circle cx="9" cy="9.5" r="1.1" fill="currentColor" stroke="none"/><circle cx="15" cy="9.5" r="1.1" fill="currentColor" stroke="none"/><path d="M12 3V1.5"/><circle cx="12" cy="1.2" r=".8" fill="currentColor" stroke="none"/></svg></div><span class="boot-dots"><i></i><i></i><i></i></span><span class="sr">Loading LocalPilot Settings…</span></div></div>
<div id="toasts"></div>
<script nonce="${nonce}" src="${media('settings.js')}"></script>
</body>
</html>`;
  }

  dispose(): void {
    clearTimeout(this.modelsRefresh);
    clearTimeout(this.jobsTimer);
    this.gallerySearchAbort.forEach((c) => c.abort(new Error('disposed')));
    this.panel?.dispose();
    this.disposables.forEach((d) => d.dispose());
  }
}

/** Validate the MCP server map coming from the form: non-empty names and commands, string args, string env values. */
export function sanitizeMcpServers(value: unknown): Record<string, McpServerConfig> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('mcpServers must be an object');
  }
  const out: Record<string, McpServerConfig> = {};
  for (const [rawName, rawCfg] of Object.entries(value as Record<string, unknown>)) {
    const name = rawName.trim().replace(/[^\w.-]+/g, '-');
    const c = (rawCfg ?? {}) as Partial<McpServerConfig>;
    const command = String(c.command ?? '').trim();
    if (!name || !command) {
      throw new Error(`MCP server "${rawName || '?'}" needs a name and a command`);
    }
    const entry: McpServerConfig = { command };
    if (Array.isArray(c.args) && c.args.length) {
      entry.args = c.args.map(String);
    }
    if (c.env && typeof c.env === 'object' && !Array.isArray(c.env)) {
      entry.env = Object.fromEntries(Object.entries(c.env).map(([k, v]) => [k, String(v)]));
    }
    if (typeof c.cwd === 'string' && c.cwd.trim()) {
      entry.cwd = c.cwd.trim();
    }
    if (c.enabled === false) {
      entry.enabled = false;
    }
    out[name] = entry;
  }
  return out;
}

/** Plain-language gallery error: connectivity, Docker Hub's anonymous rate limit, or the registry's own message. */
function galleryError(e: unknown, source: GallerySource): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (/fetch failed|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|timeout|aborted/i.test(msg)) {
    return `Cannot reach ${GALLERY_SITE[source]} — check your internet connection.`;
  }
  if (source === 'docker' && /HTTP (403|429)/.test(msg)) {
    return 'Docker Hub is rate-limiting anonymous requests — wait a minute and try again.';
  }
  return msg;
}

/** Keep only known fields and normalise URLs/ids so a malformed form can't produce a broken provider. */
export function sanitizeProvider(p: ProviderConfig): ProviderConfig {
  const id = String(p.id || '').trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'provider';
  const type: ProviderConfig['type'] = p.type === 'ollama' ? 'ollama' : 'openai';
  let baseUrl = String(p.baseUrl || '').trim().replace(/\/+$/, '');
  if (baseUrl && !/^https?:\/\//i.test(baseUrl)) {
    baseUrl = `http://${baseUrl}`;
  }
  const out: ProviderConfig = { id, type, baseUrl };
  if (p.displayName && String(p.displayName).trim()) {
    out.displayName = String(p.displayName).trim();
  }
  if (p.apiKey && String(p.apiKey).trim()) {
    out.apiKey = String(p.apiKey).trim();
  }
  if (Array.isArray(p.models) && p.models.length) {
    out.models = p.models.map((m) => String(m).trim()).filter(Boolean);
  }
  if (typeof p.contextWindow === 'number' && p.contextWindow > 0) {
    out.contextWindow = Math.round(p.contextWindow);
  }
  if (p.enabled === false) {
    out.enabled = false;
  }
  return out;
}
