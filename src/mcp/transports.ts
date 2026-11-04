import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import type { McpServerConfig } from '../config';

/**
 * MCP transports. The client speaks JSON-RPC; a transport only moves messages:
 *  - stdio: a local process, newline-delimited JSON on stdin/stdout.
 *  - Streamable HTTP (MCP 2025-03-26 and later): each message is POSTed to one endpoint; the reply is JSON or an SSE
 *    stream of messages; the server may assign a session (`Mcp-Session-Id`) that every later request carries. A
 *    standalone GET stream, if the server offers one, carries notifications and requests nobody asked for.
 *  - HTTP+SSE (MCP 2024-11-05): a GET opens an event stream whose first `endpoint` event names the URL to POST
 *    messages to; replies arrive on the stream.
 */
export type JsonRpcMessage = { jsonrpc?: '2.0'; id?: number | string; method?: string; params?: unknown; result?: unknown; error?: { code: number; message: string } };

export interface Transport {
  readonly kind: 'stdio' | 'http' | 'sse';
  start(onMessage: (m: JsonRpcMessage) => void, onClose: (err: Error) => void): Promise<void>;
  send(m: JsonRpcMessage): Promise<void>;
  /** Told the negotiated protocol version after `initialize` (HTTP sends it as a header). */
  setProtocolVersion?(v: string): void;
  /** Forgets the server-assigned session (HTTP), so the next `initialize` starts a new one. */
  resetSession?(): void;
  /** Called after the handshake: opens the stream on which the server sends unprompted messages (Streamable HTTP). */
  listen?(): void;
  close(): void;
}

/** Claude-style `${NAME}` / `${NAME:-default}` from the environment, then `${env:NAME}` / `${secret:NAME}` via `resolve`. */
export function expandRefs(value: string, resolve: (raw: string) => string | undefined): string {
  const claude = value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_, name: string, def?: string) => process.env[name] ?? def ?? '');
  return resolve(claude) ?? '';
}

/** `${env:NAME}` and `${secret:NAME}` (via `resolve`) inside header values, so tokens need not sit in settings.json. */
export function expandHeaders(headers: Record<string, string> | undefined, resolve: (raw: string) => string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers ?? {})) {
    const value = expandRefs(String(v), resolve);
    if (value) {
      out[k] = value;
    }
  }
  return out;
}

/** Which transport a server config means: explicit `type`, else a URL ending in `/sse` is legacy SSE, any other URL HTTP. */
export function transportKind(cfg: Pick<McpServerConfig, 'type' | 'url' | 'command'>): 'stdio' | 'http' | 'sse' | undefined {
  if (cfg.type === 'stdio' || cfg.type === 'http' || cfg.type === 'sse') {
    return cfg.type === 'stdio' ? (cfg.command ? 'stdio' : undefined) : cfg.url ? cfg.type : undefined;
  }
  if (cfg.type === 'streamable-http' || cfg.type === 'streamableHttp') {
    return cfg.url ? 'http' : undefined;
  }
  if (cfg.url) {
    return /\/sse\/?(\?|$)/.test(cfg.url) ? 'sse' : 'http';
  }
  return cfg.command ? 'stdio' : undefined;
}

/** Splits an SSE byte stream into events; feed chunks, get `{ event, data }` for each complete event. */
export class SseParser {
  private buf = '';
  push(chunk: string, emit: (e: { event: string; data: string }) => void): void {
    this.buf += chunk.replace(/\r\n?/g, '\n');
    let idx: number;
    while ((idx = this.buf.indexOf('\n\n')) >= 0) {
      const block = this.buf.slice(0, idx);
      this.buf = this.buf.slice(idx + 2);
      let event = 'message';
      const data: string[] = [];
      for (const line of block.split('\n')) {
        if (line.startsWith(':')) {
          continue;
        }
        const c = line.indexOf(':');
        const field = c < 0 ? line : line.slice(0, c);
        const value = c < 0 ? '' : line.slice(c + 1).replace(/^ /, '');
        if (field === 'event') {
          event = value;
        } else if (field === 'data') {
          data.push(value);
        }
      }
      if (data.length) {
        emit({ event, data: data.join('\n') });
      }
    }
  }
}

function dispatch(text: string, onMessage: (m: JsonRpcMessage) => void): void {
  const parsed = JSON.parse(text) as JsonRpcMessage | JsonRpcMessage[];
  for (const m of Array.isArray(parsed) ? parsed : [parsed]) {
    onMessage(m);
  }
}

async function readStream(body: ReadableStream<Uint8Array>, onEvent: (e: { event: string; data: string }) => void, signal: AbortSignal): Promise<void> {
  const reader = body.getReader();
  const dec = new TextDecoder();
  const sse = new SseParser();
  try {
    while (!signal.aborted) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      sse.push(dec.decode(value, { stream: true }), onEvent);
    }
  } finally {
    reader.releaseLock();
  }
}

/** One argument for `cmd /d /s /c "..."`: quoted the way the target parses it, then cmd metacharacters `^`-escaped. */
function quoteForCmd(arg: string): string {
  const quoted = `"${arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, '$1$1')}"`;
  return quoted.replace(/([()%!^"<>&|])/g, '^$1');
}

/** PATH/PATHEXT lookup for a Windows command name (also used for a bare `npx`). */
function winWhich(name: string): string | undefined {
  if (/[\\/]/.test(name)) {
    return fs.existsSync(name) ? name : undefined;
  }
  const exts = (process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';').map((e) => e.toLowerCase()).concat('');
  for (const d of (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
    for (const e of exts) {
      const f = path.join(d, name.toLowerCase().endsWith(e) ? name : name + e);
      try {
        if (fs.statSync(f).isFile()) {
          return f;
        }
      } catch {
        /* not here */
      }
    }
  }
  return undefined;
}

/**
 * How to spawn a stdio server on Windows without `shell: true`: an .exe/.com runs directly (libuv quotes each
 * argument); anything else (`npx` and other .cmd/.bat shims, or an unresolved name) goes through cmd with every
 * argument quoted and its metacharacters escaped, so spaces, `&` or `%` in paths and arguments survive.
 */
export function winSpawn(command: string, args: string[], resolve: (c: string) => string | undefined = winWhich, comspec = process.env.ComSpec ?? 'cmd.exe'): { file: string; args: string[]; verbatim: boolean } {
  const resolved = resolve(command);
  if (resolved && /\.(exe|com)$/i.test(resolved)) {
    return { file: resolved, args, verbatim: false };
  }
  return { file: comspec, args: ['/d', '/s', '/c', `"${[command, ...args].map(quoteForCmd).join(' ')}"`], verbatim: true };
}

export class StdioTransport implements Transport {
  readonly kind = 'stdio' as const;
  private child?: cp.ChildProcess;
  private buffer = '';
  private stderrTail = '';
  constructor(private readonly cfg: McpServerConfig, private readonly cwd: string | undefined, private readonly debug: (m: string) => void) {}

  async start(onMessage: (m: JsonRpcMessage) => void, onClose: (err: Error) => void): Promise<void> {
    // Its own process group (POSIX), so stopping it reaches the real server and not only a launcher such as npx.
    const opts: cp.SpawnOptions = { cwd: this.cfg.cwd ?? this.cwd, env: { ...process.env, ...(this.cfg.env ?? {}) }, stdio: ['pipe', 'pipe', 'pipe'] };
    // On Windows `npx` / `.cmd` launchers run through cmd with a quoted command line (see winSpawn).
    if (process.platform === 'win32') {
      const w = winSpawn(this.cfg.command!, this.cfg.args ?? []);
      this.child = cp.spawn(w.file, w.args, { ...opts, shell: false, windowsVerbatimArguments: w.verbatim });
    } else {
      this.child = cp.spawn(this.cfg.command!, this.cfg.args ?? [], { ...opts, shell: false, detached: true });
    }
    this.child.stdout!.setEncoding('utf8');
    this.child.stderr!.setEncoding('utf8');
    const spawned = new Promise<void>((resolve, reject) => {
      this.child!.once('spawn', () => resolve());
      this.child!.once('error', (e) => reject(new Error(`cannot start "${this.cfg.command}": ${e.message}`)));
    });
    this.child.on('error', (e) => onClose(new Error(`MCP server error: ${e.message}`)));
    // A failed spawn or an early exit also errors the pipes (EPIPE); without listeners those would be uncaught.
    for (const stream of [this.child.stdin, this.child.stdout, this.child.stderr]) {
      stream?.on('error', (e: Error) => this.debug(`pipe: ${e.message}`));
    }
    this.child.stdout!.on('data', (d: string) => {
      this.buffer += d;
      let idx: number;
      while ((idx = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, idx).trim();
        this.buffer = this.buffer.slice(idx + 1);
        if (line) {
          try {
            dispatch(line, onMessage);
          } catch {
            /* not JSON: a server logging to stdout */
          }
        }
      }
    });
    this.child.stderr!.on('data', (d: string) => {
      const line = d.trim();
      this.stderrTail = line.slice(-300);
      this.debug(line);
    });
    this.child.on('exit', (code) => onClose(new Error(`MCP server exited with code ${code ?? 'null'}${this.stderrTail ? `: ${this.stderrTail}` : ''}`)));
    await spawned;
  }

  async send(m: JsonRpcMessage): Promise<void> {
    const stdin = this.child?.stdin;
    if (!stdin || stdin.destroyed) {
      throw new Error('MCP server is not running');
    }
    stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...m })}\n`);
  }

  close(): void {
    const pid = this.child?.pid;
    if (!pid || this.child?.exitCode !== null || this.child?.signalCode !== null) {
      return;
    }
    // The whole tree: `npx server` or a Windows shell wrapper would otherwise leave the server itself running.
    if (process.platform === 'win32') {
      cp.spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' }).on('error', () => this.child?.kill());
    } else {
      try {
        process.kill(-pid, 'SIGTERM');
      } catch {
        this.child?.kill();
      }
    }
  }
}

export class StreamableHttpTransport implements Transport {
  readonly kind = 'http' as const;
  private session?: string;
  private protocol?: string;
  private onMessage: (m: JsonRpcMessage) => void = () => undefined;
  private readonly ctl = new AbortController();
  /** The standalone GET stream's own abort, so a new session can replace it. */
  private stream?: AbortController;
  /** Reconnect delays for the GET stream (ms); the last one repeats. */
  streamBackoff = [1_000, 2_000, 5_000, 10_000, 30_000];
  debug: (m: string) => void = () => undefined;
  /** The GET stream found its session gone (404 with a session id): the client starts a new session, which listens again. */
  onSessionExpired?: () => void;
  constructor(private readonly url: string, private readonly headers: Record<string, string>, private readonly fetchImpl: typeof fetch = fetch) {}

  async start(onMessage: (m: JsonRpcMessage) => void): Promise<void> {
    this.onMessage = onMessage;
  }

  listen(): void {
    if (this.ctl.signal.aborted || (this.stream && !this.stream.signal.aborted)) {
      return;
    }
    const stream = new AbortController();
    this.stream = stream;
    void this.runStream(stream.signal);
  }

  /**
   * Holds the GET stream open and reconnects with backoff. 404/405 (or a reply that is not an event stream) means
   * the server has none, which is fine; other 4xx answers stop it too. A 404 for a GET that carried a session id is an
   * expired session instead (a restarted server), handed to `onSessionExpired`.
   */
  private async runStream(own: AbortSignal): Promise<void> {
    const signal = AbortSignal.any([this.ctl.signal, own]);
    let failures = 0;
    while (!signal.aborted) {
      let opened = 0;
      const sid = this.session;
      try {
        const res = await this.fetchImpl(this.url, {
          method: 'GET',
          headers: { accept: 'text/event-stream', ...(sid ? { 'mcp-session-id': sid } : {}), ...(this.protocol ? { 'mcp-protocol-version': this.protocol } : {}), ...this.headers },
          signal,
        });
        const type = res.headers.get('content-type') ?? '';
        if (!res.ok || !type.includes('text/event-stream') || !res.body) {
          await res.body?.cancel().catch(() => undefined);
          if (res.status === 404 && sid && this.onSessionExpired) {
            if (!signal.aborted && sid === this.session) {
              this.debug('event stream: session expired');
              this.onSessionExpired();
            }
            return;
          }
          if (res.ok || (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429)) {
            this.debug(res.status === 404 || res.status === 405 || res.ok ? 'no standalone event stream' : `event stream refused: ${res.status}`);
            return;
          }
          throw new Error(`${res.status} ${res.statusText}`);
        }
        opened = Date.now();
        this.debug('event stream open');
        await readStream(res.body, (e) => {
          if (e.event === 'message') {
            try {
              dispatch(e.data, this.onMessage);
            } catch {
              /* malformed event */
            }
          }
        }, signal);
        if (!signal.aborted) {
          this.debug('event stream closed');
        }
      } catch (e) {
        if (signal.aborted) {
          return;
        }
        this.debug(`event stream: ${e instanceof Error ? e.message : String(e)}`);
      }
      // A stream that stayed up a minute counts as healthy: the backoff starts again.
      failures = opened && Date.now() - opened > 60_000 ? 0 : failures + 1;
      const delay = this.streamBackoff[Math.min(failures - 1, this.streamBackoff.length - 1)] ?? 0;
      await new Promise<void>((resolve) => {
        const t = setTimeout(done, delay);
        t.unref?.();
        function done() {
          clearTimeout(t);
          signal.removeEventListener('abort', done);
          resolve();
        }
        signal.addEventListener('abort', done, { once: true });
      });
    }
  }

  setProtocolVersion(v: string): void {
    this.protocol = v;
  }

  get hasSession(): boolean {
    return !!this.session;
  }

  resetSession(): void {
    this.session = undefined;
    this.protocol = undefined;
    this.stream?.abort();
  }

  async send(m: JsonRpcMessage): Promise<void> {
    const res = await this.fetchImpl(this.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(this.session ? { 'mcp-session-id': this.session } : {}), ...(this.protocol ? { 'mcp-protocol-version': this.protocol } : {}), ...this.headers },
      body: JSON.stringify({ jsonrpc: '2.0', ...m }),
      signal: this.ctl.signal,
    });
    const sid = res.headers.get('mcp-session-id');
    if (sid) {
      this.session = sid;
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new HttpError(res.status, `${res.status} ${res.statusText}${text ? `: ${text.slice(0, 300)}` : ''}`);
    }
    // Notifications and responses to the server are acknowledged with 202 and no body.
    if (res.status === 202 || m.id === undefined) {
      await res.body?.cancel().catch(() => undefined);
      return;
    }
    const type = res.headers.get('content-type') ?? '';
    if (type.includes('text/event-stream') && res.body) {
      // Requests are answered on this stream; it ends after the response (the server may send notifications first).
      void readStream(res.body, (e) => {
        if (e.event === 'message') {
          try {
            dispatch(e.data, this.onMessage);
          } catch {
            /* malformed event */
          }
        }
      }, this.ctl.signal).catch(() => undefined);
      return;
    }
    const text = await res.text();
    if (text.trim()) {
      dispatch(text, this.onMessage);
    }
  }

  close(): void {
    // Ending the session is a courtesy; the server also times sessions out.
    if (this.session) {
      void this.fetchImpl(this.url, { method: 'DELETE', headers: { 'mcp-session-id': this.session, ...this.headers } }).catch(() => undefined);
    }
    this.ctl.abort();
  }
}

export class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export class SseTransport implements Transport {
  readonly kind = 'sse' as const;
  private endpoint?: string;
  private readonly ctl = new AbortController();
  constructor(private readonly url: string, private readonly headers: Record<string, string>, private readonly fetchImpl: typeof fetch = fetch) {}

  async start(onMessage: (m: JsonRpcMessage) => void, onClose: (err: Error) => void): Promise<void> {
    // One deadline for the whole connect: response headers and the endpoint event.
    const timer = setTimeout(() => this.ctl.abort(new Error('the SSE server did not answer within 15 s')), 15_000);
    try {
      const res = await this.fetchImpl(this.url, { headers: { accept: 'text/event-stream', ...this.headers }, signal: this.ctl.signal });
      if (!res.ok || !res.body) {
        throw new HttpError(res.status, `SSE connection failed: ${res.status} ${res.statusText}`);
      }
      let gotEndpoint: () => void = () => undefined;
      let failed: (e: Error) => void = () => undefined;
      const ready = new Promise<void>((resolve, reject) => {
        gotEndpoint = resolve;
        failed = reject;
      });
      const onAbort = () => failed(this.ctl.signal.reason instanceof Error ? this.ctl.signal.reason : new Error('the SSE connection was aborted'));
      this.ctl.signal.addEventListener('abort', onAbort, { once: true });
      void readStream(res.body, (e) => {
        if (e.event === 'endpoint') {
          this.endpoint = new URL(e.data.trim(), this.url).toString();
          clearTimeout(timer);
          gotEndpoint();
        } else if (e.event === 'message') {
          try {
            dispatch(e.data, onMessage);
          } catch {
            /* malformed event */
          }
        }
      }, this.ctl.signal)
        .then(() => {
          failed(new Error('the SSE stream closed before the endpoint event'));
          if (!this.ctl.signal.aborted) {
            onClose(new Error('the SSE stream closed'));
          }
        })
        .catch((e) => {
          const err = e instanceof Error ? e : new Error(String(e));
          failed(err);
          if (!this.ctl.signal.aborted) {
            onClose(err);
          }
        });
      try {
        await ready;
      } finally {
        this.ctl.signal.removeEventListener('abort', onAbort);
      }
    } finally {
      clearTimeout(timer);
    }
  }

  async send(m: JsonRpcMessage): Promise<void> {
    if (!this.endpoint) {
      throw new Error('SSE transport is not connected');
    }
    const res = await this.fetchImpl(this.endpoint, { method: 'POST', headers: { 'content-type': 'application/json', ...this.headers }, body: JSON.stringify({ jsonrpc: '2.0', ...m }), signal: this.ctl.signal });
    if (!res.ok) {
      throw new HttpError(res.status, `${res.status} ${res.statusText}`);
    }
    await res.body?.cancel().catch(() => undefined);
  }

  close(): void {
    this.ctl.abort();
  }
}
