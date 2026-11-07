// S3-compatible backend (design §14.5): AWS S3, Cloudflare R2, MinIO, Backblaze B2, Wasabi. SigV4 over fetch (no SDK):
// ListObjectsV2 with continuation tokens, GET, PUT (`If-None-Match: *` for create-if-absent, falling back to HEAD then
// PUT on storage that does not implement it; `If-Match` for the keyring's compare-and-swap), DELETE. HTTPS is required
// except for localhost. The secret access key comes from SecretStorage / the CLI key file. Pure Node.
import { BackendError, checkKey, CheckResult, httpCode, PutOptions, reasonOf, RemoteEntry, requireHttps, SyncBackend } from './backend';
import { EMPTY_SHA256, sha256Hex, signV4 } from './sigv4';

export interface S3Options {
  endpoint: string;
  region: string;
  bucket: string;
  /** Folder inside the bucket ("" = the bucket root); `localpilot-sync/` is added below it. */
  prefix: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** `https://endpoint/bucket/key` instead of `https://bucket.endpoint/key` (default on for custom endpoints). */
  pathStyle?: boolean;
  fetch?: typeof fetch;
}

/** Text of the first `<tag>…</tag>` in `xml` (a minimal reader: S3 list results are flat and well-formed). */
function tag(xml: string, name: string): string | undefined {
  const m = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(xml);
  return m ? unescapeXml(m[1]) : undefined;
}

function unescapeXml(s: string): string {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n))).replace(/&amp;/g, '&');
}

export class S3Backend implements SyncBackend {
  readonly kind = 's3' as const;
  readonly label: string;
  private readonly base: URL;
  private readonly pathStyle: boolean;
  private readonly keyPrefix: string;
  private readonly fetchFn: typeof fetch;
  /** Set once the storage answered 501 / NotImplemented to a conditional PUT. */
  private noConditional = false;

  constructor(private readonly o: S3Options) {
    this.base = requireHttps(o.endpoint.includes('://') ? o.endpoint : `https://${o.endpoint}`, 'The S3 endpoint');
    const aws = /(^|\.)amazonaws\.com$/.test(this.base.hostname);
    this.pathStyle = o.pathStyle ?? !aws;
    const p = (o.prefix || '').replace(/^\/+|\/+$/g, '');
    this.keyPrefix = `${p ? `${p}/` : ''}localpilot-sync/`;
    this.fetchFn = o.fetch ?? fetch;
    this.label = `s3://${o.bucket}/${this.keyPrefix} (${this.base.host})`;
  }

  private url(key: string, query?: Record<string, string>): URL {
    const u = new URL(this.base.toString());
    const objectPath = key ? `/${key.split('/').map(encodeURIComponent).join('/')}` : '/';
    if (this.pathStyle) {
      u.pathname = `${u.pathname.replace(/\/+$/, '')}/${encodeURIComponent(this.o.bucket)}${objectPath}`;
    } else {
      u.hostname = `${this.o.bucket}.${u.hostname}`;
      u.pathname = `${u.pathname.replace(/\/+$/, '')}${objectPath}`;
    }
    for (const [k, v] of Object.entries(query ?? {})) {
      u.searchParams.set(k, v);
    }
    return u;
  }

  private async request(method: string, key: string, o: { query?: Record<string, string>; body?: Uint8Array; headers?: Record<string, string> } = {}): Promise<Response> {
    const url = this.url(key, o.query);
    const payloadHash = o.body ? sha256Hex(o.body) : EMPTY_SHA256;
    const signed = signV4({ method, url, headers: { ...(o.headers ?? {}) }, payloadHash, region: this.o.region || 'us-east-1', service: 's3' }, { accessKeyId: this.o.accessKeyId, secretAccessKey: this.o.secretAccessKey });
    const headers = { ...signed.headers };
    delete headers.host; // fetch sets it (the same value)
    try {
      return await this.fetchFn(url, { method, headers, body: o.body ? Buffer.from(o.body) : undefined, redirect: 'manual' } as RequestInit);
    } catch (e) {
      throw new BackendError(reasonOf(e) === 'other' ? 'offline' : reasonOf(e), `S3 ${method} failed: ${(e as Error).message}`);
    }
  }

  private async fail(r: Response, what: string): Promise<never> {
    const text = await r.text().catch(() => '');
    const code = tag(text, 'Code');
    const msg = tag(text, 'Message');
    let c = httpCode(r.status);
    if (code === 'NotImplemented') {
      c = 'not-implemented';
    } else if (code === 'NoSuchBucket') {
      c = 'not-found';
    } else if (code === 'InvalidAccessKeyId' || code === 'SignatureDoesNotMatch' || code === 'ExpiredToken') {
      c = 'auth';
    } else if (code === 'PreconditionFailed' || code === 'ConditionalRequestConflict') {
      c = 'precondition';
    }
    throw new BackendError(c, `S3 ${what}: ${r.status}${code ? ` ${code}` : ''}${msg ? ` — ${msg}` : ''}`, r.status);
  }

  async check(): Promise<CheckResult> {
    try {
      await this.list('format.json');
      return { ok: true };
    } catch (e) {
      const be = e instanceof BackendError ? e : new BackendError(reasonOf(e), String((e as Error).message ?? e));
      const reason = be.code === 'precondition' || be.code === 'not-implemented' ? 'other' : be.code;
      return { ok: false, reason, message: reason === 'auth' ? 'Sign-in failed: check the access key and the secret key' : reason === 'forbidden' ? 'Access denied: the key cannot use this bucket' : reason === 'not-found' ? `Bucket "${this.o.bucket}" not found` : be.message };
    }
  }

  async list(prefix: string, after?: string): Promise<RemoteEntry[]> {
    const out: RemoteEntry[] = [];
    let token: string | undefined;
    do {
      const query: Record<string, string> = { 'list-type': '2', prefix: this.keyPrefix + prefix };
      if (token) {
        query['continuation-token'] = token;
      } else if (after) {
        query['start-after'] = this.keyPrefix + after;
      }
      const r = await this.request('GET', '', { query });
      if (!r.ok) {
        await this.fail(r, 'list');
      }
      const xml = await r.text();
      for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
        const full = tag(m[1], 'Key') ?? '';
        if (!full.startsWith(this.keyPrefix)) {
          continue;
        }
        const key = full.slice(this.keyPrefix.length);
        if (after && key <= after) {
          continue;
        }
        const modified = Date.parse(tag(m[1], 'LastModified') ?? '');
        out.push({ key, size: Number(tag(m[1], 'Size') ?? 0), etag: tag(m[1], 'ETag'), ...(Number.isFinite(modified) ? { modified } : {}) });
      }
      token = tag(xml, 'IsTruncated') === 'true' ? tag(xml, 'NextContinuationToken') : undefined;
    } while (token);
    return out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  }

  async get(key: string): Promise<Uint8Array | undefined> {
    const r = await this.request('GET', this.keyPrefix + checkKey(key));
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
    const r = await this.request('HEAD', this.keyPrefix + checkKey(key));
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
    const headers: Record<string, string> = { 'content-type': 'application/octet-stream' };
    if (o.ifAbsent && !this.noConditional) {
      headers['if-none-match'] = '*';
    }
    if (o.ifMatch) {
      headers['if-match'] = o.ifMatch;
    }
    if (o.ifAbsent && this.noConditional && (await this.head(key))) {
      throw new BackendError('precondition', `${key} exists`);
    }
    const r = await this.request('PUT', this.keyPrefix + key, { body, headers });
    if (r.ok) {
      return { etag: r.headers.get('etag') ?? undefined };
    }
    if (o.ifAbsent && !this.noConditional && (r.status === 501 || r.status === 400)) {
      const text = await r.text().catch(() => '');
      if (r.status === 501 || /NotImplemented|InvalidArgument|not implemented|not supported/i.test(text)) {
        // Storage without conditional writes: HEAD, then a plain PUT (single-writer keys make the race harmless).
        this.noConditional = true;
        return this.put(key, body, o);
      }
      throw new BackendError(httpCode(r.status), `S3 put ${key}: ${r.status} ${text.slice(0, 200)}`, r.status);
    }
    return this.fail(r, `put ${key}`);
  }

  async delete(key: string): Promise<void> {
    const r = await this.request('DELETE', this.keyPrefix + checkKey(key));
    if (!r.ok && r.status !== 404) {
      await this.fail(r, `delete ${key}`);
    }
    await r.arrayBuffer().catch(() => undefined);
  }

  dispose(): void {
    // nothing to release
  }
}
