import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';
import { click, MiniElement, miniDocument } from './miniDom';

const EXT_ROOT = path.resolve(__dirname, '..', '..');

type Fn = (...a: unknown[]) => unknown;
interface MenuItem { label: string; desc?: string; group?: string; groupTag?: { text: string; cls?: string; title?: string }; onPick?: () => void; noSearch?: boolean }

/** The wait row, the model picker and the approval card of media/chat.js, with their collaborators stubbed. */
function loadChat() {
  const src = fs.readFileSync(path.join(EXT_ROOT, 'media', 'chat.js'), 'utf8');
  const cut = (from: string, to: string): string => {
    const a = src.indexOf(from);
    const b = src.indexOf(to, a);
    assert.ok(a > 0 && b > a, `${from.trim()} … ${to.trim()} not found in media/chat.js`);
    return src.slice(a, b);
  };
  const line = (prefix: string): string => {
    const l = src.split('\n').find((x) => x.trim().startsWith(prefix));
    assert.ok(l, `${prefix} not found in media/chat.js`);
    return l;
  };
  const doc = miniDocument();
  const host = doc.body.appendChild(doc.createElement('div'));
  const approvals = host.appendChild(doc.createElement('div'));
  // The footer that scrolls back to the prompts (miniDom has no parentElement).
  Object.defineProperty(approvals, 'parentElement', { value: { scrollTop: 0 } });
  const input = host.appendChild(doc.createElement('textarea')) as MiniElement & { value: string; focus(): void };
  input.value = '';
  input.focus = () => undefined;
  const posted: Record<string, unknown>[] = [];
  const menus: MenuItem[][] = [];
  const state = { session: { id: 's1', model: '' } as Record<string, unknown>, sessions: [] as unknown[], models: [] as Record<string, unknown>[], favorites: [] as string[], providerNames: {} as Record<string, string>, providerHealth: {} as Record<string, unknown>, manualProviders: [] as string[], defaultModel: '', autoModel: '' };
  const sandbox: Record<string, unknown> = {
    document: Object.assign(doc, { addEventListener: () => undefined, activeElement: null }),
    I: new Proxy({}, { get: (_t, k) => `<svg data-i="${String(k)}"></svg>` }),
    CSS: { escape: (s: string) => s },
    state,
    els: { approvals, input, modelBtn: host },
    post: (m: Record<string, unknown>) => posted.push(JSON.parse(JSON.stringify(m))),
    openMenu: (_a: unknown, items: MenuItem[]) => menus.push(items),
    kb: (s: string) => s,
    rotateBody: () => undefined,
    clearTyping: () => undefined,
    followLive: () => undefined,
    waitText: (p: { name?: string }, s: number) => `Loading ${p.name} into memory · ${s}s`,
    fmtClock: (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`,
    openModelMenu_: () => undefined,
    autoModelId: () => '',
    modelName: (id: string) => id,
    ctxLabel: () => '32k ctx',
    ctxCapped: () => false,
    chooseModel: () => undefined,
    toggleFavoriteModel: () => undefined,
    syncModel: () => undefined,
    toast: () => undefined,
    highlight: (c: string) => c,
    removeApproval: (id: string) => posted.push({ removed: id }),
    resolveAttention: () => undefined,
    syncWaiting: () => undefined,
    offerPromptFocus: () => undefined,
    scrollToBottom: () => undefined,
    selectTab: () => undefined,
    autoGrow: () => undefined,
    updateSendEnabled: () => undefined,
    promptKeyTarget: () => false,
    console,
  };
  vm.runInNewContext(
    [
      line('const esc = '),
      line('function el(tag, cls, html)'),
      'let modelPickThen = null; let lastComposerKey = 0;',
      cut('  function showWait(live, sid, p) {', '  /** Output arrived after a retry'),
      cut('  function openModelMenu(query) {', '  function toggleFavoriteModel(id, q) {'),
      cut('  const GRANT_LABEL = {', '  function syncWaiting() {'),
      cut('  function renderApproval(a) {', '  // ask_user: up to 4 questions'),
      'out_ = { showWait, openModelMenu, healthTitle, renderApproval };',
    ].join('\n'),
    sandbox,
    { timeout: 5_000 }
  );
  return { ...(sandbox.out_ as { showWait: Fn; openModelMenu: Fn; healthTitle: Fn; renderApproval: Fn }), state, posted, menus, doc, host, approvals };
}

suite('Chat webview: wait row, provider health in the picker, command rules on approval cards', () => {
  test('the wait row offers Keep waiting and the first fallback model once the wait is noticeable', () => {
    const c = loadChat();
    const root = c.host.appendChild(c.doc.createElement('div'));
    const live = { root, body: root.appendChild(c.doc.createElement('div')), waitRow: null as MiniElement | null };
    const p = { phase: 'load', model: 'ollama/gemma4:12b', name: 'gemma4:12b', limitSec: 180, fallback: { id: 'anthropic/claude-sonnet-4-6', name: 'Claude Sonnet 4.6' } };
    c.showWait(live, 's1', { ...p, seconds: 8 });
    const row = live.waitRow!;
    assert.ok(row.querySelector('.acts')!.classList.contains('hidden'), 'no actions in the first 20 s');
    c.showWait(live, 's1', { ...p, seconds: 24 });
    assert.ok(!row.querySelector('.acts')!.classList.contains('hidden'));
    assert.strictEqual(row.querySelector('.lim')!.textContent, 'times out at 3:00');
    const fb = row.querySelector('[data-w="fallback"]')!;
    assert.ok(!fb.classList.contains('hidden'));
    assert.strictEqual(fb.querySelector('.fb')!.textContent, 'Use Claude Sonnet 4.6');
    click(row.querySelector('[data-w="keep"]')!);
    click(fb);
    assert.deepStrictEqual(c.posted, [{ type: 'keepWaiting', sessionId: 's1' }, { type: 'switchModelAndRetry', sessionId: 's1', model: 'anthropic/claude-sonnet-4-6' }]);
    // No limit (firstTokenTimeoutSeconds = 0) and no fallback: nothing to extend or switch to.
    c.showWait(live, 's1', { ...p, fallback: undefined, limitSec: 0, seconds: 30 });
    assert.ok(row.querySelector('[data-w="keep"]')!.classList.contains('hidden'));
    assert.ok(row.querySelector('[data-w="fallback"]')!.classList.contains('hidden'));
    assert.strictEqual(row.querySelector('.lim')!.textContent, '');
  });

  test('the model picker tags each provider with its health and offers a row for a provider that lists nothing', () => {
    const c = loadChat();
    c.state.models = [{ id: 'ollama/qwen', providerId: 'ollama', name: 'qwen', contextWindow: 32768, supportsTools: true }, { id: 'lms/vl', providerId: 'lms', name: 'vl', contextWindow: 32768, supportsTools: true }];
    c.state.providerNames = { ollama: 'Ollama', lms: 'LM Studio', openai: 'OpenAI', vllm: 'vLLM' };
    c.state.providerHealth = { ollama: { state: 'ok', ms: 35, checkedAt: Date.now() }, lms: { state: 'slow', ms: 2600 }, openai: { state: 'nokey', detail: 'key rejected' }, vllm: { state: 'down', detail: 'not answering' } };
    c.openModelMenu();
    const items = c.menus.pop()!;
    const tag = (label: string) => items.find((i) => i.label === label)?.groupTag;
    assert.deepStrictEqual([tag('qwen')?.text, tag('qwen')?.cls], ['reachable', 'ok']);
    assert.deepStrictEqual([tag('vl')?.text, tag('vl')?.cls], ['slow', 'warn']);
    const down = items.find((i) => i.group === 'vLLM')!;
    assert.strictEqual(down.label, 'Not answering right now');
    assert.deepStrictEqual(down.groupTag?.text, 'down');
    assert.strictEqual(items.find((i) => i.group === 'OpenAI')?.label, 'Add an API key to use its models');
    down.onPick!();
    assert.deepStrictEqual(c.posted.pop(), { type: 'openSettings', section: 'providers', expand: 'vllm' });
    assert.match(String(c.healthTitle({ state: 'slow', ms: 2600, checkedAt: Date.now() })), /^Slow to answer · answered in 2\.6 s · checked just now$/);
  });

  test('an approval card offers Always allow / Always block for one command; a destructive one only Block', () => {
    const c = loadChat();
    c.renderApproval({ id: 'a1', sessionId: 's1', title: 'Run command', detail: '$ npm test\nin app', kind: 'terminal', mandatory: false, waitingSameKind: 0, rule: { pattern: 'npm test', scope: 'workspace' } });
    click(c.approvals.querySelector('.split [data-a="more"]')!);
    const items = c.menus.pop()!;
    assert.deepStrictEqual(Array.from(items, (i) => i.label), ['Allow all commands in this chat', 'Always allow in this workspace…', 'Always allow “npm test”', 'Always block “npm test”']);
    items[2].onPick!();
    assert.deepStrictEqual(c.posted.filter((m) => m.type === 'approval'), [{ type: 'approval', id: 'a1', approved: true, saveRule: true }]);
    c.renderApproval({ id: 'a2', sessionId: 's1', title: 'Run command', detail: '$ rm -rf build\nin app', kind: 'terminal', mandatory: true, mandatoryReason: 'dangerous', waitingSameKind: 0, rule: { pattern: 'rm -rf build', scope: 'user', blockOnly: true } });
    const card = c.approvals.querySelectorAll('.approval').pop()!;
    assert.strictEqual(card.querySelector('.split'), null, 'no allow-all split for a prompt that always asks');
    click(card.querySelector('[data-a="more"].solo')!);
    const only = c.menus.pop()!;
    assert.deepStrictEqual(Array.from(only, (i) => [i.label, i.desc]), [['Always block “rm -rf build”', 'Denies it now and from now on in every workspace']]);
    only[0].onPick!();
    assert.deepStrictEqual(c.posted.filter((m) => m.type === 'approval').pop(), { type: 'approval', id: 'a2', approved: false, saveRule: true });
    // No rule offered (a chain or a non-terminal prompt): the menu is unchanged.
    c.renderApproval({ id: 'a3', sessionId: 's1', title: 'Edit file', detail: 'a.ts', kind: 'write', mandatory: false, waitingSameKind: 0 });
    click(c.approvals.querySelectorAll('.approval').pop()!.querySelector('[data-a="more"]')!);
    assert.strictEqual(c.menus.pop()!.length, 2);
  });
});
