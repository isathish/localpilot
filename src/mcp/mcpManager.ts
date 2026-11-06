import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { getConfig, McpServerConfig, onConfigChange } from '../config';
import { ToolRegistry } from '../tools/registry';
import { Tool, ToolDefinition, ToolResult } from '../types';
import { getManagedPolicy, managedMcpServers, mcpServerAllowed, mcpServerBlocked } from '../agent/managedPolicy';
import { forgetMcpToolOrigin, mcpServerNames, mcpToolOrigin, registerMcpToolOrigin } from '../agent/permissions';
import { toolDisabled } from '../agent/toolAliases';
import { resolveApiKey } from '../providers/cloud';
import { expandMcpServer, loadMcpFiles, setMcpFileServerEnabled, McpLayer, mcpLogLevel, McpSource, mcpFingerprint, mcpTimeoutMessage, mcpTimeoutSeconds, mcpTrustKey, mergeMcpLayers, policyAndSettingsLayers, userMcpFile, withMcpEnabled } from './config';
import type { McpTrust } from './trust';
import { HttpError, JsonRpcMessage, SseTransport, StdioTransport, StreamableHttpTransport, Transport, transportKind } from './transports';
import { recordTelemetry } from '../telemetry/catalog';
import { McpContentItem, mcpContentToResult, mcpResourceText, mcpToolVisibleToModel } from './content';
import { mapPromptArgs, mcpPromptUsage, promptMessagesToText } from './prompts';
import { mcpToolName } from './toolNames';
import type { ImageAttachment } from '../ui/images';
import { McpAuthRequiredError, McpOAuth } from './oauth';
import { mcpWatchTargets, McpServerFileWatcher } from './serverWatch';
import { secretRefs } from '../providers/cloud';

export interface McpToolInfo {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: ToolDefinition['parameters'];
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
  _meta?: unknown;
}

export interface McpResourceInfo {
  uri: string;
  name?: string;
  description?: string;
  mimeType?: string;
}

export interface McpResourceTemplateInfo {
  uriTemplate: string;
  name?: string;
  description?: string;
  mimeType?: string;
}

export interface McpPromptInfo {
  name: string;
  description?: string;
  arguments?: { name: string; description?: string; required?: boolean }[];
}

type ListKind = 'tools' | 'resources' | 'prompts';

/** A JSON-RPC error reply; `code` -32601 is MethodNotFound. */
export class McpRpcError extends Error {
  constructor(message: string, readonly code: number) {
    super(message);
  }
}

/** A connected server's lists and connection state, as Settings and the chat show it. */
export interface McpServerStatus {
  name: string;
  state: 'connecting' | 'connected' | 'error' | 'disabled' | 'restarting' | 'auth_required';
  /** Number of tools the model is offered. */
  tools: number;
  error?: string;
  transport?: string;
  source?: McpSource;
  toolList?: { name: string; description?: string; params: { name: string; type?: string; description?: string; required: boolean }[] }[];
  resources?: McpResourceInfo[];
  resourceTemplates?: McpResourceTemplateInfo[];
  prompts?: McpPromptInfo[];
  /** The server's own `autoApprove` list (Settings shows those tools as "Allow" by default). */
  autoApprove?: string[];
}

/** `${env:NAME}` from the environment; `${secret:NAME}` the same way provider API keys are. */
const lookupRef = (kind: 'env' | 'secret', name: string) => (kind === 'env' ? process.env[name] : resolveApiKey({ apiKey: `\${secret:${name}}` }));

/** One value with its `${…}` references expanded. */
const expandRef = (v: string) => expandMcpServer({ command: v }, lookupRef).cfg.command ?? v;

/** A remote server's URL with references expanded (undefined for a local server). */
function remoteUrl(cfg: McpServerConfig): string | undefined {
  const kind = transportKind(cfg);
  return kind === 'http' || kind === 'sse' ? expandMcpServer(cfg, lookupRef).cfg.url : undefined;
}

/** A configured OAuth client, its `${env:}` / `${secret:}` references expanded. */
const oauthClientOf = (cfg: McpServerConfig) => (cfg.oauthClient ? { clientId: expandRef(cfg.oauthClient.clientId), clientSecret: cfg.oauthClient.clientSecret && expandRef(cfg.oauthClient.clientSecret) } : undefined);

const authMessage = (name: string) => `needs you to sign in: click Authenticate in Settings → MCP servers, or run \`localpilot mcp auth ${name}\``;

/** An MCP client: JSON-RPC requests and responses over whichever transport the server uses (stdio, HTTP, SSE). */
export class McpClient implements vscode.Disposable {
  private transport?: Transport;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  tools: McpToolInfo[] = [];
  resources: McpResourceInfo[] = [];
  resourceTemplates: McpResourceTemplateInfo[] = [];
  prompts: McpPromptInfo[] = [];
  /** What the server said it supports in `initialize`. */
  private capabilities: { tools?: unknown; resources?: unknown; prompts?: unknown } = {};
  private listTimers = new Map<ListKind, ReturnType<typeof setTimeout>>();
  /** The live `timeout` (seconds) and the file it is set in; read per request so an edit applies without a restart. */
  settings?: () => { timeout?: number; file?: string } | undefined;
  /** A list the server announced as changed was fetched again. */
  onListChanged?: (kind: ListKind) => void;

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
    if (kind === 'http') {
      const http = new StreamableHttpTransport(cfg.url!, headers, this.fetchImpl);
      http.debug = (m) => this.log.debug(`[mcp:${this.name}] ${m}`);
      http.onSessionExpired = () => {
        if (this.closing || this.transport !== http) {
          return;
        }
        this.log.info(`[mcp:${this.name}] session expired (event stream); starting a new one`);
        // Notifications sent while the session was gone are lost: fetch the lists again once the new one is up.
        void this.renewSession(http).then(() => {
          for (const k of ['tools', 'resources', 'prompts'] as const) {
            if (k === 'tools' || this.capabilities[k]) {
              this.listChanged(k);
            }
          }
        }, () => undefined);
      };
      return http;
    }
    return new SseTransport(cfg.url!, headers, this.fetchImpl);
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
    // Fetched together; a capability the server does not declare (or a MethodNotFound reply) is an empty list.
    const res = !!this.capabilities.resources;
    [this.tools, this.resources, this.resourceTemplates, this.prompts] = await Promise.all([
      this.firstList<McpToolInfo>('tools/list', 'tools', true),
      this.firstList<McpResourceInfo>('resources/list', 'resources', res),
      this.firstList<McpResourceTemplateInfo>('resources/templates/list', 'resourceTemplates', res),
      this.firstList<McpPromptInfo>('prompts/list', 'prompts', !!this.capabilities.prompts),
    ]);
    this.log.info(`[mcp:${this.name}] ${kind}${this.cfg.url ? ` ${this.cfg.url}` : ''}: ${init?.serverInfo?.name ?? 'server'} ${init?.serverInfo?.version ?? ''} · protocol ${init?.protocolVersion ?? '?'} · ${this.tools.length} tools`);
  }

  private async handshake(kind: 'stdio' | 'http' | 'sse'): Promise<{ protocolVersion?: string; serverInfo?: { name?: string; version?: string } }> {
    const init = (await this.request('initialize', {
      protocolVersion: kind === 'http' ? '2025-06-18' : '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'LocalPilot', version: this.clientVersion },
    })) as { protocolVersion?: string; capabilities?: McpClient['capabilities']; serverInfo?: { name?: string; version?: string } };
    if (init?.protocolVersion) {
      this.transport?.setProtocolVersion?.(init.protocolVersion);
    }
    this.capabilities = init?.capabilities ?? {};
    await this.notify('notifications/initialized', {});
    this.transport?.listen?.();
    return init;
  }

  /** Every page of a list method (`tools/list`, `resources/templates/list`, …); `key` names the array in each reply. */
  private async listAll<T>(method: string, key: string, first = false, timeoutMs?: number): Promise<T[]> {
    const out: T[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 20; page++) {
      // While connecting a refused request must reach start(), which may fall back to SSE.
      const res = (await (first ? this.request(method, cursor ? { cursor } : {}, timeoutMs) : this.requestWithReinit(method, cursor ? { cursor } : {}, timeoutMs))) as Record<string, unknown> & { nextCursor?: string };
      out.push(...((Array.isArray(res?.[key]) ? res[key] : []) as T[]));
      cursor = res?.nextCursor;
      if (!cursor) {
        break;
      }
    }
    return out;
  }

  /** A list fetched while connecting: empty when undeclared or unknown to the server; only a failing `tools/list` fails the start. */
  private async firstList<T>(method: string, key: string, declared: boolean): Promise<T[]> {
    if (!declared) {
      return [];
    }
    try {
      // A server that never answers an optional list must not hold up its start (which gives up after 30 s).
      return await this.listAll<T>(method, key, true, method === 'tools/list' ? undefined : Math.min(10_000, this.timeoutSeconds * 1000));
    } catch (e) {
      if (e instanceof McpRpcError && e.code === -32601) {
        return [];
      }
      if (method === 'tools/list') {
        throw e;
      }
      this.log.debug(`[mcp:${this.name}] ${method}: ${e instanceof Error ? e.message : String(e)}`);
      return [];
    }
  }

  /** Fetches one list again; a server that fails it keeps the previous list. */
  private async refreshList(kind: ListKind): Promise<boolean> {
    try {
      if (kind === 'tools') {
        this.tools = await this.listAll<McpToolInfo>('tools/list', 'tools');
      } else if (kind === 'resources') {
        const [resources, templates] = await Promise.all([
          this.listAll<McpResourceInfo>('resources/list', 'resources'),
          this.listAll<McpResourceTemplateInfo>('resources/templates/list', 'resourceTemplates').catch(() => this.resourceTemplates),
        ]);
        this.resources = resources;
        this.resourceTemplates = templates;
      } else {
        this.prompts = await this.listAll<McpPromptInfo>('prompts/list', 'prompts');
      }
      return true;
    } catch (e) {
      this.log.debug(`[mcp:${this.name}] ${kind}/list: ${e instanceof Error ? e.message : String(e)}`);
      return false;
    }
  }

  /** `notifications/<kind>/list_changed`: fetched again 300 ms after the last one, so a burst costs one request. */
  private listChanged(kind: ListKind): void {
    clearTimeout(this.listTimers.get(kind));
    const t = setTimeout(() => {
      this.listTimers.delete(kind);
      if (this.closing) {
        return;
      }
      void this.refreshList(kind).then((ok) => {
        if (ok && !this.closing) {
          this.log.info(`[mcp:${this.name}] ${kind} changed: ${kind === 'tools' ? this.tools.length : kind === 'resources' ? this.resources.length : this.prompts.length} now`);
          this.onListChanged?.(kind);
        }
      });
    }, 300);
    t.unref?.();
    this.listTimers.set(kind, t);
  }

  /** The request timeout in seconds, from the server's live configuration. */
  get timeoutSeconds(): number {
    return mcpTimeoutSeconds(this.settings?.()?.timeout ?? this.cfg.timeout);
  }

  /** One re-handshake shared by every call that found the HTTP session gone. */
  private reinit?: Promise<void>;

  /**
   * A request that survives an expired Streamable HTTP session (a server restart, a session timeout): the server
   * answers 404 (or a 400 naming the session), so the client starts a new session and retries once.
   */
  private async requestWithReinit(method: string, params: unknown, timeoutMs?: number, signal?: AbortSignal): Promise<unknown> {
    // A session renewal in progress has cleared the session: wait for the new one instead of sending without it.
    if (this.reinit) {
      await this.reinit.catch(() => undefined);
    }
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
      await this.renewSession(transport);
      return this.request(method, params, timeoutMs, signal);
    }
  }

  /** Starts a new HTTP session (shared by every caller that found the old one gone); a failure takes the server down. */
  private async renewSession(transport: StreamableHttpTransport): Promise<void> {
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
  }

  async callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal, timeoutMs?: number): Promise<{ text: string; images: ImageAttachment[]; isError: boolean }> {
    const res = (await this.requestWithReinit('tools/call', { name, arguments: args }, timeoutMs, signal)) as { content?: McpContentItem[]; isError?: boolean; structuredContent?: unknown };
    const { text, images } = mcpContentToResult(res?.content, res?.structuredContent, `${this.name}-${name}`.replace(/[^\w.-]+/g, '_'));
    return { text, images, isError: !!res?.isError };
  }

  /** `resources/read`: the text of a resource (binary contents named, images returned as images). */
  async readResource(uri: string, signal?: AbortSignal): Promise<{ text: string; images: ImageAttachment[] }> {
    const res = (await this.requestWithReinit('resources/read', { uri }, undefined, signal)) as { contents?: { uri?: string; mimeType?: string; text?: string; blob?: string }[] };
    return mcpResourceText(res?.contents);
  }

  /** `prompts/get` with the arguments as strings (the spec allows only strings). */
  async getPrompt(name: string, args: Record<string, string>, signal?: AbortSignal): Promise<{ text: string; images: ImageAttachment[]; description?: string }> {
    const res = (await this.requestWithReinit('prompts/get', { name, arguments: args }, undefined, signal)) as { description?: string; messages?: { role?: string; content?: McpContentItem | McpContentItem[] }[] };
    return { ...promptMessagesToText(res ?? {}, `${this.name}-${name}`.replace(/[^\w.-]+/g, '_')), description: res?.description };
  }

  private onMessage(msg: JsonRpcMessage): void {
    if (typeof msg.id === 'number' && this.pending.has(msg.id) && (msg.result !== undefined || msg.error)) {
      const p = this.pending.get(msg.id)!;
      this.pending.delete(msg.id);
      if (msg.error) {
        p.reject(new McpRpcError(msg.error.message, msg.error.code));
      } else {
        p.resolve(msg.result);
      }
    } else if (msg.method === 'ping' && msg.id !== undefined) {
      // Servers may ping the client; answer so they do not drop the connection.
      void this.transport?.send({ id: msg.id, result: {} }).catch(() => undefined);
    } else if (msg.method && msg.id === undefined) {
      this.onNotification(msg.method, msg.params);
    }
  }

  private onNotification(method: string, params: unknown): void {
    const changed = /^notifications\/(tools|resources|prompts)\/list_changed$/.exec(method);
    if (changed) {
      this.listChanged(changed[1] as ListKind);
    } else if (method === 'notifications/message') {
      const p = (params ?? {}) as { level?: unknown; logger?: unknown; data?: unknown };
      const text = typeof p.data === 'string' ? p.data : JSON.stringify(p.data);
      this.log[mcpLogLevel(p.level)](`[mcp:${this.name}]${typeof p.logger === 'string' && p.logger ? ` ${p.logger}:` : ''} ${text ?? ''}`);
    }
  }

  private request(method: string, params: unknown, timeoutMs?: number, signal?: AbortSignal): Promise<unknown> {
    const id = this.nextId++;
    const ms = timeoutMs ?? this.timeoutSeconds * 1000;
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
        void this.notify('notifications/cancelled', { requestId: id, reason: 'Timed out' });
        reject(new Error(mcpTimeoutMessage(this.name, Math.round(ms / 1000), this.settings?.()?.file)));
      }, ms);
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
    this.listTimers.forEach((t) => clearTimeout(t));
    this.listTimers.clear();
    this.failPending(new Error('MCP server stopped'));
    this.transport?.close();
  }
}
type ServerEntry = McpServerConfig & { source: McpSource; file?: string };

/** Whether `localpilot.disabledTools` switches off every tool of this server (`mcp__<server>`); its resources are then hidden too. */
function mcpServerSwitchedOff(server: string): boolean {
  const disabled = getConfig().disabledTools;
  return disabled.length > 0 && mcpServerNames(server).some((n) => toolDisabled(n, disabled));
}

/**
 * Starts configured MCP servers and registers their tools as `mcp_<server>__<tool>`. Servers come from the
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
  /** Servers whose start is in flight. */
  private connecting = new Set<string>();
  /** `mcp_read_resource`, registered while some connected server offers resources. */
  private resourceTool?: { sig: string; reg: vscode.Disposable };
  /** OAuth sign-in for remote servers that answer 401; without it such servers just fail. */
  private _oauth?: McpOAuth;
  /** Remote servers waiting for the user to sign in. */
  private authRequired = new Set<string>();
  /** Restarts a stdio server when its script changes (`localpilot.mcp.watchServerFiles`). */
  private readonly fileWatch = new McpServerFileWatcher((name, file) => this.serverFileChanged(name, file));
  /** Loads the `${secret:…}` values server configurations reference before they start. */
  loadSecrets?: (names: string[]) => Promise<void>;

  constructor(private readonly tools: ToolRegistry, private readonly log: vscode.LogOutputChannel, private readonly clientVersion = '0.0.0') {
    // Only a change to the servers themselves restarts them. Any other localpilot.* change (a default model, LocalPilot's
    // own auto-tuning) used to stop every server and fail the MCP tool calls in flight.
    let watching = getConfig().mcpWatchServerFiles;
    this.configSub = onConfigChange(() => {
      // Turning the file watch on or off does not change any server, so the running ones are (un)watched here.
      if (getConfig().mcpWatchServerFiles !== watching) {
        watching = !watching;
        for (const name of this.started.keys()) {
          const cfg = this.servers[name];
          if (cfg) {
            this.watchServerFiles(name, cfg);
          }
        }
      }
      void this.reloadIfChanged();
    });
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
    const p = getManagedPolicy(this.log);
    return JSON.stringify([layers.map((l) => [l.file ?? l.source, l.servers, l.problems]), p.allowedMcpServers ?? null, p.blockPersonalRemoteMcp, [...this.alwaysOn]]);
  }

  /** The servers each configuration file had when it last read cleanly. */
  private readonly lastGoodServers = new Map<string, McpLayer['servers']>();

  /** The organisation's servers that cannot be switched off. */
  private alwaysOn = new Set<string>();

  private async layers(): Promise<McpLayer[]> {
    // The organisation's servers come first, so no user or project server can take their names. A user switches one
    // off (unless it is always enabled) with `{ "enabled": false }` under its name in localpilot.mcpServers.
    const org = managedMcpServers(getManagedPolicy(this.log));
    this.alwaysOn = new Set(org.alwaysEnabled);
    // A file caught mid-save (empty) or with a syntax error keeps the servers it last had: dropping them would stop
    // every server of the file and start them again a moment later, when the save completes or the typo is fixed.
    const files = (await loadMcpFiles(this.projectFolders(), this.userFile())).map((l) => {
      if (!l.file) {
        return l;
      }
      if (!l.unreadable) {
        this.lastGoodServers.set(l.file, l.servers);
        return l;
      }
      const kept = this.lastGoodServers.get(l.file);
      return kept ? { ...l, servers: kept } : l;
    });
    return [
      ...policyAndSettingsLayers(org, getConfig().mcpServers ?? {}),
      ...files,
      { source: 'plugin', servers: this.extraServers(), problems: [] },
    ];
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
    if (this.loadSecrets) {
      const names = secretRefs(JSON.stringify(this.servers));
      if (names.length) {
        await this.loadSecrets(names).catch((e) => this.log.warn(`MCP secrets: ${e instanceof Error ? e.message : String(e)}`));
      }
    }
    const policy = getManagedPolicy(this.log);
    const blocked = new Map<string, string>();
    const desired = new Map<string, ServerEntry>();
    const untrusted: { name: string; cfg: ServerEntry; key: string }[] = [];
    for (const [name, c] of Object.entries(this.servers)) {
      if (!this.switchedOn(name, c) || !transportKind(c)) {
        continue;
      }
      const refused = mcpServerBlocked(policy, name, c);
      if (refused) {
        blocked.set(name, refused);
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
    // Watched even when the start fails: fixing the script restarts the server.
    this.watchServerFiles(name, cfg);
    const client = new McpClient(name, cfg, this.log, this.clientVersion, this.fetchFor(cfg));
    client.settings = () => this.servers[name];
    this.started.set(name, mcpFingerprint(cfg));
    client.onMissingRefs = (missing) => {
      const key = `${name}\n${missing.join('\n')}`;
      if (!this.warned.has(key)) {
        this.warned.add(key);
        this.log.warn(`MCP server "${name}": ${missing.join(', ')} ${missing.length > 1 ? 'are' : 'is'} not set; left as written`);
      }
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    this.connecting.add(name);
    this._onDidChange.fire();
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
      this.clients.get(name)?.dispose();
      this.clients.set(name, client);
      this.errors.delete(name);
      this.authRequired.delete(name);
      this.registerTools(name, client);
      client.onDown = (err) => this.serverDown(name, client, err);
      client.onListChanged = (kind) => {
        if (this.clients.get(name) !== client || this.disposed) {
          return;
        }
        if (kind === 'tools') {
          this.registerTools(name, client);
        } else if (kind === 'resources') {
          this.syncResourceTool();
        }
        this._onDidChange.fire();
      };
      return true;
    } catch (e) {
      clearTimeout(timer);
      if (gen !== this.gen(name) || this.disposed) {
        client.dispose();
        return false;
      }
      if (e instanceof McpAuthRequiredError) {
        this.authRequired.add(name);
        this.errors.set(name, authMessage(name));
        this.log.warn(`MCP server "${name}" needs you to sign in (OAuth)`);
        client.dispose();
        return false;
      }
      const msg = e instanceof Error ? e.message : String(e);
      this.errors.set(name, msg);
      this.log.error(`MCP server "${name}" failed to start: ${msg}`);
      client.dispose();
      return false;
    } finally {
      if (gen === this.gen(name)) {
        this.connecting.delete(name);
      }
    }
  }

  /** (Re)registers one server's tools, replacing only that server's previous ones. */
  private registerTools(name: string, client: McpClient): void {
    this.registrations.get(name)?.dispose();
    this.registrations.delete(name);
    // Tools a server marks as app-only (`_meta.ui.visibility` without "model") are never offered to the model.
    const infos = client.tools.filter(mcpToolVisibleToModel);
    const tools = infos.map((t) => this.toTool(client, t));
    const forget = new vscode.Disposable(() =>
      tools.forEach((t, i) => {
        const o = mcpToolOrigin(t.definition.name);
        if (o && o.server === name && o.tool === infos[i].name) {
          forgetMcpToolOrigin(t.definition.name);
        }
      })
    );
    this.registrations.set(name, vscode.Disposable.from(this.tools.registerAll(tools), forget));
    this.syncResourceTool();
  }

  /** Registers `mcp_read_resource` while a connected server has resources (its description lists them), else removes it. */
  private syncResourceTool(): void {
    const offering = [...this.clients.values()].filter((c) => (c.resources.length || c.resourceTemplates.length) && !mcpServerSwitchedOff(c.name));
    const lines = offering.map((c) => {
      const shown = c.resources.slice(0, 15).map((r) => `${r.uri}${r.name && r.name !== r.uri ? ` (${r.name})` : ''}`);
      const more = c.resources.length > shown.length ? `, … ${c.resources.length - shown.length} more` : '';
      const templates = c.resourceTemplates.slice(0, 5).map((t) => t.uriTemplate);
      return `- ${c.name}: ${[...shown, ...templates.map((t) => `template ${t}`)].join(', ')}${more}`;
    });
    const sig = lines.join('\n');
    if (sig === this.resourceTool?.sig) {
      return;
    }
    this.resourceTool?.reg.dispose();
    this.resourceTool = undefined;
    if (!offering.length || this.disposed) {
      return;
    }
    this.resourceTool = { sig, reg: this.tools.registerAll([this.resourceReadTool(lines)]) };
  }

  private resourceReadTool(lines: string[]): Tool {
    const clients = this.clients;
    return {
      definition: {
        name: 'mcp_read_resource',
        description: `Read a resource (a file, record or document) from a connected MCP server by its URI. Fill a template's {placeholders} to build a URI.\nResources:\n${lines.join('\n')}`,
        parameters: {
          type: 'object',
          properties: {
            server: { type: 'string', description: 'The MCP server name.' },
            uri: { type: 'string', description: 'The resource URI.' },
          },
          required: ['server', 'uri'],
        },
      },
      approvalKind: 'mcp',
      readOnly: true,
      parallelSafe: true,
      async execute(args, ctx): Promise<ToolResult> {
        const server = String(args.server ?? '').trim();
        const uri = String(args.uri ?? '').trim();
        const client = mcpServerSwitchedOff(server) ? undefined : clients.get(server);
        if (!client) {
          return { content: `No connected MCP server named "${server}". Connected: ${[...clients.keys()].filter((n) => !mcpServerSwitchedOff(n)).join(', ') || 'none'}.`, isError: true };
        }
        if (!uri) {
          return { content: 'uri is required.', isError: true };
        }
        if (!(await ctx.requestApproval(`Read MCP resource from ${server}`, uri, 'mcp'))) {
          return { content: 'User declined reading the MCP resource.', isError: true };
        }
        const started = Date.now();
        let ok = false;
        try {
          const r = await client.readResource(uri, ctx.signal);
          ok = true;
          return { content: r.text || '(empty resource)', images: r.images.length ? r.images : undefined, data: r.images.length ? { images: r.images } : undefined };
        } catch (e) {
          return { content: `Could not read ${uri} from ${server}: ${e instanceof Error ? e.message : String(e)}`, isError: true };
        } finally {
          recordTelemetry({ type: 'mcp_call', server, tool: 'resources/read', durationMs: Date.now() - started, ok });
        }
      },
    };
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
    this.syncResourceTool();
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
      if (!current || !this.switchedOn(name, current) || !transportKind(current) || !mcpServerAllowed(getManagedPolicy(this.log), name, current)) {
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
        } else if (this.authRequired.has(name)) {
          // Retrying cannot help until the user signs in.
          this.restarts.delete(name);
        } else {
          this.scheduleRestart(name, err);
        }
        this._onDidChange.fire();
      });
    }, delays[r.attempts]);
    this.restarts.set(name, r);
  }

  private toTool(client: McpClient, t: McpToolInfo): Tool {
    let registeredName = mcpToolName(client.name, t.name);
    const owner = mcpToolOrigin(registeredName);
    const taken = owner ? owner.server !== client.name || owner.tool !== t.name : !!this.tools.get(registeredName);
    if (taken) {
      // `mcp_a__b__c` is both server a's tool b__c and server a__b's tool c: the second one gets the hashed name.
      registeredName = mcpToolName(client.name, t.name, true);
    }
    if (registeredName !== `mcp_${client.name}__${t.name}`) {
      this.log.info(`MCP tool ${client.name}/${t.name} registered as ${registeredName}`);
    }
    registerMcpToolOrigin(registeredName, client.name, t.name);
    const live = () => this.servers[client.name];
    return {
      definition: {
        name: registeredName,
        description: `[MCP ${client.name}] ${t.description ?? t.name}`,
        parameters: t.inputSchema ?? { type: 'object', properties: {} },
      },
      approvalKind: 'mcp',
      readOnly: t.annotations?.readOnlyHint === true,
      async execute(args, ctx) {
        if (ctx.readOnly && t.annotations?.readOnlyHint !== true) {
          return { content: 'This MCP tool may change files or remote state, which Plan/Ask mode does not allow. Switch to Agent mode to use it.', isError: true };
        }
        const cfg = live();
        // Settings → MCP servers: the user's per-tool choice wins over the server's autoApprove list.
        const toolMode = getConfig().mcpToolApprovals[client.name]?.[t.name];
        if (toolMode === 'never') {
          return { content: `Not run: ${client.name}/${t.name} is set to Block in Settings → MCP servers. Do not call this tool again; use another approach or ask the user to allow it.`, isError: true };
        }
        // A server's autoApprove list is only a hint: the approval gate honours it unless a rule, hook or the organisation asks.
        const autoApprove = !toolMode && !!cfg?.autoApprove?.includes(t.name);
        if (!(await ctx.requestApproval(`Call MCP tool ${client.name}/${t.name}`, JSON.stringify(args ?? {}).slice(0, 2000), 'mcp', autoApprove || toolMode ? { ...(autoApprove ? { autoApprove } : {}), ...(toolMode ? { toolMode } : {}) } : undefined))) {
          return { content: 'User declined the MCP tool call.', isError: true };
        }
        const started = Date.now();
        let ok = false;
        try {
          const r = await client.callTool(t.name, args, ctx.signal);
          ok = !r.isError;
          return { content: r.text, isError: r.isError, images: r.images.length ? r.images : undefined, data: r.images.length ? { images: r.images } : undefined };
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
    this.authRequired.delete(name);
    this.connecting.delete(name);
    this.fileWatch.unwatch(name);
    this.syncResourceTool();
  }

  private stopAll(): void {
    for (const name of new Set([...this.started.keys(), ...this.clients.keys(), ...this.registrations.keys(), ...this.restarts.keys()])) {
      this.stopOne(name);
    }
  }

  /**
   * Every configured server with its state: connected ones with their tools, resources and prompts; servers starting,
   * waiting to restart, failed (or waiting for trust) with why; and switched-off ones.
   */
  get status(): McpServerStatus[] {
    const out = new Map<string, McpServerStatus>();
    for (const c of this.clients.values()) {
      const visible = c.tools.filter(mcpToolVisibleToModel);
      out.set(c.name, {
        name: c.name,
        state: 'connected',
        tools: visible.length,
        transport: c.kind,
        source: this.servers[c.name]?.source,
        toolList: visible.map((t) => {
          const props = (t.inputSchema?.properties ?? {}) as Record<string, { type?: unknown; description?: unknown }>;
          const required = new Set(Array.isArray(t.inputSchema?.required) ? t.inputSchema.required : []);
          return {
            name: t.name,
            description: t.description ?? t.title,
            params: Object.entries(props).map(([k, v]) => ({ name: k, type: typeof v?.type === 'string' ? v.type : undefined, description: typeof v?.description === 'string' ? v.description : undefined, required: required.has(k) })),
          };
        }),
        resources: c.resources,
        resourceTemplates: c.resourceTemplates,
        prompts: c.prompts,
        ...(this.servers[c.name]?.autoApprove?.length ? { autoApprove: [...this.servers[c.name].autoApprove!] } : {}),
      });
    }
    for (const name of this.connecting) {
      if (!out.has(name)) {
        out.set(name, { name, state: 'connecting', tools: 0, source: this.servers[name]?.source });
      }
    }
    for (const [name, error] of this.errors) {
      if (!out.has(name)) {
        out.set(name, { name, state: this.authRequired.has(name) ? 'auth_required' : this.restarts.get(name)?.timer ? 'restarting' : 'error', tools: 0, error, source: this.servers[name]?.source });
      }
    }
    for (const [name, c] of Object.entries(this.servers)) {
      if (!out.has(name) && !this.switchedOn(name, c)) {
        out.set(name, { name, state: 'disabled', tools: 0, source: c.source });
      }
    }
    const order = Object.keys(this.servers);
    const rank = (n: string) => (order.includes(n) ? order.indexOf(n) : order.length);
    return [...out.values()].sort((a, b) => rank(a.name) - rank(b.name));
  }

  /** Stops and starts one server again (the Restart buttons); resolves whether it is running afterwards. */
  restart(name: string): Promise<boolean> {
    return this.queue(async () => {
      const cfg = this.servers[name];
      const ready = !!cfg && this.switchedOn(name, cfg) && !!transportKind(cfg) && mcpServerAllowed(getManagedPolicy(this.log), name, cfg) && (cfg.source !== 'project' || !!this.trust?.isTrusted(mcpTrustKey(name, cfg)));
      this.stopOne(name);
      this._onDidChange.fire();
      if (ready) {
        await this.startOne(name, cfg);
        this._onDidChange.fire();
      } else {
        // Not startable as configured (switched off, blocked, untrusted): a reload reports why.
        await this.doReload();
      }
    }).then(() => this.clients.has(name));
  }

  /** Servers switched off (or on) for this process only (the CLI's `/mcp disable|enable`); their configuration is left as it is. */
  private sessionOff = new Set<string>();
  private sessionOn = new Set<string>();

  /** Enabled in its configuration or for this session, and not switched off for this session. */
  private switchedOn(name: string, c: ServerEntry): boolean {
    if (c.source === 'managed' && this.alwaysOn.has(name)) {
      return true;
    }
    return !this.sessionOff.has(name) && (c.enabled !== false || this.sessionOn.has(name));
  }

  /** An organisation server marked `alwaysEnabled`: no switch turns it off. */
  isAlwaysEnabled(name: string): boolean {
    return this.servers[name]?.source === 'managed' && this.alwaysOn.has(name);
  }

  /** Switches a server off (or back on) until the process ends, without writing its configuration. */
  async setSessionEnabled(name: string, enabled: boolean): Promise<void> {
    if (!this.servers[name]) {
      throw new Error(`No MCP server named "${name}"`);
    }
    if (!enabled && this.isAlwaysEnabled(name)) {
      throw new Error(`"${name}" is required by your organization's policy and cannot be switched off`);
    }
    if (enabled) {
      this.sessionOff.delete(name);
      this.sessionOn.add(name);
    } else {
      this.sessionOff.add(name);
      this.sessionOn.delete(name);
    }
    await this.reload();
  }

  /** Switches a server on or off where it is defined (the setting or its .mcp.json / mcp.json file). */
  async setEnabled(name: string, enabled: boolean): Promise<void> {
    const entry = this.servers[name];
    if (!entry) {
      throw new Error(`No MCP server named "${name}"`);
    }
    if (entry.source === 'plugin') {
      throw new Error(`"${name}" comes from a plugin: switch the plugin off instead`);
    }
    if (entry.source === 'managed') {
      if (!enabled && this.isAlwaysEnabled(name)) {
        throw new Error(`"${name}" is required by your organization's policy and cannot be switched off`);
      }
      // The policy file is not the user's to edit: the switch is a `{ "enabled": false }` entry in the user's settings.
      const cfg = vscode.workspace.getConfiguration('localpilot');
      const map = { ...(cfg.inspect<Record<string, McpServerConfig>>('mcpServers')?.globalValue ?? {}) };
      if (enabled) {
        delete map[name];
      } else {
        map[name] = { enabled: false };
      }
      await cfg.update('mcpServers', Object.keys(map).length ? map : undefined, vscode.ConfigurationTarget.Global);
    } else if (entry.source === 'settings') {
      const cfg = vscode.workspace.getConfiguration('localpilot');
      const info = cfg.inspect<Record<string, McpServerConfig>>('mcpServers');
      const inWorkspace = !!info?.workspaceValue && name in info.workspaceValue;
      const map = { ...((inWorkspace ? info?.workspaceValue : info?.globalValue) ?? {}) };
      map[name] = withMcpEnabled(map[name] ?? {}, enabled);
      await cfg.update('mcpServers', map, inWorkspace ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global);
    } else if (entry.file) {
      await setMcpFileServerEnabled(entry.file, name, enabled);
    }
    await this.reload();
  }

  /** Every prompt of the connected servers, as the slash commands that run them. */
  get promptCommands(): { invoke: string; description: string; argumentHint: string; server: string; prompt: string }[] {
    return [...this.clients.values()].flatMap((c) =>
      c.prompts.map((p) => ({ invoke: `/mcp:${c.name}:${p.name}`, description: p.description ?? `MCP prompt from ${c.name}`, argumentHint: mcpPromptUsage(c.name, p.name, p.arguments).split(' ').slice(1).join(' '), server: c.name, prompt: p.name }))
    );
  }

  /** Runs a server's prompt with typed arguments (by position or `key=value`) and returns the messages as one user turn. */
  async getPrompt(server: string, prompt: string, rawArgs: string, signal?: AbortSignal): Promise<{ text: string; images: ImageAttachment[] }> {
    const client = this.clients.get(server);
    if (!client) {
      const why = this.errors.get(server);
      throw new Error(this.servers[server] ? `MCP server "${server}" is not connected${why ? `: ${why}` : ''}` : `No MCP server named "${server}"`);
    }
    const info = client.prompts.find((p) => p.name === prompt);
    if (!info) {
      throw new Error(`MCP server "${server}" has no prompt "${prompt}"${client.prompts.length ? ` (it has ${client.prompts.map((p) => p.name).join(', ')})` : ''}`);
    }
    const { args, missing } = mapPromptArgs(rawArgs, info.arguments);
    if (missing.length) {
      throw new Error(`missing ${missing.join(', ')}. Usage: ${mcpPromptUsage(server, prompt, info.arguments)}`);
    }
    const r = await client.getPrompt(prompt, args, signal);
    if (!r.text && !r.images.length) {
      throw new Error(`the prompt "${prompt}" of "${server}" returned no messages`);
    }
    return r;
  }

  /** The OAuth helper for remote servers; set before the first reload. */
  get oauth(): McpOAuth | undefined {
    return this._oauth;
  }

  set oauth(o: McpOAuth | undefined) {
    this._oauth = o;
    if (o) {
      o.onAuthRequired = (url) => this.authLost(url);
    }
  }

  /** The fetch a remote server uses: through OAuth unless its configuration sends its own Authorization header. */
  private fetchFor(cfg: McpServerConfig): typeof fetch {
    const url = remoteUrl(cfg);
    const ownAuth = Object.keys(cfg.headers ?? {}).some((h) => h.toLowerCase() === 'authorization');
    return this._oauth && url && !ownAuth ? this._oauth.fetchFor(url) : fetch;
  }

  /** A connected server rejected its token for good: its tools are withdrawn until the user signs in again. */
  private authLost(url: string): void {
    for (const [name, client] of [...this.clients]) {
      if (remoteUrl(this.servers[name] ?? {}) !== url) {
        continue;
      }
      this.registrations.get(name)?.dispose();
      this.registrations.delete(name);
      this.clients.delete(name);
      client.dispose();
      this.authRequired.add(name);
      this.errors.set(name, authMessage(name));
      this.log.warn(`MCP server "${name}" rejected its token: sign in again`);
      this.syncResourceTool();
      this._onDidChange.fire();
    }
  }

  /** Signs in to a remote server in the browser (OAuth 2.1), then starts it again; resolves whether it runs. */
  async authenticate(name: string, signal?: AbortSignal): Promise<boolean> {
    const cfg = this.servers[name];
    if (!cfg) {
      throw new Error(`No MCP server named "${name}"`);
    }
    const url = remoteUrl(cfg);
    if (!url) {
      throw new Error(`"${name}" is a local server: there is nothing to sign in to`);
    }
    if (!this._oauth) {
      throw new Error('OAuth sign-in is not available here');
    }
    await this._oauth.authenticate(url, { client: oauthClientOf(cfg), signal });
    this.log.info(`MCP server "${name}": signed in`);
    return this.restart(name);
  }

  /** Watches a stdio server's workspace scripts, so a rebuild restarts it. */
  private watchServerFiles(name: string, cfg: McpServerConfig): void {
    if (!getConfig().mcpWatchServerFiles) {
      this.fileWatch.unwatch(name);
      return;
    }
    this.fileWatch.watch(name, mcpWatchTargets(expandMcpServer(cfg, lookupRef).cfg, this.projectFolders()));
  }

  private serverFileChanged(name: string, file: string): void {
    if (this.disposed || !getConfig().mcpWatchServerFiles || !this.started.has(name)) {
      return;
    }
    this.log.info(`MCP server "${name}": ${file} changed; restarting`);
    void this.restart(name);
  }

  dispose(): void {
    this.disposed = true;
    this.fileWatch.dispose();
    this.configSub.dispose();
    this._onDidChange.dispose();
    clearTimeout(this.watchTimer);
    this.watchers.forEach((w) => w.close());
    this.watchers.clear();
    this.stopAll();
    this.resourceTool?.reg.dispose();
    this.resourceTool = undefined;
  }
}

/**
 * `localpilot mcp auth`: connects to one remote server with the stored token; when it answers 401 the user signs in in
 * the browser (OAuth 2.1) and it connects again. Resolves its tool count and whether a sign-in happened.
 */
export async function signInMcpServer(name: string, cfg: McpServerConfig, oauth: McpOAuth, log: vscode.LogOutputChannel, clientVersion: string, signal?: AbortSignal): Promise<{ tools: number; signedIn: boolean }> {
  const url = remoteUrl(cfg);
  if (!url) {
    throw new Error(`"${name}" is a local server: there is nothing to sign in to`);
  }
  const ownAuth = Object.keys(cfg.headers ?? {}).some((h) => h.toLowerCase() === 'authorization');
  const connect = async () => {
    const client = new McpClient(name, cfg, log, clientVersion, ownAuth ? fetch : oauth.fetchFor(url));
    try {
      await client.start();
      return client.tools.length;
    } finally {
      client.dispose();
    }
  };
  try {
    return { tools: await connect(), signedIn: false };
  } catch (e) {
    if (ownAuth || !(e instanceof McpAuthRequiredError)) {
      throw e;
    }
  }
  await oauth.authenticate(url, { client: oauthClientOf(cfg), signal });
  log.info(`MCP server "${name}": signed in`);
  return { tools: await connect(), signedIn: true };
}
