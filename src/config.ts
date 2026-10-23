import * as vscode from 'vscode';
import { ApprovalMode, ProviderConfig } from './types';

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
  webSearch: WebSearchConfig;
  inlineCompletion: { enabled: boolean; model?: string; debounceMs: number; maxTokens: number };
  mcpServers: Record<string, McpServerConfig>;
  skillsPaths: string[];
  thinking: boolean;
  systemPromptAppend: string;
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
    thinking: c.get<boolean>('thinking', false),
    systemPromptAppend: c.get<string>('systemPromptAppend', ''),
  };
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
