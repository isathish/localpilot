import * as assert from 'assert';
import * as http from 'http';
import { AddressInfo } from 'net';
import {
  authServerMetadataUrls,
  canonicalResource,
  discoverAuthServer,
  discoverProtectedResource,
  listenForCallback,
  McpAuthRequiredError,
  McpOAuth,
  OAuthSecretStore,
  parseWwwAuthenticate,
  pkceChallenge,
  pkcePair,
  protectedResourceMetadataUrls,
} from '../mcp/oauth';

/**
 * A mock MCP server with its own authorization server: protected-resource and RFC 8414 metadata under a path,
 * dynamic registration, an /authorize endpoint that redirects straight back (as a browser would after consent),
 * and a /token endpoint that checks the PKCE verifier.
 */
function authServer(): Promise<{ origin: string; close(): void; seen: Record<string, unknown>; issued: string[] }> {
  const seen: Record<string, unknown> = {};
  const issued: string[] = [];
  const challenges = new Map<string, string>();
  let n = 0;
  const server = http.createServer(async (req, res) => {
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const u = new URL(req.url ?? '/', origin);
    const body = await new Promise<string>((r) => {
      let b = '';
      req.on('data', (c) => (b += c));
      req.on('end', () => r(b));
    });
    const json = (o: unknown, status = 200) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(o));
    if (u.pathname === '/.well-known/oauth-protected-resource/mcp') {
      return json({ resource: `${origin}/mcp`, authorization_servers: [`${origin}/tenant`], scopes_supported: ['read', 'write'] });
    }
    if (u.pathname === '/.well-known/oauth-authorization-server/tenant') {
      return json({ issuer: `${origin}/tenant`, authorization_endpoint: `${origin}/tenant/authorize`, token_endpoint: `${origin}/tenant/token`, registration_endpoint: `${origin}/tenant/register`, code_challenge_methods_supported: ['S256'] });
    }
    if (u.pathname === '/tenant/register') {
      seen.registration = JSON.parse(body);
      return json({ client_id: 'dyn-client', token_endpoint_auth_method: 'none' }, 201);
    }
    if (u.pathname === '/tenant/authorize') {
      seen.authorize = Object.fromEntries(u.searchParams);
      const code = `code-${++n}`;
      challenges.set(code, u.searchParams.get('code_challenge') ?? '');
      const back = new URL(u.searchParams.get('redirect_uri')!);
      back.searchParams.set('code', code);
      back.searchParams.set('state', u.searchParams.get('state')!);
      return res.writeHead(302, { location: back.toString() }).end();
    }
    if (u.pathname === '/tenant/token') {
      const p = new URLSearchParams(body);
      if (p.get('grant_type') === 'authorization_code') {
        if (pkceChallenge(p.get('code_verifier') ?? '') !== challenges.get(p.get('code') ?? '')) {
          return json({ error: 'invalid_grant', error_description: 'PKCE mismatch' }, 400);
        }
        seen.token = Object.fromEntries(p);
        issued.push('access-1');
        return json({ access_token: 'access-1', token_type: 'Bearer', expires_in: 3600, refresh_token: 'refresh-1' });
      }
      if (p.get('grant_type') === 'refresh_token' && p.get('refresh_token') === 'refresh-1') {
        issued.push('access-2');
        return json({ access_token: 'access-2', token_type: 'Bearer', expires_in: 3600 });
      }
      return json({ error: 'invalid_grant' }, 400);
    }
    if (u.pathname === '/mcp') {
      const auth = req.headers.authorization ?? '';
      if (auth !== `Bearer ${issued[issued.length - 1]}` || !issued.length) {
        return res.writeHead(401, { 'www-authenticate': `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp", scope="read"` }).end();
      }
      return json({ ok: true });
    }
    return res.writeHead(404).end();
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => server.close(), seen, issued })));
}

function memoryStore(): OAuthSecretStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, get: async (k) => data.get(k), store: async (k, v) => void data.set(k, v), delete: async (k) => void data.delete(k) };
}

suite('MCP OAuth', () => {
  test('parses WWW-Authenticate challenges', () => {
    const c = parseWwwAuthenticate('Bearer resource_metadata="https://x/.well-known/oauth-protected-resource", scope="a b", error=invalid_token');
    assert.strictEqual(c.scheme, 'bearer');
    assert.deepStrictEqual(c.params, { resource_metadata: 'https://x/.well-known/oauth-protected-resource', scope: 'a b', error: 'invalid_token' });
    assert.deepStrictEqual(parseWwwAuthenticate(undefined), { scheme: '', params: {} });
  });

  test('builds the path-aware discovery URLs', () => {
    assert.deepStrictEqual(protectedResourceMetadataUrls('https://h.io/v1/mcp/'), ['https://h.io/.well-known/oauth-protected-resource/v1/mcp', 'https://h.io/.well-known/oauth-protected-resource']);
    assert.deepStrictEqual(authServerMetadataUrls('https://auth.io/tenant'), ['https://auth.io/.well-known/oauth-authorization-server/tenant', 'https://auth.io/.well-known/openid-configuration/tenant', 'https://auth.io/tenant/.well-known/openid-configuration']);
    assert.deepStrictEqual(authServerMetadataUrls('https://auth.io'), ['https://auth.io/.well-known/oauth-authorization-server', 'https://auth.io/.well-known/openid-configuration']);
    assert.strictEqual(canonicalResource('https://h.io/mcp?x=1#y'), 'https://h.io/mcp');
  });

  test('PKCE S256: a 43-character verifier and its base64url SHA-256 challenge', () => {
    const p = pkcePair();
    assert.strictEqual(p.method, 'S256');
    assert.strictEqual(p.verifier.length, 43);
    assert.match(p.verifier, /^[A-Za-z0-9_-]+$/);
    assert.strictEqual(p.challenge, pkceChallenge(p.verifier));
    // base64url without padding: SHA-256 of "" is 47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU= in plain base64.
    assert.strictEqual(pkceChallenge(''), '47DEQpj8HBSa-_TImW-5JCeuQeRkm5NMpJWZG3hSuFU');
  });

  test('discovers the protected resource and its authorization server, with spec defaults as a fallback', async () => {
    const srv = await authServer();
    try {
      const prm = await discoverProtectedResource(`${srv.origin}/mcp`, undefined);
      assert.deepStrictEqual(prm?.authorization_servers, [`${srv.origin}/tenant`]);
      const as = await discoverAuthServer(prm!.authorization_servers![0]);
      assert.strictEqual(as.token_endpoint, `${srv.origin}/tenant/token`);
      assert.strictEqual(as.registration_endpoint, `${srv.origin}/tenant/register`);
      const none = await discoverAuthServer(`${srv.origin}/nothing`);
      assert.strictEqual(none.authorization_endpoint, `${srv.origin}/authorize`);
      assert.strictEqual(none.token_endpoint, `${srv.origin}/token`);
    } finally {
      srv.close();
    }
  });

  test('the callback listener takes the next free port and checks the state', async () => {
    const blocker = http.createServer();
    await new Promise<void>((r) => blocker.listen(0, '127.0.0.1', () => r()));
    const busy = (blocker.address() as AddressInfo).port;
    const free = await new Promise<number>((r) => {
      const s = http.createServer().listen(0, '127.0.0.1', () => {
        const p = (s.address() as AddressInfo).port;
        s.close(() => r(p));
      });
    });
    try {
      const cb = await listenForCallback('st', { ports: [busy, free], timeoutMs: 5000 });
      assert.strictEqual(cb.redirectUri, `http://127.0.0.1:${free}/mcp/oauth/callback`);
      const wrong = await fetch(`${cb.redirectUri}?code=c&state=other`);
      assert.strictEqual(wrong.status, 400);
      const ok = await fetch(`${cb.redirectUri}?code=the-code&state=st`);
      assert.strictEqual(ok.status, 200);
      assert.strictEqual(await cb.code, 'the-code');
    } finally {
      blocker.close();
    }
  });

  test('signs in end to end: dynamic registration, PKCE, tokens stored per URL, Bearer header, refresh', async () => {
    const srv = await authServer();
    const store = memoryStore();
    const port = await new Promise<number>((r) => {
      const s = http.createServer().listen(0, '127.0.0.1', () => {
        const p = (s.address() as AddressInfo).port;
        s.close(() => r(p));
      });
    });
    const opened: string[] = [];
    const oauth = new McpOAuth(store, { openExternal: async (url) => {
        opened.push(url);
        // The "browser": follows /authorize's redirect to the loopback callback.
        await fetch(url).catch(() => undefined);
      }, ports: [port], timeoutMs: 10_000 });
    const url = `${srv.origin}/mcp`;
    try {
      const f = oauth.fetchFor(url);
      await assert.rejects(f(url), (e: unknown) => e instanceof McpAuthRequiredError);
      await oauth.authenticate(url);
      assert.strictEqual(opened.length, 1);
      const auth = srv.seen.authorize as Record<string, string>;
      assert.strictEqual(auth.code_challenge_method, 'S256');
      assert.strictEqual(auth.client_id, 'dyn-client');
      assert.strictEqual(auth.resource, url);
      assert.strictEqual(auth.scope, 'read');
      assert.deepStrictEqual((srv.seen.registration as { redirect_uris: string[] }).redirect_uris, [`http://127.0.0.1:${port}/mcp/oauth/callback`]);
      assert.ok(store.data.has(`localpilot.mcp.oauth.${url}`), 'tokens are keyed by the server URL');
      assert.strictEqual(await oauth.accessToken(url), 'access-1');
      assert.strictEqual((await f(url)).status, 200);
      // A second window (a new helper on the same store) reuses the tokens; an expired token is refreshed.
      const raw = JSON.parse(store.data.get(`localpilot.mcp.oauth.${url}`)!);
      raw.tokens.expires_at = Date.now() - 1000;
      store.data.set(`localpilot.mcp.oauth.${url}`, JSON.stringify(raw));
      const other = new McpOAuth(store, { openExternal: async () => undefined });
      assert.strictEqual(await other.accessToken(url), 'access-2');
      assert.strictEqual((await other.fetchFor(url)(url)).status, 200);
      other.dispose();
    } finally {
      oauth.dispose();
      srv.close();
    }
  });
  test('a failed refresh keeps the tokens unless the refresh token is refused; a rotation by another window wins', async () => {
    const url = 'https://mcp.example.com/mcp';
    const key = `localpilot.mcp.oauth.${canonicalResource(url)}`;
    const store = memoryStore();
    const seed = (refresh: string) =>
      store.data.set(key, JSON.stringify({ client: { client_id: 'c' }, server: { authorization_endpoint: 'https://as.example.com/authorize', token_endpoint: 'https://as.example.com/token' }, tokens: { access_token: `access-${refresh}`, refresh_token: refresh, expires_at: Date.now() - 1000 } }));
    let mode: 'down' | 'rotate' = 'down';
    let current = 'r1';
    const tokenFetch = (async (_input: unknown, init?: RequestInit) => {
      if (mode === 'down') {
        return new Response('upstream unavailable', { status: 500 });
      }
      // Rotating one-time refresh tokens: only the latest one is accepted.
      const p = new URLSearchParams(String(init?.body));
      if (p.get('refresh_token') !== current) {
        return new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400, headers: { 'content-type': 'application/json' } });
      }
      current = `${current}x`;
      return new Response(JSON.stringify({ access_token: `access-${current}`, refresh_token: current, expires_in: 3600 }), { headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    seed('r1');
    const a = new McpOAuth(store, { openExternal: async () => undefined, fetch: tokenFetch });
    const b = new McpOAuth(store, { openExternal: async () => undefined, fetch: tokenFetch });
    try {
      // A 500 (or a network error) does not sign the user out.
      assert.strictEqual(await a.accessToken(url), undefined);
      assert.strictEqual(JSON.parse(store.data.get(key)!).tokens.refresh_token, 'r1');
      const offline = new McpOAuth(store, { openExternal: async () => undefined, fetch: (async () => Promise.reject(new TypeError('fetch failed'))) as typeof fetch });
      assert.strictEqual(await offline.accessToken(url), undefined);
      assert.strictEqual(JSON.parse(store.data.get(key)!).tokens.refresh_token, 'r1');
      offline.dispose();
      // Both windows hold r1 cached; b rotates it first, then a's stale r1 is refused and a takes b's tokens.
      mode = 'rotate';
      assert.strictEqual(await b.accessToken(url), 'access-r1x');
      assert.strictEqual(await a.accessToken(url), 'access-r1x');
      assert.strictEqual(JSON.parse(store.data.get(key)!).tokens.refresh_token, 'r1x');
      // A refresh token the server refuses outright is forgotten.
      seed('stale');
      const c = new McpOAuth(store, { openExternal: async () => undefined, fetch: tokenFetch });
      assert.strictEqual(await c.accessToken(url), undefined);
      assert.strictEqual(JSON.parse(store.data.get(key)!).tokens, undefined);
      c.dispose();
    } finally {
      a.dispose();
      b.dispose();
    }
  });
});
