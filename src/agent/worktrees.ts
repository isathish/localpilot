import * as cp from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { expandHome } from '../providers/colibriSetup';
import { onAbort } from './resilience';

/**
 * Isolated workspaces for agents, built on `git worktree`.
 *
 * Every isolated agent gets its own checkout of the repository (a worktree) so several agents can edit the same
 * files at once without clobbering each other or the user's open editors. A worktree starts as an exact copy of
 * the main checkout — committed state *plus* its uncommitted changes — recorded as a "base" commit. Afterwards
 * `changes()` diffs the worktree against that base, `apply()` brings the chosen result back onto the main checkout
 * as ordinary uncommitted changes (3-way merge on conflict), and `remove()` throws the worktree away.
 *
 * Worktrees live outside the repository (`~/.localpilot/worktrees/<repo>-<hash>/<id>`), so the user's checkout,
 * search results and VS Code explorer never see them. An optional `.localpilot/worktrees.json` in the repository
 * lists setup commands (dependency installs and the like) that run in each new worktree.
 */

export interface WorktreeInfo {
  /** Absolute path of the worktree checkout. */
  path: string;
  /** Commit the worktree started from (main checkout state including uncommitted changes at creation time). */
  base: string;
  /** Repository root this worktree belongs to. */
  repo: string;
  createdAt: number;
  /** Set once the result was applied to the main checkout. */
  appliedAt?: number;
  /** Folder of the workspace inside the repository (relative; empty or absent = the repository root). */
  subdir?: string;
  /** Who created the worktree (`cli`, `vscode:<window store>`); only its owner prunes it. */
  owner?: string;
}

export interface WorktreeChange {
  /** Path relative to the repository root. */
  path: string;
  kind: 'create' | 'modify' | 'delete' | 'rename';
  added: number;
  removed: number;
  /** For renames: the previous path. */
  from?: string;
}

export interface ApplyResult {
  files: WorktreeChange[];
  /** Files left with conflict markers after the 3-way merge. */
  conflicts: string[];
}

export interface WorktreeSetup {
  /** Commands run in order inside the new worktree (platform-neutral). */
  setup?: string[];
  'setup-unix'?: string[];
  'setup-windows'?: string[];
}

interface Logger {
  info(m: string): void;
  warn(m: string): void;
}

const noop: Logger = { info() {}, warn() {} };

export class WorktreeManager {
  constructor(
    /** Base directory for all worktrees (or a getter, re-read on each use); defaults to ~/.localpilot/worktrees. */
    private readonly home: string | (() => string | undefined) | undefined = undefined,
    private readonly log: Logger = noop
  ) {}

  /** The base directory with `~` expanded; relative paths resolve against the home directory. */
  private get base(): string {
    const raw = (typeof this.home === 'function' ? this.home() : this.home)?.trim();
    if (!raw) {
      return path.join(os.homedir(), '.localpilot', 'worktrees');
    }
    return path.resolve(os.homedir(), expandHome(raw));
  }

  /** Repository root for `dir`, or undefined when it is not inside a git working tree. */
  async repoRoot(dir: string): Promise<string | undefined> {
    try {
      const out = (await git(['rev-parse', '--show-toplevel'], dir)).trim();
      if (!out) {
        return undefined;
      }
      // Git prints forward slashes (and may keep 8.3 short names) on Windows; return the same canonical form VS
      // Code uses for workspace folders so callers can compare and hash paths.
      const resolved = path.resolve(out);
      try {
        return fs.realpathSync.native(resolved);
      } catch {
        return resolved;
      }
    } catch {
      return undefined;
    }
  }

  /** Where worktrees of `repo` are kept. */
  dirFor(repo: string): string {
    const hash = crypto.createHash('sha1').update(repo).digest('hex').slice(0, 8);
    return path.join(this.base, `${path.basename(repo).replace(/[^\w.-]+/g, '_')}-${hash}`);
  }

  /**
   * Create a worktree for `id` from the main checkout at `repo`, seeded with its uncommitted changes and untracked
   * files (and `overlay`, unsaved editor text keyed by repo-relative path), then run the repository's setup commands. `progress` receives human-readable status lines.
   */
  /** `git worktree add` calls queued per repository: they write the repository's shared worktree list and config. */
  private readonly adding = new Map<string, Promise<unknown>>();

  /**
   * Adds a worktree after any other add in the same repository has finished, and retries when git finds a lock held
   * by another git process (VS Code's own git integration, the user's terminal). Agents started together (a parallel
   * batch, Best of N) otherwise collide on those locks, and the loser silently edits the workspace instead.
   */
  private addWorktree(repo: string, args: string[]): Promise<string> {
    const run = (this.adding.get(repo) ?? Promise.resolve())
      .catch(() => undefined)
      .then(async () => {
        for (let attempt = 1; ; attempt++) {
          try {
            return await git(args, repo);
          } catch (e) {
            if (attempt >= 5 || !/\.lock\b|could not lock|unable to create .*lock|another git process/i.test(String(e))) {
              throw e;
            }
            await new Promise((r) => setTimeout(r, 250 * attempt));
          }
        }
      });
    this.adding.set(repo, run);
    void run.finally(() => {
      if (this.adding.get(repo) === run) {
        this.adding.delete(repo);
      }
    }).catch(() => undefined);
    return run;
  }

  async create(repo: string, id: string, opts: { progress?: (text: string) => void; signal?: AbortSignal; setupTimeoutMs?: number; subdir?: string; owner?: string; overlay?: Record<string, string> } = {}): Promise<WorktreeInfo> {
    const progress = opts.progress ?? (() => {});
    const dir = path.join(this.dirFor(repo), id.replace(/[^\w.-]+/g, '_'));
    if (fs.existsSync(dir)) {
      await this.removePath(repo, dir);
    }
    await fs.promises.mkdir(path.dirname(dir), { recursive: true });
    progress('Preparing an isolated copy of the repository…');
    const head = (await git(['rev-parse', '--verify', '-q', 'HEAD'], repo).catch(() => '')).trim();
    opts.signal?.throwIfAborted();
    if (head) {
      await this.addWorktree(repo, ['worktree', 'add', '--detach', dir, head]);
    } else {
      // Empty repository (no commits yet): an orphan worktree with nothing in it.
      await this.addWorktree(repo, ['worktree', 'add', '--detach', dir]).catch(async () => {
        await this.addWorktree(repo, ['worktree', 'add', '--orphan', '-b', `localpilot-${id}`, dir]);
      });
    }
    try {
      opts.signal?.throwIfAborted();
      // Carry the user's work in progress over: tracked modifications as a patch, untracked (non-ignored) files as copies.
      if (head) {
        const patch = await gitBuffer(['diff', '--binary', 'HEAD'], repo);
        if (patch.length) {
          const file = path.join(os.tmpdir(), `localpilot-seed-${process.pid}-${Date.now()}.patch`);
          await fs.promises.writeFile(file, patch);
          try {
            await git(['apply', '--whitespace=nowarn', file], dir);
          } catch (e) {
            this.log.warn(`worktree ${id}: could not carry over uncommitted changes: ${String(e)}`);
          } finally {
            await fs.promises.rm(file, { force: true });
          }
        }
      }
      opts.signal?.throwIfAborted();
      const untracked = (await git(['ls-files', '--others', '--exclude-standard', '-z'], repo)).split('\0').filter(Boolean);
      const notCopied: string[] = [];
      for (const rel of untracked) {
        opts.signal?.throwIfAborted();
        const src = path.join(repo, rel);
        const dst = path.join(dir, rel);
        try {
          await fs.promises.mkdir(path.dirname(dst), { recursive: true });
          if (rel.endsWith('/')) {
            // A nested repository: copy its files, not its .git.
            await fs.promises.cp(src, dst, { recursive: true, filter: (p) => path.basename(p) !== '.git' });
          } else {
            await fs.promises.copyFile(src, dst);
          }
        } catch {
          notCopied.push(rel);
        }
      }
      if (notCopied.length) {
        const shown = notCopied.slice(0, 10).join(', ') + (notCopied.length > 10 ? ` and ${notCopied.length - 10} more` : '');
        progress(`Not copied into the isolated workspace: ${shown}`);
        this.log.warn(`worktree ${id}: not copied: ${notCopied.join(', ')}`);
      }
      const submodules = (await git(['ls-files', '-s', '-z'], repo).catch(() => ''))
        .split('\0')
        .filter((l) => l.startsWith('160000'))
        .map((l) => l.slice(l.indexOf('\t') + 1));
      for (const sub of submodules) {
        progress(`Submodule ${sub} is not available in the isolated copy; edits there will not be applied`);
        this.log.warn(`worktree ${id}: submodule ${sub} is not available in the isolated copy`);
      }
      // Unsaved editor buffers (repo-relative path -> text) win over what is on disk.
      for (const [rel, text] of Object.entries(opts.overlay ?? {})) {
        const norm = path.normalize(rel);
        if (!norm || path.isAbsolute(norm) || norm.startsWith('..')) {continue;}
        const dst = path.join(dir, norm);
        await fs.promises.mkdir(path.dirname(dst), { recursive: true });
        await fs.promises.writeFile(dst, text);
      }
      opts.signal?.throwIfAborted();
      await this.runSetup(repo, dir, progress, opts.signal, opts.setupTimeoutMs ?? 10 * 60_000);
      opts.signal?.throwIfAborted();
      // Record the seeded + set-up state as the base commit so only the agent's own changes show up later.
      await git(['add', '-A'], dir);
      await git([...(await snapshotConfig()), 'commit', '-q', '--allow-empty', '--no-verify', '--no-gpg-sign', '-m', 'LocalPilot: workspace snapshot (base)'], dir);
      const base = (await git(['rev-parse', 'HEAD'], dir)).trim();
      // Only a folder inside the repository is a subfolder of the copy.
      const subdir = opts.subdir && !path.isAbsolute(opts.subdir) && !opts.subdir.split(/[\\/]/).includes('..') ? path.normalize(opts.subdir) : undefined;
      const info: WorktreeInfo = { path: dir, base, repo, createdAt: Date.now(), subdir, owner: opts.owner };
      // Bookkeeping lives next to the worktree, not inside it, so it never shows up as a change.
      await fs.promises.writeFile(`${dir}.json`, JSON.stringify({ id, repo, base, createdAt: info.createdAt, subdir: info.subdir, owner: info.owner }));
      this.log.info(`worktree ${id}: created at ${dir} (base ${base.slice(0, 8)})`);
      return info;
    } catch (e) {
      await this.removePath(repo, dir);
      throw e;
    }
  }

  /** Reads `.localpilot/worktrees.json` of the repository. */
  readSetup(repo: string): WorktreeSetup | undefined {
    const file = path.join(repo, '.localpilot', 'worktrees.json');
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as WorktreeSetup;
      return raw && typeof raw === 'object' ? raw : undefined;
    } catch {
      return undefined;
    }
  }

  private async runSetup(repo: string, dir: string, progress: (t: string) => void, signal: AbortSignal | undefined, timeoutMs: number): Promise<void> {
    const setup = this.readSetup(repo);
    const commands = [...(setup?.setup ?? []), ...((process.platform === 'win32' ? setup?.['setup-windows'] : setup?.['setup-unix']) ?? [])].filter((c) => typeof c === 'string' && c.trim());
    for (const command of commands) {
      signal?.throwIfAborted();
      progress(`Setting up the isolated copy: ${command}`);
      try {
        await shell(command, dir, signal, timeoutMs);
      } catch (e) {
        signal?.throwIfAborted();
        this.log.warn(`worktree setup "${command}" failed: ${String(e)}`);
        progress(`Setup command failed (continuing): ${command}`);
      }
    }
  }

  /** Files the agent changed in the worktree relative to its base, with line counts. */
  async changes(wt: WorktreeInfo): Promise<WorktreeChange[]> {
    if (!fs.existsSync(wt.path)) {
      return [];
    }
    // Make untracked files part of the diff without staging their content.
    const intent = await git(['add', '-A', '--intent-to-add'], wt.path).then(() => true, () => false);
    const status = await git(['diff', '--name-status', '-M', '-z', wt.base], wt.path);
    const numstat = await git(['diff', '--numstat', '-M', wt.base], wt.path);
    const counts = new Map<string, { added: number; removed: number }>();
    for (const line of numstat.split('\n').filter(Boolean)) {
      const [a, r, ...rest] = line.split('\t');
      const name = rest.join('\t').replace(/^.*\{(.*) => (.*)\}.*$/, (_m, _o, n) => n).replace(/^(.*) => (.*)$/, '$2');
      counts.set(name, { added: Number(a) || 0, removed: Number(r) || 0 });
    }
    const out: WorktreeChange[] = [];
    const parts = status.split('\0').filter((p) => p !== '');
    for (let i = 0; i < parts.length; i++) {
      const code = parts[i];
      if (/^R/.test(code)) {
        const from = parts[++i];
        const to = parts[++i];
        out.push({ path: to, from, kind: 'rename', ...(counts.get(to) ?? { added: 0, removed: 0 }) });
      } else {
        const p = parts[++i];
        if (p === undefined) {
          break;
        }
        const kind = code === 'A' ? 'create' : code === 'D' ? 'delete' : 'modify';
        out.push({ path: p, kind, ...(counts.get(p) ?? { added: 0, removed: 0 }) });
      }
    }
    if (!intent) {
      // The index could not be updated (e.g. locked): new files are missing from the diff, so list them directly.
      const known = new Set(out.map((c) => c.path));
      const untracked = (await git(['ls-files', '--others', '--exclude-standard', '-z'], wt.path).catch(() => '')).split('\0').filter((p) => p && !known.has(p));
      for (const p of untracked) {
        const text = await fs.promises.readFile(path.join(wt.path, p), 'utf8').catch(() => '');
        out.push({ path: p, kind: 'create', added: text ? text.split('\n').length - (text.endsWith('\n') ? 1 : 0) : 0, removed: 0 });
      }
    }
    return out;
  }

  /** The worktree's changes as a binary-safe patch against its base. */
  async patch(wt: WorktreeInfo, only?: string[]): Promise<Buffer> {
    await git(['add', '-A', '--intent-to-add'], wt.path).catch(() => undefined);
    return gitBuffer(['diff', '--binary', '-M', wt.base, ...(only ? ['--', ...only] : [])], wt.path);
  }

  /** Content of `rel` as it was at the worktree's base (empty for files the agent created). */
  async baseContent(wt: WorktreeInfo, rel: string): Promise<string> {
    try {
      return await git(['show', `${wt.base}:${rel}`], wt.path);
    } catch {
      return '';
    }
  }

  /**
   * Bring the worktree's changes onto the main checkout as uncommitted changes. Clean hunks apply directly; the rest
   * fall back to a 3-way merge, leaving conflict markers (reported in `conflicts`) instead of giving up.
   * `beforeWrite` is called with each affected main-checkout path before it is touched (for undo snapshots).
   * `only` (repository-relative paths) limits the apply to those files; a rename needs only its new path.
   */
  async apply(wt: WorktreeInfo, beforeWrite?: (fsPath: string) => Promise<void>, only?: string[]): Promise<ApplyResult> {
    const files = selectChanges(await this.changes(wt), only);
    if (!files.length) {
      return { files, conflicts: [] };
    }
    for (const f of files) {
      await beforeWrite?.(path.join(wt.repo, f.path));
      if (f.from) {
        await beforeWrite?.(path.join(wt.repo, f.from));
      }
    }
    const patch = await this.patch(wt, only ? pathsOf(files) : undefined);
    const file = path.join(os.tmpdir(), `localpilot-apply-${process.pid}-${Date.now()}.patch`);
    await fs.promises.writeFile(file, patch);
    const conflicts: string[] = [];
    try {
      try {
        await git(['apply', '--whitespace=nowarn', file], wt.repo);
      } catch {
        // 3-way merges through the index, which must match the working tree: stage the affected files as they are
        // now (the user's current content becomes "ours"), merge, then put the user's own index entries back —
        // except for conflicted files: a conflicted index lets VS Code offer its merge editor.
        const touched = pathsOf(files);
        const existing = touched.filter((p) => fs.existsSync(path.join(wt.repo, p)));
        const saved = await indexEntries(wt.repo, touched);
        try {
          if (existing.length) {
            await git(['add', '--', ...existing], wt.repo).catch(() => undefined);
          }
          const res = await gitFull(['apply', '--3way', '--whitespace=nowarn', file], wt.repo);
          for (const m of res.err.matchAll(/(?:Applied patch to '([^']+)' with conflicts|^U\s+(\S+))/gm)) {
            conflicts.push(m[1] ?? m[2]);
          }
          if (res.code !== 0 && !conflicts.length) {
            if (!saved) {
              // The user's index entries could not be read, so at least do not leave the files staged.
              await git(['reset', '-q', '--', ...touched], wt.repo).catch(() => undefined);
            }
            throw new Error(res.err.trim() || `git apply failed (${res.code})`);
          }
        } finally {
          if (saved) {
            await restoreIndex(wt.repo, touched.filter((p) => !conflicts.includes(p)), saved).catch((e) => this.log.warn(`worktree apply: could not restore the index (${e instanceof Error ? e.message : String(e)})`));
          }
        }
      }
    } finally {
      await fs.promises.rm(file, { force: true });
    }
    wt.appliedAt = Date.now();
    this.log.info(`worktree ${path.basename(wt.path)}: applied ${files.length} file(s) to ${wt.repo}${conflicts.length ? ` with ${conflicts.length} conflict(s)` : ''}`);
    return { files, conflicts: [...new Set(conflicts)] };
  }

  /**
   * Make the worktree's current state its new base (after applying), so later diffs show only new work. With `only`
   * (repository-relative paths, both sides of a rename), just those files move into the base: the rest stay pending.
   */
  async rebase(wt: WorktreeInfo, only?: string[]): Promise<void> {
    if (only && !only.length) {
      return;
    }
    if (only) {
      // Untracked new files must be known to the index for a path-limited commit to pick them up.
      await git(['add', '-A', '--intent-to-add'], wt.path).catch(() => undefined);
      await git([...(await snapshotConfig()), 'commit', '-q', '--allow-empty', '--no-verify', '--no-gpg-sign', '-m', 'LocalPilot: applied to workspace (some files)', '--', ...only], wt.path);
    } else {
      await git(['add', '-A'], wt.path);
      await git([...(await snapshotConfig()), 'commit', '-q', '--allow-empty', '--no-verify', '--no-gpg-sign', '-m', 'LocalPilot: applied to workspace'], wt.path);
    }
    wt.base = (await git(['rev-parse', 'HEAD'], wt.path)).trim();
    const meta = `${wt.path}.json`;
    try {
      const m = JSON.parse(await fs.promises.readFile(meta, 'utf8')) as Record<string, unknown>;
      await fs.promises.writeFile(meta, JSON.stringify({ ...m, base: wt.base }));
    } catch {
      /* bookkeeping only */
    }
  }

  /**
   * Throw away the agent's changes to some files of the worktree (repository-relative paths; a rename's new path
   * takes its old one with it): each goes back to its content at the base, and files the agent created are deleted.
   * Returns the paths that were reset.
   */
  async discardFiles(wt: WorktreeInfo, only: string[]): Promise<string[]> {
    const files = selectChanges(await this.changes(wt), only);
    const touched = pathsOf(files);
    for (const p of touched) {
      const inBase = await git(['cat-file', '-e', `${wt.base}:${p}`], wt.path).then(() => true, () => false);
      if (inBase) {
        await git(['checkout', wt.base, '--', p], wt.path);
      } else {
        await git(['rm', '--cached', '-q', '--ignore-unmatch', '--', p], wt.path).catch(() => undefined);
        await fs.promises.rm(path.join(wt.path, p), { force: true });
      }
    }
    this.log.info(`worktree ${path.basename(wt.path)}: discarded ${touched.length} file(s)`);
    return touched;
  }

  /** Delete the worktree and its branch bookkeeping. Safe to call twice. */
  async remove(wt: WorktreeInfo): Promise<void> {
    await this.removePath(wt.repo, wt.path);
  }

  private async removePath(repo: string, dir: string): Promise<void> {
    await git(['worktree', 'remove', '--force', dir], repo).catch(() => undefined);
    await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    await fs.promises.rm(`${dir}.json`, { force: true }).catch(() => undefined);
    await fs.promises.rmdir(path.dirname(dir)).catch(() => undefined); // drop the per-repo folder once it is empty
    await git(['worktree', 'prune'], repo).catch(() => undefined);
  }

  /** Worktrees this manager created for `repo` that still exist on disk. */
  async list(repo: string): Promise<{ id: string; info: WorktreeInfo }[]> {
    const dir = this.dirFor(repo);
    let entries: string[] = [];
    try {
      entries = await fs.promises.readdir(dir);
    } catch {
      return [];
    }
    const out: { id: string; info: WorktreeInfo }[] = [];
    for (const e of entries.filter((n) => n.endsWith('.json'))) {
      try {
        const meta = JSON.parse(await fs.promises.readFile(path.join(dir, e), 'utf8')) as { id: string; base: string; createdAt: number; subdir?: string; owner?: string };
        const wt = path.join(dir, e.slice(0, -5));
        if (fs.existsSync(wt)) {
          out.push({ id: meta.id, info: { path: wt, base: meta.base, repo, createdAt: meta.createdAt, subdir: meta.subdir || undefined, owner: meta.owner } });
        } else {
          await fs.promises.rm(path.join(dir, e), { force: true });
        }
      } catch {
        /* not one of ours */
      }
    }
    return out;
  }

  /**
   * Remove worktrees of `owner` whose session is gone (not in `keep`); other windows' and the CLI's are left alone.
   * Legacy worktrees without an owner go only once they are a week old; with no `owner` every unkept worktree goes. Returns how many were removed.
   */
  async prune(repo: string, keep: Set<string>, owner?: string): Promise<number> {
    let n = 0;
    for (const { id, info } of await this.list(repo)) {
      const mine = owner === undefined || (info.owner ? info.owner === owner : Date.now() - (info.createdAt || 0) > 7 * 24 * 3600_000 && !id.startsWith('cli-'));
      if (mine && !keep.has(id)) {
        await this.remove(info);
        n++;
      }
    }
    return n;
  }
}

/** The changes named in `only` (by new or old path; all of them when `only` is absent). */
export function selectChanges(changes: WorktreeChange[], only?: string[]): WorktreeChange[] {
  if (!only) {
    return changes;
  }
  const want = new Set(only.map((p) => p.split(path.sep).join('/')));
  return changes.filter((c) => want.has(c.path) || (c.from !== undefined && want.has(c.from)));
}

/** Every repository-relative path the changes touch (both sides of a rename). */
export function pathsOf(changes: WorktreeChange[]): string[] {
  return [...new Set(changes.flatMap((f) => (f.from ? [f.path, f.from] : [f.path])))];
}

/** `-c` options for LocalPilot's internal snapshot commits: a fixed identity, no signing and no user hooks. */
async function snapshotConfig(): Promise<string[]> {
  const noHooks = path.join(os.tmpdir(), 'localpilot-no-hooks');
  await fs.promises.mkdir(noHooks, { recursive: true });
  return ['-c', 'user.name=LocalPilot', '-c', 'user.email=localpilot@localhost', '-c', 'commit.gpgsign=false', '-c', `core.hooksPath=${noHooks}`];
}

function gitFull(args: string[], cwd: string, signal?: AbortSignal, timeoutMs = 120_000, input?: string): Promise<{ code: number | null; out: Buffer; err: string }> {
  return new Promise((resolve, reject) => {
    const child = cp.spawn('git', args, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
    if (input !== undefined) {
      child.stdin.on('error', () => undefined);
      child.stdin.end(input);
    }
    const out: Buffer[] = [];
    let err = '';
    const t = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', (d: Buffer) => out.push(d));
    child.stderr.on('data', (d) => (err += d.toString()));
    const off = onAbort(signal, () => child.kill('SIGKILL'));
    child.on('close', off);
    child.on('error', (e) => {
      clearTimeout(t);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(t);
      resolve({ code, out: Buffer.concat(out), err });
    });
  });
}

async function gitBuffer(args: string[], cwd: string): Promise<Buffer> {
  const r = await gitFull(args, cwd);
  if (r.code !== 0) {
    throw new Error(r.err.trim() || `git ${args[0]} failed (${r.code})`);
  }
  return r.out;
}

async function git(args: string[], cwd: string): Promise<string> {
  return (await gitBuffer(args, cwd)).toString('utf8');
}

/** The index entries (`git ls-files -s` records, by path) of `paths`; undefined when they cannot be read. */
async function indexEntries(repo: string, paths: string[]): Promise<Map<string, string[]> | undefined> {
  try {
    const out = await git(['--literal-pathspecs', 'ls-files', '-s', '-z', '--', ...paths], repo);
    const map = new Map<string, string[]>();
    for (const rec of out.split('\0').filter(Boolean)) {
      const p = rec.slice(rec.indexOf('\t') + 1);
      map.set(p, [...(map.get(p) ?? []), rec]);
    }
    return map;
  } catch {
    return undefined;
  }
}

/** Put `paths` back to their `saved` index entries; paths that were not indexed leave the index again. */
async function restoreIndex(repo: string, paths: string[], saved: Map<string, string[]>): Promise<void> {
  const indexed = paths.filter((p) => saved.has(p));
  const absent = paths.filter((p) => !saved.has(p));
  if (indexed.length) {
    // Drop whatever entries the merge left first (a mode-0 record), so earlier unmerged stages can come back too.
    const records = indexed.flatMap((p) => {
      const recs = saved.get(p)!;
      return [`0 ${'0'.repeat(recs[0].split(' ')[1].length)}\t${p}`, ...recs];
    });
    const r = await gitFull(['update-index', '-z', '--index-info'], repo, undefined, undefined, records.map((l) => `${l}\0`).join(''));
    if (r.code !== 0) {
      throw new Error(r.err.trim() || `git update-index failed (${r.code})`);
    }
  }
  if (absent.length) {
    await git(['--literal-pathspecs', 'rm', '--cached', '-q', '--ignore-unmatch', '--', ...absent], repo);
  }
}

function shell(command: string, cwd: string, signal: AbortSignal | undefined, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'));
      return;
    }
    // Its own process group, so a timeout or Stop ends what the command started, not just the shell.
    const child = cp.spawn(command, { cwd, shell: true, stdio: 'ignore', detached: process.platform !== 'win32' });
    const killTree = () => {
      if (!child.pid || child.exitCode !== null) {
        child.kill('SIGKILL');
        return;
      }
      if (process.platform === 'win32') {
        cp.spawn('taskkill', ['/T', '/F', '/PID', String(child.pid)], { stdio: 'ignore' }).on('error', () => child.kill('SIGKILL'));
        return;
      }
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    };
    const t = setTimeout(killTree, timeoutMs);
    const off = onAbort(signal, killTree);
    child.on('close', off);
    child.on('error', (e) => {
      clearTimeout(t);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(t);
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`exit code ${code}`));
      }
    });
  });
}
