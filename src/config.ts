import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { DEFAULT_SKILL_REPOSITORIES } from './agent/skillCatalog';
import { ApprovalMode, ProviderConfig, TerminalApprovalMode, ThinkingLevel } from './types';
import { DEFAULT_PROVIDERS } from './providers/defaultProviders';
import { expandHome } from './providers/colibriSetup';
import { VSCODE_LM_BASE_URL } from './providers/vscodeLmMessages';
import type { OtlpSettings } from './telemetry/otlp';
import { parseHealingConfig } from './healingSettings';
import { getManagedPolicy, mergeManagedProviders, policyRedis, policyTelemetry } from './agent/managedPolicy';
import { workspaceGrant } from './agent/workspaceApprovals';

export interface WebSearchConfig {
  provider: 'duckduckgo' | 'searxng' | 'brave' | 'tavily';
  searxngUrl?: string;
  apiKey?: string;
  maxResults: number;
}

export interface McpServerConfig {
  /** Local server: the program to start (stdio). */
  command?: string;
  /** Remote server: its endpoint (Streamable HTTP, or legacy HTTP+SSE for a URL ending in /sse or type "sse"). */
  url?: string;
  /** `stdio`, `http` or `sse`; inferred from command/url when omitted (Claude Code's `.mcp.json` uses the same names). */
  type?: 'stdio' | 'http' | 'sse' | 'streamable-http' | 'streamableHttp';
  /** Request headers for remote servers, e.g. `{ "Authorization": "Bearer ${env:GITHUB_TOKEN}" }`. */
  headers?: Record<string, string>;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  enabled?: boolean;
  /** Seconds a tool call may take before it fails. */
  timeout?: number;
  /** Tool names (as the server names them) called without asking. */
  autoApprove?: string[];
  /** A pre-registered OAuth client for a remote server; without one LocalPilot registers itself dynamically. */
  oauthClient?: { clientId: string; clientSecret?: string };
}

export interface RoutingConfig {
  /** Pick a model per task automatically: vision model for image turns, FIM model for completions, fallback when the default is offline. */
  enabled: boolean;
  /** Model for turns with images (empty = best available vision model). */
  vision?: string;
  /** Model for reasoning-heavy Plan mode (empty = keep the session model). */
  reasoning?: string;
  /** Model for read-only subagents — explore, clarifier, researcher (empty = auto: smallest tool-capable model that fits; 'session' keeps the session model). */
  fast?: string;
  /** Model for implementing subagents — coder, tester, debugger, docs (empty = keep the session model). */
  coding?: string;
  /** Spread simultaneous runs over comparable idle models when the intended one is saturated (Auto picks and inherited worker models only). */
  parallelModels?: boolean;
  /** Models tried in this order when the chosen one is unavailable, before the automatic best fit (User settings only). */
  fallbackModels?: string[];
}

/** Per MCP server, per tool (as the server names it): always run, always ask, or refuse. Unlisted tools follow `approvals.mcp`. */
export type McpToolApprovals = Record<string, Record<string, 'always' | 'ask' | 'never'>>;

export type HealingCheckKind = 'build' | 'typecheck' | 'lint' | 'test' | 'security' | 'custom';

/** A project check from `localpilot.healing.checks` (overrides or adds to the discovered ones). */
export interface HealingCheckSetting {
  id?: string;
  kind: HealingCheckKind;
  command: string;
  cwd?: string;
  scoped?: string;
  timeoutSeconds?: number;
  required?: boolean;
  when?: string[];
}

/** Per-category override from `localpilot.healing.policies`, already clamped to the category's safety maximum. */
export interface HealingPolicySetting {
  attempts?: number;
  backoffMs?: number[];
  timeoutSeconds?: number;
}

/** Self-healing engine settings (`localpilot.healing.*`). */
export interface HealingConfig {
  enabled: boolean;
  autoDetect: boolean;
  autoRetry: boolean;
  autoFix: boolean;
  regressionRequired: boolean;
  maxRepairAttempts: number;
  maxTotalAttempts: number;
  extraSteps: number;
  /** Recovery deadline counted from the first detected failure, only while a recovery is active; 0 = none. */
  taskDeadlineMinutes: number;
  checkTiming: 'onComplete' | 'afterEdits';
  scopeTests: boolean;
  checkTimeoutSeconds: number;
  checkTimeBudgetSeconds: number;
  baseline: 'fast' | 'all' | 'off';
  checks: HealingCheckSetting[];
  policies: Record<string, HealingPolicySetting>;
  dependencyInstall: 'ask' | 'never';
  gitConflicts: 'escalate';
  securityCheck: 'changed' | 'full' | 'off';
  delegateFixes: boolean;
  memory: 'workspace' | 'project' | 'off';
}

export interface LocalPilotConfig {
  providers: ProviderConfig[];
  defaultModel: string;
  /** Requested context window in tokens, capped by the model; 0 = the model's full native window. */
  contextWindow: number;
  maxOutputTokens: number;
  /** Sampling temperature for agent turns; undefined = the model's own default (its Modelfile / server setting). */
  temperature?: number;
  compactionThreshold: number; // 0..1 fraction of context before compaction
  /** Rotate short feature tips in the chat's status row while the agent thinks. */
  showTips: boolean;
  /** How a full context is compacted: a model-written summary, a deterministic digest without a model call, or not at all. */
  compactionStrategy: 'agentic' | 'basic' | 'off';
  /** Tools that need the internet (web_search, web_fetch, browser_*) are offered and @url mentions fetched. */
  webEnabled: boolean;
  /** Language the agent answers in; `auto` adds no instruction. */
  preferredLanguage: string;
  maxToolOutputChars: number;
  /** Tool steps in a row that may all fail before the run stops and asks for guidance; 0 = no limit. */
  maxConsecutiveMistakes: number;
  /** Self-healing: detect, classify, fix and re-check failures within budgets. */
  healing: HealingConfig;
  /** Tools never offered to the model: our names, Claude Code / Cline names, or globs (`mcp_*`, `browser_*`). */
  disabledTools: string[];
  /** File-editing tool offered to the model: `auto` gives GPT/Codex/gpt-oss models apply_patch and others edit_file. */
  editTool: 'auto' | 'edit_file' | 'apply_patch';
  /** Side-by-side diff of a proposed edit: while its approval is pending, for every edit, or never. */
  diffPreview: 'onApproval' | 'always' | 'off';
  approvals: { terminal: TerminalApprovalMode; write: ApprovalMode; delete: ApprovalMode; network: ApprovalMode; mcp: ApprovalMode };
  /** A destructive-looking command asks even when `approvals.terminal` is `always`. */
  dangerousAlwaysAsk: boolean;
  /** Native notification when a run finishes or an auto-approved command runs long: only while the chat is hidden, always, or never. */
  notifications: 'whenHidden' | 'always' | 'off';
  parallel: { maxConcurrency: number; maxSubagentDepth: number };
  /** Task queue: how many queued tasks run at once (1 = one after another). */
  queue: { concurrency: number };
  /** Auto mode: approvals set to "ask" go to a local reviewer model; it approves safe actions and sends the rest to the user. */
  autoMode: { enabled: boolean; model: string };
  /** Keep local services (Ollama, Redis) running; optionally install Ollama unattended when no model server exists. */
  supervisor: { enabled: boolean; intervalSeconds: number; autoInstall: boolean };
  worktrees: { mode: 'always' | 'parallel' | 'off'; location?: string };
  /** Local-only usage metrics and log mirror shown on the dashboard. Nothing is sent anywhere. */
  telemetry: { enabled: boolean; retentionDays: number; /** Opt-in OTLP/HTTP JSON export to the user's own collector. */ otlp: OtlpSettings };
  /** Memory footprint: chat transcripts kept in RAM, and the optional Redis Stack store for telemetry. */
  storage: { sessionsInMemory: number; redis: { enabled: boolean; url: string } };
  webSearch: WebSearchConfig;
  inlineCompletion: { enabled: boolean; model?: string; debounceMs: number; maxTokens: number };
  mcpServers: Record<string, McpServerConfig>;
  /** Restart a stdio server when its workspace script (a .js/.py file, or a file under build/ or dist/) changes. */
  mcpWatchServerFiles: boolean;
  /** Per-tool MCP approvals set in Settings → MCP servers (User settings only); they override the server's autoApprove list. */
  mcpToolApprovals: McpToolApprovals;
  /** Seconds to wait for a model's first token before the request counts as stalled (0 = no limit). */
  firstTokenTimeoutSeconds: number;
  /** Extra repositories the agent can work across, name → path (besides the workspace folders and .localpilot/repos.json). */
  repos: Record<string, string>;
  skillsPaths: string[];
  /** Extra folders scanned for Claude Code-style plugins (`.claude-plugin/plugin.json`). */
  pluginPaths: string[];
  /** Plugin marketplaces to search and install from: `owner/repo`, a git URL or a local folder with .claude-plugin/marketplace.json. */
  pluginMarketplaces: string[];
  /** Run the hooks configured in settings.json (PreToolUse, PostToolUse, Stop, …). */
  hooksEnabled: boolean;
  /** Take a git checkpoint (private ref) before each user turn; file snapshots are kept either way. */
  checkpointsEnabled: boolean;
  builtinSkills: boolean;
  /** Repositories (owner/repo[/path]) whose skills can be installed automatically when a request matches one. */
  skillRepositories: string[];
  /** Install a matching catalog skill without asking, offer it as a chip, or never. */
  skillAutoInstall: 'auto' | 'ask' | 'off';
  /** Where automatically installed skills land: the user's ~/.localpilot/skills or the workspace's .localpilot/skills. */
  skillAutoInstallScope: 'user' | 'workspace';
  /** Skill names hidden from the agent (not in the prompt, not loadable, not suggested) while staying on disk. */
  skillsDisabled: string[];
  thinking: ThinkingLevel;
  /** When the agent asks questions first: new/vague/large work (smart), every build task with a plan to confirm (interview), or only when stuck (minimal). */
  clarify: 'smart' | 'interview' | 'minimal';
  memoryEnabled: boolean;
  /** After a substantial run, save the durable facts it revealed (build/test commands, conventions, pitfalls) to project memory. */
  memoryAutoSave: boolean;
  /** Caps that keep memory from growing without bound: characters per note and notes per scope. */
  memoryLimits: { maxNoteChars: number; maxNotes: number };
  /** Max idle (unpinned) chats kept on disk; 0 = unlimited. */
  sessionRetention: number;
  /** List the CLI's chats for the same folder in VS Code's history (`localpilot.history.includeCli`). */
  historyIncludeCli: boolean;
  keepAlive: string;
  /** Load the chat's model when the composer is focused so the first token is not preceded by a weight load. */
  prewarm: boolean;
  /** Server settings applied when LocalPilot starts or restarts Ollama (it cannot change a server started elsewhere). */
  ollama: { flashAttention: boolean; kvCacheType: 'f16' | 'q8_0' | 'q4_0' };
  /** Correct misspelled file names and identifiers in requests against the workspace before the agent sees them. */
  autoCorrectPrompts: boolean;
  systemPromptAppend: string;
  showWelcomeOnStartup: boolean;
  /** Agent terminal: how long to wait for shell integration (ms) and the `terminal.integrated.profiles` entry to use ('default' = VS Code's). */
  terminal: { runInIntegratedTerminal: boolean; reveal: boolean; shellIntegrationTimeout: number; profile: string; autoDetachSeconds: number };
  /** After edit_file/write_file/apply_patch, append new Error diagnostics of the edited file to the tool result. */
  edit: { reportNewErrors: boolean };
  /** `provider/model` ids hidden from pickers and routing. */
  disabledModels: string[];
  /** Offer to install Ollama + a starter model when no local model is found. */
  autoSetupModels: boolean;
  /** Detect vague requests and give the agent a workspace snapshot to resolve them before acting. */
  autoClarify: boolean;
  /** Learn from local usage which installed models work best per role: apply them (auto), offer them (suggest) or neither (off). */
  autoTune: 'auto' | 'suggest' | 'off';
  /** colibri (experts streamed from disk): checkout folder, model and port for `LocalPilot: Start colibri`. */
  colibri: { path?: string; model?: string; port: number; kvSlots: number; modelsDir?: string; backend: 'auto' | 'cpu' | 'vulkan' | 'cuda' };
  routing: RoutingConfig;
  /** Reading PDFs (read_pdf, read_file and attachments): the largest file in MB and the most characters per read. */
  pdf: { maxReadSizeMB: number; maxChars: number };
  /** Markdown reader: scroll sync with the source, outline depth (h2–h6), how front matter shows, Mermaid diagrams. */
  markdownViewer: { scrollSync: boolean; outlineDepth: number; frontMatter: 'collapsed' | 'expanded' | 'hidden'; mermaid: boolean; exportTheme: 'light' | 'match' };
  /** PDF viewer: page colours, sidebar, initial zoom, and the sizes (MB) above which files load by range or need a confirmation. */
  pdfViewer: { pageColors: 'auto' | 'original' | 'dark' | 'sepia'; sidebar: 'auto' | 'outline' | 'thumbnails' | 'hidden'; defaultZoom: 'auto' | 'page-width' | 'page-fit' | 'page-actual'; rangeThresholdMB: number; maxFileSizeMB: number };
}

const SECTION = 'localpilot';

export { DEFAULT_PROVIDERS };

/** The providers list to edit and where to save it: arrays do not merge across scopes, so edits go back to the scope that defines the list. */
export function providerScope(i: { globalValue?: ProviderConfig[]; workspaceValue?: ProviderConfig[]; workspaceFolderValue?: ProviderConfig[] } | undefined): { list: ProviderConfig[]; target: vscode.ConfigurationTarget } {
  if (i?.workspaceFolderValue) {
    return { list: [...i.workspaceFolderValue], target: vscode.ConfigurationTarget.WorkspaceFolder };
  }
  if (i?.workspaceValue) {
    return { list: [...i.workspaceValue], target: vscode.ConfigurationTarget.Workspace };
  }
  return { list: [...(i?.globalValue ?? DEFAULT_PROVIDERS)], target: vscode.ConfigurationTarget.Global };
}

export function editableProviders(): { list: ProviderConfig[]; target: vscode.ConfigurationTarget } {
  return providerScope(vscode.workspace.getConfiguration(SECTION).inspect<ProviderConfig[]>('providers'));
}

export function getConfig(): LocalPilotConfig {
  const c = vscode.workspace.getConfiguration(SECTION);
  // Organisation policy: its providers are merged in (locked), its telemetry policy overrides the user's.
  const org = getManagedPolicy();
  const providers = mergeManagedProviders(c.get<ProviderConfig[]>('providers', DEFAULT_PROVIDERS), org)
    .filter((p) => p.enabled !== false)
    // VS Code's language models have no server URL to configure.
    .map((p) => (p.type === 'vscode-lm' && !p.baseUrl ? { ...p, baseUrl: VSCODE_LM_BASE_URL } : p));
  const maxConcurrency = Math.floor(Number(c.get<number>('parallel.maxConcurrency', 4)));
  return {
    providers,
    defaultModel: c.get<string>('defaultModel', ''),
    contextWindow: Math.max(0, Math.floor(c.get<number>('contextWindow', 32768))),
    maxOutputTokens: c.get<number>('maxOutputTokens', 4096),
    // Negative (the default, -1) means: send none, so each model samples as its makers tuned it.
    temperature: (() => { const t = c.get<number>('temperature', -1); return typeof t === 'number' && t >= 0 ? Math.min(2, t) : undefined; })(),
    compactionThreshold: c.get<number>('compactionThreshold', 0.75),
    showTips: c.get<boolean>('showTips', true),
    compactionStrategy: (['agentic', 'basic', 'off'] as const).find((m) => m === c.get<string>('compaction.strategy', 'agentic')) ?? 'agentic',
    webEnabled: c.get<boolean>('webSearch.enabled', true) !== false,
    preferredLanguage: (c.get<string>('preferredLanguage', 'auto') ?? 'auto').trim() || 'auto',
    maxToolOutputChars: c.get<number>('maxToolOutputChars', 24000),
    maxConsecutiveMistakes: (() => { const n = Number(c.get<number>('maxConsecutiveMistakes', 6)); return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 6; })(),
    healing: parseHealingConfig(<T>(key: string, def: T) => c.get<T>(key, def) as T),
    disabledTools: (c.get<string[]>('disabledTools', []) ?? []).filter((t) => typeof t === 'string' && t.trim()).map((t) => t.trim()),
    editTool: (['auto', 'edit_file', 'apply_patch'] as const).find((m) => m === c.get<string>('editTool', 'auto')) ?? 'auto',
    diffPreview: (['onApproval', 'always', 'off'] as const).find((m) => m === c.get<string>('diffPreview', 'onApproval')) ?? 'onApproval',
    approvals: {
      // "Always allow in this workspace" (per-workspace extension state) wins over the User value.
      terminal: workspaceGrant('terminal') ?? (['always', 'safe', 'ask', 'never'] as const).find((m) => m === c.get<string>('approvals.terminal', 'ask')) ?? 'ask',
      write: workspaceGrant('write') ?? c.get<ApprovalMode>('approvals.write', 'always'),
      delete: workspaceGrant('delete') ?? c.get<ApprovalMode>('approvals.delete', 'ask'),
      network: workspaceGrant('network') ?? c.get<ApprovalMode>('approvals.network', 'always'),
      mcp: workspaceGrant('mcp') ?? c.get<ApprovalMode>('approvals.mcp', 'always'),
    },
    dangerousAlwaysAsk: c.get<boolean>('approvals.dangerousAlwaysAsk', true) !== false,
    notifications: (['whenHidden', 'always', 'off'] as const).find((m) => m === c.get<string>('notifications', 'whenHidden')) ?? 'whenHidden',
    worktrees: {
      mode: (['always', 'parallel', 'off'] as const).find((m) => m === c.get<string>('worktrees.mode', 'always')) ?? 'always',
      location: homePath(c.get<string>('worktrees.location', '')),
    },
    telemetry: policyTelemetry(org, {
      enabled: c.get<boolean>('telemetry.enabled', true),
      retentionDays: Math.max(0, Math.floor(c.get<number>('telemetry.retentionDays', 30))),
      otlp: {
        enabled: c.get<boolean>('telemetry.otlp.enabled', false) === true,
        endpoint: c.get<string>('telemetry.otlp.endpoint', 'http://localhost:4318') || 'http://localhost:4318',
        headers: c.get<Record<string, string>>('telemetry.otlp.headers', {}) ?? {},
        metricsInterval: Math.max(1, Number(c.get<number>('telemetry.otlp.metricsInterval', 60)) || 60),
        exporters: c.get<string[]>('telemetry.otlp.exporters', ['otlp']) ?? ['otlp'],
        traceSamplePercent: ((n) => (Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : 100))(Number(c.get<number>('telemetry.otlp.traceSamplePercent', 100))),
        recordContent: c.get<boolean>('telemetry.otlp.recordContent', false) === true,
      },
    }),
    storage: {
      sessionsInMemory: Math.max(2, Math.min(500, Math.floor(c.get<number>('storage.sessionsInMemory', 16)))),
      redis: policyRedis(org, {
        enabled: c.get<boolean>('storage.redis.enabled', false),
        url: c.get<string>('storage.redis.url', 'redis://127.0.0.1:6379') || 'redis://127.0.0.1:6379',
      }),
    },
    parallel: {
      maxConcurrency: Number.isFinite(maxConcurrency) ? Math.max(1, Math.min(16, maxConcurrency)) : 4,
      maxSubagentDepth: Math.max(1, Math.min(4, Math.floor(c.get<number>('parallel.maxSubagentDepth', 2)) || 2)),
    },
    queue: { concurrency: Math.max(1, Math.min(8, Math.floor(c.get<number>('queue.concurrency', 1)))) },
    autoMode: { enabled: c.get<boolean>('autoMode.enabled', false), model: c.get<string>('autoMode.model', '') },
    supervisor: {
      enabled: c.get<boolean>('supervisor.enabled', true),
      intervalSeconds: Math.max(15, Math.floor(c.get<number>('supervisor.intervalSeconds', 60))),
      autoInstall: c.get<boolean>('supervisor.autoInstall', false),
    },
    webSearch: {
      provider: c.get<WebSearchConfig['provider']>('webSearch.provider', 'duckduckgo'),
      searxngUrl: c.get<string>('webSearch.searxngUrl', 'http://localhost:8888'),
      apiKey: c.get<string>('webSearch.apiKey', ''),
      maxResults: c.get<number>('webSearch.maxResults', 6),
    },
    inlineCompletion: {
      enabled: c.get<boolean>('inlineCompletion.enabled', false),
      model: c.get<string>('inlineCompletion.model', '') || undefined,
      debounceMs: c.get<number>('inlineCompletion.debounceMs', 350),
      maxTokens: c.get<number>('inlineCompletion.maxTokens', 128),
    },
    mcpServers: c.get<Record<string, McpServerConfig>>('mcpServers', {}),
    mcpWatchServerFiles: c.get<boolean>('mcp.watchServerFiles', true),
    mcpToolApprovals: parseMcpToolApprovals(c.get<unknown>('mcp.toolApprovals', {})),
    firstTokenTimeoutSeconds: (() => { const n = Number(c.get<number>('firstTokenTimeoutSeconds', 180)); return Number.isFinite(n) ? (n <= 0 ? 0 : Math.max(15, Math.min(3600, Math.floor(n)))) : 180; })(),
    repos: Object.fromEntries(Object.entries(c.get<Record<string, unknown>>('repos', {}) ?? {}).filter(([, v]) => typeof v === 'string')) as Record<string, string>,
    skillsPaths: c.get<string[]>('skillsPaths', []),
    pluginPaths: (c.get<string[]>('pluginPaths', []) ?? []).filter((s) => typeof s === 'string' && s.trim()).map((s) => s.trim()),
    pluginMarketplaces: (c.get<string[]>('plugins.marketplaces', ['anthropics/claude-plugins-official']) ?? []).filter((s) => typeof s === 'string' && s.trim()).map((s) => s.trim()),
    hooksEnabled: c.get<boolean>('hooks.enabled', true),
    checkpointsEnabled: c.get<boolean>('checkpoints.enabled', true),
    builtinSkills: c.get<boolean>('skills.builtin', true),
    skillRepositories: (c.get<string[]>('skills.repositories', DEFAULT_SKILL_REPOSITORIES) ?? []).filter((s) => typeof s === 'string' && s.trim()).map((s) => s.trim()),
    skillAutoInstall: normalizeAutoInstall(c.get<unknown>('skills.autoInstall', 'auto')),
    skillAutoInstallScope: c.get<string>('skills.autoInstallScope', 'user') === 'workspace' ? 'workspace' : 'user',
    skillsDisabled: (c.get<string[]>('skills.disabled', []) ?? []).filter((s) => typeof s === 'string' && s.trim()).map((s) => s.trim()),
    thinking: normalizeThinking(c.get<unknown>('thinking', 'auto')),
    clarify: (['smart', 'interview', 'minimal'] as const).find((m) => m === c.get<string>('clarify.questions', 'smart')) ?? 'smart',
    memoryEnabled: c.get<boolean>('memory.enabled', true),
    memoryAutoSave: c.get<boolean>('memory.autoSave', true),
    memoryLimits: {
      maxNoteChars: Math.max(500, Math.floor(c.get<number>('memory.maxNoteChars', 8000))),
      maxNotes: Math.max(5, Math.floor(c.get<number>('memory.maxNotes', 200))),
    },
    sessionRetention: Math.max(0, Math.floor(c.get<number>('sessions.retention', 50))),
    historyIncludeCli: c.get<boolean>('history.includeCli', true),
    keepAlive: c.get<string>('keepAlive', '30m'),
    prewarm: c.get<boolean>('prewarm', true),
    ollama: {
      flashAttention: c.get<boolean>('ollama.flashAttention', true),
      kvCacheType: (['f16', 'q8_0', 'q4_0'] as const).find((t) => t === c.get<string>('ollama.kvCacheType', 'q8_0')) ?? 'q8_0',
    },
    autoCorrectPrompts: c.get<boolean>('prompts.autoCorrect', true),
    systemPromptAppend: c.get<string>('systemPromptAppend', ''),
    showWelcomeOnStartup: c.get<boolean>('showWelcomeOnStartup', true),
    terminal: {
      runInIntegratedTerminal: c.get<boolean>('terminal.runInIntegratedTerminal', true),
      reveal: c.get<boolean>('terminal.reveal', true),
      shellIntegrationTimeout: Math.max(500, Math.floor(Number(c.get<number>('terminal.shellIntegrationTimeout', 4000)) || 4000)),
      profile: (c.get<string>('terminal.profile', 'default') ?? '').trim() || 'default',
      autoDetachSeconds: Math.max(0, Math.floor(Number(c.get<number>('terminal.autoDetachSeconds', 300)) || 0)),
    },
    edit: { reportNewErrors: c.get<boolean>('edit.reportNewErrors', true) },
    disabledModels: (c.get<string[]>('models.disabled', []) ?? []).filter((s) => typeof s === 'string'),
    autoSetupModels: c.get<boolean>('models.autoSetup', true),
    autoClarify: c.get<boolean>('autoClarify', true),
    autoTune: (['auto', 'suggest', 'off'] as const).find((m) => m === c.get<string>('models.autoTune', 'auto')) ?? 'auto',
    colibri: {
      path: c.get<string>('colibri.path', '') || undefined,
      model: c.get<string>('colibri.model', '') || undefined,
      port: Math.max(1, Math.floor(c.get<number>('colibri.port', 8000))),
      kvSlots: Math.max(1, Math.min(16, Math.floor(c.get<number>('colibri.kvSlots', 2)))),
      modelsDir: c.get<string>('colibri.modelsDir', '') || undefined,
      backend: (['auto', 'cpu', 'vulkan', 'cuda'] as const).find((b) => b === c.get<string>('colibri.backend', 'auto')) ?? 'auto',
    },
    routing: {
      enabled: c.get<boolean>('routing.enabled', true),
      vision: c.get<string>('routing.vision', '') || undefined,
      reasoning: c.get<string>('routing.reasoning', '') || undefined,
      fast: c.get<string>('routing.fast', '') || undefined,
      coding: c.get<string>('routing.coding', '') || undefined,
      parallelModels: c.get<boolean>('routing.parallelModels', true),
      fallbackModels: [...new Set((c.get<unknown[]>('routing.fallbackModels', []) ?? []).filter((m): m is string => typeof m === 'string' && !!m.trim()).map((m) => m.trim()))],
    },
    pdf: {
      maxReadSizeMB: Math.max(1, Number(c.get<number>('pdf.maxReadSizeMB', 100)) || 100),
      maxChars: Math.max(1000, Math.floor(Number(c.get<number>('pdf.maxChars', 60000)) || 60000)),
    },
    markdownViewer: {
      scrollSync: c.get<boolean>('markdownViewer.scrollSync', true),
      outlineDepth: Math.max(2, Math.min(6, Math.floor(Number(c.get<number>('markdownViewer.outlineDepth', 3)) || 3))),
      frontMatter: (['collapsed', 'expanded', 'hidden'] as const).find((m) => m === c.get<string>('markdownViewer.frontMatter', 'collapsed')) ?? 'collapsed',
      mermaid: c.get<boolean>('markdownViewer.mermaid', true),
      exportTheme: c.get<string>('markdownViewer.exportTheme', 'light') === 'match' ? 'match' : 'light',
    },
    pdfViewer: {
      pageColors: (['auto', 'original', 'dark', 'sepia'] as const).find((m) => m === c.get<string>('pdfViewer.pageColors', 'auto')) ?? 'auto',
      sidebar: (['auto', 'outline', 'thumbnails', 'hidden'] as const).find((m) => m === c.get<string>('pdfViewer.sidebar', 'auto')) ?? 'auto',
      defaultZoom: (['auto', 'page-width', 'page-fit', 'page-actual'] as const).find((m) => m === c.get<string>('pdfViewer.defaultZoom', 'auto')) ?? 'auto',
      rangeThresholdMB: Math.max(1, Number(c.get<number>('pdfViewer.rangeThresholdMB', 16)) || 16),
      maxFileSizeMB: Math.max(1, Number(c.get<number>('pdfViewer.maxFileSizeMB', 1024)) || 1024),
    },
  };
}

/** `~` expanded and relative paths resolved against the home directory; undefined when empty. */
function homePath(raw: string | undefined): string | undefined {
  const p = raw?.trim();
  return p ? path.resolve(os.homedir(), expandHome(p)) : undefined;
}

function normalizeAutoInstall(v: unknown): LocalPilotConfig['skillAutoInstall'] {
  if (v === false || v === 'off' || v === 'never') {
    return 'off';
  }
  return v === 'ask' ? 'ask' : 'auto';
}

function normalizeThinking(v: unknown): ThinkingLevel {
  if (v === true) {
    return 'on';
  }
  if (v === 'on' || v === 'low' || v === 'medium' || v === 'high' || v === 'max' || v === 'off') {
    return v;
  }
  return 'auto';
}

/** `mcp.toolApprovals` with unknown modes and non-object entries dropped. */
export function parseMcpToolApprovals(raw: unknown): McpToolApprovals {
  const out: McpToolApprovals = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return out;
  }
  for (const [server, tools] of Object.entries(raw as Record<string, unknown>)) {
    if (!tools || typeof tools !== 'object' || Array.isArray(tools)) {
      continue;
    }
    const t: Record<string, 'always' | 'ask' | 'never'> = {};
    for (const [tool, mode] of Object.entries(tools as Record<string, unknown>)) {
      if (mode === 'always' || mode === 'ask' || mode === 'never') {
        t[tool] = mode;
      }
    }
    if (Object.keys(t).length) {
      out[server] = t;
    }
  }
  return out;
}

export function onConfigChange(cb: () => void): vscode.Disposable {
  return vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration(SECTION)) {
      cb();
    }
  });
}

/** Security settings a repository must not change: `scope: application` in package.json, so only User settings accept them.
 *  OTLP export is user-only too: several of its keys are application-scoped, and a workspace must not redirect telemetry.
 *  A repository cannot turn the self-healing security check off or allow dependency installs. */
export const isUserOnlySetting = (key: string) => key === 'routing.fallbackModels' || key === 'mcp.toolApprovals' || key === 'hooks.enabled' || key === 'healing.dependencyInstall' || key === 'healing.securityCheck' || key.startsWith('approvals.') || key.startsWith('autoMode.') || key.startsWith('telemetry.otlp.');

/** The most specific scope that sets `key`, so a write there actually takes effect (User when nothing overrides it). */
export function configTarget(key: string): vscode.ConfigurationTarget {
  if (isUserOnlySetting(key)) {
    return vscode.ConfigurationTarget.Global;
  }
  const i = vscode.workspace.getConfiguration(SECTION).inspect(key);
  if (i?.workspaceFolderValue !== undefined) {
    return vscode.ConfigurationTarget.WorkspaceFolder;
  }
  if (i?.workspaceValue !== undefined) {
    return vscode.ConfigurationTarget.Workspace;
  }
  return vscode.ConfigurationTarget.Global;
}

/** The string list stored at one scope (not the merged value), so updating it never copies entries across scopes. */
function listAt(key: string, target: vscode.ConfigurationTarget): string[] {
  const i = vscode.workspace.getConfiguration(SECTION).inspect<string[]>(key);
  const v = target === vscode.ConfigurationTarget.WorkspaceFolder ? i?.workspaceFolderValue : target === vscode.ConfigurationTarget.Workspace ? i?.workspaceValue : i?.globalValue;
  return Array.isArray(v) ? v.filter((s) => typeof s === 'string') : [];
}

export async function setDefaultModel(modelId: string): Promise<void> {
  await vscode.workspace.getConfiguration(SECTION).update('defaultModel', modelId, configTarget('defaultModel'));
}

/** Hide or show a model everywhere (pickers, routing, status bar) without touching the server. */
export async function setModelEnabled(modelId: string, enabled: boolean): Promise<void> {
  const target = configTarget('models.disabled');
  const cur = listAt('models.disabled', target);
  const next = enabled ? cur.filter((id) => id !== modelId) : cur.includes(modelId) ? cur : [...cur, modelId];
  if (next.length !== cur.length) {
    await vscode.workspace.getConfiguration(SECTION).update('models.disabled', next, target);
  }
}

/** Hide or show a skill for the agent (prompt index, load_skill, suggestions) without deleting it from disk. */
export async function setSkillEnabled(name: string, enabled: boolean): Promise<void> {
  const target = configTarget('skills.disabled');
  const cur = listAt('skills.disabled', target);
  const next = enabled ? cur.filter((n) => n !== name) : cur.includes(name) ? cur : [...cur, name];
  if (next.length !== cur.length) {
    await vscode.workspace.getConfiguration(SECTION).update('skills.disabled', next, target);
  }
}

/**
 * A model was deleted from its runtime: drop every setting that still points at it (default, completions, routing,
 * the disabled list) in both User and Workspace scope so nothing keeps routing to a model that no longer exists.
 * Returns the labels of the settings that were cleared, for the notification.
 */
export async function forgetModel(modelId: string): Promise<string[]> {
  const c = vscode.workspace.getConfiguration(SECTION);
  const cleared: string[] = [];
  const refs: [string, string][] = [['defaultModel', 'default model'], ['inlineCompletion.model', 'completions model'], ['routing.vision', 'image model'], ['routing.reasoning', 'plan model']];
  for (const [key, label] of refs) {
    const info = c.inspect<string>(key);
    for (const [value, target] of [[info?.globalValue, vscode.ConfigurationTarget.Global], [info?.workspaceValue, vscode.ConfigurationTarget.Workspace]] as const) {
      if (value === modelId) {
        await c.update(key, undefined, target);
        if (!cleared.includes(label)) {
          cleared.push(label);
        }
      }
    }
  }
  const disabled = c.inspect<string[]>('models.disabled');
  for (const [value, target] of [[disabled?.globalValue, vscode.ConfigurationTarget.Global], [disabled?.workspaceValue, vscode.ConfigurationTarget.Workspace]] as const) {
    if (Array.isArray(value) && value.includes(modelId)) {
      await c.update('models.disabled', value.filter((id) => id !== modelId), target);
    }
  }
  return cleared;
}
