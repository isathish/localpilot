// The storage a sync remote lives on (design §14.5). Every backend stores opaque objects under `/`-separated keys
// relative to `<base>/localpilot-sync/`; every key has exactly one writer (the device that owns it), so no backend
// needs locks. `format.json` and `keyring.json` use `ifAbsent` / `ifMatch` for their one-time create and the key
// compare-and-swap. Pure Node: no vscode.

export type BackendKind = 'folder' | 'git' | 's3' | 'webdav';

export interface RemoteEntry {
  key: string;
  size: number;
  etag?: string;
  modified?: number;
}

export type CheckReason = 'auth' | 'not-found' | 'offline' | 'forbidden' | 'other';
export type CheckResult = { ok: true } | { ok: false; reason: CheckReason; message: string };

export interface PutOptions {
  /** Fail with `BackendError('precondition')` when the key exists. */
  ifAbsent?: boolean;
  /** Fail with `BackendError('precondition')` unless the current object has this etag. */
  ifMatch?: string;
}

export interface SyncBackend {
  readonly kind: BackendKind;
  /** Shown in the UI; never contains credentials. */
  readonly label: string;
  check(): Promise<CheckResult>;
  /** Keys under `prefix`, in lexical order, complete (pagination handled), after `after` when given. */
  list(prefix: string, after?: string): Promise<RemoteEntry[]>;
  /** undefined when the key is absent. */
  get(key: string): Promise<Uint8Array | undefined>;
  /** The object's etag (for `ifMatch`), undefined when absent. */
  head?(key: string): Promise<RemoteEntry | undefined>;
  /** Atomic: readers see the old object or the new one, never a part. */
  put(key: string, body: Uint8Array, o?: PutOptions): Promise<{ etag?: string }>;
  delete(key: string): Promise<void>;
  /** git: fetch + reset to the remote branch before a cycle. */
  begin?(): Promise<void>;
  /** git: commit + push what `put`/`delete` changed (retries a non-fast-forward). */
  commit?(message: string): Promise<void>;
  dispose(): void;
}

export interface SyncBackendConfig {
  kind: BackendKind;
  folder?: { path: string };
  git?: { url: string; branch: string };
  s3?: { endpoint: string; region: string; bucket: string; prefix: string; accessKeyId: string; pathStyle?: boolean };
  webdav?: { url: string; username: string };
}

export type BackendErrorCode = CheckReason | 'precondition' | 'not-implemented';

/** A backend failure with the reason the Sync manager shows ("Sync paused: sign-in failed"). */
export class BackendError extends Error {
  constructor(readonly code: BackendErrorCode, message: string, readonly status?: number) {
    super(message);
    this.name = 'BackendError';
  }
}

/** Remote keys are `/`-separated, relative, and never contain `..`, `\`, or empty parts. */
export function checkKey(key: string): string {
  if (!key || key.startsWith('/') || key.includes('\\') || key.split('/').some((p) => !p || p === '.' || p === '..')) {
    throw new BackendError('other', `bad remote key: ${key}`);
  }
  return key;
}

/** The reason of any error, for status lines and `check()`. */
export function reasonOf(e: unknown): CheckReason {
  if (e instanceof BackendError) {
    return e.code === 'precondition' || e.code === 'not-implemented' ? 'other' : e.code;
  }
  const code = (e as NodeJS.ErrnoException)?.code ?? '';
  const cause = ((e as { cause?: { code?: string } })?.cause?.code ?? '') as string;
  if (/^(ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|UND_ERR_CONNECT_TIMEOUT|UND_ERR_SOCKET)$/.test(code) || /^(ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|UND_ERR_CONNECT_TIMEOUT|UND_ERR_SOCKET)$/.test(cause)) {
    return 'offline';
  }
  if (code === 'EACCES' || code === 'EPERM') {
    return 'forbidden';
  }
  if (code === 'ENOENT') {
    return 'not-found';
  }
  if (e instanceof TypeError && /fetch failed/i.test(e.message)) {
    return 'offline';
  }
  return 'other';
}

/** Maps an HTTP status to a backend error code. */
export function httpCode(status: number): BackendErrorCode {
  if (status === 401) {
    return 'auth';
  }
  if (status === 403) {
    return 'forbidden';
  }
  if (status === 404) {
    return 'not-found';
  }
  if (status === 412 || status === 409) {
    return 'precondition';
  }
  if (status === 501) {
    return 'not-implemented';
  }
  if (status === 502 || status === 503 || status === 504) {
    return 'offline';
  }
  return 'other';
}

/** Plain HTTP only to this machine: credentials and ciphertext otherwise travel over HTTPS. */
export function requireHttps(url: string, what: string): URL {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new BackendError('other', `${what}: "${url}" is not a URL`);
  }
  const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]' || u.hostname === '::1';
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) {
    throw new BackendError('other', `${what} must use https:// (plain http is allowed only for localhost)`);
  }
  return u;
}

/** An in-memory backend (protocol tests, and a building block for fakes). Counts requests. */
export class MemoryBackend implements SyncBackend {
  readonly kind = 'folder' as const;
  readonly label: string;
  readonly objects = new Map<string, { body: Buffer; etag: string; modified: number }>();
  requests = 0;
  /** Tests: throw this (e.g. an offline error) on every call while set. */
  fail?: Error;
  /** Tests: an error for one call (`put` of a key…), or undefined to let it through. */
  failOn?: (op: 'list' | 'get' | 'head' | 'put' | 'delete', key: string) => Error | undefined;
  private n = 0;

  constructor(label = 'memory') {
    this.label = label;
  }

  private gate(op: 'list' | 'get' | 'head' | 'put' | 'delete' = 'get', key = ''): void {
    this.requests++;
    if (this.fail) {
      throw this.fail;
    }
    const e = this.failOn?.(op, key);
    if (e) {
      throw e;
    }
  }

  async check(): Promise<CheckResult> {
    if (this.fail) {
      return { ok: false, reason: reasonOf(this.fail), message: this.fail.message };
    }
    return { ok: true };
  }

  async list(prefix: string, after?: string): Promise<RemoteEntry[]> {
    this.gate('list', prefix);
    return [...this.objects.entries()]
      .filter(([k]) => k.startsWith(prefix) && (!after || k > after))
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, o]) => ({ key, size: o.body.length, etag: o.etag, modified: o.modified }));
  }

  async get(key: string): Promise<Uint8Array | undefined> {
    this.gate('get', key);
    const o = this.objects.get(checkKey(key));
    return o ? Buffer.from(o.body) : undefined;
  }

  async head(key: string): Promise<RemoteEntry | undefined> {
    this.gate('head', key);
    const o = this.objects.get(checkKey(key));
    return o ? { key, size: o.body.length, etag: o.etag, modified: o.modified } : undefined;
  }

  async put(key: string, body: Uint8Array, o: PutOptions = {}): Promise<{ etag?: string }> {
    this.gate('put', key);
    const cur = this.objects.get(checkKey(key));
    if (o.ifAbsent && cur) {
      throw new BackendError('precondition', `${key} exists`);
    }
    if (o.ifMatch && cur?.etag !== o.ifMatch) {
      throw new BackendError('precondition', `${key} changed`);
    }
    const etag = `"${++this.n}"`;
    this.objects.set(key, { body: Buffer.from(body), etag, modified: Date.now() });
    return { etag };
  }

  async delete(key: string): Promise<void> {
    this.gate('delete', key);
    this.objects.delete(checkKey(key));
  }

  dispose(): void {
    // nothing to release
  }
}

