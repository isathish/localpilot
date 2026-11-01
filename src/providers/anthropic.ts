import { ChatMessage, ChatRequestOptions, CompletionRequestOptions, LLMProvider, ModelInfo, ProviderConfig, StreamEvent, ToolCall } from '../types';
import { isRemoteUrl, knownContextWindow, resolveApiKey } from './cloud';
import { getJson, newId, postJson, streamSse, withTimeout } from './http';

const API_VERSION = '2023-06-01';

interface AnthropicModel {
  id: string;
  display_name?: string;
  max_input_tokens?: number;
  max_tokens?: number;
}

type Block =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; content: string };

interface AnthropicEvent {
  type: string;
  index?: number;
  message?: { usage?: { input_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } };
  content_block?: { type: string; id?: string; name?: string; text?: string };
  delta?: { type?: string; text?: string; thinking?: string; partial_json?: string; stop_reason?: string };
  usage?: { output_tokens?: number };
  error?: { message?: string };
}

/** Claude through Anthropic's Messages API (`/v1/messages`): streaming, native tool use and images. */
export class AnthropicProvider implements LLMProvider {
  readonly type = 'anthropic' as const;
  readonly id: string;
  readonly displayName: string;
  readonly baseUrl: string;
  private readonly headers: Record<string, string>;
  private readonly configuredCtx?: number;
  private readonly explicitModels?: string[];

  constructor(cfg: ProviderConfig) {
    this.id = cfg.id;
    this.displayName = cfg.displayName ?? 'Anthropic';
    this.baseUrl = cfg.baseUrl.replace(/\/+$/, '');
    const key = resolveApiKey(cfg);
    this.headers = { 'anthropic-version': API_VERSION, ...(key ? { 'x-api-key': key } : {}) };
    this.configuredCtx = cfg.contextWindow;
    this.explicitModels = cfg.models;
  }

  async healthCheck(signal?: AbortSignal): Promise<boolean> {
    try {
      await getJson(`${this.baseUrl}/models?limit=1`, this.headers, withTimeout(4000, signal));
      return true;
    } catch {
      return false;
    }
  }

  async listModels(signal?: AbortSignal): Promise<ModelInfo[]> {
    const listed: AnthropicModel[] = [];
    let after: string | undefined;
    for (let page = 0; page < 10; page++) {
      const res = await getJson<{ data?: AnthropicModel[]; has_more?: boolean; last_id?: string }>(
        `${this.baseUrl}/models?limit=1000${after ? `&after_id=${encodeURIComponent(after)}` : ''}`,
        this.headers,
        withTimeout(8000, signal)
      );
      listed.push(...(res.data ?? []));
      if (!res.has_more || !res.last_id) {
        break;
      }
      after = res.last_id;
    }
    for (const id of this.explicitModels ?? []) {
      if (!listed.some((m) => m.id === id)) {
        listed.push({ id });
      }
    }
    return listed.map((m) => ({
      id: `${this.id}/${m.id}`,
      providerId: this.id,
      modelId: m.id,
      name: m.display_name ?? m.id,
      family: 'claude',
      contextWindow: m.max_input_tokens ?? this.configuredCtx ?? knownContextWindow(m.id) ?? 200_000,
      maxOutputTokens: m.max_tokens ?? 8192,
      supportsTools: true,
      supportsVision: !/claude-(2|instant)/i.test(m.id),
      supportsFim: false,
      remote: isRemoteUrl(this.baseUrl) || undefined,
    }));
  }

  async *chat(opts: ChatRequestOptions): AsyncIterable<StreamEvent> {
    const { system, messages } = toAnthropicMessages(opts.messages);
    const body: Record<string, unknown> = {
      model: opts.model,
      messages,
      max_tokens: opts.maxTokens ?? 8192,
      temperature: opts.temperature ?? 0.2,
      stream: true,
    };
    if (system) {
      body.system = system;
    }
    if (opts.stop?.length) {
      body.stop_sequences = opts.stop.filter((s) => s.trim());
    }
    if (opts.tools?.length) {
      body.tools = opts.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }));
    }

    // Tool calls arrive as a content block start (id, name) followed by JSON fragments, keyed by block index.
    const pending = new Map<number, { id: string; name: string; args: string }>();
    let finish: string | undefined;
    let promptTokens: number | undefined;
    for await (const ev of streamSse<AnthropicEvent>(`${this.baseUrl}/messages`, body, this.headers, opts.signal)) {
      switch (ev.type) {
        case 'error':
          throw new Error(ev.error?.message ?? 'provider error');
        case 'message_start': {
          const u = ev.message?.usage;
          promptTokens = u ? (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) : undefined;
          break;
        }
        case 'content_block_start':
          if (ev.content_block?.type === 'tool_use') {
            pending.set(ev.index ?? 0, { id: ev.content_block.id ?? newId(), name: ev.content_block.name ?? '', args: '' });
          } else if (ev.content_block?.type === 'text' && ev.content_block.text) {
            yield { type: 'text', text: ev.content_block.text };
          }
          break;
        case 'content_block_delta': {
          const d = ev.delta;
          if (d?.type === 'text_delta' && d.text) {
            yield { type: 'text', text: d.text };
          } else if (d?.type === 'thinking_delta' && d.thinking) {
            yield { type: 'thinking', text: d.thinking };
          } else if (d?.type === 'input_json_delta' && d.partial_json) {
            const cur = pending.get(ev.index ?? 0);
            if (cur) {
              cur.args += d.partial_json;
            }
          }
          break;
        }
        case 'message_delta':
          finish = ev.delta?.stop_reason ?? finish;
          if (ev.usage) {
            yield { type: 'usage', promptTokens, completionTokens: ev.usage.output_tokens };
          }
          break;
      }
    }
    for (const [, tc] of [...pending.entries()].sort((a, b) => a[0] - b[0])) {
      yield { type: 'tool_call', call: { id: tc.id, name: tc.name, arguments: tc.args || '{}' } };
    }
    yield { type: 'done', finishReason: finish === 'tool_use' ? 'tool_calls' : finish === 'max_tokens' ? 'length' : finish === 'end_turn' ? 'stop' : finish };
  }

  /** No fill-in-the-middle endpoint: a plain continuation of the prompt (Claude models are never routed to ghost text). */
  async complete(opts: CompletionRequestOptions): Promise<string> {
    const res = await postJson<{ content?: { type: string; text?: string }[] }>(
      `${this.baseUrl}/messages`,
      {
        model: opts.model,
        max_tokens: opts.maxTokens ?? 128,
        temperature: opts.temperature ?? 0.1,
        ...(opts.stop?.length ? { stop_sequences: opts.stop.filter((s) => s.trim()) } : {}),
        messages: [{ role: 'user', content: opts.prompt }],
      },
      this.headers,
      opts.signal
    );
    return (res.content ?? []).map((b) => b.text ?? '').join('');
  }
}

/** Tool-use ids must match `^[a-zA-Z0-9_-]+$`; ids from another provider earlier in the chat may not. */
const safeId = (id: string | undefined) => (id || 'call').replace(/[^a-zA-Z0-9_-]/g, '_');

/**
 * Converts the chat to Messages API shape: system text becomes the top-level `system`, tool results become
 * `tool_result` blocks in a user turn, and consecutive turns of the same role are merged (the API wants them alternating).
 */
export function toAnthropicMessages(input: ChatMessage[]): { system: string; messages: { role: 'user' | 'assistant'; content: Block[] }[] } {
  const system: string[] = [];
  const out: { role: 'user' | 'assistant'; content: Block[] }[] = [];
  const push = (role: 'user' | 'assistant', blocks: Block[]) => {
    if (!blocks.length) {
      return;
    }
    const last = out[out.length - 1];
    if (last && last.role === role) {
      last.content.push(...blocks);
    } else {
      out.push({ role, content: blocks });
    }
  };
  for (const m of input) {
    if (m.role === 'system') {
      if (m.content.trim()) {
        system.push(m.content);
      }
    } else if (m.role === 'tool') {
      push('user', [{ type: 'tool_result', tool_use_id: safeId(m.toolCallId), content: m.content || '(no output)' }]);
    } else if (m.role === 'assistant') {
      const blocks: Block[] = m.content?.trim() ? [{ type: 'text', text: m.content }] : [];
      for (const tc of m.toolCalls ?? []) {
        blocks.push({ type: 'tool_use', id: safeId(tc.id), name: tc.name, input: parseArgs(tc) });
      }
      push('assistant', blocks);
    } else {
      const blocks: Block[] = (m.images ?? []).map((data) => ({ type: 'image', source: { type: 'base64', media_type: 'image/png', data } }));
      if (m.content?.trim()) {
        blocks.push({ type: 'text', text: m.content });
      }
      push('user', blocks);
    }
  }
  // The conversation must open with a user turn.
  if (out[0]?.role === 'assistant') {
    out.unshift({ role: 'user', content: [{ type: 'text', text: '(continue)' }] });
  }
  return { system: system.join('\n\n'), messages: out };
}

function parseArgs(tc: ToolCall): unknown {
  try {
    const v = JSON.parse(tc.arguments || '{}');
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}
