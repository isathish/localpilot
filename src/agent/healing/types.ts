import type { ToolCall, ToolCallDecision } from '../../types';

/** Shared types of the self-healing engine (detection, classification, recovery state, completion contract). */

// ---- Checks ----

export type CheckKind = 'build' | 'typecheck' | 'lint' | 'test' | 'security' | 'custom';

export type CheckEcosystem = 'node' | 'python' | 'go' | 'rust' | 'maven' | 'gradle' | 'dotnet' | 'make' | 'custom';

export interface CheckSpec {
  /** 'npm:typecheck', 'pytest', 'cargo:check', 'custom:e2e'. */
  id: string;
  kind: CheckKind;
  /** Full command line. */
  command: string;
  /** Workspace-relative folder the command runs in. */
  cwd?: string;
  /** Template with {files} / {tests} / {pkgs} / {classes} / {crate} for affected-only runs. */
  scoped?: string;
  timeoutSeconds: number;
  required: boolean;
  /** Globs: only run when a changed file matches. */
  when?: string[];
  source: 'discovered' | 'setting' | 'checks.json';
  ecosystem: CheckEcosystem;
}

/** A check as written in `localpilot.healing.checks` or `.localpilot/checks.json` (merged onto discovery by `id`). */
export interface CheckOverride {
  id: string;
  kind?: CheckKind;
  command?: string;
  cwd?: string;
  scoped?: string;
  timeoutSeconds?: number;
  required?: boolean;
  when?: string[];
}

/** `.localpilot/checks.json`. */
export interface ChecksFile {
  checks?: CheckOverride[];
  /** Discovered check ids to drop. */
  disable?: string[];
  timeBudgetSeconds?: number;
}

export type CheckStatus = 'passed' | 'failed' | 'timeout' | 'skipped';

export interface CheckResult {
  checkId: string;
  status: CheckStatus;
  skipReason?: string;
  exitCode: number | null;
  durationMs: number;
  output: string;
  failures: Failure[];
  /** Tree fingerprint the result is valid for (cache key). */
  fingerprint: string;
}

/** What the injected executor reports for one synthetic check / resolver command. */
export interface ExecResult {
  exitCode: number | null;
  /** Raw, unclamped output (before the tool result is clamped for the model). */
  output: string;
  timedOut?: boolean;
  detached?: boolean;
  /** The call never ran: denied by the user, or blocked by policy, a rule, a hook, a setting, an unattended run or a stop. */
  skipped?: ToolCallDecision;
}

// ---- Failures ----

export type FailureCategory =
  | 'model_timeout' | 'model_unavailable' | 'model_overload' | 'model_output'
  | 'compile' | 'typescript' | 'lint' | 'build' | 'dependency'
  | 'unit_test' | 'integration_test' | 'runtime'
  | 'database' | 'data_corruption' | 'mcp' | 'git_conflict' | 'security'
  | 'tool' | 'permission' | 'check_timeout' | 'loop' | 'unknown';

export const FAILURE_CATEGORIES: readonly FailureCategory[] = [
  'model_timeout', 'model_unavailable', 'model_overload', 'model_output',
  'compile', 'typescript', 'lint', 'build', 'dependency',
  'unit_test', 'integration_test', 'runtime',
  'database', 'data_corruption', 'mcp', 'git_conflict', 'security',
  'tool', 'permission', 'check_timeout', 'loop', 'unknown',
];

/** Categories fixed by editing code; their attempts are capped by `healing.maxRepairAttempts`. */
export const CODE_FIX_CATEGORIES: readonly FailureCategory[] = [
  'compile', 'typescript', 'lint', 'build', 'unit_test', 'integration_test', 'runtime', 'database', 'security',
];

/** transient -> retry; deterministic -> diagnose + fix; environmental -> resolve with approval; policy -> escalate; fatal -> stop. */
export type FailureClass = 'transient' | 'deterministic' | 'environmental' | 'policy' | 'fatal';

export type Severity = 'info' | 'low' | 'medium' | 'high' | 'critical';

export const SEVERITIES: readonly Severity[] = ['info', 'low', 'medium', 'high', 'critical'];

export interface FailureSource {
  kind: 'check' | 'tool' | 'model' | 'diagnostics' | 'subagent' | 'loop';
  checkId?: string;
  tool?: string;
  callId?: string;
}

export interface Failure {
  id: string;
  category: FailureCategory;
  cls: FailureClass;
  severity: Severity;
  /** TS2345, E0308, F401, CS1002, ModuleNotFoundError, ECONNREFUSED, GHSA-…, MCP:-32602. */
  code?: string;
  /** First meaningful line, at most 300 characters. */
  message: string;
  /** Workspace-relative. */
  file?: string;
  line?: number;
  column?: number;
  /** Test id/name for test failures. */
  test?: string;
  /** Missing module / identifier / package. */
  symbol?: string;
  /** Trimmed raw excerpt (at most 2 KB) for root cause analysis. */
  evidence: string;
  source: FailureSource;
  /** Exact signature (with the file), for duplicate detection inside a task. */
  signature: string;
  /** Generic signature (no file), for failure-memory retrieval. */
  generic: string;
  /** Matched the baseline taken before the turn's first edit. */
  preexisting?: boolean;
  /** Located only in files last written by another live session. */
  foreign?: boolean;
  /** MCP: the error proves the call never reached the server, so it may be replayed. */
  notExecuted?: boolean;
}

// ---- Recovery state machine ----

export type RecoveryPhase =
  | 'idle' | 'executing' | 'verifying' | 'detecting' | 'classifying' | 'retrying' | 'diagnosing' | 'fixing'
  | 'validating' | 'rolling_back' | 'resolving' | 'regression' | 'escalating' | 'completing'
  /** Stopped by a shutdown (window reload, process exit) mid-recovery; resumable. */
  | 'interrupted'
  | TaskOutcome;

export type TaskOutcome = 'completed' | 'completed_unverified' | 'incomplete' | 'blocked' | 'failed' | 'cancelled';

export const TERMINAL_OUTCOMES: readonly TaskOutcome[] = ['completed', 'completed_unverified', 'incomplete', 'blocked', 'failed', 'cancelled'];

export function isTerminalPhase(phase: RecoveryPhase | undefined): phase is TaskOutcome {
  return !!phase && (TERMINAL_OUTCOMES as readonly string[]).includes(phase);
}

export type Tri = 'passed' | 'failed' | 'skipped' | 'unverified' | 'n/a';

export interface AcceptedRisk {
  by: 'user';
  at: number;
  signatures: string[];
}

export interface CompletionContract {
  requirementsSatisfied: Tri;
  codeChangesApplied: Tri;
  compilationPassed: Tri;
  testsPassed: Tri;
  lintPassed: Tri;
  securityChecksPassed: Tri;
  regressionChecksPassed: Tri;
  approvalRequirementsSatisfied: Tri;
  unresolved: { signature: string; category: FailureCategory; severity: Severity }[];
  outstandingRecovery: boolean;
  /** Check-defining files edited during a fix attempt (anti-gaming); non-empty blocks `completed`. */
  checksModified: { file: string; attempt: number }[];
  acceptedRisks?: AcceptedRisk[];
}

/**
 * Files whose edits during a recovery attempt change what a check means (anti-gaming): an attempt that touched one
 * can never count as fixed. Test files not created this turn and wrapper scripts named by a check are added at runtime.
 * Manifests that also hold dependencies are in CHECK_DEFINING_SECTIONS instead: only a change to that section counts.
 */
export const CHECK_DEFINING_FILES: readonly string[] = [
  '.localpilot/checks.json',
  '**/Makefile', '**/makefile', '**/GNUmakefile', '**/*.mk',
  '**/tsconfig*.json',
  '**/jest.config.*', '**/vitest.config.*', '**/.mocharc*',
  '**/pytest.ini', '**/conftest.py', '**/tox.ini',
  '**/.eslintrc*', '**/eslint.config.*',
  '**/gradlew', '**/mvnw',
];

/**
 * Section-scoped check definitions: an edit counts only when the named section differs before/after.
 * `json` = the top-level key; `ini` = every `[header]` starting with `section` (TOML/INI headers alike).
 */
export interface CheckDefiningSection { glob: string; format: 'json' | 'ini'; section: string }

export const CHECK_DEFINING_SECTIONS: readonly CheckDefiningSection[] = [
  { glob: '**/package.json', format: 'json', section: 'scripts' },
  { glob: '**/pyproject.toml', format: 'ini', section: 'tool.pytest' },
  { glob: '**/setup.cfg', format: 'ini', section: 'tool:pytest' },
];

export type FixMode = 'inline' | 'delegate';

export type RecoveryStrategy =
  | 'retry' | 'reroute' | 'adjust_resources' | 'repair_output' | 'fix' | 'diagnose' | 'install' | 'reconnect'
  | 'validate_schema' | 'isolate' | 'remediate' | 'escalate' | 'stop';

export interface RetryPolicy {
  category: FailureCategory;
  cls: FailureClass;
  strategy: RecoveryStrategy;
  /** Attempts for this category per task (0 = escalate at once). */
  attempts: number;
  /** Base waits between retries; the last value repeats. Empty = no wait. */
  backoffMs: number[];
  /** Exponential growth with ±20% jitter on top of `backoffMs[0]` instead of the fixed list. */
  exponential?: boolean;
  /** Per-attempt timeout. */
  timeoutSeconds?: number;
}

/** User override of one category's policy (`localpilot.healing.policies`); clamped to the safety maxima. */
export interface PolicyOverride {
  attempts?: number;
  backoffMs?: number[];
  timeoutSeconds?: number;
}

/** Highest attempt counts a policy override may set (security remediation, never for corruption or conflicts). */
export const POLICY_SAFETY_MAX: Partial<Record<FailureCategory, number>> = {
  security: 3,
  data_corruption: 0,
  git_conflict: 0,
};

/** One resource change before a model-overload retry. */
export type ResourceAdjustment =
  | { kind: 'thinking_off' }
  | { kind: 'halve_context'; contextWindow: number }
  | { kind: 'serial' }
  | { kind: 'reroute'; model: string };

export type EscalationReason =
  | 'exhausted' | 'duplicate' | 'deadline' | 'loop' | 'mistake_limit' | 'approval_needed' | 'credentials'
  | 'git_conflict' | 'security' | 'data_corruption' | 'model_blocked' | 'user_edit_conflict' | 'model_unavailable';

export type Decision =
  | { action: 'cancel' }
  | { action: 'retry'; delayMs: number; adjust?: ResourceAdjustment }
  | { action: 'fix'; attempt: number; max: number; mode: FixMode }
  | { action: 'resolve'; kind: 'dependency' | 'mcp'; command?: string }
  | { action: 'rollback_then_fix' | 'rollback_then_escalate' }
  | { action: 'escalate'; reason: EscalationReason }
  | { action: 'ignore'; why: 'preexisting' | 'non_required' };

export interface PatchRecord {
  attempt: number;
  /** Workspace-relative. */
  file: string;
  added: number;
  removed: number;
  diffHash: string;
  /** At most 80 diff lines. */
  preview: string;
  result?: 'kept' | 'rolled_back';
}

export interface RegressionReport {
  before: string[];
  after: string[];
  fixed: string[];
  introduced: string[];
  preexisting: string[];
  /** Failures in files written only by another live session; never `introduced`. */
  foreign: string[];
  durationMs: number;
}

export type AttemptResult = 'fixed' | 'not_fixed' | 'worse' | 'rolled_back' | 'duplicate' | 'blocked';

export interface AttemptRecord {
  n: number;
  category: FailureCategory;
  signature: string;
  strategy: RecoveryStrategy;
  mode: FixMode;
  rootCause?: string;
  patches: PatchRecord[];
  /** `not_fixed` also covers attempts that ended without changing any file (no check rerun). */
  result?: AttemptResult;
  regression?: RegressionReport;
  startedAt: number;
  endedAt?: number;
  /** Failure-memory entry suggested in this attempt's prompt. */
  memoryUsed?: string;
  adjust?: ResourceAdjustment[];
}

/** Actions offered on a recovery card / intervention item. */
export type RecoveryActionKind =
  | 'resume' | 'retryWithGuidance' | 'approveInstall' | 'installManually' | 'rollback' | 'restoreCheckpoint'
  | 'openMergeEditor' | 'acceptRisk' | 'setApiKey' | 'pickModel' | 'startServer' | 'retry' | 'inspect' | 'openChat' | 'dismiss';

export interface NextAction {
  action: RecoveryActionKind;
  label: string;
  /** CLI equivalent (`/recovery resume`, `localpilot -c "…"`). */
  command?: string;
}

export interface InterventionRecord {
  id: string;
  sessionId: string;
  taskId?: string;
  reason: EscalationReason;
  category?: FailureCategory;
  title: string;
  rootCause?: string;
  /** The top failure's excerpt. */
  evidence?: string;
  attemptsSummary: string;
  patches: PatchRecord[];
  nextActions: NextAction[];
  createdAt: number;
  resolvedAt?: number;
}

export interface ApprovalRecord {
  at: number;
  kind: string;
  command?: string;
  decision: 'approved' | 'denied' | 'auto';
  mandatory: boolean;
  blockedBy?: string;
  origin?: 'healing';
}

export interface CheckCacheEntry {
  fingerprint: string;
  status: CheckStatus;
  at: number;
  signatures: string[];
}

export interface PendingAction {
  kind: 'install' | 'reconnect' | 'rollback';
  command?: string;
  status: 'proposed' | 'approved' | 'started' | 'done' | 'declined';
  at: number;
}

/** Persistent per-session recovery state (`recovery/<sid>.json`). */
export interface RecoveryState {
  version: 1;
  /** Increments on every write; writes are serialised. */
  rev: number;
  sessionId: string;
  /** User message index (same key as checkpoints). */
  turnKey: number;
  taskId?: string;
  phase: RecoveryPhase;
  outcome?: TaskOutcome;
  startedAt: number;
  deadlineAt?: number;
  updatedAt: number;
  owner: { pid: number; host: string; kind: 'vscode' | 'cli' };
  baseline: { signatures: string[]; fingerprint: string; at: number } | undefined;
  checks: Record<string, CheckCacheEntry>;
  /** Turn-scoped approval to run the verification checks (30 min TTL). */
  checkAllowance?: { commandsHash: string; turnKey: number; at: number };
  /** First detected failure: base of the recovery deadline. */
  recoveryStartedAt?: number;
  /** Workspace-relative. */
  changedFiles: string[];
  /** Relative path -> sha1 of the agent's last write (null = deleted). */
  agentWrites: Record<string, string | null>;
  /** The active attempt's patch scope (its snapshots are on disk). */
  activeScope?: { attempt: number; files: string[] };
  approvals: ApprovalRecord[];
  acceptedRisks: AcceptedRisk[];
  attempts: AttemptRecord[];
  perCategory: Partial<Record<FailureCategory, number>>;
  seen: Record<string, { count: number; afterFix: number; firstAt: number }>;
  /** Unresolved now. */
  active: Failure[];
  pendingAction?: PendingAction;
  intervention?: InterventionRecord;
  contract?: CompletionContract;
  extraStepsUsed: number;
}

// ---- Failure memory ----

export interface MemoryEntry {
  id: string;
  signature: string;
  generic: string;
  category: FailureCategory;
  code?: string;
  messageNorm: string;
  rootCause: string;
  /** 'cast at call site', 'add missing export', 'install dependency'. */
  strategy: string;
  /** At most 1.5 KB diff excerpt, secrets redacted. */
  patchSummary: string;
  files: string[];
  success: boolean;
  validation: { checks: string[]; passed: boolean; regressionClean: boolean };
  reuseAllowed: boolean;
  uses: number;
  successes: number;
  failures: number;
  createdAt: number;
  lastUsedAt?: number;
  lastValidatedAt?: number;
  ecosystem: string;
  /** sha1 of the excerpt lines at fix time. */
  codeFingerprint?: string;
}

// ---- Reporting ----

/** Recovery summary of a turn (`turn_end.payload.recovery`, `Session.recovery`). */
export interface RecoverySummary {
  id: string;
  phase: RecoveryPhase;
  outcome?: TaskOutcome;
  attempts: number;
  categories: FailureCategory[];
  rootCauses: string[];
  patches: { file: string; added: number; removed: number; attempt: number; result?: string }[];
  interventionId?: string;
  /** Short deterministic footer shown under the final answer. */
  report?: string;
  updatedAt: number;
}

/** Payload of the `recovery` AgentEvent (one card per task, updated in place by `id`). */
export interface RecoveryEventPayload {
  id: string;
  phase: RecoveryPhase;
  attempt?: number;
  max?: number;
  category?: FailureCategory;
  severity?: Severity;
  signature?: string;
  /** 'TypeScript TS2345 in src/api/user.ts:42'. */
  title: string;
  rootCause?: string;
  /** `excerpt`: the start of a failed check's first failure (the chip expands to show it). */
  checks?: { id: string; status: string; ms?: number; excerpt?: string }[];
  patches?: { file: string; added: number; removed: number; result?: string }[];
  /** 'retry in 2s', 'fixing', 'rolled back'. */
  decision?: string;
  outcome?: TaskOutcome;
  contract?: CompletionContract;
  /** `files`: conflicted (or user-edited) files; `next`: the plain-language next step. */
  intervention?: { id: string; reason: EscalationReason; nextActions: NextAction[]; files?: string[]; next?: string };
  childId?: string;
}

/** What the engine asks the loop to do after a tool step. */
export interface ObserveResult {
  stop?: { reason: EscalationReason; message: string };
  /** Hidden message to inject before the next model call. */
  inject?: string;
  /** Calls proven not executed (MCP not connected) to run again through the normal approval path. */
  retryCalls?: ToolCall[];
}

/** Synchronous index entry of an interrupted recovery (queue requeue and chat card). */
export interface ResumeInfo {
  phase: RecoveryPhase;
  attempt: number;
  max: number;
  category?: FailureCategory;
}

// ---- Settings ----

/** `localpilot.healing.*`. */
export interface HealingSettings {
  enabled: boolean;
  autoDetect: boolean;
  autoRetry: boolean;
  autoFix: boolean;
  regressionRequired: boolean;
  maxRepairAttempts: number;
  maxTotalAttempts: number;
  extraSteps: number;
  /** 0 = no deadline. */
  taskDeadlineMinutes: number;
  checkTiming: 'onComplete' | 'afterEdits';
  scopeTests: boolean;
  checkTimeoutSeconds: number;
  checkTimeBudgetSeconds: number;
  baseline: 'fast' | 'all' | 'off';
  checks: CheckOverride[];
  policies: Partial<Record<FailureCategory, PolicyOverride>>;
  dependencyInstall: 'ask' | 'never';
  gitConflicts: 'escalate';
  securityCheck: 'changed' | 'full' | 'off';
  delegateFixes: boolean;
  memory: 'workspace' | 'project' | 'off';
}
