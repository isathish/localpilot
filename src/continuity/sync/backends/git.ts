// Git backend (design §14.5): a dedicated repository (never the project's own), branch `localpilot-sync`, in a working
// clone under `<dataRoot>/sync/git/<remoteId>`. `begin` = fetch + reset to the remote branch (safe: every path has one
// writer and this device's own files are written again from the log), objects are files of the clone (FolderBackend),
// `commit` = add + commit + push, retried after a fetch + rebase when the push is not a fast-forward (no file can
// conflict). Uses the system `git` and the user's credential helper; never asks interactively. Pure Node.
import { execFile } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { BackendError, CheckResult, PutOptions, RemoteEntry, SyncBackend } from './backend';
import { FolderBackend } from './folder';

export interface GitBackendOptions {
  url: string;
  branch: string;
  /** `<dataRoot>/sync`. */
  workDir: string;
  git?: string;
  deviceName?: string;
  /** Tests: max push attempts. */
  attempts?: number;
}

interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Strips credentials from a URL for labels and messages. */
export function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.password || u.username) {
      u.password = '';
      u.username = u.username ? '***' : '';
    }
    return u.toString();
  } catch {
    return url.replace(/\/\/[^@/]+@/, '//***@');
  }
}

export class GitBackend implements SyncBackend {
  readonly kind = 'git' as const;
  readonly label: string;
  readonly dir: string;
  private readonly files: FolderBackend;
  private readonly git: string;
  private dirty = false;
  private prepared = false;

  constructor(private readonly o: GitBackendOptions) {
    this.git = o.git || 'git';
    this.label = redactUrl(o.url);
    const id = crypto.createHash('sha256').update(`${o.url}#${o.branch}`).digest('hex').slice(0, 16);
    this.dir = path.join(o.workDir, 'git', id);
    this.files = new FolderBackend(this.dir);
  }

  private run(args: string[], o: { cwd?: string; allowFail?: boolean } = {}): Promise<GitResult> {
    return new Promise((resolve, reject) => {
      execFile(
        this.git,
        args,
        {
          cwd: o.cwd ?? this.dir,
          maxBuffer: 64 * 1024 * 1024,
          windowsHide: true,
          // Never prompt (no TTY here): the credential helper answers or the command fails.
          env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', GIT_ASKPASS: process.env.GIT_ASKPASS ?? '', LC_ALL: 'C' },
        },
        (err, stdout, stderr) => {
          const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? ((err as { code: number }).code) : 1) : 0;
          if (err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
            reject(new BackendError('other', 'git is not installed (or not on PATH)'));
            return;
          }
          const r = { code, stdout: String(stdout), stderr: String(stderr) };
          if (code && !o.allowFail) {
            reject(gitError(args, r));
            return;
          }
          resolve(r);
        }
      );
    });
  }

  /** Clones (or re-uses) the working clone; refuses a folder that is not ours. */
  private async prepare(): Promise<void> {
    if (this.prepared) {
      return;
    }
    const gitDir = path.join(this.dir, '.git');
    if (fs.existsSync(gitDir)) {
      // The clone must be ours: its top level is exactly this folder and its origin is the configured URL.
      const top = (await this.run(['rev-parse', '--show-toplevel'])).stdout.trim();
      if (path.resolve(top) !== path.resolve(fs.realpathSync(this.dir))) {
        throw new BackendError('other', `${this.dir} is inside another repository`);
      }
      await this.run(['remote', 'set-url', 'origin', this.o.url]);
    } else {
      fs.mkdirSync(this.dir, { recursive: true });
      await this.run(['init', '-q'], { cwd: this.dir });
      await this.run(['remote', 'add', 'origin', this.o.url]);
    }
    await this.run(['config', 'user.name', 'LocalPilot']);
    await this.run(['config', 'user.email', 'localpilot@localhost']);
    await this.run(['config', 'core.autocrlf', 'false']);
    await this.run(['config', 'commit.gpgsign', 'false']);
    this.prepared = true;
  }

  /** Whether the remote has the sync branch. */
  private async remoteHasBranch(): Promise<boolean> {
    const r = await this.run(['ls-remote', '--heads', 'origin', this.o.branch], { allowFail: true });
    if (r.code) {
      throw gitError(['ls-remote'], r);
    }
    return r.stdout.trim().length > 0;
  }

  async check(): Promise<CheckResult> {
    try {
      refuseProjectRepo(this.o.url);
      await this.prepare();
      await this.remoteHasBranch();
      return { ok: true };
    } catch (e) {
      const be = e instanceof BackendError ? e : new BackendError('other', String((e as Error).message ?? e));
      return { ok: false, reason: be.code === 'precondition' || be.code === 'not-implemented' ? 'other' : be.code, message: be.message };
    }
  }

  async begin(): Promise<void> {
    refuseProjectRepo(this.o.url);
    await this.prepare();
    this.dirty = false;
    if (await this.remoteHasBranch()) {
      await this.run(['fetch', '-q', 'origin', `+refs/heads/${this.o.branch}:refs/remotes/origin/${this.o.branch}`]);
      await this.run(['checkout', '-q', '-B', this.o.branch, `origin/${this.o.branch}`]);
      await this.run(['reset', '-q', '--hard', `origin/${this.o.branch}`]);
    } else {
      // An empty remote: start the branch here (the first commit creates it on push).
      const head = await this.run(['rev-parse', '--verify', '-q', 'HEAD'], { allowFail: true });
      if (head.code) {
        await this.run(['checkout', '-q', '--orphan', this.o.branch], { allowFail: true });
      }
    }
    await this.run(['clean', '-q', '-fd'], { allowFail: true });
  }

  list(prefix: string, after?: string): Promise<RemoteEntry[]> {
    return this.files.list(prefix, after);
  }

  get(key: string): Promise<Uint8Array | undefined> {
    return this.files.get(key);
  }

  head(key: string): Promise<RemoteEntry | undefined> {
    return this.files.head(key);
  }

  async put(key: string, body: Uint8Array, o: PutOptions = {}): Promise<{ etag?: string }> {
    // Compare-and-swap for git: checked against the clone here, and the push is rejected (and the rebase stops on
    // the same file) when another device changed it meanwhile.
    const r = await this.files.put(key, body, o);
    this.dirty = true;
    return r;
  }

  async delete(key: string): Promise<void> {
    await this.files.delete(key);
    this.dirty = true;
  }

  async commit(message: string): Promise<void> {
    if (!this.dirty) {
      return;
    }
    await this.run(['add', '-A', '.']);
    const st = await this.run(['status', '--porcelain']);
    if (!st.stdout.trim()) {
      this.dirty = false;
      return;
    }
    await this.run(['commit', '-q', '--no-verify', '-m', message]);
    const attempts = this.o.attempts ?? 3;
    for (let i = 1; ; i++) {
      const r = await this.run(['push', '-q', 'origin', `HEAD:refs/heads/${this.o.branch}`], { allowFail: true });
      if (!r.code) {
        this.dirty = false;
        return;
      }
      const rejected = /non-fast-forward|fetch first|rejected|failed to push/i.test(r.stderr);
      if (!rejected || i >= attempts) {
        throw gitError(['push'], r);
      }
      // Someone else pushed: replay our commit on theirs (different files, so it always applies).
      await this.run(['fetch', '-q', 'origin', `+refs/heads/${this.o.branch}:refs/remotes/origin/${this.o.branch}`]);
      const rb = await this.run(['rebase', '-q', `origin/${this.o.branch}`], { allowFail: true });
      if (rb.code) {
        await this.run(['rebase', '--abort'], { allowFail: true });
        throw gitError(['rebase'], rb);
      }
    }
  }

  dispose(): void {
    // the clone stays for the next cycle
  }
}

function gitError(args: string[], r: GitResult): BackendError {
  const text = `${r.stderr}\n${r.stdout}`.trim();
  const short = text.split('\n').filter(Boolean).slice(-2).join(' ').slice(0, 300);
  if (/Authentication failed|could not read Username|Permission denied \(publickey|terminal prompts disabled|HTTP Basic: Access denied|invalid credentials|401/i.test(text)) {
    return new BackendError('auth', `git ${args[0]}: sign-in failed (${short})`);
  }
  if (/403|forbidden|not allowed|protected branch/i.test(text)) {
    return new BackendError('forbidden', `git ${args[0]}: ${short}`);
  }
  if (/Could not resolve host|unable to access|Connection refused|Network is unreachable|timed out|Could not read from remote/i.test(text) && !/does not appear to be a git repository|not found/i.test(text)) {
    return new BackendError('offline', `git ${args[0]}: ${short}`);
  }
  if (/does not appear to be a git repository|Repository not found|not found|does not exist/i.test(text)) {
    return new BackendError('not-found', `git ${args[0]}: ${short}`);
  }
  return new BackendError('other', `git ${args[0]} failed: ${short}`);
}

/** The sync repository must not be a project folder: a local path that has a working tree of its own is refused. */
export function refuseProjectRepo(url: string): void {
  const local = /^(file:\/\/|\/|[A-Za-z]:[\\/]|\.{1,2}[\\/]|~)/.test(url) && !/^[\w.-]+@[\w.-]+:/.test(url);
  if (!local) {
    return;
  }
  const p = url.startsWith('file://') ? decodeURIComponent(new URL(url).pathname.replace(/^\/([A-Za-z]:)/, '$1')) : url;
  try {
    if (fs.existsSync(path.join(p, '.git'))) {
      throw new BackendError('other', `${p} is a project's repository (it has a working tree). Use a separate, empty repository for sync.`);
    }
  } catch (e) {
    if (e instanceof BackendError) {
      throw e;
    }
  }
}
