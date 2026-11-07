// Continuity CONTEXT inside the VS Code test host: a real SessionStore with the bridge, continuity on a temp data root
// (in-process index, wasm from dist/), the context module attached (library, snapshots, related, policy), and the
// ContinuityHost answering the chat webview's context messages: the Context library page (create, edit, attach,
// trash / restore), `#context:` / `#chat:` suggestions, related conversations, "What did the model see?", context
// restoration of a reopened chat with "changed since", the model-switch window notice. No network; paths via path.join.
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import type { AgentRunner } from '../agent/agentLoop';
import { Continuity } from '../continuity/continuity';
import { memorySecretBox } from '../continuity/data/crypto/secretBox';
import { WorkspaceContext } from '../context/workspaceContext';
import { SessionStore } from '../sessions/sessionStore';
import { ToolRegistry } from '../tools/registry';
import type { ChatMessage, ModelInfo, Session } from '../types';
import type { ChatController, ToWebview } from '../ui/chatController';
import { attachContext } from '../ui/contextHost';
import { ContinuityHost } from '../ui/continuityHost';
import type { ContinuityHandle } from '../ui/continuityData';

const quiet = { info: () => undefined, warn: () => undefined, error: () => undefined };
const log = { ...quiet, debug: () => undefined, trace: () => undefined, show: () => undefined } as unknown as vscode.LogOutputChannel;
const tmp = (p: string) => fs.mkdtempSync(path.join(os.tmpdir(), `lp-cctx-${p}-`));
const say = (role: ChatMessage['role'], content: string): ChatMessage => ({ role, content, meta: { timestamp: Date.now() } });

function wasm(): string | undefined {
  const ext = vscode.extensions.getExtension('localpilot.localpilot-agent');
  const p = ext ? path.join(ext.extensionPath, 'dist', 'sqljs', 'sql-wasm.wasm') : '';
  return fs.existsSync(p) ? p : process.env.LOCALPILOT_SQLJS_WASM;
}

suite('Continuity context: library, snapshots, related, restoration', () => {
  test('Context library page, #context: / #chat:, related chats, inspect, restoration and the model-switch notice through the host', async function () {
    this.timeout(90_000);
    if (!wasm()) {
      this.skip();
    }
    const folder = tmp('ws');
    fs.mkdirSync(path.join(folder, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(folder, 'docs', 'release.md'), '# Release\n1. bump\n2. tag\n');
    const c = await Continuity.open({ dataDir: tmp('root'), writer: 'vscode', appVersion: 'test', secrets: memorySecretBox(), log: quiet, settings: () => ({ dataDir: '', trashRetentionDays: 30, historyDays: 90, indexMaxMB: 256, backup: { enabled: false, intervalDays: 7, keep: 4 } }), wasmPath: wasm() ?? '', workerPath: '', inProcessIndex: true, schedules: false, autoMigrate: false, flushMs: 5 });
    await c.ready;
    assert.strictEqual(c.degraded, undefined);
    const store = new SessionStore({ storageUri: vscode.Uri.file(tmp('store')) } as vscode.ExtensionContext, log);
    await store.load();
    c.attachSessionStore(store, { defaultFolder: () => folder });
    const workspace = new WorkspaceContext(log);
    const tools = new ToolRegistry();
    const runner = {} as AgentRunner;
    const posted: ToWebview[] = [];
    const composed: string[] = [];
    const active = new vscode.EventEmitter<Session | undefined>();
    const model = new vscode.EventEmitter<{ session: Session; from: string; to: string }>();
    let current: Session | undefined;
    const controller = {
      publish: (m: ToWebview) => posted.push(m),
      redraw: (s: Session) => posted.push({ type: 'session', session: s }),
      addToComposer: (t: string) => composed.push(t),
      isRunning: () => false,
      hasSurface: () => true,
      onDidChangeActive: active.event,
      onDidChangeModel: model.event,
      workspace: { root: folder },
      providers: { cachedModels: () => [{ id: 'cld/small', name: 'Small', contextWindow: 8192 } as ModelInfo] },
      get activeSession() {
        return current;
      },
    } as unknown as ChatController;
    const handle: ContinuityHandle = { opened: Promise.resolve(c), current: c };
    const host = new ContinuityHost(controller, store, handle, log);
    const ctx = attachContext(c, { runner, workspace, tools, sink: { post: (m) => posted.push(m as ToWebview) }, defaultFolder: () => folder, log });
    const settle = async (...ss: Session[]) => {
      for (const s of ss) {
        await store.flush(s);
      }
      await c.bridge!.settle();
      await c.log.flush();
      await c.index.catchUp();
    };
    const ask = async <T extends ToWebview['type']>(msg: Parameters<ContinuityHost['handle']>[0], type: T): Promise<Extract<ToWebview, { type: T }>> => {
      const from = posted.length;
      await host.handle(msg);
      const hit = posted.slice(from).find((m) => m.type === type);
      assert.ok(hit, `no ${type} after ${msg.type}: ${JSON.stringify(posted.slice(from)).slice(0, 400)}`);
      return hit as Extract<ToWebview, { type: T }>;
    };
    try {
      // Context library: create, page data, suggestions, attach, edit, trash / restore.
      const created = await ask({ type: 'contextAction', action: 'create', fields: { name: 'Release docs', description: 'how we ship', items: [{ kind: 'file', ref: path.join('docs', 'release.md') }, { kind: 'snippet', ref: 'note', text: 'tag after the smoke tests' }] } }, 'contextDone');
      assert.ok(created.id && /#context:release-docs/.test(created.note ?? ''), JSON.stringify(created));
      let page = await ask({ type: 'continuityPage', page: 'context' }, 'continuityPage');
      let data = page.data as { sets: { id: string; name: string; items: unknown[] }[]; view: string };
      assert.strictEqual(data.view, 'library');
      assert.deepStrictEqual(data.sets.map((x) => x.name), ['Release docs']);
      const sug = await ask({ type: 'contextAction', action: 'suggest', kind: 'context', query: 'rel' }, 'contextSuggest');
      assert.deepStrictEqual(sug.items.map((x) => x.name), ['release-docs']);
      await host.handle({ type: 'contextAction', action: 'attach', id: created.id });
      assert.deepStrictEqual(composed, ['#context:release-docs ']);
      const block = await workspace.readAttachment('#context:release-docs');
      assert.ok(block.includes('2. tag') && block.includes('tag after the smoke tests'), block);
      await ask({ type: 'contextAction', action: 'update', id: created.id, fields: { localOnly: true } }, 'contextDone');
      assert.ok((await workspace.readAttachment('#context:release-docs')).includes('local-only="true"'));
      await ask({ type: 'contextAction', action: 'trash', id: created.id }, 'contextDone');
      const tp = await ask({ type: 'continuityPage', page: 'trash' }, 'continuityPage');
      assert.ok(((tp.data as { contextSets: { id: string }[] }).contextSets ?? []).some((x) => x.id === created.id), 'the set is in Trash');
      await ask({ type: 'contextAction', action: 'restore', id: created.id }, 'contextDone');
      page = await ask({ type: 'continuityPage', page: 'context' }, 'continuityPage');
      assert.strictEqual((page.data as { sets: unknown[] }).sets.length, 1);

      // Earlier conversations: related suggestions and #chat: suggestions for a new chat.
      const old = store.create('m', 'agent');
      old.title = 'Postgres refuses connections';
      old.messages.push(say('user', 'The API fails with ECONNREFUSED after docker compose up'), say('assistant', 'The postgres container exited; docker compose up -d postgres.'));
      store.save(old);
      const other = store.create('m', 'agent');
      other.title = 'Button colours';
      other.messages.push(say('user', 'Make the primary button amber'), say('assistant', 'Done: --primary is amber.'));
      store.save(other);
      await settle(old, other);
      const fresh = store.create('m', 'agent');
      current = fresh;
      const rel = await ask({ type: 'contextAction', action: 'related', sessionId: fresh.id, text: 'ECONNREFUSED again when docker starts postgres' }, 'related');
      assert.strictEqual(rel.items[0]?.id, old.id, JSON.stringify(rel));
      assert.ok(!rel.items.some((x) => x.id === other.id));
      composed.length = 0;
      await host.handle({ type: 'contextAction', action: 'addRelated', sessionId: fresh.id, id: old.id });
      assert.deepStrictEqual(composed, [`#chat:${old.id} `]);
      const chats = await ask({ type: 'contextAction', action: 'suggest', kind: 'chat', query: 'postgres' }, 'contextSuggest');
      assert.ok(chats.items.some((x) => x.name === 'postgres-refuses-connections'), JSON.stringify(chats));

      // "What did the model see?": nothing yet, then a recorded snapshot opens the page on it.
      let from = posted.length;
      await host.handle({ type: 'contextAction', action: 'inspect', sessionId: old.id, messageId: old.messages[1].meta!.id });
      assert.ok(posted.slice(from).some((m) => m.type === 'toast'), 'nothing recorded yet');
      const snap = c.context!.record({ conversationId: old.id, messageId: old.messages[1].meta!.id, model: 'loc/m', provider: 'loc', remote: false, window: 8192, usedTokens: 900, phase: 'turn', messages: old.messages, workingSet: [path.join('docs', 'release.md')], todos: [{ id: '1', title: 'Restart postgres', status: 'pending' }], root: folder });
      await c.log.flush();
      await c.index.catchUp();
      const open = await ask({ type: 'contextAction', action: 'inspect', sessionId: old.id, messageId: old.messages[1].meta!.id }, 'openContinuityPage');
      assert.deepStrictEqual(open.params, { view: 'chat', sessionId: old.id, snapshotId: snap.id });
      page = await ask({ type: 'continuityPage', page: 'context', params: open.params }, 'continuityPage');
      assert.strictEqual((page.data as { view: string; snapshot: { id: string } }).snapshot.id, snap.id);
      assert.strictEqual((page.data as { view: string }).view, 'chat');

      // Restoration: the chat reopens without its working set and todos; a file changed since is marked.
      old.workingSet = [];
      old.todos = undefined;
      fs.writeFileSync(path.join(folder, 'docs', 'release.md'), '# Release\n1. bump\n2. tag\n3. announce\n');
      from = posted.length;
      current = old;
      active.fire(old);
      for (let i = 0; i < 50 && !posted.slice(from).some((m) => m.type === 'contextRestored'); i++) {
        await new Promise((r) => setTimeout(r, 100));
      }
      const restored = posted.slice(from).find((m) => m.type === 'contextRestored') as Extract<ToWebview, { type: 'contextRestored' }> | undefined;
      assert.ok(restored && restored.workingSet === 1 && restored.todos === 1, JSON.stringify(posted.slice(from)).slice(0, 600));
      assert.ok(restored.changed.some((x) => x.state === 'changed'), JSON.stringify(restored.changed));
      assert.strictEqual((old.todos as Session['todos'])?.[0]?.title, 'Restart postgres');
      assert.ok(posted.slice(from).some((m) => m.type === 'contextItems' && m.sessionId === old.id), 'the ring card gets the items');

      // Model switch: a context bigger than the new model's window is announced.
      from = posted.length;
      old.contextTokens = 30_000;
      model.fire({ session: old, from: 'loc/m', to: 'cld/small' });
      const note = posted.slice(from).find((m) => m.type === 'contextNotice') as Extract<ToWebview, { type: 'contextNotice' }> | undefined;
      assert.ok(note && note.kind === 'window' && /Small/.test(note.text), JSON.stringify(note));
    } finally {
      ctx.dispose();
      host.dispose();
      store.dispose();
      await c.dispose();
    }
  });

  test('the command opens the Context library page in the chat', async function () {
    this.timeout(60_000);
    await vscode.extensions.getExtension('localpilot.localpilot-agent')?.activate();
    const cmds = await vscode.commands.getCommands(true);
    assert.ok(cmds.includes('localpilot.continuity.openContextLibrary'));
  });
});
