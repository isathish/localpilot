import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runCmd } from '../tools/git';
import { getManagedPolicy, isManaged } from './managedPolicy';
import { PluginInfo, readPlugin } from './plugins';
import { parseJsonc } from './settings';
import { parseFrontMatter } from './frontMatter';

/**
 * Finding and installing plugins from marketplaces in Claude Code's format: a git repository with
 * `.claude-plugin/marketplace.json` listing plugins and where each lives (a folder of the marketplace, another
 * repository, or a folder of another repository, optionally pinned to a ref or commit). Marketplaces are cloned with
 * `git` (so private repositories work with the user's git credentials) into a cache that is not scanned for plugins;
 * an installed plugin is a plain copy under `~/.localpilot/plugins/<name>` (or the workspace's `.localpilot/plugins`).
 */

export type PluginSourceSpec =
  | string
  | { source: 'github'; repo: string; ref?: string; sha?: string }
  | { source: 'url'; url: string; ref?: string; sha?: string }
  | { source: 'git-subdir'; url: string; path: string; ref?: string; sha?: string };

export interface MarketplaceEntry {
  name: string;
  description?: string;
  version?: string;
  category?: string;
  keywords?: string[];
  homepage?: string;
  source: PluginSourceSpec;
  /** false: the folder need not have its own plugin.json; this entry describes the plugin. */
  strict?: boolean;
  author?: { name?: string };
}

export interface Marketplace {
  /** As configured: `owner/repo`, a git URL or a local folder. */
  spec: string;
  name: string;
  dir: string;
  plugins: MarketplaceEntry[];
}

export const marketplaceCache = () => path.join(os.homedir(), '.localpilot', 'plugin-marketplaces');
export const pluginsDir = (scope: 'user' | 'project', root?: string) => (scope === 'project' && root ? path.join(root, '.localpilot', 'plugins') : path.join(os.homedir(), '.localpilot', 'plugins'));

/** `owner/repo` → its GitHub clone URL; URLs and `git@` addresses as they are; anything else is a local folder. */
export function gitUrl(spec: string): string | undefined {
  const s = spec.trim();
  if (/^[\w.-]+\/[\w.-]+$/.test(s)) {
    return `https://github.com/${s.replace(/\.git$/, '')}.git`;
  }
  return /^(https?:\/\/|git@|ssh:\/\/)/.test(s) ? s : undefined;
}

const cacheKey = (url: string) => url.replace(/^\w+:\/\/|^git@/, '').replace(/\.git$/, '').replace(/[^\w.-]+/g, '-').slice(0, 80);

function downloadsAllowed(): void {
  const p = getManagedPolicy();
  if (isManaged(p) && !p.allowSkillInstall) {
    throw new Error(`Downloading plugins is turned off by your organization's policy${p.message ? ` (${p.message})` : ''}.`);
  }
}

async function git(args: string[], cwd: string | undefined, signal?: AbortSignal): Promise<void> {
  const r = await runCmd('git', args, cwd, signal, 180_000);
  if (r.code !== 0) {
    throw new Error(`git ${args[0]} failed: ${(r.err || r.out).trim().split('\n').slice(-2).join(' ')}`);
  }
}

/** A shallow checkout of `url` at `ref`/`sha` into `dir` (fetched again when `refresh`). */
export async function checkout(url: string, dir: string, opts: { ref?: string; sha?: string; refresh?: boolean; signal?: AbortSignal } = {}): Promise<string> {
  downloadsAllowed();
  const have = fs.existsSync(path.join(dir, '.git'));
  if (have && !opts.refresh) {
    return dir;
  }
  if (!have) {
    await fs.promises.mkdir(dir, { recursive: true });
    await git(['init', '-q'], dir, opts.signal);
    await git(['remote', 'add', 'origin', url], dir, opts.signal);
  }
  // A commit pins exactly; a ref (tag or branch) next; else the default branch.
  await git(['fetch', '-q', '--depth', '1', 'origin', opts.sha ?? opts.ref ?? 'HEAD'], dir, opts.signal);
  await git(['checkout', '-q', '--force', 'FETCH_HEAD'], dir, opts.signal);
  return dir;
}

/** Pure: the plugins listed by a marketplace.json (entries without a name or source are dropped). */
export function parseMarketplace(text: string): { name: string; plugins: MarketplaceEntry[] } {
  const raw = parseJsonc(text) as { name?: string; plugins?: unknown[] };
  const plugins = (Array.isArray(raw?.plugins) ? raw.plugins : []).filter((p): p is MarketplaceEntry => !!p && typeof p === 'object' && typeof (p as MarketplaceEntry).name === 'string' && (typeof (p as MarketplaceEntry).source === 'string' || typeof (p as MarketplaceEntry).source === 'object'));
  return { name: typeof raw?.name === 'string' ? raw.name : 'marketplace', plugins };
}

export async function loadMarketplace(spec: string, opts: { refresh?: boolean; signal?: AbortSignal } = {}): Promise<Marketplace> {
  const url = gitUrl(spec);
  const dir = url ? await checkout(url, path.join(marketplaceCache(), cacheKey(url)), { refresh: opts.refresh, signal: opts.signal }) : path.resolve(spec.replace(/^~(?=[\\/]|$)/, os.homedir()));
  const file = path.join(dir, '.claude-plugin', 'marketplace.json');
  let text: string;
  try {
    text = await fs.promises.readFile(file, 'utf8');
  } catch {
    throw new Error(`${spec} has no .claude-plugin/marketplace.json`);
  }
  const m = parseMarketplace(text);
  return { spec, name: m.name, dir, plugins: m.plugins };
}

/** Pure: ranks marketplace entries for a query (name, keywords, category, description). Empty query: all, by name. */
export function searchPlugins(markets: Marketplace[], query: string): { entry: MarketplaceEntry; market: Marketplace; score: number }[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const out: { entry: MarketplaceEntry; market: Marketplace; score: number }[] = [];
  for (const market of markets) {
    for (const entry of market.plugins) {
      const name = entry.name.toLowerCase();
      const hay = `${name} ${(entry.keywords ?? []).join(' ')} ${entry.category ?? ''} ${entry.description ?? ''}`.toLowerCase();
      const score = !words.length ? 1 : words.reduce((s, w) => s + (name === w ? 10 : name.includes(w) ? 5 : hay.includes(w) ? 1 : 0), 0);
      if (score > 0 && words.every((w) => hay.includes(w))) {
        out.push({ entry, market, score });
      }
    }
  }
  return out.sort((a, b) => b.score - a.score || a.entry.name.localeCompare(b.entry.name));
}

/** Where a marketplace entry's files are, checked out locally. */
export async function resolvePluginDir(entry: MarketplaceEntry, market: Marketplace, signal?: AbortSignal): Promise<string> {
  const within = (base: string, rel: string) => {
    const p = path.resolve(base, rel);
    if (p !== base && !p.startsWith(base + path.sep)) {
      throw new Error(`${entry.name}: source path "${rel}" leaves its repository`);
    }
    return p;
  };
  const s = entry.source;
  if (typeof s === 'string') {
    return within(market.dir, s);
  }
  const url = s.source === 'github' ? gitUrl(s.repo) : s.url;
  if (!url) {
    throw new Error(`${entry.name}: unsupported source ${JSON.stringify(s)}`);
  }
  const dir = await checkout(url, path.join(marketplaceCache(), 'sources', `${cacheKey(url)}-${(s.sha ?? s.ref ?? 'head').slice(0, 12)}`), { ref: s.ref, sha: s.sha, signal });
  return s.source === 'git-subdir' ? within(dir, s.path) : dir;
}

async function copyDir(from: string, to: string): Promise<number> {
  let n = 0;
  await fs.promises.mkdir(to, { recursive: true });
  for (const e of await fs.promises.readdir(from, { withFileTypes: true })) {
    if (e.name === '.git' || e.name === 'node_modules') {
      continue;
    }
    const a = path.join(from, e.name);
    const b = path.join(to, e.name);
    if (e.isDirectory()) {
      n += await copyDir(a, b);
    } else if (e.isFile()) {
      await fs.promises.copyFile(a, b);
      n++;
    }
  }
  return n;
}

/** Pure: what a plugin will add, with what runs on the machine (hooks, MCP servers) spelled out for the user to approve. */
export function describePlugin(p: PluginInfo): { summary: string; runs: string[] } {
  const hooks = Object.entries(p.hooks).flatMap(([ev, ms]) => (ms ?? []).flatMap((m) => m.hooks.map((h) => `${ev}${m.matcher ? ` (${m.matcher})` : ''}: ${h.command}`)));
  const mcp = Object.entries(p.mcpServers).map(([n, c]) => `MCP server ${n}: ${c.url ?? [c.command, ...(c.args ?? [])].join(' ')}`);
  const parts = [p.commandFiles.length && `${p.commandFiles.length} command${p.commandFiles.length === 1 ? '' : 's'}`, p.agentDirs.length && 'subagents', p.skillDirs.length && 'skills', hooks.length && `${hooks.length} hook${hooks.length === 1 ? '' : 's'}`, mcp.length && `${mcp.length} MCP server${mcp.length === 1 ? '' : 's'}`].filter(Boolean);
  return { summary: `${p.name}${p.version ? ` ${p.version}` : ''}: ${parts.join(', ') || 'nothing LocalPilot uses'}`, runs: [...hooks.map((h) => `hook ${h}`), ...mcp] };
}

export interface InstallResult {
  name: string;
  dir: string;
  files: number;
  plugin: PluginInfo;
}

/**
 * Installs an entry into `dest/<name>`, replacing an older copy. `confirm` sees what the plugin contains and runs
 * before anything is written; returning false cancels.
 */
export async function installPlugin(entry: MarketplaceEntry, market: Marketplace, dest: string, opts: { signal?: AbortSignal; confirm?: (p: PluginInfo, d: ReturnType<typeof describePlugin>) => Promise<boolean> } = {}): Promise<InstallResult | undefined> {
  downloadsAllowed();
  const name = entry.name.replace(/[^\w.-]+/g, '-');
  const src = await resolvePluginDir(entry, market, opts.signal);
  const staging = path.join(path.dirname(dest), `.plugin-staging-${process.pid}-${Date.now().toString(36)}`);
  try {
    const files = await copyDir(src, staging);
    // A non-strict entry describes the plugin itself: give the copy a manifest so it loads like any other.
    const manifest = path.join(staging, '.claude-plugin', 'plugin.json');
    if (!fs.existsSync(manifest)) {
      await fs.promises.mkdir(path.dirname(manifest), { recursive: true });
      await fs.promises.writeFile(manifest, JSON.stringify({ name, description: entry.description ?? '', version: entry.version }, null, 2));
    }
    const plugin = await readPlugin(staging, 'user');
    if (!plugin) {
      throw new Error(`${entry.name}: the downloaded folder is not a plugin`);
    }
    if (opts.confirm && !(await opts.confirm(plugin, describePlugin(plugin)))) {
      return undefined;
    }
    const target = path.join(dest, name);
    await fs.promises.mkdir(dest, { recursive: true });
    await fs.promises.rm(target, { recursive: true, force: true });
    await fs.promises.rename(staging, target);
    return { name, dir: target, files, plugin: (await readPlugin(target, 'user')) ?? plugin };
  } finally {
    await fs.promises.rm(staging, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Removes an installed plugin by folder name or by the name in its manifest (they can differ). */
export async function removePlugin(name: string, dest: string): Promise<boolean> {
  let entries: string[] = [];
  try {
    entries = await fs.promises.readdir(dest);
  } catch {
    return false;
  }
  for (const folder of entries) {
    const dir = path.join(dest, folder);
    if (!fs.existsSync(path.join(dir, '.claude-plugin', 'plugin.json'))) {
      continue;
    }
    if (folder === name || (await readPlugin(dir, 'user'))?.name === name) {
      await fs.promises.rm(dir, { recursive: true, force: true });
      return true;
    }
  }
  return false;
}

/** Turns a plugin on or off in a settings.json (`enabledPlugins`), keeping the file's other keys. */
export async function setPluginEnabled(settingsFile: string, name: string, enabled: boolean): Promise<void> {
  let obj: Record<string, unknown> = {};
  try {
    obj = (parseJsonc(await fs.promises.readFile(settingsFile, 'utf8')) as Record<string, unknown>) ?? {};
  } catch {
    /* new file */
  }
  const ep = { ...((obj.enabledPlugins as Record<string, boolean>) ?? {}) };
  if (enabled) {
    delete ep[name];
  } else {
    ep[name] = false;
  }
  obj.enabledPlugins = ep;
  await fs.promises.mkdir(path.dirname(settingsFile), { recursive: true });
  await fs.promises.writeFile(settingsFile, `${JSON.stringify(obj, null, 2)}\n`);
}

// ------------------------------------------------------------------ authoring

/** A new plugin with one of each part, ready to edit and load (`localpilot plugin new`). */
export async function scaffoldPlugin(dir: string, name: string): Promise<string[]> {
  const n = name.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'my-plugin';
  const files: Record<string, string> = {
    '.claude-plugin/plugin.json': JSON.stringify({ name: n, description: 'What this plugin adds, in one line', version: '0.1.0', author: { name: os.userInfo().username } }, null, 2) + '\n',
    'commands/hello.md': `---\ndescription: Say hello and summarise the workspace\nargument-hint: [name]\n---\nGreet $ARGUMENTS, then give a three-line summary of this workspace (use analyze_workspace).\n`,
    'agents/reviewer.md': `---\nname: ${n}-reviewer\ndescription: Reviews a change for bugs and missing tests. Use after editing code.\ntools: [read_file, grep_search, git_status]\n---\nYou review the current change (git_status action "diff"). Report real bugs and missing tests, most important first. Do not edit files.\n`,
    [`skills/${n}-conventions/SKILL.md`]: `---\nname: ${n}-conventions\ndescription: House rules for this codebase. Use when writing or changing code here.\n---\n# Conventions\n\n- Describe a rule the agent should follow here.\n`,
    'hooks/hooks.json': JSON.stringify({ hooks: {} }, null, 2) + '\n',
    'README.md': `# ${n}\n\nA LocalPilot / Claude Code plugin.\n\n- \`/${n}:hello\` — example command (commands/hello.md)\n- \`${n}-reviewer\` — example subagent (agents/reviewer.md)\n- \`${n}-conventions\` — example skill (skills/)\n\nCheck it with \`localpilot plugin validate .\`; install it locally by copying the folder to ~/.localpilot/plugins/, or publish it in a marketplace (.claude-plugin/marketplace.json).\n`,
  };
  const target = path.join(dir, n);
  if (fs.existsSync(target)) {
    throw new Error(`${target} already exists`);
  }
  for (const [rel, text] of Object.entries(files)) {
    await fs.promises.mkdir(path.dirname(path.join(target, rel)), { recursive: true });
    await fs.promises.writeFile(path.join(target, rel), text);
  }
  return Object.keys(files).map((f) => path.join(target, f));
}

const HOOK_EVENTS = new Set(['PreToolUse', 'PostToolUse', 'UserPromptSubmit', 'Stop', 'SubagentStop', 'SessionStart', 'SessionEnd', 'PreCompact', 'Notification']);

/** Problems a plugin author should fix (errors) or look at (warnings), for `localpilot plugin validate`. */
export async function validatePlugin(dir: string): Promise<{ errors: string[]; warnings: string[]; plugin?: PluginInfo }> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const manifestFile = path.join(dir, '.claude-plugin', 'plugin.json');
  let manifest: Record<string, unknown> = {};
  try {
    manifest = JSON.parse(await fs.promises.readFile(manifestFile, 'utf8')) as Record<string, unknown>;
  } catch (e) {
    errors.push(`.claude-plugin/plugin.json: ${fs.existsSync(manifestFile) ? `not valid JSON (${e instanceof Error ? e.message : String(e)})` : 'missing'}`);
    return { errors, warnings };
  }
  if (typeof manifest.name !== 'string' || !/^[a-z0-9][a-z0-9._-]*$/i.test(manifest.name)) {
    errors.push('plugin.json: "name" is required (letters, digits, . _ -)');
  }
  if (!manifest.description) {
    warnings.push('plugin.json: add a "description" — it is what people see when they search');
  }
  if (!manifest.version) {
    warnings.push('plugin.json: add a "version" (semver) so updates can be told apart');
  }
  const plugin = await readPlugin(dir, 'user');
  if (!plugin) {
    errors.push('the folder could not be read as a plugin');
    return { errors, warnings };
  }
  for (const f of plugin.commandFiles) {
    const { meta, body } = parseFrontMatter(await fs.promises.readFile(f, 'utf8'));
    if (!meta.description) {
      warnings.push(`${path.relative(dir, f)}: no "description" in front matter (shown in the / menu)`);
    }
    if (!body.trim()) {
      errors.push(`${path.relative(dir, f)}: empty command`);
    }
  }
  for (const d of plugin.agentDirs) {
    for (const f of (await fs.promises.readdir(d)).filter((x) => x.endsWith('.md'))) {
      const { meta } = parseFrontMatter(await fs.promises.readFile(path.join(d, f), 'utf8'));
      if (!meta.name || !meta.description) {
        errors.push(`${path.relative(dir, path.join(d, f))}: a subagent needs "name" and "description" in front matter`);
      }
    }
  }
  for (const d of plugin.skillDirs) {
    for (const s of await fs.promises.readdir(d, { withFileTypes: true })) {
      const file = path.join(d, s.name, 'SKILL.md');
      if (!s.isDirectory() || !fs.existsSync(file)) {
        continue;
      }
      const { meta } = parseFrontMatter(await fs.promises.readFile(file, 'utf8'));
      if (!meta.name || !meta.description) {
        errors.push(`${path.relative(dir, file)}: a skill needs "name" and "description" in front matter`);
      }
    }
  }
  // Loading drops events it does not know, so check the raw hooks (hooks/hooks.json or the manifest's own "hooks").
  const hookFile = typeof manifest.hooks === 'string' ? path.resolve(dir, manifest.hooks) : path.join(dir, 'hooks', 'hooks.json');
  let rawHooks: unknown = manifest.hooks && typeof manifest.hooks === 'object' ? manifest.hooks : undefined;
  if (!rawHooks && fs.existsSync(hookFile)) {
    try {
      rawHooks = JSON.parse(await fs.promises.readFile(hookFile, 'utf8'));
    } catch (e) {
      errors.push(`${path.relative(dir, hookFile)}: not valid JSON (${e instanceof Error ? e.message : String(e)})`);
    }
  }
  const events = rawHooks && typeof rawHooks === 'object' ? ((rawHooks as { hooks?: Record<string, unknown> }).hooks ?? rawHooks) : {};
  for (const ev of Object.keys(events as Record<string, unknown>)) {
    if (!HOOK_EVENTS.has(ev)) {
      errors.push(`hooks: unknown event "${ev}" (known: ${[...HOOK_EVENTS].join(', ')})`);
    }
  }
  for (const [n, c] of Object.entries(plugin.mcpServers)) {
    if (!c.command && !c.url) {
      errors.push(`.mcp.json: server "${n}" needs a "command" or a "url"`);
    }
  }
  if (!plugin.commandFiles.length && !plugin.agentDirs.length && !plugin.skillDirs.length && !Object.keys(plugin.hooks).length && !Object.keys(plugin.mcpServers).length) {
    warnings.push('the plugin adds nothing yet (no commands, subagents, skills, hooks or MCP servers)');
  }
  return { errors, warnings, plugin };
}
