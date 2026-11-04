import * as vscode from 'vscode';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { getConfig, McpServerConfig, onConfigChange } from '../config';
import { ToolRegistry } from '../tools/registry';
import { Tool, ToolDefinition } from '../types';
import { getManagedPolicy, mcpServerAllowed } from '../agent/managedPolicy';
import { forgetMcpToolOrigin, mcpToolOrigin, registerMcpToolOrigin } from '../agent/permissions';
import { resolveApiKey } from '../providers/cloud';
import { expandMcpServer, loadMcpFiles, McpLayer, McpSource, mcpFingerprint, mcpTrustKey, mergeMcpLayers, normalizeMcpServers, userMcpFile } from './config';
import type { McpTrust } from './trust';
import { HttpError, JsonRpcMessage, SseTransport, StdioTransport, StreamableHttpTransport, Transport, transportKind } from './transports';
import { recordTelemetry } from '../telemetry/catalog';

interface McpToolInfo {
  name: string;
  description?: string;
  inputSchema?: ToolDefinition['parameters'];
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
}

/** `${env:NAME}` from the environment; `${secret:NAME}` the same way provider API keys are. */
const lookupRef = (kind: 'env' | 'secret', name: string) => (kind === 'env' ? process.env[name] : resolveApiKey({ apiKey: `\${secret:${name}}` }));

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

  /** Called once per start with the `${…}` references that resolved to nothing (left as written). */
  onMissingRefs?: (missing: string[]) => void;

  private make(kind: 'stdio' | 'http' | 'sse'): Transport {
    const { cfg: expanded, missing } = expandMcpServer(this.cfg, lookupRef);
    if (missing.length) {
      this.onMissingRefs?.(missing);
    }
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(expanded.headers ?? {})) {
      if (v) {
        headers[k] = v;
      }
    }
    // A variable that expands to nothing is left out so it does not blank the inherited one.
    const env = Object.fromEntries(Object.entries(expanded.env ?? {}).filter(([, v]) => v));
    const cfg: McpServerConfig = { ...expanded, env };
    if (kind === 'stdio') {
      return new StdioTransport(cfg, vscode.workspace.workspaceFolders?.[0]?.uri.fsPath, (m) => this.log.debug(`[mcp:${this.name}] ${m}`));
    }
    return kind === 'http' ? new StreamableHttpTransport(cfg.url!, headers, this.fetchImpl) : new SseTransport(cfg.url!, headers, this.fetchImpl);
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
    const init = await this.handshake(kind);
    const tools: McpToolInfo[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 20; page++) {
      const res = (await this.request('tools/list', cursor ? { cursor } : {})) as { tools?: McpToolInfo[]; nextCursor?: string };
      tools.push(...(res?.tools ?? []));
      cursor = res?.nextCursor;
      if (!cursor) {
        break;
      }
    }
    this.tools = tools;
    this.log.info(`[mcp:${this.name}] ${kind}${this.cfg.url ? ` ${this.cfg.url}` : ''}: ${init?.serverInfo?.name ?? 'server'} ${init?.serverInfo?.version ?? ''} · protocol ${init?.protocolVersion ?? '?'} · ${this.tools.length} tools`);
  }

  private async handshake(kind: 'stdio' | 'http' | 'sse'): Promise<{ protocolVersion?: string; serverInfo?: { name?: string; version?: string } }> {
    const init = (await this.request('initialize', {
      protocolVersion: kind === 'http' ? '2025-06-18' : '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'LocalPilot', version: this.clientVersion },
    })) as { protocolVersion?: string; serverInfo?: { name?: string; version?: string } };
    if (init?.protocolVersion) {
      this.transport?.setProtocolVersion?.(init.protocolVersion);
    }
    await this.notify('notifications/initialized', {});
    return init;
  }

  /** One re-handshake shared by every call that found the HTTP session gone. */
  private reinit?: Promise<void>;

  /**
   * A request that survives an expired Streamable HTTP session (a server restart, a session timeout): the server
   * answers 404 (or a 400 naming the session), so the client starts a new session and retries once.
   */
  private async requestWithReinit(method: string, params: unknown, timeoutMs?: number, signal?: AbortSignal): Promise<unknown> {
    const transport = this.transport;
    const hadSession = transport instanceof StreamableHttpTransport && transport.hasSession;
    try {
      return await this.request(method, params, timeoutMs, signal);
    } catch (e) {
      const expired = e instanceof HttpError && (e.status === 404 || (e.status === 400 && /session/i.test(e.message)));
      if (!hadSession || !expired || this.closing || this.transport !== transport) {
        throw e;
      }
      this.log.info(`[mcp:${this.name}] session expired (${e.status}); starting a new one`);
      this.reinit ??= (async () => {
        transport.resetSession();
        await this.handshake('http');
      })().finally(() => (this.reinit = undefined));
      try {
        await this.reinit;
      } catch (err) {
        const down = err instanceof Error ? err : new Error(String(err));
        this.log.warn(`[mcp:${this.name}] could not start a new session: ${down.message}`);
        if (!this.closing) {
          this.onDown?.(down);
        }
        throw down;
      }
      return this.request(method, params, timeoutMs, signal);
    }
  }

  async callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal, timeoutMs = 120_000): Promise<{ text: string; isError: boolean }> {
    const res = (await this.requestWithReinit('tools/call', { name, arguments: args }, timeoutMs, signal)) as { content?: { type: string; text?: string; data?: string; uri?: string; resource?: { uri?: string; text?: string } }[]; isError?: boolean; structuredContent?: unknown };
    const parts = (res.content ?? []).map((c) =>
      c.type === 'text' ? c.text ?? '' : c.type === 'resource' ? c.resource?.text ?? `[resource ${c.resource?.uri ?? ''}]` : c.type === 'resource_link' ? `[resource ${c.uri ?? ''}]` : `[${c.type} content]`
    );
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
type ServerEntry = McpServerConfig & { source: McpSource; file?: string };

/**
 * Starts configured MCP servers and registers their tools as `mcp_<server>_<tool>`. Servers come from the
 * `localpilot.mcpServers` setting, the workspace's `.mcp.json` (after the user trusts it), the user's mcp.json and
 * plugins; a reload starts, stops or restarts only the servers whose configuration changed.
 */
export class McpManager implements vscode.Disposable {
  private clients = new Map<string, McpClient>();
  private errors = new Map<string, string>();
  private registrations = new Map<string, vscode.Disposable>();
  /** Restart attempts per server since it last ran fine, and their timers. */
  private restarts = new Map<string, { attempts: number; timer?: ReturnType<typeof setTimeout> }>();
  /** The fingerprint each started (or failed) server was started with. */
  private started = new Map<string, string>();
  /** Bumped by stopOne(), so a start of that server in flight then does not register itself afterwards. */
  private gens = new Map<string, number>();
  /** Every configured server after the last load, with its origin; timeout and autoApprove are read from here live. */
  private servers: Record<string, ServerEntry> = {};
  private disposed = false;
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  /** Fires after every (re)load so UIs can refresh connection status. */
  readonly onDidChange = this._onDidChange.event;
  private configSub: vscode.Disposable;
  /** Servers contributed by plugins (`.mcp.json`), merged below the user's `localpilot.mcpServers`. */
  extraServers: () => Record<string, McpServerConfig> = () => ({});
  /** Asks before the workspace's `.mcp.json` servers start; without it they stay stopped. */
  trust?: McpTrust;
  /** Folders whose `.mcp.json` is read. */
  projectFolders: () => string[] = () => (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
  userFile: () => string = userMcpFile;
  /** A server file with errors: its path and one line per problem (reported once per distinct content). */
  onFileProblems?: (file: string, problems: string[]) => void;
  /** Trust keys the user said "Not now" to in this session. */
  private declined = new Set<string>();
  private asking = false;
  private reported = new Set<string>();
  private warned = new Set<string>();
  private watchers = new Map<string, fs.FSWatcher>();
  private watchTimer?: ReturnType<typeof setTimeout>;

  constructor(private readonly tools: ToolRegistry, private readonly log: vscode.LogOutputChannel, private readonly clientVersion = '0.0.0') {
    // Only a change to the servers themselves restarts them. Any other localpilot.* change (a default model, LocalPilot's
    // own auto-tuning) used to stop every server and fail the MCP tool calls in flight.
    this.configSub = onConfigChange(() => void this.reloadIfChanged());
  }

  /** Reloads run one at a time: a second settings change while servers are still starting must not race a stop against a start. */
  private reloading: Promise<void> = Promise.resolve();

  private queue(fn: () => Promise<void>): Promise<void> {
    this.reloading = this.reloading.then(fn).catch((e) => this.log.error(`MCP reload failed: ${e instanceof Error ? e.message : String(e)}`));
    return this.reloading;
  }

  /** Reads the configuration again; servers that failed are retried, running ones whose configuration is unchanged keep running. */
  reload(): Promise<void> {
    return this.queue(() => this.doReload());
  }

  /** Reloads only when the servers' configuration changed (a plugin change that adds no server does nothing). */
  reloadIfChanged(): Promise<void> {
    return this.queue(async () => {
      const layers = await this.layers();
      if (this.signature(layers) !== this.loadedSignature) {
        await this.doReload(layers);
      }
    });
  }

  private loadedSignature = '';
  /** Everything that decides which servers run and how: every layer, and the policy's allowlist. */
  private signature(layers: McpLayer[]): string {
    return JSON.stringify([layers.map((l) => [l.file ?? l.source, l.servers, l.problems]), getManagedPolicy(this.log).allowedMcpServers ?? null]);
  }

  private async layers(): Promise<McpLayer[]> {
    const settings = normalizeMcpServers({ mcpServers: getConfig().mcpServers ?? {} });
    const files = await loadMcpFiles(this.projectFolders(), this.userFile());
    return [{ source: 'settings', servers: settings.servers, problems: settings.problems }, ...files, { source: 'plugin', servers: this.extraServers(), problems: [] }];
  }

  private async doReload(layers?: McpLayer[]): Promise<void> {
    if (this.disposed) {
      return;
    }
    layers ??= await this.layers();
    this.loadedSignature = this.signature(layers);
    this.watch(layers);
    for (const l of layers) {
      if (!l.problems.length) {
        continue;
      }
      this.log.warn(`MCP configuration ${l.file ?? '(localpilot.mcpServers)'}: ${l.problems.join('; ')}`);
      const key = `${l.file}\n${l.problems.join('\n')}`;
      if (l.file && !this.reported.has(key)) {
        this.reported.add(key);
        this.onFileProblems?.(l.file, l.problems);
      }
    }
    this.servers = mergeMcpLayers(layers);
    const policy = getManagedPolicy(this.log);
    const blocked = new Map<string, string>();
    const desired = new Map<string, ServerEntry>();
    const untrusted: { name: string; cfg: ServerEntry; key: string }[] = [];
    for (const [name, c] of Object.entries(this.servers)) {
      if (c.enabled === false || !transportKind(c)) {
        continue;
      }
      if (!mcpServerAllowed(policy, name)) {
        blocked.set(name, "not on the MCP server allowlist in your organization's policy");
        continue;
      }
      const key = mcpTrustKey(name, c);
      if (c.source === 'project' && !this.trust?.isTrusted(key)) {
        untrusted.push({ name, cfg: c, key });
        continue;
      }
      desired.set(name, c);
    }
    if (untrusted.length) {
      await this.askTrust(untrusted, desired, blocked);
    }
    // Stop what was removed or changed (and retry what failed); what runs or waits to restart unchanged keeps going.
    for (const name of new Set([...this.started.keys(), ...this.clients.keys()])) {
      const want = desired.get(name);
      if (!want || mcpFingerprint(want) !== this.started.get(name) || (!this.clients.has(name) && !this.restarts.has(name))) {
        this.stopOne(name);
      }
    }
    for (const name of [...this.errors.keys()]) {
      if (!this.started.has(name)) {
        this.errors.delete(name);
      }
    }
    blocked.forEach((msg, name) => this.errors.set(name, msg));
    await Promise.all([...desired].filter(([name]) => !this.started.has(name)).map(([name, cfg]) => this.startOne(name, cfg)));
    this._onDidChange.fire();
  }

  /** Project servers nobody trusted yet: asked per file, in the background (VS Code) or before starting (the CLI). */
  private async askTrust(list: { name: string; cfg: ServerEntry; key: string }[], desired: Map<string, ServerEntry>, blocked: Map<string, string>): Promise<void> {
    const declinedMsg = 'not started: you chose not to start the servers in this workspace\'s .mcp.json (reload the window to be asked again)';
    for (const u of list) {
      blocked.set(u.name, this.declined.has(u.key) ? declinedMsg : this.trust ? "waiting for you to trust this workspace's .mcp.json" : "not started: servers from the workspace's .mcp.json need your trust");
    }
    const fresh = list.filter((u) => !this.declined.has(u.key));
    if (!this.trust || !fresh.length || this.asking) {
      return;
    }
    const byFile = new Map<string, typeof fresh>();
    for (const u of fresh) {
      const f = u.cfg.file ?? '.mcp.json';
      byFile.set(f, [...(byFile.get(f) ?? []), u]);
    }
    const trust = this.trust;
    for (const [file, group] of byFile) {
      const answer = async () => {
        this.asking = true;
        try {
          const ok = await trust.ask(group.map((u) => u.name), file, group.map((u) => u.key));
          if (!ok) {
            group.forEach((u) => this.declined.add(u.key));
          }
          return ok;
        } catch (e) {
          this.log.warn(`MCP trust prompt: ${e instanceof Error ? e.message : String(e)}`);
          return false;
        } finally {
          this.asking = false;
        }
      };
      if (!trust.blocking) {
        // The answer reloads: the trusted servers start, the next file (if any) is asked about.
        void answer().then(() => {
          if (!this.disposed) {
            void this.reload();
          }
        });
        return;
      }
      const ok = await answer();
      for (const u of group) {
        if (ok) {
          desired.set(u.name, u.cfg);
          blocked.delete(u.name);
        } else {
          blocked.set(u.name, declinedMsg);
        }
      }
    }
  }

  /** Watches the server files (not plugins: their manager reports changes) and reloads 100 ms after the last change. */
  private watch(layers: McpLayer[]): void {
    const dirs = new Map<string, Set<string>>();
    for (const l of layers) {
      if (l.file && l.source !== 'plugin') {
        const dir = path.dirname(l.file);
        dirs.set(dir, (dirs.get(dir) ?? new Set()).add(path.basename(l.file)));
      }
    }
    for (const [dir, w] of this.watchers) {
      if (!dirs.has(dir)) {
        w.close();
        this.watchers.delete(dir);
      }
    }
    for (const [dir, names] of dirs) {
      if (this.watchers.has(dir)) {
        continue;
      }
      try {
        const w = fs.watch(dir, { persistent: false }, (_ev, f) => {
          if (!f || names.has(String(f))) {
            clearTimeout(this.watchTimer);
            this.watchTimer = setTimeout(() => void this.reloadIfChanged(), 100);
            this.watchTimer.unref?.();
          }
        });
        w.on('error', () => {
          w.close();
          this.watchers.delete(dir);
        });
        this.watchers.set(dir, w);
      } catch {
        /* the folder does not exist (yet): watched from the next reload on */
      }
    }
  }

  private gen(name: string): number {
    return this.gens.get(name) ?? 0;
  }

  private async startOne(name: string, cfg: McpServerConfig, gen = this.gen(name)): Promise<boolean> {
    const client = new McpClient(name, cfg, this.log, this.clientVersion);
    this.started.set(name, mcpFingerprint(cfg));
    client.onMissingRefs = (missing) => {
      const key = `${name}\n${missing.join('\n')}`;
      if (!this.warned.has(key)) {
        this.warned.add(key);
        this.log.warn(`MCP server "${name}": ${missing.join(', ')} ${missing.length > 1 ? 'are' : 'is'} not set; left as written`);
      }
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // One unresponsive server must not stall every reload (and the CLI's start-up).
      await Promise.race([
        client.start(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('did not answer within 30 s')), 30_000);
          timer.unref?.();
        }),
      ]);
      clearTimeout(timer);
      // Stopped (a reload, dispose) while it was starting: this start no longer counts.
      if (gen !== this.gen(name) || this.disposed) {
        client.dispose();
        return false;
      }
      this.registrations.get(name)?.dispose();
      this.registrations.delete(name);
      this.clients.get(name)?.dispose();
      this.clients.set(name, client);
      this.errors.delete(name);
      const tools = client.tools.map((t) => this.toTool(client, t));
      const forget = new vscode.Disposable(() =>
        tools.forEach((t, i) => {
          const o = mcpToolOrigin(t.definition.name);
          if (o && o.server === name && o.tool === client.tools[i].name) {
            forgetMcpToolOrigin(t.definition.name);
          }
        })
      );
      this.registrations.set(name, vscode.Disposable.from(this.tools.registerAll(tools), forget));
      client.onDown = (err) => this.serverDown(name, client, err);
      return true;
    } catch (e) {
      clearTimeout(timer);
      if (gen !== this.gen(name) || this.disposed) {
        client.dispose();
        return false;
      }
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
  private serverDown(name: string, client: McpClient, err: Error): void {
    if (this.clients.get(name) !== client) {
      return;
    }
    this.registrations.get(name)?.dispose();
    this.registrations.delete(name);
    this.clients.delete(name);
    client.dispose();
    this.scheduleRestart(name, err);
  }

  private scheduleRestart(name: string, err: Error): void {
    const r = this.restarts.get(name) ?? { attempts: 0 };
    const delays = [2_000, 10_000, 60_000];
    if (r.attempts >= delays.length) {
      // Given up: the next reload tries again.
      this.restarts.delete(name);
      this.errors.set(name, `stopped: ${err.message} (gave up after ${delays.length} restarts)`);
      this._onDidChange.fire();
      return;
    }
    this.errors.set(name, `stopped: ${err.message} — restarting`);
    this._onDidChange.fire();
    const gen = this.gen(name);
    r.timer = setTimeout(() => {
      if (gen !== this.gen(name) || this.disposed) {
        return;
      }
      // The configuration may have changed since the server went down: start what is configured now, if anything.
      const current = this.servers[name];
      if (!current || current.enabled === false || !transportKind(current) || !mcpServerAllowed(getManagedPolicy(this.log), name)) {
        this.restarts.delete(name);
        return;
      }
      r.attempts++;
      void this.startOne(name, current, gen).then((ok) => {
        if (gen !== this.gen(name) || this.disposed) {
          return;
        }
        this.log.info(`MCP server "${name}" ${ok ? 'restarted' : 'could not be restarted'} (attempt ${r.attempts})`);
        // A server that then runs for a minute counts as healthy again.
        if (ok) {
          setTimeout(() => this.clients.has(name) && this.restarts.delete(name), 60_000).unref?.();
        } else {
          this.scheduleRestart(name, err);
        }
        this._onDidChange.fire();
      });
    }, delays[r.attempts]);
    this.restarts.set(name, r);
  }

  private toTool(client: McpClient, t: McpToolInfo): Tool {
    const full = `${client.name}_${t.name}`.replace(/[^a-zA-Z0-9_-]/g, '_');
    let registeredName = `mcp_${full.slice(0, 60)}`;
    const owner = mcpToolOrigin(registeredName);
    const taken = owner ? owner.server !== client.name || owner.tool !== t.name : !!this.tools.get(registeredName);
    if (full.length > 60 || taken) {
      // Cut or clashing names get a hash of the real server/tool so two tools never share (and overwrite) one name.
      const hash = createHash('sha1').update(`${client.name}/${t.name}`).digest('hex').slice(0, 8);
      registeredName = `mcp_${full.slice(0, 51)}_${hash}`;
      this.log.info(`MCP tool ${client.name}/${t.name} registered as ${registeredName}`);
    }
    registerMcpToolOrigin(registeredName, client.name, t.name);
    const live = () => this.servers[client.name];
    const log = this.log;
    return {
      definition: {
        name: registeredName,
        description: `[MCP ${client.name}] ${t.description ?? t.name}`,
        parameters: t.inputSchema ?? { type: 'object', properties: {} },
      },
      approvalKind: 'network',
      readOnly: t.annotations?.readOnlyHint === true,
      async execute(args, ctx) {
        if (ctx.readOnly && t.annotations?.readOnlyHint !== true) {
          return { content: 'This MCP tool may change files or remote state, which Plan/Ask mode does not allow. Switch to Agent mode to use it.', isError: true };
        }
        const cfg = live();
        // A server's autoApprove list skips the prompt, unless the organisation's policy or the user's setting forbids or floors it.
        const auto = !!cfg?.autoApprove?.includes(t.name) && !getManagedPolicy(log).approvals.network && getConfig().approvals.network !== 'never';
        if (!auto && !(await ctx.requestApproval(`Call MCP tool ${client.name}/${t.name}`, JSON.stringify(args ?? {}).slice(0, 2000), 'network'))) {
          return { content: 'User declined the MCP tool call.', isError: true };
        }
        const started = Date.now();
        let ok = false;
        try {
          const r = await client.callTool(t.name, args, ctx.signal, cfg?.timeout ? Math.min(3600, Math.max(1, cfg.timeout)) * 1000 : undefined);
          ok = !r.isError;
          return { content: r.text, isError: r.isError };
        } finally {
          recordTelemetry({ type: 'mcp_call', server: client.name, tool: t.name, durationMs: Date.now() - started, ok });
        }
      },
    };
  }

  private stopOne(name: string): void {
    this.gens.set(name, this.gen(name) + 1);
    this.registrations.get(name)?.dispose();
    this.registrations.delete(name);
    clearTimeout(this.restarts.get(name)?.timer);
    this.restarts.delete(name);
    this.clients.get(name)?.dispose();
    this.clients.delete(name);
    this.started.delete(name);
    this.errors.delete(name);
  }

  private stopAll(): void {
    for (const name of new Set([...this.started.keys(), ...this.clients.keys(), ...this.registrations.keys(), ...this.restarts.keys()])) {
      this.stopOne(name);
    }
  }

  /** Connected servers with their tool counts, plus configured servers that failed to start (or wait for trust) and why. */
  get status(): { name: string; tools: number; error?: string; transport?: string }[] {
    return [
      ...[...this.clients.values()].map((c) => ({ name: c.name, tools: c.tools.length, transport: c.kind })),
      ...[...this.errors].map(([name, error]) => ({ name, tools: 0, error })),
    ];
  }

  dispose(): void {
    this.disposed = true;
    this.configSub.dispose();
    this._onDidChange.dispose();
    clearTimeout(this.watchTimer);
    this.watchers.forEach((w) => w.close());
    this.watchers.clear();
    this.stopAll();
  }
}
