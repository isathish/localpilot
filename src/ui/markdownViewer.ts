import * as path from 'path';
import * as vscode from 'vscode';
import { Tool } from '../types';

type Source = { kind: 'file'; uri: vscode.Uri } | { kind: 'text'; title: string; text: string };

type FromViewer =
  | { type: 'ready' }
  | { type: 'clientError'; where: string; message: string; stack?: string }
  | { type: 'openEditor' }
  | { type: 'saveAs' }
  | { type: 'reload' }
  | { type: 'copy' }
  | { type: 'openLink'; href: string }
  | { type: 'openPath'; path: string; line?: number }
  | { type: 'fontSize'; delta: number };

type ToViewer =
  | { type: 'content'; html: string; title: string; subtitle: string; markdown: string; isFile: boolean; words: number; fontSize: number }
  | { type: 'toast'; text: string; level?: 'info' | 'error' };

const FONT_KEY = 'localpilot.mdViewer.fontSize';

/**
 * A dedicated, distraction-free reader for Markdown: assistant answers, specs and plans the agent writes,
 * memory notes, skills, any .md in the workspace. Renders through VS Code's own Markdown engine so the result
 * matches the built-in preview, then lays it out as a clean reading column with an outline, copy buttons on
 * code blocks and live reload for files.
 */
export class MarkdownViewer implements vscode.Disposable {
  private panel?: vscode.WebviewPanel;
  private source?: Source;
  private sub: vscode.Disposable[] = [];
  private reloadTimer?: NodeJS.Timeout;
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;

  constructor(
    private readonly ctx: vscode.ExtensionContext,
    private readonly log: vscode.LogOutputChannel
  ) {}

  get isOpen(): boolean {
    return !!this.panel;
  }

  /** Shows a Markdown string (an assistant reply, a generated plan…). */
  async showText(text: string, title = 'Document', column: vscode.ViewColumn = vscode.ViewColumn.Beside): Promise<void> {
    this.source = { kind: 'text', title, text };
    this.ensurePanel(title, column);
    await this.render();
  }

  /** Shows a Markdown file and keeps it in sync while it changes on disk or in an editor. */
  async showFile(uri: vscode.Uri, column: vscode.ViewColumn = vscode.ViewColumn.Beside): Promise<void> {
    this.source = { kind: 'file', uri };
    this.ensurePanel(path.basename(uri.fsPath), column);
    this.watch(uri);
    await this.render();
  }

  private ensurePanel(title: string, column: vscode.ViewColumn): void {
    if (this.panel) {
      this.panel.title = title;
      this.panel.reveal(undefined, true);
      return;
    }
    const roots = [vscode.Uri.joinPath(this.ctx.extensionUri, 'media'), ...(vscode.workspace.workspaceFolders ?? []).map((f) => f.uri)];
    const panel = vscode.window.createWebviewPanel('localpilot.markdown', title, { viewColumn: column, preserveFocus: true }, { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: roots, enableFindWidget: true });
    panel.iconPath = vscode.Uri.joinPath(this.ctx.extensionUri, 'media', 'icon.svg');
    panel.webview.html = this.html(panel.webview);
    panel.webview.onDidReceiveMessage((m: FromViewer) => void this.handle(m).catch((e) => this.post({ type: 'toast', level: 'error', text: e instanceof Error ? e.message : String(e) })));
    panel.onDidDispose(() => {
      this.panel = undefined;
      this.unwatch();
      this._onDidChange.fire();
    });
    this.panel = panel;
    this._onDidChange.fire();
  }

  private post(m: ToViewer): void {
    // Rejects once the panel is disposed (a file change can race the close); nothing to do about it.
    this.panel?.webview.postMessage(m).then(undefined, () => undefined);
  }

  private watch(uri: vscode.Uri): void {
    this.unwatch();
    const same = (u: vscode.Uri) => u.toString() === uri.toString();
    const schedule = () => {
      clearTimeout(this.reloadTimer);
      this.reloadTimer = setTimeout(() => void this.render(), 200);
    };
    const fsw = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(path.dirname(uri.fsPath)), path.basename(uri.fsPath)));
    this.sub.push(
      fsw,
      fsw.onDidChange(schedule),
      fsw.onDidCreate(schedule),
      vscode.workspace.onDidChangeTextDocument((e) => same(e.document.uri) && schedule())
    );
  }

  private unwatch(): void {
    clearTimeout(this.reloadTimer);
    this.sub.forEach((d) => d.dispose());
    this.sub = [];
  }

  private async currentText(): Promise<string> {
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

  private async render(): Promise<void> {
    if (!this.panel || !this.source) {
      return;
    }
    const markdown = await this.currentText();
    let html: string;
    try {
      // VS Code's bundled Markdown engine (markdown-it + highlighting), the same one the built-in preview uses.
      html = (await vscode.commands.executeCommand<string>('markdown.api.render', markdown)) ?? '';
    } catch (e) {
      this.log.warn(`markdown.api.render unavailable, falling back to plain rendering: ${String(e)}`);
      html = `<pre>${markdown.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c] ?? c)}</pre>`;
    }
    html = this.rewriteImages(html);
    const s = this.source;
    const title = s.kind === 'file' ? path.basename(s.uri.fsPath) : s.title;
    const subtitle = s.kind === 'file' ? vscode.workspace.asRelativePath(s.uri) : 'From the chat';
    const words = markdown.split(/\s+/).filter(Boolean).length;
    this.panel.title = title;
    this.post({ type: 'content', html, title, subtitle, markdown, isFile: s.kind === 'file', words, fontSize: this.ctx.globalState.get<number>(FONT_KEY, 15) });
  }

  /** Relative image paths only resolve through webview URIs; links are handled by the webview itself. */
  private rewriteImages(html: string): string {
    const panel = this.panel;
    const s = this.source;
    if (!panel || !s) {
      return html;
    }
    const base = s.kind === 'file' ? path.dirname(s.uri.fsPath) : vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!base) {
      return html;
    }
    return html.replace(/(<img\b[^>]*\ssrc=")([^"]+)(")/g, (m, pre: string, src: string, post: string) => {
      if (/^(https?:|data:|vscode-)/i.test(src)) {
        return m;
      }
      const abs = path.isAbsolute(src) ? src : path.join(base, decodeURI(src.split('#')[0]));
      return `${pre}${panel.webview.asWebviewUri(vscode.Uri.file(abs))}${post}`;
    });
  }

  private async handle(m: FromViewer): Promise<void> {
    const s = this.source;
    switch (m.type) {
      case 'clientError':
        this.log.error(`markdown viewer webview (${m.where}): ${m.message}${m.stack ? `\n${m.stack}` : ''}`);
        return;
      case 'ready':
      case 'reload':
        return this.render();
      case 'openEditor':
        if (s?.kind === 'file') {
          await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(s.uri), { preview: false, viewColumn: vscode.ViewColumn.One });
        } else if (s) {
          const doc = await vscode.workspace.openTextDocument({ language: 'markdown', content: s.text });
          await vscode.window.showTextDocument(doc, { preview: false, viewColumn: vscode.ViewColumn.One });
        }
        return;
      case 'saveAs': {
        if (!s) {
          return;
        }
        const root = vscode.workspace.workspaceFolders?.[0]?.uri;
        const name = (s.kind === 'file' ? path.basename(s.uri.fsPath) : `${s.title.replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'document'}.md`);
        const target = await vscode.window.showSaveDialog({ defaultUri: root ? vscode.Uri.joinPath(root, 'docs', name) : undefined, filters: { Markdown: ['md'] }, saveLabel: 'Save Markdown' });
        if (!target) {
          return;
        }
        await vscode.workspace.fs.writeFile(target, Buffer.from(await this.currentText(), 'utf8'));
        this.post({ type: 'toast', text: `Saved ${vscode.workspace.asRelativePath(target)}` });
        await this.showFile(target, this.panel?.viewColumn ?? vscode.ViewColumn.Beside);
        return;
      }
      case 'copy':
        await vscode.env.clipboard.writeText(await this.currentText());
        this.post({ type: 'toast', text: 'Markdown copied' });
        return;
      case 'openLink':
        if (/^https?:\/\//i.test(m.href) || /^mailto:/i.test(m.href)) {
          await vscode.env.openExternal(vscode.Uri.parse(m.href));
        }
        return;
      case 'openPath': {
        const base = s?.kind === 'file' ? path.dirname(s.uri.fsPath) : vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        const abs = path.isAbsolute(m.path) ? m.path : base ? path.join(base, m.path) : undefined;
        if (!abs) {
          return;
        }
        const uri = vscode.Uri.file(abs);
        if (/\.(md|markdown)$/i.test(abs)) {
          return this.showFile(uri, this.panel?.viewColumn ?? vscode.ViewColumn.Beside);
        }
        try {
          const ed = await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri), { preview: true, viewColumn: vscode.ViewColumn.One });
          if (m.line) {
            const pos = new vscode.Position(Math.max(0, m.line - 1), 0);
            ed.selection = new vscode.Selection(pos, pos);
            ed.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
          }
        } catch {
          this.post({ type: 'toast', level: 'error', text: `Cannot open ${m.path}` });
        }
        return;
      }
      case 'fontSize': {
        const next = Math.min(24, Math.max(11, this.ctx.globalState.get<number>(FONT_KEY, 15) + m.delta));
        await this.ctx.globalState.update(FONT_KEY, next);
        return this.render();
      }
    }
  }

  private html(webview: vscode.Webview): string {
    const media = (f: string) => webview.asWebviewUri(vscode.Uri.joinPath(this.ctx.extensionUri, 'media', f));
    const nonce = Array.from({ length: 24 }, () => 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'[Math.floor(Math.random() * 62)]).join('');
    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src ${webview.cspSource} https: data:; font-src ${webview.cspSource};" />
<link rel="stylesheet" href="${media('mdview.css')}" />
<title>LocalPilot Markdown</title>
</head>
<body>
<header id="bar" class="bar">
  <div class="meta"><b id="title">Document</b><span id="subtitle"></span></div>
  <span class="spacer"></span>
  <button id="toc" class="ib" title="Outline (o)" aria-pressed="false"><svg viewBox="0 0 16 16"><path d="M3 4h10M3 8h7M3 12h9"/></svg></button>
  <button id="smaller" class="ib" title="Smaller text (−)"><svg viewBox="0 0 16 16"><path d="M3 11.5 7 4l4 7.5M4.6 9h4.8M12 6.5h2.5"/></svg></button>
  <button id="larger" class="ib" title="Larger text (+)"><svg viewBox="0 0 16 16"><path d="M2.5 11.5 6.5 4l4 7.5M4.1 9h4.8M12.5 5.5v3M11 7h3"/></svg></button>
  <button id="copy" class="ib" title="Copy Markdown"><svg viewBox="0 0 16 16"><rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/><path d="M10.5 5.5v-2a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2"/></svg></button>
  <button id="save" class="ib" title="Save as…"><svg viewBox="0 0 16 16"><path d="M8 2.5v8M4.5 7 8 10.5 11.5 7M3 13h10"/></svg></button>
  <button id="open" class="ib" title="Open in editor"><svg viewBox="0 0 16 16"><path d="M9 3h4v4M13 3 7.5 8.5M11 9.5V12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h2.5"/></svg></button>
</header>
<div id="layout" class="layout">
  <nav id="outline" class="outline hidden" aria-label="Outline"></nav>
  <main id="doc" class="doc" aria-live="polite"><div class="loading">Rendering…</div></main>
</div>
<div id="toasts"></div>
<script nonce="${nonce}" src="${media('mdview.js')}"></script>
</body>
</html>`;
  }

  dispose(): void {
    this.unwatch();
    this.panel?.dispose();
    this._onDidChange.dispose();
  }
}

/** Lets the agent present a document (a spec, plan, report or any .md file) in the reader instead of a raw dump in chat. */
export function createShowMarkdownTool(viewer: MarkdownViewer, resolve: (p: string) => vscode.Uri | undefined): Tool {
  return {
    parallelSafe: true,
    definition: {
      name: 'show_markdown',
      description: 'Open Markdown in the LocalPilot reader panel for the user — either a file in the workspace (path) or inline content. Use it to present a spec, design doc, plan, report or long explanation you just wrote so the user can read it comfortably; keep your chat reply to a short summary.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Workspace-relative path of a .md file to show' },
          content: { type: 'string', description: 'Markdown to show when there is no file' },
          title: { type: 'string', description: 'Title for inline content' },
        },
      },
    },
    async execute(args) {
      const p = typeof args.path === 'string' ? args.path.trim() : '';
      if (p) {
        const uri = resolve(p);
        if (!uri) {
          return { content: 'No workspace folder is open to resolve the path.', isError: true };
        }
        try {
          await vscode.workspace.fs.stat(uri);
        } catch {
          return { content: `File not found: ${p}`, isError: true };
        }
        await viewer.showFile(uri);
        return { content: `Opened ${p} in the Markdown reader.` };
      }
      const content = typeof args.content === 'string' ? args.content : '';
      if (!content.trim()) {
        return { content: 'Provide either path or content.', isError: true };
      }
      await viewer.showText(content, typeof args.title === 'string' && args.title.trim() ? args.title.trim() : 'Document');
      return { content: 'Opened the document in the Markdown reader.' };
    },
  };
}
