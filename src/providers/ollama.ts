import {
  ChatMessage,
  ChatRequestOptions,
  CompletionRequestOptions,
  LLMProvider,
  ModelInfo,
  ProviderConfig,
  StreamEvent,
} from '../types';
import { getJson, newId, postJson, streamLines, withTimeout } from './http';

interface OllamaTag {
  name: string;
  model: string;
  details?: { family?: string; families?: string[]; parameter_size?: string };
}
interface OllamaShow {
  capabilities?: string[];
  model_info?: Record<string, unknown>;
  details?: { family?: string };
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
  readonly baseUrl: string;
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
      return false;
    }
  }

  async listModels(signal?: AbortSignal): Promise<ModelInfo[]> {
    const res = await getJson<{ models: OllamaTag[] }>(`${this.baseUrl}/api/tags`, this.headers, withTimeout(5000, signal));
    const models = res.models ?? [];
    // Fetch capabilities in parallel but tolerate failures.
    const infos = await Promise.all(
      models.map(async (m) => {
        const cached = this.infoCache.get(m.name);
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
          supportsFim: caps.includes('insert') || /coder|code|starcoder|deepseek/i.test(m.name),
        };
        this.infoCache.set(m.name, info);
        return info;
      })
    );
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
    if (opts.think !== undefined) {
      body.think = opts.think;
    }
    for await (const line of streamLines(`${this.baseUrl}/api/chat`, body, this.headers, opts.signal)) {
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
        yield { type: 'text', text: msg.content };
      }
      for (const tc of msg?.tool_calls ?? []) {
        const args = typeof tc.function.arguments === 'string' ? tc.function.arguments : JSON.stringify(tc.function.arguments ?? {});
        yield { type: 'tool_call', call: { id: tc.id ?? newId(), name: tc.function.name, arguments: args } };
      }
      if (chunk.done) {
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
        },
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
