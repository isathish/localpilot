import * as vscode from 'vscode';
import { getConfig, McpServerConfig, onConfigChange } from '../config';
import { ToolRegistry } from '../tools/registry';
import { Tool, ToolDefinition } from '../types';
import { getManagedPolicy, mcpServerAllowed } from '../agent/managedPolicy';
import { resolveApiKey } from '../providers/cloud';
import { expandHeaders, HttpError, JsonRpcMessage, SseTransport, StdioTransport, StreamableHttpTransport, Transport, transportKind } from './transports';

interface McpToolInfo {
  name: string;
  description?: string;
  inputSchema?: ToolDefinition['parameters'];
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
}

/** Expands `${env:NAME}` / `${secret:NAME}` the same way provider API keys are. */
const resolveRef = (raw: string) => resolveApiKey({ apiKey: raw });

/** An MCP client: JSON-RPC requests and responses over whichever transport the server uses (stdio, HTTP, SSE). */
export class McpClient implements vscode.Disposable {
  private transport?: Transport;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  tools: McpToolInfo[] = [];

  constructor(readonly name: string, private readonly cfg: McpServerConfig, private readonly log: vscode.LogOutputChannel, private readonly clientVersion: string, private readonly fetchImpl: typeof fetch = fetch) {}

  get kind(): Transport['kind'] | undefined {
    return this.transport?.kind;
  }

  private failPending(err: Error): void {
    for (const [, p] of this.pending) {
      p.reject(err);
    }
    this.pending.clear();
  }

  private make(kind: 'stdio' | 'http' | 'sse'): Transport {
    const headers = expandHeaders(this.cfg.headers, resolveRef);
    if (kind === 'stdio') {
      return new StdioTransport(this.cfg, vscode.workspace.workspaceFolders?.[0]?.uri.fsPath, (m) => this.log.debug(`[mcp:${this.name}] ${m}`));
    }
    return kind === 'http' ? new StreamableHttpTransport(this.cfg.url!, headers, this.fetchImpl) : new SseTransport(this.cfg.url!, headers, this.fetchImpl);
  }

  async start(): Promise<void> {
    const kind = transportKind(this.cfg);
    if (!kind) {
      throw new Error('needs a "command" (a local server) or a "url" (a remote one)');
    }
    try {
      await this.connect(kind);
    } catch (e) {
      // Backwards compatibility from the MCP spec: a server that rejects the Streamable HTTP POST with a 4xx may be
      // an older HTTP+SSE server at the same URL. Only when the type was not set explicitly.
      if (kind === 'http' && !this.cfg.type && e instanceof HttpError && e.status >= 400 && e.status < 500 && e.status !== 401 && e.status !== 403) {
        this.log.info(`[mcp:${this.name}] Streamable HTTP refused (${e.status}); trying HTTP+SSE`);
        this.transport?.close();
        await this.connect('sse');
      } else {
        throw e;
      }
    }
  }

  private async connect(kind: 'stdio' | 'http' | 'sse'): Promise<void> {
    this.transport = this.make(kind);
    await this.transport.start(
      (m) => this.onMessage(m),
      (err) => {
        this.log.warn(`[mcp:${this.name}] ${err.message}`);
        this.failPending(err);
        // An exit nobody asked for (a crash, a dropped SSE stream): let the manager restart the server.
        if (!this.closing) {
          this.onDown?.(err);
        }
      }
    );
    const init = (await this.request('initialize', {
      protocolVersion: kind === 'http' ? '2025-06-18' : '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'LocalPilot', version: this.clientVersion },
    })) as { protocolVersion?: string; serverInfo?: { name?: string; version?: string } };
    if (init?.protocolVersion) {
      this.transport.setProtocolVersion?.(init.protocolVersion);
    }
    await this.notify('notifications/initialized', {});
    const res = (await this.request('tools/list', {})) as { tools?: McpToolInfo[] };
    this.tools = res.tools ?? [];
    this.log.info(`[mcp:${this.name}] ${kind}${this.cfg.url ? ` ${this.cfg.url}` : ''}: ${init?.serverInfo?.name ?? 'server'} ${init?.serverInfo?.version ?? ''} · protocol ${init?.protocolVersion ?? '?'} · ${this.tools.length} tools`);
  }

  async callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<{ text: string; isError: boolean }> {
    const res = (await this.request('tools/call', { name, arguments: args }, 120_000, signal)) as { content?: { type: string; text?: string; data?: string }[]; isError?: boolean; structuredContent?: unknown };
    const parts = (res.content ?? []).map((c) => (c.type === 'text' ? c.text ?? '' : `[${c.type} content]`));
    if (!parts.length && res.structuredContent !== undefined) {
      parts.push(JSON.stringify(res.structuredContent, null, 2));
    }
    return { text: parts.join('\n'), isError: !!res.isError };
  }

  private onMessage(msg: JsonRpcMessage): void {
    if (typeof msg.id === 'number' && this.pending.has(msg.id) && (msg.result !== undefined || msg.error)) {
      const p = this.pending.get(msg.id)!;
      this.pending.delete(msg.id);
      if (msg.error) {
        p.reject(new Error(msg.error.message));
      } else {
        p.resolve(msg.result);
      }
    } else if (msg.method === 'ping' && msg.id !== undefined) {
      // Servers may ping the client; answer so they do not drop the connection.
      void this.transport?.send({ id: msg.id, result: {} }).catch(() => undefined);
    }
  }

  private request(method: string, params: unknown, timeoutMs = 30_000, signal?: AbortSignal): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        return reject(new Error('Cancelled'));
      }
      const onAbort = () => {
        if (this.pending.delete(id)) {
          clearTimeout(t);
          void this.notify('notifications/cancelled', { requestId: id, reason: 'Cancelled by user' });
          reject(new Error('Cancelled'));
        }
      };
      const t = setTimeout(() => {
        this.pending.delete(id);
        signal?.removeEventListener('abort', onAbort);
        reject(new Error(`MCP ${method} timed out`));
      }, timeoutMs);
      signal?.addEventListener('abort', onAbort, { once: true });
      const done = () => {
        clearTimeout(t);
        signal?.removeEventListener('abort', onAbort);
      };
      this.pending.set(id, {
        resolve: (v) => {
          done();
          resolve(v);
        },
        reject: (e) => {
          done();
          reject(e);
        },
      });
      if (!this.transport) {
        this.pending.delete(id);
        done();
        return reject(new Error('MCP server is not running'));
      }
      this.transport.send({ id, method, params }).catch((e: Error) => {
        if (this.pending.delete(id)) {
          done();
          reject(e);
        }
      });
    });
  }

  private async notify(method: string, params: unknown): Promise<void> {
    await this.transport?.send({ method, params }).catch((e: Error) => this.log.debug(`[mcp:${this.name}] ${method}: ${e.message}`));
  }

  /** Called when the server goes away on its own after starting (not on dispose). */
  onDown?: (err: Error) => void;
  private closing = false;

  dispose(): void {
    this.closing = true;
    this.failPending(new Error('MCP server stopped'));
    this.transport?.close();
  }
}

/** Starts configured MCP servers and registers their tools as `mcp_<server>_<tool>`. */
export class McpManager implements vscode.Disposable {
  private clients = new Map<string, McpClient>();
  private errors = new Map<string, string>();
  private registrations = new Map<string, vscode.Disposable>();
  /** Restart attempts per server since it last ran fine, and their timers. */
  private restarts = new Map<string, { attempts: number; timer?: ReturnType<typeof setTimeout> }>();
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  /** Fires after every (re)load so UIs can refresh connection status. */
  readonly onDidChange = this._onDidChange.event;
  private configSub: vscode.Disposable;
  /** Servers contributed by plugins (`.mcp.json`), merged below the user's `localpilot.mcpServers`. */
  extraServers: () => Record<string, McpServerConfig> = () => ({});

  constructor(private readonly tools: ToolRegistry, private readonly log: vscode.LogOutputChannel, private readonly clientVersion = '0.0.0') {
    // Only a change to the servers themselves restarts them. Any other localpilot.* change (a default model, LocalPilot's
    // own auto-tuning) used to stop every server and fail the MCP tool calls in flight.
    this.configSub = onConfigChange(() => {
      if (this.signature() !== this.loadedSignature) {
        void this.reload();
      }
    });
  }

  /** Reloads run one at a time: a second settings change while servers are still starting must not race `stopAll()` against `start()`. */
  private reloading: Promise<void> = Promise.resolve();

  reload(): Promise<void> {
    this.reloading = this.reloading.then(() => this.doReload()).catch((e) => this.log.error(`MCP reload failed: ${e instanceof Error ? e.message : String(e)}`));
    return this.reloading;
  }

  private loadedSignature = '';
  /** Everything that decides which servers run and how: configured and plugin servers, and the policy's allowlist. */
  private signature(): string {
    return JSON.stringify([getConfig().mcpServers, this.extraServers(), getManagedPolicy(this.log).allowedMcpServers ?? null]);
  }

  private async doReload(): Promise<void> {
    this.loadedSignature = this.signature();
    this.stopAll();
    this.errors.clear();
    const servers = { ...this.extraServers(), ...getConfig().mcpServers };
    await Promise.all(
      Object.entries(servers)
        .filter(([name, c]) => {
          if (c.enabled === false || !transportKind(c)) {
            return false;
          }
          if (!mcpServerAllowed(getManagedPolicy(this.log), name)) {
            this.errors.set(name, "not on the MCP server allowlist in your organization's policy");
            return false;
          }
          return true;
        })
        .map(([name, cfg]) => this.startOne(name, cfg))
    );
    this._onDidChange.fire();
  }

  private async startOne(name: string, cfg: McpServerConfig): Promise<boolean> {
    const client = new McpClient(name, cfg, this.log, this.clientVersion);
    try {
      await client.start();
      this.clients.set(name, client);
      this.errors.delete(name);
      this.registrations.set(name, this.tools.registerAll(client.tools.map((t) => this.toTool(client, t))));
      client.onDown = (err) => this.serverDown(name, cfg, client, err);
      return true;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.errors.set(name, msg);
      this.log.error(`MCP server "${name}" failed to start: ${msg}`);
      client.dispose();
      return false;
    }
  }

  /**
   * A server that was running went away: its tools are withdrawn (calls would only fail) and it is started again,
   * after 2 s, 10 s and 60 s; after three failed attempts it stays down with the error shown in Settings.
   */
  private serverDown(name: string, cfg: McpServerConfig, client: McpClient, err: Error): void {
    if (this.clients.get(name) !== client) {
      return;
    }
    this.registrations.get(name)?.dispose();
    this.registrations.delete(name);
    this.clients.delete(name);
    client.dispose();
    this.scheduleRestart(name, cfg, err);
  }

  private scheduleRestart(name: string, cfg: McpServerConfig, err: Error): void {
    const r = this.restarts.get(name) ?? { attempts: 0 };
    const delays = [2_000, 10_000, 60_000];
    if (r.attempts >= delays.length) {
      this.errors.set(name, `stopped: ${err.message} (gave up after ${delays.length} restarts)`);
      this._onDidChange.fire();
      return;
    }
    this.errors.set(name, `stopped: ${err.message} — restarting`);
    this._onDidChange.fire();
    r.timer = setTimeout(() => {
      r.attempts++;
      void this.startOne(name, cfg).then((ok) => {
        this.log.info(`MCP server "${name}" ${ok ? 'restarted' : 'could not be restarted'} (attempt ${r.attempts})`);
        // A server that then runs for a minute counts as healthy again.
        if (ok) {
          setTimeout(() => this.clients.has(name) && this.restarts.delete(name), 60_000).unref?.();
        } else {
          this.scheduleRestart(name, cfg, err);
        }
        this._onDidChange.fire();
      });
    }, delays[r.attempts]);
    this.restarts.set(name, r);
  }

  private toTool(client: McpClient, t: McpToolInfo): Tool {
    const safe = `${client.name}_${t.name}`.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 60);
    return {
      definition: {
        name: `mcp_${safe}`,
        description: `[MCP ${client.name}] ${t.description ?? t.name}`,
        parameters: t.inputSchema ?? { type: 'object', properties: {} },
      },
      approvalKind: 'network',
      readOnly: t.annotations?.readOnlyHint === true,
      async execute(args, ctx) {
        if (ctx.readOnly && t.annotations?.readOnlyHint !== true) {
          return { content: 'This MCP tool may change files or remote state, which Plan/Ask mode does not allow. Switch to Agent mode to use it.', isError: true };
        }
        if (!(await ctx.requestApproval(`Call MCP tool ${client.name}/${t.name}`, JSON.stringify(args ?? {}).slice(0, 2000), 'network'))) {
          return { content: 'User declined the MCP tool call.', isError: true };
        }
        const r = await client.callTool(t.name, args, ctx.signal);
        return { content: r.text, isError: r.isError };
      },
    };
  }

  private stopAll(): void {
    this.registrations.forEach((r) => r.dispose());
    this.registrations.clear();
    this.restarts.forEach((r) => clearTimeout(r.timer));
    this.restarts.clear();
    for (const [, c] of this.clients) {
      c.dispose();
    }
    this.clients.clear();
  }

  /** Connected servers with their tool counts, plus configured servers that failed to start and why. */
  get status(): { name: string; tools: number; error?: string; transport?: string }[] {
    return [
      ...[...this.clients.values()].map((c) => ({ name: c.name, tools: c.tools.length, transport: c.kind })),
      ...[...this.errors].map(([name, error]) => ({ name, tools: 0, error })),
    ];
  }

  dispose(): void {
    this.configSub.dispose();
    this._onDidChange.dispose();
    this.stopAll();
  }
}
