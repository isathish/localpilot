#!/usr/bin/env node
// Tests docs/assets/pageviews.js against a mock Abacus server: one view per load for the page and the site total, a
// visitor only on a browser's first visit, nothing counted under Global Privacy Control, build-time numbers as a floor,
// and live updates over the SSE stream. Runs the real script with a minimal DOM stand-in; no browser needed.
// Run: node --experimental-eventsource scripts/pageviews-test.mjs   (Node 22+; EventSource is still behind a flag)
import fs from 'node:fs';
import http from 'node:http';
import vm from 'node:vm';

if (typeof EventSource === 'undefined') {
  console.error('Run with: node --experimental-eventsource scripts/pageviews-test.mjs');
  process.exit(2);
}
const SRC = fs.readFileSync(new URL('../docs/assets/pageviews.js', import.meta.url), 'utf8');
let failures = 0;
const check = (name, cond, detail) => {
  console.log(`  ${cond ? '✔' : '✖'} ${name}`);
  if (!cond) {
    failures++;
    if (detail !== undefined) {
      console.log(`      ${JSON.stringify(detail)}`);
    }
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ mock Abacus
const counters = new Map();
const calls = [];
const listeners = new Map();
const srv = http.createServer((req, res) => {
  res.setHeader('access-control-allow-origin', '*');
  const [, op, ns, ...rest] = decodeURIComponent(req.url.split('?')[0]).split('/');
  const key = `${ns}/${rest.join('/')}`;
  calls.push(`${op} ${key}`);
  if (op === 'hit') {
    counters.set(key, (counters.get(key) ?? 0) + 1);
    for (const l of listeners.get(key) ?? []) {
      l(counters.get(key));
    }
    return res.end(JSON.stringify({ value: counters.get(key) }));
  }
  if (op === 'get') {
    if (!counters.has(key)) {
      res.statusCode = 404;
      return res.end(JSON.stringify({ error: 'Key not found' }));
    }
    return res.end(JSON.stringify({ value: counters.get(key) }));
  }
  if (op === 'stream') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'access-control-allow-origin': '*' });
    const send = (v) => res.write(`data: ${JSON.stringify({ value: v })}\n\n`);
    send(counters.get(key) ?? 0);
    const set = listeners.get(key) ?? new Set();
    set.add(send);
    listeners.set(key, set);
    req.on('close', () => set.delete(send));
    return;
  }
  res.statusCode = 404;
  res.end('{}');
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const API = `http://127.0.0.1:${srv.address().port}`;

/** Loads a page: runs pageviews.js with elements for `kinds`, returns them and a way to close its streams. */
function load({ path, kinds, base = {}, storage, gpc = false }) {
  const els = kinds.map((kind) => {
    const attrs = { 'data-pv': kind, 'data-pv-base': String(base[kind] ?? 0) };
    const wrap = { hidden: true };
    return {
      kind, wrap, textContent: '', title: '', offsetWidth: 0,
      classList: { add() {}, remove() {} },
      getAttribute: (n) => attrs[n],
      closest: () => wrap,
    };
  });
  const handlers = {};
  const window = {
    matchMedia: () => ({ matches: true }), // reduced motion: numbers are set at once, easy to assert
    addEventListener: (t, f) => (handlers[`w:${t}`] = f),
  };
  const ctx = {
    window,
    document: {
      currentScript: { dataset: { api: API, ns: 'test-ns', base: '/localpilot' } },
      querySelectorAll: () => els,
      hidden: false,
      addEventListener: (t, f) => (handlers[t] = f),
    },
    navigator: { globalPrivacyControl: gpc, doNotTrack: '0' },
    location: { pathname: path },
    localStorage: storage,
    fetch, EventSource, Intl, performance, setInterval, clearInterval, Promise, JSON, Math, Number, String, Object, Array, isFinite,
    requestAnimationFrame: (f) => setTimeout(() => f(performance.now()), 0),
  };
  window.document = ctx.document;
  vm.runInNewContext(SRC, ctx);
  return { els: Object.fromEntries(els.map((e) => [e.kind, e])), close: () => handlers['w:pagehide']?.() };
}
const store = () => {
  const m = new Map();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)) };
};

try {
  console.log('[site page views]');
  const browserA = store();
  const home = load({ path: '/localpilot/', kinds: ['total', 'visitors'], storage: browserA });
  await sleep(400);
  check('home load counts the home page and the site total', counters.get('test-ns/p.home') === 1 && counters.get('test-ns/site.views') === 1, calls);
  check('first visit from a browser counts one visitor', counters.get('test-ns/site.visitors') === 1);
  check('home shows the live totals and reveals the line', home.els.total.textContent === '1' && home.els.visitors.textContent === '1' && home.els.total.wrap.hidden === false, home.els.total);
  home.close();

  const docs = load({ path: '/localpilot/docs/models/', kinds: ['page'], storage: browserA });
  await sleep(400);
  check('docs page: counted under its own key; the same browser is not a new visitor', counters.get('test-ns/p.docs.models') === 1 && counters.get('test-ns/site.views') === 2 && counters.get('test-ns/site.visitors') === 1, [...counters]);
  check('docs page shows its own count', docs.els.page.textContent === '1');

  console.log('[live updates]');
  const reader = load({ path: '/localpilot/docs/models/', kinds: ['page'], storage: store() });
  await sleep(400);
  check('a second reader sees 2', reader.els.page.textContent === '2', reader.els.page.textContent);
  // Two more people open the page elsewhere: the open pages update over the stream without reloading.
  await fetch(`${API}/hit/test-ns/p.docs.models`);
  await fetch(`${API}/hit/test-ns/p.docs.models`);
  await sleep(500);
  check('open pages update live as others read (stream)', reader.els.page.textContent === '4' && docs.els.page.textContent === '4', { reader: reader.els.page.textContent, first: docs.els.page.textContent });
  reader.close();
  docs.close();

  console.log('[privacy & floors]');
  const before = counters.get('test-ns/p.docs.models');
  const gpc = load({ path: '/localpilot/docs/models/', kinds: ['page'], storage: store(), gpc: true });
  await sleep(400);
  check('Global Privacy Control: numbers shown, nothing counted', counters.get('test-ns/p.docs.models') === before && gpc.els.page.textContent === String(before) && !calls.slice(-4).some((c) => c.startsWith('hit')), calls.slice(-4));
  gpc.close();
  const floored = load({ path: '/localpilot/guides/ollama-vscode/', kinds: ['page'], base: { page: 1234 }, storage: store() });
  await sleep(400);
  check('build-time Google Analytics number is the floor (1,234, not 1)', floored.els.page.textContent === '1,234' && counters.get('test-ns/p.guides.ollama-vscode') === 1, floored.els.page.textContent);
  floored.close();
  const big = load({ path: '/localpilot/docs/features/', kinds: ['page'], base: { page: 48210 }, storage: store() });
  await sleep(400);
  check('large numbers are compact (48.2K)', big.els.page.textContent === '48.2K', big.els.page.textContent);
  big.close();
} finally {
  srv.close();
  srv.closeAllConnections?.();
}
console.log(failures ? `\n${failures} page view check(s) FAILED` : '\nAll page view checks passed');
process.exit(failures ? 1 : 0);
