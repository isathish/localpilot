import * as cp from 'child_process';
import * as vscode from 'vscode';
import { getConfig } from '../config';
import { ParallelPool } from '../agent/parallel';
import { findRepo, listRepos, RepoInfo } from '../agent/repos';
import { Tool, ToolContext } from '../types';
import { runCmd } from './git';
import { onAbort } from '../agent/resilience';

/** The repositories in reach of this run (see agent/repos.ts). */
export function reposFor(ctx: Pick<ToolContext, 'workspaceRoot'>): RepoInfo[] {
  const folders = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
  return listRepos(ctx.workspaceRoot ?? folders[0], folders, getConfig().repos);
}

const tail = (s: string, lines = 30) => {
  const all = s.trimEnd().split('\n');
  return all.length > lines ? `… (${all.length - lines} earlier lines)\n${all.slice(-lines).join('\n')}` : all.join('\n');
};

function shell(command: string, cwd: string, signal: AbortSignal, timeoutMs: number): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const child = cp.spawn(command, { cwd, shell: true, env: { ...process.env, CI: '1', GIT_TERMINAL_PROMPT: '0' } });
    let out = '';
    const t = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', (d) => (out += d.toString()));
    child.stderr.on('data', (d) => (out += d.toString()));
    const off = onAbort(signal, () => child.kill('SIGKILL'));
    child.on('close', off);
    child.on('error', (e) => {
      clearTimeout(t);
      resolve({ code: -1, out: e.message });
    });
    child.on('close', (code) => {
      clearTimeout(t);
      resolve({ code: code ?? -1, out });
    });
  });
}

export const reposTool: Tool = {
  definition: {
    name: 'repos',
    description:
      'Work across several repositories (the folders of a multi-root workspace and those in .localpilot/repos.json). "list": each repository with its path, branch and uncommitted changes. "search": find text in all of them (or `repos`). "exec": run one shell command in each listed repository, such as tests or `git pull` (asks first). ' +
      'Files in these repositories can also be read and edited directly with paths relative to this workspace (e.g. "../api/server.js", as listed). To change code in several repositories, call run_parallel_subagents with one task per repository and set each task\'s "repo" to the repository name: the subagent works inside that repository with every tool, and the tasks run at the same time.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'search', 'exec'] },
        repos: { type: 'array', items: { type: 'string' }, description: 'Repository names (default: all)' },
        query: { type: 'string', description: 'search: text or regular expression' },
        command: { type: 'string', description: 'exec: shell command run in each repository' },
      },
      required: ['action'],
    },
  },
  async execute(args, ctx) {
    const all = reposFor(ctx);
    if (!all.length) {
      return { content: 'No repositories: open a folder (or a multi-root workspace), or list them in .localpilot/repos.json as { "repos": { "api": "../api" } }.', isError: true };
    }
    const names = Array.isArray(args.repos) ? args.repos.map(String) : [];
    const unknown = names.filter((n) => !findRepo(all, n));
    if (unknown.length) {
      return { content: `Unknown repositor${unknown.length === 1 ? 'y' : 'ies'}: ${unknown.join(', ')}. Known: ${all.map((r) => r.name).join(', ')}.`, isError: true };
    }
    const chosen = names.length ? names.map((n) => findRepo(all, n)!) : all;
    const pool = new ParallelPool(4);
    switch (String(args.action ?? 'list')) {
      case 'list': {
        const rows = await pool.map(chosen, async (r) => {
          const st = await runCmd('git', ['status', '--porcelain=v1', '--branch'], r.path, ctx.signal, 20_000);
          if (st.code !== 0) {
            return `${r.name}  ${r.path}  (not a git repository)`;
          }
          const [head, ...files] = st.out.split('\n').filter(Boolean);
          return `${r.name}  ${r.path}  ${head.replace(/^## /, '')}${files.length ? `  · ${files.length} changed` : '  · clean'}${r.source !== 'workspace' ? `  (${r.source})` : ''}`;
        });
        return { content: rows.map((x) => (x.status === 'fulfilled' ? x.value : String(x.reason))).join('\n') };
      }
      case 'search': {
        const q = String(args.query ?? '').trim();
        if (!q) {
          return { content: 'query is required.', isError: true };
        }
        const rows = await pool.map(chosen, async (r) => {
          const g = await runCmd('git', ['grep', '-n', '-I', '-E', '--max-count=20', '-e', q], r.path, ctx.signal, 60_000);
          return g.code === 0 ? `## ${r.name}\n${tail(g.out, 40)}` : g.code === 1 ? '' : `## ${r.name}\n(search failed: ${g.err.trim().slice(0, 160)})`;
        });
        const hits = rows.map((x) => (x.status === 'fulfilled' ? x.value : '')).filter(Boolean);
        return { content: hits.length ? hits.join('\n\n') : `No matches for /${q}/ in ${chosen.map((r) => r.name).join(', ')}.` };
      }
      case 'exec': {
        const command = String(args.command ?? '').trim();
        if (!command) {
          return { content: 'command is required.', isError: true };
        }
        if (ctx.readOnly) {
          return { content: 'Running commands is not allowed in this read-only mode.', isError: true };
        }
        if (!(await ctx.requestApproval(`Run in ${chosen.length} repositor${chosen.length === 1 ? 'y' : 'ies'}: ${command.slice(0, 80)}`, chosen.map((r) => `${r.name}: ${r.path}`).join('\n'), 'terminal'))) {
          return { content: 'The user declined running the command.', isError: true };
        }
        ctx.progress(`Running "${command}" in ${chosen.map((r) => r.name).join(', ')}…`);
        const rows = await pool.map(chosen, async (r) => ({ r, res: await shell(command, r.path, ctx.signal, 10 * 60_000) }));
        const out = rows.map((x, i) => (x.status === 'fulfilled' ? `## ${x.value.r.name} — exit ${x.value.res.code}\n${tail(x.value.res.out) || '(no output)'}` : `## ${chosen[i].name}\n${String(x.reason)}`));
        const failed = rows.filter((x) => x.status !== 'fulfilled' || x.value.res.code !== 0).length;
        return { content: `${failed ? `${failed} of ${chosen.length} failed.` : `All ${chosen.length} succeeded.`}\n\n${out.join('\n\n')}`, isError: failed === chosen.length };
      }
    }
    return { content: `Unknown action "${String(args.action)}".`, isError: true };
  },
};
