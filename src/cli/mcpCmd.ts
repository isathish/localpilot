import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import type { McpServerConfig } from '../config';
import { parseJsonc } from '../agent/jsonc';
import { splitArgs } from '../agent/commands';
import { loadMcpFiles, McpLayer, McpSource, mcpTrustKey, mergeMcpLayers, normalizeMcpServers, setMcpFileServerEnabled, userMcpFile, writeJsonAtomic } from '../mcp/config';
import type { Style } from './providers';

/**
 * `localpilot mcp …`: list the servers in force, add or remove one in `~/.localpilot/mcp.json` (or `./.mcp.json` with
 * `--scope project`), switch one on or off where it is defined, and sign in to a remote one.
 */

export type McpAction = 'list' | 'add' | 'remove' | 'enable' | 'disable' | 'auth' | 'menu';
export type McpScope = 'user' | 'project';

export interface McpCliArgs {
  action: McpAction;
  name?: string;
  /** `add`: the URL, or the command and its arguments. */
  target: string[];
  transport?: 'stdio' | 'http' | 'sse';
  headers: Record<string, string>;
  env: Record<string, string>;
  scope?: McpScope;
  json: boolean;
  /** `add` over an existing server of the same name. */
  force: boolean;
  cwd?: string;
  error?: string;
}

const ACTIONS: Record<string, McpAction> = { list: 'list', ls: 'list', add: 'add', remove: 'remove', rm: 'remove', enable: 'enable', on: 'enable', disable: 'disable', off: 'disable', auth: 'auth', login: 'auth' };
const TRANSPORTS: Record<string, 'stdio' | 'http' | 'sse'> = { stdio: 'stdio', http: 'http', 'streamable-http': 'http', streamablehttp: 'http', sse: 'sse' };
const NAME = /^[A-Za-z0-9][\w.-]{0,63}$/;

export const MCP_USAGE = `Usage:
  localpilot mcp [list] [--json]
  localpilot mcp add <name> [--transport stdio|http|sse] [--header "K: V"]… [--env K=V]… [--scope user|project] -- <command> [args…]
  localpilot mcp add <name> <url> [--transport http|sse] [--header "K: V"]… [--scope user|project]
  localpilot mcp remove <name> [--scope user|project]
  localpilot mcp enable|disable <name>
  localpilot mcp auth <name>`;

/** Parses the words after `mcp`. Everything after `--` is the server's command line, flags included. */
export function parseMcpArgs(argv: string[]): McpCliArgs {
  const a: McpCliArgs = { action: 'list', target: [], headers: {}, env: {}, json: false, force: false };
  const words: string[] = [];
  let sawAction = false;
  const fail = (m: string) => (a.error = a.error ?? m);
  for (let i = 0; i < argv.length; i++) {
    let x = argv[i];
    let inline: string | undefined;
    if (/^--[\w-]+=/.test(x)) {
      inline = x.slice(x.indexOf('=') + 1);
      x = x.slice(0, x.indexOf('='));
    }
    const next = () => inline ?? argv[++i] ?? '';
    if (x === '--') {
      a.target.push(...argv.slice(i + 1));
      break;
    }
    if (x === '-t' || x === '--transport' || x === '--type') {
      const v = next();
      const t = TRANSPORTS[v.toLowerCase()];
      if (t) {
        a.transport = t;
      } else {
        fail(`--transport takes stdio, http or sse (got "${v}")`);
      }
    } else if (x === '-H' || x === '--header') {
      const v = next();
      const m = /^\s*([^:\s][^:]*?)\s*:\s*(.*)$/.exec(v);
      if (m) {
        a.headers[m[1]] = m[2].trim();
      } else {
        fail(`--header takes "Name: value" (got "${v}")`);
      }
    } else if (x === '-e' || x === '--env') {
      const v = next();
      const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s.exec(v);
      if (m) {
        a.env[m[1]] = m[2];
      } else {
        fail(`--env takes NAME=value (got "${v}")`);
      }
    } else if (x === '-s' || x === '--scope') {
      const v = next();
      if (v === 'user' || v === 'project') {
        a.scope = v;
      } else {
        fail(`--scope takes user or project (got "${v}")`);
      }
    } else if (x === '--project') {
      a.scope = 'project';
    } else if (x === '--user' || x === '-u') {
      a.scope = 'user';
    } else if (x === '--json') {
      a.json = true;
    } else if (x === '--force' || x === '-f') {
      a.force = true;
    } else if (x === '-C' || x === '--cwd') {
      a.cwd = next();
    } else if (x.startsWith('-') && x.length > 1) {
      fail(`unknown option ${x} (a server's own flags go after --)`);
    } else if (!sawAction) {
      sawAction = true;
      const act = ACTIONS[x.toLowerCase()];
      if (act) {
        a.action = act;
      } else {
        fail(`unknown action "${x}": use list, add, remove, enable, disable or auth`);
      }
    } else {
      words.push(x);
    }
  }
  if (!sawAction && !a.json && !a.error && !argv.length) {
    a.action = 'menu';
  }
  a.name = words.shift();
  if (a.action === 'add') {
    a.target = [...words, ...a.target];
  } else if (words.length || a.target.length) {
    fail(`unexpected argument${words.length + a.target.length > 1 ? 's' : ''}: ${[...words, ...a.target].join(' ')}`);
  }
  if (['add', 'remove', 'enable', 'disable', 'auth'].includes(a.action) && !a.error) {
    if (!a.name) {
      fail(`mcp ${a.action} needs a server name`);
    } else if (!NAME.test(a.name)) {
      fail(`"${a.name}" is not a valid server name (letters, digits, "_", "-" and ".", up to 64)`);
    }
  }
  return a;
}

/** The file entry `mcp add` writes, in the `.mcp.json` shape Claude Code also reads. */
export function buildMcpEntry(a: Pick<McpCliArgs, 'target' | 'transport' | 'headers' | 'env'>): { entry?: Record<string, unknown>; error?: string } {
  if (!a.target.length) {
    return { error: 'mcp add needs a URL, or -- followed by the command that starts the server' };
  }
  const headers = Object.keys(a.headers).length ? a.headers : undefined;
  const env = Object.keys(a.env).length ? a.env : undefined;
  const isUrl = a.target.length === 1 && /^https?:\/\//i.test(a.target[0]);
  let entry: Record<string, unknown>;
  if (isUrl) {
    if (a.transport === 'stdio') {
      return { error: '--transport stdio needs a command, not a URL' };
    }
    if (env) {
      return { error: '--env is for local (stdio) servers; a remote one takes --header' };
    }
    entry = { type: a.transport, url: a.target[0], headers };
  } else {
    if (a.transport && a.transport !== 'stdio') {
      return { error: `--transport ${a.transport} needs a URL (http:// or https://)` };
    }
    if (headers) {
      return { error: '--header is for remote servers; a local one takes --env' };
    }
    const [command, ...args] = a.target;
    entry = { type: a.transport, command, args: args.length ? args : undefined, env };
  }
  for (const k of Object.keys(entry)) {
    if (entry[k] === undefined) {
      delete entry[k];
    }
  }
  const check = normalizeMcpServers({ mcpServers: { server: entry } });
  return check.problems.length ? { error: check.problems.join('; ').replace(/^"server": /, '') } : { entry };
}

/** The transport a configuration uses, as `list` shows it. */
export function mcpTransportLabel(cfg: McpServerConfig): string {
  if (cfg.type) {
    return cfg.type === 'streamableHttp' || cfg.type === 'streamable-http' ? 'http' : cfg.type;
  }
  return cfg.url ? (/\/sse\/?$/i.test(cfg.url) ? 'sse' : 'http') : 'stdio';
}

/** A server file's raw contents: its server map as written (unknown fields kept) and whether it nests them under `mcpServers`. */
async function readRaw(file: string): Promise<{ raw: Record<string, unknown>; servers: Record<string, unknown>; nested: boolean; text: string }> {
  let text = '';
  try {
    text = await fs.readFile(file, 'utf8');
  } catch {
    return { raw: {}, servers: {}, nested: true, text };
  }
  const raw = text.trim() ? parseJsonc(text) : {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`${file} is not a server file ({ "mcpServers": { … } })`);
  }
  const obj = raw as Record<string, unknown>;
  const nested = obj.mcpServers !== undefined || !Object.keys(obj).length;
  const servers = nested ? obj.mcpServers ?? {} : obj;
  if (!servers || typeof servers !== 'object' || Array.isArray(servers)) {
    throw new Error(`${file}: "mcpServers" must be an object of servers`);
  }
  return { raw: obj, servers: servers as Record<string, unknown>, nested, text };
}

function hasComments(text: string): boolean {
  return /\/[/*]/.test(text.replace(/"(?:[^"\\]|\\.)*"/g, '""'));
}

async function rewrite(file: string, r: Awaited<ReturnType<typeof readRaw>>, servers: Record<string, unknown>, what: string): Promise<void> {
  if (hasComments(r.text)) {
    throw new Error(`${file} has comments that rewriting it would lose: ${what} by hand`);
  }
  await writeJsonAtomic(file, r.nested ? { ...r.raw, mcpServers: servers } : servers);
}

/** Adds (or with `force` replaces) one server in a server file, written through a temporary file and a rename. */
export async function addMcpServerToFile(file: string, name: string, entry: Record<string, unknown>, force = false): Promise<'added' | 'replaced'> {
  const r = await readRaw(file);
  const had = name in r.servers;
  if (had && !force) {
    throw new Error(`"${name}" is already defined in ${file} (pass --force to replace it, or remove it first)`);
  }
  await rewrite(file, r, { ...r.servers, [name]: entry }, `add "${name}"`);
  return had ? 'replaced' : 'added';
}

/** Removes one server from a server file; false when the file does not define it. */
export async function removeMcpServerFromFile(file: string, name: string): Promise<boolean> {
  const r = await readRaw(file);
  if (!(name in r.servers)) {
    return false;
  }
  const next = { ...r.servers };
  delete next[name];
  await rewrite(file, r, next, `remove "${name}"`);
  return true;
}

export interface McpCmdOptions {
  cwd: string;
  st: Style;
  out?: (s: string) => void;
  err?: (s: string) => void;
  /** Servers from enabled plugins (shown by `list`, never written). */
  pluginServers?: Record<string, McpServerConfig>;
  /** Whether a project server was already trusted in this folder. */
  isTrusted?: (key: string) => boolean;
  /** Reads one line from the terminal (the interactive menu); undefined when there is none. */
  ask?: (question: string) => Promise<string | undefined>;
  /** Connects to one remote server so it can sign in (OAuth) and resolves a one-line summary. */
  authenticate?: (name: string, cfg: McpServerConfig) => Promise<string>;
  /** The user server file (tests). */
  userFile?: string;
}

type Entry = McpServerConfig & { source: McpSource; file?: string };

async function layers(o: McpCmdOptions): Promise<McpLayer[]> {
  const settings = normalizeMcpServers({ mcpServers: vscode.workspace.getConfiguration('localpilot').get<Record<string, McpServerConfig>>('mcpServers', {}) ?? {} });
  const files = await loadMcpFiles([o.cwd], o.userFile ?? userMcpFile());
  return [{ source: 'settings', servers: settings.servers, problems: settings.problems }, ...files, { source: 'plugin', servers: o.pluginServers ?? {}, problems: [] }];
}

function scopeFile(scope: McpScope, o: McpCmdOptions): string {
  return scope === 'project' ? path.join(o.cwd, '.mcp.json') : o.userFile ?? userMcpFile();
}

function where(e: Entry): string {
  return e.source === 'settings' ? 'the localpilot.mcpServers setting' : e.source === 'plugin' ? 'a plugin' : e.file ?? e.source;
}

/** One row per server in force (the first definition of a name wins), with the definitions it hides. */
export function mcpListRows(all: McpLayer[], isTrusted?: (key: string) => boolean): { name: string; source: McpSource; file?: string; transport: string; target: string; enabled: boolean; trusted?: boolean; shadows: string[]; envKeys: string[]; headerKeys: string[] }[] {
  const merged = mergeMcpLayers(all);
  return Object.entries(merged).map(([name, e]) => ({
    name,
    source: e.source,
    file: e.file,
    transport: mcpTransportLabel(e),
    target: e.url ?? [e.command, ...(e.args ?? [])].filter(Boolean).join(' '),
    enabled: e.enabled !== false,
    trusted: e.source === 'project' && isTrusted ? isTrusted(mcpTrustKey(name, e)) : undefined,
    shadows: all.filter((l) => l.servers[name] && !(l.source === e.source && l.file === e.file)).map((l) => l.file ?? l.source),
    envKeys: Object.keys(e.env ?? {}),
    headerKeys: Object.keys(e.headers ?? {}),
  }));
}

async function list(o: McpCmdOptions, json: boolean): Promise<number> {
  const out = o.out ?? console.log;
  const { st } = o;
  const all = await layers(o);
  const rows = mcpListRows(all, o.isTrusted);
  const problems = all.filter((l) => l.problems.length);
  if (json) {
    out(JSON.stringify({ servers: rows, problems: problems.map((l) => ({ file: l.file ?? l.source, problems: l.problems })) }, null, 2));
    return problems.length ? 1 : 0;
  }
  if (!rows.length) {
    out(st.dim(`No MCP servers configured. Add one: localpilot mcp add <name> -- <command> [args…]  or  localpilot mcp add <name> <url>`));
  }
  for (const r of rows) {
    const state = !r.enabled ? st.dim('disabled') : r.trusted === false ? st.yellow('asks before starting') : st.green('enabled');
    out(`${r.enabled ? st.green('●') : st.dim('○')} ${st.bold(r.name)} ${st.dim(r.transport)}  ${r.target}`);
    out(`  ${state} · ${st.dim(r.source === 'settings' ? 'localpilot.mcpServers setting' : r.source === 'plugin' ? 'plugin' : r.file ?? r.source)}${r.envKeys.length ? st.dim(` · env ${r.envKeys.join(', ')}`) : ''}${r.headerKeys.length ? st.dim(` · headers ${r.headerKeys.join(', ')}`) : ''}${r.shadows.length ? st.dim(` · overrides ${r.shadows.join(', ')}`) : ''}`);
  }
  for (const l of problems) {
    out(`${st.red('✖')} invalid MCP configuration in ${l.file ?? l.source}:\n${l.problems.map((p) => `  ${p}`).join('\n')}`);
  }
  return problems.length ? 1 : 0;
}

async function add(a: McpCliArgs, o: McpCmdOptions): Promise<number> {
  const out = o.out ?? console.log;
  const { entry, error } = buildMcpEntry(a);
  if (error || !entry) {
    (o.err ?? console.error)(`${o.st.red('✖')} ${error}\n${MCP_USAGE}`);
    return 2;
  }
  const scope = a.scope ?? 'user';
  const file = scopeFile(scope, o);
  const done = await addMcpServerToFile(file, a.name!, entry, a.force);
  out(`${o.st.green('✓')} ${done === 'replaced' ? 'Replaced' : 'Added'} "${a.name}" in ${file}`);
  const merged = mergeMcpLayers(await layers(o))[a.name!];
  if (merged && merged.file !== file) {
    out(o.st.yellow(`! ${where(merged)} also defines "${a.name}" and takes priority over this one`));
  }
  out(o.st.dim(scope === 'project' ? 'It starts in new sessions in this folder after you confirm the workspace\'s servers (or with --trust-workspace).' : 'It starts in new sessions; in a running one use /mcp restart.'));
  return 0;
}

async function remove(a: McpCliArgs, o: McpCmdOptions): Promise<number> {
  const out = o.out ?? console.log;
  const files = a.scope ? [scopeFile(a.scope, o)] : [path.join(o.cwd, '.mcp.json'), o.userFile ?? userMcpFile()];
  const removed: string[] = [];
  for (const f of files) {
    if (await removeMcpServerFromFile(f, a.name!)) {
      removed.push(f);
    }
  }
  if (!removed.length) {
    const e = mergeMcpLayers(await layers(o))[a.name!];
    (o.err ?? console.error)(`${o.st.red('✖')} ${e ? `"${a.name}" is defined in ${where(e)}${e.source === 'settings' ? ': remove it from your settings' : e.source === 'plugin' ? ': switch the plugin off with localpilot plugin disable' : ''}` : `No MCP server named "${a.name}"${a.scope ? ` in ${files[0]}` : ''}`}`);
    return 1;
  }
  for (const f of removed) {
    out(`${o.st.green('✓')} Removed "${a.name}" from ${f}`);
  }
  return 0;
}

async function toggle(a: McpCliArgs, o: McpCmdOptions, enabled: boolean): Promise<number> {
  const e = mergeMcpLayers(await layers(o))[a.name!];
  if (!e) {
    (o.err ?? console.error)(`${o.st.red('✖')} No MCP server named "${a.name}"`);
    return 1;
  }
  if (e.source === 'plugin') {
    (o.err ?? console.error)(`${o.st.red('✖')} "${a.name}" comes from a plugin: switch the plugin off instead (localpilot plugin disable)`);
    return 1;
  }
  if (e.source === 'settings') {
    // The CLI writes ~/.localpilot/config.json, whose value is merged over VS Code's settings.
    const cfg = vscode.workspace.getConfiguration('localpilot');
    const map = { ...(cfg.get<Record<string, McpServerConfig>>('mcpServers', {}) ?? {}) };
    const next: McpServerConfig = { ...(map[a.name!] ?? {}) };
    if (enabled) {
      delete next.enabled;
    } else {
      next.enabled = false;
    }
    map[a.name!] = next;
    await cfg.update('mcpServers', map, vscode.ConfigurationTarget.Global);
  } else if (e.file) {
    await setMcpFileServerEnabled(e.file, a.name!, enabled);
  }
  (o.out ?? console.log)(`${o.st.green('✓')} ${enabled ? 'Enabled' : 'Disabled'} "${a.name}" in ${where(e)}`);
  return 0;
}

async function auth(a: McpCliArgs, o: McpCmdOptions): Promise<number> {
  const e = mergeMcpLayers(await layers(o))[a.name!];
  if (!e) {
    (o.err ?? console.error)(`${o.st.red('✖')} No MCP server named "${a.name}"`);
    return 1;
  }
  if (!e.url) {
    (o.err ?? console.error)(`${o.st.red('✖')} "${a.name}" is a local (stdio) server: only remote servers sign in`);
    return 1;
  }
  if (!o.authenticate) {
    (o.err ?? console.error)(`${o.st.red('✖')} Signing in is not available here`);
    return 1;
  }
  const summary = await o.authenticate(a.name!, e);
  (o.out ?? console.log)(`${o.st.green('✓')} ${summary}`);
  return 0;
}

/** The menu `localpilot mcp` shows in a terminal: the list, then one action at a time until Enter on an empty line. */
async function menu(o: McpCmdOptions): Promise<number> {
  const ask = o.ask!;
  const out = o.out ?? console.log;
  const { st } = o;
  for (;;) {
    await list(o, false);
    out(`\n${st.yellow('?')} ${st.bold('What next?')}\n  ${st.amber('1')}. Add a server\n  ${st.amber('2')}. Remove a server\n  ${st.amber('3')}. Enable a server\n  ${st.amber('4')}. Disable a server\n  ${st.amber('5')}. Sign in to a remote server\n  ${st.dim('a number · Enter = done')}`);
    const pick = (await ask('  > '))?.trim();
    if (!pick || /^q(uit)?$/i.test(pick)) {
      return 0;
    }
    const action = (['add', 'remove', 'enable', 'disable', 'auth'] as const)[Number(pick) - 1];
    if (!action) {
      out(st.red(`Pick 1–5 (got "${pick}")`));
      continue;
    }
    const name = (await ask(`  ${st.bold('Server name')}: `))?.trim();
    if (!name) {
      continue;
    }
    const a: McpCliArgs = { action, name, target: [], headers: {}, env: {}, json: false, force: false };
    if (action === 'add') {
      const line = (await ask(`  ${st.bold('Command line or URL')}: `))?.trim();
      if (!line) {
        continue;
      }
      a.target = /^https?:\/\//i.test(line) ? [line] : splitArgs(line);
      if (a.target.length === 1 && /^https?:\/\//i.test(line)) {
        const t = (await ask(`  ${st.bold('Transport')} ${st.dim('[auto] http sse')}: `))?.trim().toLowerCase();
        a.transport = t ? TRANSPORTS[t] : undefined;
        for (;;) {
          const h = (await ask(`  ${st.bold('Header')} ${st.dim('"Name: value", Enter = none/done')}: `))?.trim();
          const m = h && /^([^:\s][^:]*?)\s*:\s*(.*)$/.exec(h);
          if (!m) {
            break;
          }
          a.headers[m[1]] = m[2].trim();
        }
      } else {
        for (;;) {
          const v = (await ask(`  ${st.bold('Environment variable')} ${st.dim('NAME=value, Enter = none/done')}: `))?.trim();
          const m = v && /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s.exec(v);
          if (!m) {
            break;
          }
          a.env[m[1]] = m[2];
        }
      }
      const scope = (await ask(`  ${st.bold('Save in')} ${st.dim(`[user] ${o.userFile ?? userMcpFile()} · project ./.mcp.json`)}: `))?.trim().toLowerCase();
      a.scope = scope?.startsWith('p') ? 'project' : 'user';
    }
    if (!NAME.test(name)) {
      out(st.red(`"${name}" is not a valid server name`));
      continue;
    }
    await runMcpAction(a, o).catch((e) => (o.err ?? console.error)(`${st.red('✖')} ${e instanceof Error ? e.message : String(e)}`));
    out('');
  }
}

function runMcpAction(a: McpCliArgs, o: McpCmdOptions): Promise<number> {
  switch (a.action) {
    case 'add':
      return add(a, o);
    case 'remove':
      return remove(a, o);
    case 'enable':
    case 'disable':
      return toggle(a, o, a.action === 'enable');
    case 'auth':
      return auth(a, o);
    default:
      return list(o, a.json);
  }
}

/** `localpilot mcp …`; resolves the exit code (2 for a usage error). */
export async function cmdMcp(a: McpCliArgs, o: McpCmdOptions): Promise<number> {
  if (a.error) {
    (o.err ?? console.error)(`${o.st.red('✖')} ${a.error}\n${MCP_USAGE}`);
    return 2;
  }
  if (a.action === 'menu') {
    return o.ask && process.stdin.isTTY && process.stdout.isTTY ? menu(o) : list(o, false);
  }
  return runMcpAction(a, o);
}
