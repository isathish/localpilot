import * as vscode from 'vscode';
import { DEFAULT_SKILL_REPOSITORIES } from './agent/skillCatalog';
import { ApprovalMode, ProviderConfig, ThinkingLevel } from './types';

export interface WebSearchConfig {
  provider: 'duckduckgo' | 'searxng' | 'brave' | 'tavily';
  searxngUrl?: string;
  apiKey?: string;
  maxResults: number;
}

export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  enabled?: boolean;
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
}

export interface LocalPilotConfig {
  providers: ProviderConfig[];
  defaultModel: string;
  /** Requested context window in tokens, capped by the model; 0 = the model's full native window. */
  contextWindow: number;
  maxOutputTokens: number;
  temperature: number;
  compactionThreshold: number; // 0..1 fraction of context before compaction
  maxToolOutputChars: number;
  approvals: { terminal: ApprovalMode; write: ApprovalMode; delete: ApprovalMode; network: ApprovalMode };
  parallel: { maxConcurrency: number; maxSubagentDepth: number };
  /** Task queue: how many queued tasks run at once (1 = one after another). */
  queue: { concurrency: number };
  /** Auto mode: approvals set to "ask" go to a local reviewer model; it approves safe actions and sends the rest to the user. */
  autoMode: { enabled: boolean; model: string };
  /** Keep local services (Ollama, Redis) running; optionally install Ollama unattended when no model server exists. */
  supervisor: { enabled: boolean; intervalSeconds: number; autoInstall: boolean };
  worktrees: { mode: 'always' | 'parallel' | 'off'; location?: string };
  /** Local-only usage metrics and log mirror shown on the dashboard. Nothing is sent anywhere. */
  telemetry: { enabled: boolean; retentionDays: number };
  /** Memory footprint: chat transcripts kept in RAM, and the optional Redis Stack store for telemetry. */
  storage: { sessionsInMemory: number; redis: { enabled: boolean; url: string } };
  webSearch: WebSearchConfig;
  inlineCompletion: { enabled: boolean; model?: string; debounceMs: number; maxTokens: number };
  mcpServers: Record<string, McpServerConfig>;
  skillsPaths: string[];
  /** Extra folders scanned for Claude Code-style plugins (`.claude-plugin/plugin.json`). */
  pluginPaths: string[];
  /** Run the hooks configured in settings.json (PreToolUse, PostToolUse, Stop, …). */
  hooksEnabled: boolean;
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
  /** Caps that keep memory from growing without bound: characters per note and notes per scope. */
  memoryLimits: { maxNoteChars: number; maxNotes: number };
  /** Max idle (unpinned) chats kept on disk; 0 = unlimited. */
  sessionRetention: number;
  keepAlive: string;
  /** Load the chat's model when the composer is focused so the first token is not preceded by a weight load. */
  prewarm: boolean;
  /** Server settings applied when LocalPilot starts or restarts Ollama (it cannot change a server started elsewhere). */
  ollama: { flashAttention: boolean; kvCacheType: 'f16' | 'q8_0' | 'q4_0' };
  /** Correct misspelled file names and identifiers in requests against the workspace before the agent sees them. */
  autoCorrectPrompts: boolean;
  systemPromptAppend: string;
  showWelcomeOnStartup: boolean;
  terminal: { runInIntegratedTerminal: boolean; reveal: boolean };
  /** `provider/model` ids hidden from pickers and routing. */
  disabledModels: string[];
  /** Offer to install Ollama + a starter model when no local model is found. */
  autoSetupModels: boolean;
  /** Detect vague requests and give the agent a workspace snapshot to resolve them before acting. */
  autoClarify: boolean;
  /** Learn from local usage which installed models work best per role: apply them (auto), offer them (suggest) or neither (off). */
  autoTune: 'auto' | 'suggest' | 'off';
  /** colibri (experts streamed from disk): checkout folder, model and port for `LocalPilot: Start colibri`. */
  colibri: { path?: string; model?: string; port: number; kvSlots: number };
  routing: RoutingConfig;
}

const SECTION = 'localpilot';

export const DEFAULT_PROVIDERS: ProviderConfig[] = [
  { id: 'ollama', type: 'ollama', baseUrl: 'http://localhost:11434', displayName: 'Ollama' },
  { id: 'lmstudio', type: 'openai', baseUrl: 'http://localhost:1234/v1', displayName: 'LM Studio' },
  { id: 'llamacpp', type: 'openai', baseUrl: 'http://localhost:8080/v1', displayName: 'llama.cpp server' },
  { id: 'vllm', type: 'openai', baseUrl: 'http://localhost:8000/v1', displayName: 'vLLM / Unsloth' },
];

export function getConfig(): LocalPilotConfig {
  const c = vscode.workspace.getConfiguration(SECTION);
  const providers = c.get<ProviderConfig[]>('providers', DEFAULT_PROVIDERS).filter((p) => p.enabled !== false);
  return {
    providers,
    defaultModel: c.get<string>('defaultModel', ''),
    contextWindow: Math.max(0, Math.floor(c.get<number>('contextWindow', 32768))),
    maxOutputTokens: c.get<number>('maxOutputTokens', 4096),
    temperature: c.get<number>('temperature', 0.2),
    compactionThreshold: c.get<number>('compactionThreshold', 0.75),
    maxToolOutputChars: c.get<number>('maxToolOutputChars', 24000),
    approvals: {
      terminal: c.get<ApprovalMode>('approvals.terminal', 'ask'),
      write: c.get<ApprovalMode>('approvals.write', 'always'),
      delete: c.get<ApprovalMode>('approvals.delete', 'ask'),
      network: c.get<ApprovalMode>('approvals.network', 'always'),
    },
    worktrees: {
      mode: (['always', 'parallel', 'off'] as const).find((m) => m === c.get<string>('worktrees.mode', 'always')) ?? 'always',
      location: c.get<string>('worktrees.location', '') || undefined,
    },
    telemetry: {
      enabled: c.get<boolean>('telemetry.enabled', true),
      retentionDays: Math.max(0, Math.floor(c.get<number>('telemetry.retentionDays', 30))),
    },
    storage: {
      sessionsInMemory: Math.max(2, Math.min(500, Math.floor(c.get<number>('storage.sessionsInMemory', 16)))),
      redis: {
        enabled: c.get<boolean>('storage.redis.enabled', false),
        url: c.get<string>('storage.redis.url', 'redis://127.0.0.1:6379') || 'redis://127.0.0.1:6379',
      },
    },
    parallel: {
      maxConcurrency: c.get<number>('parallel.maxConcurrency', 4),
      maxSubagentDepth: c.get<number>('parallel.maxSubagentDepth', 2),
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
    skillsPaths: c.get<string[]>('skillsPaths', []),
    pluginPaths: (c.get<string[]>('pluginPaths', []) ?? []).filter((s) => typeof s === 'string' && s.trim()).map((s) => s.trim()),
    hooksEnabled: c.get<boolean>('hooks.enabled', true),
    builtinSkills: c.get<boolean>('skills.builtin', true),
    skillRepositories: (c.get<string[]>('skills.repositories', DEFAULT_SKILL_REPOSITORIES) ?? []).filter((s) => typeof s === 'string' && s.trim()).map((s) => s.trim()),
    skillAutoInstall: normalizeAutoInstall(c.get<unknown>('skills.autoInstall', 'auto')),
    skillAutoInstallScope: c.get<string>('skills.autoInstallScope', 'user') === 'workspace' ? 'workspace' : 'user',
    skillsDisabled: (c.get<string[]>('skills.disabled', []) ?? []).filter((s) => typeof s === 'string' && s.trim()).map((s) => s.trim()),
    thinking: normalizeThinking(c.get<unknown>('thinking', 'auto')),
    clarify: (['smart', 'interview', 'minimal'] as const).find((m) => m === c.get<string>('clarify.questions', 'smart')) ?? 'smart',
    memoryEnabled: c.get<boolean>('memory.enabled', true),
    memoryLimits: {
      maxNoteChars: Math.max(500, Math.floor(c.get<number>('memory.maxNoteChars', 8000))),
      maxNotes: Math.max(5, Math.floor(c.get<number>('memory.maxNotes', 200))),
    },
    sessionRetention: Math.max(0, Math.floor(c.get<number>('sessions.retention', 50))),
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
    },
    disabledModels: (c.get<string[]>('models.disabled', []) ?? []).filter((s) => typeof s === 'string'),
    autoSetupModels: c.get<boolean>('models.autoSetup', true),
    autoClarify: c.get<boolean>('autoClarify', true),
    autoTune: (['auto', 'suggest', 'off'] as const).find((m) => m === c.get<string>('models.autoTune', 'auto')) ?? 'auto',
    colibri: {
      path: c.get<string>('colibri.path', '') || undefined,
      model: c.get<string>('colibri.model', '') || undefined,
      port: Math.max(1, Math.floor(c.get<number>('colibri.port', 8000))),
      kvSlots: Math.max(1, Math.min(16, Math.floor(c.get<number>('colibri.kvSlots', 2)))),
    },
    routing: {
      enabled: c.get<boolean>('routing.enabled', true),
      vision: c.get<string>('routing.vision', '') || undefined,
      reasoning: c.get<string>('routing.reasoning', '') || undefined,
      fast: c.get<string>('routing.fast', '') || undefined,
      coding: c.get<string>('routing.coding', '') || undefined,
      parallelModels: c.get<boolean>('routing.parallelModels', true),
    },
  };
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
  if (v === 'on' || v === 'low' || v === 'medium' || v === 'high' || v === 'off') {
    return v;
  }
  return 'auto';
}

export function onConfigChange(cb: () => void): vscode.Disposable {
  return vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration(SECTION)) {
      cb();
    }
  });
}

export async function setDefaultModel(modelId: string): Promise<void> {
  await vscode.workspace.getConfiguration(SECTION).update('defaultModel', modelId, vscode.ConfigurationTarget.Global);
}

/** Hide or show a model everywhere (pickers, routing, status bar) without touching the server. */
export async function setModelEnabled(modelId: string, enabled: boolean): Promise<void> {
  const c = vscode.workspace.getConfiguration(SECTION);
  const cur = (c.get<string[]>('models.disabled', []) ?? []).filter((s) => typeof s === 'string');
  const next = enabled ? cur.filter((id) => id !== modelId) : cur.includes(modelId) ? cur : [...cur, modelId];
  if (next.length !== cur.length) {
    await c.update('models.disabled', next, vscode.ConfigurationTarget.Global);
  }
}

/** Hide or show a skill for the agent (prompt index, load_skill, suggestions) without deleting it from disk. */
export async function setSkillEnabled(name: string, enabled: boolean): Promise<void> {
  const c = vscode.workspace.getConfiguration(SECTION);
  const cur = (c.get<string[]>('skills.disabled', []) ?? []).filter((s) => typeof s === 'string');
  const next = enabled ? cur.filter((n) => n !== name) : cur.includes(name) ? cur : [...cur, name];
  if (next.length !== cur.length) {
    await c.update('skills.disabled', next, vscode.ConfigurationTarget.Global);
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
