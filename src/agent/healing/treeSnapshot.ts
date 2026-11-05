import { execFile } from 'child_process';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Cheap before/after tree snapshots around model-originated `run_command` calls (design §2.4), so files changed by
 * `sed -i`, codegen or lockfile writes count as changed files, plus the whole-tree key of the baseline cache.
 */

export interface TreeEntry {
  /** -1 when the path does not exist (deleted, or listed by git as removed). */
  mtimeMs: number;
  size: number;
  /** git porcelain XY status (git snapshots only). */
  status?: string;
}

export interface TreeSnapshot {
  kind: 'git' | 'walk' | 'unknown';
  /** Root-relative, `/`-separated path -> stat. */
  entries: Map<string, TreeEntry>;
  key: string;
}

export interface GitResult {
  code: number;
  stdout: string;
}

export type GitRunner = (args: string[], cwd: string, signal?: AbortSignal) => Promise<GitResult>;

export interface SnapshotLimits {
  /** Porcelain entries whose stat is taken (the rest compare by status only). */
  gitEntries?: number;
  walkFiles?: number;
  walkMs?: number;
}

export const SNAPSHOT_SKIP_DIRS: ReadonlySet<string> = new Set(['node_modules', '.git', 'target', 'dist', 'out', '.venv']);

const ROOT_MANIFESTS = [
  'package.json', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb', 'tsconfig.json',
  'pyproject.toml', 'setup.cfg', 'setup.py', 'requirements.txt', 'pytest.ini', 'tox.ini', 'go.mod', 'go.sum',
  'Cargo.toml', 'Cargo.lock', 'pom.xml', 'build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts',
  'Makefile', '.localpilot/checks.json',
];

const sha1 = (s: string) => createHash('sha1').update(s).digest('hex');

/** Runs `git` without taking optional index locks (a concurrent `git commit` by the model must not fail). */
export const defaultGitRunner: GitRunner = (args, cwd, signal) =>
  new Promise((resolve) => {
    execFile(
      'git',
      args,
      { cwd, signal, maxBuffer: 64 * 1024 * 1024, timeout: 10_000, windowsHide: true, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } },
      (err, stdout) => {
        const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? ((err as { code: number }).code) : 1) : 0;
        resolve({ code, stdout: String(stdout ?? '') });
      },
    );
  });

const unknownSnapshot = (): TreeSnapshot => ({ kind: 'unknown', entries: new Map(), key: `unknown:${Date.now()}:${Math.random()}` });

function keyOf(kind: string, entries: Map<string, TreeEntry>): string {
  const h = createHash('sha1').update(kind);
  for (const rel of [...entries.keys()].sort()) {
    const e = entries.get(rel)!;
    h.update(`\0${rel}\0${e.status ?? ''}\0${e.mtimeMs}\0${e.size}`);
  }
  return h.digest('hex');
}

async function statEntry(fsPath: string): Promise<TreeEntry> {
  try {
    const st = await fs.promises.lstat(fsPath);
    return { mtimeMs: st.mtimeMs, size: st.size };
  } catch {
    return { mtimeMs: -1, size: -1 };
  }
}

/** Parses `git status --porcelain -z` into [status, repo-relative path] pairs (renames/copies yield both paths). */
export function parsePorcelainZ(out: string): [string, string][] {
  const parts = out.split('\0');
  const res: [string, string][] = [];
  for (let i = 0; i < parts.length; i++) {
    const rec = parts[i];
    if (rec.length < 4) {
      continue;
    }
    const status = rec.slice(0, 2);
    res.push([status, rec.slice(3)]);
    if ((status[0] === 'R' || status[0] === 'C') && i + 1 < parts.length) {
      res.push([status, parts[++i]]);
    }
  }
  return res;
}

async function gitPorcelain(root: string, run: GitRunner, signal?: AbortSignal): Promise<{ prefix: string; out: string } | undefined> {
  const pre = await run(['rev-parse', '--show-prefix'], root, signal);
  if (pre.code !== 0) {
    return undefined;
  }
  const st = await run(['status', '--porcelain', '-z', '--untracked-files=all', '--', '.'], root, signal);
  if (st.code !== 0) {
    return undefined;
  }
  return { prefix: pre.stdout.trim(), out: st.stdout };
}

async function gitSnapshot(root: string, prefix: string, out: string, max: number): Promise<TreeSnapshot> {
  const entries = new Map<string, TreeEntry>();
  const listed: [string, string][] = [];
  for (const [status, repoRel] of parsePorcelainZ(out)) {
    if (prefix && !repoRel.startsWith(prefix)) {
      continue;
    }
    const rel = repoRel.slice(prefix.length).replace(/\/$/, '');
    if (rel) {
      listed.push([status, rel]);
    }
  }
  listed.sort((a, b) => (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
  await Promise.all(
    listed.map(async ([status, rel], i) => {
      const st = i < max ? await statEntry(path.join(root, rel)) : { mtimeMs: 0, size: 0 };
      entries.set(rel, { ...st, status });
    }),
  );
  return { kind: 'git', entries, key: keyOf('git', entries) };
}

async function walkSnapshot(root: string, signal: AbortSignal | undefined, maxFiles: number, maxMs: number): Promise<TreeSnapshot> {
  const entries = new Map<string, TreeEntry>();
  const deadline = Date.now() + maxMs;
  const queue: string[] = [''];
  while (queue.length) {
    if (signal?.aborted || Date.now() > deadline) {
      return unknownSnapshot();
    }
    const dirRel = queue.shift()!;
    let dirents: fs.Dirent[];
    try {
      dirents = await fs.promises.readdir(path.join(root, dirRel), { withFileTypes: true });
    } catch {
      continue;
    }
    const files: string[] = [];
    for (const d of dirents) {
      const rel = dirRel ? `${dirRel}/${d.name}` : d.name;
      if (d.isDirectory()) {
        if (!SNAPSHOT_SKIP_DIRS.has(d.name)) {
          queue.push(rel);
        }
      } else {
        files.push(rel);
      }
    }
    if (entries.size + files.length > maxFiles) {
      return unknownSnapshot();
    }
    const stats = await Promise.all(files.map((rel) => statEntry(path.join(root, rel))));
    files.forEach((rel, i) => entries.set(rel, stats[i]));
  }
  return { kind: 'walk', entries, key: keyOf('walk', entries) };
}

/**
 * Snapshot of `root`: `git status --porcelain -z` plus the stat of each listed path (at most 2,000 stat'ed), or,
 * outside git, an mtime walk skipping dependency/build folders (at most 20,000 files / 300 ms, else `unknown`).
 */
export async function snapshot(root: string, signal?: AbortSignal, exec: GitRunner = defaultGitRunner, limits: SnapshotLimits = {}): Promise<TreeSnapshot> {
  try {
    const git = await gitPorcelain(root, exec, signal);
    if (signal?.aborted) {
      return unknownSnapshot();
    }
    if (git) {
      return await gitSnapshot(root, git.prefix, git.out, limits.gitEntries ?? 2000);
    }
    return await walkSnapshot(root, signal, limits.walkFiles ?? 20_000, limits.walkMs ?? 300);
  } catch {
    return unknownSnapshot();
  }
}

/** Root-relative paths that differ between two snapshots; `['*']` when either is `unknown` (treat as changed). */
export function diff(a: TreeSnapshot, b: TreeSnapshot): string[] {
  if (a.kind === 'unknown' || b.kind === 'unknown' || a.kind !== b.kind) {
    return ['*'];
  }
  if (a.key === b.key) {
    return [];
  }
  const changed: string[] = [];
  for (const rel of new Set([...a.entries.keys(), ...b.entries.keys()])) {
    const x = a.entries.get(rel);
    const y = b.entries.get(rel);
    if (!x || !y || x.status !== y.status || x.mtimeMs !== y.mtimeMs || x.size !== y.size) {
      changed.push(rel);
    }
  }
  return changed.sort();
}

/**
 * Whole-tree key for the baseline cache (no changed files yet): git `HEAD` + the porcelain snapshot key (status and
 * stat of every dirty path); without git, the walk key, or sha1 of the root manifests' path+mtime+size when the
 * walk is over its bounds.
 */
export async function wholeTreeKey(root: string, exec: GitRunner = defaultGitRunner, signal?: AbortSignal): Promise<string> {
  const git = await gitPorcelain(root, exec, signal).catch(() => undefined);
  if (git) {
    const head = await exec(['rev-parse', 'HEAD'], root, signal).catch(() => ({ code: 1, stdout: '' }));
    const snap = await gitSnapshot(root, git.prefix, git.out, 2000);
    return `git:${head.code === 0 ? head.stdout.trim() : 'nohead'}:${snap.key}`;
  }
  const walk = await walkSnapshot(root, signal, 20_000, 300).catch(unknownSnapshot);
  if (walk.kind === 'walk') {
    return `walk:${walk.key}`;
  }
  const parts: string[] = [];
  for (const m of ROOT_MANIFESTS) {
    const st = await statEntry(path.join(root, m));
    if (st.mtimeMs >= 0) {
      parts.push(`${m}\0${st.mtimeMs}\0${st.size}`);
    }
  }
  return `manifest:${sha1(parts.join('\n'))}`;
}
