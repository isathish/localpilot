import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { AgentRunner } from '../agent/agentLoop';
import type { HealingEngine, HealingRunContext, HealingService, ModelFailureContext, ModelFailureResult } from '../agent/healing';
import type { ApprovalRecord, CompletionContract, EscalationReason, ExecResult, Failure, ObserveResult } from '../agent/healing/types';
import { SkillManager } from '../agent/skills';
import { WorkspaceContext } from '../context/workspaceContext';
import { HttpError } from '../providers/http';
import { ProviderRegistry } from '../providers/registry';
import { ToolRegistry } from '../tools/registry';
import { AgentEvent, ApprovalDecision, ApprovalOptions, ChatMessage, ChatRequestOptions, LLMProvider, ModelInfo, Session, StreamEvent, Tool, ToolCall } from '../types';

/**
 * The agent loop's self-healing touch points (design §10) against a scripted engine: the completion gate (fix prompt,
 * granted steps, outcome footer), synthetic check commands (own identical-call counts, origin tags, raw outcome,
 * structured decisions, the check allowance), model-failure retries through the engine, and the final-failure
 * escalation; loop safety (the maxIterations + extraSteps cap, the recovery deadline, observe stops and retries, resume
 * verdicts), mandatory dangerous-command prompts during a recovery (also in children of a recovering root), the
 * preexisting-failure baseline before file-changing steps, afterWrite paths and the dispose reason. Without a healing
 * service the turn_end payload carries no outcome.
 */

const log = vscode.window.createOutputChannel('LocalPilot healing loop test', { log: true });
const model: ModelInfo = { id: 'fake/m', providerId: 'fake', modelId: 'm', name: 'm', contextWindow: 16384, maxOutputTokens: 1024, supportsTools: true, supportsVision: false };

type Script = (opts: ChatRequestOptions, call: number) => AsyncIterable<StreamEvent>;

function provider(script: Script): LLMProvider {
  let n = 0;
  return {
    id: 'fake',
    type: 'openai',
    displayName: 'Fake',
    baseUrl: 'http://127.0.0.1:9',
    listModels: async () => [model],
    complete: async () => '',
    healthCheck: async () => true,
    chat: (opts) => script(opts, ++n),
  };
}

async function* say(text: string): AsyncIterable<StreamEvent> {
  yield { type: 'text', text };
  yield { type: 'done', finishReason: 'stop' };
}

/** Commands the fake run_command was asked to run, in order. */
const commandLog: string[] = [];

/** A run_command stand-in: asks for approval like the real tool and reports a raw outcome longer than its result text. */
const fakeCommand: Tool = {
  approvalKind: 'terminal',
  definition: { name: 'run_command', description: 'run', parameters: { type: 'object', properties: { command: { type: 'string' }, requires_approval: { type: 'boolean' }, dangerous: { type: 'boolean' } }, required: ['command'] } },
  async execute(args, ctx) {
    const command = String(args.command ?? '');
    commandLog.push(command);
    if (!(await ctx.requestApproval('Run command', `$ ${command}\nin .`, 'terminal', { confirm: args.requires_approval === true, dangerous: args.dangerous === true }))) {
      return { content: 'User declined to run the command.', isError: true };
    }
    ctx.healingExec?.rawOutcome({ output: `RAW ${command} full output`, exitCode: 2 });
    return { content: 'clamped', isError: true };
  },
};

let notes = 0;
const noteThing: Tool = {
  definition: { name: 'note_thing', description: 'note', parameters: { type: 'object', properties: { text: { type: 'string' } } } },
  async execute() {
    return { content: `noted ${++notes}` };
  },
};

/** A write_file stand-in: paths starting with `bad` fail. */
const fakeWrite: Tool = {
  approvalKind: 'write',
  definition: { name: 'write_file', description: 'write', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path'] } },
  async execute(args) {
    return String(args.path).startsWith('bad') ? { content: 'cannot write', isError: true } : { content: 'written' };
  },
};

/** Overridable engine behaviour (defaults: idle, no deadline, nothing observed, resume proceeds). */
interface EngineHooks {
  inRecovery?: () => boolean;
  deadlineHit?: (engine: FakeEngine) => boolean;
  observe?: (engine: FakeEngine, calls: ToolCall[]) => ObserveResult;
  resumeEntry?: () => Awaited<ReturnType<HealingEngine['resumeEntry']>>;
}

/** Records every call the loop makes into the engine; `gate` scripts beforeComplete. */
class FakeEngine {
  readonly kind = 'full' as const;
  readonly approvals: ApprovalRecord[] = [];
  readonly failures: { kind: string; attempt: number; ctx: ModelFailureContext }[] = [];
  readonly escalations: EscalationReason[] = [];
  readonly written: string[][] = [];
  disposedWith: string | undefined = 'never';
  gates = 0;
  observed = 0;
  baselines = 0;
  /** Commands the fake run_command had seen when each baseline ran. */
  readonly baselineAfter: number[] = [];
  constructor(
    readonly root: string,
    readonly ctx: HealingRunContext,
    private readonly gate: (engine: FakeEngine, n: number) => Promise<Awaited<ReturnType<HealingEngine['beforeComplete']>>>,
    private readonly modelFailure: (kind: string, attempt: number) => ModelFailureResult,
    private readonly hooks: EngineHooks = {},
  ) {}
  async beforeWrite(): Promise<void> {}
  async afterWrite(paths: string[]): Promise<void> {
    this.written.push([...paths]);
  }
  async noteCommandChanges(): Promise<void> {}
  inRecovery(): boolean {
    return this.hooks.inRecovery?.() ?? false;
  }
  deadlineHit(): boolean {
    return this.hooks.deadlineHit?.(this) ?? false;
  }
  recordApproval(r: ApprovalRecord): void {
    this.approvals.push(r);
  }
  async ensureBaseline(): Promise<void> {
    this.baselines++;
    this.baselineAfter.push(commandLog.length);
  }
  async onModelFailure(kind: string, _e: unknown, attempt: number, ctx: ModelFailureContext): Promise<ModelFailureResult> {
    this.failures.push({ kind, attempt, ctx });
    return this.modelFailure(kind, attempt);
  }
  async observe(calls: ToolCall[]): Promise<ObserveResult> {
    this.observed++;
    return this.hooks.observe?.(this, calls) ?? {};
  }
  beforeComplete() {
    return this.gate(this, ++this.gates);
  }
  async escalate(reason: EscalationReason): Promise<string> {
    this.escalations.push(reason);
    return `Escalated: ${reason}`;
  }
  async resumeEntry(): Promise<Awaited<ReturnType<HealingEngine['resumeEntry']>>> {
    return this.hooks.resumeEntry?.() ?? { action: 'proceed' };
  }
  summary() {
    return { id: 'rec_test', phase: 'completed' as const, attempts: 1, categories: [], rootCauses: [], patches: [], updatedAt: 0, report: 'Not verified: x' };
  }
  result() {
    return undefined;
  }
  async dispose(reason?: string): Promise<void> {
    this.disposedWith = reason;
  }
}

function fakeService(make: (ctx: HealingRunContext) => FakeEngine | undefined, root?: FakeEngine) {
  const svc = {
    engine: undefined as FakeEngine | undefined,
    routed: 0,
    begin(ctx: HealingRunContext) {
      svc.engine = make(ctx);
      return svc.engine;
    },
    forRoot: () => root ?? svc.engine,
    async routeRetry<T>(_policy: unknown, fn: () => Promise<T>): Promise<T> {
      svc.routed++;
      return fn();
    },
    async escalateRun(): Promise<string> {
      return 'escalated';
    },
  };
  return svc;
}

const noFailure: (kind: string, attempt: number) => ModelFailureResult = () => ({ decision: { action: 'escalate', reason: 'model_unavailable' } });
const contract = { requirementsSatisfied: 'passed', checksModified: [], unresolved: [], outstandingRecovery: false } as unknown as CompletionContract;

async function runTurn(opts: {
  script: Script;
  healing?: ReturnType<typeof fakeService>;
  approve?: (title: string, opts?: ApprovalOptions) => Promise<boolean | ApprovalDecision>;
  request?: string;
  tools?: string[];
  depth?: number;
  resume?: boolean;
  controller?: AbortController;
}): Promise<{ events: AgentEvent[]; session: Session; error?: unknown }> {
  const registry = new ToolRegistry();
  registry.registerAll([fakeCommand, noteThing, fakeWrite]);
  const providers = new ProviderRegistry(log);
  const p = provider(opts.script);
  Object.assign(providers, { route: async () => ({ provider: p, model }), residentModels: async () => new Set<string>(), markUnresponsive: () => undefined });
  const runner = new AgentRunner(providers, registry, new SkillManager(log), new WorkspaceContext(log), log);
  if (opts.healing) {
    runner.healing = opts.healing as unknown as HealingService;
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lp-heal-loop-'));
  const now = Date.now();
  const id = `h-${now.toString(36)}`;
  const session: Session = { id: opts.depth ? `${id}::child` : id, title: 'test', createdAt: now, updatedAt: now, model: model.id, mode: 'agent', messageCount: 0, messages: [], contextTokens: 0, compactions: 0, attachments: [], todos: [], workingSet: [] };
  const events: AgentEvent[] = [];
  let error: unknown;
  try {
    await runner.run({
      session,
      userMessage: { role: 'user', content: opts.request ?? 'Please look over the project.' },
      emit: (e) => events.push(e),
      signal: (opts.controller ?? new AbortController()).signal,
      requestApproval: (title, _detail, _kind, o) => (opts.approve ? opts.approve(title, o) : Promise.resolve(true)),
      workspaceRoot: root,
      toolFilter: opts.tools ?? ['note_thing'],
      maxIterations: 6,
      ...(opts.depth ? { depth: opts.depth } : {}),
      ...(opts.resume ? { resume: true } : {}),
    });
  } catch (e) {
    error = e;
  } finally {
    providers.dispose();
    registry.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  }
  return { events, session, error };
}

async function* callTool(name: string, args: Record<string, unknown>, id = `c_${Math.random().toString(36).slice(2)}`): AsyncIterable<StreamEvent> {
  yield { type: 'tool_call', call: { id, name, arguments: JSON.stringify(args) } };
  yield { type: 'done', finishReason: 'tool_calls' };
}

async function* callTools(calls: [string, Record<string, unknown>][]): AsyncIterable<StreamEvent> {
  for (const [i, [name, args]] of calls.entries()) {
    yield { type: 'tool_call', call: { id: `c${i}_${Math.random().toString(36).slice(2)}`, name, arguments: JSON.stringify(args) } };
  }
  yield { type: 'done', finishReason: 'tool_calls' };
}

const done = async () => ({ action: 'complete' as const, outcome: 'completed' as const });

const turnEnd = (events: AgentEvent[]) => events.filter((e) => e.type === 'turn_end').pop()?.payload as Record<string, unknown> | undefined;

suite('Agent loop: self-healing integration', () => {
  const cfg = () => vscode.workspace.getConfiguration('localpilot');
  const keys = ['approvals.terminal', 'approvals.dangerousAlwaysAsk', 'autoMode.enabled', 'autoClarify', 'healing.enabled', 'healing.extraSteps'];
  const saved: Record<string, unknown> = {};
  suiteSetup(async () => {
    keys.forEach((k) => (saved[k] = cfg().inspect(k)?.globalValue));
    await cfg().update('approvals.terminal', 'ask', vscode.ConfigurationTarget.Global);
    await cfg().update('autoMode.enabled', false, vscode.ConfigurationTarget.Global);
    await cfg().update('autoClarify', false, vscode.ConfigurationTarget.Global);
    await cfg().update('healing.enabled', true, vscode.ConfigurationTarget.Global);
    await cfg().update('approvals.dangerousAlwaysAsk', false, vscode.ConfigurationTarget.Global);
    await cfg().update('healing.extraSteps', 2, vscode.ConfigurationTarget.Global);
  });
  setup(() => {
    commandLog.length = 0;
    notes = 0;
  });
  suiteTeardown(async () => {
    for (const k of keys) {
      await cfg().update(k, saved[k], vscode.ConfigurationTarget.Global);
    }
  });

  test('gate: synthetic checks, allowance, decisions, hidden fix prompt and the outcome footer', async function () {
    this.timeout(30_000);
    const execs: ExecResult[] = [];
    let grants = 0;
    const svc = fakeService(
      (ctx) =>
        new FakeEngine(
          ctx.root!,
          ctx,
          async (engine, n) => {
            if (n === 1) {
              const allowance = { commandsHash: 'h', granted: false, grant: () => undefined as void };
              allowance.grant = () => {
                allowance.granted = true;
                grants++;
              };
              const spec = { id: 'npm:typecheck', kind: 'typecheck' as const, command: 'npm run typecheck', timeoutSeconds: 5, required: true, source: 'discovered' as const, ecosystem: 'node' as const };
              for (let i = 0; i < 4; i++) {
                execs.push(await engine.ctx.exec(spec, engine.ctx.signal, { kind: 'check', checkSpecMatch: true, timeoutSeconds: 5, allowance }));
              }
              execs.push(await engine.ctx.exec({ ...spec, id: 'install:npm', command: 'npm install left-pad' }, engine.ctx.signal, { kind: 'install', checkSpecMatch: false, timeoutSeconds: 5, requiresApproval: true }));
              engine.ctx.injectHidden({ content: 'FIXPROMPT fix TS2345', meta: { hidden: true, healing: { attempt: 1, category: 'typescript', signature: 'sig' } } });
              return { action: 'continue', grantSteps: 2 };
            }
            return { action: 'complete', outcome: 'completed_unverified', contract, report: 'Not verified: x' };
          },
          noFailure,
        ),
    );
    const prompts: { title: string; mandatory?: boolean }[] = [];
    const { events, session, error } = await runTurn({
      healing: svc,
      script: (opts) => say(opts.messages.some((m) => m.content.includes('FIXPROMPT')) ? 'Root cause: a wrong type.' : 'All good.'),
      approve: async (title, o) => {
        prompts.push({ title, mandatory: o?.mandatory });
        return prompts.length === 1 ? true : { ok: false };
      },
    });
    assert.ifError(error);
    const engine = svc.engine!;
    assert.strictEqual(svc.routed, 1, 'routing went through routeRetry');
    assert.strictEqual(engine.gates, 2);
    assert.strictEqual(prompts.length, 2, JSON.stringify(prompts));
    assert.match(prompts[0].title, /verification checks/i);
    assert.strictEqual(prompts[1].mandatory, true, 'the install prompt is mandatory');
    assert.strictEqual(grants, 1, 'one yes granted the allowance');
    assert.deepStrictEqual(execs.slice(0, 4).map((r) => [r.exitCode, r.output, !!r.skipped]), Array(4).fill([2, 'RAW npm run typecheck full output', false]), 'raw outcome, never refused as an identical call');
    assert.deepStrictEqual(execs[4].skipped, { deniedByUser: true });
    const healingRows = events.filter((e) => (e.type === 'tool_start' || e.type === 'tool_end') && (e.payload as { origin?: string }).origin === 'healing');
    assert.strictEqual(healingRows.length, 10);
    assert.ok(!session.messages.some((m) => m.role === 'tool'), 'synthetic results stay out of the transcript');
    assert.deepStrictEqual(engine.approvals.map((a) => [a.decision, a.origin]), [['approved', 'healing'], ['auto', 'healing'], ['auto', 'healing'], ['auto', 'healing'], ['denied', 'healing']]);
    const hidden = session.messages.find((m) => m.content.startsWith('FIXPROMPT')) as ChatMessage;
    assert.ok(hidden.meta?.hidden && hidden.meta.healing && !hidden.meta.nudge);
    assert.ok(!events.some((e) => e.type === 'nudge'), 'a fix prompt is not a nudge');
    const last = session.messages[session.messages.length - 1];
    assert.strictEqual(last.meta?.healing?.report, 'Not verified: x');
    assert.ok(last.content.startsWith('Root cause: a wrong type.') && last.content.endsWith('Not verified: x'), last.content);
    const end = turnEnd(events)!;
    assert.strictEqual(end.outcome, 'completed_unverified');
    assert.ok(end.contract && end.recovery);
    assert.strictEqual(engine.disposedWith, undefined, 'disposed without a stop reason');
  });

  test('a transient model failure is retried by the engine’s decision; the final failure escalates before the throw', async function () {
    this.timeout(30_000);
    const unavailable = { category: 'model_unavailable' } as Failure;
    const svc = fakeService((ctx) => new FakeEngine(ctx.root!, ctx, async () => ({ action: 'complete', outcome: 'completed' }), (kind) => (kind === 'network' ? { decision: { action: 'retry', delayMs: 0 }, failure: unavailable } : { decision: { action: 'escalate', reason: 'credentials' } })));
    const { events, error } = await runTurn({
      healing: svc,
      script: (_o, n) => (n === 1 ? (async function* () { throw new Error('connect ECONNREFUSED 127.0.0.1:9'); })() : say('Hello.')),
    });
    assert.ifError(error);
    const engine = svc.engine!;
    assert.deepStrictEqual(engine.failures.map((f) => [f.kind, f.attempt, f.ctx.streamed]), [['network', 1, false]]);
    assert.ok(events.some((e) => e.type === 'retry'), 'the retry note still shows');
    assert.strictEqual(turnEnd(events)?.outcome, 'completed');

    const svc2 = fakeService((ctx) => new FakeEngine(ctx.root!, ctx, async () => ({ action: 'complete', outcome: 'completed' }), () => ({ decision: { action: 'escalate', reason: 'credentials' } })));
    const failed = await runTurn({
      healing: svc2,
      script: () => (async function* () { throw new HttpError(401, 'invalid api key', 'http://127.0.0.1:9/v1/chat/completions'); })(),
    });
    assert.ok(failed.error, 'the run still throws');
    assert.deepStrictEqual(svc2.engine!.escalations, ['credentials']);
    assert.ok(!failed.events.some((e) => e.type === 'turn_end'), 'no turn_end on the final-failure path');
  });

  test('without a healing service the turn_end carries no outcome', async () => {
    const { events, error } = await runTurn({ script: () => say('Hello.') });
    assert.ifError(error);
    const end = turnEnd(events)!;
    assert.ok(!('outcome' in end) && !('recovery' in end) && !('contract' in end), JSON.stringify(end));
  });

  test('a gate that keeps asking for fixes stops at maxIterations + extraSteps and escalates as a loop', async function () {
    this.timeout(30_000);
    let calls = 0;
    const svc = fakeService((ctx) => new FakeEngine(ctx.root!, ctx, async () => ({ action: 'continue', grantSteps: 10 }), noFailure));
    const { events, session, error } = await runTurn({
      healing: svc,
      script: () => {
        calls++;
        return say(`Answer ${calls}.`);
      },
    });
    assert.ifError(error);
    const engine = svc.engine!;
    assert.ok(calls >= 6 && calls <= 8, `model calls ${calls}`);
    assert.ok(engine.gates >= 1, `gates ${engine.gates}`);
    assert.deepStrictEqual(engine.escalations, ['loop']);
    assert.notStrictEqual(turnEnd(events)?.outcome, 'completed');
    assert.match(session.messages[session.messages.length - 1].content, /Escalated: loop/);
  });

  test('the recovery deadline ends the turn with the engine’s report', async function () {
    this.timeout(30_000);
    let calls = 0;
    const svc = fakeService((ctx) => new FakeEngine(ctx.root!, ctx, done, noFailure, { deadlineHit: (e) => e.observed > 0 }));
    const { events, session, error } = await runTurn({
      healing: svc,
      script: () => (++calls === 1 ? callTool('note_thing', { text: 'a' }) : say('Should not be asked.')),
    });
    assert.ifError(error);
    assert.strictEqual(calls, 1, 'no model call after the deadline');
    assert.deepStrictEqual(svc.engine!.escalations, ['deadline']);
    const last = session.messages[session.messages.length - 1];
    assert.strictEqual(last.content, 'Escalated: deadline');
    assert.strictEqual(last.meta?.healing?.report, 'Escalated: deadline');
    assert.strictEqual(turnEnd(events)?.text, 'Escalated: deadline');
  });

  test('observe: a stop ends the turn; retryCalls run again and replace the failed result', async function () {
    this.timeout(30_000);
    let calls = 0;
    const stopper = fakeService((ctx) => new FakeEngine(ctx.root!, ctx, done, noFailure, { observe: () => ({ stop: { reason: 'data_corruption', message: 'STOPPED: corrupt' } }) }));
    const stopped = await runTurn({
      healing: stopper,
      script: () => (++calls === 1 ? callTool('note_thing', { text: 'a' }) : say('Should not be asked.')),
    });
    assert.ifError(stopped.error);
    assert.strictEqual(calls, 1, 'no model call after a stop');
    assert.strictEqual(stopped.session.messages[stopped.session.messages.length - 1].content, 'STOPPED: corrupt');

    calls = 0;
    notes = 0;
    const retrier = fakeService((ctx) => new FakeEngine(ctx.root!, ctx, done, noFailure, { observe: (e, c) => (e.observed === 1 ? { retryCalls: c } : {}) }));
    const retried = await runTurn({
      healing: retrier,
      script: () => (++calls === 1 ? callTool('note_thing', { text: 'a' }, 'call_retry') : say('Done.')),
    });
    assert.ifError(retried.error);
    assert.strictEqual(notes, 2, 'the tool ran twice');
    const results = retried.session.messages.filter((m) => m.role === 'tool' && m.toolCallId === 'call_retry');
    assert.strictEqual(results.length, 1, 'one result per call in the transcript');
    assert.match(results[0].content, /noted 2/);
  });

  test('resume: a complete verdict answers without a model call; continue proceeds with the model', async function () {
    this.timeout(30_000);
    let calls = 0;
    const completeSvc = fakeService((ctx) => new FakeEngine(ctx.root!, ctx, done, noFailure, { resumeEntry: () => ({ action: 'complete', outcome: 'completed', contract, report: 'Verified after resume.' }) }));
    const completed = await runTurn({ healing: completeSvc, resume: true, script: () => (calls++, say('Should not be asked.')) });
    assert.ifError(completed.error);
    assert.strictEqual(calls, 0);
    assert.strictEqual(completed.session.messages[completed.session.messages.length - 1].content, 'Verified after resume.');
    assert.strictEqual(turnEnd(completed.events)?.outcome, 'completed');

    const continueSvc = fakeService((ctx) => new FakeEngine(ctx.root!, ctx, done, noFailure, { resumeEntry: () => ({ action: 'continue', grantSteps: 2 }) }));
    const continued = await runTurn({ healing: continueSvc, resume: true, script: () => (calls++, say('Fixed it.')) });
    assert.ifError(continued.error);
    assert.strictEqual(calls, 1);
    assert.strictEqual(turnEnd(continued.events)?.outcome, 'completed');
  });

  test('dangerous commands ask mandatorily during a recovery, also in a child run of the recovering root', async function () {
    this.timeout(30_000);
    const run = async (healing: ReturnType<typeof fakeService>, depth?: number) => {
      const prompts: { title: string; mandatory?: boolean }[] = [];
      let calls = 0;
      const r = await runTurn({
        healing,
        depth,
        tools: ['run_command'],
        script: () => (++calls === 1 ? callTool('run_command', { command: 'rm -rf build', dangerous: true }) : say('Removed.')),
        approve: async (title, o) => {
          prompts.push({ title, mandatory: o?.mandatory });
          return true;
        },
      });
      assert.ifError(r.error);
      return prompts;
    };
    const idle = await run(fakeService((ctx) => new FakeEngine(ctx.root!, ctx, done, noFailure)));
    assert.deepStrictEqual(idle.map((p) => !!p.mandatory), [false], 'outside a recovery dangerousAlwaysAsk=false applies');

    const recovering = fakeService((ctx) => new FakeEngine(ctx.root!, ctx, done, noFailure, { inRecovery: () => true }));
    assert.deepStrictEqual((await run(recovering)).map((p) => p.mandatory), [true]);
    assert.ok(recovering.engine!.approvals.some((a) => a.kind === 'terminal' && a.mandatory), 'recorded as mandatory');

    const root = new FakeEngine(os.tmpdir(), {} as HealingRunContext, done, noFailure, { inRecovery: () => true });
    const childSvc = fakeService(() => undefined, root);
    assert.deepStrictEqual((await run(childSvc, 1)).map((p) => p.mandatory), [true], 'a child of a recovering root asks mandatorily');
    assert.strictEqual(childSvc.engine, undefined, 'the child has no engine of its own');
    assert.ok(root.approvals.some((a) => a.kind === 'terminal' && a.mandatory && a.decision === 'approved'), 'the child’s approval is in the root’s audit trail');
  });

  test('baseline runs before a file-changing shell command or write; afterWrite gets the successful paths', async function () {
    this.timeout(30_000);
    let calls = 0;
    const svc = fakeService((ctx) => new FakeEngine(ctx.root!, ctx, done, noFailure));
    const { error } = await runTurn({
      healing: svc,
      tools: ['run_command', 'write_file'],
      script: () => {
        calls++;
        if (calls === 1) {
          return callTool('run_command', { command: 'ls' });
        }
        if (calls === 2) {
          return callTool('run_command', { command: "sed -i 's/a/b/' src/x.ts" });
        }
        if (calls === 3) {
          return callTools([['write_file', { path: 'a.txt', content: 'x' }], ['write_file', { path: 'bad.txt', content: 'y' }]]);
        }
        return say('Done.');
      },
    });
    assert.ifError(error);
    const engine = svc.engine!;
    assert.deepStrictEqual(commandLog, ['ls', "sed -i 's/a/b/' src/x.ts"]);
    assert.strictEqual(engine.baselineAfter[0], 1, 'no baseline for a read-only command; one before the sed');
    assert.deepStrictEqual(engine.written, [[path.join(engine.root, 'a.txt')]], 'only the successful write');
  });

  test('a shutdown abort disposes with "shutdown"; a user stop does not', async function () {
    this.timeout(30_000);
    const stop = async (reason?: Error) => {
      const controller = new AbortController();
      const svc = fakeService((ctx) => new FakeEngine(ctx.root!, ctx, done, noFailure));
      await runTurn({
        healing: svc,
        controller,
        script: () => {
          controller.abort(reason);
          return say('Interrupted.');
        },
      });
      return svc.engine!.disposedWith;
    };
    assert.strictEqual(await stop(new Error('shutdown')), 'shutdown');
    const user = await stop();
    assert.ok(user !== 'shutdown' && user !== 'never', `user stop disposed with ${user}`);
  });
});
