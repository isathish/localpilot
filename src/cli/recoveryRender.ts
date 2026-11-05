import { isTerminalPhase, type AttemptRecord, type CheckStatus, type NextAction, type RecoveryEventPayload, type RecoveryState, type TaskOutcome } from '../agent/healing/types';
import { Style } from './providers';
import { ageLabel } from './sessions';

/** Terminal rendering of self-healing (design §9.5): event notes, the end-of-turn outcome block and stored states. */

/** The text sent for a resume turn (`/recovery resume`, `localpilot recovery resume <id>`). */
export const RESUME_PROMPT = 'Continue the interrupted task. LocalPilot will first re-run the checks.';

const HEADINGS: Record<TaskOutcome, string> = {
  completed: 'Completed',
  completed_unverified: 'Not verified',
  incomplete: 'Incomplete',
  blocked: 'Blocked',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

const RESULT_TEXT: Record<string, string> = {
  fixed: 'fixed', not_fixed: 'not fixed', worse: 'made it worse', rolled_back: 'rolled back', duplicate: 'same error again', blocked: 'blocked',
};

/** Phase as a few words: `interrupted`, `fixing`, `rolling back`. */
export function phaseLabel(phase: string): string {
  return isTerminalPhase(phase as TaskOutcome) ? HEADINGS[phase as TaskOutcome].toLowerCase() : phase.replace(/_/g, ' ');
}

/** One line per distinct command: `/recovery resume  # Resume / Approve install`. */
export function nextCommandLines(actions: readonly NextAction[] | undefined): string[] {
  const byCommand = new Map<string, string[]>();
  for (const a of actions ?? []) {
    if (a.command) {
      byCommand.set(a.command, [...(byCommand.get(a.command) ?? []), a.label]);
    }
  }
  return [...byCommand].map(([command, labels]) => `${command}  # ${labels.join(' / ')}`);
}

/** `✓ typecheck 4.1s ✗ test 12.0s ⏱ lint – security`. */
export function checkChips(checks: readonly { id: string; status: string; ms?: number }[], st: Style): string {
  const icon = (s: string) => (s === 'passed' ? st.green('✓') : s === 'failed' ? st.red('✗') : s === 'timeout' ? st.yellow('⏱') : st.dim('–'));
  const name = (id: string) => id.replace(/^(?:npm|pnpm|yarn|bun|make|cargo|go|custom):/, '');
  return checks.map((c) => `${icon(c.status)} ${name(c.id)}${typeof c.ms === 'number' ? st.dim(` ${(c.ms / 1000).toFixed(1)}s`) : ''}${c.status === 'skipped' || c.status === 'timeout' ? st.dim(` ${c.status}`) : ''}`).join(' ');
}

/**
 * Notes for `recovery` events. The engine re-emits the card on every transition, so only what changed is printed:
 * the attempt line (attempt, title, root cause, decision), the check chips and rolled-back files. Terminal phases print
 * nothing here; the outcome block at the end of the turn reports them.
 */
export class RecoveryNotes {
  private readonly seen = new Map<string, { head?: string; checks?: string; rolled?: string }>();

  constructor(private readonly st: Style) {}

  lines(p: RecoveryEventPayload): string[] {
    const st = this.st;
    const prev = this.seen.get(p.id) ?? {};
    const out: string[] = [];
    if (!isTerminalPhase(p.phase)) {
      const count = p.attempt ? ` ${p.attempt}${p.max ? `/${p.max}` : ''}` : '';
      const cause = p.rootCause ? ` — root cause: ${p.rootCause}` : '';
      const what = p.decision ?? phaseLabel(p.phase);
      const head = `⟲ self-healing${count} · ${p.title}${cause}${what ? st.dim(` (${what})`) : ''}`;
      if (head !== prev.head) {
        out.push(head);
        prev.head = head;
      }
    }
    const done = (p.checks ?? []).filter((c) => c.status !== 'running' && c.status !== 'pending');
    const checks = done.length ? `  ${checkChips(done, st)}` : undefined;
    if (checks && checks !== prev.checks) {
      out.push(checks);
      prev.checks = checks;
    }
    const rolled = (p.patches ?? []).filter((x) => x.result === 'rolled_back').map((x) => x.file);
    const rolledKey = rolled.join('\n');
    if (rolled.length && rolledKey !== prev.rolled) {
      out.push(`  ↶ rolled back ${rolled.join(', ')}`);
      prev.rolled = rolledKey;
    }
    this.seen.set(p.id, prev);
    return out;
  }

  reset(): void {
    this.seen.clear();
  }
}

export interface OutcomeInfo {
  outcome?: TaskOutcome | string;
  /** The engine's deterministic report (`Incomplete: … Root cause: … Next: …`, or `Verified: …`). */
  report?: string;
  nextActions?: readonly NextAction[];
}

/**
 * The end-of-turn block: `Incomplete:` in red / `Blocked:` in yellow with the report and the next commands, `Not
 * verified` in amber, a verified footer in green. Nothing for cancelled turns or turns without an outcome.
 */
export function outcomeBlock(o: OutcomeInfo, st: Style): string[] {
  const outcome = o.outcome as TaskOutcome | undefined;
  if (!outcome || outcome === 'cancelled') {
    return [];
  }
  const report = (o.report ?? '').trim().split('\n').map((l) => l.trimEnd()).filter(Boolean);
  if (outcome === 'completed') {
    return report.length ? report.map((l, i) => (i ? st.dim(`  ${l}`) : `${st.green('✓')} ${st.dim(l)}`)) : [];
  }
  const color = outcome === 'blocked' || outcome === 'completed_unverified' ? (outcome === 'blocked' ? st.yellow : st.amber) : st.red;
  const heading = HEADINGS[outcome] ?? outcome;
  const lines = report.length ? [...report] : [`${heading}.`];
  if (!lines[0].toLowerCase().startsWith(heading.toLowerCase())) {
    lines.unshift(`${heading}:`);
  }
  const out = lines.map((l, i) => (i === 0 ? st.bold(color(l)) : /^Next:/.test(l) ? l : st.dim(l)));
  const cmds = nextCommandLines(o.nextActions);
  if (cmds.length) {
    out.push(st.dim('Commands:'), ...cmds.map((c) => `  ${st.cyan(c.replace(/ {2}#.*$/, ''))}${st.dim(c.slice(c.replace(/ {2}#.*$/, '').length))}`));
  }
  return out;
}

/** Default next steps for a state without an intervention record (an interrupted run). */
export function stateNextActions(state: RecoveryState, inRepl: boolean): NextAction[] {
  if (state.intervention && !state.intervention.resolvedAt && state.intervention.nextActions.length) {
    return state.intervention.nextActions;
  }
  if (isTerminalPhase(state.phase) && state.phase !== 'incomplete' && state.phase !== 'blocked') {
    return [];
  }
  const sid = state.sessionId;
  return [
    { action: 'resume', label: 'Resume (re-runs the checks first)', command: inRepl ? '/recovery resume' : `localpilot recovery resume ${sid}` },
    { action: 'rollback', label: 'Rollback fixes', command: inRepl ? '/recovery rollback' : `localpilot -r ${sid}, then /recovery rollback` },
    { action: 'dismiss', label: 'Dismiss', command: inRepl ? '/recovery dismiss' : `localpilot recovery clear ${sid}` },
  ];
}

/** Attempt N of the state's current category (the open attempt counts). */
export function attemptOf(state: Pick<RecoveryState, 'attempts' | 'perCategory'>): number {
  const last = state.attempts[state.attempts.length - 1];
  if (!last) {
    return 0;
  }
  return (state.perCategory[last.category] ?? 0) + (last.result ? 0 : 1);
}

function title(state: RecoveryState): string {
  if (state.intervention?.title) {
    return state.intervention.title;
  }
  const f = state.active.find((x) => !x.preexisting && !x.foreign) ?? state.active[0];
  if (f) {
    return `${f.category}${f.code ? ` ${f.code}` : ''}${f.file ? ` in ${f.file}${f.line ? `:${f.line}` : ''}` : ''}`;
  }
  return state.attempts[state.attempts.length - 1]?.category ?? 'no open failures';
}

function rootCause(state: RecoveryState): string | undefined {
  return state.intervention?.rootCause ?? [...state.attempts].reverse().find((a) => a.rootCause)?.rootCause;
}

/** A stored state in detail (`-c`, `/recovery status`, `recovery show`): phase, attempt N/M, category, failures, root cause, next commands. */
export function stateDetail(state: RecoveryState, max: number, st: Style, opts: { inRepl?: boolean; now?: number } = {}): string[] {
  const n = attemptOf(state);
  const last = state.attempts[state.attempts.length - 1];
  const category = last?.category ?? state.active[0]?.category;
  const label = state.phase === 'interrupted' ? 'Recovery interrupted' : isTerminalPhase(state.phase) ? `Recovery ${HEADINGS[state.phase].toLowerCase()}` : `Recovery ${phaseLabel(state.phase)}`;
  const color = state.phase === 'incomplete' || state.phase === 'failed' ? st.red : state.phase === 'blocked' || state.phase === 'interrupted' ? st.yellow : state.phase === 'completed' ? st.green : st.amber;
  const meta = [n ? `attempt ${n}/${Math.max(max, n)}` : undefined, category, ageLabel(state.updatedAt, opts.now)].filter(Boolean).join(' · ');
  const out = [`${color('⟲')} ${st.bold(label)} ${st.dim(`· ${meta} · ${state.sessionId}`)}`, `  ${title(state)}`];
  const cause = rootCause(state);
  if (cause) {
    out.push(`  ${st.dim('Root cause:')} ${cause}`);
  }
  const open = state.active.filter((f) => !f.preexisting && !f.foreign);
  for (const f of open.slice(0, 3)) {
    out.push(`  ${st.red('✗')} ${f.code ? `${f.code} ` : ''}${f.file ? `${f.file}${f.line ? `:${f.line}` : ''} ` : ''}${st.dim(f.message.slice(0, 140))}`);
  }
  if (open.length > 3) {
    out.push(st.dim(`  … ${open.length - 3} more`));
  }
  if (state.pendingAction && state.pendingAction.status !== 'done' && state.pendingAction.status !== 'declined') {
    out.push(`  ${st.dim('Pending:')} ${state.pendingAction.kind}${state.pendingAction.command ? ` \`${state.pendingAction.command}\`` : ''} (${state.pendingAction.status}${state.pendingAction.status === 'started' ? ', not rerun on resume' : ''})`);
  }
  const cmds = nextCommandLines(stateNextActions(state, !!opts.inRepl));
  if (cmds.length) {
    out.push(`  ${st.dim('Next:')}`, ...cmds.map((c) => `    ${st.cyan(c.replace(/ {2}#.*$/, ''))}${st.dim(c.slice(c.replace(/ {2}#.*$/, '').length))}`));
  }
  return out;
}

/** One row of `localpilot recovery list`. */
export function stateRow(state: RecoveryState, max: number, st: Style, now?: number): string {
  const n = attemptOf(state);
  const phase = phaseLabel(state.phase);
  const color = state.phase === 'incomplete' || state.phase === 'failed' ? st.red : state.phase === 'blocked' || state.phase === 'interrupted' ? st.yellow : st.dim;
  const meta = [n ? `attempt ${n}/${Math.max(max, n)}` : undefined, ageLabel(state.updatedAt, now)].filter(Boolean).join(' · ');
  return `  ${state.sessionId}  ${color(phase.padEnd(12))} ${title(state)}  ${st.dim(meta)}`;
}

/** Past attempts of a state (`/recovery history`). */
export function attemptLines(attempts: readonly AttemptRecord[], st: Style): string[] {
  if (!attempts.length) {
    return [st.dim('no fix attempts yet')];
  }
  const out: string[] = [];
  for (const a of attempts) {
    const secs = a.endedAt ? st.dim(` ${Math.max(0, Math.round((a.endedAt - a.startedAt) / 1000))}s`) : '';
    const result = a.result ? RESULT_TEXT[a.result] ?? a.result : 'in progress';
    const color = a.result === 'fixed' ? st.green : a.result ? st.red : st.amber;
    out.push(`  ${st.amber(String(a.n))}. ${a.category} · ${a.strategy}${a.mode === 'delegate' ? ' (workers)' : ''} · ${color(result)}${secs}`);
    if (a.rootCause) {
      out.push(`     ${st.dim('root cause:')} ${a.rootCause}`);
    }
    for (const p of a.patches) {
      const text = `${p.file} ${st.green(`+${p.added}`)} ${st.red(`−${p.removed}`)}`;
      out.push(`     ${p.result === 'rolled_back' ? st.dim(`↶ ${p.file} (rolled back)`) : text}`);
    }
  }
  return out;
}

/** Check statuses from the state's cache (`/recovery status`). */
export function cachedChecks(state: RecoveryState): { id: string; status: CheckStatus }[] {
  return Object.entries(state.checks).map(([id, c]) => ({ id, status: c.status }));
}
