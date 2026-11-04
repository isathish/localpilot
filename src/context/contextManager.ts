import { ChatMessage, LLMProvider, ModelInfo, ToolDefinition } from '../types';
import { BASIC_KEEP_ASSISTANT, basicSummary } from './basicCompaction';
import { estimateMessagesTokens, estimateMessageTokens, estimateTokens, estimateToolsTokens } from './tokenizer';
import { toolResultCache, ToolResultCache } from './toolResultCache';

export interface ContextBudget {
  contextWindow: number;
  reservedForOutput: number;
  systemTokens: number;
  toolsTokens: number;
  historyTokens: number;
  /** Tokens still available for history before compaction triggers. */
  available: number;
  usageRatio: number;
  /** The uncalibrated estimate of the whole prompt, kept so the server's real count can calibrate the next one. */
  rawPromptTokens: number;
}

export interface CompactionResult {
  messages: ChatMessage[];
  summary: string;
  removed: number;
  before: number;
  after: number;
}

export interface FitResult {
  messages: ChatMessage[];
  budget: ContextBudget;
  /** Every summarisation pass that was needed, oldest first (usually none or one). */
  compactions: CompactionResult[];
}

/**
 * Corrects the character-based estimate with the prompt sizes servers report. Tokenizers differ a lot: measured on
 * Gemma 4, the estimate was 30% low for code and 77% high for plain prose, so neither the context meter nor the point
 * where compaction starts can rely on it. After every request the ratio real / estimated is blended into a per-model
 * factor, and later estimates for that model are scaled by it. The history is mostly the same from one request to the
 * next, so the latest ratio is a good predictor; samples outside 0.4–3× are ignored (a server that reports only the
 * uncached part of the prompt would otherwise shrink every estimate).
 */
export class TokenCalibration {
  private readonly ratio = new Map<string, number>();

  scale(modelId: string): number {
    return this.ratio.get(modelId) ?? 1;
  }

  /** Records one request; returns false when the sample was rejected as implausible. */
  record(modelId: string, estimated: number, actual: number | undefined, window?: number): boolean {
    if (!actual || actual <= 0 || estimated < 256) {
      return false;
    }
    // A count at (or a prompt beyond) the window was probably truncated by the server to num_ctx.
    if (window && (actual >= 0.95 * window || estimated * this.scale(modelId) > window)) {
      return false;
    }
    const r = actual / estimated;
    if (r < 0.4 || r > 3) {
      return false;
    }
    const prev = this.ratio.get(modelId);
    this.ratio.set(modelId, prev === undefined ? r : prev * 0.3 + r * 0.7);
    return true;
  }
}

/** Shared by every run, so what one chat learns about a model's tokenizer applies to the next. */
export const tokenCalibration = new TokenCalibration();

/** Below this a local model cannot hold the system prompt and tool schemas, so a smaller request is never useful. */
export const MIN_CONTEXT_WINDOW = 4096;

/**
 * The context window a request will actually be given — the single number used both for the budget that decides
 * when to compact and for the request itself (`num_ctx`), so the conversation is split before the server has to
 * truncate it silently. `requested` is the `localpilot.contextWindow` setting: `0` (or less) asks for the model's
 * full native window — the largest it supports — otherwise the setting is honoured up to that native maximum.
 */
export function effectiveContextWindow(model: Pick<ModelInfo, 'contextWindow'>, requested: number): number {
  const native = Number.isFinite(model.contextWindow) && model.contextWindow > 0 ? Math.floor(model.contextWindow) : 32768;
  if (!Number.isFinite(requested) || requested <= 0) {
    return Math.max(native, MIN_CONTEXT_WINDOW);
  }
  return Math.max(MIN_CONTEXT_WINDOW, Math.min(native, Math.floor(requested)));
}

/**
 * Keeps a conversation within the model's context window using these strategies, applied in order (see `fit`):
 *  1. Tool-output pruning: old tool results are collapsed to a one-line stub (cheap, lossless for recent turns).
 *  2. LLM compaction: the older half of the conversation is summarised into a structured memory note.
 *  3. Tighten and repeat: if the recent window alone still overflows, fewer messages are kept verbatim and the
 *     rest is folded into the summary — until the history fits.
 *  4. Basic digest: when the model cannot summarise (error, or a transcript too large for it), every user message,
 *     the last assistant replies and one line per tool call are kept without a model call.
 * `localpilot.compaction.strategy` picks `agentic` (2, falling back to 4), `basic` (4 only) or `off` (1 only).
 */
export class ContextManager {
  constructor(
    private readonly opts: {
      compactionThreshold: number;
      maxToolOutputChars: number;
      /** Keep at least this many recent messages verbatim. */
      keepRecent?: number;
      /** Ollama keep_alive for the summarisation request, so compaction does not shorten how long the model stays loaded. */
      keepAlive?: string;
      /** Real tokens per estimated token for the model in use (see TokenCalibration); read on every budget. */
      scale?: () => number;
      /** When set, the full text of every cut tool output is kept in `cache` and the cut text points to it (lp-cache://). */
      sessionId?: string;
      cache?: ToolResultCache;
      /** `localpilot.compaction.strategy`; default agentic. */
      strategy?: 'agentic' | 'basic' | 'off';
    }
  ) {}

  get strategy(): 'agentic' | 'basic' | 'off' {
    return this.opts.strategy ?? 'agentic';
  }

  /** Keeps `full` for read_file and returns how to read it back from `line`; empty when no session is set. */
  private cacheRef(full: string, line: number): string {
    if (!this.opts.sessionId) {
      return '';
    }
    const ref = (this.opts.cache ?? toolResultCache).put(this.opts.sessionId, full);
    return ` Full text: ${ref} — read it with read_file path="${ref}" start_line=${line}`;
  }

  /** An estimate in the model's real tokens. */
  private tokens(estimated: number): number {
    return Math.ceil(estimated * (this.opts.scale?.() ?? 1));
  }

  budget(model: ModelInfo, system: string, tools: ToolDefinition[], history: ChatMessage[], maxOutput: number): ContextBudget {
    const raw = { system: estimateTokens(system), tools: estimateToolsTokens(tools), history: estimateMessagesTokens(history) };
    const systemTokens = this.tokens(raw.system);
    const toolsTokens = this.tokens(raw.tools);
    const historyTokens = this.tokens(raw.history);
    const reservedForOutput = Math.min(maxOutput, Math.floor(model.contextWindow * 0.25));
    const hardLimit = model.contextWindow - reservedForOutput - systemTokens - toolsTokens;
    return {
      contextWindow: model.contextWindow,
      reservedForOutput,
      systemTokens,
      toolsTokens,
      historyTokens,
      available: hardLimit - historyTokens,
      usageRatio: (systemTokens + toolsTokens + historyTokens) / (model.contextWindow - reservedForOutput),
      rawPromptTokens: raw.system + raw.tools + raw.history,
    };
  }

  needsCompaction(b: ContextBudget): boolean {
    return b.usageRatio >= this.opts.compactionThreshold;
  }

  /**
   * Keeps splitting the conversation until it fits the budget. Cheapest first: old tool outputs are pruned, then
   * the older part is summarised while the recent window stays verbatim. When the recent window alone is still too
   * big — a few huge tool results, or a window much smaller than the one the history was built under — the window
   * is tightened (fewer verbatim messages, their tool outputs pruned) and the rest summarised again, so a long
   * session keeps going instead of being truncated by the server. `onCompacting` fires before the first model call.
   */
  async fit(
    history: ChatMessage[],
    provider: LLMProvider,
    model: ModelInfo,
    budgetOf: (history: ChatMessage[]) => ContextBudget,
    signal?: AbortSignal,
    onCompacting?: () => void
  ): Promise<FitResult> {
    let messages = history;
    let budget = budgetOf(messages);
    const compactions: CompactionResult[] = [];
    if (signal?.aborted || !this.needsCompaction(budget)) {
      return { messages, budget, compactions };
    }
    const pruned = this.pruneToolOutputs(messages);
    if (pruned.saved > 0) {
      messages = pruned.messages;
      budget = budgetOf(messages);
    }
    if (this.strategy === 'off') {
      return { messages, budget, compactions };
    }
    const first = this.opts.keepRecent ?? 8;
    for (const keep of [first, Math.min(first, 4), 2]) {
      if (signal?.aborted || !this.needsCompaction(budget)) {
        break;
      }
      if (keep < first) {
        const tighter = this.pruneToolOutputs(messages, keep);
        if (tighter.saved > 0) {
          messages = tighter.messages;
          budget = budgetOf(messages);
          if (!this.needsCompaction(budget)) {
            break;
          }
        }
      }
      if (!compactions.length) {
        onCompacting?.();
      }
      const result = await this.compact(messages, provider, model, signal, keep);
      if (result.removed > 0) {
        messages = result.messages;
        compactions.push(result);
        budget = budgetOf(messages);
      }
    }
    return { messages, budget, compactions };
  }

  /** Truncate a single tool output to the configured size, keeping head and tail. */
  clampToolOutput(text: string): string {
    const max = this.opts.maxToolOutputChars;
    if (text.length <= max) {
      return text;
    }
    const head = Math.floor(max * 0.7);
    const tail = max - head;
    const omitted = text.length - max;
    const ref = this.cacheRef(text, text.slice(0, head).split('\n').length);
    if (ref) {
      return `${text.slice(0, head)}\n\n[Output truncated: ${omitted.toLocaleString()} characters omitted.${ref}]\n\n${text.slice(-tail)}`;
    }
    return `${text.slice(0, head)}\n\n... [${omitted.toLocaleString()} characters omitted — use offsets/filters to read more] ...\n\n${text.slice(-tail)}`;
  }

  /** Strategy 1: collapse tool results, and large tool-call arguments (file contents), older than the recent window. */
  pruneToolOutputs(history: ChatMessage[], keepRecent = this.opts.keepRecent ?? 12): { messages: ChatMessage[]; saved: number } {
    const cutoff = Math.max(0, history.length - keepRecent);
    let saved = 0;
    const messages = history.map((m, i) => {
      if (i < cutoff && m.role === 'assistant' && m.toolCalls?.length && !m.meta?.pruned) {
        const toolCalls = m.toolCalls.map((c) => {
          let args: unknown;
          try {
            args = JSON.parse(c.arguments);
          } catch {
            return c;
          }
          if (!args || typeof args !== 'object' || Array.isArray(args)) {
            return c;
          }
          let hit = false;
          const out: Record<string, unknown> = {};
          for (const [k, v] of Object.entries(args as Record<string, unknown>)) {
            if (typeof v === 'string' && v.length > 400) {
              out[k] = `[${v.length.toLocaleString()} chars — pruned to save context; read the file for current text]`;
              hit = true;
            } else {
              out[k] = v;
            }
          }
          return hit ? { ...c, arguments: JSON.stringify(out) } : c;
        });
        if (!toolCalls.some((c, j) => c !== m.toolCalls![j])) {
          return m;
        }
        const pruned: ChatMessage = { ...m, toolCalls, meta: { ...m.meta, pruned: true } };
        saved += estimateMessageTokens(m) - estimateMessageTokens(pruned);
        return pruned;
      }
      if (i >= cutoff || m.role !== 'tool' || m.meta?.pruned || m.content.length < 400) {
        return m;
      }
      const before = estimateMessageTokens(m);
      const firstLine = m.content.split('\n')[0].slice(0, 120);
      const ref = this.cacheRef(m.content, 1);
      const pruned: ChatMessage = {
        ...m,
        content: `[tool output pruned to save context — ${m.content.length.toLocaleString()} chars${ref ? `.${ref}` : ''}] ${firstLine}`,
        meta: { ...m.meta, pruned: true },
      };
      saved += before - estimateMessageTokens(pruned);
      return pruned;
    });
    return { messages, saved };
  }

  /** Strategy 2: summarise older messages with the model. */
  async compact(
    history: ChatMessage[],
    provider: LLMProvider,
    model: ModelInfo,
    signal?: AbortSignal,
    keepRecent = this.opts.keepRecent ?? 8,
    /** Mid-run, a failed summary falls back to dropping the older messages so the run can go on; a compaction the
     *  user asked for throws instead, so a server that is down never costs them their history. */
    truncateOnFailure = true
  ): Promise<CompactionResult> {
    const before = this.tokens(estimateMessagesTokens(history));
    if (history.length <= keepRecent + 2) {
      return { messages: history, summary: '', removed: 0, before, after: before };
    }
    // Never split a tool call from its results: back the split point up past tool results and their image carriers,
    // so the recent window starts at a user message or at an assistant message whose results all follow it.
    let split = history.length - keepRecent;
    while (split > 0 && (history[split].role === 'tool' || history[split].meta?.toolImages)) {
      split--;
    }
    const older = history.slice(0, split);
    const recent = history.slice(split);
    // Splitting inside a running turn: the request that started it stays verbatim, only the work since is summarised.
    let request: ChatMessage | undefined;
    if (history[split]?.role === 'assistant') {
      for (let i = older.length - 1; i >= 0; i--) {
        const m = older[i];
        if (m.role === 'user' && !m.meta?.hidden && !m.meta?.summary && !m.meta?.toolImages && !m.meta?.steer) {
          request = m;
          break;
        }
      }
    }
    if (!older.some((m) => !m.meta?.summary && m !== request)) {
      return { messages: history, summary: '', removed: 0, before, after: before };
    }
    const priorSummaries = older.filter((m) => m.meta?.summary).map((m) => m.content);
    const transcript = older
      .filter((m) => !m.meta?.summary && m !== request)
      .map((m) => {
        const tc = m.toolCalls?.map((t) => `${t.name}(${t.arguments.slice(0, 300)})`).join(', ');
        return `${m.role.toUpperCase()}: ${m.content.slice(0, 4000)}${tc ? `\n[tool calls: ${tc}]` : ''}`;
      })
      .join('\n\n');

    let summary: string;
    // The digest is the last resort, so it must fit: at most ~40% of the window, measured in the model's tokens.
    const digest = () => {
      const budget = Math.floor(model.contextWindow * 0.4);
      let maxChars = budget * 4;
      let out = basicSummary(older.filter((m) => m !== request), BASIC_KEEP_ASSISTANT, maxChars);
      for (let i = 0; i < 8 && this.tokens(estimateTokens(out)) > budget; i++) {
        maxChars = Math.floor(maxChars / 2);
        out = basicSummary(older.filter((m) => m !== request), BASIC_KEEP_ASSISTANT, maxChars);
      }
      return out;
    };
    // A transcript the model could not even read in one request would only fail (or be cut by the server): go basic.
    const tooLarge = this.tokens(estimateTokens(transcript) + estimateTokens(priorSummaries.join('\n'))) + 2000 > model.contextWindow;
    if (this.strategy === 'basic' || (tooLarge && truncateOnFailure)) {
      summary = digest();
    } else {
      try {
        summary = await this.summarise(provider, model, priorSummaries, transcript, signal);
      } catch (e) {
        if (!truncateOnFailure || signal?.aborted) {
          throw e;
        }
        // Strategy 4 fallback: the deterministic digest instead of losing the older messages.
        summary = digest();
      }
    }
    const summaryMsg: ChatMessage = {
      role: 'user',
      content: `<conversation_summary>\n${summary}\n</conversation_summary>\nContinue from here; the summary above replaces earlier messages.`,
      meta: { summary: true, timestamp: Date.now() },
    };
    const messages = request ? [summaryMsg, request, ...recent] : [summaryMsg, ...recent];
    return { messages, summary, removed: older.length - (request ? 1 : 0), before, after: this.tokens(estimateMessagesTokens(messages)) };
  }

  private async summarise(
    provider: LLMProvider,
    model: ModelInfo,
    priorSummaries: string[],
    transcript: string,
    signal?: AbortSignal
  ): Promise<string> {
    const prompt = `You are compressing an AI coding assistant's conversation so work can continue in a smaller context window.
Write a dense, factual summary in this exact structure (markdown headings, terse bullets, no filler):

## Task & goals
## Decisions & constraints
## Files touched (path → what changed / why)
## Key findings (APIs, code structure, errors seen)
## Current state & next steps
## Open questions

Preserve exact file paths, identifiers, commands, error messages and numbers. Do not invent anything.`;
    const messages: ChatMessage[] = [
      { role: 'system', content: prompt },
      {
        role: 'user',
        content: `${priorSummaries.length ? `Previous summary:\n${priorSummaries.join('\n\n')}\n\n---\n\n` : ''}Transcript to summarise:\n\n${transcript}`,
      },
    ];
    let out = '';
    // A server that accepts the request and then hangs must not leave the run on "Compacting…": after 4 minutes the
    // summary is abandoned and compact() falls back to truncation (or, when asked by the user, reports the failure).
    const limited = signal ? AbortSignal.any([signal, AbortSignal.timeout(240_000)]) : AbortSignal.timeout(240_000);
    for await (const ev of provider.chat({ model: model.modelId, messages, temperature: 0, think: false, maxTokens: 1500, contextWindow: model.contextWindow, keepAlive: this.opts.keepAlive, signal: limited })) {
      if (ev.type === 'text') {
        out += ev.text;
      }
    }
    if (!out.trim()) {
      throw new Error('the model returned an empty summary');
    }
    return out.trim();
  }
}
