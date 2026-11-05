import { ModelFailure, retryDelayMs } from '../resilience';
import { attemptCap } from './policy';
import { Decision, EscalationReason, Failure, FixMode, RecoveryState, ResourceAdjustment, RetryPolicy, SEVERITIES, Severity } from './types';

/** Retry Controller (design §4.3): one pure decision per observed failure. Clock and randomness are injected. */

const MAX_DELAY_MS = 60_000;
const JITTER = 0.2;

/** What a replacement model must match: the turn's tool protocol, its image input, and local vs. remote. */
export interface RerouteRequirement {
  protocol: 'native' | 'text';
  vision: boolean;
  locality: 'local' | 'remote';
}

/** A resource change the loop applies before the retry; the loop picks the reroute target among matching models. */
export type AdjustmentPlan = Exclude<ResourceAdjustment, { kind: 'reroute' }> | { kind: 'reroute'; require: RerouteRequirement };

/** How the controller settled a fix attempt that never reached validation. */
export interface Settled {
  result: 'not_fixed' | 'duplicate';
  /** Always false: no check rerun for these attempts. */
  validate: false;
}

export type RetryDecision = (
  | Exclude<Decision, { action: 'retry' } | { action: 'fix' } | { action: 'ignore' }>
  | { action: 'retry'; delayMs: number; adjust?: AdjustmentPlan }
  /** `raiseSeverity`: the signature survived one fix already; the prompt says so and drops the memory suggestion used. */
  | { action: 'fix'; attempt: number; max: number; mode: FixMode; raiseSeverity?: Severity }
  | { action: 'ignore'; why: 'preexisting' | 'foreign' | 'non_required' }
) & { settled?: Settled };

export interface DecideContext {
  now: number;
  /** Recovery deadline; only enforced while a recovery attempt is active. */
  deadlineAt?: number;
  recoveryActive: boolean;
  /** `healing.maxTotalAttempts`. */
  totalCap: number;
  /** `healing.delegateFixes`, depth 0, `parallel.maxConcurrency > 1` and not in ask/plan mode. */
  delegateAllowed: boolean;
  /** Failure groups with disjoint files and no import edge between them. */
  independentGroups: number;
  signal?: AbortSignal;
  /** False for a failure of a non-required check. */
  required?: boolean;
  /** `healing.maxRepairAttempts`; also applied by `effectivePolicies`. */
  maxRepairAttempts?: number;
  random?: () => number;
  /** The model failure behind a model_* failure, and its error (server-directed rate-limit waits). */
  modelFailure?: ModelFailure;
  error?: unknown;
  /** A fix attempt that just ended and is not yet recorded in `state`; one with a new patch is validated first instead. */
  ended?: { changedFiles: number; patchHashes: string[] };
  /** Overload resource state of the current model call. */
  thinking?: boolean;
  contextWindow?: number;
  /** max(model minimum, measured system prompt + tool schema tokens + reserve). */
  contextFloor?: number;
  serial?: boolean;
  /** Present when a reroute is possible at all; the loop filters the candidates. */
  reroute?: RerouteRequirement;
  /** Install command proposed for a dependency failure. */
  resolveCommand?: string;
}

/** Wait before retry `attempt` (1-based): exponential with ±20% jitter on `backoffMs[0]`, or the fixed list; at most 60 s. */
export function backoffMs(policy: RetryPolicy, attempt: number, random: () => number = Math.random): number {
  const list = policy.backoffMs;
  if (!list.length) {
    return 0;
  }
  const n = Math.max(1, Math.floor(attempt));
  if (!policy.exponential) {
    return Math.min(MAX_DELAY_MS, list[Math.min(n - 1, list.length - 1)]);
  }
  const base = list[0] * 2 ** (n - 1);
  const jitter = 1 + (random() * 2 - 1) * JITTER;
  return Math.min(MAX_DELAY_MS, Math.max(0, Math.round(base * jitter)));
}

function escalationFor(f: Failure): EscalationReason {
  switch (f.category) {
    case 'data_corruption':
    case 'git_conflict':
    case 'security':
    case 'loop':
      return f.category;
    case 'permission':
      return f.code === 'auth' || f.code === 'quota' || f.source.kind === 'model' ? 'credentials' : 'approval_needed';
    case 'model_unavailable':
    case 'model_timeout':
    case 'model_overload':
      return 'model_unavailable';
    default:
      return 'exhausted';
  }
}

const raise = (s: Severity): Severity => SEVERITIES[Math.min(SEVERITIES.length - 1, SEVERITIES.indexOf(s) + 1)];

function overloadPlan(state: RecoveryState, attempt: number, max: number, ctx: DecideContext): AdjustmentPlan | undefined {
  const done = new Set(state.attempts.filter((a) => a.category === 'model_overload').flatMap((a) => (a.adjust ?? []).map((x) => x.kind)));
  const reroute = ctx.reroute && !done.has('reroute') ? ({ kind: 'reroute', require: ctx.reroute } as const) : undefined;
  if (reroute && max > 1 && attempt >= max) {
    return reroute;
  }
  if (ctx.thinking === true && !done.has('thinking_off')) {
    return { kind: 'thinking_off' };
  }
  const win = ctx.contextWindow;
  const floor = ctx.contextFloor ?? 0;
  if (win && win > floor && !done.has('halve_context')) {
    return { kind: 'halve_context', contextWindow: Math.max(floor, Math.floor(win / 2)) };
  }
  if (!ctx.serial && !done.has('serial')) {
    return { kind: 'serial' };
  }
  return reroute;
}

export function decide(state: RecoveryState, f: Failure, policy: RetryPolicy, ctx: DecideContext): RetryDecision {
  if (ctx.signal?.aborted) {
    return { action: 'cancel' };
  }
  if (ctx.recoveryActive && ctx.deadlineAt !== undefined && ctx.now >= ctx.deadlineAt) {
    return { action: 'escalate', reason: 'deadline' };
  }
  if (f.cls === 'fatal' || policy.attempts <= 0) {
    return { action: 'escalate', reason: escalationFor(f) };
  }
  if (f.preexisting) {
    return { action: 'ignore', why: 'preexisting' };
  }
  if (f.foreign) {
    return { action: 'ignore', why: 'foreign' };
  }
  if (ctx.required === false) {
    return { action: 'ignore', why: 'non_required' };
  }

  // A fix attempt that changed nothing, or repeated an earlier patch, is settled here without a check rerun.
  let settled: Settled | undefined;
  if (ctx.ended) {
    const earlier = new Set(state.attempts.flatMap((a) => a.patches.map((p) => p.diffHash)));
    if (ctx.ended.changedFiles === 0 || !ctx.ended.patchHashes.length) {
      settled = { result: 'not_fixed', validate: false };
    } else if (ctx.ended.patchHashes.every((h) => earlier.has(h))) {
      settled = { result: 'duplicate', validate: false };
    }
  }
  const bump = settled ? 1 : 0;
  const withSettled = (d: RetryDecision): RetryDecision => (settled ? { ...d, settled } : d);

  const afterFix = (state.seen[f.signature]?.afterFix ?? 0) + bump;
  if (afterFix >= 2) {
    return withSettled({ action: 'escalate', reason: 'duplicate' });
  }

  const used = (state.perCategory[f.category] ?? 0) + bump;
  const total = Object.values(state.perCategory).reduce<number>((n, v) => n + (v ?? 0), 0) + bump;
  const max = Math.min(policy.attempts, attemptCap(f.category, ctx.maxRepairAttempts));
  if (used >= max || total >= ctx.totalCap) {
    return withSettled({ action: 'escalate', reason: f.category === 'security' ? 'security' : 'exhausted' });
  }
  const attempt = used + 1;

  if (f.category === 'mcp' && f.notExecuted) {
    return withSettled({ action: 'resolve', kind: 'mcp' });
  }
  if (f.category === 'mcp' && f.cls !== 'environmental') {
    // Not proven unexecuted: the call may have had side effects, so never replay it.
    return withSettled({ action: 'fix', attempt, max, mode: 'inline' });
  }
  if (f.cls === 'transient') {
    const random = ctx.random ?? Math.random;
    let delayMs = backoffMs(policy, attempt, random);
    if (ctx.modelFailure === 'ratelimit') {
      delayMs = retryDelayMs('ratelimit', ctx.error, attempt, [delayMs]);
    }
    if (ctx.recoveryActive && ctx.deadlineAt !== undefined) {
      delayMs = Math.min(delayMs, Math.max(0, ctx.deadlineAt - ctx.now));
    }
    const adjust = f.category === 'model_timeout' && ctx.reroute && max > 1 && attempt >= max ? ({ kind: 'reroute', require: ctx.reroute } as const) : undefined;
    return withSettled(adjust ? { action: 'retry', delayMs, adjust } : { action: 'retry', delayMs });
  }
  if (f.cls === 'environmental') {
    if (f.category === 'dependency') {
      return withSettled(ctx.resolveCommand ? { action: 'resolve', kind: 'dependency', command: ctx.resolveCommand } : { action: 'resolve', kind: 'dependency' });
    }
    if (f.category === 'mcp') {
      return withSettled({ action: 'resolve', kind: 'mcp' });
    }
    if (f.category === 'model_overload' || f.category === 'check_timeout') {
      let delayMs = backoffMs(policy, attempt, ctx.random ?? Math.random);
      if (ctx.recoveryActive && ctx.deadlineAt !== undefined) {
        delayMs = Math.min(delayMs, Math.max(0, ctx.deadlineAt - ctx.now));
      }
      const adjust = f.category === 'model_overload' ? overloadPlan(state, attempt, max, ctx) : undefined;
      return withSettled(adjust ? { action: 'retry', delayMs, adjust } : { action: 'retry', delayMs });
    }
  }
  const mode: FixMode = ctx.delegateAllowed && ctx.independentGroups >= 2 ? 'delegate' : 'inline';
  return withSettled(afterFix === 1 ? { action: 'fix', attempt, max, mode, raiseSeverity: raise(f.severity) } : { action: 'fix', attempt, max, mode });
}

