import {
  ChatMessage,
  ChatRequestOptions,
  CompletionRequestOptions,
  LLMProvider,
  ModelInfo,
  ProviderConfig,
  StreamEvent,
} from '../types';
import { getJson, newId, postJson, streamSse, withTimeout } from './http';

interface OpenAIModel {
  id: string;
  owned_by?: string;
  /** LM Studio / vLLM extensions */
  max_model_len?: number;
  context_length?: number;
  max_context_length?: number;
  loaded_context_length?: number;
  type?: string;
  capabilities?: string[];
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
  readonly displayName: string;
  readonly baseUrl: string;
  private readonly headers: Record<string, string>;
  private readonly explicitModels?: string[];
  private readonly defaultCtx: number;

  constructor(cfg: ProviderConfig) {
    this.id = cfg.id;
    this.displayName = cfg.displayName ?? cfg.id;
    this.baseUrl = cfg.baseUrl.replace(/\/+$/, '');
    this.headers = cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {};
    this.explicitModels = cfg.models;
    this.defaultCtx = cfg.contextWindow ?? 32768;
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
    return models
      .filter((m) => m.type !== 'embeddings' && !/embed/i.test(m.id))
      .map((m) => {
        const ctx = m.max_model_len ?? m.loaded_context_length ?? m.max_context_length ?? m.context_length ?? this.defaultCtx;
        return {
          id: `${this.id}/${m.id}`,
          providerId: this.id,
          modelId: m.id,
          name: m.id,
          family: m.owned_by,
          contextWindow: ctx,
          maxOutputTokens: 8192,
          // Most local OpenAI-compatible servers advertise tool support; we fall back to prompt-based tools otherwise.
          supportsTools: m.capabilities ? m.capabilities.includes('tool_use') || m.capabilities.includes('tools') : true,
          supportsVision: m.capabilities?.includes('vision') ?? /vl|vision|llava|pixtral|gemma-3|qwen.*vl/i.test(m.id),
          supportsFim: /coder|code|starcoder|codestral|deepseek/i.test(m.id),
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

    for await (const chunk of streamSse<OpenAIChunk>(`${this.baseUrl}/chat/completions`, body, this.headers, opts.signal)) {
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
          yield { type: 'text', text: d.content };
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
    for (const [, tc] of [...pending.entries()].sort((a, b) => a[0] - b[0])) {
      yield { type: 'tool_call', call: { id: tc.id, name: tc.name, arguments: tc.args || '{}' } };
    }
    yield { type: 'done', finishReason: finish };
  }

  async complete(opts: CompletionRequestOptions): Promise<string> {
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
