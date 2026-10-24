import * as assert from 'assert';
import * as http from 'http';
import { AddressInfo } from 'net';
import * as vscode from 'vscode';
import { browserInspectTool, browserScreenshotTool, captureUrl, findHeadlessBrowser, normalizeUrl, openBrowserTool } from '../tools/browser';
import { formatReport, hasWebSocket, InspectReport } from '../tools/cdp';
import { ToolContext } from '../types';

const page = `<!doctype html><html><body style="margin:0;background:#1f6feb;color:#fff;font:32px sans-serif"><h1 id="t" style="padding:40px">LocalPilot headless test</h1><script>document.getElementById('t').textContent += ' · JS ran';</script></body></html>`;
const buggy = `<!doctype html><html><head><title>Inspect me</title><style>body{margin:0;font:16px sans-serif}.wide{width:1600px;height:40px;background:#f2a33a}</style></head>
<body><h1>Hello inspector</h1><div class="wide">too wide</div><img src="/missing.png" width="80" height="80"><button id="go"></button><input id="name">
<script>console.log('boot'); console.warn('careful'); console.error('bad thing', 42); fetch('/api/users/42').then(r => console.info('status', r.status)); setTimeout(() => { nullish.prop; }, 30);
document.getElementById('go').addEventListener('click', () => { document.title = 'Clicked ' + document.getElementById('name').value; console.log('clicked!'); });</script></body></html>`;

function serve(): Promise<{ url: string; close(): void; hits: number[] }> {
  const hits: number[] = [];
  const srv = http.createServer((req, res) => {
    hits.push(Date.now());
    if (req.url === '/slow') {
      setTimeout(() => res.end(page), 400);
      return;
    }
    if (req.url === '/buggy') {
      res.setHeader('content-type', 'text/html');
      res.end(buggy);
      return;
    }
    if (req.url === '/api/users/42' || req.url === '/missing.png') {
      res.statusCode = 404;
      res.end('{"error":"nope"}');
      return;
    }
    res.setHeader('content-type', 'text/html');
    res.end(page);
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${(srv.address() as AddressInfo).port}`, close: () => srv.close(), hits })));
}

const ctx: ToolContext = { sessionId: 't', signal: new AbortController().signal, depth: 0, progress: () => undefined, trackChange: async () => undefined, requestApproval: async () => true };

suite('LocalPilot browser view & web-page screenshots', () => {
  suiteSetup(async function () {
    this.timeout(30_000);
    await vscode.extensions.getExtension('localpilot.localpilot-agent')!.activate();
  });

  test('normalizeUrl accepts bare hosts, localhost:port and rejects odd schemes', () => {
    assert.strictEqual(normalizeUrl('localhost:3000'), 'http://localhost:3000/');
    assert.strictEqual(normalizeUrl('127.0.0.1:8080/app'), 'http://127.0.0.1:8080/app');
    assert.strictEqual(normalizeUrl('example.com/docs'), 'https://example.com/docs');
    assert.strictEqual(normalizeUrl('https://a.b/c?d=1'), 'https://a.b/c?d=1');
    assert.throws(() => normalizeUrl(''), /required/);
    assert.throws(() => normalizeUrl('javascript:alert(1)'), /Unsupported/);
  });

  test('browser tools are registered in every mode and commands exist', async () => {
    const commands = await vscode.commands.getCommands(true);
    assert.ok(commands.includes('localpilot.openBrowser'));
    assert.ok(commands.includes('localpilot.screenshotUrl'));
    assert.strictEqual(openBrowserTool.approvalKind, undefined, 'opening a browser view is harmless and allowed in Ask/Plan');
    assert.strictEqual(browserScreenshotTool.approvalKind, 'network');
    assert.ok(browserScreenshotTool.parallelSafe);
    const props = vscode.extensions.getExtension('localpilot.localpilot-agent')!.packageJSON.contributes.configuration.properties;
    assert.ok(props['localpilot.browser.chromePath']);
  });

  test('browser_screenshot rejects bad URLs with a clear error and never throws', async () => {
    const r = await browserScreenshotTool.execute({ url: 'ftp://nope' }, ctx);
    assert.strictEqual(r.isError, true);
    assert.match(r.content, /Unsupported URL scheme/);
  });

  test('captureUrl renders a local page with a headless Chromium (skipped when none is installed)', async function () {
    this.timeout(120_000);
    this.retries(1); // the first Chromium launch on a fresh CI runner is occasionally very slow
    const browser = await findHeadlessBrowser(true);
    if (!browser) {
      this.skip();
    }
    const srv = await serve();
    try {
      const shot = await captureUrl(`${srv.url}/`, { width: 640, height: 360, waitMs: 300 });
      assert.strictEqual(shot.mime, 'image/png');
      assert.ok(shot.data.length > 2000, 'PNG should have real content');
      assert.strictEqual(shot.width, 640);
      assert.strictEqual(shot.height, 360);
      assert.match(shot.name, /^127\.0\.0\.1-\d{6}\.png$/);
      assert.ok(srv.hits.length >= 1, 'the browser fetched the page');
      // PNG signature + IHDR width/height = 640×360.
      const buf = Buffer.from(shot.data, 'base64');
      assert.strictEqual(buf.toString('hex', 0, 8), '89504e470d0a1a0a');
      assert.strictEqual(buf.readUInt32BE(16), 640);
      assert.strictEqual(buf.readUInt32BE(20), 360);

      // Through the tool: result carries the image for the agent loop and a human-readable summary.
      const r = await browserScreenshotTool.execute({ url: `${srv.url}/slow`, width: 400, height: 300, wait_ms: 200 }, ctx);
      assert.strictEqual(r.isError, undefined, r.content);
      assert.match(r.content, /Captured http:\/\/127\.0\.0\.1:\d+\/slow at 400×300/);
      const data = r.data as { image: { data: string; mime: string }; caption: string; url: string };
      assert.ok(data.image.data.length > 1000);
      assert.match(data.caption, /Screenshot of/);

      // Unreachable server → clean error.
      const bad = await browserScreenshotTool.execute({ url: 'http://127.0.0.1:9/', wait_ms: 100 }, ctx);
      assert.strictEqual(bad.isError, true);
      assert.match(bad.content, /Could not render|Timed out/);
    } finally {
      srv.close();
    }
  });

  test('browser_inspect collects console, exceptions, network failures, metrics, layout issues and performs actions (skipped without Chromium)', async function () {
    this.timeout(90_000);
    this.retries(1);
    if (!(await findHeadlessBrowser()) || !hasWebSocket()) {
      this.skip();
    }
    const srv = await serve();
    try {
      const r = await browserInspectTool.execute({ url: `${srv.url}/buggy`, width: 900, height: 500, wait_ms: 600, include_text: true, actions: [{ type: { selector: '#name', text: 'Ada' } }, { click: '#go', wait: 150 }] }, ctx);
      assert.strictEqual(r.isError, undefined, r.content);
      const data = r.data as { image: { data: string }; report: InspectReport };
      assert.ok(data.image.data.length > 1000, 'screenshot attached');
      const rep = data.report;
      assert.strictEqual(rep.status, 200);
      assert.strictEqual(rep.title, 'Clicked Ada', 'actions ran in order: typed then clicked');
      assert.deepStrictEqual(rep.actionLog, ['typed into #name', 'clicked #go']);
      const errors = rep.console.filter((c) => c.level === 'error');
      assert.ok(errors.some((c) => /bad thing 42/.test(c.text) && /buggy:\d+:\d+$/.test(c.at ?? '')), `console.error with location: ${JSON.stringify(errors)}`);
      assert.ok(errors.some((c) => c.source === 'exception' && /nullish is not defined/.test(c.text)), 'uncaught exception captured');
      assert.ok(rep.console.some((c) => c.level === 'warn' && c.text === 'careful'));
      assert.ok(rep.console.some((c) => c.level === 'log' && c.text === 'clicked!'), 'console output from the click');
      const failed = rep.network.filter((e) => (e.status ?? 0) >= 400 || e.error);
      assert.ok(failed.some((e) => e.url.endsWith('/api/users/42') && e.status === 404 && e.type === 'Fetch'), 'failed fetch in trace');
      assert.ok(failed.some((e) => e.url.endsWith('/missing.png') && e.type === 'Image'), 'failed image in trace');
      assert.ok(rep.network.find((e) => e.type === 'Document')!.ms! >= 0);
      assert.ok(rep.perf.domContentLoadedMs !== undefined && rep.perf.domNodes! > 5 && rep.perf.resources >= 3);
      assert.ok(rep.layout.some((l) => l.kind === 'overflow-x' && /div\.wide/.test(l.detail)), `overflow detected: ${JSON.stringify(rep.layout)}`);
      assert.ok(rep.layout.some((l) => l.kind === 'img-no-alt'));
      assert.ok(rep.layout.some((l) => l.kind === 'unlabelled-control'));
      // The text report the model reads has every section and the screenshot note.
      for (const h of ['Page: Clicked Ada', 'Actions: typed into #name; clicked #go', 'Console: 2 errors, 1 warning', 'Network:', '✗ GET /api/users/42 → HTTP 404', 'Performance: DOMContentLoaded', 'Layout: overflow-x', 'Text:', 'Hello inspector']) {
        assert.ok(r.content.includes(h), `report should contain "${h}":\n${r.content}`);
      }
      assert.match(r.content, /screenshot is attached/);
      assert.strictEqual(formatReport(rep).split('\n')[0], r.content.split('\n')[0]);
      // Unreachable server fails cleanly.
      const bad = await browserInspectTool.execute({ url: 'http://127.0.0.1:9/', wait_ms: 100 }, ctx);
      assert.strictEqual(bad.isError, true);
    } finally {
      srv.close();
    }
  });

  test('open_browser opens the Simple Browser beside the editor', async function () {
    this.timeout(20_000);
    const srv = await serve();
    const allTabs = () => vscode.window.tabGroups.all.flatMap((g) => g.tabs);
    const before = new Set(allTabs());
    try {
      const r = await openBrowserTool.execute({ url: srv.url }, ctx);
      assert.strictEqual(r.isError, undefined, r.content);
      assert.match(r.content, /Opened http:\/\/127\.0\.0\.1:\d+\/ in the VS Code browser view/);
      await new Promise((res) => setTimeout(res, 500));
      // Simple Browser is a webview tab in older VS Code; 1.143+ uses the built-in browser view (a non-webview tab). Either way a new tab appears.
      const added = allTabs().filter((t) => !before.has(t));
      assert.ok(added.length >= 1, 'a browser tab should have opened beside the editor');
      await vscode.window.tabGroups.close(added);
    } finally {
      srv.close();
    }
  });
});
