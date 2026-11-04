import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as net from 'net';
import * as path from 'path';
import * as vscode from 'vscode';
import type { LocalPilotApi } from '../extension';
import { parseRedisUrl, RedisClient } from '../storage/redis';
import { dockerState, probeRedis } from '../storage/redisSetup';
import { nextStreamId, RedisTelemetry, redisVersionSupported } from '../storage/redisTelemetry';

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
    assert.ok(['running', 'denied', 'stopped', 'missing'].includes(await dockerState()));
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
      // Health events arrive when the provider probes finish, which can be after the first events reach the stream.
      const keys = await until(async () => {
        const k = (await client.command('KEYS', 'localpilot:ts:health:*')) as string[];
        return k.length ? k : undefined;
      }, 20_000, 'provider health became time series');
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

suite('Redis client (in-process fake server)', () => {
  test('a timed-out handshake does not poison the next connection', async () => {
    const conns: net.Socket[] = [];
    const server = net.createServer((sock) => {
      sock.on('error', () => undefined);
      if (conns.push(sock) === 1) {
        return; // the first connection never answers
      }
      sock.on('data', (d: Buffer) => {
        const text = d.toString('utf8');
        // One reply per command: count the RESP array headers (`*N` at the start of a line).
        for (const m of text.matchAll(/(?:^|\r\n)\*\d+\r\n\$\d+\r\n(\w+)/g)) {
          sock.write(m[1].toUpperCase() === 'PING' ? '+PONG\r\n' : '+OK\r\n');
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as net.AddressInfo).port;
    const client = new RedisClient(`redis://:secret@127.0.0.1:${port}/2`, { commandTimeoutMs: 300 });
    try {
      await assert.rejects(client.command('PING'));
      assert.strictEqual(await client.command('PING'), 'PONG');
    } finally {
      client.close();
      conns.forEach((s) => s.destroy());
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test('servers older than Redis 6.2 are refused; XRANGE pages without exclusive ranges', () => {
    assert.strictEqual(redisVersionSupported('6.0.16'), false);
    assert.strictEqual(redisVersionSupported('6.2.0'), true);
    assert.strictEqual(redisVersionSupported('7.4.1'), true);
    assert.strictEqual(redisVersionSupported(undefined), true);
    assert.strictEqual(nextStreamId('1700000000000-5'), '1700000000000-6');
  });

  test('IPv6 literals lose their brackets; an unparsable URL is a failed probe, not a throw', async () => {
    assert.strictEqual(parseRedisUrl('redis://[::1]:6390').host, '::1');
    assert.strictEqual(parseRedisUrl('redis://127.0.0.1').host, '127.0.0.1');
    const p = await probeRedis('localhost:6379');
    assert.strictEqual(p.ok, false);
    assert.ok(p.error);
  });

  test('a failed time-series check is not cached: samples are written once Redis answers', async () => {
    const free = net.createServer();
    await new Promise<void>((resolve) => free.listen(0, '127.0.0.1', resolve));
    const port = (free.address() as net.AddressInfo).port;
    await new Promise<void>((resolve) => free.close(() => resolve()));
    const store = new RedisTelemetry(`redis://127.0.0.1:${port}`);
    const line = () => JSON.stringify({ t: Date.now(), type: 'model', provider: 'p', model: 'm', outcome: 'ok', durationMs: 12 });
    const seen: string[] = [];
    const conns: net.Socket[] = [];
    const server = net.createServer((sock) => {
      conns.push(sock);
      sock.on('error', () => undefined);
      sock.on('data', (d: Buffer) => {
        for (const m of d.toString('utf8').matchAll(/(?:^|\r\n)\*\d+\r\n\$\d+\r\n([\w.]+)/g)) {
          const cmd = m[1].toUpperCase();
          seen.push(cmd);
          sock.write(cmd === 'TS.INFO' ? '-ERR key does not exist\r\n' : cmd === 'XADD' ? '$15\r\n1700000000000-0\r\n' : cmd === 'TS.ADD' ? ':1\r\n' : '+OK\r\n');
        }
      });
    });
    try {
      await assert.rejects(store.write([line()], [], 0));
      await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
      await store.write([line()], [], 0);
      assert.ok(seen.includes('TS.ADD'), seen.join(','));
    } finally {
      store.dispose();
      conns.forEach((s) => s.destroy());
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
