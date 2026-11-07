// The host side of continuity's CONTEXT module (design §8, §16.2), shared by VS Code and the CLI: attaches the
// ContextService (snapshots, library, related conversations, policy), the agent loop's context hooks, the
// `#context:` / `#chat:` mentions, the `history_search` / `history_read` tools; the Context library page's data and
// its `contextAction` messages; the restoration of a reopened chat; the model-switch window check (the command
// `localpilot.continuity.openContextLibrary` is registered with the other continuity commands in continuityHost.ts).
import type { AgentRunner } from '../agent/agentLoop';
import type { ContextTurnHooks } from '../agent/contextHooks';
import type { MemoryStore } from '../agent/memory';
import { getConfig } from '../config';
import type { Continuity } from '../continuity/continuity';
import { LIBRARY_KINDS, slugName } from '../continuity/context/contextLibrary';
import type { ContextService } from '../continuity/context/contextService';
import type { ContextSnapshot } from '../continuity/context/contextSnapshots';
import { chatSlug, historyTools } from '../continuity/context/relatedContext';
import { effectiveContextWindow } from '../context/contextManager';
import type { WorkspaceContext } from '../context/workspaceContext';
import type { SessionStore } from '../sessions/sessionStore';
import type { ToolRegistry } from '../tools/registry';
import type { ModelInfo, Session } from '../types';

export type ContextActionName = 'create' | 'update' | 'trash' | 'restore' | 'purge' | 'attach' | 'inspect' | 'addRelated' | 'related' | 'suggest';

export type ContextFromWebview = {
  type: 'contextAction';
  action: ContextActionName;
  id?: string;
  ids?: string[];
  sessionId?: string;
  messageId?: string;
  /** inspect: the message's time (a message in the middle of a turn has no snapshot of its own). */
  at?: number;
  fields?: { name?: string; description?: string; items?: { kind: string; ref: string; text?: string }[]; localOnly?: boolean; scope?: 'project' | 'user' };
  /** related: the draft of the first message; suggest: what follows `#context:` / `#chat:`. */
  text?: string;
  kind?: 'context' | 'chat';
  query?: string;
  /** addRelated: the conversation to mention. */
  title?: string;
};

export type ContextItemsMsg = { type: 'contextItems'; sessionId: string; snapshotId: string; at: number; model: string; remote: boolean; items: ContextSnapshot['items']; excluded: NonNullable<ContextSnapshot['excluded']> };

export type ContextToWebview =
  | { type: 'related'; sessionId?: string; query: string; items: { id: string; title: string; snippet: string; mention: string }[] }
  | { type: 'contextSuggest'; kind: 'context' | 'chat'; query: string; items: { name: string; desc: string }[] }
  | ContextItemsMsg
  | { type: 'contextRestored'; sessionId: string; workingSet: number; todos: number; attachments: number; changed: { path: string; state: 'changed' | 'deleted' }[] }
  | { type: 'contextNotice'; sessionId: string; text: string; kind: 'cloud' | 'window' }
  | { type: 'contextDone'; action: string; id?: string; note?: string; error?: string };

/** Where a host shows the module's messages: the chat webview (VS Code) or the terminal (CLI). */
export interface ContextSink {
  post(m: ContextToWebview): void;
}

/** The items of a snapshot as the context ring's card shows them. */
export function itemsMsg(sessionId: string, s: ContextSnapshot): ContextItemsMsg {
  return { type: 'contextItems', sessionId, snapshotId: s.id, at: s.createdAt, model: s.model, remote: !!s.remote, items: s.items, excluded: s.excluded ?? [] };
}

/** The agent loop's hooks over a ContextService. */
export function createContextHooks(svc: ContextService, o: { sink?: ContextSink; prepare?: (s: Session) => void; log?: (m: string) => void }): ContextTurnHooks {
  return {
    beforeRequest: async (r) => {
      const res = await svc.beforeRequest({ sessionId: r.session.id, messages: r.messages, remote: !!r.model.remote, model: r.model.name || r.model.id, provider: r.model.providerId, topLevel: r.depth === 0, memoryExcluded: r.memoryExcluded });
      if (res.notice) {
        o.sink?.post({ type: 'contextNotice', sessionId: r.session.id, text: res.notice, kind: 'cloud' });
      }
      return { messages: res.messages, block: res.block };
    },
    turnNote: (s) => svc.turnNote(s.id),
    snapshot: (r) => {
      // The turn's snapshot names its answer (ids are given now, as the next save would), for "What did the model see?".
      if (r.phase === 'turn') {
        try {
          o.prepare?.(r.session);
        } catch {
          // ids come with the next save
        }
      }
      const last = r.phase === 'turn' ? [...r.session.messages].reverse().find((m) => m.role === 'assistant' && m.meta?.id) : undefined;
      const snap = svc.record({
        conversationId: r.session.id,
        ...(last?.meta?.id ? { messageId: last.meta.id } : {}),
        model: r.model.id,
        provider: r.model.providerId,
        remote: !!r.model.remote,
        window: r.model.contextWindow,
        usedTokens: r.usedTokens,
        breakdown: r.breakdown,
        excluded: r.memoryExcluded,
        compaction: r.compaction,
        phase: r.phase,
        attachments: r.session.attachments,
        workingSet: r.session.workingSet,
        todos: r.session.todos,
        root: r.root,
        messages: r.messages,
        memorySection: r.memorySection,
        rules: r.rules,
        ruleLabels: r.ruleLabels,
      });
      if (r.phase === 'turn') {
        svc.ran(r.session.id);
        o.sink?.post(itemsMsg(r.session.id, snap));
      }
    },
  };
}

/**
 * Connects the CONTEXT module once continuity is open: the service, the agent hooks, the mentions and the history
 * tools. Returns a disposable (or a no-op when continuity is degraded).
 */
export function attachContext(c: Continuity, o: { runner: AgentRunner; workspace: WorkspaceContext; memory?: MemoryStore; tools: ToolRegistry; sink?: ContextSink; defaultFolder: () => string | undefined; prepare?: (s: Session) => void; log: { warn(m: string): void; debug(m: string): void } }): { dispose(): void } {
  const svc = c.attachContext({ defaultFolder: o.defaultFolder });
  if (!svc) {
    return { dispose: () => undefined };
  }
  o.runner.contextHooks = createContextHooks(svc, { sink: o.sink, prepare: o.prepare ?? ((s) => c.bridge?.prepare(s)), log: (m) => o.log.debug(m) });
  const toolsReg = o.tools.registerAll(historyTools(() => (c.context === svc ? svc.related : undefined), (sid) => svc.projectOf(sid)));
  const deps = async () => ({ root: o.defaultFolder(), projectId: await svc.projectOf().catch(() => undefined), memory: o.memory ? (n: string) => o.memory!.mention(n) : undefined, chat: (r: string) => svc.related.chatBlock(r) });
  o.workspace.mentionResolvers.set('context', async (name) => svc.library.resolve(name, await deps()));
  o.workspace.mentionResolvers.set('chat', async (ref) => svc.related.chatBlock(ref, { projectId: await svc.projectOf().catch(() => undefined) }));
  return {
    dispose: () => {
      toolsReg.dispose();
      o.workspace.mentionResolvers.delete('context');
      o.workspace.mentionResolvers.delete('chat');
      if (o.runner.contextHooks) {
        o.runner.contextHooks = undefined;
      }
    },
  };
}

/** File refs of a chat: what was attached to its messages, then its working set (newest last). */
export function chatFiles(s: Session | undefined): string[] {
  if (!s) {
    return [];
  }
  const out: string[] = [];
  for (const m of s.messages) {
    if (m.role === 'user' && typeof m.content === 'string') {
      for (const x of m.content.matchAll(/<attachment\b[^>]*\bpath="([^"]+)"/g)) {
        out.push(x[1].replace(/&quot;/g, '"'));
      }
    }
  }
  out.push(...(s.workingSet ?? []).slice(-15));
  return [...new Set(out.filter((p) => !/^https?:/i.test(p)))].slice(0, 40);
}

/** Context library page data (§16.2): sets, and the chat's snapshots with the one to show. */
export async function contextPageData(c: Continuity, store: SessionStore, params: Record<string, unknown>, activeId: string | undefined): Promise<unknown> {
  const svc = c.context;
  if (!svc) {
    return { off: 'starting' };
  }
  const sid = typeof params.sessionId === 'string' ? params.sessionId : activeId;
  const projectId = await svc.projectOf(sid).catch(() => undefined);
  const all = params.all === true;
  const sets = await svc.library.list({ projectId: all ? undefined : projectId });
  const snapshots = sid ? await svc.snapshots.list(sid, 40).catch(() => [] as ContextSnapshot[]) : [];
  const pick = typeof params.snapshotId === 'string' ? (snapshots.find((x) => x.id === params.snapshotId) ?? (await svc.snapshots.get(params.snapshotId))) : snapshots.find((x) => x.phase !== 'before-compaction') ?? snapshots[0];
  const session = sid && store.has(sid) ? store.get(sid) : undefined;
  const title = session?.title ?? (sid ? (await c.conversations?.conversation(sid).catch(() => undefined))?.title : undefined);
  return {
    view: params.view === 'chat' || params.snapshotId ? 'chat' : params.view === 'edit' ? 'edit' : 'library',
    all,
    projectId,
    sets,
    kinds: LIBRARY_KINDS,
    chat: sid ? { id: sid, title: title ?? 'This chat', files: chatFiles(session) } : undefined,
    snapshot: pick,
    snapshots: snapshots.map((x) => ({ id: x.id, at: x.createdAt, model: x.model, phase: x.phase ?? 'turn', usedTokens: x.usedTokens, window: x.window, remote: !!x.remote, messageId: x.messageId })),
    relatedEnabled: getConfig().continuity.relatedConversations,
  };
}

interface Ctx {
  c: () => Continuity | undefined;
  store: SessionStore;
  post: (m: unknown) => void;
  toast: (text: string, level?: 'info' | 'warn' | 'error') => void;
  activeSessionId: () => string | undefined;
  /** Puts text into the chat's composer (Attach to chat, Related · Add). */
  compose: (text: string) => void;
  /** Opens a continuity page (the snapshot of a message). */
  openPage: (params: Record<string, unknown>) => void;
}

/** Handles a `contextAction` from the chat webview. */
export async function contextAction(msg: ContextFromWebview, x: Ctx): Promise<void> {
  const c = x.c();
  const svc = c?.context;
  if (!c || !svc) {
    if (msg.action !== 'related' && msg.action !== 'suggest') {
      x.toast(c?.degraded ? `Context storage is off: ${c.degraded}` : 'Context storage is still starting — try again in a moment.', 'warn');
    }
    return;
  }
  const done = (action: string, note?: string, id?: string) => x.post({ type: 'contextDone', action, ...(id ? { id } : {}), ...(note ? { note } : {}) } satisfies ContextToWebview);
  const ids = msg.ids ?? (msg.id ? [msg.id] : []);
  try {
    switch (msg.action) {
      case 'create': {
        const f = msg.fields ?? {};
        const projectId = f.scope === 'user' ? undefined : await svc.projectOf(x.activeSessionId());
        const id = await svc.library.create({ name: String(f.name ?? ''), description: f.description, projectId, items: f.items, localOnly: f.localOnly });
        done('create', `Saved context set "${String(f.name ?? '').trim()}" — attach it with #context:${slugName(String(f.name ?? ''))}`, id);
        return;
      }
      case 'update': {
        const f = msg.fields ?? {};
        const projectId = f.scope === undefined ? undefined : f.scope === 'user' ? null : (await svc.projectOf(x.activeSessionId())) ?? null;
        await svc.library.update(ids[0], { name: f.name, description: f.description, items: f.items, localOnly: f.localOnly, ...(projectId !== undefined ? { projectId } : {}) });
        done('update', 'Saved', ids[0]);
        return;
      }
      case 'trash': {
        const n = await svc.library.trash(ids);
        done('trash', `Moved ${n === 1 ? 'the context set' : `${n} context sets`} to Trash`);
        return;
      }
      case 'restore': {
        const n = await svc.library.restore(ids);
        done('restore', `Restored ${n === 1 ? 'the context set' : `${n} context sets`}`);
        return;
      }
      case 'purge': {
        const n = await svc.library.purge(ids);
        done('purge', `Deleted ${n === 1 ? 'the context set' : `${n} context sets`} permanently`);
        return;
      }
      case 'attach': {
        const set = ids[0] ? await svc.library.get(ids[0]) : undefined;
        if (!set) {
          return;
        }
        x.compose(`#context:${slugName(set.name)} `);
        done('attach', `#context:${slugName(set.name)} is in the message box: it is read when you send`);
        return;
      }
      case 'inspect': {
        const sid = msg.sessionId ?? x.activeSessionId();
        if (!sid) {
          return;
        }
        const snap = msg.messageId ? await svc.snapshots.forMessage(msg.messageId, sid, msg.at) : await svc.snapshots.latest(sid);
        if (!snap) {
          x.toast('Nothing recorded for that answer yet: what the model sees is recorded from LocalPilot 1.7 on', 'info');
          return;
        }
        x.openPage({ view: 'chat', sessionId: sid, snapshotId: snap.id });
        return;
      }
      case 'related': {
        const text = String(msg.text ?? '');
        if (!getConfig().continuity.relatedConversations || text.trim().length < 12) {
          x.post({ type: 'related', sessionId: msg.sessionId, query: text, items: [] } satisfies ContextToWebview);
          return;
        }
        const projectId = await svc.projectOf(msg.sessionId);
        const items = await svc.related.suggest(projectId, text, msg.sessionId);
        x.post({ type: 'related', sessionId: msg.sessionId, query: text, items: items.map((i) => ({ id: i.id, title: i.title, snippet: i.snippet, mention: `#chat:${i.id}` })) } satisfies ContextToWebview);
        return;
      }
      case 'addRelated': {
        if (!msg.id) {
          return;
        }
        x.compose(`#chat:${msg.id} `);
        return;
      }
      case 'suggest': {
        const q = String(msg.query ?? '').toLowerCase();
        const projectId = await svc.projectOf(x.activeSessionId());
        if (msg.kind === 'context') {
          const sets = await svc.library.list({ projectId });
          const items = sets.filter((s) => !q || slugName(s.name).includes(q) || s.name.toLowerCase().includes(q)).slice(0, 12).map((s) => ({ name: slugName(s.name), desc: `${s.items.length} item${s.items.length === 1 ? '' : 's'}${s.description ? ` · ${s.description}` : ''}${s.localOnly ? ' · local only' : ''}` }));
          x.post({ type: 'contextSuggest', kind: 'context', query: String(msg.query ?? ''), items } satisfies ContextToWebview);
        } else {
          const page = await c.index.history({ view: 'all', projectId: projectId ?? 'all', query: q.replace(/-/g, ' ').split(/\s+/)[0] || undefined, limit: 40 });
          const items = page.rows
            .filter((r) => r.id !== x.activeSessionId() && (!q || chatSlug(r.title).includes(q) || r.id.toLowerCase().startsWith(q)))
            .slice(0, 12)
            .map((r) => ({ name: chatSlug(r.title) || r.id, desc: `${r.title} · ${new Date(r.updatedAt).toLocaleDateString()}` }));
          x.post({ type: 'contextSuggest', kind: 'chat', query: String(msg.query ?? ''), items } satisfies ContextToWebview);
        }
        return;
      }
    }
  } catch (e) {
    x.post({ type: 'contextDone', action: msg.action, error: e instanceof Error ? e.message : String(e) } satisfies ContextToWebview);
    x.toast(e instanceof Error ? e.message : String(e), 'error');
  }
}

/**
 * A chat became active: restore its context from the latest snapshot when it has no live state (once per process),
 * tell the webview what came back and which files changed since, and show the snapshot's items in the ring's card.
 */
export async function onChatOpened(svc: ContextService, s: Session, o: { root?: string; running: boolean; sink: ContextSink; save: (s: Session) => void; redraw: (s: Session) => void }): Promise<void> {
  if (!o.running) {
    const r = await svc.restore(s, o.root).catch(() => undefined);
    if (r) {
      if (r.workingSet || r.todos || r.attachments || r.breakdown) {
        o.save(s);
        o.redraw(s);
      }
      o.sink.post({ type: 'contextRestored', sessionId: s.id, workingSet: r.workingSet, todos: r.todos, attachments: r.attachments, changed: r.changed });
    }
  }
  const latest = await svc.snapshots.latest(s.id).catch(() => undefined);
  if (latest) {
    o.sink.post(itemsMsg(s.id, latest));
  }
}

/**
 * The model of a chat changed (picker): when its context is bigger than the new model's window allows, say that it
 * is compacted before the next request (the agent loop budgets every request against the model that answers it).
 */
export function modelSwitchNotice(s: Session, to: ModelInfo | undefined): string | undefined {
  if (!to || !s.contextTokens) {
    return undefined;
  }
  const cfg = getConfig();
  const win = effectiveContextWindow(to, cfg.contextWindow);
  const limit = Math.floor(win * cfg.compactionThreshold);
  if (s.contextTokens <= limit) {
    return undefined;
  }
  const k = (n: number) => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));
  return cfg.compactionStrategy === 'off'
    ? `This chat holds about ${k(s.contextTokens)} tokens; ${to.name} takes ${k(win)}. Compaction is off (Settings → Context), so the next request may be refused: compact the chat first.`
    : `This chat holds about ${k(s.contextTokens)} tokens; ${to.name} takes ${k(win)}. Older messages are summarised before the next request (the full transcript stays searchable).`;
}
