// SessionBridge (design §9.1): the SessionStore keeps writing one JSON file per chat (a materialised cache); the
// bridge turns every save into conversation events first. Message ids (`meta.id`) are assigned on every save; a save
// is diffed against what was logged: appended messages -> message.create; a changed message -> message.patch; a changed
// prefix (rewind, edit, regenerate, retry) -> a new branch from the divergence point, the old one kept; a compaction ->
// the summary message plus the ids it keeps (`keeps`), so the log holds the full transcript; summary fields ->
// conversation.patch. Deletes become Trash, retention becomes Archive. Pure Node: no vscode.
import type { ChatMessage, Session } from '../../types';
import { messageHash, SavedShape, SaveHint, SessionStoreBridge } from '../../sessions/sessionShape';
import type { BlobStore } from '../data/blobs';
import type { FileEventLog } from '../data/eventLog';
import type { IndexClient } from '../data/index/indexClient';
import type { MessageRow } from '../data/index/queries';
import type { BranchFields, ConversationFields, MessageFields } from '../events';
import { mainBranchId, newId } from '../ids';
import { conversationFields, legacyMessageId, messageFields } from './payloads';
import type { ProjectResolver } from './projects';

/** Fields of the conversation entity the chat itself owns (the navigator owns favorite, archived and tags). */
const OWN_FIELDS = ['title', 'projectId', 'folder', 'model', 'mode', 'specialist', 'autoMode', 'think', 'pinned', 'parentId', 'parentTitle', 'group', 'plan', 'usage'] as const;
type OwnFields = Pick<ConversationFields, (typeof OWN_FIELDS)[number]>;

/** Usage changes with every request: logged at most this often while a run is going. */
const USAGE_EVERY_MS = 30_000;

interface Known {
  branch: string;
  parent?: string;
  hash?: string;
  role?: string;
}

interface ConvState {
  adopted: boolean;
  adopting?: Promise<void>;
  /** Messages already in the log for this conversation (every branch). */
  known: Map<string, Known>;
  /** Whether the conversation entity exists in the log. */
  exists: boolean;
  /** Active branch and its path in the log (message ids, root first). */
  branch: string;
  path: string[];
  /** Session.messages ids at the last logged save. */
  view: string[];
  /** Summary messages' kept ids (compaction), for view <-> path mapping. */
  keeps: Map<string, string[]>;
  own: string;
  usageAt: number;
  /** A truncation not followed by new messages yet: the reason waits for the first new message. */
  hint?: SaveHint;
}

export interface BridgeOptions {
  log: FileEventLog;
  index?: IndexClient;
  blobs?: BlobStore;
  /** Resolves once the index is usable (or failed); `healthy()` says which. */
  ready?: Promise<unknown>;
  healthy?: () => boolean;
  projects?: ProjectResolver;
  /** The folder a chat works in when it never picked one (the first workspace folder, the CLI's cwd). */
  defaultFolder?: () => string | undefined;
  origin?: ConversationFields['origin'];
  hint?: (id: string) => SaveHint | undefined;
  /** The live chat (a delete logs its last state before it goes to Trash). */
  peek?: (id: string) => Session | undefined;
  now?: () => number;
  warn?: (m: string) => void;
  /** Tests: how long adopting a chat waits for the index. */
  adoptTimeoutMs?: number;
}

const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T | undefined> =>
  Promise.race([p, new Promise<undefined>((r) => setTimeout(() => r(undefined), ms).unref?.())]);

/** Session.messages ids from a log path: after the last compaction summary, the summary, what it kept, the rest. */
export function viewOfPath(path: string[], keeps: Map<string, string[]>): string[] {
  for (let i = path.length - 1; i >= 0; i--) {
    const k = keeps.get(path[i]);
    if (k) {
      const on = new Set(path.slice(0, i));
      return [path[i], ...k.filter((id) => on.has(id)), ...path.slice(i + 1)];
    }
  }
  return [...path];
}

export class SessionBridge implements SessionStoreBridge {
  private readonly convs = new Map<string, ConvState>();
  /** Sessions whose ids this bridge assigned or accepted in this process, and the conversation each id belongs to. */
  private readonly owner = new Map<string, string>();
  private readonly firstSeen = new Set<string>();
  private readonly now: () => number;
  private readonly pending = new Map<string, Session>();
  /** Folders being resolved to a project, with the chats logged without one meanwhile (patched when it is known). */
  private readonly unresolved = new Map<string, { ids: Set<string>; done: Promise<void> }>();
  /** Listeners for "a chat was logged" (tests, the navigator's refresh). */
  onLogged?: (id: string) => void;

  constructor(private readonly o: BridgeOptions) {
    this.now = o.now ?? Date.now;
  }

  private get healthy(): boolean {
    return this.o.healthy ? this.o.healthy() : !!this.o.index;
  }

  // ---------------------------------------------------------------------------------------------- ids

  /**
   * Gives every message a stable id. A chat never logged by 1.7 (no `meta.lastHlc`) keeps the deterministic ids
   * migration gave its messages; ids copied from another chat (fork, duplicate) are replaced, keeping `copiedFrom`.
   */
  prepare(s: Session): void {
    const fresh = !s.meta?.lastHlc && !this.firstSeen.has(s.id);
    this.firstSeen.add(s.id);
    const seen = new Set<string>();
    s.messages.forEach((m, i) => {
      const id = m.meta?.id;
      const foreign = id && (this.owner.has(id) ? this.owner.get(id) !== s.id : !s.meta?.lastHlc);
      if (id && !foreign && !seen.has(id)) {
        seen.add(id);
        this.owner.set(id, s.id);
        return;
      }
      const next = !id && fresh ? legacyMessageId(s.id, m, i) : newId('m', this.now());
      m.meta = { ...m.meta, id: seen.has(next) ? newId('m', this.now()) : next, ...(id && id !== next ? { copiedFrom: id } : {}) };
      seen.add(m.meta.id!);
      this.owner.set(m.meta.id!, s.id);
    });
  }

  // ---------------------------------------------------------------------------------------------- adopt

  private state(id: string): ConvState {
    let st = this.convs.get(id);
    if (!st) {
      st = { adopted: false, known: new Map(), exists: false, branch: mainBranchId(id), path: [], view: [], keeps: new Map(), own: '', usageAt: 0 };
      this.convs.set(id, st);
    }
    return st;
  }

  /** Learns what the log already holds for a conversation (once per process). */
  private adopt(id: string): Promise<void> {
    const st = this.state(id);
    if (st.adopted) {
      return Promise.resolve();
    }
    st.adopting ??= (async () => {
      try {
        if (this.o.index && this.o.ready) {
          await withTimeout(this.o.ready, this.o.adoptTimeoutMs ?? 120_000);
        }
        if (this.o.index && this.healthy) {
          await this.loadFromIndex(id, st);
        }
      } catch (e) {
        this.o.warn?.(`continuity: could not read chat ${id} from the index: ${String(e)}`);
      } finally {
        st.adopted = true;
      }
    })();
    return st.adopting;
  }

  private async loadFromIndex(id: string, st: ConvState, branchId?: string): Promise<void> {
    const index = this.o.index!;
    const row = await index.conversation(id);
    st.exists = !!row;
    if (!row) {
      return;
    }
    const all = await index.query<{ id: string; branch_id: string; parent_id: string | null; role: string; summary: number }>('messageIds', { conversationId: id });
    st.known = new Map(all.map((r) => [r.id, { branch: r.branch_id, parent: r.parent_id ?? undefined, role: r.role }]));
    st.branch = branchId ?? row.activeBranchId ?? mainBranchId(id);
    const path: MessageRow[] = await index.messages(id, st.branch);
    st.path = path.map((m) => m.id);
    const summaries = path.filter((m) => m.summary).map((m) => m.id);
    if (summaries.length) {
      for (const r of await index.query<{ id: string; state: string }>('entityStates', { ids: summaries })) {
        const k = (JSON.parse(r.state) as { fields?: { keeps?: unknown } }).fields?.keeps;
        if (Array.isArray(k)) {
          st.keeps.set(r.id, k.map(String));
        }
      }
    }
    st.view = viewOfPath(st.path, st.keeps);
  }

  /**
   * The bridge's picture of a conversation after the log changed underneath (branch switch, restore, a remote
   * update): the next save of `s` is compared with this branch.
   */
  async reset(id: string, branchId?: string): Promise<void> {
    const st = this.state(id);
    st.adopted = false;
    st.adopting = undefined;
    st.keeps = new Map();
    st.hint = undefined;
    if (this.o.index && this.healthy) {
      await this.loadFromIndex(id, st, branchId).catch((e) => this.o.warn?.(`continuity: ${String(e)}`));
    }
    st.adopted = true;
  }

  /** Sets the picture of a session's messages without logging (the session was rebuilt from the log). */
  accept(s: Session): void {
    const st = this.state(s.id);
    st.view = s.messages.map((m) => m.meta?.id ?? '');
    for (const m of s.messages) {
      const k = st.known.get(m.meta?.id ?? '');
      if (k) {
        k.hash = messageHash(m);
      }
      if (m.meta?.id) {
        this.owner.set(m.meta.id, s.id);
      }
    }
    st.own = JSON.stringify(this.ownFields(s, st));
    this.firstSeen.add(s.id);
  }

  // ---------------------------------------------------------------------------------------------- saves

  saved(s: Session, _previous: SavedShape | undefined): void {
    void _previous;
    const st = this.state(s.id);
    if (!st.adopted) {
      // First save of this chat in this process: learn what the log has, then log the latest state.
      this.pending.set(s.id, s);
      void this.adopt(s.id).then(() => {
        const live = this.pending.get(s.id);
        this.pending.delete(s.id);
        if (live) {
          this.safeProcess(live);
        }
      });
      return;
    }
    this.safeProcess(s);
  }

  /** Logging never breaks a save (nor the process): a failure is reported and the next save tries again. */
  private safeProcess(s: Session): void {
    try {
      this.process(s);
    } catch (e) {
      this.o.warn?.(`continuity: could not log chat ${s.id}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /**
   * Chats whose file is newer than what the log has (saved by a process that ended before continuity was open, or
   * by 1.7 before this bridge existed): logged now. Bounded to the store's own list (retention keeps it short).
   */
  async reconcile(list: { id: string; updatedAt: number }[], get: (id: string) => Session | undefined): Promise<number> {
    if (!this.o.index || !this.healthy) {
      return 0;
    }
    let n = 0;
    for (const row of list) {
      const conv = await this.o.index.conversation(row.id).catch(() => undefined);
      if (conv && conv.updatedAt >= row.updatedAt - 1000) {
        continue;
      }
      const s = get(row.id);
      if (s && (s.messages.length || s.pinned || s.plan)) {
        this.saved(s, undefined);
        n++;
      }
    }
    await this.settle();
    return n;
  }

  /** Waits for every chat waiting on its first look at the index (tests, shutdown). */
  async settle(): Promise<void> {
    await Promise.all([...this.convs.values()].map((c) => c.adopting).filter(Boolean));
    await Promise.all([...this.unresolved.values()].map((u) => u.done));
  }

  private ownFields(s: Session, st: ConvState): Partial<OwnFields> {
    const project = this.projectOf(s);
    const f = conversationFields(s, { projectId: project, activeBranchId: st.branch, origin: this.o.origin });
    const out: Record<string, unknown> = {};
    for (const k of OWN_FIELDS) {
      if (f[k] !== undefined) {
        out[k] = f[k];
      }
    }
    return out as Partial<OwnFields>;
  }

  private projectOf(s: Session): string | undefined {
    const folder = s.folder ?? this.o.defaultFolder?.();
    if (!folder || !this.o.projects) {
      return undefined;
    }
    const hit = this.o.projects.peek(folder);
    if (!hit) {
      // Resolved in the background (git); once known, the chats logged without it meanwhile get it, so a chat saved
      // once right after start is still matched to its project on other devices.
      let u = this.unresolved.get(folder);
      if (!u) {
        const ids = new Set<string>();
        const done = this.o.projects
          .resolve(folder)
          .then(() => {
            for (const id of ids) {
              const live = this.pending.get(id) ?? this.o.peek?.(id);
              if (live && this.state(id).exists) {
                this.safeProcess(live);
              }
            }
          })
          .catch(() => undefined)
          .finally(() => this.unresolved.delete(folder));
        u = { ids, done };
        this.unresolved.set(folder, u);
      }
      u.ids.add(s.id);
    }
    return hit?.id;
  }

  private append(ent: Parameters<FileEventLog['append']>[0], eid: string, op: Parameters<FileEventLog['append']>[2], p: object, durable = false): void {
    this.o.log.append(ent, eid, op, p, durable ? { durable: true } : {});
  }

  /** message.create; a payload over the line limit keeps tool call arguments in a blob. */
  private createMessage(convId: string, branch: string, parent: string | undefined, m: ChatMessage, durable: boolean, extra: Partial<MessageFields> = {}): void {
    const p = messageFields(convId, branch, parent, m, { blobs: this.o.blobs });
    for (const a of p.attachments) {
      this.append('attachment', a.id, 'create', a.fields);
    }
    const fields = { ...p.fields, ...extra };
    try {
      this.append('message', m.meta!.id!, 'create', fields, durable);
    } catch (e) {
      if (!/too large/.test(String(e))) {
        throw e;
      }
      const parts = fields.parts.map((x) => (x.kind === 'tool_call' && x.args.length > 65536 ? { ...x, args: x.args.slice(0, 65536) } : x));
      this.append('message', m.meta!.id!, 'create', { ...fields, parts, truncated: true }, durable);
    }
  }

  private patchMessage(convId: string, m: ChatMessage, metaOnly: boolean): void {
    if (metaOnly) {
      const { id: _id, ...meta } = m.meta ?? {};
      void _id;
      this.append('message', m.meta!.id!, 'patch', { meta });
      return;
    }
    const p = messageFields(convId, '', undefined, m, { blobs: this.o.blobs });
    for (const a of p.attachments) {
      this.append('attachment', a.id, 'create', a.fields);
    }
    try {
      this.append('message', m.meta!.id!, 'patch', { parts: p.fields.parts, meta: p.fields.meta, ...(p.fields.model ? { model: p.fields.model } : {}) });
    } catch (e) {
      this.o.warn?.(`continuity: message ${m.meta?.id} not logged: ${String(e)}`);
    }
  }

  /** Logs the difference between the last logged state of a chat and `s`. Synchronous. */
  process(s: Session): void {
    if (!s.messages.length && !s.pinned && !s.plan && !this.state(s.id).exists) {
      return; // an untouched "New chat" is not history
    }
    // Messages added without a store.save (a direct flush) still get their ids here.
    if (s.messages.some((m) => !m.meta?.id)) {
      this.prepare(s);
    }
    const st = this.state(s.id);
    const conv = s.id;
    const running = !!s.runningSince;
    const hint = this.o.hint?.(conv);
    if (hint) {
      st.hint = hint;
    }
    let changed = false;
    if (!st.exists) {
      // Summary fields only: a migrated conversation keeps its favorite / archived / tags.
      const f = conversationFields(s, { projectId: this.projectOf(s), activeBranchId: st.branch, origin: this.o.origin });
      const { favorite: _f, archived: _a, tags: _t, ...create } = f;
      void _f;
      void _a;
      void _t;
      this.append('conversation', conv, 'create', create);
      this.append('branch', st.branch, 'create', { conversationId: conv, createdAt: s.createdAt ?? this.now() } satisfies BranchFields);
      st.exists = true;
      st.own = JSON.stringify(this.ownFields(s, st));
      changed = true;
    }
    const msgs = s.messages;
    // While a run streams, its last assistant message is logged once something follows it or the run ends.
    const defer = running && msgs.length && msgs[msgs.length - 1].role === 'assistant' && !st.known.has(msgs[msgs.length - 1].meta?.id ?? '') ? 1 : 0;
    const upto = msgs.length - defer;
    const ids = msgs.slice(0, upto).map((m) => m.meta?.id ?? '');
    const pos = new Map(st.path.map((id, i) => [id, i]));
    const logParent = (viewPrefix: string[]): string | undefined => {
      let best: string | undefined;
      let at = -1;
      for (const id of viewPrefix) {
        const p = pos.get(id);
        if (p !== undefined && p > at) {
          at = p;
          best = id;
        }
      }
      return best;
    };
    const durableFor = (m: ChatMessage, i: number) => m.role === 'user' || !running || i < upto - 1;
    const first = msgs[0];
    let k = -1;
    const compaction = !!first?.meta?.summary && !st.known.has(first.meta?.id ?? '') && ids.length > 0;
    if (compaction) {
      // [summary, ...kept, ...new]: the summary goes after the log head with the ids it keeps (the earlier messages
      // on the path, and the verbatim copies a compaction marks as archived — the same rule migration follows).
      const kept: string[] = [];
      for (let i = 1; i < upto && ((st.known.has(ids[i]) && pos.has(ids[i])) || msgs[i].meta?.archived !== undefined); i++) {
        kept.push(ids[i]);
      }
      const head = st.path[st.path.length - 1];
      this.createMessage(conv, st.branch, head, first, true, { keeps: kept });
      st.known.set(ids[0], { branch: st.branch, parent: head, hash: messageHash(first), role: first.role });
      st.keeps.set(ids[0], kept);
      st.path.push(ids[0]);
      pos.set(ids[0], st.path.length - 1);
      let prev = ids[0];
      for (let i = 1; i < upto; i++) {
        const id = ids[i];
        if (st.known.has(id)) {
          continue;
        }
        this.createMessage(conv, st.branch, prev, msgs[i], durableFor(msgs[i], i));
        st.known.set(id, { branch: st.branch, parent: prev, hash: messageHash(msgs[i]), role: msgs[i].role });
        st.path.push(id);
        pos.set(id, st.path.length - 1);
        prev = id;
      }
      changed = true;
    } else {
      k = 0;
      while (k < st.view.length && k < ids.length && st.view[k] === ids[k]) {
        k++;
      }
      const tail = ids.slice(k);
      if (tail.length) {
        const known = tail.filter((id) => st.known.has(id));
        if (known.length === tail.length && (k === st.view.length || tail.every((id) => pos.has(id)))) {
          // Messages put back that the log already has (a retry that never started), or the chat shows its own
          // branch in another arrangement (a migrated compaction): nothing to add.
        } else if (known.length === tail.length && known.every((id) => st.known.get(id)!.branch !== st.branch)) {
          // The chat now shows another branch's messages: switch to it.
          const target = st.known.get(tail[tail.length - 1])!.branch;
          this.append('conversation', conv, 'patch', { activeBranchId: target });
          st.branch = target;
          st.path = this.pathTo(st, tail[tail.length - 1]);
          changed = true;
        } else {
          let parent = logParent(ids.slice(0, k));
          if (k < st.view.length) {
            // History changed before the end: a new branch from the divergence point; the old branch stays.
            const branch = newId('br', this.now());
            const reason: BranchFields['reason'] = st.hint ?? (msgs[k]?.role === 'user' ? 'edit' : 'regenerate');
            const supersedes = st.view[k];
            this.append('branch', branch, 'create', { conversationId: conv, ...(parent ? { forkedFromMessageId: parent, headId: parent } : {}), reason, createdAt: this.now() } satisfies BranchFields, true);
            this.append('conversation', conv, 'patch', { activeBranchId: branch });
            st.branch = branch;
            st.path = parent ? st.path.slice(0, (pos.get(parent) ?? -1) + 1) : [];
            pos.clear();
            st.path.forEach((id, i) => pos.set(id, i));
            st.hint = undefined;
            let firstNew = true;
            for (let i = k; i < upto; i++) {
              const id = ids[i];
              if (st.known.has(id) && pos.has(id)) {
                parent = id;
                continue;
              }
              if (st.known.has(id)) {
                // A message of another branch reused here (rare): a copy keeps the branches apart.
                msgs[i].meta = { ...msgs[i].meta, id: newId('m', this.now()), copiedFrom: id };
                ids[i] = msgs[i].meta!.id!;
              }
              const sup = firstNew && supersedes && st.known.get(supersedes)?.role === msgs[i].role ? { supersedes } : {};
              this.createMessage(conv, branch, parent, msgs[i], durableFor(msgs[i], i), sup);
              firstNew = false;
              st.known.set(ids[i], { branch, parent, hash: messageHash(msgs[i]), role: msgs[i].role });
              st.path.push(ids[i]);
              pos.set(ids[i], st.path.length - 1);
              parent = ids[i];
            }
          } else {
            for (let i = k; i < upto; i++) {
              const id = ids[i];
              if (st.known.has(id)) {
                parent = id;
                continue;
              }
              this.createMessage(conv, st.branch, parent, msgs[i], durableFor(msgs[i], i));
              st.known.set(id, { branch: st.branch, parent, hash: messageHash(msgs[i]), role: msgs[i].role });
              st.path.push(id);
              pos.set(id, st.path.length - 1);
              parent = id;
            }
          }
          changed = true;
        }
      }
    }
    // Messages changed in place (a tool result filled in, meta added, the streamed answer finished).
    for (let i = 0; i < upto; i++) {
      const m = msgs[i];
      const k = st.known.get(m.meta?.id ?? '');
      if (!k) {
        continue;
      }
      const h = messageHash(m);
      if (k.hash === undefined) {
        k.hash = h; // adopted from the log: assume it matches
        continue;
      }
      if (k.hash !== h) {
        // A compaction's pruned copy keeps the original body in the log; only its marks change.
        this.patchMessage(conv, m, m.meta?.archived !== undefined);
        k.hash = h;
        changed = true;
      }
    }
    // A plain truncation (rewind, retry) keeps the old picture: the next new message then forks a branch, and
    // messages put back unchanged (a retry that never started) are recognised.
    if (!(k >= 0 && k === ids.length && k < st.view.length)) {
      st.view = ids;
    }
    // Summary fields.
    const own = this.ownFields(s, st);
    const json = JSON.stringify(own);
    if (json !== st.own) {
      const before = (st.own ? JSON.parse(st.own) : {}) as Record<string, unknown>;
      const patch: Record<string, unknown> = {};
      for (const key of OWN_FIELDS) {
        const a = (own as Record<string, unknown>)[key];
        if (JSON.stringify(a) !== JSON.stringify(before[key])) {
          patch[key] = a;
        }
      }
      const usageOnly = Object.keys(patch).length === 1 && 'usage' in patch;
      if (!(usageOnly && running && this.now() - st.usageAt < USAGE_EVERY_MS)) {
        if ('usage' in patch) {
          st.usageAt = this.now();
        }
        this.append('conversation', conv, 'patch', { ...patch, updatedAt: s.updatedAt });
        st.own = json;
        changed = true;
      }
    } else if (changed) {
      this.append('conversation', conv, 'patch', { updatedAt: s.updatedAt });
    }
    if (changed) {
      s.meta = { ...s.meta, lastHlc: this.o.log.peekHlc() };
      this.onLogged?.(conv);
    }
  }

  /** A branch's path from the known parents (root first). */
  private pathTo(st: ConvState, head: string): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    for (let id: string | undefined = head; id && !seen.has(id); id = st.known.get(id)?.parent) {
      seen.add(id);
      out.unshift(id);
    }
    return out;
  }

  /** The message ids of a conversation's current branch in the log (tests, the branch switcher). */
  pathOf(id: string): string[] {
    return [...(this.convs.get(id)?.path ?? [])];
  }

  activeBranch(id: string): string | undefined {
    return this.convs.get(id)?.branch;
  }

  // ---------------------------------------------------------------------------------------------- removal

  /** Delete = Trash, retention = Archive, when the conversation is safely in the log; else the 1.6 delete. */
  async removing(id: string, why: 'delete' | 'prune', live?: Session): Promise<'trash' | 'archive' | 'delete'> {
    if (!this.healthy) {
      return 'delete';
    }
    // A delete never waits long (the first-start import can take a while): without the log's picture after 3 s, the
    // chat is logged as it is (creates are idempotent) and then trashed.
    await Promise.race([this.adopt(id), new Promise((r) => setTimeout(r, 3000).unref?.())]);
    const st = this.state(id);
    const s = live ?? this.pending.get(id) ?? this.o.peek?.(id);
    if (s) {
      this.pending.delete(id);
      this.safeProcess(s);
    }
    if (!st.exists) {
      return 'delete'; // never logged (an empty chat): nothing to keep
    }
    if (why === 'prune') {
      this.append('conversation', id, 'patch', { archived: true }, true);
      return 'archive';
    }
    this.append('conversation', id, 'trash', { at: this.now(), reason: 'user' }, true);
    return 'trash';
  }

  /** Forget a conversation's state (purged). */
  forget(id: string): void {
    this.convs.delete(id);
    this.pending.delete(id);
  }
}
