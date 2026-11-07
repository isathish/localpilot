// Context policy (CONTEXT, design §8.3): what may leave this machine. Items marked "local only" (memory notes, context
// library sets, conversations tagged `local-only`) are never sent to a cloud model. Every block that carries one of
// them is written with a `local-only="true"` attribute by its resolver (#memory:, #context:, #chat:, history_read,
// memory_read…); before a request to a non-local provider the policy replaces those blocks with a short placeholder
// and lists them as excluded in the context snapshot. Requests to local models are untouched. Pure.
import type { ChatMessage } from '../../types';

/** The tag that keeps a conversation away from cloud models. */
export const LOCAL_ONLY_TAG = 'local-only';

/** The attribute resolvers put on a block that must not reach a cloud model. */
export const LOCAL_ONLY_ATTR = 'local-only="true"';

export interface Excluded {
  ref: string;
  reason: 'localOnly' | 'budget' | 'ignored';
}

/** Tags whose blocks can be marked local only (resolvers and tools write these). */
const BLOCK_TAGS = ['memory_note', 'memory', 'context_set', 'chat_ref', 'chat_hit', 'file', 'snippet'];
const BLOCK_RE = new RegExp(`<(${BLOCK_TAGS.join('|')})\\b([^>]*)\\blocal-only="true"([^>]*)>[\\s\\S]*?<\\/\\1>`, 'g');
const ATTR = (attrs: string, name: string) => new RegExp(`\\b${name}="([^"]*)"`).exec(attrs)?.[1];

/** A local-only block's label for the excluded list: `memory:deploy`, `context:release`, `chat:Fix login`. */
function refOf(tag: string, attrs: string): string {
  const name = ATTR(attrs, 'name') ?? ATTR(attrs, 'title') ?? ATTR(attrs, 'path') ?? ATTR(attrs, 'id') ?? '';
  const kind = tag === 'memory_note' || tag === 'memory' ? 'memory' : tag === 'context_set' ? 'context' : tag === 'chat_ref' || tag === 'chat_hit' ? 'chat' : tag;
  return `${kind}:${name.replace(/&quot;/g, '"')}`;
}

/** The text with every local-only block replaced by a placeholder; `found` collects what was removed. */
export function stripLocalOnly(text: string, found?: Excluded[]): string {
  if (!text || !text.includes(LOCAL_ONLY_ATTR)) {
    return text;
  }
  return text.replace(BLOCK_RE, (_m, tag: string, a: string, b: string) => {
    const ref = refOf(tag, `${a} ${b}`);
    if (found && !found.some((x) => x.ref === ref)) {
      found.push({ ref, reason: 'localOnly' });
    }
    return `<excluded ref="${ref.replace(/"/g, '&quot;')}" reason="local only">(Kept on the user's machine: not sent to cloud models.)</excluded>`;
  });
}

/**
 * The messages to send to a model. For a cloud model, local-only blocks are replaced (copies of the affected
 * messages only; the chat's own history is never changed); for a local model the same array comes back.
 */
export function applyPolicy(messages: ChatMessage[], o: { remote: boolean }): { messages: ChatMessage[]; excluded: Excluded[] } {
  const excluded: Excluded[] = [];
  if (!o.remote) {
    return { messages, excluded };
  }
  let changed = false;
  const out = messages.map((m) => {
    if (typeof m.content !== 'string' || !m.content.includes(LOCAL_ONLY_ATTR)) {
      return m;
    }
    changed = true;
    return { ...m, content: stripLocalOnly(m.content, excluded) };
  });
  return { messages: changed ? out : messages, excluded };
}

/** True when a conversation's tags keep it away from cloud models. */
export function isLocalOnlyConversation(tags: readonly string[] | undefined): boolean {
  return !!tags?.some((t) => t.toLowerCase() === LOCAL_ONLY_TAG);
}

/** The attribute string for a block (empty when the item may go anywhere). */
export function localOnlyAttr(on: boolean | undefined): string {
  return on ? ` ${LOCAL_ONLY_ATTR}` : '';
}

/** Why a request is refused: the conversation itself is tagged local only and the model is a cloud model. */
export function blockReason(o: { remote: boolean; tags?: readonly string[]; model: string }): string | undefined {
  return o.remote && isLocalOnlyConversation(o.tags)
    ? `This conversation is tagged "${LOCAL_ONLY_TAG}", so it is never sent to a cloud model (${o.model}). Pick a local model, or remove the tag in the conversation navigator (⋯ → Tags…).`
    : undefined;
}

/**
 * The one-time notice when a conversation that ran on local models first goes to a cloud model: what will now be
 * sent, and what the policy keeps back. Undefined when no notice is due.
 */
export function cloudNotice(o: { remote: boolean; model: string; provider: string; earlierRemote: boolean; earlierLocal: boolean; shown: boolean; excluded: readonly Excluded[] }): string | undefined {
  if (!o.remote || o.shown || o.earlierRemote || !o.earlierLocal) {
    return undefined;
  }
  const kept = o.excluded.filter((e) => e.reason === 'localOnly');
  return `Now using ${o.model}, a cloud model (${o.provider}): this chat's messages, attached files, tool output and prompt memory are sent to it.${kept.length ? ` Kept on this machine: ${kept.map((k) => k.ref).slice(0, 6).join(', ')}${kept.length > 6 ? ` and ${kept.length - 6} more` : ''}.` : ' Mark memory notes or context sets "Local only" to keep them here.'}`;
}
