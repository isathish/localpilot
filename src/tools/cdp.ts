import * as cp from 'child_process';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

/**
 * Minimal Chrome DevTools Protocol client over Node's built-in WebSocket — enough to drive a headless Chromium
 * session: navigate, run scripts, collect console / exceptions / network / performance, and take screenshots.
 * No npm dependency; works with any Chromium-family browser.
 */

type Json = Record<string, unknown>;
type Handler = (params: Json, sessionId?: string) => void;

interface WsLike {
  readyState: number;
  send(data: string): void;
  close(): void;
  addEventListener(type: string, cb: (ev: { data?: unknown; message?: string }) => void): void;
}

export function hasWebSocket(): boolean {
  return typeof (globalThis as { WebSocket?: unknown }).WebSocket === 'function';
}

const rmrf = (p: string) => fs.rm(p, { recursive: true, force: true }).catch(() => undefined);

export class CdpSession {
  private seq = 0;
  private readonly pending = new Map<number, { resolve: (v: Json) => void; reject: (e: Error) => void }>();
  private readonly handlers = new Map<string, Set<Handler>>();
  private closed = false;

  private constructor(private readonly ws: WsLike, private readonly child: cp.ChildProcess, private readonly profileDir: string) {
    ws.addEventListener('message', (ev) => {
      let msg: { id?: number; method?: string; params?: Json; result?: Json; error?: { message: string }; sessionId?: string };
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (msg.id !== undefined) {
        const p = this.pending.get(msg.id);
        if (p) {
          this.pending.delete(msg.id);
          msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result ?? {});
        }
      } else if (msg.method) {
        for (const h of this.handlers.get(msg.method) ?? []) {
          try {
            h(msg.params ?? {}, msg.sessionId);
          } catch {
            /* listener errors must not break the stream */
          }
        }
      }
    });
    ws.addEventListener('close', () => this.failAll(new Error('DevTools connection closed')));
    ws.addEventListener('error', () => this.failAll(new Error('DevTools connection error')));
  }

  /** Launches `browser` headless with a fresh profile and connects to its DevTools endpoint. */
  static async launch(browser: string, opts: { width: number; height: number; mobile?: boolean; timeoutMs?: number; signal?: AbortSignal }): Promise<CdpSession> {
    if (!hasWebSocket()) {
      throw new Error('This VS Code build has no WebSocket support for DevTools; update VS Code (Node 22+) or use browser_screenshot.');
    }
    const profileDir = path.join(os.tmpdir(), `localpilot-cdp-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
    const args = [
      '--headless=new',
      '--remote-debugging-port=0',
      '--disable-gpu',
      '--hide-scrollbars',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--disable-background-networking',
      '--disable-sync',
      '--mute-audio',
      `--user-data-dir=${profileDir}`,
      `--window-size=${opts.width},${opts.height}`,
      'about:blank',
    ];
    const child = cp.spawn(browser, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    const wsUrl = await new Promise<string>((resolve, reject) => {
      let err = '';
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error(`Browser did not expose DevTools within ${Math.round((opts.timeoutMs ?? 15000) / 1000)}s${err ? `: ${err.split('\n').find((l) => /ERR|rror/.test(l)) ?? ''}` : ''}`));
      }, opts.timeoutMs ?? 15000);
      child.stderr?.on('data', (d) => {
        err += String(d);
        const m = /DevTools listening on (ws:\/\/\S+)/.exec(err);
        if (m) {
          clearTimeout(timer);
          resolve(m[1]);
        }
      });
      child.on('error', (e) => {
        clearTimeout(timer);
        reject(e);
      });
      child.on('exit', (code) => {
        clearTimeout(timer);
        reject(new Error(`Browser exited with code ${code} before DevTools was ready`));
      });
      opts.signal?.addEventListener('abort', () => {
        clearTimeout(timer);
        child.kill();
        reject(new Error('Cancelled'));
      }, { once: true });
    });
    const WS = (globalThis as unknown as { WebSocket: new (url: string) => WsLike }).WebSocket;
    const ws = new WS(wsUrl);
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => resolve());
      ws.addEventListener('error', () => reject(new Error('Could not connect to the browser DevTools socket')));
    });
    const session = new CdpSession(ws, child, profileDir);
    opts.signal?.addEventListener('abort', () => void session.close(), { once: true });
    return session;
  }

  private failAll(e: Error): void {
    for (const p of this.pending.values()) {
      p.reject(e);
    }
    this.pending.clear();
  }

  send<T extends Json = Json>(method: string, params: Json = {}, sessionId?: string): Promise<T> {
    if (this.closed || this.ws.readyState !== 1) {
      return Promise.reject(new Error('DevTools session is closed'));
    }
    const id = ++this.seq;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: Json) => void, reject });
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  on(method: string, handler: Handler): () => void {
    let set = this.handlers.get(method);
    if (!set) {
      set = new Set();
      this.handlers.set(method, set);
    }
    set.add(handler);
    return () => set!.delete(handler);
  }

  /** Waits for one event (optionally filtered), or rejects after `timeoutMs`. */
  once(method: string, timeoutMs: number, filter?: (p: Json) => boolean): Promise<Json> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        off();
        reject(new Error(`Timed out waiting for ${method}`));
      }, timeoutMs);
      const off = this.on(method, (p) => {
        if (!filter || filter(p)) {
          clearTimeout(timer);
          off();
          resolve(p);
        }
      });
    });
  }

  /** Opens a new page target and attaches to it (flattened session). */
  async newPage(): Promise<string> {
    const { targetId } = await this.send<{ targetId: string }>('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await this.send<{ sessionId: string }>('Target.attachToTarget', { targetId, flatten: true });
    return sessionId;
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    try {
      this.ws.close();
    } catch {
      /* ignore */
    }
    this.child.kill();
    await new Promise((r) => setTimeout(r, 150));
    if (!this.child.killed) {
      try {
        this.child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
    }
    await rmrf(this.profileDir);
  }
}

// ------------------------------------------------------------------ page inspection

export interface ConsoleEntry {
  level: 'log' | 'info' | 'warn' | 'error' | 'debug';
  text: string;
  source?: string;
  /** `url:line:col` of the top frame when known. */
  at?: string;
}

export interface NetworkEntry {
  method: string;
  url: string;
  type: string;
  status?: number;
  mime?: string;
  /** Transferred bytes. */
  bytes: number;
  /** Request → finish, ms. */
  ms?: number;
  error?: string;
  fromCache?: boolean;
}

export interface PerfMetrics {
  domContentLoadedMs?: number;
  loadMs?: number;
  firstContentfulPaintMs?: number;
  largestContentfulPaintMs?: number;
  resources: number;
  transferredBytes: number;
  jsHeapMb?: number;
  domNodes?: number;
}

export interface LayoutIssue {
  kind: 'overflow-x' | 'img-no-alt' | 'tiny-text' | 'offscreen' | 'unlabelled-control';
  detail: string;
}

export interface InspectAction {
  click?: string;
  type?: { selector: string; text: string };
  wait?: number;
  scroll?: 'bottom' | 'top' | number;
  eval?: string;
}

export interface InspectOptions {
  width: number;
  height: number;
  mobile?: boolean;
  fullPage?: boolean;
  waitMs: number;
  /** Capture `document.body.innerText` (trimmed to 4k) for text-only models. */
  includeText?: boolean;
  actions?: InspectAction[];
  signal?: AbortSignal;
  progress?: (text: string) => void;
}

export interface InspectReport {
  url: string;
  finalUrl: string;
  title: string;
  status?: number;
  width: number;
  height: number;
  console: ConsoleEntry[];
  network: NetworkEntry[];
  perf: PerfMetrics;
  layout: LayoutIssue[];
  text?: string;
  actionLog: string[];
  /** Base64 PNG. */
  screenshot?: string;
}

const MOBILE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

const LAYOUT_SCRIPT = `(() => {
  const out = [];
  const de = document.documentElement; const vw = de.clientWidth;
  if (de.scrollWidth > vw + 1) {
    const culprits = [...document.querySelectorAll('body *')].filter((el) => { const r = el.getBoundingClientRect(); return r.right > vw + 1 && r.width > 0 && r.height > 0 && getComputedStyle(el).position !== 'fixed'; }).slice(0, 5)
      .map((el) => el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\\s+/).slice(0, 2).join('.') : ''));
    out.push({ kind: 'overflow-x', detail: 'page is ' + (de.scrollWidth - vw) + 'px wider than the viewport' + (culprits.length ? ' — ' + culprits.join(', ') : '') });
  }
  const noAlt = [...document.images].filter((i) => !i.alt && !i.getAttribute('aria-label') && i.width > 24 && i.height > 24);
  if (noAlt.length) { out.push({ kind: 'img-no-alt', detail: noAlt.length + ' image(s) without alt text: ' + noAlt.slice(0, 3).map((i) => (i.currentSrc || i.src || '').split('/').pop()).join(', ') }); }
  const tiny = [...document.querySelectorAll('body *')].filter((el) => el.children.length === 0 && el.textContent.trim().length > 12 && parseFloat(getComputedStyle(el).fontSize) < 11);
  if (tiny.length) { out.push({ kind: 'tiny-text', detail: tiny.length + ' element(s) with text under 11px' }); }
  const unl = [...document.querySelectorAll('button, a[href], input:not([type=hidden]), select, textarea')].filter((el) => !(el.innerText || '').trim() && !el.getAttribute('aria-label') && !el.getAttribute('title') && !el.getAttribute('placeholder') && !(el.id && document.querySelector('label[for="' + el.id + '"]')) && !el.closest('label'));
  if (unl.length) { out.push({ kind: 'unlabelled-control', detail: unl.length + ' control(s) without an accessible name' }); }
  return out;
})()`;

const PERF_SCRIPT = `(() => {
  const nav = performance.getEntriesByType('navigation')[0];
  const paint = performance.getEntriesByType('paint');
  const fcp = paint.find((p) => p.name === 'first-contentful-paint');
  let lcp; try { const l = performance.getEntriesByType('largest-contentful-paint'); lcp = l.length ? l[l.length - 1].startTime : undefined; } catch {}
  return {
    domContentLoadedMs: nav ? Math.round(nav.domContentLoadedEventEnd) : undefined,
    loadMs: nav ? Math.round(nav.loadEventEnd || nav.duration) : undefined,
    firstContentfulPaintMs: fcp ? Math.round(fcp.startTime) : undefined,
    largestContentfulPaintMs: lcp ? Math.round(lcp) : undefined,
    domNodes: document.getElementsByTagName('*').length,
    jsHeapMb: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576 * 10) / 10 : undefined,
    title: document.title, href: location.href,
  };
})()`;

function fmtArg(a: { type?: string; value?: unknown; description?: string; unserializableValue?: string }): string {
  if (a.unserializableValue) {
    return a.unserializableValue;
  }
  if (a.type === 'string') {
    return String(a.value);
  }
  if (a.value !== undefined && a.type !== 'object') {
    return String(a.value);
  }
  return a.description ?? (a.value !== undefined ? JSON.stringify(a.value) : a.type ?? '');
}

/**
 * Loads a page in a fresh headless browser, optionally performs actions, and collects console output,
 * exceptions, the network trace, performance metrics, layout problems and a screenshot.
 */
export async function inspectPage(browser: string, url: string, opts: InspectOptions): Promise<InspectReport> {
  const say = opts.progress ?? (() => undefined);
  say(`Launching ${path.basename(browser)}…`);
  const cdp = await CdpSession.launch(browser, { width: opts.width, height: opts.height, mobile: opts.mobile, signal: opts.signal });
  const report: InspectReport = { url, finalUrl: url, title: '', width: opts.width, height: opts.height, console: [], network: [], perf: { resources: 0, transferredBytes: 0 }, layout: [], actionLog: [] };
  try {
    const sid = await cdp.newPage();
    const call = <T extends Json = Json>(m: string, p: Json = {}) => cdp.send<T>(m, p, sid);
    await Promise.all([call('Page.enable'), call('Runtime.enable'), call('Log.enable'), call('Network.enable', { maxTotalBufferSize: 10_000_000 }), call('Performance.enable')]);
    await call('Emulation.setDeviceMetricsOverride', { width: opts.width, height: opts.height, deviceScaleFactor: opts.mobile ? 2 : 1, mobile: !!opts.mobile });
    if (opts.mobile) {
      await call('Emulation.setUserAgentOverride', { userAgent: MOBILE_UA });
      await call('Emulation.setTouchEmulationEnabled', { enabled: true });
    }

    // --- collectors ----------------------------------------------------------------------
    const reqs = new Map<string, NetworkEntry & { start: number }>();
    let mainRequestId: string | undefined;
    let inflight = 0;
    let lastActivity = Date.now();
    const bump = () => (lastActivity = Date.now());
    cdp.on('Network.requestWillBeSent', (p, s) => {
      if (s !== sid) {
        return;
      }
      const r = p.request as { url: string; method: string };
      const e: NetworkEntry & { start: number } = { method: r.method, url: r.url, type: String(p.type ?? 'Other'), bytes: 0, start: Number(p.timestamp) * 1000 };
      if (!reqs.has(String(p.requestId))) {
        inflight++;
      }
      reqs.set(String(p.requestId), e);
      if (p.type === 'Document' && !mainRequestId) {
        mainRequestId = String(p.requestId);
      }
      bump();
    });
    cdp.on('Network.responseReceived', (p, s) => {
      if (s !== sid) {
        return;
      }
      const e = reqs.get(String(p.requestId));
      const res = p.response as { status: number; mimeType: string; fromDiskCache?: boolean; fromServiceWorker?: boolean; encodedDataLength?: number };
      if (e) {
        e.status = res.status;
        e.mime = res.mimeType;
        e.fromCache = !!res.fromDiskCache;
        if (String(p.requestId) === mainRequestId) {
          report.status = res.status;
        }
      }
      bump();
    });
    const finish = (id: string, bytes: number | undefined, ts: number, error?: string) => {
      const e = reqs.get(id);
      if (e) {
        if (e.ms === undefined && !e.error) {
          inflight = Math.max(0, inflight - 1);
        }
        e.bytes = bytes ?? e.bytes;
        e.ms = Math.max(0, Math.round(ts * 1000 - e.start));
        if (error) {
          e.error = error;
        }
      }
      bump();
    };
    cdp.on('Network.loadingFinished', (p, s) => s === sid && finish(String(p.requestId), Number(p.encodedDataLength), Number(p.timestamp)));
    cdp.on('Network.loadingFailed', (p, s) => s === sid && finish(String(p.requestId), undefined, Number(p.timestamp), String(p.errorText || 'failed') + (p.canceled ? ' (canceled)' : '')));
    cdp.on('Runtime.consoleAPICalled', (p, s) => {
      if (s !== sid) {
        return;
      }
      const type = String(p.type);
      const level: ConsoleEntry['level'] = type === 'error' || type === 'assert' ? 'error' : type === 'warning' ? 'warn' : type === 'info' ? 'info' : type === 'debug' ? 'debug' : 'log';
      const args = (p.args as Parameters<typeof fmtArg>[0][]) ?? [];
      const frame = (p.stackTrace as { callFrames?: { url: string; lineNumber: number; columnNumber: number }[] } | undefined)?.callFrames?.[0];
      report.console.push({ level, text: args.map(fmtArg).join(' ').slice(0, 2000), at: frame?.url ? `${frame.url}:${frame.lineNumber + 1}:${frame.columnNumber + 1}` : undefined });
      bump();
    });
    cdp.on('Runtime.exceptionThrown', (p, s) => {
      if (s !== sid) {
        return;
      }
      const d = p.exceptionDetails as { text?: string; exception?: { description?: string; value?: unknown }; url?: string; lineNumber?: number; columnNumber?: number; stackTrace?: { callFrames?: { url: string; lineNumber: number; columnNumber: number }[] } };
      const frame = d.stackTrace?.callFrames?.[0];
      const at = frame?.url ? `${frame.url}:${frame.lineNumber + 1}:${frame.columnNumber + 1}` : d.url ? `${d.url}:${(d.lineNumber ?? 0) + 1}:${(d.columnNumber ?? 0) + 1}` : undefined;
      report.console.push({ level: 'error', source: 'exception', text: (d.exception?.description ?? `${d.text ?? 'Uncaught'} ${d.exception?.value ?? ''}`).split('\n').slice(0, 3).join(' ⏎ ').slice(0, 2000), at });
      bump();
    });
    cdp.on('Log.entryAdded', (p, s) => {
      if (s !== sid) {
        return;
      }
      const e = p.entry as { source: string; level: string; text: string; url?: string; lineNumber?: number };
      // Network failures are reported from the network trace; keep the rest (security, deprecation, violation, …).
      // "Deprecated API for given entry type" is triggered by our own LCP probe, not by the page.
      if (e.source === 'network' || /Deprecated API for given entry type/.test(e.text)) {
        return;
      }
      report.console.push({ level: e.level === 'error' ? 'error' : e.level === 'warning' ? 'warn' : e.level === 'info' ? 'info' : 'log', source: e.source, text: e.text.slice(0, 2000), at: e.url ? `${e.url}${e.lineNumber ? `:${e.lineNumber + 1}` : ''}` : undefined });
      bump();
    });

    // --- navigate & settle -----------------------------------------------------------------
    say(`Loading ${url}…`);
    const loaded = cdp.once('Page.loadEventFired', opts.waitMs + 30_000).catch(() => undefined);
    const nav = await call<{ errorText?: string }>('Page.navigate', { url });
    if (nav.errorText) {
      throw new Error(`Could not load ${url}: ${nav.errorText}`);
    }
    await loaded;
    const settle = async (quietMs: number, maxMs: number) => {
      const until = Date.now() + maxMs;
      while (Date.now() < until) {
        if (inflight === 0 && Date.now() - lastActivity >= quietMs) {
          break;
        }
        await new Promise((r) => setTimeout(r, 50));
      }
    };
    await settle(Math.min(opts.waitMs, 800), opts.waitMs + 2000);
    if (opts.waitMs > 800) {
      await new Promise((r) => setTimeout(r, Math.min(opts.waitMs - 800, 10_000)));
    }

    // --- actions ---------------------------------------------------------------------------
    const evaluate = async <T>(expression: string): Promise<T | undefined> => {
      const r = await call<{ result?: { value?: T }; exceptionDetails?: { text?: string; exception?: { description?: string } } }>('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) {
        throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text ?? 'evaluation failed');
      }
      return r.result?.value;
    };
    for (const a of opts.actions ?? []) {
      if (opts.signal?.aborted) {
        throw new Error('Cancelled');
      }
      try {
        if (a.click) {
          const ok = await evaluate<boolean>(`(() => { const el = document.querySelector(${JSON.stringify(a.click)}); if (!el) return false; el.scrollIntoView({ block: 'center' }); el.click(); return true; })()`);
          report.actionLog.push(ok ? `clicked ${a.click}` : `click: no element matches ${a.click}`);
        } else if (a.type) {
          const ok = await evaluate<boolean>(`(() => { const el = document.querySelector(${JSON.stringify(a.type.selector)}); if (!el) return false; el.focus(); const setter = Object.getOwnPropertyDescriptor(el.__proto__, 'value')?.set; setter ? setter.call(el, ${JSON.stringify(a.type.text)}) : (el.value = ${JSON.stringify(a.type.text)}); el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
          report.actionLog.push(ok ? `typed into ${a.type.selector}` : `type: no element matches ${a.type.selector}`);
        } else if (a.scroll !== undefined) {
          await evaluate(`window.scrollTo(0, ${a.scroll === 'bottom' ? 'document.documentElement.scrollHeight' : a.scroll === 'top' ? '0' : Number(a.scroll)})`);
          report.actionLog.push(`scrolled to ${a.scroll}`);
        } else if (a.eval) {
          const v = await evaluate<unknown>(a.eval);
          report.actionLog.push(`eval → ${typeof v === 'string' ? v : JSON.stringify(v)}`.slice(0, 500));
        }
        if (a.wait) {
          await new Promise((r) => setTimeout(r, Math.min(15_000, Number(a.wait))));
        } else {
          await settle(300, 3000);
        }
      } catch (e) {
        report.actionLog.push(`action failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    // --- metrics, layout, text -------------------------------------------------------------
    say('Collecting metrics…');
    const perf = (await evaluate<Partial<PerfMetrics> & { title?: string; href?: string }>(PERF_SCRIPT).catch(() => undefined)) ?? {};
    report.title = perf.title ?? '';
    report.finalUrl = perf.href ?? url;
    report.network = [...reqs.values()].map(({ start: _s, ...e }) => e);
    report.perf = {
      domContentLoadedMs: perf.domContentLoadedMs,
      loadMs: perf.loadMs,
      firstContentfulPaintMs: perf.firstContentfulPaintMs,
      largestContentfulPaintMs: perf.largestContentfulPaintMs,
      domNodes: perf.domNodes,
      jsHeapMb: perf.jsHeapMb,
      resources: report.network.length,
      transferredBytes: report.network.reduce((n, e) => n + (e.bytes || 0), 0),
    };
    report.layout = (await evaluate<LayoutIssue[]>(LAYOUT_SCRIPT).catch(() => [])) ?? [];
    if (opts.includeText) {
      report.text = ((await evaluate<string>('document.body ? document.body.innerText : ""').catch(() => '')) ?? '').replace(/\n{3,}/g, '\n\n').trim().slice(0, 4000);
    }

    // --- screenshot ------------------------------------------------------------------------
    say('Taking screenshot…');
    let clip: Json | undefined;
    if (opts.fullPage) {
      const m = await call<{ cssContentSize?: { width: number; height: number }; contentSize?: { width: number; height: number } }>('Page.getLayoutMetrics');
      const size = m.cssContentSize ?? m.contentSize;
      if (size) {
        const h = Math.min(Math.ceil(size.height), 8000);
        await call('Emulation.setDeviceMetricsOverride', { width: opts.width, height: h, deviceScaleFactor: opts.mobile ? 2 : 1, mobile: !!opts.mobile });
        clip = { x: 0, y: 0, width: opts.width, height: h, scale: 1 };
        report.height = h;
      }
    }
    const shot = await call<{ data: string }>('Page.captureScreenshot', { format: 'png', ...(clip ? { clip, captureBeyondViewport: true } : {}) });
    report.screenshot = shot.data;
    return report;
  } finally {
    await cdp.close();
  }
}

// ------------------------------------------------------------------ report formatting

const kb = (n: number) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`);
const shortUrl = (u: string, base: string) => {
  try {
    const a = new URL(u);
    const b = new URL(base);
    return (a.origin === b.origin ? a.pathname + a.search : u).slice(0, 110);
  } catch {
    return u.slice(0, 110);
  }
};

/** Stable text form of a report: what the model reads, and what the chat renders (the renderer parses these headings). */
export function formatReport(r: InspectReport, opts: { maxConsole?: number; maxNetwork?: number } = {}): string {
  const lines: string[] = [];
  const failed = r.network.filter((e) => e.error || (e.status ?? 0) >= 400);
  const errors = r.console.filter((c) => c.level === 'error');
  const warns = r.console.filter((c) => c.level === 'warn');
  lines.push(`Page: ${r.title || '(no title)'} — ${r.finalUrl}${r.status ? ` (HTTP ${r.status})` : ''} · ${r.width}×${r.height}${r.finalUrl !== r.url ? ` · redirected from ${r.url}` : ''}`);
  if (r.actionLog.length) {
    lines.push(`Actions: ${r.actionLog.join('; ')}`);
  }
  lines.push(`Console: ${errors.length} error${errors.length === 1 ? '' : 's'}, ${warns.length} warning${warns.length === 1 ? '' : 's'}, ${r.console.length - errors.length - warns.length} other`);
  const shown = [...errors, ...warns, ...r.console.filter((c) => c.level !== 'error' && c.level !== 'warn')].slice(0, opts.maxConsole ?? 25);
  for (const c of shown) {
    lines.push(`  [${c.level}]${c.source && c.source !== 'exception' ? ` (${c.source})` : ''} ${c.text.replace(/\s+/g, ' ')}${c.at ? ` — ${shortUrl(c.at, r.finalUrl)}` : ''}`);
  }
  if (r.console.length > shown.length) {
    lines.push(`  … ${r.console.length - shown.length} more console entries`);
  }
  const slowest = [...r.network].filter((e) => e.ms !== undefined && !e.error).sort((a, b) => (b.ms ?? 0) - (a.ms ?? 0))[0];
  lines.push(`Network: ${r.network.length} request${r.network.length === 1 ? '' : 's'} · ${failed.length} failed · ${kb(r.perf.transferredBytes || 0)} transferred${slowest ? ` · slowest ${slowest.method} ${shortUrl(slowest.url, r.finalUrl)} ${slowest.ms ?? 0} ms` : ''}`);
  for (const e of failed.slice(0, opts.maxNetwork ?? 20)) {
    lines.push(`  ✗ ${e.method} ${shortUrl(e.url, r.finalUrl)} → ${e.error ? e.error : `HTTP ${e.status}`}${e.ms !== undefined ? ` (${e.ms} ms)` : ''}`);
  }
  const byType = new Map<string, { n: number; bytes: number }>();
  for (const e of r.network) {
    const t = byType.get(e.type) ?? { n: 0, bytes: 0 };
    t.n++;
    t.bytes += e.bytes || 0;
    byType.set(e.type, t);
  }
  if (byType.size) {
    lines.push(`  by type: ${[...byType.entries()].sort((a, b) => b[1].bytes - a[1].bytes).map(([t, v]) => `${t} ${v.n} (${kb(v.bytes)})`).join(', ')}`);
  }
  const p = r.perf;
  const perfBits = [p.domContentLoadedMs !== undefined ? `DOMContentLoaded ${p.domContentLoadedMs} ms` : '', p.loadMs !== undefined ? `load ${p.loadMs} ms` : '', p.firstContentfulPaintMs !== undefined ? `FCP ${p.firstContentfulPaintMs} ms` : '', p.largestContentfulPaintMs !== undefined ? `LCP ${p.largestContentfulPaintMs} ms` : '', p.domNodes !== undefined ? `${p.domNodes} DOM nodes` : '', p.jsHeapMb !== undefined ? `JS heap ${p.jsHeapMb} MB` : ''].filter(Boolean);
  lines.push(`Performance: ${perfBits.join(' · ') || 'n/a'}`);
  lines.push(`Layout: ${r.layout.length ? r.layout.map((l) => `${l.kind}: ${l.detail}`).join('; ') : 'no issues detected (horizontal overflow, missing alt text, tiny text, unlabelled controls)'}`);
  if (r.text) {
    lines.push(`Text:\n${r.text}`);
  }
  return lines.join('\n');
}
