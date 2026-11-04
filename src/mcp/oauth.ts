import { createHash, randomBytes } from 'crypto';
import * as http from 'http';

/**
 * OAuth 2.1 for remote MCP servers (MCP authorization spec 2025-06-18): a 401 with `WWW-Authenticate` leads to the
 * protected-resource metadata (RFC 9728), then the authorization server's metadata (RFC 8414 / OpenID discovery);
 * LocalPilot registers itself (RFC 7591) unless a client is configured, and signs in with the authorization-code flow,
 * PKCE S256 and a loopback redirect. Tokens are stored per server URL, so every window (and the CLI) reuses them.
 */

/** `vscode.SecretStorage`, or the CLI's file-backed equivalent. */
export interface OAuthSecretStore {
  get(key: string): PromiseLike<string | undefined>;
  store(key: string, value: string): PromiseLike<void>;
  delete(key: string): PromiseLike<void>;
  onDidChange?: (listener: (e: { key: string }) => unknown) => { dispose(): unknown };
}

export interface OAuthTokens {
  access_token: string;
  token_type?: string;
  refresh_token?: string;
  /** Epoch ms; absent when the server gave no lifetime. */
  expires_at?: number;
  scope?: string;
}

export interface OAuthClientInfo {
  client_id: string;
  client_secret?: string;
  token_endpoint_auth_method?: string;
  /** The redirect URIs it was registered with (dynamic registration only). */
  redirect_uris?: string[];
}

export interface AuthServerMetadata {
  issuer?: string;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint?: string;
  code_challenge_methods_supported?: string[];
  scopes_supported?: string[];
}

export interface ProtectedResourceMetadata {
  resource?: string;
  authorization_servers?: string[];
  scopes_supported?: string[];
}

interface StoredAuth {
  tokens?: OAuthTokens;
  client?: OAuthClientInfo;
  server?: AuthServerMetadata;
  resource?: string;
  scope?: string;
}

/** The token endpoint answered with an error (`code` is the OAuth `error`, e.g. `invalid_grant`). */
export class OAuthTokenError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) {
    super(message);
    this.name = 'OAuthTokenError';
  }
}

/** Loopback ports tried in turn for the redirect. */
export const OAUTH_CALLBACK_PORTS = [1456, 1457, 1458, 1459, 1460, 1461];
export const OAUTH_CALLBACK_PATH = '/mcp/oauth/callback';
const PROTOCOL_VERSION = '2025-06-18';

/** A remote server answered 401: the user has to sign in (or sign in again). */
export class McpAuthRequiredError extends Error {
  constructor(readonly url: string, readonly wwwAuthenticate: string) {
    super(`${url} needs you to sign in (OAuth)`);
    this.name = 'McpAuthRequiredError';
  }
}

/** `Bearer resource_metadata="…", scope="a b"` → `{ scheme: 'bearer', params }` (parameter names lower-cased). */
export function parseWwwAuthenticate(header: string | null | undefined): { scheme: string; params: Record<string, string> } {
  const text = (header ?? '').trim();
  const scheme = /^([A-Za-z][\w-]*)/.exec(text)?.[1]?.toLowerCase() ?? '';
  const params: Record<string, string> = {};
  for (const m of text.slice(scheme.length).matchAll(/([A-Za-z_][\w-]*)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^\s,]+))/g)) {
    params[m[1].toLowerCase()] = m[2] !== undefined ? m[2].replace(/\\(.)/g, '$1') : m[3];
  }
  return { scheme, params };
}

/** The server URL without fragment or query: the token key and the RFC 8707 `resource`. */
export function canonicalResource(url: string): string {
  const u = new URL(url);
  u.hash = '';
  u.search = '';
  return u.toString();
}

/** Where RFC 9728 metadata may be: the path-specific well-known URL, then the root one. */
export function protectedResourceMetadataUrls(serverUrl: string): string[] {
  const u = new URL(serverUrl);
  const p = u.pathname.replace(/\/+$/, '');
  const urls = [`${u.origin}/.well-known/oauth-protected-resource${p}`, `${u.origin}/.well-known/oauth-protected-resource`];
  return [...new Set(urls)];
}

/** RFC 8414 and OpenID discovery URLs for an issuer, path-aware, in the order the MCP spec gives. */
export function authServerMetadataUrls(issuer: string): string[] {
  const u = new URL(issuer);
  const p = u.pathname.replace(/\/+$/, '');
  const urls = p
    ? [`${u.origin}/.well-known/oauth-authorization-server${p}`, `${u.origin}/.well-known/openid-configuration${p}`, `${u.origin}${p}/.well-known/openid-configuration`]
    : [`${u.origin}/.well-known/oauth-authorization-server`, `${u.origin}/.well-known/openid-configuration`];
  return [...new Set(urls)];
}

const b64url = (b: Buffer) => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** A PKCE verifier (43 characters) and its S256 challenge. */
export function pkcePair(): { verifier: string; challenge: string; method: 'S256' } {
  const verifier = b64url(randomBytes(32));
  return { verifier, challenge: pkceChallenge(verifier), method: 'S256' };
}

export function pkceChallenge(verifier: string): string {
  return b64url(createHash('sha256').update(verifier).digest());
}

async function getJson(url: string, fetchImpl: typeof fetch): Promise<Record<string, unknown> | undefined> {
  try {
    const res = await fetchImpl(url, { headers: { accept: 'application/json', 'mcp-protocol-version': PROTOCOL_VERSION } });
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      return undefined;
    }
    const j = (await res.json()) as unknown;
    return j && typeof j === 'object' && !Array.isArray(j) ? (j as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** The protected-resource metadata: from the `resource_metadata` the 401 named, else the well-known URLs. */
export async function discoverProtectedResource(serverUrl: string, resourceMetadataUrl: string | undefined, fetchImpl: typeof fetch = fetch): Promise<ProtectedResourceMetadata | undefined> {
  for (const url of resourceMetadataUrl ? [resourceMetadataUrl] : protectedResourceMetadataUrls(serverUrl)) {
    const j = await getJson(url, fetchImpl);
    if (j && Array.isArray(j.authorization_servers)) {
      return {
        resource: typeof j.resource === 'string' ? j.resource : undefined,
        authorization_servers: j.authorization_servers.filter((s): s is string => typeof s === 'string'),
        scopes_supported: Array.isArray(j.scopes_supported) ? j.scopes_supported.filter((s): s is string => typeof s === 'string') : undefined,
      };
    }
  }
  return undefined;
}

/**
 * The authorization server's metadata. A server that publishes none gets the defaults of the 2025-03-26 spec:
 * `/authorize`, `/token` and `/register` at the issuer's origin.
 */
export async function discoverAuthServer(issuer: string, fetchImpl: typeof fetch = fetch): Promise<AuthServerMetadata> {
  for (const url of authServerMetadataUrls(issuer)) {
    const j = await getJson(url, fetchImpl);
    if (j && typeof j.authorization_endpoint === 'string' && typeof j.token_endpoint === 'string') {
      const list = (v: unknown) => (Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : undefined);
      return {
        issuer: typeof j.issuer === 'string' ? j.issuer : issuer,
        authorization_endpoint: j.authorization_endpoint,
        token_endpoint: j.token_endpoint,
        registration_endpoint: typeof j.registration_endpoint === 'string' ? j.registration_endpoint : undefined,
        code_challenge_methods_supported: list(j.code_challenge_methods_supported),
        scopes_supported: list(j.scopes_supported),
      };
    }
  }
  const origin = new URL(issuer).origin;
  return { issuer, authorization_endpoint: `${origin}/authorize`, token_endpoint: `${origin}/token`, registration_endpoint: `${origin}/register` };
}

/** Dynamic client registration (RFC 7591) as a public client, with every loopback redirect LocalPilot may use. */
export async function registerClient(server: AuthServerMetadata, redirectUris: string[], scope: string | undefined, fetchImpl: typeof fetch = fetch): Promise<OAuthClientInfo> {
  if (!server.registration_endpoint) {
    throw new Error('the authorization server does not support dynamic client registration: register LocalPilot there and set "oauthClient": { "clientId": "…" } on this server');
  }
  const res = await fetchImpl(server.registration_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ client_name: 'LocalPilot', redirect_uris: redirectUris, grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none', ...(scope ? { scope } : {}) }),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`client registration failed: ${res.status} ${text.slice(0, 300)}`);
  }
  const j = JSON.parse(text) as Partial<OAuthClientInfo>;
  if (typeof j.client_id !== 'string' || !j.client_id) {
    throw new Error('client registration returned no client_id');
  }
  return { client_id: j.client_id, client_secret: j.client_secret, token_endpoint_auth_method: j.token_endpoint_auth_method, redirect_uris: redirectUris };
}

/** The browser URL that starts the sign-in. */
export function authorizationUrl(server: AuthServerMetadata, o: { clientId: string; redirectUri: string; challenge: string; state: string; scope?: string; resource?: string }): string {
  const u = new URL(server.authorization_endpoint);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('client_id', o.clientId);
  u.searchParams.set('redirect_uri', o.redirectUri);
  u.searchParams.set('code_challenge', o.challenge);
  u.searchParams.set('code_challenge_method', 'S256');
  u.searchParams.set('state', o.state);
  if (o.scope) {
    u.searchParams.set('scope', o.scope);
  }
  if (o.resource) {
    u.searchParams.set('resource', o.resource);
  }
  return u.toString();
}

/** A token-endpoint request with the client's authentication (HTTP Basic for a confidential client unless it registered `client_secret_post`). */
export async function tokenRequest(server: AuthServerMetadata, client: OAuthClientInfo, params: Record<string, string | undefined>, fetchImpl: typeof fetch = fetch): Promise<OAuthTokens> {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v) {
      body.set(k, v);
    }
  }
  const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' };
  if (client.client_secret && client.token_endpoint_auth_method !== 'client_secret_post') {
    headers.authorization = `Basic ${Buffer.from(`${encodeURIComponent(client.client_id)}:${encodeURIComponent(client.client_secret)}`).toString('base64')}`;
  } else {
    body.set('client_id', client.client_id);
    if (client.client_secret) {
      body.set('client_secret', client.client_secret);
    }
  }
  const res = await fetchImpl(server.token_endpoint, { method: 'POST', headers, body: body.toString() });
  const text = await res.text();
  let j: Record<string, unknown> = {};
  try {
    j = JSON.parse(text) as Record<string, unknown>;
  } catch {
    /* reported below */
  }
  if (!res.ok || typeof j.access_token !== 'string') {
    const why = typeof j.error === 'string' ? `${j.error}${typeof j.error_description === 'string' ? `: ${j.error_description}` : ''}` : text.slice(0, 300);
    throw new OAuthTokenError(`token request failed: ${res.status} ${why}`, res.status, typeof j.error === 'string' ? j.error : undefined);
  }
  const expiresIn = Number(j.expires_in);
  return {
    access_token: j.access_token,
    token_type: typeof j.token_type === 'string' ? j.token_type : undefined,
    refresh_token: typeof j.refresh_token === 'string' ? j.refresh_token : params.refresh_token,
    expires_at: Number.isFinite(expiresIn) && expiresIn > 0 ? Date.now() + expiresIn * 1000 : undefined,
    scope: typeof j.scope === 'string' ? j.scope : undefined,
  };
}

const PAGE = (title: string, text: string) =>
  `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font-family:system-ui,sans-serif;max-width:32rem;margin:15vh auto;text-align:center"><h2>${title}</h2><p>${text}</p></body>`;

/**
 * Listens for the redirect on `http://127.0.0.1:<port>/mcp/oauth/callback`, trying the ports in turn. `code` resolves
 * with the authorization code once a request with the expected `state` arrives, and rejects on an error reply, after
 * `timeoutMs` or when `signal` aborts.
 */
export async function listenForCallback(state: string, opts: { ports?: number[]; timeoutMs?: number; signal?: AbortSignal } = {}): Promise<{ redirectUri: string; code: Promise<string>; close(): void }> {
  let settle: { resolve: (c: string) => void; reject: (e: Error) => void } = { resolve: () => undefined, reject: () => undefined };
  const code = new Promise<string>((resolve, reject) => (settle = { resolve, reject }));
  code.catch(() => undefined);
  const server = http.createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (u.pathname !== OAUTH_CALLBACK_PATH) {
      res.writeHead(404).end();
      return;
    }
    if (u.searchParams.get('state') !== state) {
      res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' }).end(PAGE('Sign-in failed', 'This sign-in link is out of date. Start it again from LocalPilot.'));
      return;
    }
    const err = u.searchParams.get('error');
    const got = u.searchParams.get('code');
    if (err || !got) {
      res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' }).end(PAGE('Sign-in failed', 'The server refused the sign-in. You can close this tab.'));
      settle.reject(new Error(`sign-in refused: ${err ?? 'no code'}${u.searchParams.get('error_description') ? ` (${u.searchParams.get('error_description')})` : ''}`));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(PAGE('Signed in', 'LocalPilot is connected. You can close this tab.'));
    settle.resolve(got);
  });
  let port: number | undefined;
  for (const p of opts.ports ?? OAUTH_CALLBACK_PORTS) {
    const ok = await new Promise<boolean>((resolve) => {
      const onError = () => resolve(false);
      server.once('error', onError);
      server.listen(p, '127.0.0.1', () => {
        server.off('error', onError);
        resolve(true);
      });
    });
    if (ok) {
      port = (server.address() as { port: number }).port;
      break;
    }
  }
  if (port === undefined) {
    throw new Error(`no free port for the sign-in callback (tried ${(opts.ports ?? OAUTH_CALLBACK_PORTS).join(', ')})`);
  }
  const timer = setTimeout(() => settle.reject(new Error('sign-in timed out after 10 minutes')), opts.timeoutMs ?? 10 * 60_000);
  timer.unref?.();
  const onAbort = () => settle.reject(new Error('sign-in cancelled'));
  opts.signal?.addEventListener('abort', onAbort, { once: true });
  const close = () => {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onAbort);
    server.close();
    server.closeAllConnections?.();
  };
  void code.then(close, close);
  return { redirectUri: `http://127.0.0.1:${port}${OAUTH_CALLBACK_PATH}`, code, close };
}

const KEY_PREFIX = 'localpilot.mcp.oauth.';

/** Sign-in state, tokens and refresh for every OAuth-protected MCP server, keyed by server URL. */
export class McpOAuth {
  private cache = new Map<string, StoredAuth>();
  private challenges = new Map<string, string>();
  private refreshing = new Map<string, Promise<OAuthTokens | undefined>>();
  private sub?: { dispose(): unknown };
  /** A server rejected its token and could not be refreshed (the manager marks it as needing sign-in). */
  onAuthRequired?: (url: string) => void;

  constructor(
    private readonly store: OAuthSecretStore,
    private readonly opts: { openExternal: (url: string) => PromiseLike<unknown>; log?: (m: string) => void; fetch?: typeof fetch; ports?: number[]; timeoutMs?: number } = { openExternal: async () => undefined }
  ) {
    // Signed in (or out) in another window.
    this.sub = store.onDidChange?.((e) => {
      if (e.key.startsWith(KEY_PREFIX)) {
        this.cache.delete(e.key.slice(KEY_PREFIX.length));
      }
    });
  }

  private get fetchImpl(): typeof fetch {
    return this.opts.fetch ?? fetch;
  }

  private async load(resource: string, fresh = false): Promise<StoredAuth> {
    const hit = fresh ? undefined : this.cache.get(resource);
    if (hit) {
      return hit;
    }
    let a: StoredAuth = {};
    try {
      const raw = await this.store.get(KEY_PREFIX + resource);
      a = raw ? (JSON.parse(raw) as StoredAuth) : {};
    } catch {
      a = {};
    }
    this.cache.set(resource, a);
    return a;
  }

  private async save(resource: string, a: StoredAuth): Promise<void> {
    this.cache.set(resource, a);
    await this.store.store(KEY_PREFIX + resource, JSON.stringify(a));
  }

  /** Whether tokens are stored for this server. */
  async signedIn(url: string): Promise<boolean> {
    return !!(await this.load(canonicalResource(url))).tokens?.access_token;
  }

  /** Forgets the tokens (the client registration is kept). */
  async signOut(url: string): Promise<void> {
    const resource = canonicalResource(url);
    const a = await this.load(resource);
    await this.save(resource, { ...a, tokens: undefined });
  }

  /** A valid access token, refreshed when it expires within a minute; undefined when not signed in. */
  async accessToken(url: string): Promise<string | undefined> {
    const resource = canonicalResource(url);
    const a = await this.load(resource);
    if (!a.tokens?.access_token) {
      return undefined;
    }
    if (!a.tokens.expires_at || a.tokens.expires_at - Date.now() > 60_000) {
      return a.tokens.access_token;
    }
    return (await this.refresh(resource))?.access_token;
  }

  /**
   * One refresh per server at a time (per process). Only a refused refresh token (`invalid_grant`) forgets the tokens,
   * and not when another window or the CLI has already rotated them; a network or server error keeps them.
   */
  private refresh(resource: string): Promise<OAuthTokens | undefined> {
    const running = this.refreshing.get(resource);
    if (running) {
      return running;
    }
    const p = (async () => {
      const a = await this.load(resource);
      if (!a.tokens?.refresh_token || !a.client || !a.server) {
        return undefined;
      }
      try {
        const tokens = await tokenRequest(a.server, a.client, { grant_type: 'refresh_token', refresh_token: a.tokens.refresh_token, resource: a.resource, scope: a.scope }, this.fetchImpl);
        await this.save(resource, { ...a, tokens });
        this.opts.log?.(`OAuth: refreshed the token for ${resource}`);
        return tokens;
      } catch (e) {
        this.opts.log?.(`OAuth: refreshing the token for ${resource} failed: ${e instanceof Error ? e.message : String(e)}`);
        const stored = await this.load(resource, true);
        const t = stored.tokens;
        if (t?.access_token && (t.refresh_token !== a.tokens.refresh_token || t.access_token !== a.tokens.access_token)) {
          this.opts.log?.(`OAuth: another window refreshed the token for ${resource}`);
          return t;
        }
        if (e instanceof OAuthTokenError && (e.status === 400 || e.status === 401) && (e.code === 'invalid_grant' || e.code === 'invalid_token' || e.code === 'unauthorized_client')) {
          await this.save(resource, { ...stored, tokens: undefined });
        }
        return undefined;
      }
    })().finally(() => this.refreshing.delete(resource));
    this.refreshing.set(resource, p);
    return p;
  }

  /**
   * A fetch for one server: sends the Bearer token, refreshes it once on a 401, and otherwise throws
   * `McpAuthRequiredError` (remembering the `WWW-Authenticate` challenge for the sign-in).
   */
  fetchFor(url: string, base: typeof fetch = this.fetchImpl): typeof fetch {
    const resource = canonicalResource(url);
    const send = (input: Parameters<typeof fetch>[0], init: RequestInit | undefined, token: string | undefined) => {
      if (!token) {
        return base(input, init);
      }
      const headers = new Headers(init?.headers);
      headers.set('authorization', `Bearer ${token}`);
      return base(input, { ...init, headers });
    };
    return (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const token = await this.accessToken(url);
      let res = await send(input, init, token);
      if (res.status !== 401) {
        return res;
      }
      let challenge = res.headers.get('www-authenticate') ?? '';
      await res.body?.cancel().catch(() => undefined);
      if (token) {
        const fresh = await this.refresh(resource);
        if (fresh?.access_token && fresh.access_token !== token) {
          res = await send(input, init, fresh.access_token);
          if (res.status !== 401) {
            return res;
          }
          challenge = res.headers.get('www-authenticate') ?? challenge;
          await res.body?.cancel().catch(() => undefined);
        }
      }
      this.challenges.set(resource, challenge);
      this.onAuthRequired?.(url);
      throw new McpAuthRequiredError(url, challenge);
    }) as typeof fetch;
  }

  /** The `WWW-Authenticate` of the 401 that started it, or a fresh one from an unauthenticated `initialize`. */
  private async challenge(url: string, resource: string): Promise<string> {
    const known = this.challenges.get(resource);
    if (known !== undefined) {
      return known;
    }
    try {
      const res = await this.fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': PROTOCOL_VERSION },
        body: JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'LocalPilot', version: '0' } } }),
      });
      await res.body?.cancel().catch(() => undefined);
      return res.headers.get('www-authenticate') ?? '';
    } catch {
      return '';
    }
  }

  /**
   * Signs in to a server in the browser: discovery, client registration (unless `client` is given), PKCE S256 and a
   * loopback redirect; the tokens are stored for every window.
   */
  async authenticate(url: string, opts: { client?: { clientId: string; clientSecret?: string }; signal?: AbortSignal } = {}): Promise<void> {
    const resource = canonicalResource(url);
    const { params } = parseWwwAuthenticate(await this.challenge(url, resource));
    const prm = await discoverProtectedResource(url, params.resource_metadata, this.fetchImpl);
    const issuer = prm?.authorization_servers?.[0] ?? new URL(url).origin;
    const server = await discoverAuthServer(issuer, this.fetchImpl);
    if (server.code_challenge_methods_supported?.length && !server.code_challenge_methods_supported.includes('S256')) {
      throw new Error(`the authorization server ${issuer} does not support PKCE S256`);
    }
    const scope = params.scope || prm?.scopes_supported?.join(' ') || undefined;
    const audience = prm?.resource ?? resource;
    const stored = await this.load(resource);
    const ports = this.opts.ports ?? OAUTH_CALLBACK_PORTS;
    const redirectUris = ports.map((p) => `http://127.0.0.1:${p}${OAUTH_CALLBACK_PATH}`);
    let client: OAuthClientInfo;
    if (opts.client) {
      client = { client_id: opts.client.clientId, client_secret: opts.client.clientSecret, token_endpoint_auth_method: opts.client.clientSecret ? 'client_secret_basic' : 'none' };
    } else if (stored.client && stored.client.redirect_uris && stored.server?.token_endpoint === server.token_endpoint && redirectUris.every((u) => stored.client!.redirect_uris!.includes(u))) {
      client = stored.client;
    } else {
      client = await registerClient(server, redirectUris, scope, this.fetchImpl);
      this.opts.log?.(`OAuth: registered LocalPilot with ${issuer} as ${client.client_id}`);
    }
    const state = b64url(randomBytes(16));
    const pkce = pkcePair();
    const cb = await listenForCallback(state, { ports, timeoutMs: this.opts.timeoutMs, signal: opts.signal });
    try {
      const link = authorizationUrl(server, { clientId: client.client_id, redirectUri: cb.redirectUri, challenge: pkce.challenge, state, scope, resource: audience });
      this.opts.log?.(`OAuth: opening ${server.authorization_endpoint} to sign in to ${resource}`);
      await this.opts.openExternal(link);
      const code = await cb.code;
      const tokens = await tokenRequest(server, client, { grant_type: 'authorization_code', code, redirect_uri: cb.redirectUri, code_verifier: pkce.verifier, resource: audience }, this.fetchImpl);
      this.challenges.delete(resource);
      await this.save(resource, { tokens, client, server, resource: audience, scope });
    } finally {
      cb.close();
    }
  }

  dispose(): void {
    this.sub?.dispose();
  }
}
