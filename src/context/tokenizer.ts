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
  const chars = text.length;
  const words = text.split(/\s+/).filter(Boolean).length;
  const symbols = (text.match(/[{}()[\];:,.<>=+\-*/\\|&^%$#@!~`"'?]/g) ?? []).length;
  return Math.ceil(chars / 3.6 + words * 0.15 + symbols * 0.3);
}

export function estimateMessageTokens(m: ChatMessage): number {
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
  return n;
}

export function estimateMessagesTokens(messages: readonly ChatMessage[]): number {
  return messages.reduce((acc, m) => acc + estimateMessageTokens(m), 0);
}

export function estimateToolsTokens(tools: readonly ToolDefinition[]): number {
  return tools.reduce((acc, t) => acc + estimateTokens(JSON.stringify(t)) + 6, 0);
}
