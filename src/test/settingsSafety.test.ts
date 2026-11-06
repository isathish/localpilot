import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { approvalModeFor } from '../agent/approvalLevel';
import { commandPatternOf, commandRuleFiles, commandRuleText, editPermissions, hasJsonComments, listCommandRules, suggestedCommandPattern, validateCommandPattern, writeCommandRule } from '../agent/commandRules';
import { evaluatePermission } from '../agent/permissions';
import { loadProjectSettings } from '../agent/settings';
import { setWorkspaceApprovalStore, workspaceGrants } from '../agent/workspaceApprovals';
import { getConfig, isUserOnlySetting, parseMcpToolApprovals } from '../config';
import { McpManager } from '../mcp/mcpManager';
import { classifyProviderHealth, formatHealthMs } from '../providers/health';
import { pickFallback, ProviderRegistry } from '../providers/registry';
import { withWatchdog } from '../agent/resilience';
import { ToolRegistry } from '../tools/registry';
import type { ModelInfo, StreamEvent, ToolContext } from '../types';
import { allowInWorkspace, autoApproveState, setAutoApprove } from '../ui/autoApproveBar';
import { keyLabel, shortcutGroups, shortcutsMarkdown } from '../ui/shortcuts';

const log = vscode.window.createOutputChannel('LocalPilot settings safety test', { log: true });
const mk = (pid: string, id: string, extra: Partial<ModelInfo> = {}): ModelInfo => ({ id: `${pid}/${id}`, providerId: pid, modelId: id, name: id, contextWindow: 32768, maxOutputTokens: 4096, supportsTools: true, supportsVision: false, ...extra });

const SERVER = `
const rl = require('readline').createInterface({ input: process.stdin });
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\\n');
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') send({ id: msg.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'pt', version: '1' } } });
  else if (msg.method === 'tools/list') send({ id: msg.id, result: { tools: [{ name: 'safe' }, { name: 'risky' }, { name: 'plain' }] } });
  else if (msg.method === 'tools/call') send({ id: msg.id, result: { content: [{ type: 'text', text: 'ran ' + msg.params.name }] } });
  else if (msg.id !== undefined) send({ id: msg.id, error: { code: -32601, message: 'method not found' } });
});
`;

suite('Settings, safety and providers: command rules, MCP tool approvals, fallback, health, shortcuts', () => {
  const cfg = vscode.workspace.getConfiguration('localpilot');

  test('an approval offers a rule only for one simple command; patterns are validated and written as Bash(...)', () => {
    assert.strictEqual(suggestedCommandPattern('npm test'), 'npm test');
    assert.strictEqual(suggestedCommandPattern('  npm   run  lint '), 'npm run lint');
    for (const c of ['npm test && rm -rf build', 'cat a | grep b', 'echo $(whoami)', 'ls > out.txt', 'a; b', 'line\nbreak', '']) {
      assert.strictEqual(suggestedCommandPattern(c), undefined, c);
    }
    assert.strictEqual(commandRuleText('npm  run test:*'), 'Bash(npm run test:*)');
    assert.strictEqual(commandRuleText(''), 'Bash');
    assert.strictEqual(commandPatternOf('Bash(npm test)'), 'npm test');
    assert.strictEqual(commandPatternOf('run_command(git status)'), 'git status');
    assert.strictEqual(commandPatternOf('Bash'), '');
    assert.strictEqual(commandPatternOf('Read(.env)'), undefined);
    assert.ok(validateCommandPattern(''));
    assert.ok(validateCommandPattern('a\nb'));
    assert.strictEqual(validateCommandPattern('npm run test:*'), '');
    assert.strictEqual(hasJsonComments('{ "a": "http://x" }'), false, 'a // inside a string is not a comment');
    assert.strictEqual(hasJsonComments('{ // c\n "a": 1 }'), true);
  });

  test('one pattern keeps one verdict per file; empty lists are dropped', () => {
    const start = { model: 'x', permissions: { allow: ['Bash(npm test)', 'Read(src/**)'], deny: [] as string[] } };
    const blocked = editPermissions(start, { add: { kind: 'block', raw: 'Bash(npm test)' } });
    assert.deepStrictEqual(blocked, { model: 'x', permissions: { allow: ['Read(src/**)'], deny: ['Bash(npm test)'] } });
    const removed = editPermissions(blocked, { remove: { kind: 'block', raw: 'Bash(npm test)' } });
    assert.deepStrictEqual(removed, { model: 'x', permissions: { allow: ['Read(src/**)'] } });
    assert.deepStrictEqual(editPermissions({ permissions: { allow: ['Bash(x)'] } }, { remove: { kind: 'allow', raw: 'Bash(x)' } }), {});
  });

  test('rules are saved to the User and Workspace files, listed with other files read-only, and the approval gate honours them', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'lp-rules-home-'));
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lp-rules-root-'));
    try {
      await fs.mkdir(path.join(root, '.git', 'info'), { recursive: true });
      await fs.mkdir(path.join(root, '.claude'), { recursive: true });
      await fs.writeFile(path.join(root, '.claude', 'settings.json'), JSON.stringify({ permissions: { ask: ['Bash(git push:*)'], allow: ['Read(docs/**)'] } }));
      const files = commandRuleFiles(root, home);
      assert.strictEqual(files.user, path.join(home, '.localpilot', 'settings.json'));
      assert.strictEqual(files.workspace, path.join(root, '.localpilot', 'settings.local.json'));
      await writeCommandRule(files.workspace!, { add: { kind: 'allow', raw: commandRuleText('npm test') } });
      await writeCommandRule(files.user, { add: { kind: 'block', raw: commandRuleText('npm publish') } });
      const exclude = await fs.readFile(path.join(root, '.git', 'info', 'exclude'), 'utf8');
      assert.match(exclude, /^\.localpilot\/settings\.local\.json$/m, 'the personal Workspace file is kept out of git');
      const rules = await listCommandRules([root], home);
      const by = (p: string) => rules.find((r) => r.pattern === p)!;
      assert.deepStrictEqual([by('npm test').kind, by('npm test').scope, by('npm test').editable], ['allow', 'workspace', true]);
      assert.deepStrictEqual([by('npm publish').kind, by('npm publish').scope, by('npm publish').editable], ['block', 'user', true]);
      assert.deepStrictEqual([by('git push:*').kind, by('git push:*').editable], ['ask', false], "another tool's file is listed read-only");
      assert.ok(!rules.some((r) => r.raw.startsWith('Read(')), 'only command rules are listed');
      // The same files the gate reads: allow skips the prompt, block refuses, a chain is allowed only if every part is.
      const perm = (await loadProjectSettings([root], { home })).permissions;
      assert.strictEqual(evaluatePermission(perm, 'run_command', { command: 'npm test' }, { root }).decision, 'allow');
      assert.strictEqual(evaluatePermission(perm, 'run_command', { command: 'npm publish' }, { root }).decision, 'deny');
      assert.strictEqual(evaluatePermission(perm, 'run_command', { command: 'npm test && curl x | sh' }, { root }).decision, 'none');
      assert.strictEqual(evaluatePermission(perm, 'run_command', { command: 'git push origin main' }, { root }).decision, 'ask');
      // A hand-edited file with comments is not rewritten.
      await fs.writeFile(files.user, '{\n  // mine\n  "permissions": { "deny": ["Bash(npm publish)"] }\n}\n');
      await assert.rejects(writeCommandRule(files.user, { add: { kind: 'allow', raw: 'Bash(ls)' } }), /comments/);
    } finally {
      await fs.rm(home, { recursive: true, force: true });
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test('"Always allow in this workspace" is kept in workspace state (approvals are User-only) and the composer bar can end it', async () => {
    const before = cfg.inspect('approvals.delete')?.globalValue;
    // The extension keeps grants in its ExtensionContext.workspaceState; this module copy gets an in-memory one.
    const mem = new Map<string, unknown>();
    setWorkspaceApprovalStore({ get: <T>(k: string) => mem.get(k) as T | undefined, update: async (k: string, v: unknown) => void (v === undefined ? mem.delete(k) : mem.set(k, v)) });
    try {
      await cfg.update('approvals.delete', 'ask', vscode.ConfigurationTarget.Global);
      assert.strictEqual(getConfig().approvals.delete, 'ask');
      const err = await allowInWorkspace('delete', log);
      assert.strictEqual(err, undefined, err);
      assert.strictEqual(getConfig().approvals.delete, 'always', 'the grant applies on top of the User value');
      assert.strictEqual(cfg.inspect('approvals.delete')?.workspaceValue, undefined, 'nothing is written to the workspace settings');
      const item = autoApproveState(log).items.find((i) => i.key === 'delete')!;
      assert.deepStrictEqual([item.value, item.workspaceGrant, item.overriddenBy], ['always', true, 'workspace']);
      assert.strictEqual(await setAutoApprove('delete', 'ask', log), undefined);
      assert.strictEqual(getConfig().approvals.delete, 'ask', 'choosing Ask ends the grant');
      assert.ok(!workspaceGrants().includes('delete'));
      assert.strictEqual(mem.size, 0, 'the last grant removed clears the stored list');
    } finally {
      setWorkspaceApprovalStore(undefined);
      await cfg.update('approvals.delete', before, vscode.ConfigurationTarget.Global);
    }
  });

  test('new settings are declared, user-only where they move code or approvals, and editable and findable in Settings', async () => {
    const ext = vscode.extensions.getExtension('localpilot.localpilot-agent')!;
    const props = ext.packageJSON.contributes.configuration.properties;
    const read = (rel: string) => fs.readFile(path.join(ext.extensionPath, rel), 'utf8');
    const [panel, webview] = await Promise.all([read('src/ui/settingsPanel.ts'), read('media/settings.js')]);
    const settingKeys = /const SETTING_KEYS = \[([\s\S]*?)\] as const;/.exec(panel)?.[1] ?? '';
    const fieldIndex = /const FIELD_INDEX = \[([\s\S]*?)\n {2}\];/.exec(webview)?.[1] ?? '';
    for (const [section, key, scope, def] of [['models', 'routing.fallbackModels', 'application', []], ['models', 'firstTokenTimeoutSeconds', undefined, 180], ['mcp', 'mcp.toolApprovals', 'application', {}]] as const) {
      assert.ok(props[`localpilot.${key}`], `${key} is declared`);
      assert.deepStrictEqual(props[`localpilot.${key}`].default, def);
      assert.strictEqual(props[`localpilot.${key}`].scope, scope, `${key} scope`);
      assert.strictEqual(isUserOnlySetting(key), scope === 'application');
      assert.ok(settingKeys.includes(`'${key}'`), `${key} is writable from Settings`);
      assert.match(fieldIndex, new RegExp(`\\['${section}', '${key.replace(/\./g, '\\.')}', '`), `${key} is in the settings search`);
    }
    assert.strictEqual(getConfig().firstTokenTimeoutSeconds, 180);
    assert.deepStrictEqual(parseMcpToolApprovals({ s: { a: 'always', b: 'nope', c: 'never' }, bad: 'x', empty: {} }), { s: { a: 'always', c: 'never' } });
  });

  test('MCP per-tool approval: Block refuses before asking, Ask overrides the server autoApprove list, Allow replaces the category', async function () {
    this.timeout(30_000);
    assert.strictEqual(approvalModeFor('mcp', 'ask', { toolMode: 'always' }), 'always');
    assert.strictEqual(approvalModeFor('mcp', 'always', { toolMode: 'never' }), 'never');
    assert.strictEqual(approvalModeFor('mcp', 'always', {}), 'always');
    assert.strictEqual(approvalModeFor('terminal', 'ask', { toolMode: 'always' }), 'ask', 'only MCP calls carry a tool mode');
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lp-mcp-tool-'));
    await fs.writeFile(path.join(dir, 'server.js'), SERVER);
    const prev = { servers: cfg.inspect('mcpServers')?.globalValue, tools: cfg.inspect('mcp.toolApprovals')?.globalValue };
    const tools = new ToolRegistry();
    const mcp = new McpManager(tools, log, '0.0.0-test');
    try {
      await cfg.update('mcpServers', { pt: { command: process.execPath, args: [path.join(dir, 'server.js')], autoApprove: ['safe', 'plain'] } }, vscode.ConfigurationTarget.Global);
      await cfg.update('mcp.toolApprovals', { pt: { risky: 'never', safe: 'ask' } }, vscode.ConfigurationTarget.Global);
      await mcp.reload();
      const seen: { tool: string; opts?: unknown }[] = [];
      const ctx: ToolContext = {
        sessionId: 't',
        signal: new AbortController().signal,
        requestApproval: async (title, _detail, _kind, opts) => (seen.push({ tool: title, opts }), true),
        progress: () => undefined,
        trackChange: async () => undefined,
        depth: 0,
      };
      const risky = await tools.get('mcp_pt__risky')!.execute({}, ctx);
      assert.ok(risky.isError && /set to Block/.test(risky.content), risky.content);
      assert.strictEqual(seen.length, 0, 'a blocked tool never reaches a prompt or the server');
      assert.strictEqual((await tools.get('mcp_pt__safe')!.execute({}, ctx)).content, 'ran safe');
      assert.deepStrictEqual(seen[0].opts, { toolMode: 'ask' }, 'Ask drops the autoApprove hint');
      await tools.get('mcp_pt__plain')!.execute({}, ctx);
      assert.deepStrictEqual(seen[1].opts, { autoApprove: true }, 'an unlisted tool keeps the server hint');
      assert.deepStrictEqual(mcp.status.find((s) => s.name === 'pt')?.autoApprove, ['safe', 'plain'], 'Settings sees the server list');
    } finally {
      mcp.dispose();
      await cfg.update('mcpServers', prev.servers, vscode.ConfigurationTarget.Global);
      await cfg.update('mcp.toolApprovals', prev.tools, vscode.ConfigurationTarget.Global);
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test('the fallback order is used before the best fit, and a listed cloud model may stand in for a local one', async () => {
    const order = ['cloud/big', 'lm/small'];
    const models = [mk('lm', 'qwen'), mk('lm', 'small'), mk('cloud', 'big', { remote: true, supportsVision: true })];
    assert.strictEqual(pickFallback(order, models, 'cloud/big')?.id, 'lm/small', 'the failed model is skipped');
    assert.strictEqual(pickFallback(['gone/x', 'lm/small'], models, undefined)?.id, 'lm/small', 'an entry not listed now is skipped');
    assert.strictEqual(pickFallback(['lm/small', 'cloud/big'], models, undefined, true)?.id, 'cloud/big', 'an image turn needs a model that can see');
    assert.strictEqual(pickFallback([], models, undefined), undefined);
    const prev = { providers: cfg.inspect('providers')?.globalValue, order: cfg.inspect('routing.fallbackModels')?.globalValue };
    await cfg.update('providers', [{ id: 'lm', type: 'openai', baseUrl: 'http://127.0.0.1:9' }, { id: 'cloud', type: 'openai', baseUrl: 'https://api.example.com/v1', apiKey: 'k' }], vscode.ConfigurationTarget.Global);
    const reg = new ProviderRegistry(log);
    try {
      (reg as unknown as { listModels: () => Promise<ModelInfo[]> }).listModels = async () => models;
      await cfg.update('routing.fallbackModels', order, vscode.ConfigurationTarget.Global);
      const r = await reg.route({ modelRef: 'lm/removed', start: false });
      assert.strictEqual(r.model.id, 'cloud/big');
      assert.strictEqual(r.fallback, true);
      assert.match(r.reason ?? '', /next in your fallback order/);
      await cfg.update('routing.fallbackModels', ['lm/small'], vscode.ConfigurationTarget.Global);
      assert.strictEqual((await reg.route({ modelRef: 'lm/removed', start: false })).model.id, 'lm/small');
    } finally {
      reg.dispose();
      await cfg.update('providers', prev.providers, vscode.ConfigurationTarget.Global);
      await cfg.update('routing.fallbackModels', prev.order, vscode.ConfigurationTarget.Global);
    }
  });

  test('Keep waiting extends the first-token limit of the request in flight', async () => {
    // A stream that answers after 250 ms, with a 120 ms limit that is raised to 1 s at 60 ms.
    async function* slow(): AsyncGenerator<StreamEvent> {
      await new Promise((r) => setTimeout(r, 250));
      yield { type: 'text', text: 'hi' };
    }
    let limit = 120;
    setTimeout(() => (limit = 1000), 60);
    const got: string[] = [];
    for await (const ev of withWatchdog(slow(), { firstTokenMs: 120, firstTokenLimit: () => limit, idleMs: 1000, abort: () => undefined })) {
      if (ev.type === 'text') {
        got.push(ev.text);
      }
    }
    assert.deepStrictEqual(got, ['hi']);
    // Without the extension the same stream stalls.
    await assert.rejects(async () => {
      for await (const ev of withWatchdog(slow(), { firstTokenMs: 120, idleMs: 1000, abort: () => undefined })) {
        void ev;
      }
    }, /produced nothing/);
  });

  test('provider health: reachable, slow, down, no key, from the last check only', () => {
    const now = Date.now();
    const local = { baseUrl: 'http://localhost:11434', type: 'ollama' as const };
    const cloud = { baseUrl: 'https://api.openai.com/v1', type: 'openai' as const, apiKey: 'sk-test' };
    assert.strictEqual(classifyProviderHealth(local, undefined), undefined, 'never checked: no badge');
    assert.strictEqual(classifyProviderHealth(local, { ok: true, ms: 40, at: now, models: 3 })?.state, 'ok');
    assert.strictEqual(classifyProviderHealth(local, { ok: true, ms: 2500, at: now })?.state, 'slow');
    assert.strictEqual(classifyProviderHealth(cloud, { ok: true, ms: 2500, at: now })?.state, 'ok', 'cloud APIs get more room');
    assert.deepStrictEqual(classifyProviderHealth(local, { ok: false, ms: 5, at: now, error: 'unreachable' }), { state: 'down', ms: 5, checkedAt: now, detail: 'not answering' });
    assert.strictEqual(classifyProviderHealth(cloud, { ok: false, ms: 300, at: now, error: 'HTTP 401 from api.openai.com: invalid api key' })?.state, 'nokey');
    assert.strictEqual(classifyProviderHealth({ ...cloud, apiKey: undefined }, undefined)?.state, 'nokey', 'a cloud API without a key needs no request to know');
    assert.strictEqual(classifyProviderHealth({ ...local, enabled: false }, undefined)?.state, 'off');
    assert.strictEqual(classifyProviderHealth({ baseUrl: '', type: 'vscode-lm' }, { ok: true, ms: 10, at: now })?.state, 'ok', 'VS Code models need no key');
    assert.deepStrictEqual([formatHealthMs(38), formatHealthMs(2400), formatHealthMs(12_000)], ['38 ms', '2.4 s', '12 s']);
  });

  test('the shortcut table comes from the manifest keybindings plus the chat keys; Change… targets the command', () => {
    const ext = vscode.extensions.getExtension('localpilot.localpilot-agent')!;
    const groups = shortcutGroups(ext.packageJSON);
    const bound = (ext.packageJSON.contributes.keybindings as { command: string }[]).map((k) => k.command);
    const listed = groups.filter((g) => g.customizable).flatMap((g) => g.rows.map((r) => r.command));
    assert.deepStrictEqual([...new Set(listed)].sort(), [...new Set(bound)].sort(), 'every keybinding is in the table');
    assert.ok(groups.some((g) => !g.customizable && g.rows.some((r) => /Stop the agent/.test(r.action))), 'the chat keys are listed (fixed)');
    const open = groups[0].rows.find((r) => r.command === 'localpilot.openChat')!;
    assert.deepStrictEqual([open.mac, open.win, open.when], ['⇧⌘L', 'Ctrl+Shift+L', 'outside the text editor']);
    assert.strictEqual(keyLabel('ctrl+shift+alt+l', false), 'Ctrl+Shift+Alt+L');
    assert.strictEqual(keyLabel('cmd+alt+shift+s', true), '⌥⇧⌘S');
    assert.match(shortcutsMarkdown(groups, false), /`Ctrl\+Shift\+L` Open Chat \(outside the text editor\)/);
  });
});
