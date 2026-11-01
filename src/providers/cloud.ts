import { ProviderConfig } from '../types';

/**
 * The provider's API key with `${env:NAME}` references expanded, so cloud keys can live in the environment
 * (`${env:OPENAI_API_KEY}`) instead of in settings.json. Undefined when unset or the variable is empty.
 */
export function resolveApiKey(cfg: Pick<ProviderConfig, 'apiKey'>): string | undefined {
  const raw = cfg.apiKey?.trim();
  if (!raw) {
    return undefined;
  }
  const key = raw.replace(/\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name: string) => process.env[name] ?? '').trim();
  return key || undefined;
}

/** True for servers outside this machine and the private network: requests to them leave the user's control. */
export function isRemoteUrl(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase().replace(/^\[|\]$/g, '');
  } catch {
    return false;
  }
  return !(
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    host === '::1' ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(host) ||
    /^f[cd][0-9a-f]{2}:/.test(host) ||
    !host.includes('.')
  );
}

/** Azure OpenAI authenticates with an `api-key` header instead of a Bearer token. */
export function isAzureUrl(url: string): boolean {
  return /\.(openai\.azure\.com|services\.ai\.azure\.com|cognitiveservices\.azure\.com)(:|\/|$)/i.test(url);
}

/** Model ids cloud APIs list next to their chat models (embeddings, speech, images, moderation…) that cannot chat. */
export function isNonChatModel(id: string): boolean {
  return /embed|rerank|whisper|tts|transcribe|dall-e|image|imagen|veo|moderation|audio|realtime|davinci|babbage|guard|aqa|computer-use|search-preview|sora|-ocr/i.test(id);
}

/**
 * Context window of well-known cloud model families, for APIs whose model listing does not report one
 * (OpenAI, Anthropic, Gemini, xAI, DeepSeek…). Undefined = unknown; the provider's fallback applies.
 */
export function knownContextWindow(modelId: string): number | undefined {
  const n = modelId.toLowerCase().replace(/^models\//, '');
  const table: [RegExp, number][] = [
    [/gpt-4\.1/, 1_047_576],
    [/gpt-5/, 400_000],
    [/(^|\/)o[134](-|$)/, 200_000],
    [/gpt-4o|gpt-4-turbo|chatgpt-4o/, 128_000],
    [/gpt-oss/, 131_072],
    [/gpt-3\.5/, 16_385],
    [/claude/, 200_000],
    [/gemini-(1\.5-pro)/, 2_097_152],
    [/gemini/, 1_048_576],
    [/grok-4|grok-code/, 256_000],
    [/grok/, 131_072],
    [/deepseek/, 128_000],
    [/codestral/, 256_000],
    [/mistral|magistral|devstral|ministral|pixtral/, 128_000],
    [/kimi|moonshot/, 128_000],
    [/llama-?3|llama-?4|qwen|glm/, 128_000],
  ];
  return table.find(([re]) => re.test(n))?.[1];
}

/** Vision support of well-known cloud model families whose listing does not say. */
export function knownVision(modelId: string): boolean {
  const n = modelId.toLowerCase();
  return /gpt-4o|gpt-4\.1|gpt-5|(^|\/)o[34](-|$)|claude-(?!2|instant)|gemini|grok-4|grok-.*vision|pixtral|mistral-(medium|small)|llama-4|vl|vision/.test(n) && !/gpt-5-nano-audio|-audio/.test(n);
}
