/**
 * The plugin side of Settings → Marketplace: every plugin the configured marketplaces list, with what it adds (when its
 * files are already in the marketplace checkout) and whether it is installed. No `vscode` import.
 */
import * as fs from 'fs/promises';
import * as path from 'path';
import { loadMarketplace, Marketplace, MarketplaceEntry } from './pluginInstaller';
import { PluginInfo, readPlugin } from './plugins';

export interface PluginContents {
  commands: number;
  /** Subagent definitions (`agents/*.md`). */
  agents: number;
  skills: number;
  mcpServers: number;
  hooks: number;
}

export interface PluginCatalogEntry {
  name: string;
  description: string;
  version?: string;
  category?: string;
  homepage?: string;
  /** The marketplace's own name and how it is configured (`owner/repo`, URL or folder). */
  market: string;
  marketSpec: string;
  /** Known only for plugins whose files sit inside the marketplace's checkout (a relative `source`). */
  contains?: PluginContents;
  installed?: { scope: 'user' | 'workspace'; version?: string; enabled: boolean };
}

const countMarkdown = async (dirs: string[]): Promise<number> => {
  let n = 0;
  for (const d of dirs) {
    const st = await fs.stat(d).catch(() => undefined);
    if (st?.isFile()) {
      n++;
    } else if (st?.isDirectory()) {
      n += (await fs.readdir(d).catch(() => [] as string[])).filter((f) => /\.md$/i.test(f)).length;
    }
  }
  return n;
};

const countSkills = async (dirs: string[]): Promise<number> => {
  let n = 0;
  for (const d of dirs) {
    for (const e of await fs.readdir(d, { withFileTypes: true }).catch(() => [])) {
      if (e.isDirectory() && (await fs.stat(path.join(d, e.name, 'SKILL.md')).catch(() => undefined))) {
        n++;
      }
    }
  }
  return n;
};

/** What an installed or checked-out plugin adds. */
export async function pluginContents(p: PluginInfo): Promise<PluginContents> {
  return {
    commands: p.commandFiles.length,
    agents: await countMarkdown(p.agentDirs),
    skills: await countSkills(p.skillDirs),
    mcpServers: Object.keys(p.mcpServers).length,
    hooks: Object.values(p.hooks).reduce((s, ms) => s + (ms ?? []).reduce((t, m) => t + m.hooks.length, 0), 0),
  };
}

/** A plugin with a relative `source` is already on disk in the marketplace checkout: read what it adds without installing it. */
async function entryContents(entry: MarketplaceEntry, market: Marketplace): Promise<PluginContents | undefined> {
  if (typeof entry.source !== 'string') {
    return undefined;
  }
  const dir = path.resolve(market.dir, entry.source);
  if (dir !== market.dir && !dir.startsWith(market.dir + path.sep)) {
    return undefined;
  }
  const p = await readPlugin(dir, 'user').catch(() => undefined);
  return p ? pluginContents(p) : undefined;
}

/** The installed copy of a marketplace entry: by folder name or manifest name. */
export function installedPlugin(entry: Pick<MarketplaceEntry, 'name'>, installed: readonly PluginInfo[]): PluginInfo | undefined {
  const folder = entry.name.replace(/[^\w.-]+/g, '-');
  return installed.find((p) => p.name === entry.name || path.basename(p.root) === folder);
}

/** Pure: catalog rows from loaded marketplaces (contents looked up by `contents`). */
export function catalogRows(markets: readonly Marketplace[], installed: readonly PluginInfo[], contents: Map<string, PluginContents | undefined> = new Map()): PluginCatalogEntry[] {
  const out: PluginCatalogEntry[] = [];
  const seen = new Set<string>();
  for (const market of markets) {
    for (const e of market.plugins) {
      // The first marketplace that lists a name wins, as for installs.
      if (seen.has(e.name)) {
        continue;
      }
      seen.add(e.name);
      const have = installedPlugin(e, installed);
      const c = contents.get(`${market.spec}\u0000${e.name}`);
      out.push({
        name: e.name,
        description: e.description ?? '',
        ...(e.version ? { version: e.version } : {}),
        ...(e.category ? { category: e.category } : {}),
        ...(e.homepage ? { homepage: e.homepage } : {}),
        market: market.name,
        marketSpec: market.spec,
        ...(c ? { contains: c } : {}),
        ...(have ? { installed: { scope: have.source, ...(have.version ? { version: have.version } : {}), enabled: have.enabled } } : {}),
      });
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export interface PluginCatalog {
  entries: PluginCatalogEntry[];
  /** Marketplaces that could not be loaded, with the reason. */
  errors: { spec: string; error: string }[];
  markets: Marketplace[];
}

/** Loads every configured marketplace (git checkouts are cached; `refresh` pulls them again) and builds the rows. */
export async function loadPluginCatalog(specs: readonly string[], installed: readonly PluginInfo[], opts: { refresh?: boolean; load?: typeof loadMarketplace } = {}): Promise<PluginCatalog> {
  const markets: Marketplace[] = [];
  const errors: { spec: string; error: string }[] = [];
  for (const spec of specs) {
    try {
      markets.push(await (opts.load ?? loadMarketplace)(spec, { refresh: opts.refresh }));
    } catch (e) {
      errors.push({ spec, error: e instanceof Error ? e.message : String(e) });
    }
  }
  const contents = new Map<string, PluginContents | undefined>();
  for (const m of markets) {
    for (const e of m.plugins.slice(0, 300)) {
      contents.set(`${m.spec}\u0000${e.name}`, await entryContents(e, m));
    }
  }
  return { entries: catalogRows(markets, installed, contents), errors, markets };
}

/** "3 commands, 2 subagents, 1 MCP server": what a plugin adds, for the row and the install question. */
export function contentsText(c: PluginContents | undefined): string {
  if (!c) {
    return '';
  }
  const n = (k: number, one: string, many = `${one}s`) => (k ? `${k} ${k === 1 ? one : many}` : '');
  return [n(c.commands, 'command'), n(c.agents, 'subagent'), n(c.skills, 'skill'), n(c.mcpServers, 'MCP server'), n(c.hooks, 'hook')].filter(Boolean).join(', ') || 'nothing LocalPilot uses';
}
