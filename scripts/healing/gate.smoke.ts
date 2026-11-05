/**
 * Smoke checks for src/agent/healing/qualityGate.ts and regression.ts (design §5.2 anti-gaming, §5.5, §6).
 *   node scripts/healing/run.js scripts/healing/gate.smoke.ts
 */
import { buildContract, detectChecksModified, evaluate, formatReport, testEditRequested, type BuildContractInput } from '../../src/agent/healing/qualityGate';
import { attribute, compare, isWorse } from '../../src/agent/healing/regression';
import type { CheckResult, CheckSpec, Failure, FailureCategory, Severity } from '../../src/agent/healing/types';

type Check = (name: string, cond: boolean, detail?: unknown) => void;

function failure(signature: string, patch: Partial<Failure> = {}): Failure {
  const category: FailureCategory = patch.category ?? 'typescript';
  const severity: Severity = patch.severity ?? 'high';
  return {
    id: signature,
    category,
    cls: 'deterministic',
    severity,
    message: signature,
    evidence: '',
    source: { kind: 'check' },
    signature,
    generic: signature,
    ...patch,
  };
}

function result(checkId: string, status: CheckResult['status'], failures: Failure[] = [], skipReason?: string): CheckResult {
  return { checkId, status, skipReason, exitCode: status === 'passed' ? 0 : 1, durationMs: 10, output: '', failures, fingerprint: 'fp' };
}

const SPECS: Pick<CheckSpec, 'id' | 'kind' | 'required' | 'command'>[] = [
  { id: 'npm:typecheck', kind: 'typecheck', required: true, command: 'npm run typecheck' },
  { id: 'npm:test', kind: 'test', required: true, command: 'npm test' },
  { id: 'npm:lint', kind: 'lint', required: false, command: 'npm run lint' },
];

const passing = () => [result('npm:typecheck', 'passed'), result('npm:test', 'passed'), result('npm:lint', 'passed')];

function input(patch: Partial<BuildContractInput> = {}): BuildContractInput {
  return {
    results: passing(),
    specs: SPECS,
    outOfScope: false,
    regressionRequired: true,
    todos: [],
    finalText: 'I updated sum() to handle negatives.',
    request: 'fix sum() for negative numbers',
    changedFiles: 1,
    delegations: 0,
    approvals: [],
    unresolved: [],
    outstandingRecovery: false,
    checksModified: [],
    acceptedRisks: [],
    ...patch,
  };
}

export async function gateSmoke(check: Check): Promise<void> {
  // ---- regression.compare / isWorse ----
  const a = failure('ts:TS2345:src/a.ts');
  const b = failure('ts:TS2322:src/b.ts');
  const lint = failure('lint:no-unused:src/c.ts', { category: 'lint', severity: 'low' });
  const other = failure('ts:TS2304:src/other.ts', { file: 'src/other.ts' });
  const newOne = failure('ts:TS2551:src/a.ts', { file: 'src/a.ts' });
  const rep = compare([a, b, lint], [b, lint, other, newOne, newOne], ['lint:no-unused:src/c.ts'], (f) => f.file === 'src/other.ts', 42);
  check('compare: fixed', rep.fixed.join() === a.signature, rep);
  check('compare: still', rep.still.join() === b.signature, rep);
  check('compare: preexisting from baseline', rep.preexisting.join() === lint.signature, rep);
  check('compare: foreign never introduced', rep.foreign.join() === other.signature && !rep.introduced.includes(other.signature), rep);
  check('compare: introduced (deduped)', rep.introduced.join() === newOne.signature, rep);
  check('compare: before/after/durationMs', rep.before.length === 3 && rep.after.length === 4 && rep.durationMs === 42, rep);
  const flagged = compare([], [failure('x', { foreign: true }), failure('y', { preexisting: true })]);
  check('compare: failure flags respected', flagged.foreign.join() === 'x' && flagged.preexisting.join() === 'y' && !flagged.introduced.length, flagged);
  check('attribute: marks without mutating input', attribute([a], [a.signature])[0].preexisting === true && a.preexisting === undefined);

  check('isWorse: more severe failures', isWorse([a], [a, b]));
  check('isWorse: fewer failures is not worse', !isWorse([a, b], [b]));
  check('isWorse: preexisting/foreign growth is not worse', !isWorse([a], [a, lint, other], [lint.signature], (f) => f.file === 'src/other.ts'));
  check('isWorse: a passing required stage now fails', isWorse([a], [failure('ts:x', { severity: 'low' })], undefined, undefined, {
    before: { 'npm:typecheck': 'failed', 'npm:test': 'passed' },
    after: { 'npm:typecheck': 'passed', 'npm:test': 'failed' },
    required: ['npm:typecheck', 'npm:test'],
  }));
  check('isWorse: non-required stage regression ignored', !isWorse([a], [a], undefined, undefined, {
    before: { 'npm:lint': 'passed' },
    after: { 'npm:lint': 'failed' },
    required: ['npm:test'],
  }));

  // ---- detectChecksModified ----
  const defining = ['.localpilot/checks.json', 'package.json', 'tsconfig*.json', 'jest.config.*', 'scripts/prep.js'];
  const mods = detectChecksModified({
    attemptWrites: [
      { file: 'src/sum.ts', attempt: 1 },
      { file: 'package.json', attempt: 1 },
      { file: 'packages/a/package.json', attempt: 2 },
      { file: 'tsconfig.build.json', attempt: 2 },
      { file: 'scripts/prep.js', attempt: 2 },
      { file: 'src/sum.test.ts', attempt: 2 },
      { file: 'src/new.test.ts', attempt: 2 },
      { file: 'src/sum.test.ts', attempt: 3 },
      { file: 'Makefile', attempt: 3 },
      { file: 'tests/test_util.py', attempt: 3 },
    ],
    definingFiles: defining,
    newThisTurn: new Set(['src/new.test.ts']),
    requestText: 'fix sum() for negative numbers; the failing test in tests/test_util.py is outdated',
    scriptsChanged: (f) => f === 'package.json',
  });
  const files = mods.map((m) => `${m.file}@${m.attempt}`);
  check('checksModified: package.json scripts changed', files.includes('package.json@1'), files);
  check('checksModified: package.json without scripts change ignored', !files.some((f) => f.startsWith('packages/a/package.json')), files);
  check('checksModified: tsconfig glob + wrapper script', files.includes('tsconfig.build.json@2') && files.includes('scripts/prep.js@2'), files);
  check('checksModified: existing test file (first attempt only)', files.includes('src/sum.test.ts@2') && !files.includes('src/sum.test.ts@3'), files);
  check('checksModified: new test file / source / requested test not listed', !files.some((f) => /new\.test|sum\.ts@|test_util/.test(f)), files);
  check('checksModified: Makefile always check-defining', files.includes('Makefile@3'), files);
  check('checksModified: no callback = section assumed changed', detectChecksModified({ attemptWrites: [{ file: 'package.json', attempt: 1 }], definingFiles: [], newThisTurn: new Set(), requestText: '' }).length === 1);
  check('testEditRequested: "update the tests" yes, "fix the failing test" no', testEditRequested('src/x.test.ts', 'please update the tests for x') && !testEditRequested('src/x.test.ts', 'fix the failing test'));

  // ---- buildContract + evaluate: every outcome path ----
  const ok = buildContract(input());
  check('completed: all passed, lint not required -> skipped', evaluate(ok) === 'completed' && ok.compilationPassed === 'passed' && ok.testsPassed === 'passed' && ok.lintPassed === 'skipped', ok);
  check('completed: regression absent (no fix) -> n/a', ok.regressionChecksPassed === 'n/a' && ok.codeChangesApplied === 'passed', ok);

  const oos = buildContract(input({ outOfScope: true, results: [], specs: [] }));
  check('out-of-scope: n/a fields -> completed', evaluate(oos) === 'completed' && ['compilationPassed', 'testsPassed', 'lintPassed', 'regressionChecksPassed'].every((k) => oos[k as 'testsPassed'] === 'n/a'), oos);
  check('out-of-scope footer', formatReport(oos) === 'No checks needed for these changes.', formatReport(oos));

  const readOnly = buildContract(input({ results: [], specs: [], changedFiles: 0, request: 'what does sum() do?', finalText: 'It adds numbers.' }));
  check('read-only question: completed, codeChangesApplied n/a', evaluate(readOnly) === 'completed' && readOnly.codeChangesApplied === 'n/a', readOnly);

  const gamed = buildContract(input({ checksModified: [{ file: 'package.json', attempt: 1 }] }));
  check('checksModified -> completed_unverified', evaluate(gamed) === 'completed_unverified', gamed);
  check('footer: check definition changed', formatReport(gamed).includes('Not verified: the check definition was changed during the fix: package.json'), formatReport(gamed));

  const timedOut = buildContract(input({ results: [result('npm:typecheck', 'passed'), result('npm:test', 'timeout')] }));
  check('timeout -> unverified -> completed_unverified', timedOut.testsPassed === 'unverified' && evaluate(timedOut) === 'completed_unverified', timedOut);
  check('footer: timed out reason', formatReport(timedOut, undefined, { results: [result('npm:test', 'timeout')], specs: SPECS }).includes('Not verified: `npm test` timed out'));
  const denied = buildContract(input({ results: [result('npm:typecheck', 'passed'), result('npm:test', 'skipped', [], 'denied by rule')] }));
  check('policy-skipped required check -> completed_unverified', evaluate(denied) === 'completed_unverified' && (denied.unverifiedReasons ?? []).some((r) => r.includes('denied by rule')), denied);
  const noChecks = buildContract(input({ results: [], specs: [] }));
  check('no checks for in-scope changes -> completed_unverified', evaluate(noChecks) === 'completed_unverified' && noChecks.compilationPassed === 'unverified', noChecks);
  const noChange = buildContract(input({ changedFiles: 0, results: [], specs: [], finalText: 'The code looks right to me.' }));
  check('imperative request without changes -> unverified', noChange.codeChangesApplied === 'unverified' && evaluate(noChange) === 'completed_unverified', noChange);
  const claimed = buildContract(input({ changedFiles: 0, results: [], specs: [], finalText: "I've fixed sum()." }));
  check('claimed change without changes -> failed -> incomplete', claimed.codeChangesApplied === 'failed' && evaluate(claimed) === 'incomplete', claimed);
  const politeClaim = buildContract(input({ changedFiles: 0, results: [], specs: [], request: 'Can you fix sum()?', finalText: "I've fixed sum()." }));
  check('polite "Can you fix sum()?" + claim -> failed -> incomplete', politeClaim.codeChangesApplied === 'failed' && evaluate(politeClaim) === 'incomplete', politeClaim);
  const politeBare = buildContract(input({ changedFiles: 0, results: [], specs: [], request: 'Could you update the README?', finalText: 'Done' }));
  check('polite request + bare claim -> failed', politeBare.codeChangesApplied === 'failed' && evaluate(politeBare) === 'incomplete', politeBare);

  const ts = failure('ts:TS2345:src/sum.ts', { code: 'TS2345', file: 'src/sum.ts', line: 42 });
  const broken = buildContract(input({ results: [result('npm:typecheck', 'failed', [ts]), result('npm:test', 'passed')] }));
  check('failed typecheck -> incomplete', broken.compilationPassed === 'failed' && evaluate(broken) === 'incomplete' && broken.unresolved.some((u) => u.signature === ts.signature), broken);
  const brokenReport = formatReport(broken, undefined, { results: [result('npm:typecheck', 'failed', [ts])], specs: SPECS, attempts: 3, rootCause: 'parseDate returns UTC', next: 'decide local vs UTC' });
  check('footer: incomplete line', brokenReport.startsWith('Incomplete: `npm run typecheck` still fails (TS2345 in src/sum.ts:42) after 3 attempts.') && brokenReport.includes('Root cause: parseDate returns UTC') && brokenReport.includes('Next: decide local vs UTC'), brokenReport);

  const pre = failure('lint:x', { category: 'lint', preexisting: true });
  const preContract = buildContract(input({ specs: [...SPECS.slice(0, 2), { id: 'npm:lint', kind: 'lint', required: true, command: 'npm run lint' }], results: [...passing().slice(0, 2), result('npm:lint', 'failed', [pre])] }));
  check('preexisting-only failure: required lint passes -> completed', preContract.lintPassed === 'passed' && evaluate(preContract) === 'completed', preContract);
  const foreignF = failure('ts:TS1:src/other.ts', { foreign: true });
  const preReport = formatReport(preContract, 'completed', { results: [result('npm:lint', 'failed', [pre]), result('npm:test', 'failed', [foreignF])], regression: rep });
  check('footer: preexisting and foreign notes', /2 preexisting failures/.test(preReport) && /2 failures in files changed by another running task/.test(preReport), preReport);

  const regressed = buildContract(input({ regression: { ...rep, introduced: ['ts:new'] } }));
  check('regression introduced -> failed -> incomplete', regressed.regressionChecksPassed === 'failed' && evaluate(regressed) === 'incomplete', regressed);
  const notRequired = buildContract(input({ regressionRequired: false, regression: rep }));
  check('regression not required -> skipped -> completed', notRequired.regressionChecksPassed === 'skipped' && evaluate(notRequired) === 'completed', notRequired);
  const regressionMissing = buildContract(input({ regressionNeeded: true }));
  check('fix ran but regression suite did not -> unverified', regressionMissing.regressionChecksPassed === 'unverified' && evaluate(regressionMissing) === 'completed_unverified' && (regressionMissing.unverifiedReasons ?? []).includes('the regression suite did not run'), regressionMissing);
  const regressionMissingOptional = buildContract(input({ regressionNeeded: true, regressionRequired: false }));
  check('regression not required + did not run -> skipped', regressionMissingOptional.regressionChecksPassed === 'skipped' && evaluate(regressionMissingOptional) === 'completed', regressionMissingOptional);
  const clean = buildContract(input({ regression: { ...rep, introduced: [] } }));
  check('regression clean -> passed', clean.regressionChecksPassed === 'passed' && evaluate(clean) === 'completed', clean);

  check('pending todo -> incomplete', evaluate(buildContract(input({ todos: [{ title: 'b', status: 'in_progress' }] }))) === 'incomplete');
  check('outstanding recovery -> incomplete', evaluate(buildContract(input({ outstandingRecovery: true }))) === 'incomplete');
  const incompleteCases: [string, Partial<BuildContractInput>, string][] = [
    ['unresolved nudge', { unresolvedNudge: true }, 'the reply did not match the work done'],
    ['failed delegation', { failedDelegations: 2 }, '2 delegated items failed'],
    ['unchecked acceptance criteria', { uncheckedCriteria: 1 }, '1 acceptance criterion unchecked'],
    ['budget/deadline exhausted with checks not run', { budgetExhausted: true, results: [] }, 'the budget or deadline ran out'],
  ];
  for (const [label, patch, reason] of incompleteCases) {
    const c = buildContract(input(patch));
    const footer = formatReport(c);
    check(`incomplete: ${label}`, c.requirementsSatisfied === 'failed' && evaluate(c) === 'incomplete' && footer.includes(reason), { c, footer });
  }
  check('unresolved high failure -> incomplete; preexisting one ignored', evaluate(buildContract(input({ unresolved: [failure('rt:x', { category: 'runtime' })] }))) === 'incomplete' && evaluate(buildContract(input({ unresolved: [failure('rt:x', { preexisting: true })] }))) === 'completed');

  const secret = failure('sec:aws-key:src/k.ts', { category: 'security', severity: 'critical' });
  const sec = buildContract(input({ specs: [...SPECS, { id: 'security', kind: 'security', required: true, command: '' }], results: [...passing(), result('security', 'failed', [secret])] }));
  check('security critical -> failed -> incomplete', sec.securityChecksPassed === 'failed' && evaluate(sec) === 'incomplete', sec);
  const accepted = buildContract(input({ results: [...passing(), result('security', 'failed', [secret])], acceptedRisks: [{ by: 'user', at: 1, signatures: [secret.signature] }] }));
  check('security covered by accepted risk -> passed', accepted.securityChecksPassed === 'passed' && evaluate(accepted) === 'completed' && accepted.acceptedRisks?.length === 1, accepted);
  const lowSec = buildContract(input({ results: [...passing(), result('security', 'failed', [failure('sec:low', { category: 'security', severity: 'low' })])] }));
  check('security low finding does not fail', lowSec.securityChecksPassed === 'passed', lowSec);
  const crashedSec = buildContract(input({ results: [...passing(), result('security', 'failed')] }));
  check('security failed without findings -> unverified', crashedSec.securityChecksPassed === 'unverified' && evaluate(crashedSec) === 'completed_unverified' && (crashedSec.unverifiedReasons ?? []).includes('the security check failed without reporting findings'), crashedSec);

  const destructive = buildContract(input({ approvals: [{ at: 1, kind: 'terminal', command: 'git reset --hard HEAD~1', decision: 'auto', mandatory: true }] }));
  check('destructive action without a mandatory decision -> failed -> incomplete', destructive.approvalRequirementsSatisfied === 'failed' && evaluate(destructive) === 'incomplete', destructive);
  const inRecovery = buildContract(input({ approvals: [{ at: 1, kind: 'terminal', command: 'rm -rf dist', decision: 'auto', mandatory: false, origin: 'healing' }] }));
  check('destructive auto-run during recovery -> incomplete', inRecovery.approvalRequirementsSatisfied === 'failed' && evaluate(inRecovery) === 'incomplete', inRecovery);
  const userAuto = buildContract(input({ approvals: [
    { at: 1, kind: 'delete', command: 'src/old.ts', decision: 'auto', mandatory: false },
    { at: 2, kind: 'terminal', command: 'rm -rf dist', decision: 'auto', mandatory: false },
  ] }));
  check('auto-approved delete / rm -rf by user settings (approvals.delete=always) -> completed', userAuto.approvalRequirementsSatisfied === 'passed' && evaluate(userAuto) === 'completed', userAuto);
  const approved = buildContract(input({ approvals: [{ at: 1, kind: 'terminal', command: 'git reset --hard HEAD~1', decision: 'approved', mandatory: true }] }));
  check('approved destructive action -> passed', approved.approvalRequirementsSatisfied === 'passed' && evaluate(approved) === 'completed', approved);

  const blockedCases: [string, Partial<BuildContractInput>][] = [
    ['declined install', { declinedRequired: true }],
    ['pending approval (unattended)', { pendingRequired: true }],
    ['credentials missing', { credentialsMissing: true }],
    ['git conflict', { gitConflict: true }],
    ['security needs user', { securityNeedsUser: true }],
    ['model Blocked: line', { finalText: 'Root cause: unknown\nBlocked: need the production API key' }],
    ['modelBlocked flag', { modelBlocked: 'product decision' }],
  ];
  for (const [label, patch] of blockedCases) {
    const c = buildContract(input(patch));
    check(`blocked: ${label}`, evaluate(c) === 'blocked', c);
  }
  const blockedOverIncomplete = buildContract(input({ gitConflict: true, results: [result('npm:typecheck', 'failed', [ts])] }));
  check('blocked wins over incomplete', evaluate(blockedOverIncomplete) === 'blocked');
  const blockedReport = formatReport(buildContract(input({ finalText: 'Blocked: need the production API key' })));
  check('footer: blocked reason', blockedReport.startsWith('Blocked: need the production API key'), blockedReport);
  const verified = formatReport(ok, 'completed', { results: passing(), specs: SPECS });
  check('footer: verified line', verified === 'Verified: npm:typecheck ✓ · npm:test ✓ · npm:lint (not required) ✓', verified);
}
