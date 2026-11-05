import type { HealingService, RecoveryState, RecoveryStore } from '../../agent/healing';
import { Style } from '../providers';
import { heldElsewhere, notResumable } from '../recoveryCmd';
import { attemptLines, cachedChecks, checkChips, stateDetail } from '../recoveryRender';

export interface RecoverySlashContext {
  service: HealingService;
  store: RecoveryStore;
  /** The REPL's chat id. */
  sessionId: () => string;
  /** Where the session works (its worktree, or the start folder): rollbacks restore files there. */
  root: () => string;
  /** M of "attempt N/M" for a state. */
  budget: (state: RecoveryState) => number;
  /** Runs the resume turn (checks first, then fix / complete / escalate); `guidance` is sent with it. */
  resume: (guidance?: string) => Promise<void>;
  style: Style;
  out?: NodeJS.WritableStream;
}

export const RECOVERY_USAGE = '/recovery [status|resume [guidance]|rollback [attempt]|history|dismiss]';

/** `/recovery status|resume|rollback [attempt]|history|dismiss` in the REPL. Returns false for any other command. */
export async function recoverySlash(cmd: string, arg: string, ctx: RecoverySlashContext): Promise<boolean> {
  if (cmd !== 'recovery') {
    return false;
  }
  const st = ctx.style;
  const out = ctx.out ?? process.stdout;
  const say = (t: string) => out.write(`${t}\n`);
  const [action = 'status', ...rest] = arg.split(/\s+/).filter(Boolean);
  const more = rest.join(' ').trim();
  const sid = ctx.sessionId();
  const state = await ctx.store.load(sid);
  switch (action) {
    case 'status': {
      if (!state) {
        say(st.dim('no self-healing state for this session yet'));
        return true;
      }
      say(stateDetail(state, ctx.budget(state), st, { inRepl: true }).join('\n'));
      const checks = cachedChecks(state);
      if (checks.length) {
        say(`  ${st.dim('Checks:')} ${checkChips(checks, st)}`);
      }
      return true;
    }
    case 'history': {
      if (!state) {
        say(st.dim('no self-healing state for this session yet'));
        return true;
      }
      say(attemptLines(state.attempts, st).join('\n'));
      return true;
    }
    case 'resume': {
      if (!state) {
        say(st.dim('nothing to resume: this session has no recovery state'));
        return true;
      }
      const why = notResumable(state);
      if (why) {
        say(st.dim(why));
        return true;
      }
      if (await heldElsewhere(ctx.store, sid)) {
        say(st.red('cannot resume: the recovery is running in another window'));
        return true;
      }
      await ctx.resume(more || undefined);
      return true;
    }
    case 'rollback': {
      if (more && !/^\d+$/.test(more)) {
        say(st.red(`usage: /recovery rollback [attempt]  (got "${more}")`));
        return true;
      }
      if (!state?.attempts.length) {
        say(st.dim('no fix attempts to roll back'));
        return true;
      }
      const attempt = more ? Number(more) : undefined;
      if (attempt !== undefined && !state.attempts.some((a) => a.n === attempt)) {
        say(st.red(`no attempt ${attempt} — /recovery history lists them`));
        return true;
      }
      const r = await ctx.service.rollback(sid, attempt, ctx.root());
      if (r.restored.length) {
        say(st.yellow(`rolled back ${r.restored.length} file${r.restored.length === 1 ? '' : 's'}${attempt ? ` (attempt ${attempt} and later)` : ''}: ${r.restored.join(', ')}`));
      } else {
        say(st.dim('nothing was rolled back'));
      }
      if (r.skipped.length) {
        say(st.dim(`kept: ${r.skipped.map((x) => `${x.file} (${x.reason === 'user_edited' ? 'edited by you since' : x.reason === 'error' ? x.detail ?? 'error' : 'unknown original'})`).join(', ')}`));
      }
      return true;
    }
    case 'dismiss': {
      if (!state) {
        say(st.dim('nothing to dismiss'));
        return true;
      }
      say((await ctx.service.dismiss(sid)) ? st.dim('recovery dismissed') : st.red('could not dismiss: the recovery is running in another window'));
      return true;
    }
    default:
      say(st.dim(`usage: ${RECOVERY_USAGE}`));
      return true;
  }
}
