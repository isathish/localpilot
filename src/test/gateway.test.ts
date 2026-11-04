import * as assert from 'assert';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { gatewayModels, installAndStartCommand, terminalShell } from '../providers/gatewaySetup';
import { ProviderConfig } from '../types';

/**
 * A stand-in `omniroute` on PATH: records its arguments and bind address, then serves OmniRoute's API in the foreground
 * (/v1/models with its `auto` routes, plus provider models when `providers.flag` exists next to it).
 */
const FAKE_OMNIROUTE = `#!/usr/bin/env node
const fs = require('fs'), http = require('http'), path = require('path');
const dir = __dirname;
const args = process.argv.slice(2);
fs.appendFileSync(path.join(dir, 'calls.log'), JSON.stringify({ args, host: process.env.OMNIROUTE_SERVER_HOST || null }) + '\\n');
const port = Number(args[args.indexOf('--port') + 1] || 20128);
http.createServer((req, res) => {
  if (req.url.startsWith('/v1/models')) {
    const data = ['auto', 'auto/coding'].map((id) => ({ id, owned_by: 'omniroute' }));
    if (fs.existsSync(path.join(dir, 'providers.flag'))) data.push({ id: 'openai/gpt-5.4', owned_by: 'openai' });
    return res.end(JSON.stringify({ object: 'list', data }));
  }
  res.statusCode = 404; res.end();
}).listen(port, process.env.OMNIROUTE_SERVER_HOST || '0.0.0.0', () => setTimeout(() => {}, 0));
`;

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(p));
    });
  });
}

const calls = (dir: string) => (fs.existsSync(path.join(dir, 'calls.log')) ? fs.readFileSync(path.join(dir, 'calls.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { args: string[]; host: string | null }) : []);

suite('gateways: terminal commands per shell', () => {
  test('install-and-start uses PowerShell syntax on Windows, && elsewhere', () => {
    assert.strictEqual(installAndStartCommand('omniroute', 20128, 'win32'), 'npm install -g omniroute; if ($?) { omniroute --port 20128 --no-open --non-interactive }');
    assert.strictEqual(installAndStartCommand('omniroute', 20128, 'linux'), 'npm install -g omniroute && omniroute --port 20128 --no-open --non-interactive');
  });

  test('the terminal shell is PowerShell on Windows', () => {
    assert.strictEqual(terminalShell('win32').shellPath, 'powershell.exe');
    assert.deepStrictEqual(terminalShell('linux'), {});
  });
});

suite('gateways: Start / Stop Gateway end to end (fake omniroute on PATH)', function () {
  this.timeout(120_000);
  let bin = '';
  let savedPath = '';
  let savedProviders: unknown;

  suiteSetup(async function () {
    if (process.platform === 'win32') {
      this.skip(); // the fake executable is a #! script
    }
    bin = fs.mkdtempSync(path.join(os.tmpdir(), 'lp-omni-'));
    fs.writeFileSync(path.join(bin, 'omniroute'), FAKE_OMNIROUTE, { mode: 0o755 });
    savedPath = process.env.PATH ?? '';
    process.env.PATH = `${bin}${path.delimiter}${savedPath}`;
    savedProviders = vscode.workspace.getConfiguration('localpilot').inspect('providers')?.globalValue;
    await vscode.extensions.getExtension('localpilot.localpilot-agent')!.activate();
  });

  suiteTeardown(async () => {
    process.env.PATH = savedPath;
    await vscode.workspace.getConfiguration('localpilot').update('providers', savedProviders, vscode.ConfigurationTarget.Global);
    if (bin) {
      fs.rmSync(bin, { recursive: true, force: true });
    }
  });

  test('start runs OmniRoute on 127.0.0.1 and its port, registers it as a cloud provider; a second start reuses it; stop ends it', async () => {
    const port = await freePort();
    const cfg = vscode.workspace.getConfiguration('localpilot');
    await cfg.update('providers', [{ id: 'omniroute', type: 'openai', baseUrl: `http://localhost:${port}/v1`, displayName: 'OmniRoute' }], vscode.ConfigurationTarget.Global);

    await vscode.commands.executeCommand('localpilot.startGateway', 'omniroute');

    const run = calls(bin);
    assert.strictEqual(run.length, 1, `omniroute was started once: ${JSON.stringify(run)}`);
    assert.deepStrictEqual(run[0].args, ['--port', String(port), '--no-open', '--non-interactive'], 'its port, no browser, no prompts');
    assert.strictEqual(run[0].host, '127.0.0.1', 'bound to localhost only');
    // A fresh read: a WorkspaceConfiguration object is a snapshot from when it was taken.
    const p = (vscode.workspace.getConfiguration('localpilot').get<ProviderConfig[]>('providers') ?? []).find((x) => x.id === 'omniroute');
    assert.strictEqual(p?.cloud, true, 'the gateway provider is marked cloud');

    const api = vscode.extensions.getExtension('localpilot.localpilot-agent')!.exports as { listModels(): Promise<{ id: string; remote?: boolean }[]> };
    let models = await api.listModels();
    assert.ok(models.some((m) => m.id === 'omniroute/auto/coding' && m.remote), `its routes are listed as cloud models: ${models.map((m) => m.id).join(', ')}`);

    // A provider connected in the gateway shows up on the next refresh, without restarting anything.
    fs.writeFileSync(path.join(bin, 'providers.flag'), '');
    await vscode.commands.executeCommand('localpilot.startGateway', 'omniroute');
    assert.strictEqual(calls(bin).length, 1, 'a running gateway is reused, not started twice');
    models = await api.listModels();
    assert.ok(models.some((m) => m.id === 'omniroute/openai/gpt-5.4'), 'the connected provider model is listed');

    await vscode.commands.executeCommand('localpilot.stopGateway', 'omniroute');
    let down = false;
    for (let i = 0; i < 20 && !down; i++) {
      down = !(await gatewayModels(port));
      if (!down) {
        await new Promise((r) => setTimeout(r, 250));
      }
    }
    assert.ok(down, 'the gateway stops with its terminal');
  });
});
