import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { HealingService, RecoveryStore, type Failure, type RecoveryState } from '../agent/healing';
import { parseHealingConfig } from '../healingSettings';
import { attemptBudget, createCliHealing, restoreFile, workspaceMemoryFile } from '../cli/healing';
import { cmdRecovery, needsAttention } from '../cli/recoveryCmd';
import { attemptOf, nextCommandLines, outcomeBlock, RecoveryNotes, stateDetail } from '../cli/recoveryRender';
import { recoverySlash } from '../cli/slash/recovery';
import { SessionSummary } from '../types';

const plain = { bold: String, dim: String, red: String, green: String, yellow: String, amber: String, cyan: String };
const config = () => parseHealingConfig(<T>(_key: string, def: T) => def);
const quiet = { info: () => undefined, warn: () => undefined };

function sink(): { stream: NodeJS.WritableStream; text: () => string } {
  const chunks: string[] = [];
  return { stream: { write: (s: string) => { chunks.push(s); return true; } } as unknown as NodeJS.WritableStream, text: () => chunks.join('') };
}

function failure(extra: Partial<Failure> = {}): Failure {
  return {
    id: 'f1', category: 'typescript', cls: 'deterministic', severity: 'high', code: 'TS2345', message: "Argument of type 'string' is not assignable to parameter of type 'number'.",
    file: 'src/api/user.ts', line: 42, evidence: 'src/api/user.ts(42,7): error TS2345', source: { kind: 'check', checkId: 'npm:typecheck' }, signature: 'sig-1', generic: 'gen-1', ...extra,
  };
}

function state(sid: string, extra: Partial<RecoveryState> = {}): RecoveryState {
  const now = Date.now();
  return {
    version: 1, rev: 0, sessionId: sid, turnKey: 1, phase: 'fixing', startedAt: now, updatedAt: now, owner: { pid: 1, host: 'h', kind: 'cli' }, baseline: undefined,
    checks: { 'npm:typecheck': { fingerprint: 'x', status: 'failed', at: now, signatures: ['sig-1'] } }, changedFiles: ['src/api/user.ts'], agentWrites: {}, approvals: [], acceptedRisks: [],
    attempts: [{ n: 1, category: 'typescript', signature: 'sig-1', strategy: 'fix', mode: 'inline', rootCause: 'parseId() returns a string', patches: [], result: 'not_fixed', startedAt: now - 5000, endedAt: now }, { n: 2, category: 'typescript', signature: 'sig-1', strategy: 'fix', mode: 'inline', patches: [], startedAt: now }],
    perCategory: { typescript: 1 }, seen: {}, active: [failure()], extraStepsUsed: 0, ...extra,
  };
}

const row = (id: string): SessionSummary => ({ id, title: id, createdAt: 1, updatedAt: 1, model: 'm', mode: 'agent', messageCount: 2 });

async function tempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

suite('CLI self-healing', () => {
  test('recovery notes print only what changed, with checks and rollbacks', () => {
    const notes = new RecoveryNotes(plain);
    const card = { id: 'r1', phase: 'fixing' as const, attempt: 2, max: 3, title: 'TypeScript TS2345 in src/api/user.ts:42', rootCause: 'parseId() returns a string', decision: 'fixing' };
    assert.deepStrictEqual(notes.lines(card), ['⟲ self-healing 2/3 · TypeScript TS2345 in src/api/user.ts:42 — root cause: parseId() returns a string (fixing)']);
    assert.deepStrictEqual(notes.lines(card), [], 'the same card again prints nothing');
    const checked = notes.lines({ ...card, phase: 'validating', decision: 'validating', checks: [{ id: 'npm:typecheck', status: 'passed', ms: 4100 }, { id: 'npm:test', status: 'failed', ms: 12000 }, { id: 'npm:lint', status: 'running' }] });
    assert.strictEqual(checked.length, 2);
    assert.strictEqual(checked[1], '  ✓ typecheck 4.1s ✗ test 12.0s');
    assert.deepStrictEqual(notes.lines({ ...card, phase: 'rolling_back', decision: 'rolled back', patches: [{ file: 'src/a.ts', added: 1, removed: 2, result: 'rolled_back' }] }).slice(-1), ['  ↶ rolled back src/a.ts']);
    assert.deepStrictEqual(notes.lines({ ...card, phase: 'incomplete', outcome: 'incomplete' }), [], 'terminal phases are left to the outcome block');
  });

  test('the outcome block names the outcome, the report and the next commands', () => {
    const next = [{ action: 'resume' as const, label: 'Resume', command: '/recovery resume' }, { action: 'approveInstall' as const, label: 'Approve install', command: '/recovery resume' }, { action: 'rollback' as const, label: 'Rollback fixes', command: '/recovery rollback' }, { action: 'openChat' as const, label: 'Open chat' }];
    assert.deepStrictEqual(nextCommandLines(next), ['/recovery resume  # Resume / Approve install', '/recovery rollback  # Rollback fixes']);
    const lines = outcomeBlock({ outcome: 'incomplete', report: 'Incomplete: `npm test` still fails after 3 fix attempts.\nRoot cause: UTC vs local time\nNext: decide which', nextActions: next }, plain);
    assert.strictEqual(lines[0], 'Incomplete: `npm test` still fails after 3 fix attempts.');
    assert.ok(lines.includes('Root cause: UTC vs local time'));
    assert.ok(lines.some((l) => l.includes('/recovery rollback')));
    assert.strictEqual(outcomeBlock({ outcome: 'blocked', nextActions: [] }, plain)[0], 'Blocked.');
    assert.strictEqual(outcomeBlock({ outcome: 'completed_unverified', report: 'Verified: typecheck ✓ · tests skipped' }, plain)[0], 'Not verified:');
    assert.deepStrictEqual(outcomeBlock({ outcome: 'cancelled', report: 'x' }, plain), []);
    assert.deepStrictEqual(outcomeBlock({ outcome: 'completed' }, plain), []);
    assert.deepStrictEqual(outcomeBlock({}, plain), []);
  });

  test('a stored state shows phase, attempt N/M, category, root cause and next commands', () => {
    const s = state('cli-abc', { phase: 'interrupted' });
    assert.strictEqual(attemptOf(s), 2);
    assert.strictEqual(attemptBudget(config(), s), 3);
    const text = stateDetail(s, attemptBudget(config(), s), plain).join('\n');
    assert.match(text, /Recovery interrupted · attempt 2\/3 · typescript/);
    assert.match(text, /Root cause: parseId\(\) returns a string/);
    assert.match(text, /TS2345 src\/api\/user\.ts:42/);
    assert.match(text, /localpilot recovery resume cli-abc/);
    assert.match(stateDetail(s, 3, plain, { inRepl: true }).join('\n'), /\/recovery resume/);
    assert.ok(needsAttention(s) && needsAttention({ ...s, phase: 'blocked' }) && !needsAttention({ ...s, phase: 'completed' }));
  });

  test('localpilot recovery list / show / resume / clear', async () => {
    const dir = await tempDir('lp-cli-rec-');
    try {
      const store = new RecoveryStore(dir, { owner: { kind: 'cli' } });
      await store.save(state('cli-run'));
      await store.save(state('cli-done', { phase: 'completed', outcome: 'completed' }));
      await store.save(state('cli-other', { phase: 'blocked', outcome: 'blocked' }));
      await store.flush();
      const ctx = (json = false) => {
        const out = sink();
        const err = sink();
        return { out, err, ctx: { store: new RecoveryStore(dir, { owner: { kind: 'cli' } }), sessions: [row('cli-run'), row('cli-done')], budget: (s: RecoveryState) => attemptBudget(config(), s), style: plain, json, out: out.stream, err: err.stream } };
      };
      let c = ctx();
      assert.strictEqual((await cmdRecovery(['list'], c.ctx)).code, 0);
      assert.match(c.out.text(), /cli-run\s+interrupted/, 'a state whose owner is gone is listed as interrupted');
      assert.doesNotMatch(c.out.text(), /cli-done|cli-other/, 'finished states and other folders are not listed');
      c = ctx(true);
      await cmdRecovery([], c.ctx);
      assert.deepStrictEqual((JSON.parse(c.out.text()) as { sessionId: string }[]).map((x) => x.sessionId), ['cli-run']);
      c = ctx();
      assert.strictEqual((await cmdRecovery(['show', 'cli-run'], c.ctx)).code, 0);
      assert.match(c.out.text(), /attempt 2\/3/);
      for (const bad of [['show'], ['frobnicate'], ['show', 'nope'], ['resume'], ['list', 'x'], ['clear', 'a', 'b']]) {
        c = ctx();
        assert.strictEqual((await cmdRecovery(bad, c.ctx)).code, 2, `exit 2 for ${bad.join(' ')}`);
        assert.match(c.err.text(), /usage: localpilot recovery/);
      }
      c = ctx();
      assert.deepStrictEqual(await cmdRecovery(['resume', 'cli-run', 'use', 'UTC'], c.ctx), { code: 0, resume: 'cli-run', guidance: 'use UTC' });
      c = ctx();
      assert.strictEqual((await cmdRecovery(['resume', 'cli-other'], c.ctx)).code, 2, 'a session of another folder is not resumed here');
      c = ctx();
      assert.deepStrictEqual(await cmdRecovery(['resume', 'cli-done'], c.ctx), { code: 0 }, 'nothing to resume after a verified finish');
      c = ctx();
      await cmdRecovery(['clear'], c.ctx);
      assert.match(c.out.text(), /cleared 1 recovery state/);
      const after = new RecoveryStore(dir, { owner: { kind: 'cli' } });
      assert.strictEqual(await after.load('cli-done'), undefined);
      assert.ok(await after.load('cli-run'), 'an interrupted state is only cleared by id');
      c = ctx();
      await cmdRecovery(['clear', 'cli-run'], c.ctx);
      assert.strictEqual(await new RecoveryStore(dir, { owner: { kind: 'cli' } }).load('cli-run'), undefined);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test('resume refuses a recovery running in another window and phases with nothing to continue', async () => {
    const dir = await tempDir('lp-cli-rec-lock-');
    try {
      const other = new RecoveryStore(dir, { owner: { kind: 'vscode' }, host: 'other-host', pid: 4242 });
      await other.save(state('cli-live', { phase: 'verifying' }));
      await other.save(state('cli-idle', { phase: 'idle' }));
      await other.save(state('cli-failed', { phase: 'failed', outcome: 'failed' }));
      await other.save(state('cli-handled', { phase: 'blocked', outcome: 'blocked', intervention: { id: 'i1', kind: 'escalation', title: 't', rootCause: 'r', nextActions: [], createdAt: 1, resolvedAt: 2 } as unknown as RecoveryState['intervention'] }));
      await other.flush();
      assert.strictEqual(await other.acquire('cli-live'), 'owned');
      const mk = () => {
        const out = sink();
        const err = sink();
        const store = new RecoveryStore(dir, { owner: { kind: 'cli' } });
        return { out, err, store, ctx: { store, sessions: ['cli-live', 'cli-idle', 'cli-failed', 'cli-handled'].map(row), budget: () => 3, style: plain, out: out.stream, err: err.stream } };
      };
      let c = mk();
      assert.deepStrictEqual(await cmdRecovery(['resume', 'cli-live'], c.ctx), { code: 1 });
      assert.match(c.err.text(), /running in another window/);
      assert.ok(!c.store.isOwned('cli-live') && !c.store.isReadonly('cli-live'), 'the check keeps no lock');
      for (const sid of ['cli-idle', 'cli-failed', 'cli-handled']) {
        c = mk();
        assert.deepStrictEqual(await cmdRecovery(['resume', sid], c.ctx), { code: 0 }, `${sid} is not resumed`);
        assert.match(c.out.text(), /nothing to resume/);
      }
      const resumed: (string | undefined)[] = [];
      const slash = async (sid: string): Promise<string> => {
        const out = sink();
        const store = new RecoveryStore(dir, { owner: { kind: 'cli' } });
        const service = {} as unknown as HealingService;
        await recoverySlash('recovery', 'resume', { service, store, sessionId: () => sid, root: () => dir, budget: () => 3, resume: async (g) => { resumed.push(g); }, style: plain, out: out.stream });
        return out.text();
      };
      assert.match(await slash('cli-live'), /running in another window/);
      assert.match(await slash('cli-failed'), /nothing to resume/);
      assert.deepStrictEqual(resumed, []);
      await other.release('cli-live');
      c = mk();
      assert.deepStrictEqual(await cmdRecovery(['resume', 'cli-live'], c.ctx), { code: 0, resume: 'cli-live' }, 'resumable once the other window lets go');
      assert.ok(!c.store.isOwned('cli-live'), 'main takes the lock when the resume turn starts, not the command');
      await slash('cli-live');
      assert.deepStrictEqual(resumed, [undefined]);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test('/recovery status, history, rollback usage and dismiss', async () => {
    const home = await tempDir('lp-cli-rec-home-');
    try {
      const { service, store } = createCliHealing({ cwd: home, home, config, log: quiet, isTrusted: () => false, approve: async () => false });
      assert.ok(service instanceof HealingService);
      await store.save(state('cli-s', { phase: 'interrupted' }));
      await store.flush();
      const resumed: (string | undefined)[] = [];
      const run = async (arg: string): Promise<string> => {
        const out = sink();
        assert.ok(await recoverySlash('recovery', arg, { service, store, sessionId: () => 'cli-s', root: () => home, budget: (s) => attemptBudget(config(), s), resume: async (g) => { resumed.push(g); }, style: plain, out: out.stream }));
        return out.text();
      };
      assert.strictEqual(await recoverySlash('history', '', { service, store, sessionId: () => 'cli-s', root: () => home, budget: () => 3, resume: async () => undefined, style: plain }), false);
      assert.match(await run(''), /Recovery interrupted · attempt 2\/3[\s\S]*Checks: ✗ typecheck/);
      assert.match(await run('history'), /1\. typescript · fix · not fixed[\s\S]*root cause: parseId\(\)[\s\S]*2\. typescript · fix · in progress/);
      assert.match(await run('rollback x'), /usage: \/recovery rollback/);
      assert.match(await run('rollback 9'), /no attempt 9/);
      await run('resume use UTC');
      assert.deepStrictEqual(resumed, ['use UTC']);
      assert.match(await run('dismiss'), /recovery dismissed/);
      assert.strictEqual((await store.load('cli-s'))?.phase, 'cancelled');
      assert.match(await run('bogus'), /usage: \/recovery/);
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  test('the workspace failure memory lives under ~/.localpilot/recovery/<folder hash>', async () => {
    const home = await tempDir('lp-cli-mem-');
    try {
      const file = workspaceMemoryFile(path.join(home, 'recovery'), '/work/project');
      assert.match(path.relative(home, file), /^recovery[\\/][0-9a-f]{12}[\\/]memory\.json$/);
      assert.strictEqual(file, workspaceMemoryFile(path.join(home, 'recovery'), '/work/project/'), 'the same folder hashes the same');
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  test('rollback restores files the way the change tracker does', async () => {
    const root = await tempDir('lp-cli-restore-');
    try {
      const created = path.join(root, 'src', 'new.ts');
      await fs.mkdir(path.dirname(created), { recursive: true });
      await fs.writeFile(created, 'export const added = 1;\n');
      await restoreFile(created, undefined);
      await assert.rejects(fs.stat(created), 'a file that did not exist before is removed');
      const deleted = path.join(root, 'lib', 'gone.ts');
      await restoreFile(deleted, 'export const back = 2;\n');
      assert.strictEqual(await fs.readFile(deleted, 'utf8'), 'export const back = 2;\n', 'a deleted file is recreated with its folder');
      await restoreFile(path.join(root, 'missing.ts'), undefined);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
