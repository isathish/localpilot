import { ProviderConfig } from '../types';

/** Where a preset runs: servers on this machine, local gateways to cloud models, or cloud APIs. */
export type PresetGroup = 'local' | 'gateway' | 'cloud';

export interface ProviderPreset {
  key: string;
  label: string;
  group: PresetGroup;
  cfg: ProviderConfig;
  /** Environment variable cloud presets read the key from until one is stored. */
  env?: string;
  /** Where to get an API key (cloud) or set the gateway up. */
  keyUrl?: string;
}

const local = (key: string, label: string, type: ProviderConfig['type'], baseUrl: string, displayName = label): ProviderPreset => ({ key, label, group: 'local', cfg: { id: key, type, baseUrl, displayName } });
const cloud = (key: string, label: string, type: ProviderConfig['type'], baseUrl: string, env: string, keyUrl: string): ProviderPreset => ({
  key,
  label,
  group: 'cloud',
  env,
  keyUrl,
  // Explicitly cloud: it stays cloud behind a proxy or a regional URL that looks local.
  cfg: { id: key, type, baseUrl, displayName: label, apiKey: `\${env:${env}}`, cloud: true },
});

/**
 * Provider presets for the CLI (`localpilot providers add <key>`). The Settings page has the same list in
 * `media/settings.js` (PRESET_PROVIDERS); the smoke test keeps the two in sync.
 */
export const PROVIDER_PRESETS: ProviderPreset[] = [
  local('ollama', 'Ollama', 'ollama', 'http://localhost:11434'),
  local('lmstudio', 'LM Studio', 'openai', 'http://localhost:1234/v1'),
  local('llamacpp', 'llama.cpp', 'openai', 'http://localhost:8080/v1', 'llama.cpp server'),
  local('vllm', 'vLLM / Unsloth', 'openai', 'http://localhost:8000/v1'),
  local('docker', 'Docker Model Runner', 'openai', 'http://localhost:12434/engines/v1'),
  local('jan', 'Jan', 'openai', 'http://localhost:1337/v1'),
  local('localai', 'LocalAI', 'openai', 'http://localhost:8080/v1'),
  local('sglang', 'SGLang', 'openai', 'http://localhost:30000/v1'),
  local('koboldcpp', 'KoboldCpp', 'openai', 'http://localhost:5001/v1'),
  local('textgen', 'text-generation-webui', 'openai', 'http://localhost:5000/v1'),
  local('gpt4all', 'GPT4All', 'openai', 'http://localhost:4891/v1'),
  { key: 'omniroute', label: 'OmniRoute', group: 'gateway', keyUrl: 'https://github.com/diegosouzapw/OmniRoute', cfg: { id: 'omniroute', type: 'openai', baseUrl: 'http://localhost:20128/v1', displayName: 'OmniRoute', cloud: true } },
  { key: 'litellm', label: 'LiteLLM proxy', group: 'gateway', keyUrl: 'https://docs.litellm.ai/docs/simple_proxy', cfg: { id: 'litellm', type: 'openai', baseUrl: 'http://localhost:4000/v1', displayName: 'LiteLLM', cloud: true } },
  cloud('openai', 'OpenAI', 'openai', 'https://api.openai.com/v1', 'OPENAI_API_KEY', 'https://platform.openai.com/api-keys'),
  cloud('anthropic', 'Anthropic (Claude)', 'anthropic', 'https://api.anthropic.com/v1', 'ANTHROPIC_API_KEY', 'https://console.anthropic.com/settings/keys'),
  cloud('gemini', 'Google Gemini', 'openai', 'https://generativelanguage.googleapis.com/v1beta/openai', 'GEMINI_API_KEY', 'https://aistudio.google.com/apikey'),
  cloud('openrouter', 'OpenRouter', 'openai', 'https://openrouter.ai/api/v1', 'OPENROUTER_API_KEY', 'https://openrouter.ai/keys'),
  cloud('groq', 'Groq', 'openai', 'https://api.groq.com/openai/v1', 'GROQ_API_KEY', 'https://console.groq.com/keys'),
  cloud('mistral', 'Mistral AI', 'openai', 'https://api.mistral.ai/v1', 'MISTRAL_API_KEY', 'https://console.mistral.ai/api-keys'),
  cloud('deepseek', 'DeepSeek', 'openai', 'https://api.deepseek.com/v1', 'DEEPSEEK_API_KEY', 'https://platform.deepseek.com/api_keys'),
  cloud('xai', 'xAI (Grok)', 'openai', 'https://api.x.ai/v1', 'XAI_API_KEY', 'https://console.x.ai'),
  cloud('together', 'Together AI', 'openai', 'https://api.together.xyz/v1', 'TOGETHER_API_KEY', 'https://api.together.ai/settings/api-keys'),
  cloud('fireworks', 'Fireworks AI', 'openai', 'https://api.fireworks.ai/inference/v1', 'FIREWORKS_API_KEY', 'https://fireworks.ai/account/api-keys'),
  cloud('cerebras', 'Cerebras', 'openai', 'https://api.cerebras.ai/v1', 'CEREBRAS_API_KEY', 'https://cloud.cerebras.ai'),
  cloud('huggingface', 'Hugging Face', 'openai', 'https://router.huggingface.co/v1', 'HF_TOKEN', 'https://huggingface.co/settings/tokens'),
  cloud('nvidia', 'NVIDIA NIM', 'openai', 'https://integrate.api.nvidia.com/v1', 'NVIDIA_API_KEY', 'https://build.nvidia.com'),
  cloud('moonshot', 'Moonshot (Kimi)', 'openai', 'https://api.moonshot.ai/v1', 'MOONSHOT_API_KEY', 'https://platform.moonshot.ai/console/api-keys'),
  cloud('dashscope', 'Alibaba Qwen', 'openai', 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1', 'DASHSCOPE_API_KEY', 'https://www.alibabacloud.com/help/en/model-studio/get-api-key'),
  cloud('ollama-cloud', 'Ollama Cloud', 'ollama', 'https://ollama.com', 'OLLAMA_API_KEY', 'https://ollama.com/settings/keys'),
  cloud('azure', 'Azure OpenAI', 'openai', 'https://YOUR-RESOURCE.openai.azure.com/openai/v1', 'AZURE_OPENAI_API_KEY', 'https://portal.azure.com'),
];

export function findPreset(key: string): ProviderPreset | undefined {
  const k = key.trim().toLowerCase();
  return PROVIDER_PRESETS.find((p) => p.key === k || p.label.toLowerCase() === k) ?? PROVIDER_PRESETS.find((p) => p.label.toLowerCase().startsWith(k));
}

/** The preset a configured provider came from (`openai-2` → openai, else the same base URL). */
export function presetFor(p: Pick<ProviderConfig, 'id' | 'baseUrl'>): ProviderPreset | undefined {
  return PROVIDER_PRESETS.find((pr) => pr.cfg.id === p.id.replace(/-\d+$/, '')) ?? PROVIDER_PRESETS.find((pr) => pr.cfg.baseUrl === p.baseUrl);
}
