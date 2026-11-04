import { createHash } from 'crypto';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import type { McpServerConfig } from '../config';
import { parseJsonc } from '../agent/jsonc';

/**
 * MCP server files: `{ "mcpServers": { name: {...} } }` as written by Claude Code (`.mcp.json`), Cline
 * (`cline_mcp_settings.json`) and LocalPilot (`~/.localpilot/mcp.json`). Servers are merged, highest priority first:
 * the `localpilot.mcpServers` setting, `<workspace>/.mcp.json`, the user file, then plugin `.mcp.json` files.
 */

export type McpSource = 'settings' | 'project' | 'user' | 'plugin';

export interface McpLayer {
  source: McpSource;
  /** The file the servers came from (none for the setting). */
  file?: string;
  servers: Record<string, McpServerConfig>;
  /** Field errors, one line each (`"name": …`); the servers they name are left out. */
  problems: string[];
}

const TYPES = new Set(['stdio', 'http', 'sse', 'streamableHttp', 'streamable-http']);

function strings(v: unknown, field: string, problems: string[], map: (s: string) => string): Record<string, string> | undefined {
  if (v === undefined || v === null) {
    return undefined;
  }
  if (typeof v !== 'object' || Array.isArray(v)) {
    problems.push(`"${field}" must be an object of strings`);
    return undefined;
  }
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (typeof val === 'string' || typeof val === 'number' || typeof val === 'boolean') {
      out[k] = map(String(val));
    } else {
      problems.push(`"${field}.${k}" must be a string`);
    }
  }
  return Object.keys(out).length ? out : undefined;
}

/**
 * Validates and normalises a server map. Accepts `type`, its alias `transportType` or a nested `transport: { type, … }`,
 * `disabled` (or `enabled`), `timeout` in seconds and `autoApprove` (or Roo's `alwaysAllow`). `map` rewrites every
 * string (plugins substitute `${CLAUDE_PLUGIN_ROOT}`); a relative `cwd` resolves against `root`.
 */
export function normalizeMcpServers(raw: unknown, opts: { root?: string; defaultCwd?: string; map?: (v: string) => string } = {}): { servers: Record<string, McpServerConfig>; problems: string[] } {
  const servers: Record<string, McpServerConfig> = {};
  const problems: string[] = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { servers, problems: raw === undefined ? [] : ['expected an object: { "mcpServers": { "name": { … } } }'] };
  }
  const top = raw as { mcpServers?: unknown };
  const list = top.mcpServers ?? raw;
  if (!list || typeof list !== 'object' || Array.isArray(list)) {
    return { servers, problems: ['"mcpServers" must be an object of servers'] };
  }
  const map = opts.map ?? ((v: string) => v);
  for (const [name, entry] of Object.entries(list as Record<string, unknown>)) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      problems.push(`"${name}": expected an object`);
      continue;
    }
    const nested = (entry as { transport?: unknown }).transport;
    const c = { ...(nested && typeof nested === 'object' && !Array.isArray(nested) ? (nested as Record<string, unknown>) : {}), ...(entry as Record<string, unknown>) };
    const own: string[] = [];
    const str = (field: string): string | undefined => {
      const v = c[field];
      if (v === undefined || v === null || v === '') {
        return undefined;
      }
      if (typeof v !== 'string') {
        own.push(`"${field}" must be a string`);
        return undefined;
      }
      return v.trim() ? map(v.trim()) : undefined;
    };
    const typeRaw = c.type ?? c.transportType ?? (nested && typeof nested === 'object' ? (nested as { type?: unknown }).type : undefined);
    let type: McpServerConfig['type'];
    if (typeRaw !== undefined && typeRaw !== null && typeRaw !== '') {
      if (typeof typeRaw === 'string' && TYPES.has(typeRaw)) {
        type = typeRaw as McpServerConfig['type'];
      } else {
        own.push(`"type" must be one of stdio, sse, http, streamableHttp (got ${JSON.stringify(typeRaw)})`);
      }
    }
    const command = str('command');
    const url = str('url');
    if (url && !url.includes('${') && !/^https?:\/\/[^\s]+$/i.test(url)) {
      own.push(`"url" must be an http(s) URL (got ${JSON.stringify(url)})`);
    }
    let args: string[] | undefined;
    if (c.args !== undefined && c.args !== null) {
      if (Array.isArray(c.args) && c.args.every((a) => typeof a === 'string' || typeof a === 'number' || typeof a === 'boolean')) {
        args = c.args.map((a) => map(String(a)));
      } else {
        own.push('"args" must be an array of strings');
      }
    }
    const env = strings(c.env, 'env', own, map);
    const headers = strings(c.headers, 'headers', own, map);
    let cwd = str('cwd');
    if (cwd && opts.root && !path.isAbsolute(cwd) && !cwd.startsWith('${') && !cwd.startsWith('~')) {
      cwd = path.resolve(opts.root, cwd);
    }
    let enabled: boolean | undefined;
    for (const [field, invert] of [['disabled', true], ['enabled', false]] as const) {
      const v = c[field];
      if (v === undefined || v === null) {
        continue;
      }
      if (typeof v === 'boolean') {
        enabled = (enabled ?? true) && (invert ? !v : v);
      } else {
        own.push(`"${field}" must be true or false`);
      }
    }
    let timeout: number | undefined;
    if (c.timeout !== undefined && c.timeout !== null) {
      if (typeof c.timeout === 'number' && Number.isFinite(c.timeout) && c.timeout > 0) {
        timeout = c.timeout;
      } else {
        own.push('"timeout" must be a positive number of seconds');
      }
    }
    let autoApprove: string[] | undefined;
    const approveRaw = c.autoApprove ?? c.alwaysAllow;
    if (approveRaw !== undefined && approveRaw !== null) {
      if (Array.isArray(approveRaw) && approveRaw.every((a) => typeof a === 'string')) {
        autoApprove = approveRaw;
      } else {
        own.push('"autoApprove" must be an array of tool names');
      }
    }
    if (!own.length) {
      if (type === 'stdio' && !command) {
        own.push('"type": "stdio" needs a "command"');
      } else if (type && type !== 'stdio' && !url) {
        own.push(`"type": "${type}" needs a "url"`);
      } else if (!command && !url) {
        own.push('needs a "command" (a local server) or a "url" (a remote one)');
      }
    }
    if (own.length) {
      problems.push(...own.map((p) => `"${name}": ${p}`));
      continue;
    }
    const remote = type ? type !== 'stdio' : !!url;
    const cfg: McpServerConfig = remote ? { url, type, headers } : { command, args, env, cwd: cwd ?? opts.defaultCwd, type };
    if (enabled === false) {
      cfg.enabled = false;
    }
    if (timeout !== undefined) {
      cfg.timeout = timeout;
    }
    if (autoApprove) {
      cfg.autoApprove = autoApprove;
    }
    for (const k of Object.keys(cfg) as (keyof McpServerConfig)[]) {
      if (cfg[k] === undefined) {
        delete cfg[k];
      }
    }
    servers[name] = cfg;
  }
  return { servers, problems };
}

/** The user-level server file: `LOCALPILOT_MCP_SETTINGS_PATH`, else `~/.localpilot/mcp.json`. */
export function userMcpFile(): string {
  const env = process.env.LOCALPILOT_MCP_SETTINGS_PATH?.trim();
  return env ? path.resolve(env.replace(/^~(?=$|[\\/])/, os.homedir())) : path.join(os.homedir(), '.localpilot', 'mcp.json');
}

/** Reads one server file; a missing file is an empty layer, unreadable JSON a problem. */
export async function readMcpFile(file: string, source: McpSource): Promise<McpLayer> {
  let text: string;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch {
    return { source, file, servers: {}, problems: [] };
  }
  if (!text.trim()) {
    return { source, file, servers: {}, problems: [] };
  }
  let raw: unknown;
  try {
    raw = parseJsonc(text);
  } catch (e) {
    return { source, file, servers: {}, problems: [`not valid JSON: ${e instanceof Error ? e.message : String(e)}`] };
  }
  const { servers, problems } = normalizeMcpServers(raw, { root: path.dirname(file) });
  return { source, file, servers, problems };
}

/** The project files (`.mcp.json` in each workspace folder, the first folder wins a name) and the user file. */
export async function loadMcpFiles(folders: string[], userFile = userMcpFile()): Promise<McpLayer[]> {
  const project = await Promise.all(folders.map((f) => readMcpFile(path.join(f, '.mcp.json'), 'project')));
  return [...project, await readMcpFile(userFile, 'user')];
}

/** Merges layers given highest priority first: a name defined in an earlier layer hides the later definitions. */
export function mergeMcpLayers(layers: McpLayer[]): Record<string, McpServerConfig & { source: McpSource; file?: string }> {
  const out: Record<string, McpServerConfig & { source: McpSource; file?: string }> = {};
  for (const layer of layers) {
    for (const [name, cfg] of Object.entries(layer.servers)) {
      if (!(name in out)) {
        out[name] = { ...cfg, source: layer.source, file: layer.file };
      }
    }
  }
  return out;
}

/** The fields that decide how a server is started: a change to any of them restarts it, others (timeout, autoApprove) apply live. */
export function mcpFingerprint(cfg: McpServerConfig): string {
  const sorted = (o?: Record<string, string>) => (o ? Object.keys(o).sort().map((k) => [k, o[k]]) : null);
  return JSON.stringify([cfg.command ?? null, cfg.args ?? null, cfg.cwd ?? null, sorted(cfg.env), cfg.url ?? null, sorted(cfg.headers), cfg.type ?? null]);
}

/** A server's request timeout in seconds: its `timeout`, clamped to 1–3600, else 60. */
export function mcpTimeoutSeconds(timeout?: number): number {
  return typeof timeout === 'number' && Number.isFinite(timeout) && timeout > 0 ? Math.min(3600, Math.max(1, Math.round(timeout))) : 60;
}

/** The error for a request that ran out of time, naming where the server's timeout is set. */
export function mcpTimeoutMessage(server: string, seconds: number, file?: string): string {
  return `MCP request to "${server}" timed out after ${seconds}s. Raise "timeout" for this server in ${file ?? 'the localpilot.mcpServers setting'}.`;
}

/** The output-channel level for an MCP `notifications/message` level (RFC 5424 names). */
export function mcpLogLevel(level: unknown): 'debug' | 'info' | 'warn' | 'error' {
  switch (level) {
    case 'debug':
      return 'debug';
    case 'info':
    case 'notice':
      return 'info';
    case 'warning':
      return 'warn';
    case 'error':
    case 'critical':
    case 'alert':
    case 'emergency':
      return 'error';
    default:
      return 'info';
  }
}

/** A stable key for "this server, configured exactly so" (project trust is granted per key); a new autoApprove list asks again. */
export function mcpTrustKey(name: string, cfg: McpServerConfig): string {
  const approved = [...new Set(cfg.autoApprove ?? [])].sort();
  return `${name}:${createHash('sha1').update(JSON.stringify([mcpFingerprint(cfg), approved])).digest('hex').slice(0, 16)}`;
}

const REF = /\$\{(?:(env|secret):)?([A-Za-z_][A-Za-z0-9_.-]*)(?::-([^}]*))?\}/g;

/**
 * Expands `${env:NAME}`, `${secret:NAME}` and Claude-style `${NAME}` / `${NAME:-default}` in every connection field
 * (command, args, env values, cwd, url, headers). A reference that resolves to nothing and has no default stays as
 * written and is reported in `missing`.
 */
export function expandMcpServer(cfg: McpServerConfig, lookup: (kind: 'env' | 'secret', name: string) => string | undefined): { cfg: McpServerConfig; missing: string[] } {
  const missing = new Set<string>();
  const expand = (v: string) =>
    v.replace(REF, (whole, kind: 'env' | 'secret' | undefined, name: string, def?: string) => {
      if (!kind && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
        return whole;
      }
      const value = lookup(kind ?? 'env', name);
      if (value) {
        return value;
      }
      if (def !== undefined) {
        return def;
      }
      missing.add(kind === 'secret' ? `secret ${name}` : name);
      return whole;
    });
  const map = (o?: Record<string, string>) => (o ? Object.fromEntries(Object.entries(o).map(([k, v]) => [k, expand(String(v))])) : undefined);
  const out: McpServerConfig = {
    ...cfg,
    command: cfg.command && expand(cfg.command),
    args: cfg.args?.map((a) => expand(String(a))),
    env: map(cfg.env),
    cwd: cfg.cwd && expand(cfg.cwd),
    url: cfg.url && expand(cfg.url),
    headers: map(cfg.headers),
  };
  return { cfg: out, missing: [...missing] };
}

/** Writes JSON through a temporary file and a rename, so a crash never leaves a half-written file behind. */
export async function writeJsonAtomic(file: string, data: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now().toString(36)}.tmp`;
  try {
    await fs.writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
    await fs.rename(tmp, file);
  } catch (e) {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
    throw e;
  }
}

/** Writes a server file (`{ mcpServers }`), keeping any other top-level keys it already had. */
export async function writeMcpFile(file: string, servers: Record<string, McpServerConfig>): Promise<void> {
  let existing: Record<string, unknown> = {};
  try {
    const raw = parseJsonc(await fs.readFile(file, 'utf8'));
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      existing = raw as Record<string, unknown>;
    }
  } catch {
    /* new or unreadable: replaced */
  }
  await writeJsonAtomic(file, { ...existing, mcpServers: servers });
}
