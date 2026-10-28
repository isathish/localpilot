import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import type { LocalPilotApi } from '../extension';
import { RedisClient } from '../storage/redis';
import { dockerState, probeRedis } from '../storage/redisSetup';

/**
 * The optional Redis Stack store inside the real extension: settings switch telemetry over, events and log lines land in
 * Redis streams and time series, the Dashboard summary reads them back, and an unreachable server falls back to files.
 * Needs a Redis at LOCALPILOT_E2E_REDIS (default redis://127.0.0.1:16379/5 — a throwaway db index); skipped otherwise.
 */
const URL = process.env.LOCALPILOT_E2E_REDIS || 'redis://127.0.0.1:16379/5';
const DEAD = 'redis://127.0.0.1:1/5';

async function until<T>(fn: () => Promise<T | undefined | false>, ms: number, what: string): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn().catch(() => undefined);
    if (v) {
      return v;
    }
    if (Date.now() > end) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}

suite('Redis Stack storage (real server, end to end)', function () {
  this.timeout(90_000);
  const cfg = () => vscode.workspace.getConfiguration('localpilot');
  let api: LocalPilotApi;
  let client: RedisClient;
  let before: { enabled: unknown; url: unknown };

  suiteSetup(async function () {
    const probe = await probeRedis(URL);
    if (!probe.ok) {
      this.skip();
    }
    api = (await vscode.extensions.getExtension('localpilot.localpilot-agent')!.activate()) as LocalPilotApi;
    client = new RedisClient(URL);
    await client.command('FLUSHDB');
    before = { enabled: cfg().inspect('storage.redis.enabled')?.globalValue, url: cfg().inspect('storage.redis.url')?.globalValue };
  });
  suiteTeardown(async () => {
    if (!client) {
      return;
    }
    await cfg().update('storage.redis.enabled', before.enabled, vscode.ConfigurationTarget.Global);
    await cfg().update('storage.redis.url', before.url, vscode.ConfigurationTarget.Global);
    await client.command('FLUSHDB').catch(() => undefined);
    client.close();
  });

  test('the setup command, settings and Docker detection are wired', async () => {
    assert.ok((await vscode.commands.getCommands(true)).includes('localpilot.setupRedis'));
    const props = vscode.extensions.getExtension('localpilot.localpilot-agent')!.packageJSON.contributes.configuration.properties;
    for (const k of ['localpilot.storage.redis.enabled', 'localpilot.storage.redis.url', 'localpilot.storage.sessionsInMemory']) {
      assert.ok(props[k], k);
    }
    assert.ok(['running', 'stopped', 'missing'].includes(await dockerState()));
    const probe = await probeRedis(URL);
    assert.ok(probe.ok && probe.version, 'probe reports the server version');
  });

  test('enabling Redis moves events and log lines out of files into Redis, and the Dashboard reads them back', async () => {
    await cfg().update('storage.redis.url', URL, vscode.ConfigurationTarget.Global);
    await cfg().update('storage.redis.enabled', true, vscode.ConfigurationTarget.Global);
    const filesBefore = new Set(await fs.readdir(api.telemetry.dir).catch(() => [] as string[]));
    const sizeBefore = await fs.stat(path.join(api.telemetry.dir, [...filesBefore].find((f) => f.startsWith('events-')) ?? 'none')).then((s) => s.size, () => 0);
    // A provider refresh records one health event per configured provider, reachable or not.
    await vscode.commands.executeCommand('localpilot.refreshModels');
    const events = await until(async () => {
      const n = await client.command('XLEN', 'localpilot:events');
      return typeof n === 'number' && n > 0 ? n : undefined;
    }, 20_000, 'events in localpilot:events');
    assert.ok(events > 0);
    await until(async () => {
      const n = await client.command('XLEN', 'localpilot:logs');
      return typeof n === 'number' && n > 0;
    }, 20_000, 'log lines in localpilot:logs');
    const sizeAfter = await fs.stat(path.join(api.telemetry.dir, [...filesBefore].find((f) => f.startsWith('events-')) ?? 'none')).then((s) => s.size, () => 0);
    assert.strictEqual(sizeAfter, sizeBefore, 'no new events were appended to the daily file while Redis is on');

    const probe = await probeRedis(URL);
    if (probe.timeseries) {
      const keys = (await client.command('KEYS', 'localpilot:ts:health:*')) as string[];
      assert.ok(keys.length > 0, 'provider health became time series');
      const info = (await client.command('TS.INFO', keys[0])) as unknown[];
      const labels = info[info.indexOf('labels') + 1] as string[][];
      assert.ok(labels.some(([k, v]) => k === 'app' && v === 'localpilot'), 'series carry the app=localpilot label');
    }

    const summary = await api.telemetry.summary(1);
    assert.match(summary.storage.dir, /Redis redis:\/\/127\.0\.0\.1/, 'the Dashboard says where the data lives');
    assert.strictEqual(summary.storage.backend, 'redis');
    assert.ok(summary.health.length > 0 && summary.storage.events >= events, 'health rows come back from Redis');
  });

  test('an unreachable Redis falls back to files without losing events', async () => {
    await cfg().update('storage.redis.url', DEAD, vscode.ConfigurationTarget.Global);
    const day = new Date();
    const stamp = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`;
    const file = path.join(api.telemetry.dir, `events-${stamp}.jsonl`);
    const logFile = path.join(api.telemetry.dir, `localpilot-${stamp}.log`);
    const sizeBefore = await fs.stat(file).then((s) => s.size, () => 0);
    const logBefore = await fs.stat(logFile).then((s) => s.size, () => 0);
    await vscode.commands.executeCommand('localpilot.refreshModels');
    await until(async () => (await fs.stat(file).then((s) => s.size, () => 0)) > sizeBefore, 20_000, 'events in the daily file');
    await until(async () => (await fs.stat(logFile).then((s) => s.size, () => 0)) > logBefore, 20_000, 'log lines in the daily log file');
    const summary = await api.telemetry.summary(1);
    assert.ok(summary.health.length > 0, 'the summary still works from files');
    assert.strictEqual(summary.storage.backend, 'fallback', 'the Dashboard says Redis is unreachable');
    assert.ok(summary.storage.remoteError, 'with the reason');
  });

  test('turning Redis off goes back to files and the Dashboard stops mentioning Redis', async () => {
    await cfg().update('storage.redis.enabled', false, vscode.ConfigurationTarget.Global);
    const summary = await api.telemetry.summary(1);
    assert.doesNotMatch(summary.storage.dir, /Redis/);
    assert.strictEqual(summary.storage.backend, 'files');
  });

  test('an invalid Redis URL never breaks the extension; telemetry stays on files', async () => {
    await cfg().update('storage.redis.url', 'redis://bad host:notaport', vscode.ConfigurationTarget.Global);
    await cfg().update('storage.redis.enabled', true, vscode.ConfigurationTarget.Global);
    const summary = await api.telemetry.summary(1);
    assert.strictEqual(summary.storage.backend, 'files', 'an unparsable URL is ignored');
    await cfg().update('storage.redis.enabled', false, vscode.ConfigurationTarget.Global);
  });

  /** Drives "Set Up Redis Storage" → "Start Redis Stack in Docker" for real; opt-in because it creates a container and a volume. */
  test('setup command: Start Redis Stack in Docker creates the container and switches storage on', async function () {
    if (process.env.LOCALPILOT_E2E_DOCKER !== '1' || (await dockerState()) !== 'running') {
      this.skip();
    }
    this.timeout(6 * 60_000);
    const url = 'redis://127.0.0.1:16380';
    await cfg().update('storage.redis.url', url, vscode.ConfigurationTarget.Global);
    await cfg().update('storage.redis.enabled', false, vscode.ConfigurationTarget.Global);
    const win = vscode.window as unknown as Record<string, unknown>;
    const original = { pick: win.showQuickPick, info: win.showInformationMessage };
    const offered: string[] = [];
    win.showQuickPick = async (items: (vscode.QuickPickItem & { id?: string })[]) => {
      offered.push(...items.map((i) => i.id ?? ''));
      return items.find((i) => i.id === 'docker');
    };
    win.showInformationMessage = async () => undefined;
    try {
      await vscode.commands.executeCommand('localpilot.setupRedis');
      assert.ok(offered.includes('docker') && offered.includes('url') && offered.includes('files'), offered.join(','));
      assert.strictEqual(cfg().get('storage.redis.enabled'), true, 'storage switched on once Redis answered');
      const probe = await probeRedis(url);
      assert.ok(probe.ok && probe.timeseries, 'the container runs Redis Stack with RedisTimeSeries');
      const mem = new RedisClient(url);
      try {
        const max = (await mem.command('CONFIG', 'GET', 'maxmemory')) as string[];
        assert.strictEqual(max[1], String(256 * 1024 * 1024), 'memory capped at 256 MB');
      } finally {
        mem.close();
      }
    } finally {
      win.showQuickPick = original.pick;
      win.showInformationMessage = original.info;
      await cfg().update('storage.redis.enabled', false, vscode.ConfigurationTarget.Global);
    }
  });
});
