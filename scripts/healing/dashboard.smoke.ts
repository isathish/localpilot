/**
 * Smoke checks for src/agent/healing/dashboardData.ts (design §9.3, data side).
 *   node scripts/healing/run.js scripts/healing/dashboard.smoke.ts
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { recoveryDashboard } from '../../src/agent/healing/dashboardData';
import { FailureMemory } from '../../src/agent/healing/failureMemory';
import { effectivePolicies } from '../../src/agent/healing/policy';
import { RecoveryStore } from '../../src/agent/healing/recoveryStore';
import type { Failure, HealingSettings, InterventionRecord, RecoveryState } from '../../src/agent/healing/types';
import type { RecoverySummary } from '../../src/telemetry/telemetry';

type Check = (name: string, cond: boolean, detail?: unknown) => void;

const NOW = 1_800_000_000_000;
const DAY = 86_400_000;
const SIG_TS = 'aaaaaaaaaaaaaaaa';
const SIG_LINT = 'bbbbbbbbbbbbbbbb';
const SIG_MEM = 'cccccccccccccccc';
const SIG_UNKNOWN = 'dddddddddddddddd';

function failure(signature: string, patch: Partial<Failure>): Failure {
  return {
    id: signature,
    category: 'typescript',
    cls: 'deterministic',
    severity: 'high',
    message: 'Argument of type string is not assignable',
    evidence: '',
    source: { kind: 'check', checkId: 'npm:typecheck' },
    signature,
    generic: `g${signature}`,
    ...patch,
  };
}

function state(sessionId: string, patch: Partial<RecoveryState> = {}): RecoveryState {
  return {
    version: 1,
    rev: 0,
    sessionId,
    turnKey: 1,
    phase: 'executing',
    startedAt: NOW - 60_000,
    updatedAt: NOW,
    owner: { pid: 0, host: '', kind: 'cli' },
    baseline: undefined,
    checks: {},
    changedFiles: [],
    agentWrites: {},
    approvals: [],
    acceptedRisks: [],
    attempts: [],
    perCategory: {},
    seen: {},
    active: [],
    extraStepsUsed: 0,
    ...patch,
  };
}

const config: HealingSettings = {
  enabled: true,
  autoDetect: true,
  autoRetry: true,
  autoFix: true,
  regressionRequired: true,
  maxRepairAttempts: 3,
  maxTotalAttempts: 6,
  extraSteps: 10,
  taskDeadlineMinutes: 0,
  checkTiming: 'onComplete',
  scopeTests: true,
  checkTimeoutSeconds: 300,
  checkTimeBudgetSeconds: 600,
  baseline: 'fast',
  checks: [],
  policies: { lint: { attempts: 1 } },
  dependencyInstall: 'ask',
  gitConflicts: 'escalate',
  securityCheck: 'changed',
  delegateFixes: false,
  memory: 'workspace',
};

export async function dashboardSmoke(check: Check): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lp-dash-'));
  try {
    const store = new RecoveryStore(path.join(dir, 'recovery'), { owner: { kind: 'cli' }, now: () => NOW });
    const tsFail = failure(SIG_TS, { code: 'TS2345', file: 'src/api/user.ts', line: 42 });
    const lintFail = failure(SIG_LINT, { category: 'lint', code: 'no-unused-vars', file: 'src/a.ts', severity: 'low', message: 'x is unused' });

    // Recovered task: one failed attempt, one fixed, with patches, regression and an approval.
    await store.save(
      state('s-recovered', {
        phase: 'completed',
        outcome: 'completed',
        recoveryStartedAt: NOW - 50_000,
        active: [tsFail],
        seen: { [SIG_TS]: { count: 2, afterFix: 1, firstAt: NOW - 50_000 } },
        perCategory: { typescript: 2 },
        approvals: [{ at: NOW - 40_000, kind: 'check', command: 'npm run typecheck', decision: 'approved', mandatory: false, origin: 'healing' }],
        attempts: [
          { n: 1, category: 'typescript', signature: SIG_TS, strategy: 'fix', mode: 'inline', rootCause: 'wrong arg type', patches: [{ attempt: 1, file: 'src/api/user.ts', added: 2, removed: 1, diffHash: 'h1', preview: '-a\n+b', result: 'rolled_back' }], result: 'not_fixed', startedAt: NOW - 45_000, endedAt: NOW - 40_000 },
          {
            n: 2,
            category: 'typescript',
            signature: SIG_TS,
            strategy: 'fix',
            mode: 'inline',
            rootCause: 'cast at call site',
            memoryUsed: 'm1',
            patches: [{ attempt: 2, file: 'src/api/user.ts', added: 1, removed: 1, diffHash: 'h2', preview: 'x'.repeat(9000), result: 'kept' }],
            result: 'fixed',
            regression: { before: [SIG_TS], after: [], fixed: [SIG_TS], introduced: [], preexisting: [SIG_UNKNOWN], foreign: [], durationMs: 1200 },
            startedAt: NOW - 30_000,
            endedAt: NOW - 20_000,
            adjust: [{ kind: 'thinking_off' }, { kind: 'halve_context', contextWindow: 8192 }],
          },
        ],
      }),
    );
    // Blocked task with accepted risk and an intervention.
    const intervention: InterventionRecord = {
      id: 'iv1',
      sessionId: 's-blocked',
      reason: 'exhausted',
      category: 'lint',
      title: 'Lint no-unused-vars in src/a.ts',
      attemptsSummary: '1 attempt',
      patches: [],
      nextActions: [{ action: 'resume', label: 'Resume', command: '/recovery resume' }],
      createdAt: NOW - 5_000,
    };
    await store.save(
      state('s-blocked', {
        phase: 'blocked',
        outcome: 'blocked',
        recoveryStartedAt: NOW - 10_000,
        active: [lintFail],
        acceptedRisks: [{ by: 'user', at: NOW - 4_000, signatures: [SIG_LINT] }],
        attempts: [{ n: 1, category: 'lint', signature: SIG_LINT, strategy: 'fix', mode: 'inline', patches: [], result: 'not_fixed', startedAt: NOW - 9_000, endedAt: NOW - 6_000 }],
        intervention,
      }),
    );
    await store.addIntervention(intervention);
    // Running task mid-fix, signature only resolvable through failure memory.
    await store.save(
      state('s-running', {
        phase: 'fixing',
        recoveryStartedAt: NOW - 3_000,
        activeScope: { attempt: 1, files: ['src/m.ts'] },
        attempts: [{ n: 1, category: 'unit_test', signature: SIG_MEM, strategy: 'fix', mode: 'delegate', patches: [], startedAt: NOW - 2_000 }],
      }),
    );
    // Out of range: must not show up.
    const old = new RecoveryStore(path.join(dir, 'recovery'), { owner: { kind: 'cli' }, now: () => NOW - 30 * DAY });
    await old.save(state('s-old', { phase: 'completed', outcome: 'completed', attempts: [{ n: 1, category: 'build', signature: 'eeeeeeeeeeeeeeee', strategy: 'fix', mode: 'inline', patches: [], result: 'fixed', startedAt: NOW - 30 * DAY }] }));
    await old.flush();

    const memFile = path.join(dir, 'memory.json');
    const memory = new FailureMemory(memFile, { now: () => NOW });
    await memory.record(failure(SIG_MEM, { category: 'unit_test', code: 'AssertionError', file: 'src/m.test.ts', test: 'm works' }), { rootCause: 'off by one', strategy: 'fix bound', files: ['src/m.test.ts'], success: true, ecosystem: 'node' });

    const policies = effectivePolicies(config);
    const base = { store, config, policies, running: ['s-running', { sessionId: 's-recovered', title: 'done one' }], days: 7, now: NOW, memory };

    // ---- Store-only (telemetry off) ----
    const d = await recoveryDashboard(base);
    check('store fallback: source is store', d.analytics.source === 'store');
    check('store fallback: detected counts episodes in range only', d.tiles.detected === 3, d.tiles);
    check('store fallback: rate = recovered / (recovered + escalated + exhausted + blocked)', d.tiles.recovered === 1 && d.tiles.rate === 50, d.tiles);
    check('pending intervention tile counts open items', d.tiles.pendingIntervention === 1 && d.interventions[0]?.id === 'iv1' && d.interventions[0].nextActions[0].command === '/recovery resume');
    check('mttr p50 from recovery start to the fixed attempt', d.tiles.mttrP50 === 30_000 && d.analytics.mttr.p90 === 30_000, d.analytics.mttr);
    check('config row: security bypass locked off', d.config.securityBypass === false && d.config.maxRepairAttempts === 3 && d.config.autoFix && d.tiles.enabled);
    check('current lists only the running session still recovering', d.current.length === 1 && d.current[0].sessionId === 's-running' && d.current[0].phase === 'fixing', d.current);
    check('current shows attempt N/M from the policy', d.current[0]?.attempt === 1 && d.current[0].max === policies.unit_test.attempts && d.current[0].category === 'unit_test');
    check('memory resolves a hash to its human key', d.current[0]?.key === 'AssertionError@src/m.test.ts', d.current[0]);
    const tsRow = d.failureHistory.find((r) => r.signature === SIG_TS);
    check('history resolves human keys from store failures', tsRow?.key === 'TS2345@src/api/user.ts' && tsRow.outcome === 'fixed' && tsRow.severity === 'high', tsRow);
    check('history excludes out-of-range states', !d.failureHistory.some((r) => r.sessionId === 's-old') && !d.rca.some((r) => r.sessionId === 's-old'));
    check('history category filter list', JSON.stringify(d.categories) === JSON.stringify(['lint', 'typescript', 'unit_test']), d.categories);
    check('rca per attempt with root cause and memory id', d.rca.filter((r) => r.sessionId === 's-recovered').length === 2 && d.rca.some((r) => r.rootCause === 'cast at call site' && r.memoryUsed === 'm1' && r.result === 'fixed'));
    const task = d.attempts.find((t) => t.sessionId === 's-recovered');
    check('attempt timeline has durations and resource adjustments', task?.attempts[1]?.durationMs === 10_000 && JSON.stringify(task.attempts[1].adjust) === '["thinking_off","context 8192"]', task?.attempts);
    check('tasks carry approvals', task?.approvals.length === 1 && task.approvals[0].origin === 'healing');
    const blocked = d.attempts.find((t) => t.sessionId === 's-blocked');
    check('tasks carry accepted risks with resolved keys', blocked?.acceptedRisks[0]?.keys[0] === 'no-unused-vars@src/a.ts' && d.analytics.acceptedRisks === 1, blocked?.acceptedRisks);
    check('patches listed with bounded previews', d.patches.length === 2 && d.patches.every((p) => p.preview.length <= 4000) && d.patches.some((p) => p.result === 'rolled_back'));
    const reg = d.regression[0];
    check('regression report resolves keys, unknown hashes as short hash', reg?.fixed[0] === 'TS2345@src/api/user.ts' && reg.preexisting[0] === SIG_UNKNOWN.slice(0, 8) && reg.before === 1 && reg.after === 0, reg);
    const lintCfg = d.retryConfig.find((r) => r.category === 'lint');
    check('retry config shows effective policy and overrides', d.retryConfig.length === 22 && lintCfg?.attempts === 1 && lintCfg.overridden && lintCfg.defaultAttempts === 2 && !d.retryConfig.find((r) => r.category === 'typescript')?.overridden);
    check('attempts distribution over ended episodes', JSON.stringify(d.analytics.attemptsDistribution) === JSON.stringify([{ attempts: 1, tasks: 1 }, { attempts: 2, tasks: 1 }]), d.analytics.attemptsDistribution);
    check('memory hit rate from attempts', d.analytics.memory.suggested === 1 && d.analytics.memory.succeeded === 1 && d.analytics.memory.hitRate === 100);
    check('result is JSON-serialisable', JSON.stringify(JSON.parse(JSON.stringify(d))) === JSON.stringify(d));

    // ---- With telemetry ----
    const summary: RecoverySummary = {
      detected: 5,
      recovered: 3,
      escalated: 1,
      blocked: 1,
      exhausted: 1,
      rate: 50,
      mttr: { p50: 4000, p95: 9000, avg: 5000 },
      byCategory: [{ category: 'typescript', detected: 4, recovered: 3, attempts: { p50: 1, p95: 2, avg: 1.5 } }],
      topSignatures: [
        { signature: SIG_TS, count: 3, recovered: 2 },
        { signature: SIG_UNKNOWN, count: 1, recovered: 0 },
      ],
      memory: { suggested: 4, succeeded: 1 },
      recent: [
        { t: NOW - 1_000, sid: 's-other', category: 'build', action: 'detected', signature: SIG_UNKNOWN },
        { t: NOW - 500, sid: 's-other', category: 'build', action: 'escalated', signature: SIG_UNKNOWN },
        { t: NOW - 50_000, sid: 's-recovered', category: 'typescript', action: 'detected', signature: SIG_TS },
      ],
      acceptedRisks: 0,
    };
    const t = await recoveryDashboard({ ...base, summary: { recovery: summary } });
    check('telemetry: counters from the summary', t.analytics.source === 'telemetry' && t.tiles.detected === 5 && t.tiles.recovered === 3);
    check('telemetry: rate uses the single definition', t.tiles.rate === 50 && t.tiles.rate === summary.rate);
    check('telemetry: mttr tile and analytics p50 share one source', t.tiles.mttrP50 === t.analytics.mttr.p50 && t.tiles.mttrP50 === 30_000, { tile: t.tiles.mttrP50, mttr: t.analytics.mttr });
    const tsCat = t.analytics.rateByCategory.find((c) => c.category === 'typescript');
    check('telemetry: category rate over ended store episodes', tsCat?.rate === 100 && tsCat.recovered === 1, t.analytics.rateByCategory);
    check('telemetry: top signatures joined with store keys', t.analytics.topSignatures[0].key === 'TS2345@src/api/user.ts' && t.analytics.topSignatures[1].key === SIG_UNKNOWN.slice(0, 8));
    const other = t.failureHistory.filter((r) => r.sessionId === 's-other');
    check('telemetry-only detections added once with their final action', other.length === 1 && other[0].outcome === 'escalated' && other[0].source === 'telemetry', other);
    check('store rows not duplicated by telemetry', t.failureHistory.filter((r) => r.signature === SIG_TS).length === 1);
    check('telemetry: memory hit rate', t.analytics.memory.hitRate === 25);
    check('bare recovery summary accepted too', (await recoveryDashboard({ ...base, summary })).tiles.detected === 5);

    // ---- Unverified, running and cancelled episodes ----
    const store2 = new RecoveryStore(path.join(dir, 'recovery2'), { owner: { kind: 'cli' }, now: () => NOW });
    const fixedAttempt = (signature: string, endedAt: number) => ({ n: 1, category: 'typescript' as const, signature, strategy: 'fix' as const, mode: 'inline' as const, patches: [], result: 'fixed' as const, startedAt: endedAt - 5_000, endedAt });
    await store2.save(state('u-done', { phase: 'completed', outcome: 'completed', recoveryStartedAt: NOW - 20_000, attempts: [fixedAttempt(SIG_TS, NOW - 10_000)] }));
    await store2.save(state('u-unverified', { phase: 'completed_unverified', outcome: 'completed_unverified', recoveryStartedAt: NOW - 20_000, attempts: [fixedAttempt(SIG_LINT, NOW - 5_000)] }));
    await store2.save(state('u-running', { phase: 'fixing', recoveryStartedAt: NOW - 3_000, attempts: [{ n: 1, category: 'typescript', signature: SIG_MEM, strategy: 'fix', mode: 'inline', patches: [], startedAt: NOW - 2_000 }] }));
    await store2.save(state('u-cancelled', { phase: 'cancelled', outcome: 'cancelled', recoveryStartedAt: NOW - 8_000, attempts: [{ n: 1, category: 'build', signature: SIG_UNKNOWN, strategy: 'fix', mode: 'inline', patches: [], startedAt: NOW - 7_000 }] }));
    const u = await recoveryDashboard({ store: store2, config, policies, running: [], days: 7, now: NOW });
    check('completed_unverified with a fixed attempt is not recovered', u.tiles.recovered === 1 && u.tiles.rate === 50, u.tiles);
    check('completed_unverified adds no mttr sample', u.tiles.mttrP50 === 10_000 && u.analytics.mttr.p90 === 10_000 && u.tiles.mttrP50 === u.analytics.mttr.p50, u.analytics.mttr);
    const uTs = u.analytics.rateByCategory.find((c) => c.category === 'typescript');
    check('a running episode does not lower its category rate', uTs?.detected === 3 && uTs.recovered === 1 && uTs.rate === 50, u.analytics.rateByCategory);
    check('category rate matches the header definition', u.analytics.rateByCategory.find((c) => c.category === 'build')?.rate === 0);
    const cancelledRow = u.failureHistory.find((r) => r.sessionId === 'u-cancelled');
    check('open attempt of a cancelled task is not "in progress"', cancelledRow?.outcome === 'cancelled', cancelledRow);
    check('open attempt of a running task stays "in progress"', u.failureHistory.find((r) => r.sessionId === 'u-running')?.outcome === 'in progress');

    // ---- Empty store ----
    const empty = await recoveryDashboard({ store: new RecoveryStore(path.join(dir, 'none'), { owner: { kind: 'cli' } }), config: { ...config, enabled: false }, policies: effectivePolicies({ enabled: false }), running: ['x'], days: 0 });
    check('empty store: zeros, rate 0, nothing listed', empty.tiles.rate === 0 && empty.tiles.detected === 0 && !empty.tiles.enabled && !empty.current.length && !empty.failureHistory.length && empty.days === 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
