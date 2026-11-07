// Drafts of answers being generated (design §13 "Laptop off during generation", SESSION brief item 3): the streaming
// text of a chat's current model response goes to `<root>/drafts/<conversationId>.json` every 2 s (tmp + rename, never
// synced, never in the event log). The file goes when the run ends. On the next start, a draft newer than the chat's
// last message becomes an assistant message with `meta.partial`, offered as Continue / Regenerate / Discard.
// Pure Node (no vscode).
import * as fs from 'fs';
import * as path from 'path';
import type { ChatMessage, Session } from '../../types';
import { leaseIsFree } from '../data/lease';

export const DRAFT_INTERVAL_MS = 2000;
/** A draft keeps at most this much text (an answer this long is rare; the rest would only cost disk writes). */
export const DRAFT_MAX_CHARS = 200_000;

export interface Draft {
  v: 1;
  conversationId: string;
  text: string;
  thinking?: string;
  model?: string;
  /** The writer stream (`<deviceId>.<n>`) and process of the run that streams it. */
  stream: string;
  pid: number;
  /** The agent session it belongs to. */
  agentSessionId?: string;
  /** The chat's last message id when this response started (what the partial answer follows). */
  afterMessageId?: string;
  afterCount: number;
  startedAt: number;
  updatedAt: number;
}

export interface DraftStoreOptions {
  root: string;
  stream: string;
  now?: () => number;
  intervalMs?: number;
  warn?: (m: string) => void;
}

interface Pending {
  draft: Draft;
  timer?: NodeJS.Timeout;
  dirty: boolean;
}

/** One per process: buffers each chat's streaming text and writes it at most every `intervalMs`. */
export class DraftStore {
  readonly dir: string;
  private readonly now: () => number;
  private readonly pending = new Map<string, Pending>();

  constructor(private readonly o: DraftStoreOptions) {
    this.dir = path.join(o.root, 'drafts');
    this.now = o.now ?? Date.now;
  }

  file(conversationId: string): string {
    return path.join(this.dir, `${conversationId.replace(/[^\w.-]/g, '_')}.json`);
  }

  /** A model response starts: an empty draft (nothing is written until text arrives). */
  begin(conversationId: string, o: { model?: string; agentSessionId?: string; afterMessageId?: string; afterCount: number }): void {
    const prev = this.pending.get(conversationId);
    if (prev?.timer) {
      clearTimeout(prev.timer);
    }
    if (prev) {
      // The previous response was finalised: its draft is stale.
      fs.rmSync(this.file(conversationId), { force: true });
    }
    const at = this.now();
    this.pending.set(conversationId, {
      dirty: false,
      draft: { v: 1, conversationId, text: '', stream: this.o.stream, pid: process.pid, startedAt: at, updatedAt: at, afterCount: o.afterCount, ...(o.model ? { model: o.model } : {}), ...(o.agentSessionId ? { agentSessionId: o.agentSessionId } : {}), ...(o.afterMessageId ? { afterMessageId: o.afterMessageId } : {}) },
    });
  }

  /** Streaming text (or thinking) of the current response. */
  append(conversationId: string, text: string, kind: 'text' | 'thinking' = 'text'): void {
    const p = this.pending.get(conversationId);
    if (!p || !text) {
      return;
    }
    if (kind === 'thinking') {
      p.draft.thinking = ((p.draft.thinking ?? '') + text).slice(0, DRAFT_MAX_CHARS);
    } else {
      if (p.draft.text.length >= DRAFT_MAX_CHARS) {
        return;
      }
      p.draft.text = (p.draft.text + text).slice(0, DRAFT_MAX_CHARS);
    }
    p.draft.updatedAt = this.now();
    p.dirty = true;
    if (!p.timer) {
      p.timer = setTimeout(() => {
        p.timer = undefined;
        this.write(p);
      }, this.o.intervalMs ?? DRAFT_INTERVAL_MS);
      p.timer.unref?.();
    }
  }

  /** The text streamed so far was retracted (a nudge): the next text replaces it. */
  reset(conversationId: string): void {
    const p = this.pending.get(conversationId);
    if (p) {
      p.draft.text = '';
      p.draft.thinking = undefined;
      p.dirty = true;
    }
  }

  /** Writes what is buffered now (tests, shutdown). */
  flush(conversationId?: string): void {
    for (const [id, p] of this.pending) {
      if (!conversationId || id === conversationId) {
        if (p.timer) {
          clearTimeout(p.timer);
          p.timer = undefined;
        }
        this.write(p);
      }
    }
  }

  /** The answer was saved with the chat (or the run ended): its draft goes. */
  clear(conversationId: string): void {
    const p = this.pending.get(conversationId);
    if (p?.timer) {
      clearTimeout(p.timer);
    }
    this.pending.delete(conversationId);
    try {
      fs.rmSync(this.file(conversationId), { force: true });
    } catch {
      // gone already
    }
  }

  private write(p: Pending): void {
    if (!p.dirty) {
      return;
    }
    p.dirty = false;
    if (!p.draft.text.trim() && !p.draft.thinking?.trim()) {
      return;
    }
    const f = this.file(p.draft.conversationId);
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      const tmp = `${f}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(p.draft));
      fs.renameSync(tmp, f);
    } catch (e) {
      this.o.warn?.(`continuity: draft: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  read(conversationId: string): Draft | undefined {
    try {
      const d = JSON.parse(fs.readFileSync(this.file(conversationId), 'utf8')) as Draft;
      return d?.v === 1 && typeof d.text === 'string' && d.conversationId === conversationId ? d : undefined;
    } catch {
      return undefined;
    }
  }

  /** Conversations with a draft on disk. */
  list(): string[] {
    try {
      return fs.readdirSync(this.dir).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5));
    } catch {
      return [];
    }
  }

  /** True while the run that writes this draft is still streaming somewhere (this process, or another live writer). */
  live(d: Draft, activeHere: (conversationId: string) => boolean): boolean {
    if (d.stream === this.o.stream) {
      return d.pid === process.pid && activeHere(d.conversationId);
    }
    return !leaseIsFree(path.join(this.o.root, 'streams', d.stream, 'lease.json'));
  }

  dispose(): void {
    // Pending drafts are written so a crash right after still finds them; a clean end has cleared them already.
    this.flush();
    this.pending.clear();
  }
}

/**
 * The partial answer a draft leaves for a chat, or undefined (no draft, already saved, older than the chat, empty).
 * A draft is newer when it was written after the chat's last message and its text is not already the last answer.
 */
export function partialFromDraft(session: Pick<Session, 'messages'>, d: Draft | undefined): ChatMessage | undefined {
  if (!d || !d.text.trim()) {
    return undefined;
  }
  const msgs = session.messages;
  const last = msgs[msgs.length - 1];
  const lastAt = last?.meta?.timestamp ?? 0;
  if (lastAt && d.updatedAt <= lastAt) {
    return undefined;
  }
  // The response was saved after all (the chat's last answer already holds the text).
  const lastAnswer = [...msgs].reverse().find((m) => m.role === 'assistant');
  if (lastAnswer && (lastAnswer.content ?? '').includes(d.text.trim())) {
    return undefined;
  }
  // The chat was rewound or edited past the point the response followed.
  if (d.afterMessageId && !msgs.some((m) => m.meta?.id === d.afterMessageId)) {
    return undefined;
  }
  return {
    role: 'assistant',
    content: d.text,
    ...(d.thinking ? { thinking: d.thinking } : {}),
    meta: { timestamp: d.updatedAt, partial: true, ...(d.model ? { model: d.model } : {}) },
  };
}
