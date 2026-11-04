/**
 * Smoke checks (bundled into scripts/smoke.ts) for the organisation policy's per-control locks, its providers and
 * model allowlist, its MCP servers and allowlist, its telemetry policy, and the managed rules, skills and commands folder.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { mcpServerAllowed, mcpServerBlocked, managedDir, managedMcpServers, mergeManagedProviders, modelAllowed, normalizePolicy, policyLocks, policyRedis, policyTelemetry, isManagedProvider, describePolicy } from '../src/agent/managedPolicy';
import { collectInstructionFiles } from '../src/context/instructions';
import { discoverCommands } from '../src/agent/commands';
import { ProviderConfig } from '../src/types';

type Check = (name: string, cond: boolean, detail?: unknown) => void;

const SRC = '/etc/localpilot/managed-settings.json';
const OTLP = { enabled: false, endpoint: 'http://localhost:4318', headers: { a: 'b' }, metricsInterval: 60, exporters: ['otlp'], traceSamplePercent: 100, recordContent: false };

export async function orgPolicySmoke(check: Check): Promise<void> {
  console.log('\n[Organization policy: locks, providers, MCP, telemetry, managed folder]');
  const p = normalizePolicy({ approvals: { terminal: 'ask', delete: 'never' }, disableBypassPermissions: true, allowSkillInstall: false, telemetry: { allowRemoteExport: false } }, SRC);
  const locks = policyLocks(p)!;
  check('G1 locks: a "never" floor locks the setting, an "ask" floor disables Allow', !!locks.locked['approvals.delete'] && !locks.locked['approvals.terminal'] && locks.disabledOptions['approvals.terminal']?.join() === 'always', locks);
  check('G1 locks: auto mode, skill downloads, Redis and OTLP export locked', !!locks.locked['autoMode.enabled'] && !!locks.locked['skills.autoInstall'] && !!locks.locked['storage.redis.enabled'] && !!locks.locked['telemetry.otlp.enabled'] && !locks.locked['telemetry.enabled']);
  check('G1 locks: none without a deployed policy', policyLocks(normalizePolicy({})) === undefined);

  const corp: ProviderConfig = { id: 'corp', type: 'openai', baseUrl: 'https://llm.corp.example/v1', headers: { 'X-Team': 'eng' } } as ProviderConfig;
  const pp = normalizePolicy({ providers: [corp, { id: 'broken' }], allowedModels: ['corp/*', 'ollama/qwen*'], allowCloudProviders: false }, SRC);
  const user = [{ id: 'corp', type: 'openai', baseUrl: 'https://evil.example/v1', apiKey: '${secret:corp}' }, { id: 'ollama', type: 'ollama', baseUrl: 'http://localhost:11434' }] as ProviderConfig[];
  const merged = mergeManagedProviders(user, pp);
  check('G2 providers: the organisation wins, only the user key is kept', merged.length === 2 && merged[0].baseUrl === corp.baseUrl && merged[0].apiKey === '${secret:corp}' && merged[0].headers?.['X-Team'] === 'eng' && merged[1].id === 'ollama', merged);
  check('G2 providers: entries without id or baseUrl are dropped', pp.providers?.length === 1);
  check('G2 providers: exempt from the cloud limit only as configured', isManagedProvider(pp, corp) && !isManagedProvider(pp, { id: 'corp', baseUrl: 'https://evil.example/v1' }));
  check('G2 models: globs over provider/model', modelAllowed(pp, 'corp/gpt-4o') && modelAllowed(pp, 'ollama/qwen2.5-coder:7b') && !modelAllowed(pp, 'ollama/llama3') && modelAllowed(normalizePolicy({}), 'x/y'));
  check('G2 locks: providers sent without keys', policyLocks(normalizePolicy({ providers: [{ ...corp, apiKey: 'sk-secret' }] }, SRC))!.providers[0].apiKey === undefined);

  const mp = normalizePolicy({ mcpServers: { docs: { url: 'https://mcp.corp.example/docs', alwaysEnabled: true }, wiki: { command: 'wiki-mcp' } }, blockPersonalRemoteMcp: true, allowedMcpServers: ['github', { name: 'jira', url: 'https://mcp.corp.example/jira/' }, { name: 'fs', command: 'npx' }] }, SRC);
  const org = managedMcpServers(mp);
  check('G3 MCP: organisation servers, alwaysEnabled stripped and listed', org.alwaysEnabled.join() === 'docs' && !('alwaysEnabled' in org.servers.docs) && org.servers.docs.enabled === true && !!org.servers.wiki);
  check('G3 MCP: the organisation servers always start', mcpServerAllowed(mp, 'docs', { source: 'managed', url: 'https://mcp.corp.example/docs' }));
  check('G3 MCP: a personal remote server is blocked', !!mcpServerBlocked(mp, 'github', { source: 'settings', url: 'https://api.github.example/mcp' }));
  check('G3 MCP: an allowed name pointed at another URL is blocked', !mcpServerAllowed(mp, 'jira', { source: 'settings', url: 'https://attacker.example/jira' }) && mcpServerAllowed(mp, 'jira', { source: 'settings', url: 'https://mcp.corp.example/jira' }));
  check('G3 MCP: a pinned command matches by program name', mcpServerAllowed(mp, 'fs', { source: 'user', command: '/usr/local/bin/npx' }) && !mcpServerAllowed(mp, 'fs', { source: 'user', command: 'node' }));
  check('G3 MCP: names off the allowlist stay blocked; name-only entries accept any local command', !mcpServerAllowed(mp, 'other', { command: 'x' }) && mcpServerAllowed(mp, 'github', { command: 'gh-mcp' }));
  check('G3 MCP: the string-only allowlist still works', mcpServerAllowed(normalizePolicy({ allowedMcpServers: ['github'] }, SRC), 'github') && describePolicy(mp).some((l) => /jira \(https:\/\/mcp\.corp\.example\/jira\/\)/.test(l)));

  const t = { enabled: false, retentionDays: 30, otlp: { ...OTLP, enabled: true } };
  const none = policyTelemetry(normalizePolicy({}), t);
  check('G4 telemetry: no policy leaves the settings alone', none === t && policyRedis(normalizePolicy({}), { enabled: true, url: 'r' }).enabled);
  const off = normalizePolicy({ telemetry: {} }, SRC);
  check('G4 telemetry: a policy without allowRemoteExport turns the user export and Redis off', !policyTelemetry(off, t).otlp.enabled && !policyRedis(off, { enabled: true, url: 'r' }).enabled && policyTelemetry(off, t).enabled === false);
  const allow = normalizePolicy({ telemetry: { allowRemoteExport: true, enabled: true } }, SRC);
  check('G4 telemetry: allowRemoteExport keeps the user export; enabled forces recording', policyTelemetry(allow, t).otlp.enabled && policyTelemetry(allow, t).enabled && policyRedis(allow, { enabled: true, url: 'r' }).enabled);
  const orgT = policyTelemetry(normalizePolicy({ telemetry: { otlp: { endpoint: 'https://otel.corp.example:4318', headers: { k: 'v' } } } }, SRC), t);
  check('G4 telemetry: the organisation collector wins over the opt-out and drops the user headers', orgT.enabled && orgT.otlp.enabled && orgT.otlp.managed === true && orgT.otlp.endpoint === 'https://otel.corp.example:4318' && orgT.otlp.headers.k === 'v' && !('a' in orgT.otlp.headers), orgT);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lp-org-'));
  try {
    const policyFile = path.join(dir, 'managed-settings.json');
    check('G5 managed folders sit next to the policy file', managedDir('rules', policyFile) === path.join(dir, 'rules') && managedDir('commands', policyFile) === path.join(dir, 'commands'));
    fs.mkdirSync(path.join(dir, 'rules'));
    fs.writeFileSync(path.join(dir, 'rules', 'security.md'), '---\nalwaysEnabled: true\ndisabled: true\n---\nNever log secrets.\n');
    fs.writeFileSync(path.join(dir, 'rules', 'style.md'), '---\ndisabled: true\n---\nTabs.\n');
    const home = path.join(dir, 'home');
    fs.mkdirSync(home);
    const files = await collectInstructionFiles([], home, { managedDir: managedDir('rules', policyFile), includeDisabled: true });
    const sec = files.find((f) => f.name === 'security');
    check('G5 rules: loaded with scope managed, last in prompt order; alwaysEnabled beats disabled', !!sec && sec.scope === 'managed' && sec.alwaysEnabled === true && !sec.disabled && files[files.length - 1].scope === 'managed' && !!files.find((f) => f.name === 'style')?.disabled, files);
    fs.mkdirSync(path.join(dir, 'commands'));
    fs.writeFileSync(path.join(dir, 'commands', 'deploy.md'), '---\ndescription: org deploy\nalwaysEnabled: true\n---\nDeploy.\n');
    fs.mkdirSync(path.join(home, '.localpilot', 'commands'), { recursive: true });
    fs.writeFileSync(path.join(home, '.localpilot', 'commands', 'deploy.md'), '---\ndescription: mine\n---\nMine.\n');
    const cmds = await discoverCommands([], { home, managedDir: managedDir('commands', policyFile) });
    const deploy = cmds.find((c) => c.invoke === '/deploy');
    check('G5 commands: the organisation command takes the name, alwaysEnabled set', deploy?.source === 'managed' && deploy.alwaysEnabled === true && deploy.description === 'org deploy', deploy);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
