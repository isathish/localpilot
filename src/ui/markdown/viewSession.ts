import * as path from 'path';
import * as vscode from 'vscode';
import { getConfig } from '../../config';
import { parseLinkTarget, renderMarkdown } from './render';

export type Source = { kind: 'file'; uri: vscode.Uri } | { kind: 'text'; title: string; text: string };

type FromViewer =
  | { type: 'ready' }
  | { type: 'reload' }
  | { type: 'clientError'; where: string; message: string; stack?: string }
  | { type: 'openEditor' }
  | { type: 'saveAs'; svg?: string; name?: string }
  | { type: 'copy' }
  | { type: 'openLink'; href: string }
  | { type: 'openPath'; path: string; line?: number; endLine?: number; anchor?: string; page?: number }
  | { type: 'fontSize'; delta: number }
  | { type: 'revealLine'; line: number }
  | { type: 'openSourceAt'; line: number };

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
  | { type: 'scrollToAnchor'; anchor: string };

export interface ViewSessionOptions {
  webview: vscode.Webview;
  ctx: vscode.ExtensionContext;
  log: vscode.LogOutputChannel;
  isCustomEditor: boolean;
  /** Called with the document title after each render (the reader panel shows it as its tab title). */
  onTitle?: (title: string) => void;
  /** Opens another Markdown file in the reader, scrolled to a heading when `anchor` is given. */
  openMarkdown: (uri: vscode.Uri, anchor?: string) => Promise<void>;
}

export const FONT_KEY = 'localpilot.mdViewer.fontSize';
const MAX_TEXT = 100_000;
const MAX_SVG = 20 * 1024 * 1024;

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
      return { type: m.type };
    case 'clientError':
      return { type: 'clientError', where: str(m.where, 200) ?? '?', message: str(m.message, 4000) ?? '?', stack: str(m.stack, 8000) };
    case 'saveAs':
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
  }
  return undefined;
}

/**
 * One reader webview bound to one Markdown source: used by the reader panel (`MarkdownViewer`) and by the
 * "Open With… → LocalPilot Markdown Reader" custom editor. Renders, live-reloads, routes links and keeps the
 * view and the source editor scrolled together.
 */
export class MarkdownViewSession implements vscode.Disposable {
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

  constructor(private readonly opts: ViewSessionOptions) {
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
    await this.render();
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
      this.reloadTimer = setTimeout(() => void this.render(), 200);
    };
    const fsw = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(path.dirname(uri.fsPath)), path.basename(uri.fsPath)));
    this.watchers.push(
      fsw,
      fsw.onDidChange(schedule),
      fsw.onDidCreate(schedule),
      vscode.workspace.onDidChangeTextDocument((e) => same(e.document.uri) && e.contentChanges.length > 0 && schedule())
    );
  }

  private unwatch(): void {
    clearTimeout(this.reloadTimer);
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
      fontSize: ctx.globalState.get<number>(FONT_KEY, 15),
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
      case 'reload':
        return this.render();
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
      case 'openLink': {
        const t = parseLinkTarget(m.href);
        if (t?.kind === 'external') {
          await vscode.env.openExternal(vscode.Uri.parse(t.href));
        }
        return;
      }
      case 'openPath':
        return this.openPath(m);
      case 'fontSize': {
        const { ctx } = this.opts;
        const next = Math.min(24, Math.max(11, ctx.globalState.get<number>(FONT_KEY, 15) + m.delta));
        await ctx.globalState.update(FONT_KEY, next);
        return this.render();
      }
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
    if (/\.pdf$/i.test(abs)) {
      const page = m.page ?? m.line;
      const pdfViewer = (this.opts.ctx.extension.packageJSON?.contributes?.customEditors ?? []).some((e: { viewType?: string }) => e.viewType === 'localpilot.pdfViewer');
      if (pdfViewer) {
        await vscode.commands.executeCommand('vscode.openWith', page ? uri.with({ fragment: `page=${page}` }) : uri, 'localpilot.pdfViewer');
      } else {
        await vscode.env.openExternal(uri);
      }
      return;
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
  <button id="toc" class="ib" title="Outline (o)" aria-pressed="false"><svg viewBox="0 0 16 16"><path d="M3 4h10M3 8h7M3 12h9"/></svg></button>
  <button id="wrap" class="ib" title="Wrap long code lines (w)" aria-pressed="false"><svg viewBox="0 0 16 16"><path d="M2.5 4h11M2.5 8h9a2 2 0 0 1 0 4H8m1.5-1.5L8 12l1.5 1.5M2.5 12h3"/></svg></button>
  <button id="smaller" class="ib" title="Smaller text (−)"><svg viewBox="0 0 16 16"><path d="M3 11.5 7 4l4 7.5M4.6 9h4.8M12 6.5h2.5"/></svg></button>
  <button id="larger" class="ib" title="Larger text (+)"><svg viewBox="0 0 16 16"><path d="M2.5 11.5 6.5 4l4 7.5M4.1 9h4.8M12.5 5.5v3M11 7h3"/></svg></button>
  <button id="copy" class="ib" title="Copy Markdown"><svg viewBox="0 0 16 16"><rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/><path d="M10.5 5.5v-2a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2"/></svg></button>
  <button id="save" class="ib" title="Save as…"><svg viewBox="0 0 16 16"><path d="M8 2.5v8M4.5 7 8 10.5 11.5 7M3 13h10"/></svg></button>
  <button id="open" class="ib" title="Open in editor"><svg viewBox="0 0 16 16"><path d="M9 3h4v4M13 3 7.5 8.5M11 9.5V12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h2.5"/></svg></button>
</header>
<div id="layout" class="layout">
  <nav id="outline" class="outline hidden" aria-label="Outline"><input id="filter" class="filter hidden" type="search" placeholder="Filter headings" aria-label="Filter headings" /><div id="outline-list"></div></nav>
  <main id="doc" class="doc" aria-live="polite"><div class="loading">Rendering…</div></main>
</div>
<div id="toasts"></div>
<script nonce="${nonce}" src="${media('mdview.js')}"></script>
</body>
</html>`;
  }

  dispose(): void {
    this.disposed = true;
    this.unwatch();
    clearTimeout(this.syncTimer);
    this.subs.forEach((d) => d.dispose());
  }
}

function slugName(s: string): string {
  return s.replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
}
