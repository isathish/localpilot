/**
 * Smoke checks for src/agent/healing/engine.ts (design §4-7, §10) with a fake executor and clock.
 *   node scripts/healing/run.js scripts/healing/engine.smoke.ts
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SECURITY_CHECK } from '../../src/agent/healing/checks';
import type { SecurityScan } from '../../src/agent/healing/checkRunner';
import { classify } from '../../src/agent/healing/classifier';
import { HealingService, type HealingEngineConfig, type GateDecision, type HealingEngine, type HealingExecFlags, type HealingRunContext } from '../../src/agent/healing/engine';
import { FailureMemory } from '../../src/agent/healing/failureMemory';
import type { FixPromptMessage } from '../../src/agent/healing/rca';
import { RecoveryStore } from '../../src/agent/healing/recoveryStore';
import { CheckSemaphore, RecoveryBus } from '../../src/agent/healing/scheduler';
import type { CheckSpec, ExecResult, Failure } from '../../src/agent/healing/types';
import { parseHealingConfig } from '../../src/healingSettings';
import type { TelemetryInput } from '../../src/telemetry/telemetry';
import type { AgentEvent, ToolCall } from '../../src/types';

type Check = (name: string, cond: boolean, detail?: unknown) => void;

const SPECS: CheckSpec[] = [
  { id: 'npm:typecheck', kind: 'typecheck', command: 'npm run typecheck', timeoutSeconds: 60, required: true, source: 'checks.json', ecosystem: 'node' },
  { id: 'npm:test', kind: 'test', command: 'npm test', timeoutSeconds: 60, required: true, source: 'checks.json', ecosystem: 'node' },
];

const PKG = JSON.stringify({ name: 'demo', scripts: { typecheck: 'tsc --noEmit', test: 'mocha' } }, null, 2);

interface ExecCall {
  command: string;
  flags: HealingExecFlags;
}

interface Harness {
  root: string;
  storeDir: string;
  store: RecoveryStore;
  svc: HealingService;
  engine: HealingEngine;
  calls: ExecCall[];
  injected: FixPromptMessage[];
  events: AgentEvent[];
  tele: TelemetryInput[];
  clock: { t: number };
  abort: AbortController;
  memory?: FailureMemory;
  edit(rel: string, text: string): Promise<void>;
  read(rel: string): string;
  done(text?: string, request?: string): Promise<GateDecision>;
}

interface HarnessOptions {
  files?: Record<string, string>;
  cfg?: Partial<HealingEngineConfig>;
  storeDir?: string;
  root?: string;
  unattended?: boolean;
  resume?: boolean;
  install?: (command: string) => ExecResult;
  foreignWriter?: (fsPath: string) => string | undefined;
  mcpRestart?: (server: string) => Promise<unknown>;
  memory?: boolean;
  sid?: string;
  clock?: { t: number };
  securityScan?: SecurityScan;
}

const temps: string[] = [];

function tmp(prefix: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temps.push(d);
  return d;
}

/** typecheck/test outputs derived from file contents, like the scripted toolchains of design §12. */
function fakeCheck(root: string, command: string): ExecResult {
  const read = (rel: string) => {
    try {
      return fs.readFileSync(path.join(root, rel), 'utf8');
    } catch {
      return '';
    }
  };
  if (command === 'npm run typecheck') {
    const a = read('src/a.ts');
    const out: string[] = [];
    if (a.includes('BUG')) {
      out.push("src/a.ts(1,7): error TS2322: Type 'string' is not assignable to type 'number'.");
    }
    if (a.includes('WORSE')) {
      out.push("src/a.ts(2,3): error TS2304: Cannot find name 'worse'.", "src/a.ts(3,3): error TS2551: Property 'lenght' does not exist on type 'string'.");
    }
    if (a.includes('MISSING')) {
      out.push("src/a.ts(1,22): error TS2307: Cannot find module 'left-pad' or its corresponding type declarations.");
    }
    if (read('src/old.ts').includes('OLD')) {
      out.push("src/old.ts(4,1): error TS2322: Type 'boolean' is not assignable to type 'string'.");
    }
    if (read('src/c.ts').includes('BUG')) {
      out.push("src/c.ts(2,9): error TS2322: Type 'number' is not assignable to type 'string'.");
    }
    if (a.includes('CORRUPT')) {
      return { exitCode: 1, output: 'Error: database disk image is malformed\n    at open (src/db.ts:3:9)' };
    }
    return { exitCode: out.length ? 2 : 0, output: out.join('\n') };
  }
  if (command === 'npm test') {
    let script = '';
    try {
      script = (JSON.parse(read('package.json')) as { scripts?: { test?: string } }).scripts?.test ?? '';
    } catch {
      script = '';
    }
    if (script === 'exit 0') {
      return { exitCode: 0, output: '' };
    }
    return read('src/sum.ts').includes('BUG') ? { exitCode: 1, output: 'tests failed: sum adds' } : { exitCode: 0, output: '1 passing' };
  }
  return { exitCode: 0, output: '' };
}

function harness(o: HarnessOptions = {}): Harness {
  const root = o.root ?? tmp('lp-engine-ws-');
  for (const [rel, body] of Object.entries({ 'package.json': PKG, 'src/a.ts': 'export const a: number = 1;\n', ...(o.files ?? {}) })) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), body);
  }
  const storeDir = o.storeDir ?? tmp('lp-engine-store-');
  const clock = o.clock ?? { t: 1_000_000 };
  const now = () => clock.t;
  const store = new RecoveryStore(storeDir, { owner: { kind: 'cli' }, now });
  const defaults = parseHealingConfig(<T>(_key: string, def: T) => def);
  const cfg: HealingEngineConfig = { ...defaults, baseline: 'off', securityCheck: 'off', ...(o.cfg ?? {}) };
  const memory = o.memory ? new FailureMemory(path.join(tmp('lp-engine-mem-'), 'memory.json'), { now }) : undefined;
  const calls: ExecCall[] = [];
  const injected: FixPromptMessage[] = [];
  const events: AgentEvent[] = [];
  const tele: TelemetryInput[] = [];
  const abort = new AbortController();
  const svc = new HealingService({
    store,
    memory: () => memory,
    config: () => cfg,
    telemetry: { record: (e) => tele.push(e) },
    log: { warn: () => undefined, info: () => undefined },
    bus: new RecoveryBus(),
    semaphore: new CheckSemaphore(1),
    discover: async (_root, d) => [...SPECS, ...(d.security ? [SECURITY_CHECK] : [])].map((s) => ({ ...s })),
    securityScan: o.securityScan,
    isTrusted: () => true,
    foreignWriter: o.foreignWriter,
    mcpRestart: o.mcpRestart,
    now,
    sleep: async (ms) => {
      clock.t += ms;
    },
    random: () => 0.5,
    treeKey: async () => 'tree-1',
    owner: 'cli',
  });
  const ctx: HealingRunContext = {
    session: { id: o.sid ?? 'cli-s1' },
    depth: 0,
    mode: 'agent',
    root,
    signal: abort.signal,
    emit: (e) => events.push(e),
    unattended: o.unattended,
    exec: async (spec, _signal, flags) => {
      calls.push({ command: spec.command, flags });
      if (flags.kind === 'install') {
        return o.install ? o.install(spec.command) : { exitCode: 0, output: 'added 1 package' };
      }
      return fakeCheck(root, spec.command);
    },
    injectHidden: (m) => injected.push(m),
    turnKey: 1,
    resume: o.resume,
  };
  const engine = svc.begin(ctx)!;
  const h: Harness = {
    root, storeDir, store, svc, engine, calls, injected, events, tele, clock, abort, memory,
    async edit(rel, text) {
      const abs = path.join(root, rel);
      await h.engine.beforeWrite(abs);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, text);
      await h.engine.afterWrite([abs]);
    },
    read: (rel) => fs.readFileSync(path.join(root, rel), 'utf8'),
    done: (text = 'Done.', request = 'Update src/a.ts') => h.engine.beforeComplete({ finalText: text, request, todos: [] }),
  };
  return h;
}

const checksRun = (h: Harness) => h.calls.filter((c) => c.flags.kind === 'check').length;

export async function engineSmoke(check: Check): Promise<void> {
  try {
    // ---- compile fail -> fix -> pass -> regression -> completed ----
    {
      const h = harness({ memory: true });
      await h.edit('src/a.ts', "export const a: number = 'BUG';\n");
      const first = await h.done();
      check('compile failure starts an inline fix attempt', first.action === 'continue' && h.injected.length === 1, first);
      const prompt = h.injected[0];
      check('fix prompt is hidden with meta.healing (no nudge)', prompt?.meta.hidden === true && prompt.meta.healing.category === 'typescript' && !('nudge' in prompt.meta), prompt?.meta);
      check('fix prompt names the attempt and asks for "Root cause:"', /attempt 1\/3 · typescript TS2322/.test(prompt?.content ?? '') && prompt!.content.includes('Root cause:'));
      check('typecheck ran with checkSpecMatch and an allowance', h.calls[0]?.command === 'npm run typecheck' && h.calls[0].flags.checkSpecMatch && !!h.calls[0].flags.allowance);
      check('engine is in recovery while the attempt runs', h.engine.inRecovery());
      await h.edit('src/a.ts', 'export const a: number = 1;\n');
      const before = h.calls.length;
      const end = await h.done('Root cause: a string literal was assigned to a number.\nFixed.');
      check('fixed attempt completes', end.action === 'complete' && end.outcome === 'completed', end);
      check('validation reran typecheck and the full test suite (regression)', h.calls.slice(before).map((c) => c.command).join(',') === 'npm run typecheck,npm test', h.calls.slice(before));
      const snap = h.engine.snapshot();
      check('attempt recorded as fixed with root cause and regression report', snap.attempts.length === 1 && snap.attempts[0].result === 'fixed' && /string literal/.test(snap.attempts[0].rootCause ?? '') && !!snap.attempts[0].regression, snap.attempts);
      check('contract: compile/tests/regression passed', end.action === 'complete' && end.contract?.compilationPassed === 'passed' && end.contract.testsPassed === 'passed' && end.contract.regressionChecksPassed === 'passed', end.action === 'complete' ? end.contract : end);
      check('footer says Verified', end.action === 'complete' && /^Verified:/.test(end.report ?? ''), end.action === 'complete' ? end.report : '');
      const actions = h.tele.filter((e) => e.type === 'recovery').map((e) => (e as { action: string }).action);
      check('telemetry: detected, fix_attempt, validated, recovered', ['detected', 'fix_attempt', 'validated', 'recovered'].every((a) => actions.includes(a)), actions);
      check('telemetry carries only 16-hex signatures', h.tele.every((e) => e.type !== 'recovery' || !e.signature || /^[0-9a-f]{16}$/.test(e.signature)));
      const persisted = await h.store.load('cli-s1');
      check('outcome persisted', persisted?.phase === 'completed' && persisted.outcome === 'completed', persisted?.phase);
      const mem = (await h.memory!.list()).filter((e) => e.success);
      check('memory records the validated fix', mem.length === 1 && mem[0].category === 'typescript', mem);
      const recov = h.events.filter((e) => e.type === 'recovery');
      check('recovery events emitted (one card id)', recov.length > 3 && new Set(recov.map((e) => (e.payload as { id: string }).id)).size === 1);
      await h.engine.dispose();
    }

    // ---- read-only run: no checks ----
    {
      const h = harness();
      const end = await h.done('It parses the config.', 'What does src/a.ts do?');
      check('read-only run completes without running checks', end.action === 'complete' && end.outcome === 'completed' && h.calls.length === 0, end);
      check('read-only run writes no state', !(await h.store.load('cli-s1')));
      await h.engine.dispose();
    }

    // ---- README-only change: n/a, completed ----
    {
      const h = harness({ files: { 'README.md': '# demo\n' } });
      await h.edit('README.md', '# demo\n\nMore docs.\n');
      const end = await h.done('Updated the README.', 'Update README.md');
      check('README-only change: no checks run', h.calls.length === 0, h.calls);
      check('README-only change: n/a contract, completed', end.action === 'complete' && end.outcome === 'completed' && end.contract?.compilationPassed === 'n/a' && end.contract.testsPassed === 'n/a', end);
      await h.engine.dispose();
    }

    // ---- duplicate signature escalation ----
    {
      const h = harness();
      await h.edit('src/a.ts', "export const a: number = 'BUG';\n");
      await h.done();
      await h.edit('src/a.ts', "// try 1\nexport const a: number = 'BUG';\n");
      const second = await h.done('Root cause: wrong type.');
      check('first repeat: another attempt with the "did not change this error" note', second.action === 'continue' && /did not change this error/.test(h.injected[1]?.content ?? ''), h.injected[1]?.content);
      await h.edit('src/a.ts', "// try 2\nexport const a: number = 'BUG';\n");
      const third = await h.done('Root cause: still wrong type.');
      const snap = h.engine.snapshot();
      check('same signature after two fixes escalates duplicate before 3 attempts', third.action === 'complete' && third.outcome === 'incomplete' && snap.intervention?.reason === 'duplicate' && snap.attempts.length === 2, { third, reason: snap.intervention?.reason, n: snap.attempts.length });
      check('escalation report names the root cause and next step', third.action === 'complete' && /Root cause:/.test(third.report ?? '') && /Next:/.test(third.report ?? ''), third.action === 'complete' ? third.report : '');
      const open = await h.store.listInterventions({ sessionId: 'cli-s1' });
      check('intervention persisted to the index', open.length === 1 && open[0].reason === 'duplicate', open);
      await h.engine.dispose();
    }

    // ---- worse fix rollback, then identical diffHash refused ----
    {
      const h = harness();
      const bug = "export const a: number = 'BUG';\n";
      await h.edit('src/a.ts', bug);
      await h.done();
      const worse = "export const a: number = 1;\n  WORSE\n  WORSE\n";
      await h.edit('src/a.ts', worse);
      const r = await h.done('Root cause: guessed.');
      check('worse fix is rolled back to the pre-attempt bytes', h.read('src/a.ts') === bug, h.read('src/a.ts'));
      const snap = h.engine.snapshot();
      check('attempt marked rolled_back, patch kept as record', snap.attempts[0]?.result === 'rolled_back' && snap.attempts[0].patches.some((p) => p.result === 'rolled_back'), snap.attempts[0]);
      check('next prompt says the previous attempt was reverted', r.action === 'continue' && /made it worse.*reverted/s.test(h.injected[1]?.content ?? ''), h.injected[1]?.content);
      const before = checksRun(h);
      await h.edit('src/a.ts', worse);
      const dup = await h.done('Root cause: guessed again.');
      const snap2 = h.engine.snapshot();
      check('identical patch refused before validation (no check rerun)', checksRun(h) === before && snap2.attempts[1]?.result === 'duplicate', { runs: checksRun(h) - before, result: snap2.attempts[1]?.result });
      check('refused patch is reverted', h.read('src/a.ts') === bug);
      check('repeated failure escalates duplicate', dup.action === 'complete' && snap2.intervention?.reason === 'duplicate', dup);
      await h.engine.dispose();
    }

    // ---- no-change attempt counts not_fixed without rerun ----
    {
      const h = harness();
      await h.edit('src/a.ts', "export const a: number = 'BUG';\n");
      await h.done();
      const before = checksRun(h);
      const r = await h.done('Root cause: the literal is a string.');
      const snap = h.engine.snapshot();
      check('no-change attempt: not_fixed, no rerun', checksRun(h) === before && snap.attempts[0]?.result === 'not_fixed', { runs: checksRun(h) - before, a: snap.attempts[0] });
      check('no-change attempt: attempts+1, afterFix+1, next attempt injected', snap.perCategory.typescript === 1 && snap.seen[snap.attempts[0].signature]?.afterFix === 1 && r.action === 'continue' && h.injected.length === 2, snap.perCategory);
      await h.engine.dispose();
    }

    // ---- anti-gaming: scripts.test edited -> completed_unverified ----
    {
      const h = harness({ files: { 'src/sum.ts': 'export const sum = (a: number, b: number) => a - b; // BUG\n' } });
      await h.edit('src/sum.ts', 'export const sum = (a: number, b: number) => a - b; // BUG still\n');
      const first = await h.done();
      check('failing test starts a fix', first.action === 'continue' && h.injected[0]?.meta.healing.category === 'unit_test', h.injected[0]?.meta);
      const pkg = JSON.parse(h.read('package.json')) as { scripts: Record<string, string> };
      pkg.scripts.test = 'exit 0';
      await h.edit('package.json', JSON.stringify(pkg, null, 2));
      const end = await h.done('Root cause: the test was flaky.');
      const snap = h.engine.snapshot();
      check('gamed attempt never counts as fixed', snap.attempts[0]?.result !== 'fixed', snap.attempts[0]?.result);
      check('outcome completed_unverified with package.json listed', end.action === 'complete' && end.outcome === 'completed_unverified' && end.contract!.checksModified.some((c) => c.file.startsWith('package.json')), end);
      check('footer explains the check definition change', end.action === 'complete' && /check definition was changed/.test(end.report ?? ''), end.action === 'complete' ? end.report : '');
      await h.engine.dispose();
    }

    // ---- deadline only after the first failure ----
    {
      const h = harness({ cfg: { taskDeadlineMinutes: 1 } });
      h.clock.t += 10 * 60_000;
      await h.edit('src/a.ts', "export const a: number = 'BUG';\n");
      check('no deadline before any failure', !h.engine.deadlineHit());
      await h.done();
      check('deadline not hit right after the first failure', !h.engine.deadlineHit() && h.engine.inRecovery());
      h.clock.t += 2 * 60_000;
      check('deadline hit while the recovery attempt runs', h.engine.deadlineHit());
      const text = await h.engine.escalate('deadline');
      check('deadline escalation names the budget', /deadline of 1 min/.test(text), text);
      check('deadline escalation is incomplete', h.engine.snapshot().outcome === 'incomplete');
      await h.engine.dispose();
    }

    // ---- dependency declined -> blocked ----
    {
      const h = harness({ install: () => ({ exitCode: null, output: '', skipped: { deniedByUser: true } }) });
      await h.edit('src/a.ts', "import pad from 'left-pad'; // MISSING\n");
      const end = await h.done();
      const install = h.calls.find((c) => c.flags.kind === 'install');
      check('install proposed with requires_approval', install?.command === 'npm install left-pad' && install.flags.requiresApproval === true && !install.flags.checkSpecMatch, install);
      const snap = h.engine.snapshot();
      check('declined install -> blocked (approval_needed)', end.action === 'complete' && end.outcome === 'blocked' && snap.intervention?.reason === 'approval_needed', { end, reason: snap.intervention?.reason });
      check('install journaled then declined', snap.pendingAction?.kind === 'install' && snap.pendingAction.status === 'declined', snap.pendingAction);
      await h.engine.dispose();
    }

    // ---- unattended dependency -> blocked without exec ----
    {
      const h = harness({ unattended: true });
      await h.edit('src/a.ts', "import pad from 'left-pad'; // MISSING\n");
      const end = await h.done();
      check('unattended: no install call at all', !h.calls.some((c) => c.flags.kind === 'install'), h.calls);
      check('unattended: blocked approval_needed', end.action === 'complete' && end.outcome === 'blocked' && h.engine.snapshot().intervention?.reason === 'approval_needed', end);
      await h.engine.dispose();
    }

    // ---- dependencyInstall never -> blocked without prompt ----
    {
      const h = harness({ cfg: { dependencyInstall: 'never' } });
      await h.edit('src/a.ts', "import pad from 'left-pad'; // MISSING\n");
      const end = await h.done();
      check('dependencyInstall never: blocked without an install call', end.action === 'complete' && end.outcome === 'blocked' && !h.calls.some((c) => c.flags.kind === 'install'), end);
      await h.engine.dispose();
    }

    // ---- approved install -> rerun passes ----
    {
      let root = '';
      const h = harness({
        install: () => {
          fs.writeFileSync(path.join(root, 'src/a.ts'), 'export const a: number = 1;\n');
          return { exitCode: 0, output: 'added 1 package' };
        },
      });
      root = h.root;
      await h.edit('src/a.ts', "import pad from 'left-pad'; // MISSING\n");
      const end = await h.done();
      const snap = h.engine.snapshot();
      check('approved install: checks rerun and the task completes', end.action === 'complete' && end.outcome === 'completed' && snap.attempts[0]?.strategy === 'install' && snap.attempts[0].result === 'fixed', { end, a: snap.attempts[0] });
      check('install journaled as done', snap.pendingAction?.status === 'done', snap.pendingAction);
      await h.engine.dispose();
    }

    // ---- data corruption stop ----
    {
      const h = harness();
      await h.edit('src/a.ts', 'export const a = 1; // CORRUPT\n');
      const end = await h.done();
      const snap = h.engine.snapshot();
      check('data corruption: immediate escalation, zero fix prompts', end.action === 'complete' && h.injected.length === 0 && snap.intervention?.reason === 'data_corruption', { end, reason: snap.intervention?.reason, active: snap.active.map((f) => f.category) });
      check('data corruption: blocked, nothing rolled back', end.action === 'complete' && end.outcome === 'blocked' && h.read('src/a.ts').includes('CORRUPT'));
      await h.engine.dispose();
    }

    // ---- preexisting and foreign ignored ----
    {
      const h = harness({
        cfg: { baseline: 'fast' },
        files: { 'src/old.ts': 'export const old = 1; // OLD\n', 'src/c.ts': 'export const c = 1;\n' },
        foreignWriter: (p) => (p.endsWith(path.join('src', 'c.ts')) ? 'cli-other' : undefined),
      });
      await h.engine.ensureBaseline();
      check('baseline ran the fast checks once', h.calls.map((c) => c.command).join(',') === 'npm run typecheck', h.calls);
      fs.writeFileSync(path.join(h.root, 'src/c.ts'), 'export const c: string = 1; // BUG\n');
      await h.edit('src/a.ts', 'export const a: number = 2;\n');
      const end = await h.done();
      check('preexisting + foreign failures: no fix attempt, completed', end.action === 'complete' && end.outcome === 'completed' && h.injected.length === 0, end);
      check('footer notes preexisting and foreign failures', end.action === 'complete' && /preexisting/.test(end.report ?? '') && /another running task/.test(end.report ?? ''), end.action === 'complete' ? end.report : '');
      await h.engine.dispose();
    }

    // ---- shutdown -> interrupted vs stop -> cancelled ----
    {
      const shut = harness({ sid: 'cli-shut' });
      await shut.edit('src/a.ts', "export const a: number = 'BUG';\n");
      await shut.done();
      await shut.engine.dispose('shutdown');
      const s1 = await shut.store.load('cli-shut');
      check('shutdown persists phase interrupted', s1?.phase === 'interrupted' && !s1.outcome, s1?.phase);
      check('shutdown released the owner lock', !fs.existsSync(shut.store.lockPath('cli-shut')));

      const stop = harness({ sid: 'cli-stop' });
      await stop.edit('src/a.ts', "export const a: number = 'BUG';\n");
      await stop.done();
      stop.abort.abort(new Error('cancelled'));
      await stop.engine.dispose('cancelled');
      const s2 = await stop.store.load('cli-stop');
      check('user stop persists outcome cancelled', s2?.phase === 'cancelled' && s2.outcome === 'cancelled', s2?.phase);
      check('stop released the owner lock', !fs.existsSync(stop.store.lockPath('cli-stop')));
    }

    // ---- restart: scanUnfinished -> sync resumeInfo -> resumeEntry ----
    {
      const first = harness({ sid: 'cli-resume' });
      await first.edit('src/a.ts', "export const a: number = 'BUG';\n");
      await first.done();
      await first.edit('src/a.ts', 'export const a: number = 1;\n');
      await first.engine.dispose('shutdown');
      const stored = await first.store.load('cli-resume');
      stored!.pendingAction = { kind: 'install', command: 'npm install left-pad', status: 'started', at: first.clock.t };
      await first.store.save(stored!);
      await first.store.flush();
      await first.store.release('cli-resume');

      const second = harness({ sid: 'cli-resume', root: first.root, storeDir: first.storeDir, resume: true, clock: first.clock });
      check('resumeInfo is empty before the scan', second.svc.resumeInfo('cli-resume') === undefined);
      await second.svc.scanUnfinished();
      const info = second.svc.resumeInfo('cli-resume');
      check('resumeInfo is synchronous after scanUnfinished', !!info && !(info instanceof Promise) && info.phase === 'interrupted' && info.category === 'typescript', info);
      check('interrupted() lists the session', second.svc.interrupted().some((i) => i.sid === 'cli-resume'));
      const r = await second.engine.resumeEntry({ request: 'Update src/a.ts' });
      check('resumeEntry re-runs the checks first and completes', r.action === 'complete' && r.outcome === 'completed' && second.calls[0]?.command === 'npm run typecheck', { r, calls: second.calls });
      check('started install is never replayed on resume', !second.calls.some((c) => c.command.includes('install')), second.calls);
      const snap = second.engine.snapshot();
      check('counters continue from the stored state', snap.attempts.length === 1 && snap.attempts[0].result === 'fixed' && snap.perCategory.typescript === 1, { attempts: snap.attempts, per: snap.perCategory });
      check('resumed telemetry recorded', second.tele.some((e) => e.type === 'recovery' && e.action === 'resumed'));
      check('resume index cleared once the task completed', second.svc.resumeInfo('cli-resume') === undefined);
      await second.engine.dispose();
    }

    // ---- MCP: not connected -> retryCalls; timeout -> none ----
    {
      const restarted: string[] = [];
      const h = harness({ mcpRestart: async (s) => restarted.push(s) });
      const call: ToolCall = { id: 'c1', name: 'mcp_github__create_issue', arguments: '{"title":"x"}' };
      const r1 = await h.engine.observe([call], [{ toolCallId: 'c1', content: 'MCP error: Not connected' }], new Set(['c1']));
      check('MCP not connected: server restarted and the call returned for replay', restarted.join() === 'github' && r1.retryCalls?.[0] === call, { restarted, r1 });
      const call2: ToolCall = { id: 'c2', name: 'mcp_github__create_issue', arguments: '{"title":"y"}' };
      const r2 = await h.engine.observe([call2], [{ toolCallId: 'c2', content: 'MCP error -32001: Request timed out' }], new Set(['c2']));
      check('MCP timeout: never replayed', !r2.retryCalls?.length && restarted.length === 1, r2);
      await h.engine.dispose();
    }

    // ---- check allowance invalidated when the script body changes ----
    {
      const h = harness();
      await h.edit('src/a.ts', 'export const a: number = 3;\n');
      await h.done();
      const a1 = h.engine.allowanceFor(['npm test', 'npm run typecheck']);
      check('allowance not granted initially', !a1.granted);
      a1.grant();
      check('allowance granted for the same commands', h.engine.allowanceFor(['npm run typecheck', 'npm test']).granted);
      const pkg = JSON.parse(h.read('package.json')) as { scripts: Record<string, string> };
      pkg.scripts.test = 'mocha --bail';
      fs.writeFileSync(path.join(h.root, 'package.json'), JSON.stringify(pkg));
      const a2 = h.engine.allowanceFor(['npm test', 'npm run typecheck']);
      check('allowance invalidated after the test script changed', !a2.granted && a2.commandsHash !== a1.commandsHash);
      h.clock.t += 31 * 60_000;
      a2.grant();
      check('allowance granted again after a new yes', h.engine.allowanceFor(['npm test', 'npm run typecheck']).granted);
      h.clock.t += 31 * 60_000;
      check('allowance expires after 30 minutes', !h.engine.allowanceFor(['npm test', 'npm run typecheck']).granted);
      await h.engine.dispose();
    }

    // ---- worker (fixer): scoped checks, one attempt, worker_result to the root ----
    {
      const h = harness();
      const injected: FixPromptMessage[] = [];
      const calls: string[] = [];
      const worker = h.svc.begin({
        session: { id: 'cli-s1::fixer::w1' }, depth: 1, mode: 'agent', role: 'fixer', root: h.root, signal: h.abort.signal, emit: () => undefined,
        exec: async (spec) => {
          calls.push(spec.command);
          return fakeCheck(h.root, spec.command);
        },
        injectHidden: (m) => injected.push(m),
      })!;
      const abs = path.join(h.root, 'src/a.ts');
      await worker.beforeWrite(abs);
      fs.writeFileSync(abs, "export const a: number = 'BUG';\n");
      await worker.afterWrite([abs]);
      check('worker writes are routed to the root engine', h.engine.changedFiles().includes('src/a.ts'));
      const w1 = await worker.beforeComplete({ finalText: 'Done', request: 'fix' });
      check('worker: one fix attempt on a scoped failure', w1.action === 'continue' && injected.length === 1, w1);
      check('worker: no full test suite (scoped checks only)', !calls.includes('npm test'), calls);
      const w2 = await worker.beforeComplete({ finalText: 'Root cause: unclear.', request: 'fix' });
      check('worker: never escalates, ends incomplete after its single attempt', w2.action === 'complete' && w2.outcome === 'incomplete' && !(await h.store.listInterventions()).length, w2);
      check('worker_result reached the root engine', h.engine.workers().get('cli-s1::fixer::w1')?.healthy === false);
      check('worker summary carries its verdict', worker.summary()?.healthy === false && (worker.summary()?.failures?.length ?? 0) > 0);
      await worker.dispose();
      await h.engine.dispose();
    }

    // ---- model failures: streamed never retried, backoff, overload adjustments ----
    {
      const h = harness();
      const streamed = await h.engine.onModelFailure('network', new Error('socket hang up'), 1, { streamed: true });
      check('streamed model failure is never retried', streamed.decision.action === 'escalate', streamed.decision);
      const t0 = h.clock.t;
      const net = await h.engine.onModelFailure('network', new Error('fetch failed: connect ECONNREFUSED'), 1, { streamed: false });
      check('network failure: retry after exp backoff through the injected sleep', net.decision.action === 'retry' && h.clock.t - t0 === 1000, { d: net.decision, waited: h.clock.t - t0 });
      const net3 = await h.engine.onModelFailure('network', new Error('fetch failed'), 4, { streamed: false });
      check('network failure: escalates after 3 retries', net3.decision.action === 'escalate', net3.decision);
      const oom = new Error('500 model requires more system memory');
      const o1 = await h.engine.onModelFailure('overload', oom, 1, { streamed: false, thinking: true, contextWindow: 32768, contextFloor: 12000 });
      check('overload 1: thinking off', o1.adjust?.kind === 'thinking_off', o1.adjust);
      const o2 = await h.engine.onModelFailure('overload', oom, 1, { streamed: false, thinking: false, contextWindow: 20000, contextFloor: 12000 });
      check('overload 2: context halved down to the floor', o2.adjust?.kind === 'halve_context' && o2.adjust.contextWindow === 12000, o2.adjust);
      check('model retries are recorded as telemetry retry', h.tele.filter((e) => e.type === 'recovery' && e.action === 'retry').length === 3);
      await h.engine.dispose();
    }

    // ---- routeRetry (before an engine exists) and escalateRun ----
    {
      const h = harness();
      let routes = 0;
      const probes: number[] = [];
      const t0 = h.clock.t;
      const policy = { category: 'model_unavailable' as const, cls: 'transient' as const, strategy: 'retry' as const, attempts: 3, backoffMs: [1000], exponential: true };
      const got = await h.svc.routeRetry(policy, async () => {
        if (++routes < 3) {
          throw new Error('fetch failed: connect ECONNREFUSED 127.0.0.1:11434');
        }
        return 'route';
      }, async () => {
        probes.push(h.clock.t - t0);
        return true;
      });
      check('routeRetry: probe before each retry, exp backoff, then success', got === 'route' && routes === 3 && probes.join() === '1000,3000', { routes, probes });
      let failed = false;
      try {
        await h.svc.routeRetry(policy, async () => {
          throw new Error('401 invalid api key');
        });
      } catch {
        failed = true;
      }
      check('routeRetry: non-transient errors are not retried', failed);
      await h.engine.dispose();
      const text = await h.svc.escalateRun('cli-gone', 'model_unavailable', new Error('connect ECONNREFUSED'));
      const st = await h.store.load('cli-gone');
      check('escalateRun persists outcome failed + intervention before the rethrow', st?.outcome === 'failed' && st.intervention?.reason === 'model_unavailable' && /Failed:/.test(text), { st: st?.outcome, text });
    }

    // ---- acceptRisk, rollback and dismiss on persisted states ----
    {
      const h = harness({ sid: 'cli-risk' });
      await h.edit('src/a.ts', "export const a: number = 'BUG';\n");
      await h.done();
      await h.edit('src/a.ts', "export const a: number = 'BUG'; // tried\n");
      await h.engine.dispose('shutdown');
      const audits: Record<string, unknown>[] = [];
      const st = (await h.store.load('cli-risk'))!;
      st.active.push({ ...st.active[0], id: 'sec', category: 'security', cls: 'policy', severity: 'high', signature: 'abcdef0123456789', message: 'AWS key' });
      await h.store.save(st);
      await h.store.flush();
      await h.store.release('cli-risk');
      const svc2 = new HealingService({
        store: h.store, memory: () => undefined, config: () => ({ ...parseHealingConfig(<T>(_k: string, d: T) => d) }), telemetry: { record: (e) => h.tele.push(e) },
        log: { warn: () => undefined }, bus: new RecoveryBus(), semaphore: new CheckSemaphore(1), discover: async () => SPECS, isTrusted: () => true,
        audit: (e) => audits.push(e), now: () => h.clock.t,
      });
      const risk = await svc2.acceptRisk('cli-risk', 'user');
      const after = await h.store.load('cli-risk');
      check('acceptRisk records the user, time and signatures', risk?.by === 'user' && risk.signatures.join() === 'abcdef0123456789' && after?.acceptedRisks.length === 1, after?.acceptedRisks);
      check('acceptRisk is audited and recorded in telemetry', audits[0]?.event === 'recovery_accept_risk' && h.tele.some((e) => e.type === 'recovery' && e.action === 'accept_risk' && e.signature === 'abcdef0123456789'));
      const rb = await svc2.rollback('cli-risk', undefined, h.root);
      check('rollback restores the pre-attempt content from the persisted snapshots', rb.restored.includes('src/a.ts') && h.read('src/a.ts') === "export const a: number = 'BUG';\n", { rb, now: h.read('src/a.ts') });
      check('dismiss closes the interrupted state', (await svc2.dismiss('cli-risk')) && (await h.store.load('cli-risk'))?.phase === 'cancelled' && svc2.resumeInfo('cli-risk') === undefined);
    }

    // ---- autoFix off: detect and report only ----
    {
      const ts = classify({ kind: 'check', spec: { id: 'npm:typecheck', kind: 'typecheck', ecosystem: 'node' }, outcome: { exitCode: 2, output: "src/a.ts(1,7): error TS2322: Type 'string' is not assignable to type 'number'." } })[0];
      const sec: Failure = { ...ts, id: 'sec1', category: 'security', cls: 'policy', severity: 'high', code: 'secret', message: 'hardcoded AWS key', signature: '0123456789abcdef', generic: 'fedcba9876543210', source: { kind: 'check', checkId: 'security' } };
      const h = harness({ cfg: { autoFix: false, securityCheck: 'changed' }, securityScan: async () => [ts, sec] });
      await h.edit('src/a.ts', 'export const a: number = 2;\n');
      const end = await h.done();
      check('autoFix off: typecheck + security failures inject no fix prompt', h.injected.length === 0 && end.action === 'complete', end);
      check('autoFix off: the security finding escalates as security', h.engine.snapshot().intervention?.reason === 'security' && h.engine.snapshot().attempts.length === 0, h.engine.snapshot().intervention?.reason);
      await h.engine.dispose();

      const t = harness({ cfg: { autoFix: false } });
      await t.edit('src/a.ts', "export const a: number = 'BUG';\n");
      const r = await t.done();
      check('autoFix off: compile failure is reported without a fix attempt', t.injected.length === 0 && r.action === 'complete' && r.outcome !== 'completed' && !t.engine.snapshot().intervention, r);
      await t.engine.dispose();
    }

    // ---- restart after the recovery deadline elapsed while closed ----
    {
      const first = harness({ sid: 'cli-late', cfg: { taskDeadlineMinutes: 1 } });
      await first.edit('src/a.ts', "export const a: number = 'BUG';\n");
      await first.done();
      await first.edit('src/a.ts', "export const a: number = 'BUG'; // try\n");
      await first.engine.dispose('shutdown');
      first.clock.t += 12 * 60 * 60_000;
      const second = harness({ sid: 'cli-late', root: first.root, storeDir: first.storeDir, resume: true, clock: first.clock, cfg: { taskDeadlineMinutes: 1 }, files: { 'src/a.ts': "export const a: number = 'BUG'; // try\n" } });
      const r = await second.engine.resumeEntry({ request: 'Update src/a.ts' });
      const snap = second.engine.snapshot();
      check('resume after downtime: checks rerun, no immediate deadline escalation', second.calls[0]?.command === 'npm run typecheck' && snap.intervention?.reason !== 'deadline' && r.action === 'continue', { r, reason: snap.intervention?.reason });
      check('resume after downtime: the deadline moved by the downtime', !second.engine.deadlineHit() && (snap.deadlineAt ?? 0) > first.clock.t, snap.deadlineAt);
      await second.engine.dispose();
    }

    // ---- a follow-up task keeps the previous rollback data until it replaces the state ----
    {
      const first = harness({ sid: 'cli-follow' });
      await first.edit('src/a.ts', "export const a: number = 'BUG';\n");
      await first.done();
      await first.edit('src/a.ts', "// try 1\nexport const a: number = 'BUG';\n");
      await first.done('Root cause: wrong type.');
      await first.edit('src/a.ts', "// try 2\nexport const a: number = 'BUG';\n");
      const end = await first.done('Root cause: still wrong type.');
      await first.engine.dispose();
      const attempts = path.dirname(first.store.attemptDir('cli-follow', 1));
      check('incomplete task keeps its attempt snapshots', end.action === 'complete' && end.outcome === 'incomplete' && fs.existsSync(attempts), end);
      const files = { 'src/a.ts': "// try 2\nexport const a: number = 'BUG';\n" };
      const second = harness({ sid: 'cli-follow', root: first.root, storeDir: first.storeDir, clock: first.clock, files });
      await second.done('It assigns a constant.', 'What does src/a.ts do?');
      const kept = await second.store.load('cli-follow');
      check('a read-only follow-up leaves the intervention and its snapshots alone', fs.existsSync(attempts) && kept?.outcome === 'incomplete' && (await second.store.listInterventions({ sessionId: 'cli-follow' })).length === 1, kept?.outcome);
      await second.engine.dispose();
      const third = harness({ sid: 'cli-follow', root: first.root, storeDir: first.storeDir, clock: first.clock, files });
      await third.edit('src/b.ts', 'export const b = 1;\n');
      await third.done('Added b.', 'Add src/b.ts');
      check('a follow-up that replaces the state resolves the old intervention first', (await third.store.listInterventions({ sessionId: 'cli-follow' })).length === 0 && !(await third.store.load('cli-follow'))?.intervention);
      await third.engine.dispose();
    }

    // ---- another process owns the session: no fix, install or rollback here ----
    {
      const storeDir = tmp('lp-engine-store-');
      const clock = { t: 1_000_000 };
      const other = new RecoveryStore(storeDir, { owner: { kind: 'vscode' }, now: () => clock.t, pid: process.ppid });
      check('the other process owns the lock', (await other.acquire('cli-ro')) === 'owned');
      const h = harness({ sid: 'cli-ro', storeDir, clock });
      await h.edit('src/a.ts', "export const a: number = 'BUG';\n");
      const end = await h.done();
      check('read-only session: no fix prompt, unverified, no intervention', h.injected.length === 0 && end.action === 'complete' && end.outcome === 'completed_unverified' && /another window/.test(end.report ?? '') && !h.engine.snapshot().intervention, end);
      check('read-only session: nothing persisted here', !(await h.store.load('cli-ro')));
      await h.engine.dispose();
      const st = { ...h.engine.snapshot(), phase: 'incomplete' as const, outcome: 'incomplete' as const };
      await other.save(st);
      await other.flush();
      const svc2 = new HealingService({
        store: h.store, memory: () => undefined, config: () => ({ ...parseHealingConfig(<T>(_k: string, d: T) => d) }), log: { warn: () => undefined },
        bus: new RecoveryBus(), semaphore: new CheckSemaphore(1), discover: async () => SPECS, isTrusted: () => true, now: () => clock.t,
      });
      const rb = await svc2.rollback('cli-ro', undefined, h.root);
      check('rollback is refused while another window owns the session', !rb.restored.length && h.read('src/a.ts').includes('BUG'), rb);
      check('dismiss is refused while another window owns the session', !(await svc2.dismiss('cli-ro')) && !h.store.isReadonly('cli-ro'));
      check('the other process keeps its lock', fs.existsSync(h.store.lockPath('cli-ro')));
      await other.dispose();
    }

    // ---- dismiss on a live engine keeps its lock ----
    {
      const h = harness({ sid: 'cli-live' });
      await h.edit('src/a.ts', "export const a: number = 'BUG';\n");
      await h.done();
      check('live engine owns the lock', h.store.isOwned('cli-live') && fs.existsSync(h.store.lockPath('cli-live')));
      check('dismiss without an open intervention is refused on a live engine', !(await h.svc.dismiss('cli-live')));
      check('dismiss does not release the live engine lock', h.store.isOwned('cli-live') && fs.existsSync(h.store.lockPath('cli-live')));
      await h.engine.dispose();
    }

    // ---- begin() gating ----
    {
      const h = harness();
      const base = { session: { id: 'cli-x::fixer::sub1' }, signal: h.abort.signal, emit: () => undefined, exec: async () => ({ exitCode: 0, output: '' }), injectHidden: () => undefined, root: h.root };
      check('depth>0 without role fixer gets no engine', h.svc.begin({ ...base, depth: 1, mode: 'agent' }) === undefined);
      const worker = h.svc.begin({ ...base, depth: 1, mode: 'agent', role: 'fixer' });
      check('fixer worker gets a worker engine', worker?.kind === 'worker');
      check('scratch runs get no engine', h.svc.begin({ ...base, session: { id: 'cli-y' }, depth: 0, mode: 'agent', scratch: true }) === undefined);
      const ask = h.svc.begin({ ...base, session: { id: 'cli-z' }, depth: 0, mode: 'ask' });
      check('ask mode is detection-only', ask?.kind === 'detect');
      check('the root engine is registered for child writes', h.svc.forRoot('cli-s1') === h.engine && h.svc.forRoot('cli-s1::fixer::sub1') === h.engine);
      await worker?.dispose();
      await ask?.dispose();
      await h.engine.dispose();
      check('disposed engine leaves the registry', h.svc.forRoot('cli-s1') === undefined);
    }
  } finally {
    for (const d of temps) {
      fs.rmSync(d, { recursive: true, force: true });
    }
  }
}
