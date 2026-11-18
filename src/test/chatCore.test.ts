import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';
import { MiniElement } from './miniDom';

const EXT_ROOT = path.resolve(__dirname, '..', '..');
const read = (f: string): string => fs.readFileSync(path.join(EXT_ROOT, f), 'utf8');

/** A slice of media/chat.js, from `from` up to (not including) `to`. */
function cutChat(from: string, to: string): string {
  const src = read('media/chat.js');
  const a = src.indexOf(from); const b = src.indexOf(to, a);
  assert.ok(a > 0 && b > a, `${from.trim()} … ${to.trim()} not found in media/chat.js`);
  return src.slice(a, b);
}
/** Every icon as a recognisable stub, so a test can tell which one was drawn. */
const I = new Proxy({}, { get: (_t, k) => `<svg data-i="${String(k)}"></svg>` });
const el = (tag: string, cls?: string, html?: string): MiniElement => { const e = new MiniElement(tag); if (cls) { e.className = cls; } if (html !== undefined) { e.innerHTML = html; } return e; };

/** The chat core redesign (1.11): the token layer, the welcome screen's mode card, toasts, continuity page heads. */
suite('Chat core design', () => {
  test('the token layer keeps every existing token and adds the design scale', () => {
    const css = read('media/chat.css');
    // Other surfaces (agent lanes, settings, continuity) read these: none may be renamed or removed.
    const kept = ['--bg', '--fg', '--fg-2', '--muted', '--border', '--border-2', '--border-soft', '--accent', '--accent-fg', '--accent-hover', '--focus', '--input-bg', '--input-fg', '--card', '--code-bg', '--editor-bg', '--hover', '--sel', '--sel-fg', '--link', '--error', '--warn', '--ok', '--add-bg', '--del-bg', '--mono', '--brand', '--brand-text', '--ok-text', '--warn-text', '--error-text', '--brand-ink', '--tint', '--tint-2', '--radius-sm', '--radius', '--radius-lg', '--shadow', '--shadow-sm', '--fs-scale', '--fs', '--fs-sm', '--fs-xs', '--lh', '--gutter', '--turn-y', '--row-h', '--ctl-h', '--stack', '--pad', '--btn2', '--btn2-fg', '--btn2-hover', '--btn-border', '--icon'];
    for (const t of kept) { assert.match(css, new RegExp(`${t}:`), `${t} is still defined`); }
    const scale: Record<string, string> = { '--space-1': '4px', '--space-2': '8px', '--space-3': '12px', '--space-4': '16px', '--space-5': '24px', '--radius-ctl': '6px', '--radius-card': '10px', '--radius-pill': '999px', '--track-label': '.06em', '--dur-fast': '120ms', '--dur': '180ms', '--dur-panel': '250ms' };
    for (const [k, v] of Object.entries(scale)) { assert.ok(css.includes(`${k}: ${v};`), `${k}: ${v}`); }
    assert.match(css, /--fs-label: calc\(11px \* var\(--fs-scale\)\);/);
    assert.match(css, /--lh: 1\.45;/);
    // Elevation comes from the theme's widget shadow, so high-contrast and custom themes decide it.
    assert.match(css, /--shadow: [^;]*var\(--vscode-widget-shadow/);
    assert.match(css, /--shadow-pop: [^;]*var\(--vscode-widget-shadow/);
  });

  test('one label style: welcome groups, menu groups, continuity sections and the navigator share caps and tracking', () => {
    const css = read('media/chat.css'); const cont = read('media/continuity.css');
    const label = /font-size: var\(--fs-label\); font-weight: 600; letter-spacing: var\(--track-label\); text-transform: uppercase;/;
    for (const [src, sel] of [[css, '.recent-h {'], [css, '.popover .grp {'], [cont, '.cp-sec h3 {'], [cont, '.nav-know > summary {']] as const) {
      const i = src.indexOf(sel); assert.ok(i >= 0, sel);
      assert.match(src.slice(i, src.indexOf('}', i)), label, `${sel} uses the label style`);
    }
    // Buttons inside a label keep normal case.
    assert.match(css, /\.recent-h button \{[^}]*letter-spacing: normal; text-transform: none;/);
  });

  test('the welcome screen centres its column on a wide host and replaces the mode line with a mode card', () => {
    const css = read('media/chat.css');
    assert.match(css, /\n\.empty \{ text-align: left; margin: auto auto 0;[^}]*width: 100%; max-width: 560px; \}/);
    const js = cutChat('  function renderEmpty() {', '  /** The hint row and the disclaimer');
    assert.ok(!js.includes('modeline'), 'the old "· change" line is gone');
    assert.match(js, /el\('button', 'modecard'/);
    assert.match(js, /mc\.onclick = \(e\) => \{ e\.stopPropagation\(\); openModeMenu\(mc\); \};/);
    assert.match(js, /mc\.setAttribute\('aria-haspopup', 'listbox'\)/);
    // The menu hangs from the card; the composer's picker (an event, not an element) still anchors at itself.
    assert.match(read('media/chat.js'), /openMenu\(anchor && anchor\.nodeType === 1 \? anchor : els\.modeBtn, items/);
  });

  test('the mode card follows the mode: Agent, a specialist, and Auto with how it picks', () => {
    const src = cutChat('  const MODES = {', '  const READ_TOOLS') + cutChat('  /** The welcome screen\'s mode card', '  /** Keyboard mode switch');
    const messages = el('main');
    const empty = el('div', 'empty');
    empty.appendChild(el('button', 'modecard', '<span class="mc-ico"></span><span class="mc-txt"><span class="mc-k"></span><span class="mc-d"></span></span><span class="mc-tag hidden"></span><span class="mc-chev"></span>'));
    messages.appendChild(empty);
    const state: { session: Record<string, unknown> } = { session: { mode: 'agent', messages: [] } };
    const sandbox: Record<string, unknown> = { I, state, els: { messages } };
    vm.runInNewContext(`${src}\nout_ = syncModeLine;`, sandbox, { timeout: 2000 });
    const sync = sandbox.out_ as () => void;
    const card = empty.querySelector('.modecard')!;
    const q = (c: string) => card.querySelector(c)!;

    sync();
    assert.strictEqual(q('.mc-k').textContent, 'Agent mode');
    assert.strictEqual(q('.mc-d').textContent, 'Edit files, run commands, verify');
    assert.strictEqual(q('.mc-tag').textContent, 'edits files');
    assert.ok(!q('.mc-tag').classList.contains('hidden'));
    assert.ok(q('.mc-ico').innerHTML.includes('data-i="agent"'));
    assert.strictEqual(card.getAttribute('aria-label'), 'Agent mode: Edit files, run commands, verify (edits files). Change mode');

    state.session = { mode: 'ask', specialist: 'review', messages: [] };
    sync();
    assert.strictEqual(q('.mc-k').textContent, 'Review mode');
    assert.match(q('.mc-d').textContent, /; runs in Ask$/);
    assert.strictEqual(q('.mc-tag').textContent, 'read-only');

    state.session = { mode: 'agent', autoMode: true, messages: [] };
    sync();
    assert.strictEqual(q('.mc-k').textContent, 'Auto mode');
    assert.match(q('.mc-d').textContent, /^Each message picks Ask, Plan, Agent, Debug or a specialist/);
    assert.ok(q('.mc-tag').classList.contains('hidden'), 'Auto has no single permission tag');
    assert.ok(card.classList.contains('auto'));
    assert.ok(q('.mc-ico').innerHTML.includes('data-i="sparkle"'));

    // No welcome screen on display: nothing to do, no throw.
    empty.remove(); sync();
  });

  test('the no-model setup card: its buttons work from a click on their icon or label', () => {
    const js = cutChat('  function renderEmpty() {', '  /** The hint row and the disclaimer');
    assert.match(js, /el\('div', 'notice setupcard'/);
    assert.match(js, /n\.onclick = \(e\) => \{ const b = e\.target\.closest\('\[data-a\]'\); const a = b && b\.dataset\.a;/);
    for (const a of ['setup', 'refresh', 'settings']) { assert.ok(js.includes(`data-a="${a}"`), a); }
  });

  test('toasts name their level with an icon and spoken text, not colour alone', () => {
    const src = cutChat('  function toast(text, level, action) {', '  // "Stick to bottom"');
    const box = el('div'); const alerts = el('div');
    const posted: unknown[] = [];
    const sandbox: Record<string, unknown> = {
      I, el, els: { toasts: box }, post: (m: unknown) => posted.push(m),
      esc: (s: string) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;'),
      setTimeout: () => 1, clearTimeout: () => undefined, Date,
      document: { getElementById: (id: string) => (id === 'toastAlerts' ? alerts : null), activeElement: null },
    };
    vm.runInNewContext(`${src}\nout_ = toast;`, sandbox, { timeout: 2000 });
    const toast = sandbox.out_ as (t: string, l?: string, a?: unknown) => void;

    toast('Copied');
    const info = box.querySelector('.toast')!;
    assert.ok(!info.querySelector('.ti'), 'an info toast has no level icon');
    assert.strictEqual(info.querySelector('.tt')!.textContent, 'Copied');

    toast('No images on this model', 'warn', { label: 'Change model', msg: { type: 'x' } });
    const warn = box.querySelectorAll('.toast')[1];
    assert.ok(warn.querySelector('.ti')!.innerHTML.includes('data-i="warn"'));
    assert.strictEqual(warn.querySelector('.ti')!.getAttribute('aria-hidden'), 'true');
    assert.strictEqual(warn.querySelector('.tt')!.textContent, 'Warning: No images on this model');

    toast('Server down', 'error');
    const err = alerts.querySelector('.toast')!;
    assert.ok(err.querySelector('.ti')!.innerHTML.includes('data-i="alert"'), 'errors use their own glyph');
    assert.strictEqual(err.querySelector('.tt')!.textContent, 'Error: Server down');
    assert.match(read('media/chat.css'), /\.toast\.warn \.ti \{ color: var\(--warn-text\); \} \.toast\.error \.ti \{ color: var\(--error-text\); \}/);
  });

  test('continuity pages show their icon in the header (the navigator row\'s glyph)', () => {
    const js = read('media/continuity.js');
    assert.match(js, /const ICONS = \{ trash: I\.trash, versions: J\.history, memory: I\.memory, context: I\.layers, checkpoints: I\.restore, sync: I\.sync, compare: I\.compare \};/);
    assert.match(js, /\$\{cur && ICONS\[cur\.page\] \? `<span class="cp-ico" aria-hidden="true">\$\{ICONS\[cur\.page\]\}<\/span>` : ''\}<div class="cp-title">/);
    assert.match(read('media/continuity.css'), /\.cpage \{[^}]*animation: fadeUp var\(--dur-panel\) var\(--ease-out\);/);
  });

  test('the open tab is underlined, and the new motion is calmed by the reduced-motion flag', () => {
    const css = read('media/chat.css');
    assert.match(css, /\.tab\.active::after \{ opacity: 1; transform: none; \}/);
    const calm = css.slice(css.indexOf('@container style(--motion-reduced: 1) {'));
    for (const sel of ['.tab::after', '.modecard', '.suggestion .ico', '.toast']) { assert.ok(calm.includes(sel), `${sel} is calmed`); }
    assert.ok(read('media/continuity.css').includes('.cpage { animation: none; }'));
  });

  test('the preview takes ?whatsnew, ?toast and an Auto empty chat (empty=1&auto=1)', () => {
    const html = read('scripts/ui-preview.html');
    for (const k of ["wq.get('whatsnew')", "wq.get('toast')", "...(eq.get('auto')?{autoMode:true}:{})"]) { assert.ok(html.includes(k), k); }
  });
});
