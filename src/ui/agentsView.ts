import * as vscode from 'vscode';
import * as path from 'path';
import { ChatController } from './chatController';
import { SessionSummary } from '../types';
import { QueueTask, TaskQueue } from '../agent/taskQueue';

/** Registered by the extension; opens a task's recovery report (`sessionId`, `interventionId?`). */
export const RECOVERY_OPEN_COMMAND = 'localpilot.recovery.open';
/** Registered by the extension; continues an incomplete or waiting task in its chat. */
export const RECOVERY_RESUME_COMMAND = 'localpilot.recovery.resume';

export interface AgentsTreeOptions {
  /** The extension registered the recovery commands: incomplete/waiting tasks open their recovery report instead of the chat. */
  recovery?: boolean;
}

const ATTENTION: ReadonlySet<QueueTask['status']> = new Set(['incomplete', 'needs_input']);

type Node =
  | { kind: 'group'; id: 'running' | 'recent' | 'queue' | 'attention'; label: string }
  /** A task-queue entry; once started it opens the chat it runs in. `attention`: listed under "Needs attention". */
  | { kind: 'task'; task: QueueTask; position: number; attention?: boolean }
  | { kind: 'session'; session: SessionSummary; running: boolean }
  | { kind: 'status'; sessionId: string; text: string }
  /** A running subagent of a session, with its own pause/stop controls. */
  | { kind: 'child'; sessionId: string; childId: string; label: string; paused: boolean }
  | { kind: 'file'; sessionId: string; fsPath: string; create: boolean }
  | { kind: 'empty'; label: string }
  /** Last row of a truncated list: opens the full chat picker. */
  | { kind: 'more'; total: number };

/**
 * "Agents" panel: every chat session is an independent agent. Running ones appear on top with a live
 * status line; each session lists the files it changed with Diff / Keep / Undo actions.
 */
export class AgentsTreeProvider implements vscode.TreeDataProvider<Node>, vscode.Disposable {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
  private readonly disposables: vscode.Disposable[] = [];
  private timer?: NodeJS.Timeout;

  constructor(private readonly controller: ChatController, private readonly queue?: TaskQueue, private readonly options: AgentsTreeOptions = {}) {
    const refresh = () => this.scheduleRefresh();
    this.disposables.push(controller.store.onDidChange(refresh), controller.onDidChangeRuns(refresh), controller.tracker.onDidChange(refresh), controller.onDidChangeActive(refresh));
    if (queue) {
      this.disposables.push(queue.onDidChange(refresh));
    }
  }

  private scheduleRefresh(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this._onDidChangeTreeData.fire(undefined), 150);
  }

  getTreeItem(n: Node): vscode.TreeItem {
    switch (n.kind) {
      case 'group': {
        const item = new vscode.TreeItem(n.label, vscode.TreeItemCollapsibleState.Expanded);
        item.contextValue = n.id === 'queue' ? (this.queue?.paused ? 'group-queue-paused' : 'group-queue') : `group-${n.id}`;
        return item;
      }
      case 'task': {
        const t = n.task;
        const item = new vscode.TreeItem(t.prompt.split('\n')[0].slice(0, 80), vscode.TreeItemCollapsibleState.None);
        item.id = n.attention ? `attention/${t.id}` : t.id;
        const model = (t.model || '').split('/').pop();
        const after = t.dependsOn?.length ? ` · after ${t.dependsOn.map((d) => `#${this.queue!.list.findIndex((x) => x.id === d) + 1}`).join(', ')}` : '';
        const status = t.status === 'needs_input' ? 'needs input' : t.status;
        item.description = `#${n.position} · ${status}${t.status === 'running' && t.sessionId ? ` · ${this.controller.runStatus.get(t.sessionId) ?? 'Working…'}` : ''} · ${t.mode}${model ? ` · ${model}` : ''}${after}`;
        const outcome = t.outcome && t.outcome !== t.status ? ` (${t.outcome.replace(/_/g, ' ')})` : '';
        item.tooltip = `${t.prompt}\n\n${status}${outcome}${t.error ? `: ${t.error}` : ''}${t.model ? `\nModel: ${t.model}` : ''}${ATTENTION.has(t.status) && t.sessionId ? `\nClick to see ${this.options.recovery ? 'what happened' : 'the chat'}; Retry continues in the same chat.` : ''}`;
        const icons: Record<QueueTask['status'], [string, string?]> = {
          queued: ['clock'],
          running: ['loading~spin'],
          done: ['pass', 'testing.iconPassed'],
          failed: ['error', 'testing.iconFailed'],
          cancelled: ['circle-slash'],
          blocked: ['debug-step-over', 'list.warningForeground'],
          incomplete: ['warning', 'list.warningForeground'],
          needs_input: ['bell', 'list.warningForeground'],
        };
        const [icon, color] = icons[t.status];
        item.iconPath = new vscode.ThemeIcon(icon, color ? new vscode.ThemeColor(color) : undefined);
        // Exact values matched by package.json menus; the other statuses keep `queue-<status>`.
        item.contextValue = t.status === 'incomplete' ? 'queueTask.incomplete' : t.status === 'needs_input' ? 'queueTask.needsInput' : `queue-${t.status}`;
        if (t.sessionId) {
          item.command = ATTENTION.has(t.status) && this.options.recovery
            ? { command: RECOVERY_OPEN_COMMAND, title: 'Open recovery report', arguments: [t.sessionId, t.interventionId] }
            : { command: 'localpilot.openSession', title: 'Open', arguments: [t.sessionId] };
        }
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
        const paused = n.running && this.controller.isPaused(s.id);
        const isolated = !!s.worktree;
        if (isolated) {
          item.description = `${item.description} · isolated${s.group ? ` · best of ${s.group.size}` : ''}`;
          item.tooltip = `${item.tooltip}\nIsolated worktree: ${s.worktree!.path}\nApply its changes to the workspace or discard them from the context menu.`;
        }
        item.iconPath = new vscode.ThemeIcon(paused ? 'debug-pause' : n.running ? 'loading~spin' : s.pinned ? 'pinned' : s.mode === 'agent' ? 'localpilot-logo' : s.mode === 'plan' ? 'checklist' : 'comment-discussion');
        // session-<running|paused|idle>[-changed][-isolated]: `-changed` (idle, in-place edits) drives Keep/Undo, `-isolated` the worktree actions.
        const state = paused ? 'paused' : n.running ? 'running' : 'idle';
        item.contextValue = `session-${state}${state === 'idle' && files && !isolated ? '-changed' : ''}${isolated ? '-isolated' : ''}`;
        if (this.controller.hasPendingPrompt(s.id)) {
          // Keeps the `session-running` / `session-paused` prefix so Pause and Stop stay in the context menu while the agent waits.
          const question = this.controller.runStatus.get(s.id)?.startsWith('Waiting for your answer');
          item.iconPath = new vscode.ThemeIcon('bell-dot', new vscode.ThemeColor('list.warningForeground'));
          item.description = `${question ? 'has a question' : 'needs approval'}${model ? ` · ${model}` : ''}${isolated ? ' · isolated' : ''}`;
          item.tooltip = `${item.tooltip}\n${this.controller.runStatus.get(s.id) ?? 'Waiting for you'}\nClick to open the chat and answer.`;
          item.contextValue = `session-${state === 'idle' ? 'running' : state}-waiting${isolated ? '-isolated' : ''}`;
        }
        item.command = { command: 'localpilot.openSession', title: 'Open', arguments: [s.id] };
        if (this.controller.activeSession?.id === s.id) {
          item.resourceUri = vscode.Uri.parse(`localpilot-active:${s.id}`);
        }
        return item;
      }
      case 'status': {
        const item = new vscode.TreeItem(n.text, vscode.TreeItemCollapsibleState.None);
        item.iconPath = new vscode.ThemeIcon(n.text.startsWith('Paus') ? 'debug-pause' : 'pulse');
        item.contextValue = 'status';
        return item;
      }
      case 'child': {
        const item = new vscode.TreeItem(n.label, vscode.TreeItemCollapsibleState.None);
        item.id = `${n.sessionId}/${n.childId}`;
        item.description = n.paused ? 'paused' : 'subagent';
        item.iconPath = new vscode.ThemeIcon(n.paused ? 'debug-pause' : 'loading~spin');
        item.contextValue = n.paused ? 'child-paused' : 'child-running';
        item.tooltip = `Subagent ${n.label}\nPause or stop it without affecting the main agent`;
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
      case 'more': {
        const item = new vscode.TreeItem(`Show all ${n.total} chats…`, vscode.TreeItemCollapsibleState.None);
        item.iconPath = new vscode.ThemeIcon('history');
        item.command = { command: 'localpilot.showSessions', title: 'Show all chats' };
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
      // Nothing worth listing: return no roots so the contributed viewsWelcome content shows.
      if (!running.size && !this.queue?.list.length && sessions.every((s) => s.messageCount === 0 && !s.worktree && !this.controller.tracker.forSession(s.id).length)) {
        return [];
      }
      const groups: Node[] = [];
      if (running.size) {
        groups.push({ kind: 'group', id: 'running', label: `Running (${running.size})` });
      }
      // While agents run, an empty Idle group is just noise.
      if (!running.size || sessions.some((s) => !running.has(s.id))) {
        groups.push({ kind: 'group', id: 'recent', label: running.size ? 'Idle' : 'Sessions' });
      }
      if (this.queue?.list.length) {
        const q = this.queue;
        groups.unshift({ kind: 'group', id: 'queue', label: `Queue (${q.activeCount} running, ${q.pendingCount} waiting${q.paused ? ', paused' : ''})` });
        const attention = q.list.filter((t) => ATTENTION.has(t.status)).length;
        if (attention) {
          groups.unshift({ kind: 'group', id: 'attention', label: `Needs attention (${attention})` });
        }
      }
      return groups;
    }
    if (n.kind === 'group' && n.id === 'queue') {
      return (this.queue?.list ?? []).map((task, i) => ({ kind: 'task', task, position: i + 1 }));
    }
    if (n.kind === 'group' && n.id === 'attention') {
      return (this.queue?.list ?? []).flatMap((task, i): Node[] => (ATTENTION.has(task.status) ? [{ kind: 'task', task, position: i + 1, attention: true }] : []));
    }
    if (n.kind === 'group') {
      const all = sessions.filter((s) => running.has(s.id) === (n.id === 'running'));
      const limit = n.id === 'running' ? 50 : 25;
      if (!all.length) {
        return sessions.length ? [] : [{ kind: 'empty', label: 'No chats yet. Start one with New Chat (+) or Run Tasks in Parallel.' }];
      }
      const out: Node[] = all.slice(0, limit).map((s) => ({ kind: 'session', session: s, running: running.has(s.id) }));
      return all.length > limit ? [...out, { kind: 'more', total: sessions.length }] : out;
    }
    if (n.kind === 'session') {
      const out: Node[] = [];
      if (n.running) {
        out.push({ kind: 'status', sessionId: n.session.id, text: this.controller.runStatus.get(n.session.id) ?? 'Working…' });
        for (const c of this.controller.childControls(n.session.id)) {
          out.push({ kind: 'child', sessionId: n.session.id, childId: c.id, label: c.label ?? 'subagent', paused: c.pausedBySelf });
        }
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
