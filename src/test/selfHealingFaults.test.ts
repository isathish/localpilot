import * as assert from 'assert';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as http from 'http';
import { AddressInfo } from 'net';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { AgentRunner } from '../agent/agentLoop';
import { CheckSemaphore, discoverChecks, FailureMemory, HealingService, RecoveryBus, RecoveryStore, type CompletionContract, type HealingEngineConfig, type RecoveryEventPayload, type RecoveryState, type RecoverySummary, type TaskOutcome } from '../agent/healing';
import { changedFilesScan, repoGraphView } from '../agent/healing/hostAdapters';
import { SkillManager } from '../agent/skills';
import { getConfig } from '../config';
import { buildRepoGraph } from '../context/repoGraph';
import { WorkspaceContext } from '../context/workspaceContext';
import { restoreWorkspaceFile } from '../healingHost';
import { OpenAICompatProvider } from '../providers/openaiCompat';
import { ProviderRegistry } from '../providers/registry';
import { summarize, type TelemetryEvent, type TelemetryInput } from '../telemetry/telemetry';
import { ToolRegistry } from '../tools/registry';
import { runCommandTool } from '../tools/terminal';
import type { AgentEvent, ChatMessage, ModelInfo, Session, Tool } from '../types';
import { removeTemp } from './removeTemp';

/**
 * Fault-injection suite of the self-healing engine (spec "Required fault-injection tests", design §12), in the
 * extension host: the real AgentRunner, HealingService, RecoveryStore, failure memory, check discovery and `run_command`
 * against real temporary npm projects whose `typecheck` / `test` scripts (`node check.js`) print real-format tsc and
 * jest output derived from the files, and a scripted OpenAI-compatible model that fails on command (refused
 * connections, no first token, malformed tool calls). Clock, backoff sleep and the provider health probe are injected,
 * so nothing waits for real and every budget is deterministic.
 */

const log = vscode.window.createOutputChannel('LocalPilot self-healing faults', { log: true });
const FIX_HEAD = '[LocalPilot self-healing';
const BUGGY = "export const a: number = 'BUG';\n";
const CLEAN = 'export const a: number = 1;\n';
const SUM_OK = 'export const sum = (a: number, b: number): number => a + b;\n';
const SUM_BAD = 'export const sum = (a: number, b: number): number => a - b;\n';
const SUM_TEST = "import { sum } from './sum';\n\ndescribe('sum', () => {\n  test('adds', () => {\n    expect(sum(1, 2)).toBe(3);\n  });\n});\n";
const server = (route: string) => `export const ROUTES = { users: '${route}' };\n\nexport function handle(p: string): number {\n  return Object.values(ROUTES).includes(p) ? 200 : 404;\n}\n`;
const ROUTES_TS = "import { handle } from '../server';\n\nexport const getUsers = (): number => handle('/users');\n";
const KEY = 'AKIAQ7RZ3MXW5TPL2KVD';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(what: string, cond: () => boolean, ms = 60_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await sleep(50);
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

// ---------------------------------------------------------------- the scripted model

type Wire = { role: string; content?: unknown };
const textOf = (c: unknown): string => (typeof c === 'string' ? c : Array.isArray(c) ? c.map((p) => (p as { text?: string }).text ?? '').join('') : '');

interface Turn {
  /** 1-based request count of this model. */
  n: number;
  /** The engine's fix prompt is the latest message. */
  fix: boolean;
  /** Fix prompts in the conversation so far. */
  fixes: number;
}

interface Reply {
  text?: string;
  calls?: { name: string; args: Record<string, unknown> }[];
  finish?: string;
  /** Never send a byte: the first-token watchdog has to call it a stall. */
  hang?: boolean;
}

type Script = (t: Turn) => Reply;

const say = (text: string): Reply => ({ text });
const call = (name: string, args: Record<string, unknown>): Reply => ({ calls: [{ name, args }] });
const write = (p: string, content: string): Reply => call('write_file', { path: p, content });

/** One OpenAI-compatible server for every scripted model (by model id); its socket can be closed and reopened. */
class FaultModel {
  readonly scripts = new Map<string, Script>();
  readonly hits: { model: string; at: number }[] = [];
  private readonly hung = new Set<http.ServerResponse>();
  private srv?: http.Server;
  port = 0;

  get url(): string {
    return `http://127.0.0.1:${this.port}/v1`;
  }

  count(model: string): number {
    return this.hits.filter((h) => h.model === model).length;
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse, body: string): void {
    if (req.url !== '/v1/chat/completions') {
      res.statusCode = 404;
      res.end();
      return;
    }
    const j = JSON.parse(body) as { model: string; messages: Wire[] };
    const script = this.scripts.get(j.model);
    if (!script) {
      res.statusCode = 404;
      res.end(JSON.stringify({ error: { message: `model ${j.model} not found` } }));
      return;
    }
    this.hits.push({ model: j.model, at: Date.now() });
    const last = j.messages[j.messages.length - 1];
    const isFix = (m: Wire | undefined) => m?.role === 'user' && textOf(m.content).trimStart().startsWith(FIX_HEAD);
    const r = script({ n: this.count(j.model), fix: isFix(last), fixes: j.messages.filter(isFix).length });
    if (r.hang) {
      this.hung.add(res);
      res.on('close', () => this.hung.delete(res));
      return;
    }
    res.setHeader('content-type', 'text/event-stream');
    const send = (o: unknown) => res.write(`data: ${JSON.stringify(o)}\n\n`);
    if (r.text) {
      send({ choices: [{ index: 0, delta: { content: r.text } }] });
    }
    (r.calls ?? []).forEach((c, index) => send({ choices: [{ index: 0, delta: { tool_calls: [{ index, id: `fi_${this.hits.length}_${index}`, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) } }] } }] }));
    send({ choices: [{ index: 0, delta: {}, finish_reason: r.finish ?? (r.calls?.length ? 'tool_calls' : 'stop') }], usage: { prompt_tokens: 100, completion_tokens: 10 } });
    res.end('data: [DONE]\n\n');
  }

  /** (Re)opens the listening socket, on the same port once one was used. */
  async listen(): Promise<void> {
    const srv = http.createServer((req, res) => {
      let body = '';
      req.on('data', (d) => (body += d));
      req.on('end', () => this.handle(req, res, body));
    });
    await new Promise<void>((resolve, reject) => {
      srv.once('error', reject);
      srv.listen(this.port, '127.0.0.1', () => resolve());
    });
    this.srv = srv;
    this.port = (srv.address() as AddressInfo).port;
  }

  /** Listens again if a test left the socket closed. */
  async ensure(): Promise<void> {
    if (!this.srv) {
      await this.listen();
    }
  }

  /** Closes the socket: connections are refused until `listen()`. */
  async shut(): Promise<void> {
    const srv = this.srv;
    this.srv = undefined;
    this.hung.forEach((r) => r.destroy());
    this.hung.clear();
    if (srv) {
      srv.closeAllConnections();
      await new Promise<void>((r) => srv.close(() => r()));
    }
  }
}

// ---------------------------------------------------------------- real temporary projects

/**
 * The project's toolchain: `node check.js typecheck|test` prints real tsc / jest output derived from the files and
 * appends `{kind, t, status}` lines to a log outside the project. typecheck: `BUG` in src/a.ts -> TS2322; with the hang
 * marker present a clean typecheck never ends (its pid is written). test: `a - b` or `BUG_<x>` in src/sum.ts -> a jest
 * unit failure; server.ts not serving /users -> an integration failure; src/pad.js whose require fails -> a missing module.
 */
function checkScript(logFile: string, hangFile: string, pidFile: string): string {
  return `'use strict';
const fs = require('fs');
const path = require('path');
const kind = process.argv[2];
const read = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return undefined; } };
const note = (status) => fs.appendFileSync(${JSON.stringify(logFile)}, JSON.stringify({ kind, t: Date.now(), status }) + '\\n');
const fail = (lines, code) => { note('fail'); process.stdout.write(lines.join('\\n') + '\\n'); process.exit(code); };
const jest = (file, name, message, frames) => ['FAIL ' + file, '  \\u25cf ' + name, '', ...message.map((l) => '    ' + l), '', ...frames.map((f) => '      at Object.<anonymous> (' + f + ')'), '', 'Tests:       1 failed, 1 total'];
note('start');
if (kind === 'typecheck') {
  const a = read('src/a.ts');
  if (a !== undefined && a.includes('BUG')) {
    fail(["src/a.ts(1,14): error TS2322: Type 'string' is not assignable to type 'number'.", '', 'Found 1 error.'], 2);
  }
  if (fs.existsSync(${JSON.stringify(hangFile)})) {
    fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
    setInterval(() => undefined, 1000);
    return;
  }
  note('pass');
  console.log('typecheck ok');
  process.exit(0);
}
if (kind === 'test') {
  const sum = read('src/sum.ts');
  const bug = sum === undefined ? null : /BUG_(\\w+)/.exec(sum);
  if (sum !== undefined && (bug || sum.includes('a - b'))) {
    fail(jest('src/sum.test.ts', 'sum \\u203a adds' + (bug ? ' ' + bug[1] : ''), ['expect(received).toBe(expected) // Object.is equality', '', 'Expected: 3', 'Received: -1'], ['src/sum.test.ts:5:23']), 1);
  }
  const srv = read('server.ts');
  if (srv !== undefined && !srv.includes("users: '/users'")) {
    fail(jest('api/routes.integration.test.ts', 'api \\u203a GET /users', ['expected status 200 received 404'], ['api/routes.ts:3:42', 'api/routes.integration.test.ts:3:40']), 1);
  }
  if (fs.existsSync('src/pad.js')) {
    try {
      require(path.resolve('src/pad.js'));
    } catch (e) {
      const m = /Cannot find module '([^']+)'/.exec(String(e && e.message));
      fail(['FAIL src/pad.test.js', '  \\u25cf Test suite failed to run', '', "    Cannot find module '" + (m ? m[1] : '?') + "' from 'src/pad.js'", '', '      at Object.<anonymous> (src/pad.js:1:18)', '', 'Tests:       0 total'], 1);
    }
  }
  note('pass');
  console.log('Tests:       1 passed, 1 total');
}
`;
}

interface Project {
  root: string;
  /** Marker outside the project: while it exists a clean typecheck hangs. */
  hangFile: string;
  pidFile: string;
  read(rel: string): string;
  exists(rel: string): boolean;
  /** Check runs in order, from the log outside the project. */
  runs(): { kind: string; t: number; status: 'start' | 'pass' | 'fail' }[];
}

const temps: string[] = [];
const tmp = (prefix: string) => {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  temps.push(d);
  return d;
};

function project(files: Record<string, string>, extra: Record<string, unknown> = {}): Project {
  const root = tmp('lp-fi-ws-');
  const side = tmp('lp-fi-side-');
  const logFile = path.join(side, 'checks.jsonl');
  const hangFile = path.join(side, 'hang');
  const pidFile = path.join(side, 'check.pid');
  fs.writeFileSync(logFile, '');
  const all: Record<string, string> = {
    'package.json': `${JSON.stringify({ name: 'lp-fault', version: '1.0.0', private: true, scripts: { typecheck: 'node check.js typecheck', test: 'node check.js test' }, ...extra }, null, 2)}\n`,
    '.npmrc': 'audit=false\nfund=false\nupdate-notifier=false\npackage-lock=false\n',
    'check.js': checkScript(logFile, hangFile, pidFile),
    'src/a.ts': CLEAN,
    ...files,
  };
  for (const [rel, body] of Object.entries(all)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), body);
  }
  return {
    root,
    hangFile,
    pidFile,
    read: (rel) => fs.readFileSync(path.join(root, rel), 'utf8'),
    exists: (rel) => fs.existsSync(path.join(root, rel)),
    runs: () =>
      fs
        .readFileSync(logFile, 'utf8')
        .split('\n')
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l) as { kind: string; t: number; status: 'start' | 'pass' | 'fail' }),
  };
}

const git = (cwd: string, args: string) =>
  cp.execSync(`git ${args}`, { cwd, stdio: 'pipe', env: { ...process.env, GIT_AUTHOR_NAME: 'fi', GIT_AUTHOR_EMAIL: 'fi@localpilot', GIT_COMMITTER_NAME: 'fi', GIT_COMMITTER_EMAIL: 'fi@localpilot' } }).toString();

// ---------------------------------------------------------------- one run through AgentRunner + HealingService

/** Edit tools over the real file system: snapshot through `trackChange` (the engine's patch scope), then write. */
function fileTools(writes: string[]): Tool[] {
  const schema = (props: Record<string, string>, required: string[]) => ({ type: 'object' as const, properties: Object.fromEntries(Object.entries(props).map(([k, t]) => [k, { type: t }])), required });
  return [
    {
      parallelSafe: true,
      readOnly: true,
      definition: { name: 'read_file', description: 'Read a file', parameters: schema({ path: 'string', offset: 'integer' }, ['path']) },
      async execute(a, ctx) {
        try {
          return { content: fs.readFileSync(path.resolve(ctx.workspaceRoot!, String(a.path ?? '')), 'utf8') };
        } catch {
          return { content: `File not found: ${String(a.path)}`, isError: true };
        }
      },
    },
    {
      approvalKind: 'write',
      definition: { name: 'write_file', description: 'Create or overwrite a file', parameters: schema({ path: 'string', content: 'string' }, ['path', 'content']) },
      async execute(a, ctx) {
        const file = path.resolve(ctx.workspaceRoot!, String(a.path ?? ''));
        await ctx.trackChange(file);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, String(a.content ?? ''));
        writes.push(String(a.path));
        return { content: `Wrote ${String(a.path)}`, data: { path: file, kind: 'update' } };
      },
    },
  ];
}

interface Prompt {
  title: string;
  detail: string;
  kind: string;
  mandatory: boolean;
}

interface Harness {
  svc: HealingService;
  store: RecoveryStore;
  memory: FailureMemory;
  tele: TelemetryInput[];
  sleeps: number[];
  probes: string[];
}

interface HarnessOpts {
  storeDir?: string;
  clock?: { offset: number };
  probe?: () => boolean | Promise<boolean>;
  /** Engine settings on top of the suite's (`localpilot.healing.*`). */
  heal?: Partial<HealingEngineConfig>;
}

const ENGINE: Partial<HealingEngineConfig> = {
  enabled: true, autoDetect: true, autoRetry: true, autoFix: true, regressionRequired: true, maxRepairAttempts: 3, maxTotalAttempts: 8, extraSteps: 16,
  taskDeadlineMinutes: 60, checkTiming: 'onComplete', baseline: 'off', checks: [], policies: {}, dependencyInstall: 'ask', securityCheck: 'changed',
  delegateFixes: false, memory: 'workspace',
};

/** The service as extension.ts wires it, with the store folder, clock, backoff sleep and health probe under test control. */
function harness(o: HarnessOpts = {}): Harness {
  const clock = o.clock ?? { offset: 0 };
  const now = () => Date.now() + clock.offset;
  const store = new RecoveryStore(o.storeDir ?? tmp('lp-fi-store-'), { owner: { kind: 'vscode' }, now, log });
  const memory = new FailureMemory(path.join(tmp('lp-fi-mem-'), 'memory.json'), { now });
  const h = { store, memory, tele: [] as TelemetryInput[], sleeps: [] as number[], probes: [] as string[] };
  const svc = new HealingService({
    store,
    memory: () => memory,
    config: () => ({ ...getConfig().healing, ...ENGINE, ...(o.heal ?? {}) }) as HealingEngineConfig,
    telemetry: { record: (e) => h.tele.push(e) },
    log,
    bus: new RecoveryBus(),
    semaphore: new CheckSemaphore(1),
    discover: discoverChecks,
    isTrusted: () => true,
    repoGraph: async (root) => repoGraphView(await buildRepoGraph(root, 0)),
    securityScan: changedFilesScan(),
    probe: async (target) => {
      h.probes.push(target);
      return o.probe ? o.probe() : true;
    },
    restoreFile: restoreWorkspaceFile,
    now,
    sleep: async (ms) => {
      h.sleeps.push(ms);
      clock.offset += ms;
    },
    random: () => 0.5,
    owner: 'vscode',
  });
  return { svc, ...h };
}

interface RunOpts {
  model: string;
  project: Project;
  prompt?: string;
  /** False: a text-protocol model (tool calls in the reply text). */
  tools?: boolean;
  maxIterations?: number;
  firstTokenTimeoutMs?: number;
  approve?: (p: Prompt) => boolean;
  h?: Harness;
  session?: Session;
  resume?: boolean;
  controller?: AbortController;
}

interface TurnEnd {
  text: string;
  outcome?: TaskOutcome;
  contract?: CompletionContract;
  recovery?: RecoverySummary;
}

interface RunResult {
  text: string;
  error?: unknown;
  sid: string;
  session: Session;
  events: AgentEvent[];
  end?: TurnEnd;
  outcome?: TaskOutcome;
  prompts: Prompt[];
  writes: string[];
  /** Commands of the engine's own (synthetic) run_command calls, in order. */
  checks: string[];
  /** The hidden fix prompts pushed into the transcript. */
  hidden: ChatMessage[];
  cards: RecoveryEventPayload[];
  state?: RecoveryState;
  h: Harness;
}

let lab: FaultModel;

async function run(o: RunOpts): Promise<RunResult> {
  const h = o.h ?? harness();
  const writes: string[] = [];
  const prompts: Prompt[] = [];
  const events: AgentEvent[] = [];
  const tools = new ToolRegistry();
  tools.registerAll([...fileTools(writes), runCommandTool]);
  const providers = new ProviderRegistry(log);
  const model: ModelInfo = { id: `fi/${o.model}`, providerId: 'fi', modelId: o.model, name: o.model, contextWindow: 32768, maxOutputTokens: 2048, supportsTools: o.tools !== false, supportsVision: false };
  const provider = new OpenAICompatProvider({ id: 'fi', type: 'openai', baseUrl: lab.url, models: [o.model] });
  Object.assign(providers, { route: async () => ({ provider, model }), residentModels: async () => new Set<string>(), markUnresponsive: () => undefined });
  const runner = new AgentRunner(providers, tools, new SkillManager(log), new WorkspaceContext(log), log);
  runner.healing = h.svc;
  runner.telemetry = { record: (e: TelemetryInput) => h.tele.push(e) } as unknown as AgentRunner['telemetry'];
  const now = Date.now();
  const session: Session = o.session ?? { id: `fi-${o.model}-${now.toString(36)}`, title: 'fault injection', createdAt: now, updatedAt: now, model: model.id, mode: 'agent', messageCount: 0, messages: [], contextTokens: 0, compactions: 0, attachments: [], todos: [], workingSet: [] };
  let text = '';
  let error: unknown;
  try {
    text = await runner.run({
      session,
      userMessage: o.resume ? { role: 'user', content: o.prompt ?? 'Continue the interrupted task.', meta: { hidden: true } } : { role: 'user', content: o.prompt ?? 'Update the code in src as needed.' },
      emit: (e) => events.push(e),
      signal: (o.controller ?? new AbortController()).signal,
      requestApproval: async (title, detail, kind, opts) => {
        const p = { title, detail, kind, mandatory: !!opts?.mandatory };
        prompts.push(p);
        return o.approve ? o.approve(p) : true;
      },
      workspaceRoot: o.project.root,
      ...(o.maxIterations ? { maxIterations: o.maxIterations } : {}),
      ...(o.firstTokenTimeoutMs ? { firstTokenTimeoutMs: o.firstTokenTimeoutMs } : {}),
      ...(o.resume ? { resume: true } : {}),
    });
  } catch (e) {
    error = e;
  } finally {
    providers.dispose();
    tools.dispose();
  }
  const healingIds = new Set(events.filter((e) => e.type === 'tool_start' && (e.payload as { origin?: string }).origin === 'healing').map((e) => (e.payload as { id: string }).id));
  const end = events.filter((e) => e.type === 'turn_end').pop()?.payload as TurnEnd | undefined;
  return {
    text,
    error,
    sid: session.id,
    session,
    events,
    end,
    outcome: end?.outcome,
    prompts,
    writes,
    checks: events.filter((e) => e.type === 'tool_start' && healingIds.has((e.payload as { id: string }).id)).map((e) => String((e.payload as { args?: { command?: string } }).args?.command ?? '')),
    hidden: session.messages.filter((m) => m.role === 'user' && m.meta?.hidden && m.meta.healing),
    cards: events.filter((e) => e.type === 'recovery').map((e) => e.payload as RecoveryEventPayload),
    state: await h.store.load(session.id),
    h,
  };
}

const recoveryActions = (r: RunResult, category?: string) => r.h.tele.flatMap((e) => (e.type === 'recovery' && (!category || e.category === category) ? [e.action] : []));
/** The Dashboard's recovery numbers over this run's telemetry. */
const dashboard = (r: RunResult) => {
  const t = Date.now();
  return summarize(r.h.tele.map((e) => ({ t, ...e }) as TelemetryEvent), { days: 1, from: t - 86_400_000, to: t + 60_000 }).recovery;
};
const retriesOf = (r: RunResult) => r.events.filter((e) => e.type === 'retry').map((e) => e.payload as { reason?: string; attempt?: number; max?: number });
const show = (r: RunResult) => JSON.stringify({ outcome: r.outcome, reason: r.state?.intervention?.reason, checks: r.checks, attempts: r.state?.attempts.map((a) => [a.category, a.result]), text: r.text.slice(0, 600), error: r.error ? String(r.error) : undefined });

// ---------------------------------------------------------------- scenarios

suite('Self-healing fault injection (spec scenarios, extension host)', function () {
  this.timeout(300_000);
  const cfg = () => vscode.workspace.getConfiguration('localpilot');
  const settings: Record<string, unknown> = {
    'approvals.write': 'always',
    'approvals.terminal': 'always',
    autoClarify: false,
    'prompts.autoCorrect': false,
    'hooks.enabled': false,
    'memory.enabled': false,
    'autoMode.enabled': false,
    'skills.autoInstall': 'off',
    'terminal.runInIntegratedTerminal': false,
    'healing.enabled': true,
    'healing.baseline': 'off',
    'healing.delegateFixes': false,
    'healing.extraSteps': 16,
  };
  const saved: Record<string, unknown> = {};

  suiteSetup(async function () {
    if (process.platform === 'win32') {
      this.skip();
    }
    for (const [k, v] of Object.entries(settings)) {
      saved[k] = cfg().inspect(k)?.globalValue;
      await cfg().update(k, v, vscode.ConfigurationTarget.Global);
    }
    lab = new FaultModel();
    await lab.listen();
  });

  setup(() => lab.ensure());

  suiteTeardown(async () => {
    await lab?.shut();
    for (const k of Object.keys(settings)) {
      await cfg().update(k, saved[k], vscode.ConfigurationTarget.Global);
    }
    temps.splice(0).forEach(removeTemp);
  });

  test('Ollama unavailable: refused connections are detected as model_unavailable, the health probe runs, backoff 1 s then 2 s, the third request answers', async () => {
    lab.scripts.set('down', () => say('Hello again.'));
    await lab.shut();
    let probed = 0;
    const h = harness({
      probe: async () => {
        if (++probed === 2) {
          await lab.listen();
        }
        return probed >= 2;
      },
    });
    const r = await run({ model: 'down', project: project({}), prompt: 'Say hello.', h });
    assert.ok(!r.error && r.text === 'Hello again.', show(r));
    assert.strictEqual(lab.count('down'), 1, 'two requests were refused, the third reached the server');
    const retries = retriesOf(r);
    assert.deepStrictEqual(retries.map((x) => [x.reason, x.attempt]), [['network', 1], ['network', 2]], JSON.stringify(retries));
    assert.ok(retries.every((x) => x.max === 3), 'model_unavailable policy: 3 retries');
    assert.deepStrictEqual(h.sleeps, [1000, 2000], 'exponential backoff through the injected sleep');
    assert.deepStrictEqual(h.probes, ['fi/down', 'fi/down'], 'the provider is probed before each retry');
    assert.strictEqual(recoveryActions(r, 'model_unavailable').filter((a) => a === 'retry').length, 2);
    assert.strictEqual(r.outcome, 'completed', show(r));
    assert.ok(!r.checks.length, 'nothing to verify');
  });

  test('model timeout: a stalled first token is retried within the deadline and the turn completes', async () => {
    lab.scripts.set('staller', (t) => (t.n === 1 ? { hang: true } : say('Here is the answer.')));
    const r = await run({ model: 'staller', project: project({}), prompt: 'Explain the code.', firstTokenTimeoutMs: 200 });
    assert.ok(!r.error && r.text === 'Here is the answer.', show(r));
    assert.strictEqual(lab.count('staller'), 2);
    assert.deepStrictEqual(retriesOf(r).map((x) => x.reason), ['stall']);
    assert.ok(recoveryActions(r, 'model_timeout').includes('retry'), JSON.stringify(r.h.tele));
    assert.strictEqual(r.h.sleeps.length, 1, 'one backoff wait');
  });

  test('model timeout past the recovery deadline: escalated with the budget named, outcome incomplete, no model call after the stop', async () => {
    const clock = { offset: 0 };
    let fixTurns = 0;
    lab.scripts.set('laggard', (t) => {
      if (t.n === 1) {
        return write('src/a.ts', BUGGY);
      }
      if (!t.fixes) {
        return say('Done.');
      }
      if (++fixTurns === 1) {
        return { hang: true };
      }
      clock.offset += 2 * 60_000;
      return call('read_file', { path: 'src/a.ts' });
    });
    const h = harness({ clock, heal: { taskDeadlineMinutes: 1 } });
    const r = await run({ model: 'laggard', project: project({}), h, firstTokenTimeoutMs: 200 });
    const calls = lab.count('laggard');
    await sleep(300);
    assert.ok(retriesOf(r).some((x) => x.reason === 'stall'), 'the stall inside the fix attempt was retried');
    assert.strictEqual(r.outcome, 'incomplete', show(r));
    assert.strictEqual(r.state?.intervention?.reason, 'deadline');
    assert.match(r.text, /deadline of 1 min/);
    assert.strictEqual(lab.count('laggard'), calls, 'no model call after the stop');
    assert.strictEqual(calls, 4);
  });

  test('invalid JSON: a trailing comma is repaired without a round trip; a truncated write_file is resent, never brace-balanced', async () => {
    lab.scripts.set('comma', (t) => (t.n === 1 ? say('<tool_call>\n{"name": "read_file", "arguments": {"path": "src/a.ts",},}\n</tool_call>') : say('src/a.ts exports the constant a.')));
    const a = await run({ model: 'comma', tools: false, project: project({}), prompt: 'What does src/a.ts export?' });
    assert.strictEqual(lab.count('comma'), 2, show(a));
    assert.ok(!a.events.some((e) => e.type === 'nudge'), 'repaired locally, no repair nudge');
    assert.ok(a.session.messages.some((m) => m.role !== 'assistant' && m.content.includes(CLEAN.trim())), 'the repaired read_file ran');

    lab.scripts.set('trunc', (t) =>
      t.n === 1
        ? say('<tool_call>\n{"name": "write_file", "arguments": {"path": "b.txt", "content": "the first half"}\n</tool_call>')
        : t.n === 2
          ? say('<tool_call>\n{"name": "write_file", "arguments": {"path": "b.txt", "content": "complete"}}\n</tool_call>')
          : say('Wrote b.txt.'),
    );
    const p = project({});
    const b = await run({ model: 'trunc', tools: false, project: p, prompt: 'Create b.txt.' });
    assert.deepStrictEqual(b.writes, ['b.txt'], 'only the resent call wrote');
    assert.strictEqual(p.read('b.txt'), 'complete');
    assert.ok(b.events.some((e) => e.type === 'nudge' && (e.payload as { reason?: string }).reason === 'malformed'), 'the model was asked to resend');
  });

  test('invalid JSON that never parses: model_output repair budget (2) is exhausted, escalated, nothing written', async () => {
    lab.scripts.set('broken', () => say('<tool_call>\n{"name": "write_file", "arguments": {"path": "c.txt", "content": <<<x>>>}}\n</tool_call>'));
    const p = project({});
    const r = await run({ model: 'broken', tools: false, project: p, prompt: 'Create c.txt.' });
    const nudges = r.events.filter((e) => e.type === 'nudge' && (e.payload as { reason?: string }).reason === 'malformed').length;
    assert.strictEqual(nudges, 2, show(r));
    assert.strictEqual(lab.count('broken'), 3);
    assert.strictEqual(r.outcome, 'incomplete', show(r));
    assert.strictEqual(r.state?.intervention?.reason, 'exhausted');
    assert.ok(!p.exists('c.txt'));
  });

  test('TypeScript compile failure: typecheck fails, the fix prompt has the evidence, the patch is validated, regression runs, memory and telemetry record it', async () => {
    lab.scripts.set('tsfix', (t) => (t.n === 1 ? write('src/a.ts', BUGGY) : t.fix ? write('src/a.ts', CLEAN) : say(t.fixes ? 'Root cause: a string literal was assigned to a number.' : 'Done.')));
    const p = project({});
    const r = await run({ model: 'tsfix', project: p });
    assert.strictEqual(r.outcome, 'completed', show(r));
    assert.strictEqual(p.read('src/a.ts'), CLEAN);
    assert.strictEqual(r.hidden.length, 1, 'one fix attempt');
    const prompt = r.hidden[0].content;
    assert.ok(prompt.includes('attempt 1/3') && prompt.includes('TS2322') && prompt.includes("'BUG'") && prompt.includes('Root cause:'), prompt);
    assert.strictEqual(r.checks[0], 'npm run typecheck');
    assert.deepStrictEqual(r.checks.slice(-2), ['npm run typecheck', 'npm test'], 'rebuilt, then the regression suite');
    assert.deepStrictEqual(r.state?.attempts.map((a) => [a.category, a.result]), [['typescript', 'fixed']]);
    assert.match(r.state?.attempts[0].rootCause ?? '', /string literal/);
    assert.strictEqual(r.end?.contract?.compilationPassed, 'passed');
    assert.strictEqual(r.end?.contract?.regressionChecksPassed, 'passed');
    assert.ok(r.cards.some((c) => c.attempt === 1 && c.max === 3), 'the card shows attempt 1/3');
    const ts = p.runs().filter((x) => x.kind === 'typecheck' && x.status !== 'start').map((x) => x.status);
    assert.deepStrictEqual(ts, ['fail', 'pass']);
    const mem = (await r.h.memory.list()).filter((e) => e.success);
    assert.ok(mem.length === 1 && mem[0].category === 'typescript' && mem[0].code === 'TS2322', JSON.stringify(mem));
    for (const a of ['detected', 'fix_attempt', 'validated', 'recovered'] as const) {
      assert.ok(recoveryActions(r, 'typescript').includes(a), `telemetry ${a}: ${recoveryActions(r).join(',')}`);
    }
    const d = dashboard(r);
    assert.ok(d.recovered >= 1 && d.rate > 0, JSON.stringify(d));
  });

  test('unit test failure: the jest failure is analysed, the implementation fixed, the test file untouched', async () => {
    lab.scripts.set('unit', (t) => (t.n === 1 ? write('src/sum.ts', SUM_BAD) : t.fix ? write('src/sum.ts', SUM_OK) : say(t.fixes ? 'Root cause: the refactor turned the addition into a subtraction.' : 'Refactored sum.')));
    const p = project({ 'src/sum.ts': SUM_OK, 'src/sum.test.ts': SUM_TEST });
    const r = await run({ model: 'unit', project: p, prompt: 'Refactor src/sum.ts.' });
    assert.strictEqual(r.outcome, 'completed', show(r));
    assert.strictEqual(p.read('src/sum.ts'), SUM_OK);
    assert.strictEqual(p.read('src/sum.test.ts'), SUM_TEST, 'the test was not edited to pass');
    assert.ok(!r.writes.includes('src/sum.test.ts'));
    assert.deepStrictEqual(r.state?.attempts.map((a) => [a.category, a.result]), [['unit_test', 'fixed']]);
    assert.match(r.hidden[0]?.content ?? '', /sum › adds/);
    assert.strictEqual(r.end?.contract?.testsPassed, 'passed');
    const tests = p.runs().filter((x) => x.kind === 'test' && x.status !== 'start').map((x) => x.status);
    assert.strictEqual(tests[0], 'fail');
    assert.strictEqual(tests[tests.length - 1], 'pass');
  });

  test('integration test failure (contract mismatch): dependent modules in the evidence, at most 2 diagnostic attempts, fixed on the second', async () => {
    lab.scripts.set('integ', (t) => {
      if (t.n === 1) {
        return write('server.ts', server('/user'));
      }
      if (t.fix) {
        return write('server.ts', server(t.fixes === 1 ? '/userz' : '/users'));
      }
      return say(!t.fixes ? 'Renamed the users route.' : t.fixes === 1 ? 'Root cause: the route table and the client disagree.' : 'Root cause: api/routes.ts still requests /users, so the server must serve /users.');
    });
    const p = project({ 'server.ts': server('/users'), 'api/routes.ts': ROUTES_TS, 'api/routes.integration.test.ts': "import { getUsers } from './routes';\n\ntest('GET /users', () => expect(getUsers()).toBe(200));\n" });
    const r = await run({ model: 'integ', project: p, prompt: 'Rename the users route in server.ts.' });
    assert.strictEqual(r.outcome, 'completed', show(r));
    assert.deepStrictEqual(r.state?.attempts.map((a) => [a.category, a.result]), [['integration_test', 'not_fixed'], ['integration_test', 'fixed']]);
    const [first, second] = r.hidden.map((m) => m.content);
    assert.ok(first.includes('attempt 1/2') && first.includes('integration_test'), first);
    assert.match(first, /Related files \(imports\/importers\):[\s\S]*(api\/routes\.ts|server\.ts)/, 'repoGraph neighbours of the failing module');
    assert.ok(second.includes('attempt 2/2') && /did not change this error/.test(second), second);
    assert.strictEqual(p.read('server.ts'), server('/users'));
    assert.strictEqual(p.read('api/routes.ts'), ROUTES_TS, 'the dependent module was not bent to the rename');
  });

  const depProject = () =>
    project(
      {
        'vendor/left-pad/package.json': `${JSON.stringify({ name: 'left-pad', version: '1.3.0', main: 'index.js' }, null, 2)}\n`,
        'vendor/left-pad/index.js': "module.exports = (s, n, c = ' ') => String(s).padStart(n, c);\n",
        'src/pad.test.js': "const pad = require('./pad');\n\ntest('pads', () => expect(pad('ab')).toBe('   ab'));\n",
      },
      { dependencies: { 'left-pad': 'file:./vendor/left-pad' } },
    );
  const PAD = "const leftPad = require('left-pad');\n\nmodule.exports = (s) => leftPad(s, 5);\n";

  test('missing dependency, approved: one mandatory install prompt even with terminal commands auto-approved, then the checks pass', async () => {
    lab.scripts.set('dep', (t) => (t.n === 1 ? write('src/pad.js', PAD) : say('Added pad().')));
    const p = depProject();
    const r = await run({ model: 'dep', project: p, prompt: 'Add a pad helper using left-pad.', approve: () => true });
    assert.strictEqual(r.prompts.length, 1, JSON.stringify(r.prompts));
    assert.ok(r.prompts[0].mandatory && r.prompts[0].kind === 'terminal' && /npm install/.test(`${r.prompts[0].title}\n${r.prompts[0].detail}`), JSON.stringify(r.prompts[0]));
    assert.strictEqual(r.outcome, 'completed', show(r));
    assert.ok(p.exists('node_modules/left-pad/package.json'), 'installed');
    assert.deepStrictEqual(r.state?.attempts.map((a) => [a.category, a.strategy, a.result]), [['dependency', 'install', 'fixed']]);
    assert.strictEqual(r.state?.pendingAction?.status, 'done');
    assert.deepStrictEqual(p.runs().filter((x) => x.kind === 'test' && x.status !== 'start').map((x) => x.status), ['fail', 'pass']);
  });

  test('missing dependency, denied: blocked with an approval_needed intervention, nothing installed', async () => {
    lab.scripts.set('dep-no', (t) => (t.n === 1 ? write('src/pad.js', PAD) : say('Added pad().')));
    const p = depProject();
    const r = await run({ model: 'dep-no', project: p, prompt: 'Add a pad helper using left-pad.', approve: () => false });
    assert.strictEqual(r.prompts.filter((x) => x.mandatory).length, 1, 'asked once');
    assert.strictEqual(r.outcome, 'blocked', show(r));
    assert.strictEqual(r.state?.intervention?.reason, 'approval_needed');
    assert.strictEqual(r.state?.pendingAction?.status, 'declined');
    assert.ok(!p.exists('node_modules/left-pad'));
    assert.ok(recoveryActions(r).includes('blocked'), recoveryActions(r).join(','));
  });

  test('infinite agent loop: stopped by the iteration budget plus the granted recovery steps, outcome incomplete (loop)', async () => {
    await cfg().update('healing.extraSteps', 3, vscode.ConfigurationTarget.Global);
    try {
      lab.scripts.set('looper', (t) => (t.n === 1 ? write('src/a.ts', BUGGY) : t.n === 2 ? say('Done.') : call('read_file', { path: 'src/a.ts', offset: t.n })));
      const r = await run({ model: 'looper', project: project({}), maxIterations: 4, h: harness({ heal: { extraSteps: 3 } }) });
      const calls = lab.count('looper');
      await sleep(300);
      assert.ok(calls > 4 && calls <= 7, `stopped within maxIterations + extraSteps (${calls})`);
      assert.strictEqual(lab.count('looper'), calls, 'no model call after the stop');
      assert.strictEqual(r.outcome, 'incomplete', show(r));
      assert.strictEqual(r.state?.intervention?.reason, 'loop');
      assert.match(r.text, /Stopped after 4 model steps \+ \d recovery steps/);
    } finally {
      await cfg().update('healing.extraSteps', 16, vscode.ConfigurationTarget.Global);
    }
  });

  test('repeated same failure: the duplicate signature is named in the second prompt and escalated before the attempt budget', async () => {
    let tries = 0;
    lab.scripts.set('stubborn', (t) => (t.n === 1 ? write('src/a.ts', BUGGY) : t.fix ? write('src/a.ts', `// try ${++tries}\n${BUGGY}`) : say(t.fixes ? 'Root cause: the cast.' : 'Done.')));
    const r = await run({ model: 'stubborn', project: project({}) });
    assert.strictEqual(r.hidden.length, 2, show(r));
    assert.match(r.hidden[1].content, /did not change this error/);
    assert.strictEqual(r.outcome, 'incomplete', show(r));
    assert.strictEqual(r.state?.intervention?.reason, 'duplicate');
    assert.strictEqual(r.state?.attempts.length, 2, 'stopped before the third of 3 attempts');
    const sig = r.state!.attempts[0].signature;
    assert.ok(r.state!.attempts.every((a) => a.signature === sig), 'one signature throughout');
    assert.ok(r.state!.seen[sig]?.count >= 3, JSON.stringify(r.state!.seen));
    assert.ok(recoveryActions(r).some((a) => a === 'duplicate' || a === 'escalated'), recoveryActions(r).join(','));

    lab.scripts.set('talker', (t) => (t.n === 1 ? write('src/a.ts', BUGGY) : say(t.fixes ? 'Root cause: the literal is a string.' : 'Done.')));
    const q = await run({ model: 'talker', project: project({}) });
    assert.strictEqual(q.checks.length, 1, `a reply without an edit reruns no check: ${show(q)}`);
    assert.strictEqual(q.state?.attempts[0]?.result, 'not_fixed');
    assert.strictEqual(q.hidden.length, 2);
    assert.strictEqual(q.state?.intervention?.reason, 'duplicate');
    assert.strictEqual(q.outcome, 'incomplete');
  });

  test('VS Code restart mid-validation: interrupted is persisted, a new store finds it, the resume reruns the checks first and completes without re-editing', async () => {
    lab.scripts.set('restart', (t) => (t.n === 1 ? write('src/a.ts', BUGGY) : t.fix ? write('src/a.ts', CLEAN) : say(t.fixes ? 'Root cause: a string was assigned to a number.' : 'Done.')));
    const storeDir = tmp('lp-fi-restart-');
    const p = project({});
    fs.writeFileSync(p.hangFile, '');
    const first = harness({ storeDir });
    const controller = new AbortController();
    const pending = run({ model: 'restart', project: p, h: first, controller });
    await waitFor('the validation check to hang', () => fs.existsSync(p.pidFile) && !!fs.readFileSync(p.pidFile, 'utf8').trim(), 120_000);
    const pid = Number(fs.readFileSync(p.pidFile, 'utf8').trim());
    controller.abort('shutdown');
    const r1 = await pending;
    await waitFor('the hanging check to be killed', () => !alive(pid), 15_000);
    assert.strictEqual(r1.state?.phase, 'interrupted', show(r1));
    assert.deepStrictEqual(r1.writes, ['src/a.ts', 'src/a.ts'], 'the edit and the fix were made before the restart');
    await first.store.flush();
    await first.store.dispose();
    fs.rmSync(p.hangFile);

    const second = harness({ storeDir });
    const found = await second.svc.scanUnfinished();
    assert.ok(found.some((u) => u.sid === r1.sid && u.phase === 'interrupted'), JSON.stringify(found));
    const info = second.svc.resumeInfo(r1.sid);
    assert.ok(info?.phase === 'interrupted' && info.attempt === 1 && info.category === 'typescript', JSON.stringify(info));
    const before = lab.hits.length;
    const resumedAt = Date.now();
    const r2 = await run({ model: 'restart', project: p, h: second, session: r1.session, resume: true });
    assert.strictEqual(r2.outcome, 'completed', show(r2));
    assert.deepStrictEqual(r2.writes, [], 'no edit was repeated');
    assert.strictEqual(p.read('src/a.ts'), CLEAN);
    const firstCheck = p.runs().find((x) => x.t >= resumedAt && x.status === 'start');
    assert.ok(firstCheck, 'the checks reran');
    assert.ok(!lab.hits.slice(before).some((x) => x.model === 'restart' && x.at < firstCheck!.t), 'no model request before the checks');
    assert.deepStrictEqual(r2.state?.attempts.map((a) => [a.n, a.category, a.result]), [[1, 'typescript', 'fixed']], 'the attempt counter carried on');
    assert.ok(recoveryActions(r2).includes('resumed'), recoveryActions(r2).join(','));
    await second.store.dispose();
  });

  test('git conflict: escalated at once, the user\'s conflicted file is byte-identical, blocked with Open merge editor', async () => {
    const p = project({ 'a.ts': 'export const greeting = "hello";\n' });
    git(p.root, 'init -q -b main');
    git(p.root, 'add -A');
    git(p.root, 'commit -q -m base');
    git(p.root, 'checkout -q -b feature');
    fs.writeFileSync(path.join(p.root, 'a.ts'), 'export const greeting = "hello from feature";\n');
    git(p.root, 'commit -q -am feature');
    git(p.root, 'checkout -q main');
    fs.writeFileSync(path.join(p.root, 'a.ts'), 'export const greeting = "hello from main";\n');
    git(p.root, 'commit -q -am main');
    try {
      git(p.root, 'merge feature');
    } catch {
      // exits 1 on the conflict, which is the point
    }
    const before = p.read('a.ts');
    assert.ok(before.includes('<<<<<<<'), 'the project is mid-merge');
    lab.scripts.set('merger', (t) => (t.n === 1 ? call('run_command', { command: 'git status --porcelain' }) : write('a.ts', 'export const greeting = "resolved by the model";\n')));
    const r = await run({ model: 'merger', project: p, prompt: 'Finish the merge.' });
    assert.strictEqual(r.outcome, 'blocked', show(r));
    assert.strictEqual(lab.count('merger'), 1, 'no model call after the conflict was detected');
    assert.strictEqual(p.read('a.ts'), before, 'the user\'s content is untouched');
    assert.deepStrictEqual(r.writes, []);
    assert.strictEqual(r.state?.intervention?.reason, 'git_conflict');
    assert.ok(r.state!.intervention!.nextActions.some((a) => a.action === 'openMergeEditor'), JSON.stringify(r.state!.intervention!.nextActions));
    assert.ok(!r.hidden.length, 'no fix prompt: conflicts are never auto-resolved');
  });

  test('security vulnerability: a hard-coded key blocks completion; the model cannot accept the risk; completed once remediated', async () => {
    lab.scripts.set('leaker', (t) => {
      if (t.n === 1) {
        return write('src/keys.ts', `export const KEY = '${KEY}';\n`);
      }
      if (t.fix && t.fixes === 1) {
        return say('Accept risk: it is only a test key, mark the finding accepted.');
      }
      if (t.fix) {
        return write('src/keys.ts', "export const KEY = process.env.AWS_ACCESS_KEY_ID ?? '';\n");
      }
      return say(t.fixes ? 'Root cause: a credential was hard-coded.' : 'Done.');
    });
    const p = project({});
    const r = await run({ model: 'leaker', project: p });
    assert.strictEqual(r.hidden.length, 2, show(r));
    assert.ok(r.hidden.every((m) => m.meta?.healing?.category === 'security'), JSON.stringify(r.hidden.map((m) => m.meta?.healing)));
    assert.deepStrictEqual(r.state?.attempts.map((a) => [a.category, a.result]), [['security', 'not_fixed'], ['security', 'fixed']], 'the "accept the risk" reply changed nothing');
    assert.strictEqual(r.outcome, 'completed', show(r));
    assert.strictEqual(r.end?.contract?.securityChecksPassed, 'passed');
    assert.deepStrictEqual(r.state?.acceptedRisks, []);
    assert.ok(!p.read('src/keys.ts').includes(KEY));
  });

  test('security vulnerability left in place: blocked, security check failed, Accept risk offered to the user only', async () => {
    lab.scripts.set('keeper', (t) => (t.n === 1 ? write('src/keys.ts', `export const KEY = '${KEY}';\n`) : say(t.fixes ? 'Root cause: the key is intentional. I accept the risk.' : 'Done.')));
    const p = project({});
    const r = await run({ model: 'keeper', project: p, h: harness({ heal: { policies: { security: { attempts: 1 } } } }) });
    assert.strictEqual(r.outcome, 'blocked', show(r));
    assert.strictEqual(r.state?.intervention?.reason, 'security');
    assert.strictEqual(r.state?.contract?.securityChecksPassed, 'failed');
    assert.ok(r.state!.intervention!.nextActions.some((a) => a.action === 'acceptRisk'));
    assert.deepStrictEqual(r.state?.acceptedRisks, [], 'nothing was waived');
    assert.ok(p.read('src/keys.ts').includes(KEY), 'the engine did not rewrite the user-visible finding itself');
    assert.ok(r.state!.active.some((f) => f.category === 'security'), 'the finding stays unresolved');
  });

  test('all retries exhausted: three attempts, incomplete, the report gives the root cause, what was tried and the next action', async () => {
    const names = ['alpha', 'beta', 'gamma', 'delta'];
    let i = 0;
    const bad = () => `// BUG_${names[i++]}\nexport const sum = (a: number, b: number): number => a + b + 1;\n`;
    lab.scripts.set('hopeless', (t) => (t.n === 1 || t.fix ? write('src/sum.ts', bad()) : say(t.fixes ? 'Root cause: sum adds one too many.' : 'Done.')));
    const p = project({ 'src/sum.ts': SUM_OK, 'src/sum.test.ts': SUM_TEST });
    const r = await run({ model: 'hopeless', project: p });
    assert.strictEqual(r.hidden.length, 3, show(r));
    assert.strictEqual(r.state?.attempts.length, 3);
    assert.ok(r.state!.attempts.every((a) => a.category === 'unit_test' && a.result !== 'fixed'), JSON.stringify(r.state!.attempts.map((a) => a.result)));
    assert.strictEqual(r.outcome, 'incomplete', show(r));
    assert.strictEqual(r.state?.intervention?.reason, 'exhausted');
    assert.strictEqual(r.end?.contract?.testsPassed, 'failed');
    assert.match(r.text, /Incomplete/);
    assert.match(r.text, /Root cause: .*sum adds one too many/);
    assert.match(r.text, /Tried: /);
    assert.match(r.text, /Next: /);
    assert.ok(r.state!.intervention!.nextActions.length > 0);
    assert.ok(recoveryActions(r).includes('exhausted'), recoveryActions(r).join(','));
    const d = dashboard(r);
    assert.ok(d.exhausted >= 1 && d.recovered === 0, JSON.stringify(d));
  });
});
