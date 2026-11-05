import * as assert from 'assert';
import * as vscode from 'vscode';
import { ChatController, RESUME_PROMPT } from '../ui/chatController';
import { forgetRecovery } from '../ui/healingAccess';

suite('Chat controller: self-healing wiring', () => {
  const make = (opts: { resumeInfo?: any; sessions?: string[] } = {}) => {
    const calls = { sent: [] as any[][], broadcast: [] as any[], pushed: [] as string[], rollback: [] as any[][], dismissed: [] as string[], stopped: [] as any[], accepted: [] as any[][] };
    const sessions = new Map<string, any>((opts.sessions ?? ['s1']).map((id) => [id, { id, messages: [], mode: 'agent', model: '' }]));
    const agentEvents = new vscode.EventEmitter<any>();
    const runsChanged = new vscode.EventEmitter<void>();
    const c = Object.create(ChatController.prototype) as any;
    Object.assign(c, {
      runs: new Map(),
      starting: new Set(),
      compacting: new Map(),
      replays: new Map(),
      offers: new Map(),
      outcomes: new Map(),
      stoppedByUser: new Set(),
      runStatus: new Map(),
      shuttingDown: false,
      _onDidChangeRuns: runsChanged,
      onDidChangeRuns: runsChanged.event,
      _onDidChangeActive: { fire() {} },
      _onAgentEvent: agentEvents,
      onAgentEvent: agentEvents.event,
      store: {
        get: (id: string) => sessions.get(id),
        peek: (id: string) => sessions.get(id),
        save: () => undefined,
        prune: async () => 0,
        create: () => {
          const s = { id: `new${sessions.size}`, messages: [], mode: 'agent', model: '' };
          sessions.set(s.id, s);
          return s;
        },
      },
      workspace: { root: '/repo' },
      log: { warn() {}, info() {}, debug() {} },
      healing: {
        resumeInfo: () => opts.resumeInfo,
        rollback: async (...a: any[]) => (calls.rollback.push(a), { restored: ['src/a.ts'], skipped: [] }),
        dismiss: async (sid: string) => (calls.dismissed.push(sid), true),
        acceptRisk: async (...a: any[]) => (calls.accepted.push(a), { signatures: ['sig'] }),
      },
      broadcast: (m: any) => calls.broadcast.push(m),
      pushChanges: (id: string) => calls.pushed.push(id),
      mirrorPendingApprovals() {},
      send: async (...args: any[]) => (calls.sent.push(args), ''),
    });
    return { c, calls, sessions, agentEvents };
  };

  test('Resume and Approve install send the hidden resume turn with the resume option', async () => {
    const t = make();
    await t.c.handle({ type: 'recoveryAction', sessionId: 's1', action: 'resume' });
    await t.c.handle({ type: 'recoveryAction', sessionId: 's1', action: 'approveInstall' });
    assert.deepStrictEqual(t.calls.sent, [
      ['s1', RESUME_PROMPT, [], undefined, { resume: true }],
      ['s1', RESUME_PROMPT, [], undefined, { resume: true }],
    ]);
  });

  test('Retry with guidance is a normal user message; an empty one sends nothing', async () => {
    const t = make();
    await t.c.handle({ type: 'recoveryAction', sessionId: 's1', action: 'retryWithGuidance', text: '  use the v2 API ' });
    await t.c.handle({ type: 'recoveryAction', sessionId: 's1', action: 'retryWithGuidance', text: '   ' });
    assert.deepStrictEqual(t.calls.sent, [['s1', 'use the v2 API']]);
  });

  test('Rollback calls the service with the attempt and workspace, reports and refreshes the changes', async () => {
    const t = make();
    await t.c.handle({ type: 'recoveryAction', sessionId: 's1', action: 'rollback', attempt: 2 });
    assert.deepStrictEqual(t.calls.rollback, [['s1', 2, '/repo']]);
    assert.match(t.calls.broadcast.find((m) => m.type === 'toast')?.text ?? '', /Rolled back 1 file/);
    assert.deepStrictEqual(t.calls.pushed, ['s1']);
    assert.ok(!t.c.runStatus.has('s1'));
  });

  test('Dismiss closes the recovery and clears the interrupted card', async () => {
    const t = make();
    await t.c.handle({ type: 'recoveryAction', sessionId: 's1', action: 'dismiss' });
    assert.deepStrictEqual(t.calls.dismissed, ['s1']);
    assert.ok(t.calls.broadcast.some((m) => m.type === 'recoveryInterrupted' && m.sessionId === 's1' && m.state === null));
  });

  test('opening a chat with an interrupted recovery shows the card; other phases do not', () => {
    const t = make({ resumeInfo: { phase: 'interrupted', attempt: 2, max: 3, category: 'typescript' } });
    t.c.setActive(t.sessions.get('s1'));
    const card = t.calls.broadcast.find((m) => m.type === 'recoveryInterrupted');
    assert.deepStrictEqual(card, { type: 'recoveryInterrupted', sessionId: 's1', state: { phase: 'interrupted', attempt: 2, max: 3, category: 'typescript', sessionId: 's1', recoveryId: 's1' } });

    const busy = make({ resumeInfo: { phase: 'fixing', attempt: 1, max: 3 } });
    busy.c.setActive(busy.sessions.get('s1'));
    assert.ok(!busy.calls.broadcast.some((m) => m.type === 'recoveryInterrupted'));
  });

  test('dispose stops runs with the shutdown reason; a user Stop keeps the default', () => {
    const t = make();
    const reasons: (string | undefined)[] = [];
    const control = { stop: (r?: string) => reasons.push(r) };
    t.c.runs.set('s1', control);
    Object.assign(t.c, { approvals: new Map(), questions: new Map(), settleApproval() {}, settleQuestion() {} });
    t.c.stop('s1');
    Object.assign(t.c, { notifier: { dispose() {} }, pendingDeltas: new Map(), disposables: [], _onDidChangeActive: { dispose() {} }, _onDidChangeRuns: { dispose() {}, fire() {} } });
    t.c.dispose();
    assert.deepStrictEqual(reasons, [undefined, 'shutdown']);
  });

  test('runQueuedTask maps the turn_end outcome and intervention id', async () => {
    const t = make();
    t.c.send = async (sid: string) => {
      t.c.outcomes.set(sid, { outcome: 'incomplete', interventionId: 'iv1', report: 'Incomplete: npm test still fails' });
      t.agentEvents.fire({ sessionId: sid, type: 'turn_end', payload: { text: 'tried', outcome: 'incomplete' } });
      return 'tried';
    };
    const started: string[] = [];
    const r = await t.c.runQueuedTask({ prompt: 'fix the tests', mode: 'agent' }, (id: string) => started.push(id), false);
    assert.strictEqual(started.length, 1);
    assert.deepStrictEqual(r, { ok: false, outcome: 'incomplete', interventionId: 'iv1', error: 'Incomplete: npm test still fails' });
    assert.strictEqual(t.c.lastOutcome(started[0]), 'incomplete');
  });

  test('runQueuedTask: no turn_end (model failure threw) is failed; healing off falls back to the answer rule', async () => {
    const t = make();
    t.c.send = async (sid: string) => {
      t.agentEvents.fire({ sessionId: sid, type: 'error', payload: 'model unavailable' });
      return '';
    };
    const failed = await t.c.runQueuedTask({ prompt: 'x', mode: 'agent' }, () => undefined, false);
    assert.strictEqual(failed.outcome, 'failed');
    assert.strictEqual(failed.ok, false);
    assert.strictEqual(failed.error, 'model unavailable');

    t.c.send = async (sid: string) => {
      t.agentEvents.fire({ sessionId: sid, type: 'turn_end', payload: { text: 'done', completed: true } });
      return 'done';
    };
    const plain = await t.c.runQueuedTask({ prompt: 'y', mode: 'agent' }, () => undefined, false);
    assert.strictEqual(plain.ok, true);
    assert.strictEqual(plain.outcome, 'completed');
  });

  test('runQueuedTask with resume continues the existing chat with the resume turn', async () => {
    const t = make({ sessions: ['old'] });
    const sent: any[][] = [];
    t.c.send = async (...args: any[]) => {
      sent.push(args);
      t.c.outcomes.set(args[0], { outcome: 'completed_unverified' });
      t.agentEvents.fire({ sessionId: args[0], type: 'turn_end', payload: { text: 'ok', outcome: 'completed_unverified' } });
      return 'ok';
    };
    const started: string[] = [];
    const r = await t.c.runQueuedTask({ prompt: 'orig', mode: 'agent', sessionId: 'old', resume: true }, (id: string) => started.push(id), false);
    assert.deepStrictEqual(started, ['old']);
    assert.deepStrictEqual(sent, [['old', RESUME_PROMPT, [], undefined, { modelRef: undefined, unattended: true, resume: true, taskId: undefined }]]);
    assert.strictEqual(r.ok, true);

    const gone = await t.c.runQueuedTask({ prompt: 'orig', mode: 'agent', sessionId: 'deleted', resume: true }, (id: string) => started.push(id), false);
    assert.notStrictEqual(started[1], 'deleted', 'a missing chat starts a new one');
    assert.strictEqual(sent[1][1], 'orig');
    assert.strictEqual(gone.ok, true);
  });

  test('runQueuedTask during shutdown is not recorded', async () => {
    const t = make();
    t.c.send = async () => {
      t.c.shuttingDown = true;
      return '';
    };
    const r = await t.c.runQueuedTask({ prompt: 'x', mode: 'agent' }, () => undefined, false);
    assert.deepStrictEqual(r, { ok: false, shutdown: true });
  });

  const tick = () => new Promise((r) => setTimeout(r, 0));

  test('refreshInterrupted posts the card once the index is filled after the webview was ready', async () => {
    let info: any;
    const t = make();
    t.c.healing.resumeInfo = () => info;
    t.c.setActive(t.sessions.get('s1'));
    assert.ok(!t.calls.broadcast.some((m) => m.type === 'recoveryInterrupted'), 'the index is still empty at ready');
    info = { phase: 'interrupted', attempt: 1, max: 3, category: 'test' };
    t.c.refreshInterrupted();
    const card = t.calls.broadcast.find((m) => m.type === 'recoveryInterrupted');
    assert.strictEqual(card?.sessionId, 's1');
    assert.strictEqual(card?.state.attempt, 1);
  });

  test('the interrupted card is posted again with the persisted failures, attempts, root cause and phase', async () => {
    const t = make({ resumeInfo: { phase: 'interrupted', attempt: 1, max: 3, category: 'typescript' } });
    const active = [{ category: 'typescript', message: "Cannot find name 'x'", file: 'src/a.ts', line: 3 }];
    t.c.healing.state = async () => ({ phase: 'interrupted', active, attempts: [{ n: 1, category: 'typescript', rootCause: 'missing import', patches: [], startedAt: 1 }], intervention: undefined });
    t.c.setActive(t.sessions.get('s1'));
    await tick();
    const cards = t.calls.broadcast.filter((m) => m.type === 'recoveryInterrupted');
    assert.strictEqual(cards.length, 2);
    assert.deepStrictEqual(cards[1].state, { phase: 'interrupted', attempt: 1, max: 3, category: 'typescript', sessionId: 's1', recoveryId: 's1', lastPhase: 'fixing', active, attempts: [{ n: 1, category: 'typescript', rootCause: 'missing import' }] });

    // Resumed before the state was read: no second card.
    const late = make({ resumeInfo: { phase: 'interrupted', attempt: 1, max: 3 } });
    late.c.healing.state = async () => ({ phase: 'interrupted', active, attempts: [] });
    late.c.setActive(late.sessions.get('s1'));
    late.c.starting.add('s1');
    await tick();
    assert.strictEqual(late.calls.broadcast.filter((m) => m.type === 'recoveryInterrupted').length, 1);
  });

  test('no interrupted card for a chat the queue is already starting', () => {
    const t = make({ resumeInfo: { phase: 'interrupted', attempt: 1, max: 3 } });
    t.c.starting.add('s1');
    t.c.setActive(t.sessions.get('s1'));
    assert.ok(!t.calls.broadcast.some((m) => m.type === 'recoveryInterrupted'));
  });

  test('a resume send into a busy chat is dropped, never turned into a visible steer', async () => {
    const t = make();
    const steered: any[] = [];
    Object.assign(t.c, { send: ChatController.prototype.send, steer: async (...a: any[]) => (steered.push(a), true), drainQueue() {} });
    t.c.runs.set('s1', {});
    assert.strictEqual(await t.c.send('s1', RESUME_PROMPT, [], undefined, { resume: true }), '');
    assert.deepStrictEqual(steered, []);
    await t.c.send('s1', 'also check the docs');
    assert.strictEqual(steered.length, 1, 'a normal message still steers');
  });

  test('runQueuedTask resume into a chat that is already running follows that run instead of sending', async () => {
    const t = make({ sessions: ['old'] });
    const sent: any[] = [];
    t.c.send = async (...a: any[]) => (sent.push(a), '');
    t.c.runs.set('old', {});
    const p = t.c.runQueuedTask({ prompt: 'orig', mode: 'agent', sessionId: 'old', resume: true }, () => undefined, false);
    await tick();
    t.c.outcomes.set('old', { outcome: 'completed' });
    t.agentEvents.fire({ sessionId: 'old', type: 'turn_end', payload: { text: 'fixed', outcome: 'completed' } });
    t.c.runs.delete('old');
    t.c._onDidChangeRuns.fire();
    const r = await p;
    assert.deepStrictEqual(sent, []);
    assert.deepStrictEqual(r, { ok: true, outcome: 'completed', interventionId: undefined, error: undefined });
  });

  test('Rollback and Dismiss are refused while the chat runs', async () => {
    const t = make();
    t.c.runs.set('s1', {});
    await t.c.handle({ type: 'recoveryAction', sessionId: 's1', action: 'rollback', attempt: 1 });
    await t.c.handle({ type: 'recoveryAction', sessionId: 's1', action: 'dismiss' });
    t.c.runs.delete('s1');
    t.c.starting.add('s1');
    await t.c.handle({ type: 'recoveryAction', sessionId: 's1', action: 'rollback' });
    assert.deepStrictEqual(t.calls.rollback, []);
    assert.deepStrictEqual(t.calls.dismissed, []);
    const toasts = t.calls.broadcast.filter((m) => m.type === 'toast').map((m) => m.text);
    assert.strictEqual(toasts.length, 3);
    assert.match(toasts[0], /stop it before rolling back/);
  });

  test('Resume of a deleted chat tells the user', async () => {
    const t = make();
    Object.assign(t.c, { send: ChatController.prototype.send });
    await t.c.resumeRecovery('gone');
    assert.match(t.calls.broadcast.find((m) => m.type === 'toast')?.text ?? '', /no longer exists/);
  });

  test('forgetting a deleted chat drops its index entry and persisted state', async () => {
    const deleted: string[] = [];
    const index = new Map<string, any>([['s1', { phase: 'interrupted', attempt: 1, max: 3 }], ['s2', { phase: 'interrupted', attempt: 1, max: 3 }]]);
    await forgetRecovery({ index, opts: { store: { deleteSession: async (sid: string) => void deleted.push(sid) } } } as any, 's1');
    assert.deepStrictEqual([...index.keys()], ['s2']);
    assert.deepStrictEqual(deleted, ['s1']);
  });

  test('Accept risk records nothing unless the modal returns Accept risk', async () => {
    const win = vscode.window as any;
    const original = win.showWarningMessage;
    const answers: (string | undefined)[] = [undefined, 'Accept risk'];
    win.showWarningMessage = async () => answers.shift();
    try {
      const t = make();
      await t.c.handle({ type: 'recoveryAction', sessionId: 's1', action: 'acceptRisk' });
      assert.deepStrictEqual(t.calls.accepted, []);
      await t.c.handle({ type: 'recoveryAction', sessionId: 's1', action: 'acceptRisk' });
      assert.deepStrictEqual(t.calls.accepted, [['s1', 'user']]);
    } finally {
      win.showWarningMessage = original;
    }
  });

  test('a resume turn is a hidden user message, skips slash parsing and name correction; child turn_ends set no outcome', async () => {
    const t = make();
    let captured: any;
    const never = (what: string) => () => {
      throw new Error(`${what} must not run for a resume turn`);
    };
    Object.assign(t.c, {
      afterTurn: { list: () => [] },
      tracker: { beginTurn() {}, forSession: () => [] },
      lastCheckpoint: 0,
      activeSessionId: undefined,
      removedWhileRunning: new Map(),
      notifier: { event() {}, finished() {}, groupFinished() {} },
      handleSlash: never('slash parsing'),
      inlineCommand: never('inline commands'),
      correctNames: never('name correction'),
      ensureWorktree: async () => undefined,
      readAttachments: async () => [],
      deliverLeftovers() {},
      onControlChange() {},
      sessionRoot: () => '/repo',
      runner: {
        run: async (o: any) => {
          captured = o.userMessage;
          o.emit({ sessionId: 's1', type: 'turn_end', payload: { childId: 'w1', text: 'worker', outcome: 'failed' } });
          return 'done';
        },
      },
    });
    const session = t.sessions.get('s1');
    await t.c.startRun(session, 's1', '/compact', [], undefined, { resume: true });
    assert.strictEqual(captured.content, '/compact');
    assert.strictEqual(captured.meta.hidden, true);
    assert.ok(!t.c.outcomes.has('s1'), 'a subagent turn_end does not set the chat outcome');
  });

  test('replay keeps only the latest recovery event per id and child id', () => {
    const t = make();
    t.c.replays.set('s1', { base: 0, startedAt: 0, items: [], bytes: 0, truncated: false });
    const ev = (payload: any) => ({ type: 'event', event: { sessionId: 's1', type: 'recovery', payload } });
    t.c.record(ev({ id: 'r1', phase: 'fixing' }));
    t.c.record(ev({ id: 'r1', phase: 'validating' }));
    t.c.record(ev({ childId: 'w1', data: { id: 'r1', phase: 'fixing' } }));
    t.c.record(ev({ childId: 'w1', data: { id: 'r1', phase: 'completed' } }));
    const items = t.c.replays.get('s1').items;
    assert.strictEqual(items.length, 2);
    assert.strictEqual(items[0].event.payload.phase, 'validating');
    assert.strictEqual(items[1].event.payload.data.phase, 'completed');
  });
});
