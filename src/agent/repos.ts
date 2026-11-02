import * as fs from 'fs';
import * as path from 'path';
import { parseJsonc } from './settings';

/**
 * The repositories a task may span: the folders of a multi-root workspace, plus any listed in the workspace's
 * `.localpilot/repos.json` (`{ "repos": { "api": "../api", "web": "/src/web" } }`, paths relative to the workspace) or in
 * the `localpilot.repos` setting. Names are how the agent refers to them (`repo: "api"` on a subagent task).
 */
export interface RepoInfo {
  name: string;
  path: string;
  source: 'workspace' | 'repos.json' | 'setting';
}

const nameOf = (p: string) => path.basename(p).replace(/[^\w.-]+/g, '-') || 'repo';

/** Pure: merges the sources (first name wins; the same folder listed twice appears once) and keeps existing folders. */
export function collectRepos(
  sources: { folders: string[]; file?: { base: string; map: Record<string, string> }; setting?: Record<string, string> },
  exists: (p: string) => boolean = (p) => fs.existsSync(p)
): RepoInfo[] {
  const out: RepoInfo[] = [];
  const add = (name: string, p: string, source: RepoInfo['source']) => {
    const abs = path.resolve(p);
    if (!exists(abs) || out.some((r) => r.path === abs)) {
      return;
    }
    let n = name.replace(/[^\w.-]+/g, '-') || nameOf(abs);
    for (let i = 2; out.some((r) => r.name === n); i++) {
      n = `${name}-${i}`;
    }
    out.push({ name: n, path: abs, source });
  };
  for (const f of sources.folders) {
    add(nameOf(f), f, 'workspace');
  }
  for (const [name, p] of Object.entries(sources.file?.map ?? {})) {
    add(name, path.resolve(sources.file!.base, p), 'repos.json');
  }
  for (const [name, p] of Object.entries(sources.setting ?? {})) {
    add(name, p.replace(/^~(?=[\\/]|$)/, process.env.HOME ?? process.env.USERPROFILE ?? '~'), 'setting');
  }
  return out;
}

/** Reads `.localpilot/repos.json` of `root` (absent or invalid → nothing). */
export function readReposFile(root: string): Record<string, string> {
  try {
    const raw = parseJsonc(fs.readFileSync(path.join(root, '.localpilot', 'repos.json'), 'utf8')) as { repos?: Record<string, unknown> } | Record<string, unknown>;
    const map = (raw && typeof raw === 'object' && 'repos' in raw ? (raw as { repos?: Record<string, unknown> }).repos : raw) ?? {};
    return Object.fromEntries(Object.entries(map).filter(([, v]) => typeof v === 'string')) as Record<string, string>;
  } catch {
    return {};
  }
}

export function listRepos(primary: string | undefined, folders: string[], setting: Record<string, string> = {}): RepoInfo[] {
  const all = [...new Set([...(primary ? [primary] : []), ...folders])];
  return collectRepos({ folders: all, file: primary ? { base: primary, map: readReposFile(primary) } : undefined, setting });
}

/** A repo by name (case-insensitive) or by path. */
export function findRepo(repos: RepoInfo[], ref: string): RepoInfo | undefined {
  const r = ref.trim();
  return repos.find((x) => x.name === r) ?? repos.find((x) => x.name.toLowerCase() === r.toLowerCase()) ?? repos.find((x) => x.path === path.resolve(r));
}
