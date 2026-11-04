import { execFile } from 'child_process';
import { ALL_MODES, Session, SessionUsage } from '../types';
import { Style } from './providers';

export interface StatusParts {
  model: string;
  mode: Session['mode'];
  /** Context in use, 0–100; undefined when the model's window is unknown. */
  ctxPercent?: number;
  git?: GitState;
  auto: boolean;
  costUsd?: number;
}

export interface GitState {
  branch: string;
  added: number;
  removed: number;
}

/** `$0.02`, `$1.40`, `<$0.01` for a cost that rounds to nothing; undefined without one. */
export function formatCost(usd: number | undefined): string | undefined {
  if (usd === undefined || !Number.isFinite(usd)) {
    return undefined;
  }
  if (usd > 0 && usd < 0.005) {
    return '<$0.01';
  }
  return `$${usd.toFixed(2)}`;
}

/** The dim line above each REPL prompt: `model · mode · ctx 34% · main +3 −1 · auto:off · $0.02`. */
export function statusLineText(p: StatusParts): string {
  const cost = formatCost(p.costUsd);
  return [
    p.model,
    p.mode,
    p.ctxPercent !== undefined ? `ctx ${p.ctxPercent}%` : '',
    p.git ? `${p.git.branch}${p.git.added || p.git.removed ? ` +${p.git.added} −${p.git.removed}` : ''}` : '',
    `auto:${p.auto ? 'on' : 'off'}`,
    cost ?? '',
  ].filter(Boolean).join(' · ');
}

/** Sums `git diff --numstat` output (binary files count as nothing). */
export function sumNumstat(out: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of out.split('\n')) {
    const m = /^(\d+)\t(\d+)\t/.exec(line);
    if (m) {
      added += Number(m[1]);
      removed += Number(m[2]);
    }
  }
  return { added, removed };
}

function git(cwd: string, args: string[]): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile('git', ['-C', cwd, ...args], { timeout: 1500, maxBuffer: 4 * 1024 * 1024, windowsHide: true }, (err, stdout) => resolve(err ? undefined : stdout));
  });
}

/** Branch (or short commit when detached) and uncommitted line counts; undefined outside a git repository. */
export async function gitState(cwd: string): Promise<GitState | undefined> {
  const branch = (await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']))?.trim();
  if (!branch) {
    return undefined;
  }
  const name = branch === 'HEAD' ? ((await git(cwd, ['rev-parse', '--short', 'HEAD']))?.trim() ?? 'HEAD') : branch;
  const diff = await git(cwd, ['diff', '--numstat', 'HEAD']);
  return { branch: name, ...sumNumstat(diff ?? '') };
}

/** The mode after `mode` for Shift+Tab (wraps around). */
export function nextMode(mode: Session['mode']): Session['mode'] {
  const i = ALL_MODES.indexOf(mode);
  return ALL_MODES[(i + 1) % ALL_MODES.length];
}

/** Total tokens of a chat's usage (input, cached input and output). */
export function usageTokens(u: SessionUsage | undefined): number {
  return u ? u.promptTokens + u.cacheReadTokens + u.cacheWriteTokens + u.completionTokens : 0;
}

/** What the REPL prints when it ends: session id, messages, tokens, cost, and how to resume. */
export function exitSummary(s: Pick<Session, 'id' | 'messages' | 'usage'>, st: Style): string {
  if (!s.messages.length) {
    return st.dim('bye');
  }
  const tokens = usageTokens(s.usage);
  const cost = formatCost(s.usage?.costUsd);
  const parts = [`session ${s.id}`, `${s.messages.length} message${s.messages.length === 1 ? '' : 's'}`, tokens ? `${tokens.toLocaleString()} tokens` : '', cost ?? ''].filter(Boolean);
  return `${st.dim(parts.join(' · '))}\n${st.dim('resume with')} localpilot -r ${s.id} ${st.dim('(or localpilot -c)')}`;
}
