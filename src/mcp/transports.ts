import * as cp from 'child_process';
import type { McpServerConfig } from '../config';

/**
 * MCP transports. The client speaks JSON-RPC; a transport only moves messages:
 *  - stdio: a local process, newline-delimited JSON on stdin/stdout.
 *  - Streamable HTTP (MCP 2025-03-26 and later): each message is POSTed to one endpoint; the reply is JSON or an SSE
 *    stream of messages; the server may assign a session (`Mcp-Session-Id`) that every later request carries.
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
  close(): void;
}

/** `${env:NAME}` and `${secret:NAME}` (via `resolve`) inside header values, so tokens need not sit in settings.json. */
export function expandHeaders(headers: Record<string, string> | undefined, resolve: (raw: string) => string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers ?? {})) {
    const value = resolve(String(v));
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

export class StdioTransport implements Transport {
  readonly kind = 'stdio' as const;
  private child?: cp.ChildProcess;
  private buffer = '';
  private stderrTail = '';
  constructor(private readonly cfg: McpServerConfig, private readonly cwd: string | undefined, private readonly debug: (m: string) => void) {}

  async start(onMessage: (m: JsonRpcMessage) => void, onClose: (err: Error) => void): Promise<void> {
    // `shell: true` on Windows so `npx` / `.cmd` launchers resolve the same way they do in a terminal.
    this.child = cp.spawn(this.cfg.command!, this.cfg.args ?? [], { cwd: this.cfg.cwd ?? this.cwd, env: { ...process.env, ...(this.cfg.env ?? {}) }, stdio: ['pipe', 'pipe', 'pipe'], shell: process.platform === 'win32' });
    const spawned = new Promise<void>((resolve, reject) => {
      this.child!.once('spawn', () => resolve());
      this.child!.once('error', (e) => reject(new Error(`cannot start "${this.cfg.command}": ${e.message}`)));
    });
    this.child.on('error', (e) => onClose(new Error(`MCP server error: ${e.message}`)));
    // A failed spawn or an early exit also errors the pipes (EPIPE); without listeners those would be uncaught.
    for (const stream of [this.child.stdin, this.child.stdout, this.child.stderr]) {
      stream?.on('error', (e: Error) => this.debug(`pipe: ${e.message}`));
    }
    this.child.stdout!.on('data', (d: Buffer) => {
      this.buffer += d.toString();
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
    this.child.stderr!.on('data', (d: Buffer) => {
      const line = d.toString().trim();
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
    this.child?.kill();
  }
}

export class StreamableHttpTransport implements Transport {
  readonly kind = 'http' as const;
  private session?: string;
  private protocol?: string;
  private onMessage: (m: JsonRpcMessage) => void = () => undefined;
  private readonly ctl = new AbortController();
  constructor(private readonly url: string, private readonly headers: Record<string, string>, private readonly fetchImpl: typeof fetch = fetch) {}

  async start(onMessage: (m: JsonRpcMessage) => void): Promise<void> {
    this.onMessage = onMessage;
  }

  setProtocolVersion(v: string): void {
    this.protocol = v;
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
    const res = await this.fetchImpl(this.url, { headers: { accept: 'text/event-stream', ...this.headers }, signal: this.ctl.signal });
    if (!res.ok || !res.body) {
      throw new HttpError(res.status, `SSE connection failed: ${res.status} ${res.statusText}`);
    }
    let gotEndpoint: () => void = () => undefined;
    const ready = new Promise<void>((resolve, reject) => {
      gotEndpoint = resolve;
      setTimeout(() => reject(new Error('the SSE server sent no endpoint event within 15 s')), 15_000);
    });
    void readStream(res.body, (e) => {
      if (e.event === 'endpoint') {
        this.endpoint = new URL(e.data.trim(), this.url).toString();
        gotEndpoint();
      } else if (e.event === 'message') {
        try {
          dispatch(e.data, onMessage);
        } catch {
          /* malformed event */
        }
      }
    }, this.ctl.signal)
      .then(() => !this.ctl.signal.aborted && onClose(new Error('the SSE stream closed')))
      .catch((e) => !this.ctl.signal.aborted && onClose(e instanceof Error ? e : new Error(String(e))));
    await ready;
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
