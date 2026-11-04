import { ChatMessage } from '../types';

/** Assistant replies kept word for word at the end of a basic summary. */
export const BASIC_KEEP_ASSISTANT = 3;

const PRIMARY_ARGS = ['path', 'command', 'query', 'pattern', 'url', 'name', 'symbol', 'file', 'target', 'title', 'prompt'];

/** The argument that says what a call did (`read_file src/a.ts`, `run_command npm test`), one line, shortened. */
export function primaryArg(args: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(args);
  } catch {
    return '';
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return '';
  }
  const rec = parsed as Record<string, unknown>;
  const key = PRIMARY_ARGS.find((k) => typeof rec[k] === 'string' && rec[k]) ?? Object.keys(rec).find((k) => typeof rec[k] === 'string' && (rec[k] as string).length <= 200);
  const v = key ? String(rec[key]).replace(/\s+/g, ' ').trim() : '';
  return v.length > 80 ? `${v.slice(0, 77)}…` : v;
}

/** `ok`, `error`, or for commands `exit 1, 3 lines of error`. */
export function toolOutcome(name: string, content: string | undefined, failed?: boolean): string {
  if (content === undefined) {
    return 'no result';
  }
  if (/^\[tool output pruned/.test(content)) {
    return failed ? 'error' : 'ok';
  }
  const exit = /\n\[exit code (-?\d+|null)\]\s*$/.exec(content);
  if (name === 'run_command' && exit) {
    if (exit[1] === '0') {
      return 'exit 0';
    }
    const body = content.slice(0, exit.index).split('\n').slice(1).filter((l) => l.trim() && l.trim() !== '(no output)');
    return `exit ${exit[1]}, ${body.length} line${body.length === 1 ? '' : 's'} of error`;
  }
  const isError = failed ?? /^(Error|Blocked by|Not run|User declined|The user declined|Tool "|Failed|Stopped by|Nothing was run|File not found|Plan mode:|Ask mode:)/i.test(content.trim());
  return isError ? 'error' : 'ok';
}

const textOf = (m: ChatMessage) => m.content.trim();

const CONTEXT_BLOCK = /<(attachment|directory|workspace_tree|problems|git|open_editors|terminal_output|selection|url|commit|pdf)\b([^>]*)>[\s\S]*?<\/\1>/g;

/** A user message's own words; attached context blocks (file contents, @git …) shrink to a reference. */
function userWords(content: string): string {
  return content
    .replace(CONTEXT_BLOCK, (_m, tag: string, attrs: string) => {
      const ref = /\b(?:path|url|ref)="([^"]*)"/.exec(attrs)?.[1];
      return `[attached ${ref ?? `@${tag}`}]`;
    })
    .trim();
}

/** Tool results carried in a user message (text tool protocol), in call order. */
function textProtocolResults(m: ChatMessage): string[] {
  return [...m.content.matchAll(/<tool_result name="[^"]*">\n?([\s\S]*?)\n?<\/tool_result>/g)].map((r) => r[1]);
}

const BASIC_HEAD = /^Earlier conversation, compacted without a model:[^\n]*\n*/;

/** Head and tail of `text` within about `max` chars, with an omission marker in between. */
export function clipMiddle(text: string, max: number): string {
  if (text.length <= max) {
    return text;
  }
  const keep = Math.max(0, max - 40);
  const head = Math.ceil(keep / 2);
  return `${text.slice(0, head)}\n[… ${(text.length - keep).toLocaleString()} chars omitted …]\n${text.slice(text.length - (keep - head))}`;
}

/** An earlier summary's content; an earlier basic digest is flattened so digests never nest. */
function priorContent(content: string): string {
  const inner = (/<conversation_summary>\n?([\s\S]*?)\n?<\/conversation_summary>/.exec(content)?.[1] ?? content).trim();
  if (!BASIC_HEAD.test(inner)) {
    return inner;
  }
  return inner
    .replace(BASIC_HEAD, '')
    .split('\n\n')
    .filter((block) => block !== '## Earlier summary' && block !== '## Conversation')
    .join('\n\n')
    .trim();
}

/**
 * The deterministic "basic" compaction: no model call. Every user message is kept word for word (attached file
 * contents become a reference), the last `keepAssistant` assistant replies too, and each earlier tool call becomes
 * one line (`• read_file src/a.ts (ok)`). Earlier summaries are carried over in front. `messages` is the part of the
 * conversation being replaced. With `maxChars`, long messages keep their head and tail, and when the digest is still
 * too long the oldest entries are dropped, so it always fits the space it is given.
 */
export function basicSummary(messages: ChatMessage[], keepAssistant = BASIC_KEEP_ASSISTANT, maxChars?: number): string {
  const clip = (text: string) => (maxChars === undefined ? text : clipMiddle(text, Math.max(200, Math.min(4000, Math.floor(maxChars / 8)))));
  const results = new Map<string, { content: string; failed?: boolean }>();
  for (const m of messages) {
    if (m.role === 'tool' && m.toolCallId) {
      results.set(m.toolCallId, { content: m.content, failed: m.meta?.failed });
    } else if (m.role === 'user' && m.meta?.toolResults) {
      const texts = textProtocolResults(m);
      m.meta.toolResults.forEach((id, i) => results.set(id, { content: texts[i] ?? '' }));
    }
  }
  const replies = messages.filter((m) => m.role === 'assistant' && textOf(m) && !m.meta?.nudge);
  const verbatim = new Set(replies.slice(-Math.max(0, keepAssistant)));
  const prior: string[] = [];
  const lines: string[] = [];
  let toolBlock = false;
  const push = (text: string, tool = false) => {
    if (tool && toolBlock) {
      lines[lines.length - 1] += `\n${text}`;
    } else {
      lines.push(text);
    }
    toolBlock = tool;
  };
  for (const m of messages) {
    if (m.meta?.summary) {
      const inner = priorContent(m.content);
      if (inner) {
        prior.push(maxChars === undefined ? inner : clipMiddle(inner, Math.floor(maxChars / 3)));
      }
    } else if (m.role === 'user') {
      if (m.meta?.hidden || m.meta?.toolImages || m.meta?.toolResults) {
        continue;
      }
      const text = userWords(m.content);
      if (text) {
        push(`User: ${clip(text)}`);
      }
    } else if (m.role === 'assistant') {
      if (verbatim.has(m)) {
        push(`Assistant: ${clip(textOf(m))}`);
      }
      for (const c of m.toolCalls ?? []) {
        const r = results.get(c.id);
        const arg = primaryArg(c.arguments);
        push(`• ${c.name}${arg ? ` ${arg}` : ''} (${toolOutcome(c.name, r?.content, r?.failed)})`, true);
      }
    }
  }
  const head = `Earlier conversation, compacted without a model: user messages verbatim, the last ${keepAssistant} assistant replies verbatim, one line per tool call.`;
  const build = (dropped: number) => {
    const p = prior.slice(Math.min(dropped, prior.length));
    const l = lines.slice(Math.max(0, dropped - prior.length));
    const note = dropped ? [`[${dropped} earlier entr${dropped === 1 ? 'y' : 'ies'} omitted to fit the context window]`] : [];
    return [head, ...(p.length ? ['## Earlier summary', ...p] : []), '## Conversation', ...note, ...l].join('\n\n');
  };
  let out = build(0);
  if (maxChars === undefined || out.length <= maxChars) {
    return out;
  }
  // Drop the oldest entries until it fits (a binary search: the length only shrinks as more are dropped).
  let lo = 1;
  let hi = prior.length + lines.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (build(mid).length <= maxChars) {
      hi = mid;
    } else {
      lo = mid + 1;
    }
  }
  out = build(lo);
  return out.length <= maxChars ? out : out.slice(0, maxChars);
}
