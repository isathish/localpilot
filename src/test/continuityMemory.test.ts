// Continuity MEMORY inside the VS Code test host: a real MemoryStore (notes in the test workspace and a temp global
// folder) attached to continuity on a temp data root, the ContinuityHost answering the Memory manager's webview
// messages (page data, create / trash / restore / move / versions reach the note files), a hand edit picked up by the
// FileSystemWatcher, `#memory:` mentions, and the extension's command and attachment. No network; paths via path.join.
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import type { LocalPilotApi } from '../extension';
import { MemoryStore } from '../agent/memory';
import { Continuity } from '../continuity/continuity';
import { memorySecretBox } from '../continuity/data/crypto/secretBox';
import { SessionStore } from '../sessions/sessionStore';
import type { ChatController, ToWebview } from '../ui/chatController';
import { ContinuityHost } from '../ui/continuityHost';
import type { ContinuityHandle } from '../ui/continuityData';
import { vscodeWatch } from '../ui/memoryHost';

const quiet = { info: () => undefined, warn: () => undefined, error: () => undefined };
const log = { ...quiet, debug: () => undefined, trace: () => undefined, show: () => undefined } as unknown as vscode.LogOutputChannel;
const tmp = (p: string) => fs.mkdtempSync(path.join(os.tmpdir(), `lp-cmem-${p}-`));

function wasm(): string | undefined {
  const ext = vscode.extensions.getExtension('localpilot.localpilot-agent');
  const p = ext ? path.join(ext.extensionPath, 'dist', 'sqljs', 'sql-wasm.wasm') : '';
  return fs.existsSync(p) ? p : process.env.LOCALPILOT_SQLJS_WASM;
}

async function until(cond: () => Promise<boolean> | boolean, ms = 8000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) {
      return true;
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  return cond();
}

suite('Continuity memory: Memory manager, note files, watcher', () => {
  test('Memory manager actions reach the MemoryStore files; hand edits are logged; Trash and versions work', async function () {
    this.timeout(90_000);
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!wasm() || !folder) {
      this.skip();
    }
    const projDir = path.join(folder!, '.localpilot', 'memory');
    const c = await Continuity.open({ dataDir: tmp('root'), writer: 'vscode', appVersion: 'test', secrets: memorySecretBox(), log: quiet, settings: () => ({ dataDir: '', trashRetentionDays: 30, historyDays: 90, indexMaxMB: 256, backup: { enabled: false, intervalDays: 7, keep: 4 } }), wasmPath: wasm() ?? '', workerPath: '', inProcessIndex: true, schedules: false, autoMigrate: false, flushMs: 5 });
    await c.ready;
    const globalDir = tmp('global');
    const memory = new MemoryStore(vscode.Uri.file(globalDir), log);
    const att = c.attachMemoryStore(memory, { projectFolders: () => [folder!], watch: vscodeWatch });
    await att.refreshFolders();
    const store = new SessionStore({ storageUri: vscode.Uri.file(tmp('store')) } as vscode.ExtensionContext, log);
    await store.load();
    c.attachSessionStore(store, { defaultFolder: () => folder });
    const posted: ToWebview[] = [];
    const controller = { publish: (m: ToWebview) => posted.push(m), onDidChangeActive: new vscode.EventEmitter<undefined>().event, workspace: { root: folder }, activeSession: undefined, hasSurface: () => true } as unknown as ChatController;
    const handle: ContinuityHandle = { opened: Promise.resolve(c), current: c };
    const host = new ContinuityHost(controller, store, handle, log);
    host.memory = memory;
    const ask = async <T extends string>(msg: Parameters<ContinuityHost['handle']>[0], type: T) => {
      const from = posted.length;
      await host.handle(msg);
      const hit = posted.slice(from).find((m) => (m as { type: string }).type === type);
      assert.ok(hit, `no ${type} after ${msg.type}: ${JSON.stringify(posted.slice(from)).slice(0, 400)}`);
      return hit as unknown as Record<string, unknown>;
    };
    const name = `lp-test-${Date.now().toString(36)}`;
    try {
      // New project note from the Memory manager -> a file through MemoryStore -> an event.
      const done = await ask({ type: 'memoryAction', action: 'create', fields: { type: 'project', name, body: '- `npm test` runs the suite' } }, 'memoryDone');
      assert.ok(!done.error, String(done.error));
      const file = path.join(projDir, `${name}.md`);
      assert.ok(fs.existsSync(file), 'the note file was written');
      const page = await ask({ type: 'continuityPage', page: 'memory' }, 'continuityPage');
      const items = (page.data as { items: { id: string; name: string; type: string; path?: string }[] }).items;
      const row = items.find((i) => i.name === name);
      assert.ok(row && row.type === 'project' && row.path, JSON.stringify(items).slice(0, 400));

      // A hand edit is picked up by the FileSystemWatcher and logged.
      fs.writeFileSync(file, '- `npm test` runs the suite\n- edited by hand\n');
      assert.ok(await until(async () => (await c.memory!.get(row!.id))?.body.includes('edited by hand') ?? false), 'the hand edit reached the log');

      // Knowledge note (log only), versions, move to developer (file in global storage).
      await ask({ type: 'memoryAction', action: 'create', fields: { type: 'knowledge', name: 'Deploy steps', body: '- kubectl rollout restart' } }, 'memoryDone');
      const k = await c.memory!.get('Deploy steps', { type: 'knowledge' });
      assert.ok(k);
      await ask({ type: 'memoryAction', action: 'update', id: k!.id, fields: { body: '- kubectl rollout restart\n- watch the logs' } }, 'memoryDone');
      const vs = await ask({ type: 'memoryAction', action: 'versions', id: k!.id }, 'memoryVersions');
      assert.ok((vs.versions as unknown[]).length >= 2);
      const moved = await ask({ type: 'memoryAction', action: 'move', id: k!.id, to: 'developer' }, 'memoryDone');
      assert.ok(fs.existsSync(path.join(globalDir, 'memory', 'deploy-steps.md')), JSON.stringify(moved));

      // Trash removes the file; the Trash page lists the note; restore puts it back.
      await ask({ type: 'memoryAction', action: 'trash', id: row!.id }, 'memoryDone');
      assert.ok(!fs.existsSync(file), 'trash deletes the note file');
      const trash = await ask({ type: 'continuityPage', page: 'trash' }, 'continuityPage');
      assert.ok(((trash.data as { memory: { id: string }[] }).memory ?? []).some((m) => m.id === row!.id), 'the Trash page lists the memory note');
      await ask({ type: 'memoryAction', action: 'restore', id: row!.id }, 'memoryDone');
      assert.ok(fs.existsSync(file) && fs.readFileSync(file, 'utf8').includes('edited by hand'), 'restore writes the file back');

      // #memory:<name> resolves through the store.
      const mention = await memory.mention(name);
      assert.ok(mention.includes('edited by hand'), mention);
    } finally {
      fs.rmSync(path.join(projDir, `${name}.md`), { force: true });
      host.dispose();
      store.dispose();
      att.dispose();
      await c.dispose();
    }
  });

  test('the extension registers the Memory manager command and attaches its MemoryStore', async function () {
    this.timeout(60_000);
    const ext = vscode.extensions.getExtension<LocalPilotApi>('localpilot.localpilot-agent');
    assert.ok(ext);
    const api = await ext.activate();
    const commands = await vscode.commands.getCommands(true);
    assert.ok(commands.includes('localpilot.continuity.openMemoryManager'));
    const c = await api.continuity;
    assert.ok(c && !c.degraded);
    await c.ready;
    assert.ok(await until(() => !!c.memory, 8000), 'the MemoryStore is attached (memory manager set)');
    const cfg = vscode.workspace.getConfiguration('localpilot');
    assert.strictEqual(cfg.get('memory.taskExpiryDays'), 14);
  });
});
