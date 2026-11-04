import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { McpClient, McpManager } from '../mcp/mcpManager';
import { expandRefs, StdioTransport, winSpawn } from '../mcp/transports';
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
      assert.deepStrictEqual(mcp.status, [{ name: 'echo', tools: 1, transport: 'stdio' }]);
      const tool = tools.get('mcp_echo_echo');
      assert.ok(tool, 'MCP tool must be registered under mcp_<server>_<tool>');
      assert.strictEqual(tool.approvalKind, 'mcp');
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
      const declined = await tool.execute({ text: 'hello' }, {
        sessionId: 't',
        signal: new AbortController().signal,
        requestApproval: async () => false,
        progress: () => undefined,
        trackChange: async () => undefined,
        depth: 0,
      });
      assert.ok(declined.isError && /declined/.test(declined.content), 'MCP calls honour approvals and permission rules');
      assert.ok(!tool.readOnly, 'a tool without readOnlyHint counts as able to change state');
      const blocked = await tool.execute({ text: 'hello' }, {
        sessionId: 't',
        signal: new AbortController().signal,
        requestApproval: async () => true,
        progress: () => undefined,
        trackChange: async () => undefined,
        depth: 0,
        readOnly: true,
      });
      assert.ok(blocked.isError && /read-only|Plan\/Ask/.test(blocked.content), 'read-only modes refuse MCP tools not annotated read-only');
    } finally {
      mcp.dispose();
    }
  });

  test('Streamable HTTP starts a new session and retries when the server forgets the old one', async function () {
    this.timeout(15_000);
    let inits = 0;
    let rejected = false;
    const fetchImpl = (async (_url: string, init: { method?: string; headers?: Record<string, string>; body?: string }) => {
      if (init.method !== 'POST') {
        return new Response(null, { status: 204 });
      }
      const msg = JSON.parse(init.body ?? '{}') as { id?: number; method?: string };
      const sid = init.headers?.['mcp-session-id'];
      const json = (result: unknown, headers: Record<string, string> = {}) =>
        new Response(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }), { status: 200, headers: { 'content-type': 'application/json', ...headers } });
      if (msg.method === 'initialize') {
        inits++;
        return json({ protocolVersion: '2025-06-18', serverInfo: { name: 'fake', version: '1' } }, { 'mcp-session-id': `s${inits}` });
      }
      if (msg.id === undefined) {
        return new Response(null, { status: 202 });
      }
      if (msg.method === 'tools/list') {
        return json({ tools: [{ name: 'echo' }] });
      }
      if (msg.method === 'tools/call') {
        if (sid === 's1' && !rejected) {
          rejected = true;
          return new Response('session not found', { status: 404 });
        }
        return json({ content: [{ type: 'text', text: `ok ${sid}` }] });
      }
      return json({});
    }) as unknown as typeof fetch;
    const stub = { info() {}, warn() {}, debug() {}, error() {} } as unknown as vscode.LogOutputChannel;
    const client = new McpClient('fake', { url: 'http://127.0.0.1:1/mcp', type: 'http' }, stub, '0.0.0-test', fetchImpl);
    try {
      await client.start();
      const res = await client.callTool('echo', {});
      assert.strictEqual(res.text, 'ok s2');
      assert.strictEqual(inits, 2, 'the expired session triggers exactly one new initialize');
    } finally {
      client.dispose();
    }
  });

  test('expandRefs expands Claude-style ${VAR} and ${VAR:-default}', () => {
    process.env.LP_TEST_X = 'abc';
    try {
      assert.strictEqual(expandRefs('Bearer ${LP_TEST_X}', (r) => r), 'Bearer abc');
      assert.strictEqual(expandRefs('${LP_MISSING:-def}', (r) => r), 'def');
    } finally {
      delete process.env.LP_TEST_X;
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

  test('stdio transport keeps multi-byte UTF-8 intact across chunk boundaries', async function () {
    this.timeout(15_000);
    const t = new StdioTransport({ command: process.execPath, args: ['-e', "process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:1,result:{t:'あ'.repeat(40000)}})+'\\n')"] }, undefined, () => undefined);
    try {
      const msg = await new Promise<unknown>((resolve, reject) => {
        t.start(resolve, reject).catch(reject);
      });
      assert.strictEqual((msg as { result: { t: string } }).result.t, 'あ'.repeat(40000));
    } finally {
      t.close();
    }
  });

  test('winSpawn quotes .cmd shims through cmd and runs .exe directly', () => {
    const shim = winSpawn('npx', ['-y', 'C:\\Users\\Jane Doe\\srv.js', 'a=1&b=2'], () => 'C:\\nodejs\\npx.cmd', 'cmd.exe');
    assert.strictEqual(shim.file, 'cmd.exe');
    assert.strictEqual(shim.verbatim, true);
    assert.deepStrictEqual(shim.args.slice(0, 3), ['/d', '/s', '/c']);
    assert.ok(shim.args[3].includes('^"C:\\Users\\Jane Doe\\srv.js^"'), shim.args[3]);
    assert.ok(shim.args[3].includes('a=1^&b=2'), shim.args[3]);
    assert.deepStrictEqual(winSpawn('node', ['x y'], () => 'C:\\node.exe'), { file: 'C:\\node.exe', args: ['x y'], verbatim: false });
  });
});
