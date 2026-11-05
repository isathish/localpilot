import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { checkSemaphore, discoverChecks, HealingService, recoveryBus, RecoveryStore, type HealingEngineConfig, type RecoveryState } from '../agent/healing';
import type { QueueTask, TaskQueue } from '../agent/taskQueue';
import { getConfig } from '../config';
import type { LocalPilotApi } from '../extension';
import { Telemetry } from '../telemetry/telemetry';
import type { Session } from '../types';
import { AgentsTreeProvider } from '../ui/agentsView';
import { ChatController } from '../ui/chatController';
import { call, say, scriptedModel, write, type ModelRequest, type Route, type ScriptedModel } from './fixtures/healing/scriptedModel';
import { CONFLICT, FAN, LEAKED_KEY, materialize, PAD, ROUTES, runOverlap, SECRET, SUM, TS_A, type Fixture, type FixtureName } from './fixtures/healing/workspaces';
import { removeTemp } from './removeTemp';

/**
 * Self-healing end to end in the extension host (design §12): the real extension (LocalPilotApi, chat controller,
 * agent loop, healing service, task queue) against a scripted OpenAI-compatible model and package folders with fake
 * node toolchains (`fixtures/healing`). Covers a model server that is down, TypeScript / unit / integration test
 * failures fixed and verified, missing dependencies (approve, deny, unattended queue, installs disabled), git conflicts,
 * security findings (no model waiver; risk accepted only by the user's chat action), Stop during a long check, and
 * fixer fan-out (worker engines only for healing fixers, one check at a time, child writes seen and rolled back by the
 * parent, Multitask workers not serialised). Approval prompts are answered through the native notification the chat
 * mirrors them to.
 */

type Post = { type: string; sessionId?: string; kind?: string; detail?: string; mandatory?: boolean; event?: { sessionId: string; type: string; payload?: unknown } };

const log = vscode.window.createOutputChannel('LocalPilot self-healing e2e', { log: true });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(cond: () => boolean | Promise<boolean>, timeoutMs: number, what: string): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!(await cond())) {
    if (Date.now() > end) {
      throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}`);
    }
    await sleep(200);
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Largest number of the given model requests in flight at the same moment. */
function reqOverlap(reqs: readonly ModelRequest[]): number {
  return runOverlap(reqs.map((r) => ({ tool: 'model', args: [], pid: 0, start: r.start, end: r.end || Date.now() })));
}

suite('Self-healing end to end (scripted model, fake toolchains)', function () {
  this.timeout(240_000);
  let api: LocalPilotApi;
  let root = '';
  let scratch = '';
  let mock: ScriptedModel;
  let stop: vscode.Disposable | undefined;
  const posts: Post[] = [];
  const made: string[] = [];
  const keys = [
    'providers', 'defaultModel', 'worktrees.mode', 'approvals.write', 'approvals.terminal', 'autoClarify', 'prompts.autoCorrect', 'clarify.questions',
    'queue.concurrency', 'skills.autoInstall', 'routing.enabled', 'routing.parallelModels', 'parallel.maxConcurrency', 'hooks.enabled', 'memory.enabled',
    'autoMode.enabled', 'terminal.runInIntegratedTerminal', 'healing.enabled', 'healing.baseline', 'healing.memory', 'healing.maxRepairAttempts',
    'healing.policies', 'healing.dependencyInstall', 'healing.securityCheck', 'healing.delegateFixes', 'healing.checks', 'healing.autoFix', 'healing.autoRetry',
  ];
  const saved: Record<string, unknown> = {};
  const set = (k: string, v: unknown) => vscode.workspace.getConfiguration('localpilot').update(k, v, vscode.ConfigurationTarget.Global);
  const win = vscode.window as unknown as Record<string, unknown>;
  let originalWarning: unknown;
  /** Answers native warning prompts (mirrored approvals, confirm dialogs); undefined = dismissed. */
  let answer: (message: string, items: string[]) => string | undefined = () => undefined;
  const approve = (ok: boolean) => (_m: string, items: string[]) => (items.includes('Allow') ? (ok ? 'Allow' : items.includes('Deny') ? 'Deny' : undefined) : undefined);
  const memoryFile = () => path.join(root, '.localpilot', 'recovery-memory.json');
  let memoryExisted = false;

  const make = (name: FixtureName): Fixture => {
    const fx = materialize(root, name, scratch);
    made.push(fx.dir);
    return fx;
  };
  const waitIdle = (ids: string[], timeoutMs = 180_000) =>
    new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        sub.dispose();
        ids.forEach((id) => api.stop(id));
        reject(new Error(`still running after ${timeoutMs} ms: ${transcript(ids[0])}`));
      }, timeoutMs);
      const check = () => {
        if (!ids.some((id) => api.runningSessionIds.includes(id))) {
          clearTimeout(timer);
          sub.dispose();
          resolve();
        }
      };
      const sub = api.onDidChangeRuns(check);
      check();
    });
  const transcript = (id: string) => JSON.stringify((api.getSession(id)?.messages ?? []).map((m) => ({ role: m.role, calls: m.toolCalls?.map((c) => c.name), content: m.content.slice(0, 200) })));
  const run = async (prompt: string, mode: Session['mode'] = 'agent'): Promise<string> => {
    const id = await api.runPrompt(prompt, mode);
    await waitIdle([id]);
    await waitFor(() => api.lastOutcome(id) !== undefined, 10_000, `the outcome of ${id}: ${transcript(id)}`);
    return id;
  };
  const eventsOf = (sid: string, type: string) => posts.filter((p) => p.type === 'event' && p.event?.sessionId === sid && p.event.type === type).map((p) => p.event!.payload as Record<string, unknown>);
  const approvalsOf = (sid: string) => posts.filter((p) => p.type === 'approval' && p.sessionId === sid);
  const toolCommands = (sid: string) => posts.filter((p) => p.type === 'event' && p.event?.sessionId === sid && /^tool_(start|end)$/.test(p.event.type)).map((p) => JSON.stringify(p.event!.payload ?? ''));
  const fixPrompts = (sid: string) => (api.getSession(sid)?.messages ?? []).filter((m) => m.role === 'user' && m.meta?.hidden && m.meta.healing?.attempt !== undefined).map((m) => m.content);
  const stateOf = async (sid: string): Promise<RecoveryState> => {
    const s = await api.recovery.state(sid);
    assert.ok(s, `recovery state of ${sid}`);
    return s!;
  };
  const routed = (r: Route) => mock.reqs.filter((x) => x.route === r.re);
  const withRoutes = async <T>(routes: Route[], fn: () => Promise<T>): Promise<T> => {
    const offs = routes.map((r) => mock.route(r));
    try {
      return await fn();
    } finally {
      offs.forEach((off) => off());
    }
  };
  const waitTask = async (id: string): Promise<QueueTask> => {
    await waitFor(() => {
      const t = api.queue.list.find((x) => x.id === id);
      return !!t && t.status !== 'queued' && t.status !== 'running';
    }, 180_000, `queue task ${id}`);
    return api.queue.list.find((x) => x.id === id)!;
  };
  /** The Agents view row of a queue task, from the extension's own tree provider class. */
  const treeItem = (task: QueueTask): vscode.TreeItem => {
    const ev = new vscode.EventEmitter<void>();
    const controller = { store: { onDidChange: ev.event }, onDidChangeRuns: ev.event, tracker: { onDidChange: ev.event }, onDidChangeActive: ev.event, runStatus: new Map<string, string>() };
    const tree = new AgentsTreeProvider(controller as unknown as ChatController, api.queue as unknown as TaskQueue, { recovery: true });
    try {
      return tree.getTreeItem({ kind: 'task', task, position: 1, attention: true } as Parameters<typeof tree.getTreeItem>[0]);
    } finally {
      tree.dispose();
      ev.dispose();
    }
  };

  suiteSetup(async function () {
    if (process.platform === 'win32') {
      this.skip();
    }
    api = await vscode.extensions.getExtension<LocalPilotApi>('localpilot.localpilot-agent')!.activate();
    root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
    if (!root) {
      this.skip();
    }
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'lp-heal-e2e-'));
    memoryExisted = fs.existsSync(memoryFile());
    const cfg = vscode.workspace.getConfiguration('localpilot');
    for (const k of keys) {
      saved[k] = cfg.inspect(k)?.globalValue;
    }
    mock = await scriptedModel();
    await set('providers', [{ id: 'hl', type: 'openai', baseUrl: mock.url, displayName: 'Scripted healing' }]);
    await set('defaultModel', 'hl/m-heal');
    await set('worktrees.mode', 'off');
    await set('approvals.write', 'always');
    await set('approvals.terminal', 'always');
    await set('autoClarify', false);
    await set('prompts.autoCorrect', false);
    await set('clarify.questions', 'minimal');
    await set('queue.concurrency', 1);
    await set('skills.autoInstall', 'off');
    await set('routing.enabled', false);
    await set('routing.parallelModels', false);
    await set('parallel.maxConcurrency', 4);
    await set('hooks.enabled', false);
    await set('memory.enabled', false);
    await set('autoMode.enabled', false);
    await set('terminal.runInIntegratedTerminal', false);
    await set('healing.enabled', true);
    await set('healing.autoFix', true);
    await set('healing.autoRetry', true);
    await set('healing.baseline', 'off');
    await set('healing.memory', 'off');
    await set('healing.maxRepairAttempts', 3);
    await set('healing.policies', {});
    await set('healing.dependencyInstall', 'ask');
    await set('healing.securityCheck', 'changed');
    await set('healing.delegateFixes', true);
    await set('healing.checks', []);
    for (let i = 0; i < 40 && !(await api.listModels()).some((m) => m.id === 'hl/m-heal'); i++) {
      await sleep(250);
    }
    assert.ok((await api.listModels()).some((m) => m.id === 'hl/m-heal'), 'the scripted model is listed');
    // Prompts nobody can see in a chat view are mirrored as notifications, which the stub answers.
    for (const c of ['workbench.action.closeSidebar', 'workbench.action.closeAuxiliaryBar']) {
      await Promise.resolve(vscode.commands.executeCommand(c)).catch(() => undefined);
    }
    originalWarning = win.showWarningMessage;
    win.showWarningMessage = async (message: string, ...rest: unknown[]) => answer(String(message), rest.filter((x): x is string => typeof x === 'string'));
    stop = api.observeChat((m) => posts.push(m as unknown as Post));
    api.queue.setPaused(false);
  });

  suiteTeardown(async () => {
    stop?.dispose();
    if (originalWarning) {
      win.showWarningMessage = originalWarning;
    }
    for (const k of keys) {
      await set(k, saved[k]);
    }
    mock?.close();
    if (root && !memoryExisted) {
      fs.rmSync(memoryFile(), { force: true });
    }
    made.forEach((d) => removeTemp(d));
    if (scratch) {
      removeTemp(scratch);
    }
  });

  setup(() => {
    answer = () => undefined;
  });

  test('model server unavailable: dropped connections are retried with backoff and a health probe, then the turn completes', async () => {
    const net: Route = { re: /HEAL-NET/, reply: () => say('pong'), drop: 2 };
    const id = await withRoutes([net], () => run('HEAL-NET reply with pong'));
    const reqs = routed(net);
    assert.deepStrictEqual(reqs.map((r) => !!r.dropped), [true, true, false], 'two refused requests, then one answered');
    const [a, b, c] = reqs;
    assert.ok(b.start - a.end >= 750, `first backoff ~1 s (was ${b.start - a.end} ms)`);
    assert.ok(c.start - b.end >= 1500, `second backoff ~2 s (was ${c.start - b.end} ms)`);
    assert.ok(mock.modelHits.some((t) => t > a.end && t < c.start), 'the provider health was probed before retrying');
    const retries = eventsOf(id, 'retry');
    assert.deepStrictEqual(retries.map((r) => r.attempt), [1, 2], JSON.stringify(retries));
    assert.ok(retries.every((r) => r.max === 3), 'model_unavailable policy: 3 attempts');
    assert.ok(eventsOf(id, 'recovery').some((r) => r.phase === 'retrying' && r.category === 'model_unavailable'), 'the recovery card shows the retry');
    assert.strictEqual(api.lastOutcome(id), 'completed');
    await waitFor(async () => (await api.telemetry.summary(1)).recovery.recent.filter((r) => r.sid === id && r.action === 'retry' && r.category === 'model_unavailable').length >= 2, 20_000, 'two retry telemetry events');
  });

  test('TypeScript compile failure: typecheck fails, the fix prompt carries the evidence, the model fixes it, typecheck and the regression suite pass', async () => {
    const fx = make('typescript');
    await set('healing.memory', 'project');
    try {
      const ts: Route = {
        re: /HEAL-TS dir=(\S+)/,
        reply: (t) => {
          const file = `${t.match[1]}/src/a.ts`;
          if (!t.fix) {
            return t.toolsAfter ? say('Added BUG_TOTAL to src/a.ts.') : write(file, TS_A.buggy);
          }
          return t.toolsAfter ? say("Root cause: double() was called with the string '2' instead of a number.\nPassed the number 2.") : write(file, TS_A.fixed);
        },
      };
      const id = await withRoutes([ts], () => run(`HEAL-TS dir=${fx.rel} add a total constant to src/a.ts`));
      assert.strictEqual(api.lastOutcome(id), 'completed', transcript(id));
      assert.strictEqual(fx.read('src/a.ts'), TS_A.fixed);
      const s = await stateOf(id);
      assert.strictEqual(s.outcome, 'completed');
      assert.deepStrictEqual(s.attempts.map((x) => [x.category, x.result]), [['typescript', 'fixed']]);
      assert.match(s.attempts[0].rootCause ?? '', /string '2'/, 'the root cause comes from the reply');
      const [prompt, ...more] = fixPrompts(id);
      assert.strictEqual(more.length, 0, 'one fix attempt');
      assert.ok(prompt.includes('attempt 1/3') && prompt.includes('typescript TS2345'), prompt);
      assert.ok(prompt.includes(`${fx.rel}/src/a.ts`) && prompt.includes('BUG_TOTAL') && prompt.includes('Root cause:'), `excerpt, location and the root-cause instruction: ${prompt}`);
      const cards = eventsOf(id, 'recovery');
      assert.ok(cards.some((r) => r.attempt === 1 && r.max === 3), 'the card shows attempt 1/3');
      assert.strictEqual(cards[cards.length - 1].outcome, 'completed');
      const runs = fx.runs().map((r) => `${r.tool}:${r.status}`);
      assert.strictEqual(runs[0], 'tsc:fail', runs.join(' '));
      const passed = runs.indexOf('tsc:pass');
      assert.ok(passed > 0 && runs.indexOf('test:pass') > passed, `typecheck reran, then the regression suite: ${runs.join(' ')}`);
      assert.ok(!runs.slice(0, passed).some((r) => r.startsWith('test')), 'fail fast: no tests while the typecheck fails');
      const memory = fs.readFileSync(memoryFile(), 'utf8');
      assert.ok(/TS2345/.test(memory) && /"success":\s*true/.test(memory), 'a successful fix is remembered');
    } finally {
      await set('healing.memory', 'off');
    }
  });

  test('unit test failure: the related test runs first, the model fixes the implementation, the full suite passes, the test is untouched', async () => {
    const fx = make('unit');
    const unit: Route = {
      re: /HEAL-UNIT dir=(\S+)/,
      reply: (t) => {
        const file = `${t.match[1]}/src/sum.ts`;
        if (!t.fix) {
          return t.toolsAfter ? say('Refactored sum.') : write(file, SUM.buggy);
        }
        return t.toolsAfter ? say('Root cause: the refactor turned the addition into a subtraction.\nRestored a + b.') : write(file, SUM.fixed);
      },
    };
    const id = await withRoutes([unit], () => run(`HEAL-UNIT dir=${fx.rel} refactor src/sum.ts`));
    assert.strictEqual(api.lastOutcome(id), 'completed', transcript(id));
    assert.strictEqual(fx.read('src/sum.test.ts'), SUM.test, 'the test file is untouched');
    assert.strictEqual(fx.read('src/sum.ts'), SUM.fixed);
    const s = await stateOf(id);
    assert.deepStrictEqual(s.attempts.map((x) => [x.category, x.result]), [['unit_test', 'fixed']]);
    assert.match(fixPrompts(id)[0] ?? '', /sum › adds/);
    const runs = fx.runs();
    assert.ok(runs[0].args.includes('--findRelatedTests') && runs[0].args.includes('src/sum.ts') && runs[0].status === 'fail', `scoped run first: ${JSON.stringify(runs)}`);
    const scopedPass = runs.findIndex((r) => r.args.includes('--findRelatedTests') && r.status === 'pass');
    const full = runs.findIndex((r, i) => i > scopedPass && !r.args.includes('--findRelatedTests'));
    assert.ok(scopedPass > 0 && full > scopedPass && runs[full].status === 'pass', `then the full suite: ${JSON.stringify(runs)}`);
    assert.deepStrictEqual(runs[full].results, { 'sum › adds': 'pass', 'other › works': 'pass' });
  });

  test('integration test failure: dependent modules are in the evidence, two diagnostic attempts, fixed on the second', async () => {
    const fx = make('integration');
    const integ: Route = {
      re: /HEAL-INT dir=(\S+)/,
      reply: (t) => {
        const file = `${t.match[1]}/server.ts`;
        if (!t.fix) {
          return t.toolsAfter ? say('Renamed the users route.') : write(file, ROUTES.server('/user'));
        }
        if (t.toolsAfter) {
          return say(t.fixes === 1 ? 'Root cause: the route table and the client disagree.\nAdjusted the route.' : 'Root cause: api/routes.ts still requests /users, so the server must serve /users.\nRestored the route.');
        }
        return write(file, ROUTES.server(t.fixes === 1 ? '/userz' : '/users'));
      },
    };
    const id = await withRoutes([integ], () => run(`HEAL-INT dir=${fx.rel} rename the users route in server.ts`));
    assert.strictEqual(api.lastOutcome(id), 'completed', transcript(id));
    const s = await stateOf(id);
    assert.deepStrictEqual(s.attempts.map((x) => [x.category, x.result]), [['integration_test', 'not_fixed'], ['integration_test', 'fixed']]);
    const [first, second] = fixPrompts(id);
    assert.ok(first.includes('attempt 1/2') && first.includes('integration_test'), first);
    assert.match(first, /Related files \(imports\/importers\):[\s\S]*api\/routes\.ts/, 'repoGraph neighbours of the failing test');
    assert.ok(second.includes('attempt 2/2') && /did not change this error/.test(second), second);
    assert.strictEqual(fx.read('server.ts'), ROUTES.server('/users'));
  });

  test('missing dependency, approved: the install is a mandatory prompt even with terminal commands auto-approved, then checks pass', async () => {
    const fx = make('dependency');
    answer = approve(true);
    const dep: Route = { re: /HEAL-DEP dir=(\S+)/, reply: (t) => (t.toolsAfter ? say('Added pad().') : write(`${t.match[1]}/src/pad.js`, PAD.module)) };
    const id = await withRoutes([dep], () => run(`HEAL-DEP dir=${fx.rel} add a pad helper using left-pad`));
    const asked = approvalsOf(id);
    assert.strictEqual(asked.length, 1, JSON.stringify(asked));
    assert.ok(asked[0].mandatory && asked[0].kind === 'terminal' && /npm install/.test(asked[0].detail ?? ''), JSON.stringify(asked[0]));
    assert.strictEqual(api.lastOutcome(id), 'completed', transcript(id));
    assert.ok(fx.exists('node_modules/left-pad/package.json'), 'installed');
    const s = await stateOf(id);
    assert.deepStrictEqual(s.attempts.map((x) => [x.category, x.strategy, x.result]), [['dependency', 'install', 'fixed']]);
    assert.strictEqual(s.pendingAction?.status, 'done');
    assert.deepStrictEqual(fx.runs().map((r) => r.status), ['fail', 'pass']);
  });

  test('missing dependency, denied: blocked with an approval_needed intervention, nothing installed', async () => {
    const fx = make('dependency');
    answer = approve(false);
    const dep: Route = { re: /HEAL-DEP dir=(\S+)/, reply: (t) => (t.toolsAfter ? say('Added pad().') : write(`${t.match[1]}/src/pad.js`, PAD.module)) };
    const id = await withRoutes([dep], () => run(`HEAL-DEP dir=${fx.rel} add a pad helper using left-pad`));
    assert.strictEqual(approvalsOf(id).length, 1, 'the install was asked once');
    assert.strictEqual(api.lastOutcome(id), 'blocked', transcript(id));
    const s = await stateOf(id);
    assert.strictEqual(s.intervention?.reason, 'approval_needed');
    assert.strictEqual(s.pendingAction?.status, 'declined');
    assert.ok(!fx.exists('node_modules/left-pad'), 'nothing installed');
  });

  test('missing dependency in an unattended queue task: needs_input, no approval card, no install call', async () => {
    const fx = make('dependency');
    const dep: Route = { re: /HEAL-DEP dir=(\S+)/, reply: (t) => (t.toolsAfter ? say('Added pad().') : write(`${t.match[1]}/src/pad.js`, PAD.module)) };
    const task = await withRoutes([dep], async () => waitTask(api.queue.add({ prompt: `HEAL-DEP dir=${fx.rel} add a pad helper using left-pad`, mode: 'agent' }).id));
    try {
      assert.strictEqual(task.status, 'needs_input', JSON.stringify(task));
      assert.ok(task.sessionId && task.interventionId, 'the task keeps its chat and points at the intervention');
      const sid = task.sessionId!;
      assert.strictEqual(approvalsOf(sid).length, 0, 'no approval card waits in a queued chat');
      assert.ok(!toolCommands(sid).some((t) => /npm install/.test(t)), 'no install command was issued');
      assert.ok(!fx.exists('node_modules/left-pad'));
      const s = await stateOf(sid);
      assert.strictEqual(s.intervention?.reason, 'approval_needed');
      assert.strictEqual(s.intervention?.id, task.interventionId);
      assert.strictEqual(treeItem(task).contextValue, 'queueTask.needsInput', 'Agents view context value');
    } finally {
      api.queue.remove(task.id);
    }
  });

  test('missing dependency with dependencyInstall never: blocked without a prompt', async () => {
    const fx = make('dependency');
    await set('healing.dependencyInstall', 'never');
    try {
      const dep: Route = { re: /HEAL-DEP dir=(\S+)/, reply: (t) => (t.toolsAfter ? say('Added pad().') : write(`${t.match[1]}/src/pad.js`, PAD.module)) };
      const id = await withRoutes([dep], () => run(`HEAL-DEP dir=${fx.rel} add a pad helper using left-pad`));
      assert.strictEqual(api.lastOutcome(id), 'blocked', transcript(id));
      assert.strictEqual(approvalsOf(id).length, 0, 'no prompt');
      assert.ok(!toolCommands(id).some((t) => /npm install/.test(t)), 'no install command');
      assert.strictEqual((await stateOf(id)).intervention?.reason, 'approval_needed');
    } finally {
      await set('healing.dependencyInstall', 'ask');
    }
  });

  test('git conflict: escalated at once, the conflicted file is left byte-identical, blocked with Open merge editor', async () => {
    const fx = make('conflict');
    const before = fx.read('a.ts');
    assert.ok(before.includes('<<<<<<<') && before.includes(CONFLICT.theirs.trim()), 'the fixture is mid-merge');
    const git: Route = {
      re: /HEAL-GIT dir=(\S+)/,
      reply: (t) => (t.toolsAfter ? write(`${t.match[1]}/a.ts`, CONFLICT.ours) : call('run_command', { command: 'git status --porcelain', cwd: t.match[1] })),
    };
    const id = await withRoutes([git], () => run(`HEAL-GIT dir=${fx.rel} finish the merge`));
    assert.strictEqual(api.lastOutcome(id), 'blocked', transcript(id));
    assert.strictEqual(routed(git).length, 1, 'no model call after the conflict was detected');
    assert.strictEqual(fx.read('a.ts'), before, 'the user\'s conflicted content is untouched');
    const s = await stateOf(id);
    assert.strictEqual(s.intervention?.reason, 'git_conflict');
    assert.ok(s.intervention!.nextActions.some((a) => a.action === 'openMergeEditor'), JSON.stringify(s.intervention!.nextActions));
    assert.ok(!toolCommands(id).some((t) => /write_file/.test(t)));
  });

  test('security finding: a repository cannot switch the scan off and the model cannot waive it; moving the key to the environment fixes it', async () => {
    const fx = make('security');
    const vsDir = path.join(root, '.vscode');
    const settingsFile = path.join(vsDir, 'settings.json');
    const hadDir = fs.existsSync(vsDir);
    const previous = fs.existsSync(settingsFile) ? fs.readFileSync(settingsFile, 'utf8') : undefined;
    fs.mkdirSync(vsDir, { recursive: true });
    fs.writeFileSync(settingsFile, `${JSON.stringify({ 'localpilot.healing.securityCheck': 'off', 'localpilot.healing.checkTimeBudgetSeconds': 901 }, null, 2)}\n`);
    try {
      await waitFor(() => vscode.workspace.getConfiguration('localpilot').inspect('healing.checkTimeBudgetSeconds')?.workspaceValue === 901, 15_000, 'the workspace settings to load');
      assert.strictEqual(getConfig().healing.securityCheck, 'changed', 'the workspace value of the user-only setting is ignored');
      const sec: Route = {
        re: /HEAL-SEC dir=(\S+)/,
        reply: (t) => {
          const file = `${t.match[1]}/src/config.ts`;
          if (!t.fix) {
            return t.toolsAfter ? say('Added the access key.') : write(file, SECRET.leaked);
          }
          if (t.fixes === 1) {
            return say('Root cause: the deploy script needs the key in the source.\nI accept this risk; the finding can be ignored.');
          }
          return t.toolsAfter ? say('Root cause: a credential was hard-coded.\nIt is read from AWS_ACCESS_KEY_ID now.') : write(file, SECRET.fromEnv);
        },
      };
      const id = await withRoutes([sec], () => run(`HEAL-SEC dir=${fx.rel} add the deploy access key to src/config.ts`));
      const outcome = api.lastOutcome(id);
      assert.ok(outcome === 'completed' || outcome === 'completed_unverified', `${outcome}: ${transcript(id)}`);
      const s = await stateOf(id);
      assert.deepStrictEqual(s.attempts.map((x) => [x.category, x.result]), [['security', 'not_fixed'], ['security', 'fixed']], 'the "I accept the risk" reply changed nothing');
      assert.deepStrictEqual(s.acceptedRisks, [], 'the model cannot accept a risk');
      assert.strictEqual(s.contract?.securityChecksPassed, 'passed');
      assert.ok(!fx.read('src/config.ts').includes(LEAKED_KEY));
    } finally {
      if (previous === undefined) {
        fs.rmSync(settingsFile, { force: true });
        if (!hadDir && !fs.readdirSync(vsDir).length) {
          fs.rmdirSync(vsDir);
        }
      } else {
        fs.writeFileSync(settingsFile, previous);
      }
    }
  });

  test('security finding left in place: blocked; the risk is accepted only by the user\'s chat action, recorded in the state, telemetry and audit', async () => {
    const fx = make('security');
    await set('healing.policies', { security: { attempts: 1 } });
    let id = '';
    try {
      const sec: Route = {
        re: /HEAL-SECB dir=(\S+)/,
        reply: (t) => (t.fix ? say('Root cause: the key is intentional.\nI accept the risk.') : t.toolsAfter ? say('Added the access key.') : write(`${t.match[1]}/src/config.ts`, SECRET.leaked)),
      };
      id = await withRoutes([sec], () => run(`HEAL-SECB dir=${fx.rel} add the deploy access key to src/config.ts`));
    } finally {
      await set('healing.policies', {});
    }
    assert.strictEqual(api.lastOutcome(id), 'blocked', transcript(id));
    const state = await stateOf(id);
    assert.strictEqual(state.intervention?.reason, 'security');
    assert.ok(state.intervention!.nextActions.some((a) => a.action === 'acceptRisk'), 'Accept risk is offered to the user');
    assert.strictEqual(state.contract?.securityChecksPassed, 'failed');
    assert.deepStrictEqual(state.acceptedRisks, []);
    const sig = state.active.find((f) => f.category === 'security')?.signature;
    assert.ok(sig, 'the finding is an active failure');

    // The chat card's Accept risk action, through ChatController.handle, on a service over a copy of the persisted state.
    const dir = path.join(scratch, `accept-risk-${Date.now()}`);
    const store = new RecoveryStore(path.join(dir, 'recovery'), { owner: { kind: 'vscode' } });
    await store.save(JSON.parse(JSON.stringify(state)) as RecoveryState);
    await store.flush();
    const telemetry = new Telemetry({ dir: path.join(dir, 'telemetry'), retentionDays: () => 0 });
    const audits: Record<string, unknown>[] = [];
    const service = new HealingService({
      store, memory: () => undefined, config: () => getConfig().healing as HealingEngineConfig, telemetry, log, bus: recoveryBus, semaphore: checkSemaphore,
      discover: discoverChecks, isTrusted: () => true, audit: (e) => audits.push(e), owner: 'vscode',
    });
    const broadcasts: Record<string, unknown>[] = [];
    const controller = Object.create(ChatController.prototype) as ChatController;
    Object.assign(controller, { healing: service, log, broadcast: (m: Record<string, unknown>) => broadcasts.push(m), runs: new Map(), starting: new Set() });
    const confirms: string[] = [];
    try {
      answer = (m, items) => (confirms.push(m), undefined);
      await controller.handle({ type: 'recoveryAction', sessionId: id, action: 'acceptRisk' });
      assert.strictEqual(confirms.length, 1, 'a confirm dialog is shown');
      assert.deepStrictEqual((await store.load(id))?.acceptedRisks, [], 'dismissing the dialog accepts nothing');
      assert.strictEqual(audits.length, 0);

      answer = (m, items) => (confirms.push(m), items.includes('Accept risk') ? 'Accept risk' : undefined);
      await controller.handle({ type: 'recoveryAction', sessionId: id, action: 'acceptRisk' });
      const after = await store.load(id);
      assert.strictEqual(after?.acceptedRisks.length, 1);
      assert.strictEqual(after!.acceptedRisks[0].by, 'user');
      assert.ok(after!.acceptedRisks[0].signatures.includes(sig!), 'the finding\'s signature is recorded');
      assert.ok(after!.intervention?.resolvedAt, 'the security intervention is resolved');
      assert.strictEqual(audits[0]?.event, 'recovery_accept_risk');
      assert.ok(broadcasts.some((m) => m.type === 'toast' && /Accepted the risk/.test(String(m.text))), JSON.stringify(broadcasts));
      await telemetry.flush();
      const summary = await telemetry.summary(1);
      assert.strictEqual(summary.recovery.acceptedRisks, 1);
      const recent = summary.recovery.recent.find((r) => r.action === 'accept_risk');
      assert.ok(recent && recent.sid === id && recent.category === 'security', JSON.stringify(summary.recovery.recent));
      if (/^[0-9a-f]{16}$/.test(sig!)) {
        assert.strictEqual(recent!.signature, sig, 'telemetry carries the signature hash');
      }
    } finally {
      telemetry.dispose();
      await store.dispose();
    }
  });

  test('Stop during a long check kills the check process and persists cancelled', async () => {
    const fx = make('slow');
    const slow: Route = { re: /HEAL-SLOW dir=(\S+)/, reply: (t) => (t.toolsAfter ? say('Bumped x.') : write(`${t.match[1]}/src/x.ts`, 'export const x = 2;\n')) };
    await withRoutes([slow], async () => {
      const id = await api.runPrompt(`HEAL-SLOW dir=${fx.rel} bump x`, 'agent');
      await waitFor(() => fs.existsSync(fx.pidFile) && !!fs.readFileSync(fx.pidFile, 'utf8').trim(), 120_000, `the check to start: ${transcript(id)}`);
      const pid = Number(fs.readFileSync(fx.pidFile, 'utf8').trim());
      try {
        assert.ok(alive(pid), 'the check is running');
        api.stop(id);
        await waitIdle([id], 30_000);
        await waitFor(() => !alive(pid), 15_000, 'the check process to be killed');
        await waitFor(async () => (await api.recovery.state(id))?.phase === 'cancelled', 10_000, 'the cancelled state');
        const s = await stateOf(id);
        assert.strictEqual(s.outcome, 'cancelled');
        const calls = routed(slow).length;
        await sleep(1500);
        const later = await stateOf(id);
        assert.strictEqual(later.phase, 'cancelled', 'no further transitions');
        assert.strictEqual(later.rev, s.rev, 'nothing was written after the cancel');
        assert.strictEqual(routed(slow).length, calls, 'no model call after Stop');
        assert.ok(!fx.runs().some((r) => r.end !== undefined), 'the check never finished');
      } finally {
        if (alive(pid)) {
          try {
            process.kill(pid, 'SIGKILL');
          } catch {
            // already gone
          }
        }
      }
    });
  });

  test('fixer fan-out: only healing fixers get worker engines, one check at a time, the parent sees and rolls back their writes', async () => {
    const fx = make('fanout');
    await set('healing.maxRepairAttempts', 1);
    try {
      const fileOf = (brief: string) => (/Where: \S*alpha/.test(brief) || (!/Where:/.test(brief) && /alpha/.test(brief)) ? 'alpha' : 'beta');
      const parent: Route = {
        re: /HEAL-FAN dir=(\S+)/,
        reply: (t) => {
          if (t.fix) {
            return say('Root cause: unclear.');
          }
          return t.toolsAfter
            ? say('Updated alpha and beta.')
            : { calls: [{ name: 'write_file', args: { path: `${t.match[1]}/src/alpha.ts`, content: FAN.alpha('ALPHA_BUG') } }, { name: 'write_file', args: { path: `${t.match[1]}/src/beta.ts`, content: FAN.beta('BETA_BUG') } }] };
        },
      };
      const fixer: Route = {
        re: /Fix exactly this/,
        delayMs: 100,
        reply: (t) => {
          const which = fileOf(t.users[0] ?? '');
          const file = `${fx.rel}/src/${which}.ts`;
          if (t.fix) {
            return say('Root cause: the expected beta value is unclear.\nDone: no');
          }
          if (t.toolsAfter) {
            return say(`Root cause: ${which}Value computes the wrong result.\nFiles: ${file}\nDone`);
          }
          return write(file, which === 'alpha' ? FAN.alpha('ALPHA_OK') : FAN.beta('BETA_WRONG'));
        },
      };
      const id = await withRoutes([fixer, parent], () => run(`HEAL-FAN dir=${fx.rel} tune alpha and beta`));
      assert.strictEqual(api.lastOutcome(id), 'incomplete', transcript(id));
      assert.strictEqual(routed(fixer).length > 0, true, 'fixer workers ran');
      const s = await stateOf(id);
      assert.strictEqual(s.attempts[0]?.mode, 'delegate', JSON.stringify(s.attempts));
      const patched = s.attempts[0].patches.map((p) => p.file);
      assert.ok(patched.includes(`${fx.rel}/src/alpha.ts`) && patched.includes(`${fx.rel}/src/beta.ts`), `the parent recorded the fixers' writes: ${patched.join(', ')}`);

      const runs = fx.runs();
      assert.strictEqual(runOverlap(runs), 1, `max concurrent = 1 (never two checks at once): ${JSON.stringify(runs.map((r) => [r.args.join(' '), r.start, r.end]))}`);
      const only = (f: string) => runs.filter((r) => r.args.length === 2 && r.args[0] === '--findRelatedTests' && r.args[1] === f);
      assert.ok(only('src/alpha.ts').length && only('src/beta.ts').length, `each fixer ran its own scoped check (worker engine): ${JSON.stringify(runs.map((r) => r.args))}`);
      const workersDone = Math.max(...[...only('src/alpha.ts'), ...only('src/beta.ts')].map((r) => r.start));
      const recheck = runs.filter((r) => r.start > workersDone && r.args.includes('src/alpha.ts') && r.args.includes('src/beta.ts'));
      assert.ok(recheck.length, 'the parent reran the checks after the fixers wrote');
      assert.deepStrictEqual(recheck[0].results, { 'alpha › works': 'pass', 'beta › works': 'fail' }, 'with the fixers\' files, not a cached result');

      assert.strictEqual(fx.read('src/alpha.ts'), FAN.alpha('ALPHA_OK'));
      const rb = await api.recovery.rollback(id);
      assert.ok(rb.restored.length >= 2, JSON.stringify(rb));
      assert.strictEqual(fx.read('src/alpha.ts'), FAN.alpha('ALPHA_BUG'), 'rollback undid the delegated fix');
      assert.strictEqual(fx.read('src/beta.ts'), FAN.beta('BETA_BUG'));
    } finally {
      await set('healing.maxRepairAttempts', 3);
    }
  });

  test('fixer fan-out that succeeds: each worker runs only its own scoped check, then the parent runs the full suite exactly once', async () => {
    const fx = make('fanout');
    const fileOf = (brief: string) => (/Where: \S*alpha/.test(brief) || (!/Where:/.test(brief) && /alpha/.test(brief)) ? 'alpha' : 'beta');
    const parent: Route = {
      re: /HEAL-FANOK dir=(\S+)/,
      reply: (t) => {
        if (t.fix) {
          return say('Root cause: unclear.');
        }
        return t.toolsAfter
          ? say('Updated alpha and beta.')
          : { calls: [{ name: 'write_file', args: { path: `${t.match[1]}/src/alpha.ts`, content: FAN.alpha('ALPHA_BUG') } }, { name: 'write_file', args: { path: `${t.match[1]}/src/beta.ts`, content: FAN.beta('BETA_BUG') } }] };
      },
    };
    const fixer: Route = {
      re: /Fix exactly this/,
      delayMs: 100,
      reply: (t) => {
        const which = fileOf(t.users[0] ?? '');
        const file = `${fx.rel}/src/${which}.ts`;
        if (t.toolsAfter) {
          return say(`Root cause: ${which}Value computes the wrong result.\nFiles: ${file}\nDone`);
        }
        return write(file, which === 'alpha' ? FAN.alpha('ALPHA_OK') : FAN.beta('BETA_OK'));
      },
    };
    const id = await withRoutes([fixer, parent], () => run(`HEAL-FANOK dir=${fx.rel} tune alpha and beta`));
    assert.strictEqual(api.lastOutcome(id), 'completed', transcript(id));
    const s = await stateOf(id);
    assert.ok(s.attempts.some((a) => a.mode === 'delegate'), JSON.stringify(s.attempts));

    const runs = fx.runs();
    const show = JSON.stringify(runs.map((r) => [r.args.join(' '), r.start, r.end]));
    assert.strictEqual(runOverlap(runs), 1, `max concurrent = 1: ${show}`);
    const single = runs.filter((r) => r.args.length === 2 && r.args[0] === '--findRelatedTests');
    const only = (f: string) => single.filter((r) => r.args[1] === f);
    assert.ok(only('src/alpha.ts').length && only('src/beta.ts').length, `each fixer ran its own scoped check: ${show}`);
    assert.ok(single.every((r) => r.args[1] === 'src/alpha.ts' || r.args[1] === 'src/beta.ts'), `workers checked only their own file: ${show}`);
    const workersDone = Math.max(...single.map((r) => r.end ?? r.start));
    const full = runs.filter((r) => !r.args.includes('--findRelatedTests'));
    assert.ok(full.every((r) => r.start > workersDone), `no worker ran the full suite: ${show}`);
    assert.strictEqual(full.filter((r) => r.start > workersDone).length, 1, `the parent ran the full suite exactly once: ${show}`);
    assert.strictEqual(fx.read('src/alpha.ts'), FAN.alpha('ALPHA_OK'));
    assert.strictEqual(fx.read('src/beta.ts'), FAN.beta('BETA_OK'));
  });

  test('Multitask workers have no engine of their own: they run at the same time and only the coordinator checks, once they reported', async () => {
    const fx = make('fanout');
    const coord: Route = {
      re: /COORD-FAN dir=(\S+)/,
      reply: (t) =>
        t.toolsAfter
          ? say('COORD-DONE')
          : call('run_parallel_subagents', { tasks: ['alpha', 'beta'].map((w) => ({ agent: 'coder', prompt: `FANWRITE file=${t.match[1]}/src/${w}.ts which=${w}` })) }),
    };
    const worker: Route = {
      re: /FANWRITE file=(\S+) which=(\w+)/,
      delayMs: 400,
      reply: (t) => (t.toolsAfter ? say(`DONE ${t.match[2]}`) : write(t.match[1], `${t.match[2] === 'alpha' ? FAN.alpha('ALPHA_OK') : FAN.beta('BETA_OK')}// v2\n`)),
    };
    const id = await withRoutes([worker, coord], () => run(`COORD-FAN dir=${fx.rel} update alpha and beta`, 'multitask'));
    assert.strictEqual(api.lastOutcome(id), 'completed', transcript(id));
    const workerReqs = routed(worker);
    assert.ok(reqOverlap(workerReqs) >= 2, `the workers ran at the same time (${workerReqs.length} requests)`);
    const runs = fx.runs();
    const workersEnd = Math.max(...workerReqs.map((r) => r.end));
    assert.ok(runs.length > 0, 'the coordinator verified the workers\' writes');
    assert.ok(runs.every((r) => r.start >= workersEnd), `no checks ran inside the workers: ${JSON.stringify(runs.map((r) => [r.args.join(' '), r.start]))} vs ${workersEnd}`);
    assert.ok(!runs.some((r) => r.args.length === 2 && r.args[0] === '--findRelatedTests'), 'no single-file worker checks');
    assert.ok(fx.read('src/alpha.ts').includes('// v2') && fx.read('src/beta.ts').includes('// v2'));
  });

  test('queue task whose tests still fail: incomplete, with the Agents view context value the menus match', async () => {
    const fx = make('unit');
    await set('healing.maxRepairAttempts', 1);
    const stuck: Route = { re: /HEAL-STUCK dir=(\S+)/, reply: (t) => (t.fix ? say('Root cause: not sure what sum should do.') : t.toolsAfter ? say('Refactored sum.') : write(`${t.match[1]}/src/sum.ts`, SUM.buggy)) };
    let task: QueueTask | undefined;
    try {
      task = await withRoutes([stuck], async () => waitTask(api.queue.add({ prompt: `HEAL-STUCK dir=${fx.rel} refactor src/sum.ts`, mode: 'agent' }).id));
      assert.strictEqual(task.status, 'incomplete', JSON.stringify(task));
      assert.strictEqual(task.outcome, 'incomplete');
      assert.strictEqual(treeItem(task).contextValue, 'queueTask.incomplete');
      const menus = (vscode.extensions.getExtension('localpilot.localpilot-agent')!.packageJSON as { contributes: { menus: Record<string, { when?: string }[]> } }).contributes.menus;
      const when = Object.values(menus).flat().map((m) => m.when ?? '');
      assert.ok(when.some((w) => w.includes('viewItem == queueTask.incomplete') && w.includes('viewItem == queueTask.needsInput')), 'package.json menus match both context values');
    } finally {
      await set('healing.maxRepairAttempts', 3);
      if (task) {
        api.queue.remove(task.id);
      }
    }
  });
});
