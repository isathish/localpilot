import * as assert from 'assert';
import * as fs from 'fs';
import * as http from 'http';
import { AddressInfo } from 'net';
import * as path from 'path';
import * as vscode from 'vscode';
import { probeProvider, recommendModel, sanitizeMcpServers, sanitizeProvider } from '../ui/settingsPanel';
import { resolveApiKey } from '../providers/cloud';
import { ProviderSecrets } from '../providers/secrets';
import { DEFAULT_PROVIDERS, isUserOnlySetting, providerScope } from '../config';

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

  test('chat location: one set of views moved natively, destination containers for every side, Move Chat To… everywhere, LocalPilot icon in editor title and status bar', async () => {
    const c = vscode.extensions.getExtension('localpilot.localpilot-agent')!.packageJSON.contributes;
    assert.ok(c.viewsContainers.activitybar.some((v: { id: string }) => v.id === 'localpilot'));
    assert.ok(c.viewsContainers.secondarySidebar.some((v: { id: string }) => v.id === 'localpilot-secondary'));
    assert.ok(c.viewsContainers.panel.some((v: { id: string }) => v.id === 'localpilot-panel'));
    assert.deepStrictEqual(c.configuration.properties['localpilot.chat.location'].enum, ['sidebar', 'secondarySidebar', 'panel', 'editor']);
    assert.strictEqual(c.configuration.properties['localpilot.chat.location'].default, 'sidebar');
    const menus = c.menus as Record<string, { command?: string; when?: string }[]>;
    assert.ok(menus['view/title'].some((m) => m.command === 'localpilot.moveChat' && /localpilot\\?\.chatView/.test(m.when ?? '')));
    // The views exist exactly once and are never gated on the location setting: VS Code moves them (drag-and-drop,
    // Move View, Reset Location, or our vscode.moveViews call) exactly as it does for any other extension.
    const views = c.views as Record<string, { id: string; when?: string }[]>;
    assert.ok(views['localpilot'].some((v) => v.id === 'localpilot.chatView' && !v.when));
    assert.ok(views['localpilot'].some((v) => v.id === 'localpilot.agentsView' && !v.when));
    assert.deepStrictEqual(views['localpilot-secondary'], [], 'secondary side bar container is only a move destination');
    assert.deepStrictEqual(views['localpilot-panel'], [], 'panel container is only a move destination');
    for (const [, list] of Object.entries(views)) {
      for (const v of list) {
        assert.ok(!/chat\.location/.test(v.when ?? ''), `${v.id} must not be gated on the location setting`);
      }
    }
    assert.ok(menus['editor/title'].some((m) => m.command === 'localpilot.openChat' && m.when?.includes('activeWebviewPanelId != localpilot.chatPanel')), 'LocalPilot icon on every editor');
    assert.ok(menus['editor/title'].some((m) => m.command === 'localpilot.moveChat' && m.when?.includes('activeWebviewPanelId == localpilot.chatPanel')), 'Move Chat To… on the chat tab');
    const commands = await vscode.commands.getCommands(true);
    for (const id of ['localpilot.moveChat', 'localpilot.statusMenu', 'localpilot.openChatInEditor', 'vscode.moveViews', 'localpilot.chatView.focus', 'localpilot.agentsView.focus']) {
      assert.ok(commands.includes(id), `missing command ${id}`);
    }
    // Switching the setting moves the (single) chat view and reveals it; the UI must boot in its new home each time.
    const cfg = vscode.workspace.getConfiguration('localpilot');
    const before = cfg.inspect<string>('chat.location')?.globalValue;
    const api = vscode.extensions.getExtension('localpilot.localpilot-agent')!.exports as { chatHost?: { viewId: string; visible: boolean; ready: boolean } };
    const until = async (ok: () => boolean, ms = 8000) => { const t0 = Date.now(); while (!ok() && Date.now() - t0 < ms) { await new Promise((r) => setTimeout(r, 100)); } return ok(); };
    try {
      // Which workbench part hosts the view is not exposed by the API, so prove the move by closing the part it
      // should be in: the chat must disappear with it.
      const PARTS = { sidebar: 'workbench.action.closeSidebar', secondarySidebar: 'workbench.action.closeAuxiliaryBar', panel: 'workbench.action.closePanel' } as const;
      for (const loc of ['secondarySidebar', 'panel', 'sidebar'] as const) {
        await cfg.update('chat.location', loc, vscode.ConfigurationTarget.Global);
        await vscode.commands.executeCommand('localpilot.openChat');
        const shown = await until(() => api.chatHost?.viewId === 'localpilot.chatView' && api.chatHost.visible);
        assert.ok(shown, `after choosing ${loc} the chat view should be visible, got ${JSON.stringify(api.chatHost)}`);
        const booted = await until(() => api.chatHost?.viewId === 'localpilot.chatView' && api.chatHost.ready, 10_000);
        assert.ok(booted, `the chat stayed on its loading screen after moving to ${loc}, got ${JSON.stringify(api.chatHost)}`);
        // Closing the part the chat was moved to must hide it; had it stayed elsewhere, this would leave it visible.
        // (Linux under xvfb occasionally swallows a close issued right after a move — a user would click again.)
        await vscode.commands.executeCommand(PARTS[loc]);
        if (!(await until(() => !api.chatHost?.visible, 1500))) {
          await vscode.commands.executeCommand(PARTS[loc]);
        }
        assert.ok(await until(() => !api.chatHost?.visible, 3000), `closing the ${loc} should hide the chat — it is not really there: ${JSON.stringify(api.chatHost)}`);
        // The Agents view stays under the activity bar icon whatever the chat's location, so the icon never disappears.
        await vscode.commands.executeCommand('localpilot.agentsView.focus');
      }
      // The real "Move Chat To…" flow: run the command and answer its quick pick like a user would. Let the view
      // settle first: a webview that becomes visible focuses its input, which would dismiss a quick pick opening at that instant.
      // If focus still dismissed the pick (or it opened late), the setting is unchanged: try again, as a user would.
      for (let attempt = 0; attempt < 3 && vscode.workspace.getConfiguration('localpilot').get('chat.location') !== 'secondarySidebar'; attempt++) {
        await until(() => false, 800);
        const picked = vscode.commands.executeCommand('localpilot.moveChat');
        await until(() => false, 1200);
        await vscode.commands.executeCommand('workbench.action.quickOpenSelectNext');
        await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');
        await Promise.race([picked, until(() => false, 3000)]);
        await until(() => vscode.workspace.getConfiguration('localpilot').get('chat.location') === 'secondarySidebar', 1500);
      }
      assert.strictEqual(vscode.workspace.getConfiguration('localpilot').get('chat.location'), 'secondarySidebar', 'the second item (Secondary Side Bar) was accepted');
      const moved = await until(() => api.chatHost?.viewId === 'localpilot.chatView' && api.chatHost.visible && api.chatHost.ready, 10_000);
      assert.ok(moved, `Move Chat To… should show the booted chat, got ${JSON.stringify(api.chatHost)}`);
    } finally {
      await cfg.update('chat.location', before, vscode.ConfigurationTarget.Global);
      await vscode.commands.executeCommand('vscode.moveViews', { viewIds: ['localpilot.chatView', 'localpilot.agentsView'], destinationId: 'workbench.view.extension.localpilot' });
    }
  });

  test('package.json wires the settings UI: gear in chat toolbar, walkthrough, welcome setting', () => {
    const c = vscode.extensions.getExtension('localpilot.localpilot-agent')!.packageJSON.contributes;
    assert.ok(c.menus['view/title'].some((m: { command: string; when: string }) => m.command === 'localpilot.openSettings' && /localpilot\\?\.chatView/.test(m.when)));
    assert.strictEqual(c.walkthroughs[0].id, 'localpilot.gettingStarted');
    assert.ok(c.walkthroughs[0].steps.length >= 4);
    assert.strictEqual(c.configuration.properties['localpilot.showWelcomeOnStartup'].default, true);
    // The model step completes only once a model is actually reachable, not when the setup screen is opened.
    assert.deepStrictEqual(c.walkthroughs[0].steps[0].completionEvents, ['onContext:localpilot.hasModels']);
    const extPath = vscode.extensions.getExtension('localpilot.localpilot-agent')!.extensionPath;
    for (const step of c.walkthroughs[0].steps) {
      assert.ok(step.media.markdown.startsWith('media/walkthrough/'), `walkthrough media must ship in the VSIX: ${step.media.markdown}`);
      assert.ok(fs.existsSync(path.join(extPath, step.media.markdown)), `walkthrough step ${step.id} has its markdown: ${step.media.markdown}`);
    }
    for (const id of ['editor', 'extend']) {
      assert.ok(c.walkthroughs[0].steps.some((s: { id: string }) => s.id === id), `walkthrough has the ${id} step`);
    }
    // Cmd/Ctrl+Shift+L must leave the editor's Select All Occurrences alone.
    const openChatKey = (c.keybindings as { command: string; when?: string }[]).find((k) => k.command === 'localpilot.openChat');
    assert.ok(openChatKey?.when?.includes('!editorTextFocus'), `openChat keybinding must be scoped outside the text editor, got ${openChatKey?.when}`);
  });

  test('Agents view: row context menus are registered, hidden from the palette, and the title bar is gated on run state', async () => {
    const c = vscode.extensions.getExtension('localpilot.localpilot-agent')!.packageJSON.contributes;
    const menus = c.menus as Record<string, { command: string; when?: string; group?: string }[]>;
    const commands = await vscode.commands.getCommands(true);
    const rowCommands = ['localpilot.renameSession', 'localpilot.pinSession', 'localpilot.forkSession', 'localpilot.exportSession', 'localpilot.deleteSession', 'localpilot.openChangedFile'];
    for (const id of rowCommands) {
      assert.ok(commands.includes(id), `missing command ${id}`);
      assert.ok(c.commands.some((x: { command: string }) => x.command === id), `${id} is declared`);
      assert.ok(menus.commandPalette.some((m) => m.command === id && m.when === 'false'), `${id} is hidden from the Command Palette`);
      assert.ok(menus['view/item/context'].some((m) => m.command === id && /agentsView/.test(m.when ?? '')), `${id} is on an Agents-view row`);
    }
    const agentsTitle = menus['view/title'].filter((m) => /agentsView/.test(m.when ?? ''));
    assert.ok(!agentsTitle.some((m) => m.command === 'localpilot.openChat'), 'the Agents header does not repeat Open Chat');
    assert.ok(menus['view/title'].some((m) => m.command === 'localpilot.openSettings' && /chatView/.test(m.when ?? '')), 'the chat view keeps its gear');
    const when = (id: string) => agentsTitle.find((m) => m.command === id)?.when ?? '';
    assert.match(when('localpilot.pauseAll'), /localpilot\.anyRunning && !localpilot\.anyPaused/);
    assert.match(when('localpilot.resumeAll'), /localpilot\.anyPaused/);
    assert.match(when('localpilot.stopAll'), /localpilot\.anyRunning/);
    assert.match(when('localpilot.compareResults'), /localpilot\.hasBatches/);
    // Worktree actions only on isolated rows, and apply/discard never while the agent is running.
    const ctx = menus['view/item/context'];
    const apply = ctx.filter((m) => m.command === 'localpilot.applyWorktree').map((m) => m.when ?? '');
    assert.ok(apply.length && apply.every((w) => /isolated/.test(w) && !/running/.test(w)), `applyWorktree must be scoped to idle/paused isolated rows: ${apply.join(' | ')}`);
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
    assert.strictEqual(sanitizeProvider({ id: 'c', type: 'openai', baseUrl: 'http://' }).baseUrl, '');
    assert.strictEqual(sanitizeProvider({ id: 'c', type: 'openai', baseUrl: 'https://' }).baseUrl, '');
    assert.strictEqual(sanitizeProvider({ id: 'anthropic', type: 'anthropic', baseUrl: 'https://api.anthropic.com/v1', apiKey: '${env:ANTHROPIC_API_KEY}' }).type, 'anthropic');
  });

  test('sanitizeMcpServers validates names, commands and env', () => {
    const out = sanitizeMcpServers({ 'file system': { command: ' npx ', args: ['-y', 'pkg'], env: { A: 1 }, cwd: ' /tmp ', enabled: false } });
    assert.deepStrictEqual(out, { 'file-system': { command: 'npx', args: ['-y', 'pkg'], env: { A: '1' }, cwd: '/tmp', enabled: false } });
    assert.throws(() => sanitizeMcpServers({ bad: { command: '' } }), /needs a name and a command/);
    assert.throws(() => sanitizeMcpServers([]), /must be an object/);
    // Remote servers: a URL instead of a command, with optional transport and headers; non-HTTP URLs are refused.
    const remote = sanitizeMcpServers({ wiki: { url: ' https://mcp.example.com/mcp ', type: 'sse', headers: { Authorization: 'Bearer ${env:T}', ' ': 'x' }, args: ['ignored'] } });
    assert.deepStrictEqual(remote.wiki, { url: 'https://mcp.example.com/mcp', type: 'sse', headers: { Authorization: 'Bearer ${env:T}' } });
    assert.throws(() => sanitizeMcpServers({ bad: { url: 'ftp://x' } }), /must start with http/);
  });

  test('sanitizeMcpServers keeps timeout, autoApprove and the Streamable HTTP type on save', () => {
    const out = sanitizeMcpServers({
      gh: { url: 'https://api.example.com/mcp', type: 'streamableHttp', timeout: 90, autoApprove: ['list_issues', ' ', 3, 'list_issues'] },
      fs: { command: 'npx', timeout: 99999, autoApprove: [] },
      slow: { command: 'x', timeout: -1 },
    });
    assert.deepStrictEqual(out.gh, { url: 'https://api.example.com/mcp', type: 'streamableHttp', timeout: 90, autoApprove: ['list_issues'] });
    assert.deepStrictEqual(out.fs, { command: 'npx', timeout: 3600 });
    assert.deepStrictEqual(out.slow, { command: 'x' });
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

  test('provider keys typed into Settings move to secret storage and are deleted with their provider', async () => {
    const vault = new Map<string, string>();
    const changed = new vscode.EventEmitter<vscode.SecretStorageChangeEvent>();
    const storage = { get: async (k: string) => vault.get(k), store: async (k: string, v: string) => void vault.set(k, v), delete: async (k: string) => void vault.delete(k), keys: async () => [...vault.keys()], onDidChange: changed.event } as unknown as vscode.SecretStorage;
    const memo = new Map<string, unknown>();
    const state = { get: (k: string, d?: unknown) => (memo.has(k) ? memo.get(k) : d), update: async (k: string, v: unknown) => void memo.set(k, v), keys: () => [...memo.keys()] } as unknown as vscode.Memento;
    const secrets = new ProviderSecrets(storage, state);
    try {
      const [openai, env, local] = await secrets.protect([
        { id: 'openai-test', type: 'openai', baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-typed' },
        { id: 'gemini-test', type: 'openai', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', apiKey: '${env:GEMINI_API_KEY}' },
        { id: 'local-test', type: 'openai', baseUrl: 'http://localhost:1234/v1' },
      ]);
      assert.strictEqual(openai.apiKey, '${secret:openai-test}', 'a pasted key is replaced by a reference');
      assert.strictEqual(vault.get('localpilot.provider.openai-test'), 'sk-typed');
      assert.strictEqual(resolveApiKey(openai), 'sk-typed', 'the reference resolves to the stored key');
      assert.strictEqual(env.apiKey, '${env:GEMINI_API_KEY}', 'environment references are left alone');
      assert.strictEqual(local.apiKey, undefined);
      await secrets.prune([local]);
      assert.strictEqual(vault.has('localpilot.provider.openai-test'), false, 'the key of a removed provider is deleted');
      assert.strictEqual(resolveApiKey(openai), undefined);
      // A re-added provider with the same id gets its own name instead of overwriting the stored key.
      const [first] = await secrets.protect([{ id: 'openai-x', type: 'openai', baseUrl: 'https://api.openai.com/v1', apiKey: 'K1' }]);
      assert.strictEqual(first.apiKey, '${secret:openai-x}');
      const [, second] = await secrets.protect([first, { id: 'openai-x', type: 'openai', baseUrl: 'https://api.openai.com/v1', apiKey: 'K2' }]);
      assert.strictEqual(second.apiKey, '${secret:openai-x-2}');
      assert.strictEqual(vault.get('localpilot.provider.openai-x'), 'K1');
      await secrets.prune([], ['other']);
      assert.strictEqual(vault.get('localpilot.provider.openai-x'), 'K1', 'only the names a write dropped are pruned');
    } finally {
      secrets.dispose();
      changed.dispose();
    }
  });

  test('pruning provider keys keeps keys owned by other workspaces; workspace keys get their own name', async () => {
    const vault = new Map<string, string>([['localpilot.provider.other.ws-0000abcd', 'sk-other'], ['localpilot.provider.old-user', 'sk-old']]);
    const changed = new vscode.EventEmitter<vscode.SecretStorageChangeEvent>();
    const storage = { get: async (k: string) => vault.get(k), store: async (k: string, v: string) => void vault.set(k, v), delete: async (k: string) => void vault.delete(k), keys: async () => [...vault.keys()], onDidChange: changed.event } as unknown as vscode.SecretStorage;
    const memo = new Map<string, unknown>([['localpilot.providerSecretOwners', { 'other.ws-0000abcd': '0000abcd', 'old-user': 'user' }]]);
    const state = { get: (k: string, d?: unknown) => (memo.has(k) ? memo.get(k) : d), update: async (k: string, v: unknown) => void memo.set(k, v), keys: () => [...memo.keys()] } as unknown as vscode.Memento;
    const secrets = new ProviderSecrets(storage, state);
    try {
      await secrets.prune([]);
      assert.strictEqual(vault.get('localpilot.provider.other.ws-0000abcd'), 'sk-other', "another workspace's key is kept");
      assert.strictEqual(vault.has('localpilot.provider.old-user'), false, 'a stale user key is deleted');
      const [ws] = await secrets.protect([{ id: 'openai-ws', type: 'openai', baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-ws' }], 'workspace');
      assert.match(ws.apiKey!, /^\$\{secret:openai-ws\.ws-[0-9a-f]{8}\}$/);
      await secrets.prune([]);
      assert.strictEqual(vault.size, 1, "this workspace's unreferenced key is deleted, the other workspace's is kept");
    } finally {
      secrets.dispose();
      changed.dispose();
    }
  });

  test('provider edits go back to the scope that defines the providers list', () => {
    const user = [{ id: 'u', type: 'ollama' as const, baseUrl: 'http://u' }];
    const ws = [{ id: 'w', type: 'ollama' as const, baseUrl: 'http://w' }];
    const folder = [{ id: 'f', type: 'ollama' as const, baseUrl: 'http://f' }];
    const inWs = providerScope({ globalValue: user, workspaceValue: ws });
    assert.strictEqual(inWs.target, vscode.ConfigurationTarget.Workspace);
    assert.deepStrictEqual(inWs.list, ws);
    const inUser = providerScope({ globalValue: user });
    assert.strictEqual(inUser.target, vscode.ConfigurationTarget.Global);
    assert.deepStrictEqual(inUser.list, user);
    const none = providerScope(undefined);
    assert.strictEqual(none.target, vscode.ConfigurationTarget.Global);
    assert.deepStrictEqual(none.list, DEFAULT_PROVIDERS);
    const inFolder = providerScope({ globalValue: user, workspaceValue: ws, workspaceFolderValue: folder });
    assert.strictEqual(inFolder.target, vscode.ConfigurationTarget.WorkspaceFolder);
    assert.deepStrictEqual(inFolder.list, folder);
  });

  test('Settings page can edit and find the edit, internet and OTLP settings', () => {
    const ext = vscode.extensions.getExtension('localpilot.localpilot-agent')!;
    const read = (rel: string) => fs.readFileSync(path.join(ext.extensionPath, rel), 'utf8');
    const panel = read('src/ui/settingsPanel.ts');
    const webview = read('media/settings.js');
    const settingKeys = /const SETTING_KEYS = \[([\s\S]*?)\] as const;/.exec(panel)?.[1] ?? '';
    const allowed = /const ALLOWED_COMMANDS = new Set\(\[([\s\S]*?)\]\);/.exec(panel)?.[1] ?? '';
    const fieldIndex = /const FIELD_INDEX = \[([\s\S]*?)\n {2}\];/.exec(webview)?.[1] ?? '';
    assert.ok(settingKeys && allowed && fieldIndex, 'SETTING_KEYS, ALLOWED_COMMANDS and FIELD_INDEX are found');
    const props = ext.packageJSON.contributes.configuration.properties ?? Object.assign({}, ...[].concat(ext.packageJSON.contributes.configuration).map((c: { properties: object }) => c.properties));
    const keys = [
      'diffPreview', 'editTool', 'edit.reportNewErrors', 'checkpoints.enabled', 'webSearch.enabled',
      'telemetry.otlp.enabled', 'telemetry.otlp.endpoint', 'telemetry.otlp.headers', 'telemetry.otlp.metricsInterval', 'telemetry.otlp.exporters', 'telemetry.otlp.traceSamplePercent', 'telemetry.otlp.recordContent',
    ];
    for (const key of keys) {
      assert.ok(settingKeys.includes(`'${key}'`), `${key} is writable from Settings (SETTING_KEYS)`);
      assert.match(fieldIndex, new RegExp(`\\['\\w+', '${key.replace(/\./g, '\\.')}', '`), `${key} is in the settings search (FIELD_INDEX)`);
      assert.ok(props[`localpilot.${key}`], `localpilot.${key} is declared in package.json`);
    }
    assert.ok(allowed.includes(`'localpilot.telemetry.testOtlp'`), 'Settings may run the OTLP test command');
    assert.strictEqual(isUserOnlySetting('telemetry.otlp.endpoint'), true, 'OTLP export is never written to workspace settings');
    assert.strictEqual(isUserOnlySetting('telemetry.enabled'), false);
  });

  test('Settings page can edit and find the viewer, PDF and compaction settings', () => {
    const ext = vscode.extensions.getExtension('localpilot.localpilot-agent')!;
    const read = (rel: string) => fs.readFileSync(path.join(ext.extensionPath, rel), 'utf8');
    const panel = read('src/ui/settingsPanel.ts');
    const webview = read('media/settings.js');
    const settingKeys = /const SETTING_KEYS = \[([\s\S]*?)\] as const;/.exec(panel)?.[1] ?? '';
    const allowed = /const ALLOWED_COMMANDS = new Set\(\[([\s\S]*?)\]\);/.exec(panel)?.[1] ?? '';
    const fieldIndex = /const FIELD_INDEX = \[([\s\S]*?)\n {2}\];/.exec(webview)?.[1] ?? '';
    const props = ext.packageJSON.contributes.configuration.properties ?? Object.assign({}, ...[].concat(ext.packageJSON.contributes.configuration).map((c: { properties: object }) => c.properties));
    const documents = [
      'markdownViewer.scrollSync', 'markdownViewer.outlineDepth', 'markdownViewer.frontMatter', 'markdownViewer.mermaid', 'markdownViewer.exportTheme',
      'pdfViewer.pageColors', 'pdfViewer.sidebar', 'pdfViewer.defaultZoom', 'pdfViewer.rangeThresholdMB', 'pdfViewer.maxFileSizeMB', 'pdf.maxReadSizeMB', 'pdf.maxChars',
    ];
    for (const key of documents) {
      assert.ok(settingKeys.includes(`'${key}'`), `${key} is writable from Settings (SETTING_KEYS)`);
      assert.match(fieldIndex, new RegExp(`\\['documents', '${key.replace(/\./g, '\\.')}', '`), `${key} is in the settings search under Markdown & PDF`);
      assert.ok(props[`localpilot.${key}`], `localpilot.${key} is declared in package.json`);
    }
    assert.ok(settingKeys.includes(`'compaction.strategy'`), 'compaction.strategy is writable from Settings');
    assert.match(fieldIndex, /\['agent', 'compaction\.strategy', '/, 'compaction.strategy is in the settings search');
    assert.ok(props['localpilot.compaction.strategy'], 'localpilot.compaction.strategy is declared in package.json');
    for (const id of ['localpilot.openMarkdownViewer', 'localpilot.openPdf']) {
      assert.ok(allowed.includes(`'${id}'`), `Settings may run ${id}`);
    }
  });

  test('Settings page can edit and find the terminal, conversation, memory, plugin marketplace and repository settings', () => {
    const ext = vscode.extensions.getExtension('localpilot.localpilot-agent')!;
    const read = (rel: string) => fs.readFileSync(path.join(ext.extensionPath, rel), 'utf8');
    const panel = read('src/ui/settingsPanel.ts');
    const webview = read('media/settings.js');
    const settingKeys = /const SETTING_KEYS = \[([\s\S]*?)\] as const;/.exec(panel)?.[1] ?? '';
    const allowed = /const ALLOWED_COMMANDS = new Set\(\[([\s\S]*?)\]\);/.exec(panel)?.[1] ?? '';
    const fieldIndex = /const FIELD_INDEX = \[([\s\S]*?)\n {2}\];/.exec(webview)?.[1] ?? '';
    const props = ext.packageJSON.contributes.configuration.properties ?? Object.assign({}, ...[].concat(ext.packageJSON.contributes.configuration).map((c: { properties: object }) => c.properties));
    const keys: [string, string][] = [
      ['agent', 'terminal.profile'], ['agent', 'terminal.shellIntegrationTimeout'], ['agent', 'terminal.autoDetachSeconds'],
      ['memory', 'memory.autoSave'], ['memory', 'history.includeCli'], ['agent', 'preferredLanguage'], ['agent', 'showTips'],
      ['customize', 'plugins.marketplaces'], ['agent', 'repos'], ['mcp', 'mcp.watchServerFiles'],
    ];
    for (const [section, key] of keys) {
      assert.ok(settingKeys.includes(`'${key}'`), `${key} is writable from Settings (SETTING_KEYS)`);
      assert.match(fieldIndex, new RegExp(`\\['${section}', '${key.replace(/\./g, '\\.')}', '`), `${key} is in the settings search under ${section}`);
      assert.ok(props[`localpilot.${key}`], `localpilot.${key} is declared in package.json`);
    }
    for (const id of ['localpilot.selectTerminalProfile', 'workbench.action.reloadWindow', 'localpilot.browsePlugins', 'localpilot.managePlugins']) {
      assert.ok(allowed.includes(`'${id}'`), `Settings may run ${id}`);
    }
    const fromWebview = /type FromSettings =([\s\S]*?);\n/.exec(panel)?.[1] ?? '';
    assert.match(fromWebview, /\{ type: 'pickFolder'; key: string/, 'the webview can ask for a folder dialog (Browse…)');
    // The language options mirror the package.json enum.
    const langs = (props['localpilot.preferredLanguage'].enum as string[]).filter((l) => l !== 'auto');
    for (const l of langs) {
      assert.ok(webview.includes(`'${l}'`), `"${l}" is offered in Answer in`);
    }
  });

  test('every setting the Settings page writes can be found in its search, and the search hands off to VS Code settings', () => {
    const ext = vscode.extensions.getExtension('localpilot.localpilot-agent')!;
    const read = (rel: string) => fs.readFileSync(path.join(ext.extensionPath, rel), 'utf8');
    const panel = read('src/ui/settingsPanel.ts');
    const webview = read('media/settings.js');
    const settingKeys = [...(/const SETTING_KEYS = \[([\s\S]*?)\] as const;/.exec(panel)?.[1] ?? '').matchAll(/'([^']+)'/g)].map((m) => m[1]);
    const fieldIndex = /const FIELD_INDEX = \[([\s\S]*?)\n {2}\];/.exec(webview)?.[1] ?? '';
    const indexed = new Set([...fieldIndex.matchAll(/\['\w+', '([^']+)', '/g)].map((m) => m[1]));
    assert.ok(settingKeys.length > 50 && indexed.size > 50, 'SETTING_KEYS and FIELD_INDEX are found');
    const missing = settingKeys.filter((k) => !indexed.has(k));
    assert.deepStrictEqual(missing, [], `every SETTING_KEY has a FIELD_INDEX entry (missing: ${missing.join(', ')})`);
    // "Search in VS Code settings" filters the Settings editor to this extension.
    const extId = /const EXT_ID = '([^']+)'/.exec(webview)?.[1];
    assert.strictEqual(extId, `${ext.packageJSON.publisher}.${ext.packageJSON.name}`);
    const allowed = /const ALLOWED_COMMANDS = new Set\(\[([\s\S]*?)\]\);/.exec(panel)?.[1] ?? '';
    assert.ok(allowed.includes(`'workbench.action.openSettings'`), 'Settings may open the VS Code Settings editor');
    // The webview's User-only list mirrors isUserOnlySetting.
    const userOnly = /const USER_ONLY = \(k\) => (.*);/.exec(webview)?.[1] ?? '';
    for (const key of settingKeys) {
      const prefixes = [...userOnly.matchAll(/k\.startsWith\('([^']+)'\)/g)].map((m) => m[1]);
      const exact = [...userOnly.matchAll(/k === '([^']+)'/g)].map((m) => m[1]);
      assert.strictEqual(exact.includes(key) || prefixes.some((p) => key.startsWith(p)), isUserOnlySetting(key), `USER_ONLY in settings.js agrees with isUserOnlySetting for ${key}`);
    }
  });
});
