import * as assert from 'assert';
import * as fs from 'fs';
import * as http from 'http';
import { AddressInfo } from 'net';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { AgentRunner } from '../agent/agentLoop';
import { ChangeTracker } from '../agent/changeTracker';
import type { RecoveryState } from '../agent/healing';
import { isPidAlive } from '../agent/healing/recoveryStore';
import { SkillManager } from '../agent/skills';
import { QueueRunResult, QueueTask, TaskQueue } from '../agent/taskQueue';
import { WorkspaceContext } from '../context/workspaceContext';
import { createHealingHost, type HealingHost } from '../healingHost';
import type { McpManager } from '../mcp/mcpManager';
import { OpenAICompatProvider } from '../providers/openaiCompat';
import { ProviderRegistry } from '../providers/registry';
import { SessionStore } from '../sessions/sessionStore';
import type { Telemetry } from '../telemetry/telemetry';
import { ToolRegistry } from '../tools/registry';
import type { AgentEvent, ModelInfo, Session, Tool } from '../types';
import { ChatController, type ToWebview } from '../ui/chatController';
import { removeTemp } from './removeTemp';

/**
 * Design §7.2 / §12 row 10: a VS Code restart in the middle of a recovery. A queued task's fix attempt is being
 * validated by a slow check when the window closes (queue disposed first, then the controller stops its runs with
 * `shutdown`). The services are then built again on the same folders, as on the next activation: the store says
 * `interrupted`, the queue resumes the task in its own chat, the checks rerun before any model request, nothing is
 * edited or installed twice and the attempt counters carry on. A user Stop is the contrast: `cancelled`, not resumed.
 *
 * The model is a scripted OpenAI-compatible server; the toolchain is a `run_command` stand-in whose `npm run typecheck`
 * prints a real tsc error while `src/a.ts` contains `BUG` and can be told to hang until it is aborted.
 */

const log = vscode.window.createOutputChannel('LocalPilot restart test', { log: true });
const FIX_MARK = '[LocalPilot self-healing';
const TS_ERROR = "src/a.ts(1,14): error TS2322: Type 'string' is not assignable to type 'number'.\n";
const BROKEN = "export const a: number = 'BUG';\n";
const FIXED = 'export const a: number = 1;\n';
const INSTALL = 'npm install left-pad';
const TS_MISSING = "src/a.ts(1,20): error TS2307: Cannot find module 'left-pad' or its corresponding type declarations.\n";

/** What happened, in order: model requests, writes and checks/commands (shared by the server and the tools). */
interface Env {
  trace: string[];
  /** The next clean typecheck hangs until it is aborted. */
  hang: boolean;
  /** A clean typecheck reports that `left-pad` is not installed. */
  missing?: boolean;
  hung?: () => void;
}

let env: Env = { trace: [], hang: false };

type Msg = { role: string; content?: unknown };
const text = (c: unknown): string => (typeof c === 'string' ? c : Array.isArray(c) ? c.map((p) => (p as { text?: string }).text ?? '').join('') : '');

/** Write a broken file; after the fix prompt write the fixed one; otherwise answer. */
function scriptedModel() {
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      if (req.url !== '/v1/chat/completions') {
        res.statusCode = 404;
        res.end();
        return;
      }
      const j = JSON.parse(body) as { messages: Msg[]; tools?: unknown[] };
      let reply: { text: string } | { path: string; content: string };
      if (!j.tools?.length) {
        env.trace.push('helper');
        reply = { text: 'Restart test' };
      } else {
        env.trace.push('model');
        const fixAt = j.messages.map((m) => m.role === 'user' && text(m.content).includes(FIX_MARK)).lastIndexOf(true);
        const toolsAfter = j.messages.slice(fixAt + 1).filter((m) => m.role === 'tool').length;
        if (fixAt < 0) {
          reply = toolsAfter ? { text: 'Created src/a.ts.' } : { path: 'src/a.ts', content: BROKEN };
        } else {
          reply = toolsAfter ? { text: 'Root cause: a string was assigned to a number.\nFixed src/a.ts.' } : { path: 'src/a.ts', content: FIXED };
        }
      }
      res.setHeader('content-type', 'text/event-stream');
      if ('path' in reply) {
        const call = { index: 0, id: `call_${env.trace.length}`, type: 'function', function: { name: 'write_file', arguments: JSON.stringify(reply) } };
        res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [call] } }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })}\n\n`);
      } else {
        res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: reply.text } }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
      }
      res.end('data: [DONE]\n\n');
    });
  });
  return new Promise<{ url: string; close(): void }>((resolve) =>
    srv.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${(srv.address() as AddressInfo).port}/v1`, close: () => srv.close() }))
  );
}

const writeFile: Tool = {
  approvalKind: 'write',
  definition: { name: 'write_file', description: 'Write a file', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } },
  async execute(args, ctx) {
    const rel = String(args.path ?? '');
    const abs = path.resolve(ctx.workspaceRoot!, rel);
    await ctx.trackChange(abs);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, String(args.content ?? ''));
    env.trace.push(`write:${rel}`);
    return { content: `Wrote ${rel}` };
  },
};

/** The fake toolchain: `npm run typecheck` fails while src/a.ts has BUG; anything else is recorded and succeeds. */
const runCommand: Tool = {
  approvalKind: 'terminal',
  definition: { name: 'run_command', description: 'Run a command', parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } },
  async execute(args, ctx) {
    const command = String(args.command ?? '');
    const done = (output: string, exitCode: number | null) => {
      ctx.healingExec?.rawOutcome({ output, exitCode });
      return { content: output || 'ok', isError: exitCode !== 0 };
    };
    if (command !== 'npm run typecheck') {
      env.trace.push(`cmd:${command}`);
      return done('', 0);
    }
    const src = fs.existsSync(path.join(ctx.workspaceRoot!, 'src/a.ts')) ? fs.readFileSync(path.join(ctx.workspaceRoot!, 'src/a.ts'), 'utf8') : '';
    if (src.includes('BUG')) {
      env.trace.push('check:fail');
      return done(TS_ERROR, 2);
    }
    if (env.missing) {
      env.trace.push('check:missing');
      return done(TS_MISSING, 2);
    }
    if (env.hang) {
      env.trace.push('check:hang');
      env.hung?.();
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 60_000);
        const stop = () => {
          clearTimeout(timer);
          resolve();
        };
        if (ctx.signal.aborted) {
          stop();
        } else {
          ctx.signal.addEventListener('abort', stop, { once: true });
        }
      });
      env.trace.push('check:aborted');
      return done('[cancelled]', null);
    }
    env.trace.push('check:pass');
    return done('', 0);
  },
};

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(what: string, check: () => boolean, ms = 30_000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) {
      throw new Error(`timed out waiting for ${what}; trace: ${env.trace.join(', ')}`);
    }
    await wait(25);
  }
}

const readJson = <T>(file: string): T | undefined => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return undefined;
  }
};

/** A pid on this host that no process has (a crashed owner). */
function deadPid(): number {
  for (let pid = 99_999; pid > 1000; pid--) {
    if (!isPidAlive(pid)) {
      return pid;
    }
  }
  throw new Error('no free pid found');
}

interface Dirs {
  root: string;
  data: string;
  queueFile: string;
}

/** One "window": the services extension.ts builds, on the given folders (queue separate: it loads after the scan). */
class Window {
  readonly sessions: SessionStore;
  readonly workspace: WorkspaceContext;
  readonly providers: ProviderRegistry;
  readonly tools = new ToolRegistry();
  readonly tracker = new ChangeTracker(log);
  readonly runner: AgentRunner;
  readonly controller: ChatController;
  readonly host: HealingHost;
  queue?: TaskQueue;
  readonly runs: Promise<QueueRunResult>[] = [];
  readonly tasks: QueueTask[] = [];
  readonly sids: string[] = [];
  readonly posted: ToWebview[] = [];
  readonly events: AgentEvent[] = [];
  closed = false;
  private storeGone?: Promise<void>;

  constructor(readonly dirs: Dirs, url: string) {
    this.sessions = new SessionStore({ storageUri: vscode.Uri.file(dirs.data) } as vscode.ExtensionContext, log);
    this.workspace = new WorkspaceContext(log);
    Object.defineProperty(this.workspace, 'root', { get: () => dirs.root });
    this.providers = new ProviderRegistry(log);
    const model: ModelInfo = { id: 'restart/m', providerId: 'restart', modelId: 'm', name: 'm', contextWindow: 32768, maxOutputTokens: 2048, supportsTools: true, supportsVision: false };
    const provider = new OpenAICompatProvider({ id: 'restart', type: 'openai', baseUrl: url, models: ['m'] });
    Object.assign(this.providers, { route: async () => ({ provider, model }), residentModels: async () => new Set<string>(), markUnresponsive: () => undefined });
    this.tools.registerAll([writeFile, runCommand]);
    this.runner = new AgentRunner(this.providers, this.tools, new SkillManager(log), this.workspace, log, this.tracker);
    this.controller = new ChatController(this.sessions, this.runner, this.providers, new SkillManager(log), this.workspace, this.tracker, log);
    this.host = createHealingHost({
      storageDir: path.join(dirs.data, 'storage'),
      log,
      telemetry: { record: () => undefined } as unknown as Telemetry,
      providers: this.providers,
      tracker: this.tracker,
      mcp: { restart: async () => undefined } as unknown as McpManager,
      liveSessions: () => this.controller.runningSessionIds,
      root: () => dirs.root,
    });
    this.runner.healing = this.host.service;
    this.controller.healing = this.host.service;
    const c = this.controller as unknown as { broadcast(m: ToWebview): void };
    const broadcast = c.broadcast.bind(this.controller);
    c.broadcast = (m) => {
      this.posted.push(m);
      broadcast(m);
    };
    this.controller.onAgentEvent((e) => this.events.push(e));
  }

  /** The queue as extension.ts builds it: runs go through the controller, interrupted chats resume. */
  openQueue(runner?: (t: QueueTask) => void): TaskQueue {
    this.queue = new TaskQueue(
      this.dirs.queueFile,
      (task, started) => {
        this.tasks.push({ ...task });
        runner?.(task);
        const p = this.controller.runQueuedTask({ prompt: task.prompt, mode: task.mode, model: task.model, sessionId: task.sessionId, resume: task.resume }, (id) => {
          this.sids.push(id);
          started(id);
        }, false);
        this.runs.push(p);
        return p;
      },
      () => 1,
      log,
      { resumable: (sid) => this.host.service.resumeInfo(sid)?.phase === 'interrupted' }
    );
    return this.queue;
  }

  get statePath(): string {
    return this.host.store.statePath(this.sids[0]);
  }

  state(): RecoveryState | undefined {
    return readJson<RecoveryState>(this.statePath);
  }

  /** Waits for the queued run to reach the hanging validation check. */
  async untilValidatingHangs(): Promise<void> {
    const hung = new Promise<void>((resolve) => (env.hung = resolve));
    await Promise.race([hung, wait(60_000).then(() => Promise.reject(new Error(`the validation check never started; trace: ${env.trace.join(', ')}`)))]);
    await until('the validating phase on disk', () => this.state()?.phase === 'validating');
  }

  /**
   * Deactivation as it happens in VS Code, all in one tick: extension.ts disposes the queue, then the subscriptions go
   * in order: the controller stops its runs for shutdown and the healing store flushes and releases its locks. Nothing
   * waits for the aborted runs to unwind, so their `interrupted` write and lock release land on a disposed store.
   */
  shutdown(): Promise<void> {
    this.queue?.dispose();
    this.controller.dispose();
    return (this.storeGone ??= this.host.store.dispose());
  }

  /** What the rest of deactivation does after the runs settled: sessions and recovery state reach disk. */
  async close(): Promise<void> {
    this.closed = true;
    for (const id of this.sids) {
      const s = this.sessions.get(id);
      if (s) {
        await this.sessions.flush(s);
      }
    }
    this.sessions.dispose();
    await (this.storeGone ??= this.host.store.dispose());
    this.queue?.dispose();
    this.providers.dispose();
    this.tools.dispose();
    this.workspace.dispose();
  }
}

suite('Self-healing: restart and resume (extension host)', function () {
  this.timeout(180_000);
  let server: Awaited<ReturnType<typeof scriptedModel>>;
  const temps: string[] = [];
  const opened: Window[] = [];
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
    'healing.enabled': true,
    'healing.baseline': 'off',
    'healing.securityCheck': 'off',
    'healing.memory': 'off',
    'healing.delegateFixes': false,
    'healing.checkTiming': 'onComplete',
  };
  const saved: Record<string, unknown> = {};

  const dirs = (): Dirs => {
    const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lp-heal-restart-')));
    temps.push(base);
    const root = path.join(base, 'ws');
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'heal-restart', version: '1.0.0', scripts: { typecheck: 'node check.js' } }, null, 2));
    fs.writeFileSync(path.join(root, 'check.js'), '// stands in for tsc\n');
    return { root, data: path.join(base, 'data'), queueFile: path.join(base, 'data', 'task-queue.json') };
  };

  const open = async (d: Dirs): Promise<Window> => {
    const w = new Window(d, server.url);
    opened.push(w);
    await w.sessions.load();
    return w;
  };

  /** Window 1: queue a task and run it until its fix attempt is being validated by the hanging check. */
  const runUntilValidating = async (d: Dirs): Promise<Window> => {
    env.hang = true;
    const w = await open(d);
    w.openQueue().add({ prompt: 'Create src/a.ts exporting the number a.' });
    await w.untilValidatingHangs();
    return w;
  };

  /** Shuts window 1 down in production order mid-validation; returns the queued run's result once all settled. */
  const shutDown = async (w: Window): Promise<QueueRunResult> => {
    const storeGone = w.shutdown();
    const result = await w.runs[0];
    await storeGone;
    await w.host.store.flush();
    await w.queue!.flush();
    await w.close();
    return result;
  };

  suiteSetup(async () => {
    for (const [k, v] of Object.entries(settings)) {
      saved[k] = cfg().inspect(k)?.globalValue;
      await cfg().update(k, v, vscode.ConfigurationTarget.Global);
    }
    server = await scriptedModel();
  });

  setup(() => {
    env = { trace: [], hang: false };
  });

  teardown(async () => {
    for (const w of opened.splice(0)) {
      w.queue?.dispose();
      try {
        w.controller.dispose();
        if (!w.closed) {
          await w.close();
        }
      } catch {
        /* already disposed */
      }
    }
    await wait(50);
    temps.splice(0).forEach(removeTemp);
  });

  suiteTeardown(async () => {
    server?.close();
    for (const k of Object.keys(settings)) {
      await cfg().update(k, saved[k], vscode.ConfigurationTarget.Global);
    }
  });

  test('shutdown mid-validation persists interrupted; the next start resumes the task with checks first', async () => {
    const d = dirs();
    const w1 = await runUntilValidating(d);
    const sid = w1.sids[0];
    assert.ok(sid, 'the queue started the task in a chat');

    // Deactivation order of extension.ts and VS Code: queue, controller (stop for shutdown) and store in one tick.
    assert.deepStrictEqual(await shutDown(w1), { ok: false, shutdown: true });

    const queued = readJson<{ tasks: QueueTask[] }>(d.queueFile)!;
    assert.deepStrictEqual(queued.tasks.map((t) => [t.status, t.sessionId]), [['running', sid]], 'the task stays running on disk');
    const before = w1.state()!;
    assert.strictEqual(before.phase, 'interrupted');
    assert.strictEqual(before.outcome, undefined, 'a shutdown is not a cancellation');
    assert.deepStrictEqual(before.attempts.map((a) => [a.n, a.category, a.result]), [[1, 'typescript', undefined]]);
    assert.ok(before.changedFiles.includes('src/a.ts'), JSON.stringify(before.changedFiles));
    assert.ok(!fs.existsSync(w1.host.store.lockPath(sid)), 'the owner lock was released');
    assert.deepStrictEqual(env.trace.filter((t) => t.startsWith('write:') || t.startsWith('check:')), ['write:src/a.ts', 'check:fail', 'write:src/a.ts', 'check:hang', 'check:aborted']);
    const fixedBytes = fs.readFileSync(path.join(d.root, 'src/a.ts'), 'utf8');
    assert.strictEqual(fixedBytes, FIXED);

    // A crashed process of another window left its lock behind.
    fs.writeFileSync(w1.host.store.lockPath(sid), JSON.stringify({ pid: deadPid(), host: os.hostname(), at: Date.now(), kind: 'vscode' }));

    // Next activation on the same folders.
    env.hang = false;
    const mark = env.trace.length;
    const w2 = await open(d);
    w2.sids.push(sid);
    const found = await w2.host.service.scanUnfinished();
    assert.ok(found.some((u) => u.sid === sid && u.phase === 'interrupted'), JSON.stringify(found));
    const info = w2.host.service.resumeInfo(sid);
    assert.deepStrictEqual([info?.phase, info?.attempt, info?.category], ['interrupted', 1, 'typescript'], 'resumeInfo answers synchronously from the scan');

    await w2.controller.handle({ type: 'selectSession', id: sid });
    const resumed: QueueTask[] = [];
    const q2 = w2.openQueue((t) => resumed.push({ ...t }));
    await q2.load();
    assert.deepStrictEqual(resumed.map((t) => [t.resume, t.sessionId]), [[true, sid]], 'requeued with resume in the same chat');
    const result = await w2.runs[0];
    await wait(0);
    await q2.flush();

    const card = w2.posted.findIndex((m) => m.type === 'recoveryInterrupted' && m.sessionId === sid && !!m.state);
    const running = w2.posted.findIndex((m) => m.type === 'running' && m.sessionId === sid && m.running);
    assert.ok(card >= 0, 'the Recovery interrupted card was posted');
    assert.ok(card < running, `the card (${card}) comes before the resumed run (${running})`);
    const cardState = (w2.posted[card] as Extract<ToWebview, { type: 'recoveryInterrupted' }>).state;
    assert.strictEqual(cardState?.phase, 'interrupted');

    const after = env.trace.slice(mark);
    const firstCheck = after.findIndex((t) => t.startsWith('check:'));
    assert.strictEqual(after[firstCheck], 'check:pass', `trace after restart: ${after.join(', ')}`);
    assert.ok(!after.slice(0, firstCheck).some((t) => t === 'model' || t === 'helper'), `no model request before the checks rerun: ${after.join(', ')}`);
    assert.ok(!after.some((t) => t.startsWith('write:')), 'no edit is replayed');
    assert.strictEqual(fs.readFileSync(path.join(d.root, 'src/a.ts'), 'utf8'), fixedBytes);

    const final = w2.state()!;
    const outcome = final.outcome;
    assert.ok(outcome === 'completed' || outcome === 'completed_unverified', `outcome ${outcome}`);
    assert.strictEqual(final.phase, outcome);
    assert.deepStrictEqual(final.attempts.map((a) => [a.n, a.category, a.result, a.startedAt]), [[1, 'typescript', 'fixed', before.attempts[0].startedAt]], 'the same attempt, settled');
    assert.strictEqual(final.perCategory.typescript, 1, 'counters continue from the stored state');
    const sig = before.attempts[0].signature;
    assert.ok((final.seen[sig]?.count ?? 0) >= (before.seen[sig]?.count ?? 0), 'seen counters are not reset');
    assert.ok(final.rev > before.rev, 'the dead owner’s lock was taken over: the resumed run could write');
    assert.ok(!fs.existsSync(w2.host.store.lockPath(sid)), 'and released at the end');

    const end = w2.events.filter((e) => e.sessionId === sid && e.type === 'turn_end').pop()?.payload as { outcome?: string } | undefined;
    assert.strictEqual(end?.outcome, outcome);
    assert.strictEqual(w2.sessions.get(sid)?.recovery?.outcome, outcome, 'Session.recovery');
    assert.deepStrictEqual(result, { ok: true, outcome, interventionId: undefined, error: undefined });
    assert.deepStrictEqual(q2.list.map((t) => [t.status, t.sessionId, t.outcome]), [['done', sid, outcome]]);

    await w2.close();
    const onDisk = readJson<Session>(path.join(d.data, 'sessions', `${sid}.json`));
    assert.strictEqual(onDisk?.recovery?.outcome, outcome, 'Session.recovery persisted');
  });

  test('an install started before the crash is not rerun; a still-missing dependency asks for approval again', async () => {
    const d = dirs();
    const w1 = await runUntilValidating(d);
    const sid = w1.sids[0];
    assert.deepStrictEqual(await shutDown(w1), { ok: false, shutdown: true });
    const before = w1.state()!;
    assert.strictEqual(before.phase, 'interrupted');

    // The process died while the approved install of a missing dependency was running (journaled as started).
    const now = Date.now();
    const fixAttempt = { ...before.attempts[0], result: 'fixed' as const, endedAt: now - 2000 };
    const journaled: RecoveryState = {
      ...before,
      phase: 'resolving',
      attempts: [fixAttempt, { n: 2, category: 'dependency', signature: 'dep:left-pad', strategy: 'install', mode: 'inline', patches: [], startedAt: now - 1000 }],
      pendingAction: { kind: 'install', command: INSTALL, status: 'started', at: now - 1000 },
    };
    fs.writeFileSync(w1.statePath, JSON.stringify(journaled, null, 2));
    fs.writeFileSync(w1.host.store.lockPath(sid), JSON.stringify({ pid: deadPid(), host: os.hostname(), at: now, kind: 'vscode' }));

    // Next activation: left-pad is still not installed.
    env.missing = true;
    const mark = env.trace.length;
    const w2 = await open(d);
    w2.sids.push(sid);
    const found = await w2.host.service.scanUnfinished();
    assert.ok(found.some((u) => u.sid === sid && u.phase === 'interrupted'), JSON.stringify(found));
    const q2 = w2.openQueue();
    await q2.load();
    assert.deepStrictEqual(w2.tasks.map((t) => [t.resume, t.sessionId]), [[true, sid]], 'requeued with resume in the same chat');
    const result = await w2.runs[0];
    await wait(0);
    await q2.flush();
    await w2.host.store.flush();

    const after = env.trace.slice(mark);
    assert.ok(after.includes('check:missing'), `the checks reran: ${after.join(', ')}`);
    assert.ok(!after.some((t) => t === `cmd:${INSTALL}`), `the started install is not run again without a new approval: ${after.join(', ')}`);
    assert.ok(!after.some((t) => t.startsWith('write:')), 'no edit is replayed');

    const final = w2.state()!;
    assert.deepStrictEqual(final.attempts.map((a) => [a.n, a.strategy, a.result]), [[1, 'fix', 'fixed'], [2, 'install', 'not_fixed']], 'the interrupted install attempt is settled as not fixed');
    assert.ok(final.attempts[1].endedAt, 'and ended');
    assert.strictEqual(final.outcome, 'blocked', `outcome ${final.outcome}`);
    assert.strictEqual(final.intervention?.reason, 'approval_needed');
    assert.ok(final.intervention.nextActions.some((a) => a.action === 'approveInstall'), JSON.stringify(final.intervention.nextActions));
    assert.ok(!fs.existsSync(w2.host.store.lockPath(sid)), 'the lock was released at the end');

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.outcome, 'blocked');
    assert.strictEqual(result.interventionId, final.intervention.id, 'the queue gets the intervention to answer');
    assert.deepStrictEqual(q2.list.map((t) => [t.status, t.sessionId, t.interventionId]), [['needs_input', sid, final.intervention.id]], 'the task waits for a fresh approval');
    await w2.close();
  });

  test('a user Stop mid-validation persists cancelled and is not resumed', async () => {
    const d = dirs();
    const w1 = await runUntilValidating(d);
    const sid = w1.sids[0];
    w1.controller.stop(sid);
    assert.deepStrictEqual(await w1.runs[0], { ok: false, cancelled: true, outcome: 'cancelled', error: 'Stopped by the user.' });
    await wait(0);
    await w1.queue!.flush();
    const stopped = w1.state()!;
    assert.strictEqual(stopped.phase, 'cancelled');
    assert.strictEqual(stopped.outcome, 'cancelled');
    w1.queue!.dispose();
    w1.controller.dispose();
    await w1.close();
    assert.deepStrictEqual(readJson<{ tasks: QueueTask[] }>(d.queueFile)!.tasks.map((t) => t.status), ['cancelled']);

    const mark = env.trace.length;
    const w2 = await open(d);
    const found = await w2.host.service.scanUnfinished();
    assert.ok(!found.some((u) => u.sid === sid), JSON.stringify(found));
    assert.strictEqual(w2.host.service.resumeInfo(sid), undefined);
    const started: QueueTask[] = [];
    const q2 = w2.openQueue((t) => started.push(t));
    await q2.load();
    await wait(50);
    assert.deepStrictEqual(started, [], 'nothing is started');
    assert.deepStrictEqual(q2.list.map((t) => [t.status, t.resume]), [['cancelled', undefined]]);
    assert.deepStrictEqual(env.trace.slice(mark), []);
    assert.strictEqual(readJson<RecoveryState>(w2.host.store.statePath(sid))?.phase, 'cancelled');
    await w2.close();
  });

  test('a stale lock of a dead owner is taken over; a live owner’s lock leaves the state read-only', async () => {
    const d = dirs();
    const w = await open(d);
    const store = w.host.store;
    const sid = 's_crashed01';
    const now = Date.now();
    const state: RecoveryState = {
      version: 1, rev: 3, sessionId: sid, turnKey: 1, phase: 'validating', startedAt: now - 10_000, updatedAt: now, owner: { pid: process.ppid, host: os.hostname(), kind: 'cli' },
      baseline: undefined, checks: {}, changedFiles: ['src/a.ts'], agentWrites: {}, approvals: [], acceptedRisks: [],
      attempts: [{ n: 1, category: 'typescript', signature: 'sig-1', strategy: 'fix', mode: 'inline', patches: [], startedAt: now - 5000 }],
      perCategory: {}, seen: {}, active: [], extraStepsUsed: 0,
    };
    fs.mkdirSync(store.dir, { recursive: true });
    fs.writeFileSync(store.statePath(sid), JSON.stringify(state));
    const lock = (pid: number) => fs.writeFileSync(store.lockPath(sid), JSON.stringify({ pid, host: os.hostname(), at: Date.now(), kind: 'cli' }));
    const lockPid = () => readJson<{ pid: number }>(store.lockPath(sid))?.pid;

    // Live owner (another process on this host): not interrupted, not resumable, read-only here.
    assert.ok(isPidAlive(process.ppid));
    lock(process.ppid);
    assert.ok(!(await w.host.service.scanUnfinished()).some((u) => u.sid === sid));
    assert.strictEqual(w.host.service.resumeInfo(sid), undefined);
    assert.strictEqual(readJson<RecoveryState>(store.statePath(sid))?.phase, 'validating');
    assert.strictEqual(await store.acquire(sid), 'readonly');
    assert.strictEqual(await store.save({ ...state }), false, 'no write while another process owns it');
    await store.release(sid);
    assert.strictEqual(lockPid(), process.ppid, 'a foreign lock is never removed');

    // The owner died: the scan marks it interrupted and the lock can be taken over.
    lock(deadPid());
    const found = await w.host.service.scanUnfinished();
    assert.ok(found.some((u) => u.sid === sid && u.phase === 'interrupted'), JSON.stringify(found));
    assert.strictEqual(w.host.service.resumeInfo(sid)?.phase, 'interrupted');
    assert.strictEqual(readJson<RecoveryState>(store.statePath(sid))?.phase, 'interrupted');
    assert.strictEqual(await store.acquire(sid), 'owned');
    assert.strictEqual(lockPid(), process.pid);
    assert.strictEqual(await store.save({ ...state, phase: 'interrupted' }), true);
    await store.release(sid);
    assert.ok(!fs.existsSync(store.lockPath(sid)));
    await w.close();
  });
});
