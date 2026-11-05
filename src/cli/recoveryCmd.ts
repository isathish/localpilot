import { isTerminalPhase, type RecoveryState, type RecoveryStore } from '../agent/healing';
import { SessionSummary } from '../types';
import { Style } from './providers';
import { attemptOf, stateDetail, stateRow } from './recoveryRender';
import { findSession, newestFirst } from './sessions';

export interface RecoveryCmdContext {
  store: RecoveryStore;
  /** Saved sessions of this folder: the command only lists and clears their states. */
  sessions: SessionSummary[];
  /** M of "attempt N/M". */
  budget: (state: RecoveryState) => number;
  style: Style;
  json?: boolean;
  out?: NodeJS.WritableStream;
  err?: NodeJS.WritableStream;
}

export interface RecoveryCmdResult {
  code: number;
  /** `recovery resume <id>`: the session to continue with a resume turn (main runs it), and the guidance sent with it. */
  resume?: string;
  guidance?: string;
}

export const RECOVERY_CMD_USAGE = 'usage: localpilot recovery list | show <id> | resume <id> ["guidance"] | clear [id]';

/** States worth listing: still running or interrupted, or ended incomplete / blocked. */
export function needsAttention(s: RecoveryState): boolean {
  return (!isTerminalPhase(s.phase) && s.phase !== 'idle') || s.phase === 'incomplete' || s.phase === 'blocked';
}

/** A stored recovery worth resuming: interrupted or still open, or ended incomplete / blocked with its intervention open. */
export function resumableRecovery(s: RecoveryState): boolean {
  if (!isTerminalPhase(s.phase)) {
    return s.phase !== 'idle';
  }
  return (s.phase === 'incomplete' || s.phase === 'blocked') && !!s.intervention && !s.intervention.resolvedAt;
}

/** Whether another live process holds the session's owner lock (its recovery is running there). Never keeps a lock it took. */
export async function heldElsewhere(store: RecoveryStore, sid: string): Promise<boolean> {
  if (store.isOwned(sid)) {
    return false;
  }
  const held = (await store.acquire(sid)) === 'readonly';
  await store.release(sid);
  return held;
}

/** Why a state cannot be resumed, or undefined when it can. */
export function notResumable(s: RecoveryState): string | undefined {
  if (resumableRecovery(s)) {
    return undefined;
  }
  if (s.phase === 'completed' || s.phase === 'completed_unverified') {
    return `the last task ended ${s.phase === 'completed' ? 'verified' : 'unverified'}; nothing to resume`;
  }
  if (s.phase === 'incomplete' || s.phase === 'blocked') {
    return `the recovery ended ${s.phase} and its intervention was already handled; nothing to resume`;
  }
  return `the recovery is ${s.phase}; nothing to resume`;
}

/** `localpilot recovery list|show <id>|resume <id>|clear [id]`; exit code 2 on bad usage or an unknown session. */
export async function cmdRecovery(words: string[], ctx: RecoveryCmdContext): Promise<RecoveryCmdResult> {
  const st = ctx.style;
  const out = ctx.out ?? process.stdout;
  const err = ctx.err ?? process.stderr;
  const say = (t: string) => out.write(`${t}\n`);
  const usage = (msg?: string): RecoveryCmdResult => {
    err.write(`${st.red('✖')} ${msg ?? RECOVERY_CMD_USAGE}${msg ? `\n${st.dim(RECOVERY_CMD_USAGE)}` : ''}\n`);
    return { code: 2 };
  };
  const [action = 'list', ref, ...rest] = words;
  const ids = new Set(ctx.sessions.map((s) => s.id));
  // A run that died without closing its state is shown (and resumable) as interrupted.
  await ctx.store.scanUnfinished();
  const mine = async (): Promise<RecoveryState[]> => (await ctx.store.listStates()).filter((s) => ids.has(s.sessionId));
  /** A session by list number, id or unique prefix, else a state id as stored. */
  const resolve = async (r: string): Promise<{ state?: RecoveryState; error?: string }> => {
    const hit = findSession(newestFirst(ctx.sessions), r);
    if (hit.ambiguous) {
      return { error: `"${r}" matches ${hit.ambiguous.length} sessions — use more of the id` };
    }
    const sid = hit.session?.id ?? r;
    const state = await ctx.store.load(sid);
    return state ? { state } : { error: hit.session ? `session ${sid} has no self-healing state` : `no session or recovery state "${r}" (localpilot recovery list)` };
  };
  switch (action) {
    case 'list': case 'ls': {
      if (ref) {
        return usage(`recovery list takes no arguments (got "${ref}")`);
      }
      const states = (await mine()).filter(needsAttention);
      if (ctx.json) {
        say(JSON.stringify(states.map((s) => ({
          sessionId: s.sessionId, phase: s.phase, outcome: s.outcome, attempt: attemptOf(s), max: ctx.budget(s),
          category: s.attempts[s.attempts.length - 1]?.category ?? s.active[0]?.category, title: s.intervention?.title, rootCause: s.intervention?.rootCause,
          updatedAt: new Date(s.updatedAt).toISOString(),
        })), null, 2));
        return { code: 0 };
      }
      if (!states.length) {
        say(st.dim('No interrupted, incomplete or blocked recoveries in this folder.'));
        return { code: 0 };
      }
      say(states.map((s) => stateRow(s, ctx.budget(s), st)).join('\n'));
      say(st.dim('localpilot recovery show <id> for details · recovery resume <id> to continue · recovery clear [id] to forget'));
      return { code: 0 };
    }
    case 'show': {
      if (!ref || rest.length) {
        return usage(ref ? `recovery show takes one id (got "${[ref, ...rest].join(' ')}")` : 'recovery show needs a session id');
      }
      const r = await resolve(ref);
      if (!r.state) {
        return usage(r.error);
      }
      say(ctx.json ? JSON.stringify(r.state, null, 2) : stateDetail(r.state, ctx.budget(r.state), st).join('\n'));
      return { code: 0 };
    }
    case 'resume': {
      if (!ref) {
        return usage('recovery resume needs a session id');
      }
      const r = await resolve(ref);
      if (!r.state) {
        return usage(r.error);
      }
      if (!ids.has(r.state.sessionId)) {
        return usage(`session ${r.state.sessionId} is not saved in this folder; run it from its own folder (-C <dir>)`);
      }
      const why = notResumable(r.state);
      if (why) {
        say(st.dim(`${r.state.sessionId}: ${why}`));
        return { code: 0 };
      }
      if (await heldElsewhere(ctx.store, r.state.sessionId)) {
        err.write(`${st.yellow('!')} the recovery of ${r.state.sessionId} is running in another window; resume it there or wait for it to finish\n`);
        return { code: 1 };
      }
      return { code: 0, resume: r.state.sessionId, ...(rest.length ? { guidance: rest.join(' ') } : {}) };
    }
    case 'clear': case 'rm': {
      if (rest.length) {
        return usage(`recovery clear takes at most one id (got "${[ref, ...rest].join(' ')}")`);
      }
      const targets: RecoveryState[] = [];
      if (ref) {
        const r = await resolve(ref);
        if (!r.state) {
          return usage(r.error);
        }
        targets.push(r.state);
      } else {
        targets.push(...(await mine()).filter((s) => isTerminalPhase(s.phase)));
      }
      let cleared = 0;
      const busy: string[] = [];
      for (const s of targets) {
        if ((await ctx.store.acquire(s.sessionId)) === 'readonly') {
          await ctx.store.release(s.sessionId);
          busy.push(s.sessionId);
          continue;
        }
        await ctx.store.deleteSession(s.sessionId);
        cleared++;
      }
      if (busy.length) {
        err.write(`${st.yellow('!')} still running in another window, not cleared: ${busy.join(', ')}\n`);
      }
      say(cleared ? st.dim(`cleared ${cleared} recovery state${cleared === 1 ? '' : 's'}`) : st.dim(ref ? 'nothing cleared' : 'no finished recovery states in this folder'));
      return { code: busy.length && !cleared ? 1 : 0 };
    }
    default:
      return usage(`unknown recovery action "${action}"`);
  }
}
