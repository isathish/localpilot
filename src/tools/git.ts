import * as cp from 'child_process';
import * as vscode from 'vscode';
import { Tool, ToolContext } from '../types';

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
      child = cp.spawn(cmd, args, { cwd, shell: false, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GH_PROMPT_DISABLED: '1', NO_COLOR: '1', GH_NO_UPDATE_NOTIFIER: '1' } });
    } catch (e) {
      resolve({ code: -1, out: '', err: e instanceof Error ? e.message : String(e) });
      return;
    }
    let out = '';
    let err = '';
    const t = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout?.on('data', (d) => (out += d.toString()));
    child.stderr?.on('data', (d) => (err += d.toString()));
    signal?.addEventListener('abort', () => child.kill('SIGKILL'), { once: true });
    child.on('error', (e) => {
      clearTimeout(t);
      resolve({ code: -1, out, err: (e as NodeJS.ErrnoException).code === 'ENOENT' ? `${cmd}: command not found` : e.message });
    });
    child.on('close', (code) => {
      clearTimeout(t);
      resolve({ code: code ?? -1, out, err });
    });
    if (input !== undefined) {
      child.stdin?.end(input);
    }
  });
}

const rootOf = (ctx: ToolContext) => ctx.workspaceRoot ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
const clip = (s: string, max = 12_000) => (s.length > max ? `${s.slice(0, max)}\n… (${(s.length - max).toLocaleString()} more characters)` : s);
const fail = (r: Run, what: string) => ({ content: `${what} failed (exit ${r.code}): ${(r.err || r.out).trim().slice(0, 2000)}`, isError: true });

/** A safe ref name: what `git check-ref-format --branch` accepts, minus anything that looks like an option. */
export function validBranch(name: string): boolean {
  return /^(?!-)(?!.*\.\.)(?!.*\/\/)(?!.*@\{)[A-Za-z0-9._/-]{1,200}(?<![./])$/.test(name) && !name.endsWith('.lock');
}

/** The default branch (origin/HEAD, else main/master if they exist). */
export async function defaultBranch(cwd: string): Promise<string | undefined> {
  const head = await runCmd('git', ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], cwd);
  if (head.code === 0 && head.out.trim()) {
    return head.out.trim().replace(/^origin\//, '');
  }
  for (const b of ['main', 'master']) {
    if ((await runCmd('git', ['rev-parse', '--verify', '--quiet', b], cwd)).code === 0) {
      return b;
    }
  }
  return undefined;
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
      },
      required: ['action'],
    },
  },
  async execute(args, ctx) {
    const cwd = rootOf(ctx);
    if (!cwd) {
      return { content: 'No workspace folder open.', isError: true };
    }
    const p = typeof args.path === 'string' && args.path.trim() ? ['--', args.path.trim()] : [];
    switch (String(args.action ?? 'status')) {
      case 'diff': {
        const r = await runCmd('git', ['diff', '--no-color', '--stat', '--patch', ...(args.staged ? ['--cached'] : []), ...p], cwd, ctx.signal);
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
        const r = await runCmd('git', ['status', '--porcelain=v1', '--branch', '--untracked-files=normal'], cwd, ctx.signal);
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
      },
      required: ['message'],
    },
  },
  async execute(args, ctx) {
    const cwd = rootOf(ctx);
    const message = String(args.message ?? '').trim();
    if (!cwd || !message) {
      return { content: cwd ? 'message is required.' : 'No workspace folder open.', isError: true };
    }
    const branch = typeof args.branch === 'string' ? args.branch.trim() : '';
    if (branch && !validBranch(branch)) {
      return { content: `"${branch}" is not a valid branch name (letters, digits, . _ - /; no spaces or "..").`, isError: true };
    }
    const paths = Array.isArray(args.paths) ? args.paths.map(String).filter((x) => x.trim() && !x.startsWith('-')) : [];
    const status = await runCmd('git', ['status', '--porcelain=v1'], cwd, ctx.signal);
    if (status.code !== 0) {
      return fail(status, 'git status');
    }
    if (!status.out.trim()) {
      return { content: 'Nothing to commit: the working tree is clean.' };
    }
    if (!(await ctx.requestApproval(`Commit${branch ? ` on new branch ${branch}` : ''}: ${message.split('\n')[0].slice(0, 70)}`, `${paths.length ? paths.join('\n') : status.out.trim().split('\n').slice(0, 30).join('\n')}`, 'write'))) {
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
    const c = await runCmd('git', ['commit', '--file=-'], cwd, ctx.signal, 120_000, `${message}\n`);
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
    description: 'Push the current branch to its remote (origin by default) and set the upstream. Never force-pushes. Pushing the default branch (main/master) directly is refused unless allow_default_branch is true and the user asked for it — push a feature branch and open a pull request instead.',
    parameters: {
      type: 'object',
      properties: { remote: { type: 'string', description: 'Default origin' }, allow_default_branch: { type: 'boolean' } },
    },
  },
  async execute(args, ctx) {
    const cwd = rootOf(ctx);
    if (!cwd) {
      return { content: 'No workspace folder open.', isError: true };
    }
    const remote = typeof args.remote === 'string' && /^[\w.-]+$/.test(args.remote) ? args.remote : 'origin';
    const branch = (await runCmd('git', ['branch', '--show-current'], cwd)).out.trim();
    if (!branch) {
      return { content: 'Not on a branch (detached HEAD); create one with git_commit branch=… first.', isError: true };
    }
    const def = await defaultBranch(cwd);
    if (branch === def && args.allow_default_branch !== true) {
      return { content: `Refused: ${branch} is the default branch. Commit on a feature branch (git_commit with branch="fix/…") and open a pull request, or pass allow_default_branch=true only if the user explicitly asked to push to ${branch}.`, isError: true };
    }
    if (!(await ctx.requestApproval(`Push ${branch} to ${remote}`, `git push --set-upstream ${remote} ${branch}`, 'terminal'))) {
      return { content: 'The user declined the push.', isError: true };
    }
    const r = await runCmd('git', ['push', '--set-upstream', remote, branch], cwd, ctx.signal, 180_000);
    return r.code === 0 ? { content: `Pushed ${branch} to ${remote}.\n${(r.err + r.out).trim().split('\n').filter((l) => !/^remote:\s*$/.test(l)).slice(-6).join('\n')}` } : fail(r, 'git push');
  },
};

const ghMissing = 'The GitHub CLI (gh) is not installed or not signed in. Install it from https://cli.github.com and run `gh auth login`, then try again.';

async function gh(args: string[], ctx: ToolContext, input?: string): Promise<Run> {
  return runCmd('gh', args, rootOf(ctx), ctx.signal, 120_000, input);
}
const ghFailed = (r: Run, what: string) => (/command not found|not logged|auth login|authentication/i.test(r.err) ? { content: ghMissing, isError: true } : fail(r, what));

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
      },
      required: ['action'],
    },
  },
  async execute(args, ctx) {
    const action = String(args.action ?? 'view');
    const num = Number(args.number) > 0 ? [String(Math.floor(Number(args.number)))] : [];
    if (action === 'list') {
      const r = await gh(['pr', 'list', '--limit', '20', '--json', 'number,title,headRefName,author,isDraft,reviewDecision', '--template', '{{range .}}#{{.number}} {{.title}} ({{.headRefName}}, {{.author.login}}{{if .isDraft}}, draft{{end}}{{if .reviewDecision}}, {{.reviewDecision}}{{end}})\n{{end}}'], ctx);
      return r.code === 0 ? { content: r.out.trim() || 'No open pull requests.' } : ghFailed(r, 'gh pr list');
    }
    if (action === 'view') {
      const r = await gh(['pr', 'view', ...num, '--json', 'number,title,state,isDraft,url,headRefName,baseRefName,reviewDecision,mergeable,statusCheckRollup,comments,reviews'], ctx);
      if (r.code !== 0) {
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
      if (!(await ctx.requestApproval(`Comment on pull request ${num[0] ? `#${num[0]}` : 'for this branch'}`, body.slice(0, 600), 'terminal'))) {
        return { content: 'The user declined the comment.', isError: true };
      }
      const r = await gh(['pr', 'comment', ...num, '--body-file', '-'], ctx, body);
      return r.code === 0 ? { content: `Commented: ${r.out.trim()}` } : ghFailed(r, 'gh pr comment');
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
      const r = await gh(['pr', 'create', '--title', title, '--body-file', '-', ...base, ...(args.draft ? ['--draft'] : [])], ctx, body || ' ');
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
      },
      required: ['action'],
    },
  },
  async execute(args, ctx) {
    const cwd = rootOf(ctx);
    const action = String(args.action ?? 'runs');
    const branch = typeof args.branch === 'string' && validBranch(args.branch.trim()) ? args.branch.trim() : (await runCmd('git', ['branch', '--show-current'], cwd)).out.trim();
    let runId = Number(args.run_id) > 0 ? String(Math.floor(Number(args.run_id))) : '';
    if (action === 'runs' || !runId) {
      const r = await gh(['run', 'list', ...(branch ? ['--branch', branch] : []), '--limit', '10', '--json', 'databaseId,workflowName,status,conclusion,headSha,displayTitle,createdAt,event'], ctx);
      if (r.code !== 0) {
        return ghFailed(r, 'gh run list');
      }
      const runs = JSON.parse(r.out) as { databaseId: number; workflowName: string; status: string; conclusion: string; headSha: string; displayTitle: string; createdAt: string; event: string }[];
      if (action === 'runs') {
        return { content: runs.length ? `Workflow runs${branch ? ` on ${branch}` : ''}:\n${runs.map((x) => `${x.databaseId}  ${x.workflowName}: ${x.status === 'completed' ? x.conclusion : x.status}  ${x.headSha.slice(0, 7)} ${x.displayTitle.slice(0, 60)} (${x.event}, ${x.createdAt.slice(0, 16).replace('T', ' ')})`).join('\n')}` : `No workflow runs${branch ? ` for ${branch}` : ''}.` };
      }
      const failed = runs.find((x) => x.conclusion === 'failure');
      if (!failed) {
        return { content: runs.length ? `No failed run among the latest ${runs.length}${branch ? ` on ${branch}` : ''}: ${runs.slice(0, 3).map((x) => `${x.workflowName} ${x.status === 'completed' ? x.conclusion : x.status}`).join(', ')}.` : 'No workflow runs to read.' };
      }
      runId = String(failed.databaseId);
    }
    if (action === 'rerun') {
      if (ctx.readOnly) {
        return { content: 'Re-running CI is not allowed in this read-only mode. Switch to Agent mode.', isError: true };
      }
      if (!(await ctx.requestApproval(`Re-run failed jobs of run ${runId}`, `gh run rerun ${runId} --failed`, 'terminal'))) {
        return { content: 'The user declined the re-run.', isError: true };
      }
      const r = await gh(['run', 'rerun', runId, '--failed'], ctx);
      return r.code === 0 ? { content: `Re-running the failed jobs of run ${runId}. Check again with ci_status "runs" in a few minutes.` } : ghFailed(r, 'gh run rerun');
    }
    const r = await gh(['run', 'view', runId, '--log-failed'], ctx);
    if (r.code !== 0) {
      return ghFailed(r, 'gh run view --log-failed');
    }
    return { content: `Failed steps of run ${runId}:\n${summarizeFailedLog(r.out)}` };
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
