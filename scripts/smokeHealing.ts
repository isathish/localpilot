/**
 * Smoke checks for the self-healing engine inside the agent loop (bundled into scripts/smoke.ts; design §12): scripted
 * OpenAI-compatible models fail on command (closed socket, stalls, OOM 500s, broken tool-call JSON) and edit temp npm
 * workspaces whose `typecheck`/`test`/`lint` scripts print real-format tsc/jest/eslint output; checks run through the
 * real `run_command`. Clock, backoff sleep, health probe and MCP restart are injected, so nothing waits for real.
 *   node scripts/healing/run.js scripts/smokeHealing.ts healingSmoke
 */
import * as cp from 'child_process';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { AgentRunner } from '../src/agent/agentLoop';
import { discoverChecks } from '../src/agent/healing/checks';
import { HealingService } from '../src/agent/healing/engine';
import { effectivePolicies } from '../src/agent/healing/policy';
import { FailureMemory } from '../src/agent/healing/failureMemory';
import { changedFilesScan } from '../src/agent/healing/hostAdapters';
import { RecoveryStore } from '../src/agent/healing/recoveryStore';
import { CheckSemaphore, RecoveryBus } from '../src/agent/healing/scheduler';
import type { CheckSpec, CompletionContract, RecoveryEventPayload, RecoverySummary, TaskOutcome } from '../src/agent/healing/types';
import { resetManagedPolicyCache } from '../src/agent/managedPolicy';
import { emptySettings, type ProjectSettings } from '../src/agent/settings';
import { SkillManager } from '../src/agent/skills';
import { restoreFile } from '../src/cli/healing';
import { getConfig } from '../src/config';
import { WorkspaceContext } from '../src/context/workspaceContext';
import { OpenAICompatProvider } from '../src/providers/openaiCompat';
import { ProviderRegistry } from '../src/providers/registry';
import type { TelemetryInput } from '../src/telemetry/telemetry';
import { runningCommands } from '../src/terminal/commandRun';
import { ToolRegistry } from '../src/tools/registry';
import { runCommandTool } from '../src/tools/terminal';
import type { AgentEvent, ChatMessage, Session, Tool, ToolContext } from '../src/types';

type Check = (name: string, cond: boolean, detail?: unknown) => void;

declare const REPO_ROOT: string;

/** Fixture outputs (scripts/healing/fixtures), resolved from the repo root: `REPO_ROOT` when the runner defines it, else the bundle in out/. */
function fixturesDir(): string {
  const root = typeof REPO_ROOT === 'string' ? REPO_ROOT : path.resolve(__dirname, '..');
  return path.join(root, 'scripts', 'healing', 'fixtures', 'classifier');
}

// ---------------------------------------------------------------- scripted models

interface WireMessage {
  role: string;
  content?: string | null;
  tool_calls?: { function: { name: string; arguments: string } }[];
}

interface Turn {
  /** 1-based request count of this model. */
  n: number;
  messages: WireMessage[];
  tools: string[];
  last: WireMessage | undefined;
  /** The engine's hidden fix prompt, when it is the latest message. */
  fix?: string;
  /** All fix prompts in this request. */
  fixes: string[];
}

interface Reply {
  text?: string;
  calls?: { name: string; args: unknown }[];
  /** Raw arguments string for the first call (malformed JSON). */
  rawArgs?: string;
  finish?: string;
  status?: number;
  body?: string;
  /** Never answer (no first token): the watchdog has to call it a stall. */
  hang?: boolean;
}

type Script = (t: Turn) => Reply | Promise<Reply>;

interface ModelDef {
  id: string;
  script: Script;
  /** False: text-protocol model (no native tools). */
  tools?: boolean;
  /** Listed under /cloud/v1 (a provider configured with `cloud: true`). */
  cloud?: boolean;
}

const FIX_HEAD = '[LocalPilot self-healing';
const text = (m: WireMessage | undefined) => (typeof m?.content === 'string' ? m.content : '');
const call = (name: string, args: unknown): Reply => ({ calls: [{ name, args }] });
const say = (t: string): Reply => ({ text: t });
const write = (p: string, content: string) => call('write_file', { path: p, content });

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((r) => {
    let b = '';
    req.on('data', (d) => (b += d));
    req.on('end', () => r(b));
  });
}

/** One scripted OpenAI-compatible server (plus a `cloud` provider under /cloud/v1) and the provider registry over it. */
class Lab {
  readonly models = new Map<string, ModelDef>();
  readonly counts = new Map<string, number>();
  readonly bodies = new Map<string, Turn[]>();
  url = '';
  port = 0;
  private srv?: http.Server;
  /** Called after a model listing was answered (scenario 1 closes the socket there). */
  afterList?: () => void;

  add(...defs: ModelDef[]): void {
    for (const d of defs) {
      this.models.set(d.id, d);
    }
  }

  requests(id: string): number {
    return this.counts.get(id) ?? 0;
  }

  /** Provider settings for runs against this lab. */
  providerConfig(): Record<string, unknown> {
    const out: Record<string, unknown>[] = [{ id: 'mock', type: 'openai', baseUrl: `${this.url}/v1` }];
    if ([...this.models.values()].some((m) => m.cloud)) {
      out.push({ id: 'cloud', type: 'openai', baseUrl: `${this.url}/cloud/v1`, cloud: true, apiKey: 'sk-smoke' });
    }
    return { providers: out };
  }

  private handler = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    const cloud = req.url?.startsWith('/cloud/') ?? false;
    const url = cloud ? req.url!.slice('/cloud'.length) : req.url;
    if (url === '/v1/models') {
      const data = [...this.models.values()].filter((m) => !!m.cloud === cloud).map((m) => ({ id: m.id, capabilities: m.tools === false ? ['completion'] : ['tool_use'] }));
      res.end(JSON.stringify({ data }), () => this.afterList?.());
      return;
    }
    if (url !== '/v1/chat/completions') {
      res.statusCode = 404;
      res.end();
      return;
    }
    const body = JSON.parse(await readBody(req)) as { model: string; messages: WireMessage[]; tools?: { function: { name: string } }[] };
    const def = this.models.get(body.model);
    if (!def) {
      res.statusCode = 404;
      res.end(JSON.stringify({ error: { message: `model ${body.model} not found` } }));
      return;
    }
    const n = (this.counts.get(def.id) ?? 0) + 1;
    this.counts.set(def.id, n);
    const last = body.messages[body.messages.length - 1];
    const fixes = body.messages.filter((m) => m.role === 'user' && text(m).startsWith(FIX_HEAD)).map(text);
    const turn: Turn = { n, messages: body.messages, tools: (body.tools ?? []).map((t) => t.function.name), last, fixes, ...(last?.role === 'user' && text(last).startsWith(FIX_HEAD) ? { fix: text(last) } : {}) };
    this.bodies.set(def.id, [...(this.bodies.get(def.id) ?? []), turn]);
    const r = await def.script(turn);
    if (r.hang) {
      // Hold the request open without a byte; the client's watchdog aborts it.
      req.on('close', () => res.destroy());
      return;
    }
    if (r.status) {
      res.statusCode = r.status;
      res.setHeader('content-type', 'application/json');
      res.end(r.body ?? JSON.stringify({ error: { message: 'error' } }));
      return;
    }
    res.setHeader('content-type', 'text/event-stream');
    const send = (o: unknown) => res.write(`data: ${JSON.stringify(o)}\n\n`);
    if (r.text) {
      send({ choices: [{ delta: { content: r.text } }] });
    }
    (r.calls ?? []).forEach((c, i) => {
      const args = i === 0 && r.rawArgs !== undefined ? r.rawArgs : JSON.stringify(c.args);
      send({ choices: [{ delta: { tool_calls: [{ index: i, id: `${def.id}-${n}-${i}`, function: { name: c.name, arguments: args } }] } }] });
    });
    send({ choices: [{ delta: {}, finish_reason: r.finish ?? (r.calls?.length ? 'tool_calls' : 'stop') }], usage: { prompt_tokens: 100, completion_tokens: 10 } });
    res.write('data: [DONE]\n\n');
    res.end();
  };

  async start(port = 0): Promise<void> {
    await this.listen(port);
    this.url = `http://127.0.0.1:${this.port}`;
  }

  /** (Re)opens the listening socket, on the same port when one was used before. */
  async listen(port = this.port): Promise<void> {
    const srv = http.createServer((req, res) => void this.handler(req, res));
    await new Promise<void>((resolve, reject) => {
      srv.once('error', reject);
      srv.listen(port, '127.0.0.1', () => resolve());
    });
    this.srv = srv;
    this.port = (srv.address() as { port: number }).port;
  }

  /** Closes the socket: connections are refused until `listen()` again. */
  async shut(): Promise<void> {
    const srv = this.srv;
    this.srv = undefined;
    if (srv) {
      srv.closeAllConnections();
      await new Promise<void>((r) => srv.close(() => r()));
    }
  }

  async dispose(): Promise<void> {
    await this.shut();
  }
}

// ---------------------------------------------------------------- workspaces with scripted toolchains

const temps: string[] = [];
function tmp(prefix: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temps.push(d);
  return d;
}

/**
 * The fake toolchain: `node check.js <kind>` prints real-format output derived from file contents.
 * typecheck: `BUG` in src/a.ts -> TS2322; `WORSE` -> two new errors; `OLD` in src/old.ts -> TS2322 there; `CORRUPT` -> the
 * sqlite fixture; `NOISY` -> 30k characters of noise around the error; `SLOW` -> never ends (pid written to `pidFile`).
 * test: `BUG<suffix>` in src/sum.ts -> a failing jest test named after the suffix. lint: `LINT` in src/old.ts -> eslint unix.
 */
function checkScript(pidFile: string): string {
  return `const fs = require('fs');
const path = require('path');
const kind = process.argv[2];
const read = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } };
const a = read('src/a.ts');
if (kind === 'typecheck') {
  if (a.includes('SLOW')) {
    fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
    setInterval(() => {}, 1000);
    return;
  }
  if (a.includes('CORRUPT')) {
    process.stdout.write(fs.readFileSync(${JSON.stringify(path.join(fixturesDir(), 'sqlite-malformed.txt'))}, 'utf8'));
    process.exit(1);
  }
  const out = [];
  if (a.includes('BUG')) out.push("src/a.ts(1,14): error TS2322: Type 'string' is not assignable to type 'number'.");
  if (a.includes('WORSE')) out.push("src/a.ts(2,3): error TS2304: Cannot find name 'worse'.", "src/a.ts(3,3): error TS2551: Property 'lenght' does not exist on type 'string'.");
  if (read('src/old.ts').includes('OLD')) out.push("src/old.ts(4,1): error TS2322: Type 'boolean' is not assignable to type 'string'.");
  if (a.includes('NOISY')) {
    const noise = (tag) => Array.from({ length: 600 }, (_, i) => '  [' + tag + '] compiled module ' + i + ' of 600 without diagnostics').join('\\n');
    out.unshift(noise('pre'));
    out.push(noise('post'));
  }
  if (out.length) { console.log(out.join('\\n')); process.exit(2); }
  console.log('typecheck ok');
} else if (kind === 'test') {
  const m = /BUG(\\w*)/.exec(read('src/sum.ts'));
  if (m) {
    const name = 'sum › adds' + (m[1] ? ' ' + m[1].replace(/^_/, '') : '');
    console.log([' FAIL  src/sum.test.ts', '  ● ' + name, '', '    expect(received).toBe(expected) // Object.is equality', '', '    Expected: 3', '    Received: 4', '', '      at Object.<anonymous> (src/sum.test.ts:7:23)', '', 'Tests:       1 failed, 1 total'].join('\\n'));
    process.exit(1);
  }
  console.log('Tests:       1 passed, 1 total');
} else if (kind === 'lint') {
  if (read('src/old.ts').includes('LINT')) {
    console.log(path.join(process.cwd(), 'src/old.ts') + ":3:7: 'x' is defined but never used. [Error/no-unused-vars]\\n\\n1 problem");
    process.exit(1);
  }
}
`;
}

interface Workspace {
  root: string;
  pidFile: string;
  read(rel: string): string;
  write(rel: string, body: string): void;
}

function workspace(files: Record<string, string> = {}, scripts: Record<string, string> = { typecheck: 'node check.js typecheck', test: 'node check.js test' }): Workspace {
  const root = tmp('lp-heal-ws-');
  const pidFile = path.join(tmp('lp-heal-pid-'), 'slow.pid');
  const all: Record<string, string> = {
    'package.json': `${JSON.stringify({ name: 'demo', version: '1.0.0', private: true, scripts }, null, 2)}\n`,
    'check.js': checkScript(pidFile),
    'src/a.ts': 'export const a: number = 1;\n',
    'src/sum.ts': 'export const sum = (x: number, y: number) => x + y;\n',
    ...files,
  };
  const ws: Workspace = {
    root,
    pidFile,
    read: (rel) => fs.readFileSync(path.join(root, rel), 'utf8'),
    write: (rel, body) => {
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      fs.writeFileSync(path.join(root, rel), body);
    },
  };
  for (const [rel, body] of Object.entries(all)) {
    ws.write(rel, body);
  }
  return ws;
}

/** Edit tools over the real file system: snapshot through `trackChange` (the engine's patch scope), then write. */
function fileTools(executed: Map<string, number>): Tool[] {
  const schema = (props: Record<string, string>, required: string[]) => ({ type: 'object' as const, properties: Object.fromEntries(Object.entries(props).map(([k, t]) => [k, { type: t }])), required });
  const resolve = (ctx: ToolContext, p: unknown) => path.resolve(ctx.workspaceRoot ?? process.cwd(), String(p ?? ''));
  const bump = (name: string) => executed.set(name, (executed.get(name) ?? 0) + 1);
  return [
    {
      parallelSafe: true,
      readOnly: true,
      definition: { name: 'read_file', description: 'Read a file', parameters: schema({ path: 'string', offset: 'integer' }, ['path']) },
      async execute(a, ctx) {
        bump('read_file');
        try {
          return { content: fs.readFileSync(resolve(ctx, a.path), 'utf8') };
        } catch {
          return { content: `File not found: ${a.path}`, isError: true };
        }
      },
    },
    {
      approvalKind: 'write',
      definition: { name: 'write_file', description: 'Create or overwrite a file', parameters: schema({ path: 'string', content: 'string' }, ['path', 'content']) },
      async execute(a, ctx) {
        bump('write_file');
        const file = resolve(ctx, a.path);
        await ctx.trackChange(file);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, String(a.content ?? ''));
        return { content: `WROTE:${a.path}`, data: { path: file, kind: 'update' } };
      },
    },
  ];
}

/** MCP tools of a fake `github` server: `search_issues` is not connected until restarted; `create_issue` always times out. */
function mcpTools(executed: Map<string, number>, state: { connected: boolean }): Tool[] {
  const schema = { type: 'object' as const, properties: { q: { type: 'string' } } };
  const bump = (name: string) => executed.set(name, (executed.get(name) ?? 0) + 1);
  return [
    {
      parallelSafe: true,
      definition: { name: 'mcp_github__search_issues', description: 'Search GitHub issues (MCP)', parameters: schema },
      async execute() {
        bump('mcp_github__search_issues');
        return state.connected ? { content: 'Found 3 issues: #1 #2 #3' } : { content: 'MCP server "github": Not connected', isError: true };
      },
    },
    {
      definition: { name: 'mcp_github__create_issue', description: 'Create a GitHub issue (MCP)', parameters: schema },
      async execute() {
        bump('mcp_github__create_issue');
        return { content: 'MCP error: request timed out after 30s', isError: true };
      },
    },
  ];
}

// ---------------------------------------------------------------- one run through AgentRunner + HealingService

interface Prompt {
  title: string;
  kind: string;
  mandatory: boolean;
}

interface Clock {
  offset: number;
}

interface RunOpts {
  sid: string;
  model: string;
  ws: Workspace;
  prompt?: string;
  mode?: Session['mode'];
  /** `localpilot.*` overrides for this run (LP_CONFIG). */
  cfg?: Record<string, unknown>;
  toolFilter?: string[];
  maxIterations?: number;
  firstTokenTimeoutMs?: number;
  settings?: ProjectSettings;
  approve?: (p: Prompt) => boolean;
  clock?: Clock;
  probe?: (target: string) => Promise<boolean>;
  mcpRestart?: (server: string) => Promise<unknown>;
  /** Adjusts the discovered checks (a test seam: e.g. a 2 s timeout). */
  tweak?: (s: CheckSpec) => CheckSpec;
  extraTools?: Tool[];
}

interface TurnEnd {
  text: string;
  completed: boolean;
  outcome?: TaskOutcome;
  contract?: CompletionContract;
  recovery?: RecoverySummary;
}

interface RunResult {
  text: string;
  error?: unknown;
  ms: number;
  events: AgentEvent[];
  session: Session;
  end?: TurnEnd;
  prompts: Prompt[];
  tele: TelemetryInput[];
  sleeps: number[];
  probes: string[];
  store: RecoveryStore;
  memory: FailureMemory;
  executed: Map<string, number>;
  /** Commands of the engine's synthetic run_command calls, in order. */
  checks: string[];
  checkEnds: { content: string; isError: boolean; data?: unknown }[];
  /** The hidden fix prompts pushed into the transcript. */
  hidden: ChatMessage[];
  recovery: RecoveryEventPayload[];
  reason?: string;
}

const log = {
  info() {},
  warn(m: string) {
    if (process.env.LP_SMOKE_DEBUG) {
      console.log(`    [warn] ${m}`);
    }
  },
  error(m: string) {
    if (process.env.LP_SMOKE_DEBUG) {
      console.log(`    [error] ${m}`);
    }
  },
  debug() {},
  trace() {},
} as unknown as import('vscode').LogOutputChannel;

const BASE_CFG: Record<string, unknown> = { 'healing.baseline': 'off', 'healing.delegateFixes': false };

type ServiceOpts = Pick<RunOpts, 'clock' | 'probe' | 'mcpRestart' | 'tweak'>;

interface ServiceHarness {
  svc: HealingService;
  store: RecoveryStore;
  memory: FailureMemory;
  tele: TelemetryInput[];
  sleeps: number[];
  probes: string[];
}

/** The service as the extension and the CLI wire it, with the clock, backoff sleep, probe and MCP restart injected. */
function service(o: ServiceOpts): ServiceHarness {
  const clock = o.clock ?? { offset: 0 };
  const now = () => Date.now() + clock.offset;
  const h: Omit<ServiceHarness, 'svc'> = {
    store: new RecoveryStore(tmp('lp-heal-store-'), { owner: { kind: 'cli' }, now }),
    memory: new FailureMemory(path.join(tmp('lp-heal-mem-'), 'memory.json'), { now }),
    tele: [],
    sleeps: [],
    probes: [],
  };
  const svc = new HealingService({
    store: h.store,
    memory: () => h.memory,
    config: () => getConfig().healing,
    telemetry: { record: (e) => h.tele.push(e) },
    log: { info: () => undefined, warn: (m) => log.warn(m) },
    bus: new RecoveryBus(),
    semaphore: new CheckSemaphore(1),
    discover: async (root, d) => {
      const found = await discoverChecks(root, d);
      if (o.tweak) {
        found.forEach((s, i) => (found[i] = o.tweak!(s)));
      }
      return found;
    },
    isTrusted: () => true,
    securityScan: changedFilesScan(),
    probe: async (target) => {
      h.probes.push(target);
      return o.probe ? o.probe(target) : true;
    },
    mcpRestart: o.mcpRestart,
    restoreFile,
    now,
    sleep: async (ms) => {
      h.sleeps.push(ms);
      clock.offset += ms;
    },
    random: () => 0.5,
    owner: 'cli',
  });
  return { svc, ...h };
}

async function run(lab: Lab, o: RunOpts): Promise<RunResult> {
  const prevCfg = process.env.LP_CONFIG;
  process.env.LP_CONFIG = JSON.stringify({ ...BASE_CFG, ...lab.providerConfig(), ...(o.cfg ?? {}) });
  const { svc, store, memory, tele, sleeps, probes } = service(o);
  const prompts: Prompt[] = [];
  const events: AgentEvent[] = [];
  const executed = new Map<string, number>();
  const providers = new ProviderRegistry(log);
  const tools = new ToolRegistry();
  tools.registerAll([...fileTools(executed), runCommandTool, ...(o.extraTools ?? [])]);
  const runner = new AgentRunner(providers, tools, new SkillManager(log), new WorkspaceContext(log), log);
  runner.healing = svc;
  runner.telemetry = { record: (e: TelemetryInput) => tele.push(e) } as unknown as AgentRunner['telemetry'];
  if (o.settings) {
    runner.projectSettings = () => o.settings!;
  }
  const session: Session = { id: o.sid, title: '', createdAt: 0, updatedAt: 0, model: o.model, messageCount: 0, messages: [], contextTokens: 0, compactions: 0, mode: o.mode ?? 'agent', attachments: [] };
  const started = Date.now();
  let out = '';
  let error: unknown;
  try {
    out = await runner.run({
      session,
      userMessage: { role: 'user', content: o.prompt ?? 'Update the code in src as needed.' },
      emit: (e) => events.push(e),
      signal: new AbortController().signal,
      requestApproval: async (title, _detail, kind, opts) => {
        const p = { title, kind, mandatory: !!opts?.mandatory };
        prompts.push(p);
        return o.approve ? o.approve(p) : true;
      },
      workspaceRoot: o.ws.root,
      ...(o.toolFilter ? { toolFilter: o.toolFilter } : {}),
      ...(o.maxIterations ? { maxIterations: o.maxIterations } : {}),
      ...(o.firstTokenTimeoutMs ? { firstTokenTimeoutMs: o.firstTokenTimeoutMs } : {}),
    });
  } catch (e) {
    error = e;
  } finally {
    providers.dispose();
    if (prevCfg === undefined) {
      delete process.env.LP_CONFIG;
    } else {
      process.env.LP_CONFIG = prevCfg;
    }
  }
  const healingIds = new Set(events.filter((e) => e.type === 'tool_start' && (e.payload as { origin?: string }).origin === 'healing').map((e) => (e.payload as { id: string }).id));
  const end = events.find((e) => e.type === 'turn_end')?.payload as TurnEnd | undefined;
  const state = await store.load(o.sid);
  return {
    text: out,
    error,
    ms: Date.now() - started,
    events,
    session,
    end,
    prompts,
    tele,
    sleeps,
    probes,
    store,
    memory,
    executed,
    checks: events.filter((e) => e.type === 'tool_start' && healingIds.has((e.payload as { id: string }).id)).map((e) => String((e.payload as { args?: { command?: string } }).args?.command ?? '')),
    checkEnds: events.filter((e) => e.type === 'tool_end' && healingIds.has((e.payload as { id: string }).id)).map((e) => e.payload as { content: string; isError: boolean; data?: unknown }),
    hidden: session.messages.filter((m) => m.role === 'user' && m.meta?.hidden && m.meta.healing),
    recovery: events.filter((e) => e.type === 'recovery').map((e) => e.payload as RecoveryEventPayload),
    reason: state?.intervention?.reason,
  };
}

const allTele: TelemetryInput[] = [];
const keep = (r: RunResult): RunResult => {
  allTele.push(...r.tele);
  return r;
};
const outcomeOf = (r: RunResult) => r.end?.outcome;
const tick = (ms = 150) => new Promise((r) => setTimeout(r, ms));
const BUGGY = "export const a: number = 'BUG';\n";
const CLEAN = 'export const a: number = 1;\n';

// ---------------------------------------------------------------- scenarios

/**
 * #1 Ollama unavailable: the listening socket is closed and refuses the next two requests until the second health
 * probe reopens it; once inside the turn (model call) and once while routing (`routeRetry`).
 */
async function unavailable(check: Check): Promise<void> {
  const lab = new Lab();
  lab.add({ id: 'up', script: () => say('Hello again.') });
  await lab.start();
  try {
    let listed = false;
    lab.afterList = () => {
      if (!listed) {
        listed = true;
        void lab.shut();
      }
    };
    let probed = 0;
    const reopenOnSecond = async () => {
      if (++probed === 2) {
        await lab.listen();
      }
      return probed >= 2;
    };
    const r = keep(await run(lab, { sid: 'heal-unavailable', model: 'mock/up', ws: workspace(), prompt: 'Say hello.', probe: reopenOnSecond }));
    lab.afterList = undefined;
    const retries = r.events.filter((e) => e.type === 'retry').map((e) => e.payload as { reason?: string; attempt?: number });
    check('unavailable: refused model calls are retried and the third request answers', !r.error && r.text === 'Hello again.' && lab.requests('up') === 1 && retries.length === 2 && retries.every((x) => x.reason === 'network'), { error: String(r.error ?? ''), text: r.text, retries });
    check('unavailable: detected as model_unavailable, 2 retries with exp backoff (1 s, 2 s) through the injected sleep', r.sleeps.join() === '1000,2000' && r.tele.filter((e) => e.type === 'recovery' && e.action === 'retry' && e.category === 'model_unavailable').length === 2, { sleeps: r.sleeps, tele: r.tele.filter((e) => e.type === 'recovery') });
    check('unavailable: the provider health probe runs before each retry', r.probes.length === 2 && r.probes.every((p) => p === 'mock/up'), r.probes);
    check('unavailable: outcome completed, nothing to verify', outcomeOf(r) === 'completed' && r.checks.length === 0, r.end);

    // Routing before the engine exists: the provider's listing against the closed socket, retried by routeRetry.
    await lab.shut();
    probed = 0;
    const h = service({ probe: reopenOnSecond });
    const provider = new OpenAICompatProvider({ id: 'mock', type: 'openai', baseUrl: `${lab.url}/v1` });
    let routes = 0;
    const routed = await h.svc.routeRetry(
      effectivePolicies(getConfig().healing).model_unavailable,
      async () => {
        routes++;
        return (await provider.listModels())[0]?.id;
      },
      'mock/up',
      undefined,
      'heal-route',
    ).catch((e: unknown) => e);
    check('routeRetry: the closed socket is retried with the probe and backoff until the server is back', routed === 'mock/up' && routes === 3 && h.sleeps.join() === '1000,2000' && h.probes.length === 2, { routed: String(routed), routes, sleeps: h.sleeps, probes: h.probes });
    check('routeRetry: telemetry retry x2 (model_unavailable)', h.tele.filter((e) => e.type === 'recovery' && e.action === 'retry' && e.category === 'model_unavailable').length === 2, h.tele);
    allTele.push(...h.tele);
  } finally {
    await lab.dispose();
  }
}

/** #14 Model overload: OOM 500s -> thinking off, context halved (never below the prompt floor), then a same-protocol local model. */
async function overload(check: Check): Promise<void> {
  const lab = new Lab();
  let heavyFirst: Turn | undefined;
  const oom = JSON.stringify({ error: { message: 'model requires more system memory (24.0 GiB) than is available (7.6 GiB)' } });
  lab.add(
    {
      id: 'heavy',
      script: (t) => {
        heavyFirst ??= t;
        return { status: 500, body: oom };
      },
    },
    { id: 'lite', script: () => say('Answered by the smaller model.') },
    { id: 'texty', tools: false, script: () => say('wrong model: text protocol') },
    { id: 'cloudlite', cloud: true, script: () => say('wrong model: cloud') },
  );
  await lab.start();
  try {
    const ws = workspace();
    const r = keep(await run(lab, { sid: 'heal-overload', model: 'mock/heavy', ws, prompt: 'Say hello.', cfg: { 'healing.policies': { model_overload: { attempts: 3 } }, contextWindow: 12000 } }));
    const retries = r.events.filter((e) => e.type === 'retry').map((e) => e.payload as { reason: string; adjust?: string });
    check('overload: answered after resource adjustments', !r.error && r.text === 'Answered by the smaller model.', { error: String(r.error ?? ''), text: r.text, retries });
    check('overload: three retries, each with an adjustment', retries.length === 3 && retries.every((x) => x.reason === 'overload' && !!x.adjust), retries);
    check('overload: first thinking is switched off', retries[0]?.adjust === 'thinking off', retries[0]);
    const ctx = /context ([\d,]+) tokens/.exec(retries[1]?.adjust ?? '');
    const win = ctx ? Number(ctx[1].replace(/,/g, '')) : 0;
    // Halving 12,000 would give 6,000: below the measured system prompt + tool schemas + reply budget, so the floor wins.
    const promptChars = text(heavyFirst?.messages[0]).length + JSON.stringify(heavyFirst?.tools ?? []).length;
    check('overload: then the context window is halved, floored at the measured prompt size (not 6,000)', win > 6000 && win < 12000 && win >= promptChars / 4 + 4096, { win, promptChars, adjust: retries[1]?.adjust });
    check('overload: last, reroute to a model with the same tool protocol and locality', /rerouted to lite/.test(retries[2]?.adjust ?? '') && lab.requests('lite') === 1 && lab.requests('texty') === 0 && lab.requests('cloudlite') === 0, { retries, lite: lab.requests('lite'), texty: lab.requests('texty'), cloud: lab.requests('cloudlite') });
    check('overload: backoff waits went through the injectable sleep', r.sleeps.length === 3 && r.sleeps.every((ms) => ms >= 2000) && r.ms < 10_000, { sleeps: r.sleeps, ms: r.ms });
    const adjust = r.tele.filter((e) => e.type === 'recovery' && e.action === 'retry' && e.category === 'model_overload').flatMap((e) => (e.type === 'recovery' ? e.adjust ?? [] : []));
    check('overload: telemetry lists the adjustments', ['thinking_off', 'halve_context', 'reroute'].every((k) => adjust.includes(k)), adjust);
  } finally {
    await lab.dispose();
  }
}

async function mainScenarios(check: Check, lab: Lab): Promise<void> {
  // #2 Model timeout: the first request never answers; the stall is retried within the deadline.
  {
    lab.add({ id: 'staller', script: (t) => (t.n === 1 ? { hang: true } : say('Here is the answer.')) });
    const r = keep(await run(lab, { sid: 'heal-stall', model: 'mock/staller', ws: workspace(), prompt: 'Explain the code.', firstTokenTimeoutMs: 200 }));
    const retry = r.events.find((e) => e.type === 'retry')?.payload as { reason?: string } | undefined;
    check('timeout: a stalled first token is retried (model_timeout) and the turn completes', !r.error && r.text === 'Here is the answer.' && retry?.reason === 'stall' && lab.requests('staller') === 2, { error: String(r.error ?? ''), text: r.text, retry });
    check('timeout: telemetry retry for model_timeout, waits through the injected sleep', r.tele.some((e) => e.type === 'recovery' && e.action === 'retry' && e.category === 'model_timeout') && r.sleeps.length === 1, r.sleeps);
  }
  // #2 with a tiny deadline: the recovery deadline (counted from the first failure) stops the fix attempt.
  {
    const clock: Clock = { offset: 0 };
    let fixTurns = 0;
    lab.add({
      id: 'laggard',
      script: (t) => {
        if (t.n === 1) {
          return write('src/a.ts', BUGGY);
        }
        if (!t.fixes.length) {
          return say('Done.');
        }
        if (++fixTurns === 1) {
          return { hang: true };
        }
        clock.offset += 2 * 60_000;
        return call('read_file', { path: 'src/a.ts' });
      },
    });
    const r = keep(await run(lab, { sid: 'heal-deadline', model: 'mock/laggard', ws: workspace(), clock, firstTokenTimeoutMs: 200, cfg: { 'healing.taskDeadlineMinutes': 1 } }));
    const calls = lab.requests('laggard');
    await tick();
    check('deadline: the stall during the fix is retried within the deadline', r.events.some((e) => e.type === 'retry' && (e.payload as { reason?: string }).reason === 'stall'), r.events.filter((e) => e.type === 'retry'));
    check('deadline: escalated when the recovery deadline passes, outcome incomplete', outcomeOf(r) === 'incomplete' && r.reason === 'deadline', { outcome: outcomeOf(r), reason: r.reason });
    check('deadline: the report names the budget', /deadline of 1 min/.test(r.text), r.text);
    check('deadline: no model call after the stop', lab.requests('laggard') === calls && calls === 4, calls);
  }

  // #3 Invalid JSON (text protocol): trailing comma repaired silently; truncated write_file nudged; length cut-off to lengthAction.
  {
    lab.add({
      id: 'texter-comma',
      tools: false,
      script: (t) => (t.n === 1 ? say('<tool_call>\n{"name": "read_file", "arguments": {"path": "src/a.ts",},}\n</tool_call>') : say('src/a.ts exports the constant a.')),
    });
    const r = keep(await run(lab, { sid: 'heal-comma', model: 'mock/texter-comma', ws: workspace(), prompt: 'What does src/a.ts export?' }));
    check('invalid JSON: a trailing comma is repaired without a model round trip', r.executed.get('read_file') === 1 && lab.requests('texter-comma') === 2 && !r.events.some((e) => e.type === 'nudge'), { reads: r.executed.get('read_file'), calls: lab.requests('texter-comma'), nudges: r.events.filter((e) => e.type === 'nudge') });
  }
  {
    lab.add({
      id: 'texter-trunc',
      tools: false,
      script: (t) =>
        t.n === 1
          ? say('<tool_call>\n{"name": "write_file", "arguments": {"path": "b.txt", "content": "the first half"}\n</tool_call>')
          : t.n === 2
            ? say('<tool_call>\n{"name": "write_file", "arguments": {"path": "b.txt", "content": "complete"}}\n</tool_call>')
            : say('Wrote b.txt.'),
    });
    const ws = workspace();
    const r = keep(await run(lab, { sid: 'heal-trunc', model: 'mock/texter-trunc', ws, prompt: 'Create b.txt.' }));
    const nudge = r.events.find((e) => e.type === 'nudge')?.payload as { reason?: string } | undefined;
    const b = fs.existsSync(path.join(ws.root, 'b.txt')) ? ws.read('b.txt') : undefined;
    check('invalid JSON: a truncated write_file is never brace-balanced; the model is asked to resend', b === 'complete' && r.executed.get('write_file') === 1 && nudge?.reason === 'malformed', { b, writes: r.executed.get('write_file'), nudge });
  }
  {
    // The same truncation (closing brace lost) on a read-only call with its required arguments present is repaired.
    lab.add({
      id: 'texter-brace',
      tools: false,
      script: (t) => (t.n === 1 ? say('<tool_call>\n{"name": "read_file", "arguments": {"path": "src/a.ts"}\n</tool_call>') : say('src/a.ts exports the constant a.')),
    });
    const r = keep(await run(lab, { sid: 'heal-brace', model: 'mock/texter-brace', ws: workspace(), prompt: 'What does src/a.ts export?' }));
    check('invalid JSON: a truncated read-only call with all required arguments is brace-balanced and run', r.executed.get('read_file') === 1 && lab.requests('texter-brace') === 2 && !r.events.some((e) => e.type === 'nudge'), { reads: r.executed.get('read_file'), calls: lab.requests('texter-brace') });
  }
  {
    lab.add({
      id: 'texter-length',
      tools: false,
      script: (t) =>
        t.n === 1
          ? { text: '<tool_call>\n{"name": "read_file", "arguments": {"path": "src/a.ts"', finish: 'length' }
          : t.n === 2
            ? say('<tool_call>\n{"name": "read_file", "arguments": {"path": "src/a.ts"}}\n</tool_call>')
            : say('It exports a.'),
    });
    const r = keep(await run(lab, { sid: 'heal-length', model: 'mock/texter-length', ws: workspace(), prompt: 'What does src/a.ts export?' }));
    const nudge = r.events.find((e) => e.type === 'nudge')?.payload as { reason?: string } | undefined;
    check('invalid JSON: a length cut-off goes to lengthAction, never to repair', nudge?.reason === 'length' && r.executed.get('read_file') === 1 && lab.requests('texter-length') === 3, { nudge, reads: r.executed.get('read_file') });
  }
  {
    lab.add({ id: 'texter-broken', tools: false, script: () => say('<tool_call>\n{"name": "write_file", "arguments": {"path": "c.txt", "content": <<<x>>>}}\n</tool_call>') });
    const ws = workspace();
    const r = keep(await run(lab, { sid: 'heal-broken', model: 'mock/texter-broken', ws, prompt: 'Create c.txt.' }));
    const nudges = r.events.filter((e) => e.type === 'nudge' && (e.payload as { reason?: string }).reason === 'malformed').length;
    check('invalid JSON: repeated malformed calls exhaust model_output (2 repairs) and escalate', nudges === 2 && lab.requests('texter-broken') === 3 && outcomeOf(r) === 'incomplete' && r.reason === 'exhausted' && !fs.existsSync(path.join(ws.root, 'c.txt')), { nudges, calls: lab.requests('texter-broken'), outcome: outcomeOf(r), reason: r.reason });
  }

  // #4 TypeScript compile failure: gate -> TS2322 -> fix prompt -> edit -> rerun -> regression -> completed (+ memory).
  {
    lab.add({
      id: 'tsfix',
      script: (t) => {
        if (t.n === 1) {
          return write('src/a.ts', BUGGY);
        }
        if (t.fix) {
          return write('src/a.ts', CLEAN);
        }
        return say(t.fixes.length ? 'Root cause: a string literal was assigned to a number.' : 'Done.');
      },
    });
    const r = keep(await run(lab, { sid: 'heal-ts', model: 'mock/tsfix', ws: workspace() }));
    const prompt = r.hidden[0];
    check('typescript: the gate ran the typecheck and injected one fix prompt', r.checks[0] === 'npm run typecheck' && r.hidden.length === 1, { checks: r.checks, hidden: r.hidden.length });
    check('typescript: fix prompt has the code excerpt and the "Root cause:" instruction', /attempt 1\/3 · typescript TS2322/.test(prompt?.content ?? '') && prompt!.content.includes("'BUG'") && prompt!.content.includes('Root cause:'), prompt?.content);
    check('typescript: hidden fix prompt carries meta.healing, no meta.nudge, and no nudge event', prompt?.meta?.hidden === true && !!prompt.meta.healing && prompt.meta.nudge === undefined && !r.events.some((e) => e.type === 'nudge'), prompt?.meta);
    check('typescript: rerun passes, regression runs the tests, completed', outcomeOf(r) === 'completed' && r.checks.slice(-2).join() === 'npm run typecheck,npm test' && r.end?.contract?.regressionChecksPassed === 'passed', { outcome: outcomeOf(r), checks: r.checks, contract: r.end?.contract });
    check('typescript: card shows attempt 1/3 and the footer says Verified', r.recovery.some((p) => p.attempt === 1 && p.max === 3) && /Verified:/.test(r.text), r.text);
    const mem = (await r.memory.list()).filter((e) => e.success);
    check('typescript: memory entry written for the validated fix', mem.length === 1 && mem[0].category === 'typescript' && mem[0].code === 'TS2322', mem);
    check('typescript: telemetry detected, fix_attempt, validated, recovered', ['detected', 'fix_attempt', 'validated', 'recovered'].every((a) => r.tele.some((e) => e.type === 'recovery' && e.action === a)), r.tele.filter((e) => e.type === 'recovery').map((e) => (e.type === 'recovery' ? e.action : '')));
    check('typescript: the task telemetry records completed', r.tele.some((e) => e.type === 'task' && e.action === 'completed'));
  }

  // Check output beyond the tool clamp: the classifier reads the raw outcome.
  {
    lab.add({
      id: 'noisy',
      script: (t) => (t.n === 1 ? write('src/a.ts', "// NOISY\nexport const a: number = 'BUG';\n") : t.fix ? write('src/a.ts', CLEAN) : say(t.fixes.length ? 'Root cause: string literal.' : 'Done.')),
    });
    const r = keep(await run(lab, { sid: 'heal-noisy', model: 'mock/noisy', ws: workspace() }));
    const first = r.checkEnds[0]?.content ?? '';
    check('clamp: the check output was clamped for the model, yet the failure buried in it was found', first.length < 40_000 && !first.includes('TS2322') && /TS2322/.test(r.hidden[0]?.content ?? '') && outcomeOf(r) === 'completed', { len: first.length, inClamp: first.includes('TS2322'), outcome: outcomeOf(r) });
  }

  // An agent whose tool filter omits run_command is still verified (run_command comes from the full registry).
  {
    lab.add({ id: 'filtered', script: (t) => (t.n === 1 ? write('src/a.ts', BUGGY) : t.fix ? write('src/a.ts', CLEAN) : say(t.fixes.length ? 'Root cause: string literal.' : 'Done.')) });
    const r = keep(await run(lab, { sid: 'heal-filtered', model: 'mock/filtered', ws: workspace(), toolFilter: ['read_file', 'write_file'] }));
    const offered = lab.bodies.get('filtered')?.[0]?.tools ?? [];
    check('toolFilter: run_command not offered to the model, the checks still ran and the fix completed', !offered.includes('run_command') && r.checks.includes('npm run typecheck') && !r.checkEnds.some((c) => /not available/i.test(c.content)) && outcomeOf(r) === 'completed', { offered, checks: r.checks, outcome: outcomeOf(r) });
  }

  // A healing check is never auto-detached: killed at its own timeout even with autoDetachSeconds = 1.
  {
    lab.add({ id: 'sleeper', script: (t) => (t.n === 1 ? write('src/a.ts', "// SLOW\nexport const a: number = 1;\n") : say('Done.')) });
    const ws = workspace();
    const r = keep(
      await run(lab, {
        sid: 'heal-slow', model: 'mock/sleeper', ws, cfg: { 'terminal.autoDetachSeconds': 1, 'healing.policies': { check_timeout: { attempts: 0 } } },
        tweak: (s) => (s.kind === 'typecheck' ? { ...s, timeoutSeconds: 2, source: 'setting' } : s),
      }),
    );
    const slow = r.checkEnds[0];
    let alive = false;
    try {
      const pid = Number(fs.readFileSync(ws.pidFile, 'utf8'));
      process.kill(pid, 0);
      alive = true;
    } catch {
      alive = false;
    }
    check('no auto-detach: the check ran to its 2 s timeout instead of detaching after 1 s', r.ms >= 1800 && !!slow && !/still running/i.test(slow.content) && !(slow.data as { detached?: unknown } | undefined)?.detached, { ms: r.ms, slow });
    check('no auto-detach: the check process tree was killed, nothing left running', fs.existsSync(ws.pidFile) && !alive && runningCommands('heal-slow').length === 0, { alive, running: runningCommands('heal-slow').length });
    check('no auto-detach: a timed-out check leaves the task completed_unverified', outcomeOf(r) === 'completed_unverified' && r.end?.contract?.compilationPassed === 'unverified', { outcome: outcomeOf(r), contract: r.end?.contract });
  }

  // #8 Infinite agent loop: stops at maxIterations + granted recovery steps, outcome incomplete (loop).
  {
    lab.add({
      id: 'looper',
      script: (t) => (t.n === 1 ? write('src/a.ts', BUGGY) : t.n === 2 ? say('Done.') : call('read_file', { path: 'src/a.ts', offset: t.n })),
    });
    const r = keep(await run(lab, { sid: 'heal-loop', model: 'mock/looper', ws: workspace(), maxIterations: 4, cfg: { 'healing.extraSteps': 3 } }));
    const calls = lab.requests('looper');
    await tick();
    check('loop: stopped within maxIterations + extraSteps', calls > 4 && calls <= 7 && lab.requests('looper') === calls, calls);
    check('loop: outcome incomplete with the loop reason and the budget named', outcomeOf(r) === 'incomplete' && r.reason === 'loop' && /Stopped after 4 model steps \+ \d recovery steps/.test(r.text), { outcome: outcomeOf(r), reason: r.reason, text: r.text });
  }

  // #9 Repeated same failure: the second prompt says the fix did not change the error; the third occurrence escalates duplicate.
  {
    let tries = 0;
    lab.add({
      id: 'stubborn',
      script: (t) => (t.n === 1 ? write('src/a.ts', BUGGY) : t.fix ? write('src/a.ts', `// try ${++tries}\nexport const a: number = 'BUG';\n`) : say(t.fixes.length ? 'Root cause: the cast.' : 'Done.')),
    });
    const r = keep(await run(lab, { sid: 'heal-dup', model: 'mock/stubborn', ws: workspace() }));
    check('repeated failure: second prompt says the previous fix did not change this error', r.hidden.length === 2 && /did not change this error/.test(r.hidden[1].content), r.hidden.map((h) => h.content.split('\n')[0]));
    check('repeated failure: escalated duplicate before the 3-attempt budget, outcome incomplete', outcomeOf(r) === 'incomplete' && r.reason === 'duplicate' && (await r.store.load('heal-dup'))?.attempts.length === 2, { outcome: outcomeOf(r), reason: r.reason });
    check('repeated failure: duplicate recorded in telemetry', r.tele.some((e) => e.type === 'recovery' && (e.action === 'escalated' || e.action === 'duplicate')));
  }
  {
    lab.add({ id: 'talker', script: (t) => (t.n === 1 ? write('src/a.ts', BUGGY) : say(t.fixes.length ? 'Root cause: the literal is a string.' : 'Done.')) });
    const r = keep(await run(lab, { sid: 'heal-noedit', model: 'mock/talker', ws: workspace() }));
    const st = await r.store.load('heal-noedit');
    check('no-edit attempt: counts not_fixed without rerunning the checks', r.checks.length === 1 && st?.attempts[0]?.result === 'not_fixed', { checks: r.checks, attempts: st?.attempts.map((a) => a.result) });
    check('no-edit attempt: two of them escalate duplicate', r.hidden.length === 2 && r.reason === 'duplicate' && outcomeOf(r) === 'incomplete', { hidden: r.hidden.length, reason: r.reason });
  }

  // #12 Security: a hard-coded key blocks completion; the model cannot accept the risk, it has to remediate.
  {
    lab.add({
      id: 'leaker',
      script: (t) => {
        if (t.n === 1) {
          return write('src/keys.ts', "export const KEY = 'AKIAQ7RZ3MXW5TPL2KVD';\n");
        }
        if (t.fix && t.fixes.length === 1) {
          return say('Accept risk: it is only a test key, mark it accepted.');
        }
        if (t.fix) {
          return write('src/keys.ts', 'export const KEY = process.env.AWS_ACCESS_KEY_ID ?? "";\n');
        }
        return say(t.fixes.length ? 'Root cause: a credential was hard-coded.' : 'Done.');
      },
    });
    const r = keep(await run(lab, { sid: 'heal-secret', model: 'mock/leaker', ws: workspace() }));
    check('security: the secret finding starts a remediation prompt', r.hidden.length === 2 && r.hidden.every((h) => h.meta?.healing?.category === 'security'), r.hidden.map((h) => h.meta?.healing));
    check('security: the model cannot accept the risk; remediated and completed', outcomeOf(r) === 'completed' && r.end?.contract?.securityChecksPassed === 'passed' && !r.end?.contract?.acceptedRisks?.length, { outcome: outcomeOf(r), contract: r.end?.contract });
  }

  // #13 All retries exhausted: the test never passes.
  {
    const names = ['alpha', 'beta', 'gamma', 'delta'];
    let i = 0;
    lab.add({
      id: 'hopeless',
      script: (t) =>
        t.n === 1 ? write('src/sum.ts', `// BUG_${names[i++]}\nexport const sum = (x: number, y: number) => x + y + 1;\n`) : t.fix ? write('src/sum.ts', `// BUG_${names[i++]}\nexport const sum = (x: number, y: number) => x + y + 1;\n`) : say(t.fixes.length ? 'Root cause: sum adds one too many.' : 'Done.'),
    });
    const r = keep(await run(lab, { sid: 'heal-exhausted', model: 'mock/hopeless', ws: workspace() }));
    const st = await r.store.load('heal-exhausted');
    check('exhausted: three fix attempts for unit_test, then incomplete', r.hidden.length === 3 && st?.attempts.length === 3 && outcomeOf(r) === 'incomplete' && r.reason === 'exhausted', { hidden: r.hidden.length, attempts: st?.attempts.length, outcome: outcomeOf(r), reason: r.reason });
    check('exhausted: report has the root cause, what was tried and the next action', /Incomplete/.test(r.text) && /Root cause:/.test(r.text) && /Tried:/.test(r.text) && /Next:/.test(r.text), r.text);
  }

  // #15 MCP: "Not connected" -> restart + replay through executeToolCalls; a timeout is reported, never replayed.
  {
    const conn = { connected: false };
    const restarts: string[] = [];
    const executed = new Map<string, number>();
    lab.add({
      id: 'mcper',
      script: (t) => (t.n === 1 ? call('mcp_github__search_issues', { q: 'crash' }) : t.n === 2 ? call('mcp_github__create_issue', { q: 'crash' }) : say('Searched and tried to file the issue.')),
    });
    const r = keep(
      await run(lab, {
        sid: 'heal-mcp', model: 'mock/mcper', ws: workspace(), prompt: 'Search the GitHub issues for crash and file one.', extraTools: mcpTools(executed, conn),
        mcpRestart: async (server) => {
          restarts.push(server);
          conn.connected = true;
        },
      }),
    );
    const sawSearch = JSON.stringify(lab.bodies.get('mcper')?.[1]?.messages ?? []);
    const sawTimeout = JSON.stringify(lab.bodies.get('mcper')?.[2]?.messages ?? []);
    check('mcp: Not connected -> the server restarted once and the call replayed successfully', restarts.join() === 'github' && executed.get('mcp_github__search_issues') === 2 && sawSearch.includes('Found 3 issues') && !sawSearch.includes('Not connected'), { restarts, executed: [...executed] });
    check('mcp: a timeout is reported to the model and never replayed', executed.get('mcp_github__create_issue') === 1 && sawTimeout.includes('timed out') && restarts.length === 1, [...executed]);
    check('mcp: the replay waited the policy backoff through the injected sleep', r.sleeps[0] === 1000, r.sleeps);
  }

  // #16 Data corruption: immediate escalation, zero fix prompts, nothing rolled back.
  {
    const content = "// CORRUPT\nexport const a: number = 1;\n";
    lab.add({ id: 'corrupt', script: (t) => (t.n === 1 ? write('src/a.ts', content) : say('Done.')) });
    const ws = workspace();
    const r = keep(await run(lab, { sid: 'heal-corrupt', model: 'mock/corrupt', ws }));
    check('data corruption: escalated at once with zero fix prompts', r.reason === 'data_corruption' && r.hidden.length === 0 && outcomeOf(r) === 'blocked', { reason: r.reason, hidden: r.hidden.length, outcome: outcomeOf(r) });
    check('data corruption: no rollback writes', ws.read('src/a.ts') === content && lab.requests('corrupt') === 2);
  }

  // #17 A fix that makes it worse is rolled back to the pre-attempt bytes; also: >3 identical synthetic typecheck calls are fine.
  {
    const ws = workspace();
    let beforeSecond = '';
    lab.add({
      id: 'worse',
      script: (t) => {
        if (t.n === 1) {
          return write('src/a.ts', BUGGY);
        }
        if (t.fix && t.fixes.length === 1) {
          return write('src/a.ts', "export const a: number = 1;\nWORSE\n");
        }
        if (t.fix) {
          beforeSecond = ws.read('src/a.ts');
          return write('src/a.ts', CLEAN);
        }
        return say(t.fixes.length ? 'Root cause: string literal.' : 'Done.');
      },
    });
    const r = keep(await run(lab, { sid: 'heal-worse', model: 'mock/worse', ws, cfg: { 'healing.baseline': 'fast', maxConsecutiveMistakes: 2 } }));
    const st = await r.store.load('heal-worse');
    check('worse fix: rolled back to the pre-attempt bytes', beforeSecond === BUGGY && st?.attempts[0]?.result === 'rolled_back', { beforeSecond, a: st?.attempts.map((a) => a.result) });
    check('worse fix: the next prompt says it was reverted, then the task completes', /made it worse.*reverted/s.test(r.hidden[1]?.content ?? '') && outcomeOf(r) === 'completed', { prompt: r.hidden[1]?.content.slice(0, 400), outcome: outcomeOf(r) });
    const typechecks = r.checks.filter((c) => c === 'npm run typecheck').length;
    check('identical checks: 4+ synthetic `npm run typecheck` calls are never refused by MAX_IDENTICAL_CALLS', typechecks >= 4 && !r.checkEnds.some((c) => /^Refused:/.test(c.content)), { typechecks, ends: r.checkEnds.map((c) => c.content.slice(0, 60)) });
    check('identical checks: failing checks are not model mistakes (limit 2 never hit)', !r.events.some((e) => e.type === 'error') && !r.tele.some((e) => e.type === 'task' && e.action === 'mistake_limit'));
  }

  // #18 Preexisting failures (typecheck + lint failing before the turn) are not attributed.
  {
    const ws = workspace({ 'src/old.ts': "// OLD LINT\nconst x = 1;\n" }, { typecheck: 'node check.js typecheck', test: 'node check.js test', lint: 'node check.js lint' });
    lab.add({ id: 'tidy', script: (t) => (t.n === 1 ? write('src/a.ts', 'export const a: number = 2;\n') : say('Done.')) });
    const r = keep(await run(lab, { sid: 'heal-pre', model: 'mock/tidy', ws, cfg: { 'healing.baseline': 'fast' } }));
    const firstCheck = r.events.findIndex((e) => e.type === 'tool_start' && (e.payload as { origin?: string }).origin === 'healing');
    const firstWrite = r.events.findIndex((e) => e.type === 'tool_start' && (e.payload as { name?: string }).name === 'write_file');
    check('preexisting: the baseline ran before the first edit', firstCheck >= 0 && firstCheck < firstWrite && r.checks.includes('npm run lint'), { firstCheck, firstWrite, checks: r.checks });
    check('preexisting: no fix attempt, outcome completed with a preexisting note', r.hidden.length === 0 && outcomeOf(r) === 'completed' && /preexisting/i.test(r.text), { outcome: outcomeOf(r), text: r.text });
  }

  // #21 Policy never bypassed: a settings deny rule skips the check; an org `approvals.terminal: ask` prompts every time.
  {
    lab.add({ id: 'denied', script: (t) => (t.n === 1 ? write('src/a.ts', 'export const a: number = 3;\n') : say('Done.')) });
    const settings: ProjectSettings = { ...emptySettings(), permissions: { allow: [], deny: ['Bash(npm test)'], ask: [], additionalDirectories: [] } };
    const r = keep(await run(lab, { sid: 'heal-deny', model: 'mock/denied', ws: workspace(), settings }));
    check('policy: a deny rule on `npm test` skips the check -> completed_unverified', outcomeOf(r) === 'completed_unverified' && r.end?.contract?.testsPassed !== 'passed' && r.end?.contract?.compilationPassed === 'passed', { outcome: outcomeOf(r), contract: r.end?.contract });
  }
  {
    const policyFile = path.join(tmp('lp-heal-org-'), 'managed-settings.json');
    fs.writeFileSync(policyFile, JSON.stringify({ approvals: { terminal: 'ask' } }));
    const prev = process.env.LOCALPILOT_MANAGED_SETTINGS;
    process.env.LOCALPILOT_MANAGED_SETTINGS = policyFile;
    resetManagedPolicyCache();
    try {
      lab.add({ id: 'orgask', script: (t) => (t.n === 1 ? write('src/a.ts', BUGGY) : t.fix ? write('src/a.ts', CLEAN) : say(t.fixes.length ? 'Root cause: string literal.' : 'Done.')) });
      const r = keep(await run(lab, { sid: 'heal-org', model: 'mock/orgask', ws: workspace() }));
      const terminal = r.prompts.filter((p) => p.kind === 'terminal');
      check('policy: org approvals.terminal=ask -> a mandatory prompt for every check, no allowance', r.checks.length >= 3 && terminal.length === r.checks.length && terminal.every((p) => p.mandatory) && outcomeOf(r) === 'completed', { checks: r.checks, prompts: terminal, outcome: outcomeOf(r) });
    } finally {
      if (prev === undefined) {
        delete process.env.LOCALPILOT_MANAGED_SETTINGS;
      } else {
        process.env.LOCALPILOT_MANAGED_SETTINGS = prev;
      }
      resetManagedPolicyCache();
    }
  }

  // #22 Read-only exploration: git log, ls, reads -> no checks, no baseline, completed.
  {
    const ws = workspace();
    const git = (...args: string[]) => cp.execFileSync('git', args, { cwd: ws.root, stdio: 'ignore' });
    git('init', '-q');
    git('add', '-A');
    git('-c', 'user.name=Smoke', '-c', 'user.email=smoke@example.com', 'commit', '-q', '-m', 'init');
    lab.add({
      id: 'explorer',
      script: (t) => (t.n === 1 ? call('run_command', { command: 'git log --oneline -1' }) : t.n === 2 ? call('run_command', { command: 'ls src' }) : t.n === 3 ? call('read_file', { path: 'src/a.ts' }) : say('The project has one commit and exports a from src/a.ts.')),
    });
    const r = keep(await run(lab, { sid: 'heal-readonly', model: 'mock/explorer', ws, prompt: 'Explore the repo and tell me what it has.', cfg: { 'healing.baseline': 'fast' } }));
    check('read-only: no checks and no baseline ran, outcome completed', r.checks.length === 0 && outcomeOf(r) === 'completed' && lab.requests('explorer') === 4, { checks: r.checks, outcome: outcomeOf(r) });
    check('read-only: no recovery state written', !(await r.store.load('heal-readonly')));
  }

  // #23 Out-of-scope edit: README only -> no checks, n/a, completed.
  {
    lab.add({ id: 'docs', script: (t) => (t.n === 1 ? write('README.md', '# Demo\n\nUsage notes.\n') : say('Updated the README.')) });
    const r = keep(await run(lab, { sid: 'heal-readme', model: 'mock/docs', ws: workspace(), prompt: 'Write a README.' }));
    check('README-only: no checks, contract n/a, outcome completed', r.checks.length === 0 && outcomeOf(r) === 'completed' && r.end?.contract?.compilationPassed === 'n/a' && r.end.contract.testsPassed === 'n/a', { checks: r.checks, outcome: outcomeOf(r), contract: r.end?.contract });
  }

  // #24 Check gaming: the fix rewrites scripts.test to `exit 0` -> never fixed, completed_unverified with the edit listed.
  {
    const ws = workspace();
    lab.add({
      id: 'gamer',
      script: (t) => {
        if (t.n === 1) {
          return write('src/sum.ts', '// BUG\nexport const sum = (x: number, y: number) => x + y + 1;\n');
        }
        if (t.fix) {
          const pkg = JSON.parse(ws.read('package.json')) as { scripts: Record<string, string> };
          pkg.scripts.test = 'exit 0';
          return write('package.json', `${JSON.stringify(pkg, null, 2)}\n`);
        }
        return say(t.fixes.length ? 'Root cause: the test was too strict.' : 'Done.');
      },
    });
    const r = keep(await run(lab, { sid: 'heal-gaming', model: 'mock/gamer', ws }));
    const st = await r.store.load('heal-gaming');
    check('check gaming: the attempt is never counted fixed', !!st?.attempts.length && st.attempts.every((a) => a.result !== 'fixed'), st?.attempts.map((a) => a.result));
    check('check gaming: completed_unverified with package.json listed', outcomeOf(r) === 'completed_unverified' && !!r.end?.contract?.checksModified.some((c) => c.file.startsWith('package.json')) && /check definition was changed/.test(r.text), { outcome: outcomeOf(r), mods: r.end?.contract?.checksModified, text: r.text });
  }

  // #25 Allowance: one "yes" covers the turn's checks until the model rewrites a check script.
  {
    const verify = (r: RunResult) => r.prompts.filter((p) => p.kind === 'terminal' && /verification checks/i.test(p.title)).length;
    lab.add({ id: 'allow-keep', script: (t) => (t.n === 1 ? write('src/a.ts', BUGGY) : t.fix ? write('src/a.ts', CLEAN) : say(t.fixes.length ? 'Root cause: string literal.' : 'Done.')) });
    const kept = keep(await run(lab, { sid: 'heal-allow', model: 'mock/allow-keep', ws: workspace(), cfg: { 'approvals.terminal': 'ask' } }));
    check('allowance: one prompt covers every check of the turn', verify(kept) === 1 && kept.checks.length >= 3 && outcomeOf(kept) === 'completed', { prompts: kept.prompts, checks: kept.checks, outcome: outcomeOf(kept) });
    const ws = workspace();
    lab.add({
      id: 'allow-rewrite',
      script: (t) => {
        if (t.n === 1) {
          return write('src/a.ts', BUGGY);
        }
        if (t.fix) {
          ws.write('src/a.ts', CLEAN);
          const pkg = JSON.parse(ws.read('package.json')) as { scripts: Record<string, string> };
          pkg.scripts.typecheck = 'node check.js typecheck --pretty';
          return write('package.json', `${JSON.stringify(pkg, null, 2)}\n`);
        }
        return say(t.fixes.length ? 'Root cause: string literal.' : 'Done.');
      },
    });
    const rewritten = keep(await run(lab, { sid: 'heal-allow2', model: 'mock/allow-rewrite', ws, cfg: { 'approvals.terminal': 'ask' } }));
    check('allowance: invalidated after the script rewrite, the next check prompts again', verify(rewritten) === 2, { prompts: rewritten.prompts, checks: rewritten.checks });
  }
}

export async function healingSmoke(check: Check): Promise<void> {
  console.log('\n[Self-healing through the agent loop]');
  const lab = new Lab();
  try {
    await unavailable(check);
    await overload(check);
    await lab.start();
    await mainScenarios(check, lab);
    const recov = allTele.filter((e) => e.type === 'recovery');
    const sigs = recov.flatMap((e) => (e.type === 'recovery' && e.signature !== undefined ? [e.signature] : []));
    check('telemetry: recovery events carry only 16-hex signature hashes', recov.length > 10 && sigs.length > 0 && sigs.every((s) => /^[0-9a-f]{16}$/.test(s)), sigs.filter((s) => !/^[0-9a-f]{16}$/.test(s)));
  } finally {
    await lab.dispose();
    allTele.length = 0;
    for (const d of temps.splice(0)) {
      fs.rmSync(d, { recursive: true, force: true });
    }
  }
}
