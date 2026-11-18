import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';
import { click, MiniElement, miniDocument } from './miniDom';

const EXT_ROOT = path.resolve(__dirname, '..', '..');

type Fn = (...a: unknown[]) => unknown;
interface Rec {
  fns: Record<string, Fn>;
  state: { recovery: Map<string, { cards: Map<string, Record<string, unknown>>; outcome: Record<string, unknown> | null; at?: number }>; interrupted: Map<string, unknown>; running: Set<string>; live: Map<string, unknown>; session: { id: string; messages: unknown[] } | null };
  els: { messages: MiniElement };
  posted: Record<string, unknown>[];
  childStatus: unknown[][];
  doc: ReturnType<typeof miniDocument>;
}

/**
 * The self-healing section of `media/chat.js` (a browser IIFE) is lifted out of the source and run in a sandbox with a
 * small DOM (./miniDom): the pure renderers, plus the cards' final state, actions, routing and replay.
 */
function loadRecovery(): Rec {
  const src = fs.readFileSync(path.join(EXT_ROOT, 'media', 'chat.js'), 'utf8');
  const start = src.indexOf('  // ------------------------------------------------------------------ self-healing');
  const end = src.indexOf('  // Scrolls only when the event belongs to the transcript on screen');
  assert.ok(start > 0 && end > start, 'self-healing section not found in media/chat.js');
  const line = (prefix: string): string => { const l = src.split('\n').find((x) => x.trim().startsWith(prefix)); assert.ok(l, `${prefix} not found in media/chat.js`); return l; };
  const doc = miniDocument();
  const posted: Record<string, unknown>[] = []; const childStatus: unknown[][] = [];
  const state = { recovery: new Map(), interrupted: new Map(), running: new Set(), live: new Map(), session: null };
  const els = { messages: doc.body.appendChild(doc.createElement('div')) };
  const icon = '<svg></svg>';
  const noop = (): void => undefined;
  const sandbox: Record<string, unknown> = {
    document: doc, CSS: { escape: (x: string) => String(x).replace(/["\\]/g, '\\$&') },
    I: { spin: icon, check: icon, warn: icon, refresh: icon, undo: icon, pause: icon, play: icon, x: icon, timer: icon, chev: icon }, state, els,
    post: (m: Record<string, unknown>) => posted.push(JSON.parse(JSON.stringify(m))),
    noteStatus: noop, setStatus: noop, setPhase: noop, followLive: noop, rotateBody: noop,
    childStatus: (...a: unknown[]) => childStatus.push(a),
  };
  const names = ['recHeader', 'recBody', 'recMerge', 'reportOutcome', 'outcomeBadge', 'recCode', 'recCache', 'onRecovery', 'recTurnEnd', 'wrappedChild', 'onChildRecovery', 'recReplay', 'renderInterrupted', 'userTurns', 'foldRecCards'];
  vm.runInNewContext(`${line('const esc = ')}\n${line('function el(')}\n${line('function short(')}\n${src.slice(start, end)}\nout_ = { ${names.join(', ')} };`, sandbox, { timeout: 5_000 });
  return { fns: sandbox.out_ as Record<string, Fn>, state: state as unknown as Rec['state'], els, posted, childStatus, doc };
}

/** A live turn as `ensureLive` builds it: steps then the streaming body inside the turn root. */
function liveTurn(rec: Rec): { root: MiniElement; body: MiniElement; steps: MiniElement; subs: Map<string, MiniElement> } {
  const root = rec.els.messages.appendChild(rec.doc.createElement('div'));
  root.className = 'turn assistant live';
  const steps = root.appendChild(rec.doc.createElement('div')); steps.className = 'steps';
  const body = root.appendChild(rec.doc.createElement('div')); body.className = 'body';
  return { root, body, steps, subs: new Map() };
}

suite('Chat self-healing card', () => {
  const r = loadRecovery().fns;
  const base = { id: 'r1', attempt: 2, max: 3, category: 'typescript', title: 'TypeScript TS2345 in src/api/user.ts:42' };

  test('header names the attempt, the category and the code', () => {
    assert.strictEqual(r.recHeader(base), 'Self-healing · attempt 2/3 · TypeScript (TS2345)');
    assert.strictEqual(r.recHeader({ id: '', phase: 'verifying' }), 'Self-healing · verifying changes');
    assert.strictEqual(r.recCode({ title: "ModuleNotFoundError: No module named 'x'" }), 'ModuleNotFoundError');
  });

  test('stepper marks the current phase while running and the failed step when stopped', () => {
    const running = r.recMerge(undefined, { ...base, phase: 'fixing' }) as Record<string, unknown>;
    const html = r.recBody(running) as string;
    assert.match(html, /<li class="done">Detect<\/li><li class="done">Diagnose<\/li><li class="cur" aria-current="step">Fix<\/li><li class="">Validate/);
    const validating = r.recMerge(running, { id: 'r1', phase: 'validating' });
    const blocked = r.recMerge(validating, { id: 'r1', phase: 'blocked' }) as Record<string, unknown>;
    assert.strictEqual(blocked.outcome, 'blocked', 'a terminal phase sets the outcome');
    assert.strictEqual(blocked.attempt, 2, 'fields missing from an update are kept');
    assert.match(r.recBody(blocked) as string, /<li class="done">Fix<\/li><li class="bad">Validate<\/li><li class="">Regression/);
    const done = r.recMerge(validating, { id: 'r1', phase: 'completed' });
    assert.ok(!/class="(cur|bad|)"/.test(r.recBody(done) as string), 'a recovered card shows every step done');
  });

  test('check chips, patches and decision are escaped and styled by status', () => {
    const html = r.recBody(r.recMerge(undefined, {
      ...base, phase: 'validating', rootCause: 'parseId() returns <string>', decision: 'retry in 2s',
      checks: [{ id: 'typecheck', status: 'passed', ms: 4100 }, { id: 'test', status: 'failed', ms: 250 }, { id: 'e2e', status: 'timeout', ms: 120000 }, { id: 'lint', status: 'skipped', skipReason: 'not required' }],
      patches: [{ file: 'src/a.ts', added: 4, removed: 2 }, { file: 'src/b.ts', added: 1, removed: 1, result: 'rolled_back' }],
    })) as string;
    assert.match(html, /rchip passed[^>]*><b><svg><\/svg><\/b><span class="n">typecheck<\/span><i>4\.1s<\/i>/);
    assert.match(html, /rchip failed[^>]*><b><svg><\/svg><\/b><span class="n">test<\/span><i>250ms<\/i>/);
    assert.match(html, /rchip timeout[^>]*><b><svg><\/svg><\/b>/);
    assert.match(html, /rchip skipped" title="Skipped: not required"><span class="n">lint<\/span><i>skipped<\/i>/);
    assert.match(html, /<li class="rb"[^>]*><span class="f">src\/b\.ts<\/span><span class="a">\+1<\/span><span class="r">−1<\/span>/);
    assert.match(html, /returns &lt;string&gt;/);
    assert.match(html, /rec-decision/);
    assert.ok(!/rec-decision/.test(r.recBody(r.recMerge(undefined, { ...base, phase: 'completed', decision: 'x' })) as string), 'no decision once finished');
  });

  test('stored footers map to outcomes and badges', () => {
    assert.strictEqual(r.reportOutcome('Verified: typecheck ✓ · tests 42/42 ✓'), 'completed');
    assert.strictEqual(r.reportOutcome('Not verified: no checks for the changed files'), 'completed_unverified');
    assert.strictEqual(r.reportOutcome('Incomplete: `npm test` still fails'), 'incomplete');
    assert.strictEqual(r.reportOutcome('Blocked: approval needed'), 'blocked');
    assert.strictEqual(r.reportOutcome('All done.'), '');
    assert.match(r.outcomeBadge('completed') as string, /class="outcome ok">Completed ✓ verified/);
    assert.match(r.outcomeBadge('blocked', 'a "b"') as string, /title="a &quot;b&quot;">Blocked/);
    assert.strictEqual(r.outcomeBadge('failed'), '');
  });

  test('a merge after an answered intervention asks again only for a new intervention or new work', () => {
    const answered = { ...base, phase: 'blocked', outcome: 'blocked', intervention: { id: 'i1', reason: 'approval_needed', nextActions: [] }, done: true };
    assert.strictEqual((r.recMerge(answered, { id: 'r1', phase: 'blocked', intervention: { id: 'i2', reason: 'approval_needed', nextActions: [] } }) as Record<string, unknown>).done, undefined);
    assert.strictEqual((r.recMerge(answered, { id: 'r1', phase: 'resolving' }) as Record<string, unknown>).done, undefined);
    assert.strictEqual((r.recMerge(answered, { id: 'r1', phase: 'blocked', intervention: { id: 'i1', reason: 'approval_needed', nextActions: [] } }) as Record<string, unknown>).done, true);
    assert.strictEqual((r.recMerge(answered, { id: 'r1', decision: 'x' }) as Record<string, unknown>).done, true);
  });
});

suite('Chat self-healing card (DOM)', () => {
  const blocked = (iv: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    id: 'r1', phase: 'blocked', outcome: 'blocked', attempt: 1, max: 3, category: 'dependency', title: 'Missing module',
    intervention: { id: iv, reason: 'approval_needed', nextActions: [{ action: 'approveInstall', label: 'Approve install' }, { action: 'acceptRisk', label: 'Accept risk' }, { action: 'dismiss', label: 'Dismiss' }] }, ...extra,
  });
  const buttons = (card: MiniElement): string[] => card.querySelectorAll('.rec-final button[data-ra]').map((b) => `${b.dataset.ra}${b.disabled ? ':off' : ''}`);

  test('a second intervention on the same recovery id draws its buttons again', () => {
    const rec = loadRecovery(); const live = liveTurn(rec);
    rec.fns.onRecovery(live, 's1', blocked('i1'), true);
    const card = live.root.querySelector(':scope > .rec')!;
    assert.deepStrictEqual(buttons(card), ['approveInstall', 'dismiss']);
    click(card.querySelector('button[data-ra="approveInstall"]')!);
    assert.strictEqual(rec.posted.length, 1);
    assert.strictEqual(rec.posted[0].type, 'recoveryAction'); assert.strictEqual(rec.posted[0].action, 'approveInstall'); assert.strictEqual(rec.posted[0].recoveryId, 'r1'); assert.strictEqual(rec.posted[0].sessionId, 's1');
    assert.deepStrictEqual(buttons(card), ['approveInstall:off', 'dismiss:off']);
    rec.fns.onRecovery(live, 's1', { id: 'r1', phase: 'blocked', decision: 'waiting' }, true);
    assert.deepStrictEqual(buttons(card), [], 'the answered escalation stays answered');
    rec.fns.onRecovery(live, 's1', { id: 'r1', phase: 'resolving', outcome: undefined }, true);
    rec.fns.onRecovery(live, 's1', blocked('i2', { attempt: 2 }), true);
    assert.strictEqual(live.root.querySelectorAll(':scope > .rec').length, 1, 'still one card per recovery id');
    assert.deepStrictEqual(buttons(card), ['approveInstall', 'dismiss']);
    assert.match(card.querySelector('.rec-final')!.textContent, /Needs you: an approval is needed/);
  });

  test('acceptRisk is offered only for security findings and posts without an in-card confirm', () => {
    const rec = loadRecovery(); const live = liveTurn(rec);
    rec.fns.onRecovery(live, 's1', blocked('i1', { category: 'typescript', intervention: { id: 'i1', reason: 'exhausted', nextActions: [{ action: 'acceptRisk', label: 'Accept risk' }, { action: 'dismiss', label: 'Dismiss' }] } }), true);
    assert.deepStrictEqual(buttons(live.root.querySelector('.rec')!), ['dismiss']);
    rec.fns.onRecovery(live, 's1', { id: 'r2', phase: 'blocked', category: 'security', title: 'Secret in src/a.ts', intervention: { id: 'i2', reason: 'security', nextActions: [{ action: 'acceptRisk', label: 'Accept risk' }] } }, true);
    const sec = live.root.querySelector(':scope > .rec[data-rid="r2"]')!;
    assert.deepStrictEqual(buttons(sec), ['acceptRisk']);
    click(sec.querySelector('button[data-ra="acceptRisk"]')!);
    assert.strictEqual(rec.posted.length, 1, 'the host asks with a modal; the card does not arm a second click');
    assert.strictEqual(rec.posted[0].action, 'acceptRisk'); assert.strictEqual(rec.posted[0].recoveryId, 'r2');
    rec.fns.onRecovery(live, 's1', { id: 'r3', phase: 'blocked', category: 'unknown', intervention: { id: 'i3', reason: 'security', nextActions: [{ action: 'acceptRisk', label: 'Accept risk' }] } }, true);
    assert.deepStrictEqual(buttons(live.root.querySelector(':scope > .rec[data-rid="r3"]')!), ['acceptRisk'], 'a security escalation reason counts too');
  });

  test('stopped cards offer a Rollback per attempt that still has applied patches', () => {
    const rec = loadRecovery(); const live = liveTurn(rec);
    const patches = [{ file: 'src/a.ts', added: 2, removed: 1, attempt: 1 }, { file: 'src/b.ts', added: 1, removed: 0, attempt: 2, result: 'rolled_back' }];
    rec.fns.onRecovery(live, 's1', { id: 'r1', phase: 'fixing', patches }, true);
    const card = live.root.querySelector('.rec')!;
    assert.strictEqual(card.querySelectorAll('button[data-rb]').length, 0, 'no rollback while the recovery runs');
    rec.fns.onRecovery(live, 's1', { id: 'r1', phase: 'incomplete', outcome: 'incomplete' }, true);
    const rb = card.querySelectorAll('.rec-patches button[data-rb]');
    assert.deepStrictEqual(rb.map((b) => b.dataset.rb), ['1'], 'attempt 2 is already rolled back');
    click(rb[0]);
    assert.strictEqual(rec.posted.length, 1);
    assert.strictEqual(rec.posted[0].action, 'rollback'); assert.strictEqual(rec.posted[0].attempt, 1); assert.strictEqual(rec.posted[0].recoveryId, 'r1');
    assert.ok(card.querySelector('button[data-rb="1"]')!.disabled, 'a requested rollback is not sent twice');
    rec.fns.onRecovery(live, 's1', { id: 'r2', phase: 'completed_unverified', outcome: 'completed_unverified', patches: [{ file: 'src/c.ts', added: 1, removed: 1 }] }, true);
    const two = live.root.querySelector(':scope > .rec[data-rid="r2"]')!;
    click(two.querySelector('button[data-rb]')!);
    assert.strictEqual(rec.posted[1].action, 'rollback'); assert.ok(!('attempt' in rec.posted[1]), 'patches without an attempt roll back every fix');
  });

  test('turn_end with an outcome settles a card that is still open', () => {
    const rec = loadRecovery(); const live = liveTurn(rec);
    rec.fns.onRecovery(live, 's1', { id: 'r1', phase: 'fixing', attempt: 1, max: 3, category: 'typescript' }, true);
    const card = live.root.querySelector('.rec')!;
    assert.ok(card.classList.contains('running'));
    rec.fns.recTurnEnd(live, 's1', { outcome: 'incomplete', recovery: { id: 'r1', attempts: 2, report: 'Incomplete: tests fail' } }, true);
    assert.ok(!card.classList.contains('running') && card.classList.contains('bad'));
    assert.match(card.querySelector('.rec-final')!.textContent, /Needs you/);
    assert.strictEqual(rec.state.recovery.get('s1')!.outcome!.outcome, 'incomplete');
    rec.fns.recTurnEnd(live, 's1', { durationMs: 5 }, true);
    assert.strictEqual(rec.state.recovery.get('s1')!.outcome!.outcome, 'incomplete', 'a turn_end without outcome changes nothing');
  });

  test('wrapped child recoveries go to the worker row, a root payload naming a childId to the main card', () => {
    const rec = loadRecovery(); const live = liveTurn(rec);
    const sub = live.root.appendChild(rec.doc.createElement('div')); sub.innerHTML = '<div class="content"><div class="subrows"></div></div>';
    live.subs.set('c1', sub);
    const wrapped = { type: 'recovery', sessionId: 's1', payload: { childId: 'c1', agent: 'worker', inner: 'recovery', data: { id: 'x', phase: 'fixing', category: 'typescript' } } };
    const root = { type: 'recovery', sessionId: 's1', payload: { id: 'r1', phase: 'fixing', childId: 'c1' } };
    assert.strictEqual(rec.fns.wrappedChild(wrapped), true);
    assert.strictEqual(rec.fns.wrappedChild(root), false);
    assert.strictEqual(rec.fns.wrappedChild({ type: 'subagent_start', payload: { childId: 'c1' } }), false);
    rec.fns.onChildRecovery(live, 's1', wrapped.payload, true);
    const mini = sub.querySelector('.subrows > .rec-mini')!;
    assert.ok(mini && mini.classList.contains('running'));
    assert.match(mini.querySelector('.t')!.textContent, /Self-healing · TypeScript · fixing/);
    assert.strictEqual(rec.childStatus.length, 1);
    assert.strictEqual(live.root.querySelectorAll(':scope > .rec').length, 0, 'a worker recovery opens no main card');
    rec.fns.onRecovery(live, 's1', root.payload, true);
    assert.strictEqual(live.root.querySelectorAll(':scope > .rec').length, 1);
  });

  test('the interrupted card names where it stopped and posts a recovery id the host has', () => {
    const rec = loadRecovery();
    rec.state.session = { id: 's1', messages: [] };
    rec.state.interrupted.set('s1', { sessionId: 's1', phase: 'interrupted', attempt: 2, max: 3, category: 'typescript', attempts: [], active: [] });
    rec.fns.renderInterrupted();
    let card = rec.els.messages.querySelector(':scope > .rec-int')!;
    assert.ok(card);
    const title = card.querySelector('.rec-title')!.textContent;
    assert.ok(!/interrupted/.test(title), title);
    assert.strictEqual(title, 'Stopped before it finished · attempt 2/3 · TypeScript');
    click(card.querySelector('button[data-ra="resume"]')!);
    assert.strictEqual(rec.posted[0].recoveryId, 's1'); assert.strictEqual(rec.posted[0].action, 'resume');
    rec.state.interrupted.set('s1', { sid: 'root', phase: 'interrupted', lastPhase: 'validating', attempt: 1, max: 3 });
    rec.fns.renderInterrupted();
    card = rec.els.messages.querySelector(':scope > .rec-int')!;
    assert.match(card.querySelector('.rec-title')!.textContent, /^Stopped while validating · attempt 1\/3/);
    click(card.querySelector('button[data-ra="dismiss"]')!);
    assert.strictEqual(rec.posted[1].recoveryId, 'root');
    assert.strictEqual(rec.els.messages.querySelectorAll('.rec-int').length, 0);
  });

  test('replay attaches the cards only to the answer of the turn they belong to', () => {
    const rec = loadRecovery();
    const turn = (): MiniElement => { const t = rec.els.messages.appendChild(rec.doc.createElement('div')); t.className = 'turn assistant'; t.innerHTML = '<div class="body">answer</div><div class="afoot"><span class="info"></span></div>'; return t; };
    const msgs = [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'x' }, { role: 'user', content: 'hint', meta: { hidden: true } }, { role: 'user', content: 'b' }, { role: 'assistant', content: 'y' }];
    assert.strictEqual(rec.fns.userTurns(msgs, msgs.length), 2);
    rec.state.session = { id: 's1', messages: msgs };
    const c = rec.fns.recCache('s1') as { cards: Map<string, unknown>; outcome: unknown; at?: number };
    c.cards.set('r1', rec.fns.recMerge(undefined, { id: 'r1', phase: 'completed', outcome: 'completed', attempt: 1 }));
    c.at = 2;
    turn(); const last = turn();
    rec.fns.recReplay('s1');
    assert.strictEqual(last.querySelectorAll(':scope > .rec').length, 1);
    // Cut back to the first turn (checkpoint restore): the cards must not move onto the earlier answer.
    rec.els.messages.innerHTML = '';
    rec.state.session = { id: 's1', messages: msgs.slice(0, 2) };
    const first = turn();
    rec.fns.recReplay('s1');
    assert.strictEqual(first.querySelectorAll('.rec').length, 0);
    assert.ok(!rec.state.recovery.has('s1'), 'the stale cache is dropped');
  });
});

suite('Chat self-healing card: run-card details', () => {
  test('a failed check with an excerpt expands; patch rows open their diff; Details opens the dashboard', () => {
    const rec = loadRecovery(); const live = liveTurn(rec);
    rec.fns.onRecovery(live, 's1', { id: 'r1', phase: 'validating', checks: [{ id: 'test', status: 'failed', ms: 300, excerpt: 'AssertionError: 1 !== 2' }, { id: 'lint', status: 'passed' }], patches: [{ file: 'src/a.ts', added: 1, removed: 0 }] }, true);
    const card = live.root.querySelector('.rec')!;
    assert.strictEqual(card.querySelectorAll('[data-ex]').length, 1, 'only the failed check expands');
    click(card.querySelector('[data-ex="test"]')!);
    assert.strictEqual(card.querySelector('.rec-ex')!.textContent, 'AssertionError: 1 !== 2');
    click(card.querySelector('[data-ex="test"]')!);
    assert.strictEqual(card.querySelectorAll('.rec-ex').length, 0, 'a second click folds it');
    click(card.querySelector('.rec-patches li[data-file] .f')!);
    assert.deepStrictEqual(rec.posted.pop(), { type: 'showDiff', sessionId: 's1', fsPath: 'src/a.ts' });
    click(card.querySelector('.rec-details')!);
    assert.deepStrictEqual(rec.posted.pop(), { type: 'openRecovery', sessionId: 's1' });
  });

  test('a git conflict lists its files with a merge editor each and keeps Resume off until resolved', () => {
    const rec = loadRecovery(); const live = liveTurn(rec);
    rec.fns.onRecovery(live, 's1', { id: 'g1', phase: 'blocked', outcome: 'blocked', category: 'git_conflict', title: 'Git conflict', intervention: { id: 'i1', reason: 'git_conflict', files: ['src/a.ts', 'README.md'], next: 'Resolve, then Resume.', nextActions: [{ action: 'openMergeEditor', label: 'Open merge editor' }, { action: 'resume', label: 'Resume after resolving' }, { action: 'dismiss', label: 'Dismiss' }] } }, true);
    const card = live.root.querySelector('.rec')!;
    assert.deepStrictEqual(card.querySelectorAll('.rec-conflicts li').map((li) => li.dataset.file), ['src/a.ts', 'README.md']);
    assert.match(card.querySelector('.rec-next')!.textContent, /Resolve, then Resume/);
    assert.deepStrictEqual(card.querySelectorAll('.rec-final button[data-ra]').map((b) => `${b.dataset.ra}${b.disabled ? ':off' : ''}`), ['resume:off', 'dismiss'], 'the per-file buttons replace the generic one');
    assert.ok(rec.posted.some((m) => m.type === 'checkConflicts' && m.sessionId === 's1'), 'asks the host which files are still unmerged');
    click(card.querySelector('button[data-merge="README.md"]')!);
    const sent = rec.posted.pop()!;
    assert.strictEqual(sent.action, 'openMergeEditor'); assert.strictEqual(sent.file, 'README.md'); assert.strictEqual(sent.recoveryId, 'g1');
  });

  test('without a recovery to resume the interrupted card falls through to the run card', () => {
    const rec = loadRecovery();
    rec.state.session = { id: 's1', messages: [] };
    rec.fns.renderInterrupted();
    assert.strictEqual(rec.els.messages.querySelectorAll('.rec-int').length, 0, 'nothing to show, and no ReferenceError outside the section');
  });

  // A model failure is one card: the error box the turn already shows gains the escalation's next step, with no second
  // "Self-healing" card and no Detect → … → Regression stepper (no code-fix stage ran).
  const modelEsc = (reason: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    id: 'm1', phase: 'failed', outcome: 'failed', checks: [], patches: [],
    intervention: { id: 'iv1', reason, next: 'start the model server, then "Retry".', nextActions: [{ action: 'retry', label: 'Retry' }, { action: 'startServer', label: 'Start server' }] }, ...extra,
  });
  const errBox = (rec: Rec, root: MiniElement): MiniElement => {
    const box = root.insertBefore(rec.doc.createElement('div'), root.querySelector(':scope > .body'));
    box.className = 'error-box'; box.innerHTML = '<div class="err-head"><b>Something went wrong</b></div><span class="msg">x</span>';
    return box;
  };

  test('a model escalation folds into the error box instead of drawing a second card', () => {
    for (const reason of ['model_unavailable', 'model_rejected', 'credentials']) {
      const rec = loadRecovery(); const live = liveTurn(rec); const box = errBox(rec, live.root);
      rec.fns.onRecovery(live, 's1', modelEsc(reason), true);
      assert.strictEqual(live.root.querySelectorAll(':scope > .rec').length, 0, `${reason}: no self-healing card`);
      assert.match(box.querySelector(':scope > .err-next')!.textContent, /Start the model server/);
    }
    // The escalation arriving first (its card already drawn) folds once the error box exists.
    const rec = loadRecovery(); const live = liveTurn(rec);
    rec.fns.onRecovery(live, 's1', modelEsc('model_unavailable'), true);
    assert.strictEqual(live.root.querySelectorAll(':scope > .rec').length, 1);
    const box = errBox(rec, live.root); rec.fns.foldRecCards(live.root);
    assert.strictEqual(live.root.querySelectorAll(':scope > .rec').length, 0);
    assert.ok(box.querySelector(':scope > .err-next'));
  });

  test('model recoveries hide the healing stepper; code-healing escalations keep their card and stepper', () => {
    const rec = loadRecovery(); const live = liveTurn(rec);
    rec.fns.onRecovery(live, 's1', { id: 'm2', phase: 'retrying', category: 'model_unavailable', attempt: 1, max: 3, decision: 'retry in 1s' }, true);
    assert.ok(live.root.querySelector(':scope > .rec[data-rid="m2"]')!.classList.contains('model'));
    const live2 = liveTurn(rec); errBox(rec, live2.root);
    rec.fns.onRecovery(live2, 's1', { id: 'c1', phase: 'incomplete', outcome: 'incomplete', attempt: 3, max: 3, category: 'typescript', patches: [{ file: 'a.ts', added: 1, removed: 0 }], intervention: { id: 'i9', reason: 'exhausted', nextActions: [{ action: 'retryWithGuidance', label: 'Retry with guidance' }] } }, true);
    const card = live2.root.querySelector(':scope > .rec[data-rid="c1"]')!;
    assert.ok(card, 'a code-healing escalation keeps its card');
    assert.ok(!card.classList.contains('model'));
    assert.ok(card.querySelector('.rec-stepper'));
  });

  test('a model escalation\'s Retry on a card sends the last message again instead of an unknown recovery action', () => {
    const rec = loadRecovery(); const live = liveTurn(rec);
    rec.fns.onRecovery(live, 's1', modelEsc('model_unavailable'), true);
    click(live.root.querySelector('.rec-final button[data-ra="retry"]')!);
    assert.deepStrictEqual(rec.posted.map((m) => m.type), ['retry']);
  });

  test('replay folds a model escalation into the failed turn\'s error box', () => {
    const rec = loadRecovery();
    rec.state.session = { id: 's1', messages: [{ role: 'user', content: 'a' }, { role: 'assistant', content: '(error: x)', meta: { error: 'x' } }] };
    const c = rec.fns.recCache('s1') as { cards: Map<string, unknown>; at?: number };
    c.cards.set('m1', rec.fns.recMerge(undefined, modelEsc('model_rejected', { intervention: { id: 'iv2', reason: 'model_rejected', next: 'pick another model', nextActions: [{ action: 'pickModel', label: 'Pick another model' }] } })));
    const t = rec.els.messages.appendChild(rec.doc.createElement('div')); t.className = 'turn assistant';
    const box = errBox(rec, t);
    rec.fns.recReplay('s1');
    assert.strictEqual(t.querySelectorAll('.rec').length, 0);
    assert.match(box.querySelector('.err-next')!.textContent, /Pick another model/);
  });
});

suite('Chat error box: friendly message first, raw provider text apart', () => {
  const src = fs.readFileSync(path.join(EXT_ROOT, 'media', 'chat.js'), 'utf8');
  const start = src.indexOf('  function splitErr('); const end = src.indexOf('  function errorHead(');
  const sb: Record<string, unknown> = {};
  vm.runInNewContext(`${src.slice(start, end)}\nout_ = splitErr;`, sb);
  const split = sb.out_ as (t: string) => { text: string; raw: string; missing: string };

  test('a bare JSON body is read for its message, the JSON goes to Details', () => {
    const r = split('{"error":"model \'gemma4:12b\' not found"}');
    assert.strictEqual(r.missing, 'gemma4:12b');
    assert.match(r.text, /^The model gemma4:12b is not installed/);
    assert.strictEqual(r.raw, '{"error":"model \'gemma4:12b\' not found"}');
    assert.strictEqual(split('{"error":{"message":"bad deployment"}}').text, 'The model server said: bad deployment');
  });

  test('describeModelError\'s trailing detail moves to Details; plain messages stay whole', () => {
    const a = split('Could not reach the model server for x. Check that it is running and try again. (fetch failed: ECONNREFUSED 127.0.0.1:11434)');
    assert.strictEqual(a.text, 'Could not reach the model server for x. Check that it is running and try again.');
    assert.strictEqual(a.raw, 'fetch failed: ECONNREFUSED 127.0.0.1:11434');
    const b = split('The provider rejected the request for gpt-5-mini (HTTP 400 from https://h/x: {"error":{"code":"DeploymentNotFound"}})');
    assert.strictEqual(b.text, 'The provider rejected the request for gpt-5-mini.');
    assert.match(b.raw, /^HTTP 400 from https:\/\/h\/x: \{"error"/);
    assert.deepStrictEqual({ ...split('gemma4:12b stopped responding. The model produced nothing for 180s.') }, { text: 'gemma4:12b stopped responding. The model produced nothing for 180s.', raw: '', missing: '' });
  });
});
