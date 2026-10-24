import * as cp from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

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
    /** Base directory for all worktrees; defaults to ~/.localpilot/worktrees. */
    private readonly home = path.join(os.homedir(), '.localpilot', 'worktrees'),
    private readonly log: Logger = noop
  ) {}

  /** Repository root for `dir`, or undefined when it is not inside a git working tree. */
  async repoRoot(dir: string): Promise<string | undefined> {
    try {
      const out = await git(['rev-parse', '--show-toplevel'], dir);
      return out.trim() || undefined;
    } catch {
      return undefined;
    }
  }

  /** Where worktrees of `repo` are kept. */
  dirFor(repo: string): string {
    const hash = crypto.createHash('sha1').update(repo).digest('hex').slice(0, 8);
    return path.join(this.home, `${path.basename(repo).replace(/[^\w.-]+/g, '_')}-${hash}`);
  }

  /**
   * Create a worktree for `id` from the main checkout at `repo`, seeded with its uncommitted changes and untracked
   * files, then run the repository's setup commands. `progress` receives human-readable status lines.
   */
  async create(repo: string, id: string, opts: { progress?: (text: string) => void; signal?: AbortSignal; setupTimeoutMs?: number } = {}): Promise<WorktreeInfo> {
    const progress = opts.progress ?? (() => {});
    const dir = path.join(this.dirFor(repo), id.replace(/[^\w.-]+/g, '_'));
    await fs.promises.mkdir(path.dirname(dir), { recursive: true });
    if (fs.existsSync(dir)) {
      await this.removePath(repo, dir);
    }
    progress('Preparing an isolated copy of the repository…');
    const head = (await git(['rev-parse', '--verify', '-q', 'HEAD'], repo).catch(() => '')).trim();
    if (head) {
      await git(['worktree', 'add', '--detach', dir, head], repo);
    } else {
      // Empty repository (no commits yet): an orphan worktree with nothing in it.
      await git(['worktree', 'add', '--detach', dir], repo).catch(async () => {
        await git(['worktree', 'add', '--orphan', '-b', `localpilot-${id}`, dir], repo);
      });
    }
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
    const untracked = (await git(['ls-files', '--others', '--exclude-standard', '-z'], repo)).split('\0').filter(Boolean);
    for (const rel of untracked) {
      const src = path.join(repo, rel);
      const dst = path.join(dir, rel);
      try {
        await fs.promises.mkdir(path.dirname(dst), { recursive: true });
        await fs.promises.copyFile(src, dst);
      } catch {
        /* unreadable or vanished file: skip */
      }
    }
    await this.runSetup(repo, dir, progress, opts.signal, opts.setupTimeoutMs ?? 10 * 60_000);
    // Record the seeded + set-up state as the base commit so only the agent's own changes show up later.
    await git(['add', '-A'], dir);
    await git(['-c', 'user.name=LocalPilot', '-c', 'user.email=localpilot@localhost', 'commit', '-q', '--allow-empty', '--no-verify', '-m', 'LocalPilot: workspace snapshot (base)'], dir);
    const base = (await git(['rev-parse', 'HEAD'], dir)).trim();
    const info: WorktreeInfo = { path: dir, base, repo, createdAt: Date.now() };
    // Bookkeeping lives next to the worktree, not inside it, so it never shows up as a change.
    await fs.promises.writeFile(`${dir}.json`, JSON.stringify({ id, repo, base, createdAt: info.createdAt }));
    this.log.info(`worktree ${id}: created at ${dir} (base ${base.slice(0, 8)})`);
    return info;
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
      progress(`Setting up the isolated copy: ${command}`);
      try {
        await shell(command, dir, signal, timeoutMs);
      } catch (e) {
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
    await git(['add', '-A', '--intent-to-add'], wt.path).catch(() => undefined);
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
    return out;
  }

  /** The worktree's changes as a binary-safe patch against its base. */
  async patch(wt: WorktreeInfo): Promise<Buffer> {
    await git(['add', '-A', '--intent-to-add'], wt.path).catch(() => undefined);
    return gitBuffer(['diff', '--binary', '-M', wt.base], wt.path);
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
   */
  async apply(wt: WorktreeInfo, beforeWrite?: (fsPath: string) => Promise<void>): Promise<ApplyResult> {
    const files = await this.changes(wt);
    if (!files.length) {
      return { files, conflicts: [] };
    }
    for (const f of files) {
      await beforeWrite?.(path.join(wt.repo, f.path));
      if (f.from) {
        await beforeWrite?.(path.join(wt.repo, f.from));
      }
    }
    const patch = await this.patch(wt);
    const file = path.join(os.tmpdir(), `localpilot-apply-${process.pid}-${Date.now()}.patch`);
    await fs.promises.writeFile(file, patch);
    const conflicts: string[] = [];
    try {
      try {
        await git(['apply', '--whitespace=nowarn', file], wt.repo);
      } catch {
        // 3-way merges through the index, which must match the working tree: stage the affected files as they are
        // now (the user's current content becomes "ours"), merge, then unstage again unless conflicts remain —
        // a conflicted index lets VS Code offer its merge editor.
        const touched = [...new Set(files.flatMap((f) => (f.from ? [f.path, f.from] : [f.path])))];
        const existing = touched.filter((p) => fs.existsSync(path.join(wt.repo, p)));
        if (existing.length) {
          await git(['add', '--', ...existing], wt.repo).catch(() => undefined);
        }
        const res = await gitFull(['apply', '--3way', '--whitespace=nowarn', file], wt.repo);
        for (const m of res.err.matchAll(/(?:Applied patch to '([^']+)' with conflicts|^U\s+(\S+))/gm)) {
          conflicts.push(m[1] ?? m[2]);
        }
        if (res.code !== 0 && !conflicts.length) {
          throw new Error(res.err.trim() || `git apply failed (${res.code})`);
        }
        if (!conflicts.length) {
          await git(['reset', '-q', '--', ...touched], wt.repo).catch(() => undefined);
        }
      }
    } finally {
      await fs.promises.rm(file, { force: true });
    }
    wt.appliedAt = Date.now();
    this.log.info(`worktree ${path.basename(wt.path)}: applied ${files.length} file(s) to ${wt.repo}${conflicts.length ? ` with ${conflicts.length} conflict(s)` : ''}`);
    return { files, conflicts: [...new Set(conflicts)] };
  }

  /** Make the worktree's current state its new base (after applying), so later diffs show only new work. */
  async rebase(wt: WorktreeInfo): Promise<void> {
    await git(['add', '-A'], wt.path);
    await git(['-c', 'user.name=LocalPilot', '-c', 'user.email=localpilot@localhost', 'commit', '-q', '--allow-empty', '--no-verify', '-m', 'LocalPilot: applied to workspace'], wt.path);
    wt.base = (await git(['rev-parse', 'HEAD'], wt.path)).trim();
    const meta = `${wt.path}.json`;
    try {
      const m = JSON.parse(await fs.promises.readFile(meta, 'utf8')) as Record<string, unknown>;
      await fs.promises.writeFile(meta, JSON.stringify({ ...m, base: wt.base }));
    } catch {
      /* bookkeeping only */
    }
  }

  /** Delete the worktree and its branch bookkeeping. Safe to call twice. */
  async remove(wt: WorktreeInfo): Promise<void> {
    await this.removePath(wt.repo, wt.path);
  }

  private async removePath(repo: string, dir: string): Promise<void> {
    await git(['worktree', 'remove', '--force', dir], repo).catch(() => undefined);
    await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    await fs.promises.rm(`${dir}.json`, { force: true }).catch(() => undefined);
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
        const meta = JSON.parse(await fs.promises.readFile(path.join(dir, e), 'utf8')) as { id: string; base: string; createdAt: number };
        const wt = path.join(dir, e.slice(0, -5));
        if (fs.existsSync(wt)) {
          out.push({ id: meta.id, info: { path: wt, base: meta.base, repo, createdAt: meta.createdAt } });
        } else {
          await fs.promises.rm(path.join(dir, e), { force: true });
        }
      } catch {
        /* not one of ours */
      }
    }
    return out;
  }

  /** Remove worktrees whose session is gone (not in `keep`). Returns how many were removed. */
  async prune(repo: string, keep: Set<string>): Promise<number> {
    let n = 0;
    for (const { id, info } of await this.list(repo)) {
      if (!keep.has(id)) {
        await this.remove(info);
        n++;
      }
    }
    return n;
  }
}

function gitFull(args: string[], cwd: string, signal?: AbortSignal, timeoutMs = 120_000): Promise<{ code: number | null; out: Buffer; err: string }> {
  return new Promise((resolve, reject) => {
    const child = cp.spawn('git', args, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
    const out: Buffer[] = [];
    let err = '';
    const t = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', (d: Buffer) => out.push(d));
    child.stderr.on('data', (d) => (err += d.toString()));
    signal?.addEventListener('abort', () => child.kill('SIGKILL'), { once: true });
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

function shell(command: string, cwd: string, signal: AbortSignal | undefined, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = cp.spawn(command, { cwd, shell: true, stdio: 'ignore' });
    const t = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    signal?.addEventListener('abort', () => child.kill('SIGKILL'), { once: true });
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
