import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as http from 'http';
import { AddressInfo } from 'net';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { mcpLogLevel, mcpTimeoutMessage, mcpTimeoutSeconds } from '../mcp/config';
import { McpClient, McpManager } from '../mcp/mcpManager';
import { ToolRegistry } from '../tools/registry';
import { ToolContext } from '../types';

/**
 * A stdio MCP server whose tool list grows: calling `grow` adds a tool, sends `tools/list_changed` (three times, to
 * exercise the debounce) and a log message. `slow` never answers.
 */
const SERVER = `
const rl = require('readline').createInterface({ input: process.stdin });
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\\n');
let tools = [{ name: 'grow', inputSchema: { type: 'object', properties: {} } }, { name: 'slow', inputSchema: { type: 'object', properties: {} } }];
let lists = 0;
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') send({ id: msg.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: { listChanged: true }, prompts: { listChanged: true } }, serverInfo: { name: 'grow', version: '1' } } });
  else if (msg.method === 'tools/list') { lists++; send({ id: msg.id, result: { tools } }); }
  else if (msg.method === 'prompts/list') send({ id: msg.id, result: { prompts: [{ name: 'review' }] } });
  else if (msg.method === 'tools/call' && msg.params.name === 'grow') {
    tools = [...tools, { name: 'extra' + tools.length, inputSchema: { type: 'object', properties: {} } }];
    send({ id: msg.id, result: { content: [{ type: 'text', text: 'lists ' + lists }] } });
    for (let i = 0; i < 3; i++) send({ method: 'notifications/tools/list_changed' });
    send({ method: 'notifications/message', params: { level: 'warning', logger: 'db', data: 'pool low' } });
  } else if (msg.method === 'tools/call' && msg.params.name === 'extra2') send({ id: msg.id, result: { content: [{ type: 'text', text: 'lists ' + lists }] } });
  else if (msg.method === 'tools/call') { /* slow: never answers */ }
  else if (msg.id !== undefined) send({ id: msg.id, error: { code: -32601, message: 'method not found' } });
});
`;

const ctx = (): ToolContext => ({ sessionId: 't', signal: new AbortController().signal, requestApproval: async () => true, progress: () => undefined, trackChange: async () => undefined, depth: 0 });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 5_000): Promise<boolean> {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) {
    await sleep(25);
  }
  return cond();
}

function recordingLog(): { log: vscode.LogOutputChannel; lines: [string, string][] } {
  const lines: [string, string][] = [];
  const at = (level: string) => (m: string) => lines.push([level, m]);
  return { lines, log: { info: at('info'), warn: at('warn'), debug: at('debug'), error: at('error'), trace: at('trace') } as unknown as vscode.LogOutputChannel };
}

suite('LocalPilot MCP timeouts and server notifications', () => {
  let dir: string;
  const cfg = vscode.workspace.getConfiguration('localpilot');
  let before: unknown;
  const log = vscode.window.createOutputChannel('LocalPilot MCP notifications test', { log: true });

  suiteSetup(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lp-mcp-notify-'));
    await fs.writeFile(path.join(dir, 'server.js'), SERVER);
    before = cfg.inspect('mcpServers')?.globalValue;
  });
  suiteTeardown(async () => {
    await cfg.update('mcpServers', before, vscode.ConfigurationTarget.Global);
    await fs.rm(dir, { recursive: true, force: true });
  });

  test('timeout: seconds clamped to 1–3600 (default 60), the message names the server and the file', () => {
    assert.strictEqual(mcpTimeoutSeconds(undefined), 60);
    assert.strictEqual(mcpTimeoutSeconds(0), 60);
    assert.strictEqual(mcpTimeoutSeconds(0.2), 1);
    assert.strictEqual(mcpTimeoutSeconds(9999), 3600);
    assert.strictEqual(mcpTimeoutSeconds(300), 300);
    assert.strictEqual(mcpTimeoutMessage('db', 5, '/w/.mcp.json'), 'MCP request to "db" timed out after 5s. Raise "timeout" for this server in /w/.mcp.json.');
    assert.match(mcpTimeoutMessage('db', 60), /in the localpilot\.mcpServers setting\.$/);
    assert.deepStrictEqual(['debug', 'info', 'notice', 'warning', 'error', 'critical', 'emergency', 'bogus'].map(mcpLogLevel), ['debug', 'info', 'info', 'warn', 'error', 'error', 'error', 'info']);
  });

  test('a request that outlives the server timeout fails with the timeout message', async function () {
    this.timeout(15_000);
    const { log: stub } = recordingLog();
    const client = new McpClient('slowpoke', { command: process.execPath, args: [path.join(dir, 'server.js')], timeout: 1 }, stub, '0.0.0-test');
    client.settings = () => ({ timeout: 1, file: '/repo/.mcp.json' });
    try {
      await client.start();
      const started = Date.now();
      await assert.rejects(client.callTool('slow', {}), /MCP request to "slowpoke" timed out after 1s\. Raise "timeout" for this server in \/repo\/\.mcp\.json\./);
      assert.ok(Date.now() - started < 5_000, 'the per-server timeout replaces the old fixed 120 s');
    } finally {
      client.dispose();
    }
  });

  test('tools/list_changed re-lists once (debounced) and re-registers only that server; notifications/message is logged at its level', async function () {
    this.timeout(30_000);
    const tools = new ToolRegistry();
    const mcp = new McpManager(tools, log, '0.0.0-test');
    const server = { command: process.execPath, args: [path.join(dir, 'server.js')] };
    try {
      await cfg.update('mcpServers', { a: server, b: server }, vscode.ConfigurationTarget.Global);
      await mcp.reload();
      assert.deepStrictEqual(mcp.status.map((s) => [s.name, s.tools]).sort(), [['a', 2], ['b', 2]]);
      const bTool = tools.get('mcp_b_grow');
      const aTool = tools.get('mcp_a_grow');
      assert.ok(aTool && bTool);
      let changes = 0;
      const sub = mcp.onDidChange(() => changes++);
      const r = await aTool.execute({}, ctx());
      assert.strictEqual(r.content, 'lists 1');
      assert.ok(await until(() => !!tools.get('mcp_a_extra2')), 'the new tool of server a is registered');
      sub.dispose();
      assert.ok(changes >= 1, 'status listeners hear about the new tool count');
      assert.strictEqual(tools.get('mcp_b_grow'), bTool, "server b's tools are not re-registered");
      assert.ok(!tools.get('mcp_b_extra2'));
      assert.notStrictEqual(tools.get('mcp_a_grow'), aTool, "server a's tools are registered again");
      assert.strictEqual(mcp.status.find((s) => s.name === 'a')?.tools, 3);
      const after = await tools.get('mcp_a_extra2')!.execute({}, ctx());
      assert.strictEqual(after.content, 'lists 2', 'three list_changed notifications in a burst cost one tools/list');
    } finally {
      mcp.dispose();
    }
    const { log: stub, lines } = recordingLog();
    const client = new McpClient('logger', server, stub, '0.0.0-test');
    try {
      await client.start();
      assert.deepStrictEqual(client.prompts.map((p) => p.name), ['review'], 'prompts are fetched when the server offers them');
      await client.callTool('grow', {});
      assert.ok(await until(() => lines.some(([lvl, m]) => lvl === 'warn' && m === '[mcp:logger] db: pool low')), JSON.stringify(lines));
    } finally {
      client.dispose();
    }
  });

  test('Streamable HTTP: the standalone GET stream delivers notifications and reconnects; 405 means no stream', async function () {
    this.timeout(20_000);
    let gets = 0;
    let toolCount = 1;
    const streams: http.ServerResponse[] = [];
    const getHeaders: http.IncomingHttpHeaders[] = [];
    let noStream = false;
    const srv = http.createServer((req, res) => {
      let body = '';
      req.on('data', (d) => (body += d));
      req.on('end', () => {
        if (req.method === 'GET') {
          gets++;
          getHeaders.push(req.headers);
          if (noStream) {
            res.writeHead(405).end();
            return;
          }
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          res.write(': open\n\n');
          streams.push(res);
          if (gets === 1) {
            // The first stream drops at once: the client must come back.
            setTimeout(() => res.end(), 50);
          }
          return;
        }
        if (req.method === 'DELETE') {
          res.writeHead(200).end();
          return;
        }
        const msg = JSON.parse(body || '{}') as { id?: number; method?: string };
        if (msg.id === undefined) {
          res.writeHead(202).end();
          return;
        }
        const result =
          msg.method === 'initialize'
            ? { protocolVersion: '2025-06-18', capabilities: { tools: { listChanged: true } }, serverInfo: { name: 'h', version: '1' } }
            : msg.method === 'tools/list'
              ? { tools: Array.from({ length: toolCount }, (_, i) => ({ name: `t${i}` })) }
              : {};
        res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'sess-9' }).end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }));
      });
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
    const url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/mcp`;
    const { log: stub, lines } = recordingLog();
    const client = new McpClient('h', { url, type: 'http' }, stub, '0.0.0-test');
    try {
      await client.start();
      assert.strictEqual(client.tools.length, 1);
      assert.ok(await until(() => gets >= 2 && streams.length >= 2 && !streams[1].writableEnded), `the dropped stream is reopened (GETs: ${gets})`);
      assert.strictEqual(getHeaders[0].accept, 'text/event-stream');
      assert.strictEqual(getHeaders[0]['mcp-session-id'], 'sess-9');
      toolCount = 3;
      streams[1].write(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' })}\n\n`);
      streams[1].write(`data: ${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/message', params: { level: 'error', data: { code: 7 } } })}\n\n`);
      assert.ok(await until(() => client.tools.length === 3), 'a notification on the GET stream reaches the client');
      assert.ok(lines.some(([lvl, m]) => lvl === 'error' && m === '[mcp:h] {"code":7}'));
    } finally {
      client.dispose();
      streams.forEach((s) => s.end());
    }
    noStream = true;
    gets = 0;
    const quiet = new McpClient('q', { url, type: 'http' }, stub, '0.0.0-test');
    try {
      await quiet.start();
      await sleep(1_500);
      assert.strictEqual(gets, 1, 'a 405 is not retried');
      assert.strictEqual((await quiet.callTool('t0', {})).isError, false, 'the server works without a stream');
    } finally {
      quiet.dispose();
      srv.closeAllConnections?.();
      srv.close();
    }
  });

  test('Streamable HTTP: a 404 on the GET stream after a server restart starts a new session and reopens the stream', async function () {
    this.timeout(20_000);
    let session = 'sess-1';
    let toolCount = 1;
    let inits = 0;
    const streams: http.ServerResponse[] = [];
    const getSessions: (string | undefined)[] = [];
    const srv = http.createServer((req, res) => {
      let body = '';
      req.on('data', (d) => (body += d));
      req.on('end', () => {
        const sid = req.headers['mcp-session-id'] as string | undefined;
        if (req.method === 'GET') {
          getSessions.push(sid);
          if (sid !== session) {
            res.writeHead(404).end();
            return;
          }
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          res.write(': open\n\n');
          streams.push(res);
          return;
        }
        if (req.method === 'DELETE') {
          res.writeHead(200).end();
          return;
        }
        const msg = JSON.parse(body || '{}') as { id?: number; method?: string };
        if (msg.method !== 'initialize' && sid !== session) {
          res.writeHead(404).end();
          return;
        }
        if (msg.id === undefined) {
          res.writeHead(202).end();
          return;
        }
        if (msg.method === 'initialize') {
          inits++;
        }
        const result =
          msg.method === 'initialize'
            ? { protocolVersion: '2025-06-18', capabilities: { tools: { listChanged: true } }, serverInfo: { name: 'r', version: '1' } }
            : msg.method === 'tools/list'
              ? { tools: Array.from({ length: toolCount }, (_, i) => ({ name: `t${i}` })) }
              : {};
        res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': session }).end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }));
      });
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
    const url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/mcp`;
    const { log: stub } = recordingLog();
    const client = new McpClient('r', { url, type: 'http' }, stub, '0.0.0-test');
    try {
      await client.start();
      assert.ok(await until(() => streams.length === 1), 'the GET stream opens');
      // The server restarts while the client is idle: a new session, a new tool list, and the old stream drops.
      session = 'sess-2';
      toolCount = 2;
      streams[0].end();
      assert.ok(await until(() => streams.length === 2 && !streams[1].writableEnded), `the stream is reopened on a new session (GETs: ${getSessions.join(', ')})`);
      assert.deepStrictEqual(getSessions, ['sess-1', 'sess-1', 'sess-2'], 'the stale session got a 404, then the new one a stream');
      assert.strictEqual(inits, 2, 'one new handshake');
      assert.ok(await until(() => client.tools.length === 2), 'the lists are fetched again on the new session');
      toolCount = 3;
      streams[1].write(`data: ${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' })}\n\n`);
      assert.ok(await until(() => client.tools.length === 3), 'notifications arrive on the new stream');
    } finally {
      client.dispose();
      streams.forEach((s) => s.end());
      srv.closeAllConnections?.();
      srv.close();
    }
  });
});
