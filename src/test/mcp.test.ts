import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { McpManager } from '../mcp/mcpManager';
import { ToolRegistry } from '../tools/registry';

/** A complete, tiny MCP server (stdio, JSON-RPC) exposing one `echo` tool — written to disk and run with node. */
const SERVER = `
const rl = require('readline').createInterface({ input: process.stdin });
const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n');
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'echo', version: '1.0.0' } } });
  else if (msg.method === 'tools/list') send({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'echo', description: 'Echoes text back', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } }] } });
  else if (msg.method === 'tools/call') send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'echo: ' + msg.params.arguments.text }], isError: false } });
  else if (msg.id !== undefined) send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'method not found' } });
});
`;

suite('LocalPilot MCP client', () => {
  let dir: string;
  const cfg = vscode.workspace.getConfiguration('localpilot');
  let before: unknown;
  // One channel for the whole suite: late async pipe-error logs must not hit a disposed channel.
  const log = vscode.window.createOutputChannel('LocalPilot MCP test', { log: true });

  suiteSetup(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lp-mcp-'));
    await fs.writeFile(path.join(dir, 'server.js'), SERVER);
    before = cfg.inspect('mcpServers')?.globalValue;
  });
  suiteTeardown(async () => {
    await cfg.update('mcpServers', before, vscode.ConfigurationTarget.Global);
    await fs.rm(dir, { recursive: true, force: true });
  });

  test('starts a real stdio server, registers its tool and round-trips a call', async function () {
    this.timeout(30_000);
    const tools = new ToolRegistry();
    const mcp = new McpManager(tools, log, '0.0.0-test');
    try {
      await cfg.update('mcpServers', { echo: { command: process.execPath, args: [path.join(dir, 'server.js')] } }, vscode.ConfigurationTarget.Global);
      await mcp.reload();
      assert.deepStrictEqual(mcp.status, [{ name: 'echo', tools: 1 }]);
      const tool = tools.get('mcp_echo_echo');
      assert.ok(tool, 'MCP tool must be registered under mcp_<server>_<tool>');
      assert.strictEqual(tool.approvalKind, 'network');
      const res = await tool.execute({ text: 'hello' }, {
        sessionId: 't',
        signal: new AbortController().signal,
        requestApproval: async () => true,
        progress: () => undefined,
        trackChange: async () => undefined,
        depth: 0,
      });
      assert.strictEqual(res.content, 'echo: hello');
      assert.strictEqual(res.isError, false);
    } finally {
      mcp.dispose();
    }
  });

  test('a server that cannot be launched fails fast and reports the error in status', async function () {
    this.timeout(15_000);
    const mcp = new McpManager(new ToolRegistry(), log, '0.0.0-test');
    try {
      await cfg.update('mcpServers', { broken: { command: path.join(dir, 'does-not-exist-xyz') } }, vscode.ConfigurationTarget.Global);
      const started = Date.now();
      await mcp.reload();
      assert.ok(Date.now() - started < 5000, 'spawn failure must not wait for the 30s request timeout');
      const st = mcp.status;
      assert.strictEqual(st.length, 1);
      assert.strictEqual(st[0].name, 'broken');
      assert.strictEqual(st[0].tools, 0);
      assert.match(st[0].error ?? '', /cannot start|ENOENT|not found|exited/i);
    } finally {
      mcp.dispose();
    }
  });
});
