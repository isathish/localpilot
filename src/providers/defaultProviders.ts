import type { ProviderConfig } from '../types';

/** The local servers LocalPilot looks for when `localpilot.providers` is not set. No `vscode` import: the CLI uses it too. */
export const DEFAULT_PROVIDERS: ProviderConfig[] = [
  { id: 'ollama', type: 'ollama', baseUrl: 'http://localhost:11434', displayName: 'Ollama' },
  { id: 'lmstudio', type: 'openai', baseUrl: 'http://localhost:1234/v1', displayName: 'LM Studio' },
  { id: 'llamacpp', type: 'openai', baseUrl: 'http://localhost:8080/v1', displayName: 'llama.cpp server' },
  { id: 'vllm', type: 'openai', baseUrl: 'http://localhost:8000/v1', displayName: 'vLLM / Unsloth' },
];
