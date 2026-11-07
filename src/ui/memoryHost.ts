// The VS Code side of continuity's memory (MEMORY, design §7, §16.2): attaches the MemoryStore to continuity (events,
// FileSystemWatcher, write-back), the agent loop's conversation / task memory hooks, healing fixes as agent lessons,
// `#memory:<name>` mentions; the Memory manager page's data and its `memoryAction` messages; the "Remember in this
// chat" / "Save to knowledge" message actions; the command `localpilot.continuity.openMemoryManager`.
import * as vscode from 'vscode';
import { createMemoryHooks } from '../agent/autoMemory';
import type { AgentRunner } from '../agent/agentLoop';
import { failureMemoryListeners } from '../agent/healing/failureMemory';
import type { MemoryStore } from '../agent/memory';
import { getConfig } from '../config';
import type { Continuity } from '../continuity/continuity';
import type { WatchFactory } from '../continuity/memory/memoryBridge';
import type { MemoryManager } from '../continuity/memory/memoryManager';
import { MEMORY_TYPES, normalizeType, TYPE_INFO } from '../continuity/memory/memoryTypes';
import type { WorkspaceContext } from '../context/workspaceContext';
import type { SessionStore } from '../sessions/sessionStore';
import type { Sink } from './chatController';

/** A FileSystemWatcher on a memory folder (also outside the workspace: global storage). */
export const vscodeWatch: WatchFactory = (dir, onChange) => {
  const w = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(dir), '*.md'));
  const subs = [w.onDidChange(onChange), w.onDidCreate(onChange), w.onDidDelete(onChange)];
  return { dispose: () => [...subs, w].forEach((d) => d.dispose()) };
};

/**
 * Connects memory to continuity once it is open: the store's notes become events, the tools and the prompt reach the
 * 1.7 types, conversation summaries and task checklists are kept, healing fixes become agent lessons.
 */
export function attachMemory(c: Continuity, o: { memory: MemoryStore; runner: AgentRunner; workspace: WorkspaceContext; log: { warn(m: string): void; debug(m: string): void }; watch?: WatchFactory | false; projectFolders: () => string[]; onFoldersChanged?: (cb: () => void) => { dispose(): unknown } }): { dispose(): void } {
  const d = c.attachMemoryStore(o.memory, {
    projectFolders: o.projectFolders,
    watch: o.watch ?? vscodeWatch,
    taskExpiryDays: () => getConfig().memoryTaskExpiryDays,
    warn: (m) => o.log.warn(m),
  });
  const mgr = c.memory;
  if (!mgr) {
    return { dispose: () => void d.dispose() };
  }
  o.runner.memoryHooks = createMemoryHooks(mgr, { log: (m) => o.log.debug(m) });
  const onFix = (e: { success: boolean; category: string; signature: string; messageNorm: string; strategy: string; ecosystem: string; successes: number; failures: number }) => {
    if (e.success) {
      void mgr.recordFix({ category: e.category, signature: e.signature, message: e.messageNorm, strategy: e.strategy, ecosystem: e.ecosystem, successes: e.successes, failures: e.failures }).catch((err) => o.log.debug(`memory: fix lesson skipped: ${String(err)}`));
    }
  };
  failureMemoryListeners.add(onFix);
  o.workspace.mentionResolvers.set('memory', (name) => o.memory.mention(name));
  const folders = o.onFoldersChanged?.(() => void d.refreshFolders().catch(() => undefined));
  return {
    dispose: () => {
      folders?.dispose();
      failureMemoryListeners.delete(onFix);
      o.workspace.mentionResolvers.delete('memory');
      if (o.runner.memoryHooks) {
        o.runner.memoryHooks = undefined;
      }
      d.dispose();
    },
  };
}

export type MemoryActionName = 'create' | 'update' | 'move' | 'trash' | 'restore' | 'purge' | 'open' | 'localOnly' | 'pin' | 'versions' | 'restoreVersion' | 'remember' | 'saveKnowledge' | 'suggest' | 'openFolder';

export type MemoryFromWebview = {
  type: 'memoryAction';
  action: MemoryActionName;
  id?: string;
  ids?: string[];
  /** create / update: type, name, body; move: `to`. */
  fields?: { type?: string; name?: string; body?: string; localOnly?: boolean; pinned?: boolean };
  to?: string;
  on?: boolean;
  hlc?: string;
  sessionId?: string;
  messageId?: string;
  query?: string;
};

export type MemoryToWebview =
  | { type: 'memoryVersions'; id: string; name: string; itemType: string; versions: { hlc: string; at: number; device: string; op: string; body?: string; changes: string[] }[] }
  | { type: 'memorySuggest'; query: string; items: { name: string; type: string; summary?: string }[] }
  /** An action finished: the page shows `note` and reloads. */
  | { type: 'memoryDone'; action: string; id?: string; note?: string; error?: string };

interface Ctx {
  c: () => Continuity | undefined;
  memory: MemoryStore;
  store: SessionStore;
  post: (m: unknown, reply?: Sink) => void;
  toast: (text: string, level?: 'info' | 'warn' | 'error') => void;
  activeSessionId: () => string | undefined;
}

/** Page data of the Memory manager: every type of this project and the user's, with counts and chat titles. */
export async function memoryPageData(c: Continuity, store: SessionStore, params: Record<string, unknown>): Promise<unknown> {
  const mgr = c.memory;
  if (!mgr) {
    return { off: 'starting' };
  }
  const all = params.all === true;
  const items = await mgr.list({ projectId: all ? 'all' : undefined, limit: 1000 });
  const titles: Record<string, string> = {};
  for (const id of new Set(items.map((i) => i.conversationId).filter((x): x is string => !!x))) {
    titles[id] = (store.has(id) ? store.get(id)?.title : undefined) ?? (await c.conversations?.conversation(id).catch(() => undefined))?.title ?? '';
  }
  const counts = Object.fromEntries(MEMORY_TYPES.map((t) => [t, items.filter((i) => i.type === t).length]));
  const types = MEMORY_TYPES.map((t) => ({ id: t, label: TYPE_INFO[t].label, description: TYPE_INFO[t].description, fileBacked: TYPE_INFO[t].fileBacked }));
  return { items, counts, types, titles, all, taskExpiryDays: getConfig().memoryTaskExpiryDays, enabled: getConfig().memoryEnabled };
}

function messageText(store: SessionStore, sessionId: string | undefined, messageId: string | undefined): string | undefined {
  if (!sessionId || !messageId || !store.has(sessionId)) {
    return undefined;
  }
  const m = store.get(sessionId)?.messages.find((x) => x.meta?.id === messageId);
  const text = m ? (typeof m.content === 'string' ? m.content : '') : undefined;
  return text?.replace(/<attachment[\s\S]*?<\/attachment>\s*/g, '').replace(/<memory_note[\s\S]*?<\/memory_note>\s*/g, '').trim();
}

/** Handles a `memoryAction` from the chat webview. */
export async function memoryAction(msg: MemoryFromWebview, x: Ctx, reply?: Sink): Promise<void> {
  const c = x.c();
  const mgr: MemoryManager | undefined = c?.memory;
  if (!c || !mgr) {
    x.toast(c?.degraded ? `Memory storage is off: ${c.degraded}` : 'Memory storage is still starting — try again in a moment.', 'warn');
    return;
  }
  const done = (action: string, note?: string, id?: string) => x.post({ type: 'memoryDone', action, ...(id ? { id } : {}), ...(note ? { note } : {}) } satisfies MemoryToWebview, reply);
  const ids = msg.ids ?? (msg.id ? [msg.id] : []);
  try {
    switch (msg.action) {
      case 'create': {
        const f = msg.fields ?? {};
        const type = normalizeType(f.type) ?? 'knowledge';
        const sid = x.activeSessionId();
        const id = await mgr.create(type, {
          name: String(f.name ?? ''),
          body: String(f.body ?? ''),
          conversationId: type === 'conversation' || type === 'task' ? sid : undefined,
          taskRef: type === 'task' && sid ? mgr.taskOf(sid) : undefined,
          localOnly: f.localOnly,
          pinned: f.pinned,
          source: 'user',
        });
        done('create', `Saved ${TYPE_INFO[type].label.toLowerCase()} memory "${f.name}"`, id);
        return;
      }
      case 'update': {
        const f = msg.fields ?? {};
        await mgr.update(ids[0], { body: f.body, name: f.name });
        done('update', 'Saved', ids[0]);
        return;
      }
      case 'move': {
        const to = normalizeType(msg.to);
        if (!to) {
          return;
        }
        const sid = x.activeSessionId();
        const nid = await mgr.moveType(ids[0], to, { conversationId: to === 'conversation' ? sid : undefined, taskRef: to === 'task' && sid ? mgr.taskOf(sid) : undefined });
        done('move', `Moved to ${TYPE_INFO[to].label}`, nid);
        return;
      }
      case 'localOnly':
        await mgr.setLocalOnly(ids, msg.on !== false);
        done('localOnly', msg.on !== false ? 'Kept on this machine: never sent to a cloud model' : 'Can be sent to any model again');
        return;
      case 'pin':
        await mgr.pin(ids, msg.on !== false);
        done('pin');
        return;
      case 'trash': {
        const n = await mgr.trash(ids);
        done('trash', `Moved ${n === 1 ? 'the note' : `${n} notes`} to Trash`);
        return;
      }
      case 'restore': {
        const n = await mgr.restore(ids);
        done('restore', `Restored ${n === 1 ? 'the note' : `${n} notes`}`);
        return;
      }
      case 'purge': {
        const n = await mgr.purge(ids);
        done('purge', `Deleted ${n === 1 ? 'the note' : `${n} notes`} permanently`);
        return;
      }
      case 'open': {
        const it = await mgr.get(ids[0]);
        if (it?.path) {
          await vscode.window.showTextDocument(vscode.Uri.file(it.path), { preview: false });
        } else {
          x.toast('This note lives in LocalPilot only: edit it in the Memory manager', 'info');
        }
        return;
      }
      case 'openFolder': {
        const scope = msg.to === 'developer' ? 'global' : 'project';
        const dir = x.memory.folder(scope);
        if (dir) {
          await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(dir));
        }
        return;
      }
      case 'versions': {
        const it = await mgr.get(ids[0]);
        if (!it) {
          return;
        }
        x.post({ type: 'memoryVersions', id: it.id, name: it.name, itemType: it.type, versions: await mgr.versions(it.id) } satisfies MemoryToWebview, reply);
        return;
      }
      case 'restoreVersion':
        await mgr.restoreVersion(ids[0], String(msg.hlc ?? ''));
        done('restoreVersion', 'Restored that version — the newer one stays in the history', ids[0]);
        return;
      case 'remember':
      case 'saveKnowledge': {
        const text = messageText(x.store, msg.sessionId, msg.messageId);
        if (!text) {
          x.toast('That message is not in this window any more', 'warn');
          return;
        }
        const first = text.split('\n').map((l) => l.replace(/^[#>*\-\s]+/, '').trim()).find(Boolean) ?? 'Note';
        const type = msg.action === 'remember' ? 'conversation' : 'knowledge';
        const name = await vscode.window.showInputBox({
          title: msg.action === 'remember' ? 'Remember in this chat' : 'Save to knowledge',
          prompt: msg.action === 'remember' ? 'This chat sees the note in every later turn (other chats do not).' : 'Knowledge is used when asked for: #memory:<name> or the agent\'s memory_search.',
          value: first.slice(0, 60),
          ignoreFocusOut: true,
          validateInput: (v) => (v.trim() ? undefined : 'Give it a name'),
        });
        if (!name) {
          return;
        }
        await mgr.create(type, { name, body: text, conversationId: type === 'conversation' ? msg.sessionId : undefined, source: 'user' });
        x.toast(msg.action === 'remember' ? `Remembered in this chat: "${name.trim()}"` : `Saved to knowledge: "${name.trim()}" — mention it with #memory:${name.trim().replace(/\s+/g, '-')}`);
        return;
      }
      case 'suggest': {
        const q = String(msg.query ?? '').toLowerCase();
        const notes = await x.memory.list().catch(() => []);
        const rows = await mgr.list({ limit: 500 });
        const items = [
          ...notes.map((n) => ({ name: n.name, type: n.scope === 'global' ? 'developer' : 'project', summary: n.summary })),
          ...rows.filter((r) => !TYPE_INFO[r.type as keyof typeof TYPE_INFO]?.fileBacked && r.type !== 'conversation').map((r) => ({ name: r.name.replace(/\s+/g, '-'), type: r.type, summary: r.summary })),
        ].filter((i) => !q || i.name.toLowerCase().includes(q)).slice(0, 12);
        x.post({ type: 'memorySuggest', query: String(msg.query ?? ''), items } satisfies MemoryToWebview, reply);
        return;
      }
    }
  } catch (e) {
    x.post({ type: 'memoryDone', action: msg.action, error: e instanceof Error ? e.message : String(e) } satisfies MemoryToWebview, reply);
    x.toast(e instanceof Error ? e.message : String(e), 'error');
  }
}
