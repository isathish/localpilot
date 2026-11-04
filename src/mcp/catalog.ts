import * as fs from 'fs/promises';
import type { McpServerConfig } from '../config';
import { parseJsonc } from '../agent/jsonc';
import { writeJsonAtomic } from './config';

/**
 * The MCP server catalog behind Settings → MCP servers → Browse: a curated list shipped in `media/mcp-catalog.json`,
 * optionally extended (on request only) from the official MCP registry.
 */

export interface McpCatalogEnv {
  name: string;
  required: boolean;
  description?: string;
  /** Where to get the value (an API key page). */
  url?: string;
  /** Stored in secret storage unless false (paths, URLs, ids). */
  secret?: boolean;
  /** Suggested value; `${workspaceFolder}` is the first workspace folder. */
  default?: string;
  /** Only used in `args` (as `${env:NAME}`), not passed in the environment. */
  arg?: boolean;
}

export interface McpCatalogEntry {
  id: string;
  name: string;
  tagline: string;
  tags: string[];
  repo?: string;
  install?: { command: string; args: string[]; env?: McpCatalogEnv[] };
  remote?: { url: string };
  /** `registry` for entries fetched from the MCP registry. */
  origin?: 'bundled' | 'registry';
}

export const MCP_REGISTRY_URL = 'https://registry.modelcontextprotocol.io/v0/servers';

const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;

/** Checks a catalog file: every entry needs an id, name, tagline, tags and a local `install` or a `remote` URL. */
export function validateMcpCatalog(raw: unknown): { entries: McpCatalogEntry[]; problems: string[] } {
  const problems: string[] = [];
  const list = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as { servers?: unknown }).servers : undefined;
  if (!Array.isArray(list)) {
    return { entries: [], problems: ['expected { "servers": [ … ] }'] };
  }
  const entries: McpCatalogEntry[] = [];
  const seen = new Set<string>();
  list.forEach((e, i) => {
    const own: string[] = [];
    const x = (e ?? {}) as Record<string, unknown>;
    const where = isStr(x.id) ? `"${x.id}"` : `#${i}`;
    if (!isStr(x.id) || !/^[a-z0-9][a-z0-9._-]*$/.test(x.id)) {
      own.push('"id" must be lower-case letters, digits, ".", "_" or "-"');
    } else if (seen.has(x.id)) {
      own.push('duplicate id');
    }
    for (const f of ['name', 'tagline']) {
      if (!isStr(x[f])) {
        own.push(`"${f}" must be a non-empty string`);
      }
    }
    if (!Array.isArray(x.tags) || !x.tags.every(isStr)) {
      own.push('"tags" must be an array of strings');
    }
    if (x.repo !== undefined && !(isStr(x.repo) && /^https:\/\//.test(x.repo))) {
      own.push('"repo" must be an https URL');
    }
    const inst = x.install as { command?: unknown; args?: unknown; env?: unknown } | undefined;
    if (inst !== undefined) {
      if (!isStr(inst?.command)) {
        own.push('"install.command" must be a string');
      }
      if (!Array.isArray(inst?.args) || !inst.args.every((a) => typeof a === 'string')) {
        own.push('"install.args" must be an array of strings');
      }
      if (inst?.env !== undefined) {
        if (!Array.isArray(inst.env)) {
          own.push('"install.env" must be an array');
        } else {
          inst.env.forEach((v: Record<string, unknown>, j) => {
            if (!v || !isStr(v.name) || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(v.name) || typeof v.required !== 'boolean') {
              own.push(`"install.env[${j}]" needs a "name" (an environment variable name) and "required" (true or false)`);
            }
          });
        }
      }
    }
    const remote = x.remote as { url?: unknown } | undefined;
    if (remote !== undefined && !(isStr(remote?.url) && /^https?:\/\//.test(remote.url))) {
      own.push('"remote.url" must be an http(s) URL');
    }
    if (inst === undefined && remote === undefined) {
      own.push('needs "install" or "remote"');
    }
    if (own.length) {
      problems.push(...own.map((p) => `${where}: ${p}`));
      return;
    }
    seen.add(x.id as string);
    entries.push({ ...(x as unknown as McpCatalogEntry), origin: 'bundled' });
  });
  return { entries, problems };
}

/** The bundled catalog; a broken file is an empty catalog plus the problems. */
export async function loadMcpCatalog(file: string): Promise<{ entries: McpCatalogEntry[]; problems: string[] }> {
  try {
    return validateMcpCatalog(JSON.parse(await fs.readFile(file, 'utf8')));
  } catch (e) {
    return { entries: [], problems: [`cannot read ${file}: ${e instanceof Error ? e.message : String(e)}`] };
  }
}

/**
 * Maps a page of the MCP registry (`/v0/servers`) to catalog entries: an npm package runs with npx, a PyPI one with
 * uvx, an OCI image with docker; a remote becomes `remote.url`. Both the current (`{ server: {…} }`, camelCase) and
 * the earlier (snake_case) shapes are read. Entries with nothing to run are skipped.
 */
export function registryToCatalog(json: unknown): { entries: McpCatalogEntry[]; nextCursor?: string } {
  const root = (json ?? {}) as { servers?: unknown[]; metadata?: { nextCursor?: unknown; next_cursor?: unknown } };
  const entries: McpCatalogEntry[] = [];
  for (const item of Array.isArray(root.servers) ? root.servers : []) {
    const s = ((item as { server?: unknown })?.server ?? item) as Record<string, unknown>;
    if (!isStr(s?.name)) {
      continue;
    }
    const pkgs = Array.isArray(s.packages) ? (s.packages as Record<string, unknown>[]) : [];
    let install: McpCatalogEntry['install'];
    for (const p of pkgs) {
      const type = String(p.registryType ?? p.registry_type ?? p.registry_name ?? '').toLowerCase();
      const ident = String(p.identifier ?? p.name ?? '');
      const version = typeof p.version === 'string' && p.version && p.version !== 'latest' ? p.version : undefined;
      const transport = ((p.transport as { type?: unknown } | undefined)?.type ?? 'stdio') as string;
      if (!ident || transport !== 'stdio') {
        continue;
      }
      const envRaw = (p.environmentVariables ?? p.environment_variables ?? []) as Record<string, unknown>[];
      const env: McpCatalogEnv[] = (Array.isArray(envRaw) ? envRaw : [])
        .filter((v) => isStr(v?.name) && /^[A-Za-z_][A-Za-z0-9_]*$/.test(v.name as string))
        .map((v) => ({
          name: v.name as string,
          required: v.isRequired === true || v.is_required === true,
          description: typeof v.description === 'string' ? v.description : undefined,
          secret: v.isSecret === false || v.is_secret === false ? false : undefined,
          default: typeof v.default === 'string' ? v.default : undefined,
        }));
      if (type === 'npm') {
        install = { command: 'npx', args: ['-y', version ? `${ident}@${version}` : ident], env };
      } else if (type === 'pypi') {
        install = { command: 'uvx', args: [version ? `${ident}==${version}` : ident], env };
      } else if (type === 'oci' || type === 'docker') {
        const image = version && !ident.includes(':') ? `${ident}:${version}` : ident;
        install = { command: 'docker', args: ['run', '-i', '--rm', ...env.flatMap((v) => ['-e', v.name]), image], env };
      } else {
        continue;
      }
      break;
    }
    const remotes = Array.isArray(s.remotes) ? (s.remotes as Record<string, unknown>[]) : [];
    const remoteUrl = remotes.map((r) => r.url).find((u): u is string => isStr(u) && /^https?:\/\//.test(u) && !u.includes('{'));
    if (!install && !remoteUrl) {
      continue;
    }
    const name = s.name;
    const short = name.split('/').pop() ?? name;
    const repoUrl = (s.repository as { url?: unknown } | undefined)?.url;
    entries.push({
      id: short.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[^a-z0-9]+/, '') || 'server',
      name: (typeof s.title === 'string' && s.title) || short,
      tagline: typeof s.description === 'string' ? s.description : name,
      tags: ['registry', ...(remoteUrl ? ['remote'] : []), ...(install ? [install.command === 'npx' ? 'npm' : install.command === 'uvx' ? 'python' : 'docker'] : [])],
      repo: isStr(repoUrl) && /^https:\/\//.test(repoUrl) ? repoUrl : undefined,
      install,
      remote: remoteUrl ? { url: remoteUrl } : undefined,
      origin: 'registry',
    });
  }
  const next = root.metadata?.nextCursor ?? root.metadata?.next_cursor;
  return { entries, nextCursor: isStr(next) ? next : undefined };
}

/** Fetches up to `pages` pages of the MCP registry (only when the user asks for it). */
export async function fetchMcpRegistry(fetchImpl: typeof fetch = fetch, pages = 5, signal?: AbortSignal): Promise<McpCatalogEntry[]> {
  const out: McpCatalogEntry[] = [];
  const ids = new Set<string>();
  let cursor: string | undefined;
  for (let i = 0; i < pages; i++) {
    const u = new URL(MCP_REGISTRY_URL);
    u.searchParams.set('limit', '100');
    if (cursor) {
      u.searchParams.set('cursor', cursor);
    }
    const res = await fetchImpl(u.toString(), { headers: { accept: 'application/json' }, signal });
    if (!res.ok) {
      throw new Error(`the MCP registry answered ${res.status} ${res.statusText}`);
    }
    const page = registryToCatalog(await res.json());
    for (const e of page.entries) {
      // The registry lists every version; the first seen (the newest) wins.
      if (!ids.has(e.id)) {
        ids.add(e.id);
        out.push(e);
      }
    }
    cursor = page.nextCursor;
    if (!cursor) {
      break;
    }
  }
  return out;
}

/** The secret name an installed server's value is stored under. */
export function catalogSecretName(server: string, env: string): string {
  return `mcp.${server}.${env}`.replace(/[^A-Za-z0-9_.-]/g, '_');
}

/**
 * The server configuration an install writes. `values` holds what the user entered per variable, already turned into
 * `${secret:…}` references where they are secret; `${env:NAME}` in the arguments is replaced by that value.
 */
export function catalogServerConfig(entry: McpCatalogEntry, how: 'local' | 'remote', values: Record<string, string> = {}): McpServerConfig {
  if (how === 'remote') {
    if (!entry.remote) {
      throw new Error(`${entry.name} has no remote server`);
    }
    return { url: entry.remote.url };
  }
  if (!entry.install) {
    throw new Error(`${entry.name} cannot run locally`);
  }
  const declared = new Map((entry.install.env ?? []).map((v) => [v.name, v]));
  const args = entry.install.args.map((a) => a.replace(/\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g, (whole, n: string) => (declared.has(n) ? values[n] ?? '' : whole))).filter((a) => a !== '');
  const env: Record<string, string> = {};
  for (const v of entry.install.env ?? []) {
    if (!v.arg && values[v.name]) {
      env[v.name] = values[v.name];
    }
  }
  return { command: entry.install.command, args, ...(Object.keys(env).length ? { env } : {}) };
}

/** A name not used yet: `id`, else `id-2`, `id-3`… */
export function freeServerName(id: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  let name = id;
  for (let n = 2; used.has(name); n++) {
    name = `${id}-${n}`;
  }
  return name;
}

/**
 * Adds one server to a server file (`{ "mcpServers": { … } }`), keeping the other servers and keys. A file with
 * comments is not rewritten (they would be lost); the caller reports the error.
 */
export async function addMcpFileServer(file: string, name: string, cfg: McpServerConfig): Promise<void> {
  let text = '';
  try {
    text = await fs.readFile(file, 'utf8');
  } catch {
    /* a new file */
  }
  let raw: Record<string, unknown> = {};
  if (text.trim()) {
    const parsed = parseJsonc(text) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`${file} is not a server file`);
    }
    if (/\/[/*]/.test(text.replace(/"(?:[^"\\]|\\.)*"/g, '""'))) {
      throw new Error(`${file} has comments that rewriting it would lose: add "${name}" by hand`);
    }
    raw = parsed as Record<string, unknown>;
  }
  // A flat file (`{ "name": { … } }`, read as a server map by the loader) gets the server at the top level.
  const nested = (!!raw.mcpServers && typeof raw.mcpServers === 'object' && !Array.isArray(raw.mcpServers)) || !Object.keys(raw).length;
  const servers = nested ? ((raw.mcpServers as Record<string, unknown> | undefined) ?? {}) : raw;
  if (Object.prototype.hasOwnProperty.call(servers, name)) {
    throw new Error(`"${name}" is already defined in ${file}`);
  }
  await writeJsonAtomic(file, nested ? { ...raw, mcpServers: { ...servers, [name]: cfg } } : { ...raw, [name]: cfg });
}
