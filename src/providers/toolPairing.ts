import { ChatMessage } from '../types';

/**
 * Keeps native tool calls only where a role:'tool' result answers them. Calls parsed from text (answered by a plain
 * user message) are written back into the assistant text as `<tool_call>` lines, and tool results whose call is gone
 * become user messages, so APIs that require tool_use/tool_result pairing accept the history. Never mutates the input.
 */
export function pairToolCalls(messages: ChatMessage[]): ChatMessage[] {
  const answered = new Set<string>();
  for (const m of messages) {
    if (m.role === 'tool' && m.toolCallId) {
      answered.add(m.toolCallId);
    }
  }
  const kept = new Set<string>();
  const out = messages.map((m): ChatMessage => {
    if (m.role !== 'assistant' || !m.toolCalls?.length) {
      return m;
    }
    const calls = m.toolCalls.filter((tc) => answered.has(tc.id));
    calls.forEach((tc) => kept.add(tc.id));
    if (calls.length === m.toolCalls.length) {
      return m;
    }
    const text = m.toolCalls
      .filter((tc) => !answered.has(tc.id))
      .map((tc) => `<tool_call>${JSON.stringify({ name: tc.name, arguments: parseArgs(tc.arguments) })}</tool_call>`);
    const copy: ChatMessage = { ...m, content: [m.content, ...text].filter(Boolean).join('\n') };
    if (calls.length) {
      copy.toolCalls = calls;
    } else {
      delete copy.toolCalls;
    }
    return copy;
  });
  return out.map((m) => (m.role === 'tool' && !(m.toolCallId && kept.has(m.toolCallId)) ? { role: 'user', content: m.content, meta: m.meta } : m));
}

function parseArgs(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}
