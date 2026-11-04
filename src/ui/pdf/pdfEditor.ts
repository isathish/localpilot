import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { getConfig } from '../../config';
import {
  FromPdfViewer,
  isAllowedExternalLink,
  MAX_PENDING_RANGES,
  pageFromFragment,
  PdfPosition,
  PdfViewerPrefs,
  rangeAllowed,
  rememberPosition,
  selectionDraft,
  validatePdfViewerMessage,
} from '../../pdf/viewerMessages';
import { ImageAttachment } from '../images';
import { livePdfViews, PDF_VIEW_TYPE } from './open';

/** What the viewer hands to the chat: the file to attach, a page reference, a draft and page images. */
export interface PdfChatHooks {
  /**
   * Shows the chat and appends `text` plus the `refs` chips (workspace-relative path, optionally `#page=N`) to the
   * composer; a chat view that is still loading picks both up when it boots.
   */
  addToComposer(text: string, refs: string[]): void;
  /** Shows the chat and adds the image to its composer, also once a still-loading view boots. */
  attachImage(img: ImageAttachment): void;
}

type ToPdfViewer =
  | { type: 'open'; mode: 'data'; data: Uint8Array; name: string; size: number; page?: number; scale?: string | number; prefs: PdfViewerPrefs }
  | { type: 'open'; mode: 'range'; length: number; initial: Uint8Array; name: string; size: number; page?: number; scale?: string | number; prefs: PdfViewerPrefs }
  | { type: 'rangeData'; id: number; begin: number; data: Uint8Array }
  | { type: 'rangeError'; id: number; message: string }
  | { type: 'reload' }
  | { type: 'goToPage'; page: number }
  | { type: 'prefs'; prefs: PdfViewerPrefs }
  | { type: 'toast'; text: string; level?: 'info' | 'error' }
  | { type: 'tooLarge'; size: number; max: number }
  | { type: 'attachPageImage' };

const POSITIONS_KEY = 'localpilot.pdf.positions';
/** Bytes sent with a range-mode open, enough for pdf.js to find the trailer of a linearized file. */
const INITIAL_RANGE = 64 * 1024;
/** A view that covers its whole buffer, so postMessage never copies bytes outside it (pooled or partly-read buffers). */
const exact = (u: Uint8Array): Uint8Array => (u.byteOffset === 0 && u.byteLength === u.buffer.byteLength ? u : u.slice());

/** One PDF file: its size (re-read on change) and a watcher that tells the open viewer to reload. */
class PdfDocument implements vscode.CustomDocument {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.emitter.event;
  private readonly watcher: vscode.FileSystemWatcher;
  private timer?: NodeJS.Timeout;
  /** Whole-file bytes for schemes without random access (remote and virtual file systems). */
  private cache?: Uint8Array;

  constructor(
    readonly uri: vscode.Uri,
    public size: number,
    /** The page a link asked for (`x.pdf#page=3`), used by the first open only. */
    readonly initialPage?: number
  ) {
    this.watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.joinPath(uri, '..'), path.posix.basename(uri.path)), true, false, true);
    this.watcher.onDidChange(() => {
      clearTimeout(this.timer);
      this.timer = setTimeout(() => {
        this.cache = undefined;
        void vscode.workspace.fs.stat(this.uri).then(
          (s) => {
            this.size = s.size;
            this.emitter.fire();
          },
          () => undefined
        );
      }, 500);
    });
  }

  readAll(): Thenable<Uint8Array> {
    return vscode.workspace.fs.readFile(this.uri);
  }

  async read(begin: number, end: number): Promise<Uint8Array> {
    if (this.uri.scheme === 'file') {
      const fh = await fs.promises.open(this.uri.fsPath, 'r');
      try {
        const buf = Buffer.alloc(end - begin);
        const { bytesRead } = await fh.read(buf, 0, end - begin, begin);
        return new Uint8Array(buf.buffer, buf.byteOffset, bytesRead);
      } finally {
        await fh.close();
      }
    }
    this.cache ??= await this.readAll();
    return this.cache.subarray(begin, end);
  }

  dispose(): void {
    clearTimeout(this.timer);
    this.cache = undefined;
    this.watcher.dispose();
    this.emitter.dispose();
  }
}

/**
 * The PDF viewer: a read-only custom editor rendering with pdf.js inside a locked-down webview. The PDF bytes go
 * through postMessage (whole, or by range for large files), so the webview can read nothing else from disk.
 *
 * Security: document JavaScript never runs (no pdf.sandbox, scripting disabled), XFA is off, forms render flat,
 * embedded attachments are not exposed, and links leave the viewer only as http(s)/mailto through the host.
 */
export class PdfEditorProvider implements vscode.CustomReadonlyEditorProvider<PdfDocument> {
  static readonly viewType = PDF_VIEW_TYPE;
  private readonly panels = new Set<vscode.WebviewPanel>();
  private active?: vscode.WebviewPanel;

  private constructor(
    private readonly ctx: vscode.ExtensionContext,
    private readonly log: vscode.LogOutputChannel,
    private readonly hooks: PdfChatHooks
  ) {}

  /** Register synchronously during activation so viewers restored at startup resolve. */
  static register(ctx: vscode.ExtensionContext, log: vscode.LogOutputChannel, hooks: PdfChatHooks): { provider: PdfEditorProvider; disposable: vscode.Disposable } {
    const provider = new PdfEditorProvider(ctx, log, hooks);
    const disposable = vscode.Disposable.from(
      vscode.window.registerCustomEditorProvider(PDF_VIEW_TYPE, provider, {
        webviewOptions: { retainContextWhenHidden: true, enableFindWidget: false },
        supportsMultipleEditorsPerDocument: false,
      }),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('localpilot.pdfViewer')) {
          const prefs = provider.prefs();
          provider.panels.forEach((p) => void p.webview.postMessage({ type: 'prefs', prefs } satisfies ToPdfViewer));
        }
      })
    );
    return { provider, disposable };
  }

  /** Asks the focused viewer to render its current page and attach it to the chat; false when no viewer is focused. */
  attachActivePageImage(): boolean {
    const p = this.active;
    if (!p?.active) {
      return false;
    }
    void p.webview.postMessage({ type: 'attachPageImage' } satisfies ToPdfViewer);
    return true;
  }

  async openCustomDocument(uri: vscode.Uri): Promise<PdfDocument> {
    const file = uri.with({ fragment: '', query: '' });
    const stat = await vscode.workspace.fs.stat(file);
    return new PdfDocument(file, stat.size, pageFromFragment(uri.fragment));
  }

  async resolveCustomEditor(doc: PdfDocument, panel: vscode.WebviewPanel): Promise<void> {
    const { webview } = panel;
    // One viewer per file: links with different #page fragments must find it.
    const key = doc.uri.with({ fragment: '' }).toString();
    const subs: vscode.Disposable[] = [];
    let pending = 0;
    let force = false;
    let firstOpen = true;
    const post = (m: ToPdfViewer) => void webview.postMessage(m);

    panel.iconPath = vscode.Uri.joinPath(this.ctx.extensionUri, 'media', 'icon.svg');
    webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.ctx.extensionUri, 'media'), vscode.Uri.joinPath(this.ctx.extensionUri, 'dist', 'pdfjs')] };
    webview.html = this.html(webview);
    this.panels.add(panel);
    this.active = panel;
    const live = {
      reveal: (page?: number) => {
        panel.reveal();
        if (page) {
          post({ type: 'goToPage', page });
        }
      },
    };
    livePdfViews.add(key, live);

    const open = async () => {
      const name = path.posix.basename(doc.uri.path);
      const { rangeThresholdMB, maxFileSizeMB } = getConfig().pdfViewer;
      const max = maxFileSizeMB * 1024 * 1024;
      if (doc.size > max && !force) {
        post({ type: 'tooLarge', size: doc.size, max });
        return;
      }
      const saved = this.ctx.workspaceState.get<Record<string, PdfPosition>>(POSITIONS_KEY, {})[key];
      // The link's page wins the first time; reloads keep whatever the webview is showing.
      const at = firstOpen ? { page: doc.initialPage ?? saved?.page, scale: saved?.scale } : {};
      firstOpen = false;
      const prefs = this.prefs();
      if (doc.size <= rangeThresholdMB * 1024 * 1024 && !force) {
        post({ type: 'open', mode: 'data', data: exact(await doc.readAll()), name, size: doc.size, ...at, prefs });
      } else {
        post({ type: 'open', mode: 'range', length: doc.size, initial: exact(await doc.read(0, Math.min(INITIAL_RANGE, doc.size))), name, size: doc.size, ...at, prefs });
      }
    };

    const handle = async (m: FromPdfViewer): Promise<void> => {
      switch (m.type) {
        case 'ready':
          return open();
        case 'clientError':
          this.log.error(`PDF viewer webview (${m.where}): ${m.message}${m.stack ? `\n${m.stack}` : ''}`);
          return;
        case 'openAnyway':
          force = true;
          return open();
        case 'range': {
          if (!rangeAllowed(m.begin, m.end, doc.size) || pending >= MAX_PENDING_RANGES) {
            post({ type: 'rangeError', id: m.id, message: `Range ${m.begin}-${m.end} refused` });
            return;
          }
          pending++;
          try {
            post({ type: 'rangeData', id: m.id, begin: m.begin, data: exact(await doc.read(m.begin, m.end)) });
          } catch (e) {
            post({ type: 'rangeError', id: m.id, message: e instanceof Error ? e.message : String(e) });
          } finally {
            pending--;
          }
          return;
        }
        case 'openLink':
          if (isAllowedExternalLink(m.href)) {
            await vscode.env.openExternal(vscode.Uri.parse(m.href.trim(), true));
          } else {
            post({ type: 'toast', level: 'error', text: 'Only web and mail links open from a PDF.' });
          }
          return;
        case 'openExternal':
          await vscode.env.openExternal(doc.uri);
          return;
        case 'reveal':
          await vscode.commands.executeCommand('revealFileInOS', doc.uri);
          return;
        case 'ask':
          this.hooks.addToComposer('About this PDF: ', [vscode.workspace.asRelativePath(doc.uri)]);
          return;
        case 'askSelection':
          this.hooks.addToComposer(selectionDraft(m.text), [`${vscode.workspace.asRelativePath(doc.uri)}#page=${m.page}`]);
          return;
        case 'attachImage':
          this.hooks.attachImage({ name: m.name, data: m.data, mime: m.mime });
          post({ type: 'toast', text: `Attached ${m.name} to the chat` });
          return;
        case 'copyText':
          await vscode.env.clipboard.writeText(m.text);
          post({ type: 'toast', text: m.text.trim() ? 'Page text copied' : 'This page has no text (scanned?). Attach it as an image instead.' });
          return;
        case 'position': {
          const all = this.ctx.workspaceState.get<Record<string, PdfPosition>>(POSITIONS_KEY, {});
          await this.ctx.workspaceState.update(POSITIONS_KEY, rememberPosition(all, key, { page: m.page, scale: m.scale }));
          return;
        }
        case 'prefs': {
          const c = vscode.workspace.getConfiguration('localpilot');
          for (const [k, v] of Object.entries(m.patch)) {
            await c.update(`pdfViewer.${k}`, v, vscode.ConfigurationTarget.Global);
          }
          return;
        }
      }
    };

    subs.push(
      webview.onDidReceiveMessage((raw: unknown) => {
        const m = validatePdfViewerMessage(raw);
        if (m) {
          void handle(m).catch((e) => {
            this.log.warn(`PDF viewer: ${m.type} failed: ${e instanceof Error ? e.message : String(e)}`);
            post({ type: 'toast', level: 'error', text: e instanceof Error ? e.message : String(e) });
          });
        }
      }),
      doc.onDidChange(() => post({ type: 'reload' })),
      panel.onDidChangeViewState(() => {
        if (panel.active) {
          this.active = panel;
        }
      })
    );
    panel.onDidDispose(() => {
      subs.forEach((d) => d.dispose());
      livePdfViews.delete(key, live);
      this.panels.delete(panel);
      if (this.active === panel) {
        this.active = undefined;
      }
    });
  }

  prefs(): PdfViewerPrefs {
    const { pageColors, sidebar, defaultZoom } = getConfig().pdfViewer;
    return { pageColors, sidebar, defaultZoom };
  }

  private html(webview: vscode.Webview): string {
    const media = (f: string) => webview.asWebviewUri(vscode.Uri.joinPath(this.ctx.extensionUri, 'media', f)).toString();
    const pdfjs = (f: string) => webview.asWebviewUri(vscode.Uri.joinPath(this.ctx.extensionUri, 'dist', 'pdfjs', f)).toString();
    const nonce = Array.from({ length: 24 }, () => 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'[Math.floor(Math.random() * 62)]).join('');
    const config = JSON.stringify({
      worker: pdfjs('pdf.worker.mjs'),
      cmaps: `${pdfjs('cmaps')}/`,
      standardFonts: `${pdfjs('standard_fonts')}/`,
      wasm: `${pdfjs('wasm')}/`,
      iccs: `${pdfjs('iccs')}/`,
      images: `${pdfjs('images')}/`,
    }).replace(/</g, '\\u003c');
    // 'wasm-unsafe-eval' only allows WebAssembly (JPX, JBIG2, ICC decoders); the worker starts from a blob of the
    // packaged worker file; connect-src lets the main thread fetch cmaps and fonts. No eval, no remote source.
    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}' 'wasm-unsafe-eval'; worker-src blob:; connect-src ${webview.cspSource}; style-src ${webview.cspSource} 'unsafe-inline'; img-src ${webview.cspSource} data: blob:; font-src ${webview.cspSource} data: blob:;" />
<link rel="stylesheet" href="${pdfjs('pdf_viewer.css')}" />
<link rel="stylesheet" href="${media('pdfview.css')}" />
<title>LocalPilot PDF</title>
</head>
<body>
<script type="application/json" id="pdf-config">${config}</script>
<header id="bar" class="bar" role="toolbar" aria-label="PDF toolbar">
  <button id="sidebarToggle" class="ib" title="Sidebar (outline and thumbnails)" aria-pressed="false"><svg viewBox="0 0 16 16"><rect x="2.5" y="3" width="11" height="10" rx="1.5"/><path d="M6 3v10"/></svg></button>
  <span class="sep"></span>
  <button id="prev" class="ib" title="Previous page (p)"><svg viewBox="0 0 16 16"><path d="m4.5 10 3.5-3.5 3.5 3.5"/></svg></button>
  <button id="next" class="ib" title="Next page (n)"><svg viewBox="0 0 16 16"><path d="m4.5 6 3.5 3.5 3.5-3.5"/></svg></button>
  <span class="pagebox"><input id="page" type="number" min="1" value="1" aria-label="Page" title="Page (Ctrl+G)" /><span id="total" class="muted">/ –</span></span>
  <span class="sep"></span>
  <button id="zoomOut" class="ib" title="Zoom out (Ctrl+-)"><svg viewBox="0 0 16 16"><path d="M4 8h8"/></svg></button>
  <select id="zoom" title="Zoom" aria-label="Zoom">
    <option value="auto">Auto</option><option value="page-width">Page width</option><option value="page-fit">Page fit</option><option value="page-actual">Actual size</option>
    <option value="0.5">50%</option><option value="0.75">75%</option><option value="1">100%</option><option value="1.25">125%</option><option value="1.5">150%</option><option value="2">200%</option><option value="3">300%</option><option value="4">400%</option>
    <option value="custom" id="zoomCustom" hidden></option>
  </select>
  <button id="zoomIn" class="ib" title="Zoom in (Ctrl+=)"><svg viewBox="0 0 16 16"><path d="M4 8h8M8 4v8"/></svg></button>
  <button id="rotate" class="ib" title="Rotate clockwise (r)"><svg viewBox="0 0 16 16"><path d="M12.5 7.5A4.5 4.5 0 1 1 11 4.2M11.5 2v2.5H9"/></svg></button>
  <span class="spacer"></span>
  <button id="colors" class="ib" title="Page colours" aria-haspopup="menu"><svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="5.5"/><path d="M8 2.5v11A5.5 5.5 0 0 0 8 2.5z" fill="currentColor"/></svg></button>
  <button id="findToggle" class="ib" title="Find (Ctrl+F)"><svg viewBox="0 0 16 16"><circle cx="7" cy="7" r="4"/><path d="m10 10 3.5 3.5"/></svg></button>
  <button id="ask" class="ask" title="Ask LocalPilot about this PDF"><svg viewBox="0 0 16 16"><path d="M3 3.5h10v7H7l-3 2.5v-2.5H3z"/></svg><span>Ask</span></button>
  <button id="more" class="ib" title="More actions" aria-haspopup="menu"><svg viewBox="0 0 16 16"><path d="M4 8h.01M8 8h.01M12 8h.01" stroke-width="2.2"/></svg></button>
</header>
<div id="findbar" class="findbar hidden" role="search">
  <input id="findInput" type="search" placeholder="Find in document" aria-label="Find in document" />
  <button id="findPrev" class="ib" title="Previous match (Shift+Enter)"><svg viewBox="0 0 16 16"><path d="m4.5 10 3.5-3.5 3.5 3.5"/></svg></button>
  <button id="findNext" class="ib" title="Next match (Enter)"><svg viewBox="0 0 16 16"><path d="m4.5 6 3.5 3.5 3.5-3.5"/></svg></button>
  <label><input id="findCase" type="checkbox" /> Match case</label>
  <label><input id="findWord" type="checkbox" /> Whole words</label>
  <label><input id="findAll" type="checkbox" checked /> Highlight all</label>
  <span id="findCount" class="muted" aria-live="polite"></span>
  <span class="spacer"></span>
  <button id="findClose" class="ib" title="Close (Esc)"><svg viewBox="0 0 16 16"><path d="m4.5 4.5 7 7m0-7-7 7"/></svg></button>
</div>
<div id="progress" class="progress hidden"><div></div></div>
<div id="layout" class="layout">
  <nav id="sidebar" class="sidebar hidden" aria-label="Document navigation">
    <div class="tabs" role="tablist"><button id="tabOutline" role="tab">Outline</button><button id="tabThumbs" role="tab">Pages</button></div>
    <div id="outlineView" class="outline" role="tree"></div>
    <div id="thumbsView" class="thumbs hidden"></div>
  </nav>
  <div id="viewerContainer" class="viewer-container" tabindex="0"><div id="viewer" class="pdfViewer"></div></div>
</div>
<div id="panel" class="panel hidden" role="dialog" aria-live="polite"></div>
<button id="askSel" class="ask-sel hidden" title="Ask LocalPilot about the selected text">Ask about selection</button>
<div id="menu" class="menu hidden" role="menu"></div>
<div id="toasts"></div>
<script nonce="${nonce}" type="module">
import * as pdfjsLib from '${pdfjs('pdf.mjs')}';
globalThis.pdfjsLib = pdfjsLib;
globalThis.pdfjsViewer = await import('${pdfjs('pdf_viewer.mjs')}');
await import('${media('pdfview.js')}');
</script>
</body>
</html>`;
  }
}
