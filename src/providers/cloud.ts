import { ChatMessage, CompletionRequestOptions, LLMProvider } from '../types';
import { ProviderConfig } from '../types';
import { expandMcpServer } from '../mcp/config';
import { cleanHeaders } from './providerOptions';

/** Keys from VS Code's secret storage by name, loaded by ProviderSecrets so key resolution stays synchronous. */
const secretValues = new Map<string, string>();
const secretListeners = new Set<() => void>();

/** Replaces the known secret values (`undefined` removes one) and tells providers to rebuild with them. */
export function setSecretValues(values: Record<string, string | undefined>): void {
  let changed = false;
  for (const [name, value] of Object.entries(values)) {
    if (value) {
      changed = secretValues.get(name) !== value || changed;
      secretValues.set(name, value);
    } else {
      changed = secretValues.delete(name) || changed;
    }
  }
  if (!changed) {
    return;
  }
  for (const l of secretListeners) {
    l();
  }
}

export function onSecretsChanged(listener: () => void): { dispose(): void } {
  secretListeners.add(listener);
  return { dispose: () => secretListeners.delete(listener) };
}

/** Secret names referenced as `${secret:NAME}` in a key. */
export function secretRefs(apiKey: string | undefined): string[] {
  return [...(apiKey ?? '').matchAll(SECRET_REF)].map((m) => m[1]);
}

const SECRET_REF = /\$\{secret:([A-Za-z0-9_.-]+)\}/g;

/**
 * The provider's API key with references expanded: `${env:NAME}` from the environment, `${secret:NAME}` from VS Code's
 * secret storage. So cloud keys need not be stored in settings.json. Undefined when unset or the reference is empty.
 */
export function resolveApiKey(cfg: Pick<ProviderConfig, 'apiKey'>): string | undefined {
  const raw = cfg.apiKey?.trim();
  if (!raw) {
    return undefined;
  }
  const key = raw
    .replace(/\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name: string) => process.env[name] ?? '')
    // Outside VS Code (the CLI) there is no secret storage: LOCALPILOT_KEY_<NAME> stands in for it.
    .replace(SECRET_REF, (_, name: string) => secretValues.get(name) ?? process.env[secretEnvName(name)] ?? '')
    .trim();
  return key || undefined;
}

/**
 * The provider's custom headers with `${env:NAME}` / `${secret:NAME}` expanded the way MCP server headers are. A header
 * whose reference resolves to nothing is left out rather than sent with the placeholder in it.
 */
export function resolveHeaders(cfg: Pick<ProviderConfig, 'headers'>): Record<string, string> {
  const headers = cleanHeaders(cfg.headers);
  if (!headers) {
    return {};
  }
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const { cfg: expanded, missing } = expandMcpServer({ headers: { [name]: value } }, (kind, ref) =>
      kind === 'secret' ? secretValues.get(ref) ?? process.env[secretEnvName(ref)] : process.env[ref]
    );
    const v = expanded.headers?.[name]?.trim();
    if (v && !missing.length) {
      out[name] = v;
    }
  }
  return out;
}

/** Environment variable the CLI reads for a `${secret:NAME}` key, e.g. `LOCALPILOT_KEY_OPENAI`. */
export function secretEnvName(name: string): string {
  return `LOCALPILOT_KEY_${name.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`;
}

/** Why a configured key resolves to nothing: the missing variable or secret, for the connection test. */
export function missingKeyReason(cfg: Pick<ProviderConfig, 'apiKey'>): string {
  const raw = cfg.apiKey ?? '';
  const env = /\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}/.exec(raw);
  if (env) {
    return `Environment variable ${env[1]} is not set`;
  }
  const secret = secretRefs(raw)[0];
  return secret ? `The stored API key is missing from VS Code secret storage — enter it again (the CLI reads ${secretEnvName(secret)})` : 'API key required';
}

/** Where a provider's key comes from and whether it resolves right now — never the key itself (shown in Settings). */
export interface KeyStatus {
  source: 'keychain' | 'env' | 'settings' | 'none';
  ok: boolean;
  /** The environment variable for `env` keys. */
  env?: string;
}

export function keyStatus(cfg: Pick<ProviderConfig, 'apiKey'>): KeyStatus {
  const raw = cfg.apiKey?.trim();
  if (!raw) {
    return { source: 'none', ok: false };
  }
  const ok = !!resolveApiKey(cfg);
  if (secretRefs(raw).length) {
    return { source: 'keychain', ok };
  }
  const env = /\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}/.exec(raw);
  return env ? { source: 'env', ok, env: env[1] } : { source: 'settings', ok };
}

/** Prompts sent to this provider leave the machine: a cloud URL, or a local gateway marked `cloud`. */
export function isCloudProvider(cfg: Pick<ProviderConfig, 'baseUrl' | 'cloud'> & { type?: ProviderConfig['type'] }): boolean {
  // An Anthropic-type provider always ends at Anthropic's API, even behind a proxy on this machine.
  return cfg.cloud ?? (cfg.type === 'anthropic' || cfg.type === 'vscode-lm' || isRemoteUrl(cfg.baseUrl));
}

/** True for a server on this machine (localhost, 127.0.0.0/8, ::1): one LocalPilot can start itself. */
export function isLoopbackUrl(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase().replace(/^\[|\]$/g, '');
  } catch {
    return false;
  }
  return host === 'localhost' || host.endsWith('.localhost') || host === '::1' || /^127\./.test(host);
}

/** True for servers outside this machine and the private network: requests to them leave the user's control. */
export function isRemoteUrl(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase().replace(/^\[|\]$/g, '');
  } catch {
    return false;
  }
  if (host.includes(':')) {
    return !isPrivateIpv6(host);
  }
  return !(host === 'localhost' || host === '0.0.0.0' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal') || isPrivateIpv4(host) || !host.includes('.'));
}

function isPrivateIpv4(host: string): boolean {
  return (
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(host)
  );
}

/** Loopback, unspecified, unique-local (fc00::/7), link-local (fe80::/10), or an IPv4-mapped private address. */
function isPrivateIpv6(host: string): boolean {
  if (host === '::1' || host === '::' || /^f[cd]/.test(host) || /^fe[89ab]/.test(host)) {
    return true;
  }
  const mapped = /^::ffff:(.+)$/.exec(host)?.[1];
  if (!mapped) {
    return false;
  }
  const hex = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(mapped);
  const v4 = hex ? [parseInt(hex[1], 16) >> 8, parseInt(hex[1], 16) & 255, parseInt(hex[2], 16) >> 8, parseInt(hex[2], 16) & 255].join('.') : mapped;
  return /^\d+\.\d+\.\d+\.\d+$/.test(v4) && isPrivateIpv4(v4);
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
    [/claude-(fable|mythos)|claude-(opus|sonnet)-(4[-.][6-9]|[5-9])|claude-haiku-[5-9]/, 1_000_000],
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

const CURSOR = '<CURSOR>';

/**
 * Fill-in-the-middle through chat, for cloud APIs that have no `suffix` completion endpoint: the model sees the code
 * around the cursor and answers with only the text to insert. Used for ghost text when a cloud model is chosen for it.
 */
export async function completeViaChat(provider: Pick<LLMProvider, 'chat'>, opts: CompletionRequestOptions): Promise<string> {
  const before = opts.prompt.slice(-6000);
  const after = (opts.suffix ?? '').slice(0, 2000);
  const messages: ChatMessage[] = [
    {
      role: 'system',
      content: `You are a code completion engine. The user sends a file with ${CURSOR} where the cursor is. Reply with only the text to insert at ${CURSOR}: no explanation, no code fences, and never repeat code that is already before or after the cursor. Reply with nothing if nothing should be inserted.`,
    },
    { role: 'user', content: `${before}${CURSOR}${after}` },
  ];
  let text = '';
  for await (const ev of provider.chat({ model: opts.model, messages, maxTokens: opts.maxTokens ?? 128, temperature: opts.temperature ?? 0.1, stop: opts.stop, think: false, signal: opts.signal })) {
    if (ev.type === 'text') {
      text += ev.text;
    }
  }
  return stripFences(text);
}

/** Models sometimes wrap the insertion in a code fence despite being told not to. */
export function stripFences(text: string): string {
  const m = /^\s*```[\w+-]*\n([\s\S]*?)\n?```\s*$/.exec(text);
  return m ? m[1] : text;
}
