import * as path from 'path';
import type { HealingCheckKind, HealingCheckSetting, HealingConfig, HealingPolicySetting } from './config';

type Get = <T>(key: string, def: T) => T;

/** `security` is absent: that stage is only the in-process scan governed by the user-only `healing.securityCheck`. */
const CHECK_KINDS: readonly HealingCheckKind[] = ['build', 'typecheck', 'lint', 'test', 'custom'];

/** Failure categories a `healing.policies` entry may override. */
export const HEALING_POLICY_CATEGORIES = [
  'model_timeout', 'model_unavailable', 'model_overload', 'model_output',
  'compile', 'typescript', 'lint', 'build', 'dependency',
  'unit_test', 'integration_test', 'runtime',
  'database', 'data_corruption', 'mcp', 'git_conflict', 'security',
  'tool', 'permission', 'check_timeout', 'loop', 'unknown',
] as const;

/** Attempts a setting can never raise: these categories escalate or stop, security gets bounded remediation. */
export const HEALING_POLICY_MAX: Record<string, number> = { data_corruption: 0, git_conflict: 0, permission: 0, loop: 0, security: 3 };

const MAX_ATTEMPTS = 10;

const int = (v: unknown, def: number, min: number, max: number): number => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) ? Math.max(min, Math.min(max, Math.floor(n))) : def;
};
const pick = <T extends string>(v: unknown, values: readonly T[], def: T): T => values.find((x) => x === v) ?? def;
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

const insideRoot = (cwd: string) => !path.isAbsolute(cwd) && !/^[\\/]/.test(cwd) && !/^[a-zA-Z]:/.test(cwd) && !path.normalize(cwd).split(/[\\/]/).includes('..');

/** Entries without a known `kind` and a command, aimed at the security stage, or with a `cwd` outside the root are dropped; the rest are trimmed and clamped. */
export function sanitizeHealingChecks(raw: unknown): HealingCheckSetting[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const out: HealingCheckSetting[] = [];
  for (const e of raw) {
    if (!e || typeof e !== 'object' || Array.isArray(e)) {
      continue;
    }
    const r = e as Record<string, unknown>;
    const kind = CHECK_KINDS.find((k) => k === r.kind);
    const command = str(r.command);
    const id = str(r.id);
    const cwd = str(r.cwd);
    if (!kind || !command || (id && /^security/i.test(id)) || (cwd && !insideRoot(cwd))) {
      continue;
    }
    const check: HealingCheckSetting = { kind, command };
    if (id) {
      check.id = id;
    }
    if (cwd) {
      check.cwd = cwd;
    }
    const scoped = str(r.scoped);
    if (scoped) {
      check.scoped = scoped;
    }
    if (r.timeoutSeconds !== undefined && Number.isFinite(Number(r.timeoutSeconds))) {
      check.timeoutSeconds = int(r.timeoutSeconds, 300, 10, 3600);
    }
    if (typeof r.required === 'boolean') {
      check.required = r.required;
    }
    if (Array.isArray(r.when)) {
      const when = r.when.map(str).filter((g): g is string => !!g);
      if (when.length) {
        check.when = when;
      }
    }
    out.push(check);
  }
  return out;
}

/** Known categories only; attempts 0–10 and never above the category's safety maximum. */
export function sanitizeHealingPolicies(raw: unknown): Record<string, HealingPolicySetting> {
  const out: Record<string, HealingPolicySetting> = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return out;
  }
  for (const [cat, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!(HEALING_POLICY_CATEGORIES as readonly string[]).includes(cat) || !v || typeof v !== 'object' || Array.isArray(v)) {
      continue;
    }
    const r = v as Record<string, unknown>;
    const cap = HEALING_POLICY_MAX[cat] ?? MAX_ATTEMPTS;
    const p: HealingPolicySetting = {};
    if (r.attempts !== undefined && Number.isFinite(Number(r.attempts))) {
      p.attempts = int(r.attempts, 0, 0, cap);
    } else if (cap === 0) {
      p.attempts = 0;
    }
    if (Array.isArray(r.backoffMs)) {
      const waits = r.backoffMs.map(Number).filter((n) => Number.isFinite(n)).slice(0, MAX_ATTEMPTS).map((n) => Math.max(0, Math.min(600_000, Math.floor(n))));
      if (waits.length) {
        p.backoffMs = waits;
      }
    }
    if (r.timeoutSeconds !== undefined && Number.isFinite(Number(r.timeoutSeconds))) {
      p.timeoutSeconds = int(r.timeoutSeconds, 300, 1, 3600);
    }
    if (Object.keys(p).length) {
      out[cat] = p;
    }
  }
  return out;
}

/** `localpilot.healing.*`, clamped to the ranges package.json declares. */
export function parseHealingConfig(get: Get): HealingConfig {
  const bool = (key: string, def: boolean) => {
    const v = get<unknown>(`healing.${key}`, def);
    return typeof v === 'boolean' ? v : def;
  };
  const num = (key: string, def: number, min: number, max: number) => int(get<unknown>(`healing.${key}`, def), def, min, max);
  return {
    enabled: bool('enabled', true),
    autoDetect: bool('autoDetect', true),
    autoRetry: bool('autoRetry', true),
    autoFix: bool('autoFix', true),
    regressionRequired: bool('regressionRequired', true),
    maxRepairAttempts: num('maxRepairAttempts', 3, 0, 10),
    maxTotalAttempts: num('maxTotalAttempts', 8, 0, 30),
    extraSteps: num('extraSteps', 16, 0, 60),
    taskDeadlineMinutes: num('taskDeadlineMinutes', 60, 0, 1440),
    checkTiming: pick(get<unknown>('healing.checkTiming', 'onComplete'), ['onComplete', 'afterEdits'] as const, 'onComplete'),
    scopeTests: bool('scopeTests', true),
    checkTimeoutSeconds: num('checkTimeoutSeconds', 300, 10, 3600),
    checkTimeBudgetSeconds: num('checkTimeBudgetSeconds', 900, 30, 7200),
    baseline: pick(get<unknown>('healing.baseline', 'fast'), ['fast', 'all', 'off'] as const, 'fast'),
    checks: sanitizeHealingChecks(get<unknown>('healing.checks', [])),
    policies: sanitizeHealingPolicies(get<unknown>('healing.policies', {})),
    dependencyInstall: pick(get<unknown>('healing.dependencyInstall', 'ask'), ['ask', 'never'] as const, 'ask'),
    gitConflicts: 'escalate',
    securityCheck: pick(get<unknown>('healing.securityCheck', 'changed'), ['changed', 'full', 'off'] as const, 'changed'),
    delegateFixes: bool('delegateFixes', true),
    memory: pick(get<unknown>('healing.memory', 'workspace'), ['workspace', 'project', 'off'] as const, 'workspace'),
  };
}
