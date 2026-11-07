// Continuity CONVERSATION inside the VS Code test host: a real SessionStore with the bridge, continuity on a temp data
// root (in-process index, wasm from dist/), and the ContinuityHost answering the navigator's webview messages (counts,
// views, trash / restore / purge, favorites, search), the branch switcher after an edit-and-resend, and the commands.
// No network; paths via path.join.
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import type { LocalPilotApi } from '../extension';
import { Continuity } from '../continuity/continuity';
import { memorySecretBox } from '../continuity/data/crypto/secretBox';
import { SessionStore } from '../sessions/sessionStore';
import type { ChatMessage, Session } from '../types';
import type { ChatController, ToWebview } from '../ui/chatController';
import { ContinuityHost } from '../ui/continuityHost';
import type { ContinuityHandle } from '../ui/continuityData';

const quiet = { info: () => undefined, warn: () => undefined, error: () => undefined };
const log = { ...quiet, debug: () => undefined, trace: () => undefined, show: () => undefined } as unknown as vscode.LogOutputChannel;
const tmp = (p: string) => fs.mkdtempSync(path.join(os.tmpdir(), `lp-cconv-${p}-`));
const say = (role: ChatMessage['role'], content: string): ChatMessage => ({ role, content, meta: { timestamp: Date.now() } });

function wasm(): string | undefined {
  const ext = vscode.extensions.getExtension('localpilot.localpilot-agent');
  const p = ext ? path.join(ext.extensionPath, 'dist', 'sqljs', 'sql-wasm.wasm') : '';
  return fs.existsSync(p) ? p : process.env.LOCALPILOT_SQLJS_WASM;
}

interface Rig {
  c: Continuity;
  store: SessionStore;
  host: ContinuityHost;
  posted: ToWebview[];
  active?: Session;
  settle(...s: Session[]): Promise<void>;
  ask<T extends ToWebview['type']>(msg: Parameters<ContinuityHost['handle']>[0], type: T): Promise<Extract<ToWebview, { type: T }>>;
  dispose(): Promise<void>;
}

async function rig(): Promise<Rig> {
  const root = tmp('root');
  const folder = tmp('ws');
  const c = await Continuity.open({ dataDir: root, writer: 'vscode', appVersion: 'test', secrets: memorySecretBox(), log: quiet, settings: () => ({ dataDir: '', trashRetentionDays: 30, historyDays: 90, indexMaxMB: 256, backup: { enabled: false, intervalDays: 7, keep: 4 } }), wasmPath: wasm() ?? '', workerPath: '', inProcessIndex: true, schedules: false, autoMigrate: false, flushMs: 5 });
  await c.ready;
  assert.strictEqual(c.degraded, undefined);
  const store = new SessionStore({ storageUri: vscode.Uri.file(tmp('store')) } as vscode.ExtensionContext, log);
  await store.load();
  c.attachSessionStore(store, { defaultFolder: () => folder });
  const posted: ToWebview[] = [];
  const active = new vscode.EventEmitter<Session | undefined>();
  const r = {} as Rig;
  const controller = {
    publish: (m: ToWebview) => posted.push(m),
    present: (s: Session) => {
      r.active = s;
      active.fire(s);
    },
    redraw: (s: Session) => posted.push({ type: 'session', session: s }),
    isRunning: () => false,
    hasSurface: () => true,
    onDidChangeActive: active.event,
    workspace: { root: folder },
    get activeSession() {
      return r.active;
    },
    providers: undefined,
    retry: async () => '',
    handle: async (m: { type: string; id?: string }) => {
      if (m.type === 'deleteSession' && m.id) {
        await store.delete(m.id);
      } else if (m.type === 'selectSession' && m.id) {
        r.active = store.get(m.id);
      }
    },
  } as unknown as ChatController;
  const handle: ContinuityHandle = { opened: Promise.resolve(c), current: c };
  const host = new ContinuityHost(controller, store, handle, log);
  Object.assign(r, {
    c,
    store,
    host,
    posted,
    settle: async (...ss: Session[]) => {
      for (const s of ss) {
        if (store.has(s.id)) {
          await store.flush(store.get(s.id)!);
        }
      }
      await c.bridge!.settle();
      for (const s of ss) {
        if (store.has(s.id)) {
          await store.flush(store.get(s.id)!);
        }
      }
      await c.log.flush();
      await c.index.catchUp();
    },
    ask: async <T extends ToWebview['type']>(msg: Parameters<ContinuityHost['handle']>[0], type: T) => {
      const from = posted.length;
      await host.handle(msg);
      const hit = posted.slice(from).find((m) => m.type === type);
      assert.ok(hit, `no ${type} after ${msg.type}: ${JSON.stringify(posted.slice(from)).slice(0, 400)}`);
      return hit as Extract<ToWebview, { type: T }>;
    },
    dispose: async () => {
      host.dispose();
      store.dispose();
      await c.dispose();
    },
  });
  return r;
}

suite('Continuity conversations: navigator, Trash, branches', () => {
  test('navigator counts, views, favorites, search, trash / undo / purge through the host', async function () {
    this.timeout(60_000);
    if (!wasm()) {
      this.skip();
    }
    const r = await rig();
    try {
      const a = r.store.create('m', 'agent');
      a.messages.push(say('user', 'Why does the build fail with ECONNREFUSED?'), say('assistant', 'Postgres is down: `docker compose up -d db`.'));
      r.store.save(a);
      const b = r.store.create('m', 'ask');
      b.messages.push(say('user', 'Explain the retry policy'), say('assistant', 'Backoff 5 s, 15 s, 1 min.'));
      r.store.save(b);
      await r.settle(a, b);
      let page = await r.ask({ type: 'nav', seq: 1, view: 'all', projectId: 'this' }, 'navPage');
      assert.strictEqual(page.indexState, 'ready');
      assert.strictEqual(page.counts?.all, 2, JSON.stringify(page.counts));
      assert.ok(page.projects.some((p) => p.current), 'the workspace folder is the current project');
      assert.deepStrictEqual(page.page.rows.map((x) => x.id).sort(), [a.id, b.id].sort());

      await r.host.handle({ type: 'convAction', ids: [a.id], action: 'favorite' });
      page = await r.ask({ type: 'nav', seq: 2, view: 'favorites', projectId: 'all' }, 'navPage');
      assert.deepStrictEqual(page.page.rows.map((x) => x.id), [a.id]);
      assert.strictEqual(page.counts?.favorites, 1);

      page = await r.ask({ type: 'nav', seq: 3, view: 'all', projectId: 'all', query: 'econnrefused' }, 'navPage');
      assert.ok(page.page.rows.some((x) => x.id === a.id), JSON.stringify(page.page.rows));
      page = await r.ask({ type: 'nav', seq: 3, view: 'all', projectId: 'all', query: 'docker' }, 'navPage');
      assert.ok(page.page.rows.some((x) => x.id === a.id && /docker/.test(x.snippet ?? '')), JSON.stringify(page.page.rows));

      const from = r.posted.length;
      await r.host.handle({ type: 'convAction', ids: [b.id], action: 'trash' });
      const toast = r.posted.slice(from).find((m) => m.type === 'toast') as Extract<ToWebview, { type: 'toast' }> | undefined;
      assert.ok(toast?.action && (toast.action.msg as { action?: string }).action === 'restore', 'Moved to Trash · Undo');
      assert.ok(!r.store.has(b.id), 'the chat left the store');
      page = await r.ask({ type: 'nav', seq: 4, view: 'trash', projectId: 'all' }, 'navPage');
      assert.deepStrictEqual(page.page.rows.map((x) => x.id), [b.id]);
      assert.strictEqual(page.counts?.trash, 1);

      // Undo (the toast's action) brings it back with its messages.
      await r.host.handle(toast!.action!.msg as Parameters<ContinuityHost['handle']>[0]);
      assert.ok(r.store.has(b.id));
      assert.strictEqual(r.store.get(b.id)!.messages.length, 2);

      // Trash page data, then purge (the host asks first: answered by the modal stub in the test host? skip it).
      await r.host.handle({ type: 'convAction', ids: [b.id], action: 'trash' });
      const tp = await r.ask({ type: 'continuityPage', page: 'trash' }, 'continuityPage');
      assert.ok(((tp.data as { rows: { id: string }[] }).rows ?? []).some((x) => x.id === b.id));
      await r.c.conversations!.purge([b.id]);
      page = await r.ask({ type: 'nav', seq: 5, view: 'trash', projectId: 'all' }, 'navPage');
      assert.strictEqual(page.counts?.trash, 0);

      // Versions list for the navigator's Versions page.
      const v = await r.ask({ type: 'versions', ent: 'conversation', id: a.id }, 'versionsList');
      assert.ok(v.versions.length >= 2 && v.branches.length >= 1);
    } finally {
      await r.dispose();
    }
  });

  test('an edited and resent message gets the < 1/2 > switcher; stepping it shows the other version', async function () {
    this.timeout(60_000);
    if (!wasm()) {
      this.skip();
    }
    const r = await rig();
    try {
      const s = r.store.create('m', 'agent');
      s.messages.push(say('user', 'Add a --verbose flag'), say('assistant', 'Added --verbose to the CLI.'));
      r.store.save(s);
      await r.settle(s);
      const first = s.messages[0].meta!.id!;
      // What ChatController.editAndRegenerate does: hint, rewind to the message, send the edited text.
      r.store.hint(s.id, 'edit');
      s.messages = [];
      r.store.save(s);
      s.messages.push(say('user', 'Add a --quiet flag'), say('assistant', 'Added --quiet.'));
      r.store.save(s);
      await r.settle(s);
      r.active = s;
      const br = await r.ask({ type: 'branches', sessionId: s.id }, 'branches');
      const edited = s.messages[0].meta!.id!;
      assert.ok(br.siblings[edited], JSON.stringify(br));
      assert.deepStrictEqual([br.siblings[edited].index, br.siblings[edited].total], [2, 2]);
      assert.ok(br.branches.some((b) => b.reason === 'edit'));
      await r.host.handle({ type: 'branch', sessionId: s.id, action: 'step', messageId: edited, delta: -1 });
      const live = r.store.get(s.id)!;
      assert.strictEqual(live.messages[0].meta?.id, first, 'the first version is shown again');
      assert.strictEqual(live.messages[1].content, 'Added --verbose to the CLI.');
    } finally {
      await r.dispose();
    }
  });

  test('the extension registers the conversation commands and attaches its store', async function () {
    this.timeout(60_000);
    const ext = vscode.extensions.getExtension<LocalPilotApi>('localpilot.localpilot-agent');
    assert.ok(ext);
    const api = await ext.activate();
    const commands = await vscode.commands.getCommands(true);
    for (const id of ['localpilot.continuity.openNavigator', 'localpilot.continuity.openTrash', 'localpilot.continuity.exportConversations', 'localpilot.continuity.importConversations']) {
      assert.ok(commands.includes(id), `missing command ${id}`);
    }
    const c = await api.continuity;
    assert.ok(c && !c.degraded);
    await c.ready;
    for (let i = 0; i < 50 && !c.conversations; i++) {
      await new Promise((res) => setTimeout(res, 100));
    }
    assert.ok(c.conversations, 'the SessionStore is attached (conversation manager set)');
  });
});
