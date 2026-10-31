import {
  ChatMessage,
  ChatRequestOptions,
  CompletionRequestOptions,
  LLMProvider,
  ModelInfo,
  ProviderConfig,
  StreamEvent,
  WarmOptions,
} from '../types';
import { getJson, newId, postJson, streamLines, withTimeout } from './http';
import { ThinkTagSplitter } from './thinkTags';

interface OllamaTag {
  name: string;
  model: string;
  size?: number;
  digest?: string;
  details?: { family?: string; families?: string[]; parameter_size?: string };
}
interface OllamaShow {
  capabilities?: string[];
  model_info?: Record<string, unknown>;
  details?: { family?: string; parameter_size?: string };
}
interface OllamaChatChunk {
  message?: {
    role: string;
    content?: string;
    thinking?: string;
    tool_calls?: { id?: string; function: { name: string; arguments: Record<string, unknown> | string } }[];
  };
  done: boolean;
  done_reason?: string;
  prompt_eval_count?: number;
  eval_count?: number;
  error?: string;
}

/** Native Ollama provider (`/api/chat`, `/api/generate`, `/api/tags`, `/api/show`). */
export class OllamaProvider implements LLMProvider {
  readonly type = 'ollama' as const;
  readonly id: string;
  readonly displayName: string;
  baseUrl: string;
  private readonly headers: Record<string, string>;
  private readonly defaultCtx: number;
  private infoCache = new Map<string, ModelInfo>();

  constructor(cfg: ProviderConfig) {
    this.id = cfg.id;
    this.displayName = cfg.displayName ?? 'Ollama';
    this.baseUrl = cfg.baseUrl.replace(/\/+$/, '');
    this.headers = cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {};
    this.defaultCtx = cfg.contextWindow ?? 32768;
  }

  async healthCheck(signal?: AbortSignal): Promise<boolean> {
    try {
      await getJson(`${this.baseUrl}/api/version`, this.headers, withTimeout(2500, signal));
      return true;
    } catch {
      // Windows resolves `localhost` to ::1 first while Ollama binds 127.0.0.1 only: a server that is up looks down.
      // Retry on the IPv4 loopback and, when that answers, keep using it for this provider.
      if (/\/\/localhost[:/]/i.test(this.baseUrl)) {
        const v4 = this.baseUrl.replace(/\/\/localhost/i, '//127.0.0.1');
        try {
          await getJson(`${v4}/api/version`, this.headers, withTimeout(2500, signal));
          this.baseUrl = v4;
          return true;
        } catch {
          /* really down */
        }
      }
      return false;
    }
  }

  async listModels(signal?: AbortSignal): Promise<ModelInfo[]> {
    const res = await getJson<{ models: OllamaTag[] }>(`${this.baseUrl}/api/tags`, this.headers, withTimeout(5000, signal));
    const models = res.models ?? [];
    // Fetch capabilities for models not seen before, a few at a time: /api/show loads model metadata
    // from disk, and a user with twenty tags should not see Ollama freeze on every discovery.
    const infos = await mapLimit(models, 4, async (m) => {
        // Keyed by digest too: a re-pulled tag (new weights, maybe new capabilities) is inspected again.
        const key = `${m.name}@${m.digest ?? ''}`;
        const cached = this.infoCache.get(key);
        if (cached) {
          return cached;
        }
        let show: OllamaShow | undefined;
        try {
          show = await postJson<OllamaShow>(`${this.baseUrl}/api/show`, { model: m.name }, this.headers, withTimeout(5000, signal));
        } catch {
          show = undefined;
        }
        const caps = show?.capabilities ?? [];
        const ctxKey = Object.keys(show?.model_info ?? {}).find((k) => k.endsWith('.context_length'));
        const ctx = ctxKey ? Number(show!.model_info![ctxKey]) : this.defaultCtx;
        const info: ModelInfo = {
          id: `${this.id}/${m.name}`,
          providerId: this.id,
          modelId: m.name,
          name: m.name,
          family: show?.details?.family ?? m.details?.family,
          contextWindow: Number.isFinite(ctx) && ctx > 0 ? ctx : this.defaultCtx,
          maxOutputTokens: 8192,
          supportsTools: caps.includes('tools'),
          supportsVision: caps.includes('vision'),
          // Older Ollama versions list no capabilities at all: unknown, not "cannot think".
          supportsThinking: caps.length ? caps.includes('thinking') : undefined,
          supportsFim: caps.includes('insert') || /coder|code|starcoder|deepseek/i.test(m.name),
          sizeBytes: typeof m.size === 'number' && m.size > 0 ? m.size : undefined,
          parameterSize: show?.details?.parameter_size ?? m.details?.parameter_size,
        };
        this.infoCache.set(key, info);
        return info;
      });
    return infos.filter((i) => !/embed/i.test(i.modelId));
  }

  async *chat(opts: ChatRequestOptions): AsyncIterable<StreamEvent> {
    const body: Record<string, unknown> = {
      model: opts.model,
      messages: opts.messages.map(toOllamaMessage),
      stream: true,
      options: {
        temperature: opts.temperature ?? 0.2,
        num_ctx: opts.contextWindow ?? this.defaultCtx,
        ...(opts.maxTokens ? { num_predict: opts.maxTokens } : {}),
        ...(opts.stop?.length ? { stop: opts.stop } : {}),
      },
    };
    if (opts.tools?.length) {
      body.tools = opts.tools.map((t) => ({ type: 'function', function: t }));
    }
    if (opts.jsonSchema) {
      body.format = opts.jsonSchema;
    }
    // A model without thinking support rejects any `think` value; it is dropped once Ollama has said so.
    if (opts.think !== undefined && !this.noThink.has(opts.model)) {
      body.think = ollamaThink(opts.model, opts.think);
    }
    if (opts.keepAlive) {
      body.keep_alive = opts.keepAlive;
    }
    try {
      yield* this.streamChat(body, opts.signal);
    } catch (e) {
      if (!('think' in body) || !/does not support thinking/i.test(e instanceof Error ? e.message : String(e))) {
        throw e;
      }
      this.noThink.add(opts.model);
      delete body.think;
      yield* this.streamChat(body, opts.signal);
    }
  }

  /** Models this server said cannot think: `think` is no longer sent for them. */
  private readonly noThink = new Set<string>();

  private async *streamChat(body: Record<string, unknown>, signal?: AbortSignal): AsyncIterable<StreamEvent> {
    const split = new ThinkTagSplitter();
    for await (const line of streamLines(`${this.baseUrl}/api/chat`, body, this.headers, signal)) {
      let chunk: OllamaChatChunk;
      try {
        chunk = JSON.parse(line);
      } catch {
        continue;
      }
      if (chunk.error) {
        throw new Error(chunk.error);
      }
      const msg = chunk.message;
      if (msg?.thinking) {
        yield { type: 'thinking', text: msg.thinking };
      }
      if (msg?.content) {
        yield* split.push(msg.content);
      }
      for (const tc of msg?.tool_calls ?? []) {
        const args = typeof tc.function.arguments === 'string' ? tc.function.arguments : JSON.stringify(tc.function.arguments ?? {});
        yield { type: 'tool_call', call: { id: tc.id ?? newId(), name: tc.function.name, arguments: args } };
      }
      if (chunk.done) {
        yield* split.flush();
        yield { type: 'usage', promptTokens: chunk.prompt_eval_count, completionTokens: chunk.eval_count };
        yield { type: 'done', finishReason: chunk.done_reason };
      }
    }
  }

  async complete(opts: CompletionRequestOptions): Promise<string> {
    const res = await postJson<{ response: string }>(
      `${this.baseUrl}/api/generate`,
      {
        model: opts.model,
        prompt: opts.prompt,
        suffix: opts.suffix,
        stream: false,
        options: {
          temperature: opts.temperature ?? 0.1,
          num_predict: opts.maxTokens ?? 128,
          stop: opts.stop,
          // Without it Ollama uses its own default window; a model already loaded for chat would be reloaded for every completion.
          num_ctx: opts.contextWindow ?? this.defaultCtx,
        },
        ...(opts.keepAlive ? { keep_alive: opts.keepAlive } : {}),
      },
      this.headers,
      opts.signal
    );
    return res.response ?? '';
  }

  async embed(model: string, input: string[]): Promise<number[][]> {
    const res = await postJson<{ embeddings: number[][] }>(`${this.baseUrl}/api/embed`, { model, input }, this.headers);
    return res.embeddings;
  }

  /**
   * An empty `messages` array makes Ollama load the weights (and keep them for `keep_alive`) without generating
   * anything. `num_ctx` must be the one the chat will send: a different value makes Ollama reload the model.
   */
  async warm(model: string, opts: WarmOptions, signal?: AbortSignal): Promise<void> {
    const body: Record<string, unknown> = { model, messages: [], stream: false };
    if (opts.keepAlive) {
      body.keep_alive = opts.keepAlive;
    }
    body.options = { num_ctx: opts.contextWindow ?? this.defaultCtx };
    await postJson(`${this.baseUrl}/api/chat`, body, this.headers, signal);
  }

  async loadedModels(signal?: AbortSignal): Promise<string[]> {
    const res = await getJson<{ models?: { name?: string; model?: string }[] }>(`${this.baseUrl}/api/ps`, this.headers, withTimeout(1500, signal));
    return (res.models ?? []).map((m) => m.name ?? m.model ?? '').filter(Boolean);
  }
}

function toOllamaMessage(m: ChatMessage): Record<string, unknown> {
  const out: Record<string, unknown> = { role: m.role, content: m.content ?? '' };
  if (m.images?.length) {
    out.images = m.images;
  }
  if (m.toolCalls?.length) {
    out.tool_calls = m.toolCalls.map((tc) => ({
      id: tc.id,
      function: { name: tc.name, arguments: safeParse(tc.arguments) },
    }));
  }
  if (m.role === 'tool' && m.toolName) {
    out.tool_name = m.toolName;
  }
  return out;
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return { input: s };
  }
}

/** `Promise.all(items.map(fn))` with at most `limit` calls in flight; results keep the input order. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/**
 * Ollama documents effort levels for gpt-oss only; other thinking models take true/false. A level becomes a switch
 * there: "low" (light work: Ask, subagents) skips the reasoning pass, "medium"/"high" turn it on.
 */
export function ollamaThink(model: string, think: boolean | 'low' | 'medium' | 'high'): boolean | 'low' | 'medium' | 'high' {
  if (typeof think === 'boolean' || /gpt-oss/i.test(model)) {
    return think;
  }
  return think !== 'low';
}

