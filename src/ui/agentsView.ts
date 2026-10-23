import * as vscode from 'vscode';
import * as path from 'path';
import { ChatController } from './chatController';
import { SessionSummary } from '../types';

type Node =
  | { kind: 'group'; id: 'running' | 'recent'; label: string }
  | { kind: 'session'; session: SessionSummary; running: boolean }
  | { kind: 'status'; sessionId: string; text: string }
  | { kind: 'file'; sessionId: string; fsPath: string; create: boolean }
  | { kind: 'empty'; label: string };

/**
 * "Agents" panel: every chat session is an independent agent. Running ones appear on top with a live
 * status line; each session lists the files it changed with Diff / Keep / Undo actions.
 */
export class AgentsTreeProvider implements vscode.TreeDataProvider<Node>, vscode.Disposable {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
  private readonly disposables: vscode.Disposable[] = [];
  private timer?: NodeJS.Timeout;

  constructor(private readonly controller: ChatController) {
    const refresh = () => this.scheduleRefresh();
    this.disposables.push(controller.store.onDidChange(refresh), controller.onDidChangeRuns(refresh), controller.tracker.onDidChange(refresh), controller.onDidChangeActive(refresh));
  }

  private scheduleRefresh(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this._onDidChangeTreeData.fire(undefined), 150);
  }

  getTreeItem(n: Node): vscode.TreeItem {
    switch (n.kind) {
      case 'group': {
        const item = new vscode.TreeItem(n.label, vscode.TreeItemCollapsibleState.Expanded);
        item.contextValue = `group-${n.id}`;
        return item;
      }
      case 'session': {
        const s = n.session;
        const files = this.controller.tracker.forSession(s.id).length;
        const item = new vscode.TreeItem(s.title, n.running || files ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed);
        item.id = s.id;
        const model = (s.model || '').split('/').pop();
        item.description = n.running ? `${this.controller.runStatus.get(s.id) ?? 'Working…'}${model ? ` · ${model}` : ''}` : `${s.mode} · ${s.messageCount} msgs${files ? ` · ${files} file${files === 1 ? '' : 's'} changed` : ''}`;
        item.tooltip = `${s.title}\n${s.model || 'default model'} · ${new Date(s.updatedAt).toLocaleString()}`;
        item.iconPath = new vscode.ThemeIcon(n.running ? 'loading~spin' : s.pinned ? 'pinned' : s.mode === 'agent' ? 'localpilot-logo' : s.mode === 'plan' ? 'checklist' : 'comment-discussion');
        item.contextValue = n.running ? 'session-running' : files ? 'session-changed' : 'session';
        item.command = { command: 'localpilot.openSession', title: 'Open', arguments: [s.id] };
        if (this.controller.activeSession?.id === s.id) {
          item.resourceUri = vscode.Uri.parse(`localpilot-active:${s.id}`);
        }
        return item;
      }
      case 'status': {
        const item = new vscode.TreeItem(n.text, vscode.TreeItemCollapsibleState.None);
        item.iconPath = new vscode.ThemeIcon('pulse');
        item.contextValue = 'status';
        return item;
      }
      case 'file': {
        const item = new vscode.TreeItem(path.basename(n.fsPath), vscode.TreeItemCollapsibleState.None);
        item.description = path.dirname(vscode.workspace.asRelativePath(n.fsPath));
        item.resourceUri = vscode.Uri.file(n.fsPath);
        item.iconPath = new vscode.ThemeIcon(n.create ? 'diff-added' : 'diff-modified', new vscode.ThemeColor(n.create ? 'gitDecoration.addedResourceForeground' : 'gitDecoration.modifiedResourceForeground'));
        item.tooltip = `${n.create ? 'Created' : 'Modified'} by agent — click to view diff`;
        item.contextValue = 'file';
        item.command = { command: 'localpilot.showDiff', title: 'Show diff', arguments: [n.sessionId, n.fsPath] };
        return item;
      }
      case 'empty': {
        const item = new vscode.TreeItem(n.label, vscode.TreeItemCollapsibleState.None);
        item.iconPath = new vscode.ThemeIcon('info');
        return item;
      }
    }
  }

  getChildren(n?: Node): Node[] {
    const sessions = this.controller.store.list();
    const running = new Set(this.controller.runningSessionIds);
    if (!n) {
      const groups: Node[] = [];
      if (running.size) {
        groups.push({ kind: 'group', id: 'running', label: `Running (${running.size})` });
      }
      groups.push({ kind: 'group', id: 'recent', label: running.size ? 'Idle' : 'Sessions' });
      return groups;
    }
    if (n.kind === 'group') {
      const list = sessions.filter((s) => running.has(s.id) === (n.id === 'running')).slice(0, n.id === 'running' ? 50 : 25);
      if (!list.length) {
        return [{ kind: 'empty', label: 'No sessions yet — press + to start one' }];
      }
      return list.map((s) => ({ kind: 'session', session: s, running: running.has(s.id) }));
    }
    if (n.kind === 'session') {
      const out: Node[] = [];
      if (n.running) {
        out.push({ kind: 'status', sessionId: n.session.id, text: this.controller.runStatus.get(n.session.id) ?? 'Working…' });
      }
      for (const c of this.controller.tracker.forSession(n.session.id)) {
        out.push({ kind: 'file', sessionId: n.session.id, fsPath: c.fsPath, create: c.original === undefined });
      }
      return out;
    }
    return [];
  }

  dispose(): void {
    clearTimeout(this.timer);
    this.disposables.forEach((d) => d.dispose());
    this._onDidChangeTreeData.dispose();
  }
}
