import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { parseFrontMatter } from './frontMatter';
import { ParallelPool } from './parallel';

/**
 * Skill installation: fetches a skill folder (SKILL.md plus any companion files) from GitHub, a URL or a local
 * folder into one of the discovery locations (`.localpilot/skills/<name>` in the workspace or the user's home).
 * Accepted sources:
 *   - `owner/repo`, `owner/repo/path/to/skill`, `owner/repo@ref/path`
 *   - https://github.com/owner/repo[/tree/<ref>/<path>|/blob/<ref>/<path>/SKILL.md]
 *   - https://raw.githubusercontent.com/owner/repo/<ref>/<path>/SKILL.md
 *   - any other https URL to a SKILL.md
 *   - a local folder (or SKILL.md) path, `~` allowed
 * A repository that holds several skills (e.g. a `skills/` collection) lists them so the caller can pick.
 */
export type SkillSource = { kind: 'github'; owner: string; repo: string; ref?: string; path: string } | { kind: 'url'; url: string } | { kind: 'local'; path: string };

export interface RemoteSkill {
  /** Folder of the skill inside the source (repo-relative for GitHub). */
  dir: string;
  /** Name from the front-matter, else the folder name. */
  name: string;
  description: string;
  /** Files to copy, relative to `dir`. */
  files: string[];
}

export interface InstalledSkill {
  name: string;
  dir: string;
  files: number;
}

export interface InstallOptions {
  /** Destination skills folder (…/.localpilot/skills). */
  dest: string;
  /** Resolve an existing destination folder: true = replace, false = skip. Default: skip. */
  onExists?: (name: string, dir: string) => Promise<boolean>;
  /** Only install these skill names from a multi-skill source (default: all discovered). */
  only?: string[];
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  /** Reported as files land. */
  progress?: (text: string) => void;
  /** Cap on the skills listed from a collection (default 60; the catalog raises it). */
  maxSkills?: number;
}

const MAX_FILES_PER_SKILL = 200;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_SKILLS = 60;

export function parseSkillSource(input: string): SkillSource | undefined {
  const s = input.trim().replace(/^<|>$/g, '');
  if (!s) {
    return undefined;
  }
  let m = /^https?:\/\/(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:\/(tree|blob)\/([^/]+)(?:\/(.*))?)?\/?(?:[?#].*)?$/i.exec(s);
  if (m) {
    const [, owner, repo, mode, ref, rest] = m;
    let p = (rest ?? '').replace(/\/+$/, '');
    if (mode === 'blob' && /(^|\/)SKILL\.md$/i.test(p)) {
      p = path.posix.dirname(p).replace(/^\.$/, '');
    }
    return { kind: 'github', owner, repo, ref, path: p };
  }
  m = /^https?:\/\/raw\.githubusercontent\.com\/([\w.-]+)\/([\w.-]+)\/(?:refs\/heads\/)?([^/]+)\/(.*)$/i.exec(s);
  if (m) {
    const [, owner, repo, ref, rest] = m;
    let p = rest.replace(/\/+$/, '');
    if (/(^|\/)SKILL\.md$/i.test(p)) {
      p = path.posix.dirname(p).replace(/^\.$/, '');
    }
    return { kind: 'github', owner, repo, ref, path: p };
  }
  if (/^https?:\/\//i.test(s)) {
    return { kind: 'url', url: s };
  }
  m = /^(?:github:|gh:)?([\w.-]+)\/([\w.-]+)(?:@([^/\s]+))?(?:\/(.*))?$/.exec(s);
  if (m && !s.startsWith('.') && !s.startsWith('/') && !s.startsWith('~') && !/\.(md|txt)$/i.test(m[2])) {
    const [, owner, repo, ref, rest] = m;
    let p = (rest ?? '').replace(/\/+$/, '');
    if (/(^|\/)SKILL\.md$/i.test(p)) {
      p = path.posix.dirname(p).replace(/^\.$/, '');
    }
    return { kind: 'github', owner, repo: repo.replace(/\.git$/, ''), ref, path: p };
  }
  return { kind: 'local', path: s.replace(/^~(?=$|[\\/])/, os.homedir()) };
}

export function describeSource(src: SkillSource): string {
  return src.kind === 'github' ? `${src.owner}/${src.repo}${src.path ? `/${src.path}` : ''}${src.ref ? `@${src.ref}` : ''}` : src.kind === 'url' ? src.url : src.path;
}

/** Skills folder for a destination: the workspace's `.localpilot/skills` or the user's `~/.localpilot/skills`. */
export function skillsDestination(scope: 'workspace' | 'user', workspaceRoot?: string): string {
  return scope === 'workspace' && workspaceRoot ? path.join(workspaceRoot, '.localpilot', 'skills') : path.join(os.homedir(), '.localpilot', 'skills');
}

type Tree = { path: string; type: 'blob' | 'tree'; size?: number }[];

async function githubJson<T>(url: string, fetchImpl: typeof fetch, signal?: AbortSignal): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/vnd.github+json', 'user-agent': 'LocalPilot' };
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (token) {
    headers.authorization = `Bearer ${token}`;
  }
  const res = await fetchImpl(url, { headers, signal });
  if (!res.ok) {
    const hint = res.status === 404 ? ' (private repository, wrong path or branch?)' : res.status === 403 ? ' (GitHub API rate limit — set GITHUB_TOKEN to raise it)' : '';
    throw new Error(`GitHub answered HTTP ${res.status} for ${url}${hint}`);
  }
  return (await res.json()) as T;
}

async function githubTree(src: Extract<SkillSource, { kind: 'github' }>, fetchImpl: typeof fetch, signal?: AbortSignal): Promise<{ ref: string; tree: Tree }> {
  let ref = src.ref;
  if (!ref) {
    const repo = await githubJson<{ default_branch?: string }>(`https://api.github.com/repos/${src.owner}/${src.repo}`, fetchImpl, signal);
    ref = repo.default_branch ?? 'main';
  }
  const data = await githubJson<{ tree: Tree; truncated?: boolean }>(`https://api.github.com/repos/${src.owner}/${src.repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`, fetchImpl, signal);
  return { ref, tree: data.tree ?? [] };
}

/** Finds the skill folders (dirs holding a SKILL.md) under `base` in a flat file list; pure so it can be unit-tested. */
export function findSkillDirs(paths: readonly string[], base = '', maxSkills = MAX_SKILLS): string[] {
  const prefix = base ? `${base.replace(/\/+$/, '')}/` : '';
  const dirs = new Set<string>();
  for (const p of paths) {
    if (!/(^|\/)SKILL\.md$/.test(p)) {
      continue;
    }
    const dir = path.posix.dirname(p).replace(/^\.$/, '');
    if (!prefix || dir === base || dir.startsWith(prefix)) {
      dirs.add(dir);
    }
  }
  // Exact folder first, then by depth so a collection lists its skills in a stable order.
  return [...dirs].sort((a, b) => (a === base ? -1 : b === base ? 1 : a.split('/').length - b.split('/').length || a.localeCompare(b))).slice(0, maxSkills);
}

/** Lists the skills a source offers without installing anything. */
export async function discoverSkills(src: SkillSource, opts: Pick<InstallOptions, 'signal' | 'fetchImpl' | 'maxSkills'> = {}): Promise<RemoteSkill[]> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  if (src.kind === 'github') {
    const { ref, tree } = await githubTree(src, fetchImpl, opts.signal);
    const blobs = tree.filter((t) => t.type === 'blob');
    const dirs = findSkillDirs(
      blobs.map((b) => b.path),
      src.path,
      opts.maxSkills
    );
    if (!dirs.length) {
      throw new Error(`No SKILL.md found in ${describeSource(src)} (branch ${ref}). Point at the skill folder, e.g. owner/repo/skills/<name>.`);
    }
    // One SKILL.md per skill for its name/description — fetched concurrently so a 20-skill collection lists quickly.
    const settled = await new ParallelPool(6).map(dirs, async (dir) => {
      const prefix = dir ? `${dir}/` : '';
      const files = blobs.filter((b) => (dir ? b.path.startsWith(prefix) : !b.path.includes('/')) && (b.size ?? 0) <= MAX_FILE_BYTES).map((b) => b.path.slice(prefix.length)).slice(0, MAX_FILES_PER_SKILL);
      const raw = await fetchText(`https://raw.githubusercontent.com/${src.owner}/${src.repo}/${encodeURIComponent(ref)}/${prefix}SKILL.md`, fetchImpl, opts.signal);
      const { meta } = parseFrontMatter(raw);
      return { dir, name: safeName(String(meta.name || path.posix.basename(dir) || src.repo)), description: String(meta.description ?? ''), files } as RemoteSkill;
    });
    const ok = settled.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []));
    const failed = settled.find((r) => r.status === 'rejected');
    // A single skill must load; in a collection one unreadable SKILL.md should not hide the rest.
    if (failed && failed.status === 'rejected' && !ok.length) {
      throw failed.reason instanceof Error ? failed.reason : new Error(String(failed.reason));
    }
    return ok;
  }
  if (src.kind === 'url') {
    const raw = await fetchText(src.url, fetchImpl, opts.signal);
    const { meta } = parseFrontMatter(raw);
    if (!meta.name && !/(^|\/)SKILL\.md(\?|$)/i.test(src.url)) {
      throw new Error(`${src.url} is not a SKILL.md (no front-matter with a name).`);
    }
    const fromUrl = path.posix.basename(path.posix.dirname(new URL(src.url).pathname));
    return [{ dir: src.url, name: safeName(String(meta.name || fromUrl || 'skill')), description: String(meta.description ?? ''), files: ['SKILL.md'] }];
  }
  const stat = await fs.stat(src.path).catch(() => undefined);
  if (!stat) {
    throw new Error(`${src.path} does not exist. Give a GitHub repository (owner/repo), a URL to a SKILL.md, or a local skill folder.`);
  }
  const root = stat.isDirectory() ? src.path : path.dirname(src.path);
  const all = await walk(root);
  const dirs = findSkillDirs(all.map((p) => p.split(path.sep).join('/')));
  if (!dirs.length) {
    throw new Error(`No SKILL.md found under ${root}.`);
  }
  const out: RemoteSkill[] = [];
  for (const dir of dirs) {
    const abs = path.join(root, dir);
    const raw = await fs.readFile(path.join(abs, 'SKILL.md'), 'utf8');
    const { meta } = parseFrontMatter(raw);
    const files = (await walk(abs)).map((p) => p.split(path.sep).join('/')).slice(0, MAX_FILES_PER_SKILL);
    out.push({ dir: abs, name: safeName(String(meta.name || path.basename(abs))), description: String(meta.description ?? ''), files });
  }
  return out;
}

/** Downloads/copies the skills of a source into `opts.dest/<name>/…` and returns what was installed. */
export async function installSkills(src: SkillSource, opts: InstallOptions): Promise<InstalledSkill[]> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const found = await discoverSkills(src, opts);
  const wanted = opts.only ? found.filter((s) => opts.only!.includes(s.name)) : found;
  if (!wanted.length) {
    throw new Error(`None of the discovered skills (${found.map((s) => s.name).join(', ')}) match ${opts.only?.join(', ')}.`);
  }
  const ref = src.kind === 'github' ? (await githubTree(src, fetchImpl, opts.signal)).ref : '';
  const installed: InstalledSkill[] = [];
  for (const skill of wanted) {
    const target = path.join(opts.dest, skill.name);
    const exists = await fs.stat(target).then(() => true, () => false);
    if (exists) {
      const replace = (await opts.onExists?.(skill.name, target)) ?? false;
      if (!replace) {
        continue;
      }
      await fs.rm(target, { recursive: true, force: true });
    }
    await fs.mkdir(target, { recursive: true });
    const safe = skill.files.filter((rel) => !rel.split('/').some((seg) => seg === '..'));
    const results = await new ParallelPool(6).map(safe, async (rel) => {
      opts.progress?.(`${skill.name}: ${rel}`);
      const out = path.join(target, ...rel.split('/'));
      await fs.mkdir(path.dirname(out), { recursive: true });
      if (src.kind === 'github') {
        const url = `https://raw.githubusercontent.com/${src.owner}/${src.repo}/${encodeURIComponent(ref)}/${skill.dir ? `${skill.dir}/` : ''}${rel}`;
        await fs.writeFile(out, await fetchBytes(url, fetchImpl, opts.signal));
      } else if (src.kind === 'url') {
        await fs.writeFile(out, await fetchBytes(src.url, fetchImpl, opts.signal));
      } else {
        await fs.copyFile(path.join(skill.dir, ...rel.split('/')), out);
      }
    });
    const firstError = results.find((r) => r.status === 'rejected');
    if (firstError && firstError.status === 'rejected') {
      await fs.rm(target, { recursive: true, force: true });
      throw new Error(`${skill.name}: ${firstError.reason instanceof Error ? firstError.reason.message : String(firstError.reason)}`);
    }
    installed.push({ name: skill.name, dir: target, files: results.length });
  }
  return installed;
}

async function fetchText(url: string, fetchImpl: typeof fetch, signal?: AbortSignal): Promise<string> {
  return Buffer.from(await fetchBytes(url, fetchImpl, signal)).toString('utf8');
}

async function fetchBytes(url: string, fetchImpl: typeof fetch, signal?: AbortSignal): Promise<Buffer> {
  const res = await fetchImpl(url, { headers: { 'user-agent': 'LocalPilot' }, signal });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} for ${url}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.byteLength > MAX_FILE_BYTES) {
    throw new Error(`${url} is larger than ${MAX_FILE_BYTES / 1024 / 1024} MB; skills should be small text files.`);
  }
  return buf;
}

async function walk(dir: string, rel = ''): Promise<string[]> {
  const out: string[] = [];
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    if (e.name === '.git' || e.name === 'node_modules') {
      continue;
    }
    const r = rel ? path.join(rel, e.name) : e.name;
    if (e.isDirectory()) {
      out.push(...(await walk(path.join(dir, e.name), r)));
    } else if (e.isFile()) {
      out.push(r);
    }
  }
  return out;
}

function safeName(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 64) || 'skill';
}
