import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';
import { click, dispatch, MiniElement, miniDocument } from './miniDom';
import { keyLabel } from '../ui/shortcuts';

const EXT_ROOT = path.resolve(__dirname, '..', '..');
const read = (f: string): string => fs.readFileSync(path.join(EXT_ROOT, f), 'utf8');

/** Focus that moves: `document.activeElement` of the sandbox. */
const focus: { active: MiniElement | null } = { active: null };
/** ./miniDom plus the bits these surfaces use: `id`, `tabIndex`, focus, append, click(). */
class El extends MiniElement {
  get id(): string { return this.getAttribute('id') || ''; }
  set id(v: string) { this.setAttribute('id', v); }
  get tabIndex(): number { const t = this.getAttribute('tabindex'); return t === null ? (/^(BUTTON|INPUT|SELECT|TEXTAREA)$/.test(this.tagName) ? 0 : -1) : Number(t); }
  set tabIndex(v: number) { this.setAttribute('tabindex', String(v)); }
  get type(): string { return this.getAttribute('type') || ''; }
  set type(v: string) { this.setAttribute('type', v); }
  get src(): string { return this.getAttribute('src') || ''; }
  set src(v: string) { this.setAttribute('src', v); }
  get alt(): string { return this.getAttribute('alt') || ''; }
  set alt(v: string) { this.setAttribute('alt', v); }
  get placeholder(): string { return this.getAttribute('placeholder') || ''; }
  set placeholder(v: string) { this.setAttribute('placeholder', v); }
  append(...nodes: MiniElement[]): void { for (const n of nodes) { this.appendChild(n); } }
  override focus(): void { focus.active = this; }
  click(): void { click(this); }
}
/** Elements parsed from innerHTML are MiniElements: give them El's accessors while these suites run, then put it back. */
const PATCHED = ['id', 'tabIndex', 'type', 'src', 'alt', 'placeholder', 'append', 'focus', 'click'] as const;
let saved: Record<string, PropertyDescriptor | undefined> = {};
function patchMini(): void {
  saved = Object.fromEntries(PATCHED.map((k) => [k, Object.getOwnPropertyDescriptor(MiniElement.prototype, k)]));
  for (const k of PATCHED) { Object.defineProperty(MiniElement.prototype, k, { ...Object.getOwnPropertyDescriptor(El.prototype, k)!, configurable: true }); }
}
function unpatchMini(): void {
  for (const k of PATCHED) { const d = saved[k]; if (d) { Object.defineProperty(MiniElement.prototype, k, d); } else { delete (MiniElement.prototype as unknown as Record<string, unknown>)[k]; } }
}

function docFor() {
  const doc = miniDocument();
  const all = (): MiniElement[] => [doc.body, ...doc.body.querySelectorAll('*')];
  const listeners: Record<string, ((e: unknown) => void)[]> = {};
  focus.active = null;
  return {
    doc,
    document: {
      body: doc.body,
      createElement: (tag: string) => new El(tag),
      getElementById: (id: string) => all().find((e) => e.getAttribute('id') === id) || null,
      get activeElement() { return focus.active; },
      addEventListener: (t: string, fn: (e: unknown) => void) => { (listeners[t] ||= []).push(fn); },
    },
    /** Sends a key to the document-level listeners (the lightbox's Esc fallback). */
    docKey: (key: string) => { for (const fn of listeners.keydown || []) { fn({ key, preventDefault: () => undefined, stopPropagation: () => undefined }); } },
  };
}
const elFn = (document: { createElement(t: string): MiniElement }) => (tag: string, cls?: string, html?: string): MiniElement => { const e = document.createElement(tag); if (cls) { e.className = cls; } if (html !== undefined) { e.innerHTML = html; } return e; };
const key = (target: MiniElement, k: string, extra: Record<string, unknown> = {}) => dispatch(target, 'keydown', { key: k, ...extra });
/** A key on a strip whose handler is an `onkeydown` property. */
function onKey(list: MiniElement, target: MiniElement, k: string): { defaultPrevented: boolean } {
  const res = { defaultPrevented: false };
  (list.onkeydown as (e: unknown) => void)({ key: k, target, preventDefault: () => { res.defaultPrevented = true; } });
  return res;
}

/** A slice of media/chat.js, from the line starting with `from` up to (not including) `to`. */
function cutChat(from: string, to: string): string {
  const src = read('media/chat.js');
  const a = src.indexOf(from); const b = src.indexOf(to, a);
  assert.ok(a > 0 && b > a, `${from.trim()} … ${to.trim()} not found in media/chat.js`);
  return src.slice(a, b);
}

suite('Webview accessibility', () => {
suiteSetup(patchMini);
suiteTeardown(unpatchMini);

suite('Chat: modals, thumbnails, toggles', () => {
  test('Tab wraps inside a modal, Shift+Tab wraps back, and in between the browser moves', () => {
    const sb: Record<string, unknown> = {};
    vm.runInNewContext(`${cutChat('  function trapTarget(', '  /** Keeps Tab inside a modal')}\nout_ = trapTarget;`, sb);
    const trapTarget = sb.out_ as (f: string[], a: string | null, back: boolean) => string | null;
    const f = ['a', 'b', 'c'];
    assert.strictEqual(trapTarget(f, 'c', false), 'a');
    assert.strictEqual(trapTarget(f, 'a', true), 'c');
    assert.strictEqual(trapTarget(f, 'b', false), null);
    assert.strictEqual(trapTarget(f, 'b', true), null);
    assert.strictEqual(trapTarget(f, null, false), 'a', 'focus outside the modal comes back in');
    assert.strictEqual(trapTarget([], 'a', false), null);
  });

  test('the lightbox is a labelled modal dialog: Close gets focus, Tab stays in, Esc closes and focus returns', () => {
    const d = docFor();
    const input = d.doc.body.appendChild(new El('textarea'));
    const thumb = d.doc.body.appendChild(new El('img')) as El; thumb.src = 'data:image/png;base64,AAAA'; thumb.alt = 'Image 1 of 1';
    const sb: Record<string, unknown> = { document: d.document, el: elFn(d.document), I: new Proxy({}, { get: () => '<svg></svg>' }), toast: () => undefined, els: { input } };
    vm.runInNewContext(`${cutChat('  function trapTarget(', '  // ------------------------------------------------------------------ markdown')}\nout_ = { openLightbox, ENLARGE, THUMBS };`, sb);
    const { openLightbox, ENLARGE, THUMBS } = sb.out_ as { openLightbox: (src: string, alt: string) => void; ENLARGE: string; THUMBS: string };
    assert.match(ENLARGE, /tabindex="0"/); assert.match(ENLARGE, /role="button"/);
    assert.ok(THUMBS.includes('.imgs img') && THUMBS.includes('.md-img'));
    thumb.focus();
    openLightbox(thumb.src, thumb.alt);
    const lb = d.document.getElementById('lightbox')!;
    assert.strictEqual(lb.getAttribute('role'), 'dialog');
    assert.strictEqual(lb.getAttribute('aria-modal'), 'true');
    assert.strictEqual(lb.getAttribute('aria-label'), 'Image: Image 1 of 1');
    const close = lb.querySelector('.lb-close')!; const copy = lb.querySelector('.lb-copy')!;
    assert.strictEqual(close.getAttribute('aria-label'), 'Close image');
    assert.strictEqual(copy.getAttribute('aria-label'), 'Copy image');
    assert.strictEqual(focus.active, close, 'Close has focus on open');
    assert.ok(key(close, 'Tab').defaultPrevented); assert.strictEqual(focus.active, copy, 'Tab from the last button wraps to the first');
    assert.ok(key(copy, 'Tab', { shiftKey: true }).defaultPrevented); assert.strictEqual(focus.active, close);
    key(close, 'Escape');
    assert.ok(lb.classList.contains('hidden'));
    assert.strictEqual(focus.active, thumb, 'focus returns to the thumbnail');
    // Esc also closes when focus left the bar (a click on the picture).
    openLightbox(thumb.src, thumb.alt); focus.active = null; d.docKey('Escape');
    assert.ok(lb.classList.contains('hidden'));
  });

  test('every enlargeable image in chat.js is keyboard-operable, and Enter or Space opens it', () => {
    const src = read('media/chat.js');
    assert.ok(!src.includes('Click to enlarge'), 'no mouse-only hint left');
    assert.match(src, /class="md-img"[^`]*tabindex="0" role="button"/);
    assert.match(src, /els\.messages\.addEventListener\('keydown', \(e\) => \{\s*if \(\(e\.key !== 'Enter' && e\.key !== ' '\)[^\n]*THUMBS/);
  });

  test('the Tasks toggle reports aria-expanded and controls the list', () => {
    const html = read('src/ui/chatViewProvider.ts');
    assert.match(html, /<button id="tasksToggle" class="panel-head" aria-expanded="true" aria-controls="tasksList">/);
    assert.match(html, /<button id="changesToggle" class="panel-toggle" aria-expanded="false" aria-controls="changesList">/);
    for (const f of ['scripts/ui-preview.html', 'scripts/ui-preview-parallel.html']) { assert.ok(read(f).includes('id="tasksToggle" class="panel-head" aria-expanded="true" aria-controls="tasksList"'), f); }
    const d = docFor();
    const host = d.doc.body.appendChild(new El('div'));
    host.innerHTML = '<div id="tasks" class="panel"><button id="tasksToggle" class="panel-head" aria-expanded="true" aria-controls="tasksList"><span id="tasksLabel">Tasks</span><span id="tasksMeter"><i></i></span></button><ul id="tasksList"></ul></div>';
    const q = (id: string) => host.querySelector(`#${id}`)!;
    const els = { tasks: q('tasks'), tasksToggle: q('tasksToggle'), tasksLabel: q('tasksLabel'), tasksMeter: q('tasksMeter'), tasksList: q('tasksList'), messages: new El('div') };
    const state = { session: { id: 's1', todos: [{ id: 1, title: 'Write it', status: 'in_progress' }] }, running: new Set<string>() };
    const sb: Record<string, unknown> = { document: d.document, el: elFn(d.document), I: new Proxy({}, { get: () => '<svg></svg>' }), esc: (s: string) => String(s), els, state, CSS: { escape: (s: string) => s } };
    const src = read('media/chat.js');
    const todoFailed = src.split('\n').find((l) => l.trim().startsWith('function todoFailed('))!;
    const start = src.indexOf('  let tasksSig = ');
    const fn = src.indexOf('  function renderTasks()', start);
    const end = src.indexOf('\n  }\n', fn);
    vm.runInNewContext(`${todoFailed}\n${src.slice(start, end + 4)}\nout_ = { renderTasks, tasksUserOpen };`, sb);
    const { renderTasks, tasksUserOpen } = sb.out_ as { renderTasks: () => void; tasksUserOpen: Map<string, boolean> };
    renderTasks();
    assert.strictEqual(els.tasksToggle.getAttribute('aria-expanded'), 'false', 'idle: folded');
    state.running.add('s1'); renderTasks();
    assert.strictEqual(els.tasksToggle.getAttribute('aria-expanded'), 'true', 'running: open');
    tasksUserOpen.set('s1', false); renderTasks();
    assert.strictEqual(els.tasksToggle.getAttribute('aria-expanded'), 'false', 'the user folded it');
    assert.ok(els.tasksList.classList.contains('hidden'));
  });
});

/** media/continuity.js run whole against ./miniDom, with chat.js's helpers (trapTab lifted from chat.js). */
function loadContinuity() {
  const d = docFor();
  const app = d.doc.body.appendChild(new El('div')); app.id = 'app';
  const input = app.appendChild(new El('textarea')); input.id = 'input';
  const opener = app.appendChild(new El('button'));
  const posted: Record<string, unknown>[] = [];
  const timers: (() => void)[] = [];
  const el = elFn(d.document);
  const helpers: Record<string, unknown> = { document: d.document };
  vm.runInNewContext(`${cutChat('  function trapTarget(', '  /** Image thumbnails open')}\nout_ = trapTab;`, helpers);
  const window: Record<string, unknown> = {
    LPChat: { post: (m: Record<string, unknown>) => posted.push(JSON.parse(JSON.stringify(m))), esc: (s: unknown) => String(s ?? '').replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`), el, I: new Proxy({}, { get: () => '<svg></svg>' }), timeAgo: () => '5m', md: (s: string) => s, toast: () => undefined, trapTab: helpers.out_ },
  };
  const sb: Record<string, unknown> = { window, document: d.document, setTimeout: (f: () => void) => { timers.push(f); return 0; }, clearTimeout: () => undefined, console };
  vm.runInNewContext(read('media/continuity.js'), sb);
  const api = window.LPContinuity as { open: (p: string, params?: unknown) => void; receive: (m: unknown) => void; close: (b: boolean) => void };
  const root = d.document.getElementById('cpage')!;
  const flush = () => { while (timers.length) { timers.shift()!(); } };
  return { api, root, posted, flush, input, opener };
}

suite('Continuity pages', () => {
  const trashPage = { type: 'continuityPage', page: 'trash', data: { rows: [{ id: 'c1', title: 'Old chat', messageCount: 3, trashedAt: 1 }], retentionDays: 30 } };

  test('a page is a modal: Back has focus, Tab wraps, closing returns focus to what opened it', () => {
    const c = loadContinuity();
    c.opener.focus();
    c.api.open('trash'); c.flush();
    c.api.receive(trashPage); c.flush();
    assert.strictEqual(c.root.getAttribute('role'), 'dialog');
    const buttons = c.root.querySelectorAll('button');
    const back = c.root.querySelector('.cp-back')!;
    back.focus();
    const last = buttons[buttons.length - 1];
    last.focus();
    assert.ok(key(last, 'Tab').defaultPrevented, 'Tab on the last control is trapped');
    assert.strictEqual(focus.active, back, 'and wraps to Back');
    assert.ok(key(back, 'Tab', { shiftKey: true }).defaultPrevented);
    assert.strictEqual(focus.active, last);
    c.api.close(false);
    assert.strictEqual(focus.active, c.opener, 'focus goes back to the opener');
  });

  test('Restore keeps the Trash row until the host answers, and it stays on "Nothing to restore"', () => {
    const c = loadContinuity();
    c.api.open('trash'); c.api.receive(trashPage);
    const row = () => c.root.querySelector('.cp-list .cp-row');
    click(row()!.querySelector('[data-c="restore"]')!);
    assert.deepStrictEqual(c.posted.filter((m) => m.type === 'convAction'), [{ type: 'convAction', ids: ['c1'], action: 'restore' }]);
    assert.ok(row(), 'the row is still there');
    assert.strictEqual(row()!.getAttribute('aria-busy'), 'true');
    assert.ok(row()!.querySelectorAll('button').every((b) => b.disabled), 'its buttons wait');
    // The host could not restore it (navChanged → refresh → the same page again).
    c.api.receive(trashPage);
    assert.ok(row(), 'still listed');
    assert.ok(!row()!.querySelector('[data-c="restore"]')!.disabled, 'Restore works again');
    // Restored: the refreshed page no longer has it.
    c.api.receive({ ...trashPage, data: { rows: [], retentionDays: 30 } });
    assert.ok(!row());
  });

  test('Memory: the off notice names the Settings section, and Open folder is a real button', () => {
    const c = loadContinuity();
    c.api.open('memory');
    c.api.receive({ type: 'continuityPage', page: 'memory', data: { enabled: false, items: [], types: [{ id: 'project', description: 'This repository' }] } });
    const warn = c.root.querySelector('.mm-warn')!;
    assert.match(warn.textContent, /Settings → Memory & history\)/);
    const folder = c.root.querySelector('[data-c="folder"]')!;
    assert.strictEqual(folder.tagName, 'BUTTON', 'a button gets Enter and Space from the browser');
    click(folder);
    assert.deepStrictEqual(c.posted.find((m) => m.type === 'memoryAction'), { type: 'memoryAction', action: 'openFolder', to: 'project' });
  });
});

/** rovingStrip and rovingIndex from media/settings.js. */
function loadRoving() {
  const src = read('media/settings.js');
  const a = src.indexOf('  /** Where an arrow key, Home or End moves');
  const b = src.indexOf('  const I = {', a);
  assert.ok(a > 0 && b > a, 'rovingStrip not found in media/settings.js');
  const d = docFor();
  const sb: Record<string, unknown> = { document: d.document, setTimeout: (f: () => void) => { f(); return 0; } };
  vm.runInNewContext(`${src.slice(a, b)}\nout_ = { rovingIndex, rovingStrip };`, sb);
  return { ...(sb.out_ as { rovingIndex: (n: number, i: number, k: string) => number; rovingStrip: (l: MiniElement, o: Record<string, unknown>) => MiniElement }), d };
}

suite('Settings: tab strips', () => {
  test('arrows wrap, Home and End jump, other keys do nothing', () => {
    const { rovingIndex } = loadRoving();
    assert.strictEqual(rovingIndex(3, 2, 'ArrowRight'), 0);
    assert.strictEqual(rovingIndex(3, 0, 'ArrowLeft'), 2);
    assert.strictEqual(rovingIndex(3, 1, 'ArrowDown'), 2);
    assert.strictEqual(rovingIndex(3, 1, 'ArrowUp'), 0);
    assert.strictEqual(rovingIndex(3, 1, 'Home'), 0);
    assert.strictEqual(rovingIndex(3, 1, 'End'), 2);
    assert.strictEqual(rovingIndex(3, 1, 'Enter'), -1);
    assert.strictEqual(rovingIndex(3, -1, 'ArrowRight'), -1, 'focus not on a tab');
  });

  test('a tablist: one tab stop, aria-selected, aria-controls, a labelled panel, arrows select and keep focus', () => {
    const { rovingStrip, d } = loadRoving();
    const host = d.doc.body.appendChild(new El('div'));
    const panel = host.appendChild(new El('div')); panel.id = 'p';
    let sel = 'local';
    const draw = () => {
      for (const c of [...host.querySelectorAll('.strip')]) { c.remove(); }
      const list = new El('div'); list.className = 'strip'; host.insertBefore(list, panel);
      for (const k of ['local', 'cloud', 'gateway']) { const b = list.appendChild(new El('button')); b.className = `chip ${k === sel ? 'on' : ''}`; b.dataset.k = k; b.textContent = k; b.onclick = () => { sel = k; draw(); }; }
      // Not a tab: stays out of the strip's items.
      list.appendChild(new El('span'));
      rovingStrip(list, { id: 't', label: 'Kind', panel });
      return list;
    };
    const list = draw();
    assert.strictEqual(list.getAttribute('role'), 'tablist');
    assert.strictEqual(list.getAttribute('aria-label'), 'Kind');
    const tabs = () => host.querySelectorAll('.strip button');
    assert.deepStrictEqual(tabs().map((b) => [b.id, b.getAttribute('role'), b.getAttribute('aria-selected'), b.getAttribute('tabindex'), b.getAttribute('aria-controls')]), [
      ['t-local', 'tab', 'true', '0', 'p'], ['t-cloud', 'tab', 'false', '-1', 'p'], ['t-gateway', 'tab', 'false', '-1', 'p'],
    ]);
    assert.strictEqual(panel.getAttribute('role'), 'tabpanel');
    assert.strictEqual(panel.getAttribute('aria-labelledby'), 't-local');
    tabs()[0].focus();
    assert.ok(onKey(host.querySelector('.strip')!, tabs()[0], 'ArrowLeft').defaultPrevented);
    assert.strictEqual(sel, 'gateway', 'ArrowLeft from the first wraps to the last and selects it');
    assert.strictEqual(focus.active, d.document.getElementById('t-gateway'), 'focus follows into the re-rendered strip');
    assert.strictEqual(panel.getAttribute('aria-labelledby'), 't-gateway');
    onKey(host.querySelector('.strip')!, focus.active!, 'Home');
    assert.strictEqual(sel, 'local');
    assert.ok(!onKey(host.querySelector('.strip')!, focus.active!, 'a').defaultPrevented);
  });

  test('a filter strip is a radio group', () => {
    const { rovingStrip, d } = loadRoving();
    const list = d.doc.body.appendChild(new El('div'));
    list.innerHTML = '<button class="chip on" data-k="all">All</button><button class="chip" data-k="skill">Skills</button>';
    rovingStrip(list, { role: 'radio', id: 'mk', label: 'Kind' });
    assert.strictEqual(list.getAttribute('role'), 'radiogroup');
    assert.deepStrictEqual(list.querySelectorAll('button').map((b) => [b.getAttribute('role'), b.getAttribute('aria-checked'), b.getAttribute('aria-selected'), b.getAttribute('tabindex')]), [['radio', 'true', null, '0'], ['radio', 'false', null, '-1']]);
  });

  test('every former tablist in settings.js goes through rovingStrip, and the provider search is outside its tablist', () => {
    const src = read('media/settings.js');
    for (const id of ["id: 'add-prov-tab'", "id: 'gal-tab'", "id: 'cz-tab'", "role: 'radio', id: 'mk-kind'", "id: 'mcp-view'", 'id: `${key}-tab`']) { assert.ok(src.includes(id), id); }
    // Only the recovery tabs (the model for the helper) still set role=tablist by hand.
    assert.deepStrictEqual((src.match(/setAttribute\('role', 'tablist'\)/g) || []).length, 1);
    assert.ok(!/role="tab" aria-selected|setAttribute\('role', 'tab'\)/.test(src.replace(/b\.setAttribute\('role', 'tab'\); b\.setAttribute\('aria-selected', String\(on\)\); b\.setAttribute\('aria-controls', 'rec-panel'\)/, '')), 'no hand-written tabs outside the recovery view');
    assert.match(src, /chips\.append\(kinds, q\)/);
  });
});

suite('Keybindings and wording', () => {
  const pkg = JSON.parse(read('package.json')) as { contributes: { keybindings: { command: string; key: string; mac?: string; when?: string }[]; commands: { command: string; title: string }[] } };
  const kb = pkg.contributes.keybindings;

  test('Open Chat has a key outside the editor and one inside it', () => {
    const open = kb.filter((k) => k.command === 'localpilot.openChat');
    assert.deepStrictEqual(open.map((k) => [k.key, k.mac, k.when]), [['ctrl+shift+l', 'cmd+shift+l', '!editorTextFocus'], ['ctrl+alt+l', 'ctrl+cmd+l', 'editorTextFocus']]);
  });

  test('Reject File has a key that mirrors Accept File, and no two bindings collide', () => {
    const accept = kb.find((k) => k.command === 'localpilot.review.acceptFile')!;
    const reject = kb.find((k) => k.command === 'localpilot.review.rejectFile')!;
    assert.strictEqual(reject.when, accept.when);
    assert.deepStrictEqual([reject.key, reject.mac], ['ctrl+shift+backspace', 'cmd+shift+backspace']);
    assert.strictEqual(keyLabel(reject.mac!, true), '⇧⌘⌫');
    assert.strictEqual(keyLabel(reject.key, false), 'Ctrl+Shift+Backspace');
    for (const plat of ['key', 'mac'] as const) {
      const seen = new Set<string>();
      for (const k of kb) { const id = `${k[plat] ?? k.key}|${k.when ?? ''}`; assert.ok(!seen.has(id), `${plat}: ${id} bound twice`); seen.add(id); }
    }
  });

  test('changes are accepted or rejected everywhere (no Keep / Undo pair)', () => {
    const title = (c: string) => pkg.contributes.commands.find((x) => x.command === c)!.title;
    assert.deepStrictEqual(['keepChanges', 'undoChanges', 'keepAllChanges', 'undoAllChanges', 'review.acceptFile', 'review.rejectFile'].map((c) => title(`localpilot.${c}`)), ['Accept', 'Reject', 'Accept All Agent Changes', 'Reject All Agent Changes', 'Accept File', 'Reject File']);
    const chat = read('media/chat.js');
    assert.ok(!/<span>Keep( all)?<\/span>/.test(chat), 'the recovery card says Accept');
    assert.ok(!/Keep all|Undo all/.test(read('src/extension.ts')), 'the session menu says Accept all / Reject all');
    assert.ok(!/'Keep All'/.test(read('src/ui/runNotifier.ts')));
  });

  test('Import sits next to Export in the conversation menus and the navigator', () => {
    const chat = read('media/chat.js');
    assert.ok((chat.match(/post\(\{ type: 'importConversations' \}\)/g) || []).length >= 3, 'row menu, Trash row menu and the navigator foot');
    assert.match(chat, /data-a="import"/);
  });

  test('Empty Trash says "1 item" / "n items", not "item(s)"', () => {
    assert.ok(!read('src/ui/continuityHost.ts').includes('item(s)'));
    assert.ok(!read('src/ui/continuityData.ts').includes('item(s)'));
  });
});
});
