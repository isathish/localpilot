// Smart context selection from earlier conversations (CONTEXT, design §8.3): "Related: <title> · Add" suggestions for
// a new chat (full-text over this project's earlier conversations, top 3 above a score threshold, Trash excluded),
// the `#chat:<title>` mention (a conversation's summary, else its first request and last answer, capped at 1,500
// tokens), and the agent's read-only `history_search` / `history_read` tools. Nothing is added to a chat without a
// click or a mention. Conversations tagged `local-only` are marked so the context policy keeps them from cloud
// models. Pure Node; no vscode.
import { estimateTokens } from '../../context/tokenizer';
import type { ChatMessage, Session, Tool } from '../../types';
import type { IndexClient } from '../data/index/indexClient';
import type { ConversationRow, SearchHit } from '../data/index/queries';
import { isLocalOnlyConversation, localOnlyAttr } from './contextPolicy';

/** Tokens a `#chat:` block may take. */
export const CHAT_REF_TOKENS = 1500;
/** history_read: messages per call and characters per message / per call. */
export const READ_MAX_MESSAGES = 20;
export const READ_MESSAGE_CHARS = 2000;
export const READ_TOTAL_CHARS = 12_000;
/** history_search: hits returned. */
export const SEARCH_MAX_HITS = 12;
/** Related suggestions: how many, and the share of the request's (weighted) words an earlier chat must contain. */
export const RELATED_MAX = 3;
export const RELATED_MIN_SCORE = 0.34;

const STOP = new Set(
  ('the a an and or but if then else for to of in on at by with from into onto over under is are was were be been being this that these those it its ' +
    'i me my we our you your he she they them their what which who whom how why when where can could should would will shall may might must do does did ' +
    'done have has had not no yes please thanks thank just also only very really more most some any all each every about like make get use using used ' +
    'want need help let lets file files code fix add new one two way still again here there now so as than too out up down via per etc it’s don’t can’t ' +
    'der die das und oder ist ein eine nicht mit für von zu le la les et ou est un une des pas avec pour de du en el los las y es una por con para que')
    .split(/\s+/)
);

/** The words of a request worth searching for: no stop words, ≥ 3 letters (or digits), longest first, at most 8. */
export function keywords(text: string, max = 8): string[] {
  const words = (text.toLowerCase().replace(/<[^>]+>/g, ' ').match(/[\p{L}\p{N}_]+/gu) ?? []).filter((w) => (w.length >= 3 || /\d/.test(w)) && !STOP.has(w) && w.length <= 40);
  const uniq = [...new Set(words)];
  // Rarer-looking words first: identifiers and long words say more than short common ones.
  const weight = (w: string) => w.length + (/[_\d]/.test(w) ? 4 : 0);
  return uniq.sort((a, b) => weight(b) - weight(a)).slice(0, max);
}

export interface TermHit {
  term: string;
  id: string;
  title: string;
  updated_at: number;
}

export interface RelatedItem {
  id: string;
  title: string;
  snippet: string;
  score: number;
  matched: string[];
  updatedAt: number;
}

/**
 * Scores conversations by the inverse-document-frequency weight of the request's words they contain, as a share of
 * the weight of all the words. Returns the best `max` above `minScore` (ties: newest first). Pure.
 */
export function scoreRelated(terms: readonly string[], hits: readonly TermHit[], total: number, o: { max?: number; minScore?: number } = {}): RelatedItem[] {
  if (!terms.length || !hits.length) {
    return [];
  }
  const df = new Map<string, Set<string>>();
  for (const h of hits) {
    (df.get(h.term) ?? df.set(h.term, new Set()).get(h.term)!).add(h.id);
  }
  const n = Math.max(total, 1);
  const idf = (t: string) => Math.log(1 + n / Math.max(1, df.get(t)?.size ?? 0));
  // A word every conversation has says nothing; one no conversation has still counts in the denominator.
  const weightOf = (t: string) => (df.has(t) ? idf(t) : Math.log(1 + n));
  const all = terms.reduce((a, t) => a + weightOf(t), 0);
  const byConv = new Map<string, { title: string; at: number; terms: Set<string> }>();
  for (const h of hits) {
    const c = byConv.get(h.id) ?? byConv.set(h.id, { title: h.title, at: h.updated_at, terms: new Set() }).get(h.id)!;
    c.terms.add(h.term);
  }
  const need = Math.min(2, terms.length);
  const out: RelatedItem[] = [];
  for (const [id, c] of byConv) {
    if (c.terms.size < need) {
      continue;
    }
    const score = [...c.terms].reduce((a, t) => a + idf(t), 0) / (all || 1);
    if (score >= (o.minScore ?? RELATED_MIN_SCORE)) {
      out.push({ id, title: c.title, snippet: '', score: Math.round(score * 1000) / 1000, matched: [...c.terms], updatedAt: c.at });
    }
  }
  out.sort((a, b) => b.score - a.score || b.updatedAt - a.updatedAt);
  return out.slice(0, o.max ?? RELATED_MAX);
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
const strip = (s: string) => s.replace(/[\u0002\u0003]/g, '');
/** The text a person wrote or read (attachment blocks and tool chatter out). */
export function plainText(m: Pick<ChatMessage, 'content'>): string {
  return String(m.content ?? '')
    .replace(/<(attachment|workspace_tree|codebase|git|problems|open_editors|terminal_output|url_content|directory|commit|memory_note|context_set|chat_ref|turn-context)\b[^>]*>[\s\S]*?<\/\1>\s*/g, '')
    .trim();
}
/** A `#chat:` slug of a title. */
export function chatSlug(title: string): string {
  return title.trim().toLowerCase().replace(/[^\p{L}\p{N}_.-]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 60);
}

/** Caps text at about `tokens` tokens (by characters, then checked with the estimator). */
export function capTokens(text: string, tokens: number): string {
  if (estimateTokens(text) <= tokens) {
    return text;
  }
  let n = Math.floor(tokens * 3.4);
  let t = text.slice(0, n);
  while (n > 200 && estimateTokens(t) > tokens) {
    n = Math.floor(n * 0.9);
    t = text.slice(0, n);
  }
  return `${t}\n…(cut to fit)`;
}

export interface RelatedDeps {
  index: IndexClient;
  /** A conversation as a Session (ConversationManager.materialize); undefined when unknown. */
  load: (id: string) => Promise<Session | undefined>;
  /** The project of the current folder / of a conversation. */
  projectOf?: (sessionId?: string) => Promise<string | undefined>;
}

export class RelatedContext {
  constructor(private readonly d: RelatedDeps) {}

  /** Up to 3 earlier conversations of `projectId` related to `text` (Trash and `excludeId` left out). */
  async suggest(projectId: string | undefined, text: string, excludeId?: string, o: { max?: number; minScore?: number } = {}): Promise<RelatedItem[]> {
    const terms = keywords(text);
    if (terms.length < 2) {
      return [];
    }
    const [hits, count] = await Promise.all([
      this.d.index.query<TermHit>('relatedTerms', { terms, projectId: projectId ?? 'all', excludeId: excludeId ?? '' }),
      this.d.index.query<{ n: number }>('projectConversationCount', { projectId: projectId ?? 'all' }),
    ]);
    const items = scoreRelated(terms, hits, Number(count[0]?.n ?? 0), o);
    // A snippet of where the words matched (the first hit of the best words).
    for (const it of items) {
      for (const t of it.matched.slice(0, 3)) {
        const s = (await this.d.index.search({ text: t, projectId: projectId ?? 'all', limit: 50 }).catch(() => [] as SearchHit[])).find((h) => h.conversationId === it.id && h.field !== 'title');
        if (s) {
          it.snippet = strip(s.snippet).replace(/\s+/g, ' ').slice(0, 160);
          break;
        }
      }
    }
    return items;
  }

  /** Finds a conversation by id, id prefix, `#chat:` slug or title (this project's first, then the newest). */
  async find(ref: string, projectId?: string): Promise<ConversationRow | undefined> {
    const r = ref.trim();
    if (!r) {
      return undefined;
    }
    const byId = await this.d.index.conversation(r).catch(() => undefined);
    if (byId && !byId.trashedAt) {
      return byId;
    }
    const slug = chatSlug(r);
    const words = r.replace(/[-_]+/g, ' ').trim();
    // An id prefix (`s_01J…`, `cli-…`) matches no title: look through the newest conversations instead.
    const idLike = /^(s_|cli-|[0-9a-z]{6,}$)/i.test(r) && !/\s/.test(r);
    const q = idLike ? undefined : words.split(/\s+/)[0];
    const page = await this.d.index.history({ view: 'all', projectId: 'all', query: q, limit: idLike ? 500 : 200 });
    const archived = await this.d.index.history({ view: 'archived', projectId: 'all', query: q, limit: 100 });
    const rows = [...page.rows, ...archived.rows];
    const hits = rows.filter((c) => c.id.startsWith(r) || chatSlug(c.title) === slug || c.title.toLowerCase() === r.toLowerCase());
    const pool = hits.length ? hits : rows.filter((c) => chatSlug(c.title).includes(slug));
    pool.sort((a, b) => Number(b.projectId === projectId) - Number(a.projectId === projectId) || b.updatedAt - a.updatedAt);
    return pool[0];
  }

  /** `#chat:<ref>`: the conversation's summary, else its first request and last answer, capped at 1,500 tokens. */
  async chatBlock(ref: string, o: { projectId?: string; tokens?: number } = {}): Promise<string> {
    const row = await this.find(ref, o.projectId);
    if (!row) {
      return `<chat_ref id="${esc(ref)}" error="not found">\n(No earlier conversation matches "${ref}". The navigator lists them; history_search finds them by content.)\n</chat_ref>`;
    }
    let body: string;
    if (row.summary?.trim()) {
      body = `Summary:\n${row.summary.trim()}`;
    } else {
      const s = await this.d.load(row.id).catch(() => undefined);
      const msgs = (s?.messages ?? []).filter((m) => !m.meta?.hidden && (m.role === 'user' || m.role === 'assistant'));
      const first = msgs.find((m) => m.role === 'user' && plainText(m));
      const last = [...msgs].reverse().find((m) => m.role === 'assistant' && plainText(m));
      body = `${first ? `First request:\n${plainText(first)}` : ''}${last ? `\n\nLast answer:\n${plainText(last)}` : ''}`.trim() || '(empty conversation)';
    }
    const when = new Date(row.updatedAt).toISOString().slice(0, 10);
    return `<chat_ref id="${row.id}" title="${esc(row.title)}" updated="${when}"${localOnlyAttr(isLocalOnlyConversation(row.tags))}>\n${capTokens(body, o.tokens ?? CHAT_REF_TOKENS)}\n</chat_ref>`;
  }

  /** history_search: snippets of matching messages (this project by default), one line per hit. */
  async search(query: string, o: { projectId?: string; allProjects?: boolean; currentId?: string; limit?: number }): Promise<string> {
    const projectId = o.allProjects ? 'all' : o.projectId ?? 'all';
    const hits = await this.d.index.search({ text: query, projectId, limit: Math.min(50, (o.limit ?? SEARCH_MAX_HITS) * 3) });
    if (!hits.length) {
      return `No earlier conversation matches "${query}"${o.allProjects ? '' : ' in this project (all_projects: true widens the search)'}.`;
    }
    const rows = new Map<string, ConversationRow | undefined>();
    for (const id of new Set(hits.map((h) => h.conversationId))) {
      rows.set(id, await this.d.index.conversation(id).catch(() => undefined));
    }
    const seen = new Set<string>();
    const lines: string[] = [];
    for (const h of hits) {
      const key = `${h.conversationId}:${h.messageId ?? h.field}`;
      if (seen.has(key) || lines.length >= (o.limit ?? SEARCH_MAX_HITS)) {
        continue;
      }
      seen.add(key);
      const row = rows.get(h.conversationId);
      const title = row?.title ?? h.title ?? h.conversationId;
      const line = `- ${h.conversationId}${h.conversationId === o.currentId ? ' (this chat)' : ''} "${title}" ${new Date(h.at).toISOString().slice(0, 10)}${h.messageId ? ` message ${h.messageId}` : ''} [${h.field}${h.role ? `, ${h.role}` : ''}]: ${strip(h.snippet).replace(/\s+/g, ' ').slice(0, 240)}`;
      lines.push(isLocalOnlyConversation(row?.tags) ? `<chat_hit id="${h.conversationId}" title="${esc(title)}"${localOnlyAttr(true)}>${line}</chat_hit>` : line);
    }
    return `${lines.join('\n')}\n\nRead a conversation (or part of it) with history_read.`;
  }

  /**
   * history_read: messages of one conversation (requests and answers; tool output left out), `from`..`to`
   * (1-based, inclusive; default the last 10), or the messages around `messageId`. Capped per message and per call.
   */
  async read(id: string, o: { from?: number; to?: number; messageId?: string; projectId?: string }): Promise<string> {
    const row = await this.find(id, o.projectId);
    if (!row) {
      return `No conversation "${id}". history_search returns conversation ids.`;
    }
    const s = await this.d.load(row.id).catch(() => undefined);
    const msgs = (s?.messages ?? []).filter((m) => !m.meta?.hidden && (m.role === 'user' || m.role === 'assistant') && plainText(m));
    if (!msgs.length) {
      return `"${row.title}" has no messages to read.`;
    }
    let from = Math.max(1, Math.floor(o.from ?? msgs.length - 9));
    let to = Math.min(msgs.length, Math.floor(o.to ?? from + 9));
    if (o.messageId) {
      const at = msgs.findIndex((m) => m.meta?.id === o.messageId);
      if (at >= 0) {
        from = Math.max(1, at + 1 - 2);
        to = Math.min(msgs.length, at + 1 + 2);
      }
    }
    if (to - from + 1 > READ_MAX_MESSAGES) {
      to = from + READ_MAX_MESSAGES - 1;
    }
    let left = READ_TOTAL_CHARS;
    const out: string[] = [];
    for (let i = from; i <= to && left > 0; i++) {
      const m = msgs[i - 1];
      let t = plainText(m);
      if (t.length > READ_MESSAGE_CHARS) {
        t = `${t.slice(0, READ_MESSAGE_CHARS)}\n…(message cut; ${t.length.toLocaleString('en')} characters)`;
      }
      t = t.length > left ? `${t.slice(0, left)}\n…(cut)` : t;
      left -= t.length;
      out.push(`[${i}] ${m.role}${m.meta?.id ? ` ${m.meta.id}` : ''}:\n${t}`);
    }
    const more = to < msgs.length ? ` Messages ${to + 1}–${msgs.length} follow (from: ${to + 1}).` : '';
    return `<chat_ref id="${row.id}" title="${esc(row.title)}" messages="${from}-${to} of ${msgs.length}"${localOnlyAttr(isLocalOnlyConversation(row.tags))}>\n${out.join('\n\n')}\n</chat_ref>${more}`;
  }
}

/**
 * The agent's read-only tools over earlier conversations. `get` returns the service once continuity is open (the
 * tools say so when it is not), `projectOf` the chat's project.
 */
export function historyTools(get: () => RelatedContext | undefined, projectOf: (sessionId?: string) => Promise<string | undefined>): Tool[] {
  const unavailable = { content: 'Earlier conversations are not available in this window (conversation storage is off or still starting).', isError: true };
  const search: Tool = {
    readOnly: true,
    parallelSafe: true,
    definition: {
      name: 'history_search',
      description:
        'Search earlier conversations (requests, answers, code and errors) by words or "a phrase"; returns snippets with conversation ids. Defaults to this project. Use it when the user refers to earlier work ("like last time", "the bug we fixed yesterday") or before redoing an investigation that may have been done already. Inline filters work: in:code, in:errors, from:user, before:YYYY-MM-DD, after:YYYY-MM-DD.',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string' }, all_projects: { type: 'boolean', description: 'Search every project, not only this one' } },
        required: ['query'],
      },
    },
    async execute(args, ctx) {
      const r = get();
      const query = String(args.query ?? '').trim();
      if (!query) {
        return { content: 'history_search needs a query.', isError: true };
      }
      if (!r) {
        return unavailable;
      }
      return { content: await r.search(query, { projectId: await projectOf(ctx.sessionId), allProjects: args.all_projects === true, currentId: ctx.sessionId }) };
    },
  };
  const read: Tool = {
    readOnly: true,
    parallelSafe: true,
    definition: {
      name: 'history_read',
      description: `Read messages of an earlier conversation by id (from history_search) or title: requests and answers, tool output left out. Default the last 10; "from"/"to" pick a range (1-based), "message_id" the messages around one hit. At most ${READ_MAX_MESSAGES} messages and ${READ_TOTAL_CHARS.toLocaleString('en')} characters per call.`,
      parameters: {
        type: 'object',
        properties: { conversation_id: { type: 'string' }, from: { type: 'number' }, to: { type: 'number' }, message_id: { type: 'string' } },
        required: ['conversation_id'],
      },
    },
    async execute(args, ctx) {
      const r = get();
      if (!r) {
        return unavailable;
      }
      const id = String(args.conversation_id ?? '').trim();
      if (!id) {
        return { content: 'history_read needs a conversation_id.', isError: true };
      }
      const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : undefined);
      return { content: await r.read(id, { from: num(args.from), to: num(args.to), messageId: typeof args.message_id === 'string' ? args.message_id : undefined, projectId: await projectOf(ctx.sessionId) }) };
    },
  };
  return [search, read];
}
