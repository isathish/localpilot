import * as path from 'path';
import * as vscode from 'vscode';
import { resolveWorkspacePath } from '../tools/fs';
import { Tool } from '../types';
import { MarkdownViewSession, ReaderChat, Source } from './markdown/viewSession';

/** Test hooks. */
export const __test = { serializerRegistered: false };

/**
 * A dedicated, distraction-free reader for Markdown: assistant answers, specs and plans the agent writes,
 * memory notes, skills, any .md in the workspace. One panel, reused, so the agent always has a place to show a
 * document; the rendering, live reload and scroll sync live in `MarkdownViewSession`, shared with the
 * "Open With… → LocalPilot Markdown Reader" custom editor.
 */
export class MarkdownViewer implements vscode.Disposable {
  static readonly viewType = 'localpilot.markdown';
  private static instance?: MarkdownViewer;
  /** A panel restored by the serializer before the viewer existed. */
  private static restored?: { panel: vscode.WebviewPanel; uri: vscode.Uri };
  private panel?: vscode.WebviewPanel;
  private session?: MarkdownViewSession;
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;

  constructor(
    private readonly ctx: vscode.ExtensionContext,
    private readonly log: vscode.LogOutputChannel,
    private readonly chat?: ReaderChat
  ) {
    MarkdownViewer.instance = this;
    const r = MarkdownViewer.restored;
    MarkdownViewer.restored = undefined;
    if (r) {
      void this.adopt(r.panel, r.uri);
    }
  }

  /**
   * Brings the reader panel back after a window reload. Only file sources are restored; a panel that showed chat
   * text has nothing to come back to and is closed. Register it synchronously during activation.
   */
  static registerSerializer(_ctx: vscode.ExtensionContext): vscode.Disposable {
    __test.serializerRegistered = true;
    return vscode.window.registerWebviewPanelSerializer(MarkdownViewer.viewType, {
      async deserializeWebviewPanel(panel: vscode.WebviewPanel, state: unknown) {
        const src = (state as { source?: { kind?: string; uri?: string } } | undefined)?.source;
        if (src?.kind !== 'file' || typeof src.uri !== 'string') {
          panel.dispose();
          return;
        }
        const uri = vscode.Uri.parse(src.uri);
        if (MarkdownViewer.instance && !MarkdownViewer.instance.panel) {
          await MarkdownViewer.instance.adopt(panel, uri);
        } else if (MarkdownViewer.instance) {
          panel.dispose();
        } else {
          MarkdownViewer.restored = { panel, uri };
        }
      },
    });
  }

  get isOpen(): boolean {
    return !!this.panel;
  }

  /** Shows a Markdown string (an assistant reply, a generated plan…). */
  async showText(text: string, title = 'Document', column: vscode.ViewColumn = vscode.ViewColumn.Beside): Promise<void> {
    const session = this.ensurePanel(title, column);
    await session.setSource({ kind: 'text', title, text });
  }

  /** Shows a Markdown file and keeps it in sync while it changes on disk or in an editor; `anchor` scrolls to a heading. */
  async showFile(uri: vscode.Uri, column: vscode.ViewColumn = vscode.ViewColumn.Beside, anchor?: string): Promise<void> {
    const session = this.ensurePanel(path.basename(uri.fsPath), column);
    await session.setSource({ kind: 'file', uri }, anchor);
  }

  /** The source the reader shows, if it is open. */
  get current(): Source | undefined {
    return this.session?.source;
  }

  private ensurePanel(title: string, column: vscode.ViewColumn): MarkdownViewSession {
    if (this.panel && this.session) {
      this.panel.title = title;
      this.panel.reveal(undefined, true);
      return this.session;
    }
    const panel = vscode.window.createWebviewPanel(MarkdownViewer.viewType, title, { viewColumn: column, preserveFocus: true }, { enableScripts: true, retainContextWhenHidden: true, enableFindWidget: true });
    return this.attach(panel);
  }

  private async adopt(panel: vscode.WebviewPanel, uri: vscode.Uri): Promise<void> {
    const session = this.attach(panel);
    await session.setSource({ kind: 'file', uri });
  }

  private attach(panel: vscode.WebviewPanel): MarkdownViewSession {
    panel.iconPath = vscode.Uri.joinPath(this.ctx.extensionUri, 'media', 'icon.svg');
    const session = new MarkdownViewSession({
      webview: panel.webview,
      ctx: this.ctx,
      log: this.log,
      isCustomEditor: false,
      panel,
      chat: this.chat,
      onTitle: (t) => (panel.title = t),
      openMarkdown: (uri, anchor) => this.showFile(uri, panel.viewColumn ?? vscode.ViewColumn.Beside, anchor),
    });
    panel.onDidDispose(() => {
      session.dispose();
      if (this.panel === panel) {
        this.panel = undefined;
        this.session = undefined;
      }
      this._onDidChange.fire();
    });
    this.panel = panel;
    this.session = session;
    this._onDidChange.fire();
    return session;
  }

  dispose(): void {
    this.session?.dispose();
    this.panel?.dispose();
    this._onDidChange.dispose();
    if (MarkdownViewer.instance === this) {
      MarkdownViewer.instance = undefined;
    }
  }
}

/** Lets the agent present a document (a spec, plan, report or any .md file) in the reader instead of a raw dump in chat. */
export function createShowMarkdownTool(viewer: MarkdownViewer): Tool {
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
    async execute(args, ctx) {
      const p = typeof args.path === 'string' ? args.path.trim() : '';
      if (p) {
        let uri: vscode.Uri;
        try {
          // The session's worktree when it runs isolated, else the workspace folder.
          uri = resolveWorkspacePath(p, ctx);
        } catch (e) {
          return { content: e instanceof Error ? e.message : String(e), isError: true };
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
