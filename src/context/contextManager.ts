import { ChatMessage, LLMProvider, ModelInfo, ToolDefinition } from '../types';
import { estimateMessagesTokens, estimateMessageTokens, estimateTokens, estimateToolsTokens } from './tokenizer';

export interface ContextBudget {
  contextWindow: number;
  reservedForOutput: number;
  systemTokens: number;
  toolsTokens: number;
  historyTokens: number;
  /** Tokens still available for history before compaction triggers. */
  available: number;
  usageRatio: number;
}

export interface CompactionResult {
  messages: ChatMessage[];
  summary: string;
  removed: number;
  before: number;
  after: number;
}

/**
 * Keeps a conversation within the model's context window using three strategies, applied in order:
 *  1. Tool-output pruning: old tool results are collapsed to a one-line stub (cheap, lossless for recent turns).
 *  2. LLM compaction: the older half of the conversation is summarised into a structured memory note.
 *  3. Hard truncation: drop oldest turns if the model is unavailable for summarisation.
 */
export class ContextManager {
  constructor(
    private readonly opts: {
      compactionThreshold: number;
      maxToolOutputChars: number;
      /** Keep at least this many recent messages verbatim. */
      keepRecent?: number;
    }
  ) {}

  budget(model: ModelInfo, system: string, tools: ToolDefinition[], history: ChatMessage[], maxOutput: number): ContextBudget {
    const systemTokens = estimateTokens(system);
    const toolsTokens = estimateToolsTokens(tools);
    const historyTokens = estimateMessagesTokens(history);
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
    };
  }

  needsCompaction(b: ContextBudget): boolean {
    return b.usageRatio >= this.opts.compactionThreshold;
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
    return `${text.slice(0, head)}\n\n... [${omitted.toLocaleString()} characters omitted — use offsets/filters to read more] ...\n\n${text.slice(-tail)}`;
  }

  /** Strategy 1: collapse tool results older than the recent window. */
  pruneToolOutputs(history: ChatMessage[], keepRecent = this.opts.keepRecent ?? 12): { messages: ChatMessage[]; saved: number } {
    const cutoff = Math.max(0, history.length - keepRecent);
    let saved = 0;
    const messages = history.map((m, i) => {
      if (i >= cutoff || m.role !== 'tool' || m.meta?.pruned || m.content.length < 400) {
        return m;
      }
      const before = estimateMessageTokens(m);
      const firstLine = m.content.split('\n')[0].slice(0, 120);
      const pruned: ChatMessage = {
        ...m,
        content: `[tool output pruned to save context — ${m.content.length.toLocaleString()} chars] ${firstLine}`,
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
    keepRecent = this.opts.keepRecent ?? 8
  ): Promise<CompactionResult> {
    const before = estimateMessagesTokens(history);
    if (history.length <= keepRecent + 2) {
      return { messages: history, summary: '', removed: 0, before, after: before };
    }
    // Never split a tool call from its results: back the split point up to a user message.
    let split = history.length - keepRecent;
    while (split > 1 && history[split].role !== 'user') {
      split--;
    }
    const older = history.slice(0, split);
    const recent = history.slice(split);
    const priorSummaries = older.filter((m) => m.meta?.summary).map((m) => m.content);
    const transcript = older
      .filter((m) => !m.meta?.summary)
      .map((m) => {
        const tc = m.toolCalls?.map((t) => `${t.name}(${t.arguments.slice(0, 300)})`).join(', ');
        return `${m.role.toUpperCase()}: ${m.content.slice(0, 4000)}${tc ? `\n[tool calls: ${tc}]` : ''}`;
      })
      .join('\n\n');

    let summary: string;
    try {
      summary = await this.summarise(provider, model, priorSummaries, transcript, signal);
    } catch {
      // Strategy 3 fallback: hard truncation with a plain-text stub.
      summary = `Earlier conversation (${older.length} messages) was truncated because the context window filled up.`;
    }
    const summaryMsg: ChatMessage = {
      role: 'user',
      content: `<conversation_summary>\n${summary}\n</conversation_summary>\nContinue from here; the summary above replaces earlier messages.`,
      meta: { summary: true, timestamp: Date.now() },
    };
    const messages = [summaryMsg, ...recent];
    return { messages, summary, removed: older.length, before, after: estimateMessagesTokens(messages) };
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
    for await (const ev of provider.chat({ model: model.modelId, messages, temperature: 0, maxTokens: 1500, contextWindow: model.contextWindow, signal })) {
      if (ev.type === 'text') {
        out += ev.text;
      }
    }
    return out.trim();
  }
}
