/**
 * Smoke checks for src/agent/healing/checkRunner.ts (design §2.4-2.5) with a fake executor.
 *   node scripts/healing/run.js scripts/healing/checkRunner.smoke.ts
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CheckRunner, SKIP_BUDGET, SKIP_DEADLINE, SKIP_WORKTREE_DEPS, treeFingerprint, type CheckExec } from '../../src/agent/healing/checkRunner';
import { classify } from '../../src/agent/healing/classifier';
import { CheckSemaphore } from '../../src/agent/healing/scheduler';
import type { CheckCacheEntry, CheckSpec, ExecResult, Failure } from '../../src/agent/healing/types';

type Check = (name: string, cond: boolean, detail?: unknown) => void;

function workspace(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lp-runner-'));
  for (const [rel, body] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body);
  }
  return root;
}

const spec = (id: string, kind: CheckSpec['kind'], extra: Partial<CheckSpec> = {}): CheckSpec => ({
  id, kind, command: `run ${id}`, timeoutSeconds: 60, required: kind !== 'lint', source: 'discovered', ecosystem: 'node', ...extra,
});

const NODE_SPECS = (): CheckSpec[] => [
  spec('npm:test', 'test', { scoped: 'npx mocha {tests}' }),
  spec('npm:lint', 'lint'),
  spec('npm:build', 'build'),
  spec('npm:typecheck', 'typecheck'),
];

const TS_ERROR = "src/a.ts(3,7): error TS2322: Type 'string' is not assignable to type 'number'.";

interface Fake {
  exec: CheckExec;
  calls: string[];
  active: () => number;
  maxActive: () => number;
}

function fakeExec(outcomes: Record<string, ExecResult | ((signal: AbortSignal) => Promise<ExecResult>)>, delayMs = 0): Fake {
  const calls: string[] = [];
  let active = 0;
  let maxActive = 0;
  const exec: CheckExec = async (s, signal) => {
    calls.push(s.command);
    active++;
    maxActive = Math.max(maxActive, active);
    try {
      if (delayMs) {
        await new Promise((r) => setTimeout(r, delayMs));
      }
      const o = outcomes[s.id] ?? { exitCode: 0, output: 'ok' };
      return typeof o === 'function' ? await o(signal) : o;
    } finally {
      active--;
    }
  };
  return { exec, calls, active: () => active, maxActive: () => maxActive };
}

const hang = (signal: AbortSignal) =>
  new Promise<ExecResult>((resolve) => signal.addEventListener('abort', () => resolve({ exitCode: null, output: 'killed' }), { once: true }));

export async function checkRunnerSmoke(check: Check): Promise<void> {
  const temps: string[] = [];
  const ws = (files: Record<string, string>) => {
    const r = workspace(files);
    temps.push(r);
    return r;
  };
  const signal = new AbortController().signal;
  try {
    const root = ws({
      'package.json': '{"scripts":{}}',
      'src/a.ts': 'export const a = 1;',
      'src/a.test.ts': "import { a } from './a';",
      'README.md': '# x',
      'node_modules/.keep': '',
    });

    // ---- stage order + fail fast ----
    {
      const fake = fakeExec({ 'npm:typecheck': { exitCode: 2, output: TS_ERROR } });
      const runner = new CheckRunner({ exec: fake.exec, semaphore: new CheckSemaphore(1), classify });
      const r = await runner.runStages({ specs: NODE_SPECS(), root, changedFiles: ['src/a.ts'], scoped: true, budgetMs: 60_000, signal, cache: {} });
      check('build stage runs build and typecheck only, then stops', JSON.stringify(fake.calls) === JSON.stringify(['run npm:build', 'run npm:typecheck']), fake.calls);
      check('stoppedAt = build', r.stoppedAt === 'build' && !r.budgetExhausted, r);
      check('typescript failure classified from raw output', r.failures.length === 1 && r.failures[0].category === 'typescript' && r.failures[0].code === 'TS2322', r.failures);
      check('result statuses', r.results.map((x) => `${x.checkId}=${x.status}`).join(',') === 'npm:build=passed,npm:typecheck=failed', r.results);
    }
    {
      const fake = fakeExec({ 'npm:lint': { exitCode: 1, output: 'lint broke' } });
      const runner = new CheckRunner({ exec: fake.exec, semaphore: new CheckSemaphore(1), classify });
      const r = await runner.runStages({ specs: NODE_SPECS(), root, changedFiles: [path.join(root, 'src/a.ts')], scoped: true, budgetMs: 60_000, signal, cache: {} });
      check('order build -> lint -> scoped test -> full test', JSON.stringify(fake.calls) === JSON.stringify(['run npm:build', 'run npm:typecheck', 'run npm:lint', 'npx mocha src/a.test.ts', 'run npm:test']), fake.calls);
      check('non-required lint failure does not stop', !r.stoppedAt && r.results.find((x) => x.checkId === 'npm:lint')?.status === 'failed', r.results);
      check('scoped run reported as #scoped', r.results.some((x) => x.checkId === 'npm:test#scoped' && x.status === 'passed'), r.results.map((x) => x.checkId));
    }
    {
      const fake = fakeExec({ 'npm:test': { exitCode: 1, output: 'tests failed' } });
      const runner = new CheckRunner({ exec: fake.exec, semaphore: new CheckSemaphore(1), classify });
      const r = await runner.runStages({ specs: [...NODE_SPECS(), spec('security', 'security', { command: '', ecosystem: 'custom' })], root, changedFiles: ['src/a.ts'], scoped: false, budgetMs: 60_000, signal, cache: {} });
      check('scoped=false runs only the full test; failing test stops before security', !fake.calls.includes('npx mocha src/a.test.ts') && r.stoppedAt === 'test' && !r.results.some((x) => x.checkId === 'security'), { calls: fake.calls, r: r.results });
    }

    // ---- cache reuse ----
    {
      const fake = fakeExec({});
      const runner = new CheckRunner({ exec: fake.exec, semaphore: new CheckSemaphore(1), classify });
      const cache: Record<string, CheckCacheEntry> = {};
      const base = { specs: NODE_SPECS(), root, changedFiles: ['src/a.ts'], scoped: true, budgetMs: 60_000, signal, cache };
      const first = await runner.runStages(base);
      const n = fake.calls.length;
      const second = await runner.runStages(base);
      check('identical fingerprint reuses every passed check', fake.calls.length === n && second.results.every((x) => x.status === 'passed' && x.durationMs === 0) && first.fingerprint === second.fingerprint, { n, calls: fake.calls.length });
      check('cache entries written', cache['npm:typecheck']?.status === 'passed' && cache['npm:test#scoped']?.fingerprint === first.fingerprint, cache);
      const later = new Date(Date.now() + 5000);
      fs.utimesSync(path.join(root, 'src/a.ts'), later, later);
      await runner.runStages(base);
      check('changed mtime invalidates the cache', fake.calls.length === n * 2, fake.calls.length);
      const before = fake.calls.length;
      await runner.runStages({ ...base, changedFiles: ['*'] });
      check('unknown changes never use the cache (no scoped run)', fake.calls.length === before + n - 1, fake.calls.length - before);
      const fp1 = await treeFingerprint(root, ['src/a.ts']);
      fs.utimesSync(path.join(root, 'package.json'), later, later);
      check('manifest mtime is part of the fingerprint', fp1 !== (await treeFingerprint(root, ['src/a.ts'])));
    }

    // ---- budget exhaustion -> timeout ----
    {
      const fake = fakeExec({ 'npm:typecheck': hang });
      const runner = new CheckRunner({ exec: fake.exec, semaphore: new CheckSemaphore(1), classify });
      const t0 = Date.now();
      const r = await runner.runStages({ specs: NODE_SPECS(), root, changedFiles: ['src/a.ts'], scoped: true, budgetMs: 150, signal, cache: {} });
      const tc = r.results.find((x) => x.checkId === 'npm:typecheck');
      check('check killed at the remaining budget -> timeout', tc?.status === 'timeout' && Date.now() - t0 < 2000, r.results);
      check('timeout classified check_timeout', tc?.failures[0]?.category === 'check_timeout', tc?.failures);
      check('budgetExhausted and later checks skipped (not failed)', r.budgetExhausted && r.results.filter((x) => x.status === 'skipped').every((x) => x.skipReason === SKIP_BUDGET) && r.results.some((x) => x.status === 'skipped') && !r.stoppedAt, r.results);
      const passed: ExecResult = { exitCode: null, output: '', timedOut: true };
      const r2 = await new CheckRunner({ exec: fakeExec({ 'npm:build': passed }).exec, semaphore: new CheckSemaphore(1), classify })
        .runStages({ specs: NODE_SPECS(), root, changedFiles: ['src/a.ts'], scoped: true, budgetMs: 60_000, signal, cache: {} });
      check('executor-reported timeout -> timeout, run continues', r2.results[0].status === 'timeout' && !r2.budgetExhausted && r2.results.length === 5, r2.results);
      let seenTimeout = 0;
      await new CheckRunner({ exec: async (s) => ((seenTimeout = s.timeoutSeconds), { exitCode: 0, output: '' }), semaphore: new CheckSemaphore(1), classify })
        .runStages({ specs: [spec('npm:build', 'build', { timeoutSeconds: 300 })], root, changedFiles: ['src/a.ts'], scoped: false, budgetMs: 60_000, deadlineAt: Date.now() + 10_000, signal, cache: {} });
      check('per-check timeout = min(spec, budget, deadline)', seenTimeout > 0 && seenTimeout <= 10, seenTimeout);
    }

    // ---- budget / deadline spent before a check starts -> skipped, not timeout ----
    {
      let t = 1_000_000;
      const slowFail = async (): Promise<ExecResult> => ((t += 1000), { exitCode: 1, output: 'build broke' });
      const fake = fakeExec({ 'npm:build': slowFail });
      const runner = new CheckRunner({ exec: fake.exec, semaphore: new CheckSemaphore(1), classify, now: () => t });
      const r = await runner.runStages({ specs: NODE_SPECS(), root, changedFiles: ['src/a.ts'], scoped: true, budgetMs: 500, signal, cache: {} });
      const tc = r.results.find((x) => x.checkId === 'npm:typecheck');
      check('spent budget: next check skipped with SKIP_BUDGET, no failures', tc?.status === 'skipped' && tc.skipReason === SKIP_BUDGET && !tc.failures.length && !r.failures.some((f) => f.category === 'check_timeout'), r.results);
      check('spent budget: budgetExhausted, never started', r.budgetExhausted && JSON.stringify(fake.calls) === '["run npm:build"]', { r, calls: fake.calls });
      const fake2 = fakeExec({ 'npm:build': slowFail });
      const r2 = await new CheckRunner({ exec: fake2.exec, semaphore: new CheckSemaphore(1), classify, now: () => t })
        .runStages({ specs: NODE_SPECS(), root, changedFiles: ['src/a.ts'], scoped: true, budgetMs: 60_000, deadlineAt: t + 500, signal, cache: {} });
      const tc2 = r2.results.find((x) => x.checkId === 'npm:typecheck');
      check('passed deadline: next check skipped with SKIP_DEADLINE', tc2?.status === 'skipped' && tc2.skipReason === SKIP_DEADLINE && !tc2.failures.length && r2.budgetExhausted && fake2.calls.length === 1, r2.results);
      const fake3 = fakeExec({});
      const b = await new CheckRunner({ exec: fake3.exec, semaphore: new CheckSemaphore(1), classify, now: () => t })
        .runBaseline({ specs: NODE_SPECS(), root, mode: 'fast', key: 'dl', deadlineAt: t - 1, signal });
      check('baseline past deadline: all skipped SKIP_DEADLINE, nothing run', b.budgetExhausted && !fake3.calls.length && b.results.length === 2 && b.results.every((x) => x.status === 'skipped' && x.skipReason === SKIP_DEADLINE && !x.failures.length), b.results);
    }

    // ---- semaphore wait is bounded by the budget ----
    {
      const sem = new CheckSemaphore(1);
      const holderCtrl = new AbortController();
      const holder = new CheckRunner({ exec: fakeExec({ 'npm:build': hang }).exec, semaphore: sem, classify })
        .runStages({ specs: NODE_SPECS(), root, changedFiles: ['src/a.ts'], scoped: true, budgetMs: 60_000, signal: holderCtrl.signal, cache: {} })
        .then(() => undefined, (e: Error) => e);
      await new Promise((res) => setTimeout(res, 20));
      const waiter = fakeExec({});
      const t0 = Date.now();
      const r = await new CheckRunner({ exec: waiter.exec, semaphore: sem, classify })
        .runStages({ specs: NODE_SPECS(), root, changedFiles: ['src/a.ts'], scoped: true, budgetMs: 150, signal, cache: {} });
      const took = Date.now() - t0;
      check('blocked on the semaphore: returns at the budget with budgetExhausted', took < 1000 && r.budgetExhausted && !waiter.calls.length, { took, r: r.results });
      check('blocked on the semaphore: checks skipped with SKIP_BUDGET, no failures', r.results.length > 0 && r.results.every((x) => x.status === 'skipped' && x.skipReason === SKIP_BUDGET) && !r.failures.length, r.results);
      holderCtrl.abort();
      const err = await holder;
      check('holder released on abort', err?.name === 'AbortError' && Object.values(sem.stats().roots).every((l) => l.active === 0 && l.waiting === 0), sem.stats());
    }

    // ---- skipped with skipReason ----
    {
      const fake = fakeExec({ 'npm:build': { exitCode: null, output: 'denied', skipped: { deniedByUser: true } }, 'npm:typecheck': { exitCode: null, output: '', skipped: { blockedBy: 'unattended' } } });
      const runner = new CheckRunner({ exec: fake.exec, semaphore: new CheckSemaphore(1), classify });
      const r = await runner.runStages({ specs: NODE_SPECS(), root, changedFiles: ['src/a.ts'], scoped: true, budgetMs: 60_000, signal, cache: {} });
      const b = r.results.find((x) => x.checkId === 'npm:build');
      const t = r.results.find((x) => x.checkId === 'npm:typecheck');
      check('denied -> skipped "denied by user", no failures', b?.status === 'skipped' && b.skipReason === 'denied by user' && !b.failures.length, b);
      check('unattended -> skipped with reason', t?.status === 'skipped' && /unattended/.test(t.skipReason ?? ''), t);
      check('skipped checks do not stop the run', !r.stoppedAt && r.results.length === 5, r.results.length);
    }

    // ---- semaphore ----
    {
      const sem = new CheckSemaphore(1);
      const fake = fakeExec({}, 20);
      const runner = new CheckRunner({ exec: fake.exec, semaphore: sem, classify });
      const runs = [0, 1, 2].map(() => runner.runStages({ specs: NODE_SPECS(), root, changedFiles: ['src/a.ts'], scoped: true, budgetMs: 60_000, signal, cache: {} }));
      await Promise.all(runs);
      check('semaphore: never two checks at once across runs', fake.maxActive() === 1 && sem.stats().maxConcurrent === 1 && fake.calls.length === 15, { max: fake.maxActive(), calls: fake.calls.length });
      check('semaphore released', Object.keys(sem.stats().roots).length === 0, sem.stats());
    }

    // ---- out of scope / when ----
    {
      const fake = fakeExec({});
      const runner = new CheckRunner({ exec: fake.exec, semaphore: new CheckSemaphore(1), classify });
      const r = await runner.runStages({ specs: NODE_SPECS(), root, changedFiles: ['README.md', '.localpilot/recovery-memory.json'], scoped: true, budgetMs: 60_000, signal, cache: {} });
      check('docs-only change is out of scope, nothing runs', r.outOfScope === true && !r.results.length && !fake.calls.length, r);
      const e2e = spec('custom:e2e', 'test', { when: ['src/api/**'] });
      await runner.runStages({ specs: [e2e, spec('npm:typecheck', 'typecheck')], root, changedFiles: ['src/a.ts'], scoped: false, budgetMs: 60_000, signal, cache: {} });
      check('when globs filter specs', JSON.stringify(fake.calls) === JSON.stringify(['run npm:typecheck']), fake.calls);
      const docs = await runner.runStages({ specs: [spec('custom:docs', 'custom', { when: ['docs/**/*.md'] })], root, changedFiles: ['docs/guide/x.md'], scoped: false, budgetMs: 60_000, signal, cache: {} });
      check('explicit when glob matches even for docs', docs.results.length === 1 && !docs.outOfScope, docs);
    }

    // ---- security stage ----
    {
      const sec = spec('security', 'security', { command: '', ecosystem: 'custom' });
      const finding = classify({ kind: 'check', spec: { id: 'npm:lint', kind: 'lint', ecosystem: 'node' }, outcome: { exitCode: 1, output: 'boom' } })[0];
      const secFailure: Failure = { ...finding, category: 'security', severity: 'high', message: 'hardcoded secret' };
      let scanned: string[] = [];
      const runner = new CheckRunner({ exec: fakeExec({}).exec, semaphore: new CheckSemaphore(1), classify, securityScan: async (_r, files) => ((scanned = files), [secFailure]) });
      const r = await runner.runStages({ specs: [...NODE_SPECS(), sec], root, changedFiles: ['src/a.ts', 'README.md'], scoped: false, budgetMs: 60_000, signal, cache: {} });
      const s = r.results.find((x) => x.checkId === 'security');
      check('security stage runs last, in process, over in-scope changed files', r.results[r.results.length - 1] === s && s?.status === 'failed' && JSON.stringify(scanned) === '["src/a.ts"]' && r.stoppedAt === 'security', { s, scanned });
      const none = await new CheckRunner({ exec: fakeExec({}).exec, semaphore: new CheckSemaphore(1), classify }).runStages({ specs: [sec], root, changedFiles: ['src/a.ts'], scoped: false, budgetMs: 60_000, signal, cache: {} });
      check('no scanner -> security skipped', none.results[0]?.status === 'skipped', none.results);
    }

    // ---- worktree dependency detection ----
    {
      const main = ws({ 'package.json': '{}', 'src/a.ts': '', 'node_modules/typescript/package.json': '{}' });
      const wt = ws({ 'package.json': '{}', 'src/a.ts': '' });
      const fake = fakeExec({ 'npm:typecheck': { exitCode: 2, output: "src/a.ts(1,20): error TS2307: Cannot find module 'typescript' or its corresponding type declarations." } });
      const runner = new CheckRunner({ exec: fake.exec, semaphore: new CheckSemaphore(1), classify, mainRoot: main });
      check('missing node_modules detected', JSON.stringify(runner.missingDependencies(wt, { ecosystem: 'node' })) === '["node_modules"]' && !runner.missingDependencies(main, { ecosystem: 'node' }).length);
      const r = await runner.runStages({ specs: NODE_SPECS(), root: wt, changedFiles: ['src/a.ts'], scoped: true, budgetMs: 60_000, signal, cache: {} });
      check('worktree without node_modules: checks skipped, not run', !fake.calls.length && r.results.every((x) => x.status === 'skipped' && x.skipReason === SKIP_WORKTREE_DEPS), r.results);
      check('no dependency failure, runAgainstMain set', !r.failures.some((f) => f.category === 'dependency') && !r.failures.length && r.runAgainstMain === true, r);
      const py = await runner.runStages({ specs: [spec('pytest', 'test', { ecosystem: 'python', command: 'python -m pytest' })], root: wt, changedFiles: ['x.py'], scoped: false, budgetMs: 60_000, signal, cache: {} });
      check('other ecosystems still run in the worktree', py.results[0]?.status === 'passed' && !py.runAgainstMain, py);
    }

    // ---- worktree roots get their own semaphore lane ----
    {
      const main = ws({ 'package.json': '{}', 'src/a.ts': '' });
      const wt1 = ws({ 'package.json': '{}', 'src/a.ts': '' });
      const wt2 = ws({ 'package.json': '{}', 'src/a.ts': '' });
      const sem = new CheckSemaphore(1);
      const fake = fakeExec({}, 50);
      const run = (r: string) => new CheckRunner({ exec: fake.exec, semaphore: sem, classify, mainRoot: main })
        .runStages({ specs: [spec('npm:build', 'build')], root: r, changedFiles: ['src/a.ts'], scoped: false, budgetMs: 60_000, signal, cache: {} });
      const [a, b] = await Promise.all([run(wt1), run(wt2)]);
      check('two worktrees under a 1-permit semaphore run in parallel', fake.maxActive() === 2 && a.results[0]?.status === 'passed' && b.results[0]?.status === 'passed', { max: fake.maxActive(), a: a.results, b: b.results });
    }

    // ---- baseline ----
    {
      const fake = fakeExec({ 'npm:typecheck': { exitCode: 2, output: TS_ERROR } });
      const runner = new CheckRunner({ exec: fake.exec, semaphore: new CheckSemaphore(1), classify });
      const specs = [...NODE_SPECS(), spec('custom:e2e', 'test', { when: ['src/api/**'] }), spec('security', 'security', { command: '', ecosystem: 'custom' })];
      const b = await runner.runBaseline({ specs, root, mode: 'fast', key: 'k1', signal });
      check('baseline fast = typecheck + lint only (no build, tests, security)', JSON.stringify(fake.calls) === JSON.stringify(['run npm:typecheck', 'run npm:lint']), fake.calls);
      check('baseline signatures recorded, no fail fast', b.signatures.length === 1 && b.results.length === 2 && b.fingerprint === 'k1', b);
      const again = await runner.runBaseline({ specs, root, mode: 'fast', key: 'k1', signal });
      check('baseline cached by whole-tree key', again.cached === true && fake.calls.length === 2 && again.signatures[0] === b.signatures[0]);
      await runner.runBaseline({ specs, root, mode: 'fast', key: 'k2', signal });
      check('new key reruns the baseline', fake.calls.length === 4, fake.calls.length);
      const before = fake.calls.length;
      const all = await runner.runBaseline({ specs, root, mode: 'all', key: 'k1', signal });
      check('baseline all = every non-security check without when', fake.calls.length - before === 4 && all.results.length === 4, fake.calls.slice(before));
    }

    // ---- cancellation ----
    {
      const ctrl = new AbortController();
      const runner = new CheckRunner({ exec: fakeExec({ 'npm:build': hang }).exec, semaphore: new CheckSemaphore(1), classify });
      const p = runner.runStages({ specs: NODE_SPECS(), root, changedFiles: ['src/a.ts'], scoped: true, budgetMs: 60_000, signal: ctrl.signal, cache: {} });
      setTimeout(() => ctrl.abort(), 20);
      const err = await p.then(() => undefined, (e: Error) => e);
      check('outer abort rejects with AbortError', err?.name === 'AbortError', err);
    }
  } finally {
    for (const t of temps) {
      fs.rmSync(t, { recursive: true, force: true });
    }
  }
}
