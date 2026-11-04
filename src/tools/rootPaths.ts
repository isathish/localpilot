import * as path from 'path';

/** A folder a relative tool path may resolve against: a workspace folder or a registered repository. */
export interface NamedRoot {
  name: string;
  path: string;
}

export type RootResolution = { abs: string; root?: NamedRoot; note?: string } | { error: string };

const fold = (s: string): string => (process.platform === 'win32' ? s.toLowerCase() : s);

/** The root a `name` refers to: exact name first, then case-insensitive. */
export function findRoot(roots: readonly NamedRoot[], name: string): NamedRoot | undefined {
  const n = name.trim();
  return roots.find((r) => r.name === n) ?? roots.find((r) => r.name.toLowerCase() === n.toLowerCase());
}

/**
 * `name:rel` (also `name:/rel`, the @ menu's form) naming one of `roots`. Single letters are left alone so Windows
 * drive paths (`C:\x`) never read as a folder prefix.
 */
export function splitRootPrefix(p: string, roots: readonly NamedRoot[]): { root: NamedRoot; rest: string } | undefined {
  const m = /^([^:/\\]{2,}):(?![\\/]{2})(.*)$/s.exec(p);
  const root = m ? findRoot(roots, m[1]) : undefined;
  return root && m ? { root, rest: m[2].replace(/^[\\/]+/, '') } : undefined;
}

/**
 * Where a tool path points in a multi-root workspace. `primary` is the agent's root; `roots` the other folders it may
 * reach (the primary itself may be among them). `name:rel` picks a root. A bare relative path that is missing from the
 * primary but exists in exactly one other root resolves there with a note; in several it is an error listing them.
 * With `create` (a file about to be created) a bare path always stays in the primary.
 */
export function resolveRootPath(p: string, primary: string, roots: readonly NamedRoot[], exists: (abs: string) => boolean, create = false): RootResolution {
  const prefixed = splitRootPrefix(p, roots);
  if (prefixed) {
    return { abs: path.join(prefixed.root.path, prefixed.rest), root: prefixed.root };
  }
  if (path.isAbsolute(p)) {
    return { abs: p };
  }
  const own = path.join(primary, p);
  const rel = p.replace(/\\/g, '/').replace(/^\.\//, '');
  const others = roots.filter((r) => fold(path.resolve(r.path)) !== fold(path.resolve(primary)));
  if (create || !others.length || !rel || rel === '.' || rel.startsWith('../') || rel === '..' || exists(own)) {
    return { abs: own };
  }
  const hits: { root: NamedRoot; abs: string; shown: string }[] = [];
  for (const r of others) {
    const abs = path.join(r.path, p);
    if (exists(abs)) {
      hits.push({ root: r, abs, shown: `${r.name}:${rel}` });
      continue;
    }
    // `asRelativePath` names a file of another folder `folder/rel`.
    const [head, ...tail] = rel.split('/');
    if (tail.length && head === r.name && exists(path.join(r.path, ...tail))) {
      hits.push({ root: r, abs: path.join(r.path, ...tail), shown: `${r.name}:${tail.join('/')}` });
    }
  }
  if (hits.length === 1) {
    const h = hits[0];
    return { abs: h.abs, root: h.root, note: `(${rel} is not in the primary folder; using workspace folder "${h.root.name}": ${h.shown})` };
  }
  if (hits.length > 1) {
    return { error: `"${rel}" is not in the primary folder and exists in several workspace folders: ${hits.map((h) => h.shown).join(', ')}. Prefix the path with the folder name, e.g. "${hits[0].shown}".` };
  }
  return { abs: own };
}

/** `name — path — git <branch>@<sha>` lines for the prompt; `git` is absent for folders that are not repositories. */
export function formatRootsOverview(roots: readonly (NamedRoot & { git?: { branch: string; sha: string } })[]): string {
  return roots.map((r) => `${r.name} — ${r.path}${r.git ? ` — git ${r.git.branch || '(detached)'}@${r.git.sha}` : ''}`).join('\n');
}

/** The optional `root` parameter of the git, security and repo_graph tools. */
export const ROOT_PARAM = { type: 'string', description: 'Workspace folder or repository name to run in (multi-root workspaces); default: the primary folder' } as const;
