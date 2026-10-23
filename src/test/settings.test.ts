import * as assert from 'assert';
import * as http from 'http';
import { AddressInfo } from 'net';
import * as vscode from 'vscode';
import { probeProvider, recommendModel, sanitizeMcpServers, sanitizeProvider } from '../ui/settingsPanel';

/** Minimal Ollama look-alike: enough of /api/version, /api/tags and /api/show for discovery. */
function fakeOllama(): Promise<{ url: string; close(): void }> {
  const models = [
    { name: 'qwen2.5-coder:14b', caps: ['completion', 'tools'], ctx: 32768 },
    { name: 'qwen2.5-coder:1.5b-base', caps: ['completion', 'insert'], ctx: 32768 },
    { name: 'qwen2.5vl:7b', caps: ['completion', 'tools', 'vision'], ctx: 32768 },
    { name: 'nomic-embed-text', caps: ['embedding'], ctx: 2048 },
  ];
  const srv = http.createServer((req, res) => {
    const json = (body: unknown) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(body));
    };
    if (req.url === '/api/version') {
      return json({ version: '0.6.0' });
    }
    if (req.url === '/api/tags') {
      return json({ models: models.map((m) => ({ name: m.name, model: m.name, details: { family: 'qwen2' } })) });
    }
    if (req.url === '/api/show') {
      let body = '';
      req.on('data', (d) => (body += d));
      req.on('end', () => {
        const m = models.find((x) => x.name === JSON.parse(body || '{}').model);
        json(m ? { capabilities: m.caps, model_info: { 'qwen2.context_length': m.ctx }, details: { family: 'qwen2' } } : {});
      });
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${(srv.address() as AddressInfo).port}`, close: () => srv.close() })));
}

const settingsTabs = () => vscode.window.tabGroups.all.flatMap((g) => g.tabs).filter((t) => t.input instanceof vscode.TabInputWebview && (t.input as vscode.TabInputWebview).viewType.includes('localpilot.settings'));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

suite('LocalPilot settings & setup', () => {
  suiteSetup(async function () {
    this.timeout(30_000);
    await vscode.extensions.getExtension('localpilot.localpilot-agent')!.activate();
  });

  test('settings, provider, welcome and memory commands are registered', async () => {
    const commands = await vscode.commands.getCommands(true);
    for (const id of ['localpilot.openSettings', 'localpilot.manageProviders', 'localpilot.openWelcome', 'localpilot.clearMemory']) {
      assert.ok(commands.includes(id), `missing command ${id}`);
    }
  });

  test('package.json wires the settings UI: gear in chat toolbar, walkthrough, welcome setting', () => {
    const c = vscode.extensions.getExtension('localpilot.localpilot-agent')!.packageJSON.contributes;
    assert.ok(c.menus['view/title'].some((m: { command: string; when: string }) => m.command === 'localpilot.openSettings' && m.when.includes('localpilot.chatView')));
    assert.strictEqual(c.walkthroughs[0].id, 'localpilot.gettingStarted');
    assert.ok(c.walkthroughs[0].steps.length >= 4);
    assert.strictEqual(c.configuration.properties['localpilot.showWelcomeOnStartup'].default, true);
    for (const step of c.walkthroughs[0].steps) {
      assert.ok(step.media.markdown.startsWith('media/walkthrough/'), `walkthrough media must ship in the VSIX: ${step.media.markdown}`);
    }
  });

  test('openSettings opens one webview panel; openWelcome re-targets the same panel', async function () {
    this.timeout(20_000);
    // On a fresh profile the first-run setup may already be showing; start from a known state.
    await vscode.window.tabGroups.close(settingsTabs());
    await sleep(200);
    await vscode.commands.executeCommand('localpilot.openSettings', 'providers');
    await sleep(400);
    let tabs = settingsTabs();
    assert.strictEqual(tabs.length, 1, 'expected exactly one settings panel');
    assert.strictEqual(tabs[0].label, 'LocalPilot Settings');

    await vscode.commands.executeCommand('localpilot.openWelcome');
    await sleep(300);
    tabs = settingsTabs();
    assert.strictEqual(tabs.length, 1, 'welcome must reuse the settings panel');
    assert.strictEqual(tabs[0].label, 'Welcome to LocalPilot');

    await vscode.commands.executeCommand('localpilot.manageProviders');
    await sleep(300);
    assert.strictEqual(settingsTabs()[0].label, 'LocalPilot Settings');
    await vscode.window.tabGroups.close(settingsTabs());
  });

  test('probeProvider talks to a real Ollama-style server and reports models with capabilities', async function () {
    this.timeout(20_000);
    const srv = await fakeOllama();
    try {
      const r = await probeProvider({ id: 'fake', type: 'ollama', baseUrl: srv.url, displayName: 'Fake' }, true);
      assert.strictEqual(r.ok, true, r.error);
      assert.strictEqual(r.models.length, 3, 'embedding-only models are not offered as chat models');
      assert.ok(!r.models.some((m) => m.name === 'nomic-embed-text'));
      const coder = r.models.find((m) => m.name === 'qwen2.5-coder:14b')!;
      assert.strictEqual(coder.supportsTools, true);
      assert.strictEqual(coder.contextWindow, 32768);
      assert.strictEqual(r.models.find((m) => m.name === 'qwen2.5vl:7b')!.supportsVision, true);
      assert.strictEqual(r.models.find((m) => m.name === 'qwen2.5-coder:1.5b-base')!.supportsFim, true);
      assert.ok(r.latencyMs >= 0 && r.latencyMs < 5000);
      // The wizard recommends a tool-capable coder model, never an embedding model.
      assert.strictEqual(recommendModel(r.models), 'fake/qwen2.5-coder:14b');
    } finally {
      srv.close();
    }
  });

  test('probeProvider against a live Ollama (skipped when none is running)', async function () {
    this.timeout(20_000);
    const r = await probeProvider({ id: 'ollama', type: 'ollama', baseUrl: 'http://localhost:11434', displayName: 'Ollama' }, true);
    if (!r.ok) {
      this.skip();
    }
    assert.ok(r.models.length > 0, 'a running Ollama should expose at least one chat model');
    for (const m of r.models) {
      assert.ok(m.id.startsWith('ollama/'), m.id);
      assert.ok(m.contextWindow > 0);
    }
    assert.ok(recommendModel(r.models), 'wizard must be able to recommend a model');
  });

  test('probeProvider fails fast and cleanly for unreachable or malformed endpoints', async function () {
    this.timeout(15_000);
    const dead = await probeProvider({ id: 'dead', type: 'openai', baseUrl: 'http://127.0.0.1:9' }, true);
    assert.strictEqual(dead.ok, false);
    assert.ok(dead.error && dead.error.length > 0);
    const bad = await probeProvider({ id: 'bad', type: 'openai', baseUrl: 'localhost:1234' }, false);
    assert.strictEqual(bad.ok, false);
    assert.match(bad.error!, /http/);
  });

  test('sanitizeProvider normalises ids and URLs and drops unknown fields', () => {
    const p = sanitizeProvider({ id: ' My Server! ', type: 'openai', baseUrl: 'localhost:1234/v1/', apiKey: ' ', displayName: ' LM ', models: [' a ', ''], contextWindow: 8192.4, enabled: false, extra: 1 } as never);
    assert.deepStrictEqual(p, { id: 'my-server', type: 'openai', baseUrl: 'http://localhost:1234/v1', displayName: 'LM', models: ['a'], contextWindow: 8192, enabled: false });
    assert.strictEqual(sanitizeProvider({ id: '', type: 'weird' as never, baseUrl: '' }).type, 'openai');
  });

  test('sanitizeMcpServers validates names, commands and env', () => {
    const out = sanitizeMcpServers({ 'file system': { command: ' npx ', args: ['-y', 'pkg'], env: { A: 1 }, cwd: ' /tmp ', enabled: false } });
    assert.deepStrictEqual(out, { 'file-system': { command: 'npx', args: ['-y', 'pkg'], env: { A: '1' }, cwd: '/tmp', enabled: false } });
    assert.throws(() => sanitizeMcpServers({ bad: { command: '' } }), /needs a name and a command/);
    assert.throws(() => sanitizeMcpServers([]), /must be an object/);
  });

  test('settings written through the VS Code API are picked up by the extension', async function () {
    this.timeout(15_000);
    const cfg = vscode.workspace.getConfiguration('localpilot');
    const before = cfg.inspect<string>('approvals.terminal')?.globalValue;
    await cfg.update('approvals.terminal', 'never', vscode.ConfigurationTarget.Global);
    assert.strictEqual(vscode.workspace.getConfiguration('localpilot').get('approvals.terminal'), 'never');
    await cfg.update('approvals.terminal', before, vscode.ConfigurationTarget.Global);
    assert.strictEqual(vscode.workspace.getConfiguration('localpilot').inspect<string>('approvals.terminal')?.globalValue, before);
  });
});
