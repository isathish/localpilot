// Minimal Redis client (RESP2 over TCP/TLS) for the optional Redis Stack backend. Pure Node, no dependencies, so the
// extension bundle and the CLI stay dependency-free. Covers what LocalPilot needs: commands, pipelines, AUTH/SELECT.
import * as net from 'net';
import * as tls from 'tls';

export class RedisError extends Error {}
export type RedisReply = string | number | null | RedisError | RedisReply[];

export interface RedisTarget {
  host: string;
  port: number;
  tls: boolean;
  username?: string;
  password?: string;
  db: number;
}

/** `redis://[user[:password]@]host[:port][/db]`, `rediss://` for TLS. */
export function parseRedisUrl(url: string): RedisTarget {
  const u = new URL(url.trim() || 'redis://127.0.0.1:6379');
  if (u.protocol !== 'redis:' && u.protocol !== 'rediss:') {
    throw new Error(`Unsupported Redis URL scheme ${u.protocol} (use redis:// or rediss://)`);
  }
  const db = Number(u.pathname.replace(/^\//, '') || 0);
  return {
    host: u.hostname || '127.0.0.1',
    port: Number(u.port) || 6379,
    tls: u.protocol === 'rediss:',
    username: u.username ? decodeURIComponent(u.username) : undefined,
    password: u.password ? decodeURIComponent(u.password) : undefined,
    db: Number.isInteger(db) && db >= 0 ? db : 0,
  };
}

/** The URL without its password, for logs and the UI. */
export function redactRedisUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.password) {
      u.password = '***';
    }
    return u.toString().replace(/\/$/, '');
  } catch {
    return 'redis://(invalid url)';
  }
}

function encode(args: (string | number)[]): Buffer {
  const parts: Buffer[] = [Buffer.from(`*${args.length}\r\n`)];
  for (const a of args) {
    const b = Buffer.from(String(a), 'utf8');
    parts.push(Buffer.from(`$${b.length}\r\n`), b, Buffer.from('\r\n'));
  }
  return Buffer.concat(parts);
}

/** Parses one reply starting at `at`; undefined when the buffer does not hold a complete reply yet. */
export function parseReply(buf: Buffer, at = 0): { value: RedisReply; next: number } | undefined {
  if (at >= buf.length) {
    return undefined;
  }
  const eol = buf.indexOf('\r\n', at);
  if (eol < 0) {
    return undefined;
  }
  const type = String.fromCharCode(buf[at]);
  const line = buf.toString('utf8', at + 1, eol);
  switch (type) {
    case '+':
      return { value: line, next: eol + 2 };
    case '-':
      return { value: new RedisError(line), next: eol + 2 };
    case ':':
      return { value: Number(line), next: eol + 2 };
    case '$': {
      const len = Number(line);
      if (len < 0) {
        return { value: null, next: eol + 2 };
      }
      const end = eol + 2 + len;
      if (buf.length < end + 2) {
        return undefined;
      }
      return { value: buf.toString('utf8', eol + 2, end), next: end + 2 };
    }
    case '*': {
      const n = Number(line);
      if (n < 0) {
        return { value: null, next: eol + 2 };
      }
      const items: RedisReply[] = [];
      let next = eol + 2;
      for (let i = 0; i < n; i++) {
        const r = parseReply(buf, next);
        if (!r) {
          return undefined;
        }
        items.push(r.value);
        next = r.next;
      }
      return { value: items, next };
    }
    default:
      throw new RedisError(`Protocol error: unexpected reply type "${type}"`);
  }
}

interface Pending {
  resolve: (v: RedisReply) => void;
  reject: (e: Error) => void;
}

/**
 * One lazily opened connection; replies come back in order. A broken or timed-out connection fails everything in
 * flight and the next command reconnects.
 */
export class RedisClient {
  readonly target: RedisTarget;
  private sock?: net.Socket;
  private connecting?: Promise<net.Socket>;
  private pending: Pending[] = [];
  private buf: Buffer = Buffer.alloc(0);

  constructor(
    url: string,
    private readonly opts: { connectTimeoutMs?: number; commandTimeoutMs?: number } = {}
  ) {
    this.target = parseRedisUrl(url);
  }

  /** Runs one command; a Redis error reply rejects. */
  async command(...args: (string | number)[]): Promise<RedisReply> {
    const [r] = await this.pipeline([args]);
    if (r instanceof RedisError) {
      throw r;
    }
    return r;
  }

  /** Sends several commands in one round trip. Error replies are returned in place, not thrown. */
  async pipeline(cmds: (string | number)[][]): Promise<RedisReply[]> {
    if (!cmds.length) {
      return [];
    }
    const sock = await this.connect();
    const replies = cmds.map(() => new Promise<RedisReply>((resolve, reject) => this.pending.push({ resolve, reject })));
    const timer = setTimeout(() => this.fail(new Error('Redis did not answer in time')), this.opts.commandTimeoutMs ?? 5000);
    try {
      sock.write(Buffer.concat(cmds.map(encode)));
      return await Promise.all(replies);
    } finally {
      clearTimeout(timer);
    }
  }

  close(): void {
    this.fail(new Error('Redis connection closed'));
  }

  private connect(): Promise<net.Socket> {
    if (this.sock && !this.sock.destroyed) {
      return Promise.resolve(this.sock);
    }
    if (this.connecting) {
      return this.connecting;
    }
    // One handshake for everyone who calls while it runs; the socket is published only once AUTH/SELECT succeeded,
    // so no caller can slip a command in before the connection is authenticated.
    this.connecting = this.open()
      .then(async (sock) => {
        await this.hello(sock);
        this.sock = sock;
        return sock;
      })
      .finally(() => {
        this.connecting = undefined;
      });
    return this.connecting;
  }

  private open(): Promise<net.Socket> {
    const t = this.target;
    return new Promise<net.Socket>((resolve, reject) => {
      const sock = t.tls ? tls.connect({ host: t.host, port: t.port, servername: t.host }) : net.connect({ host: t.host, port: t.port });
      const timer = setTimeout(() => {
        sock.destroy();
        reject(new Error(`Cannot reach Redis at ${t.host}:${t.port} (timed out)`));
      }, this.opts.connectTimeoutMs ?? 1500);
      sock.setNoDelay(true);
      sock.once(t.tls ? 'secureConnect' : 'connect', () => {
        clearTimeout(timer);
        this.buf = Buffer.alloc(0);
        resolve(sock);
      });
      sock.on('data', (d: Buffer) => this.onData(d));
      sock.on('error', (e) => {
        clearTimeout(timer);
        reject(new Error(`Cannot reach Redis at ${t.host}:${t.port}: ${e.message}`));
        // A late error from a socket we already gave up on must not take down its replacement.
        if (this.sock === sock || !this.sock) {
          this.fail(e);
        }
      });
      sock.on('close', () => {
        if (this.sock === sock) {
          this.fail(new Error('Redis connection closed'));
        }
      });
    });
  }

  private async hello(sock: net.Socket): Promise<void> {
    const t = this.target;
    const cmds: (string | number)[][] = [];
    if (t.password) {
      cmds.push(t.username ? ['AUTH', t.username, t.password] : ['AUTH', t.password]);
    }
    if (t.db) {
      cmds.push(['SELECT', t.db]);
    }
    if (!cmds.length) {
      return;
    }
    const replies = await new Promise<RedisReply[]>((resolve, reject) => {
      const out: RedisReply[] = [];
      const timer = setTimeout(() => reject(new Error('Redis did not answer the handshake')), this.opts.commandTimeoutMs ?? 5000);
      const done = (v: RedisReply) => {
        out.push(v);
        if (out.length === cmds.length) {
          clearTimeout(timer);
          resolve(out);
        }
      };
      for (let i = 0; i < cmds.length; i++) {
        this.pending.push({ resolve: done, reject: (e) => (clearTimeout(timer), reject(e)) });
      }
      sock.write(Buffer.concat(cmds.map(encode)));
    }).catch((e) => {
      sock.destroy();
      throw e;
    });
    const bad = replies.find((r) => r instanceof RedisError);
    if (bad) {
      sock.destroy();
      throw bad;
    }
  }

  private onData(d: Buffer): void {
    this.buf = this.buf.length ? Buffer.concat([this.buf, d]) : d;
    let at = 0;
    for (;;) {
      let r: ReturnType<typeof parseReply>;
      try {
        r = parseReply(this.buf, at);
      } catch (e) {
        this.fail(e as Error);
        return;
      }
      if (!r) {
        break;
      }
      at = r.next;
      this.pending.shift()?.resolve(r.value);
    }
    this.buf = at ? this.buf.subarray(at) : this.buf;
  }

  private fail(e: Error): void {
    const pending = this.pending;
    this.pending = [];
    this.buf = Buffer.alloc(0);
    const sock = this.sock;
    this.sock = undefined;
    sock?.destroy();
    for (const p of pending) {
      p.reject(e);
    }
  }
}
