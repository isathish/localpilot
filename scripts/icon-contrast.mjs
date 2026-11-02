#!/usr/bin/env node
// Icon contrast check: every visible icon (svg, logo tile, monogram) in the chat, Settings and setup webviews, in dark,
// light and both high-contrast themes, from the preview harnesses. For each it measures the colour it is drawn in
// against the background behind it; WCAG 1.4.11 wants at least 3:1 for icons. Exits 1 when any icon is below that.
//   npm run test:contrast                (needs Chrome; set CHROME=… if it is elsewhere)
import { spawn } from 'node:child_process'; import fs from 'node:fs'; import path from 'node:path'; import os from 'node:os';
const root = process.argv[2] || path.resolve(path.dirname(new URL(import.meta.url).pathname), '..'); const outFile = process.argv[3];
const C = process.env.CHROME || ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find((c) => fs.existsSync(c));
if (!C) { console.error('No Chrome/Chromium found; set CHROME=/path/to/chrome'); process.exit(2); }
const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-'));
const ch = spawn(C, ['--headless=new', '--disable-gpu', '--allow-file-access-from-files', '--remote-debugging-port=0', `--user-data-dir=${prof}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
const ws = await new Promise((r) => { let e = ''; ch.stderr.on('data', (d) => { e += d; const m = /ws:\/\/\S+/.exec(e); if (m) r(m[0]); }); });
const sock = new WebSocket(ws); await new Promise((r) => (sock.onopen = r));
let id = 0; const w = new Map(); sock.onmessage = (m) => { const x = JSON.parse(m.data); if (x.id && w.has(x.id)) { w.get(x.id)(x); w.delete(x.id); } };
const send = (method, params = {}, sessionId) => new Promise((r) => { const n = ++id; w.set(n, r); sock.send(JSON.stringify({ id: n, method, params, sessionId })); });
const { result: { targetId } } = await send('Target.createTarget', { url: 'about:blank' });
const { result: { sessionId: s } } = await send('Target.attachToTarget', { targetId, flatten: true });
const PAGES = [
  ['chat', 'ui-preview.html', 'live=0', [420, 900]],
  ['chat-empty', 'ui-preview.html', 'empty=1', [420, 900]],
  ['chat-live', 'ui-preview.html', '', [420, 900]],
  ...['providers', 'models', 'gallery', 'skills', 'agent', 'dashboard', 'mcp', 'memory', 'web', 'completions', 'advanced'].map((sec) => [`settings-${sec}`, 'settings-preview.html', `section=${sec}`, [1000, 2400]]),
  ['setup', 'settings-preview.html', 'page=setup&local=1', [900, 900]],
];
const THEMES = [['dark', ''], ['light', 'light=1'], ['hc', 'hc=1'], ['hc-light', 'hc=1&light=1']];
const AUDIT = `(() => {
  // Any CSS colour (rgb, color(srgb), oklab, color-mix…) to sRGB via a 1x1 canvas, the way the browser paints it.
  const cv = document.createElement('canvas'); cv.width = cv.height = 1; const cx = cv.getContext('2d', { willReadFrequently: true });
  const parse = (c) => { if (!c || c === 'none' || c === 'transparent') return null; cx.clearRect(0,0,1,1); cx.fillStyle = '#000'; cx.fillStyle = c; cx.fillRect(0,0,1,1); const d = cx.getImageData(0,0,1,1).data; return d[3] === 0 ? null : [d[0], d[1], d[2], d[3]/255]; };
  const lum = ([r,g,b]) => { const f = (v) => { v/=255; return v <= .03928 ? v/12.92 : Math.pow((v+.055)/1.055, 2.4); }; return .2126*f(r)+.7152*f(g)+.0722*f(b); };
  const blend = (top, bot) => { const a = top[3]; return [top[0]*a+bot[0]*(1-a), top[1]*a+bot[1]*(1-a), top[2]*a+bot[2]*(1-a), 1]; };
  // Background behind an element: composite every ancestor's background colour, bottom up.
  const bgOf = (el) => { const stack = []; for (let e = el; e; e = e.parentElement) { const c = parse(getComputedStyle(e).backgroundColor); if (c && c[3] > 0) stack.push(c); } let out = parse(getComputedStyle(document.body).backgroundColor) || [30,30,30,1]; if (out[3] < 1) out = blend(out, [30,30,30,1]); for (const c of stack.reverse()) out = blend(c, out); return out; };
  const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + .05) / (y + .05); };
  const visible = (el) => { const r = el.getBoundingClientRect(); if (r.width < 6 || r.height < 6) return false; const st = getComputedStyle(el); return st.visibility !== 'hidden' && st.display !== 'none' && Number(st.opacity) > 0.2 && !el.closest('[hidden], .hidden'); };
  const out = [];
  for (const svg of document.querySelectorAll('svg')) {
    if (!visible(svg) || svg.closest('#lp-glass-defs') || svg.closest('.chart, .spark, .bars, canvas')) continue;
    const st = getComputedStyle(svg);
    const paint = st.stroke && st.stroke !== 'none' ? st.stroke : st.fill;
    const color = parse(paint && paint !== 'none' ? paint : st.color);
    if (!color) continue;
    const bg = bgOf(svg);
    const drawn = color[3] < 1 ? blend(color, bg) : color;
    const host = svg.closest('button, a, [class]');
    const tile = svg.parentElement;
    const tst = getComputedStyle(tile);
    out.push({ where: (host ? (host.id ? '#'+host.id : host.tagName.toLowerCase()+'.'+[...host.classList].slice(0,2).join('.')) : 'svg') + ' > ' + (tile.className && typeof tile.className === 'string' ? tile.className.split(' ').slice(0,2).join('.') : tile.tagName.toLowerCase()),
      ratio: +ratio(drawn, bg).toFixed(2), color: drawn.map(Math.round).slice(0,3).join(','), bg: bg.map(Math.round).slice(0,3).join(','),
      filter: st.filter !== 'none' ? st.filter : (tst.filter !== 'none' ? 'tile:'+tst.filter : ''), shadow: tst.boxShadow !== 'none' ? tst.boxShadow.slice(0,60) : '', opacity: st.opacity });
  }
  // Monogram tiles (text marks like OA, GQ): their text colour vs their own tile background.
  for (const m of document.querySelectorAll('.brand-mark, .ic')) {
    if (!visible(m) || m.querySelector('svg')) continue;
    const st = getComputedStyle(m); const c = parse(st.color); const bg = bgOf(m);
    out.push({ where: 'mark:' + m.textContent.trim().slice(0,4), ratio: +ratio(c[3]<1?blend(c,bg):c, bg).toFixed(2), color: c.map(Math.round).slice(0,3).join(','), bg: bg.map(Math.round).slice(0,3).join(','), filter: st.filter !== 'none' ? st.filter : '', shadow: st.boxShadow !== 'none' ? st.boxShadow.slice(0,60) : '', opacity: st.opacity });
  }
  return out;
})()`;
const results = {};
for (const [name, file, q, [W, H]] of PAGES) {
  for (const [theme, tq] of THEMES) {
    await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false }, s);
    await send('Page.navigate', { url: `file://${root}/scripts/${file}?${[q, tq].filter(Boolean).join('&')}` }, s);
    await new Promise((r) => setTimeout(r, name === 'chat-live' ? 2500 : 1300));
    const r = await send('Runtime.evaluate', { expression: AUDIT, returnByValue: true }, s);
    results[`${name}/${theme}`] = r.result?.result?.value ?? [];
  }
}
if (outFile) { fs.writeFileSync(outFile, JSON.stringify(results, null, 1)); }
sock.close(); ch.kill(); fs.rmSync(prof, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
// Summary per page/theme, then every icon under 3:1.
for (const [k, list] of Object.entries(results)) {
  const low = list.filter((x) => x.ratio < 3);
  const filt = list.filter((x) => x.filter);
  console.log(`${k.padEnd(28)} icons:${String(list.length).padStart(3)}  <3:1:${String(low.length).padStart(3)}  filtered:${filt.length}`);
}
const failing = Object.entries(results).flatMap(([k, list]) => list.filter((x) => x.ratio < 3).map((x) => `  ✖ ${k}  ${x.where}  ${x.ratio}:1  (${x.color} on ${x.bg})`));
const total = Object.values(results).reduce((n, l) => n + l.length, 0);
console.log(failing.length ? `\n${failing.join('\n')}\n\n${failing.length} of ${total} icons below 3:1` : `\nAll ${total} icons at 3:1 or better`);
process.exit(failing.length ? 1 : 0);
