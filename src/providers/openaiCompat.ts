import { createHash } from 'crypto';
import {
  ChatMessage,
  ChatRequestOptions,
  CompletionRequestOptions,
  LLMProvider,
  ModelInfo,
  ProviderConfig,
  ProviderUsage,
  StreamEvent,
} from '../types';
import { lookupCatalog } from './catalog';
import { completeViaChat, isAzureUrl, isCloudProvider, isNonChatModel, knownContextWindow, knownVision, resolveApiKey, resolveHeaders } from './cloud';
import { colibriHealth, colibriSlots, colibriSpec, COLIBRI_OWNER } from './colibri';
import { getJson, HttpError, newId, postJson, streamSse, withTimeout } from './http';
import { imageMime } from './imageMime';
import { fetchLmStudioContexts, isLmStudio } from './lmstudio';
import { anyModelFacts, factsProvider, modelFacts, outputLimit, pricingOf } from './modelFacts';
import { applyModelOverrides, isOpenRouterUrl, mergeHeaders, OPENROUTER_HEADERS, withApiVersion, withExtraBody } from './providerOptions';
import { effortOf, openRouterReasoning } from './thinkingParams';
import { ThinkTagSplitter } from './thinkTags';
import { pairToolCalls } from './toolPairing';

/** Default provider labels that say nothing about the server actually answering (vLLM's port is also colibri's). */
const STOCK_NAMES = /^(vllm( \/ unsloth)?|vllm-\d+)$/i;

interface OpenAIModel {
  id: string;
  owned_by?: string;
  /** LM Studio / vLLM extensions */
  max_model_len?: number;
  context_length?: number;
  max_context_length?: number;
  loaded_context_length?: number;
  /** Groq */
  context_window?: number;
  type?: string;
  /** A list (LM Studio, vLLM) or Mistral's flags object (`function_calling`, `vision`, `completion_chat`…). */
  capabilities?: string[] | Record<string, unknown>;
  /** OpenRouter */
  supported_parameters?: string[];
  architecture?: { input_modalities?: string[] };
  top_provider?: { context_length?: number };
  /** colibri: `["text"]` or `["text", "image"]`. */
  input_modalities?: string[];
}
interface OpenAIChunk {
  choices?: {
    delta?: {
      /** Mistral reasoning models stream a list of parts (thinking / text) instead of a string. */
      content?: string | Array<{ type?: string; text?: string; thinking?: Array<{ text?: string }> | string }> | null;
      reasoning_content?: string | null;
      reasoning?: string | null;
      tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string }; extra_content?: Record<string, unknown> }[];
    };
    finish_reason?: string | null;
  }[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number } | null;
    /** OpenRouter: what the request cost, in credits (US dollars). */
    cost?: number;
  } | null;
  error?: { message?: string; code?: string | number; type?: string; status?: number } | string;
}

/** Whether a `/v1/models` entry says how long its context is. */
function hasContextField(m: OpenAIModel): boolean {
  return [m.max_model_len, m.loaded_context_length, m.max_context_length, m.context_length, m.context_window, m.top_provider?.context_length].some((v) => typeof v === 'number' && v > 0);
}

/** A chunk's usage block: `prompt_tokens` already includes the cached part, which is reported beside it. */
export function usageOf(u: NonNullable<OpenAIChunk['usage']>): ProviderUsage {
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined);
  return {
    promptTokens: num(u.prompt_tokens),
    completionTokens: num(u.completion_tokens),
    cacheReadTokens: num(u.prompt_tokens_details?.cached_tokens) || undefined,
    cacheWriteTokens: num(u.prompt_tokens_details?.cache_write_tokens) || undefined,
    costUsd: num(u.cost),
  };
}

/** An error sent inside the stream: an HttpError when it carries a status, so it is retried like the same error sent as a response. */
function streamError(error: NonNullable<OpenAIChunk['error']>, url: string): Error {
  if (typeof error === 'string') {
    return new Error(error);
  }
  const code = Number(error.status ?? error.code);
  const kind = `${error.code ?? ''} ${error.type ?? ''}`;
  const status = Number.isInteger(code) && code >= 400 && code < 600 ? code
    : error.type === 'server_error' ? 500
    : /rate_limit/i.test(kind) ? 429
    : /server_error|overloaded|unavailable|timeout|internal|disconnected/i.test(`${kind} ${error.message ?? ''}`) ? 502
    : undefined;
  return status ? new HttpError(status, JSON.stringify(error), url) : new Error(error.message ?? 'provider error');
}

/**
 * OpenAI-compatible chat provider. Works with LM Studio, llama.cpp server, vLLM, SGLang,
 * Unsloth-served models, LocalAI, Jan, text-generation-webui, OpenRouter, OpenAI, etc.
 */
export class OpenAICompatProvider implements LLMProvider {
  readonly type = 'openai' as const;
  readonly id: string;
  readonly baseUrl: string;
  private readonly headers: Record<string, string>;
  private readonly explicitModels?: string[];
  private readonly configuredCtx?: number;
  /** A cloud API (or a local gateway to one) rather than a model server on this machine or the private network. */
  readonly remote: boolean;
  /** Request parameters a model rejected once (see PARAM_FIXES), re-applied to its later requests. */
  private readonly learnedFixes = new Map<string, Set<string>>();
  /** Models whose server rejected a `suffix` on `/completions` (llama.cpp, vLLM): their FIM goes through chat. */
  private readonly noSuffix = new Set<string>();
  private readonly configuredName: string;
  /** LM Studio by preset or port: context lengths come from its native `/api/v0/models`. */
  private readonly lmStudio: boolean;
  /** Set once the server turned out to have no LM Studio native API, so later listings skip the probe. */
  private noNativeApi = false;
  /** Engine the server identified itself as on the last model listing. */
  engine?: 'colibri';
  /** The cloud preset whose bundled model facts (limits, prices) apply; undefined for local servers and gateways. */
  private readonly factsKey?: string;
  private readonly cfg: ProviderConfig;
  /** OpenRouter takes reasoning as one `reasoning` object instead of `reasoning_effort`. */
  private readonly openRouter: boolean;

  /** The configured name, unless it is the stock vLLM label on :8000 and the server turned out to be colibri. */
  get displayName(): string {
    return this.engine === 'colibri' && STOCK_NAMES.test(this.configuredName) ? 'colibri' : this.configuredName;
  }

  constructor(cfg: ProviderConfig) {
    this.cfg = cfg;
    this.id = cfg.id;
    this.configuredName = cfg.displayName ?? cfg.id;
    this.baseUrl = cfg.baseUrl.replace(/\/+$/, '');
    this.openRouter = isOpenRouterUrl(this.baseUrl);
    const key = resolveApiKey(cfg);
    const auth: Record<string, string> = !key ? {} : isAzureUrl(this.baseUrl) ? { 'api-key': key } : { authorization: `Bearer ${key}` };
    // Custom headers come last: a gateway may need its own Authorization or replace the attribution headers.
    this.headers = mergeHeaders(auth, this.openRouter ? OPENROUTER_HEADERS : {}, resolveHeaders(cfg));
    this.explicitModels = cfg.models;
    this.configuredCtx = cfg.contextWindow;
    this.remote = isCloudProvider(cfg);
    this.lmStudio = isLmStudio(cfg);
    this.factsKey = this.remote ? factsProvider(cfg) : undefined;
  }

  /** An endpoint under the base URL, with Azure's `api-version` when one is configured. */
  private url(path: string): string {
    return withApiVersion(`${this.baseUrl}${path}`, this.cfg.apiVersion);
  }

  private get modelsUrl(): string {
    return this.cfg.modelsUrl?.trim() || this.url('/models');
  }

  async healthCheck(signal?: AbortSignal): Promise<boolean> {
    try {
      await getJson(this.modelsUrl, this.headers, withTimeout(2500, signal));
      return true;
    } catch (e) {
      // A server that answers with an error status (no /models endpoint) is up; its configured models still serve.
      return e instanceof HttpError && !!this.explicitModels?.length;
    }
  }

  async listModels(signal?: AbortSignal): Promise<ModelInfo[]> {
    let models: OpenAIModel[] = [];
    try {
      // Together AI answers with a bare array instead of `{ data: [...] }`.
      const res = await getJson<OpenAIModel[] | { data?: OpenAIModel[] | null }>(this.modelsUrl, this.headers, withTimeout(5000, signal));
      models = Array.isArray(res) ? res : (res?.data ?? []);
    } catch (e) {
      if (!(e instanceof HttpError) || !this.explicitModels?.length) {
        throw e;
      }
    }
    if (this.explicitModels?.length) {
      const known = new Set(models.map((m) => m.id));
      for (const id of this.explicitModels) {
        if (!known.has(id)) {
          models.push({ id });
        }
      }
    }
    const colibri = models.some((m) => m.owned_by === COLIBRI_OWNER);
    this.engine = colibri ? 'colibri' : undefined;
    // colibri decodes one request per KV slot; its /health says how many there are.
    const slots = colibri ? colibriSlots(await colibriHealth(this.baseUrl, this.headers, signal)) : undefined;
    const native = !colibri && !this.remote && !this.noNativeApi && models.length && (this.lmStudio || !models.some(hasContextField))
      ? await fetchLmStudioContexts(this.baseUrl, this.headers, signal)
      : undefined;
    if (native === null && !this.lmStudio) {
      this.noNativeApi = true;
    }
    const listed = models
      .filter((m) => !/^(embeddings?|image|rerank|moderation|audio|transcribe|video)$/i.test(m.type ?? '') && !/embed/i.test(m.id))
      // Cloud listings mix in speech, image and moderation models; Mistral flags the ones that cannot chat.
      .filter((m) => !this.remote || (!isNonChatModel(m.id) && capabilityList(m)?.includes('completion_chat') !== false))
      // colibri decision (System One) and picture models cannot chat.
      .filter((m) => m.owned_by !== COLIBRI_OWNER || !m.capabilities || !!capabilityList(m)?.includes('chat'))
      .map((m) => {
        const facts = this.remote ? (modelFacts(m.id, this.factsKey) ?? anyModelFacts(m.id)) : undefined;
        const ctx =
          m.max_model_len ?? m.loaded_context_length ?? m.max_context_length ?? m.context_length ?? m.context_window ?? m.top_provider?.context_length ?? native?.get(m.id) ?? this.configuredCtx ?? (this.remote ? (facts?.contextWindow ?? knownContextWindow(m.id)) : undefined) ?? 32768;
        const caps = capabilityList(m);
        if (m.owned_by === COLIBRI_OWNER) {
          const spec = colibriSpec(m.id);
          return {
            id: `${this.id}/${m.id}`,
            providerId: this.id,
            modelId: m.id,
            name: m.id,
            family: COLIBRI_OWNER,
            contextWindow: ctx,
            maxOutputTokens: ctx,
            supportsTools: spec?.tools ?? true,
            supportsVision: m.input_modalities ? m.input_modalities.includes('image') : !!spec?.vision,
            // colibri's /v1/completions has no `suffix`, so fill-in-the-middle is not available.
            supportsFim: false,
            parameterSize: spec ? `${spec.paramsB}B` : undefined,
            runtime: 'colibri',
            residentGb: spec?.ramMinGb,
            diskGb: spec?.diskGb,
            parallelSlots: slots,
          } satisfies ModelInfo;
        }
        const vision = caps?.includes('vision') || (m.architecture?.input_modalities?.includes('image') ?? (this.remote ? !!facts?.vision || knownVision(m.id) : undefined));
        const info: ModelInfo = {
          id: `${this.id}/${m.id}`,
          providerId: this.id,
          modelId: m.id,
          name: m.id,
          family: m.owned_by,
          contextWindow: ctx,
          maxOutputTokens: outputLimit(facts, ctx, this.remote),
          // Most local OpenAI-compatible servers advertise tool support; we fall back to prompt-based tools otherwise.
          supportsTools: caps ? caps.includes('tool_use') || caps.includes('tools') || caps.includes('function_calling') : m.supported_parameters ? m.supported_parameters.includes('tools') : true,
          supportsVision: !!vision,
          // Cloud APIs have no `suffix`-style /completions (Mistral and DeepSeek use separate FIM endpoints).
          supportsFim: !this.remote && /coder|code|starcoder|codestral|deepseek/i.test(m.id),
          supportsThinking: facts?.reasoning || undefined,
          remote: this.remote || undefined,
          // Only the API the prices belong to is priced: a gateway's own prices are unknown.
          pricing: pricingOf(modelFacts(m.id, this.factsKey), this.factsKey),
        };
        // Local servers (Docker Model Runner, LM Studio, llama.cpp) say nothing about vision: go by the catalog, then the name.
        if (vision === undefined) {
          info.supportsVision = lookupCatalog(info)?.entry.supportsVision ?? /vl\b|vl-|vision|llava|pixtral|gemma-?3|gemma-?4|nemotron.*bolt|mistral-small-?3\.[12]|llama-?4|qwen.*vl/i.test(m.id);
        }
        return info;
      });
    return applyModelOverrides(listed, this.cfg.modelOverrides);
  }

  async *chat(opts: ChatRequestOptions): AsyncIterable<StreamEvent> {
    const messages = pairToolCalls(opts.messages).map((m) => toOpenAIMessage(m, isGeminiUrl(this.baseUrl)));
    if (isMistral(this.baseUrl, opts.model)) {
      mistralToolCallIds(messages);
    }
    const body: Record<string, unknown> = {
      model: opts.model,
      messages,
      stream: true,
      stream_options: { include_usage: true },
      ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
    };
    if (opts.maxTokens) {
      body.max_tokens = opts.maxTokens;
    }
    if (opts.stop?.length) {
      body.stop = opts.stop;
    }
    if (opts.tools?.length) {
      body.tools = opts.tools.map((t) => ({ type: 'function', function: t }));
      body.tool_choice = 'auto';
    }
    if (opts.jsonSchema) {
      body.response_format = { type: 'json_schema', json_schema: { name: 'response', schema: opts.jsonSchema } };
    }
    if (this.openRouter && opts.think !== undefined) {
      body.reasoning = openRouterReasoning(opts.think);
    } else if (typeof opts.think === 'string') {
      body.reasoning_effort = effortOf(opts.think);
    } else if (opts.think === false && this.remote) {
      body.reasoning_effort = 'none';
    } else if (opts.think === false) {
      // Qwen3-style chat templates (vLLM, SGLang, llama.cpp --jinja) read this to skip reasoning.
      body.chat_template_kwargs = { enable_thinking: false };
    }
    withExtraBody(body, this.cfg.extraBody);

    // Accumulate streamed tool-call fragments by index. Some servers (Gemini) send complete calls without an index, and
    // some gateways send index 0 for every call: those get keys above any real index, in arrival order.
    const pending = new Map<number, { id: string; name: string; args: string; extra?: Record<string, unknown> }>();
    let lastKey: number | undefined;
    let nextFree = 1000;
    let finish: string | undefined;
    const split = new ThinkTagSplitter();

    for await (const chunk of this.stream(opts.model, body, opts.signal)) {
      if (chunk.error) {
        throw streamError(chunk.error, `${this.baseUrl}/chat/completions`);
      }
      if (chunk.usage) {
        yield { type: 'usage', ...usageOf(chunk.usage) };
      }
      for (const choice of chunk.choices ?? []) {
        const d = choice.delta;
        const reasoning = d?.reasoning_content ?? d?.reasoning;
        if (reasoning) {
          yield { type: 'thinking', text: reasoning };
        }
        const c = d?.content;
        if (typeof c === 'string' && c) {
          yield* split.push(c);
        } else if (Array.isArray(c)) {
          for (const part of c) {
            if (part?.type === 'thinking') {
              const text = typeof part.thinking === 'string' ? part.thinking : (part.thinking ?? []).map((t) => (typeof t?.text === 'string' ? t.text : '')).join('');
              if (text) {
                yield { type: 'thinking', text };
              }
            } else if (part?.type === 'text' && typeof part.text === 'string') {
              yield* split.push(part.text);
            }
          }
        }
        for (const tc of d?.tool_calls ?? []) {
          const latest = lastKey === undefined ? undefined : pending.get(lastKey);
          let key: number;
          if (typeof tc.index === 'number') {
            const at = pending.get(tc.index);
            key = at?.id && tc.id && tc.id !== at.id ? nextFree++ : tc.index;
          } else if (!latest || (tc.id && tc.id !== latest.id) || (tc.function?.name && latest.name)) {
            key = nextFree++;
          } else {
            key = lastKey!;
          }
          lastKey = key;
          const cur = pending.get(key) ?? { id: tc.id || newId(), name: '', args: '' };
          if (tc.id) {
            cur.id = tc.id;
          }
          if (tc.function?.name) {
            cur.name += tc.function.name;
          }
          if (tc.function?.arguments) {
            cur.args += tc.function.arguments;
          }
          if (tc.extra_content) {
            cur.extra = { ...cur.extra, ...tc.extra_content };
          }
          pending.set(key, cur);
        }
        if (d?.tool_calls?.length) {
          yield { type: 'progress' };
        }
        if (choice.finish_reason) {
          finish = choice.finish_reason;
        }
      }
    }
    yield* split.flush();
    for (const [, tc] of [...pending.entries()].sort((a, b) => a[0] - b[0])) {
      yield { type: 'tool_call', call: { id: tc.id, name: tc.name, arguments: tc.args || '{}', ...(tc.extra ? { extra: tc.extra } : {}) } };
    }
    yield { type: 'done', finishReason: finish };
  }

  /**
   * Streams a chat completion. Cloud APIs reject parameters their models do not take (OpenAI reasoning models:
   * `temperature`, `max_tokens`; many: `reasoning_effort`, `stream_options`…): such a 4xx is answered by dropping or
   * renaming the parameter and asking again, before anything was streamed, and remembered for the model.
   */
  private async *stream(model: string, body: Record<string, unknown>, signal?: AbortSignal): AsyncGenerator<OpenAIChunk> {
    const learned = this.learnedFixes.get(model) ?? new Set<string>();
    for (const name of learned) {
      PARAM_FIXES.find((f) => f.name === name)?.apply(body);
    }
    for (let attempt = 0; ; attempt++) {
      const it = streamSse<OpenAIChunk>(this.url('/chat/completions'), body, this.headers, signal)[Symbol.asyncIterator]();
      let first: IteratorResult<OpenAIChunk>;
      try {
        first = await it.next();
      } catch (e) {
        const fix = attempt < PARAM_FIXES.length && e instanceof HttpError && e.status >= 400 && e.status < 500 ? PARAM_FIXES.find((f) => f.applies(body, e.body)) : undefined;
        if (!fix) {
          throw e;
        }
        fix.apply(body);
        learned.add(fix.name);
        this.learnedFixes.set(model, learned);
        continue;
      }
      for (let r = first; !r.done; r = await it.next()) {
        yield r.value;
      }
      return;
    }
  }

  async complete(opts: CompletionRequestOptions): Promise<string> {
    // Cloud APIs have no `/completions` with `suffix` (it is legacy or missing): fill in the middle through chat.
    if (this.remote || (opts.suffix && this.noSuffix.has(opts.model))) {
      return completeViaChat(this, opts);
    }
    const body: Record<string, unknown> = {
      model: opts.model,
      prompt: opts.prompt,
      max_tokens: opts.maxTokens ?? 128,
      temperature: opts.temperature ?? 0.1,
      stream: false,
    };
    if (opts.suffix) {
      body.suffix = opts.suffix;
    }
    if (opts.stop?.length) {
      body.stop = opts.stop;
    }
    try {
      const res = await postJson<{ choices?: { text?: string }[] }>(this.url('/completions'), body, this.headers, opts.signal);
      return res.choices?.[0]?.text ?? '';
    } catch (e) {
      if (!opts.suffix || opts.signal?.aborted || !/suffix/i.test(e instanceof Error ? e.message : String(e))) {
        throw e;
      }
      this.noSuffix.add(opts.model);
      return completeViaChat(this, opts);
    }
  }

  async embed(model: string, input: string[]): Promise<number[][]> {
    const res = await postJson<{ data: { embedding: number[] }[] }>(this.url('/embeddings'), { model, input }, this.headers);
    return res.data.map((d) => d.embedding);
  }
}

/** Capabilities as a list, whether the server sends one (LM Studio, vLLM) or Mistral's `{ function_calling: true, … }`. */
function capabilityList(m: OpenAIModel): string[] | undefined {
  const c = m.capabilities;
  return !c ? undefined : Array.isArray(c) ? c : Object.keys(c).filter((k) => c[k] === true);
}

interface ParamFix {
  name: string;
  /** The request carries the parameter and the error body names it. */
  applies(body: Record<string, unknown>, error: string): boolean;
  apply(body: Record<string, unknown>): void;
}

const dropParam = (key: string, mention: RegExp): ParamFix => ({
  name: key,
  applies: (body, error) => body[key] !== undefined && mention.test(error),
  apply: (body) => delete body[key],
});

/** Parameters cloud models are known to reject, in the order they are tried. */
const PARAM_FIXES: ParamFix[] = [
  {
    name: 'max_completion_tokens',
    applies: (body, error) => body.max_tokens !== undefined && /max_tokens/.test(error),
    apply: (body) => {
      if (body.max_tokens !== undefined) {
        body.max_completion_tokens = body.max_tokens;
        delete body.max_tokens;
      }
    },
  },
  dropParam('temperature', /temperature/i),
  {
    // Learned fixes replay on every request of the model: drop only the 'none' sent for think:false, not real levels.
    name: 'reasoning_effort_none',
    applies: (body, error) => body.reasoning_effort === 'none' && /reasoning/i.test(error),
    apply: (body) => {
      if (body.reasoning_effort === 'none') {
        delete body.reasoning_effort;
      }
    },
  },
  dropParam('reasoning_effort', /reasoning/i),
  dropParam('reasoning', /reasoning/i),
  dropParam('stream_options', /stream_options|include_usage/i),
  dropParam('response_format', /response_format|json_schema/i),
  dropParam('tool_choice', /tool_choice/i),
  dropParam('stop', /\bstop\b/i),
  dropParam('chat_template_kwargs', /chat_template_kwargs|enable_thinking/i),
];

function isGeminiUrl(url: string): boolean {
  try {
    return new URL(url).hostname === 'generativelanguage.googleapis.com';
  } catch {
    return false;
  }
}

function isMistral(url: string, model: string): boolean {
  try {
    if (new URL(url).hostname === 'api.mistral.ai') {
      return true;
    }
  } catch {
    // fall through to the model name
  }
  return /mistral|devstral|codestral|magistral|ministral|pixtral|voxtral/i.test(model);
}

/** Mistral rejects tool-call ids that are not exactly 9 alphanumerics: maps other ids (in place) to stable hashed ones. */
function mistralToolCallIds(messages: Record<string, unknown>[]): void {
  const valid = /^[a-zA-Z0-9]{9}$/;
  const mapped = new Map<string, string>();
  const used = new Set<string>();
  for (const m of messages) {
    for (const tc of (m.tool_calls as { id?: string }[] | undefined) ?? []) {
      if (tc.id && valid.test(tc.id)) {
        used.add(tc.id);
      }
    }
    if (typeof m.tool_call_id === 'string' && valid.test(m.tool_call_id)) {
      used.add(m.tool_call_id);
    }
  }
  const map = (id: string): string => {
    if (valid.test(id)) {
      return id;
    }
    let out = mapped.get(id);
    for (let n = 0; !out; n++) {
      const h = createHash('sha256').update(n ? `${id}#${n}` : id).digest('base64').replace(/[^a-zA-Z0-9]/g, '').slice(0, 9);
      if (h.length === 9 && !used.has(h)) {
        out = h;
        mapped.set(id, h);
        used.add(h);
      }
    }
    return out;
  };
  for (const m of messages) {
    for (const tc of (m.tool_calls as { id?: string }[] | undefined) ?? []) {
      if (tc.id) {
        tc.id = map(tc.id);
      }
    }
    if (typeof m.tool_call_id === 'string') {
      m.tool_call_id = map(m.tool_call_id);
    }
  }
}

/** `gemini`: Gemini 3 rejects a replayed tool call without its thought signature; calls from elsewhere skip the check. */
function toOpenAIMessage(m: ChatMessage, gemini = false): Record<string, unknown> {
  if (m.role === 'tool') {
    return { role: 'tool', tool_call_id: m.toolCallId, content: m.content };
  }
  const out: Record<string, unknown> = { role: m.role };
  if (m.images?.length && m.role === 'user') {
    out.content = [
      { type: 'text', text: m.content },
      ...m.images.map((b64) => ({ type: 'image_url', image_url: { url: `data:${imageMime(b64)};base64,${b64}` } })),
    ];
  } else {
    out.content = m.content ?? '';
  }
  if (m.toolCalls?.length) {
    out.tool_calls = m.toolCalls.map((tc) => {
      const extra = tc.extra ?? (gemini ? { google: { thought_signature: 'skip_thought_signature_validator' } } : undefined);
      return { id: tc.id, type: 'function', function: { name: tc.name, arguments: tc.arguments }, ...(extra ? { extra_content: extra } : {}) };
    });
    if (!m.content) {
      out.content = null;
    }
  }
  return out;
}
