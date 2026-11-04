import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getConfig } from '../config';
import { managedMcpServers, managedPolicyPath, mcpServerBlocked, mergeManagedProviders, modelAllowed, normalizePolicy, policyLocks, policyTelemetry, resetManagedPolicyCache } from '../agent/managedPolicy';
import { collectInstructionFiles } from '../context/instructions';
import { discoverCommands } from '../agent/commands';
import { ProviderConfig } from '../types';
import type { OtlpSettings } from '../telemetry/otlp';

const SRC = '/etc/localpilot/managed-settings.json';

suite('LocalPilot organization policy (providers, MCP, telemetry, managed folder)', () => {
  test('Settings locks: floors, auto mode and telemetry export', () => {
    const l = policyLocks(normalizePolicy({ approvals: { write: 'ask', network: 'never' }, disableBypassPermissions: true, telemetry: { otlp: { endpoint: 'https://otel.corp.example' } } }, SRC))!;
    assert.deepStrictEqual(l.disabledOptions['approvals.write'], ['always']);
    assert.ok(l.locked['approvals.network'] && l.locked['autoMode.enabled'] && l.locked['telemetry.enabled'] && l.locked['storage.redis.enabled']);
    assert.strictEqual(l.telemetryEndpoint, 'https://otel.corp.example');
    assert.strictEqual(policyLocks(normalizePolicy({})), undefined);
  });

  test('providers are merged in and locked; models are filtered by glob', () => {
    const p = normalizePolicy({ providers: [{ id: 'corp', type: 'openai', baseUrl: 'https://llm.corp.example/v1/' }], allowedModels: ['corp/*'] }, SRC);
    const merged = mergeManagedProviders([{ id: 'corp', type: 'ollama', baseUrl: 'http://x', apiKey: 'k' } as ProviderConfig], p);
    assert.deepStrictEqual(merged, [{ id: 'corp', type: 'openai', baseUrl: 'https://llm.corp.example/v1', apiKey: 'k' }]);
    assert.ok(modelAllowed(p, 'corp/big') && !modelAllowed(p, 'ollama/big'));
  });

  test('MCP: organisation servers, personal remote servers and pinned allowlist entries', () => {
    const p = normalizePolicy({ mcpServers: { docs: { url: 'https://mcp.corp.example/docs', alwaysEnabled: true } }, blockPersonalRemoteMcp: true, allowedMcpServers: [{ name: 'docs2', url: 'https://mcp.corp.example/docs2' }, 'local'] }, SRC);
    assert.deepStrictEqual(managedMcpServers(p).alwaysEnabled, ['docs']);
    assert.strictEqual(mcpServerBlocked(p, 'docs', { source: 'managed', url: 'https://mcp.corp.example/docs' }), undefined);
    assert.ok(mcpServerBlocked(p, 'mine', { source: 'user', url: 'https://example.com/mcp' }));
    assert.ok(mcpServerBlocked(p, 'docs2', { source: 'user', url: 'https://example.com/docs2' }));
    assert.strictEqual(mcpServerBlocked(p, 'docs2', { source: 'user', url: 'https://mcp.corp.example/docs2' }), undefined);
    assert.strictEqual(mcpServerBlocked(p, 'local', { source: 'settings', command: 'node' }), undefined);
  });

  test('telemetry: the organisation collector ignores the user opt-out', () => {
    const t = policyTelemetry(normalizePolicy({ telemetry: { otlp: { endpoint: 'https://otel.corp.example' } } }, SRC), { enabled: false, otlp: { enabled: false, endpoint: 'http://localhost:4318', headers: {}, metricsInterval: 60, exporters: ['otlp'], traceSamplePercent: 100, recordContent: false } as OtlpSettings });
    assert.ok(t.enabled && t.otlp.enabled && t.otlp.managed);
    assert.strictEqual(t.otlp.endpoint, 'https://otel.corp.example');
  });

  test('getConfig applies a deployed policy: providers merged, Redis and OTLP export off', function () {
    if (fs.existsSync(managedPolicyPath(process.platform, {}))) {
      this.skip(); // a real policy is deployed on this machine
    }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lp-org-cfg-'));
    const file = path.join(dir, 'managed-settings.json');
    const prev = process.env.LOCALPILOT_MANAGED_SETTINGS;
    try {
      fs.writeFileSync(file, JSON.stringify({ providers: [{ id: 'corp-test', type: 'openai', baseUrl: 'https://llm.corp.example/v1' }], telemetry: {} }));
      process.env.LOCALPILOT_MANAGED_SETTINGS = file;
      resetManagedPolicyCache();
      const cfg = getConfig();
      assert.strictEqual(cfg.providers[0].id, 'corp-test');
      assert.strictEqual(cfg.storage.redis.enabled, false);
      assert.strictEqual(cfg.telemetry.otlp.enabled, false);
    } finally {
      process.env.LOCALPILOT_MANAGED_SETTINGS = prev;
      if (prev === undefined) {
        delete process.env.LOCALPILOT_MANAGED_SETTINGS;
      }
      resetManagedPolicyCache();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('managed rules and commands: an extra layer with source managed; alwaysEnabled cannot be switched off', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lp-org-dir-'));
    try {
      const home = path.join(dir, 'home');
      fs.mkdirSync(path.join(dir, 'rules'), { recursive: true });
      fs.mkdirSync(path.join(dir, 'commands'));
      fs.mkdirSync(home);
      fs.writeFileSync(path.join(dir, 'rules', 'a.md'), '---\nalwaysEnabled: true\ndisabled: true\n---\nOrg rule.\n');
      fs.writeFileSync(path.join(dir, 'commands', 'ship.md'), '---\nalwaysEnabled: yes\n---\nShip it.\n');
      const files = await collectInstructionFiles([], home, { managedDir: path.join(dir, 'rules') });
      assert.strictEqual(files.length, 1);
      assert.strictEqual(files[0].scope, 'managed');
      assert.ok(files[0].alwaysEnabled && !files[0].disabled);
      const cmds = await discoverCommands([], { home, managedDir: path.join(dir, 'commands') });
      const ship = cmds.find((c) => c.invoke === '/ship');
      assert.strictEqual(ship?.source, 'managed');
      assert.strictEqual(ship?.alwaysEnabled, true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
