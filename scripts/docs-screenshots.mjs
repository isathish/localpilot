#!/usr/bin/env node
// Regenerates the documentation screenshots of LocalPilot's webviews (Settings, setup wizard, chat model picker) from the
// preview harnesses in scripts/, which run the real media/*.js and *.css with mock data. Drives headless Chrome over the
// DevTools Protocol (Node's built-in WebSocket; no dependencies) so it can click, expand and crop to an element, and
// writes 2× PNGs into docs/assets/screenshots/.
//
//   node scripts/docs-screenshots.mjs            # every shot
//   node scripts/docs-screenshots.mjs providers  # only shots whose file name contains "providers"
//
// Screens that need a real VS Code window and a real model (the hero, the terminal, parallel agents, diffs…) are not
// covered; take those by hand.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
// SHOTS_OUT writes elsewhere, to compare with the current images before replacing them.
const outDir = process.env.SHOTS_OUT || path.join(root, 'docs', 'assets', 'screenshots');
const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const only = process.argv[2];

const CHROME = process.env.CHROME || ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find((c) => fs.existsSync(c));
if (!CHROME) {
  console.error('No Chrome/Chromium found; set CHROME=/path/to/chrome');
  process.exit(1);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const harness = (file, query) => `${pathToFileURL(path.join(root, 'scripts', file)).href}?${query}`;
const settings = (query) => harness('settings-preview.html', `version=${version}&${query}`);

// ------------------------------------------------------------------ shots
// clip: 'viewport' | { selector, pad?, maxHeight?, from?: selector to start at } — CSS pixels, captured at 2×.
const SHOTS = [
  { file: 'settings-providers.png', url: settings('section=providers'), size: [900, 648], clip: 'viewport' },
  {
    file: 'settings-provider-test.png', url: settings('section=providers'), size: [900, 1400],
    steps: [`document.querySelector('.prov[data-prov="ollama"] .prov-head').click()`, 300, `document.querySelector('.prov[data-prov="ollama"] #test').click()`, 600],
    clip: { selector: '.prov[data-prov="ollama"]', pad: 10 },
  },
  {
    file: 'settings-provider-cloud.png', url: settings('section=providers'), size: [900, 1400],
    steps: [`document.querySelector('.prov[data-prov="openai"] .prov-head').click()`, 400],
    // Header, name, key (with the missing-key warning and the key link), id, type, URL, context window.
    clip: { selector: '.prov[data-prov="openai"]', pad: 10, maxHeight: 495 },
  },
  {
    file: 'settings-add-provider.png', url: settings('section=providers'), size: [900, 1600],
    steps: [`[...document.querySelectorAll('.add-prov .chip')].find((b) => /Cloud APIs/.test(b.textContent)).click()`, 300],
    clip: { selector: '.add-prov', pad: 18 },
  },
  { file: 'settings-colibri.png', url: settings('section=providers'), size: [704, 2400], clip: { headingText: 'Huge MoE models', pad: 14, maxHeight: 880, side: 'content' } },
  { file: 'settings-models-manager.png', url: settings('section=models'), size: [900, 936], clip: 'viewport' },
  { file: 'landing-models.png', url: settings('section=models'), size: [1100, 1600], clip: { headingText: 'Models', tag: 'h1', toHeadingText: 'Model catalog', pad: 18, maxHeight: 780, side: 'content' } },
  { file: 'settings-models-catalog.png', url: settings('section=models'), size: [704, 2400], clip: { headingText: 'catalog', pad: 14, maxHeight: 684, side: 'content' } },
  { file: 'settings-routing.png', url: settings('section=models'), size: [704, 3000], clip: { headingText: 'Routing', tag: 'h2', pad: 14, maxHeight: 684, side: 'content' } },
  { file: 'settings-gallery.png', url: settings('section=gallery'), size: [900, 648], clip: 'viewport', wait: 1500 },
  { file: 'settings-skills.png', url: settings('section=skills'), size: [900, 648], clip: 'viewport' },
  { file: 'settings-agent.png', url: settings('section=agent'), size: [900, 648], clip: 'viewport' },
  { file: 'settings-completions.png', url: settings('section=completions'), size: [900, 648], clip: 'viewport' },
  { file: 'settings-web.png', url: settings('section=web'), size: [900, 648], clip: 'viewport' },
  { file: 'settings-memory.png', url: settings('section=memory'), size: [900, 648], clip: 'viewport' },
  { file: 'settings-mcp.png', url: settings('section=mcp'), size: [900, 648], clip: 'viewport' },
  { file: 'settings-dashboard.png', url: settings('section=dashboard'), size: [900, 648], clip: 'viewport', wait: 1500 },
  { file: 'dashboard-tuning.png', url: settings('section=dashboard'), size: [1000, 3200], wait: 1500, clip: { selector: '.tblwrap:has(h3)', pad: 0, text: 'Model tuning' } },
  { file: 'setup-detect.png', url: settings('page=setup&local=1'), size: [900, 760], steps: [`document.querySelector('#back') && document.querySelector('#back').click()`, 300], clip: 'viewport' },
  { file: 'setup-model.png', url: settings('page=setup&local=1'), size: [900, 760], steps: [`document.querySelector('#back') && document.querySelector('#back').click()`, 200, `document.querySelector('#next').click()`, 300], clip: 'viewport' },
  { file: 'setup-approvals.png', url: settings('page=setup&local=1'), size: [900, 760], steps: [`document.querySelector('#back') && document.querySelector('#back').click()`, 200, `document.querySelector('#next').click()`, 200, `document.querySelector('#next').click()`, 300], clip: 'viewport' },
  { file: 'model-picker.png', url: harness('ui-preview.html', 'live=0'), size: [370, 796], steps: [`document.getElementById('modelBtn').click()`, 400], clip: 'viewport' },
  { file: 'mode-picker.png', url: harness('ui-preview.html', 'live=0'), size: [370, 796], steps: [`document.getElementById('modeBtn').click()`, 400], clip: 'viewport' },
  // Chat transcript: steps, the diff and test-output cards, and the run-command approval the agent is waiting on.
  { file: 'chat-rendering.png', url: harness('ui-preview.html', 'live=0'), size: [471, 836], wait: 1200, clip: 'viewport' },
  { file: 'approval.png', url: harness('ui-preview.html', 'live=0'), size: [471, 836], wait: 1200, steps: [`(() => { const m = document.getElementById('messages'); m.scrollTop = m.scrollHeight; })()`, 400], clip: 'viewport' },
  // A live run fanned out to subagents, paused, with a steering message queued for its next step.
  {
    file: 'pause-steer.png', url: harness('ui-preview.html', ''), size: [471, 836], wait: 2600,
    steps: [`document.getElementById('btnPause').click()`, 900, `(() => { const i = document.getElementById('input'); i.value = 'Also cover negative modifiers like 2d10 - 1'; i.dispatchEvent(new Event('input', { bubbles: true })); document.getElementById('btnSend').click(); })()`, 700],
    clip: 'viewport',
  },
  { file: 'questions.png', url: harness('ui-preview.html', 'live=0&question=1'), size: [471, 836], wait: 1200, clip: 'viewport' },
];

// ------------------------------------------------------------------ DevTools Protocol
async function launch() {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lp-shots-'));
  const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--allow-file-access-from-files', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  const ws = await new Promise((resolve, reject) => {
    let err = '';
    chrome.stderr.on('data', (d) => {
      err += d;
      const m = /DevTools listening on (ws:\/\/\S+)/.exec(err);
      if (m) {
        resolve(m[1]);
      }
    });
    chrome.on('exit', () => reject(new Error(`Chrome exited: ${err.slice(-400)}`)));
  });
  return { chrome, ws, profile };
}

function connect(url) {
  const sock = new WebSocket(url);
  let id = 0;
  const waiting = new Map();
  const events = [];
  sock.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && waiting.has(msg.id)) {
      const { resolve, reject } = waiting.get(msg.id);
      waiting.delete(msg.id);
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
    } else if (msg.method) {
      events.push(msg);
    }
  };
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const n = ++id;
    waiting.set(n, { resolve, reject });
    sock.send(JSON.stringify({ id: n, method, params, sessionId }));
  });
  return new Promise((resolve) => (sock.onopen = () => resolve({ send, events, close: () => sock.close() })));
}

/** Page-side: the rectangle to capture, in CSS pixels of the full page. */
const CLIP_JS = (c) => `(() => {
  const c = ${JSON.stringify(c)};
  const rectOf = (el) => { const r = el.getBoundingClientRect(); return { x: r.left + scrollX, y: r.top + scrollY, w: r.width, h: r.height }; };
  const byText = (text, tag) => [...document.querySelectorAll(tag || 'h1, h2, h3')].find((h) => h.textContent.toLowerCase().includes(text.toLowerCase()));
  let x, y, w, h;
  if (c.headingText) {
    const head = byText(c.headingText, c.tag);
    if (!head) { return null; }
    const content = head.closest('section, .content, main') || document.body;
    const area = rectOf(c.side === 'content' ? (document.querySelector('.content .sec') || document.querySelector('.content') || content) : content);
    const top = rectOf(head);
    x = area.x; w = area.w; y = top.y;
    const end = c.toHeadingText ? byText(c.toHeadingText) : null;
    h = end ? rectOf(end).y - y : (c.maxHeight || 600);
  } else {
    const el = c.text ? [...document.querySelectorAll(c.selector)].find((e) => e.textContent.includes(c.text)) : document.querySelector(c.selector);
    if (!el) { return null; }
    const r = rectOf(el); x = r.x; y = r.y; w = r.w; h = r.h;
  }
  const pad = c.pad || 0;
  x -= pad; y -= pad; w += 2 * pad; h += 2 * pad;
  if (c.maxHeight) { h = Math.min(h, c.maxHeight + 2 * pad); }
  return { x: Math.max(0, x), y: Math.max(0, y), width: Math.round(w), height: Math.round(h) };
})()`;

async function shoot(cdp, sessionId, shot) {
  const [w, h] = shot.size;
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 2, mobile: false }, sessionId);
  await cdp.send('Page.navigate', { url: shot.url }, sessionId);
  await sleep(shot.wait ?? 900);
  for (const step of shot.steps ?? []) {
    if (typeof step === 'number') {
      await sleep(step);
    } else {
      const r = await cdp.send('Runtime.evaluate', { expression: step, awaitPromise: true }, sessionId);
      if (r.exceptionDetails) {
        throw new Error(`${shot.file}: step failed: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
      }
    }
  }
  let clip;
  if (shot.clip !== 'viewport') {
    const r = await cdp.send('Runtime.evaluate', { expression: CLIP_JS(shot.clip), returnByValue: true }, sessionId);
    clip = r.result.value;
    if (!clip) {
      throw new Error(`${shot.file}: nothing to crop (${JSON.stringify(shot.clip)})`);
    }
  }
  const img = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: !!clip, ...(clip ? { clip: { ...clip, scale: 1 } } : {}) }, sessionId);
  fs.writeFileSync(path.join(outDir, shot.file), Buffer.from(img.data, 'base64'));
  return clip ? `${clip.width * 2}×${clip.height * 2}` : `${w * 2}×${h * 2}`;
}

const { chrome, ws, profile } = await launch();
const cdp = await connect(ws);
const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
await cdp.send('Page.enable', {}, sessionId);
let failed = 0;
try {
  for (const shot of SHOTS.filter((s) => !only || s.file.includes(only))) {
    try {
      console.log(`  ✔ ${shot.file.padEnd(30)} ${await shoot(cdp, sessionId, shot)}`);
    } catch (e) {
      failed++;
      console.log(`  ✖ ${shot.file.padEnd(30)} ${e.message}`);
    }
  }
} finally {
  cdp.close();
  const exited = new Promise((r) => chrome.once('exit', r));
  chrome.kill();
  await Promise.race([exited, sleep(3000)]);
  fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
process.exit(failed ? 1 : 0);
