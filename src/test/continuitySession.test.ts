// Continuity SESSION inside the VS Code test host: the chat controller's Run interrupted card gets "What ran", the
// changed files and the checkpoint from continuity; a draft becomes a partial answer with Continue / Regenerate /
// Discard; the Checkpoints page and its actions go through the ContinuityHost to the chat's own restore and diff paths.
// Real continuity on temp data roots (in-process index, wasm from dist/), a simulated crash (a writer whose pid is
// gone); no network, paths via path.join.
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import * as vscode from 'vscode';
import type { CheckpointEntry } from '../agent/checkpoints';
import { CONTINUE_PARTIAL_PROMPT } from '../agent/runActions';
import { Continuity } from '../continuity/continuity';
import { memorySecretBox } from '../continuity/data/crypto/secretBox';
import { SessionStore } from '../sessions/sessionStore';
import { TraceStore } from '../telemetry/traceStore';
import type { ChatMessage, Session } from '../types';
import { ChatController, type ToWebview } from '../ui/chatController';
import { ContinuityHost } from '../ui/continuityHost';
import type { ContinuityHandle } from '../ui/continuityData';
import { attachSessions, chatSessionRuns } from '../ui/sessionHost';

const quiet = { info: () => undefined, warn: () => undefined, error: () => undefined };
const log = { ...quiet, debug: () => undefined, trace: () => undefined, show: () => undefined } as unknown as vscode.LogOutputChannel;
const tmp = (p: string) => fs.mkdtempSync(path.join(os.tmpdir(), `lp-cses-${p}-`));
const say = (role: ChatMessage['role'], content: string, meta: ChatMessage['meta'] = {}): ChatMessage => ({ role, content, meta: { timestamp: Date.now(), ...meta } });
const settings = () => ({ dataDir: '', trashRetentionDays: 30, historyDays: 90, indexMaxMB: 256, backup: { enabled: false, intervalDays: 7, keep: 4 }, captureToolOutput: 'summary' as const });

function wasm(): string | undefined {
  const ext = vscode.extensions.getExtension('localpilot.localpilot-agent');
  const p = ext ? path.join(ext.extensionPath, 'dist', 'sqljs', 'sql-wasm.wasm') : '';
  return fs.existsSync(p) ? p : process.env.LOCALPILOT_SQLJS_WASM;
}

async function open(root: string): Promise<Continuity> {
  const c = await Continuity.open({ dataDir: root, writer: 'vscode', appVersion: 'test', secrets: memorySecretBox(), log: quiet, settings, wasmPath: wasm() ?? '', workerPath: '', inProcessIndex: true, schedules: false, autoMigrate: false, flushMs: 5 });
  await c.ready;
  return c;
}

/** A chat controller from the prototype with only what the Run interrupted card and partial answers touch. */
function bareController(sessions: Map<string, Session>) {
  const calls = { broadcast: [] as ToWebview[], sent: [] as unknown[][], retried: [] as string[], saved: 0 };
  const c = Object.create(ChatController.prototype) as ChatController & Record<string, unknown>;
  Object.assign(c, {
    runs: new Map(),
    starting: new Set(),
    compacting: new Map(),
    replays: new Map(),
    offers: new Map(),
    traces: new TraceStore(undefined),
    workspace: { root: os.tmpdir() },
    log: { warn() {}, info() {}, debug() {} },
    healing: { resumeInfo: () => undefined },
    tracker: { forSession: () => [] },
    store: {
      has: (id: string) => sessions.has(id),
      get: (id: string) => sessions.get(id),
      save: () => void calls.saved++,
      hint: () => undefined,
    },
    sessionRoot: () => os.tmpdir(),
    chatFolder: () => os.tmpdir(),
    broadcast: (m: ToWebview) => calls.broadcast.push(m),
    send: async (...a: unknown[]) => (calls.sent.push(a), ''),
    retry: async (id: string) => (calls.retried.push(id), ''),
  });
  return { c, calls };
}

suite('Continuity sessions: interrupted runs, partial answers, checkpoints', () => {
  test('a crashed run shows What ran and its checkpoint; its draft comes back as a partial answer with Continue / Regenerate / Discard', async function () {
    this.timeout(90_000);
    if (!wasm()) {
      this.skip();
    }
    const root = tmp('root');
    const A = await open(root);
    const B = await open(root);
    const mA = A.attachSessions({ draftIntervalMs: 10 })!;
    const mB = B.attachSessions()!;
    const s: Session = { id: 's_vsc_crash', title: 'Parser', createdAt: Date.now(), updatedAt: Date.now(), model: 'ollama/qwen', mode: 'agent', messageCount: 1, messages: [say('user', 'Refactor the parser', { id: 'm_vu1', checkpoint: 2, timestamp: Date.now() - 4000 })], contextTokens: 0, compactions: 0, attachments: [], runningSince: Date.now() - 4000 };
    const h = mA.bridge.start({ session: s, userMessage: s.messages[0], run: 2, mode: 'agent', model: 'ollama/qwen' })!;
    mA.bridge.checkpoint(s, { run: 2, createdAt: Date.now(), kind: 'files', outcome: 'skipped', root: os.tmpdir() } as CheckpointEntry);
    h.event({ sessionId: s.id, type: 'tool_start', payload: { id: 'a', name: 'edit_file', args: { path: 'src/parser.ts' } } });
    h.event({ sessionId: s.id, type: 'tool_end', payload: { id: 'a', name: 'edit_file', content: 'ok' } });
    h.event({ sessionId: s.id, type: 'model_request', payload: { model: 'ollama/qwen', name: 'qwen' } });
    h.event({ sessionId: s.id, type: 'assistant_delta', payload: 'The parser now' });
    await new Promise((r) => setTimeout(r, 60));
    await A.log.flush();
    // A dies: its stream's lease names a pid that is gone.
    const leaseFile = path.join(root, 'streams', A.log.stream, 'lease.json');
    const lease = JSON.parse(fs.readFileSync(leaseFile, 'utf8')) as { pid: number };
    fs.writeFileSync(leaseFile, JSON.stringify({ ...lease, pid: spawnSync(process.execPath, ['-e', '0']).pid ?? 999_999 }));
    try {
      const sessions = new Map([[s.id, s]]);
      const { c, calls } = bareController(sessions);
      c.sessionRuns = chatSessionRuns(() => mB, async () => true);
      (c as unknown as { activeSessionId: string }).activeSessionId = s.id;
      c.redrawInterrupted(s.id);
      const last = s.messages[s.messages.length - 1];
      assert.strictEqual(last.role, 'assistant');
      assert.strictEqual(last.meta?.partial, true);
      assert.strictEqual(last.content, 'The parser now');
      // The first post is synchronous; the second carries continuity's details.
      const until = Date.now() + 10_000;
      let full: Extract<ToWebview, { type: 'runInterrupted' }> | undefined;
      while (!full && Date.now() < until) {
        full = calls.broadcast.find((m): m is Extract<ToWebview, { type: 'runInterrupted' }> => m.type === 'runInterrupted' && !!m.state?.ran);
        await new Promise((r) => setTimeout(r, 50));
      }
      assert.ok(full?.state, 'the card got its details');
      assert.strictEqual(full.state.partial, true);
      assert.ok(full.state.ran!.some((e) => e.name === 'edit_file' && e.status === 'ok'));
      assert.strictEqual(full.state.checkpoint?.run, 2);
      assert.strictEqual((await mB.runs(s.id))[0].outcome, 'interrupted');

      // Discard removes the partial answer; Continue sends the continue-from-partial request; Regenerate retries.
      await c.handle({ type: 'resumeDraft', sessionId: s.id, action: 'continue' });
      assert.strictEqual(calls.sent[0]?.[1], CONTINUE_PARTIAL_PROMPT);
      assert.strictEqual(s.runningSince, undefined);
      await c.handle({ type: 'resumeDraft', sessionId: s.id, action: 'regenerate' });
      assert.deepStrictEqual(calls.retried, [s.id]);
      await c.handle({ type: 'resumeDraft', sessionId: s.id, action: 'discard' });
      assert.ok(!s.messages.some((m) => m.meta?.partial), 'the partial answer is gone');
    } finally {
      fs.writeFileSync(leaseFile, JSON.stringify(lease));
      await A.dispose();
      await B.dispose();
    }
  });

  test('the Checkpoints page lists this project\'s checkpoints; View changes and Restore reach the chat\'s own paths', async function () {
    this.timeout(90_000);
    if (!wasm()) {
      this.skip();
    }
    const folder = tmp('ws');
    const c = await open(tmp('root2'));
    const store = new SessionStore({ storageUri: vscode.Uri.file(tmp('store')) } as vscode.ExtensionContext, log);
    await store.load();
    c.attachSessionStore(store, { defaultFolder: () => folder });
    const runner = {} as import('../agent/agentLoop').AgentRunner;
    const att = attachSessions(c, { runner, sessionOf: (id) => (store.has(id) ? store.get(id) : undefined), log });
    const mgr = att.manager!;
    const project = (await c.projects!.resolve(folder)).id;
    const s = store.create('ollama/qwen', 'agent');
    s.messages.push(say('user', 'first', { checkpoint: 1 }), say('assistant', 'done'), say('user', 'second', { checkpoint: 2 }), say('assistant', 'done too'));
    store.save(s);
    await store.flush(s);
    for (const run of [1, 2]) {
      mgr.bridge.checkpoint(s, { run, createdAt: Date.now() + run, kind: 'files', outcome: 'skipped', root: folder } as CheckpointEntry);
    }
    await c.bridge!.settle();
    await c.log.flush();
    await c.index.catchUp();
    const posted: ToWebview[] = [];
    const handled: unknown[] = [];
    const controller = {
      publish: (m: ToWebview) => posted.push(m),
      redraw: () => undefined,
      handle: async (m: unknown) => void handled.push(m),
      isRunning: () => false,
      hasSurface: () => true,
      onDidChangeActive: new vscode.EventEmitter<Session | undefined>().event,
      workspace: { root: folder },
      activeSession: s,
    } as unknown as ChatController;
    const handle: ContinuityHandle = { opened: Promise.resolve(c), current: c };
    const host = new ContinuityHost(controller, store, handle, log);
    const realWarn = vscode.window.showWarningMessage;
    try {
      await host.handle({ type: 'continuityPage', page: 'checkpoints', params: {} });
      const page = posted.find((m): m is Extract<ToWebview, { type: 'continuityPage' }> => m.type === 'continuityPage' && m.page === 'checkpoints');
      const rows = (page?.data as { rows: { run: number; available: boolean; title: string }[]; project?: string }).rows;
      assert.strictEqual(rows.length, 2);
      assert.strictEqual(rows[0].run, 2, 'newest first');
      assert.ok(rows.every((r) => r.available));
      assert.strictEqual((page?.data as { project?: string }).project, project);
      await host.handle({ type: 'checkpointAction', action: 'view', sessionId: s.id, run: 1 });
      assert.deepStrictEqual(handled.pop(), { type: 'viewChanges', sessionId: s.id, scope: 'turn', run: 1 });
      (vscode.window as { showWarningMessage: unknown }).showWarningMessage = async () => 'Restore';
      await host.handle({ type: 'checkpointAction', action: 'restore', sessionId: s.id, run: 1, restoreType: 'workspace' });
      assert.deepStrictEqual(handled.pop(), { type: 'restoreCheckpoint', sessionId: s.id, messageIndex: 0, restoreType: 'workspace' });
      // A turn that is no longer in the chat (rewound) cannot be restored from the page.
      s.messages.splice(2);
      posted.length = 0;
      await host.handle({ type: 'continuityPage', page: 'checkpoints', params: {} });
      const after = (posted.find((m) => m.type === 'continuityPage') as Extract<ToWebview, { type: 'continuityPage' }>).data as { rows: { run: number; available: boolean; why?: string }[] };
      assert.strictEqual(after.rows.find((r) => r.run === 2)?.available, false);
      assert.match(after.rows.find((r) => r.run === 2)?.why ?? '', /no longer in the chat/);
      const cmds = await vscode.commands.getCommands(true);
      assert.ok(cmds.includes('localpilot.continuity.openCheckpoints'));
    } finally {
      (vscode.window as { showWarningMessage: unknown }).showWarningMessage = realWarn;
      host.dispose();
      att.dispose();
      store.dispose();
      await c.dispose();
    }
  });
});
