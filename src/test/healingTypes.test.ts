import * as assert from 'assert';
import { checkDefiningEdit } from '../agent/healing/checkDefining';
import {
  CHECK_DEFINING_FILES,
  CHECK_DEFINING_SECTIONS,
  FAILURE_CATEGORIES,
  POLICY_SAFETY_MAX,
  TERMINAL_OUTCOMES,
  isTerminalPhase,
  type CompletionContract,
  type RecoveryPhase,
  type RecoveryState,
} from '../agent/healing/types';

suite('Self-healing shared types', () => {
  test('terminal phases are exactly the task outcomes; interrupted stays resumable', () => {
    for (const o of TERMINAL_OUTCOMES) { assert.ok(isTerminalPhase(o), o); }
    const live: RecoveryPhase[] = ['idle', 'executing', 'verifying', 'detecting', 'classifying', 'retrying', 'diagnosing', 'fixing', 'validating', 'rolling_back', 'resolving', 'regression', 'escalating', 'completing', 'interrupted'];
    for (const p of live) { assert.ok(!isTerminalPhase(p), p); }
    assert.ok(!isTerminalPhase(undefined));
  });

  test('category list is unique and covers the spec categories', () => {
    assert.strictEqual(new Set(FAILURE_CATEGORIES).size, FAILURE_CATEGORIES.length);
    for (const c of ['model_overload', 'typescript', 'dependency', 'integration_test', 'mcp', 'git_conflict', 'security', 'data_corruption', 'check_timeout', 'loop'] as const) {
      assert.ok(FAILURE_CATEGORIES.includes(c), c);
    }
  });

  test('safety maxima and anti-gaming files', () => {
    assert.deepStrictEqual(POLICY_SAFETY_MAX, { security: 3, data_corruption: 0, git_conflict: 0 });
    for (const f of ['.localpilot/checks.json', '**/tsconfig*.json', '**/conftest.py', '**/eslint.config.*']) {
      assert.ok(CHECK_DEFINING_FILES.includes(f), f);
    }
    for (const f of ['**/package.json', '**/pyproject.toml', '**/setup.cfg']) {
      assert.ok(!CHECK_DEFINING_FILES.includes(f), f);
      assert.ok(CHECK_DEFINING_SECTIONS.some((s) => s.glob === f), f);
    }
  });

  test('check-defining edits: whole files always, manifests only when the check section changes', () => {
    assert.strictEqual(checkDefiningEdit('.localpilot/checks.json', '{}', '{"a":1}'), '.localpilot/checks.json');
    assert.strictEqual(checkDefiningEdit('packages/web/tsconfig.build.json', null, '{}'), 'packages/web/tsconfig.build.json');
    assert.strictEqual(checkDefiningEdit('src/app.ts', 'a', 'b'), undefined);

    const pkg = (deps: Record<string, string>, scripts: Record<string, string>) =>
      JSON.stringify({ name: 'x', version: '1.0.0', scripts, dependencies: deps }, null, 2);
    const scripts = { test: 'mocha', build: 'tsc' };
    assert.strictEqual(checkDefiningEdit('package.json', pkg({}, scripts), pkg({ lodash: '^4.17.21' }, scripts)), undefined);
    assert.strictEqual(
      checkDefiningEdit('apps/api/package.json', pkg({}, scripts), pkg({}, { ...scripts, test: 'exit 0' })),
      'apps/api/package.json scripts',
    );

    const py = (deps: string, pytest: string) => `[project]\nname = "x"\ndependencies = [${deps}]\n\n[tool.pytest.ini_options]\n${pytest}\n`;
    assert.strictEqual(checkDefiningEdit('pyproject.toml', py('', 'addopts = "-q"'), py('"requests"', 'addopts = "-q"')), undefined);
    assert.strictEqual(checkDefiningEdit('pyproject.toml', py('', 'addopts = "-q"'), py('', 'addopts = "-q -k not_slow"')), 'pyproject.toml tool.pytest');

    const cfg = (ver: string, pytest: string) => `[metadata]\nversion = ${ver}\n\n[tool:pytest]\n${pytest}\n`;
    assert.strictEqual(checkDefiningEdit('setup.cfg', cfg('1.0', 'testpaths = tests'), cfg('1.1', 'testpaths = tests')), undefined);
    assert.strictEqual(checkDefiningEdit('setup.cfg', cfg('1.0', 'testpaths = tests'), cfg('1.0', 'testpaths = none')), 'setup.cfg tool:pytest');
  });

  test('a recovery state round-trips through JSON', () => {
    const contract: CompletionContract = {
      requirementsSatisfied: 'passed', codeChangesApplied: 'passed', compilationPassed: 'failed', testsPassed: 'unverified',
      lintPassed: 'skipped', securityChecksPassed: 'passed', regressionChecksPassed: 'n/a', approvalRequirementsSatisfied: 'passed',
      unresolved: [{ signature: 'abc', category: 'typescript', severity: 'high' }], outstandingRecovery: true,
      checksModified: [{ file: 'package.json', attempt: 1 }],
    };
    const state: RecoveryState = {
      version: 1, rev: 3, sessionId: 's1', turnKey: 2, phase: 'interrupted', startedAt: 1, updatedAt: 2,
      owner: { pid: 1, host: 'h', kind: 'cli' }, baseline: { signatures: ['abc'], fingerprint: 'f', at: 1 }, checks: {}, changedFiles: ['src/a.ts'],
      agentWrites: { 'src/a.ts': 'deadbeef', 'src/b.ts': null }, activeScope: { attempt: 1, files: ['src/a.ts'] },
      approvals: [{ at: 1, kind: 'terminal', command: 'npm test', decision: 'auto', mandatory: false, origin: 'healing' }],
      acceptedRisks: [], attempts: [], perCategory: { typescript: 1 }, seen: {}, active: [], extraStepsUsed: 0, contract,
      checkAllowance: { commandsHash: 'h', turnKey: 2, at: 1 },
    };
    assert.deepStrictEqual(JSON.parse(JSON.stringify(state)), state);
  });
});
