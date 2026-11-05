import * as cp from 'child_process';
import { promises as fsp } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { pathToFileURL } from 'url';
import * as vscode from 'vscode';
import { getConfig } from '../../config';
import { findHeadlessBrowser } from '../../tools/browser';
import { buildExportDocument, exportImageSrc, ExportTarget, imageSources, inlineKatexFonts, MAX_EXPORT_HTML, printToPdfArgs, quoteForDraft, rewriteImageSources, sanitizeExportHtml } from './export';
import { LEGACY_FONT_KEY, PREFS_KEY, prefsCss, ReaderPrefs, readPrefs, sanitizePrefsPatch } from './prefs';
import { parseLinkTarget, renderMarkdown } from './render';
import { isPdfPath, openPdf } from '../pdf/open';
import { askDraft, MAX_QUOTE, quoteCutNotice } from '../../pdf/viewerMessages';
import { noteViewerKeyAsk, viewerAnsweredKey } from '../viewerKeyAsk';

export type Source = { kind: 'file'; uri: vscode.Uri } | { kind: 'text'; title: string; text: string };

type FromViewer =
  | { type: 'ready' }
  | { type: 'reload' }
  | { type: 'clientError'; where: string; message: string; stack?: string }
  | { type: 'openEditor' }
  | { type: 'saveAs'; svg?: string; name?: string }
  | { type: 'copy' }
  /** The toolbar's Find button: VS Code's find widget for this webview. */
  | { type: 'find' }
  | { type: 'openLink'; href: string }
  | { type: 'openPath'; path: string; line?: number; endLine?: number; anchor?: string; page?: number }
  | { type: 'fontSize'; delta: number }
  | { type: 'revealLine'; line: number }
  | { type: 'openSourceAt'; line: number }
  | { type: 'prefs'; patch: Partial<ReaderPrefs> }
  | { type: 'exportHtml'; html: string; target: ExportTarget; preface?: string; vars?: string; themeClass?: string }
  /** `key`: sent by Ctrl/Cmd+' in the webview (the keybinding's command then stands down). */
  | { type: 'ask'; key?: boolean }
  /** `text` is cut to the quote limit by the webview; `total` is the selection's full length when it was cut. */
  | { type: 'askSelection'; text: string; line?: number; endLine?: number; total?: number; key?: boolean }
  /** The More menu's "Viewer settings…": Settings → Markdown & PDF. */
  | { type: 'openSettings' }
  /** Close on the error card or the deleted-file banner. */
  | { type: 'close' };

type ToViewer =
  | {
      type: 'content';
      html: string;
      title: string;
      subtitle: string;
      markdown: string;
      isFile: boolean;
      words: number;
      fontSize: number;
      prefs: ReaderPrefs;
      prefsCss: Record<string, string>;
      /** Whether the Ask LocalPilot actions have a chat to go to. */
      canAsk: boolean;
      /** Characters of a selection quoted into the chat draft (`MAX_QUOTE`). */
      maxQuote: number;
      frontMatter?: Record<string, unknown>;
      frontMatterMode: 'collapsed' | 'expanded' | 'hidden';
      mermaidSrc?: string;
      outlineDepth: number;
      syncScroll: boolean;
      isCustomEditor: boolean;
      /** Workspace-relative path and the front-matter line offset, for "Copy as path:line". */
      pathRef?: string;
      lineOffset: number;
      /** What the panel serializer restores after a reload (file sources only). */
      persist?: { kind: 'file'; uri: string };
    }
  | { type: 'toast'; text: string; level?: 'info' | 'error' }
  | { type: 'scrollToLine'; line: number }
  | { type: 'scrollToAnchor'; anchor: string }
  | { type: 'prefs'; prefs: ReaderPrefs; css: Record<string, string> }
  | { type: 'requestExport'; target: ExportTarget }
  /** The document could not be rendered: the view replaces it with a card offering Retry. */
  | { type: 'error'; title: string; message: string }
  /** The file was deleted or moved away; the view keeps the last render under a banner until it comes back. */
  | { type: 'deleted' }
  | { type: 'restored' };

/** The chat entry points the Ask actions use (`ChatController` satisfies it). */
export interface ReaderChat {
  /** Chips and draft text in one buffered message, so a chat view still booting receives both. */
  addToComposer(text: string, attachments: string[]): void;
  draft(text: string): void;
}

export interface ViewSessionOptions {
  webview: vscode.Webview;
  ctx: vscode.ExtensionContext;
  log: vscode.LogOutputChannel;
  isCustomEditor: boolean;
  /** Called with the document title after each render (the reader panel shows it as its tab title). */
  onTitle?: (title: string) => void;
  /** Opens another Markdown file in the reader, scrolled to a heading when `anchor` is given. */
  openMarkdown: (uri: vscode.Uri, anchor?: string) => Promise<void>;
  /** The panel hosting the webview, so commands can find the reader in focus. */
  panel?: vscode.WebviewPanel;
  /** Where Ask LocalPilot sends the document; the Ask actions are hidden without it. */
  chat?: ReaderChat;
}

const MAX_TEXT = 100_000;
const MAX_SVG = 20 * 1024 * 1024;
const EXPORT_TARGETS: readonly ExportTarget[] = ['html', 'pdf', 'clipboard'];

const str = (v: unknown, max = MAX_TEXT): string | undefined => (typeof v === 'string' && v.length <= max ? v : undefined);
const int = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v < 1e7 ? Math.floor(v) : undefined);

/** Checks every field of a webview message; anything malformed is dropped. */
export function validateViewerMessage(raw: unknown): FromViewer | undefined {
  if (!raw || typeof raw !== 'object') {
    return undefined;
  }
  const m = raw as Record<string, unknown>;
  switch (m.type) {
    case 'ready':
    case 'reload':
    case 'openEditor':
    case 'copy':
    case 'find':
    case 'openSettings':
    case 'close':
      return { type: m.type };
    case 'clientError':
      return { type: 'clientError', where: str(m.where, 200) ?? '?', message: str(m.message, 4000) ?? '?', stack: str(m.stack, 8000) };
    case 'saveAs':
      // An oversize or malformed diagram must not fall through to "Save Markdown".
      if (m.svg !== undefined && str(m.svg, MAX_SVG) === undefined) {
        return undefined;
      }
      return { type: 'saveAs', svg: str(m.svg, MAX_SVG), name: str(m.name, 200) };
    case 'openLink':
      return str(m.href, 4000) ? { type: 'openLink', href: m.href as string } : undefined;
    case 'openPath': {
      const p = str(m.path, 4000);
      return p ? { type: 'openPath', path: p, line: int(m.line), endLine: int(m.endLine), anchor: str(m.anchor, 500), page: int(m.page) } : undefined;
    }
    case 'fontSize':
      return typeof m.delta === 'number' && Number.isFinite(m.delta) ? { type: 'fontSize', delta: Math.sign(m.delta) } : undefined;
    case 'revealLine':
    case 'openSourceAt': {
      const line = int(m.line);
      return line === undefined ? undefined : { type: m.type, line };
    }
    case 'prefs': {
      const patch = sanitizePrefsPatch(m.patch);
      return Object.keys(patch).length ? { type: 'prefs', patch } : undefined;
    }
    case 'exportHtml': {
      const html = str(m.html, MAX_EXPORT_HTML);
      const target = EXPORT_TARGETS.find((t) => t === m.target);
      if (html === undefined || !target || (m.preface !== undefined && str(m.preface, MAX_TEXT * 10) === undefined)) {
        return undefined;
      }
      return { type: 'exportHtml', html, target, preface: str(m.preface, MAX_TEXT * 10), vars: str(m.vars, 200_000), themeClass: str(m.themeClass, 100) };
    }
    case 'ask':
      return m.key === true ? { type: 'ask', key: true } : { type: 'ask' };
    case 'askSelection': {
      const text = str(m.text);
      if (!text?.trim()) {
        return undefined;
      }
      const total = int(m.total);
      const endLine = int(m.endLine);
      return {
        type: 'askSelection',
        text,
        line: int(m.line),
        ...(endLine !== undefined ? { endLine } : {}),
        ...(total !== undefined && total > text.length ? { total } : {}),
        ...(m.key === true ? { key: true } : {}),
      };
    }
  }
  return undefined;
}

/**
 * Attaches a file (Markdown or PDF) to the visible chat and drafts a question about it. `fromViewer`: the reader's own
 * Ask; otherwise (the command) a viewer that already answered the same Ctrl/Cmd+' press wins.
 */
export async function askAboutFile(chat: ReaderChat, uri: vscode.Uri, fromViewer = false): Promise<void> {
  if (!fromViewer && (await viewerAnsweredKey(uri))) {
    return;
  }
  await vscode.commands.executeCommand('localpilot.openChat');
  chat.addToComposer(askDraft(path.posix.basename(uri.path)), uri.scheme === 'file' ? [vscode.workspace.asRelativePath(uri)] : []);
}

let sessionSeq = 0;

/**
 * One reader webview bound to one Markdown source: used by the reader panel (`MarkdownViewer`) and by the
 * "Open With… → LocalPilot Markdown Reader" custom editor. Renders, live-reloads, routes links and keeps the
 * view and the source editor scrolled together.
 */
export class MarkdownViewSession implements vscode.Disposable {
  /** Every open reader (panel and custom editors): reading preferences are pushed to all of them. */
  private static readonly all = new Set<MarkdownViewSession>();
  /** One listener for every reader: `localpilot.markdownViewer.*` changes re-render them; disposed with the last reader. */
  private static configSub?: vscode.Disposable;
  /** Identifies a reader of text from the chat (no file URI) to the Ctrl/Cmd+' de-duplication. */
  private readonly id = `localpilot-reader:${++sessionSeq}`;
  source?: Source;
  private watchers: vscode.Disposable[] = [];
  private readonly subs: vscode.Disposable[] = [];
  private reloadTimer?: NodeJS.Timeout;
  private syncTimer?: NodeJS.Timeout;
  private pendingLine?: number;
  /** Until when editor scroll events are ours (from a reveal) and must not be echoed back to the view. */
  private suppressUntil = 0;
  private frontMatterLines = 0;
  private pendingAnchor?: string;
  private disposed = false;
  /** The webview script has booted (messages posted before that are lost). */
  private ready = false;
  private pendingExport?: ExportTarget;
  /** The watched file is gone; set until it is created again. */
  private deleted = false;

  /** The reader whose tab is focused, if any. */
  static active(): MarkdownViewSession | undefined {
    return [...MarkdownViewSession.all].find((s) => s.opts.panel?.active);
  }

  /** A reader showing `uri` (the focused one first). */
  static forUri(uri: vscode.Uri): MarkdownViewSession | undefined {
    const shows = (s: MarkdownViewSession) => s.source?.kind === 'file' && s.source.uri.toString() === uri.toString();
    const list = [...MarkdownViewSession.all].filter(shows);
    return list.find((s) => s.opts.panel?.active) ?? list[0];
  }

  constructor(private readonly opts: ViewSessionOptions) {
    MarkdownViewSession.all.add(this);
    MarkdownViewSession.configSub ??= vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('localpilot.markdownViewer')) {
        // Front matter, outline depth, Mermaid and scroll sync all travel with the render.
        MarkdownViewSession.all.forEach((s) => void s.renderOrReport());
      }
    });
    const { webview } = opts;
    webview.options = { enableScripts: true, localResourceRoots: this.roots() };
    webview.html = this.html();
    this.subs.push(
      webview.onDidReceiveMessage((raw: unknown) => {
        const m = validateViewerMessage(raw);
        if (m) {
          void this.handle(m).catch((e) => this.post({ type: 'toast', level: 'error', text: e instanceof Error ? e.message : String(e) }));
        }
      }),
      vscode.window.onDidChangeTextEditorVisibleRanges((e) => this.onEditorScroll(e))
    );
  }

  private roots(): vscode.Uri[] {
    const ext = this.opts.ctx.extensionUri;
    return [vscode.Uri.joinPath(ext, 'media'), vscode.Uri.joinPath(ext, 'dist', 'webview'), ...(vscode.workspace.workspaceFolders ?? []).map((f) => f.uri)];
  }

  /** Shows a new source; `anchor` scrolls to that heading once it has rendered. */
  async setSource(source: Source, anchor?: string): Promise<void> {
    this.source = source;
    this.pendingAnchor = anchor;
    this.unwatch();
    if (source.kind === 'file') {
      this.allowResources(vscode.Uri.file(path.dirname(source.uri.fsPath)));
      this.watch(source.uri);
    }
    await this.renderOrReport();
  }

  /** Renders, and on failure shows the error card instead of leaving the view on "Rendering…" or a stale page. */
  private async renderOrReport(): Promise<void> {
    try {
      await this.render();
    } catch (e) {
      const s = this.source;
      const name = s?.kind === 'file' ? path.basename(s.uri.fsPath) : (s?.title ?? 'document');
      const message = e instanceof Error ? e.message : String(e);
      this.opts.log.warn(`markdown reader: could not render ${name}: ${message}`);
      this.post({ type: 'error', title: `Couldn't render ${name}`, message });
    }
  }

  scrollToAnchor(anchor: string): void {
    this.post({ type: 'scrollToAnchor', anchor });
  }

  /** Lets relative images load for a file outside the workspace folders (e.g. an agent's worktree). */
  private allowResources(dir: vscode.Uri): void {
    const { webview } = this.opts;
    const roots = webview.options.localResourceRoots ?? [];
    const within = (r: vscode.Uri) => {
      const rel = path.relative(r.fsPath, dir.fsPath);
      return !rel.startsWith('..') && !path.isAbsolute(rel);
    };
    if (!roots.some(within)) {
      webview.options = { ...webview.options, localResourceRoots: [...roots, dir] };
    }
  }

  private post(m: ToViewer): void {
    if (this.disposed) {
      return;
    }
    // Rejects once the webview is disposed (a file change can race the close); nothing to do about it.
    this.opts.webview.postMessage(m).then(undefined, () => undefined);
  }

  private watch(uri: vscode.Uri): void {
    const same = (u: vscode.Uri) => u.toString() === uri.toString();
    const schedule = () => {
      clearTimeout(this.reloadTimer);
      this.reloadTimer = setTimeout(() => void this.renderOrReport(), 200);
    };
    let deleteTimer: NodeJS.Timeout | undefined;
    // Editors that save atomically delete and recreate the file; only a file still missing a moment later counts as deleted.
    const onDelete = () => {
      clearTimeout(deleteTimer);
      deleteTimer = setTimeout(() => {
        void vscode.workspace.fs.stat(uri).then(
          () => undefined,
          () => {
            if (!this.deleted && this.source?.kind === 'file' && same(this.source.uri)) {
              this.deleted = true;
              this.post({ type: 'deleted' });
            }
          }
        );
      }, 300);
    };
    const onCreate = () => {
      clearTimeout(deleteTimer);
      if (this.deleted) {
        this.deleted = false;
        this.post({ type: 'restored' });
      }
      schedule();
    };
    const fsw = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(path.dirname(uri.fsPath)), path.basename(uri.fsPath)));
    this.watchers.push(
      fsw,
      fsw.onDidChange(schedule),
      fsw.onDidCreate(onCreate),
      fsw.onDidDelete(onDelete),
      { dispose: () => clearTimeout(deleteTimer) },
      vscode.workspace.onDidChangeTextDocument((e) => same(e.document.uri) && e.contentChanges.length > 0 && schedule())
    );
  }

  private unwatch(): void {
    clearTimeout(this.reloadTimer);
    this.deleted = false;
    this.watchers.forEach((d) => d.dispose());
    this.watchers = [];
  }

  async currentText(): Promise<string> {
    const s = this.source;
    if (!s) {
      return '';
    }
    if (s.kind === 'text') {
      return s.text;
    }
    // Prefer the editor buffer so unsaved edits show up live.
    const open = vscode.workspace.textDocuments.find((d) => d.uri.toString() === s.uri.toString());
    if (open) {
      return open.getText();
    }
    return Buffer.from(await vscode.workspace.fs.readFile(s.uri)).toString('utf8');
  }

  private workspaceRoot(): string | undefined {
    const s = this.source;
    const folder = s?.kind === 'file' ? vscode.workspace.getWorkspaceFolder(s.uri) : undefined;
    return (folder ?? vscode.workspace.workspaceFolders?.[0])?.uri.fsPath;
  }

  private baseDir(): string | undefined {
    const s = this.source;
    return s?.kind === 'file' ? path.dirname(s.uri.fsPath) : this.workspaceRoot();
  }

  async render(): Promise<void> {
    const s = this.source;
    if (!s || this.disposed) {
      return;
    }
    const { webview, ctx, log } = this.opts;
    const markdown = await this.currentText();
    const cfg = getConfig().markdownViewer;
    const out = await renderMarkdown(
      {
        markdown,
        baseDir: this.baseDir(),
        workspaceRoot: this.workspaceRoot(),
        // VS Code's bundled Markdown engine (markdown-it + highlighting), the same one the built-in preview uses.
        engine: async (md) => {
          try {
            return (await vscode.commands.executeCommand<string>('markdown.api.render', md)) ?? '';
          } catch (e) {
            log.warn(`markdown.api.render unavailable, falling back to plain rendering: ${String(e)}`);
            throw e;
          }
        },
      },
      (abs) => webview.asWebviewUri(vscode.Uri.file(abs)).toString()
    );
    this.frontMatterLines = out.frontMatterLines;
    const title = s.kind === 'file' ? path.basename(s.uri.fsPath) : s.title;
    const rel = s.kind === 'file' ? vscode.workspace.asRelativePath(s.uri) : undefined;
    this.opts.onTitle?.(title);
    this.post({
      type: 'content',
      html: out.html,
      title,
      subtitle: rel ?? 'From the chat',
      markdown,
      isFile: s.kind === 'file',
      words: out.words,
      fontSize: this.prefs().fontSize,
      prefs: this.prefs(),
      prefsCss: prefsCss(this.prefs()),
      canAsk: !!this.opts.chat,
      maxQuote: MAX_QUOTE,
      frontMatter: cfg.frontMatter === 'hidden' ? undefined : out.frontMatter,
      frontMatterMode: cfg.frontMatter,
      mermaidSrc: cfg.mermaid && out.hasMermaid ? webview.asWebviewUri(vscode.Uri.joinPath(ctx.extensionUri, 'dist', 'webview', 'mermaid.js')).toString() : undefined,
      outlineDepth: cfg.outlineDepth,
      syncScroll: cfg.scrollSync && s.kind === 'file',
      isCustomEditor: this.opts.isCustomEditor,
      pathRef: rel,
      lineOffset: out.frontMatterLines,
      persist: s.kind === 'file' ? { kind: 'file', uri: s.uri.toString() } : undefined,
    });
    if (this.pendingAnchor) {
      this.post({ type: 'scrollToAnchor', anchor: this.pendingAnchor });
      this.pendingAnchor = undefined;
    }
    if (this.ready && this.pendingExport) {
      this.post({ type: 'requestExport', target: this.pendingExport });
      this.pendingExport = undefined;
    }
  }

  private prefs(): ReaderPrefs {
    const { globalState } = this.opts.ctx;
    return readPrefs(globalState.get(PREFS_KEY), globalState.get(LEGACY_FONT_KEY));
  }

  /** Saves a preference change and applies it live in every open reader, without re-rendering. */
  private async updatePrefs(patch: Partial<ReaderPrefs>): Promise<void> {
    const prefs = { ...this.prefs(), ...patch };
    await this.opts.ctx.globalState.update(PREFS_KEY, prefs);
    const css = prefsCss(prefs);
    MarkdownViewSession.all.forEach((s) => s.post({ type: 'prefs', prefs, css }));
  }

  /** Asks the webview for its decorated HTML (Mermaid only draws there); the export continues when it answers. */
  requestExport(target: ExportTarget): void {
    if (this.ready) {
      this.post({ type: 'requestExport', target });
    } else {
      this.pendingExport = target;
    }
  }

  /** The command's Ask (palette, editor title, Ctrl/Cmd+'): skipped when this reader's webview already answered the key. */
  async ask(): Promise<void> {
    const s = this.source;
    if (s && (await viewerAnsweredKey(s.kind === 'file' ? s.uri : this.id))) {
      return;
    }
    return this.askDocument();
  }

  /**
   * Ask LocalPilot about the whole document: a file is attached; text from the chat is quoted into the draft, or,
   * over the quote limit, attached whole as a Markdown file so nothing is cut.
   */
  private async askDocument(): Promise<void> {
    const { chat } = this.opts;
    const s = this.source;
    if (!chat || !s) {
      return;
    }
    if (s.kind === 'file') {
      return askAboutFile(chat, s.uri, true);
    }
    await vscode.commands.executeCommand('localpilot.openChat');
    if (s.text.length <= MAX_QUOTE) {
      chat.draft(`${askDraft(s.title)}\n\n${quoteForDraft(s.text)}\n\n`);
      return;
    }
    // Chat attachments are read by path, and text from the chat has none: it goes to a private temp file.
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'localpilot-reader-'));
    const file = path.join(dir, `${slugName(s.title) || 'document'}.md`);
    await fsp.writeFile(file, s.text, 'utf8');
    chat.addToComposer(askDraft(s.title), [file]);
  }

  private async askSelection(m: Extract<FromViewer, { type: 'askSelection' }>): Promise<void> {
    const { chat } = this.opts;
    const s = this.source;
    if (!chat || !s) {
      return;
    }
    await vscode.commands.executeCommand('localpilot.openChat');
    const draft = `${quoteForDraft(m.text)}\n\n`;
    const total = Math.max(m.total ?? 0, m.text.length);
    if (total > MAX_QUOTE) {
      this.post({ type: 'toast', text: quoteCutNotice(total) });
    }
    if (s.kind !== 'file') {
      chat.draft(draft);
      return;
    }
    // data-line is 0-based in the rendered body; the attachment wants 1-based source lines.
    const rel = vscode.workspace.asRelativePath(s.uri);
    const from = m.line === undefined ? undefined : m.line + this.frontMatterLines + 1;
    const to = m.endLine === undefined ? undefined : m.endLine + this.frontMatterLines + 1;
    chat.addToComposer(draft, [from === undefined ? rel : to !== undefined && to > from ? `${rel}#L${from}-L${to}` : `${rel}#L${from}`]);
  }

  /** Editor → view: the first visible source line, throttled to 50 ms with a trailing update. */
  private onEditorScroll(e: vscode.TextEditorVisibleRangesChangeEvent): void {
    const s = this.source;
    if (s?.kind !== 'file' || e.textEditor.document.uri.toString() !== s.uri.toString() || !e.visibleRanges.length || !getConfig().markdownViewer.scrollSync) {
      return;
    }
    if (Date.now() < this.suppressUntil) {
      return;
    }
    const line = Math.max(0, e.visibleRanges[0].start.line - this.frontMatterLines);
    if (this.syncTimer) {
      this.pendingLine = line;
      return;
    }
    this.post({ type: 'scrollToLine', line });
    this.syncTimer = setTimeout(() => {
      this.syncTimer = undefined;
      if (this.pendingLine !== undefined && Date.now() >= this.suppressUntil) {
        this.post({ type: 'scrollToLine', line: this.pendingLine });
      }
      this.pendingLine = undefined;
    }, 50);
  }

  private editorsForSource(): vscode.TextEditor[] {
    const s = this.source;
    return s?.kind === 'file' ? vscode.window.visibleTextEditors.filter((ed) => ed.document.uri.toString() === s.uri.toString()) : [];
  }

  private async handle(m: FromViewer): Promise<void> {
    const s = this.source;
    switch (m.type) {
      case 'clientError':
        this.opts.log.error(`markdown viewer webview (${m.where}): ${m.message}${m.stack ? `\n${m.stack}` : ''}`);
        return;
      case 'ready':
        this.ready = true;
        await this.renderOrReport();
        // A reloaded webview starts without the banner.
        if (this.deleted) {
          this.post({ type: 'deleted' });
        }
        return;
      case 'reload':
        return this.renderOrReport();
      case 'close':
        this.opts.panel?.dispose();
        return;
      case 'openSettings':
        await vscode.commands.executeCommand('localpilot.openSettings', 'documents');
        return;
      case 'openEditor':
        if (s?.kind === 'file') {
          await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(s.uri), { preview: false, viewColumn: this.opts.isCustomEditor ? vscode.ViewColumn.Beside : vscode.ViewColumn.One });
        } else if (s) {
          const doc = await vscode.workspace.openTextDocument({ language: 'markdown', content: s.text });
          await vscode.window.showTextDocument(doc, { preview: false, viewColumn: vscode.ViewColumn.One });
        }
        return;
      case 'saveAs':
        return m.svg !== undefined ? this.saveSvg(m.svg, m.name) : this.saveMarkdown();
      case 'copy':
        await vscode.env.clipboard.writeText(await this.currentText());
        this.post({ type: 'toast', text: 'Markdown copied' });
        return;
      case 'find':
        await vscode.commands.executeCommand('editor.action.webvieweditor.showFind');
        return;
      case 'openLink': {
        const t = parseLinkTarget(m.href);
        if (t?.kind === 'external') {
          await vscode.env.openExternal(vscode.Uri.parse(t.href));
        }
        return;
      }
      case 'openPath':
        return this.openPath(m);
      case 'fontSize':
        return this.updatePrefs({ fontSize: Math.min(24, Math.max(11, this.prefs().fontSize + m.delta)) });
      case 'prefs':
        return this.updatePrefs(m.patch);
      case 'ask':
        if (m.key) {
          noteViewerKeyAsk(s?.kind === 'file' ? s.uri : this.id);
        }
        return this.askDocument();
      case 'askSelection':
        if (m.key) {
          noteViewerKeyAsk(s?.kind === 'file' ? s.uri : this.id);
        }
        return this.askSelection(m);
      case 'exportHtml':
        return this.exportDocument(m);
      case 'revealLine': {
        if (!getConfig().markdownViewer.scrollSync) {
          return;
        }
        const line = m.line + this.frontMatterLines;
        const editors = this.editorsForSource();
        if (editors.length) {
          // Our own reveal fires visible-range events; ignore them so the two sides never chase each other.
          this.suppressUntil = Date.now() + 300;
        }
        for (const ed of editors) {
          const pos = new vscode.Position(Math.min(line, ed.document.lineCount - 1), 0);
          ed.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.AtTop);
        }
        return;
      }
      case 'openSourceAt': {
        if (s?.kind !== 'file') {
          return;
        }
        const line = m.line + this.frontMatterLines;
        const visible = this.editorsForSource()[0];
        const pos = new vscode.Position(line, 0);
        this.suppressUntil = Date.now() + 300;
        await vscode.window.showTextDocument(s.uri, {
          selection: new vscode.Range(pos, pos),
          preview: false,
          viewColumn: visible?.viewColumn ?? (this.opts.isCustomEditor ? vscode.ViewColumn.Beside : vscode.ViewColumn.One),
        });
        return;
      }
    }
  }

  /** Base name for exported files: the source file's, or the title of text from the chat. */
  private exportName(): string {
    const s = this.source;
    return s?.kind === 'file' ? path.basename(s.uri.fsPath).replace(/\.(md|markdown)$/i, '') : slugName(s?.title ?? '') || 'document';
  }

  /** The file behind a webview resource URL (`asWebviewUri`), or undefined for remote and data: sources. */
  private localFile(src: string): vscode.Uri | undefined {
    const prefix = this.opts.webview.asWebviewUri(vscode.Uri.file('/')).toString();
    if (!src.startsWith(prefix)) {
      return undefined;
    }
    try {
      return vscode.Uri.file(`/${decodeURIComponent(src.slice(prefix.length).split(/[?#]/)[0])}`);
    } catch {
      return undefined;
    }
  }

  private async exportDocument(m: Extract<FromViewer, { type: 'exportHtml' }>): Promise<void> {
    const { ctx } = this.opts;
    const isLocal = (src: string) => !!this.localFile(src);
    const map = new Map<string, string>();
    const clean = sanitizeExportHtml(m.html);
    const preface = m.preface ? sanitizeExportHtml(m.preface) : '';
    const base = this.baseDir();
    for (const src of imageSources(clean)) {
      const file = this.localFile(src);
      if (!file) {
        continue;
      }
      if (m.target === 'clipboard') {
        // Pasted elsewhere, a webview URL means nothing; a path next to the document does.
        map.set(src, base ? path.relative(base, file.fsPath).split(path.sep).join('/') : file.fsPath);
        continue;
      }
      const size = await vscode.workspace.fs.stat(file).then((st) => st.size, () => undefined);
      map.set(src, await exportImageSrc(file.fsPath, size, async () => vscode.workspace.fs.readFile(file)));
    }
    const article = rewriteImageSources(clean, map, isLocal);
    if (m.target === 'clipboard') {
      await vscode.env.clipboard.writeText(article);
      this.post({ type: 'toast', text: 'HTML copied' });
      return;
    }
    const read = async (...p: string[]) => Buffer.from(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(ctx.extensionUri, ...p)));
    let katexCss: string | undefined;
    if (/class="[^"]*\bkatex\b/.test(article)) {
      try {
        const fonts = new Map<string, string>();
        const css = (await read('dist', 'webview', 'katex', 'katex.min.css')).toString('utf8');
        for (const name of new Set([...css.matchAll(/fonts\/([\w-]+\.woff2)/g)].map((x) => x[1]))) {
          fonts.set(name, (await read('dist', 'webview', 'katex', 'fonts', name).catch(() => Buffer.alloc(0))).toString('base64'));
        }
        katexCss = inlineKatexFonts(css, (n) => fonts.get(n) || undefined);
      } catch (e) {
        this.opts.log.warn(`markdown export: KaTeX styles unavailable: ${String(e)}`);
      }
    }
    const s = this.source;
    const doc = buildExportDocument({
      title: s?.kind === 'file' ? path.basename(s.uri.fsPath) : (s?.title ?? 'Document'),
      article,
      preface,
      css: (await read('media', 'mdview.css')).toString('utf8'),
      katexCss,
      theme: getConfig().markdownViewer.exportTheme,
      vars: m.vars,
      themeClass: m.themeClass,
      prefs: this.prefs(),
    });
    return m.target === 'pdf' ? this.exportPdf(doc) : this.exportHtml(doc);
  }

  private defaultExportUri(ext: string): vscode.Uri | undefined {
    const dir = this.baseDir();
    return dir ? vscode.Uri.file(path.join(dir, `${this.exportName()}.${ext}`)) : undefined;
  }

  private async exportHtml(doc: string): Promise<void> {
    const target = await vscode.window.showSaveDialog({ defaultUri: this.defaultExportUri('html'), filters: { HTML: ['html', 'htm'] }, saveLabel: 'Export HTML' });
    if (!target) {
      return;
    }
    await vscode.workspace.fs.writeFile(target, Buffer.from(doc, 'utf8'));
    const pick = await vscode.window.showInformationMessage(`Exported ${vscode.workspace.asRelativePath(target)}`, 'Open in Browser');
    if (pick) {
      await vscode.env.openExternal(target);
    }
  }

  /** Prints the self-contained page to PDF with a headless Chromium; offers HTML when there is no browser. */
  private async exportPdf(doc: string): Promise<void> {
    const browser = await findHeadlessBrowser();
    if (!browser) {
      const pick = await vscode.window.showWarningMessage('No Chromium-based browser found to print the PDF. Install Chrome, Chromium, Edge or Brave, or set its path.', 'Export HTML instead', 'Set browser path');
      if (pick === 'Export HTML instead') {
        return this.exportHtml(doc);
      }
      if (pick === 'Set browser path') {
        await vscode.commands.executeCommand('workbench.action.openSettings', 'localpilot.browser.chromePath');
      }
      return;
    }
    const target = await vscode.window.showSaveDialog({ defaultUri: this.defaultExportUri('pdf'), filters: { PDF: ['pdf'] }, saveLabel: 'Export PDF' });
    if (!target) {
      return;
    }
    const rand = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const tmp = path.join(os.tmpdir(), `lp-md-${rand}.html`);
    const profile = path.join(os.tmpdir(), `lp-md-profile-${rand}`);
    try {
      await fsp.writeFile(tmp, doc, 'utf8');
      // The save dialog already confirmed overwriting; a stale file must not pass for a fresh print.
      await fsp.rm(target.fsPath, { force: true });
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Exporting PDF…', cancellable: true }, (_p, token) => printPdf(browser, printToPdfArgs(pathToFileURL(tmp).href, target.fsPath, profile), target.fsPath, token));
    } finally {
      await fsp.rm(tmp, { force: true }).catch(() => undefined);
      await fsp.rm(profile, { recursive: true, force: true }).catch(() => undefined);
    }
    const pick = await vscode.window.showInformationMessage(`Exported ${vscode.workspace.asRelativePath(target)}`, 'Open');
    if (pick) {
      await openPdf(target);
    }
  }

  private async saveMarkdown(): Promise<void> {
    const s = this.source;
    if (!s) {
      return;
    }
    const root = vscode.workspace.workspaceFolders?.[0]?.uri;
    const name = s.kind === 'file' ? path.basename(s.uri.fsPath) : `${slugName(s.title) || 'document'}.md`;
    const target = await vscode.window.showSaveDialog({ defaultUri: root ? vscode.Uri.joinPath(root, 'docs', name) : undefined, filters: { Markdown: ['md'] }, saveLabel: 'Save Markdown' });
    if (!target) {
      return;
    }
    await vscode.workspace.fs.writeFile(target, Buffer.from(await this.currentText(), 'utf8'));
    this.post({ type: 'toast', text: `Saved ${vscode.workspace.asRelativePath(target)}` });
    await this.opts.openMarkdown(target);
  }

  private async saveSvg(svg: string, name?: string): Promise<void> {
    if (!/^\s*<svg[\s>]/i.test(svg)) {
      return;
    }
    const dir = this.baseDir();
    const file = `${slugName(name ?? '') || 'diagram'}.svg`;
    const target = await vscode.window.showSaveDialog({ defaultUri: dir ? vscode.Uri.file(path.join(dir, file)) : undefined, filters: { SVG: ['svg'] }, saveLabel: 'Save SVG' });
    if (!target) {
      return;
    }
    await vscode.workspace.fs.writeFile(target, Buffer.from(svg, 'utf8'));
    this.post({ type: 'toast', text: `Saved ${vscode.workspace.asRelativePath(target)}` });
  }

  private async openPath(m: Extract<FromViewer, { type: 'openPath' }>): Promise<void> {
    const base = this.baseDir();
    const abs = path.isAbsolute(m.path) ? m.path : base ? path.join(base, m.path) : undefined;
    if (!abs) {
      return;
    }
    const uri = vscode.Uri.file(abs);
    const s = this.source;
    if (/\.(md|markdown)$/i.test(abs)) {
      if (s?.kind === 'file' && s.uri.fsPath === uri.fsPath) {
        if (m.anchor) {
          this.scrollToAnchor(m.anchor);
        }
        return;
      }
      return this.opts.openMarkdown(uri, m.anchor);
    }
    if (isPdfPath(abs)) {
      return openPdf(uri, m.page ?? m.line);
    }
    try {
      const ed = await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri), { preview: true, viewColumn: this.opts.isCustomEditor ? vscode.ViewColumn.Beside : vscode.ViewColumn.One });
      if (m.line) {
        const start = new vscode.Position(Math.max(0, m.line - 1), 0);
        const end = m.endLine && m.endLine >= m.line ? new vscode.Position(Math.min(ed.document.lineCount - 1, m.endLine - 1), Number.MAX_SAFE_INTEGER) : start;
        ed.selection = new vscode.Selection(start, ed.document.validatePosition(end));
        ed.revealRange(new vscode.Range(start, end), vscode.TextEditorRevealType.InCenter);
      }
    } catch {
      this.post({ type: 'toast', level: 'error', text: `Cannot open ${m.path}` });
    }
  }

  private html(): string {
    const { webview, ctx } = this.opts;
    const media = (f: string) => webview.asWebviewUri(vscode.Uri.joinPath(ctx.extensionUri, 'media', f));
    const dist = (f: string) => webview.asWebviewUri(vscode.Uri.joinPath(ctx.extensionUri, 'dist', 'webview', f));
    const nonce = Array.from({ length: 24 }, () => 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'[Math.floor(Math.random() * 62)]).join('');
    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src ${webview.cspSource} https: data:; font-src ${webview.cspSource};" />
<link rel="stylesheet" href="${dist('katex/katex.min.css')}" />
<link rel="stylesheet" href="${media('mdview.css')}" />
<title>LocalPilot Markdown</title>
</head>
<body>
<header id="bar" class="bar">
  <div class="meta"><b id="title">Document</b><span id="subtitle"></span></div>
  <span class="spacer"></span>
  <button id="toc" class="ib" title="Outline (o)" aria-label="Outline" aria-pressed="false"><svg viewBox="0 0 16 16"><path d="M3 4h10M3 8h7M3 12h9"/></svg></button>
  <button id="find" class="ib" title="Find (Ctrl+F)" aria-label="Find in document"><svg viewBox="0 0 16 16"><circle cx="7" cy="7" r="4"/><path d="m10 10 3.5 3.5"/></svg></button>
  <button id="wrap" class="ib" title="Wrap long code lines (w)" aria-label="Wrap long code lines" aria-pressed="false"><svg viewBox="0 0 16 16"><path d="M2.5 4h11M2.5 8h9a2 2 0 0 1 0 4H8m1.5-1.5L8 12l1.5 1.5M2.5 12h3"/></svg></button>
  <button id="smaller" class="ib" title="Smaller text (−)" aria-label="Smaller text"><svg viewBox="0 0 16 16"><path d="M3 11.5 7 4l4 7.5M4.6 9h4.8M12 6.5h2.5"/></svg></button>
  <button id="larger" class="ib" title="Larger text (+)" aria-label="Larger text"><svg viewBox="0 0 16 16"><path d="M2.5 11.5 6.5 4l4 7.5M4.1 9h4.8M12.5 5.5v3M11 7h3"/></svg></button>
  <button id="copy" class="ib wide-only" title="Copy Markdown" aria-label="Copy Markdown"><svg viewBox="0 0 16 16"><rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/><path d="M10.5 5.5v-2a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2"/></svg></button>
  <button id="save" class="ib wide-only" title="Save as…"><svg viewBox="0 0 16 16"><path d="M8 2.5v8M4.5 7 8 10.5 11.5 7M3 13h10"/></svg></button>
  <button id="open" class="ib wide-only" title="Open in editor"><svg viewBox="0 0 16 16"><path d="M9 3h4v4M13 3 7.5 8.5M11 9.5V12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h2.5"/></svg></button>
  <button id="ask" class="ask hidden" title="Ask LocalPilot about this document" aria-label="Ask LocalPilot about this document"><svg viewBox="0 0 16 16"><path d="M2.5 4a1.5 1.5 0 0 1 1.5-1.5h8A1.5 1.5 0 0 1 13.5 4v5A1.5 1.5 0 0 1 12 10.5H7L4 13v-2.5a1.5 1.5 0 0 1-1.5-1.5Z"/></svg><span>Ask</span></button>
  <button id="prefs" class="ib txt" title="Reading settings (a)" aria-label="Reading settings" aria-haspopup="true" aria-expanded="false">Aa</button>
  <button id="more" class="ib" title="More actions" aria-label="More actions" aria-haspopup="true" aria-expanded="false"><svg viewBox="0 0 16 16"><path d="M3.5 8h.01M8 8h.01M12.5 8h.01" stroke-width="2.4"/></svg></button>
</header>
<div id="prefs-pop" class="pop hidden" role="dialog" aria-label="Reading settings">
  <div class="row"><span id="pl-width">Width</span><div class="seg" data-key="width" role="group" aria-labelledby="pl-width"><button data-v="narrow">Narrow</button><button data-v="normal">Normal</button><button data-v="wide">Wide</button><button data-v="full">Full</button></div></div>
  <div class="row"><span id="pl-font">Font</span><div class="seg" data-key="font" role="group" aria-labelledby="pl-font"><button data-v="sans">Sans</button><button data-v="serif">Serif</button><button data-v="editor">Editor</button></div></div>
  <div class="row"><span id="pl-lh">Line height</span><div class="seg" data-key="lineHeight" role="group" aria-labelledby="pl-lh"><button data-v="1.5">Tight</button><button data-v="1.65">Normal</button><button data-v="1.8">Loose</button></div></div>
  <div class="row"><span id="pl-size">Text size</span><div class="seg" role="group" aria-labelledby="pl-size"><button data-size="-1" title="Smaller text" aria-label="Smaller text">−</button><output id="size-val" aria-live="polite" aria-label="Text size">15</output><button data-size="1" title="Larger text" aria-label="Larger text">+</button></div></div>
  <div class="row reset"><button id="prefs-reset" class="linkish" data-reset="1" title="Width, font, line height and text size back to their defaults">Reset to defaults</button></div>
</div>
<div id="more-pop" class="pop menu hidden" role="menu">
  <button role="menuitem" class="narrow-only" data-act="copy">Copy Markdown</button>
  <button role="menuitem" class="narrow-only" data-act="save">Save as…</button>
  <button role="menuitem" class="narrow-only" data-act="open">Open in editor</button>
  <button role="menuitemcheckbox" class="narrow-only" data-act="wrap" aria-checked="false">Wrap long code lines</button>
  <hr class="narrow-only" />
  <button role="menuitem" data-act="html">Export HTML…</button>
  <button role="menuitem" data-act="pdf">Export PDF…</button>
  <button role="menuitem" data-act="clipboard">Copy HTML</button>
  <hr />
  <button role="menuitem" id="more-settings" data-act="settings">Viewer settings…</button>
</div>
<button id="ask-sel" class="ask-sel hidden" title="Ask LocalPilot (Ctrl+')" aria-keyshortcuts="Control+'">Ask LocalPilot</button>
<div id="ask-live" class="sr-only" aria-live="polite"></div>
<div id="layout" class="layout">
  <nav id="outline" class="outline hidden" aria-label="Outline"><input id="filter" class="filter hidden" type="search" placeholder="Filter headings (/)" aria-label="Filter headings" /><div id="outline-list"></div></nav>
  <main id="doc" class="doc" aria-live="polite"><div class="loading">Rendering…</div></main>
</div>
<div id="toasts"></div>
<script nonce="${nonce}" src="${media('mdview.js')}"></script>
</body>
</html>`;
  }

  dispose(): void {
    MarkdownViewSession.all.delete(this);
    if (!MarkdownViewSession.all.size) {
      MarkdownViewSession.configSub?.dispose();
      MarkdownViewSession.configSub = undefined;
    }
    this.disposed = true;
    this.unwatch();
    clearTimeout(this.syncTimer);
    this.subs.forEach((d) => d.dispose());
  }
}

/** Runs the headless print and resolves once the PDF exists; 60 s at most. */
function printPdf(browser: string, args: string[], target: string, token: vscode.CancellationToken): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const child = cp.spawn(browser, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('Timed out printing the PDF after 60 s'));
    }, 60_000);
    const sub = token.onCancellationRequested(() => {
      child.kill('SIGKILL');
      reject(new Error('PDF export cancelled'));
    });
    child.stderr?.on('data', (d) => (err = (err + String(d)).slice(-4000)));
    child.on('error', (e) => {
      clearTimeout(timer);
      sub.dispose();
      reject(e);
    });
    child.on('close', () => {
      clearTimeout(timer);
      sub.dispose();
      fsp.stat(target).then(
        (st) => (st.size > 0 ? resolve() : reject(new Error('The browser wrote an empty PDF'))),
        () => {
          const line = err.split('\n').find((l) => /ERR_|error|failed/i.test(l) && !/task_policy|GPU|dbus|Fontconfig/i.test(l)) ?? '';
          reject(new Error(`The browser did not produce a PDF${line ? `: ${line.replace(/^\[[^\]]*\]\s*/, '').trim()}` : ''}`));
        }
      );
    });
  });
}

function slugName(s: string): string {
  return s.replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
}
