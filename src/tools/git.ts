import * as cp from 'child_process';
import { Tool, ToolContext } from '../types';
import { onAbort } from '../agent/resilience';
import { killTree } from './terminal';
import { rootArg } from './fs';
import { ROOT_PARAM } from './rootPaths';

/**
 * Source control and CI for the agent: inspect and commit with `git`, push, open and follow pull requests and read CI
 * results with the GitHub CLI (`gh`). Every call runs a fixed program with an argument list (no shell), so nothing the
 * model writes in a message or a branch name is interpreted as a command.
 */

interface Run {
  code: number;
  out: string;
  err: string;
}

export function runCmd(cmd: string, args: string[], cwd: string | undefined, signal?: AbortSignal, timeoutMs = 120_000, input?: string): Promise<Run> {
  return new Promise((resolve) => {
    let child: cp.ChildProcess;
    try {
      // Own session/process group (no controlling terminal): ssh and hooks cannot prompt into the CLI, and a kill reaches hooks too.
      child = cp.spawn(cmd, args, { cwd, shell: false, detached: process.platform !== 'win32', windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GH_PROMPT_DISABLED: '1', NO_COLOR: '1', GH_NO_UPDATE_NOTIFIER: '1' } });
    } catch (e) {
      resolve({ code: -1, out: '', err: e instanceof Error ? e.message : String(e) });
      return;
    }
    let out = '';
    let err = '';
    let killed = '';
    let settled = false;
    const finish = (r: Run) => {
      if (!settled) {
        settled = true;
        clearTimeout(t);
        off();
        resolve(killed ? { code: -1, out, err: `${killed}${err.trim() ? `\n${err.trim()}` : ''}` } : r);
      }
    };
    const kill = (reason: string) => {
      if (settled || killed) {
        return;
      }
      killed = reason;
      killTree(child);
      // A grandchild that survived may still hold the pipes open; do not wait for 'close' forever.
      setTimeout(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
        finish({ code: -1, out, err });
      }, 2000).unref?.();
    };
    const t = setTimeout(() => kill(`timed out after ${timeoutMs / 1000}s (hooks may still have been running); nothing was completed`), timeoutMs);
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (d: string) => (out += d));
    child.stderr?.on('data', (d: string) => (err += d));
    const off = onAbort(signal, () => kill('stopped by the user'));
    child.on('error', (e) => finish({ code: -1, out, err: (e as NodeJS.ErrnoException).code === 'ENOENT' ? `${cmd}: command not found` : e.message }));
    child.on('close', (code) => finish({ code: code ?? -1, out, err }));
    if (input !== undefined) {
      child.stdin?.on('error', () => undefined);
      child.stdin?.end(input);
    }
  });
}

/** The repository a call runs in: its `root` argument (a workspace folder or repository name), else the agent's root. */
const rootOf = (ctx: ToolContext, args: Record<string, unknown> = {}) => rootArg(args.root, ctx);
const clip = (s: string, max = 12_000) => (s.length > max ? `${s.slice(0, max)}\n… (${(s.length - max).toLocaleString()} more characters)` : s);
const fail = (r: Run, what: string) => ({ content: `${what} failed (exit ${r.code}): ${(r.err || r.out).trim().slice(0, 2000)}`, isError: true });

/** A safe ref name: what `git check-ref-format --branch` accepts, minus anything that looks like an option. */
export function validBranch(name: string): boolean {
  return /^(?!-)(?!.*\.\.)(?!.*\/\/)(?!.*@\{)[A-Za-z0-9._/-]{1,200}(?<![./])$/.test(name) && !name.endsWith('.lock');
}

const remoteHeads = new Map<string, string | undefined>();

/** The default branch of `remote`: its remote-tracking HEAD if it still exists, else what the remote reports, else main/master. */
export async function defaultBranch(cwd: string, remote = 'origin'): Promise<string | undefined> {
  const head = (await runCmd('git', ['symbolic-ref', '--quiet', `refs/remotes/${remote}/HEAD`], cwd)).out.trim();
  if (head && (await runCmd('git', ['rev-parse', '--verify', '--quiet', head], cwd)).code === 0) {
    return head.replace(`refs/remotes/${remote}/`, '');
  }
  // origin/HEAD is only set by clone and goes stale; ask the remote once per session.
  const cacheKey = `${cwd}\0${remote}`;
  if (!remoteHeads.has(cacheKey)) {
    const r = await runCmd('git', ['ls-remote', '--symref', remote, 'HEAD'], cwd, undefined, 15_000);
    remoteHeads.set(cacheKey, r.code === 0 ? /^ref: refs\/heads\/(\S+)\tHEAD$/m.exec(r.out)?.[1] : undefined);
  }
  const reported = remoteHeads.get(cacheKey);
  if (reported) {
    return reported;
  }
  for (const b of ['main', 'master']) {
    if ((await runCmd('git', ['rev-parse', '--verify', '--quiet', b], cwd)).code === 0) {
      return b;
    }
  }
  return undefined;
}

/** Pure: `paths` as an array, a JSON-array string or a comma/newline-separated string; drops empty and option-like entries. */
export function parsePaths(v: unknown): string[] {
  let list: unknown[] = [];
  if (Array.isArray(v)) {
    list = v;
  } else if (typeof v === 'string' && v.trim()) {
    try {
      const j: unknown = JSON.parse(v);
      list = Array.isArray(j) ? j : v.split(/[,\n]/);
    } catch {
      list = v.split(/[,\n]/);
    }
  }
  return list.map((x) => String(x).trim()).filter((x) => x && !x.startsWith('-'));
}

/** Pure: the approval text for committing everything — new files first, capped at 40 lines. */
export function commitAllPreview(porcelain: string): string {
  const lines = porcelain.split('\n').filter((l) => l.trim());
  const isNew = (l: string) => l.startsWith('??') || l[0] === 'A' || l[1] === 'A';
  const sorted = [...lines.filter(isNew), ...lines.filter((l) => !isNew(l))];
  const shown = sorted.slice(0, 40);
  return ['Stages and commits ALL changes below (including untracked files)', ...shown, ...(sorted.length > shown.length ? [`+${sorted.length - shown.length} more`] : [])].join('\n');
}

export const gitStatusTool: Tool = {
  parallelSafe: true,
  definition: {
    name: 'git_status',
    description:
      'Read the repository state with git: "status" (branch, upstream ahead/behind, staged/unstaged/untracked files), "diff" (unstaged, or staged with staged=true, optionally for one path), "log" (recent commits), "branches". Read-only.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['status', 'diff', 'log', 'branches'] },
        path: { type: 'string', description: 'Limit diff/log to this path' },
        staged: { type: 'boolean', description: 'diff: show what is staged for commit' },
        count: { type: 'integer', description: 'log: number of commits (default 15)' },
        root: ROOT_PARAM,
      },
      required: ['action'],
    },
  },
  async execute(args, ctx) {
    const cwd = rootOf(ctx, args);
    if (!cwd) {
      return { content: 'No workspace folder open.', isError: true };
    }
    const p = typeof args.path === 'string' && args.path.trim() ? ['--', args.path.trim()] : [];
    switch (String(args.action ?? 'status')) {
      case 'diff': {
        const r = await runCmd('git', ['--no-optional-locks', 'diff', '--no-color', '--stat', '--patch', ...(args.staged ? ['--cached'] : []), ...p], cwd, ctx.signal);
        return r.code === 0 ? { content: r.out.trim() ? clip(r.out) : `No ${args.staged ? 'staged' : 'unstaged'} changes.` } : fail(r, 'git diff');
      }
      case 'log': {
        const n = Math.max(1, Math.min(100, Number(args.count) || 15));
        const r = await runCmd('git', ['log', `-${n}`, '--no-color', '--date=short', '--pretty=format:%h %ad %an  %s%d', ...p], cwd, ctx.signal);
        return r.code === 0 ? { content: r.out.trim() || 'No commits yet.' } : fail(r, 'git log');
      }
      case 'branches': {
        const r = await runCmd('git', ['branch', '--all', '--no-color', '--sort=-committerdate', '--format=%(HEAD) %(refname:short) %(upstream:track) %(committerdate:relative)'], cwd, ctx.signal);
        return r.code === 0 ? { content: clip(r.out.trim(), 6000) } : fail(r, 'git branch');
      }
      default: {
        const r = await runCmd('git', ['--no-optional-locks', 'status', '--porcelain=v1', '--branch', '--untracked-files=normal'], cwd, ctx.signal);
        if (r.code !== 0) {
          return fail(r, 'git status');
        }
        const [head, ...files] = r.out.split('\n').filter(Boolean);
        const def = await defaultBranch(cwd);
        return { content: `${head.replace(/^## /, 'Branch: ')}${def ? ` (default branch: ${def})` : ''}\n${files.length ? files.join('\n') : 'Working tree clean.'}` };
      }
    }
  },
};

export const gitCommitTool: Tool = {
  approvalKind: 'write',
  definition: {
    name: 'git_commit',
    description:
      'Commit changes with git. Stages the given paths (or every changed tracked and new file when paths is omitted), optionally on a new branch created from the current HEAD first, and commits with the message. Write a conventional message ("fix: …", "feat: …") describing why. Never amends or rewrites history.',
    parameters: {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'Commit message (first line ≤ 72 chars, blank line, then details)' },
        paths: { type: 'array', items: { type: 'string' }, description: 'Files to stage; omit to stage all changes' },
        branch: { type: 'string', description: 'Create and switch to this new branch before committing' },
        root: ROOT_PARAM,
      },
      required: ['message'],
    },
  },
  async execute(args, ctx) {
    const cwd = rootOf(ctx, args);
    const message = String(args.message ?? '').trim();
    if (!cwd || !message) {
      return { content: cwd ? 'message is required.' : 'No workspace folder open.', isError: true };
    }
    const branch = typeof args.branch === 'string' ? args.branch.trim() : '';
    if (branch && !validBranch(branch)) {
      return { content: `"${branch}" is not a valid branch name (letters, digits, . _ - /; no spaces or "..").`, isError: true };
    }
    const paths = parsePaths(args.paths);
    const status = await runCmd('git', ['--no-optional-locks', 'status', '--porcelain=v1'], cwd, ctx.signal);
    if (status.code !== 0) {
      return fail(status, 'git status');
    }
    if (!status.out.trim()) {
      return { content: 'Nothing to commit: the working tree is clean.' };
    }
    if (!(await ctx.requestApproval(`Commit${branch ? ` on new branch ${branch}` : ''}: ${message.split('\n')[0].slice(0, 70)}`, paths.length ? paths.join('\n') : commitAllPreview(status.out), 'write'))) {
      return { content: 'The user declined the commit. Nothing was committed.', isError: true };
    }
    if (branch) {
      const b = await runCmd('git', ['switch', '-c', branch], cwd, ctx.signal);
      if (b.code !== 0) {
        return fail(b, `git switch -c ${branch}`);
      }
    }
    const add = await runCmd('git', paths.length ? ['add', '--', ...paths] : ['add', '--all'], cwd, ctx.signal);
    if (add.code !== 0) {
      return fail(add, 'git add');
    }
    // --only with paths: files the user staged earlier stay out of this commit.
    const c = await runCmd('git', paths.length ? ['commit', '--only', '--file=-', '--', ...paths] : ['commit', '--file=-'], cwd, ctx.signal, 120_000, `${message}\n`);
    if (c.code !== 0) {
      return fail(c, 'git commit');
    }
    const sha = (await runCmd('git', ['rev-parse', '--short', 'HEAD'], cwd)).out.trim();
    const cur = (await runCmd('git', ['branch', '--show-current'], cwd)).out.trim();
    return { content: `Committed ${sha} on ${cur}: ${message.split('\n')[0]}\n${c.out.trim().split('\n').slice(-3).join('\n')}` };
  },
};

export const gitPushTool: Tool = {
  approvalKind: 'terminal',
  definition: {
    name: 'git_push',
    description: 'Push the current branch to its upstream, or to the remote (origin by default) under the same name and set the upstream. Never force-pushes. Pushing the default branch (main/master) directly is refused unless allow_default_branch is true and the user asked for it — push a feature branch and open a pull request instead.',
    parameters: {
      type: 'object',
      properties: { remote: { type: 'string', description: 'Default origin' }, allow_default_branch: { type: 'boolean' }, root: ROOT_PARAM },
    },
  },
  async execute(args, ctx) {
    const cwd = rootOf(ctx, args);
    if (!cwd) {
      return { content: 'No workspace folder open.', isError: true };
    }
    let remote = typeof args.remote === 'string' && /^[\w.-]+$/.test(args.remote) ? args.remote : 'origin';
    const branch = (await runCmd('git', ['branch', '--show-current'], cwd)).out.trim();
    if (!branch) {
      return { content: 'Not on a branch (detached HEAD); create one with git_commit branch=… first.', isError: true };
    }
    // An existing push destination (e.g. fork/feature) wins over the default remote and the local name.
    let dest = branch;
    let setUpstream = true;
    const push = (await runCmd('git', ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{push}'], cwd)).out.trim();
    const slash = push.indexOf('/');
    if (slash > 0 && (typeof args.remote !== 'string' || args.remote === push.slice(0, slash))) {
      const remotes = (await runCmd('git', ['remote'], cwd)).out.split('\n').map((l) => l.trim());
      if (remotes.includes(push.slice(0, slash)) && validBranch(push.slice(slash + 1))) {
        remote = push.slice(0, slash);
        dest = push.slice(slash + 1);
        setUpstream = false;
      }
    }
    const def = await defaultBranch(cwd, remote);
    const protectedBranch = def ? dest === def : ['main', 'master', 'develop', 'trunk', 'dev'].includes(dest);
    if (protectedBranch && args.allow_default_branch !== true) {
      return { content: `Refused: ${dest} is ${def ? 'the default branch' : 'likely the default branch'} of ${remote}. Commit on a feature branch (git_commit with branch="fix/…") and open a pull request, or pass allow_default_branch=true only if the user explicitly asked to push to ${dest}.`, isError: true };
    }
    const unpushed = await runCmd('git', ['log', '--format=%ae', 'HEAD', '--not', '--remotes'], cwd, ctx.signal);
    if (unpushed.out.split('\n').some((l) => l.trim() === 'localpilot@localhost')) {
      return { content: "Refused: this branch contains LocalPilot's internal worktree snapshot commit (your uncommitted work at the time the isolated copy was made). Apply the changes to the workspace and commit and push from there.", isError: true };
    }
    const pushArgs = ['push', ...(setUpstream ? ['--set-upstream'] : []), remote, `HEAD:refs/heads/${dest}`];
    if (!(await ctx.requestApproval(`Push ${branch} to ${remote}/${dest}`, `git ${pushArgs.join(' ')}`, 'terminal'))) {
      return { content: 'The user declined the push.', isError: true };
    }
    const r = await runCmd('git', pushArgs, cwd, ctx.signal, 180_000);
    if (r.code !== 0 && /Permission denied \(publickey\)|Host key verification failed/.test(r.err)) {
      return { content: `git push failed: SSH could not authenticate without a prompt (${/Host key/.test(r.err) ? 'unknown host key' : 'no usable key'}). Load the key with \`ssh-add\` (or accept the host key) by pushing once in a terminal, then try again.\n${r.err.trim().slice(0, 800)}`, isError: true };
    }
    return r.code === 0 ? { content: `Pushed ${branch} to ${remote}/${dest}.\n${(r.err + r.out).trim().split('\n').filter((l) => !/^remote:\s*$/.test(l)).slice(-6).join('\n')}` } : fail(r, 'git push');
  },
};

const ghMissing = 'The GitHub CLI (gh) is not installed or not signed in. Install it from https://cli.github.com and run `gh auth login`, then try again.';

async function gh(args: string[], ctx: ToolContext, cwd: string | undefined, input?: string): Promise<Run> {
  return runCmd('gh', args, cwd, ctx.signal, 120_000, input);
}
const ghFailed = (r: Run, what: string) =>
  // gh's "no known GitHub host" error also says `gh auth login`; it means a GitLab/Bitbucket remote or an unknown Enterprise host.
  /known GitHub host/i.test(r.err)
    ? { content: 'The git remote does not point to a GitHub host gh knows. pull_request and ci_status support GitHub only; for GitHub Enterprise run `gh auth login --hostname <host>`.', isError: true }
    : /command not found|not logged|gh auth login\b|authentication required/i.test(r.err)
      ? { content: ghMissing, isError: true }
      : fail(r, what);

export const pullRequestTool: Tool = {
  // No approvalKind: view/list stay available in Ask and Plan mode; create/comment ask explicitly and refuse there.
  definition: {
    name: 'pull_request',
    description:
      'GitHub pull requests via the gh CLI. "create": open a PR from the current (pushed) branch — give a clear title and a body with what changed, why, and how it was verified; draft=true for work in progress. "view": a PR\'s state, checks, review decision and latest comments (default: the current branch\'s PR). "list": open PRs. "comment": add a comment. Reading needs no approval; create and comment do.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['create', 'view', 'list', 'comment'] },
        title: { type: 'string' },
        body: { type: 'string' },
        base: { type: 'string', description: 'create: target branch (default: the repository default)' },
        draft: { type: 'boolean' },
        number: { type: 'integer', description: 'PR number for view/comment (default: the current branch\'s PR)' },
        branch: { type: 'string', description: 'view/comment: the PR of this head branch (when number is not given)' },
        root: ROOT_PARAM,
      },
      required: ['action'],
    },
  },
  async execute(args, ctx) {
    const cwd = rootOf(ctx, args);
    const action = String(args.action ?? 'view');
    const prBranch = typeof args.branch === 'string' && validBranch(args.branch.trim()) ? args.branch.trim() : '';
    const num = Number(args.number) > 0 ? [String(Math.floor(Number(args.number)))] : prBranch ? [prBranch] : [];
    const detachedMsg = { content: 'This workspace is on a detached HEAD (isolated copy), so the current branch and its pull request are unknown. Pass number=<PR number> or branch="<name>".', isError: true };
    if ((action === 'view' || action === 'comment') && !num.length && !(await runCmd('git', ['branch', '--show-current'], cwd)).out.trim()) {
      return detachedMsg;
    }
    if (action === 'list') {
      const r = await gh(['pr', 'list', '--limit', '20', '--json', 'number,title,headRefName,author,isDraft,reviewDecision', '--template', '{{range .}}#{{.number}} {{.title}} ({{.headRefName}}, {{.author.login}}{{if .isDraft}}, draft{{end}}{{if .reviewDecision}}, {{.reviewDecision}}{{end}})\n{{end}}'], ctx, cwd);
      return r.code === 0 ? { content: r.out.trim() || 'No open pull requests.' } : ghFailed(r, 'gh pr list');
    }
    if (action === 'view') {
      const r = await gh(['pr', 'view', ...num, '--json', 'number,title,state,isDraft,url,headRefName,baseRefName,reviewDecision,mergeable,statusCheckRollup,comments,reviews'], ctx, cwd);
      if (r.code !== 0) {
        if (/not on any branch/i.test(r.err)) {
          return detachedMsg;
        }
        return /no pull requests found/i.test(r.err) ? { content: 'No pull request for this branch yet. Push it (git_push) and use action "create".' } : ghFailed(r, 'gh pr view');
      }
      return { content: formatPr(JSON.parse(r.out)) };
    }
    if ((action === 'comment' || action === 'create') && ctx.readOnly) {
      return { content: `"${action}" changes GitHub, which this read-only mode does not allow. Switch to Agent mode.`, isError: true };
    }
    if (action === 'comment') {
      const body = String(args.body ?? '').trim();
      if (!body) {
        return { content: 'body is required.', isError: true };
      }
      if (!(await ctx.requestApproval(`Comment on pull request ${num[0] ? (prBranch && num[0] === prBranch ? `of ${prBranch}` : `#${num[0]}`) : 'for this branch'}`, body.slice(0, 600), 'terminal'))) {
        return { content: 'The user declined the comment.', isError: true };
      }
      const r = await gh(['pr', 'comment', ...num, '--body-file', '-'], ctx, cwd, body);
      return r.code === 0 ? { content: `Commented: ${r.out.trim()}` } : /not on any branch/i.test(r.err) ? detachedMsg : ghFailed(r, 'gh pr comment');
    }
    if (action === 'create') {
      const title = String(args.title ?? '').trim();
      const body = String(args.body ?? '').trim();
      if (!title) {
        return { content: 'title is required.', isError: true };
      }
      const base = typeof args.base === 'string' && validBranch(args.base.trim()) ? ['--base', args.base.trim()] : [];
      if (!(await ctx.requestApproval(`Open pull request: ${title.slice(0, 70)}`, body.slice(0, 800) || '(no description)', 'terminal'))) {
        return { content: 'The user declined opening the pull request.', isError: true };
      }
      const r = await gh(['pr', 'create', '--title', title, '--body-file', '-', ...base, ...(args.draft ? ['--draft'] : [])], ctx, cwd, body || ' ');
      if (r.code !== 0) {
        return /must first push|no commits between|has no upstream/i.test(r.err) ? { content: `${r.err.trim()}\nPush the branch with git_push first (and make sure it has commits the base does not).`, isError: true } : ghFailed(r, 'gh pr create');
      }
      return { content: `Opened ${r.out.trim().split('\n').pop()}` };
    }
    return { content: `Unknown action "${action}".`, isError: true };
  },
};

interface PrJson {
  number: number;
  title: string;
  state: string;
  isDraft: boolean;
  url: string;
  headRefName: string;
  baseRefName: string;
  reviewDecision?: string;
  mergeable?: string;
  statusCheckRollup?: { name?: string; context?: string; status?: string; conclusion?: string; state?: string; detailsUrl?: string; workflowName?: string }[];
  comments?: { author?: { login?: string }; body: string }[];
  reviews?: { author?: { login?: string }; state: string; body: string }[];
}

/** Pure: a PR summary that puts failing checks first. */
export function formatPr(p: PrJson): string {
  const checks = (p.statusCheckRollup ?? []).map((c) => ({ name: c.workflowName ? `${c.workflowName} / ${c.name}` : c.name ?? c.context ?? 'check', result: (c.conclusion || c.state || c.status || '').toLowerCase() }));
  const failed = checks.filter((c) => /failure|error|cancelled|timed_out|action_required/.test(c.result));
  const pending = checks.filter((c) => /pending|queued|in_progress|expected|^$/.test(c.result));
  const lines = [
    `#${p.number} ${p.title} — ${p.isDraft ? 'draft, ' : ''}${p.state.toLowerCase()}${p.reviewDecision ? `, ${p.reviewDecision.toLowerCase().replace(/_/g, ' ')}` : ''}${p.mergeable && p.mergeable !== 'UNKNOWN' ? `, ${p.mergeable.toLowerCase()}` : ''}`,
    `${p.headRefName} → ${p.baseRefName}  ${p.url}`,
    checks.length ? `Checks: ${checks.length - failed.length - pending.length} passed, ${failed.length} failed, ${pending.length} pending` : 'Checks: none reported',
    ...failed.map((c) => `  ✖ ${c.name} (${c.result})`),
    ...pending.map((c) => `  … ${c.name}`),
  ];
  const talk = [...(p.reviews ?? []).filter((r) => r.body.trim()).map((r) => `${r.author?.login ?? '?'} (${r.state.toLowerCase()}): ${r.body.trim()}`), ...(p.comments ?? []).map((c) => `${c.author?.login ?? '?'}: ${c.body.trim()}`)];
  if (talk.length) {
    lines.push(`Latest discussion:\n${talk.slice(-6).map((t) => `  ${t.replace(/\s+/g, ' ').slice(0, 400)}`).join('\n')}`);
  }
  if (failed.length) {
    lines.push('Read the failures with ci_status action "logs", reproduce locally, fix, commit and push.');
  }
  return lines.join('\n');
}

export const ciStatusTool: Tool = {
  definition: {
    name: 'ci_status',
    description:
      'GitHub Actions results via the gh CLI. "runs": the latest workflow runs for the current branch (or `branch`) with their conclusions. "logs": the log lines of the failed steps of a run (default: the latest failed run of the branch) — use it to see why CI failed before fixing. "rerun": re-run the failed jobs of a run (asks first).',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['runs', 'logs', 'rerun'] },
        branch: { type: 'string' },
        run_id: { type: 'integer' },
        root: ROOT_PARAM,
      },
      required: ['action'],
    },
  },
  async execute(args, ctx) {
    const cwd = rootOf(ctx, args);
    const action = String(args.action ?? 'runs');
    const branch = typeof args.branch === 'string' && validBranch(args.branch.trim()) ? args.branch.trim() : (await runCmd('git', ['branch', '--show-current'], cwd)).out.trim();
    let runId = Number(args.run_id) > 0 ? String(Math.floor(Number(args.run_id))) : '';
    let header = `Failed steps of run ${runId}`;
    let warning = '';
    let failedJobs: number[] = [];
    if (!branch && (action === 'runs' || !runId)) {
      return { content: 'This workspace is on a detached HEAD (isolated copy), so the current branch is unknown. Pass branch="<name>" or run_id.', isError: true };
    }
    if (action === 'runs' || !runId) {
      const r = await gh(['run', 'list', '--branch', branch, '--limit', '10', '--json', 'databaseId,workflowName,status,conclusion,headSha,headBranch,displayTitle,createdAt,event'], ctx, cwd);
      if (r.code !== 0) {
        return ghFailed(r, 'gh run list');
      }
      const runs = JSON.parse(r.out) as { databaseId: number; workflowName: string; status: string; conclusion: string; headSha: string; headBranch?: string; displayTitle: string; createdAt: string; event: string }[];
      if (action === 'runs') {
        return { content: runs.length ? `Workflow runs${branch ? ` on ${branch}` : ''}:\n${runs.map((x) => `${x.databaseId}  ${x.workflowName}: ${x.status === 'completed' ? x.conclusion : x.status}  ${x.headBranch ? `${x.headBranch} ` : ''}${x.headSha.slice(0, 7)} ${x.displayTitle.slice(0, 60)} (${x.event}, ${x.createdAt.slice(0, 16).replace('T', ' ')})`).join('\n')}` : `No workflow runs${branch ? ` for ${branch}` : ''}.` };
      }
      const isFailed = (c: string | undefined) => /^(failure|timed_out|startup_failure|action_required)$/.test(c ?? '');
      // Prefer the run of the commit being worked on, even while it is still running, over an older failure.
      const shas = (await Promise.all([runCmd('git', ['rev-parse', 'HEAD'], cwd), runCmd('git', ['rev-parse', '@{u}'], cwd)])).filter((x) => x.code === 0).map((x) => x.out.trim());
      let failed: (typeof runs)[number] | undefined;
      let running: (typeof runs)[number] | undefined;
      for (const x of runs.filter((y) => shas.includes(y.headSha))) {
        if (isFailed(x.conclusion)) {
          failed = x;
          break;
        }
        if (x.status !== 'completed') {
          const v = await gh(['run', 'view', String(x.databaseId), '--json', 'jobs'], ctx, cwd);
          const jobs = v.code === 0 ? ((JSON.parse(v.out) as { jobs?: { databaseId: number; conclusion?: string }[] }).jobs ?? []) : [];
          const bad = jobs.filter((j) => isFailed(j.conclusion)).map((j) => j.databaseId);
          if (bad.length) {
            failedJobs = bad;
            failed = x;
            break;
          }
          running ??= x;
        }
      }
      failed ??= runs.find((x) => isFailed(x.conclusion));
      if (!failed) {
        return { content: runs.length ? `No failed run among the latest ${runs.length}${branch ? ` on ${branch}` : ''}: ${runs.slice(0, 3).map((x) => `${x.workflowName} ${x.status === 'completed' ? x.conclusion : x.status}`).join(', ')}.` : 'No workflow runs to read.' };
      }
      runId = String(failed.databaseId);
      header = `Failed steps of run ${runId} (${failed.workflowName}, ${failed.headSha.slice(0, 7)}, ${failed.createdAt.slice(0, 16).replace('T', ' ')})`;
      if (!shas.includes(failed.headSha)) {
        warning = `Warning: this run is for an older commit, not ${shas[0]?.slice(0, 7) ?? 'HEAD'}${running ? `; run ${running.databaseId} (${running.workflowName}) for the current commit is still in progress` : ''}.\n`;
      } else if (failed.status !== 'completed') {
        warning = 'The run is still in progress: some jobs are still running.\n';
      }
    }
    if (action === 'rerun') {
      if (ctx.readOnly) {
        return { content: 'Re-running CI is not allowed in this read-only mode. Switch to Agent mode.', isError: true };
      }
      if (!(await ctx.requestApproval(`Re-run failed jobs of run ${runId}`, `gh run rerun ${runId} --failed`, 'terminal'))) {
        return { content: 'The user declined the re-run.', isError: true };
      }
      const r = await gh(['run', 'rerun', runId, '--failed'], ctx, cwd);
      return r.code === 0 ? { content: `Re-running the failed jobs of run ${runId}. Check again with ci_status "runs" in a few minutes.` } : ghFailed(r, 'gh run rerun');
    }
    // An unfinished run has no run-level log yet; its finished failed jobs do.
    const logs = await Promise.all((failedJobs.length ? failedJobs.slice(0, 3).map((j) => ['--job', String(j)]) : [[runId]]).map((sel) => gh(['run', 'view', ...sel, '--log-failed'], ctx, cwd)));
    const r = logs.find((x) => x.code !== 0);
    if (r) {
      return ghFailed(r, 'gh run view --log-failed');
    }
    return { content: `${header}:\n${warning}${summarizeFailedLog(logs.map((x) => x.out).join('\n'))}` };
  },
};

/**
 * Pure: the useful part of `gh run view --log-failed` (lines are `job<TAB>step<TAB>timestamp text`). Keeps the error
 * lines and their context per job/step, drops timestamps and the setup noise, and caps the size for the model.
 */
export function summarizeFailedLog(raw: string, maxChars = 10_000): string {
  const groups = new Map<string, string[]>();
  for (const line of raw.split('\n')) {
    const m = /^([^\t]+)\t([^\t]+)\t(?:\d{4}-\d\d-\d\dT[\d:.]+Z )?(.*)$/.exec(line);
    if (!m) {
      continue;
    }
    const key = `${m[1]} › ${m[2]}`;
    const list = groups.get(key) ?? [];
    list.push(m[3]);
    groups.set(key, list);
  }
  // Real failure markers only: a passing check that merely mentions "error" in its name must not be kept.
  const ERR = /##\[error\]|✖|✗|\bFAIL(ED)?\b|\b(Error|ERROR|AssertionError|TypeError|SyntaxError|Exception)\b[:\s]|\berror( TS\d+)?:|\bfailing\b|\d+ check\(s\) FAILED|Traceback|panic:|exit code [1-9]|npm ERR!|expected .* (to|but)/;
  const PASS = /✔|✓|\bPASS\b|\bok\b \d/;
  const parts: string[] = [];
  for (const [key, lines] of groups) {
    const keep = new Set<number>();
    lines.forEach((l, i) => {
      if (ERR.test(l) && !PASS.test(l)) {
        for (let k = Math.max(0, i - 3); k <= Math.min(lines.length - 1, i + 3); k++) {
          keep.add(k);
        }
      }
    });
    // No recognisable error line: the tail is the best guess.
    const idx = keep.size ? [...keep].sort((a, b) => a - b) : lines.map((_, i) => i).slice(-25);
    const body: string[] = [];
    idx.forEach((i, n) => {
      if (n && i !== idx[n - 1] + 1) {
        body.push('  …');
      }
      body.push(`  ${lines[i].replace(/\x1b\[[0-9;]*m/g, '').slice(0, 400)}`);
    });
    parts.push(`## ${key}\n${body.join('\n')}`);
  }
  const text = parts.join('\n\n') || raw.trim().slice(-maxChars);
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n… (cut)` : text;
}

export const gitTools: Tool[] = [gitStatusTool, gitCommitTool, gitPushTool, pullRequestTool, ciStatusTool];
