import * as assert from 'assert';
import * as fs from 'fs';
import * as http from 'http';
import { AddressInfo } from 'net';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { managedMcpServers, managedPolicyPath, normalizePolicy, policyEffectiveValues, resetManagedPolicyCache } from '../agent/managedPolicy';
import { mergeMcpLayers, policyAndSettingsLayers } from '../mcp/config';
import { McpManager } from '../mcp/mcpManager';
import { ToolRegistry } from '../tools/registry';
import { SkillManager } from '../agent/skills';
import { parseCommandFile } from '../agent/commands';
import { collectInstructionFiles } from '../context/instructions';
import { ProviderRegistry } from '../providers/registry';
import type { OtlpSettings } from '../telemetry/otlp';
import { removeTemp } from './removeTemp';

const SRC = '/etc/localpilot/managed-settings.json';
const log = { info() {}, warn() {}, error() {}, debug() {}, trace() {}, append() {}, appendLine() {} } as unknown as vscode.LogOutputChannel;

/** Runs `fn` with a policy file (and its folder for managed skills) deployed through LOCALPILOT_MANAGED_SETTINGS. */
async function withPolicy(policy: Record<string, unknown>, fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lp-org-wiring-'));
  const prev = process.env.LOCALPILOT_MANAGED_SETTINGS;
  try {
    const file = path.join(dir, 'managed-settings.json');
    fs.writeFileSync(file, JSON.stringify(policy));
    process.env.LOCALPILOT_MANAGED_SETTINGS = file;
    resetManagedPolicyCache();
    await fn(dir);
  } finally {
    if (prev === undefined) {
      delete process.env.LOCALPILOT_MANAGED_SETTINGS;
    } else {
      process.env.LOCALPILOT_MANAGED_SETTINGS = prev;
    }
    resetManagedPolicyCache();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Ollama look-alike listing two models, enough for discovery. */
function fakeOllama(): Promise<{ url: string; close(): void }> {
  const names = ['corp-coder:7b', 'other-coder:7b'];
  const srv = http.createServer((req, res) => {
    const json = (body: unknown) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(body));
    };
    if (req.url === '/api/version') {
      return json({ version: '0.6.0' });
    }
    if (req.url === '/api/tags') {
      return json({ models: names.map((n) => ({ name: n, model: n, details: { family: 'qwen2' } })) });
    }
    if (req.url === '/api/show') {
      req.resume();
      req.on('end', () => json({ capabilities: ['completion', 'tools'], model_info: { 'qwen2.context_length': 32768 }, details: { family: 'qwen2' } }));
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${(srv.address() as AddressInfo).port}`, close: () => srv.close() })));
}

suite('LocalPilot organization policy wiring (MCP layers, skills, registry, Settings values)', () => {
  const realPolicy = () => fs.existsSync(managedPolicyPath(process.platform, {}));

  test('MCP: the managed layer comes first; a user switch-off applies only to servers that are not always enabled', () => {
    const p = normalizePolicy({ mcpServers: { docs: { url: 'https://mcp.corp.example/docs', alwaysEnabled: true }, wiki: { url: 'https://mcp.corp.example/wiki' } } }, SRC);
    const layers = policyAndSettingsLayers(managedMcpServers(p), { docs: { enabled: false }, wiki: { enabled: false }, mine: { command: 'node', args: ['x.js'] } });
    assert.deepStrictEqual(layers.map((l) => l.source), ['managed', 'settings']);
    const merged = mergeMcpLayers(layers);
    assert.strictEqual(merged.docs.source, 'managed');
    assert.notStrictEqual(merged.docs.enabled, false);
    assert.strictEqual(merged.docs.url, 'https://mcp.corp.example/docs');
    assert.strictEqual(merged.wiki.source, 'managed');
    assert.strictEqual(merged.wiki.enabled, false);
    assert.strictEqual(merged.mine.source, 'settings');
  });

  test('Settings shows the value the policy applies for locked keys and approval floors', () => {
    const otlp: OtlpSettings = { enabled: true, endpoint: 'https://otel.corp.example', headers: { authorization: 'secret' }, metricsInterval: 60, exporters: ['otlp'], traceSamplePercent: 100, recordContent: false, managed: true };
    const p = normalizePolicy({ approvals: { write: 'never', terminal: 'ask' }, disableBypassPermissions: true, allowSkillInstall: false, telemetry: { otlp: { endpoint: 'https://otel.corp.example' } } }, SRC);
    const eff = policyEffectiveValues(p, { approvals: { terminal: 'always', write: 'always', delete: 'ask', network: 'always', mcp: 'always' }, telemetry: { enabled: true, otlp }, storage: { redis: { enabled: true } } });
    assert.strictEqual(eff['approvals.write'], 'never');
    assert.strictEqual(eff['approvals.terminal'], 'ask');
    assert.ok(!('approvals.delete' in eff));
    assert.strictEqual(eff['autoMode.enabled'], false);
    assert.strictEqual(eff['skills.autoInstall'], 'off');
    assert.strictEqual(eff['telemetry.enabled'], true);
    assert.strictEqual(eff['telemetry.otlp.endpoint'], 'https://otel.corp.example');
    assert.ok(!('telemetry.otlp.headers' in eff), 'collector headers are never sent to the webview');
    assert.deepStrictEqual(policyEffectiveValues(normalizePolicy({}), { approvals: { terminal: 'ask', write: 'always', delete: 'ask', network: 'always', mcp: 'always' }, telemetry: { enabled: true, otlp }, storage: { redis: { enabled: false } } }), {});
  });

  test('alwaysEnabled in a project rule or command is ignored: they can still be disabled', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lp-org-proj-'));
    try {
      const home = path.join(dir, 'home');
      const root = path.join(dir, 'proj');
      fs.mkdirSync(home);
      fs.mkdirSync(path.join(root, '.clinerules'), { recursive: true });
      const rule = path.join(root, '.clinerules', 'locked.md');
      fs.writeFileSync(rule, '---\nalwaysEnabled: true\ndisabled: true\n---\nProject rule.\n');
      const shown = (await collectInstructionFiles([root], home, { includeDisabled: true, managedDir: null })).find((f) => f.file === rule);
      assert.ok(shown?.disabled && !shown.alwaysEnabled, JSON.stringify(shown));
      assert.ok(!(await collectInstructionFiles([root], home, { managedDir: null })).some((f) => f.file === rule));
      const cmd = parseCommandFile(path.join(root, '.clinerules', 'workflows', 'ship.md'), '---\nalwaysEnabled: true\ndisabled: true\n---\nShip.', { source: 'project' });
      assert.ok(cmd.disabled && !cmd.alwaysEnabled);
      assert.strictEqual(parseCommandFile('/org/commands/ship.md', '---\nalwaysEnabled: true\ndisabled: true\n---\nShip.', { source: 'managed' }).alwaysEnabled, true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('skills: the managed folder wins over a workspace skill of the same name; only its alwaysEnabled beats skills.disabled', async function () {
    if (realPolicy()) {
      this.skip(); // a real policy is deployed on this machine
    }
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) {
      this.skip();
    }
    const wsSkills = path.join(root!, '.localpilot', 'skills');
    const mk = (base: string, name: string, extra: string) => {
      fs.mkdirSync(path.join(base, name), { recursive: true });
      fs.writeFileSync(path.join(base, name, 'SKILL.md'), `---\nname: ${name}\ndescription: ${name} skill\n${extra}---\n# ${name}\n`);
    };
    const cfg = vscode.workspace.getConfiguration('localpilot');
    const prevDisabled = cfg.inspect<string[]>('skills.disabled')?.globalValue;
    const mgr = new SkillManager(log);
    try {
      await withPolicy({ message: 'test' }, async (dir) => {
        mk(path.join(dir, 'skills'), 'org-style', 'alwaysEnabled: true\n');
        mk(wsSkills, 'org-style', '');
        mk(wsSkills, 'ws-locked', 'alwaysEnabled: true\n');
        await cfg.update('skills.disabled', ['org-style', 'ws-locked'], vscode.ConfigurationTarget.Global);
        await mgr.refresh();
        const org = mgr.getSkill('org-style');
        assert.strictEqual(org?.source, 'managed');
        assert.strictEqual(org?.dir, path.join(dir, 'skills', 'org-style'));
        assert.ok(org?.alwaysEnabled && !org.disabled, 'the organisation skill stays on despite skills.disabled');
        const ws = mgr.getSkill('ws-locked');
        assert.strictEqual(ws?.source, 'workspace');
        assert.ok(ws?.disabled && !ws.alwaysEnabled, 'a workspace skill cannot lock itself on');
      });
    } finally {
      mgr.dispose();
      await cfg.update('skills.disabled', prevDisabled, vscode.ConfigurationTarget.Global);
      removeTemp(path.join(wsSkills, 'org-style'));
      removeTemp(path.join(wsSkills, 'ws-locked'));
    }
  });

  test('MCP manager refuses to switch off an always-enabled organisation server', async function () {
    this.timeout(15_000);
    if (realPolicy()) {
      this.skip();
    }
    const missing = path.join(os.tmpdir(), 'lp-no-such-mcp-server-xyz');
    await withPolicy({ mcpServers: { required: { command: missing, alwaysEnabled: true }, optional: { command: missing } } }, async () => {
      const mcp = new McpManager(new ToolRegistry(), log, '0.0.0-test');
      try {
        await mcp.reload();
        assert.ok(mcp.isAlwaysEnabled('required') && !mcp.isAlwaysEnabled('optional'));
        await assert.rejects(mcp.setEnabled('required', false), /organization/);
        await assert.rejects(mcp.setSessionEnabled('required', false), /organization/);
        await mcp.setSessionEnabled('optional', false);
      } finally {
        mcp.dispose();
      }
    });
  });

  test('registry: a model off allowedModels is not listed, and route() says why', async function () {
    this.timeout(30_000);
    if (realPolicy()) {
      this.skip();
    }
    const srv = await fakeOllama();
    const cfg = vscode.workspace.getConfiguration('localpilot');
    const prev = { providers: cfg.inspect('providers')?.globalValue, disabled: cfg.inspect('models.disabled')?.globalValue, def: cfg.inspect('defaultModel')?.globalValue };
    let reg: ProviderRegistry | undefined;
    try {
      await cfg.update('providers', [{ id: 'fake', type: 'ollama', baseUrl: srv.url }], vscode.ConfigurationTarget.Global);
      await cfg.update('models.disabled', [], vscode.ConfigurationTarget.Global);
      await cfg.update('defaultModel', '', vscode.ConfigurationTarget.Global);
      await withPolicy({ allowedModels: ['fake/corp-*'] }, async () => {
        reg = new ProviderRegistry(log);
        const listed = (await reg.listModels(true)).map((m) => m.id);
        assert.ok(listed.includes('fake/corp-coder:7b'), listed.join(','));
        assert.ok(!listed.includes('fake/other-coder:7b'), listed.join(','));
        const r = await reg.route({ modelRef: 'fake/other-coder:7b', start: false });
        assert.strictEqual(r.model.id, 'fake/corp-coder:7b');
        assert.match(r.reason ?? '', /allowlist/);
      });
    } finally {
      reg?.dispose();
      srv.close();
      await cfg.update('providers', prev.providers, vscode.ConfigurationTarget.Global);
      await cfg.update('models.disabled', prev.disabled, vscode.ConfigurationTarget.Global);
      await cfg.update('defaultModel', prev.def, vscode.ConfigurationTarget.Global);
    }
  });
});
