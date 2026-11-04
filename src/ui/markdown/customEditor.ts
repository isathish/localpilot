import * as vscode from 'vscode';
import { MarkdownViewSession } from './viewSession';

/**
 * "Open With… → LocalPilot Markdown Reader": one reader per editor tab, each bound to its own document, so two files
 * can be read side by side. Not the default for .md (priority `option`); the reader panel stays the agent's surface.
 */
export class MarkdownCustomEditor implements vscode.CustomTextEditorProvider {
  static readonly viewType = 'localpilot.markdownEditor';
  /** Open readers by document URI, so a link to an already-open file just scrolls it. */
  private readonly sessions = new Map<string, Set<MarkdownViewSession>>();
  /** A heading to scroll to once the editor for that URI resolves. */
  private readonly pendingAnchors = new Map<string, string>();

  private constructor(
    private readonly ctx: vscode.ExtensionContext,
    private readonly log: vscode.LogOutputChannel
  ) {}

  /** Register synchronously during activation so editors restored at startup resolve. */
  static register(ctx: vscode.ExtensionContext, log: vscode.LogOutputChannel): vscode.Disposable {
    return vscode.window.registerCustomEditorProvider(MarkdownCustomEditor.viewType, new MarkdownCustomEditor(ctx, log), {
      webviewOptions: { retainContextWhenHidden: true, enableFindWidget: true },
      supportsMultipleEditorsPerDocument: true,
    });
  }

  async resolveCustomTextEditor(document: vscode.TextDocument, panel: vscode.WebviewPanel): Promise<void> {
    const key = document.uri.toString();
    panel.iconPath = vscode.Uri.joinPath(this.ctx.extensionUri, 'media', 'icon.svg');
    const session = new MarkdownViewSession({
      webview: panel.webview,
      ctx: this.ctx,
      log: this.log,
      isCustomEditor: true,
      openMarkdown: (uri, anchor) => this.open(uri, anchor),
    });
    const set = this.sessions.get(key) ?? new Set();
    set.add(session);
    this.sessions.set(key, set);
    panel.onDidDispose(() => {
      session.dispose();
      set.delete(session);
      if (!set.size) {
        this.sessions.delete(key);
      }
    });
    const anchor = this.pendingAnchors.get(key);
    this.pendingAnchors.delete(key);
    await session.setSource({ kind: 'file', uri: document.uri }, anchor);
  }

  private async open(uri: vscode.Uri, anchor?: string): Promise<void> {
    const key = uri.toString();
    const open = this.sessions.get(key);
    if (anchor && !open?.size) {
      this.pendingAnchors.set(key, anchor);
    }
    await vscode.commands.executeCommand('vscode.openWith', uri, MarkdownCustomEditor.viewType);
    if (anchor && open?.size) {
      open.forEach((s) => s.scrollToAnchor(anchor));
    }
  }
}
