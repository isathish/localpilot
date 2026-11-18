import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';
import * as vscode from 'vscode';
import { click, MiniElement, miniDocument } from './miniDom';
import { AGENT_STATUS, AgentsTreeProvider, agentStatus, describeAgent, fmtCost, fmtElapsed } from '../ui/agentsView';
import type { ChatController } from '../ui/chatController';
import type { SessionSummary } from '../types';

const EXT_ROOT = path.resolve(__dirname, '..', '..');
const read = (f: string): string => fs.readFileSync(path.join(EXT_ROOT, f), 'utf8');

/** A slice of media/chat.js between two markers (the functions under test, lifted out of the browser IIFE). */
function cutChat(from: string, to: string): string {
  const src = read('media/chat.js');
  const a = src.indexOf(from);
  const b = src.indexOf(to, a + from.length);
  assert.ok(a > 0 && b > a, `${from.trim()} … ${to.trim()} not found in media/chat.js`);
  return src.slice(a, b);
}

const now = Date.now();
const summary = (id: string, extra: Partial<SessionSummary> = {}): SessionSummary => ({ id, title: `Chat ${id}`, createdAt: now - 1e6, updatedAt: now - 3600e3, model: 'ollama/qwen2.5-coder:7b', mode: 'agent', messageCount: 4, ...extra });

/** The controller surface the Agents view reads, with every state in reach. */
function fakeController(o: { sessions: SessionSummary[]; running?: string[]; paused?: string[]; prompts?: string[]; files?: Record<string, number>; last?: Record<string, { status: 'done' | 'failed' | 'stopped'; endedAt: number; durationMs?: number }> }): ChatController {
  const ev = () => ({ dispose: () => undefined });
  return {
    store: { onDidChange: ev, list: () => o.sessions },
    onDidChangeRuns: ev,
    onDidChangeActive: ev,
    tracker: { onDidChange: ev, forSession: (id: string) => Array.from({ length: o.files?.[id] ?? 0 }, (_, i) => ({ fsPath: `/w/${id}/f${i}.ts`, original: i ? 'x' : undefined })) },
    runStatus: new Map(o.running?.map((id) => [id, 'Editing src/a.ts'])),
    runningSessionIds: o.running ?? [],
    isPaused: (id: string) => !!o.paused?.includes(id),
    hasPendingPrompt: (id: string) => !!o.prompts?.includes(id),
    runStartedAt: (id: string) => (o.running?.includes(id) ? Date.now() - 125_000 : undefined),
    lastRun: (id: string) => o.last?.[id],
    childControls: () => [],
    activeSession: undefined,
  } as unknown as ChatController;
}

suite('Agent surfaces: the Agents view', () => {
  test('one status vocabulary: a prompt outranks paused, paused outranks running; finished runs keep how they ended', () => {
    assert.strictEqual(agentStatus({ running: true, paused: true, prompt: true }), 'waiting');
    assert.strictEqual(agentStatus({ running: true, paused: true, prompt: false }), 'paused');
    assert.strictEqual(agentStatus({ running: true, paused: false, prompt: false }), 'running');
    assert.strictEqual(agentStatus({ running: false, paused: false, prompt: false, last: { status: 'stopped', endedAt: now } }), 'stopped');
    assert.strictEqual(agentStatus({ running: false, paused: false, prompt: false }), 'idle');
    assert.deepStrictEqual(Object.values(AGENT_STATUS).map((s) => s.label).slice(0, 6), ['Running', 'Waiting for you', 'Paused', 'Done', 'Failed', 'Stopped']);
    // Only problems get a colour; a good outcome stays quiet.
    assert.ok(AGENT_STATUS.failed.color && AGENT_STATUS.waiting.color && !AGENT_STATUS.done.color);
  });

  test('row text: status and elapsed first, then model, changed files and what it cost', () => {
    assert.strictEqual(fmtElapsed(45_000), '45s');
    assert.strictEqual(fmtElapsed(125_000), '2m 05s');
    assert.strictEqual(fmtElapsed(2 * 3600e3 + 5 * 60e3), '2h 05m');
    assert.strictEqual(fmtCost({ promptTokens: 1, completionTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, requests: 1, costUsd: 0.184 }), '$0.18');
    assert.strictEqual(fmtCost({ promptTokens: 12_000, completionTokens: 400, cacheReadTokens: 0, cacheWriteTokens: 0, requests: 3 }), '12k tok');
    const s = summary('a', { usage: { promptTokens: 1, completionTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, requests: 1, costUsd: 0.5 } });
    assert.strictEqual(describeAgent(s, { running: true, paused: false, prompt: false, startedAt: now - 125_000, files: 2 }, now), 'Running 2m 05s · qwen2.5-coder:7b · 2 files changed · $0.50');
    assert.strictEqual(describeAgent(s, { running: true, paused: false, prompt: true, question: true, files: 0 }, now), 'Waiting for you · question · qwen2.5-coder:7b · $0.50');
    assert.strictEqual(describeAgent(s, { running: false, paused: false, prompt: false, last: { status: 'failed', endedAt: now - 120e3, durationMs: 61_000 }, files: 3 }, now), 'Failed in 1m 01s · 2m ago · qwen2.5-coder:7b · 3 files to review · $0.50');
    assert.match(describeAgent(summary('b', { worktree: { path: '/wt' } as SessionSummary['worktree'], group: { id: 'g', kind: 'bestOf', prompt: 'p', size: 3 } }), { running: false, paused: false, prompt: false, files: 0 }, now), /^agent · 1h ago · qwen2\.5-coder:7b · isolated · best of 3$/);
  });

  test('groups: Needs you (waiting + changes to review) · Running · Recent, each agent once', () => {
    const sessions = [summary('wait'), summary('run'), summary('pause'), summary('review'), summary('done'), summary('old')];
    const c = fakeController({ sessions, running: ['wait', 'run', 'pause'], paused: ['pause'], prompts: ['wait'], files: { review: 2, run: 1 }, last: { done: { status: 'done', endedAt: Date.now() - 60e3 } } });
    const tree = new AgentsTreeProvider(c);
    try {
      const roots = tree.getChildren();
      assert.deepStrictEqual(roots.map((r) => (r as { label: string }).label), ['Needs you (2)', 'Running (2)', 'Recent']);
      const ids = (n: unknown) => tree.getChildren(n as Parameters<typeof tree.getChildren>[0]).map((x) => (x as { session?: { id: string } }).session?.id);
      assert.deepStrictEqual(ids(roots[0]), ['wait', 'review'], 'the waiting agent comes first');
      assert.deepStrictEqual(ids(roots[1]), ['run', 'pause']);
      assert.deepStrictEqual(ids(roots[2]), ['done', 'old']);
      const item = (id: string, running: boolean) => tree.getTreeItem({ kind: 'session', session: sessions.find((s) => s.id === id)!, running });
      const w = item('wait', true);
      assert.strictEqual(w.contextValue, 'session-running-waiting', 'Pause and Stop stay on a waiting agent');
      assert.match(String(w.description), /^Waiting for you · approval/);
      assert.strictEqual((w.iconPath as vscode.ThemeIcon).id, 'bell-dot');
      const r = item('run', true);
      assert.strictEqual(r.contextValue, 'session-running');
      assert.match(String(r.description), /^Running 2m 0\ds · qwen2\.5-coder:7b · 1 file changed$/);
      assert.strictEqual(item('pause', true).contextValue, 'session-paused');
      assert.match(String(item('pause', true).description), /^Paused /);
      const v = item('review', false);
      assert.strictEqual(v.contextValue, 'session-idle-changed', 'drives Review / Accept / Reject');
      assert.match(String(v.description), /2 files to review/);
      assert.match(String(item('done', false).description), /^Done · 1m ago/);
      assert.strictEqual((item('done', false).iconPath as vscode.ThemeIcon).id, 'pass');
      assert.ok(w.tooltip instanceof vscode.MarkdownString && /Click to open the chat and answer/.test(w.tooltip.value));
    } finally {
      tree.dispose();
    }
  });

  test('Review Changes is a registered command on idle rows with changes, inline before Accept / Reject', async () => {
    const pkg = JSON.parse(read('package.json')) as { contributes: { commands: { command: string; icon?: string }[]; menus: Record<string, { command: string; when?: string; group?: string }[]> } };
    assert.ok(pkg.contributes.commands.some((c) => c.command === 'localpilot.reviewSession' && c.icon));
    const inline = pkg.contributes.menus['view/item/context'].filter((m) => m.when === 'view =~ /^localpilot\\.agentsView/ && viewItem == session-idle-changed' && /^inline/.test(m.group ?? ''));
    assert.deepStrictEqual(inline.map((m) => m.command), ['localpilot.reviewSession', 'localpilot.keepChanges', 'localpilot.undoChanges']);
    await vscode.extensions.getExtension('localpilot.localpilot-agent')!.activate();
    assert.ok((await vscode.commands.getCommands(true)).includes('localpilot.reviewSession'));
  });
});

interface Strip {
  renderBgRuns: () => void;
  agentSt: (k: string, label?: string, bare?: boolean) => string;
  laneMeta: (d: MiniElement) => void;
  hostTally: (h: MiniElement) => Record<string, number>;
  tallyText: (t: Record<string, number>) => string;
  hostMeter: (done: number, total: number) => string;
}

function loadStrip(state: Record<string, unknown>, all: Record<string, unknown>[], active: string): { api: Strip; els: Record<string, MiniElement>; posted: Record<string, unknown>[]; selected: string[]; doc: ReturnType<typeof miniDocument> } {
  const doc = miniDocument();
  const els = { bgruns: doc.body.appendChild(doc.createElement('div')), approvals: doc.body.appendChild(doc.createElement('div')) };
  els.bgruns.className = 'bgruns hidden';
  const posted: Record<string, unknown>[] = [];
  const selected: string[] = [];
  const icon = '<svg></svg>';
  const sb: Record<string, unknown> = {
    document: doc,
    CSS: { escape: (s: string) => s },
    I: { warn: icon, pause: icon, play: icon, check: icon, x: icon, stop: icon },
    LIVE_DOT: '<span class="dot live"></span>',
    esc: (s: unknown) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!),
    el: (tag: string, cls: string, html: string) => { const e = doc.createElement(tag); if (cls) { e.className = cls; } if (html) { e.innerHTML = html; } return e; },
    state,
    els,
    post: (m: Record<string, unknown>) => posted.push(JSON.parse(JSON.stringify(m))),
    selectTab: (id: string) => selected.push(id),
    openHistory: () => undefined,
    activeId: () => active,
    tabList: () => ({ all }),
    tabModel: (s: { model?: string }) => String(s.model || 'auto').split('/').pop(),
    modelName: (ref: string) => String(ref || '').split('/').pop(),
    fmtUsd: (v: number) => `$${v.toFixed(4)}`,
    fmtDur: (ms: number) => `${Math.round(ms / 1000)}s`,
    liveElapsed: (live: { startedAt: number }, t: number) => t - live.startedAt,
    out_: null,
  };
  vm.runInNewContext(`${cutChat('  // ------------------------------------------------------------------ agent surfaces', '  function modelName(')}
${cutChat('  /** How the finished lanes of a Workers card ended', '  function hostProgress(')}
${cutChat('  // Agents strip under the tab bar', '  function scheduleBg() {')}
out_ = { renderBgRuns, agentSt, laneMeta, hostTally, tallyText, hostMeter };`, sb);
  return { api: sb.out_ as Strip, els, posted, selected, doc };
}

suite('Agent surfaces: the chat webview', () => {
  const baseState = () => ({ running: new Set<string>(), paused: new Map<string, { paused: boolean; holding: boolean }>(), attention: new Set<string>(), status: new Map<string, string>(), live: new Map<string, { startedAt: number }>(), session: null as unknown });

  test('the status chip is an icon and a word, so the state never rests on colour', () => {
    const { api } = loadStrip(baseState(), [], '');
    for (const [k, word] of [['running', 'Running'], ['waiting', 'Waiting for you'], ['paused', 'Paused'], ['done', 'Done'], ['failed', 'Failed'], ['stopped', 'Stopped'], ['queued', 'Queued']]) {
      const html = api.agentSt(k);
      assert.ok(html.includes(`class="agst k-${k}"`) && html.includes(`>${word}<`) && html.includes('aria-hidden="true"'), html);
    }
    assert.ok(!api.agentSt('done', '', true).includes('agi'), 'bare: the lane row already starts with the glyph');
    assert.ok(api.agentSt('bogus').includes('k-running'));
  });

  test('Best of N strip: every sibling with its status, the open one marked, Compare and row actions wired', () => {
    const st = baseState();
    const g = { id: 'g1', kind: 'bestOf', prompt: 'Add validation', size: 3 };
    const all = [
      { id: 'a', title: 'Add validation', model: 'ollama/qwen', group: g, createdAt: 1 },
      { id: 'b', title: 'Add validation', model: 'anthropic/sonnet', group: g, createdAt: 2, usage: { costUsd: 0.1834 } },
      { id: 'c', title: 'Add validation', model: 'ollama/gemma', group: g, createdAt: 3 },
      { id: 'd', title: 'Refactor dates', model: 'ollama/qwen', createdAt: 4 },
    ];
    for (const id of ['a', 'b', 'd']) { st.running.add(id); st.live.set(id, { startedAt: Date.now() - 65_000 }); }
    st.attention.add('b');
    st.paused.set('d', { paused: true, holding: true });
    st.status.set('a', 'Editing src/a.ts');
    const { api, els, posted, selected } = loadStrip(st, all, 'a');
    api.renderBgRuns();
    assert.ok(!els.bgruns.classList.contains('hidden'));
    const head = els.bgruns.querySelector('.bg-head')!;
    assert.match(head.textContent, /Best of 3.*1 waiting for you · 1 running · 1 done.*Compare/);
    const rows = els.bgruns.querySelectorAll('.bgrun');
    assert.deepStrictEqual(rows.map((r) => r.className), ['bgrun k-running current', 'bgrun k-waiting', 'bgrun k-done', 'bgrun k-paused']);
    assert.deepStrictEqual(rows.map((r) => r.querySelector('.t')!.textContent), ['qwen', 'sonnet', 'gemma', 'Refactor dates']);
    assert.strictEqual(rows[0].querySelector('.open')!.getAttribute('aria-current'), 'true');
    assert.match(rows[1].querySelector('.open')!.getAttribute('aria-label')!, /^sonnet: Waiting for you/);
    assert.ok(rows[1].querySelector('.cost')!.textContent.startsWith('$0.18'), 'what it cost so far');
    assert.strictEqual(rows[2].querySelector('.stop'), null, 'a finished sibling has no pause / stop');
    assert.ok(els.bgruns.querySelector('.bg-head.other'), 'agents outside the batch get their own heading');
    click(head.querySelector('.bg-compare')!);
    assert.deepStrictEqual(posted.pop(), { type: 'compareGroup', groupId: 'g1' });
    click(rows[1].querySelector('.t')!);
    assert.deepStrictEqual(selected, ['b']);
    click(rows[0].querySelector('.t')!);
    assert.deepStrictEqual(selected, ['b'], 'the open tab does not reselect itself');
    click(rows[3].querySelector('.pausebtn')!);
    assert.deepStrictEqual(posted.pop(), { type: 'resume', sessionId: 'd' });
    click(rows[1].querySelector('.stop:not(.pausebtn)')!);
    assert.deepStrictEqual(posted.pop(), { type: 'stop', sessionId: 'b' });
  });

  test('no batch and nothing else running: the strip hides', () => {
    const { api, els } = loadStrip(baseState(), [{ id: 'a', title: 'x', createdAt: 1 }], 'a');
    api.renderBgRuns();
    assert.ok(els.bgruns.classList.contains('hidden'));
  });

  test('worker lanes: status glyph and word, steps · time · files; the Workers card tallies in the same words', () => {
    const { api, doc } = loadStrip(baseState(), [], '');
    const host = doc.body.appendChild(doc.createElement('details'));
    host.innerHTML = '<div class="content subs"></div>';
    const lane = (cls: string, st?: string) => {
      const d = host.querySelector('.content')!.appendChild(doc.createElement('details'));
      d.className = `step subagent ${cls}`;
      d.innerHTML = '<summary><span class="ico"></span><span class="label"></span><span class="meta"></span></summary><div class="content"></div>';
      if (st) { d.dataset.st = st; }
      return d;
    };
    const done = lane('ok', 'done');
    done.dataset.calls = '3';
    done.querySelector('.content')!.innerHTML = '<div class="card edit" data-path="a.ts"></div><div class="card edit" data-path="a.ts"></div><div class="card edit" data-path="b.ts"></div>';
    done.__t0 = Date.now() - 64_000; done.__t1 = Date.now();
    api.laneMeta(done);
    assert.match(done.querySelector('.meta')!.textContent, /^Done · 3 steps · 64s · 2 files$/);
    assert.strictEqual(done.dataset.lane, 'done');
    const failed = lane('error', 'failed'); api.laneMeta(failed);
    const stopped = lane('error', 'stopped'); api.laneMeta(stopped);
    assert.match(stopped.querySelector('.meta')!.textContent, /^Stopped/);
    const paused = lane('running paused'); paused.__now = 'Reading a.ts'; api.laneMeta(paused);
    assert.match(paused.querySelector('.meta')!.textContent, /^Paused/, 'a paused lane says so instead of its last step');
    const running = lane('running'); running.__now = 'Reading a.ts'; api.laneMeta(running);
    assert.strictEqual(running.querySelector('.meta .now')!.textContent, 'Reading a.ts');
    assert.strictEqual(running.dataset.lane, 'running');
    const t = api.hostTally(host);
    assert.deepStrictEqual(JSON.parse(JSON.stringify(t)), { done: 1, failed: 1, stopped: 1 });
    assert.strictEqual(api.tallyText(t), '1 done · 1 failed · 1 stopped');
    assert.match(api.hostMeter(3, 6), /role="progressbar"[^>]*aria-valuemax="6" aria-valuenow="3"[^>]*><i style="width:50%"><\/i><\/span><span class="wk-n">3\/6<\/span>/);
    void failed;
  });

  test('agents.css is loaded everywhere the chat is, scales its type and calms motion through the shared flag', () => {
    assert.ok(read('src/ui/chatViewProvider.ts').includes("media('agents.css')"));
    for (const f of ['scripts/ui-preview.html', 'scripts/ui-preview-parallel.html']) { assert.ok(read(f).includes('../media/agents.css'), f); }
    const css = read('media/agents.css');
    assert.deepStrictEqual(css.match(/font-size: *\d+(\.\d+)?px/g) || [], [], 'fixed font sizes go through --fs-scale');
    assert.ok(!css.includes('prefers-reduced-motion') && css.includes('@container style(--motion-reduced: 1)'));
    assert.ok(!/#[0-9a-f]{3,8}\b/i.test(css.replace(/\/\*[\s\S]*?\*\//g, '')), 'no hard-coded colours: theme variables only');
    for (const k of ['running', 'waiting', 'paused', 'done', 'failed', 'stopped']) { assert.ok(css.includes(`.agst.k-${k}`) || k === 'running', k); }
  });
});
