// WebDAV backend (design §14.5): Nextcloud, ownCloud, Synology, Apache mod_dav. PROPFIND Depth 1 to list (folders
// walked for `streams/<id>/`), GET, PUT to `<key>.tmp-<random>` then MOVE into place (`Overwrite: F` for
// create-if-absent, `T` otherwise), DELETE, MKCOL for missing folders. Basic auth (password from SecretStorage / the CLI
// key file) or a bearer token. HTTPS is required except for localhost. Pure Node.
import * as crypto from 'crypto';
import { BackendError, checkKey, CheckResult, httpCode, PutOptions, reasonOf, RemoteEntry, requireHttps, SyncBackend } from './backend';

export interface WebDavOptions {
  url: string;
  username?: string;
  password?: string;
  token?: string;
  fetch?: typeof fetch;
}

function unescapeXml(s: string): string {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n))).replace(/&amp;/g, '&');
}

/** `<d:response>` blocks of a multistatus body (namespace prefixes vary by server: d:, D:, lp1:, none). */
export function parseMultistatus(xml: string): { href: string; dir: boolean; size: number; etag?: string; modified?: number }[] {
  const out: { href: string; dir: boolean; size: number; etag?: string; modified?: number }[] = [];
  for (const m of xml.matchAll(/<(?:[\w-]+:)?response\b[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?response>/gi)) {
    const body = m[1];
    const get = (name: string) => {
      const r = new RegExp(`<(?:[\\w-]+:)?${name}\\b[^>]*>([\\s\\S]*?)</(?:[\\w-]+:)?${name}>`, 'i').exec(body);
      return r ? unescapeXml(r[1].trim()) : undefined;
    };
    const href = get('href');
    if (!href) {
      continue;
    }
    const dir = /<(?:[\w-]+:)?collection\b/i.test(body);
    const modified = Date.parse(get('getlastmodified') ?? '');
    out.push({ href, dir, size: Number(get('getcontentlength') ?? 0), etag: get('getetag'), ...(Number.isFinite(modified) ? { modified } : {}) });
  }
  return out;
}

export class WebDavBackend implements SyncBackend {
  readonly kind = 'webdav' as const;
  readonly label: string;
  private readonly root: URL;
  private readonly auth?: string;
  private readonly fetchFn: typeof fetch;
  private readonly made = new Set<string>();

  constructor(o: WebDavOptions) {
    const base = requireHttps(o.url, 'The WebDAV URL');
    this.label = `${base.origin}${base.pathname}`;
    base.username = '';
    base.password = '';
    this.root = new URL(`${base.toString().replace(/\/+$/, '')}/localpilot-sync/`);
    this.auth = o.token ? `Bearer ${o.token}` : o.username || o.password ? `Basic ${Buffer.from(`${o.username ?? ''}:${o.password ?? ''}`, 'utf8').toString('base64')}` : undefined;
    this.fetchFn = o.fetch ?? fetch;
  }

  private url(key: string): URL {
    return new URL(key.split('/').map((p) => (p ? encodeURIComponent(p) : p)).join('/'), this.root);
  }

  private async req(method: string, url: URL, o: { body?: Uint8Array | string; headers?: Record<string, string> } = {}): Promise<Response> {
    try {
      return await this.fetchFn(url, { method, headers: { ...(this.auth ? { authorization: this.auth } : {}), ...(o.headers ?? {}) }, body: o.body === undefined ? undefined : typeof o.body === 'string' ? o.body : Buffer.from(o.body), redirect: 'manual' } as RequestInit);
    } catch (e) {
      throw new BackendError(reasonOf(e) === 'other' ? 'offline' : reasonOf(e), `WebDAV ${method} failed: ${(e as Error).message}`);
    }
  }

  private async fail(r: Response, what: string): Promise<never> {
    await r.arrayBuffer().catch(() => undefined);
    throw new BackendError(httpCode(r.status), `WebDAV ${what}: ${r.status} ${r.statusText}`, r.status);
  }

  /** Creates the folders of `key` (MKCOL each missing level; 405 = exists). */
  private async ensureDirs(key: string): Promise<void> {
    const parts = key.split('/').slice(0, -1);
    const chain = [''];
    for (const p of parts) {
      chain.push(`${chain[chain.length - 1]}${p}/`);
    }
    for (const dir of chain) {
      if (this.made.has(dir)) {
        continue;
      }
      const u = dir ? this.url(dir) : this.root;
      const r = await this.req('MKCOL', u);
      await r.arrayBuffer().catch(() => undefined);
      if (!(r.ok || r.status === 405 || r.status === 301)) {
        if (r.status === 409) {
          throw new BackendError('not-found', `WebDAV: the folder above ${u.pathname} does not exist`, 409);
        }
        throw new BackendError(httpCode(r.status), `WebDAV MKCOL ${u.pathname}: ${r.status}`, r.status);
      }
      this.made.add(dir);
    }
  }

  async check(): Promise<CheckResult> {
    try {
      const parent = new URL('..', this.root);
      const r = await this.req('PROPFIND', parent, { headers: { depth: '0' } });
      await r.arrayBuffer().catch(() => undefined);
      if (r.status === 401) {
        return { ok: false, reason: 'auth', message: 'Sign-in failed: check the user name and the password' };
      }
      if (r.status === 403) {
        return { ok: false, reason: 'forbidden', message: 'Access denied to this folder' };
      }
      if (r.status === 404) {
        return { ok: false, reason: 'not-found', message: `${parent.pathname} does not exist on the server` };
      }
      if (!(r.ok || r.status === 207)) {
        return { ok: false, reason: 'other', message: `The server answered ${r.status} ${r.statusText}` };
      }
      await this.ensureDirs('x');
      return { ok: true };
    } catch (e) {
      const be = e instanceof BackendError ? e : new BackendError(reasonOf(e), String((e as Error).message ?? e));
      return { ok: false, reason: be.code === 'precondition' || be.code === 'not-implemented' ? 'other' : be.code, message: be.message };
    }
  }

  async list(prefix: string, after?: string): Promise<RemoteEntry[]> {
    const slash = prefix.lastIndexOf('/');
    const dirKey = slash >= 0 ? prefix.slice(0, slash + 1) : '';
    const out: RemoteEntry[] = [];
    const walk = async (dir: string): Promise<void> => {
      const u = dir ? this.url(dir) : this.root;
      const r = await this.req('PROPFIND', u, { headers: { depth: '1', 'content-type': 'application/xml' }, body: '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/><d:getcontentlength/><d:getetag/><d:getlastmodified/></d:prop></d:propfind>' });
      if (r.status === 404) {
        await r.arrayBuffer().catch(() => undefined);
        return;
      }
      if (r.status !== 207 && !r.ok) {
        await this.fail(r, `list ${dir || '/'}`);
      }
      const self = decodeURIComponent(u.pathname).replace(/\/+$/, '');
      for (const item of parseMultistatus(await r.text())) {
        const p = decodeURIComponent(new URL(item.href, u).pathname).replace(/\/+$/, '');
        if (p === self || !p.startsWith(`${self}/`)) {
          continue;
        }
        const name = p.slice(self.length + 1);
        if (!name || name.includes('/') || name.startsWith('.') || /\.tmp-[\w-]+$/.test(name)) {
          continue;
        }
        const key = `${dir}${name}`;
        if (item.dir) {
          if (key.startsWith(prefix) || prefix.startsWith(`${key}/`)) {
            await walk(`${key}/`);
          }
          continue;
        }
        if (key.startsWith(prefix) && (!after || key > after)) {
          out.push({ key, size: item.size, etag: item.etag, modified: item.modified });
        }
      }
    };
    await walk(dirKey);
    return out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  }

  async get(key: string): Promise<Uint8Array | undefined> {
    const r = await this.req('GET', this.url(checkKey(key)));
    if (r.status === 404) {
      await r.arrayBuffer().catch(() => undefined);
      return undefined;
    }
    if (!r.ok) {
      await this.fail(r, `get ${key}`);
    }
    return Buffer.from(await r.arrayBuffer());
  }

  async head(key: string): Promise<RemoteEntry | undefined> {
    const r = await this.req('HEAD', this.url(checkKey(key)));
    if (r.status === 404) {
      return undefined;
    }
    if (!r.ok) {
      await this.fail(r, `head ${key}`);
    }
    return { key, size: Number(r.headers.get('content-length') ?? 0), etag: r.headers.get('etag') ?? undefined };
  }

  async put(key: string, body: Uint8Array, o: PutOptions = {}): Promise<{ etag?: string }> {
    checkKey(key);
    await this.ensureDirs(key);
    if (o.ifMatch) {
      const cur = await this.head(key);
      if (cur?.etag !== o.ifMatch) {
        throw new BackendError('precondition', `${key} changed`);
      }
    }
    const tmpKey = `${key}.tmp-${crypto.randomBytes(6).toString('hex')}`;
    const put = await this.req('PUT', this.url(tmpKey), { body, headers: { 'content-type': 'application/octet-stream' } });
    await put.arrayBuffer().catch(() => undefined);
    if (!put.ok) {
      throw new BackendError(httpCode(put.status), `WebDAV put ${key}: ${put.status} ${put.statusText}`, put.status);
    }
    const mv = await this.req('MOVE', this.url(tmpKey), { headers: { destination: this.url(key).toString(), overwrite: o.ifAbsent ? 'F' : 'T', ...(o.ifMatch ? { 'if-match': o.ifMatch } : {}) } });
    await mv.arrayBuffer().catch(() => undefined);
    if (!mv.ok) {
      const del = await this.req('DELETE', this.url(tmpKey));
      await del.arrayBuffer().catch(() => undefined);
      if (mv.status === 412) {
        throw new BackendError('precondition', o.ifAbsent ? `${key} exists` : `${key} changed`, 412);
      }
      throw new BackendError(httpCode(mv.status), `WebDAV move ${key}: ${mv.status} ${mv.statusText}`, mv.status);
    }
    return { etag: mv.headers.get('etag') ?? undefined };
  }

  async delete(key: string): Promise<void> {
    const r = await this.req('DELETE', this.url(checkKey(key)));
    await r.arrayBuffer().catch(() => undefined);
    if (!r.ok && r.status !== 404) {
      throw new BackendError(httpCode(r.status), `WebDAV delete ${key}: ${r.status}`, r.status);
    }
  }

  dispose(): void {
    // nothing to release
  }
}
