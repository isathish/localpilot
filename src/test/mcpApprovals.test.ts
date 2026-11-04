import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { getConfig } from '../config';
import { autoApprovedMode, flooredApproval, normalizePolicy } from '../agent/managedPolicy';
import { McpManager } from '../mcp/mcpManager';
import { ToolRegistry } from '../tools/registry';
import { ToolContext } from '../types';

const SERVER = `
const rl = require('readline').createInterface({ input: process.stdin });
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\\n');
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') send({ id: msg.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'two', version: '1' } } });
  else if (msg.method === 'tools/list') send({ id: msg.id, result: { tools: [{ name: 'safe' }, { name: 'risky' }] } });
  else if (msg.method === 'tools/call') send({ id: msg.id, result: { content: [{ type: 'text', text: 'ran ' + msg.params.name }] } });
  else if (msg.id !== undefined) send({ id: msg.id, error: { code: -32601, message: 'method not found' } });
});
`;

suite('LocalPilot MCP approval category', () => {
  const cfg = vscode.workspace.getConfiguration('localpilot');
  let dir: string;
  let beforeServers: unknown;
  let beforeMcp: unknown;
  const log = vscode.window.createOutputChannel('LocalPilot MCP approvals test', { log: true });

  suiteSetup(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lp-mcp-appr-'));
    await fs.writeFile(path.join(dir, 'server.js'), SERVER);
    beforeServers = cfg.inspect('mcpServers')?.globalValue;
    beforeMcp = cfg.inspect('approvals.mcp')?.globalValue;
  });
  suiteTeardown(async () => {
    await cfg.update('mcpServers', beforeServers, vscode.ConfigurationTarget.Global);
    await cfg.update('approvals.mcp', beforeMcp, vscode.ConfigurationTarget.Global);
    await fs.rm(dir, { recursive: true, force: true });
  });

  test('approvals.mcp is contributed next to approvals.network, user-scoped, default always', () => {
    const props = vscode.extensions.getExtension('localpilot.localpilot-agent')!.packageJSON.contributes.configuration.properties;
    const p = props['localpilot.approvals.mcp'];
    assert.ok(p, 'localpilot.approvals.mcp is contributed');
    assert.strictEqual(p.default, 'always', 'MCP tools keep running without a prompt by default');
    assert.strictEqual(p.scope, 'application');
    assert.deepStrictEqual(p.enum, ['always', 'ask', 'never']);
    assert.ok(!/MCP/.test(props['localpilot.approvals.network'].description), 'the network setting no longer claims MCP tools');
    assert.ok(['always', 'ask', 'never'].includes(getConfig().approvals.mcp));
  });

  test('a policy network floor still covers MCP tools unless the policy sets an mcp floor', () => {
    assert.strictEqual(normalizePolicy({ approvals: { network: 'ask' } }).approvals.mcp, 'ask');
    assert.strictEqual(normalizePolicy({ approvals: { network: 'never', mcp: 'ask' } }).approvals.mcp, 'ask');
    assert.strictEqual(normalizePolicy({ approvals: { mcp: 'never' } }).approvals.network, undefined);
    assert.strictEqual(flooredApproval(normalizePolicy({ approvals: { mcp: 'ask' } }), 'mcp', 'always'), 'ask');
  });

  test("MCP tools ask under the mcp kind; a server's autoApprove list skips the prompt even when the category is ask", async function () {
    this.timeout(30_000);
    const tools = new ToolRegistry();
    const mcp = new McpManager(tools, log, '0.0.0-test');
    try {
      await cfg.update('approvals.mcp', 'ask', vscode.ConfigurationTarget.Global);
      await cfg.update('mcpServers', { two: { command: process.execPath, args: [path.join(dir, 'server.js')], autoApprove: ['safe'] } }, vscode.ConfigurationTarget.Global);
      await mcp.reload();
      const asked: string[] = [];
      // Mirrors AgentLoop.gateApproval on the category path: the configured mode, then the autoApprove hint.
      const ctx: ToolContext = {
        sessionId: 't',
        signal: new AbortController().signal,
        requestApproval: async (_title, _detail, kind, opts) => {
          const mode = autoApprovedMode(normalizePolicy({}), kind, flooredApproval(normalizePolicy({}), kind, getConfig().approvals[kind]), opts);
          if (mode !== 'ask') {
            return mode === 'always';
          }
          asked.push(kind);
          return false;
        },
        progress: () => undefined,
        trackChange: async () => undefined,
        depth: 0,
      };
      const safe = tools.get('mcp_two__safe')!;
      const risky = tools.get('mcp_two__risky')!;
      assert.strictEqual(safe.approvalKind, 'mcp');
      assert.strictEqual((await safe.execute({}, ctx)).content, 'ran safe');
      assert.deepStrictEqual(asked, [], 'autoApprove tools are not asked about');
      const declined = await risky.execute({}, ctx);
      assert.ok(declined.isError && /declined/.test(declined.content));
      assert.deepStrictEqual(asked, ['mcp'], 'other tools ask under the MCP category');
      await cfg.update('approvals.mcp', 'never', vscode.ConfigurationTarget.Global);
      const blocked = await safe.execute({}, ctx);
      assert.ok(blocked.isError, '"never" overrides autoApprove');
    } finally {
      mcp.dispose();
    }
  });

  test('an ask rule, a hook ask or an organisation floor still prompts for an autoApprove tool', async function () {
    this.timeout(30_000);
    const org = normalizePolicy({ approvals: { mcp: 'ask' } });
    const none = normalizePolicy({});
    assert.strictEqual(autoApprovedMode(none, 'mcp', 'ask', { autoApprove: true }), 'always', 'the plain category prompt honours autoApprove');
    assert.strictEqual(autoApprovedMode(none, 'mcp', 'ask', { autoApprove: true, mandatory: true }), 'ask', 'an organisation permissions.ask rule is mandatory');
    assert.strictEqual(autoApprovedMode(org, 'mcp', flooredApproval(org, 'mcp', 'always'), { autoApprove: true }), 'ask', 'an organisation mcp floor wins');
    assert.strictEqual(autoApprovedMode(none, 'mcp', 'never', { autoApprove: true }), 'never');
    assert.strictEqual(autoApprovedMode(none, 'network', 'ask', { autoApprove: true }), 'ask', 'only MCP calls carry the hint');
    const tools = new ToolRegistry();
    const mcp = new McpManager(tools, log, '0.0.0-test');
    try {
      await cfg.update('approvals.mcp', 'ask', vscode.ConfigurationTarget.Global);
      await cfg.update('mcpServers', { two: { command: process.execPath, args: [path.join(dir, 'server.js')], autoApprove: ['safe'] } }, vscode.ConfigurationTarget.Global);
      await mcp.reload();
      const seen: (boolean | undefined)[] = [];
      // A settings/hook `ask` (policy.ask) or organisation `ask` (policy.askMandatory) replaces requestApproval and drops the hint.
      const ruleAsk: ToolContext = {
        sessionId: 't',
        signal: new AbortController().signal,
        requestApproval: async (_title, _detail, kind, opts) => {
          seen.push(opts?.autoApprove);
          return autoApprovedMode(none, kind, 'ask', { mandatory: opts?.mandatory }) === 'always';
        },
        progress: () => undefined,
        trackChange: async () => undefined,
        depth: 0,
      };
      const r = await tools.get('mcp_two__safe')!.execute({}, ruleAsk);
      assert.ok(r.isError && /declined/.test(r.content), 'the ask rule prompted and the refusal stood');
      assert.deepStrictEqual(seen, [true], 'the tool always reaches the approval gate, flagging its autoApprove entry');
    } finally {
      mcp.dispose();
    }
  });
});
