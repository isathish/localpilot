import { CODE_FIX_CATEGORIES, FAILURE_CATEGORIES, FailureCategory, FailureClass, PolicyOverride, POLICY_SAFETY_MAX, RecoveryStrategy, RetryPolicy } from './types';

/** Per-category retry policies (design §4.2) and their merge with `localpilot.healing.policies`. */

/** Today's agent-loop constants: transient model failures retried twice per step, tool-call repairs twice per run. */
export const LEGACY_MODEL_RETRIES = 2;
export const LEGACY_BACKOFF_MS: readonly number[] = [800, 2500];
export const LEGACY_TOOLCALL_REPAIRS = 2;

/** No override can raise these categories above their maximum: they stop or escalate, security gets bounded remediation. */
export const SAFETY_MAX_ATTEMPTS: Partial<Record<FailureCategory, number>> = { ...POLICY_SAFETY_MAX, permission: 0, loop: 0 };

const MAX_ATTEMPTS = 10;
const MAX_WAIT_MS = 600_000;

const p = (category: FailureCategory, cls: FailureClass, strategy: RecoveryStrategy, attempts: number, backoffMs: number[] = [], exponential?: boolean): RetryPolicy =>
  exponential ? { category, cls, strategy, attempts, backoffMs, exponential } : { category, cls, strategy, attempts, backoffMs };

export const DEFAULT_POLICIES: Readonly<Record<FailureCategory, RetryPolicy>> = {
  model_unavailable: p('model_unavailable', 'transient', 'retry', 3, [1000], true),
  model_timeout: p('model_timeout', 'transient', 'retry', 3, [1000], true),
  model_overload: p('model_overload', 'environmental', 'adjust_resources', 2, [2000, 5000]),
  model_output: p('model_output', 'deterministic', 'repair_output', 2),
  compile: p('compile', 'deterministic', 'fix', 3),
  typescript: p('typescript', 'deterministic', 'fix', 3),
  build: p('build', 'deterministic', 'fix', 3),
  lint: p('lint', 'deterministic', 'fix', 2),
  dependency: p('dependency', 'environmental', 'install', 1),
  unit_test: p('unit_test', 'deterministic', 'fix', 3),
  integration_test: p('integration_test', 'deterministic', 'diagnose', 2),
  runtime: p('runtime', 'deterministic', 'fix', 2),
  database: p('database', 'deterministic', 'validate_schema', 1),
  data_corruption: p('data_corruption', 'fatal', 'stop', 0),
  mcp: p('mcp', 'transient', 'reconnect', 2, [1000, 3000]),
  git_conflict: p('git_conflict', 'policy', 'isolate', 0),
  security: p('security', 'policy', 'remediate', 2),
  tool: p('tool', 'deterministic', 'fix', 2),
  permission: p('permission', 'policy', 'escalate', 0),
  check_timeout: p('check_timeout', 'environmental', 'retry', 1),
  loop: p('loop', 'fatal', 'stop', 0),
  unknown: p('unknown', 'deterministic', 'diagnose', 1),
};

/**
 * What the loop does today without the engine (`healing.enabled: false`): model failures, overload included, are
 * retried {@link LEGACY_MODEL_RETRIES} times with the fixed {@link LEGACY_BACKOFF_MS}; nothing else is recovered.
 */
export const LEGACY_POLICIES: Readonly<Record<FailureCategory, RetryPolicy>> = Object.fromEntries(
  FAILURE_CATEGORIES.map((c): [FailureCategory, RetryPolicy] => {
    if (c === 'model_unavailable' || c === 'model_timeout' || c === 'model_overload') {
      return [c, p(c, 'transient', 'retry', LEGACY_MODEL_RETRIES, [...LEGACY_BACKOFF_MS])];
    }
    if (c === 'model_output') {
      return [c, p(c, 'deterministic', 'repair_output', LEGACY_TOOLCALL_REPAIRS)];
    }
    return [c, { ...DEFAULT_POLICIES[c], attempts: 0, backoffMs: [] }];
  }),
) as Record<FailureCategory, RetryPolicy>;

/** The parts of `getConfig().healing` the policies depend on. */
export interface PolicySettings {
  enabled?: boolean;
  maxRepairAttempts?: number;
  policies?: Partial<Record<string, PolicyOverride>>;
}

const clampInt = (v: number, min: number, max: number) => Math.max(min, Math.min(max, Math.floor(v)));

/** The attempt ceiling of a category: its safety maximum, and `maxRepairAttempts` for code-fix categories. */
export function attemptCap(category: FailureCategory, maxRepairAttempts?: number): number {
  let cap = SAFETY_MAX_ATTEMPTS[category] ?? MAX_ATTEMPTS;
  if (maxRepairAttempts !== undefined && Number.isFinite(maxRepairAttempts) && CODE_FIX_CATEGORIES.includes(category)) {
    cap = Math.min(cap, clampInt(maxRepairAttempts, 0, MAX_ATTEMPTS));
  }
  return cap;
}

/**
 * Defaults merged with the user's overrides, clamped to the safety maxima and to `maxRepairAttempts` for code-fix
 * categories. A listed `backoffMs` replaces the exponential schedule with those fixed waits. Disabled healing gets
 * {@link LEGACY_POLICIES}.
 */
export function effectivePolicies(cfg?: PolicySettings): Record<FailureCategory, RetryPolicy> {
  const base = cfg?.enabled === false ? LEGACY_POLICIES : DEFAULT_POLICIES;
  const out = {} as Record<FailureCategory, RetryPolicy>;
  for (const c of FAILURE_CATEGORIES) {
    const pol: RetryPolicy = { ...base[c], backoffMs: [...base[c].backoffMs] };
    if (cfg?.enabled !== false) {
      const o = cfg?.policies?.[c];
      if (o && typeof o === 'object') {
        if (typeof o.attempts === 'number' && Number.isFinite(o.attempts)) {
          pol.attempts = clampInt(o.attempts, 0, MAX_ATTEMPTS);
        }
        if (Array.isArray(o.backoffMs)) {
          const waits = o.backoffMs.filter((n) => typeof n === 'number' && Number.isFinite(n)).map((n) => clampInt(n, 0, MAX_WAIT_MS));
          if (waits.length) {
            pol.backoffMs = waits;
            delete pol.exponential;
          }
        }
        if (typeof o.timeoutSeconds === 'number' && Number.isFinite(o.timeoutSeconds)) {
          pol.timeoutSeconds = clampInt(o.timeoutSeconds, 1, 3600);
        }
      }
      pol.attempts = Math.min(pol.attempts, attemptCap(c, cfg?.maxRepairAttempts));
    }
    out[c] = pol;
  }
  return out;
}
