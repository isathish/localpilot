// Continuity SYNC inside the VS Code test host: every `localpilot.sync.*` command is registered and contributed, the
// settings exist; two Continuity instances on temp data roots sync through a temp folder backend (set up, join,
// a chat and a concurrent title change travel, the conflict is resolved through the Sync manager's host and the
// resolution reaches the other device); the Sync manager page data and the chat's `syncStatus` come from the engine.
// No network, temp folders only, paths via path.join.
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { Continuity } from '../continuity/continuity';
import { memorySecretBox } from '../continuity/data/crypto/secretBox';
import { mainBranchId } from '../continuity/ids';
import { FolderBackend } from '../continuity/sync/backends/folder';
import { DEFAULT_SYNC_SETTINGS, type SyncSettings } from '../continuity/sync/syncEngine';
import type { ContinuityHandle } from '../ui/continuityData';
import { SyncHost } from '../ui/syncHost';

const quiet = { info: () => undefined, warn: () => undefined, error: () => undefined };
const log = { ...quiet, debug: () => undefined, trace: () => undefined, show: () => undefined } as unknown as vscode.LogOutputChannel;
const tmp = (p: string) => fs.mkdtempSync(path.join(os.tmpdir(), `lp-csync-${p}-`));
const settings = () => ({ dataDir: '', trashRetentionDays: 30, historyDays: 90, indexMaxMB: 256, backup: { enabled: false, intervalDays: 7, keep: 4 } });
const PASS = 'a long test passphrase';

function wasm(): string | undefined {
  const ext = vscode.extensions.getExtension('localpilot.localpilot-agent');
  const p = ext ? path.join(ext.extensionPath, 'dist', 'sqljs', 'sql-wasm.wasm') : '';
  return fs.existsSync(p) ? p : process.env.LOCALPILOT_SQLJS_WASM;
}

async function device(name: string, remote: string): Promise<{ c: Continuity; s: SyncSettings }> {
  const c = await Continuity.open({ dataDir: tmp(name), writer: 'vscode', appVersion: 'test', secrets: memorySecretBox(), log: quiet, settings, wasmPath: wasm() ?? '', workerPath: '', inProcessIndex: true, schedules: false, autoMigrate: false, flushMs: 5 });
  await c.ready;
  const s: SyncSettings = { ...DEFAULT_SYNC_SETTINGS, enabled: true, deviceName: name, folder: { path: remote } };
  c.attachSync({ settings: () => s, backend: new FolderBackend(remote), kdfN: 1024, start: false, promptsDir: tmp(`${name}-cmds`) });
  return { c, s };
}

async function settle(...cs: Continuity[]): Promise<void> {
  for (const c of cs) {
    await c.log.flush();
    await c.index.catchUp();
  }
}

suite('Continuity sync', function () {
  this.timeout(120_000);

  test('every sync command is registered and contributed; the settings exist', async () => {
    const ext = vscode.extensions.getExtension('localpilot.localpilot-agent');
    assert.ok(ext);
    await ext.activate();
    const want = ['localpilot.sync.setup', 'localpilot.sync.now', 'localpilot.sync.openManager', 'localpilot.sync.showConflicts', 'localpilot.sync.changePassphrase', 'localpilot.sync.rotateKey', 'localpilot.sync.turnOff'];
    const all = new Set(await vscode.commands.getCommands(true));
    for (const id of want) {
      assert.ok(all.has(id), `${id} is registered`);
    }
    const pkg = ext.packageJSON as { contributes: { commands: { command: string }[]; configuration: { properties: Record<string, unknown> } | { properties: Record<string, unknown> }[] } };
    const contributed = new Set(pkg.contributes.commands.map((c) => c.command));
    for (const id of want) {
      assert.ok(contributed.has(id), `${id} is in package.json`);
    }
    const conf = Array.isArray(pkg.contributes.configuration) ? Object.assign({}, ...pkg.contributes.configuration.map((x) => x.properties)) : pkg.contributes.configuration.properties;
    for (const k of ['enabled', 'backend', 'folder.path', 'git.url', 'git.branch', 's3.endpoint', 's3.region', 's3.bucket', 's3.prefix', 's3.accessKeyId', 's3.pathStyle', 'webdav.url', 'webdav.username', 'intervalMinutes', 'categories', 'maxAttachmentMB', 'deviceName']) {
      assert.ok(`localpilot.sync.${k}` in conf, `localpilot.sync.${k} is a setting`);
    }
    const cfg = vscode.workspace.getConfiguration('localpilot');
    assert.strictEqual(cfg.get('sync.enabled'), false);
    assert.strictEqual(cfg.get('sync.backend'), 'folder');
    assert.strictEqual((cfg.get('sync.categories') as Record<string, boolean>).checkpointContents, false);
  });

  test('two data roots sync through a folder; a conflict is resolved through the Sync manager host', async () => {
    const remote = tmp('remote');
    const A = await device('Laptop', remote);
    const B = await device('Desktop', remote);
    const published: { type: string }[] = [];
    try {
      await A.c.sync!.create(PASS);
      await B.c.sync!.join(PASS);
      A.c.log.append('conversation', 'conv_vs', 'create', { title: 'Synced from VS Code', model: 'm', mode: 'agent', pinned: false, favorite: false, archived: false, tags: {}, activeBranchId: mainBranchId('conv_vs'), createdAt: Date.now() }, { durable: true });
      await settle(A.c);
      assert.ok(await A.c.sync!.cycle('now'));
      assert.ok(await B.c.sync!.cycle('now'));
      await settle(B.c);
      assert.strictEqual((await B.c.index.conversation('conv_vs'))?.title, 'Synced from VS Code');
      // Concurrent titles.
      const ba = A.c.log.peekHlc();
      const bb = B.c.log.peekHlc();
      A.c.log.append('conversation', 'conv_vs', 'patch', { title: 'Title from the laptop' }, { base: ba, durable: true });
      B.c.log.append('conversation', 'conv_vs', 'patch', { title: 'Title from the desktop' }, { base: bb, durable: true });
      await settle(A.c, B.c);
      await A.c.sync!.cycle('now');
      await B.c.sync!.cycle('now');
      await A.c.sync!.cycle('now');
      await settle(A.c, B.c);
      const conflicts = await B.c.sync!.conflicts.list();
      const cf = conflicts.find((x) => x.kind === 'field' && x.field === 'title');
      assert.ok(cf, 'a title conflict is listed');
      // The Sync manager's host on B: page data, then "Keep the older title" (ours).
      const handle: ContinuityHandle = { opened: Promise.resolve(B.c), current: B.c };
      const fakeContext = { secrets: { get: async () => undefined, store: async () => undefined, delete: async () => undefined, onDidChange: () => ({ dispose() {} }) }, globalState: { get: () => undefined, update: async () => undefined } } as unknown as vscode.ExtensionContext;
      const host = new SyncHost({ context: fakeContext, handle, log, publish: (m) => published.push(m as { type: string }) });
      await new Promise((r) => setTimeout(r, 50));
      const page = (await host.pageData()) as { conflicts: { id: string }[]; devices: { name: string }[]; configured: boolean };
      assert.ok(page.configured);
      assert.ok(page.conflicts.some((x) => x.id === cf.id));
      assert.ok(page.devices.some((d) => d.name === 'Laptop') && page.devices.some((d) => d.name === 'Desktop'), JSON.stringify(page.devices));
      await host.handle({ type: 'resolveConflict', id: cf.id, resolution: 'ours' });
      await settle(B.c);
      assert.ok(!(await B.c.sync!.conflicts.list()).some((x) => x.id === cf.id), 'resolved on B');
      // The host started a cycle after resolving; Sync now waits for it and runs once more.
      await B.c.sync!.syncNow();
      await A.c.sync!.cycle('now');
      await settle(A.c);
      assert.strictEqual((await A.c.index.conversation('conv_vs'))?.title, cf.ours.value, 'the chosen title wins on A');
      assert.ok(!(await A.c.sync!.conflicts.list()).some((x) => x.id === cf.id), 'and the conflict is resolved there too');
      host.push();
      assert.ok(published.some((m) => m.type === 'syncStatus'), 'the chat gets the sync status');
      host.dispose();
    } finally {
      await A.c.dispose();
      await B.c.dispose();
    }
  });
});
