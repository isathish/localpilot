import * as assert from 'assert';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { probePort, runColi } from '../providers/colibriSetup';

/**
 * A stand-in for a colibri checkout: `c/coli` behaves like the real launcher where LocalPilot relies on it.
 * `setup` records its arguments and environment, then (after a short "load") serves an OpenAI-compatible API that
 * identifies itself as colibri, in the foreground like `coli serve`. `status --json` reports a state, `stop` ends it.
 */
const FAKE_COLI = `#!/usr/bin/env node
const fs = require('fs'), http = require('http'), path = require('path');
const dir = path.dirname(__dirname);
const args = process.argv.slice(2);
fs.appendFileSync(path.join(dir, 'calls.log'), JSON.stringify({ args, kv: process.env.COLI_KV_SLOTS || null }) + '\\n');
const arg = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined; };
const pidFile = path.join(dir, 'server.pid');
if (args[0] === 'status') { console.log(JSON.stringify({ setup: { state: 'complete' }, server: { state: fs.existsSync(pidFile) ? 'running' : 'stopped' } })); process.exit(0); }
if (args[0] === 'stop') { try { process.kill(Number(fs.readFileSync(pidFile, 'utf8'))); } catch {} try { fs.unlinkSync(pidFile); } catch {} process.exit(0); }
if (args[0] === 'setup') {
  const model = arg('--model') || 'qwen3-coder-30b';
  fs.writeFileSync(pidFile, String(process.pid));
  setTimeout(() => http.createServer((req, res) => {
    if (req.url.startsWith('/v1/models')) return res.end(JSON.stringify({ data: [{ id: model, owned_by: 'colibri', capabilities: ['chat'], input_modalities: ['text'] }] }));
    if (req.url.startsWith('/health')) return res.end(JSON.stringify({ status: 'ok', arch: 'qwen3moe', kv_slots: Number(process.env.COLI_KV_SLOTS || 1) }));
    res.statusCode = 404; res.end();
  }).listen(Number(arg('--port') || 8000), '127.0.0.1'), 1500);
}
`;

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(p));
    });
  });
}

const calls = (dir: string) =>
  fs.existsSync(path.join(dir, 'calls.log'))
    ? fs.readFileSync(path.join(dir, 'calls.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { args: string[]; kv: string | null })
    : [];

suite('colibri: runColi', () => {
  test('a launcher that cannot be spawned resolves undefined instead of throwing', async () => {
    assert.strictEqual(await runColi({ kind: 'path', command: 'coli\0bad', prefix: [] }, ['status']), undefined);
  });
});

suite('colibri: Start / Stop colibri end to end (fake colibri checkout)', function () {
  this.timeout(120_000);
  const keys = ['colibri.path', 'colibri.port', 'colibri.kvSlots', 'colibri.model', 'parallel.maxConcurrency', 'providers'];
  const saved: Record<string, unknown> = {};
  let dir = '';

  suiteSetup(async function () {
    if (process.platform === 'win32') {
      this.skip(); // the fake launcher is a #! script
    }
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lp-colibri-'));
    fs.mkdirSync(path.join(dir, 'c'));
    fs.writeFileSync(path.join(dir, 'c', 'coli'), FAKE_COLI, { mode: 0o755 });
    const cfg = vscode.workspace.getConfiguration('localpilot');
    for (const k of keys) {
      saved[k] = cfg.inspect(k)?.globalValue;
    }
    await vscode.extensions.getExtension('localpilot.localpilot-agent')!.activate();
  });

  suiteTeardown(async () => {
    const cfg = vscode.workspace.getConfiguration('localpilot');
    for (const k of keys) {
      await cfg.update(k, saved[k], vscode.ConfigurationTarget.Global);
    }
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('start runs coli setup in a terminal, waits until it serves, registers its model; stop shuts it down', async () => {
    const port = await freePort();
    const cfg = vscode.workspace.getConfiguration('localpilot');
    await cfg.update('colibri.path', dir, vscode.ConfigurationTarget.Global);
    await cfg.update('colibri.port', port, vscode.ConfigurationTarget.Global);
    await cfg.update('colibri.kvSlots', 3, vscode.ConfigurationTarget.Global);
    await cfg.update('colibri.model', undefined, vscode.ConfigurationTarget.Global);
    await cfg.update('parallel.maxConcurrency', 4, vscode.ConfigurationTarget.Global);

    await vscode.commands.executeCommand('localpilot.startColibri');

    assert.strictEqual(await probePort(port), 'colibri', 'colibri answers on its port when the command returns');
    const setup = calls(dir).find((c) => c.args[0] === 'setup');
    assert.ok(setup, `coli setup was run: ${JSON.stringify(calls(dir))}`);
    assert.deepStrictEqual(setup!.args, ['setup', '--yes', '--no-browser', '--host', '127.0.0.1', '--port', String(port)], 'non-interactive, no browser, the configured port, colibri picks the model');
    assert.strictEqual(setup!.kv, '3', 'KV slots reach coli serve through COLI_KV_SLOTS');

    const api = vscode.extensions.getExtension('localpilot.localpilot-agent')!.exports as { listModels(): Promise<{ id: string; runtime?: string; parallelSlots?: number }[]> };
    const models = await api.listModels();
    const coli = models.find((m) => m.runtime === 'colibri');
    assert.ok(coli && /qwen3-coder-30b/.test(coli.id), `the colibri model is listed: ${models.map((m) => m.id).join(', ')}`);
    assert.strictEqual(coli!.parallelSlots, 3, 'its KV slots are read from /health');

    // Starting again reuses the running server instead of a second setup on the same port.
    await vscode.commands.executeCommand('localpilot.startColibri');
    assert.strictEqual(calls(dir).filter((c) => c.args[0] === 'setup').length, 1, 'no second setup while it is running');

    await vscode.commands.executeCommand('localpilot.stopColibri');
    assert.ok(calls(dir).some((c) => c.args[0] === 'stop'), 'coli stop was run');
    assert.notStrictEqual(await probePort(port), 'colibri', 'nothing answers as colibri after stop');
  });
});
