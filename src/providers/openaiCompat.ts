import {
  ChatMessage,
  ChatRequestOptions,
  CompletionRequestOptions,
  LLMProvider,
  ModelInfo,
  ProviderConfig,
  StreamEvent,
} from '../types';
import { completeViaChat, isAzureUrl, isCloudProvider, isNonChatModel, knownContextWindow, knownVision, resolveApiKey } from './cloud';
import { colibriHealth, colibriSlots, colibriSpec, COLIBRI_OWNER } from './colibri';
import { getJson, HttpError, newId, postJson, streamSse, withTimeout } from './http';
import { ThinkTagSplitter } from './thinkTags';

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
      content?: string | null;
      reasoning_content?: string | null;
      reasoning?: string | null;
      tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string } }[];
    };
    finish_reason?: string | null;
  }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: { message?: string } | string;
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
  private readonly configuredName: string;
  /** Engine the server identified itself as on the last model listing. */
  engine?: 'colibri';

  /** The configured name, unless it is the stock vLLM label on :8000 and the server turned out to be colibri. */
  get displayName(): string {
    return this.engine === 'colibri' && STOCK_NAMES.test(this.configuredName) ? 'colibri' : this.configuredName;
  }

  constructor(cfg: ProviderConfig) {
    this.id = cfg.id;
    this.configuredName = cfg.displayName ?? cfg.id;
    this.baseUrl = cfg.baseUrl.replace(/\/+$/, '');
    const key = resolveApiKey(cfg);
    this.headers = !key ? {} : isAzureUrl(this.baseUrl) ? { 'api-key': key } : { authorization: `Bearer ${key}` };
    this.explicitModels = cfg.models;
    this.configuredCtx = cfg.contextWindow;
    this.remote = isCloudProvider(cfg);
  }

  async healthCheck(signal?: AbortSignal): Promise<boolean> {
    try {
      await getJson(`${this.baseUrl}/models`, this.headers, withTimeout(2500, signal));
      return true;
    } catch {
      return false;
    }
  }

  async listModels(signal?: AbortSignal): Promise<ModelInfo[]> {
    let models: OpenAIModel[] = [];
    try {
      const res = await getJson<{ data: OpenAIModel[] }>(`${this.baseUrl}/models`, this.headers, withTimeout(5000, signal));
      models = res.data ?? [];
    } catch (e) {
      if (!this.explicitModels?.length) {
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
    return models
      .filter((m) => m.type !== 'embeddings' && !/embed/i.test(m.id))
      // Cloud listings mix in speech, image and moderation models; Mistral flags the ones that cannot chat.
      .filter((m) => !this.remote || (!isNonChatModel(m.id) && capabilityList(m)?.includes('completion_chat') !== false))
      // colibri decision (System One) and picture models cannot chat.
      .filter((m) => m.owned_by !== COLIBRI_OWNER || !m.capabilities || !!capabilityList(m)?.includes('chat'))
      .map((m) => {
        const ctx =
          m.max_model_len ?? m.loaded_context_length ?? m.max_context_length ?? m.context_length ?? m.context_window ?? m.top_provider?.context_length ?? this.configuredCtx ?? (this.remote ? knownContextWindow(m.id) : undefined) ?? 32768;
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
            maxOutputTokens: 8192,
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
        return {
          id: `${this.id}/${m.id}`,
          providerId: this.id,
          modelId: m.id,
          name: m.id,
          family: m.owned_by,
          contextWindow: ctx,
          maxOutputTokens: 8192,
          // Most local OpenAI-compatible servers advertise tool support; we fall back to prompt-based tools otherwise.
          supportsTools: caps ? caps.includes('tool_use') || caps.includes('tools') || caps.includes('function_calling') : m.supported_parameters ? m.supported_parameters.includes('tools') : true,
          supportsVision: caps?.includes('vision') || (m.architecture?.input_modalities?.includes('image') ?? (this.remote ? knownVision(m.id) : /vl|vision|llava|pixtral|gemma-3|qwen.*vl/i.test(m.id))),
          // Cloud APIs have no `suffix`-style /completions (Mistral and DeepSeek use separate FIM endpoints).
          supportsFim: !this.remote && /coder|code|starcoder|codestral|deepseek/i.test(m.id),
          remote: this.remote || undefined,
        } satisfies ModelInfo;
      });
  }

  async *chat(opts: ChatRequestOptions): AsyncIterable<StreamEvent> {
    const body: Record<string, unknown> = {
      model: opts.model,
      messages: opts.messages.map(toOpenAIMessage),
      stream: true,
      stream_options: { include_usage: true },
      temperature: opts.temperature ?? 0.2,
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
    if (typeof opts.think === 'string') {
      body.reasoning_effort = opts.think;
    }

    // Accumulate streamed tool-call fragments by index.
    const pending = new Map<number, { id: string; name: string; args: string }>();
    let finish: string | undefined;
    const split = new ThinkTagSplitter();

    for await (const chunk of this.stream(opts.model, body, opts.signal)) {
      if (chunk.error) {
        throw new Error(typeof chunk.error === 'string' ? chunk.error : chunk.error.message ?? 'provider error');
      }
      if (chunk.usage) {
        yield { type: 'usage', promptTokens: chunk.usage.prompt_tokens, completionTokens: chunk.usage.completion_tokens };
      }
      for (const choice of chunk.choices ?? []) {
        const d = choice.delta;
        const reasoning = d?.reasoning_content ?? d?.reasoning;
        if (reasoning) {
          yield { type: 'thinking', text: reasoning };
        }
        if (d?.content) {
          yield* split.push(d.content);
        }
        for (const tc of d?.tool_calls ?? []) {
          const idx = tc.index ?? 0;
          const cur = pending.get(idx) ?? { id: tc.id ?? newId(), name: '', args: '' };
          if (tc.id) {
            cur.id = tc.id;
          }
          if (tc.function?.name) {
            cur.name += tc.function.name;
          }
          if (tc.function?.arguments) {
            cur.args += tc.function.arguments;
          }
          pending.set(idx, cur);
        }
        if (choice.finish_reason) {
          finish = choice.finish_reason;
        }
      }
    }
    yield* split.flush();
    for (const [, tc] of [...pending.entries()].sort((a, b) => a[0] - b[0])) {
      yield { type: 'tool_call', call: { id: tc.id, name: tc.name, arguments: tc.args || '{}' } };
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
      const it = streamSse<OpenAIChunk>(`${this.baseUrl}/chat/completions`, body, this.headers, signal)[Symbol.asyncIterator]();
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
    if (this.remote) {
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
    const res = await postJson<{ choices?: { text?: string }[] }>(`${this.baseUrl}/completions`, body, this.headers, opts.signal);
    return res.choices?.[0]?.text ?? '';
  }

  async embed(model: string, input: string[]): Promise<number[][]> {
    const res = await postJson<{ data: { embedding: number[] }[] }>(`${this.baseUrl}/embeddings`, { model, input }, this.headers);
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
  dropParam('reasoning_effort', /reasoning/i),
  dropParam('stream_options', /stream_options|include_usage/i),
  dropParam('response_format', /response_format|json_schema/i),
  dropParam('tool_choice', /tool_choice/i),
  dropParam('stop', /\bstop\b/i),
];

function toOpenAIMessage(m: ChatMessage): Record<string, unknown> {
  if (m.role === 'tool') {
    return { role: 'tool', tool_call_id: m.toolCallId, content: m.content };
  }
  const out: Record<string, unknown> = { role: m.role };
  if (m.images?.length && m.role === 'user') {
    out.content = [
      { type: 'text', text: m.content },
      ...m.images.map((b64) => ({ type: 'image_url', image_url: { url: `data:image/png;base64,${b64}` } })),
    ];
  } else {
    out.content = m.content ?? '';
  }
  if (m.toolCalls?.length) {
    out.tool_calls = m.toolCalls.map((tc) => ({ id: tc.id, type: 'function', function: { name: tc.name, arguments: tc.arguments } }));
    if (!m.content) {
      out.content = null;
    }
  }
  return out;
}
