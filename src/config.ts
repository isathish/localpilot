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
}

export interface LocalPilotConfig {
  providers: ProviderConfig[];
  defaultModel: string;
  contextWindow: number;
  maxOutputTokens: number;
  temperature: number;
  compactionThreshold: number; // 0..1 fraction of context before compaction
  maxToolOutputChars: number;
  approvals: { terminal: ApprovalMode; write: ApprovalMode; delete: ApprovalMode; network: ApprovalMode };
  parallel: { maxConcurrency: number; maxSubagentDepth: number };
  worktrees: { mode: 'always' | 'parallel' | 'off'; location?: string };
  webSearch: WebSearchConfig;
  inlineCompletion: { enabled: boolean; model?: string; debounceMs: number; maxTokens: number };
  mcpServers: Record<string, McpServerConfig>;
  skillsPaths: string[];
  builtinSkills: boolean;
  /** Repositories (owner/repo[/path]) whose skills can be installed automatically when a request matches one. */
  skillRepositories: string[];
  /** Install a matching catalog skill without asking, offer it as a chip, or never. */
  skillAutoInstall: 'auto' | 'ask' | 'off';
  /** Where automatically installed skills land: the user's ~/.localpilot/skills or the workspace's .localpilot/skills. */
  skillAutoInstallScope: 'user' | 'workspace';
  thinking: ThinkingLevel;
  memoryEnabled: boolean;
  /** Max idle (unpinned) chats kept on disk; 0 = unlimited. */
  sessionRetention: number;
  keepAlive: string;
  systemPromptAppend: string;
  showWelcomeOnStartup: boolean;
  terminal: { runInIntegratedTerminal: boolean; reveal: boolean };
  /** `provider/model` ids hidden from pickers and routing. */
  disabledModels: string[];
  /** Offer to install Ollama + a starter model when no local model is found. */
  autoSetupModels: boolean;
  /** Detect vague requests and give the agent a workspace snapshot to resolve them before acting. */
  autoClarify: boolean;
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
    contextWindow: c.get<number>('contextWindow', 32768),
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
    parallel: {
      maxConcurrency: c.get<number>('parallel.maxConcurrency', 4),
      maxSubagentDepth: c.get<number>('parallel.maxSubagentDepth', 2),
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
    builtinSkills: c.get<boolean>('skills.builtin', true),
    skillRepositories: (c.get<string[]>('skills.repositories', DEFAULT_SKILL_REPOSITORIES) ?? []).filter((s) => typeof s === 'string' && s.trim()).map((s) => s.trim()),
    skillAutoInstall: normalizeAutoInstall(c.get<unknown>('skills.autoInstall', 'auto')),
    skillAutoInstallScope: c.get<string>('skills.autoInstallScope', 'user') === 'workspace' ? 'workspace' : 'user',
    thinking: normalizeThinking(c.get<unknown>('thinking', 'off')),
    memoryEnabled: c.get<boolean>('memory.enabled', true),
    sessionRetention: Math.max(0, Math.floor(c.get<number>('sessions.retention', 50))),
    keepAlive: c.get<string>('keepAlive', '30m'),
    systemPromptAppend: c.get<string>('systemPromptAppend', ''),
    showWelcomeOnStartup: c.get<boolean>('showWelcomeOnStartup', true),
    terminal: {
      runInIntegratedTerminal: c.get<boolean>('terminal.runInIntegratedTerminal', true),
      reveal: c.get<boolean>('terminal.reveal', true),
    },
    disabledModels: (c.get<string[]>('models.disabled', []) ?? []).filter((s) => typeof s === 'string'),
    autoSetupModels: c.get<boolean>('models.autoSetup', true),
    autoClarify: c.get<boolean>('autoClarify', true),
    routing: {
      enabled: c.get<boolean>('routing.enabled', true),
      vision: c.get<string>('routing.vision', '') || undefined,
      reasoning: c.get<string>('routing.reasoning', '') || undefined,
      fast: c.get<string>('routing.fast', '') || undefined,
      coding: c.get<string>('routing.coding', '') || undefined,
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
  if (v === 'on' || v === 'low' || v === 'medium' || v === 'high') {
    return v;
  }
  return 'off';
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
