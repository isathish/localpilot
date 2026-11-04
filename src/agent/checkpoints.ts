import * as cp from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { Session } from '../types';

/** `stash` = a stash-shaped commit of the dirty tree (untracked files as a third parent); `commit` = HEAD; `files` = file snapshots only. */
export type CheckpointKind = 'stash' | 'commit' | 'files';
export type CheckpointOutcome = 'stash' | 'head_clean' | 'head_fallback' | 'skipped';

export interface CheckpointEntry {
  /** The user turn (change-tracker turn key) this checkpoint was taken before. */
  run: number;
  createdAt: number;
  kind: CheckpointKind;
  outcome: CheckpointOutcome;
  /** `refs/localpilot/checkpoints/<session>/<run>`; absent for file-snapshot checkpoints. */
  ref?: string;
  sha?: string;
  /** Git top level (or folder) the checkpoint was taken in. */
  root?: string;
}

export interface SessionCheckpoints {
  /** Run of the most recent checkpoint. */
  latest?: number;
  history: CheckpointEntry[];
}

export const CHECKPOINT_REF_PREFIX = 'refs/localpilot/checkpoints';
/** Checkpoints kept per chat; older refs are deleted as new ones arrive. */
export const MAX_CHECKPOINTS = 100;
export const SCRATCH_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
/** Untracked files beyond these limits are left out of the snapshot (a stray build folder must not stall every turn). */
const MAX_UNTRACKED_FILES = 5000;
const MAX_UNTRACKED_BYTES = 20 * 1024 * 1024;
const GIT_TIMEOUT_MS = 60_000;

/** A ref-safe form of a session id (`s_…`, `cli-…` pass through unchanged). */
export function refSafe(id: string): string {
  return id.split('::')[0].replace(/[^A-Za-z0-9_-]/g, '_') || 'session';
}

export function checkpointRef(sessionId: string, run: number): string {
  return `${CHECKPOINT_REF_PREFIX}/${refSafe(sessionId)}/${Math.max(0, Math.floor(run))}`;
}

/** Name of the private index folder for a (folder, session) pair. */
export function scratchKey(cwd: string, sessionId: string): string {
  return crypto.createHash('sha256').update(cwd + refSafe(sessionId)).digest('hex').slice(0, 32);
}

/** Which commit a checkpoint points at, given what git produced. */
export function pickOutcome(r: { head?: string; stash?: string; stashFailed?: boolean }): { outcome: CheckpointOutcome; sha?: string; kind: CheckpointKind } {
  if (!r.head) {
    return { outcome: 'skipped', kind: 'files' };
  }
  if (r.stashFailed) {
    return { outcome: 'head_fallback', sha: r.head, kind: 'commit' };
  }
  return r.stash ? { outcome: 'stash', sha: r.stash, kind: 'stash' } : { outcome: 'head_clean', sha: r.head, kind: 'commit' };
}

/** Adds an entry (replacing one for the same run) and returns the entries that fell off the end. */
export function recordCheckpoint(state: SessionCheckpoints, entry: CheckpointEntry, cap = MAX_CHECKPOINTS): CheckpointEntry[] {
  state.history = state.history.filter((e) => e.run !== entry.run);
  state.history.push(entry);
  state.history.sort((a, b) => a.run - b.run);
  state.latest = state.history[state.history.length - 1]?.run;
  return state.history.length > cap ? state.history.splice(0, state.history.length - cap) : [];
}

/** Creation time encoded in a session id (`s_<base36 ms>…`, `cli-<base36 ms>`); undefined when it has none. */
export function sessionCreatedAt(sessionId: string): number | undefined {
  const m = /^(?:s_|cli-)([0-9a-z]{8})/.exec(sessionId);
  const t = m ? parseInt(m[1], 36) : NaN;
  return Number.isFinite(t) && t > 1_500_000_000_000 && t < 4_000_000_000_000 ? t : undefined;
}

/** What a restore brings back: the conversation (`task`), the files (`workspace`), or both. */
export type RestoreType = 'task' | 'workspace' | 'both';

export type ChangeStatus = 'A' | 'M' | 'D';

export interface ChangedFile {
  /** Relative to the checkpoint's root, `/`-separated. */
  path: string;
  status: ChangeStatus;
}

export interface WorkspaceRestore {
  ok: boolean;
  /** Files that differed from the checkpoint and were put back. */
  files: number;
  error?: string;
  /** The `git stash` entry holding the state before the restore (absent when the tree was clean). */
  safetyStash?: string;
}

/** Blobs bigger than this compare as empty in View changes. */
export const MAX_DIFF_BLOB_BYTES = 50 * 1024 * 1024;

/** The git checkpoint taken before `run`, if there is a restorable one. */
export function gitCheckpoint(state: SessionCheckpoints | undefined, run: number): CheckpointEntry | undefined {
  const e = state?.history.find((x) => x.run === run);
  return e && e.kind !== 'files' && e.sha && e.root ? e : undefined;
}

/** Parses `git diff --name-status --no-renames -z` output. */
export function parseNameStatus(out: string): Map<string, ChangeStatus> {
  const parts = out.split('\0');
  const m = new Map<string, ChangeStatus>();
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const st = parts[i].trim();
    const p = parts[i + 1];
    if (st && p) {
      m.set(p, st[0] === 'A' ? 'A' : st[0] === 'D' ? 'D' : 'M');
    }
  }
  return m;
}

/**
 * Files that differ from a checkpoint. `tracked` is the diff of its commit against the working tree, `saved` the
 * untracked files it captured (path → blob), `untrackedNow` the untracked files today and `currentBlob` the blob of
 * each saved path as it is now (undefined = gone).
 */
export function checkpointChanges(tracked: Map<string, ChangeStatus>, saved: Map<string, string>, untrackedNow: string[], currentBlob: Map<string, string | undefined>): ChangedFile[] {
  const out = new Map(tracked);
  for (const p of untrackedNow) {
    if (!out.has(p)) {
      out.set(p, 'A');
    }
  }
  for (const [p, blob] of saved) {
    if (!currentBlob.has(p)) {
      continue;
    }
    const now = currentBlob.get(p);
    if (now === undefined) {
      out.set(p, 'D');
    } else if (now === blob) {
      out.delete(p);
    } else {
      out.set(p, 'M');
    }
  }
  return [...out].map(([p, status]) => ({ path: p, status })).sort((a, b) => a.path.localeCompare(b.path));
}

/** A checkpoint-relative path, or undefined when `fsPath` is outside `root`. */
export function relativeIn(root: string, fsPath: string): string | undefined {
  const rel = path.relative(root, fsPath);
  return rel && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel) ? rel.split(path.sep).join('/') : undefined;
}

interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

// Private refs need no real author, and must not prompt for a signing key or fail on a repo without user.name.
const IDENTITY = { GIT_AUTHOR_NAME: 'LocalPilot', GIT_AUTHOR_EMAIL: 'localpilot@localhost', GIT_COMMITTER_NAME: 'LocalPilot', GIT_COMMITTER_EMAIL: 'localpilot@localhost' };

function git(args: string[], cwd: string, opts: { env?: Record<string, string>; input?: string } = {}): Promise<GitResult> {
  return new Promise((resolve) => {
    let child: cp.ChildProcess;
    try {
      child = cp.spawn('git', ['-c', 'commit.gpgSign=false', ...args], {
        cwd,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', ...IDENTITY, ...opts.env },
        windowsHide: true,
      });
    } catch (e) {
      resolve({ code: -1, stdout: '', stderr: String(e) });
      return;
    }
    // Decoded once at the end: a multi-byte character split across two chunks must not turn into garbage.
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    const timer = setTimeout(() => child.kill(), GIT_TIMEOUT_MS);
    child.stdout?.on('data', (d: Buffer) => out.push(d));
    child.stderr?.on('data', (d: Buffer) => err.push(d));
    const text = (b: Buffer[]) => Buffer.concat(b).toString('utf8');
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout: text(out), stderr: text(err) || String(e) });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout: text(out), stderr: text(err) });
    });
    child.stdin?.on('error', () => undefined);
    child.stdin?.end(opts.input ?? '');
  });
}

/**
 * A file's content in a checkpoint (`''` when it did not exist, is outside `root`, or is over the size limit); files
 * that were untracked then are read from the stash commit's third parent.
 */
export async function checkpointFile(root: string, sha: string, kind: CheckpointKind, fsPath: string): Promise<string> {
  const rel = relativeIn(root, fsPath);
  if (!rel || !/^[0-9a-f]{7,64}$/i.test(sha)) {
    return '';
  }
  for (const obj of kind === 'stash' ? [`${sha}:${rel}`, `${sha}^3:${rel}`] : [`${sha}:${rel}`]) {
    const size = await git(['cat-file', '-s', obj], root);
    if (size.code !== 0) {
      continue;
    }
    if (Number(size.stdout.trim()) > MAX_DIFF_BLOB_BYTES) {
      return '';
    }
    const blob = await git(['cat-file', 'blob', obj], root);
    return blob.code === 0 ? blob.stdout : '';
  }
  return '';
}

export interface CheckpointServiceOptions {
  /** Global storage folder; the private indexes live in `<dir>/checkpoint-scratch`. */
  globalStorageDir: string;
  enabled: () => boolean;
  log?: { info(m: string): void; warn(m: string): void };
  /** Folder used to find refs of sessions whose checkpoints were taken before this process started. */
  defaultRoot?: () => string | undefined;
  /** True when the workspace has several folders (only the primary one is checkpointed). */
  multiRoot?: () => boolean;
  /** Shown once per process (multi-root warning). */
  warn?: (message: string) => void;
}

/**
 * Git-backed checkpoints taken before each user turn: a stash-shaped commit (`git stash create`, untracked files
 * added from a private index as a third parent) kept under `refs/localpilot/checkpoints/<session>/<run>`, so
 * changes made by shell commands are captured too and `git stash list` stays untouched. Folders that are not git
 * repositories rely on the change tracker's file snapshots.
 */
export class CheckpointService {
  private readonly scratchRoot: string;
  /** Folders checkpoints were taken in, per session, this process. */
  private readonly roots = new Map<string, Set<string>>();
  /** One git snapshot at a time per repository (parallel chats would fight over the index lock). */
  private readonly chains = new Map<string, Promise<unknown>>();
  private warned = false;

  constructor(private readonly o: CheckpointServiceOptions) {
    this.scratchRoot = path.join(o.globalStorageDir, 'checkpoint-scratch');
  }

  /** Takes the checkpoint for `run` of a chat in `cwd` and records it in `session.checkpoints`. */
  async snapshot(session: Session, run: number, cwd: string | undefined): Promise<CheckpointEntry | undefined> {
    if (!this.o.enabled() || !cwd) {
      return undefined;
    }
    if (this.o.multiRoot?.() && !this.warned) {
      this.warned = true;
      this.o.warn?.('LocalPilot checkpoints cover only the first workspace folder; changes in the other folders are not captured.');
    }
    let entry: CheckpointEntry;
    try {
      entry = await this.take(session.id, run, cwd);
    } catch (e) {
      this.o.log?.warn(`checkpoint: ${e instanceof Error ? e.message : String(e)}`);
      entry = { run, createdAt: Date.now(), kind: 'files', outcome: 'skipped', root: cwd };
    }
    const state = (session.checkpoints ??= { history: [] });
    const dropped = recordCheckpoint(state, entry);
    for (const d of dropped) {
      if (d.ref && d.root) {
        void git(['update-ref', '-d', d.ref], d.root);
      }
    }
    return entry;
  }

  private async take(sessionId: string, run: number, cwd: string): Promise<CheckpointEntry> {
    const createdAt = Date.now();
    const top = await git(['rev-parse', '--show-toplevel'], cwd);
    if (top.code !== 0 || !top.stdout.trim()) {
      return { run, createdAt, kind: 'files', outcome: 'skipped', root: cwd };
    }
    const root = path.resolve(top.stdout.trim());
    return this.serial(root, () => this.takeIn(root, sessionId, run, createdAt));
  }

  /** Runs `op` after every git operation already queued for `root`. */
  private async serial<T>(root: string, op: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(root) ?? Promise.resolve();
    const next = prev.catch(() => undefined).then(op);
    this.chains.set(root, next);
    try {
      return await next;
    } finally {
      if (this.chains.get(root) === next) {
        this.chains.delete(root);
      }
    }
  }

  private async takeIn(root: string, sessionId: string, run: number, createdAt: number): Promise<CheckpointEntry> {
    const headR = await git(['rev-parse', '--verify', '-q', 'HEAD^{commit}'], root);
    const head = headR.code === 0 ? headR.stdout.trim() : undefined;
    if (!head) {
      // No commit yet: nothing for a stash to hang on, the file snapshots are the checkpoint.
      return { run, createdAt, kind: 'files', outcome: 'skipped', root };
    }
    const message = `localpilot checkpoint session=${refSafe(sessionId)} run=${run}`;
    const stashR = await git(['stash', 'create', message], root);
    const stashFailed = stashR.code !== 0;
    let stash = stashFailed ? undefined : stashR.stdout.trim() || undefined;
    if (stashFailed) {
      this.o.log?.warn(`checkpoint: git stash create failed (${stashR.stderr.trim().split('\n')[0]}); recording HEAD`);
    } else {
      const untracked = await this.untrackedCommit(root, sessionId, message);
      if (untracked) {
        let tree: string;
        let parents: string[];
        if (stash) {
          const p = await git(['rev-parse', `${stash}^1`, `${stash}^2`, `${stash}^{tree}`], root);
          const [p1, p2, t] = p.stdout.trim().split('\n');
          parents = [p1, p2];
          tree = t;
        } else {
          tree = (await git(['rev-parse', `${head}^{tree}`], root)).stdout.trim();
          const index = await git(['commit-tree', tree, '-p', head, '-m', `index on ${message}`], root);
          parents = [head, index.stdout.trim()];
        }
        const w = await git(['commit-tree', tree, ...parents.flatMap((p) => ['-p', p]), '-p', untracked, '-m', message], root);
        if (w.code === 0 && w.stdout.trim()) {
          stash = w.stdout.trim();
        } else {
          this.o.log?.warn(`checkpoint: could not attach untracked files: ${w.stderr.trim()}`);
        }
      }
    }
    const picked = pickOutcome({ head, stash, stashFailed });
    const ref = checkpointRef(sessionId, run);
    const upd = await git(['update-ref', '-m', message, ref, picked.sha!], root);
    if (upd.code !== 0) {
      throw new Error(`git update-ref failed: ${upd.stderr.trim()}`);
    }
    const roots = this.roots.get(refSafe(sessionId)) ?? new Set<string>();
    roots.add(root);
    this.roots.set(refSafe(sessionId), roots);
    return { run, createdAt, kind: picked.kind, outcome: picked.outcome, ref, sha: picked.sha, root };
  }

  /** A root commit of the untracked, non-ignored files, built in a private index; undefined when there are none. */
  private async untrackedCommit(root: string, sessionId: string, message: string): Promise<string | undefined> {
    const ls = await git(['ls-files', '--others', '--exclude-standard', '-z'], root);
    if (ls.code !== 0) {
      return undefined;
    }
    let files = ls.stdout.split('\0').filter(Boolean);
    if (!files.length) {
      return undefined;
    }
    if (files.length > MAX_UNTRACKED_FILES) {
      this.o.log?.warn(`checkpoint: ${files.length} untracked files — left out of the checkpoint (add them to .gitignore or commit them)`);
      return undefined;
    }
    files = files.filter((f) => {
      try {
        const st = fs.lstatSync(path.join(root, f));
        return st.isSymbolicLink() || (st.isFile() && st.size <= MAX_UNTRACKED_BYTES);
      } catch {
        return false;
      }
    });
    if (!files.length) {
      return undefined;
    }
    const dir = path.join(this.scratchRoot, scratchKey(root, sessionId));
    fs.mkdirSync(dir, { recursive: true });
    const index = path.join(dir, 'index');
    fs.rmSync(index, { force: true });
    const env = { GIT_INDEX_FILE: index };
    const cfg = ['-c', 'core.ignorestat=false', '-c', 'core.splitIndex=false'];
    const add = await git([...cfg, 'update-index', '--add', '-z', '--stdin'], root, { env, input: files.join('\0') + '\0' });
    if (add.code !== 0) {
      this.o.log?.warn(`checkpoint: could not index untracked files: ${add.stderr.trim()}`);
      return undefined;
    }
    const tree = await git([...cfg, 'write-tree'], root, { env });
    if (tree.code !== 0) {
      return undefined;
    }
    const commit = await git(['commit-tree', tree.stdout.trim(), '-m', `untracked files on ${message}`], root);
    fs.rmSync(index, { force: true });
    return commit.code === 0 ? commit.stdout.trim() || undefined : undefined;
  }

  /** Files that differ between a git checkpoint and the working tree, including those changed by shell commands. */
  async changedFiles(entry: CheckpointEntry): Promise<ChangedFile[]> {
    const root = entry.root;
    const sha = entry.sha;
    if (!root || !sha || entry.kind === 'files') {
      return [];
    }
    const diff = await git(['diff', '--name-status', '--no-renames', '-z', sha, '--'], root);
    if (diff.code !== 0) {
      throw new Error(`git diff failed: ${firstLine(diff.stderr)}`);
    }
    const ls = await git(['ls-files', '--others', '--exclude-standard', '-z'], root);
    let untrackedNow = ls.code === 0 ? ls.stdout.split('\0').filter(Boolean) : [];
    if (untrackedNow.length > MAX_UNTRACKED_FILES) {
      this.o.log?.warn(`checkpoint: ${untrackedNow.length} untracked files — left out of the change list`);
      untrackedNow = [];
    }
    const saved = new Map<string, string>();
    if (entry.kind === 'stash') {
      // Fails when the checkpoint captured no untracked files (no third parent).
      const t = await git(['ls-tree', '-r', '-z', `${sha}^3`], root);
      for (const rec of t.code === 0 ? t.stdout.split('\0').filter(Boolean) : []) {
        const tab = rec.indexOf('\t');
        const [mode, , blob] = rec.slice(0, tab).split(' ');
        if (tab > 0 && mode !== '120000') {
          saved.set(rec.slice(tab + 1), blob);
        }
      }
    }
    const currentBlob = new Map<string, string | undefined>();
    const present: string[] = [];
    for (const p of saved.keys()) {
      try {
        if (fs.lstatSync(path.join(root, p)).isFile() && !p.includes('\n')) {
          present.push(p);
        }
      } catch {
        currentBlob.set(p, undefined);
      }
    }
    if (present.length) {
      const h = await git(['hash-object', '--stdin-paths'], root, { input: present.join('\n') + '\n' });
      const hashes = h.stdout.split('\n');
      if (h.code === 0) {
        present.forEach((p, i) => currentBlob.set(p, hashes[i]?.trim()));
      }
    }
    return checkpointChanges(parseNameStatus(diff.stdout), saved, untrackedNow, currentBlob);
  }

  /**
   * Puts the files back as they were at a git checkpoint. Refuses when HEAD has moved past it (commits would be
   * lost); the current state is first saved with `git stash push --include-untracked`, so nothing is thrown away.
   */
  async restoreWorkspace(entry: CheckpointEntry): Promise<WorkspaceRestore> {
    if (!entry.root || !entry.sha || entry.kind === 'files') {
      return { ok: false, files: 0, error: 'This checkpoint has no git snapshot' };
    }
    const root = entry.root;
    return this.serial(root, () => this.restoreIn(root, entry));
  }

  private async restoreIn(root: string, entry: CheckpointEntry): Promise<WorkspaceRestore> {
    const fail = (error: string, safetyStash?: string, files = 0): WorkspaceRestore => ({ ok: false, files, error, safetyStash });
    const wt = await git(['rev-parse', '--is-inside-work-tree'], root);
    if (wt.code !== 0 || wt.stdout.trim() !== 'true') {
      return fail(`${root} is no longer a git work tree`);
    }
    let target = '';
    for (const name of [entry.ref, entry.sha]) {
      const r = name ? await git(['rev-parse', '--verify', '-q', `${name}^{commit}`], root) : undefined;
      if (r?.code === 0 && r.stdout.trim()) {
        target = r.stdout.trim();
        break;
      }
    }
    if (!target) {
      return fail('The checkpoint commit no longer exists in this repository');
    }
    const base = entry.kind === 'stash' ? (await git(['rev-parse', '--verify', '-q', `${target}^1`], root)).stdout.trim() : target;
    const head = (await git(['rev-parse', '--verify', '-q', 'HEAD^{commit}'], root)).stdout.trim();
    if (!base || !head) {
      return fail('Could not read the checkpoint or HEAD');
    }
    // HEAD behind the checkpoint (a reset since) is fine to move forward; anything else would drop commits.
    if (head !== base && (await git(['merge-base', '--is-ancestor', head, base], root)).code !== 0) {
      return fail('HEAD moved since this checkpoint; restore would lose commits');
    }
    const files = (await this.changedFiles({ ...entry, sha: target }).catch(() => [])).length;
    const status = await git(['status', '--porcelain', '--untracked-files=normal'], root);
    if (status.code !== 0) {
      return fail(`git status failed: ${firstLine(status.stderr)}`);
    }
    let safetyStash: string | undefined;
    if (status.stdout.trim()) {
      const push = await git(['stash', 'push', '--include-untracked', '-m', 'localpilot pre-restore'], root);
      if (push.code !== 0) {
        return fail(`Could not save the current state first (git stash push): ${firstLine(push.stderr)}`);
      }
      safetyStash = (await git(['rev-parse', '--verify', '-q', 'refs/stash'], root)).stdout.trim() || undefined;
    }
    if (head !== base) {
      const mv = await git(['update-ref', '-m', 'localpilot: restore checkpoint', 'HEAD', base, head], root);
      if (mv.code !== 0) {
        return fail(`Could not move HEAD back: ${firstLine(mv.stderr)}`, safetyStash);
      }
    }
    const reset = await git(['reset', '--hard', '-q', base], root);
    if (reset.code !== 0) {
      return fail(`git reset failed: ${firstLine(reset.stderr)}`, safetyStash);
    }
    if (entry.kind === 'stash') {
      if ((await git(['rev-parse', '--verify', '-q', `${target}^3`], root)).code === 0) {
        // Untracked files come back from the stash; anything untracked in the way would make the apply refuse. Ignored files stay.
        await git(['clean', '-fdq'], root);
      }
      const apply = await git(['stash', 'apply', '-q', target], root);
      if (apply.code !== 0) {
        return fail(`git stash apply failed: ${firstLine(apply.stderr)}`, safetyStash, files);
      }
    }
    this.o.log?.info(`checkpoint: restored ${entry.ref ?? target} in ${root}${safetyStash ? ` (previous state in stash ${safetyStash.slice(0, 10)})` : ''}`);
    return { ok: true, files, safetyStash };
  }

  /** Forgets the checkpoints of `run` and later (their messages were removed) and deletes their refs. */
  async dropFrom(session: Session, run: number): Promise<void> {
    const st = session.checkpoints;
    if (!st) {
      return;
    }
    const gone = st.history.filter((e) => e.run >= run);
    st.history = st.history.filter((e) => e.run < run);
    st.latest = st.history[st.history.length - 1]?.run;
    for (const e of gone) {
      if (e.ref && e.root) {
        await git(['update-ref', '-d', e.ref], e.root);
      }
    }
  }

  /** Checkpoint refs of a session in a repository. */
  async refs(sessionId: string, cwd: string): Promise<string[]> {
    const r = await git(['for-each-ref', '--format=%(refname)', `${CHECKPOINT_REF_PREFIX}/${refSafe(sessionId)}/`], cwd);
    return r.code === 0 ? r.stdout.split('\n').map((l) => l.trim()).filter(Boolean) : [];
  }

  /** Removes a deleted chat's refs and private index folders. */
  async deleteSession(sessionId: string, roots: (string | undefined)[] = []): Promise<void> {
    const sid = refSafe(sessionId);
    const all = new Set<string>([...(this.roots.get(sid) ?? []), ...roots.filter((r): r is string => !!r)]);
    const def = this.o.defaultRoot?.();
    if (def) {
      all.add(def);
    }
    for (const root of all) {
      try {
        const refs = await this.refs(sessionId, root);
        if (refs.length) {
          await git(['update-ref', '--stdin'], root, { input: refs.map((r) => `delete ${r}\n`).join('') });
        }
      } catch {
        /* folder gone */
      }
      fs.rmSync(path.join(this.scratchRoot, scratchKey(root, sessionId)), { recursive: true, force: true });
    }
    this.roots.delete(sid);
  }

  /**
   * Deletes checkpoint refs of chats that `orphan` says are gone; returns how many chats were cleaned up.
   * `orphan` gets the time of the chat's newest checkpoint here (see lastCheckpointAt).
   */
  async pruneRefs(cwd: string, orphan: (sessionId: string, lastUsedAt: number | undefined) => boolean): Promise<number> {
    const r = await git(['for-each-ref', '--format=%(refname) %(committerdate:unix)', `${CHECKPOINT_REF_PREFIX}/`], cwd);
    if (r.code !== 0) {
      return 0;
    }
    const bySession = new Map<string, { refs: string[]; last?: number }>();
    for (const line of r.stdout.split('\n').map((l) => l.trim()).filter(Boolean)) {
      const [ref, date] = line.split(' ');
      const [sid, run] = ref.slice(CHECKPOINT_REF_PREFIX.length + 1).split('/');
      if (!sid) {
        continue;
      }
      const g = bySession.get(sid) ?? { refs: [] };
      g.refs.push(ref);
      const t = lastCheckpointAt(Number(run), Number(date));
      if (t !== undefined && (g.last === undefined || t > g.last)) {
        g.last = t;
      }
      bySession.set(sid, g);
    }
    const doomed = [...bySession].filter(([sid, g]) => orphan(sid, g.last));
    const refs = doomed.flatMap(([, g]) => g.refs);
    if (refs.length) {
      await git(['update-ref', '--stdin'], cwd, { input: refs.map((x) => `delete ${x}\n`).join('') });
    }
    return doomed.length;
  }

  /** Removes private index folders untouched for `maxAgeMs` (left by crashes or chats deleted elsewhere). */
  pruneScratch(maxAgeMs = SCRATCH_MAX_AGE_MS, now = Date.now()): number {
    let n = 0;
    let names: string[];
    try {
      names = fs.readdirSync(this.scratchRoot);
    } catch {
      return 0;
    }
    for (const name of names) {
      const p = path.join(this.scratchRoot, name);
      try {
        if (now - fs.statSync(p).mtimeMs > maxAgeMs) {
          fs.rmSync(p, { recursive: true, force: true });
          n++;
        }
      } catch {
        /* raced with another window */
      }
    }
    return n;
  }
}

/**
 * When a checkpoint ref was taken: the run when it is a `Date.now()` turn key (VS Code), else the commit date
 * (a stash commit is made at snapshot time; a clean-tree checkpoint points at HEAD, so it can be older).
 */
export function lastCheckpointAt(run: number, committerDateSec: number): number | undefined {
  const plausible = (t: number) => Number.isFinite(t) && t > 1_500_000_000_000 && t < 4_000_000_000_000;
  const fromRun = plausible(run) ? run : undefined;
  const fromDate = plausible(committerDateSec * 1000) ? committerDateSec * 1000 : undefined;
  return fromRun === undefined ? fromDate : fromDate === undefined ? fromRun : Math.max(fromRun, fromDate);
}

/**
 * Chats whose refs should go: CLI chats, and VS Code chats missing from `live`, once both their creation and their
 * newest checkpoint (`lastUsedAt`, when known) are older than the scratch age. The age gate keeps a chat still
 * in use in another window on the same repository (a different chat store) safe; chats deleted in this window lose
 * their refs immediately through deleteSession.
 */
export function isOrphanCheckpoint(sessionId: string, live: ReadonlySet<string> | undefined, now = Date.now(), lastUsedAt?: number): boolean {
  const t = sessionCreatedAt(sessionId);
  if (t === undefined || now - Math.max(t, lastUsedAt ?? 0) <= SCRATCH_MAX_AGE_MS) {
    return false;
  }
  return sessionId.startsWith('cli-') || (!!live && sessionId.startsWith('s_') && !live.has(sessionId));
}

/** Removes the persisted file snapshots (`<dir>/<session>/`) of chats `orphan` says are gone; returns how many. */
export function pruneSnapshotDirs(dir: string, orphan: (sessionId: string) => boolean): number {
  let n = 0;
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return 0;
  }
  for (const name of names) {
    if (orphan(name)) {
      fs.rmSync(path.join(dir, name), { recursive: true, force: true });
      n++;
    }
  }
  return n;
}

function firstLine(s: string): string {
  return s.trim().split('\n')[0] ?? '';
}
