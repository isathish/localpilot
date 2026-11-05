import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { parseLogLine, summarize, Telemetry } from '../telemetry/telemetry';
import type { LogEntry, TelemetryEvent, TelemetryRemote, TelemetrySummary } from '../telemetry/telemetry';

type Api = { telemetry: { summary(days: number): Promise<TelemetrySummary>; logs(filter?: { level?: string; q?: string }): LogEntry[]; dir: string } };

suite('LocalPilot dashboard & telemetry', () => {
  test('package.json wires the dashboard: command, menu, settings', () => {
    const c = vscode.extensions.getExtension('localpilot.localpilot-agent')!.packageJSON.contributes;
    assert.ok(c.commands.some((x: { command: string }) => x.command === 'localpilot.openDashboard'));
    assert.ok(c.menus['view/title'].some((m: { command: string }) => m.command === 'localpilot.openDashboard'));
    assert.strictEqual(c.configuration.properties['localpilot.telemetry.enabled'].default, true);
    assert.strictEqual(c.configuration.properties['localpilot.telemetry.retentionDays'].default, 30);
    assert.ok(/nothing is ever sent/i.test(c.configuration.properties['localpilot.telemetry.enabled'].markdownDescription), 'the setting promises local-only recording');
  });

  test('the log is mirrored into the telemetry store and provider checks are recorded', async function () {
    this.timeout(30_000);
    const ext = vscode.extensions.getExtension('localpilot.localpilot-agent')!;
    const api = (await ext.activate()) as Api;
    assert.ok(api.telemetry.dir.endsWith('telemetry'), api.telemetry.dir);
    // Activation itself logs; the mirror must have caught it.
    const logs = api.telemetry.logs({ q: 'activat' });
    assert.ok(logs.length >= 1, 'activation log line mirrored');
    assert.ok(logs.every((l) => typeof l.t === 'number' && typeof l.level === 'string'));
    // Discovery probes every configured provider and records a health event per provider.
    await vscode.commands.executeCommand('localpilot.refreshModels');
    const s = await api.telemetry.summary(1);
    assert.ok(s.health.length >= 1, `expected provider health rows, got ${JSON.stringify(s.health)}`);
    assert.ok(s.health.every((h) => typeof h.uptime === 'number' && typeof h.up === 'boolean'));
    assert.strictEqual(s.series.length, 1, 'one point for today');
    assert.ok(s.storage.events >= s.health.length);
  });

  test('Open Dashboard shows the settings panel on the dashboard section', async function () {
    this.timeout(20_000);
    await vscode.commands.executeCommand('localpilot.openDashboard');
    await new Promise((r) => setTimeout(r, 400));
    const tabs = vscode.window.tabGroups.all.flatMap((g) => g.tabs).filter((t) => t.input instanceof vscode.TabInputWebview && (t.input as vscode.TabInputWebview).viewType.includes('localpilot.settings'));
    assert.strictEqual(tabs.length, 1, 'one settings panel');
    assert.strictEqual(tabs[0].label, 'LocalPilot Settings');
    await vscode.window.tabGroups.close(tabs);
  });

  test('Delete all reports a Redis store that could not be cleared', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lp-telemetry-'));
    const stub = (clear: () => Promise<void>): TelemetryRemote => ({
      label: 'stub',
      write: async () => undefined,
      events: async () => undefined,
      recentLogs: async () => [],
      stats: async () => ({ events: 0, bytes: 0 }),
      prune: async () => undefined,
      clear,
    });
    try {
      const down = new Telemetry({ dir, retentionDays: () => 0, remote: () => stub(() => Promise.reject(new Error('down'))) });
      assert.strictEqual((await down.clear()).remoteError, 'down');
      down.dispose();
      const up = new Telemetry({ dir, retentionDays: () => 0, remote: () => stub(async () => undefined) });
      assert.deepStrictEqual(await up.clear(), {});
      up.dispose();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test('log lines survive a reload byte for byte: backslashes, newlines, CR and U+2028', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lp-telemetry-'));
    const msgs = ['Reading C:\\Users\\nina\\notes.txt', 'a\nb', 'progress 50%\r60%', 'x\u2028y'];
    try {
      const a = new Telemetry({ dir, retentionDays: () => 0 });
      msgs.forEach((m) => a.log('info', m));
      await a.flush();
      a.dispose();
      const b = new Telemetry({ dir, retentionDays: () => 0 });
      await b.loadRecentLogs();
      assert.deepStrictEqual(b.logs({ limit: 10 }).map((e) => e.msg), msgs);
      assert.strictEqual(parseLogLine('2026-01-01T00:00:00.000Z [info] a\\nb')?.msg, 'a\nb');
      b.dispose();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test('spend is summed per day and per provider; local calls stay free', () => {
    const day = 86_400_000;
    const to = new Date(2026, 3, 10, 12).getTime();
    const from = new Date(2026, 3, 8).getTime();
    const call = (t: number, provider: string, costUsd?: number): TelemetryEvent => ({ type: 'model', t, sid: 's', model: `${provider}-m`, provider, mode: 'agent', depth: 0, promptTokens: 100, completionTokens: 10, costUsd, durationMs: 500, outcome: 'ok' });
    const s = summarize([call(to - 2 * day, 'openai', 0.25), call(to, 'anthropic', 0.5), call(to, 'ollama')], { days: 3, from, to });
    assert.strictEqual(s.series.length, 3);
    assert.strictEqual(s.series[0].costUsd, 0.25);
    assert.deepStrictEqual(s.series[0].costByProvider, { openai: 0.25 });
    assert.strictEqual(s.series[1].costUsd, 0, 'a day without calls costs nothing');
    assert.strictEqual(s.series[2].costUsd, 0.5);
    assert.deepStrictEqual(s.series[2].costByProvider, { anthropic: 0.5 });
    assert.strictEqual(s.totals.costUsd, 0.75);
    assert.deepStrictEqual(s.providers, [
      { provider: 'anthropic', calls: 1, pricedCalls: 1, costUsd: 0.5 },
      { provider: 'openai', calls: 1, pricedCalls: 1, costUsd: 0.25 },
      { provider: 'ollama', calls: 1, pricedCalls: 0, costUsd: 0 },
    ]);
  });
});
