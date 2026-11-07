/**
 * Smoke checks (bundled into scripts/smoke.ts) for the continuity SESSION module: runs of the real agent loop become
 * agent sessions with execution events (per `captureToolOutput`: errors / summary / full as a blob), a checkpoint entity
 * per snapshot linked to its run and user message (and `restoredAt` on restore, git and file snapshots), model sessions
 * on a user switch, a fallback and a provider that is down, recovery phases and trace ids, a simulated crash (a run
 * whose writer died is marked interrupted, with "What ran" and its checkpoint for the card), a draft that becomes a
 * partial answer on the next start, purge. Temp dirs, a local bare git repo and a local fake model server only.
 */
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { execFileSync, spawnSync } from 'child_process';
import { AgentRunner } from '../src/agent/agentLoop';
import { CheckpointService } from '../src/agent/checkpoints';
import { SkillManager } from '../src/agent/skills';
import { Continuity, type ContinuitySettings } from '../src/continuity/continuity';
import { memorySecretBox } from '../src/continuity/data/crypto/secretBox';
import { agentSessionId } from '../src/continuity/conversation/payloads';
import { writerGone } from '../src/continuity/session/crashRecovery';
import { DraftStore, partialFromDraft } from '../src/continuity/session/drafts';
import { OUTPUT_SUMMARY_CHARS } from '../src/continuity/session/runBridge';
import { WorkspaceContext } from '../src/context/workspaceContext';
import { ProviderRegistry } from '../src/providers/registry';
import { SessionStore } from '../src/sessions/sessionStore';
import { ToolRegistry } from '../src/tools/registry';
import type { AgentEvent, ChatMessage, Session, Tool } from '../src/types';
import { attachSessions, checkpointMessageIndex, checkpointsPageData, runDetails } from '../src/ui/sessionHost';

type Check = (name: string, cond: boolean, detail?: unknown) => void;
const tmp = (p: string) => fs.mkdtempSync(path.join(os.tmpdir(), `lp-ses-${p}-`));
const quiet = { info: () => undefined, warn: () => undefined, error: () => undefined };
const log = { ...quiet, debug: () => undefined, trace: () => undefined } as unknown as vscode.LogOutputChannel;
const say = (role: ChatMessage['role'], content: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({ role, content, meta: { timestamp: Date.now() }, ...extra });
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((r) => {
    let b = '';
    req.on('data', (d) => (b += d));
    req.on('end', () => r(b));
  });
}

/** A pid that is certainly not running (a child that already exited). */
function deadPid(): number {
  const r = spawnSync(process.execPath, ['-e', '0']);
  return r.pid ?? 999_999;
}

async function openC(root: string, settings: () => ContinuitySettings): Promise<Continuity> {
  const c = await Continuity.open({ dataDir: root, writer: 'vscode', appVersion: 'test', secrets: memorySecretBox(), log: quiet, settings, wasmPath: process.env.LOCALPILOT_SQLJS_WASM ?? '', workerPath: '', inProcessIndex: true, schedules: false, autoMigrate: false, flushMs: 5 });
  await c.ready;
  return c;
}

export async function sessionSmoke(check: Check): Promise<void> {
  console.log('\n[continuity: sessions — agent sessions, execution events, checkpoints, model sessions, crash recovery, drafts]');
  const root = tmp('root');
  const cfg: ContinuitySettings = { dataDir: '', trashRetentionDays: 30, historyDays: 90, indexMaxMB: 256, backup: { enabled: false, intervalDays: 7, keep: 4 }, captureToolOutput: 'summary' };
  const c = await openC(root, () => cfg);
  const store = new SessionStore({ storageUri: vscode.Uri.file(tmp('store')) } as unknown as vscode.ExtensionContext, log);
  await store.load();
  // A git repository for checkpoints (the CheckpointService takes a stash-shaped commit before each turn).
  const repo = fs.realpathSync(tmp('repo'));
  const g = (...a: string[]) => execFileSync('git', ['-C', repo, ...a], { stdio: 'ignore' });
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 'a@b');
  g('config', 'user.name', 'a');
  g('config', 'core.autocrlf', 'false');
  fs.writeFileSync(path.join(repo, 'app.txt'), 'v1\n');
  g('add', '.');
  g('commit', '-q', '-m', 'init');
  c.attachSessionStore(store, { defaultFolder: () => repo });
  const workspace = new WorkspaceContext(log);
  const tools = new ToolRegistry();
  const big = 'x'.repeat(OUTPUT_SUMMARY_CHARS + 900);
  const lookup: Tool = {
    definition: { name: 'lookup', description: 'Look a key up', parameters: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] } },
    readOnly: true,
    parallelSafe: true,
    execute: async (args) => (args.key === 'bad' ? { content: 'lookup failed: no such key', isError: true } : { content: big }),
  };
  tools.registerAll([lookup]);
  // Each request answers from the queue: a tool call, or text.
  const replies: ({ tool: string; args: object } | { text: string })[] = [];
  const srv = http.createServer(async (req, res) => {
    if (req.url?.endsWith('/models')) {
      return res.end(JSON.stringify({ data: [{ id: 'm1' }, { id: 'm2' }] }));
    }
    await readBody(req);
    const r = replies.shift() ?? { text: 'Done.' };
    res.setHeader('content-type', 'text/event-stream');
    if ('tool' in r) {
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: `c${Date.now()}`, type: 'function', function: { name: r.tool, arguments: JSON.stringify(r.args) } }] } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 40, completion_tokens: 5 } })}\n\n`);
    } else {
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: r.text } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 50, completion_tokens: 2 } })}\n\n`);
    }
    res.write('data: [DONE]\n\n');
    res.end();
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
  const prevConfig = process.env.LP_CONFIG;
  process.env.LP_CONFIG = JSON.stringify({ providers: [{ id: 'loc', type: 'openai', baseUrl: `${url}/loc/v1` }], 'webSearch.enabled': false, 'memory.enabled': false, contextWindow: 32768, 'checkpoints.enabled': true });
  const providers = new ProviderRegistry(log);
  const checkpoints = new CheckpointService({ globalStorageDir: tmp('global'), enabled: () => true });
  const settle = async (...ss: Session[]) => {
    for (const s of ss) {
      if (store.has(s.id)) {
        await store.flush(store.get(s.id)!);
      }
    }
    await c.bridge!.settle();
    await c.log.flush();
    await c.index.catchUp();
  };
  try {
    const runner = new AgentRunner(providers, tools, new SkillManager(log), workspace, log);
    runner.checkpoints = checkpoints;
    const att = attachSessions(c, { runner, checkpoints, sessionOf: (id) => (store.has(id) ? store.get(id) : undefined), models: () => [{ id: 'loc/m1', name: 'm1', contextWindow: 32768 }, { id: 'loc/m2', name: 'm2', contextWindow: 16384, remote: true }] as never, log });
    const mgr = att.manager!;
    check('attachSessions sets the manager and the loop, checkpoint and trace hooks', !!mgr && c.sessions === mgr && runner.sessionHooks === mgr.bridge && !!checkpoints.onSnapshot && !!checkpoints.onRestore);
    let turn = 0;
    const run = async (s: Session, text: string, o: { traceId?: string } = {}) => {
      const events: AgentEvent[] = [];
      turn++;
      const out = await runner.run({ session: s, userMessage: say('user', text, { meta: { timestamp: Date.now(), checkpoint: turn } }), onUserMessage: () => store.save(s), emit: (e) => events.push(e), signal: new AbortController().signal, workspaceRoot: repo, requestApproval: async () => true, traceId: o.traceId }).catch((e: Error) => `THREW ${e.message}`);
      store.save(s);
      await settle(s);
      return { out, events };
    };

    // ---- a run with a tool call, summary capture (default)
    const s1 = store.create('loc/m1', 'agent');
    replies.push({ tool: 'lookup', args: { key: 'a' } }, { text: 'Found it.' });
    const r1 = await run(s1, 'Look up key a', { traceId: 't_trace1' });
    let runs = await mgr.runs(s1.id);
    const as1 = runs[0];
    check('a run is one agent session: outcome ok, this stream as writer, its title, model and tokens', r1.out === 'Found it.' && runs.length === 1 && as1.outcome === 'ok' && as1.writer === c.log.stream && as1.title === 'Look up key a' && as1.model === 'loc/m1' && (as1.promptTokens ?? 0) > 0 && !!as1.endedAt, { out: r1.out, runs });
    check('its id derives from the Trace id (like migrated traces)', as1.id === agentSessionId('t_trace1'));
    const userMsg = s1.messages.find((m) => m.role === 'user');
    check('the agent session links the turn\'s user message by id', !!userMsg?.meta?.id && as1.messageId === userMsg.meta.id, { as: as1.messageId, msg: userMsg?.meta?.id });
    let ev = await mgr.events(as1.id);
    const toolEv = ev.find((e) => e.kind === 'tool');
    check('execution events: model calls and the tool call in order, the tool closed with its status', ev.filter((e) => e.kind === 'model').length >= 2 && !!toolEv && toolEv.name === 'lookup' && toolEv.status === 'ok' && !!toolEv.end && ev.every((e, i) => e.seq === i + 1), ev.map((e) => `${e.seq}:${e.kind}:${e.name}:${e.status}`));
    check('captureToolOutput summary: the first 2 KB of the output, no blob', !!toolEv?.output && toolEv.output.length <= OUTPUT_SUMMARY_CHARS + 1 && !toolEv.outputBlob, toolEv?.output?.length);
    mgr.bridge.traceAdded({ id: 't_trace1' });
    await c.log.flush();
    await c.index.catchUp();
    check('a stored trace patches traceId onto its agent session', (await mgr.runs(s1.id))[0].traceId === 't_trace1');

    // ---- checkpoint entity per snapshot, linked to the run and the message
    let cps = await mgr.checkpoints({ conversationId: s1.id });
    check('a checkpoint entity per snapshot: run, git snapshot, this device, linked to the agent session and user message', cps.length === 1 && cps[0].run === 1 && cps[0].agentSessionId === as1.id && cps[0].messageId === userMsg?.meta?.id && cps[0].device === c.device.deviceId && !!cps[0].sha && !!cps[0].ref && cps[0].root === repo, cps);

    // ---- full capture, an error with errors capture
    cfg.captureToolOutput = 'full';
    replies.push({ tool: 'lookup', args: { key: 'b' } }, { text: 'Ok.' });
    await run(s1, 'Look up key b');
    runs = await mgr.runs(s1.id);
    ev = await mgr.events(runs[0].id);
    const full = ev.find((e) => e.kind === 'tool');
    check('captureToolOutput full: the output beyond 2 KB is a blob with everything', !!full?.outputBlob && c.blobs.get(full.outputBlob)?.toString('utf8') === big && !!full.output, full);
    cfg.captureToolOutput = 'errors';
    replies.push({ tool: 'lookup', args: { key: 'c' } }, { tool: 'lookup', args: { key: 'bad' } }, { text: 'Gave up.' });
    await run(s1, 'Look up c then bad');
    runs = await mgr.runs(s1.id);
    ev = await mgr.events(runs[0].id);
    const [okEv, badEv] = ev.filter((e) => e.kind === 'tool');
    check('captureToolOutput errors: a successful step keeps no output; a failed one keeps its error', !!okEv && !okEv.output && !okEv.outputBlob && badEv?.status === 'error' && /no such key/.test(badEv.error ?? ''), { okEv, badEv });
    cfg.captureToolOutput = 'summary';

    // ---- restore: git checkpoint and file snapshots patch restoredAt
    fs.writeFileSync(path.join(repo, 'app.txt'), 'v2 by the agent\n');
    const entry = s1.checkpoints!.history.find((e) => e.run === 1)!;
    const restored = await checkpoints.restoreWorkspace(entry);
    await c.log.flush();
    await c.index.catchUp();
    cps = await mgr.checkpoints({ conversationId: s1.id });
    check('restoring a git checkpoint patches restoredAt on its entity', restored.ok && !!cps.find((x) => x.run === 1)?.restoredAt && fs.readFileSync(path.join(repo, 'app.txt'), 'utf8') === 'v1\n', { restored, cps: cps.map((x) => [x.run, x.restoredAt]) });
    checkpoints.noteRestored(s1.id, 2);
    await c.log.flush();
    await c.index.catchUp();
    check('a restore from file snapshots (noteRestored) patches restoredAt too', !!(await mgr.checkpoints({ conversationId: s1.id })).find((x) => x.run === 2)?.restoredAt);
    check('the Checkpoints page: this project\'s checkpoints, newest first, with the chat title and what can be done', await (async () => {
      const proj = (await c.projects!.resolve(repo)).id;
      const page = (await checkpointsPageData(c, store, {}, proj)) as { rows: { run: number; available: boolean; thisDevice: boolean; title: string }[] };
      return page.rows.length === 3 && page.rows[0].run === 3 && page.rows.every((r) => r.available && r.thisDevice) && checkpointMessageIndex(s1, 1) >= 0;
    })());

    // ---- model sessions: first use, a user switch, a fallback, a provider that is down
    let ms = await mgr.modelSessions(s1.id);
    check('model session: the chat\'s first model, open, reason user (picked in the chat), local', ms.length === 1 && ms[0].model === 'loc/m1' && ms[0].reason === 'user' && ms[0].local && !ms[0].endedAt && ms[0].promptTokens > 0, ms);
    s1.model = 'loc/m2';
    mgr.bridge.modelChanged(s1.id);
    await run(s1, 'now with m2');
    ms = await mgr.modelSessions(s1.id);
    check('a user switch ends the open model session and starts one (reason user, cloud, window)', ms.length === 2 && !!ms[0].endedAt && ms[1].model === 'loc/m2' && ms[1].reason === 'user' && !ms[1].local && ms[1].window === 16384, ms);
    const pure = store.create('loc/m1', 'agent');
    const h = mgr.bridge.start({ session: pure, userMessage: say('user', 'x'), mode: 'agent', model: 'loc/m1' })!;
    h.event({ sessionId: pure.id, type: 'model_request', payload: { model: 'loc/m1', name: 'm1' } });
    h.event({ sessionId: pure.id, type: 'route', payload: { wanted: 'loc/m1', used: 'loc/m2', usedName: 'm2', fallback: true, unavailable: true, reason: 'server down' } });
    h.event({ sessionId: pure.id, type: 'model_request', payload: { model: 'loc/m2', name: 'm2' } });
    h.event({ sessionId: pure.id, type: 'route', payload: { wanted: 'loc/m2', used: 'loc/m1', usedName: 'm1', fallback: true, reason: 'overloaded' } });
    h.event({ sessionId: pure.id, type: 'model_request', payload: { model: 'loc/m1', name: 'm1' } });
    h.end({ outcome: 'ok', filesTouched: [{ path: 'src/a.ts', status: 'M' }] });
    await wait(20);
    await c.log.flush();
    await c.index.catchUp();
    ms = await mgr.modelSessions(pure.id);
    check('model sessions: a provider that is down and a fallback are recorded with their reason', ms.map((m) => m.reason).join(',') === 'user,provider-down,fallback' && ms.filter((m) => !m.endedAt).length === 1, ms.map((m) => [m.model, m.reason, !!m.endedAt]));
    check('a fallback is an execution event too; files touched reach the agent session', (await mgr.events((await mgr.runs(pure.id))[0].id)).some((e) => e.kind === 'fallback') && (await mgr.runs(pure.id))[0].filesTouched.join() === 'src/a.ts');

    // ---- recovery phases (throttled to changes)
    const h2 = mgr.bridge.start({ session: pure, userMessage: say('user', 'y'), mode: 'agent' })!;
    mgr.bridge.recovery({ sessionId: pure.id, phase: 'verifying', attempts: [] });
    mgr.bridge.recovery({ sessionId: pure.id, phase: 'verifying', attempts: [] });
    mgr.bridge.recovery({ sessionId: `${pure.id}::child`, phase: 'fixing', attempts: [{ category: 'test' }] });
    h2.end({ outcome: 'ok' });
    await c.log.flush();
    await c.index.catchUp();
    const withRec = (await mgr.runs(pure.id))[0];
    check('RecoveryStore saves patch the run\'s recovery phase (a subagent\'s state counts for its chat)', withRec.recovery?.phase === 'fixing' && withRec.recovery.attempt === 1 && withRec.recovery.category === 'test', withRec.recovery);

    // ---- drafts (pure): written every interval, kept on a shutdown, dropped on a normal end
    const dd = new DraftStore({ root: tmp('drafts'), stream: 'dev_x.1', intervalMs: 10 });
    dd.begin('s_d', { afterCount: 1 });
    dd.append('s_d', 'Hello ');
    dd.append('s_d', 'world');
    await wait(40);
    const dr = dd.read('s_d');
    check('a draft is written (tmp + rename) within the interval', dr?.text === 'Hello world' && !fs.readdirSync(dd.dir).some((f) => f.endsWith('.tmp')), dr);
    const base: Pick<Session, 'messages'> = { messages: [say('user', 'hi')] };
    base.messages[0].meta!.timestamp = (dr?.updatedAt ?? 0) - 1000;
    check('a draft newer than the last message becomes a partial answer', partialFromDraft(base, dr)?.meta?.partial === true && partialFromDraft(base, dr)?.content === 'Hello world');
    check('a draft older than the last message, or already saved, is not offered', partialFromDraft({ messages: [say('user', 'later', { meta: { timestamp: (dr?.updatedAt ?? 0) + 5 } })] }, dr) === undefined && partialFromDraft({ messages: [...base.messages, say('assistant', 'Hello world, and more', { meta: { timestamp: 1 } })] }, dr) === undefined);
    dd.clear('s_d');
    check('clear removes the draft', !dd.read('s_d'));

    // ---- a simulated crash: process A runs, dies; process B marks the run interrupted and offers the partial answer
    const shared = tmp('shared');
    const A = await openC(shared, () => cfg);
    const B = await openC(shared, () => cfg);
    check('two processes on one data root get their own streams', A.log.stream !== B.log.stream && A.device.deviceId === B.device.deviceId);
    const mA = A.attachSessions({ draftIntervalMs: 10 })!;
    const mB = B.attachSessions()!;
    const crashed: Session = { id: 's_crash', title: 'Crash', createdAt: Date.now(), updatedAt: Date.now(), model: 'loc/m1', mode: 'agent', messageCount: 1, messages: [say('user', 'Refactor the parser', { meta: { timestamp: Date.now() - 5000, id: 'm_u1', checkpoint: 4 } })], contextTokens: 0, compactions: 0, attachments: [] };
    const hA = mA.bridge.start({ session: crashed, userMessage: crashed.messages[0], run: 4, mode: 'agent', model: 'loc/m1' })!;
    mA.bridge.checkpoint(crashed, { run: 4, createdAt: Date.now(), kind: 'files', outcome: 'skipped', root: repo });
    hA.event({ sessionId: crashed.id, type: 'model_request', payload: { model: 'loc/m1', name: 'm1' } });
    hA.event({ sessionId: crashed.id, type: 'tool_start', payload: { id: 't1', name: 'edit_file', args: { path: 'src/parser.ts' } } });
    hA.event({ sessionId: crashed.id, type: 'tool_end', payload: { id: 't1', name: 'edit_file', content: 'ok' } });
    hA.event({ sessionId: crashed.id, type: 'tool_start', payload: { id: 't2', name: 'run_command', args: { command: 'npm test' } } });
    hA.event({ sessionId: crashed.id, type: 'model_request', payload: { model: 'loc/m1', name: 'm1' } });
    hA.event({ sessionId: crashed.id, type: 'assistant_delta', payload: 'The parser now handles ' });
    hA.event({ sessionId: crashed.id, type: 'assistant_delta', payload: 'nested blocks and' });
    await wait(40);
    await A.log.flush();
    await B.index.catchUp();
    const asCrash = mA.bridge.activeId(crashed.id)!;
    const liveRow = (await mB.runs(crashed.id))[0];
    check('while A is alive, B sees the run as running and does not mark it', liveRow?.outcome === 'running' && !writerGone(liveRow, { root: shared, deviceId: B.device.deviceId, ownStream: B.log.stream, isActive: () => false }));
    check('while A streams, B does not take its draft', mB.takePartial(crashed) === undefined && !!mA.drafts.read(crashed.id));
    // A dies: its lease names a pid that is gone (no clean end, nothing more written).
    const leaseFile = path.join(shared, 'streams', A.log.stream, 'lease.json');
    const lease = JSON.parse(fs.readFileSync(leaseFile, 'utf8')) as { pid: number };
    fs.writeFileSync(leaseFile, JSON.stringify({ ...lease, pid: deadPid() }));
    const marked = await mB.recoverInterrupted();
    await B.index.catchUp();
    check('crash recovery: B marks the dead writer\'s running agent session interrupted', marked.some((r) => r.id === asCrash) && (await mB.runs(crashed.id))[0].outcome === 'interrupted', marked);
    const card = await runDetails(mB, crashed.id);
    check('the Run interrupted card: what ran (the tool that was running included) and the checkpoint before the run', !!card && card.ran!.some((e) => e.kind === 'tool' && e.name === 'edit_file' && e.status === 'ok') && card.ran!.some((e) => e.name === 'run_command' && e.status === 'running') && card.checkpoint?.run === 4, card);
    const partial = mB.takePartial(crashed);
    check('B turns A\'s draft into a partial answer (assistant, meta.partial) and removes the draft', partial?.role === 'assistant' && partial.meta?.partial === true && partial.content === 'The parser now handles nested blocks and' && !mB.drafts.read(crashed.id), partial);
    check('a partial answer is offered once', mB.takePartial(crashed) === undefined);
    check('the interrupted list (CLI recovery runs) has it', (await mB.interrupted()).some((r) => r.id === asCrash));
    fs.writeFileSync(leaseFile, JSON.stringify(lease));
    await A.dispose();
    await B.dispose();

    // ---- a shutdown keeps the draft (reload mid-answer); purge removes runs from the index
    const keep = store.create('loc/m1', 'agent');
    const h3 = mgr.bridge.start({ session: keep, userMessage: say('user', 'z'), mode: 'agent' })!;
    h3.event({ sessionId: keep.id, type: 'assistant_delta', payload: 'Half an ans' });
    h3.end({ outcome: 'interrupted' });
    check('a run ended by a shutdown keeps its draft (written at once)', mgr.drafts.read(keep.id)?.text === 'Half an ans');
    await c.log.flush();
    await c.index.catchUp();
    check('…and its agent session says interrupted', (await mgr.runs(keep.id))[0]?.outcome === 'interrupted');
    mgr.drafts.clear(keep.id);
    await c.conversations!.trash([s1.id]);
    await c.conversations!.purge([s1.id]);
    await c.log.flush();
    await c.index.catchUp();
    check('purging a conversation removes its runs, checkpoints and model sessions from the index', (await mgr.runs(s1.id)).length === 0 && (await mgr.checkpoints({ conversationId: s1.id })).length === 0 && (await mgr.modelSessions(s1.id)).length === 0);
    att.dispose();
    check('detaching unhooks the loop and the checkpoint service', runner.sessionHooks === undefined && checkpoints.onSnapshot === undefined);
  } finally {
    providers.dispose();
    srv.close();
    if (prevConfig === undefined) {
      delete process.env.LP_CONFIG;
    } else {
      process.env.LP_CONFIG = prevConfig;
    }
    store.dispose();
    await c.dispose();
  }
}
