import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { MemoryStore } from '../agent/memory';
import { CatalogEntry, SkillCatalog } from '../agent/skillCatalog';
import { skillsDestination } from '../agent/skillInstaller';
import { SkillCreateSuggestion, SkillLearner } from '../agent/skillRecommender';
import { SkillManager } from '../agent/skills';
import { editableProviders, getConfig, isUserOnlySetting, McpServerConfig, setModelEnabled, setSkillEnabled } from '../config';
import { McpManager, McpServerStatus } from '../mcp/mcpManager';
import type { McpCatalogEntry } from '../mcp/catalog';
import { installCatalogServer, installedMessage, McpCatalogService } from './mcpCatalogInstall';
import { isRemoteUrl, keyStatus, KeyStatus, secretRefs } from '../providers/cloud';
import { sanitizeProviderConfig } from '../providers/sanitize';
import { ProviderSecrets } from '../providers/secrets';
import { CatalogRow, catalogForSystem, InstallTarget, installId, lookupCatalog, modelFootprintGb, starterPlan } from '../providers/catalog';
import { autoDetectProviders, endpointKey, KNOWN_ENDPOINTS, ProbeResult, probeProvider, recommendModel } from '../providers/discovery';
import { ModelJob, ModelManager, RuntimeStatus } from '../providers/modelManager';
import { createGalleryRegistries, GallerySource, isValidInstallRef } from '../providers/modelGallery';
import { RegistryCapability, RegistryModel, RegistrySort, RegistryTag } from '../providers/ollamaRegistry';
import { pickForRole, ProviderRegistry } from '../providers/registry';
import { getSystemProfile, SystemProfile } from '../providers/system';
import { TUNE_LABELS, TuneRole, TuneSuggestion } from '../providers/usageAdvisor';
import { SessionStore } from '../sessions/sessionStore';
import { LogEntry, LogLevel, Telemetry, TelemetrySummary } from '../telemetry/telemetry';
import { pingRedis, RedisPingInfo, redactRedisUrl } from '../storage/redis';
import type { ModelTuner, TuneReport } from './modelAutoTune';
import { ModelInfo, ProviderConfig } from '../types';
import { DEFAULT_PROVIDERS } from '../providers/defaultProviders';
import { describePolicy, getManagedPolicy, mergeManagedProviders, PolicyLocks, policyEffectiveValues, policyLocks } from '../agent/managedPolicy';
import { toolDisabled } from '../agent/toolAliases';
import { createItem, CustomizeData, CustomKind, deleteItem, listCustomizations, setItemEnabled } from './customize';
import { FrontMatterError } from '../agent/frontMatterEdit';
import { listRepos } from '../agent/repos';
import { formatBytes } from '../agent/checkpoints';
import { profileNames, profileOsKey, TerminalProfileEntry } from '../terminal/profiles';
import { ensureChecksJson, HealingView, healingView as buildHealingView } from './healingChecksView';
import type { RecoveryDashboard } from '../agent/healing/dashboardData';
import type { RecoveryActionKind } from '../agent/healing/types';
import { handleMemoryReuse, handleOpenRecoveryDiff, handleRecoveryAction, loadRecovery, RecoveryHooks } from './recoveryDashboardBridge';

export { probeProvider, recommendModel };
export type { ProbeResult };

export type SettingsPage = 'settings' | 'setup';
export type SettingsSection = 'providers' | 'models' | 'gallery' | 'skills' | 'agent' | 'completions' | 'web' | 'memory' | 'mcp' | 'dashboard' | 'telemetry' | 'advanced' | 'customize' | 'documents';

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

/** Installed skill as shown in Settings → Skills. */
export interface SettingsSkill {
  name: string;
  description: string;
  source: string;
  used?: number;
  disabled?: boolean;
  /** Required by the organisation: cannot be switched off. */
  alwaysEnabled?: boolean;
  dir: string;
  /** Workspace / user skills can be deleted from Settings; bundled ones cannot. */
  removable: boolean;
}

/** Registry (catalog) skill as shown in the gallery. */
export interface RegistrySkill extends CatalogEntry {
  installed: boolean;
  /** Source of the installed copy, when there is one. */
  installedSource?: string;
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
  | { type: 'state'; page: SettingsPage; section?: SettingsSection; focusKey?: string; expand?: string; navigate?: boolean; version: string; hasWorkspace: boolean; settings: Record<string, SettingEntry>; models: ModelInfo[]; keys: Record<string, KeyStatus>; skills: SettingsSkill[]; learning: { recurring: SkillCreateSuggestion[] }; agents: { name: string; description: string; source: string }[]; tools: { name: string; description: string; off: boolean }[]; mcp: McpServerStatus[]; memory: { project: number; global: number; notes: { name: string; scope: 'project' | 'global'; summary: string; updatedAt: number; chars: number }[] }; sessions: { count: number; bytes: number; messages: number; running: number; pinned: number; oldest?: number; checkpointBytes?: number }; welcomed: boolean; managed?: { source: string; message?: string; lines: string[] }; policy?: PolicyLocks & { effective: Record<string, unknown> }; otlp?: OtlpStatus; terminalProfiles: string[]; autoRepos: { name: string; path: string; source: 'workspace' | 'repos.json' }[]; settingsMeta: { missingPaths: string[] }; healing?: HealingView }
  | { type: 'probe'; results: ProbeResult[]; dockerModelRunner?: string; runtimes?: RuntimeStatus[]; starter?: { agent: string; completion?: string; gb: number; platformNote: string } }
  | { type: 'testResult'; id: string; result: ProbeResult }
  | { type: 'models'; models: ModelsState }
  | { type: 'jobs'; jobs: ModelJob[] }
  | { type: 'gallery'; source: GallerySource; q: string; capability: string; sort: string; page: number; models: RegistryModel[]; hasMore: boolean; error?: string }
  | { type: 'galleryTags'; source: GallerySource; name: string; tags: RegistryTag[]; description?: string; error?: string }
  | { type: 'skillRegistry'; q: string; entries: RegistrySkill[]; status: { repo: string; skills: number; fetched?: number; error?: string }[]; refreshing: boolean }
  | { type: 'skillJob'; name: string; status: 'running' | 'done' | 'error'; detail?: string }
  | { type: 'busy'; busy: boolean }
  | {
      type: 'dashboard';
      days: number;
      summary?: TelemetrySummary;
      logFile?: string;
      tuning?: DashboardTuning;
      error?: string;
      /** Providers left out of the numbers (disabled or removed) with their model calls in the range. */
      hiddenProviders?: { id: string; calls: number }[];
      /** Every provider the Provider filter can offer. */
      allProviders?: string[];
      includeDisabled?: boolean;
      providers?: string[];
      /** Self-healing & recovery group; absent when no recovery service is wired into this window. */
      recovery?: RecoveryDashboard;
      recoveryError?: string;
      /** Applied patches can open as a diff editor. */
      recoveryDiff?: boolean;
    }
  | { type: 'healingChecks'; healing?: HealingView; error?: string }
  | { type: 'tuneResult'; role: string; model: string; ok: boolean; error?: string }
  | { type: 'logs'; entries: LogEntry[]; level?: LogLevel; q?: string }
  | { type: 'logLine'; entry: LogEntry }
  /** action: a button that runs an allowed command, or posts `msg` back as if the page had sent it (Undo). */
  | { type: 'toast'; level: 'info' | 'warn' | 'error'; text: string; action?: { label: string; command?: string; msg?: FromSettings } }
  /** The outcome of one 'set' / 'reset' write, so the page says "Saved" only once VS Code wrote it and puts the control back when it refused. */
  | { type: 'saved'; id?: number; key: string; ok: boolean; error?: string }
  | { type: 'pickedFolder'; key: string; name?: string; path: string }
  | { type: 'customize'; data: CustomizeData }
  | { type: 'otlpTest'; ok: boolean; status?: number; url: string; error?: string }
  | { type: 'redisTest'; ok: boolean; info?: RedisPingInfo; error?: string }
  | { type: 'mcpCatalog'; entries: McpCatalogEntry[]; registry: boolean; loading?: boolean; error?: string; installed?: string };

type FromSettings =
  | { type: 'ready' }
  | { type: 'clientError'; where: string; message: string; stack?: string }
  | { type: 'set'; key: string; value: unknown; scope: 'user' | 'workspace'; id?: number }
  | { type: 'reset'; key: string; scope: 'user' | 'workspace'; id?: number }
  | { type: 'test'; provider: ProviderConfig }
  | { type: 'probe' }
  | { type: 'refreshModels' }
  | { type: 'loadModels' }
  | { type: 'installModel'; target: InstallTarget; model: string }
  | { type: 'gallerySearch'; source?: string; q?: string; capability?: string; sort?: string; page?: number }
  | { type: 'galleryTags'; source?: string; name: string }
  | { type: 'skillSearch'; q?: string }
  | { type: 'refreshSkillRegistry' }
  | { type: 'installRegistrySkill'; name: string; repo: string; scope?: 'user' | 'workspace' }
  | { type: 'removeSkill'; name: string }
  | { type: 'toggleSkill'; name: string; enabled: boolean }
  | { type: 'openSkill'; name: string }
  | { type: 'removeModel'; target: InstallTarget; model: string; providerId: string; name?: string }
  | { type: 'toggleModel'; id: string; enabled: boolean }
  | { type: 'cancelJob'; id: string }
  | { type: 'clearJobs' }
  | { type: 'autoSetup'; installRuntime?: boolean; target?: InstallTarget }
  | { type: 'startRuntime'; target: InstallTarget }
  | { type: 'command'; id: string; args?: unknown[] }
  | { type: 'deleteNote'; name: string; scope: 'project' | 'global' }
  | { type: 'openNote'; name: string; scope: 'project' | 'global' }
  | { type: 'leaveSetup' }
  | { type: 'finishSetup'; model?: string; approvals?: 'safe' | 'balanced' | 'autonomous'; inlineCompletion?: boolean; providers?: ProviderConfig[] }
  | { type: 'openExternal'; url: string }
  | { type: 'pickFolder'; key: string; name?: string }
  | { type: 'restartMcp'; name: string }
  | { type: 'toggleMcp'; name: string; enabled: boolean }
  | { type: 'authMcp'; name: string }
  | { type: 'mcpCatalog'; refresh?: boolean }
  | { type: 'installMcpCatalog'; id: string }
  /** includeDisabled counts providers that are disabled or no longer configured; providers narrows to those ids. */
  | { type: 'dashboard'; days?: number; includeDisabled?: boolean; providers?: string[] }
  | { type: 'applyTune'; role: string; model: string }
  | { type: 'retune' }
  | { type: 'undoTune'; role: string }
  | { type: 'logs'; level?: string; q?: string; follow?: boolean }
  /** range: raw events of the last `days` days; csv: the summary tables for that range; all: everything recorded. */
  | { type: 'exportTelemetry'; scope?: 'range' | 'csv' | 'all'; days?: number }
  | { type: 'clearTelemetry' }
  | { type: 'openLogFile' }
  | { type: 'openTelemetryFolder' }
  /** Opens `.localpilot/checks.json`, created from a template when missing. */
  | { type: 'openChecksJson' }
  /** Re-reads the detected checks for the Agent → Self-healing block. */
  | { type: 'loadChecks' }
  /** A Human Intervention Queue action; `id` is the intervention. */
  | { type: 'recoveryAction'; sessionId: string; action: RecoveryActionKind; id?: string }
  /** Failure memory: "Don't suggest again" (allowed false) or "Suggest again". */
  | { type: 'memoryReuse'; id: string; allowed: boolean }
  /** "Open diff" on an applied patch. */
  | { type: 'openRecoveryDiff'; sessionId: string; attempt: number; file: string }
  | { type: 'testOtlp' }
  | { type: 'testRedis' }
  | { type: 'loadCustomize' }
  | { type: 'customToggle'; kind: CustomKind; file: string; enabled: boolean }
  | { type: 'customOpen'; kind: CustomKind; file: string }
  | { type: 'customDelete'; kind: CustomKind; file: string }
  | { type: 'customCreate'; kind: CustomKind; name: string; scope: 'global' | 'workspace' };

/** Keys (relative to `localpilot.`) that the UI may read and write. Anything else is rejected. */
const SETTING_KEYS = [
  'providers', 'defaultModel', 'contextWindow', 'maxOutputTokens', 'temperature', 'thinking', 'keepAlive', 'prewarm', 'ollama.flashAttention', 'ollama.kvCacheType', 'prompts.autoCorrect', 'compactionThreshold', 'compaction.strategy', 'maxToolOutputChars',
  'approvals.terminal', 'approvals.write', 'approvals.delete', 'approvals.network', 'approvals.mcp', 'approvals.dangerousAlwaysAsk', 'notifications', 'parallel.maxConcurrency', 'parallel.maxSubagentDepth', 'autoClarify', 'clarify.questions', 'worktrees.mode', 'worktrees.location',
  'diffPreview', 'editTool', 'edit.reportNewErrors', 'checkpoints.enabled',
  'webSearch.enabled', 'webSearch.provider', 'webSearch.searxngUrl', 'webSearch.apiKey', 'webSearch.maxResults',
  'inlineCompletion.enabled', 'inlineCompletion.model', 'inlineCompletion.debounceMs', 'inlineCompletion.maxTokens',
  'mcpServers', 'skillsPaths', 'skills.builtin', 'skills.repositories', 'skills.autoInstall', 'skills.autoInstallScope', 'skills.disabled', 'memory.enabled', 'sessions.retention', 'systemPromptAppend', 'showWelcomeOnStartup', 'chat.location', 'terminal.runInIntegratedTerminal', 'terminal.reveal',
  'terminal.profile', 'terminal.shellIntegrationTimeout', 'terminal.autoDetachSeconds', 'memory.autoSave', 'history.includeCli', 'preferredLanguage', 'showTips', 'plugins.marketplaces', 'repos', 'mcp.watchServerFiles',
  'models.disabled', 'models.autoSetup', 'routing.enabled', 'routing.vision', 'routing.reasoning', 'routing.fast', 'routing.coding', 'routing.parallelModels', 'models.autoTune', 'colibri.path', 'colibri.model', 'colibri.port', 'colibri.kvSlots', 'colibri.modelsDir', 'colibri.backend', 'telemetry.enabled', 'telemetry.retentionDays',
  'storage.sessionsInMemory', 'storage.redis.enabled', 'storage.redis.url',
  'telemetry.otlp.enabled', 'telemetry.otlp.endpoint', 'telemetry.otlp.headers', 'telemetry.otlp.metricsInterval', 'telemetry.otlp.exporters', 'telemetry.otlp.traceSamplePercent', 'telemetry.otlp.recordContent',
  'pluginPaths', 'hooks.enabled', 'browser.chromePath',
  'memory.maxNoteChars', 'memory.maxNotes', 'autoMode.enabled', 'autoMode.model', 'queue.concurrency', 'supervisor.enabled', 'supervisor.intervalSeconds', 'supervisor.autoInstall', 'gateways.litellmConfig',
  'maxConsecutiveMistakes', 'disabledTools',
  'markdownViewer.scrollSync', 'markdownViewer.outlineDepth', 'markdownViewer.frontMatter', 'markdownViewer.mermaid', 'markdownViewer.exportTheme',
  'pdfViewer.pageColors', 'pdfViewer.sidebar', 'pdfViewer.defaultZoom', 'pdfViewer.rangeThresholdMB', 'pdfViewer.maxFileSizeMB', 'pdf.maxReadSizeMB', 'pdf.maxChars',
  'healing.enabled', 'healing.autoDetect', 'healing.autoRetry', 'healing.autoFix', 'healing.regressionRequired', 'healing.maxRepairAttempts', 'healing.maxTotalAttempts', 'healing.extraSteps', 'healing.taskDeadlineMinutes',
  'healing.checkTiming', 'healing.scopeTests', 'healing.checkTimeoutSeconds', 'healing.checkTimeBudgetSeconds', 'healing.baseline', 'healing.checks', 'healing.policies', 'healing.dependencyInstall', 'healing.gitConflicts',
  'healing.securityCheck', 'healing.delegateFixes', 'healing.memory',
] as const;

/** Commands the webview is allowed to trigger. */
const ALLOWED_COMMANDS = new Set([
  'localpilot.openChat', 'localpilot.newSession', 'localpilot.openMemory', 'localpilot.clearMemory', 'localpilot.clearHistory', 'localpilot.showSessions', 'localpilot.reloadSkills', 'localpilot.showLogs', 'localpilot.installCli',
  'localpilot.refreshModels', 'localpilot.openWelcome', 'localpilot.openSettings', 'localpilot.openMarkdownViewer', 'localpilot.openPdf', 'localpilot.openTerminal', 'workbench.action.openSettingsJson', 'workbench.action.openWorkspaceSettingsFile',
  'workbench.action.openWalkthrough', 'workbench.action.openSettings', 'localpilot.autoSetupModels', 'localpilot.installModel', 'localpilot.removeModel', 'localpilot.manageModels', 'localpilot.browseModelGallery',
  'localpilot.createSkill', 'localpilot.dismissSkillTopic', 'localpilot.installSkill', 'localpilot.browseSkills', 'localpilot.manageSkills',
  'localpilot.editMcpConfig', 'localpilot.setupRedis', 'localpilot.telemetry.testOtlp', 'localpilot.startColibri', 'localpilot.stopColibri', 'localpilot.startGateway', 'localpilot.stopGateway',
  'localpilot.selectTerminalProfile', 'localpilot.browsePlugins', 'localpilot.managePlugins', 'workbench.action.reloadWindow', 'localpilot.setProviderApiKey',
]);

const PRESETS: Record<'safe' | 'balanced' | 'autonomous', Record<'terminal' | 'write' | 'delete' | 'network' | 'mcp', 'ask' | 'always' | 'never'>> = {
  safe: { terminal: 'ask', write: 'ask', delete: 'ask', network: 'ask', mcp: 'ask' },
  balanced: { terminal: 'ask', write: 'always', delete: 'ask', network: 'always', mcp: 'always' },
  autonomous: { terminal: 'always', write: 'always', delete: 'ask', network: 'always', mcp: 'always' },
};

export const WELCOMED_KEY = 'localpilot.welcomed';

/** OTLP export as the extension resolved it: whether it runs, the setting that keeps it off, and the OTEL_* variables that override Settings. */
export interface OtlpStatus {
  enabled: boolean;
  offBecause?: string;
  endpoint?: string;
  fromEnv: string[];
}

/** The tuning report as the dashboard gets it: changes applied from the dashboard are marked `manual`. */
type DashboardTuning = Omit<TuneReport, 'history'> & { history: (TuneReport['history'][number] & { manual?: boolean })[] };
const tuneRoleLabel = (role: string) => TUNE_LABELS[role as TuneRole] ?? role;
const shortModel = (id: string) => id.slice(id.indexOf('/') + 1);
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
  /** Usage-based model tuning shown on the dashboard. */
  tuner?: ModelTuner;
  /** Skill registry (configured repositories), set by the extension host. */
  catalog?: SkillCatalog;
  /** Called after a rule, command or hook file was switched, created or deleted (drops the hosts' caches). */
  onCustomized?: () => void;
  /** Bytes held by chat checkpoints (file snapshots and git objects only checkpoint refs keep), for Memory & history. */
  checkpointBytes?: () => Promise<number>;
  /** Self-healing & recovery dashboard for the last `days` days (store states joined with telemetry). */
  recoveryDashboard?: (days: number) => Promise<RecoveryDashboard>;
  /** Runs a Human Intervention Queue action and audits it like the chat card does; `acceptRisk` arrives only after the
   *  panel's modal confirmation. false: not done. */
  onRecoveryAction?: (sessionId: string, action: RecoveryActionKind, interventionId?: string) => Promise<boolean | void>;
  /** Switches a failure-memory entry's suggestions off or on again; false when the entry is gone. */
  onMemoryReuse?: (id: string, allowed: boolean) => Promise<boolean>;
  /** Opens an applied patch as a diff: the snapshot in the attempt's directory against the current file. */
  openRecoveryDiff?: (sessionId: string, attempt: number, file: string) => Promise<void>;
  /** Detected checks for the Settings page; defaults to the first workspace folder's view. */
  loadChecks?: () => Promise<HealingView>;
  /** Opens `.localpilot/checks.json`; defaults to creating it from a template in the first workspace folder. */
  openChecks?: () => Promise<void>;
  private panel?: vscode.WebviewPanel;
  private page: SettingsPage = 'settings';
  private section?: SettingsSection;
  /** A deep link from the chat: the setting to scroll to (`key`) or the provider card to open (`expand`); sent once. */
  private focus?: { key?: string; expand?: string };
  private navigate = false;
  private pushSeq = 0;
  private modelsLoaded = false;
  private modelsRefresh?: ReturnType<typeof setTimeout>;
  private jobsTimer?: ReturnType<typeof setTimeout>;
  private readonly registries = createGalleryRegistries();
  private readonly gallerySearchAbort = new Map<GallerySource, AbortController>();
  private readonly disposables: vscode.Disposable[] = [];
  /** Dashboard log viewer is open with "follow" on: new lines are streamed to it. */
  private following = false;
  /** The last dashboard Apply per role, for the toast's Undo (this window only). */
  private readonly tuneUndo = new Map<string, TuneSuggestion>();
  /** Role settings the user applied from the dashboard, so its change list can tell them from automatic ones. */
  private readonly manualTunes = new Map<string, string>();
  private _mcpCatalog?: McpCatalogService;
  private get mcpCatalog(): McpCatalogService {
    return (this._mcpCatalog ??= new McpCatalogService(this.ctx.extensionUri, this.log));
  }

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
    private readonly running: () => string[] = () => [],
    /** Local metrics + log mirror behind the Dashboard page. */
    private readonly telemetry?: Telemetry,
    /** Moves API keys typed into a provider card into VS Code secret storage. */
    private readonly secrets?: ProviderSecrets,
    /** Registered built-in tools, for the Tools on/off list (MCP tools are managed per server). */
    private readonly toolCatalog: () => { name: string; description: string }[] = () => [],
    /** Sends one test record to the OTLP collector with the current settings (Settings → Telemetry → Test connection). */
    private readonly otlpTest?: () => Promise<{ status?: number; url: string; error?: string }>,
    private readonly otlpStatus?: () => OtlpStatus
  ) {
    if (telemetry) {
      const off = telemetry.onLog((entry) => {
        if (this.panel && this.following && this.panel.visible) {
          this.post({ type: 'logLine', entry });
        }
      });
      this.disposables.push(new vscode.Disposable(off));
    }
    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('localpilot') && this.panel) {
          void this.pushState();
        }
        if (e.affectsConfiguration('localpilot.skills.repositories') && this.panel && this.catalog) {
          void this.catalog
            .refresh()
            .then(() => this.pushSkillRegistry(this.skillQuery))
            .catch((err) => this.log.warn(`skill registry: ${String(err)}`));
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

  show(page: SettingsPage = 'settings', section?: SettingsSection, focus?: { key?: string; expand?: string }): void {
    this.page = page;
    this.section = section;
    this.focus = focus?.key || focus?.expand ? focus : undefined;
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
      if (this.page === 'setup') {
        void this.ctx.globalState.update(WELCOMED_KEY, true);
      }
      this.panel = undefined;
      this.following = false;
      Object.values(this.registries).forEach((r) => r.clearCache());
      this.modelsLoaded = false;
    });
  }

  private title(): string {
    return this.page === 'setup' ? 'Welcome to LocalPilot' : 'LocalPilot Settings';
  }

  private post(m: ToSettings): void {
    // Rejects once the panel is disposed (a coalesced jobs/models refresh can fire after close); nothing to do about it.
    this.panel?.webview.postMessage(m).then(undefined, () => undefined);
  }

  // ------------------------------------------------------------------ messages
  private async handle(m: FromSettings): Promise<void> {
    switch (m.type) {
      case 'clientError':
        this.log.error(`settings webview (${m.where}): ${m.message}${m.stack ? `\n${m.stack}` : ''}`);
        return;
      case 'ready':
        this.navigate = true;
        return this.pushState();
      case 'set':
      case 'reset': {
        try {
          await this.update(m.key, m.type === 'set' ? m.value : undefined, m.scope);
        } catch (e) {
          const error = e instanceof Error ? e.message : String(e);
          this.log.warn(`settings: ${m.key} not saved: ${error}`);
          return this.post({ type: 'saved', id: m.id, key: m.key, ok: false, error });
        }
        this.post({ type: 'saved', id: m.id, key: m.key, ok: true });
        if (m.type === 'set' && m.key === 'history.includeCli') {
          this.post({ type: 'toast', level: 'info', text: 'Reload the window to update chat history', action: { label: 'Reload window', command: 'workbench.action.reloadWindow' } });
        }
        return;
      }
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
        void this.models.pull(m.target, m.model, this.runtimeProvider(m.target)).then(
          (job) => {
            if (job.status === 'done') {
              this.post({ type: 'toast', level: 'info', text: `${job.model} installed` });
            } else if (job.status === 'error') {
              this.post({ type: 'toast', level: 'error', text: `Install failed: ${job.error}` });
            }
          },
          (e: unknown) => this.post({ type: 'toast', level: 'error', text: `Install failed: ${e instanceof Error ? e.message : String(e)}` })
        );
        return;
      case 'gallerySearch':
        return this.gallerySearch(m);
      case 'skillSearch':
        return this.pushSkillRegistry(String(m.q ?? ''));
      case 'refreshSkillRegistry': {
        if (!this.catalog) {
          return;
        }
        this.post({ type: 'busy', busy: true });
        try {
          await this.catalog.refresh(true);
        } finally {
          this.post({ type: 'busy', busy: false });
        }
        return this.pushSkillRegistry(this.skillQuery);
      }
      case 'installRegistrySkill':
        return this.installRegistrySkill(m.name, m.repo, m.scope);
      case 'removeSkill':
        return this.removeSkill(m.name);
      case 'loadCustomize':
      case 'customToggle':
      case 'customOpen':
      case 'customDelete':
      case 'customCreate':
        return this.customize(m);
      case 'toggleSkill': {
        const skill = this.skills.getSkill(m.name);
        if (!skill) {
          throw new Error(`Unknown skill "${m.name}"`);
        }
        if (!m.enabled && skill.alwaysEnabled) {
          throw new Error(`“${skill.name}” is always on: your organization requires it`);
        }
        await setSkillEnabled(skill.name, !!m.enabled);
        await this.skills.refresh();
        this.post({ type: 'toast', level: 'info', text: m.enabled ? `“${skill.name}” enabled` : `“${skill.name}” disabled — the agent no longer sees it` });
        return this.pushState();
      }
      case 'openSkill': {
        const skill = this.skills.getSkill(m.name);
        if (!skill) {
          throw new Error(`Unknown skill "${m.name}"`);
        }
        await vscode.window.showTextDocument(vscode.Uri.file(skill.path), { preview: true });
        return;
      }
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
        void this.models.remove(m.target, m.model, m.providerId).then(async (job) => {
          if (job.status === 'done') {
            // The manager already refreshed discovery and showed the notification; repaint the page from the fresh list
            // right away rather than waiting for the debounced change listeners.
            await this.pushState();
            await this.pushModels();
          } else if (job.status === 'error') {
            this.post({ type: 'toast', level: 'error', text: job.error ?? 'Remove failed' });
            void vscode.window.showErrorMessage(`Could not delete ${label}: ${job.error ?? 'unknown error'}`);
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
      case 'leaveSetup':
        await this.ctx.globalState.update(WELCOMED_KEY, true);
        this.page = 'settings';
        if (this.panel) {
          this.panel.title = this.title();
        }
        return;
      case 'restartMcp':
        if (!(await this.mcp.restart(m.name))) {
          const st = this.mcp.status.find((x) => x.name === m.name);
          this.post({ type: 'toast', level: 'error', text: `${m.name}: ${st?.error ?? 'could not be started'}` });
        }
        return;
      case 'toggleMcp':
        await this.mcp.setEnabled(m.name, m.enabled).catch((e) => this.post({ type: 'toast', level: 'error', text: e instanceof Error ? e.message : String(e) }));
        return;
      case 'authMcp':
        await vscode.commands.executeCommand('localpilot.authenticateMcpServer', m.name);
        return;
      case 'mcpCatalog': {
        if (m.refresh) {
          this.post({ type: 'mcpCatalog', ...(await this.mcpCatalog.entries()), loading: true });
          await this.mcpCatalog.refreshRegistry().catch(() => undefined);
        }
        this.post({ type: 'mcpCatalog', ...(await this.mcpCatalog.entries()) });
        return;
      }
      case 'installMcpCatalog': {
        const entry = await this.mcpCatalog.find(m.id);
        if (!entry) {
          throw new Error(`“${m.id}” is not in the catalog`);
        }
        let name: string | undefined;
        try {
          name = await installCatalogServer(entry, [...Object.keys(getConfig().mcpServers ?? {}), ...this.mcp.status.map((s) => s.name)], this.secrets);
          if (name) {
            this.post({ type: 'toast', level: 'info', text: installedMessage(name) });
            await this.mcp.reload();
          }
        } finally {
          // Also after a cancel or an error: the card stops showing "Installing…".
          this.post({ type: 'mcpCatalog', ...(await this.mcpCatalog.entries()), installed: name });
        }
        return;
      }
      case 'pickFolder': {
        if (!(SETTING_KEYS as readonly string[]).includes(m.key)) {
          throw new Error(`Unknown setting: ${m.key}`);
        }
        const picked = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, canSelectMany: false, defaultUri: vscode.workspace.workspaceFolders?.[0]?.uri, openLabel: 'Select folder' });
        if (picked?.[0]) {
          this.post({ type: 'pickedFolder', key: m.key, name: m.name, path: picked[0].fsPath });
        }
        return;
      }
      case 'openExternal':
        if (/^https?:\/\//i.test(m.url)) {
          await vscode.env.openExternal(vscode.Uri.parse(m.url));
        }
        return;
      case 'dashboard':
        this.dashFilter = { includeDisabled: !!m.includeDisabled, providers: Array.isArray(m.providers) ? m.providers.filter((p) => typeof p === 'string') : [] };
        return this.pushDashboard(m.days);
      case 'testOtlp': {
        if (!this.otlpTest) {
          return this.post({ type: 'otlpTest', ok: false, url: '', error: 'OTLP export is not available here' });
        }
        const r = await this.otlpTest().catch((e: unknown) => ({ status: undefined, url: '', error: e instanceof Error ? e.message : String(e) }));
        this.log.info(r.error === undefined ? `OTLP test: HTTP ${r.status} from ${r.url}` : `OTLP test to ${r.url} failed: ${r.error}`);
        return this.post({ type: 'otlpTest', ok: r.error === undefined, status: r.status, url: r.url, error: r.error });
      }
      case 'testRedis': {
        const url = getConfig().storage.redis.url;
        const r = await pingRedis(url);
        this.log.info(r.ok ? `Redis test: ${redactRedisUrl(url)} answered in ${r.info?.latencyMs} ms` : `Redis test to ${redactRedisUrl(url)} failed: ${r.error}`);
        return this.post({ type: 'redisTest', ok: r.ok, info: r.info, error: r.error });
      }
      case 'applyTune': {
        // The row reports the outcome in place of its button; the toast names the change and offers Undo.
        const sug = this.tuner ? (await this.tuner.suggestions().catch(() => [])).find((x) => x.role === m.role && x.suggested === m.model) : undefined;
        const applied = this.tuner ? await this.tuner.applyFromDashboard(m.role, m.model).then((ok) => (ok ? '' : 'No longer applies: the numbers changed'), (e: unknown) => (e instanceof Error ? e.message : String(e))) : 'Model tuning is not available in this window';
        this.post({ type: 'tuneResult', role: m.role, model: m.model, ok: !applied, error: applied || undefined });
        if (!applied && sug) {
          this.tuneUndo.set(m.role, { ...sug, kind: 'setting' });
          this.manualTunes.set(sug.setting, m.model);
          this.post({ type: 'toast', level: 'info', text: `${tuneRoleLabel(m.role)} now uses ${shortModel(m.model)}`, action: { label: 'Undo', msg: { type: 'undoTune', role: m.role } } });
        }
        return this.pushDashboard();
      }
      case 'undoTune': {
        const sug = this.tuneUndo.get(m.role);
        if (!sug || !this.tuner) {
          return this.post({ type: 'toast', level: 'warn', text: 'Nothing to undo: that change was made in another window or is already undone' });
        }
        this.tuneUndo.delete(m.role);
        // The tuner restores the value it recorded before the write, and leaves a setting changed again since alone.
        await this.tuner.undo([sug]);
        const now = vscode.workspace.getConfiguration('localpilot').inspect<string>(sug.setting)?.globalValue;
        if (now !== sug.suggested) {
          this.manualTunes.delete(sug.setting);
          this.post({ type: 'toast', level: 'info', text: `${tuneRoleLabel(m.role)} is back to ${now ? shortModel(now) : 'Auto'}` });
        }
        return this.pushDashboard();
      }
      case 'retune': {
        if (!this.tuner) {
          return this.post({ type: 'toast', level: 'error', text: 'Model tuning is not available in this window' });
        }
        const usage = await this.tuner.refresh(true);
        const open = (await this.tuner.suggestions().catch(() => [])).length;
        const runs = `Analysed ${usage.runs} run${usage.runs === 1 ? '' : 's'}`;
        this.post({ type: 'toast', level: 'info', text: open ? `${runs}: ${open} suggestion${open === 1 ? '' : 's'}` : `${runs}: no better picks found` });
        // autoApply waits on any notification it offers, so the toast above goes out first.
        await this.tuner.autoApply();
        return this.pushDashboard();
      }
      case 'logs': {
        if (typeof m.follow === 'boolean') {
          this.following = m.follow;
        }
        const level = (['trace', 'debug', 'info', 'warn', 'error'] as const).find((l) => l === m.level);
        return this.post({ type: 'logs', entries: this.telemetry?.logs({ level, q: m.q || undefined }) ?? [], level, q: m.q || undefined });
      }
      case 'exportTelemetry':
        return this.exportTelemetry(m.scope ?? 'all', typeof m.days === 'number' ? m.days : this.lastDashboardDays);
      case 'clearTelemetry': {
        if (!this.telemetry) {
          return;
        }
        const pick = await vscode.window.showWarningMessage('Delete all recorded LocalPilot metrics and log files on this machine?', { modal: true, detail: await this.clearDetail() }, 'Delete');
        if (pick !== 'Delete') {
          return;
        }
        const r = await this.telemetry.clear();
        if (r.remoteError) {
          this.post({ type: 'toast', level: 'error', text: `Local files deleted, but the Redis store could not be reached, so the data stored there was not deleted (${r.remoteError}). Run Delete again when Redis is up.` });
        } else {
          this.post({ type: 'toast', level: 'info', text: 'Telemetry cleared' });
        }
        return this.pushDashboard();
      }
      case 'openLogFile': {
        if (!this.telemetry) {
          return;
        }
        await this.telemetry.flush();
        // With Redis storage on, log lines go to Redis instead of the daily file.
        const remote = this.telemetry.activeRemote();
        if (remote) {
          try {
            const lines = await remote.recentLogs(2000);
            const doc = await vscode.workspace.openTextDocument({ content: lines.join('\n') + '\n', language: 'log' });
            await vscode.window.showTextDocument(doc, { preview: false });
            return;
          } catch {
            // fall back to the file
          }
        }
        try {
          await vscode.window.showTextDocument(vscode.Uri.file(this.telemetry.logFile()), { preview: false });
        } catch {
          this.post({ type: 'toast', level: 'error', text: 'No log file has been written today yet' });
        }
        return;
      }
      case 'openChecksJson':
        return this.openChecks ? this.openChecks().then(() => this.pushChecks()) : this.openChecksJson();
      case 'loadChecks':
        return this.pushChecks();
      case 'recoveryAction':
        return handleRecoveryAction(m, this.recoveryHooks(), (t) => this.post(t), () => this.pushDashboard());
      case 'memoryReuse':
        return handleMemoryReuse(m, this.recoveryHooks(), (t) => this.post(t), () => this.pushDashboard());
      case 'openRecoveryDiff':
        return handleOpenRecoveryDiff(m, this.recoveryHooks(), (t) => this.post(t));
      case 'openTelemetryFolder':
        if (this.telemetry) {
          await fs.mkdir(this.telemetry.dir, { recursive: true });
          await vscode.env.openExternal(vscode.Uri.file(this.telemetry.dir));
        }
        return;
    }
  }

  private recoveryHooks(): RecoveryHooks {
    return {
      onRecoveryAction: this.onRecoveryAction,
      onMemoryReuse: this.onMemoryReuse,
      openRecoveryDiff: this.openRecoveryDiff,
      confirmRisk: async () => (await vscode.window.showWarningMessage('Accept this security risk? It is recorded in the audit log.', { modal: true }, 'Accept risk')) === 'Accept risk',
    };
  }

  private lastDashboardDays = 7;
  /** Enabled provider ids from the CLI config, so its model calls count on the dashboard too. */
  private healingView(): Promise<HealingView> {
    if (this.loadChecks) {
      return this.loadChecks();
    }
    const i = vscode.workspace.getConfiguration('localpilot').inspect<unknown>('healing.checks');
    return buildHealingView(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath, { user: i?.globalValue, workspace: i?.workspaceValue ?? i?.workspaceFolderValue }, vscode.workspace.isTrusted);
  }

  private async pushChecks(): Promise<void> {
    try {
      this.post({ type: 'healingChecks', healing: await this.healingView() });
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      this.log.warn(`self-healing checks: ${error}`);
      this.post({ type: 'healingChecks', error });
    }
  }

  private async openChecksJson(): Promise<void> {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) {
      this.post({ type: 'toast', level: 'error', text: 'Open a folder first: checks.json belongs to a workspace' });
      return;
    }
    const { file, created } = await ensureChecksJson(root);
    await vscode.window.showTextDocument(vscode.Uri.file(file), { preview: false });
    if (!vscode.workspace.isTrusted) {
      this.post({ type: 'toast', level: 'warn', text: 'This workspace is not trusted: .localpilot/checks.json is ignored until you trust it' });
    } else if (created) {
      this.post({ type: 'toast', level: 'info', text: 'Created .localpilot/checks.json' });
    }
    return this.pushState();
  }

  private async cliProviderIds(): Promise<string[]> {
    try {
      const cfg = JSON.parse(await fs.readFile(path.join(os.homedir(), '.localpilot', 'config.json'), 'utf8')) as Record<string, unknown>;
      const list = Array.isArray(cfg.providers) ? cfg.providers : Array.isArray(cfg['localpilot.providers']) ? cfg['localpilot.providers'] : [];
      return (list as { id?: unknown; enabled?: unknown }[]).filter((p) => p && typeof p.id === 'string' && p.enabled !== false).map((p) => p.id as string);
    } catch {
      return [];
    }
  }
  /** The dashboard's provider filter, as the page last asked for it (also used by the CSV export). */
  private dashFilter: { includeDisabled: boolean; providers: string[] } = { includeDisabled: false, providers: [] };
  /** Providers that are configured and enabled right now, in VS Code or in the CLI's ~/.localpilot/config.json. */
  private async enabledProviderIds(): Promise<string[]> {
    return [...new Set([...getConfig().providers.map((p) => p.id), ...(await this.cliProviderIds())])];
  }
  /** The summary filter for the current dashboard choice: enabled providers only unless the page includes the others. */
  private dashProviders(enabled: string[]): string[] | undefined {
    const { includeDisabled, providers } = this.dashFilter;
    return providers.length ? providers : includeDisabled ? undefined : enabled;
  }
  private async pushDashboard(days = this.lastDashboardDays): Promise<void> {
    this.lastDashboardDays = days;
    const { includeDisabled, providers: picked } = this.dashFilter;
    // Recovery comes from the RecoveryStore, so it loads alongside (and without) telemetry.
    const recovery = loadRecovery(this.recoveryDashboard, days).then((x) => ({ ...x, recoveryDiff: !!this.openRecoveryDiff }));
    if (!this.telemetry) {
      return this.post({ type: 'dashboard', days, error: 'Telemetry is not available in this window', includeDisabled, providers: picked, ...(await recovery) });
    }
    try {
      // By default only enabled providers count: disabling one hides its history, and providers that tests or old
      // configs made up never show. The page says how many were left out and can include them.
      const enabled = await this.enabledProviderIds();
      const known = new Set(enabled);
      const hidden = new Map<string, number>();
      const countHidden = this.telemetry.eachEvent(days, (batch) => {
        for (const e of batch) {
          if (e.type === 'model' && !known.has(e.provider)) {
            hidden.set(e.provider, (hidden.get(e.provider) ?? 0) + 1);
          }
        }
      });
      const [summary, report] = await Promise.all([this.telemetry.summary(days, { providers: this.dashProviders(enabled) }), this.tuner?.report().catch(() => undefined), countHidden]);
      const tuning = report && { ...report, history: report.history.map((h) => ({ ...h, manual: this.manualTunes.get(h.setting) === h.value || undefined })) };
      const hiddenProviders = [...hidden].map(([id, calls]) => ({ id, calls })).sort((a, b) => b.calls - a.calls);
      const allProviders = [...enabled, ...(includeDisabled ? hiddenProviders.map((h) => h.id) : [])];
      this.post({ type: 'dashboard', days, summary, logFile: this.telemetry.logFile(), tuning, hiddenProviders, allProviders, includeDisabled, providers: picked, ...(await recovery) });
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      this.log.warn(`Dashboard metrics failed: ${error}`);
      this.post({ type: 'dashboard', days, error, includeDisabled, providers: picked, ...(await recovery) });
    }
  }

  /** Export… on the dashboard: raw events of the range or of everything as JSON, or the range's summary tables as CSV. */
  private async exportTelemetry(scope: 'range' | 'csv' | 'all', days: number): Promise<void> {
    const telemetry = this.telemetry;
    if (!telemetry) {
      return;
    }
    const csv = scope === 'csv';
    const span = scope === 'all' || days <= 0 ? '' : `-${days}d`;
    const name = `localpilot-${csv ? 'summary' : 'telemetry'}-${new Date().toISOString().slice(0, 10)}${span}.${csv ? 'csv' : 'json'}`;
    const target = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(path.join(os.homedir(), name)),
      filters: csv ? { CSV: ['csv'] } : { JSON: ['json'] },
      title: csv ? 'Export LocalPilot usage summary' : scope === 'range' && days > 0 ? `Export LocalPilot telemetry (last ${days} day${days === 1 ? '' : 's'})` : 'Export LocalPilot telemetry',
    });
    if (!target) {
      return;
    }
    let n = 0;
    try {
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Exporting LocalPilot ${csv ? 'usage summary' : 'telemetry'}…` }, async () => {
        if (csv) {
          const summary = await telemetry.summary(days, { providers: this.dashProviders(await this.enabledProviderIds()) });
          n = summary.storage.events;
          return vscode.workspace.fs.writeFile(target, Buffer.from(summaryCsv(summary), 'utf8'));
        }
        const range = scope === 'range' ? days : 0;
        if (range <= 0 && target.scheme === 'file') {
          n = await telemetry.exportTo(target.fsPath);
          return;
        }
        // Collected batch by batch; the range is usually small, and remote targets take one buffer anyway.
        const events: string[] = [];
        await telemetry.eachEvent(range, (batch) => {
          for (const e of batch) {
            events.push(JSON.stringify(e));
          }
        });
        n = events.length;
        const head = `{\n "exportedAt": ${JSON.stringify(new Date().toISOString())},\n "dir": ${JSON.stringify(telemetry.dir)},${range > 0 ? `\n "days": ${range},` : ''}\n "events": [`;
        const body = `${head}${events.map((e, i) => `${i ? ',' : ''}\n  ${e}`).join('')}\n ],\n "logs": ${JSON.stringify(telemetry.logs({ limit: Infinity }))}\n}\n`;
        await vscode.workspace.fs.writeFile(target, Buffer.from(body, 'utf8'));
      });
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      this.log.warn(`Telemetry export to ${target.fsPath} failed: ${error}`);
      return void vscode.window.showErrorMessage(`Could not export telemetry: ${error}`);
    }
    const size = await vscode.workspace.fs.stat(target).then((st) => formatBytes(st.size), () => '');
    const what = csv ? `Exported the summary of ${n} event${n === 1 ? '' : 's'}` : `Exported ${n} event${n === 1 ? '' : 's'}`;
    const reveal = process.platform === 'darwin' ? 'Reveal in Finder' : process.platform === 'win32' ? 'Reveal in File Explorer' : 'Open Containing Folder';
    const actions = target.scheme === 'file' ? [reveal, 'Open'] : ['Open'];
    const pick = await vscode.window.showInformationMessage(`${what}${size ? ` (${size})` : ''}`, ...actions);
    if (pick === reveal) {
      await vscode.commands.executeCommand('revealFileInOS', target);
    } else if (pick === 'Open') {
      await vscode.commands.executeCommand('vscode.open', target);
    }
  }

  /** "Deletes 1,204 events and 9 files (3.1 MB) since 2 Oct 2026, and the Redis streams at 127.0.0.1:6379." */
  private async clearDetail(): Promise<string | undefined> {
    const st = await this.telemetry?.summary(0, { providers: [] }).then((s) => s.storage, () => undefined);
    if (!st) {
      return undefined;
    }
    const redis = getConfig().storage.redis;
    let host = '';
    if (redis.enabled) {
      try {
        host = new URL(redis.url).host;
      } catch {
        host = 'the configured server';
      }
    }
    const since = st.oldest ? ` since ${new Date(st.oldest).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}` : '';
    return `Deletes ${st.events.toLocaleString()} event${st.events === 1 ? '' : 's'} and ${st.files} file${st.files === 1 ? '' : 's'} (${formatBytes(st.bytes)})${since}${host ? `, and the Redis streams at ${host}` : ''}. This cannot be undone.`;
  }

  private async update(key: string, value: unknown, scope: 'user' | 'workspace'): Promise<void> {
    if (!(SETTING_KEYS as readonly string[]).includes(key)) {
      throw new Error(`Unknown setting: ${key}`);
    }
    if (isUserOnlySetting(key)) {
      scope = 'user';
    }
    if (scope === 'workspace' && !vscode.workspace.workspaceFolders?.length) {
      throw new Error('Open a folder to use workspace settings');
    }
    // The page disables these controls already; refuse here too so a stale page cannot write past the policy.
    const locks = value === undefined ? undefined : policyLocks(getManagedPolicy(this.log));
    const lockedWhy = locks?.locked[key] ?? (locks?.disabledOptions[key]?.includes(String(value)) ? 'Your organization requires approval here' : undefined);
    if (lockedWhy) {
      throw new Error(`Managed by your organization: ${lockedWhy}`);
    }
    let clean = key === 'providers' && Array.isArray(value) ? value.map((p) => sanitizeProvider(p as ProviderConfig)) : key === 'mcpServers' && value !== undefined ? sanitizeMcpServers(value) : value;
    if (key === 'providers' && Array.isArray(clean) && this.secrets) {
      // A pasted key goes to the OS keychain; settings.json keeps a `${secret:<id>}` reference.
      clean = await this.secrets.protect(clean as ProviderConfig[], scope);
    }
    if (key === 'webSearch.apiKey' && typeof clean === 'string' && clean.trim() && !clean.includes('${') && this.secrets) {
      clean = await this.secrets.store('websearch', clean.trim(), scope);
    }
    const cfg = vscode.workspace.getConfiguration('localpilot');
    // Only keys this write stops referencing may be deleted, never ones another window's settings still use.
    const own = key === 'providers' ? cfg.inspect<ProviderConfig[]>('providers') : undefined;
    const before = ((scope === 'user' ? own?.globalValue : own?.workspaceValue) ?? []).flatMap((p) => secretRefs(p?.apiKey));
    await cfg.update(key, clean, scope === 'user' ? vscode.ConfigurationTarget.Global : vscode.ConfigurationTarget.Workspace);
    this.log.info(`settings: ${key} ${clean === undefined ? 'reset' : 'updated'} (${scope})`);
    if (key === 'providers') {
      await this.secrets?.prune(undefined, before);
    }
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

  // ------------------------------------------------------------------ skills gallery
  private skillQuery = '';

  /** Registry entries ranked for `q` (all of them, popular repositories first, when empty) with the installed state of each. */
  private async pushSkillRegistry(q: string): Promise<void> {
    this.skillQuery = q;
    if (!this.catalog) {
      this.post({ type: 'skillRegistry', q, entries: [], status: [], refreshing: false });
      return;
    }
    const [status, ready] = await Promise.all([this.catalog.status(), this.catalog.ready()]);
    const installed = new Map(this.skills.allSkills.map((s) => [s.name, s.source]));
    const decorate = (e: CatalogEntry): RegistrySkill => ({ ...e, installed: installed.has(e.name), installedSource: installed.get(e.name) });
    let entries: RegistrySkill[];
    if (q.trim()) {
      entries = (await this.catalog.search(q, 40)).map(decorate);
    } else {
      // No query: the whole registry, one entry per name, in repository order (the order that wins on conflicts).
      const seen = new Set<string>();
      entries = (await this.catalog.entries()).filter((e) => !seen.has(e.name) && seen.add(e.name)).map(decorate);
    }
    this.post({ type: 'skillRegistry', q, entries, status, refreshing: !ready });
    // A first visit with no index yet: fetch it and push again.
    if (!ready) {
      void this.catalog
        .refresh()
        .then(() => (this.skillQuery === q ? this.pushSkillRegistry(q) : undefined))
        .catch((e) => this.log.warn(`skill registry: ${String(e)}`));
    }
  }

  private async installRegistrySkill(name: string, repo: string, scope?: 'user' | 'workspace'): Promise<void> {
    const entries = this.catalog ? await this.catalog.entries() : [];
    const entry = entries.find((e) => e.name === name && e.repo === repo) ?? entries.find((e) => e.name === name);
    if (!this.catalog || !entry) {
      this.post({ type: 'skillJob', name, status: 'error', detail: 'no longer in the skill registry' });
      this.post({ type: 'toast', level: 'error', text: `Could not install “${name}”: it is no longer in the skill registry` });
      await this.pushSkillRegistry(this.skillQuery);
      return;
    }
    const dest = skillsDestination(scope ?? getConfig().skillAutoInstallScope, vscode.workspace.workspaceFolders?.[0]?.uri.fsPath);
    this.post({ type: 'skillJob', name: entry.name, status: 'running', detail: `Installing from ${entry.repo}…` });
    try {
      const one = await this.catalog.install(entry, dest, { replace: true, timeoutMs: 60_000, progress: (t) => this.post({ type: 'skillJob', name: entry.name, status: 'running', detail: t }) });
      await this.skills.refresh();
      if (!one) {
        throw new Error('nothing was installed');
      }
      // A skill that was disabled before being reinstalled stays disabled; a fresh install is enabled.
      this.post({ type: 'skillJob', name: entry.name, status: 'done', detail: one.dir });
      this.post({ type: 'toast', level: 'info', text: `Installed “${one.name}” into ${dest}` });
      this.log.info(`skill registry: installed "${one.name}" from ${entry.repo} into ${one.dir}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.post({ type: 'skillJob', name: entry.name, status: 'error', detail: msg });
      this.post({ type: 'toast', level: 'error', text: `Could not install “${entry.name}”: ${msg}` });
    }
    await this.pushState();
    await this.pushSkillRegistry(this.skillQuery);
  }

  // ------------------------------------------------------------------ customize (rules, commands, hooks, plugins)
  private async customize(m: Extract<FromSettings, { type: 'loadCustomize' | 'customToggle' | 'customOpen' | 'customDelete' | 'customCreate' }>): Promise<void> {
    const roots = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
    const pluginDirs = getConfig().pluginPaths;
    const KIND: Record<CustomKind, string> = { rule: 'rule', command: 'command', hook: 'hook', plugin: 'plugin' };
    if (m.type !== 'loadCustomize' && !(m.kind in KIND)) {
      throw new Error(`Unknown kind: ${String(m.kind)}`);
    }
    const list = () => listCustomizations(roots, os.homedir(), { pluginDirs });
    const changed = async () => {
      this.onCustomized?.();
      this.post({ type: 'customize', data: await list() });
    };
    switch (m.type) {
      case 'loadCustomize':
        return this.post({ type: 'customize', data: await list() });
      case 'customToggle':
        try {
          await setItemEnabled(m.kind, m.file, !!m.enabled, roots, os.homedir(), pluginDirs);
        } catch (e) {
          await changed();
          throw e instanceof FrontMatterError ? new Error(`${path.basename(m.file)} was not changed: ${e.message} Fix it in the editor, or add "disabled: true" yourself.`) : e;
        }
        this.post({ type: 'toast', level: 'info', text: m.enabled ? `${path.basename(m.file)} enabled` : m.kind === 'hook' ? `${path.basename(m.file)} disabled — it no longer runs` : `${path.basename(m.file)} disabled — the agent no longer sees it` });
        return changed();
      case 'customOpen': {
        const data = await list();
        const all = [...data.rules, ...data.commands, ...data.hooks, ...data.plugins];
        if (!all.some((i) => i.kind === m.kind && path.resolve(i.file) === path.resolve(m.file))) {
          throw new Error(`Not a listed ${KIND[m.kind]}: ${m.file}`);
        }
        // A plugin is a folder: open its manifest.
        const file = m.kind === 'plugin' ? path.join(m.file, '.claude-plugin', 'plugin.json') : m.file;
        await vscode.window.showTextDocument(vscode.Uri.file(file), { preview: false });
        return;
      }
      case 'customDelete': {
        const what = m.kind === 'plugin' ? `the plugin ${path.basename(m.file)} and its folder` : `the ${KIND[m.kind]} ${path.basename(m.file)}`;
        const ok = await vscode.window.showWarningMessage(`Delete ${what}?`, { modal: true, detail: `Removes ${m.file} from disk.` }, 'Delete');
        if (ok !== 'Delete') {
          return;
        }
        await deleteItem(m.kind, m.file, roots, os.homedir(), pluginDirs);
        this.post({ type: 'toast', level: 'info', text: `Deleted ${path.basename(m.file)}` });
        return changed();
      }
      case 'customCreate': {
        const r = await createItem(m.kind, String(m.name ?? ''), m.scope === 'global' ? 'global' : 'workspace', roots);
        await vscode.window.showTextDocument(vscode.Uri.file(r.file), { preview: false });
        if (!r.created) {
          this.post({ type: 'toast', level: 'info', text: `${path.basename(r.file)} already exists — opened it` });
        } else if (m.kind === 'hook') {
          this.post({ type: 'toast', level: 'info', text: `${path.basename(r.file)} created switched off — edit it, then switch it on to run it` });
        }
        return changed();
      }
    }
  }

  private async removeSkill(name: string): Promise<void> {
    const skill = this.skills.getSkill(name);
    if (!skill) {
      throw new Error(`Unknown skill "${name}"`);
    }
    if (skill.source === 'managed') {
      throw new Error(`“${skill.name}” is provided by your organization and cannot be deleted here`);
    }
    if (skill.source === 'builtin') {
      throw new Error('Bundled skills cannot be deleted — disable them instead');
    }
    // Webviews cannot show confirm(); the host asks.
    const ok = await vscode.window.showWarningMessage(`Delete the skill “${skill.name}”?`, { modal: true, detail: `Removes ${skill.dir} from disk. You can install it again from the registry.` }, 'Delete');
    if (ok !== 'Delete') {
      return;
    }
    await fs.rm(skill.dir, { recursive: true, force: true });
    await setSkillEnabled(skill.name, true);
    await this.skills.refresh();
    this.post({ type: 'toast', level: 'info', text: `Deleted “${skill.name}”` });
    await this.pushState();
    await this.pushSkillRegistry(this.skillQuery);
  }

  private async finishSetup(m: Extract<FromSettings, { type: 'finishSetup' }>): Promise<void> {
    const cfg = vscode.workspace.getConfiguration('localpilot');
    let model = m.model;
    if (m.providers?.length) {
      // Merge: keep everything the user already configured, add newly detected servers (unique ids, known cloud flags).
      const { list, target } = editableProviders();
      const existing = list.map(sanitizeProvider);
      const effective = cfg.get<ProviderConfig[]>('providers', DEFAULT_PROVIDERS);
      const known = new Set([...existing, ...effective].map((p) => endpointKey(p.baseUrl)));
      const taken = new Set([...existing, ...effective].map((p) => p.id));
      const added: ProviderConfig[] = [];
      for (const p of m.providers.map(sanitizeProvider)) {
        if (known.has(endpointKey(p.baseUrl))) {
          continue;
        }
        known.add(endpointKey(p.baseUrl));
        let id = p.id;
        for (let n = 2; taken.has(id); n++) {
          id = `${p.id.replace(/-\d+$/, '')}-${n}`;
        }
        taken.add(id);
        if (id !== p.id && model?.startsWith(`${p.id}/`)) {
          model = `${id}/${model.slice(p.id.length + 1)}`;
        }
        const cloud = KNOWN_ENDPOINTS.find((k) => k.cloud && endpointKey(k.baseUrl) === endpointKey(p.baseUrl));
        added.push({ ...p, id, ...(cloud ? { cloud: true } : {}) });
      }
      if (added.length) {
        await cfg.update('providers', [...existing, ...added], target);
      }
    }
    if (model && model !== cfg.get<string>('defaultModel')) {
      await cfg.update('defaultModel', model, vscode.ConfigurationTarget.Global);
    }
    if (m.approvals) {
      // Values the organisation locks or forbids are left as they are, as the Settings preset buttons do.
      const locks = policyLocks(getManagedPolicy(this.log));
      for (const [k, v] of Object.entries(PRESETS[m.approvals])) {
        if (locks && (locks.locked[`approvals.${k}`] || locks.disabledOptions[`approvals.${k}`]?.includes(v))) {
          continue;
        }
        if (cfg.get<string>(`approvals.${k}`) !== v) {
          await cfg.update(`approvals.${k}`, v, vscode.ConfigurationTarget.Global);
        }
      }
    }
    if (typeof m.inlineCompletion === 'boolean' && m.inlineCompletion !== cfg.get<boolean>('inlineCompletion.enabled')) {
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
    return target === 'ollama' ? providers.find((p) => p.type === 'ollama' && !isRemoteUrl(p.baseUrl))?.id : target === 'docker' ? providers.find((p) => /:12434\//.test(p.baseUrl) || p.id === 'docker')?.id : providers.find((p) => /:1234\//.test(p.baseUrl) || p.id === 'lmstudio')?.id;
  }

  /** Builds the model-manager view: machine profile, runtimes, installed models with roles, catalog and jobs. */
  async modelsState(): Promise<ModelsState> {
    const [system, runtimes, all] = await Promise.all([getSystemProfile(), this.models.detectRuntimes(), this.providers.listAllModels().catch(() => [] as ModelInfo[])]);
    const enabled = all.filter((m) => !m.disabled);
    // Plan mode keeps the session model unless `routing.reasoning` is set, so there is no "auto" reasoning pick to show.
    const auto = { agent: pickForRole(enabled, 'agent', system)?.id, completion: pickForRole(enabled, 'completion', system)?.id, vision: pickForRole(enabled, 'vision', system)?.id, fast: pickForRole(enabled, 'fast', system)?.id };
    const installed: ManagedModel[] = all.map((m) => {
      // A cloud model takes no memory here: no size and no "fits" badge, which would only mislead.
      const gb = m.remote ? undefined : modelFootprintGb(m);
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

  /** Re-sends the panel state (when open), e.g. after chats were deleted outside the panel. */
  refresh(): void {
    void this.pushState();
  }

  private async pushState(): Promise<void> {
    if (!this.panel) {
      return;
    }
    const seq = ++this.pushSeq;
    const models = await this.providers.listAllModels().catch(() => []);
    const notes = await this.memory.list().catch(() => []);
    const learning = await this.learner?.usage(this.skills.enabledSkills).catch(() => undefined);
    const stats = await this.store.stats().catch(() => ({ count: this.store.list().length, bytes: 0, messages: 0 }));
    const checkpointBytes = this.page === 'settings' ? await this.checkpointBytes?.().catch(() => undefined) : undefined;
    const missingPaths = this.page === 'settings' ? await missingFolders().catch(() => []) : [];
    const healing = this.page === 'settings' ? await this.healingView().catch((e) => { this.log.warn(`self-healing checks: ${e instanceof Error ? e.message : String(e)}`); return undefined; }) : undefined;
    // A newer push started while this one awaited: only the newest snapshot may reach the webview.
    if (seq !== this.pushSeq) {
      return;
    }
    const cfg = vscode.workspace.getConfiguration('localpilot');
    const settings: Record<string, SettingEntry> = {};
    for (const key of SETTING_KEYS) {
      const i = cfg.inspect<unknown>(key);
      const scope = i?.workspaceValue !== undefined || i?.workspaceFolderValue !== undefined ? 'workspace' : i?.globalValue !== undefined ? 'user' : 'default';
      settings[key] = { value: cfg.get(key), default: i?.defaultValue, scope, userValue: i?.globalValue, workspaceValue: i?.workspaceValue ?? i?.workspaceFolderValue };
    }
    this.post({
      type: 'state',
      page: this.page,
      section: this.section,
      ...(this.focus ? { focusKey: this.focus.key, expand: this.focus.expand } : {}),
      // Only an explicit show()/ready moves the webview; refreshes after a settings change leave the user where they are.
      navigate: this.navigate,
      version: String((this.ctx.extension.packageJSON as { version?: string }).version ?? ''),
      hasWorkspace: !!vscode.workspace.workspaceFolders?.length,
      settings,
      models,
      // Key source and presence per provider, so cards can say "key in keychain" or "OPENAI_API_KEY not set".
      keys: Object.fromEntries(mergeManagedProviders(cfg.get<ProviderConfig[]>('providers', []) ?? [], getManagedPolicy(this.log)).map((p) => [p.id, keyStatus(p)])),
      skills: this.skills.allSkills.map((s) => ({ name: s.name, description: s.description, source: s.source, used: learning?.skillUse[s.name]?.count, disabled: s.disabled, alwaysEnabled: s.alwaysEnabled, dir: s.dir, removable: s.source !== 'builtin' && s.source !== 'managed' })),
      learning: { recurring: learning?.recurring ?? [] },
      agents: this.skills.allAgents.map((a) => ({ name: a.name, description: a.description, source: a.source })),
      tools: (() => {
        const off = getConfig().disabledTools;
        return this.toolCatalog().filter((t) => !t.name.startsWith('mcp_')).sort((a, b) => a.name.localeCompare(b.name)).map((t) => ({ ...t, off: toolDisabled(t.name, off) }));
      })(),
      mcp: this.mcp.status,
      managed: (() => { const p = getManagedPolicy(this.log); return p.source ? { source: p.source, message: p.message, lines: describePolicy(p) } : undefined; })(),
      // Per control: what Settings shows locked (keys, approval floors, allowlists, the organisation's providers and servers).
      policy: (() => { const p = getManagedPolicy(this.log); const locks = policyLocks(p); return locks && { ...locks, effective: policyEffectiveValues(p, getConfig()) }; })(),
      memory: { project: notes.filter((n) => n.scope === 'project').length, global: notes.filter((n) => n.scope === 'global').length, notes: notes.slice(0, 200).map((n) => ({ name: n.name, scope: n.scope, summary: n.summary, updatedAt: n.updatedAt, chars: n.chars })) },
      sessions: { ...stats, checkpointBytes, running: this.running().length, pinned: this.store.list().filter((x) => x.pinned).length },
      welcomed: !!this.ctx.globalState.get(WELCOMED_KEY),
      otlp: this.otlpStatus?.(),
      terminalProfiles: profileNames(vscode.workspace.getConfiguration('terminal.integrated').get<Record<string, TerminalProfileEntry | null>>(`profiles.${profileOsKey()}`)),
      autoRepos: (() => {
        try {
          return listRepos(undefined, (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath)).flatMap((r) => (r.source === 'setting' ? [] : [{ name: r.name, path: r.path, source: r.source }]));
        } catch {
          return [];
        }
      })(),
      settingsMeta: { missingPaths },
      healing,
    });
    this.section = undefined;
    this.focus = undefined;
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
<div id="toasts" role="status" aria-live="polite"></div>
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

/** Entries of skillsPaths, pluginPaths and repos that do not exist (after `~` and workspace-relative expansion), for the "not found" badges. */
async function missingFolders(): Promise<string[]> {
  const cfg = vscode.workspace.getConfiguration('localpilot');
  const strings = (v: unknown) => (Array.isArray(v) ? v : []).filter((x): x is string => typeof x === 'string' && !!x.trim());
  const entries = [...new Set([...strings(cfg.get('skillsPaths')), ...strings(cfg.get('pluginPaths')), ...strings(Object.values(cfg.get<Record<string, unknown>>('repos') ?? {}))])];
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const home = os.homedir();
  const missing = await Promise.all(
    entries.map(async (p) => {
      const t = p.trim().replace(/^~(?=$|[\\/])/, home);
      if (!path.isAbsolute(t) && !root) {
        return undefined;
      }
      const ok = await fs.stat(path.isAbsolute(t) ? t : path.join(root!, t)).then(() => true, () => false);
      return ok ? undefined : p;
    })
  );
  return missing.filter((x): x is string => !!x);
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
    const url = String(c.url ?? '').trim();
    if (!name || (!command && !url)) {
      throw new Error(`MCP server "${rawName || '?'}" needs a name and a command (local) or a URL (remote)`);
    }
    if (url && !/^https?:\/\//i.test(url)) {
      throw new Error(`MCP server "${name}": the URL must start with http:// or https://`);
    }
    const entry: McpServerConfig = url ? { url } : { command };
    if (url && (c.type === 'http' || c.type === 'sse' || c.type === 'streamableHttp' || c.type === 'streamable-http')) {
      entry.type = c.type;
    }
    if (url && c.headers && typeof c.headers === 'object' && !Array.isArray(c.headers)) {
      const h = Object.fromEntries(Object.entries(c.headers).map(([k, v]) => [k.trim(), String(v)]).filter(([k]) => k));
      if (Object.keys(h).length) {
        entry.headers = h;
      }
    }
    if (!url && Array.isArray(c.args) && c.args.length) {
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
    // Fields the form does not edit (set in settings.json) survive a save from the form.
    if (typeof c.timeout === 'number' && Number.isFinite(c.timeout) && c.timeout > 0) {
      entry.timeout = Math.min(3600, Math.max(1, c.timeout));
    }
    if (Array.isArray(c.autoApprove)) {
      const tools = c.autoApprove.filter((t): t is string => typeof t === 'string' && !!t.trim()).map((t) => t.trim());
      if (tools.length) {
        entry.autoApprove = [...new Set(tools)];
      }
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

/** Kept under its old name for the settings tests and callers. */
export const sanitizeProvider = sanitizeProviderConfig;

/** The dashboard's model, tool and mode tables as one CSV: each table under its own header row, a blank line between. */
export function summaryCsv(s: TelemetrySummary): string {
  const cell = (v: unknown): string => {
    const t = v === undefined || v === null ? '' : typeof v === 'number' ? String(Math.round(v * 10000) / 10000) : String(v);
    return /[",\n\r]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
  };
  const iso = (t: number): string => (t ? new Date(t).toISOString() : '');
  const table = (head: string[], rows: unknown[][]): string => [head, ...rows].map((r) => r.map(cell).join(',')).join('\r\n');
  return [
    table(['model', 'provider', 'calls', 'errors', 'prompt_tokens', 'completion_tokens', 'cost_usd', 'tokens_per_sec', 'ttft_p50_ms', 'duration_p50_ms', 'duration_p95_ms', 'last_used'],
      s.models.map((m) => [m.model, m.provider, m.calls, m.errors, m.promptTokens, m.completionTokens, m.costUsd, m.tokPerSec, m.ttft.p50, m.duration.p50, m.duration.p95, iso(m.last)])),
    table(['tool', 'calls', 'errors', 'cached', 'duration_p50_ms', 'duration_p95_ms', 'last_used'],
      s.tools.map((t) => [t.name, t.calls, t.errors, t.cached, t.duration.p50, t.duration.p95, iso(t.last)])),
    table(['mode', 'runs', 'done', 'stopped', 'failed', 'tool_calls', 'duration_p50_ms', 'duration_p95_ms', 'steps_p50'],
      s.modes.map((m) => [m.mode, m.runs, m.done, m.stopped, m.failed, m.toolCalls, m.duration.p50, m.duration.p95, m.steps.p50])),
  ].join('\r\n\r\n') + '\r\n';
}
