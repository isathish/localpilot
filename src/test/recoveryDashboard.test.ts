import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';
import { click, MiniElement, miniDocument } from './miniDom';
import { handleMemoryReuse, handleOpenRecoveryDiff, handleRecoveryAction, loadRecovery, parseMemoryReuse, parseOpenRecoveryDiff, parseRecoveryAction, RecoveryHooks, RecoveryToast, recoveryDays } from '../ui/recoveryDashboardBridge';

const EXT_ROOT = path.resolve(__dirname, '..', '..');

/** Element with the DOM bits the dashboard code uses beyond ./miniDom: `id` as an attribute, append/replaceChildren, lastChild. */
class El extends MiniElement {
  get id(): string { return this.getAttribute('id') || ''; }
  set id(v: string) { this.setAttribute('id', v); }
  get lastChild(): MiniElement | null { const c = this.childNodes[this.childNodes.length - 1]; return c instanceof MiniElement ? c : null; }
  append(...nodes: MiniElement[]): void { for (const n of nodes) { this.appendChild(n); } }
  replaceChildren(...nodes: MiniElement[]): void { for (const c of [...this.childNodes]) { this.removeChild(c); } this.append(...nodes); }
  contains(n: unknown): boolean { for (let e = n as MiniElement | null; e; e = e.parentNode) { if (e === this) { return true; } } return false; }
  override focus(): void { focusTarget.activeElement = this; }
}
/** The sandbox's `document.activeElement`, moved by El.focus. */
const focusTarget: { activeElement: MiniElement | null } = { activeElement: null };

interface Sandbox {
  fns: Record<string, (...a: unknown[]) => unknown>;
  state: { section: string; rec: Record<string, unknown> & { data: unknown; tab: string; cat: string; open: Record<string, boolean>; reuse: Record<string, boolean> } };
  root: El;
  posted: Record<string, unknown>[];
  rendered: number[];
  doc: { activeElement: MiniElement | null };
}

/** The Self-healing & recovery section of `media/settings.js`, lifted out of the IIFE and run against ./miniDom. */
function loadSection(): Sandbox {
  const src = fs.readFileSync(path.join(EXT_ROOT, 'media', 'settings.js'), 'utf8');
  const start = src.indexOf('  // ------------------------------------------------------------------ self-healing & recovery (dashboard)');
  const end = src.indexOf('  // ------------------------------------------------------------------ end self-healing & recovery');
  assert.ok(start > 0 && end > start, 'self-healing & recovery section not found in media/settings.js');
  const frameAt = src.indexOf('  function chartFrame(');
  const frameEnd = src.indexOf('  /** Donut', frameAt);
  assert.ok(frameAt > 0 && frameEnd > frameAt, 'chartFrame not found');
  const line = (prefix: string): string => { const l = src.split('\n').find((x) => x.trim().startsWith(prefix)); assert.ok(l, `${prefix} not found in media/settings.js`); return l; };
  const labels = src.slice(src.indexOf('  const HEAL_CAT_LABEL = {'), src.indexOf('  };', src.indexOf('  const HEAL_CAT_LABEL = {')) + 4);
  const doc = miniDocument();
  const body = doc.body.appendChild(new El('div'));
  const root = body.appendChild(new El('div')); root.id = 'dash-rec';
  const all = (): MiniElement[] => [body, ...body.querySelectorAll('*')];
  const document = {
    createElement: (tag: string) => new El(tag),
    getElementById: (id: string) => all().find((e) => e.getAttribute('id') === id) || null,
    querySelector: (sel: string) => body.querySelector(sel),
    querySelectorAll: (sel: string) => body.querySelectorAll(sel),
    get activeElement() { return focusTarget.activeElement; },
  };
  focusTarget.activeElement = null;
  const posted: Record<string, unknown>[] = []; const rendered: number[] = [];
  const state = { section: 'dashboard', rec: { data: null, error: '', loaded: false, tab: 'history', cat: '', open: {}, reuse: {}, ro: null, raf: 0 } };
  const icon = '<svg></svg>';
  const sandbox: Record<string, unknown> = {
    document, state,
    I: new Proxy({}, { get: () => icon }),
    post: (m: Record<string, unknown>) => posted.push(JSON.parse(JSON.stringify(m))),
    render: () => rendered.push(1),
    kpi: (label: string, value: string, sub: string, _sp: string, tone: string) => `<div class="kpi ${tone || ''}"><div class="kpi-l">${label}</div><div class="kpi-v">${value}</div><div class="kpi-s">${sub || ''}</div></div>`,
    fmtN: (n: number) => String(n), fmtMs: (ms: number) => `${ms} ms`, pct: (p: number) => `${Math.round(p)}%`, fmtTime: () => '12:00:00',
    skeleton: (text: string) => { const e = new El('div'); e.className = 'skel'; e.textContent = text; return e; },
    drawCharts: (r: MiniElement) => { for (const s of r.querySelectorAll('.chart-slot')) { (s as unknown as { _draw(): void })._draw(); } },
    chartSlot: (draw: (w: number) => { html: string; data: unknown }) => { const s = new El('div'); s.className = 'chart-slot'; (s as unknown as { _draw(): void })._draw = () => { const r = draw(400); s.innerHTML = r.html; (s as unknown as { _data: unknown })._data = r.data; }; return s; },
    niceMax: (v: number) => Math.max(1, v),
  };
  const code = `${line('const esc = ')}\n${line('const plural = ')}\nconst el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) { e.className = cls; } if (html !== undefined) { e.innerHTML = html; } return e; };\n${labels}\n${src.slice(frameAt, frameEnd)}\n${src.slice(start, end)}\nout_ = { renderRecovery, hbarChart, diffHtml };`;
  vm.runInNewContext(code, sandbox, { timeout: 5_000 });
  return { fns: sandbox.out_ as Sandbox['fns'], state: state as unknown as Sandbox['state'], root, posted, rendered, doc: focusTarget };
}

const iv = (over: Record<string, unknown> = {}) => ({ id: 'i_1', sessionId: 's_aaaaaaaa11', reason: 'approval_needed', category: 'dependency', title: 'Missing package zod', rootCause: "imports 'zod'", attemptsSummary: 'install declined', patches: 0, nextActions: [{ action: 'approveInstall', label: 'Approve install' }, { action: 'retryWithGuidance', label: 'Retry with guidance' }, { action: 'acceptRisk', label: 'Accept risk' }, { action: 'dismiss', label: 'Dismiss' }], createdAt: 1, ...over });

function dashboard(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    days: 7, generatedAt: 1,
    tiles: { enabled: true, detected: 4, recovered: 3, pendingIntervention: 1, rate: 75, mttrP50: 90000 },
    config: { autoDetect: true, autoRetry: false, autoFix: true, regressionRequired: true, securityBypass: false, maxRepairAttempts: 3 },
    current: [{ sessionId: 's_bbbbbbbb22', title: 'Pagination', phase: 'fixing', attempt: 2, max: 3, category: 'typescript', key: 'TS2345@src/api/user.ts', updatedAt: 1 }],
    failureHistory: [
      { t: 1, sessionId: 's_bbbbbbbb22', category: 'typescript', severity: 'high', signature: 'a1', key: 'TS2345@src/api/user.ts', outcome: 'fixed', source: 'store' },
      { t: 2, sessionId: 's_cccccccc33', category: 'unit_test', signature: 'b2', key: 'adds <b>rows</b>@src/x.test.ts', outcome: 'escalated', source: 'store' },
    ],
    categories: ['typescript', 'unit_test'],
    rca: [{ sessionId: 's_bbbbbbbb22', attempt: 1, category: 'typescript', signature: 'a1', key: 'TS2345@src/api/user.ts', failure: 'Argument of type number', rootCause: 'caller passes a number', strategy: 'fix', mode: 'inline', result: 'fixed', memoryUsed: 'm_7', t: 1 }],
    attempts: [{ sessionId: 's_bbbbbbbb22', turnKey: 0, phase: 'completed', outcome: 'completed', startedAt: 1, updatedAt: 2, attempts: [{ n: 1, category: 'typescript', key: 'TS2345@src/api/user.ts', strategy: 'fix', mode: 'inline', startedAt: 1, endedAt: 2, durationMs: 1, result: 'fixed', adjust: ['context 8192'], patches: 1 }], perCategory: [{ category: 'typescript', count: 1 }], approvals: [], acceptedRisks: [{ by: 'user', at: 1, signatures: ['d4'], keys: ['secret@src/k.ts'] }] }],
    patches: [{ sessionId: 's_bbbbbbbb22', attempt: 1, file: 'src/api/user.ts', added: 1, removed: 1, result: 'kept', diffHash: 'h1', preview: '--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a<script>\n+b', t: 1 }],
    retryConfig: [{ category: 'unit_test', cls: 'deterministic', strategy: 'fix', attempts: 4, defaultAttempts: 3, backoffMs: [], exponential: false, overridden: true }, { category: 'git_conflict', cls: 'deterministic', strategy: 'escalate', attempts: 0, defaultAttempts: 0, backoffMs: [], exponential: false, overridden: false }],
    regression: [{ sessionId: 's_bbbbbbbb22', attempt: 1, t: 1, before: 2, after: 1, fixed: ['TS2345@src/api/user.ts'], introduced: [], preexisting: ['lint@src/old.ts'], foreign: ['TS2304@src/billing.ts'], durationMs: 10 }],
    interventions: [iv(), iv({ id: 'i_2', sessionId: 's_dddddddd44', reason: 'security', category: 'security', title: 'Secret in src/k.ts' })],
    analytics: { rateByCategory: [{ category: 'typescript', detected: 3, recovered: 3, rate: 100 }, { category: 'unit_test', detected: 1, recovered: 0, rate: 0 }], attemptsDistribution: [{ attempts: 1, tasks: 3 }], mttr: { p50: 90000, p90: 200000 }, topSignatures: [{ signature: 'a1', key: 'TS2345@src/api/user.ts', count: 2, recovered: 2 }], memory: { suggested: 2, succeeded: 1, hitRate: 50 }, acceptedRisks: 1, source: 'telemetry' },
    ...over,
  };
}

suite('Recovery dashboard bridge', () => {
  test('recovery actions are validated against the queue actions', () => {
    assert.deepStrictEqual(parseRecoveryAction({ sessionId: 's1', action: 'resume', id: 'i1' }), { sessionId: 's1', action: 'resume', id: 'i1' });
    assert.deepStrictEqual(parseRecoveryAction({ sessionId: 's1', action: 'dismiss' }), { sessionId: 's1', action: 'dismiss' });
    assert.strictEqual(parseRecoveryAction({ sessionId: 's1', action: 'retryWithGuidance' }), undefined, 'guidance needs the chat card');
    assert.strictEqual(parseRecoveryAction({ sessionId: 's1', action: 'rm -rf' }), undefined);
    assert.strictEqual(parseRecoveryAction({ sessionId: '', action: 'resume' }), undefined);
    assert.strictEqual(parseRecoveryAction({ sessionId: 's1\nx', action: 'resume' }), undefined);
    assert.strictEqual(parseRecoveryAction({ sessionId: 7, action: 'resume' }), undefined);
  });

  test('memory reuse needs an id and a boolean', () => {
    assert.deepStrictEqual(parseMemoryReuse({ id: 'm_1', allowed: false }), { id: 'm_1', allowed: false });
    assert.strictEqual(parseMemoryReuse({ id: 'm_1', allowed: 'no' }), undefined);
    assert.strictEqual(parseMemoryReuse({ allowed: true }), undefined);
  });

  test('the All range becomes a long day count; ranges are whole days', () => {
    assert.strictEqual(recoveryDays(0), 3650);
    assert.strictEqual(recoveryDays(-1), 3650);
    assert.strictEqual(recoveryDays(Number.NaN), 3650);
    assert.strictEqual(recoveryDays(7.6), 7);
  });

  test('loadRecovery reports data, errors, or nothing without a provider', async () => {
    assert.deepStrictEqual(await loadRecovery(undefined, 7), {});
    let asked = -1;
    const r = await loadRecovery(async (d) => { asked = d; return dashboard() as never; }, 0);
    assert.strictEqual(asked, 3650);
    assert.ok(r.recovery);
    assert.deepStrictEqual(await loadRecovery(async () => { throw new Error('store unreadable'); }, 7), { recoveryError: 'store unreadable' });
  });

  /** Hooks recording every call, with the toasts posted and the refreshes asked for. */
  function harness(over: Partial<RecoveryHooks> = {}) {
    const calls: unknown[][] = []; const toasts: RecoveryToast[] = []; let refreshed = 0; let asked = 0;
    const hooks: RecoveryHooks = {
      onRecoveryAction: async (...a) => { calls.push(['action', ...a]); return true; },
      onMemoryReuse: async (...a) => { calls.push(['memory', ...a]); return true; },
      confirmRisk: async () => { asked++; return true; },
      ...over,
    };
    return { hooks, calls, toasts, post: (t: RecoveryToast) => toasts.push(t), refresh: async () => { refreshed++; }, get refreshed() { return refreshed; }, get asked() { return asked; } };
  }

  test('a thrown recovery action still refreshes the dashboard and reports the error', async () => {
    const h = harness({ onRecoveryAction: async () => { throw new Error('session gone'); } });
    await handleRecoveryAction({ sessionId: 's1', action: 'resume' }, h.hooks, h.post, h.refresh);
    assert.strictEqual(h.refreshed, 1);
    assert.deepStrictEqual(h.toasts.map((t) => t.level), ['error']);
    assert.match(h.toasts[0].text, /session gone/);
  });

  test('an action the host did not run (false) posts no done toast', async () => {
    const h = harness({ onRecoveryAction: async () => false });
    await handleRecoveryAction({ sessionId: 's1', action: 'rollback', id: 'i1' }, h.hooks, h.post, h.refresh);
    assert.deepStrictEqual(h.toasts, []);
    assert.strictEqual(h.refreshed, 1);
    const ok = harness();
    await handleRecoveryAction({ sessionId: 's1', action: 'rollback', id: 'i1' }, ok.hooks, ok.post, ok.refresh);
    assert.deepStrictEqual(ok.calls, [['action', 's1', 'rollback', 'i1']]);
    assert.deepStrictEqual(ok.toasts, [{ type: 'toast', level: 'info', text: 'Rolled back the fixes' }]);
  });

  test('accepting a risk is confirmed in the panel; declined means no call, no audit, no toast', async () => {
    const h = harness({ confirmRisk: async () => false });
    await handleRecoveryAction({ sessionId: 's1', action: 'acceptRisk', id: 'i1' }, h.hooks, h.post, h.refresh);
    assert.deepStrictEqual(h.calls, [], 'the hook (which audits) is not reached');
    assert.deepStrictEqual(h.toasts, []);
    assert.strictEqual(h.refreshed, 1, 'the disabled buttons come back');
    const yes = harness();
    await handleRecoveryAction({ sessionId: 's1', action: 'acceptRisk', id: 'i1' }, yes.hooks, yes.post, yes.refresh);
    assert.strictEqual(yes.asked, 1);
    assert.deepStrictEqual(yes.calls, [['action', 's1', 'acceptRisk', 'i1']]);
    const other = harness();
    await handleRecoveryAction({ sessionId: 's1', action: 'dismiss', id: 'i1' }, other.hooks, other.post, other.refresh);
    assert.strictEqual(other.asked, 0, 'only accepting a risk asks');
  });

  test('unknown actions and missing hooks report an error and refresh', async () => {
    const h = harness();
    await handleRecoveryAction({ sessionId: 's1', action: 'rm -rf' }, h.hooks, h.post, h.refresh);
    assert.deepStrictEqual(h.toasts, [{ type: 'toast', level: 'error', text: 'Unknown recovery action' }]);
    assert.deepStrictEqual(h.calls, []);
    const none = harness({ onRecoveryAction: undefined, onMemoryReuse: undefined });
    await handleRecoveryAction({ sessionId: 's1', action: 'resume' }, none.hooks, none.post, none.refresh);
    await handleMemoryReuse({ id: 'm_1', allowed: false }, none.hooks, none.post, none.refresh);
    assert.deepStrictEqual(none.toasts.map((t) => t.text), ['Self-healing is not available in this window', 'Failure memory is not available in this window']);
    assert.strictEqual(none.refreshed, 2);
  });

  test('memory reuse reports a vanished entry and refreshes either way', async () => {
    const gone = harness({ onMemoryReuse: async () => false });
    await handleMemoryReuse({ id: 'm_1', allowed: true }, gone.hooks, gone.post, gone.refresh);
    assert.deepStrictEqual(gone.toasts, [{ type: 'toast', level: 'warn', text: 'That memory entry no longer exists' }]);
    assert.strictEqual(gone.refreshed, 1);
    const h = harness();
    await handleMemoryReuse({ id: 'm_1', allowed: false }, h.hooks, h.post, h.refresh);
    assert.deepStrictEqual(h.calls, [['memory', 'm_1', false]]);
    assert.match(h.toasts[0].text, /will not be suggested again/);
  });

  test('open diff validates the patch and needs the hook', async () => {
    assert.deepStrictEqual(parseOpenRecoveryDiff({ sessionId: 's1', attempt: 2, file: 'src/a.ts' }), { sessionId: 's1', attempt: 2, file: 'src/a.ts' });
    assert.strictEqual(parseOpenRecoveryDiff({ sessionId: 's1', attempt: 0, file: 'src/a.ts' }), undefined);
    assert.strictEqual(parseOpenRecoveryDiff({ sessionId: 's1', attempt: 1.5, file: 'src/a.ts' }), undefined);
    const none = harness();
    await handleOpenRecoveryDiff({ sessionId: 's1', attempt: 1, file: 'a.ts' }, none.hooks, none.post);
    assert.match(none.toasts[0].text, /not available/);
    const opened: unknown[] = [];
    const h = harness({ openRecoveryDiff: async (...a) => { opened.push(a); } });
    await handleOpenRecoveryDiff({ sessionId: 's1', attempt: 1, file: 'a.ts' }, h.hooks, h.post);
    assert.deepStrictEqual(opened, [['s1', 1, 'a.ts']]);
    assert.deepStrictEqual(h.toasts, []);
  });
});

suite('Dashboard: Self-healing & recovery group', () => {
  const show = (sb: Sandbox, data: Record<string, unknown> | null, tab = 'history') => { sb.state.rec.data = data; sb.state.rec.loaded = true; sb.state.rec.tab = tab; sb.fns.renderRecovery(); return sb.root; };

  test('loading, unavailable and error states', () => {
    const sb = loadSection();
    sb.fns.renderRecovery();
    assert.match(sb.root.textContent, /Loading recovery data/);
    sb.state.rec.loaded = true; sb.fns.renderRecovery();
    assert.match(sb.root.textContent, /not available in this window/);
    sb.state.rec.error = 'EACCES'; sb.fns.renderRecovery();
    assert.match(sb.root.querySelector('[role="alert"]')!.textContent, /Could not load recovery data: EACCES/);
  });

  test('tiles carry the single recovery-rate definition; config row locks the security bypass', () => {
    const root = show(loadSection(), dashboard());
    const tiles = root.querySelectorAll('.rec-kpis > .kpi');
    assert.deepStrictEqual(tiles.map((t) => t.querySelector('.kpi-l')!.textContent), ['Engine', 'Failures detected', 'Recovered', 'Pending intervention', 'Recovery rate', 'Mean time to recover']);
    assert.strictEqual(tiles[4].querySelector('.kpi-v')!.textContent, '75%');
    assert.match(tiles[4].title, /recovered ÷ \(recovered \+ escalated \+ exhausted \+ blocked\)/);
    assert.match(tiles[3].className, /warn/, 'a waiting intervention is flagged');
    const cfg = root.querySelector('.rec-cfgs')!;
    assert.match(cfg.querySelector('.rec-cfg.locked')!.textContent, /Security bypass: disabled/);
    assert.match(cfg.textContent, /Automatic retry: off/);
    assert.match(cfg.textContent, /Max repair attempts 3/);
    assert.match(root.querySelector('.rec-current')!.textContent, /attempt 2\/3/);
  });

  test('eight views as tabs; switching keeps one tabpanel', () => {
    const sb = loadSection();
    const root = show(sb, dashboard());
    const tabs = root.querySelectorAll('[role="tab"]');
    assert.strictEqual(tabs.length, 8);
    assert.deepStrictEqual(tabs.filter((t) => t.getAttribute('aria-selected') === 'true').map((t) => t.dataset.tab), ['history']);
    click(tabs.find((t) => t.dataset.tab === 'retry')!);
    assert.strictEqual(sb.state.rec.tab, 'retry');
    assert.strictEqual(root.querySelectorAll('[role="tabpanel"]').length, 1);
    assert.match(root.querySelector('#rec-panel')!.textContent, /Failing unit tests override4 default 3/);
    assert.match(root.querySelector('#rec-panel')!.textContent, /goes to you/);
  });

  test('failure history shows resolved keys, filters by category and switches a remembered fix off', () => {
    const sb = loadSection();
    const root = show(sb, dashboard());
    const rows = () => root.querySelectorAll('#rec-panel tbody tr');
    assert.strictEqual(rows().length, 2);
    assert.match(root.querySelector('#rec-panel')!.innerHTML, /adds &lt;b&gt;rows&lt;\/b&gt;@src\/x\.test\.ts/, 'keys are escaped');
    const sel = root.querySelector('#rec-panel select')!; sel.value = 'typescript'; (sel.onchange as () => void)();
    assert.strictEqual(rows().length, 1);
    assert.match(rows()[0].textContent, /TS2345@src\/api\/user\.ts/);
    click(rows()[0].querySelector('button[data-memory="m_7"]')!);
    assert.deepStrictEqual(sb.posted.pop(), { type: 'memoryReuse', id: 'm_7', allowed: false });
    assert.match(root.querySelector('button[data-memory="m_7"]')!.textContent, /Suggest again/);
  });

  test('a memory entry switched off in the store shows "Suggest again" after a reload', () => {
    const sb = loadSection();
    const base = dashboard();
    const rca = (base.rca as Record<string, unknown>[]).map((x) => ({ ...x, memoryReuseAllowed: false }));
    const root = show(sb, dashboard({ rca }));
    const btn = () => root.querySelector('button[data-memory="m_7"]')!;
    assert.match(btn().textContent, /Suggest again/);
    click(btn());
    assert.deepStrictEqual(sb.posted.pop(), { type: 'memoryReuse', id: 'm_7', allowed: true });
    assert.match(btn().textContent, /Don’t suggest again/);
    sb.state.rec.reuse = {}; sb.fns.renderRecovery();
    assert.match(btn().textContent, /Suggest again/, 'the stored value wins once the click is cleared');
  });

  test('every queue card can be dismissed, also when its reason lists no dismiss', () => {
    const sb = loadSection();
    const root = show(sb, dashboard({ interventions: [iv({ id: 'i_3', reason: 'credentials', category: 'model', nextActions: [{ action: 'setApiKey', label: 'Set API key' }] }), iv({ id: 'i_4', reason: 'security', category: 'security', nextActions: [{ action: 'acceptRisk', label: 'Accept risk' }] }), iv()] }), 'queue');
    const cards = root.querySelectorAll('.rec-iv');
    assert.strictEqual(cards.length, 3);
    for (const c of cards) { assert.strictEqual(c.querySelectorAll('button[data-ra="dismiss"]').length, 1, `${c.dataset.iv} has one Dismiss`); }
    click(cards[0].querySelector('button[data-ra="dismiss"]')!);
    assert.deepStrictEqual(sb.posted.pop(), { type: 'recoveryAction', sessionId: 's_aaaaaaaa11', action: 'dismiss', id: 'i_3' });
  });

  test('opened details and focus survive the refresh', () => {
    const sb = loadSection();
    const data = dashboard({ interventions: [iv({ evidence: 'npm ERR! 404' })] });
    let root = show(sb, data, 'queue');
    const ev = () => root.querySelector('details[data-open="iv:i_1"]')!;
    assert.ok(ev());
    assert.strictEqual(ev().hasAttribute('open'), false);
    (ev() as unknown as { open: boolean }).open = true; (ev().ontoggle as () => void)();
    assert.strictEqual(sb.state.rec.open['iv:i_1'], true);
    (root.querySelector('[data-iv="i_1"] button[data-ra="dismiss"]') as El).focus();
    root = show(sb, data, 'queue');
    assert.ok(ev().hasAttribute('open'), 'Evidence stays open');
    const f = sb.doc.activeElement!;
    assert.ok(f && root.contains(f), 'focus is on the rebuilt panel');
    assert.strictEqual(f.dataset.ra, 'dismiss');
    const approvals = dashboard({ attempts: [{ ...(dashboard().attempts as Record<string, unknown>[])[0], approvals: [{ at: 1, kind: 'install', command: 'npm i zod', decision: 'approved' }] }] });
    sb.state.rec.open['ap:s_bbbbbbbb22|0'] = true;
    root = show(sb, approvals, 'attempts');
    assert.ok(root.querySelector('details[data-open="ap:s_bbbbbbbb22|0"]')!.hasAttribute('open'));
  });

  test('applied patches have Open diff, disabled when the window cannot open one', () => {
    const sb = loadSection();
    let root = show(sb, dashboard(), 'patches');
    assert.strictEqual(root.querySelector('button[data-opendiff="0"]')!.disabled, true);
    (sb.state.rec as Record<string, unknown>).canDiff = true;
    root = show(sb, dashboard(), 'patches');
    const b = root.querySelector('button[data-opendiff="0"]')!;
    assert.strictEqual(b.disabled, false);
    click(b);
    assert.deepStrictEqual(sb.posted.pop(), { type: 'openRecoveryDiff', sessionId: 's_bbbbbbbb22', attempt: 1, file: 'src/api/user.ts' });
  });

  test('intervention queue: actions post with the intervention, accept risk only for security, guidance stays in chat', () => {
    const sb = loadSection();
    const root = show(sb, dashboard(), 'queue');
    const cards = root.querySelectorAll('.rec-iv');
    const acts = (c: MiniElement) => c.querySelectorAll('button[data-ra]').map((b) => b.dataset.ra);
    assert.deepStrictEqual(acts(cards[0]), ['approveInstall', 'dismiss', 'openChat']);
    assert.deepStrictEqual(acts(cards[1]), ['approveInstall', 'acceptRisk', 'dismiss', 'openChat']);
    assert.match(cards[1].querySelector('button[data-ra="acceptRisk"]')!.className, /danger/);
    click(cards[0].querySelector('button[data-ra="approveInstall"]')!);
    assert.deepStrictEqual(sb.posted.pop(), { type: 'recoveryAction', sessionId: 's_aaaaaaaa11', action: 'approveInstall', id: 'i_1' });
    assert.ok(cards[0].querySelectorAll('button').every((b) => b.disabled), 'buttons wait for the refresh');
    assert.match(root.querySelector('.rec-risks')!.textContent, /secret@src\/k\.ts/);
  });

  test('applied patches preview an escaped diff with marked lines', () => {
    const sb = loadSection();
    const root = show(sb, dashboard(), 'patches');
    assert.strictEqual(root.querySelector('.rec-diff'), null);
    click(root.querySelector('button[data-patch="0"]')!);
    const pre = root.querySelector('.rec-diff')!;
    assert.ok(pre);
    assert.match(pre.innerHTML, /a&lt;script&gt;/);
    assert.strictEqual(pre.querySelectorAll('span.add').length, 1);
    assert.strictEqual(pre.querySelectorAll('span.del').length, 1);
    assert.strictEqual(pre.querySelectorAll('span.hunk').length, 1);
  });

  test('regression reports list foreign failures; attempts show adjustments and accepted risks', () => {
    const sb = loadSection();
    let root = show(sb, dashboard(), 'regression');
    assert.match(root.querySelector('.rec-reg')!.textContent, /Another session.*TS2304@src\/billing\.ts/);
    root = show(sb, dashboard(), 'attempts');
    assert.match(root.querySelector('.rec-task')!.textContent, /context 8192/);
    assert.match(root.querySelector('.rec-task')!.textContent, /Risk accepted by you/);
  });

  test('analytics draw category bars through chartFrame with a per-category readout', () => {
    const sb = loadSection();
    const root = show(sb, dashboard(), 'analytics');
    const chart = root.querySelector('.chart.hbars')!;
    assert.ok(chart);
    assert.match(chart.getAttribute('aria-label')!, /Recovery rate by category: Type errors 100%, Failing unit tests 0%.*read each category/);
    assert.strictEqual(chart.querySelectorAll('rect[data-i]').length, 2);
    assert.match(root.textContent, /50% 1 of 2/);
  });

  test('every view has an empty state', () => {
    const empty = dashboard({ tiles: { enabled: false, detected: 0, recovered: 0, pendingIntervention: 0, rate: 0, mttrP50: 0 }, current: [], failureHistory: [], categories: [], rca: [], attempts: [], patches: [], regression: [], interventions: [], analytics: { rateByCategory: [], attemptsDistribution: [], mttr: { p50: 0, p90: 0 }, topSignatures: [], memory: { suggested: 0, succeeded: 0, hitRate: 0 }, acceptedRisks: 0, source: 'store' } });
    const sb = loadSection();
    for (const tab of ['history', 'rca', 'attempts', 'patches', 'regression', 'queue', 'analytics']) {
      const root = show(sb, empty, tab);
      assert.ok(root.querySelector('#rec-panel p.empty'), `${tab} has an empty state`);
    }
    const root = show(sb, empty);
    assert.match(root.querySelector('.rec-current')!.textContent, /No task is recovering/);
    assert.strictEqual(root.querySelectorAll('.rec-kpis .kpi')[4].querySelector('.kpi-v')!.textContent, '—');
  });
});
