// CONTEXT module facade (design §2.1 `Continuity.context`): context snapshots, the context library, related
// conversations and the context policy, plus the per-chat state they share in this process (what the policy kept
// back on the last request, which chats got the local -> cloud notice, files changed since a chat last ran). The
// agent loop reaches it through `ContextTurnHooks` (src/ui/contextHost.ts builds them). Pure Node.
import type { ChatMessage, Session } from '../../types';
import type { EventLog } from '../data/eventLog';
import type { IndexClient } from '../data/index/indexClient';
import type { Retention } from '../data/retention';
import { applyPolicy, blockReason, cloudNotice, Excluded, isLocalOnlyConversation } from './contextPolicy';
import { ContextLibrary } from './contextLibrary';
import { changedNote, ContextSnapshot, ContextSnapshots, RecordInput, restoreInto, Restored } from './contextSnapshots';
import { RelatedContext } from './relatedContext';

export interface ContextServiceOptions {
  log: EventLog;
  index: IndexClient;
  retention: Retention;
  /** A conversation as a Session (ConversationManager.materialize). */
  load: (id: string) => Promise<Session | undefined>;
  /** The project of a chat (its folder's), else this process's. */
  projectOf: (sessionId?: string) => Promise<string | undefined>;
  now?: () => number;
}

export class ContextService {
  readonly snapshots: ContextSnapshots;
  readonly library: ContextLibrary;
  readonly related: RelatedContext;
  /** Per chat: what the policy kept back on the last request (shown in the snapshot's Excluded list). */
  private readonly lastExcluded = new Map<string, Excluded[]>();
  /** Chats that got the local -> cloud notice in this process. */
  private readonly noticed = new Set<string>();
  /** Chats restored in this process, and the files that changed since each last ran (for its next turn). */
  private readonly restored = new Map<string, Restored | null>();
  /** Tags per conversation, briefly cached (looked up before every request). */
  private readonly tagCache = new Map<string, { at: number; tags: string[] }>();
  private readonly listeners = new Set<() => void>();
  private readonly now: () => number;

  constructor(private readonly o: ContextServiceOptions) {
    this.now = o.now ?? Date.now;
    const sync = async () => {
      await o.log.flush();
      await o.index.catchUp().catch(() => 0);
    };
    this.snapshots = new ContextSnapshots({ log: o.log, index: o.index, now: o.now });
    this.library = new ContextLibrary({ log: o.log, index: o.index, retention: o.retention, sync, now: o.now, onChange: () => this.changed() });
    this.related = new RelatedContext({ index: o.index, load: o.load, projectOf: o.projectOf });
  }

  /** The Context library or a chat's context changed (pages refresh). */
  onDidChange(l: () => void): { dispose(): void } {
    this.listeners.add(l);
    return { dispose: () => this.listeners.delete(l) };
  }
  changed(): void {
    this.listeners.forEach((l) => {
      try {
        l();
      } catch {
        // a listener's failure is its own
      }
    });
  }

  projectOf(sessionId?: string): Promise<string | undefined> {
    return this.o.projectOf(sessionId);
  }

  async tags(conversationId: string): Promise<string[]> {
    const hit = this.tagCache.get(conversationId);
    if (hit && this.now() - hit.at < 10_000) {
      return hit.tags;
    }
    const row = await this.o.index.conversation(conversationId).catch(() => undefined);
    const tags = row?.tags ?? [];
    this.tagCache.set(conversationId, { at: this.now(), tags });
    return tags;
  }
  /** Forget cached tags (the navigator changed them). */
  forgetTags(ids?: string[]): void {
    if (ids) {
      ids.forEach((id) => this.tagCache.delete(id));
    } else {
      this.tagCache.clear();
    }
  }

  /**
   * Before a model request: applies the policy (cloud models get no local-only blocks) and decides whether the chat
   * may go to that model at all and whether the one-time local -> cloud notice is due.
   */
  async beforeRequest(o: { sessionId: string; messages: ChatMessage[]; remote: boolean; model: string; provider: string; topLevel: boolean; memoryExcluded?: Excluded[] }): Promise<{ messages: ChatMessage[]; excluded: Excluded[]; block?: string; notice?: string }> {
    const { messages, excluded } = applyPolicy(o.messages, { remote: o.remote });
    const all = [...(o.memoryExcluded ?? []).filter((e) => e.reason === 'localOnly' && o.remote), ...excluded];
    if (!o.topLevel) {
      return { messages, excluded: all };
    }
    this.lastExcluded.set(o.sessionId, all);
    if (!o.remote) {
      return { messages, excluded: all };
    }
    const block = blockReason({ remote: true, tags: await this.tags(o.sessionId), model: o.model });
    if (block) {
      return { messages, excluded: all, block };
    }
    let notice: string | undefined;
    if (!this.noticed.has(o.sessionId)) {
      const earlier = await this.snapshots.list(o.sessionId, 200).catch(() => [] as ContextSnapshot[]);
      notice = cloudNotice({ remote: true, model: o.model, provider: o.provider, earlierRemote: earlier.some((s) => s.remote), earlierLocal: earlier.some((s) => s.remote === false), shown: false, excluded: all });
      // Decided once per chat and process: the snapshot this turn records (remote) settles it for later processes.
      this.noticed.add(o.sessionId);
    }
    return { messages, excluded: all, notice };
  }

  /** What the policy kept back on the chat's last request. */
  excludedFor(sessionId: string): Excluded[] {
    return this.lastExcluded.get(sessionId) ?? [];
  }

  /** Records a snapshot (with the policy's exclusions of the chat's last request). */
  record(i: RecordInput): ContextSnapshot {
    const snap = this.snapshots.record({ ...i, excluded: [...(i.excluded ?? []), ...this.excludedFor(i.conversationId)] });
    this.changed();
    return snap;
  }

  /**
   * A chat opened with no live state in this process: its latest snapshot's working set, todos and attachments come
   * back, and the files changed since are remembered for the next turn. Once per chat and process.
   */
  async restore(session: Session, root: string | undefined): Promise<Restored | undefined> {
    if (this.restored.has(session.id)) {
      return this.restored.get(session.id) ?? undefined;
    }
    this.restored.set(session.id, null);
    const snap = await this.snapshots.latest(session.id).catch(() => undefined);
    if (!snap) {
      return undefined;
    }
    const r = restoreInto(session, snap, root ?? snap.root);
    this.restored.set(session.id, r ?? null);
    return r;
  }

  /** The chat ran a turn here: its live state is current, nothing to restore any more. */
  ran(sessionId: string): void {
    this.restored.set(sessionId, null);
  }

  /** A turn-context note for the chat's next turn (files changed since it last ran), given once. */
  turnNote(sessionId: string): string | undefined {
    const r = this.restored.get(sessionId);
    if (!r) {
      return undefined;
    }
    this.restored.set(sessionId, null);
    return changedNote(r.changed);
  }

  /** Whether a conversation is kept away from cloud models (tag `local-only`). */
  async isLocalOnly(conversationId: string): Promise<boolean> {
    return isLocalOnlyConversation(await this.tags(conversationId));
  }
}
