import { globToRegExp } from '../permissions';
import type { TodoItem } from '../../types';
import { claimsChange, looksLikeBareClaim } from '../agentLoop';
import {
  CHECK_DEFINING_FILES, CHECK_DEFINING_SECTIONS,
  type AcceptedRisk, type ApprovalRecord, type CheckKind, type CheckResult, type CheckSpec, type CompletionContract,
  type EscalationReason, type Failure, type FailureCategory, type RegressionReport, type Severity, type TaskOutcome, type Tri,
} from './types';

/** Quality Gate (design §5.2 anti-gaming, §6): completion contract, outcome and the deterministic footer. */

// ---- Anti-gaming ----

/** Test files across the supported ecosystems (JS/TS, Python, Go, JVM, .NET, Rust integration tests). */
export const DEFAULT_TEST_FILE_PATTERN =
  /(?:^|\/)(?:__tests__|tests?|spec)\/|\.(?:test|spec)\.[cm]?[jt]sx?$|(?:^|\/)test_[^/]+\.py$|_test\.(?:py|go)$|(?:Tests?|Spec|IT)\.(?:java|kt|kts|scala|groovy|cs|fs|vb)$/;

/** The request asks to change tests ("update the tests", "add a test for…"); "fix the failing test" does not count. */
const CHANGE_TESTS =
  /\b(?:update|change|edit|modify|adjust|rewrite|amend|extend|add|write|correct|replace|remove|delete|rename)\w*\s+(?:(?:a|an|the|these|those|this|that|my|our|its|their|existing|old|unit|integration|e2e|new|more|some|failing|broken|outdated)\s+){0,3}(?:tests?|specs?|test\s+(?:cases?|files?|suites?)|assertions?|snapshots?)\b|\b(?:tests?|specs?|assertions?|snapshots?)\s+(?:is|are)\s+(?:wrong|outdated|incorrect|obsolete|stale)\b/i;

export interface AttemptWrite {
  /** Workspace-relative. */
  file: string;
  attempt: number;
}

export interface DetectChecksModifiedInput {
  attemptWrites: readonly AttemptWrite[];
  /** Files and globs from `checkDefiningFiles` (workspace-relative); CHECK_DEFINING_FILES always apply too. */
  definingFiles: readonly string[];
  /** Files created in this turn (workspace-relative). */
  newThisTurn: ReadonlySet<string>;
  requestText: string;
  testFilePattern?: RegExp;
  /** Section-scoped manifests (package.json `scripts`, pyproject `[tool.pytest]`, setup.cfg `[tool:pytest]`): did the check section change? Absent = assume it did. */
  scriptsChanged?: (file: string) => boolean;
}

const rel = (p: string) => p.replace(/\\/g, '/').replace(/^\.\//, '');

function matcher(globs: readonly string[]): (file: string) => boolean {
  const res = globs.map((g) => {
    const p = rel(g);
    return globToRegExp(p.includes('/') ? p : `**/${p}`);
  });
  return (file) => res.some((re) => re.test(file));
}

/** The request names `file` (path or base name) or asks to change tests. */
export function testEditRequested(file: string, requestText: string): boolean {
  const req = requestText.replace(/\\/g, '/').toLowerCase();
  const f = rel(file).toLowerCase();
  const base = f.slice(f.lastIndexOf('/') + 1);
  return req.includes(f) || (base.length > 3 && req.includes(base)) || CHANGE_TESTS.test(requestText);
}

/**
 * Writes made during a recovery attempt that change what a check means (§5.2): a check-defining file (section-scoped
 * manifests only when their check section changed), or an existing test file that was not created this turn and that
 * the request neither names nor asks to change. One entry per file (its first attempt).
 */
export function detectChecksModified(input: DetectChecksModifiedInput): AttemptWrite[] {
  const sectionFile = matcher(CHECK_DEFINING_SECTIONS.map((s) => s.glob));
  const defining = matcher([...CHECK_DEFINING_FILES, ...input.definingFiles]);
  const tests = input.testFilePattern ?? DEFAULT_TEST_FILE_PATTERN;
  const newFiles = new Set([...input.newThisTurn].map(rel));
  const out = new Map<string, AttemptWrite>();
  for (const w of input.attemptWrites) {
    const file = rel(w.file);
    if (out.has(file)) {
      continue;
    }
    let hit: boolean;
    if (sectionFile(file)) {
      hit = input.scriptsChanged ? input.scriptsChanged(w.file) : true;
    } else if (defining(file)) {
      hit = true;
    } else {
      hit = tests.test(file) && !newFiles.has(file) && !testEditRequested(file, input.requestText);
    }
    if (hit) {
      out.set(file, { file, attempt: w.attempt });
    }
  }
  return [...out.values()];
}

// ---- Completion contract ----

/** Why the task needs the user; any entry makes the outcome `blocked`. */
export interface Blocker {
  reason: EscalationReason;
  detail: string;
}

/** The contract with what `evaluate` needs beyond the persisted fields. */
export interface GateContract extends CompletionContract {
  blockers?: Blocker[];
  /** Why required fields are `unverified` (footer). */
  unverifiedReasons?: string[];
  /** Why `requirementsSatisfied` failed beyond pending todos (footer). */
  incompleteReasons?: string[];
}

type UnresolvedInput = Pick<Failure, 'signature' | 'category' | 'severity'> & Partial<Pick<Failure, 'preexisting' | 'foreign'>>;

export interface BuildContractInput {
  results: readonly CheckResult[];
  /** The checks relevant to this turn's changes; a required one without a result is unverified. */
  specs: readonly Pick<CheckSpec, 'id' | 'kind' | 'required' | 'command'>[];
  /** Every changed file is outside every check's scope (§2.4): check fields are `n/a`. */
  outOfScope: boolean;
  /** The regression suite's report, when it ran. */
  regression?: RegressionReport;
  regressionRequired: boolean;
  /** A fix attempt ran, so a regression run was needed (absent `regression` then means it did not run). */
  regressionNeeded?: boolean;
  todos?: readonly Pick<TodoItem, 'status' | 'title'>[];
  finalText: string;
  request: string;
  /** Files actually changed this turn (not `mutationsExecuted`). */
  changedFiles: number;
  /** Successful delegations (workers that changed files are counted in `changedFiles` too). */
  delegations: number;
  approvals: readonly ApprovalRecord[];
  /** An approval the work needs has not been asked yet (or could not be: unattended). */
  pendingRequired?: boolean;
  /** An approval the work needs was declined. */
  declinedRequired?: boolean;
  unresolved: readonly UnresolvedInput[];
  outstandingRecovery: boolean;
  /** A nudge (claimed change, bare claim, shown tool call…) was still unresolved when the turn ended. */
  unresolvedNudge?: boolean;
  /** Delegated items (workers) that failed. */
  failedDelegations?: number;
  /** Acceptance criteria still unchecked in the plan file. */
  uncheckedCriteria?: number;
  /** The step budget, recovery budget or deadline ran out before the work finished. */
  budgetExhausted?: boolean;
  checksModified: readonly AttemptWrite[];
  acceptedRisks: readonly AcceptedRisk[];
  /** The model replied `Blocked: <reason>` (string = the reason). */
  modelBlocked?: string | boolean;
  credentialsMissing?: boolean;
  gitConflict?: boolean;
  /** A security finding needs the user's risk acceptance. */
  securityNeedsUser?: boolean;
}

/** Same imperative test as agentLoop's claimsChange: a polite "Can you fix …?" still asks for a change. */
const IMPERATIVE = /\b(create|write|add|edit|fix|update|change|rename|delete|remove|refactor|implement|make|generate|replace|move|save)\b/i;
const BLOCKED_LINE = /^\s*(?:\*\*)?Blocked:(?:\*\*)?\s*(.+)$/im;

/** Destructive command shapes (mirrors run_command's `dangerous` flag). */
export const DESTRUCTIVE = /\b(rm\s+-rf?\s|sudo\b|mkfs|dd\s+if=|:\(\)\s*\{|shutdown|reboot|git\s+push\s+(?:-f\b|--force)|git\s+reset\s+--hard|git\s+clean\s+-[a-z]*f|chmod\s+-R\s+777|drop\s+(?:table|database)\b)/i;

const isDestructive = (a: ApprovalRecord) => a.kind === 'dangerous' || (!!a.command && DESTRUCTIVE.test(a.command));

/** A destructive action ran without a decision although one was required (mandatory, or forced during recovery §5.3); a user-configured auto-approval is fine. */
const ranWithoutDecision = (a: ApprovalRecord) => a.decision === 'auto' && isDestructive(a) && (a.mandatory || a.origin === 'healing');

const SEVERE: readonly Severity[] = ['high', 'critical'];

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The request asks for a change. */
export function asksForChange(request: string): boolean {
  return IMPERATIVE.test(request);
}

function covered(signature: string, risks: readonly AcceptedRisk[]): boolean {
  return risks.some((r) => r.by === 'user' && r.signatures.includes(signature));
}

type Group = 'compile' | 'tests' | 'lint' | 'security';

function groupOf(kind: CheckKind): Group {
  switch (kind) {
    case 'build':
    case 'typecheck':
      return 'compile';
    case 'lint':
      return 'lint';
    case 'security':
      return 'security';
    default:
      return 'tests';
  }
}

function inferKind(checkId: string): CheckKind {
  const id = checkId.toLowerCase();
  if (id === 'security' || id.startsWith('security')) { return 'security'; }
  if (/lint|vet|clippy|ruff|flake8|eslint/.test(id)) { return 'lint'; }
  if (/typecheck|type-check|tsc|mypy|pyright|check-types|:check/.test(id)) { return 'typecheck'; }
  if (/build|compile/.test(id)) { return 'build'; }
  if (/test|spec|pytest/.test(id)) { return 'test'; }
  return 'custom';
}

const DEFAULT_REQUIRED: Record<CheckKind, boolean> = { build: true, typecheck: true, test: true, security: true, lint: false, custom: false };

const worst = (list: Tri[]): Tri =>
  list.includes('failed') ? 'failed' : list.includes('unverified') ? 'unverified' : list.includes('passed') ? 'passed' : list.includes('skipped') ? 'skipped' : 'n/a';

/** Build the contract from the gate's evidence (deterministic; the model never judges it). */
export function buildContract(input: BuildContractInput): GateContract {
  const risks = input.acceptedRisks;
  const specById = new Map(input.specs.map((s) => [s.id, s]));
  const latest = new Map<string, CheckResult>();
  for (const r of input.results) {
    latest.set(r.checkId, r);
  }
  const unverifiedReasons: string[] = [];
  const attributable = (f: Pick<Failure, 'preexisting' | 'foreign' | 'signature'>) => !f.preexisting && !f.foreign && !covered(f.signature, risks);
  const unresolved = new Map<string, CompletionContract['unresolved'][number]>();
  const addUnresolved = (f: UnresolvedInput) => {
    if (attributable(f) && !unresolved.has(f.signature)) {
      unresolved.set(f.signature, { signature: f.signature, category: f.category, severity: f.severity });
    }
  };
  input.unresolved.forEach(addUnresolved);

  const fields: Record<Group, Tri[]> = { compile: [], tests: [], lint: [], security: [] };
  const securityFailures: Failure[] = [];
  const kindOf = (id: string) => specById.get(id)?.kind ?? inferKind(id);
  const requiredOf = (id: string) => specById.get(id)?.required ?? DEFAULT_REQUIRED[kindOf(id)];
  const label = (id: string) => specById.get(id)?.command || id;

  for (const r of latest.values()) {
    const kind = kindOf(r.checkId);
    const group = groupOf(kind);
    for (const f of r.failures) {
      if (f.category === 'security' || kind === 'security') {
        securityFailures.push(f);
      }
    }
    if (group === 'security') {
      continue;
    }
    if (!requiredOf(r.checkId)) {
      fields[group].push('skipped');
      continue;
    }
    if (r.status === 'passed') {
      fields[group].push('passed');
    } else if (r.status === 'failed') {
      const own = r.failures.filter((f) => f.category !== 'security' && attributable(f));
      if (r.failures.length && !own.length) {
        fields[group].push('passed');
      } else {
        fields[group].push('failed');
        own.forEach(addUnresolved);
      }
    } else {
      fields[group].push('unverified');
      unverifiedReasons.push(r.status === 'timeout' ? `\`${label(r.checkId)}\` timed out` : `\`${label(r.checkId)}\` did not run${r.skipReason ? ` (${r.skipReason})` : ''}`);
    }
  }
  for (const s of input.specs) {
    if (!latest.has(s.id) && s.kind !== 'security') {
      const group = groupOf(s.kind);
      if (s.required) {
        fields[group].push('unverified');
        unverifiedReasons.push(`\`${label(s.id)}\` did not run`);
      } else {
        fields[group].push('skipped');
      }
    }
  }

  const changed = input.changedFiles > 0;
  const noChecks = !input.outOfScope && changed && !input.specs.some((s) => s.kind !== 'security') && ![...latest.keys()].some((id) => kindOf(id) !== 'security');
  if (noChecks) {
    unverifiedReasons.push('no checks were found for the changed files');
  }
  const field = (g: Group): Tri => {
    if (input.outOfScope) {
      return 'n/a';
    }
    if (noChecks && (g === 'compile' || g === 'tests')) {
      return 'unverified';
    }
    return worst(fields[g]);
  };

  // Security: new high/critical findings fail unless the user accepted the risk.
  let securityChecksPassed: Tri = 'n/a';
  const securityRan = [...latest.values()].filter((r) => kindOf(r.checkId) === 'security');
  const severeSecurity = securityFailures.filter((f) => SEVERE.includes(f.severity) && attributable(f));
  if (severeSecurity.length) {
    securityChecksPassed = 'failed';
    severeSecurity.forEach(addUnresolved);
  } else if (securityRan.some((r) => r.status === 'timeout' || r.status === 'skipped')) {
    securityChecksPassed = 'unverified';
    unverifiedReasons.push('the security check did not complete');
  } else if (securityRan.some((r) => r.status === 'failed' && !r.failures.length)) {
    securityChecksPassed = 'unverified';
    unverifiedReasons.push('the security check failed without reporting findings');
  } else if (securityRan.length) {
    securityChecksPassed = 'passed';
  }

  let regressionChecksPassed: Tri;
  if (input.outOfScope) {
    regressionChecksPassed = 'n/a';
  } else if (!input.regressionRequired) {
    regressionChecksPassed = 'skipped';
  } else if (!input.regression) {
    regressionChecksPassed = input.regressionNeeded ? 'unverified' : 'n/a';
    if (input.regressionNeeded) {
      unverifiedReasons.push('the regression suite did not run');
    }
  } else {
    regressionChecksPassed = input.regression.introduced.some((s) => !covered(s, risks)) ? 'failed' : 'passed';
  }

  const blockers: Blocker[] = [];
  const blockedText = BLOCKED_LINE.exec(input.finalText)?.[1]?.trim();
  const modelBlocked = typeof input.modelBlocked === 'string' ? input.modelBlocked : input.modelBlocked ? blockedText ?? 'the model reported it cannot continue' : blockedText;
  if (modelBlocked) {
    blockers.push({ reason: 'model_blocked', detail: modelBlocked });
  }
  if (input.credentialsMissing) {
    blockers.push({ reason: 'credentials', detail: 'credentials for the model provider are missing or rejected' });
  }
  if (input.gitConflict) {
    blockers.push({ reason: 'git_conflict', detail: 'a git conflict is waiting for review' });
  }
  if (input.securityNeedsUser) {
    blockers.push({ reason: 'security', detail: 'a security finding needs your decision' });
  }
  if (input.declinedRequired || input.pendingRequired) {
    blockers.push({ reason: 'approval_needed', detail: input.declinedRequired ? 'an approval the work needs was declined' : 'an approval the work needs is pending' });
  }

  const pendingTodos = (input.todos ?? []).filter((t) => t.status === 'pending' || t.status === 'in_progress');
  const incompleteReasons: string[] = [];
  if (pendingTodos.length) {
    incompleteReasons.push(`${plural(pendingTodos.length, 'todo')} still open`);
  }
  if (input.unresolvedNudge) {
    incompleteReasons.push('the reply did not match the work done');
  }
  if (input.failedDelegations) {
    incompleteReasons.push(`${plural(input.failedDelegations, 'delegated item')} failed`);
  }
  if (input.uncheckedCriteria) {
    incompleteReasons.push(`${plural(input.uncheckedCriteria, 'acceptance criterion', 'acceptance criteria')} unchecked`);
  }
  if (input.budgetExhausted) {
    incompleteReasons.push('the budget or deadline ran out');
  }
  const requirementsSatisfied: Tri = modelBlocked || incompleteReasons.length ? 'failed' : 'passed';

  let codeChangesApplied: Tri;
  if (changed || input.delegations > 0) {
    codeChangesApplied = 'passed';
  } else if (!asksForChange(input.request)) {
    codeChangesApplied = 'n/a';
  } else if (claimsChange(input.finalText, input.request) || looksLikeBareClaim(input.finalText, input.request)) {
    codeChangesApplied = 'failed';
  } else {
    codeChangesApplied = 'unverified';
    unverifiedReasons.push('no code changes were applied');
  }

  let approvalRequirementsSatisfied: Tri = input.approvals.length ? 'passed' : 'n/a';
  if (input.approvals.some(ranWithoutDecision)) {
    approvalRequirementsSatisfied = 'failed';
  } else if (input.declinedRequired || input.pendingRequired) {
    approvalRequirementsSatisfied = 'unverified';
  }

  return {
    requirementsSatisfied,
    codeChangesApplied,
    compilationPassed: field('compile'),
    testsPassed: field('tests'),
    lintPassed: field('lint'),
    securityChecksPassed,
    regressionChecksPassed,
    approvalRequirementsSatisfied,
    unresolved: [...unresolved.values()],
    outstandingRecovery: input.outstandingRecovery,
    checksModified: input.checksModified.map((c) => ({ file: c.file, attempt: c.attempt })),
    acceptedRisks: risks.length ? risks.map((r) => ({ ...r, signatures: [...r.signatures] })) : undefined,
    blockers: blockers.length ? blockers : undefined,
    unverifiedReasons: unverifiedReasons.length ? [...new Set(unverifiedReasons)] : undefined,
    incompleteReasons: incompleteReasons.length ? incompleteReasons : undefined,
  };
}

const TRI_FIELDS = [
  'requirementsSatisfied', 'codeChangesApplied', 'compilationPassed', 'testsPassed', 'lintPassed',
  'securityChecksPassed', 'regressionChecksPassed', 'approvalRequirementsSatisfied',
] as const satisfies readonly (keyof CompletionContract)[];

/** Gate rule (§6): blocked > incomplete > completed_unverified > completed. `skipped` = not required; `unverified` = required but not proven. */
export function evaluate(contract: CompletionContract | GateContract): TaskOutcome {
  if ((contract as GateContract).blockers?.length) {
    return 'blocked';
  }
  const tris = TRI_FIELDS.map((k) => contract[k]);
  if (tris.includes('failed') || contract.outstandingRecovery || contract.unresolved.some((u) => SEVERE.includes(u.severity))) {
    return 'incomplete';
  }
  if (tris.includes('unverified') || contract.checksModified.length) {
    return 'completed_unverified';
  }
  return 'completed';
}

// ---- Report ----
const FIELD_LABEL: Record<(typeof TRI_FIELDS)[number], string> = {
  requirementsSatisfied: 'requirements not met',
  codeChangesApplied: 'no code changes were applied',
  compilationPassed: 'compilation fails',
  testsPassed: 'tests fail',
  lintPassed: 'lint fails',
  securityChecksPassed: 'security findings remain',
  regressionChecksPassed: 'the fix introduced new failures',
  approvalRequirementsSatisfied: 'a destructive action ran without approval',
};

export interface ReportExtras {
  results?: readonly CheckResult[];
  specs?: readonly Pick<CheckSpec, 'id' | 'kind' | 'required' | 'command'>[];
  regression?: RegressionReport;
  /** Fix attempts made (and the budget) for the incomplete line. */
  attempts?: number;
  rootCause?: string;
  next?: string;
}

const CATEGORY_LABEL: Partial<Record<FailureCategory, string>> = { typescript: 'TypeScript', unit_test: 'test', integration_test: 'integration test', security: 'security' };

function failureLabel(f: Failure): string {
  const where = f.file ? ` in ${f.file}${f.line ? `:${f.line}` : ''}` : '';
  const what = f.code ?? f.test ?? CATEGORY_LABEL[f.category] ?? f.category;
  return `${what}${where}`;
}

/** Short deterministic footer for the final answer (§6 Reporting). */
export function formatReport(contract: CompletionContract | GateContract, outcome: TaskOutcome = evaluate(contract), extras: ReportExtras = {}): string {
  const gate = contract as GateContract;
  const specById = new Map((extras.specs ?? []).map((s) => [s.id, s]));
  const latest = new Map<string, CheckResult>();
  for (const r of extras.results ?? []) {
    latest.set(r.checkId, r);
  }
  const name = (id: string) => specById.get(id)?.command || id;
  const lines: string[] = [];

  if (outcome === 'blocked') {
    const b = gate.blockers ?? [];
    lines.push(`Blocked: ${b.length ? b.map((x) => x.detail).join('; ') : 'waiting for your input'}.`);
  } else if (outcome === 'incomplete') {
    const failed = [...latest.values()].find((r) => r.status === 'failed' && r.failures.some((f) => !f.preexisting && !f.foreign));
    const first = failed?.failures.find((f) => !f.preexisting && !f.foreign);
    const after = extras.attempts ? ` after ${plural(extras.attempts, 'attempt')}` : '';
    if (failed) {
      lines.push(`Incomplete: \`${name(failed.checkId)}\` still fails${first ? ` (${failureLabel(first)})` : ''}${after}.`);
    } else if (contract.outstandingRecovery) {
      lines.push(`Incomplete: recovery did not finish${after}.`);
    } else {
      const reasons = gate.incompleteReasons ?? [];
      const bad = TRI_FIELDS.filter((k) => contract[k] === 'failed').flatMap((k) => (k === 'requirementsSatisfied' && reasons.length ? reasons : [FIELD_LABEL[k]]));
      lines.push(`Incomplete: ${bad.length ? bad.join(', ') : 'unresolved failures remain'}${after}.`);
    }
    if (extras.rootCause) {
      lines.push(`Root cause: ${extras.rootCause}`);
    }
    if (extras.next) {
      lines.push(`Next: ${extras.next}`);
    }
  } else {
    const parts: string[] = [];
    for (const r of latest.values()) {
      const spec = specById.get(r.checkId);
      const required = spec?.required ?? DEFAULT_REQUIRED[spec?.kind ?? inferKind(r.checkId)];
      const mark = r.status === 'passed' ? '✓' : r.status === 'failed' ? '✗' : r.status === 'timeout' ? 'timed out' : 'not run';
      parts.push(`${r.checkId}${required ? '' : ' (not required)'} ${mark}`);
    }
    if (parts.length) {
      lines.push(`${outcome === 'completed' ? 'Verified' : 'Checks'}: ${parts.join(' · ')}`);
    } else if (outcome === 'completed' && contract.compilationPassed === 'n/a' && contract.testsPassed === 'n/a') {
      lines.push('No checks needed for these changes.');
    }
    if (outcome === 'completed_unverified') {
      for (const reason of gate.unverifiedReasons ?? []) {
        lines.push(`Not verified: ${reason}.`);
      }
    }
  }
  if (contract.checksModified.length) {
    lines.push(`Not verified: the check definition was changed during the fix: ${contract.checksModified.map((c) => c.file).join(', ')}`);
  }

  const preexisting = new Set(extras.regression?.preexisting ?? []);
  const foreign = new Set(extras.regression?.foreign ?? []);
  for (const r of latest.values()) {
    for (const f of r.failures) {
      if (f.preexisting) {
        preexisting.add(f.signature);
      } else if (f.foreign) {
        foreign.add(f.signature);
      }
    }
  }
  if (preexisting.size) {
    lines.push(`Note: ${plural(preexisting.size, 'preexisting failure')} (present before this task) ${preexisting.size === 1 ? 'was' : 'were'} not attributed.`);
  }
  if (foreign.size) {
    lines.push(`Note: ${plural(foreign.size, 'failure')} in files changed by another running task.`);
  }
  return lines.join('\n');
}

