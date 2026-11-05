import * as crypto from 'crypto';
import type {
  AttemptRecord, AttemptResult, EscalationReason, Failure, FailureCategory, InterventionRecord, NextAction, PatchRecord,
  RecoveryActionKind, RecoveryState, Severity, TaskOutcome,
} from './types';
import { SEVERITIES } from './types';

/** Escalation Manager (design §11): intervention records, the chat report and the next actions. Pure. */

export const EVIDENCE_MAX = 2048;
const ROOT_CAUSE_MAX = 300;
const TRIED_ITEM_MAX = 90;

export interface EscalationContext {
  now: number;
  /** Defaults to a stable hash of session, turn, reason and time. */
  id?: string;
  /** The failure the report is about; defaults to the most severe active (non-preexisting first) failure. */
  failure?: Failure;
  /** Failing check command line (`npm test`). */
  command?: string;
  /** Overrides the root cause taken from the latest attempt. */
  rootCause?: string;
  /** Attempt budget of the failure's category (`exhausted`). */
  budget?: number;
  /** `healing.maxTotalAttempts`; when reached, `exhausted` names the total budget instead. */
  maxTotalAttempts?: number;
  /** `healing.taskDeadlineMinutes` (`deadline`); derived from the state when absent. */
  deadlineMinutes?: number;
  /** Model and recovery steps used (`loop`). */
  steps?: { model: number; recovery: number };
  /** Consecutive mistakes (`mistake_limit`). */
  mistakes?: number;
  /** The task ran without anyone to ask (queue / unattended CLI). */
  unattended?: boolean;
  /** Install command waiting for approval (`approval_needed`). */
  installCommand?: string;
  /** Free-form reason: the model's `Blocked:` text, the provider error, the security finding. */
  detail?: string;
  model?: string;
  /** Provider id for `localpilot providers key <id>`. */
  provider?: string;
  /** Conflicted files (`git_conflict`) or files the user edited (`user_edit_conflict`). */
  files?: string[];
  /** Replaces the default `Next:` sentence. */
  next?: string;
  taskId?: string;
}

const BLOCKED: readonly EscalationReason[] = ['approval_needed', 'credentials', 'git_conflict', 'security', 'model_blocked', 'data_corruption'];

export function outcomeFor(reason: EscalationReason): TaskOutcome {
  if (BLOCKED.includes(reason)) {return 'blocked';}
  if (reason === 'model_unavailable') {return 'failed';}
  return 'incomplete';
}

const ACTION_LABELS: Record<RecoveryActionKind, string> = {
  resume: 'Resume',
  retryWithGuidance: 'Retry with guidance',
  approveInstall: 'Approve install',
  installManually: 'Install manually and Resume',
  rollback: 'Rollback all fixes',
  restoreCheckpoint: 'Restore checkpoint',
  openMergeEditor: 'Open merge editor',
  acceptRisk: 'Accept risk (user only, audited)',
  setApiKey: 'Set API key',
  pickModel: 'Pick another model',
  startServer: 'Start server',
  retry: 'Retry',
  inspect: 'Inspect manually',
  openChat: 'Open chat',
  dismiss: 'Dismiss',
};

const ACTIONS_BY_REASON: Record<EscalationReason, RecoveryActionKind[]> = {
  approval_needed: ['approveInstall', 'resume'],
  git_conflict: ['openMergeEditor', 'resume'],
  security: ['resume', 'acceptRisk'],
  credentials: ['setApiKey', 'pickModel'],
  data_corruption: ['restoreCheckpoint', 'dismiss'],
  model_unavailable: ['retry', 'startServer'],
  exhausted: ['retryWithGuidance', 'resume', 'rollback', 'dismiss'],
  duplicate: ['retryWithGuidance', 'resume', 'rollback', 'dismiss'],
  deadline: ['retryWithGuidance', 'resume', 'rollback', 'dismiss'],
  loop: ['retryWithGuidance', 'resume', 'rollback', 'dismiss'],
  mistake_limit: ['retryWithGuidance', 'resume', 'rollback', 'dismiss'],
  model_blocked: ['retryWithGuidance', 'resume', 'rollback', 'dismiss'],
  user_edit_conflict: ['retryWithGuidance', 'resume', 'rollback', 'dismiss'],
};

/** Reason-specific labels that differ from the generic ones. */
const LABEL_OVERRIDES: Partial<Record<EscalationReason, Partial<Record<RecoveryActionKind, string>>>> = {
  approval_needed: { resume: 'Install manually and Resume' },
  git_conflict: { resume: 'Resume after resolving (your changes are preserved)' },
  security: { resume: 'Remediate (Resume)' },
  data_corruption: { dismiss: 'Inspect manually and dismiss (no automatic writes)' },
};

/** Ids `localpilot -r` accepts (src/cli/main.ts); anything else falls back to `-c` (latest session). */
const RESUMABLE_ID = /^(?:cli-|s_)[0-9a-z]+$/i;

/** `next` mirrors the optional InterventionRecord field so reports rebuilt from the persisted record keep it. */
type RecordWithNext = InterventionRecord & { next?: string };

function actionCommand(kind: RecoveryActionKind, sessionId: string, ctx: Pick<EscalationContext, 'provider'>): string | undefined {
  switch (kind) {
    case 'resume':
    case 'approveInstall':
    case 'installManually':
      return '/recovery resume';
    case 'retryWithGuidance':
      return RESUMABLE_ID.test(sessionId) ? `localpilot -r ${sessionId} "<your guidance>"` : 'localpilot -c "<your guidance>"';
    case 'rollback':
      return '/recovery rollback';
    case 'restoreCheckpoint':
      return '/undo';
    case 'openMergeEditor':
      return 'git status';
    case 'setApiKey':
      return ctx.provider ? `localpilot providers key ${ctx.provider}` : 'localpilot providers';
    case 'pickModel':
      return '/model';
    case 'startServer':
      return 'localpilot providers';
    case 'retry':
      return RESUMABLE_ID.test(sessionId) ? `localpilot -r ${sessionId}` : 'localpilot -c';
    case 'dismiss':
      return `localpilot recovery clear ${sessionId}`;
    case 'inspect':
      return `localpilot recovery show ${sessionId}`;
    default:
      return undefined;
  }
}

export function nextActionsFor(reason: EscalationReason, sessionId: string, ctx: Pick<EscalationContext, 'provider'> = {}): NextAction[] {
  return ACTIONS_BY_REASON[reason].map((action) => {
    const command = actionCommand(action, sessionId, ctx);
    return { action, label: LABEL_OVERRIDES[reason]?.[action] ?? ACTION_LABELS[action], ...(command ? { command } : {}) };
  });
}

const sevRank = (s: Severity): number => SEVERITIES.indexOf(s);

function topFailure(state: RecoveryState): Failure | undefined {
  let best: Failure | undefined;
  for (const f of state.active) {
    if (!best) { best = f; continue; }
    const better = (!!best.preexisting && !f.preexisting) || (!!best.preexisting === !!f.preexisting && sevRank(f.severity) > sevRank(best.severity));
    if (better) {best = f;}
  }
  return best;
}

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function location(f: Failure | undefined): string | undefined {
  if (!f?.file) {return undefined;}
  return f.line ? `${f.file}:${f.line}` : f.file;
}

function describeFailure(f: Failure | undefined): string | undefined {
  if (!f) {return undefined;}
  const where = location(f);
  return [f.category, f.code, where ? `in ${where}` : undefined].filter(Boolean).join(' ');
}

const RESULT_TEXT: Record<AttemptResult, string> = {
  fixed: 'fixed',
  not_fixed: 'not fixed',
  worse: 'made it worse',
  rolled_back: 'made it worse, reverted',
  duplicate: 'same error',
  blocked: 'blocked',
};

export function attemptsSummary(attempts: readonly AttemptRecord[]): string {
  return attempts
    .map((a, i) => `${i + 1}) ${oneLine(a.rootCause || a.strategy, TRIED_ITEM_MAX)} (${a.result ? RESULT_TEXT[a.result] : 'unfinished'})`)
    .join(' ');
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function deadlineMinutes(state: RecoveryState, ctx: EscalationContext): number | undefined {
  if (ctx.deadlineMinutes !== undefined) {return ctx.deadlineMinutes;}
  if (state.deadlineAt === undefined) {return undefined;}
  const start = state.recoveryStartedAt ?? state.startedAt;
  return Math.round((state.deadlineAt - start) / 60_000);
}

function categoryAttempts(state: RecoveryState, category: FailureCategory | undefined): number {
  if (!category) {return state.attempts.length;}
  return state.perCategory[category] ?? state.attempts.filter((a) => a.category === category).length;
}

function title(state: RecoveryState, reason: EscalationReason, f: Failure | undefined, category: FailureCategory | undefined, ctx: EscalationContext): string {
  const what = ctx.command ? `\`${ctx.command}\`` : describeFailure(f) ?? (category ? `the ${category} failure` : 'the task');
  const failing = ctx.command ? `${what} still fails` : `${what} is still failing`;
  const files = ctx.files?.length ? ctx.files.join(', ') : undefined;
  const detail = ctx.detail ? oneLine(ctx.detail, 160) : undefined;
  const model = ctx.model ? ` (${ctx.model})` : '';
  switch (reason) {
    case 'exhausted': {
      const n = categoryAttempts(state, category);
      const total = state.attempts.length;
      if (ctx.maxTotalAttempts !== undefined && total >= ctx.maxTotalAttempts) {
        return `${failing} after ${plural(total, 'fix attempt')} (total budget: ${ctx.maxTotalAttempts})`;
      }
      const budget = ctx.budget ?? n;
      return `${failing} after ${plural(n, 'fix attempt')} (budget for ${category ?? 'this failure'}: ${budget})`;
    }
    case 'duplicate':
      return `${failing} with the same error after ${plural(categoryAttempts(state, category), 'fix attempt')}`;
    case 'deadline': {
      const m = deadlineMinutes(state, ctx);
      return `recovery deadline${m !== undefined ? ` of ${m} min` : ''} reached while ${failing}`;
    }
    case 'loop':
      return ctx.steps
        ? `stopped: ${plural(ctx.steps.model, 'model step')} + ${plural(ctx.steps.recovery, 'recovery step')} used`
        : 'stopped: the step budget was used up';
    case 'mistake_limit':
      return `stopped after ${ctx.mistakes !== undefined ? plural(ctx.mistakes, 'consecutive tool mistake') : 'too many consecutive tool mistakes'}`;
    case 'approval_needed': {
      const cmd = ctx.installCommand ? `\`${ctx.installCommand}\`` : 'the dependency install';
      return ctx.unattended
        ? `${cmd} needs approval; the install was not attempted because the task ran unattended`
        : `${cmd} needs approval and was not approved`;
    }
    case 'credentials':
      return `the model provider rejected the credentials${model}${detail ? `: ${detail}` : ''}`;
    case 'git_conflict':
      return `git conflict${files ? ` in ${files}` : ''} needs review; your changes were preserved`;
    case 'security':
      return `a security finding blocks completion${detail ? `: ${detail}` : f ? `: ${describeFailure(f)}` : ''}`;
    case 'data_corruption':
      return `data corruption detected${detail ? ` (${detail})` : f ? ` (${oneLine(f.message, 160)})` : ''}; stopped without writing files`;
    case 'model_blocked':
      return `the model reported it is blocked${detail ? `: ${detail}` : ''}`;
    case 'user_edit_conflict':
      return `${files ?? 'a file'} changed outside the agent during a fix, so the fix was not rolled back`;
    case 'model_unavailable':
      return `the model server is unavailable${model}${detail ? `: ${detail}` : ''}`;
  }
}

function nextText(reason: EscalationReason, ctx: EscalationContext): string {
  if (ctx.next) {return ctx.next;}
  switch (reason) {
    case 'approval_needed':
      return ctx.installCommand
        ? `approve the install, or run \`${ctx.installCommand}\` yourself and "Resume".`
        : 'approve the install, or install it yourself and "Resume".';
    case 'git_conflict':
      return 'resolve the conflict in the merge editor, then "Resume". LocalPilot does not touch conflicted files.';
    case 'security':
      return '"Resume" to remediate, or accept the risk yourself (audited).';
    case 'credentials':
      return 'set the API key for the provider, or pick another model.';
    case 'data_corruption':
      return 'restore the checkpoint or inspect the data manually. No automatic writes were made.';
    case 'model_unavailable':
      return 'start the model server, then "Retry".';
    case 'model_blocked':
      return 'answer the question above, then reply with that, or "Resume" to try again with your guidance.';
    case 'user_edit_conflict':
      return 'check your edits, then reply with guidance, or "Resume" to try again.';
    default:
      return 'reply with guidance on the root cause, or "Resume" to try again with your guidance; "Rollback" undoes the fixes.';
  }
}

export function buildIntervention(state: RecoveryState, reason: EscalationReason, ctx: EscalationContext): InterventionRecord {
  const f = ctx.failure ?? topFailure(state);
  const last = state.attempts[state.attempts.length - 1];
  const category = f?.category ?? last?.category;
  const lastCause = [...state.attempts].reverse().find((a) => a.rootCause)?.rootCause;
  const cause = ctx.rootCause ?? lastCause;
  const where = location(f);
  const rootCause = cause
    ? oneLine(where && !cause.includes(f!.file!) ? `${cause} (${where})` : cause, ROOT_CAUSE_MAX)
    : undefined;
  const patches: PatchRecord[] = state.attempts.flatMap((a) => a.patches);
  const id = ctx.id ?? `int_${crypto.createHash('sha1').update(`${state.sessionId}|${state.turnKey}|${reason}|${ctx.now}|${state.attempts.length}`).digest('hex').slice(0, 12)}`;
  const evidence = f?.evidence ? f.evidence.trim().slice(0, EVIDENCE_MAX) : undefined;
  const taskId = ctx.taskId ?? state.taskId;
  const record: RecordWithNext = {
    id,
    sessionId: state.sessionId,
    ...(taskId ? { taskId } : {}),
    reason,
    ...(category ? { category } : {}),
    title: title(state, reason, f, category, ctx),
    ...(rootCause ? { rootCause } : {}),
    ...(evidence ? { evidence } : {}),
    attemptsSummary: attemptsSummary(state.attempts),
    patches,
    nextActions: nextActionsFor(reason, state.sessionId, ctx),
    next: nextText(reason, ctx),
    createdAt: ctx.now,
  };
  return record;
}

const HEADINGS: Record<TaskOutcome, string> = {
  completed: 'Completed',
  completed_unverified: 'Not verified',
  incomplete: 'Incomplete',
  blocked: 'Blocked',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

/** Chat text of an escalation (design §11 style). `ctx.next` / installCommand override the record's stored `Next:` line. */
export function report(state: RecoveryState, intervention: InterventionRecord, ctx: Pick<EscalationContext, 'next' | 'installCommand'> = {}): string {
  const heading = HEADINGS[outcomeFor(intervention.reason)];
  const t = intervention.title;
  const lines = [`${heading}: ${t.charAt(0).toUpperCase()}${t.slice(1)}.`];
  if (intervention.rootCause) {lines.push(`Root cause: ${intervention.rootCause}`);}
  const tried = intervention.attemptsSummary || attemptsSummary(state.attempts);
  if (tried) {lines.push(`Tried: ${tried}.`);}
  const next = ctx.next ?? (intervention as RecordWithNext).next ?? nextText(intervention.reason, { now: intervention.createdAt, ...ctx });
  lines.push(`Next: ${next}`);
  return lines.join('\n');
}

/** CLI lines for the intervention's actions, one per distinct command: `/recovery resume  # Resume`. */
export function cliNextCommands(intervention: InterventionRecord): string[] {
  const byCommand = new Map<string, string[]>();
  for (const a of intervention.nextActions) {
    if (!a.command) {continue;}
    const labels = byCommand.get(a.command) ?? [];
    labels.push(a.label);
    byCommand.set(a.command, labels);
  }
  return [...byCommand].map(([command, labels]) => `${command}  # ${labels.join(' / ')}`);
}
