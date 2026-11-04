import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import type * as vscode from 'vscode';
import { mcpListRows } from '../cli/mcpCmd';
import { browserCommand } from '../cli/mcpOAuth';
import { normalizeMcpServers, policyAndSettingsLayers, withMcpEnabled } from '../mcp/config';
import { signInMcpServer } from '../mcp/mcpManager';
import { McpOAuth } from '../mcp/oauth';
import { FileSecretStorage } from '../providers/secrets';

const log = { info() {}, warn() {}, error() {}, debug() {}, trace() {} } as unknown as vscode.LogOutputChannel;

/** An MCP server behind OAuth: 401 until a request carries the token its /token endpoint issued. */
function oauthServer(): Promise<{ url: string; close(): void; hits: string[] }> {
  const hits: string[] = [];
  const server = http.createServer((req, res) => {
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const u = new URL(req.url ?? '/', origin);
    hits.push(`${req.method} ${u.pathname}`);
    const json = (status: number, body: unknown) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (u.pathname === '/.well-known/oauth-protected-resource') {
        json(200, { resource: `${origin}/mcp`, authorization_servers: [origin] });
        return;
      }
      if (u.pathname === '/.well-known/oauth-authorization-server') {
        json(200, { issuer: origin, authorization_endpoint: `${origin}/authorize`, token_endpoint: `${origin}/token`, registration_endpoint: `${origin}/register`, code_challenge_methods_supported: ['S256'] });
        return;
      }
      if (u.pathname === '/register') {
        json(201, { client_id: 'client-1' });
        return;
      }
      if (u.pathname === '/token') {
        json(200, new URLSearchParams(body).get('code') === 'code-1' ? { access_token: 'token-1', token_type: 'Bearer' } : { error: 'invalid_grant' });
        return;
      }
      if (u.pathname !== '/mcp') {
        res.writeHead(404).end();
        return;
      }
      if (req.headers.authorization !== 'Bearer token-1') {
        res.writeHead(401, { 'www-authenticate': `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"` }).end();
        return;
      }
      if (req.method !== 'POST') {
        res.writeHead(405).end();
        return;
      }
      const m = JSON.parse(body) as { id?: number; method: string };
      if (m.id === undefined) {
        res.writeHead(202).end();
        return;
      }
      const result = m.method === 'initialize' ? { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'auth-test', version: '1' } } : m.method === 'tools/list' ? { tools: [{ name: 'a', inputSchema: { type: 'object' } }, { name: 'b', inputSchema: { type: 'object' } }] } : {};
      json(200, { jsonrpc: '2.0', id: m.id, result });
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${(server.address() as { port: number }).port}/mcp`, hits, close: () => (server.close(), server.closeAllConnections?.()) })));
}

suite('CLI mcp auth and organization servers', () => {
  test('a server answering 401 starts the OAuth sign-in, stores the token in the secrets file and connects', async () => {
    const srv = await oauthServer();
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lp-mcp-auth-'));
    const store = new FileSecretStorage(path.join(dir, 'secrets.json'));
    const opened: string[] = [];
    // The "browser": follows the sign-in link straight to the loopback redirect with a code.
    const oauth = new McpOAuth(store, {
      ports: [0],
      openExternal: async (link) => {
        opened.push(link);
        const u = new URL(link);
        await fetch(`${u.searchParams.get('redirect_uri')}?code=code-1&state=${u.searchParams.get('state')}`);
      },
    });
    try {
      const r = await signInMcpServer('docs', { type: 'http', url: srv.url }, oauth, log, '0');
      assert.deepStrictEqual(r, { tools: 2, signedIn: true });
      assert.strictEqual(opened.length, 1);
      assert.match(opened[0], /\/authorize\?/);
      assert.ok(srv.hits.includes('POST /register') && srv.hits.includes('POST /token'));
      const file = path.join(dir, 'secrets.json');
      assert.match(await fs.readFile(file, 'utf8'), /token-1/);
      if (process.platform !== 'win32') {
        assert.strictEqual((await fs.stat(file)).mode & 0o777, 0o600);
      }
      // Signed in: the next run uses the stored token without opening the browser.
      const again = await signInMcpServer('docs', { type: 'http', url: srv.url }, new McpOAuth(store, { ports: [0], openExternal: async () => assert.fail('opened the browser again') }), log, '0');
      assert.deepStrictEqual(again, { tools: 2, signedIn: false });
    } finally {
      oauth.dispose();
      srv.close();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test('refuses a local server', async () => {
    const oauth = new McpOAuth(new FileSecretStorage(path.join(os.tmpdir(), 'lp-unused-secrets.json')));
    await assert.rejects(signInMcpServer('local', { command: 'node' }, oauth, log, '0'), /local server/);
  });

  test('opens the system browser with the URL as one argument', () => {
    const url = 'https://a.dev/authorize?x=1&y=2';
    assert.deepStrictEqual(browserCommand(url, 'darwin'), ['open', [url]]);
    assert.deepStrictEqual(browserCommand(url, 'linux'), ['xdg-open', [url]]);
    assert.deepStrictEqual(browserCommand(url, 'win32')[1].slice(-1), [url]);
  });

  test('organization servers come first and a settings stub only switches one off', () => {
    const org = { servers: { corp: { url: 'https://corp.example/mcp' }, must: { command: 'node', args: ['m.js'], enabled: true } }, alwaysEnabled: ['must'] };
    const layers = policyAndSettingsLayers(org, { corp: { enabled: false }, must: { enabled: false }, mine: { command: 'x' } });
    assert.deepStrictEqual(layers.map((l) => l.source), ['managed', 'settings']);
    assert.deepStrictEqual(layers.flatMap((l) => l.problems), []);
    assert.strictEqual(layers[0].servers.corp.enabled, false);
    assert.notStrictEqual(layers[0].servers.must.enabled, false);
    assert.deepStrictEqual(Object.keys(layers[1].servers), ['mine']);
    const user = { source: 'user' as const, file: '/home/u/.localpilot/mcp.json', servers: { corp: { command: 'mine' } }, problems: [] };
    const rows = mcpListRows([...layers, user]);
    const corp = rows.find((r) => r.name === 'corp')!;
    assert.deepStrictEqual([corp.source, corp.enabled, corp.shadows], ['managed', false, ['/home/u/.localpilot/mcp.json']]);
  });

  test('switching a settings entry clears both enabled and disabled', () => {
    const on = withMcpEnabled({ command: 'x', disabled: true }, true);
    assert.deepStrictEqual(on, { command: 'x' });
    assert.notStrictEqual(normalizeMcpServers({ mcpServers: { x: on } }).servers.x.enabled, false);
    const off = withMcpEnabled({ command: 'x', disabled: false, enabled: true }, false);
    assert.deepStrictEqual(off, { command: 'x', enabled: false });
    assert.strictEqual(normalizeMcpServers({ mcpServers: { x: off } }).servers.x.enabled, false);
  });
});
