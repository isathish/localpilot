import { ChatMessage, ToolDefinition } from '../types';

/**
 * Fast heuristic tokenizer. Local models use different BPE vocabularies, so an exact count is
 * impossible without the model's tokenizer; this estimate errs slightly high to keep us safe.
 */
export function estimateTokens(text: string): number {
  if (!text) {
    return 0;
  }
  // Code and non-Latin text tokenize denser than prose; blend char- and word-based estimates.
  // Counted in one pass without allocating word/symbol arrays: this runs over the whole history on every agent step.
  const chars = text.length;
  let words = 0;
  let symbols = 0;
  let inWord = false;
  for (let i = 0; i < chars; i++) {
    const c = text.charCodeAt(i);
    const ws = c === 32 || (c >= 9 && c <= 13) || c === 160;
    if (ws) {
      inWord = false;
    } else {
      if (!inWord) {
        words++;
        inWord = true;
      }
      if (SYMBOL[c]) {
        symbols++;
      }
    }
  }
  return Math.ceil(chars / 3.6 + words * 0.15 + symbols * 0.3);
}
const SYMBOL: Record<number, 1> = {};
for (const ch of '{}()[];:,.<>=+-*/\\|&^%$#@!~`"\'?') {
  SYMBOL[ch.charCodeAt(0)] = 1;
}

/** Per-message counts are memoised: messages never change once in the history (pruning replaces them). */
const messageTokens = new WeakMap<ChatMessage, { key: number; n: number }>();

export function estimateMessageTokens(m: ChatMessage): number {
  const key = m.content.length * 31 + (m.toolCalls?.length ?? 0) * 7 + (m.images?.length ?? 0);
  const hit = messageTokens.get(m);
  if (hit && hit.key === key) {
    return hit.n;
  }
  let n = 4; // role / separators
  n += estimateTokens(m.content);
  if (m.toolCalls) {
    for (const tc of m.toolCalls) {
      n += estimateTokens(tc.name) + estimateTokens(tc.arguments) + 8;
    }
  }
  if (m.images?.length) {
    n += m.images.length * 768;
  }
  messageTokens.set(m, { key, n });
  return n;
}

export function estimateMessagesTokens(messages: readonly ChatMessage[]): number {
  return messages.reduce((acc, m) => acc + estimateMessageTokens(m), 0);
}

export function estimateToolsTokens(tools: readonly ToolDefinition[]): number {
  return tools.reduce((acc, t) => acc + estimateTokens(JSON.stringify(t)) + 6, 0);
}
