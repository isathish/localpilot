import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';
import { click, dispatch, MiniElement, miniDocument } from './miniDom';

const EXT_ROOT = path.resolve(__dirname, '..', '..');

type Fn = (...a: unknown[]) => unknown;
interface Pieces {
  linkify: (t: string) => string;
  codeBlock: (code: string, info: string, closed?: boolean) => string;
  isStackTrace: (code: string, lang: string) => boolean;
  debugReport: (lines: string[], start: number, inline: (s: string) => string) => { html: string; end: number } | null;
  traceView: (t: unknown, totals: unknown, filter: string) => string;
  openTrace: Fn;
  showTrace: Fn;
  renderRunHint: Fn;
  applyConnectivity: Fn;
}

/** The run-related pieces of media/chat.js, against the preview harness's copy of the markup (its ids must match the view's). */
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
  const html = fs.readFileSync(path.join(EXT_ROOT, 'scripts', 'ui-preview.html'), 'utf8');
  const view = fs.readFileSync(path.join(EXT_ROOT, 'src', 'ui', 'chatViewProvider.ts'), 'utf8');
  const doc = miniDocument();
  const host = doc.body.appendChild(doc.createElement('div'));
  for (const id of ['offline', 'runHint', 'trace']) {
    const tag = new RegExp(`<div id="${id}"[^>]*></div>`).exec(html);
    assert.ok(tag, `#${id} missing from scripts/ui-preview.html`);
    assert.ok(view.includes(tag[0]), `#${id} in the preview differs from chatViewProvider.ts`);
    host.insertAdjacentHTML('beforeend', tag[0]);
  }
  const input = host.appendChild(doc.createElement('textarea')) as MiniElement & { value: string };
  input.value = '';
  const posted: Record<string, unknown>[] = [];
  const toasts: string[] = [];
  const menus: { items: { label: string }[] }[] = [];
  const calls: string[] = [];
  const winListeners: Record<string, Fn[]> = {};
  const state = { session: { id: 's1' } as unknown, running: new Set<string>(), pendingSend: new Set<string>(), paused: new Map<string, { paused: boolean }>(), images: [] as unknown[], platform: 'darwin' };
  const sandbox: Record<string, unknown> = {
    document: doc,
    window: { addEventListener: (t: string, f: Fn) => (winListeners[t] ??= []).push(f) },
    I: new Proxy({}, { get: (_t, k) => `<svg data-i="${String(k)}"></svg>` }),
    state,
    els: { offline: host.querySelector('#offline'), runHint: host.querySelector('#runHint'), trace: host.querySelector('#trace'), input, box: host },
    post: (m: Record<string, unknown>) => posted.push(JSON.parse(JSON.stringify(m))),
    toast: (t: string) => toasts.push(t),
    openMenu: (_a: unknown, items: { label: string }[]) => menus.push({ items }),
    kb: (s: string) => s,
    steerCurrent: () => calls.push('steer'),
    queueCurrent: () => calls.push('queue'),
    sendInNewTab: () => calls.push('tab'),
    renderCtxStrip: () => calls.push('strip'),
    highlight: (c: string) => c,
    normLang: (l: string) => l || 'text',
    langForPath: () => '',
    setTimeout: () => 0,
    clearTimeout: () => undefined,
    console,
  };
  vm.runInNewContext(
    [
      line('const esc = '),
      cut('  // Stack-trace frames whose path may be absolute', '  /** ANSI SGR'),
      cut('  /** A file path standing alone on the line before a fence', '  /** `NNN | text` lines'),
      cut('  // Debug mode ends its answer', '  // end of debugReport'),
      cut('  // ------------------------------------------------------------------ run trace', '\n  // The extras above follow'),
      cut('  /** Every way to send while an agent works', '  /** Queue the composer text for the running agent'),
      cut("  // Offline: the host's connectivity monitor decides", '  // Screenshot capture options'),
      'out_ = { linkify, codeBlock, isStackTrace, debugReport, traceView, openTrace, showTrace, renderRunHint, applyConnectivity };',
    ].join('\n'),
    sandbox,
    { timeout: 5_000 }
  );
  return { ...(sandbox.out_ as Pieces), state, posted, toasts, menus, calls, doc, host, input, winListeners };
}

const links = (html: string): string[] => {
  const doc = miniDocument();
  const d = doc.body.appendChild(doc.createElement('div'));
  d.innerHTML = html;
  return d.querySelectorAll('.path-link').map((l) => `${l.dataset.path}:${l.dataset.line}`);
};

suite('Chat webview: stack traces and the debug report', () => {
  test('stack frames become file:line links, absolute paths and Windows paths included', () => {
    const c = loadChat();
    assert.deepStrictEqual(links(c.linkify('    at roll (/Users/me/app/src/dice.js:12:5)\n    at Object.<anonymous> (node:internal/main:1:1)')), ['/Users/me/app/src/dice.js:12']);
    assert.deepStrictEqual(links(c.linkify('  File "/home/me/dice.py", line 22, in roll_dice')), ['/home/me/dice.py:22']);
    assert.deepStrictEqual(links(c.linkify('   at Dice.Roll() in C:\\src\\Dice.cs:line 42')), ['C:\\src\\Dice.cs:42']);
    assert.deepStrictEqual(links(c.linkify('\t/usr/local/go/src/runtime/panic.go:1038 +0x215')), ['/usr/local/go/src/runtime/panic.go:1038']);
    assert.ok(links(c.linkify('at com.x.Dice.roll(Dice.java:12)')).includes('Dice.java:12'));
    assert.deepStrictEqual(links(c.linkify('    at f (file:///C:/app/x.mjs:3:9)')), ['C:/app/x.mjs:3']);
    // Relative paths and URLs keep working, and a URL is never mistaken for a path.
    assert.deepStrictEqual(links(c.linkify('see src/a.ts:4 and https://example.com/x/y.js:5')), ['src/a.ts:4']);
    assert.match(c.linkify('https://example.com/x/y.js:5'), /<a href="https:\/\/example.com\/x\/y.js:5">/);
    // Escaping still holds around the links.
    assert.ok(!c.linkify('File "<x>.py", line 1').includes('<x>'));
  });

  test('a fenced stack trace renders as linked frames without Apply; ordinary code keeps highlighting and Apply', () => {
    const c = loadChat();
    const trace = 'Traceback (most recent call last):\n  File "tests/test_dice.py", line 14, in test_spaces\n    assert roll_dice("2d10 - 1")\n  File "dice.py", line 22, in roll_dice\nTypeError: bad';
    assert.strictEqual(c.isStackTrace(trace, ''), true);
    assert.strictEqual(c.isStackTrace('TypeError: x\n    at f (src/a.ts:3:1)', 'text'), true);
    assert.strictEqual(c.isStackTrace('def f():\n    return 1', 'python'), false);
    assert.strictEqual(c.isStackTrace('const x = "at f (a.js:1:1)";\nconst y = 2;\nconst z = 3;', 'js'), false);
    const doc = miniDocument();
    const d = doc.body.appendChild(doc.createElement('div'));
    d.innerHTML = c.codeBlock(trace, '');
    assert.ok(d.querySelector('.code.stack'));
    assert.strictEqual(d.querySelector('[data-code="apply"]'), null);
    assert.ok(d.querySelector('[data-code="copy"]'));
    assert.deepStrictEqual(d.querySelectorAll('.path-link').map((l) => `${l.dataset.path}:${l.dataset.line}`), ['tests/test_dice.py:14', 'dice.py:22']);
    d.innerHTML = c.codeBlock('x = 1', 'python');
    assert.strictEqual(d.querySelector('.code.stack'), null);
    assert.ok(d.querySelector('[data-code="apply"]'));
  });

  test('"## Debug report" with its labelled rows becomes a card; Verified or Not verified from the text', () => {
    const c = loadChat();
    const inline = (s: string) => s.replace(/`([^`]+)`/g, '<code>$1</code>');
    const md = ['## Debug report', '- **Symptom:** `roll_dice` crashed', '- **Root cause:** regex too strict', '  in `dice.py:22`', '- **Fix:** relaxed it', '- **Verified:** `pytest -q` passes', '', 'Anything else?'];
    const r = c.debugReport(md, 0, inline)!;
    assert.strictEqual(r.end, 7, 'stops before the text after the report');
    const doc = miniDocument();
    const d = doc.body.appendChild(doc.createElement('div'));
    d.innerHTML = r.html;
    assert.deepStrictEqual(d.querySelectorAll('dt').map((x) => x.textContent), ['Symptom', 'Root cause', 'Fix', 'Verified']);
    assert.strictEqual(d.querySelectorAll('dd')[1].textContent, 'regex too strictin dice.py:22');
    assert.strictEqual(d.querySelector('.dr-v')!.textContent, 'Verified');
    assert.ok(d.querySelector('.dr-v.ok'));
    const not = c.debugReport(['### Debug report', 'Symptom: x', 'Root cause: y', '**Verified**: Not verified: pytest is missing'], 0, inline)!;
    d.innerHTML = not.html;
    assert.strictEqual(d.querySelector('.dr-v.warn')!.textContent, 'Not verified');
    // A heading alone, or with one known row, stays Markdown.
    assert.strictEqual(c.debugReport(['## Debug report', 'Some prose.'], 0, inline), null);
    assert.strictEqual(c.debugReport(['## Debug report', '- **Fix:** x'], 0, inline), null);
    assert.strictEqual(c.debugReport(['## Summary', '- **Fix:** x', '- **Symptom:** y'], 0, inline), null);
  });

  test('Debug mode asks for the report in the format the card reads', () => {
    const src = fs.readFileSync(path.join(EXT_ROOT, 'src', 'agent', 'prompts.ts'), 'utf8');
    for (const label of ['## Debug report', '**Symptom:**', '**Root cause:**', '**Fix:**', '**Verified:**', 'Not verified:']) {
      assert.ok(src.includes(label), `${label} missing from the Debug prompt`);
    }
  });
});

suite('Chat webview: run hint, offline banner and the trace sheet', () => {
  test('while running, the hint says what Enter and Alt+Enter do; its buttons steer, queue or open the send choices', () => {
    const c = loadChat();
    const hint = c.host.querySelector('#runHint')!;
    c.renderRunHint();
    assert.ok(hint.classList.contains('hidden'), 'idle: no hint');
    c.state.running.add('s1');
    c.renderRunHint();
    assert.ok(!hint.classList.contains('hidden'));
    assert.match(hint.textContent, /Enter\s*adds to this run/);
    assert.match(hint.textContent, /Alt\+Enter\s*sends after it/);
    click(hint.querySelector('[data-r="steer"]')!);
    assert.deepStrictEqual(c.calls, [], 'an empty draft is not sent');
    assert.strictEqual(c.toasts.length, 1);
    c.input.value = 'also update the README';
    click(hint.querySelector('[data-r="steer"]')!);
    click(hint.querySelector('[data-r="queue"]')!);
    assert.deepStrictEqual(c.calls, ['steer', 'queue']);
    click(hint.querySelector('[data-r="more"]')!);
    assert.deepStrictEqual(JSON.parse(JSON.stringify(c.menus[0].items.map((i) => i.label))), ['Add to this agent', 'Send after this turn', 'Send in a new tab', 'Stop this agent first', 'Cancel']);
    c.state.paused.set('s1', { paused: true });
    c.renderRunHint();
    assert.match(hint.textContent, /read when it resumes/);
  });

  test('the offline banner follows the host: local fallback or none, Check again, then "Back online"', () => {
    const c = loadChat();
    const b = c.host.querySelector('#offline')!;
    c.applyConnectivity({ type: 'connectivity', offline: true, since: Date.now(), local: true });
    assert.ok(!b.classList.contains('hidden'));
    assert.match(b.textContent, /Offline: using local models only/);
    assert.strictEqual(b.querySelector('[data-n="models"]'), null);
    click(b.querySelector('[data-n="check"]')!);
    assert.deepStrictEqual(c.posted.pop(), { type: 'checkConnection' });
    c.applyConnectivity({ type: 'connectivity', offline: true, since: Date.now(), local: false, checking: true });
    assert.match(b.textContent, /no local model available/);
    assert.ok(b.querySelector('[data-n="check"]')!.disabled, 'disabled while a check runs');
    click(b.querySelector('[data-n="models"]')!);
    assert.deepStrictEqual(c.posted.pop(), { type: 'openSettings', section: 'models' });
    c.applyConnectivity({ type: 'connectivity', offline: false, local: true });
    assert.match(b.textContent, /Back online/);
    assert.ok(c.calls.includes('strip'), 'the welcome strip is redrawn');
    // The webview's own network events only ask the host to check.
    c.winListeners.offline[0]();
    assert.deepStrictEqual(c.posted.pop(), { type: 'netHint', online: false });
  });

  test('Trace opens a sheet, asks the host, renders rows with durations, filters problems and exports', () => {
    const c = loadChat();
    const sheet = c.host.querySelector('#trace')!;
    c.openTrace('s1', 't1', null);
    assert.ok(!sheet.classList.contains('hidden'));
    assert.deepStrictEqual(c.posted.pop(), { type: 'openTrace', sessionId: 's1', traceId: 't1' });
    const trace = {
      version: 1, id: 't1', sessionId: 's1', title: 'Fix the parser', startedAt: 0, durationMs: 10_000, outcome: 'ok', model: 'ollama/qwen',
      entries: [
        { kind: 'model', name: 'qwen', start: 0, end: 4000, status: 'ok', firstTokenMs: 1200 },
        { kind: 'tool', name: 'run_command', start: 4000, end: 6500, status: 'error', detail: 'pytest -q' },
        { kind: 'retry', name: 'Retry 1/3', start: 6500, detail: 'connection' },
        { kind: 'tool', name: 'write_file', start: 7000, end: 7100, status: 'ok', depth: 1, agent: 'tester' },
      ],
    };
    c.showTrace({ type: 'trace', sessionId: 's1', traceId: 'other', trace });
    assert.strictEqual(sheet.querySelector('.tr-row'), null, 'another trace\'s reply is ignored');
    c.showTrace({ type: 'trace', sessionId: 's1', traceId: 't1', trace, totals: { modelCalls: 1, toolCalls: 2, failedTools: 1, retries: 1, fallbacks: 0, approvals: 0, errors: 0, modelMs: 4000, toolMs: 2500 } });
    const rows = sheet.querySelectorAll('.tr-row');
    assert.strictEqual(rows.length, 4);
    assert.match(sheet.querySelector('.tr-facts')!.textContent, /Finished.*10 s.*qwen.*1 model call.*2 tool calls \(1 failed\).*1 retry/);
    assert.strictEqual(rows[0].querySelector('.dur')!.textContent, '4.0 s');
    assert.match(rows[0].querySelector('.det')!.textContent, /first token 1.2 s/);
    assert.strictEqual(rows[1].querySelector('.stl')!.textContent, 'failed');
    assert.strictEqual(rows[2].querySelector('.stl'), null, 'a retry is a point, not a failed step');
    assert.ok(rows[3].classList.contains('sub'));
    click(sheet.querySelector('[data-f="problems"]')!);
    assert.deepStrictEqual(sheet.querySelectorAll('.tr-row .name').map((n) => n.textContent), ['run_command', 'Retry 1/3']);
    click(sheet.querySelector('[data-t="export"]')!);
    assert.deepStrictEqual(c.posted.pop(), { type: 'exportTrace', sessionId: 's1', traceId: 't1' });
    dispatch(sheet, 'keydown', { key: 'Escape' });
    assert.ok(sheet.classList.contains('hidden'));
    // A trace that is gone says so instead of an empty list.
    c.openTrace('s1', 't9', null);
    c.showTrace({ type: 'trace', sessionId: 's1', traceId: 't9', trace: null });
    assert.match(sheet.textContent, /no longer stored/);
  });
});
