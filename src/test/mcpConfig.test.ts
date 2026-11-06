import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { expandMcpServer, loadMcpFiles, mcpFingerprint, mcpTrustKey, mergeMcpLayers, normalizeMcpServers, readMcpFile, writeMcpFile } from '../mcp/config';
import { McpManager } from '../mcp/mcpManager';
import type { McpTrust } from '../mcp/trust';
import { ToolRegistry } from '../tools/registry';

const SERVER = `
const rl = require('readline').createInterface({ input: process.stdin });
const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n');
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'echo', version: '1.0.0' } } });
  else if (msg.method === 'tools/list') send({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'echo', inputSchema: { type: 'object', properties: {} } }] } });
  else if (msg.method === 'tools/call') send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'tag=' + (process.env.TAG || '') }] } });
  else if (msg.id !== undefined) send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'method not found' } });
});
`;

suite('LocalPilot MCP configuration files', () => {
  let dir: string;
  const cfg = vscode.workspace.getConfiguration('localpilot');
  let before: unknown;
  const log = vscode.window.createOutputChannel('LocalPilot MCP config test', { log: true });

  suiteSetup(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lp-mcpcfg-'));
    await fs.writeFile(path.join(dir, 'server.js'), SERVER);
    before = cfg.inspect('mcpServers')?.globalValue;
    await cfg.update('mcpServers', {}, vscode.ConfigurationTarget.Global);
  });
  suiteTeardown(async () => {
    await cfg.update('mcpServers', before, vscode.ConfigurationTarget.Global);
    await fs.rm(dir, { recursive: true, force: true });
  });

  test('normalizes Claude Code, Cline and nested-transport server entries', () => {
    const { servers, problems } = normalizeMcpServers(
      {
        mcpServers: {
          claude: { type: 'stdio', command: 'npx', args: ['-y', 'srv', 3], env: { TOKEN: '${env:T}' } },
          cline: { command: 'node', args: ['s.js'], cwd: 'tools', disabled: true, timeout: 90, autoApprove: ['read'] },
          roo: { url: 'https://mcp.example.com/mcp', transportType: 'streamableHttp', alwaysAllow: ['list'] },
          nested: { transport: { type: 'sse', url: 'https://old.example.com/sse', headers: { Authorization: 'Bearer x' } } },
          guess: { url: 'https://x.example.com/mcp' },
          badType: { type: 'websocket', url: 'wss://x' },
          noTarget: { args: ['x'] },
          badArgs: { command: 'x', args: 'nope' },
          badTimeout: { command: 'x', timeout: -1 },
          stdioUrl: { type: 'stdio', url: 'https://x.example.com' },
          notObject: 5,
        },
      },
      { root: '/repo' }
    );
    assert.deepStrictEqual(servers.claude, { command: 'npx', args: ['-y', 'srv', '3'], env: { TOKEN: '${env:T}' }, type: 'stdio' });
    assert.deepStrictEqual(servers.cline, { command: 'node', args: ['s.js'], cwd: path.resolve('/repo', 'tools'), enabled: false, timeout: 90, autoApprove: ['read'] });
    assert.deepStrictEqual(servers.roo, { url: 'https://mcp.example.com/mcp', type: 'streamableHttp', autoApprove: ['list'] });
    assert.deepStrictEqual(servers.nested, { url: 'https://old.example.com/sse', type: 'sse', headers: { Authorization: 'Bearer x' } });
    assert.deepStrictEqual(servers.guess, { url: 'https://x.example.com/mcp' });
    assert.deepStrictEqual(Object.keys(servers).sort(), ['claude', 'cline', 'guess', 'nested', 'roo']);
    for (const name of ['badType', 'noTarget', 'badArgs', 'badTimeout', 'stdioUrl', 'notObject']) {
      assert.ok(problems.some((p) => p.startsWith(`"${name}"`)), `a field error names ${name}: ${problems.join(' | ')}`);
    }
  });

  test('layers merge highest priority first; unreadable files report a problem', async () => {
    const ws = path.join(dir, 'ws-merge');
    await fs.mkdir(ws, { recursive: true });
    await fs.writeFile(path.join(ws, '.mcp.json'), '{ // comment\n "mcpServers": { "a": { "command": "project" }, "b": { "command": "project" } } }');
    const user = path.join(dir, 'user-mcp.json');
    await writeMcpFile(user, { b: { command: 'user' }, c: { command: 'user' } });
    const layers = await loadMcpFiles([ws], user);
    const merged = mergeMcpLayers([{ source: 'settings', servers: { a: { command: 'settings' } }, problems: [] }, ...layers]);
    assert.strictEqual(merged.a.command, 'settings');
    assert.strictEqual(merged.b.command, 'project');
    assert.strictEqual(merged.b.source, 'project');
    assert.strictEqual(merged.c.command, 'user');
    await fs.writeFile(path.join(ws, '.mcp.json'), '{ "mcpServers": ');
    const broken = await readMcpFile(path.join(ws, '.mcp.json'), 'project');
    assert.ok(/not valid JSON/.test(broken.problems[0] ?? ''), broken.problems.join());
    const missing = await readMcpFile(path.join(dir, 'nope.json'), 'user');
    assert.deepStrictEqual([missing.servers, missing.problems], [{}, []]);
    assert.ok(!(await fs.readdir(dir)).some((f) => f.endsWith('.tmp')), 'the atomic write leaves no temp file');
  });

  test('expands references in every connection field and leaves missing ones as written', () => {
    const lookup = (kind: 'env' | 'secret', name: string) => ({ env: { HOME_DIR: '/h', TOKEN: 't0k' }, secret: { gh: 's3c' } } as Record<string, Record<string, string>>)[kind][name];
    const { cfg: out, missing } = expandMcpServer(
      { command: '${HOME_DIR}/bin/srv', args: ['--token=${env:TOKEN}', '${NOPE:-fallback}'], env: { A: '${secret:gh}', B: '${env:MISSING}' }, cwd: '${env:HOME_DIR}/w', url: 'https://x/${env:TOKEN}', headers: { Authorization: 'Bearer ${secret:absent}' } },
      lookup
    );
    assert.strictEqual(out.command, '/h/bin/srv');
    assert.deepStrictEqual(out.args, ['--token=t0k', 'fallback']);
    assert.deepStrictEqual(out.env, { A: 's3c', B: '${env:MISSING}' });
    assert.strictEqual(out.cwd, '/h/w');
    assert.strictEqual(out.url, 'https://x/t0k');
    assert.strictEqual(out.headers?.Authorization, 'Bearer ${secret:absent}');
    assert.deepStrictEqual(missing.sort(), ['MISSING', 'secret absent']);
  });

  test('fingerprints ignore timeout and autoApprove; trust keys change with the command', () => {
    assert.strictEqual(mcpFingerprint({ command: 'x', env: { B: '1', A: '2' } }), mcpFingerprint({ command: 'x', env: { A: '2', B: '1' }, timeout: 5, autoApprove: ['t'] }));
    assert.notStrictEqual(mcpTrustKey('s', { command: 'x' }), mcpTrustKey('s', { command: 'y' }));
  });

  test('trust keys change when autoApprove changes, but not with its order or the timeout', () => {
    const key = mcpTrustKey('s', { command: 'x', autoApprove: ['a', 'b'] });
    assert.notStrictEqual(mcpTrustKey('s', { command: 'x' }), key);
    assert.notStrictEqual(mcpTrustKey('s', { command: 'x', autoApprove: ['a', 'b', 'delete_repository'] }), key);
    assert.strictEqual(mcpTrustKey('s', { command: 'x', autoApprove: ['b', 'a'], timeout: 9 }), key);
  });

  test('a project .mcp.json starts after trust, and editing one server restarts only that one', async function () {
    this.timeout(40_000);
    const ws = path.join(dir, 'ws-trust');
    await fs.mkdir(ws, { recursive: true });
    const file = path.join(ws, '.mcp.json');
    const server = (tag: string) => ({ command: process.execPath, args: [path.join(dir, 'server.js')], env: { TAG: tag } });
    await fs.writeFile(file, JSON.stringify({ mcpServers: { alpha: server('a'), beta: server('b1') } }));
    const trusted = new Set<string>();
    const asked: string[][] = [];
    let answer = false;
    const trust: McpTrust = {
      blocking: true,
      isTrusted: (k) => trusted.has(k),
      ask: async (names, _file, keys) => {
        asked.push(names);
        if (answer) {
          keys.forEach((k) => trusted.add(k));
        }
        return answer;
      },
    };
    const tools = new ToolRegistry();
    const mcp = new McpManager(tools, log, '0.0.0-test');
    mcp.projectFolders = () => [ws];
    mcp.userFile = () => path.join(dir, 'no-user-file.json');
    mcp.trust = trust;
    const ctx = { sessionId: 't', signal: new AbortController().signal, requestApproval: async () => true, progress: () => undefined, trackChange: async () => undefined, depth: 0 };
    const clients = () => (mcp as unknown as { clients: Map<string, unknown> }).clients;
    try {
      await mcp.reload();
      assert.deepStrictEqual(asked, [['alpha', 'beta']]);
      assert.ok(!tools.get('mcp_alpha__echo'), 'declined servers do not start');
      assert.ok(mcp.status.every((s) => /trust|chose not/.test(s.error ?? '')), JSON.stringify(mcp.status));
      await mcp.reload();
      assert.strictEqual(asked.length, 1, 'a "Not now" is not asked again in the same session');

      // This manager's part is over: it started nothing, and it must stop watching the file. Left running, its watcher
      // sees the writes below, is now trusted (answer = true) and starts its own servers into the shared tool registry,
      // which made the removal and count checks below fail now and then.
      assert.strictEqual(clients().size, 0);
      mcp.dispose();
      answer = true;
      const fresh = new McpManager(tools, log, '0.0.0-test');
      fresh.projectFolders = () => [ws];
      fresh.userFile = () => path.join(dir, 'no-user-file.json');
      fresh.trust = trust;
      const fc = () => (fresh as unknown as { clients: Map<string, unknown> }).clients;
      try {
        await fresh.reload();
        assert.deepStrictEqual(fresh.status.map((s) => [s.name, s.tools]).sort(), [['alpha', 1], ['beta', 1]]);
        assert.strictEqual((await tools.get('mcp_beta__echo')!.execute({}, ctx)).content, 'tag=b1');
        const alpha = fc().get('alpha');
        const beta = fc().get('beta');
        await fs.writeFile(file, JSON.stringify({ mcpServers: { alpha: { ...server('a'), timeout: 30 }, beta: server('b2') } }));
        await fresh.reloadIfChanged();
        assert.strictEqual(asked.length, 3, 'the changed server needs trust again; the unchanged one does not');
        assert.deepStrictEqual(asked[2], ['beta']);
        assert.strictEqual(fc().get('alpha'), alpha, 'editing server beta (and only the timeout of alpha) leaves alpha running');
        assert.notStrictEqual(fc().get('beta'), beta, 'beta is restarted with its new configuration');
        assert.strictEqual((await tools.get('mcp_beta__echo')!.execute({}, ctx)).content, 'tag=b2');
        await fs.writeFile(file, JSON.stringify({ mcpServers: { alpha: { ...server('a'), timeout: 30 } } }));
        await fresh.reloadIfChanged();
        assert.ok(!fc().has('beta') && !tools.get('mcp_beta__echo'), 'a removed server is stopped and its tools withdrawn');
        assert.strictEqual(fc().get('alpha'), alpha);
        // Caught mid-save (empty) or with a typo, the file keeps its servers running instead of stopping them.
        await fs.writeFile(file, '');
        await fresh.reloadIfChanged();
        await fs.writeFile(file, '{ "mcpServers": { "alpha": ');
        await fresh.reloadIfChanged();
        assert.strictEqual(fc().get('alpha'), alpha, 'an empty or broken .mcp.json does not restart its servers');
        await fs.writeFile(file, JSON.stringify({ mcpServers: { alpha: { ...server('a'), timeout: 30 } } }));
        await fresh.reloadIfChanged();
        assert.strictEqual(fc().get('alpha'), alpha, 'the same configuration saved again leaves it running');
      } finally {
        fresh.dispose();
      }
    } finally {
      mcp.dispose();
    }
  });

  test('an invalid server file is reported once with its field errors', async () => {
    const ws = path.join(dir, 'ws-invalid');
    await fs.mkdir(ws, { recursive: true });
    await fs.writeFile(path.join(ws, '.mcp.json'), JSON.stringify({ mcpServers: { bad: { type: 'stdio' } } }));
    const mcp = new McpManager(new ToolRegistry(), log, '0.0.0-test');
    const reports: [string, string[]][] = [];
    mcp.projectFolders = () => [ws];
    mcp.userFile = () => path.join(dir, 'no-user-file.json');
    mcp.onFileProblems = (f, p) => reports.push([f, p]);
    try {
      await mcp.reload();
      await mcp.reload();
      assert.strictEqual(reports.length, 1);
      assert.strictEqual(reports[0][0], path.join(ws, '.mcp.json'));
      assert.match(reports[0][1][0], /"bad": "type": "stdio" needs a "command"/);
    } finally {
      mcp.dispose();
    }
  });
});
