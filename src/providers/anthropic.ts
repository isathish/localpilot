import { ChatMessage, ChatRequestOptions, CompletionRequestOptions, LLMProvider, ModelInfo, ProviderConfig, StreamEvent, ToolCall } from '../types';
import { completeViaChat, isCloudProvider, knownContextWindow, resolveApiKey } from './cloud';
import { getJson, HttpError, newId, streamSse, withTimeout } from './http';
import { imageMime } from './imageMime';
import { pairToolCalls } from './toolPairing';

const API_VERSION = '2023-06-01';

interface AnthropicModel {
  id: string;
  display_name?: string;
  max_input_tokens?: number;
  max_tokens?: number;
}

/** Reasoning blocks of a reply, replayed unchanged (signature included) in the tool loop that follows it. */
type ThinkingBlock = { type: 'thinking'; thinking: string; signature: string } | { type: 'redacted_thinking'; data: string };

type Block =
  | ThinkingBlock
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; content: string };

type Turn = { role: 'user' | 'assistant'; content: Block[] };

interface AnthropicEvent {
  type: string;
  index?: number;
  message?: { usage?: { input_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } };
  content_block?: { type: string; id?: string; name?: string; text?: string; thinking?: string; signature?: string; data?: string };
  delta?: { type?: string; text?: string; thinking?: string; signature?: string; partial_json?: string; stop_reason?: string };
  usage?: { output_tokens?: number };
  error?: { type?: string; message?: string };
}

/** HTTP status equivalent of an error event sent inside the stream, so it is retried like the same error sent as a response. */
const STREAM_ERROR_STATUS: Record<string, number> = { overloaded_error: 529, api_error: 500, rate_limit_error: 429, request_too_large: 413, authentication_error: 401, permission_error: 403, billing_error: 402, invalid_request_error: 400 };

/**
 * How a Claude model takes the `thinking` option:
 * - `always`: thinking cannot be turned off (Fable, Mythos, Opus 5.5) — the setting is omitted, effort sets the depth;
 * - `adaptive`: `{ type: 'adaptive' }` plus `output_config.effort` (Claude 4.6 and later);
 * - `budget`: `{ type: 'enabled', budget_tokens }` (Claude 3.7 and 4.x before 4.6);
 * - `none`: no extended thinking (Claude 3.5 and older).
 */
export type ThinkingStyle = 'always' | 'adaptive' | 'budget' | 'none';

export function thinkingStyle(model: string): ThinkingStyle {
  const n = model.toLowerCase();
  if (/claude-(fable|mythos)|claude-opus-5-5/.test(n)) {
    return 'always';
  }
  if (/claude-(opus|sonnet|haiku)-([5-9]|4-[6-9])/.test(n)) {
    return 'adaptive';
  }
  if (/claude-(opus|sonnet|haiku)-4|claude-3-7/.test(n)) {
    return 'budget';
  }
  return 'none';
}

const BUDGET: Record<'low' | 'medium' | 'high', number> = { low: 2048, medium: 6000, high: 12000 };

/** Claude through Anthropic's Messages API (`/v1/messages`): streaming, tool use, images, thinking and prompt caching. */
export class AnthropicProvider implements LLMProvider {
  readonly type = 'anthropic' as const;
  readonly id: string;
  readonly displayName: string;
  readonly baseUrl: string;
  private readonly headers: Record<string, string>;
  private readonly configuredCtx?: number;
  private readonly explicitModels?: string[];
  private readonly remote: boolean;
  /** Thinking blocks by the first tool-use id of the reply they came with (bounded; oldest dropped first). */
  private readonly thinkingByCall = new Map<string, ThinkingBlock[]>();
  /** Request options a proxy or older endpoint rejected once (`cache_control`, `output_config`, `display`), not sent again. */
  private readonly unsupported = new Set<string>();

  constructor(cfg: ProviderConfig) {
    this.id = cfg.id;
    this.displayName = cfg.displayName ?? 'Anthropic';
    this.baseUrl = cfg.baseUrl.replace(/\/+$/, '');
    const key = resolveApiKey(cfg);
    this.headers = { 'anthropic-version': API_VERSION, ...(key ? { 'x-api-key': key } : {}) };
    this.configuredCtx = cfg.contextWindow;
    this.explicitModels = cfg.models;
    this.remote = isCloudProvider(cfg);
  }

  async healthCheck(signal?: AbortSignal): Promise<boolean> {
    try {
      await getJson(`${this.baseUrl}/models?limit=1`, this.headers, withTimeout(4000, signal));
      return true;
    } catch (e) {
      // A gateway without a model listing is up; its configured models still serve.
      return e instanceof HttpError && !!this.explicitModels?.length;
    }
  }

  async listModels(signal?: AbortSignal): Promise<ModelInfo[]> {
    const listed: AnthropicModel[] = [];
    let after: string | undefined;
    try {
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
    } catch (e) {
      if (!(e instanceof HttpError) || !this.explicitModels?.length) {
        throw e;
      }
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
      supportsThinking: thinkingStyle(m.id) !== 'none',
      remote: this.remote || undefined,
    }));
  }

  async *chat(opts: ChatRequestOptions): AsyncIterable<StreamEvent> {
    const { system, messages } = toAnthropicMessages(opts.messages, (id) => this.thinkingByCall.get(id));
    const body = this.requestBody(opts, system, messages);

    // Tool calls arrive as a content block start (id, name) followed by JSON fragments; thinking as text plus a
    // signature. Both are keyed by block index.
    const pending = new Map<number, { id: string; name: string; args: string }>();
    const thinking = new Map<number, ThinkingBlock>();
    let finish: string | undefined;
    let promptTokens: number | undefined;
    let wroteText = false;
    for await (const ev of this.stream(body, messages, opts.signal)) {
      switch (ev.type) {
        case 'error':
          throw new HttpError(STREAM_ERROR_STATUS[ev.error?.type ?? ''] ?? 500, JSON.stringify(ev.error ?? { message: 'provider error' }), `${this.baseUrl}/messages`);
        case 'message_start': {
          const u = ev.message?.usage;
          promptTokens = u ? (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) : undefined;
          break;
        }
        case 'content_block_start': {
          const b = ev.content_block;
          const i = ev.index ?? 0;
          if (b?.type === 'tool_use') {
            pending.set(i, { id: b.id ?? newId(), name: b.name ?? '', args: '' });
          } else if (b?.type === 'thinking') {
            thinking.set(i, { type: 'thinking', thinking: b.thinking ?? '', signature: b.signature ?? '' });
            if (b.thinking) {
              yield { type: 'thinking', text: b.thinking };
            }
          } else if (b?.type === 'redacted_thinking' && b.data) {
            thinking.set(i, { type: 'redacted_thinking', data: b.data });
          } else if (b?.type === 'text' && b.text) {
            wroteText = true;
            yield { type: 'text', text: b.text };
          }
          break;
        }
        case 'content_block_delta': {
          const d = ev.delta;
          const i = ev.index ?? 0;
          const t = thinking.get(i);
          if (d?.type === 'text_delta' && d.text) {
            wroteText = true;
            yield { type: 'text', text: d.text };
          } else if (d?.type === 'thinking_delta' && d.thinking) {
            if (t?.type === 'thinking') {
              t.thinking += d.thinking;
            }
            yield { type: 'thinking', text: d.thinking };
          } else if (d?.type === 'signature_delta' && d.signature && t?.type === 'thinking') {
            t.signature += d.signature;
            yield { type: 'progress' };
          } else if (d?.type === 'input_json_delta' && d.partial_json) {
            const cur = pending.get(i);
            if (cur) {
              cur.args += d.partial_json;
            }
            yield { type: 'progress' };
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
    const calls = [...pending.entries()].sort((a, b) => a[0] - b[0]).map(([, tc]) => tc);
    const blocks = [...thinking.entries()].sort((a, b) => a[0] - b[0]).map(([, b]) => b).filter((b) => b.type === 'redacted_thinking' || b.signature);
    if (calls.length && blocks.length) {
      this.rememberThinking(safeId(calls[0].id), blocks);
    }
    for (const tc of calls) {
      yield { type: 'tool_call', call: { id: tc.id, name: tc.name, arguments: tc.args || '{}' } };
    }
    if (finish === 'refusal' && !wroteText) {
      yield { type: 'text', text: 'Claude declined to answer this request.' };
    }
    const mapped: Record<string, string> = { tool_use: 'tool_calls', max_tokens: 'length', model_context_window_exceeded: 'length', end_turn: 'stop', stop_sequence: 'stop' };
    yield { type: 'done', finishReason: (finish && mapped[finish]) ?? finish };
  }

  private requestBody(opts: ChatRequestOptions, system: string, messages: Turn[]): Record<string, unknown> {
    // No `temperature`: current Claude models reject sampling parameters, and the default suits agent work.
    const body: Record<string, unknown> = { model: opts.model, messages, max_tokens: opts.maxTokens ?? 8192, stream: true };
    if (system) {
      body.system = system;
    }
    if (opts.stop?.length) {
      body.stop_sequences = opts.stop.filter((s) => s.trim());
    }
    if (opts.tools?.length) {
      body.tools = opts.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }));
    }
    if (!this.unsupported.has('cache_control')) {
      // Automatic prompt caching: the system prompt, tools and earlier turns are billed at cache rates on the next request.
      body.cache_control = { type: 'ephemeral' };
    }
    const style = thinkingStyle(opts.model);
    const level = typeof opts.think === 'string' ? opts.think : undefined;
    const effort = (e: string) => {
      if (!this.unsupported.has('output_config')) {
        body.output_config = { effort: e };
      }
    };
    if (style === 'always' || style === 'adaptive') {
      if (opts.think === false) {
        // `disabled` is rejected by the newest models; the lowest effort is the closest to "off" everywhere.
        effort('low');
      } else if (opts.think !== undefined) {
        body.thinking = this.unsupported.has('display') ? { type: 'adaptive' } : { type: 'adaptive', display: 'summarized' };
        // Thinking shares max_tokens with the answer: a small output limit would leave little room for the reply.
        body.max_tokens = Math.max(Number(body.max_tokens), 16000);
        if (level) {
          effort(level);
        }
      }
    } else if (style === 'budget' && opts.think && canReplayThinking(messages)) {
      // These models need the reasoning of the current tool loop replayed; without it the request is rejected.
      const budget = BUDGET[level ?? 'medium'];
      body.thinking = { type: 'enabled', budget_tokens: budget };
      body.max_tokens = Math.max(Number(body.max_tokens), budget + 4096);
    }
    return body;
  }

  /**
   * Streams the request. A 4xx that names an option is answered by dropping it and asking again (before anything was
   * streamed): thinking blocks bound to an edited history (LocalPilot prunes and compacts) are stripped and forgotten,
   * and options an endpoint does not know are not sent again.
   */
  private async *stream(body: Record<string, unknown>, messages: Turn[], signal?: AbortSignal): AsyncGenerator<AnthropicEvent> {
    for (let attempt = 0; ; attempt++) {
      const it = streamSse<AnthropicEvent>(`${this.baseUrl}/messages`, body, this.headers, signal)[Symbol.asyncIterator]();
      let first: IteratorResult<AnthropicEvent>;
      try {
        first = await it.next();
      } catch (e) {
        if (attempt >= 3 || !(e instanceof HttpError) || e.status < 400 || e.status >= 500 || !this.recover(e.body, body, messages)) {
          throw e;
        }
        continue;
      }
      for (let r = first; !r.done; r = await it.next()) {
        yield r.value;
      }
      return;
    }
  }

  /** Adjusts the request for a rejected option; false when the error is not one LocalPilot can work around. */
  private recover(error: string, body: Record<string, unknown>, messages: Turn[]): boolean {
    const thinking = body.thinking as { type?: string; display?: string } | undefined;
    if (thinking?.display && /display/.test(error)) {
      this.unsupported.add('display');
      body.thinking = { type: thinking.type };
      return true;
    }
    if (/signature|thinking/i.test(error)) {
      if (hasThinking(messages)) {
        // Blocks bound to a history that has since changed (pruned or compacted): send none, and never replay them again.
        for (const turn of messages) {
          turn.content = turn.content.filter((b) => b.type !== 'thinking' && b.type !== 'redacted_thinking');
        }
        this.thinkingByCall.clear();
        return true;
      }
      if (thinking) {
        delete body.thinking;
        return true;
      }
    }
    for (const key of ['cache_control', 'output_config'] as const) {
      if (body[key] !== undefined && new RegExp(key === 'output_config' ? 'output_config|effort' : key).test(error)) {
        this.unsupported.add(key);
        delete body[key];
        return true;
      }
    }
    return false;
  }

  private rememberThinking(callId: string, blocks: ThinkingBlock[]): void {
    this.thinkingByCall.set(callId, blocks);
    while (this.thinkingByCall.size > 500) {
      this.thinkingByCall.delete(this.thinkingByCall.keys().next().value!);
    }
  }

  /** No fill-in-the-middle endpoint: the code around the cursor goes through chat (used when Claude is chosen for ghost text). */
  async complete(opts: CompletionRequestOptions): Promise<string> {
    return completeViaChat(this, opts);
  }
}

/** Tool-use ids must match `^[a-zA-Z0-9_-]+$`; ids from another provider earlier in the chat may not. */
const safeId = (id: string | undefined) => (id || 'call').replace(/[^a-zA-Z0-9_-]/g, '_');

const hasThinking = (messages: Turn[]) => messages.some((t) => t.content.some((b) => b.type === 'thinking' || b.type === 'redacted_thinking'));

/** Budget-style thinking needs the reasoning of the tool loop in progress: the last assistant turn, if it called tools. */
function canReplayThinking(messages: Turn[]): boolean {
  const last = [...messages].reverse().find((t) => t.role === 'assistant');
  return !last || !last.content.some((b) => b.type === 'tool_use') || last.content[0]?.type === 'thinking' || last.content[0]?.type === 'redacted_thinking';
}

/**
 * Converts the chat to Messages API shape: system text becomes the top-level `system`, tool results become
 * `tool_result` blocks in a user turn, consecutive turns of the same role are merged, and an assistant turn that
 * called tools gets back the thinking blocks it was produced with (`thinkingFor`, by its first tool-use id).
 */
export function toAnthropicMessages(input: ChatMessage[], thinkingFor?: (callId: string) => ThinkingBlock[] | undefined): { system: string; messages: Turn[] } {
  const system: string[] = [];
  const out: Turn[] = [];
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
  for (const m of pairToolCalls(input)) {
    if (m.role === 'system') {
      if (m.content.trim()) {
        system.push(m.content);
      }
    } else if (m.role === 'tool') {
      push('user', [{ type: 'tool_result', tool_use_id: safeId(m.toolCallId), content: m.content || '(no output)' }]);
    } else if (m.role === 'assistant') {
      const calls = m.toolCalls ?? [];
      const replay = calls.length ? thinkingFor?.(safeId(calls[0].id)) : undefined;
      const blocks: Block[] = [...(replay ?? [])];
      if (m.content?.trim()) {
        blocks.push({ type: 'text', text: m.content });
      }
      for (const tc of calls) {
        blocks.push({ type: 'tool_use', id: safeId(tc.id), name: tc.name, input: parseArgs(tc) });
      }
      // Thinking blocks must open their turn, so a replayed turn is never merged into the previous assistant turn.
      if (replay?.length) {
        out.push({ role: 'assistant', content: blocks });
      } else {
        push('assistant', blocks);
      }
    } else {
      const blocks: Block[] = (m.images ?? []).map((data) => ({ type: 'image', source: { type: 'base64', media_type: imageMime(data), data } }));
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
