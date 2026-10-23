import * as vscode from 'vscode';
import { ChatController, FromWebview, ToWebview } from './chatController';

/** Where the chat lives; mirrors the `localpilot.chat.location` setting. */
export type ChatLocation = 'sidebar' | 'secondarySidebar' | 'panel' | 'editor';

/** View container ids (as VS Code registers them) that host the LocalPilot views in each location. */
const CONTAINER_FOR: Record<Exclude<ChatLocation, 'editor'>, string> = {
  sidebar: 'workbench.view.extension.localpilot',
  secondarySidebar: 'workbench.view.extension.localpilot-secondary',
  panel: 'workbench.view.extension.localpilot-panel',
};

export const CHAT_LOCATIONS: { id: ChatLocation; label: string; detail: string; icon: string }[] = [
  { id: 'sidebar', label: 'Primary Side Bar', detail: 'Left, with the Explorer — under the LocalPilot activity bar icon', icon: 'layout-sidebar-left' },
  { id: 'secondarySidebar', label: 'Secondary Side Bar', detail: 'Right, where Copilot Chat lives — keeps the Explorer visible', icon: 'layout-sidebar-right' },
  { id: 'panel', label: 'Panel', detail: 'Bottom, next to the Terminal and Problems', icon: 'layout-panel' },
  { id: 'editor', label: 'Editor Area', detail: 'A tab in the main area, like a file — most room for long answers', icon: 'layout-centered' },
];

export function getChatLocation(): ChatLocation {
  return vscode.workspace.getConfiguration('localpilot').get<ChatLocation>('chat.location', 'sidebar');
}

/** Hosts the chat UI in the sidebar view and (optionally) in editor tabs. All hosts share one controller. */
export class ChatViewProvider implements vscode.WebviewViewProvider {
  static readonly viewId = 'localpilot.chatView';
  static readonly panelViewType = 'localpilot.chatPanel';
  private view?: vscode.WebviewView;
  private panels = new Set<vscode.WebviewPanel>();

  constructor(private readonly ctx: vscode.ExtensionContext, private readonly controller: ChatController) {
    controller.onDidChangeActive((s) => {
      if (this.view) {
        this.view.description = s?.title && s.title !== 'New chat' ? s.title : undefined;
      }
      for (const p of this.panels) {
        p.title = s?.title ? `LocalPilot · ${s.title}` : 'LocalPilot Chat';
      }
    });
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    this.wire(view.webview, () => (this.view = undefined), view);
    view.onDidChangeVisibility(() => {
      if (view.visible) {
        void view.webview.postMessage({ type: 'focusInput' } satisfies ToWebview);
      }
    });
  }

  /** Shows the chat as an editor tab; reuses the open tab instead of stacking duplicates. */
  openInEditor(column: vscode.ViewColumn = vscode.ViewColumn.Beside): void {
    const existing = this.panels.values().next().value as vscode.WebviewPanel | undefined;
    if (existing) {
      existing.reveal(undefined, false);
      void existing.webview.postMessage({ type: 'focusInput' } satisfies ToWebview);
      return;
    }
    const panel = vscode.window.createWebviewPanel(ChatViewProvider.panelViewType, 'LocalPilot Chat', column, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(this.ctx.extensionUri, 'media')],
    });
    panel.iconPath = vscode.Uri.joinPath(this.ctx.extensionUri, 'media', 'icon.svg');
    this.panels.add(panel);
    this.wire(panel.webview, () => this.panels.delete(panel), panel);
  }

  /** Opens the chat wherever the user keeps it: the editor tab when `chat.location` is `editor`, otherwise the view. */
  reveal(): void {
    if (getChatLocation() === 'editor') {
      this.openInEditor(vscode.ViewColumn.Active);
      return;
    }
    if (this.view) {
      this.view.show(true);
    } else {
      void vscode.commands.executeCommand(`${ChatViewProvider.viewId}.focus`);
    }
  }

  /**
   * Moves the LocalPilot views to the container for `loc` and opens the chat there. Uses the same
   * `vscode.moveViews` command Copilot Chat uses; the empty containers left behind hide themselves.
   */
  async applyLocation(loc: ChatLocation): Promise<void> {
    if (loc === 'editor') {
      this.openInEditor(vscode.ViewColumn.Active);
      return;
    }
    try {
      await vscode.commands.executeCommand('vscode.moveViews', { viewIds: [ChatViewProvider.viewId, 'localpilot.agentsView'], destinationId: CONTAINER_FOR[loc] });
    } catch {
      // Older VS Code without the command: the view stays put and the user can still drag it.
    }
    await vscode.commands.executeCommand(`${ChatViewProvider.viewId}.focus`);
  }

  /** Quick pick that updates `localpilot.chat.location` and moves the chat right away. */
  async pickLocation(): Promise<void> {
    const current = getChatLocation();
    const pick = await vscode.window.showQuickPick(
      CHAT_LOCATIONS.map((l) => ({ label: `$(${l.icon}) ${l.label}`, description: l.id === current ? 'current' : undefined, detail: l.detail, id: l.id })),
      { title: 'Move LocalPilot Chat To…', placeHolder: 'Where should the chat live? You can also drag the view anywhere.', matchOnDetail: true }
    );
    if (!pick) {
      return;
    }
    if (pick.id === current) {
      // Nothing to save; still move, so re-picking brings back a view that was dragged elsewhere or closed.
      await this.applyLocation(pick.id);
      return;
    }
    await vscode.workspace.getConfiguration('localpilot').update('chat.location', pick.id, vscode.ConfigurationTarget.Global);
    // The configuration listener in extension.ts moves the views; editor tabs are opened on demand.
    if (pick.id === 'editor') {
      this.openInEditor(vscode.ViewColumn.Active);
    }
  }

  private wire(webview: vscode.Webview, onDispose: () => void, host: { onDidDispose: vscode.Event<void>; visible?: boolean }): void {
    webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.ctx.extensionUri, 'media')] };
    webview.html = this.html(webview);
    const sink = { post: (m: ToWebview) => void webview.postMessage(m), visible: () => host.visible !== false };
    const attach = this.controller.attach(sink);
    const sub = webview.onDidReceiveMessage((m: FromWebview) => {
      if (m.type === 'attachActive' || m.type === 'pickAttachment') {
        return void this.handleAttachment(m, sink);
      }
      void this.controller.handle(m).catch((e) => sink.post({ type: 'toast', level: 'error', text: e instanceof Error ? e.message : String(e) }));
    });
    host.onDidDispose(() => {
      attach.dispose();
      sub.dispose();
      onDispose();
    });
  }

  private async handleAttachment(m: FromWebview, sink: { post: (m: ToWebview) => void }): Promise<void> {
    if (m.type === 'attachActive') {
      const ed = vscode.window.activeTextEditor;
      if (!ed) {
        return sink.post({ type: 'toast', level: 'error', text: 'No active editor' });
      }
      const rel = vscode.workspace.asRelativePath(ed.document.uri);
      const ref = ed.selection.isEmpty ? rel : `${rel}#L${ed.selection.start.line + 1}-L${ed.selection.end.line + 1}`;
      return void sink.post({ type: 'toast', level: 'info', text: `attach:${ref}` });
    }
    if (m.type === 'pickAttachment') {
      const picked = await vscode.window.showOpenDialog({ canSelectMany: true, openLabel: 'Attach', defaultUri: vscode.workspace.workspaceFolders?.[0]?.uri });
      for (const uri of picked ?? []) {
        sink.post({ type: 'toast', level: 'info', text: `attach:${vscode.workspace.asRelativePath(uri)}` });
      }
    }
  }

  private html(webview: vscode.Webview): string {
    const media = (f: string) => webview.asWebviewUri(vscode.Uri.joinPath(this.ctx.extensionUri, 'media', f));
    const nonce = Array.from({ length: 24 }, () => 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'[Math.floor(Math.random() * 62)]).join('');
    const svg = (d: string) => `<svg viewBox="0 0 16 16" aria-hidden="true">${d}</svg>`;
    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src ${webview.cspSource} data: https:; font-src ${webview.cspSource};" />
<link rel="stylesheet" href="${media('chat.css')}" />
<title>LocalPilot</title>
</head>
<body>
<div id="app">
  <div id="boot" class="boot" role="status" aria-label="Loading LocalPilot"><div class="boot-logo"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3h11A2.5 2.5 0 0 1 20 5.5v8a2.5 2.5 0 0 1-2.5 2.5H13l-4.5 4v-4h-2A2.5 2.5 0 0 1 4 13.5z"/><circle cx="9" cy="9.5" r="1.1" fill="currentColor" stroke="none"/><circle cx="15" cy="9.5" r="1.1" fill="currentColor" stroke="none"/><path d="M12 3V1.5"/><circle cx="12" cy="1.2" r=".8" fill="currentColor" stroke="none"/></svg></div><span class="boot-dots"><i></i><i></i><i></i></span></div>
  <div id="progress" class="progress hidden" aria-hidden="true"></div>
  <header id="tabbar" class="tabbar">
    <nav id="tabs" class="tabs" role="tablist" aria-label="Chats"></nav>
    <button id="btnNewTab" class="ib" title="New chat — runs in parallel (⌘⇧↵ sends the draft in a new tab)">${svg('<path d="M8 3v10M3 8h10"/>')}</button>
    <button id="btnHistory" class="ib badge" data-n="0" title="All chats">${svg('<path d="M2.5 8a5.5 5.5 0 1 0 1.6-3.9M2.5 2.5v2.2h2.2M8 5v3l2 1.5"/>')}</button>
  </header>
  <div id="bgruns" class="bgruns hidden" aria-label="Agents running in other tabs"></div>
  <main id="messages" aria-live="polite"></main>
  <div id="approvals"></div>
  <footer id="composer">
    <div id="tasks" class="panel hidden">
      <button id="tasksToggle" class="panel-head"><span class="chev">${svg('<path d="M6 4l4 4-4 4"/>')}</span><span id="tasksLabel">Tasks</span><span class="spacer"></span><span id="tasksMeter" class="meter"><i></i></span></button>
      <ul id="tasksList" class="panel-body"></ul>
    </div>
    <div id="changes" class="panel hidden">
      <div class="panel-head">
        <button id="changesToggle" class="panel-toggle"><span class="chev">${svg('<path d="M6 4l4 4-4 4"/>')}</span><span id="changesLabel">0 files changed</span></button>
        <span class="spacer"></span>
        <button class="btn ghost" data-a="undoAll" title="Reject all changes">${svg('<path d="M3 7h7a3 3 0 0 1 0 6H8M3 7l3-3M3 7l3 3"/>')}<span class="long">Reject all</span></button><button class="btn primary" data-a="keepAll" title="Accept all changes">${svg('<path d="M3 8.5l3 3 7-7"/>')}<span class="long">Accept all</span></button>
      </div>
      <ul id="changesList" class="panel-body hidden"></ul>
    </div>
    <div id="status" class="status hidden"><span class="spinner"></span><span id="statusText" class="text"></span></div>
    <div id="box" class="box">
      <div class="ctx-row">
        <button id="btnAddCtx" class="ctxbtn" title="Add context (@)"><span class="at">@</span><span class="lbl">Add context</span></button>
        <div id="chips" class="chips"></div>
      </div>
      <textarea id="input" rows="1" placeholder="Plan, build, fix anything… (@ context, / commands)" aria-label="Chat input"></textarea>
      <div class="row">
        <button id="modeBtn" class="pick mode" title="Mode"><span id="modeIcon" class="ico"></span><span id="modeLabel" class="lbl">Agent</span><span class="chev">${svg('<path d="M4 6l4 4 4-4"/>')}</span></button>
        <button id="modelBtn" class="pick model" title="Model"><span class="ico">${svg('<path d="M3.5 5A1.5 1.5 0 0 1 5 3.5h6A1.5 1.5 0 0 1 12.5 5v5a1.5 1.5 0 0 1-1.5 1.5H8l-2.5 2v-2H5A1.5 1.5 0 0 1 3.5 10z"/><circle cx="6.5" cy="7.5" r=".8" fill="currentColor"/><circle cx="9.5" cy="7.5" r=".8" fill="currentColor"/>')}</span><span id="modelLabel" class="lbl">Auto</span><span class="chev">${svg('<path d="M4 6l4 4 4-4"/>')}</span></button>
        <span class="spacer"></span>
        <button id="btnImage" class="ib" title="Attach image or take a screenshot (area, window, screen)">${svg('<rect x="2.5" y="3.5" width="11" height="9" rx="1.5"/><circle cx="6" cy="7" r="1.2"/><path d="M13.5 10.5l-3-3-4 4-1.5-1.5-2.5 2.5"/>')}</button>
        <button id="ctxMeter" class="ctx" title="Context usage"><span class="ring"></span><span class="txt">0%</span></button>
        <button id="btnSend" class="send" title="Send (Enter)">${svg('<path d="M8 13V3M3.5 7.5L8 3l4.5 4.5"/>')}</button>
        <button id="btnStop" class="send stop hidden" title="Stop (Esc)">${svg('<rect x="4" y="4" width="8" height="8" rx="1.5" fill="currentColor"/>')}</button>
      </div>
    </div>
  </footer>
  <div id="popover" class="popover hidden" role="menu"></div>
  <div id="toasts"></div>
</div>
<script nonce="${nonce}" src="${media('chat.js')}"></script>
</body>
</html>`;
  }
}
