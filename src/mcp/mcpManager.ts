import * as vscode from 'vscode';
import * as cp from 'child_process';
import { getConfig, McpServerConfig, onConfigChange } from '../config';
import { ToolRegistry } from '../tools/registry';
import { Tool, ToolDefinition } from '../types';

interface JsonRpcResponse {
  id?: number;
  result?: unknown;
  error?: { code: number; message: string };
  method?: string;
  params?: unknown;
}

interface McpToolInfo {
  name: string;
  description?: string;
  inputSchema?: ToolDefinition['parameters'];
}

/** Minimal MCP client over stdio (JSON-RPC 2.0, newline-delimited). */
class McpClient implements vscode.Disposable {
  private child?: cp.ChildProcess;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private buffer = '';
  private stderrTail = '';
  tools: McpToolInfo[] = [];

  private failPending(err: Error): void {
    for (const [, p] of this.pending) {
      p.reject(err);
    }
    this.pending.clear();
  }

  constructor(readonly name: string, private readonly cfg: McpServerConfig, private readonly log: vscode.LogOutputChannel, private readonly clientVersion: string) {}

  async start(): Promise<void> {
    const cwd = this.cfg.cwd ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    // `shell: true` on Windows so `npx` / `.cmd` launchers resolve the same way they do in a terminal.
    this.child = cp.spawn(this.cfg.command, this.cfg.args ?? [], { cwd, env: { ...process.env, ...(this.cfg.env ?? {}) }, stdio: ['pipe', 'pipe', 'pipe'], shell: process.platform === 'win32' });
    const spawned = new Promise<void>((resolve, reject) => {
      this.child!.once('spawn', () => resolve());
      this.child!.once('error', (e) => reject(new Error(`cannot start "${this.cfg.command}": ${e.message}`)));
    });
    this.child.on('error', (e) => this.failPending(new Error(`MCP server error: ${e.message}`)));
    // A failed spawn or an early exit also errors the pipes (EPIPE); without listeners those would be uncaught.
    for (const stream of [this.child.stdin, this.child.stdout, this.child.stderr]) {
      stream?.on('error', (e: Error) => this.log.debug(`[mcp:${this.name}] pipe: ${e.message}`));
    }
    this.child.stdout!.on('data', (d: Buffer) => this.onData(d));
    this.child.stderr!.on('data', (d: Buffer) => {
      const line = d.toString().trim();
      this.stderrTail = line.slice(-300);
      this.log.debug(`[mcp:${this.name}] ${line}`);
    });
    this.child.on('exit', (code) => {
      this.log.warn(`[mcp:${this.name}] exited with ${code}`);
      this.failPending(new Error(`MCP server exited with code ${code ?? 'null'}${this.stderrTail ? `: ${this.stderrTail}` : ''}`));
    });
    await spawned;
    await this.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'LocalPilot', version: this.clientVersion },
    });
    this.notify('notifications/initialized', {});
    const res = (await this.request('tools/list', {})) as { tools?: McpToolInfo[] };
    this.tools = res.tools ?? [];
    this.log.info(`[mcp:${this.name}] ${this.tools.length} tools`);
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
    const res = (await this.request('tools/call', { name, arguments: args }, 120_000)) as { content?: { type: string; text?: string; data?: string }[]; isError?: boolean };
    const text = (res.content ?? []).map((c) => (c.type === 'text' ? c.text ?? '' : `[${c.type} content]`)).join('\n');
    return { text, isError: !!res.isError };
  }

  private onData(d: Buffer): void {
    this.buffer += d.toString();
    let idx: number;
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) {
        continue;
      }
      let msg: JsonRpcResponse;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id)!;
        this.pending.delete(msg.id);
        if (msg.error) {
          p.reject(new Error(msg.error.message));
        } else {
          p.resolve(msg.result);
        }
      }
    }
  }

  private request(method: string, params: unknown, timeoutMs = 30_000): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP ${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(t);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(t);
          reject(e);
        },
      });
      const stdin = this.child?.stdin;
      if (!stdin || stdin.destroyed) {
        this.pending.delete(id);
        clearTimeout(t);
        return reject(new Error('MCP server is not running'));
      }
      stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }

  private notify(method: string, params: unknown): void {
    this.child?.stdin?.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  }

  dispose(): void {
    this.child?.kill();
  }
}

/** Starts configured MCP servers and registers their tools as `mcp_<server>_<tool>`. */
export class McpManager implements vscode.Disposable {
  private clients = new Map<string, McpClient>();
  private errors = new Map<string, string>();
  private registrations: vscode.Disposable[] = [];
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  /** Fires after every (re)load so UIs can refresh connection status. */
  readonly onDidChange = this._onDidChange.event;
  private configSub: vscode.Disposable;
  /** Servers contributed by plugins (`.mcp.json`), merged below the user's `localpilot.mcpServers`. */
  extraServers: () => Record<string, McpServerConfig> = () => ({});

  constructor(private readonly tools: ToolRegistry, private readonly log: vscode.LogOutputChannel, private readonly clientVersion = '0.0.0') {
    this.configSub = onConfigChange(() => void this.reload());
  }

  async reload(): Promise<void> {
    this.stopAll();
    this.errors.clear();
    const servers = { ...this.extraServers(), ...getConfig().mcpServers };
    await Promise.all(
      Object.entries(servers)
        .filter(([, c]) => c.enabled !== false && c.command)
        .map(async ([name, cfg]) => {
          const client = new McpClient(name, cfg, this.log, this.clientVersion);
          try {
            await client.start();
            this.clients.set(name, client);
            this.registrations.push(this.tools.registerAll(client.tools.map((t) => this.toTool(client, t))));
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            this.errors.set(name, msg);
            this.log.error(`MCP server "${name}" failed to start: ${msg}`);
            client.dispose();
          }
        })
    );
    this._onDidChange.fire();
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
      async execute(args) {
        const r = await client.callTool(t.name, args);
        return { content: r.text, isError: r.isError };
      },
    };
  }

  private stopAll(): void {
    this.registrations.forEach((r) => r.dispose());
    this.registrations = [];
    for (const [, c] of this.clients) {
      c.dispose();
    }
    this.clients.clear();
  }

  /** Connected servers with their tool counts, plus configured servers that failed to start and why. */
  get status(): { name: string; tools: number; error?: string }[] {
    return [
      ...[...this.clients.values()].map((c) => ({ name: c.name, tools: c.tools.length })),
      ...[...this.errors].map(([name, error]) => ({ name, tools: 0, error })),
    ];
  }

  dispose(): void {
    this.configSub.dispose();
    this._onDidChange.dispose();
    this.stopAll();
  }
}
