// Continuity DATA layer inside the VS Code test host: the extension opens it on activation (bundled worker + wasm from
// dist/), its commands are registered, a fixture 1.6 profile migrates into the live instance, and the pure parts
// (reducer, index, crypto, retention, backup) run against temp folders. No network; paths via path.join.
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import type { LocalPilotApi } from '../extension';
import { Continuity, continuityDataDir } from '../continuity/continuity';
import { FileEventLog } from '../continuity/data/eventLog';
import { BlobStore } from '../continuity/data/blobs';
import { Migration } from '../continuity/data/migration';
import { LocalIndexClient } from '../continuity/data/index/indexClient';
import { loadSqlJs } from '../continuity/data/index/engine';
import { DEFAULT_RULES, reduce, EntityState } from '../continuity/data/reducer';
import { EventEnvelope } from '../continuity/events';
import { createKeyring, unlockKeyring, WrongPassphraseError } from '../continuity/data/crypto/keyring';
import { open as openSealed, seal } from '../continuity/data/crypto/envelope';
import { Retention } from '../continuity/data/retention';
import { restoreBackup, writeBackup } from '../continuity/data/backup';
import { memorySecretBox } from '../continuity/data/crypto/secretBox';
import { makeFixture, originalsUntouched } from './fixtures/continuityFixtures';

const quiet = { info: () => undefined, warn: () => undefined, error: () => undefined };
const tmp = (p: string) => fs.mkdtempSync(path.join(os.tmpdir(), `lp-ctest-${p}-`));
const wasm = () => {
  const ext = vscode.extensions.getExtension('localpilot.localpilot-agent');
  const dist = ext ? path.join(ext.extensionPath, 'dist', 'sqljs', 'sql-wasm.wasm') : '';
  return fs.existsSync(dist) ? dist : undefined;
};
const H = (ms: number, d: string) => `${ms.toString(16).padStart(12, '0')}-0000-${d}`;
function ev(stream: string, seq: number, hlc: string, eid: string, op: EventEnvelope['op'], p: Record<string, unknown>, base?: string): EventEnvelope {
  return { v: 1, id: `${stream}:${seq}`, stream, seq, hlc, dev: stream.split('.')[0], ent: 'conversation', eid, op, sv: 1, p, ...(base ? { base } : {}) };
}

suite('Continuity data: extension activation', () => {
  test('opens on activation with the bundled worker, registers its commands and imports a 1.6 profile', async function () {
    this.timeout(120_000);
    const ext = vscode.extensions.getExtension<LocalPilotApi>('localpilot.localpilot-agent');
    assert.ok(ext);
    const api = await ext.activate();
    const commands = await vscode.commands.getCommands(true);
    for (const id of ['localpilot.continuity.rebuildIndex', 'localpilot.continuity.backupNow', 'localpilot.continuity.restoreBackup', 'localpilot.continuity.openDataFolder']) {
      assert.ok(commands.includes(id), `missing command ${id}`);
    }
    const c = await api.continuity;
    assert.ok(c, 'continuity opened');
    assert.strictEqual(c.degraded, undefined, c.degraded);
    assert.ok(c.openMs < 50, `open took ${c.openMs} ms on the extension host`);
    await c.ready;
    assert.strictEqual(c.indexFailed, undefined, `index: ${c.indexFailed}`);
    assert.ok(!c.dataDir.startsWith(path.join(os.homedir(), '.localpilot')) || !!process.env.LOCALPILOT_CONTINUITY_DIR, 'tests never write the real data folder');
    const status = await c.index.status();
    assert.strictEqual(status.state, 'ready');
    // A fixture profile migrated into the live instance (its log, its worker-backed index).
    const fx = makeFixture();
    const mig = new Migration({ root: path.join(c.dataDir, 'fixture-run'), log: c.log, blobs: c.blobs, sources: fx.sources, logger: quiet });
    const p = await mig.run();
    assert.strictEqual(p.state, 'done');
    await c.index.catchUp();
    const page = await c.index.history({ limit: 100 });
    for (const id of [fx.ids.vscodeChat, fx.ids.archivedChat, fx.ids.cliChat, fx.ids.goneChat]) {
      assert.ok(page.rows.some((r) => r.id === id), `${id} listed`);
    }
    assert.strictEqual((await c.index.messages(fx.ids.archivedChat)).length, fx.expectedMessages[fx.ids.archivedChat]);
    const hits = await c.index.search('in:errors econnrefused');
    assert.ok(hits.some((h) => h.conversationId === fx.ids.vscodeChat), 'error output is searchable');
    assert.deepStrictEqual(originalsUntouched(fx), []);
    const stats = await c.data.stats();
    assert.ok(stats.bytes.logs > 0 && stats.index?.fts, JSON.stringify(stats.index));
  });
});

suite('Continuity data: core', () => {
  test('reducer: 200 interleavings of three streams agree', () => {
    let seed = 11;
    const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    const streams = ['dev_A', 'dev_B', 'dev_C'].map((d, k) =>
      Array.from({ length: 20 }, (_, i) => {
        const t = 100 + i * 3 + k;
        const r = rand();
        return ev(`${d}.1`, i + 1, H(t, d), 's_p', r < 0.15 ? 'trash' : r < 0.3 ? 'restore' : 'patch', r < 0.3 ? { at: t } : { title: `${d}${i}`, tags: { [`t${i % 3}`]: r > 0.6 }, pinned: r > 0.5 }, r > 0.5 ? H(t - 4, 'dev_A') : undefined);
      })
    );
    const canon = (v: unknown): unknown => (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon((v as Record<string, unknown>)[k])])) : v);
    const sig = (s?: EntityState) => JSON.stringify(canon({ f: s?.fields, c: s?.clocks, t: s?.trashed }));
    let ref: string | undefined;
    for (let run = 0; run < 200; run++) {
      const cur = [0, 0, 0];
      let s: EntityState | undefined;
      while (cur.some((c, i) => c < streams[i].length)) {
        const open = [0, 1, 2].filter((i) => cur[i] < streams[i].length);
        const i = open[Math.floor(rand() * open.length)];
        s = reduce(s, streams[i][cur[i]++], DEFAULT_RULES).state;
      }
      ref ??= sig(s);
      assert.strictEqual(sig(s), ref, `run ${run}`);
    }
  });

  test('index: incremental equals rebuild; corrupt file is rebuilt', async function () {
    this.timeout(60_000);
    const sqlJs = await loadSqlJs(wasm());
    const root = tmp('idx');
    const log = FileEventLog.open({ root, writer: 'vscode', log: quiet, flushMs: 1 });
    for (let i = 0; i < 50; i++) {
      log.append('conversation', `s_${i % 5}`, i < 5 ? 'create' : 'patch', i < 5 ? { title: `Chat ${i}`, tags: {}, pinned: false, favorite: false, archived: false, model: 'm', mode: 'agent', activeBranchId: `br_s_${i}`, createdAt: i } : { title: `Chat ${i}`, favorite: i % 2 === 0 });
      log.append('message', `m_${i}`, 'create', { conversationId: `s_${i % 5}`, branchId: `br_s_${i % 5}`, role: 'user', parts: [{ kind: 'text', text: `needle${i % 7} haystack` }], meta: {}, createdAt: i });
    }
    await log.flush();
    const client = new LocalIndexClient({ root, deviceId: log.device.deviceId, ownStream: log.stream, sqlJs });
    await client.ready;
    const dump = async () => JSON.stringify([await client.history({ limit: 100 }), await client.counts(), (await client.search('needle3')).length]);
    const before = await dump();
    await client.rebuild();
    assert.strictEqual(await dump(), before);
    await client.dispose();
    fs.writeFileSync(path.join(root, 'index', 'index.sqlite'), 'garbage');
    const again = new LocalIndexClient({ root, deviceId: log.device.deviceId, sqlJs });
    await again.ready;
    assert.strictEqual(JSON.stringify([await again.history({ limit: 100 }), await again.counts(), (await again.search('needle3')).length]), before);
    await again.dispose();
    await log.dispose();
  });

  test('crypto: wrong passphrase, tamper, AAD swap', async () => {
    const ring = await createKeyring('a long passphrase', { N: 2 ** 14 });
    await assert.rejects(unlockKeyring(ring.file, 'nope'), WrongPassphraseError);
    const obj = seal(ring.keys[0], 'devices/dev_A.json.lpe', '{"heads":{}}');
    assert.strictEqual(openSealed(ring.keys, 'devices/dev_A.json.lpe', obj).toString(), '{"heads":{}}');
    assert.throws(() => openSealed(ring.keys, 'devices/dev_B.json.lpe', obj));
    const bad = Buffer.from(obj);
    bad[bad.length - 1] ^= 1;
    assert.throws(() => openSealed(ring.keys, 'devices/dev_A.json.lpe', bad));
  });

  test('retention with an injected clock, then backup round trip into another root', async function () {
    this.timeout(60_000);
    const sqlJs = await loadSqlJs(wasm());
    let now = Date.UTC(2026, 5, 1);
    const root = tmp('ret');
    const log = FileEventLog.open({ root, writer: 'vscode', log: quiet, flushMs: 1, now: () => now });
    const index = new LocalIndexClient({ root, deviceId: log.device.deviceId, ownStream: log.stream, sqlJs, now: () => now });
    const ret = new Retention({ log, index, blobs: new BlobStore(root), settings: () => ({ trashRetentionDays: 7, historyDays: 90 }), now: () => now });
    for (const id of ['s_a', 's_b']) {
      log.append('conversation', id, 'create', { title: id, tags: {}, pinned: false, favorite: false, archived: false, model: '', mode: 'agent', activeBranchId: `br_${id}`, createdAt: now });
    }
    log.append('conversation', 's_b', 'trash', { at: now });
    await log.flush();
    await index.ready;
    await index.catchUp();
    now += 3 * 86_400_000;
    assert.strictEqual((await ret.run()).purged, 0);
    now += 5 * 86_400_000;
    assert.strictEqual((await ret.run()).purged, 1);
    assert.strictEqual((await index.counts()).trash, 0);
    const dir = tmp('bk');
    const b = await writeBackup({ log, blobs: new BlobStore(root), dir, now: () => now });
    const other = tmp('other');
    const olog = FileEventLog.open({ root: other, writer: 'vscode', log: quiet, flushMs: 1 });
    const r = await restoreBackup({ log: olog, blobs: new BlobStore(other), file: b.file });
    assert.ok(r.imported > 0);
    const oindex = new LocalIndexClient({ root: other, deviceId: olog.device.deviceId, sqlJs });
    await oindex.ready;
    assert.deepStrictEqual((await oindex.history({ limit: 10 })).rows.map((x) => x.id), ['s_a']);
    await oindex.dispose();
    await olog.dispose();
    await index.dispose();
    await log.dispose();
  });

  test('Continuity.open: never throws, data dir resolution', async () => {
    const file = path.join(tmp('deg'), 'not-a-dir');
    fs.writeFileSync(file, 'x');
    const c = await Continuity.open({ dataDir: path.join(file, 'x'), writer: 'vscode', appVersion: 't', secrets: memorySecretBox(), log: quiet, settings: () => ({ dataDir: '', trashRetentionDays: 30, historyDays: 90, indexMaxMB: 256, backup: { enabled: false, intervalDays: 7, keep: 4 } }), wasmPath: '', workerPath: '', schedules: false });
    assert.ok(c.degraded);
    assert.strictEqual(continuityDataDir(path.join('a', 'b')), path.resolve(path.join('a', 'b')));
    assert.strictEqual(continuityDataDir('', { LOCALPILOT_DATA_DIR: path.join(os.tmpdir(), 'lpd') }), path.join(path.resolve(os.tmpdir(), 'lpd'), 'continuity'));
    assert.strictEqual(continuityDataDir('', { LOCALPILOT_CONTINUITY_DIR: path.join(os.tmpdir(), 'cd') }), path.resolve(os.tmpdir(), 'cd'));
  });
});
