// Conversation merge (design §4.2, §16.1 "Merge with…"): a new conversation that continues A with what was learned
// in B — A's messages (copies, new ids), then a summary of B as context. The summary is written by the model when a
// summariser is available (after the user asked; never in the background), else an extract: B's first request and
// its last answer. Pure.
import type { ChatMessage, Session } from '../../types';
import { userText } from '../../agent/clarify';

/** Plain text of a conversation, for the summariser (newest part kept when long). */
export function transcriptText(s: Session, max = 24_000): string {
  const lines: string[] = [];
  for (const m of s.messages) {
    if ((m.role !== 'user' && m.role !== 'assistant') || m.meta?.hidden || m.meta?.toolResults || m.meta?.toolImages) {
      continue;
    }
    const t = m.role === 'user' ? (m.meta?.display ?? userText(m.content)) : m.content;
    if (t?.trim()) {
      lines.push(`${m.role === 'user' ? 'User' : 'Assistant'}: ${t.trim()}`);
    }
  }
  const text = lines.join('\n\n');
  return text.length > max ? `…${text.slice(-max)}` : text;
}

/** B's first request and last answer, when no model summary is available. */
export function extractSummary(s: Session, max = 6000): string {
  const said = s.messages.filter((m) => (m.role === 'user' || m.role === 'assistant') && !m.meta?.hidden && !m.meta?.toolResults && !m.meta?.toolImages && !m.meta?.summary);
  const first = said.find((m) => m.role === 'user');
  const last = [...said].reverse().find((m) => m.role === 'assistant' && m.content.trim());
  const summary = s.messages.filter((m) => m.meta?.summary).pop();
  const parts = [
    summary ? summary.content.replace(/<\/?conversation_summary>/g, '').trim() : '',
    first ? `Request: ${(first.meta?.display ?? userText(first.content)).trim()}` : '',
    last ? `Outcome: ${last.content.trim()}` : '',
  ].filter(Boolean);
  const text = parts.join('\n\n');
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export const MERGE_PROMPT = 'Summarise this conversation for someone continuing the work in another chat: the goal, decisions made, what was changed (files, commands), what is still open. Plain text, at most 300 words.';

/**
 * The merged session (no id yet): A's messages as copies, then a hidden-free user message carrying B's summary
 * and an assistant acknowledgement, so the next turn sees both.
 */
export function mergeSessions(a: Session, b: Session, summary: string, o: { now?: number } = {}): Omit<Session, 'id'> & { mergedFrom: string[] } {
  const now = o.now ?? Date.now();
  const copy = (m: ChatMessage): ChatMessage => ({ ...structuredClone(m), meta: { ...m.meta, id: undefined, ...(m.meta?.id ? { copiedFrom: m.meta.id } : {}) } });
  const note: ChatMessage = {
    role: 'user',
    content: `<merged_conversation title="${b.title.replace(/"/g, "'")}">\n${summary.trim()}\n</merged_conversation>\nThe summary above comes from another conversation ("${b.title}"); use it as context from now on.`,
    meta: { timestamp: now, display: `Merged “${b.title}” into this conversation` },
  };
  const ack: ChatMessage = { role: 'assistant', content: `Merged “${b.title}”: its summary is now part of this conversation's context.`, meta: { timestamp: now } };
  return {
    title: `${a.title} + ${b.title}`.slice(0, 120),
    createdAt: now,
    updatedAt: now,
    model: a.model,
    mode: a.mode,
    messageCount: a.messages.length + 2,
    messages: [...a.messages.map(copy), note, ack],
    contextTokens: 0,
    compactions: a.compactions ?? 0,
    attachments: [...(a.attachments ?? [])],
    ...(a.folder ? { folder: a.folder } : {}),
    parentId: a.id,
    parentTitle: a.title,
    mergedFrom: [a.id, b.id],
  };
}
