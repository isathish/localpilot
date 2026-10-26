import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { McpServerConfig } from '../config';
import { emptySettings, normalizeSettings, parseJsonc, ProjectSettings } from './settings';

/**
 * Claude Code plugins: a folder with `.claude-plugin/plugin.json` bundling slash commands, subagents, skills, hooks
 * and MCP servers. Default layout (each part optional, paths overridable in the manifest):
 *
 *   plugin/
 *   ├── .claude-plugin/plugin.json   { name, description, version, commands?, agents?, skills?, hooks?, mcpServers? }
 *   ├── commands/*.md                → /plugin-name:command (and /command when unambiguous)
 *   ├── agents/*.md                  → subagents
 *   ├── skills/<name>/SKILL.md       → skills
 *   ├── hooks/hooks.json             → hooks ({ hooks: { PreToolUse: [...] } }); ${CLAUDE_PLUGIN_ROOT} = plugin folder
 *   └── .mcp.json                    → MCP servers ({ mcpServers: { name: { command, args, env } } })
 *
 * Discovered under <workspace>/.claude/plugins, <workspace>/.localpilot/plugins, ~/.claude/plugins,
 * ~/.localpilot/plugins (nested up to three levels, so marketplace checkouts work), plus the workspace itself when it
 * is a plugin. `enabledPlugins` in settings.json (`name` or `name@marketplace`: false) disables one.
 */

export interface PluginInfo {
  name: string;
  description: string;
  version?: string;
  root: string;
  source: 'workspace' | 'user';
  enabled: boolean;
  commandFiles: string[];
  agentDirs: string[];
  skillDirs: string[];
  /** Hooks contributed by the plugin, with `pluginRoot` set on every command. */
  hooks: ProjectSettings['hooks'];
  mcpServers: Record<string, McpServerConfig>;
}

export interface PluginManifest {
  name?: string;
  description?: string;
  version?: string;
  commands?: string | string[];
  agents?: string | string[];
  skills?: string | string[];
  hooks?: string | Record<string, unknown>;
  mcpServers?: string | Record<string, unknown>;
}

const MANIFEST = path.join('.claude-plugin', 'plugin.json');
const MARKETPLACE = path.join('.claude-plugin', 'marketplace.json');
const MAX_DEPTH = 3;

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function readJson(file: string): Promise<unknown> {
  try {
    return parseJsonc(await fs.readFile(file, 'utf8'));
  } catch {
    return undefined;
  }
}

/** Collect every `.md` under a folder (one level of subfolders, for namespaced commands). */
async function listMarkdown(dir: string, depth = 2): Promise<string[]> {
  const out: string[] = [];
  let entries: import('fs').Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isFile() && e.name.endsWith('.md')) {
      out.push(p);
    } else if (e.isDirectory() && depth > 1 && !e.name.startsWith('.')) {
      out.push(...(await listMarkdown(p, depth - 1)));
    }
  }
  return out;
}

// The path that follows the variable is normalised with it so `${CLAUDE_PLUGIN_ROOT}/x` yields native separators on Windows.
const substitute = (v: string, root: string) => v.replace(/(?:\$\{CLAUDE_PLUGIN_ROOT\}|\$CLAUDE_PLUGIN_ROOT)((?:[\\/][^\s"']*)?)/g, (_m, rest: string) => path.normalize(root + rest));

function normalizeMcp(raw: unknown, root: string): Record<string, McpServerConfig> {
  const out: Record<string, McpServerConfig> = {};
  if (!raw || typeof raw !== 'object') {
    return out;
  }
  const map = ((raw as { mcpServers?: unknown }).mcpServers ?? raw) as Record<string, unknown>;
  for (const [name, cfg] of Object.entries(map)) {
    if (!cfg || typeof cfg !== 'object') {
      continue;
    }
    const c = cfg as { command?: unknown; args?: unknown; env?: unknown; cwd?: unknown; type?: unknown; url?: unknown };
    if (typeof c.command !== 'string' || !c.command.trim()) {
      continue; // remote (url) servers are not supported by the stdio client
    }
    const env: Record<string, string> = {};
    if (c.env && typeof c.env === 'object') {
      for (const [k, v] of Object.entries(c.env as Record<string, unknown>)) {
        if (typeof v === 'string') {
          env[k] = substitute(v, root);
        }
      }
    }
    out[name] = {
      command: substitute(c.command, root),
      args: Array.isArray(c.args) ? c.args.filter((a): a is string => typeof a === 'string').map((a) => substitute(a, root)) : undefined,
      env: Object.keys(env).length ? env : undefined,
      cwd: typeof c.cwd === 'string' ? substitute(c.cwd, root) : root,
    };
  }
  return out;
}

/** Reads one plugin folder; undefined when it has no manifest. */
export async function readPlugin(root: string, source: PluginInfo['source'], enabledPlugins: Record<string, boolean> = {}): Promise<PluginInfo | undefined> {
  const manifestPath = path.join(root, MANIFEST);
  const manifest = (await readJson(manifestPath)) as PluginManifest | undefined;
  if (!manifest || typeof manifest !== 'object') {
    return undefined;
  }
  const name = (typeof manifest.name === 'string' && manifest.name.trim()) || path.basename(root);
  const resolve = (p: string) => (path.isAbsolute(p) ? p : path.resolve(root, p));
  const dirs = async (v: string | string[] | undefined, def: string): Promise<string[]> => {
    const list = v === undefined ? [def] : Array.isArray(v) ? v : [v];
    const out: string[] = [];
    for (const p of list) {
      const abs = resolve(p);
      if (await exists(abs)) {
        out.push(abs);
      }
    }
    return out;
  };
  const commandFiles: string[] = [];
  for (const p of await dirs(manifest.commands, 'commands')) {
    const st = await fs.stat(p).catch(() => undefined);
    if (st?.isFile()) {
      commandFiles.push(p);
    } else if (st?.isDirectory()) {
      commandFiles.push(...(await listMarkdown(p)));
    }
  }
  let hooksRaw: unknown = manifest.hooks;
  if (typeof hooksRaw === 'string') {
    hooksRaw = await readJson(resolve(hooksRaw));
  } else if (hooksRaw === undefined) {
    hooksRaw = await readJson(path.join(root, 'hooks', 'hooks.json'));
  }
  const hooksObj = hooksRaw && typeof hooksRaw === 'object' ? ((hooksRaw as { hooks?: unknown }).hooks ?? hooksRaw) : undefined;
  const hooks = hooksObj ? normalizeSettings({ hooks: hooksObj }, manifestPath, root).hooks : {};
  let mcpRaw: unknown = manifest.mcpServers;
  if (typeof mcpRaw === 'string') {
    mcpRaw = await readJson(resolve(mcpRaw));
  } else if (mcpRaw === undefined) {
    mcpRaw = await readJson(path.join(root, '.mcp.json'));
  }
  const disabled = Object.entries(enabledPlugins).some(([k, v]) => v === false && (k === name || k.startsWith(`${name}@`)));
  return {
    name,
    description: typeof manifest.description === 'string' ? manifest.description : '',
    version: typeof manifest.version === 'string' ? manifest.version : undefined,
    root,
    source,
    enabled: !disabled,
    commandFiles,
    agentDirs: await dirs(manifest.agents, 'agents'),
    skillDirs: await dirs(manifest.skills, 'skills'),
    hooks,
    mcpServers: normalizeMcp(mcpRaw, root),
  };
}

/** Finds plugin folders below `dir`: manifests, marketplace listings, and nested checkouts up to MAX_DEPTH. */
export async function findPluginRoots(dir: string, depth = MAX_DEPTH, seen = new Set<string>()): Promise<string[]> {
  const out: string[] = [];
  if (depth < 0 || seen.has(dir)) {
    return out;
  }
  seen.add(dir);
  if (await exists(path.join(dir, MANIFEST))) {
    out.push(dir);
    return out;
  }
  const market = (await readJson(path.join(dir, MARKETPLACE))) as { plugins?: { source?: unknown }[] } | undefined;
  if (market?.plugins && Array.isArray(market.plugins)) {
    for (const p of market.plugins) {
      if (typeof p?.source === 'string' && !/^https?:|^git@|^github:/.test(p.source)) {
        out.push(...(await findPluginRoots(path.resolve(dir, p.source), depth - 1, seen)));
      }
    }
    if (out.length) {
      return out;
    }
  }
  if (depth === 0) {
    return out;
  }
  let entries: import('fs').Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.isDirectory() && e.name !== 'node_modules' && !e.name.startsWith('.')) {
      out.push(...(await findPluginRoots(path.join(dir, e.name), depth - 1, seen)));
    }
  }
  return out;
}

export async function discoverPlugins(roots: string[], opts: { home?: string; extraDirs?: string[]; enabledPlugins?: Record<string, boolean> } = {}): Promise<PluginInfo[]> {
  const home = opts.home ?? os.homedir();
  const scan: { dir: string; source: PluginInfo['source']; self?: boolean }[] = [];
  for (const r of roots) {
    scan.push({ dir: r, source: 'workspace', self: true });
    scan.push({ dir: path.join(r, '.claude', 'plugins'), source: 'workspace' });
    scan.push({ dir: path.join(r, '.localpilot', 'plugins'), source: 'workspace' });
  }
  scan.push({ dir: path.join(home, '.claude', 'plugins'), source: 'user' });
  scan.push({ dir: path.join(home, '.localpilot', 'plugins'), source: 'user' });
  for (const d of opts.extraDirs ?? []) {
    scan.push({ dir: d.replace(/^~/, home), source: 'user' });
  }
  const seen = new Set<string>();
  const out: PluginInfo[] = [];
  for (const s of scan) {
    const pluginRoots = s.self ? ((await exists(path.join(s.dir, MANIFEST))) ? [s.dir] : []) : await findPluginRoots(s.dir);
    for (const pr of pluginRoots) {
      if (seen.has(pr)) {
        continue;
      }
      seen.add(pr);
      const info = await readPlugin(pr, s.source, opts.enabledPlugins);
      if (info && !out.some((p) => p.name === info.name)) {
        out.push(info);
      }
    }
  }
  return out;
}

/** What the skill, command, hook and MCP managers read from plugins (implemented by PluginManager and by `pluginSource`). */
export interface PluginSource {
  skillDirs(): { dir: string; source: PluginInfo['source'] }[];
  agentDirs(): { dir: string; source: PluginInfo['source'] }[];
  commandFiles(): { file: string; plugin: PluginInfo }[];
  mcpServers(): Record<string, McpServerConfig>;
  settingsLayers(): ProjectSettings[];
}

/** A static view over a plugin list (the CLI discovers once; the extension uses PluginManager). */
export function pluginSource(list: PluginInfo[]): PluginSource {
  const enabled = () => list.filter((p) => p.enabled);
  return {
    skillDirs: () => enabled().flatMap((p) => p.skillDirs.map((dir) => ({ dir, source: p.source }))),
    agentDirs: () => enabled().flatMap((p) => p.agentDirs.map((dir) => ({ dir, source: p.source }))),
    commandFiles: () => enabled().flatMap((p) => p.commandFiles.map((file) => ({ file, plugin: p }))),
    mcpServers: () => {
      const out: Record<string, McpServerConfig> = {};
      for (const p of enabled()) {
        for (const [name, cfg] of Object.entries(p.mcpServers)) {
          out[`${p.name}:${name}`] = cfg;
        }
      }
      return out;
    },
    // Hooks of enabled plugins as a settings layer (below every settings file, so a project can deny what a plugin allows).
    settingsLayers: () =>
      enabled()
        .filter((p) => Object.keys(p.hooks).length)
        .map((p) => ({ ...emptySettings(), hooks: p.hooks, sources: [path.join(p.root, MANIFEST)] })),
  };
}

/** Discovers plugins and exposes their parts to the skill, command, hook and MCP managers. */
export class PluginManager implements vscode.Disposable, PluginSource {
  private list: PluginInfo[] = [];
  private readonly _onDidChange = new vscode.EventEmitter<PluginInfo[]>();
  readonly onDidChange = this._onDidChange.event;
  private readonly watcher: vscode.FileSystemWatcher;
  /** Extra folders to scan (`localpilot.pluginPaths`). */
  extraDirs: () => string[] = () => [];
  /** `enabledPlugins` from the merged settings. */
  enabledPlugins: () => Record<string, boolean> = () => ({});

  constructor(private readonly log: vscode.LogOutputChannel, private readonly homeDir = os.homedir()) {
    this.watcher = vscode.workspace.createFileSystemWatcher('**/{.claude,.localpilot}/plugins/**/.claude-plugin/*.json');
    const reload = () => void this.refresh();
    this.watcher.onDidChange(reload);
    this.watcher.onDidCreate(reload);
    this.watcher.onDidDelete(reload);
  }

  get all(): PluginInfo[] {
    return this.list;
  }
  get enabled(): PluginInfo[] {
    return this.list.filter((p) => p.enabled);
  }

  async refresh(): Promise<PluginInfo[]> {
    const roots = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
    let next: PluginInfo[];
    try {
      next = await discoverPlugins(roots, { home: this.homeDir, extraDirs: this.extraDirs(), enabledPlugins: this.enabledPlugins() });
    } catch (e) {
      this.log.warn(`plugins: discovery failed: ${String(e)}`);
      next = [];
    }
    const changed = JSON.stringify(next) !== JSON.stringify(this.list);
    this.list = next;
    if (changed) {
      if (this.list.length) {
        this.log.info(`Plugins: ${this.list.map((p) => `${p.name}${p.enabled ? '' : ' (disabled)'}`).join(', ')}`);
      }
      this._onDidChange.fire(this.list);
    }
    return this.list;
  }

  /** Hooks of enabled plugins as a settings layer (below every settings file). */
  settingsLayers(): ProjectSettings[] {
    return pluginSource(this.list).settingsLayers();
  }

  mcpServers(): Record<string, McpServerConfig> {
    return pluginSource(this.list).mcpServers();
  }

  skillDirs(): { dir: string; source: PluginInfo['source'] }[] {
    return pluginSource(this.list).skillDirs();
  }

  agentDirs(): { dir: string; source: PluginInfo['source'] }[] {
    return pluginSource(this.list).agentDirs();
  }

  commandFiles(): { file: string; plugin: PluginInfo }[] {
    return pluginSource(this.list).commandFiles();
  }

  dispose(): void {
    this.watcher.dispose();
    this._onDidChange.dispose();
  }
}
