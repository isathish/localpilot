import * as cp from 'child_process';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { Tool } from '../types';
import { ImageAttachment, readImage } from '../ui/images';
import { formatReport, hasWebSocket, InspectAction, InspectReport, inspectPage } from './cdp';

/**
 * Browser integration without extra dependencies:
 * - `open_browser` shows a page in VS Code's built-in Simple Browser (beside the editor) or the system browser;
 * - `browser_screenshot` renders a URL with a headless Chromium-family browser already on the machine
 *   (Chrome, Edge, Brave, Chromium, Arc) and returns the PNG, which the agent loop hands to a vision model.
 */

const CANDIDATES: Record<string, string[]> = {
  darwin: [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    '/Applications/Arc.app/Contents/MacOS/Arc',
    '/Applications/Vivaldi.app/Contents/MacOS/Vivaldi',
    path.join(os.homedir(), 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
  ],
  linux: ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge', 'microsoft-edge-stable', 'brave-browser', 'vivaldi', '/snap/bin/chromium'],
  win32: [
    path.join(process.env['PROGRAMFILES'] ?? 'C:\\Program Files', 'Google\\Chrome\\Application\\chrome.exe'),
    path.join(process.env['PROGRAMFILES(X86)'] ?? 'C:\\Program Files (x86)', 'Google\\Chrome\\Application\\chrome.exe'),
    path.join(process.env['LOCALAPPDATA'] ?? '', 'Google\\Chrome\\Application\\chrome.exe'),
    path.join(process.env['PROGRAMFILES(X86)'] ?? 'C:\\Program Files (x86)', 'Microsoft\\Edge\\Application\\msedge.exe'),
    path.join(process.env['PROGRAMFILES'] ?? 'C:\\Program Files', 'Microsoft\\Edge\\Application\\msedge.exe'),
    path.join(process.env['PROGRAMFILES'] ?? 'C:\\Program Files', 'BraveSoftware\\Brave-Browser\\Application\\brave.exe'),
    path.join(process.env['LOCALAPPDATA'] ?? '', 'Chromium\\Application\\chrome.exe'),
  ],
};

let cachedBrowser: string | null | undefined;

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

function onPath(cmd: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = cp.spawn(process.platform === 'win32' ? 'where' : 'which', [cmd], { stdio: 'ignore' });
    child.on('error', () => resolve(false));
    child.on('close', (code) => resolve(code === 0));
  });
}

/** Headless-capable Chromium binary: `localpilot.browser.chromePath`, `LOCALPILOT_CHROME`, then well-known locations. */
export async function findHeadlessBrowser(force = false): Promise<string | undefined> {
  if (cachedBrowser !== undefined && !force) {
    return cachedBrowser ?? undefined;
  }
  const configured = vscode.workspace.getConfiguration('localpilot').get<string>('browser.chromePath', '').trim() || process.env['LOCALPILOT_CHROME'];
  const list = [...(configured ? [configured] : []), ...(CANDIDATES[process.platform] ?? CANDIDATES.linux)];
  for (const c of list) {
    if (c.includes('/') || c.includes('\\') ? await exists(c) : await onPath(c)) {
      cachedBrowser = c;
      return c;
    }
  }
  cachedBrowser = null;
  return undefined;
}

export interface UrlCaptureOptions {
  width?: number;
  height?: number;
  /** Capture a tall viewport so most of the page is visible (headless Chrome screenshots the viewport only). */
  fullPage?: boolean;
  /** Extra time for scripts/fonts to settle, in ms. */
  waitMs?: number;
  /** Emulate a phone-sized viewport with a mobile user agent. */
  mobile?: boolean;
  signal?: AbortSignal;
}

export function normalizeUrl(raw: string): string {
  let url = String(raw ?? '').trim();
  if (!url) {
    throw new Error('url is required');
  }
  if (/^localhost(:\d+)?(\/|$)/i.test(url) || /^\d{1,3}(\.\d{1,3}){3}(:\d+)?(\/|$)/.test(url)) {
    url = `http://${url}`;
  } else if (!/^[a-z][a-z0-9+.-]*:/i.test(url)) {
    url = /^[\w.-]+\.[a-z]{2,}(\/|$)/i.test(url) ? `https://${url}` : `file://${path.resolve(url)}`;
  }
  const u = new URL(url);
  if (!['http:', 'https:', 'file:'].includes(u.protocol)) {
    throw new Error(`Unsupported URL scheme ${u.protocol}`);
  }
  return u.toString();
}

/** Renders `url` headlessly and returns the PNG. Throws with an actionable message when no browser is found. */
export async function captureUrl(rawUrl: string, opts: UrlCaptureOptions = {}): Promise<ImageAttachment & { url: string; width: number; height: number; browser: string }> {
  const url = normalizeUrl(rawUrl);
  const browser = await findHeadlessBrowser();
  if (!browser) {
    throw new Error('No Chromium-based browser found for headless screenshots. Install Google Chrome, Chromium, Edge or Brave, or set `localpilot.browser.chromePath`.');
  }
  const width = Math.min(4000, Math.max(320, Math.round(opts.width ?? (opts.mobile ? 390 : 1280))));
  const height = Math.min(8000, Math.max(240, Math.round(opts.height ?? (opts.fullPage ? 4000 : opts.mobile ? 844 : 800))));
  const wait = Math.min(20000, Math.max(0, Math.round(opts.waitMs ?? 1500)));
  const file = path.join(os.tmpdir(), `localpilot-web-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.png`);
  const profile = path.join(os.tmpdir(), 'localpilot-headless-profile');
  const args = [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-background-networking',
    '--mute-audio',
    `--user-data-dir=${profile}`,
    `--window-size=${width},${height}`,
    `--virtual-time-budget=${wait + 1000}`,
    `--screenshot=${file}`,
    ...(opts.mobile ? ['--user-agent=Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1', '--force-device-scale-factor=2'] : []),
    url,
  ];
  await new Promise<void>((resolve, reject) => {
    const child = cp.spawn(browser, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`Timed out rendering ${url} after ${Math.round((wait + 30000) / 1000)}s`));
    }, wait + 30000);
    const onAbort = () => {
      child.kill();
      reject(new Error('Cancelled'));
    };
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    child.stderr?.on('data', (d) => (err += String(d)));
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', async () => {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      if (await exists(file)) {
        resolve();
      } else {
        const line = err.split('\n').find((l) => /ERR_|error|failed/i.test(l) && !/task_policy|GPU|dbus|Fontconfig/i.test(l)) ?? '';
        reject(new Error(`Could not render ${url}${line ? `: ${line.replace(/^\[[^\]]*\]\s*/, '').trim()}` : ''}`));
      }
    });
  });
  try {
    const img = await readImage(file);
    if (!img) {
      throw new Error('Screenshot file could not be read');
    }
    const host = (() => {
      try {
        return new URL(url).hostname || 'page';
      } catch {
        return 'page';
      }
    })();
    return { ...img, name: `${host.replace(/[^\w.-]+/g, '_')}-${new Date().toISOString().slice(11, 19).replace(/:/g, '')}.png`, url, width, height, browser: path.basename(browser) };
  } finally {
    await fs.unlink(file).catch(() => undefined);
  }
}

/**
 * Full DevTools-style inspection: screenshot + console/exceptions + network trace + performance + layout checks,
 * optionally after clicking/typing. Falls back to a plain CLI screenshot when DevTools cannot be used.
 */
export async function inspectUrl(rawUrl: string, opts: Partial<Omit<Parameters<typeof inspectPage>[2], 'width' | 'height' | 'waitMs'>> & { width?: number; height?: number; waitMs?: number } = {}): Promise<InspectReport> {
  const url = normalizeUrl(rawUrl);
  const browser = await findHeadlessBrowser();
  if (!browser) {
    throw new Error('No Chromium-based browser found. Install Google Chrome, Chromium, Edge or Brave, or set `localpilot.browser.chromePath`.');
  }
  const width = Math.min(4000, Math.max(320, Math.round(opts.width ?? (opts.mobile ? 390 : 1280))));
  const height = Math.min(8000, Math.max(240, Math.round(opts.height ?? (opts.mobile ? 844 : 800))));
  const waitMs = Math.min(20000, Math.max(0, Math.round(opts.waitMs ?? 1500)));
  if (!hasWebSocket()) {
    const shot = await captureUrl(url, { width, height, fullPage: opts.fullPage, mobile: opts.mobile, waitMs, signal: opts.signal });
    return { url, finalUrl: url, title: '', width: shot.width, height: shot.height, console: [], network: [], perf: { resources: 0, transferredBytes: 0 }, layout: [], actionLog: ['DevTools unavailable in this runtime — screenshot only'], screenshot: shot.data };
  }
  return inspectPage(browser, url, { ...opts, width, height, waitMs });
}

/** Opens a URL in VS Code's Simple Browser beside the editor; falls back to the system browser (file: URLs, missing extension). */
export async function openInBrowser(rawUrl: string, external = false): Promise<'simple' | 'external'> {
  const url = normalizeUrl(rawUrl);
  const uri = vscode.Uri.parse(url);
  if (!external && uri.scheme !== 'file') {
    try {
      await vscode.commands.executeCommand('simpleBrowser.api.open', uri, { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true });
      return 'simple';
    } catch {
      try {
        await vscode.commands.executeCommand('simpleBrowser.show', url);
        return 'simple';
      } catch {
        /* fall through */
      }
    }
  }
  await vscode.env.openExternal(uri);
  return 'external';
}

/** Marker the agent loop looks for on a tool result to attach a captured image to the conversation. */
export interface ToolImageData {
  image: ImageAttachment;
  url?: string;
  caption?: string;
}

export const openBrowserTool: Tool = {
  parallelSafe: false,
  definition: {
    name: 'open_browser',
    description: 'Open a URL for the user in a browser view inside VS Code (beside the editor). Use it to show a local dev server, a docs page or a result. Does not return page content — use web_fetch for text or browser_screenshot to see the rendered page.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'http(s) URL, e.g. http://localhost:3000. Bare localhost:port is accepted.' },
        external: { type: 'boolean', description: 'Open in the system browser instead of the VS Code browser view' },
      },
      required: ['url'],
    },
  },
  async execute(args) {
    try {
      const where = await openInBrowser(String(args.url ?? ''), args.external === true);
      const url = normalizeUrl(String(args.url ?? ''));
      return { content: `Opened ${url} in ${where === 'simple' ? 'the VS Code browser view beside the editor' : 'the system browser'}.`, data: { url, where } };
    } catch (e) {
      return { content: e instanceof Error ? e.message : String(e), isError: true };
    }
  },
};

export const browserScreenshotTool: Tool = {
  approvalKind: 'network',
  parallelSafe: true,
  definition: {
    name: 'browser_screenshot',
    description: 'Render a web page (or local dev server URL) in a headless browser and look at the screenshot. Use it to verify UI changes, check layouts, or read pages that need JavaScript. The image is attached to the conversation for a vision model; with a text-only model you get the page title and size only.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'http(s) URL. Bare localhost:port is accepted.' },
        width: { type: 'integer', description: 'Viewport width in px (default 1280)' },
        height: { type: 'integer', description: 'Viewport height in px (default 800)' },
        full_page: { type: 'boolean', description: 'Use a tall viewport (4000px) to capture most of a long page' },
        mobile: { type: 'boolean', description: 'Phone-sized viewport (390×844) with a mobile user agent' },
        wait_ms: { type: 'integer', description: 'Extra time for the page to settle, default 1500' },
      },
      required: ['url'],
    },
  },
  async execute(args, ctx) {
    const o = {
      width: typeof args.width === 'number' ? args.width : undefined,
      height: typeof args.height === 'number' ? args.height : undefined,
      fullPage: args.full_page === true,
      mobile: args.mobile === true,
      waitMs: typeof args.wait_ms === 'number' ? args.wait_ms : undefined,
      signal: ctx.signal,
    };
    try {
      ctx.progress(`Rendering ${String(args.url ?? '')}…`);
      let shot: ImageAttachment & { url: string; width: number; height: number; browser: string; note?: string };
      try {
        const r = await inspectUrl(String(args.url ?? ''), { ...o, progress: (t) => ctx.progress(t) });
        const errors = r.console.filter((c) => c.level === 'error').length;
        const failed = r.network.filter((e) => e.error || (e.status ?? 0) >= 400).length;
        shot = { name: shotName(r.finalUrl), data: r.screenshot ?? '', mime: 'image/png', url: r.finalUrl, width: r.width, height: r.height, browser: 'DevTools', note: `${r.title ? `"${r.title}"` : ''}${r.status ? ` HTTP ${r.status}` : ''}${errors || failed ? ` · ${errors} console error${errors === 1 ? '' : 's'}, ${failed} failed request${failed === 1 ? '' : 's'} — run browser_inspect for details` : ' · no console errors or failed requests'}`.trim() };
        if (!shot.data) {
          throw new Error('empty screenshot');
        }
      } catch (e) {
        if (ctx.signal.aborted) {
          throw e;
        }
        shot = await captureUrl(String(args.url ?? ''), o);
      }
      const { url, width, height, browser, note, ...image } = shot;
      const data: ToolImageData = { image, url, caption: `Screenshot of ${url} (${width}×${height})` };
      return { content: `Captured ${url} at ${width}×${height} with ${browser}.${note ? ` ${note}.` : ''} The screenshot is attached to the next message.`, data };
    } catch (e) {
      return { content: e instanceof Error ? e.message : String(e), isError: true };
    }
  },
};

function shotName(url: string): string {
  let host = 'page';
  try {
    host = new URL(url).hostname || 'page';
  } catch {
    /* keep default */
  }
  return `${host.replace(/[^\w.-]+/g, '_')}-${new Date().toISOString().slice(11, 19).replace(/:/g, '')}.png`;
}

export const browserInspectTool: Tool = {
  approvalKind: 'network',
  parallelSafe: true,
  definition: {
    name: 'browser_inspect',
    description:
      'Load a web page or local dev server in a headless browser with DevTools attached and collect everything needed to debug it: screenshot, console logs and uncaught exceptions (with file:line), the network trace (every request with status, size, timing; failed ones listed), performance metrics (DOMContentLoaded, load, FCP/LCP, DOM nodes, JS heap) and layout checks (horizontal overflow, images without alt, tiny text, unlabelled controls). Optional actions run before capture: click a selector, type into a field, scroll, evaluate JS — so you can reproduce a flow and see what breaks. Use after changing web UI, when the user reports a page bug, or to verify a dev server renders.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'http(s) URL. Bare localhost:port is accepted.' },
        actions: {
          type: 'array',
          description: 'Steps to perform after load, in order. Each item has exactly one of: {"click":"css selector"}, {"type":{"selector":"css","text":"value"}}, {"scroll":"bottom"|"top"|pixels}, {"eval":"js expression"}; add "wait": ms to pause after it.',
          items: { type: 'object', properties: { click: { type: 'string' }, type: { type: 'object', properties: { selector: { type: 'string' }, text: { type: 'string' } } }, scroll: {}, eval: { type: 'string' }, wait: { type: 'integer' } } },
        },
        width: { type: 'integer', description: 'Viewport width (default 1280)' },
        height: { type: 'integer', description: 'Viewport height (default 800)' },
        mobile: { type: 'boolean', description: 'Phone viewport 390×844 with touch and a mobile user agent' },
        full_page: { type: 'boolean', description: 'Screenshot the whole page height (up to 8000px)' },
        wait_ms: { type: 'integer', description: 'Settle time after load for scripts/fetches, default 1500' },
        include_text: { type: 'boolean', description: 'Also return the visible page text (first 4k chars) — useful for text-only models' },
      },
      required: ['url'],
    },
  },
  async execute(args, ctx) {
    try {
      const actions = Array.isArray(args.actions) ? (args.actions as InspectAction[]).filter((a) => a && typeof a === 'object').slice(0, 20) : undefined;
      const r = await inspectUrl(String(args.url ?? ''), {
        width: typeof args.width === 'number' ? args.width : undefined,
        height: typeof args.height === 'number' ? args.height : undefined,
        fullPage: args.full_page === true,
        mobile: args.mobile === true,
        waitMs: typeof args.wait_ms === 'number' ? args.wait_ms : undefined,
        includeText: args.include_text === true,
        actions,
        signal: ctx.signal,
        progress: (t) => ctx.progress(t),
      });
      const text = formatReport(r);
      const data: ToolImageData & { report: Omit<InspectReport, 'screenshot' | 'text'> } = {
        image: { name: shotName(r.finalUrl), data: r.screenshot ?? '', mime: 'image/png' },
        url: r.finalUrl,
        caption: `Screenshot of ${r.finalUrl} (${r.width}×${r.height})`,
        report: (({ screenshot: _s, text: _t, ...rest }) => rest)(r),
      };
      return { content: `${text}\n\nThe screenshot is attached to the next message.`, data };
    } catch (e) {
      return { content: e instanceof Error ? e.message : String(e), isError: true };
    }
  },
};

export const browserTools: Tool[] = [openBrowserTool, browserScreenshotTool, browserInspectTool];
