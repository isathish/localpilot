/**
 * Smoke checks for src/agent/healing/policy.ts + retryController.ts and the overload classification (design §4.2-4.4).
 *   node scripts/healing/run.js scripts/healing/retry.smoke.ts
 */
import { errorKind } from '../../src/agent/agentLoop';
import { DEFAULT_POLICIES, LEGACY_POLICIES, effectivePolicies } from '../../src/agent/healing/policy';
import { DecideContext, backoffMs, decide } from '../../src/agent/healing/retryController';
import type { AttemptRecord, Failure, FailureCategory, FailureClass, RecoveryState } from '../../src/agent/healing/types';
import { classifyModelError, describeModelError, isTransient } from '../../src/agent/resilience';
import { HttpError } from '../../src/providers/http';

type Check = (name: string, cond: boolean, detail?: unknown) => void;

const state = (over: Partial<RecoveryState> = {}): RecoveryState => ({
  version: 1, rev: 0, sessionId: 's', turnKey: 0, phase: 'classifying', startedAt: 0, updatedAt: 0,
  owner: { pid: 1, host: 'h', kind: 'cli' }, baseline: undefined, checks: {}, changedFiles: [], agentWrites: {},
  approvals: [], acceptedRisks: [], attempts: [], perCategory: {}, seen: {}, active: [], extraStepsUsed: 0, ...over,
});
const failure = (category: FailureCategory, cls: FailureClass, over: Partial<Failure> = {}): Failure => ({
  id: 'f', category, cls, severity: 'high', message: 'm', evidence: '', source: { kind: 'check' }, signature: 'sig', generic: 'g', ...over,
});
const attempt = (category: FailureCategory, over: Partial<AttemptRecord> = {}): AttemptRecord => ({
  n: 1, category, signature: 'sig', strategy: 'fix', mode: 'inline', patches: [], startedAt: 0, ...over,
});
const ctx = (over: Partial<DecideContext> = {}): DecideContext => ({
  now: 1000, recoveryActive: true, totalCap: 8, delegateAllowed: false, independentGroups: 1, random: () => 0.5, ...over,
});
const pol = effectivePolicies({ enabled: true, maxRepairAttempts: 3, policies: {} });

export async function retrySmoke(check: Check): Promise<void> {
  // ---- policies ----
  check('legacy model policies equal the loop constants', LEGACY_POLICIES.model_unavailable.attempts === 2 && LEGACY_POLICIES.model_unavailable.backoffMs.join() === '800,2500' && !LEGACY_POLICIES.model_unavailable.exponential && LEGACY_POLICIES.model_output.attempts === 2 && LEGACY_POLICIES.model_overload.cls === 'transient' && LEGACY_POLICIES.compile.attempts === 0);
  check('disabled healing -> legacy policies', effectivePolicies({ enabled: false, policies: { model_unavailable: { attempts: 7 } } }).model_unavailable.attempts === 2);
  check('defaults per the table', DEFAULT_POLICIES.model_unavailable.attempts === 3 && DEFAULT_POLICIES.model_overload.cls === 'environmental' && DEFAULT_POLICIES.model_overload.backoffMs.join() === '2000,5000' && DEFAULT_POLICIES.dependency.attempts === 1 && DEFAULT_POLICIES.git_conflict.attempts === 0 && DEFAULT_POLICIES.security.attempts === 2);
  const clamped = effectivePolicies({ maxRepairAttempts: 2, policies: { data_corruption: { attempts: 5 }, git_conflict: { attempts: 3 }, security: { attempts: 9 }, permission: { attempts: 4 }, loop: { attempts: 2 }, unit_test: { attempts: 6 }, model_unavailable: { attempts: 5, backoffMs: [10, 20] } } });
  check('safety clamps: corruption/conflict/permission/loop 0', clamped.data_corruption.attempts === 0 && clamped.git_conflict.attempts === 0 && clamped.permission.attempts === 0 && clamped.loop.attempts === 0, clamped);
  check('security <= 3 and <= maxRepairAttempts', clamped.security.attempts === 2 && effectivePolicies({ maxRepairAttempts: 10, policies: { security: { attempts: 9 } } }).security.attempts === 3);
  check('maxRepairAttempts caps code categories only', clamped.unit_test.attempts === 2 && clamped.typescript.attempts === 2 && clamped.model_unavailable.attempts === 5);
  check('listed backoff replaces exponential', clamped.model_unavailable.backoffMs.join() === '10,20' && !clamped.model_unavailable.exponential);
  check('defaults are not mutated by overrides', DEFAULT_POLICIES.model_unavailable.attempts === 3 && DEFAULT_POLICIES.model_unavailable.exponential === true);

  // ---- backoff ----
  const exp = pol.model_unavailable;
  check('exponential backoff 1s, 2s, 4s at mid random', [1, 2, 3].map((n) => backoffMs(exp, n, () => 0.5)).join() === '1000,2000,4000');
  check('jitter is +-20%', backoffMs(exp, 1, () => 0) === 800 && backoffMs(exp, 1, () => 1) === 1200 && backoffMs(exp, 2, () => 1) === 2400);
  check('backoff capped at 60s', backoffMs(exp, 10, () => 1) === 60_000);
  check('fixed list repeats the last value', [1, 2, 3].map((n) => backoffMs(pol.model_overload, n, () => 0.9)).join() === '2000,5000,5000');
  check('empty list = no wait', backoffMs(pol.compile, 1) === 0);

  // ---- rule 1: abort, deadline ----
  const ac = new AbortController();
  ac.abort();
  check('aborted -> cancel', decide(state(), failure('compile', 'deterministic'), pol.compile, ctx({ signal: ac.signal })).action === 'cancel');
  const late = decide(state(), failure('compile', 'deterministic'), pol.compile, ctx({ now: 5000, deadlineAt: 4000 }));
  check('deadline passed while recovering -> escalate deadline', late.action === 'escalate' && late.reason === 'deadline', late);
  check('deadline ignored without active recovery', decide(state(), failure('compile', 'deterministic'), pol.compile, ctx({ now: 5000, deadlineAt: 4000, recoveryActive: false })).action === 'fix');

  // ---- rule 2: fatal / zero attempts ----
  const corrupt = decide(state(), failure('data_corruption', 'fatal'), pol.data_corruption, ctx());
  check('data corruption -> escalate data_corruption', corrupt.action === 'escalate' && corrupt.reason === 'data_corruption', corrupt);
  const conflict = decide(state(), failure('git_conflict', 'policy'), pol.git_conflict, ctx());
  check('git conflict (0 attempts) -> escalate git_conflict', conflict.action === 'escalate' && conflict.reason === 'git_conflict', conflict);
  const auth = decide(state(), failure('permission', 'policy', { code: 'auth', source: { kind: 'model' } }), pol.permission, ctx());
  check('auth -> escalate credentials', auth.action === 'escalate' && auth.reason === 'credentials', auth);
  const denied = decide(state(), failure('permission', 'policy', { source: { kind: 'tool' } }), pol.permission, ctx());
  check('denied approval -> escalate approval_needed', denied.action === 'escalate' && denied.reason === 'approval_needed', denied);

  // ---- rule 3: ignore ----
  const pre = decide(state(), failure('typescript', 'deterministic', { preexisting: true }), pol.typescript, ctx());
  check('preexisting -> ignore', pre.action === 'ignore' && pre.why === 'preexisting', pre);
  const foreign = decide(state(), failure('typescript', 'deterministic', { foreign: true }), pol.typescript, ctx());
  check('foreign -> ignore', foreign.action === 'ignore' && foreign.why === 'foreign', foreign);
  const lint = decide(state(), failure('lint', 'deterministic'), pol.lint, ctx({ required: false }));
  check('non-required -> ignore', lint.action === 'ignore' && lint.why === 'non_required', lint);

  // ---- rule 4: duplicates, no-change, identical patch ----
  const seen = (afterFix: number) => ({ sig: { count: afterFix + 1, afterFix, firstAt: 0 } });
  const dup = decide(state({ seen: seen(2), perCategory: { typescript: 2 } }), failure('typescript', 'deterministic'), pol.typescript, ctx());
  check('signature survived two fixes -> escalate duplicate', dup.action === 'escalate' && dup.reason === 'duplicate', dup);
  const rep = decide(state({ seen: seen(1), perCategory: { typescript: 1 } }), failure('typescript', 'deterministic', { severity: 'medium' }), pol.typescript, ctx());
  check('first repeat raises severity and keeps fixing', rep.action === 'fix' && rep.attempt === 2 && rep.raiseSeverity === 'high', rep);
  const noChange = decide(state({ perCategory: { typescript: 0 } }), failure('typescript', 'deterministic'), pol.typescript, ctx({ ended: { changedFiles: 0, patchHashes: [] } }));
  check('no-change attempt -> not_fixed without validation, counted', noChange.action === 'fix' && noChange.attempt === 2 && noChange.raiseSeverity === 'critical' && noChange.settled?.result === 'not_fixed' && noChange.settled.validate === false, noChange);
  const noChange2 = decide(state({ seen: seen(1), perCategory: { typescript: 1 } }), failure('typescript', 'deterministic'), pol.typescript, ctx({ ended: { changedFiles: 0, patchHashes: [] } }));
  check('second no-change after a failed fix -> escalate duplicate', noChange2.action === 'escalate' && noChange2.reason === 'duplicate' && noChange2.settled?.result === 'not_fixed', noChange2);
  const patched = state({ seen: seen(1), perCategory: { typescript: 1 }, attempts: [attempt('typescript', { patches: [{ attempt: 1, file: 'a.ts', added: 1, removed: 1, diffHash: 'h1', preview: '' }] })] });
  const samePatch = decide(patched, failure('typescript', 'deterministic'), pol.typescript, ctx({ ended: { changedFiles: 1, patchHashes: ['h1'] } }));
  check('identical patch hash -> duplicate', samePatch.action === 'escalate' && samePatch.reason === 'duplicate' && samePatch.settled?.result === 'duplicate', samePatch);
  const newPatch = decide(patched, failure('typescript', 'deterministic'), pol.typescript, ctx({ ended: { changedFiles: 1, patchHashes: ['h2'] } }));
  check('new patch is not settled by the controller', newPatch.action === 'fix' && !newPatch.settled, newPatch);

  // ---- rule 5: caps ----
  const cat = decide(state({ perCategory: { unit_test: 3 } }), failure('unit_test', 'deterministic'), pol.unit_test, ctx());
  check('per-category cap -> escalate exhausted', cat.action === 'escalate' && cat.reason === 'exhausted', cat);
  const tot = decide(state({ perCategory: { unit_test: 2, lint: 1, compile: 2 } }), failure('typescript', 'deterministic'), pol.typescript, ctx({ totalCap: 5 }));
  check('total cap -> escalate exhausted', tot.action === 'escalate' && tot.reason === 'exhausted', tot);
  const repairCap = decide(state({ perCategory: { compile: 1 } }), failure('compile', 'deterministic'), DEFAULT_POLICIES.compile, ctx({ maxRepairAttempts: 1 }));
  check('maxRepairAttempts caps a raw default policy too', repairCap.action === 'escalate' && repairCap.reason === 'exhausted', repairCap);
  const sec = decide(state({ perCategory: { security: 2 } }), failure('security', 'policy'), pol.security, ctx());
  check('security remediation exhausted -> escalate security', sec.action === 'escalate' && sec.reason === 'security', sec);
  const secFix = decide(state(), failure('security', 'policy'), pol.security, ctx());
  check('security remediation -> fix', secFix.action === 'fix' && secFix.max === 2, secFix);

  // ---- rule 6: transient ----
  const ret = [0, 1, 2].map((n) => decide(state({ perCategory: { model_unavailable: n } }), failure('model_unavailable', 'transient'), pol.model_unavailable, ctx()));
  check('transient retries with exponential backoff', ret.map((d) => (d.action === 'retry' ? d.delayMs : -1)).join() === '1000,2000,4000', ret);
  const bounded = decide(state({ perCategory: { model_unavailable: 2 } }), failure('model_unavailable', 'transient'), pol.model_unavailable, ctx({ now: 1000, deadlineAt: 2500 }));
  check('backoff bounded by the deadline', bounded.action === 'retry' && bounded.delayMs === 1500, bounded);
  const unbounded = decide(state({ perCategory: { model_unavailable: 2 } }), failure('model_unavailable', 'transient'), pol.model_unavailable, ctx({ now: 1000, deadlineAt: 2500, recoveryActive: false }));
  check('deadline does not bound waits without active recovery', unbounded.action === 'retry' && unbounded.delayMs === 4000, unbounded);
  const rl = decide(state(), failure('model_unavailable', 'transient'), pol.model_unavailable, ctx({ modelFailure: 'ratelimit', error: new HttpError(429, '', 'u', new Headers({ 'retry-after': '7' })) }));
  check('rate limit waits as the server asks', rl.action === 'retry' && rl.delayMs === 7000, rl);
  const rlDefault = decide(state(), failure('model_unavailable', 'transient'), pol.model_unavailable, ctx({ modelFailure: 'ratelimit', error: new HttpError(429, '', 'u') }));
  check('rate limit without Retry-After waits 5s', rlDefault.action === 'retry' && rlDefault.delayMs === 5000, rlDefault);
  const require = { protocol: 'native', vision: false, locality: 'local' } as const;
  const stallLast = decide(state({ perCategory: { model_timeout: 2 } }), failure('model_timeout', 'transient'), pol.model_timeout, ctx({ reroute: require }));
  check('stall: last attempt reroutes', stallLast.action === 'retry' && stallLast.adjust?.kind === 'reroute' && stallLast.adjust.require === require, stallLast);
  const stallFirst = decide(state(), failure('model_timeout', 'transient'), pol.model_timeout, ctx({ reroute: require }));
  check('stall: earlier attempts plain retry', stallFirst.action === 'retry' && !stallFirst.adjust, stallFirst);
  const mcp = decide(state(), failure('mcp', 'transient', { notExecuted: true }), pol.mcp, ctx());
  check('MCP not executed -> resolve mcp', mcp.action === 'resolve' && mcp.kind === 'mcp', mcp);
  const mcpTimeout = decide(state(), failure('mcp', 'transient'), pol.mcp, ctx());
  check('MCP maybe executed -> never replayed', mcpTimeout.action !== 'retry' && mcpTimeout.action === 'fix' && mcpTimeout.mode === 'inline', mcpTimeout);
  const mcpTimeoutLater = decide(state({ perCategory: { mcp: 1 } }), failure('mcp', 'transient', { notExecuted: false }), pol.mcp, ctx());
  check('MCP maybe executed on a later attempt -> still no retry', mcpTimeoutLater.action !== 'retry', mcpTimeoutLater);

  // ---- rule 7: environmental ----
  const dep = decide(state(), failure('dependency', 'environmental'), pol.dependency, ctx({ resolveCommand: 'npm ci' }));
  check('dependency -> resolve with command', dep.action === 'resolve' && dep.kind === 'dependency' && dep.command === 'npm ci', dep);
  const overloadPol = effectivePolicies({ policies: { model_overload: { attempts: 4 } } }).model_overload;
  const oom = failure('model_overload', 'environmental');
  const base = ctx({ thinking: true, contextWindow: 16384, contextFloor: 6000, serial: false, reroute: require });
  const o1 = decide(state(), oom, overloadPol, base);
  check('overload 1: thinking off, 2s', o1.action === 'retry' && o1.adjust?.kind === 'thinking_off' && o1.delayMs === 2000, o1);
  const after = (...kinds: ('thinking_off' | 'halve_context' | 'serial')[]) => state({
    perCategory: { model_overload: kinds.length },
    attempts: kinds.map((k) => attempt('model_overload', { adjust: [k === 'halve_context' ? { kind: k, contextWindow: 8192 } : { kind: k }] })),
  });
  const o2 = decide(after('thinking_off'), oom, overloadPol, ctx({ ...base, thinking: false }));
  check('overload 2: context halved, 5s', o2.action === 'retry' && o2.adjust?.kind === 'halve_context' && o2.adjust.contextWindow === 8192 && o2.delayMs === 5000, o2);
  const o2floor = decide(after('thinking_off'), oom, overloadPol, ctx({ ...base, thinking: false, contextWindow: 9000 }));
  check('halving stops at the floor', o2floor.action === 'retry' && o2floor.adjust?.kind === 'halve_context' && o2floor.adjust.contextWindow === 6000, o2floor);
  const atFloor = decide(after('thinking_off'), oom, overloadPol, ctx({ ...base, thinking: false, contextWindow: 6000 }));
  check('at the floor: halving skipped -> serial', atFloor.action === 'retry' && atFloor.adjust?.kind === 'serial', atFloor);
  const o3 = decide(after('thinking_off', 'halve_context'), oom, overloadPol, ctx({ ...base, thinking: false, contextWindow: 8192 }));
  check('overload 3: concurrency 1 + serial', o3.action === 'retry' && o3.adjust?.kind === 'serial', o3);
  const o4 = decide(after('thinking_off', 'halve_context', 'serial'), oom, overloadPol, ctx({ ...base, thinking: false, serial: true }));
  check('overload 4 (last): reroute with requirements only', o4.action === 'retry' && o4.adjust?.kind === 'reroute' && o4.adjust.require.protocol === 'native' && o4.adjust.require.locality === 'local', o4);
  const defLast = decide(after('thinking_off'), oom, pol.model_overload, ctx({ ...base, thinking: false }));
  check('default overload policy: last of 2 attempts reroutes', defLast.action === 'retry' && defLast.adjust?.kind === 'reroute', defLast);
  const noThink = decide(state(), oom, overloadPol, ctx({ ...base, thinking: false }));
  const { thinking: _t, ...noThinkingBase } = base;
  void _t;
  const unknownThink = decide(state(), oom, overloadPol, ctx(noThinkingBase));
  check('thinking unsupported (undefined) -> first step halves', unknownThink.action === 'retry' && unknownThink.adjust?.kind === 'halve_context' && unknownThink.adjust.contextWindow === 8192, unknownThink);
  check('thinking already off -> first step halves', noThink.action === 'retry' && noThink.adjust?.kind === 'halve_context', noThink);
  const oDone = decide(state({ perCategory: { model_overload: 2 } }), oom, pol.model_overload, base);
  check('overload attempts exhausted -> escalate', oDone.action === 'escalate' && oDone.reason === 'exhausted', oDone);
  const ct = decide(state(), failure('check_timeout', 'environmental'), pol.check_timeout, ctx());
  check('check timeout -> one retry', ct.action === 'retry' && ct.delayMs === 0, ct);

  // ---- rule 8: deterministic fix ----
  const inline = decide(state(), failure('typescript', 'deterministic'), pol.typescript, ctx({ delegateAllowed: true, independentGroups: 1 }));
  check('fix inline with one group', inline.action === 'fix' && inline.mode === 'inline' && inline.attempt === 1 && inline.max === 3, inline);
  const deleg = decide(state(), failure('typescript', 'deterministic'), pol.typescript, ctx({ delegateAllowed: true, independentGroups: 2 }));
  check('fix delegate with >= 2 groups when allowed', deleg.action === 'fix' && deleg.mode === 'delegate', deleg);
  const notAllowed = decide(state(), failure('typescript', 'deterministic'), pol.typescript, ctx({ delegateAllowed: false, independentGroups: 3 }));
  check('fix inline when delegation not allowed', notAllowed.action === 'fix' && notAllowed.mode === 'inline', notAllowed);

  // ---- overload classification (legacy compatibility) ----
  const bodies = [
    '{"error":"model requires more system memory (12.5 GiB) than is available (8.0 GiB)"}',
    '{"error":"llama runner process has terminated: exit status 2"}',
    'CUDA error: out of memory',
    'ggml_backend_cuda_buffer_type_alloc_buffer: failed to allocate CUDA0 buffer',
    'torch.OutOfMemoryError: CUDA OOM',
    'insufficient memory to load model',
  ];
  check('OOM 500/503 bodies -> overload', bodies.every((b, i) => classifyModelError(new HttpError(i % 2 ? 503 : 500, b, 'u')) === 'overload'), bodies.map((b) => classifyModelError(new HttpError(500, b, 'u'))));
  check('OOM stream text -> overload', classifyModelError(new Error('llama runner process has terminated: signal: killed')) === 'overload' && classifyModelError(new Error('out of memory')) === 'overload');
  check('plain 5xx stays server', classifyModelError(new HttpError(503, 'overloaded', 'u')) === 'server' && classifyModelError(new Error('Overloaded')) === 'server' && classifyModelError(new HttpError(500, 'internal error', 'u')) === 'server');
  check('OOM text in a 400 is not overload', classifyModelError(new HttpError(400, 'out of memory', 'u')) === 'other');
  check('isTransient(overload) is true (legacy retries)', isTransient('overload'));
  check('errorKind(overload) -> server', errorKind('overload') === 'server' && errorKind('server') === 'server');
  check('describeModelError has an overload wording', /ran out of memory/.test(describeModelError('overload', 'HTTP 500 from x: CUDA error', 'qwen')));
}
