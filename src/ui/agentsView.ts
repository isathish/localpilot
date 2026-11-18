import * as vscode from 'vscode';
import * as path from 'path';
import { ChatController, LastRun } from './chatController';
import { SessionSummary, SessionUsage } from '../types';
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

/**
 * One status vocabulary for every agent surface (the chat's lanes, background strip and this view):
 * Running · Waiting for you · Paused · Done · Failed · Stopped, each with an icon, a colour and a word, so
 * nothing is conveyed by colour alone. `idle`: never ran in this window (the row shows when it was last used).
 */
export type AgentStatus = 'running' | 'waiting' | 'paused' | 'done' | 'failed' | 'stopped' | 'idle';

export const AGENT_STATUS: Record<AgentStatus, { label: string; icon: string; color?: string }> = {
  running: { label: 'Running', icon: 'loading~spin' },
  waiting: { label: 'Waiting for you', icon: 'bell-dot', color: 'list.warningForeground' },
  paused: { label: 'Paused', icon: 'debug-pause' },
  // A good outcome stays quiet: the default icon colour, only problems get a colour.
  done: { label: 'Done', icon: 'pass' },
  failed: { label: 'Failed', icon: 'error', color: 'list.errorForeground' },
  stopped: { label: 'Stopped', icon: 'debug-stop' },
  idle: { label: 'Idle', icon: 'comment-discussion' },
};

/** What a session row needs to know about its agent, gathered from the controller in one place. */
export interface AgentFacts {
  running: boolean;
  paused: boolean;
  /** Waits on an approval or a question in its chat. */
  prompt: boolean;
  last?: LastRun;
}

/** The status word of a session row: a pending prompt outranks paused, paused outranks running. */
export function agentStatus(f: AgentFacts): AgentStatus {
  if (f.prompt) {
    return 'waiting';
  }
  if (f.running) {
    return f.paused ? 'paused' : 'running';
  }
  return f.last?.status ?? 'idle';
}

/** "45s", "4m 05s", "1h 12m": elapsed time at the precision a glance needs. */
export function fmtElapsed(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) {
    return `${s}s`;
  }
  if (s < 3600) {
    return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
  }
  return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`;
}

/** "now", "5m ago", "3h ago", "2d ago". */
export function fmtAgo(ts: number, now = Date.now()): string {
  const d = now - ts;
  if (d < 60e3) {
    return 'just now';
  }
  if (d < 3600e3) {
    return `${Math.floor(d / 60e3)}m ago`;
  }
  if (d < 86400e3) {
    return `${Math.floor(d / 3600e3)}h ago`;
  }
  return `${Math.floor(d / 86400e3)}d ago`;
}

/** What the chat cost: dollars when the provider reported a price, else the tokens (local models are free). */
export function fmtCost(u: SessionUsage | undefined): string {
  if (!u) {
    return '';
  }
  if (u.costUsd && u.costUsd > 0) {
    return u.costUsd < 0.01 ? '<$0.01' : `$${u.costUsd.toFixed(2)}`;
  }
  const t = (u.promptTokens || 0) + (u.completionTokens || 0) + (u.cacheReadTokens || 0) + (u.cacheWriteTokens || 0);
  if (!t) {
    return '';
  }
  return t >= 1e6 ? `${(t / 1e6).toFixed(1)}M tok` : t >= 1000 ? `${Math.round(t / 1000)}k tok` : `${t} tok`;
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/**
 * The secondary text of a session row, most important first so a narrow side bar keeps what matters:
 * status · elapsed (or when it ended) · model · changed files · cost.
 */
export function describeAgent(s: Pick<SessionSummary, 'mode' | 'model' | 'messageCount' | 'updatedAt' | 'usage' | 'worktree' | 'group'>, f: AgentFacts & { startedAt?: number; files: number; question?: boolean }, now = Date.now()): string {
  const st = agentStatus(f);
  const model = (s.model || '').split('/').pop();
  const parts: string[] = [];
  if (st === 'waiting') {
    parts.push(f.question ? 'Waiting for you · question' : 'Waiting for you · approval');
  } else if (st === 'running' || st === 'paused') {
    parts.push(f.startedAt ? `${AGENT_STATUS[st].label} ${fmtElapsed(now - f.startedAt)}` : AGENT_STATUS[st].label);
  } else if (st === 'idle') {
    parts.push(`${s.mode} · ${fmtAgo(s.updatedAt, now)}`);
  } else {
    parts.push(`${AGENT_STATUS[st].label}${f.last?.durationMs ? ` in ${fmtElapsed(f.last.durationMs)}` : ''} · ${fmtAgo(f.last!.endedAt, now)}`);
  }
  if (model) {
    parts.push(model);
  }
  if (f.files) {
    parts.push(f.running ? plural(f.files, 'file') + ' changed' : `${plural(f.files, 'file')} to review`);
  }
  const cost = fmtCost(s.usage);
  if (cost) {
    parts.push(cost);
  }
  if (s.worktree) {
    parts.push(s.group && s.group.size > 1 ? `isolated · best of ${s.group.size}` : 'isolated');
  }
  return parts.join(' · ');
}

type GroupId = 'attention' | 'running' | 'queue' | 'recent';

type Node =
  | { kind: 'group'; id: GroupId; label: string }
  /** A task-queue entry; once started it opens the chat it runs in. `attention`: listed under "Needs you". */
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
 * "Agents" panel: a live overview of every agent. Native tree (not a webview) so it keeps VS Code's keyboard
 * navigation, screen-reader support, theming and context menus for free.
 *
 *   Needs you   agents waiting on an approval or a question, finished agents whose changes wait for review, queue
 *               tasks that stopped short — the things only the user can unblock.
 *   Running     working or paused agents: status · elapsed · model · files changed · cost; inline Pause / Stop.
 *   Queue       the task queue.
 *   Recent      everything else, with how its last run ended (Done / Failed / Stopped) when it ran in this window.
 *
 * Each agent lists its live step, its subagents (own Pause / Stop) and the files it changed (Diff / Accept / Reject).
 */
export class AgentsTreeProvider implements vscode.TreeDataProvider<Node>, vscode.Disposable {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
  private readonly disposables: vscode.Disposable[] = [];
  private timer?: NodeJS.Timeout;
  /** Keeps the elapsed times of running agents moving while anything runs. */
  private clock?: NodeJS.Timeout;

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

  /** A 5 s tick while agents run (elapsed times), none while idle. */
  private syncClock(running: number): void {
    if (running && !this.clock) {
      this.clock = setInterval(() => this._onDidChangeTreeData.fire(undefined), 5000);
    } else if (!running && this.clock) {
      clearInterval(this.clock);
      this.clock = undefined;
    }
  }

  private facts(s: SessionSummary, running: boolean): AgentFacts & { startedAt?: number; files: number; question?: boolean } {
    const c = this.controller;
    const prompt = !!c.hasPendingPrompt?.(s.id);
    return {
      running,
      paused: running && !!c.isPaused?.(s.id),
      prompt,
      question: prompt && !!c.runStatus.get(s.id)?.startsWith('Waiting for your answer'),
      last: c.lastRun?.(s.id),
      startedAt: running ? c.runStartedAt?.(s.id) : undefined,
      files: c.tracker.forSession?.(s.id).length ?? 0,
    };
  }

  /** Needs the user: a pending prompt, or a finished agent whose changes wait for review. */
  private needsYou(s: SessionSummary, running: boolean): boolean {
    const f = this.facts(s, running);
    return f.prompt || (!running && f.files > 0);
  }

  getTreeItem(n: Node): vscode.TreeItem {
    switch (n.kind) {
      case 'group': {
        const item = new vscode.TreeItem(n.label, vscode.TreeItemCollapsibleState.Expanded);
        item.id = `group/${n.id}`;
        item.contextValue = n.id === 'queue' ? (this.queue?.paused ? 'group-queue-paused' : 'group-queue') : `group-${n.id}`;
        if (n.id === 'attention') {
          item.iconPath = new vscode.ThemeIcon('bell-dot', new vscode.ThemeColor('list.warningForeground'));
          item.tooltip = 'Agents waiting on an approval or a question, finished agents whose changes wait for your review, and queued tasks that stopped short';
        }
        return item;
      }
      case 'task': {
        const t = n.task;
        const item = new vscode.TreeItem(t.prompt.split('\n')[0].slice(0, 80), vscode.TreeItemCollapsibleState.None);
        item.id = n.attention ? `attention/${t.id}` : t.id;
        const model = (t.model || '').split('/').pop();
        const after = t.dependsOn?.length ? ` · after ${t.dependsOn.map((d) => `#${this.queue!.list.findIndex((x) => x.id === d) + 1}`).join(', ')}` : '';
        // The queue's own states, worded like the rest of the agent surfaces.
        const words: Record<QueueTask['status'], string> = { queued: 'Queued', running: 'Running', done: 'Done', failed: 'Failed', cancelled: 'Stopped', blocked: 'Blocked', incomplete: 'Needs you · incomplete', needs_input: 'Waiting for you' };
        const status = words[t.status];
        item.description = `#${n.position} · ${status}${t.status === 'running' && t.sessionId ? ` · ${this.controller.runStatus.get(t.sessionId) ?? 'Working…'}` : ''} · ${t.mode}${model ? ` · ${model}` : ''}${after}`;
        const outcome = t.outcome && t.outcome !== t.status ? ` (${t.outcome.replace(/_/g, ' ')})` : '';
        item.tooltip = `${t.prompt}\n\n${status}${outcome}${t.error ? `: ${t.error}` : ''}${t.model ? `\nModel: ${t.model}` : ''}${ATTENTION.has(t.status) && t.sessionId ? `\nClick to see ${this.options.recovery ? 'what happened' : 'the chat'}; Retry continues in the same chat.` : ''}`;
        const icons: Record<QueueTask['status'], [string, string?]> = {
          queued: ['clock'],
          running: ['loading~spin'],
          done: ['pass'],
          failed: ['error', 'list.errorForeground'],
          cancelled: ['debug-stop'],
          blocked: ['debug-step-over', 'list.warningForeground'],
          incomplete: ['warning', 'list.warningForeground'],
          needs_input: ['bell-dot', 'list.warningForeground'],
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
        const f = this.facts(s, n.running);
        const st = agentStatus(f);
        const item = new vscode.TreeItem(s.title, n.running || f.files ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed);
        item.id = s.id;
        item.description = describeAgent(s, f);
        const isolated = !!s.worktree;
        const look = AGENT_STATUS[st];
        // Idle chats keep their mode icon (and the pin): the status word is only for agents that ran in this window.
        const icon = st === 'idle' ? (s.pinned ? 'pinned' : s.mode === 'agent' ? 'localpilot-logo' : s.mode === 'plan' ? 'checklist' : s.mode === 'debug' ? 'debug-alt' : 'comment-discussion') : look.icon;
        item.iconPath = new vscode.ThemeIcon(icon, look.color && st !== 'idle' ? new vscode.ThemeColor(look.color) : undefined);
        const tip = new vscode.MarkdownString(undefined, true);
        tip.appendMarkdown(`**${esc(s.title)}**\n\n`);
        tip.appendMarkdown(`$(${icon.replace('~spin', '')}) ${st === 'idle' ? `Last used ${fmtAgo(s.updatedAt)}` : look.label}${f.running && f.startedAt ? ` for ${fmtElapsed(Date.now() - f.startedAt)}` : ''}${n.running ? ` — ${esc(this.controller.runStatus.get(s.id) ?? 'Working…')}` : ''}\n\n`);
        tip.appendMarkdown(`Model: ${esc(s.model || 'default model')} · ${s.mode} · ${plural(s.messageCount, 'message')}\n\n`);
        if (f.files) {
          tip.appendMarkdown(`${plural(f.files, 'file')} changed${n.running ? '' : ' — waiting for your review'}\n\n`);
        }
        const cost = fmtCost(s.usage);
        if (cost) {
          tip.appendMarkdown(`Spent: ${cost}${s.usage?.requests ? ` over ${plural(s.usage.requests, 'request')}` : ''}\n\n`);
        }
        if (isolated) {
          tip.appendMarkdown(`Isolated worktree: \`${esc(s.worktree!.path)}\` — apply its changes to the workspace or discard them.\n\n`);
        }
        tip.appendMarkdown(f.prompt ? 'Click to open the chat and answer.' : 'Click to open the chat.');
        item.tooltip = tip;
        item.accessibilityInformation = { label: `${s.title}, ${item.description}`, role: 'treeitem' };
        // session-<running|paused|idle>[-changed][-isolated]: `-changed` (idle, in-place edits) drives Review / Accept / Reject, `-isolated` the worktree actions.
        const state = f.paused ? 'paused' : n.running ? 'running' : 'idle';
        item.contextValue = `session-${state}${state === 'idle' && f.files && !isolated ? '-changed' : ''}${isolated ? '-isolated' : ''}`;
        if (f.prompt) {
          // Keeps the `session-running` / `session-paused` prefix so Pause and Stop stay in the context menu while the agent waits.
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
        item.iconPath = new vscode.ThemeIcon(n.text.startsWith('Paus') ? 'debug-pause' : n.text.startsWith('Waiting for your') ? 'bell-dot' : 'pulse');
        item.tooltip = `Now: ${n.text}`;
        item.contextValue = 'status';
        return item;
      }
      case 'child': {
        const item = new vscode.TreeItem(n.label, vscode.TreeItemCollapsibleState.None);
        item.id = `${n.sessionId}/${n.childId}`;
        item.description = `subagent · ${n.paused ? 'Paused' : 'Running'}`;
        item.iconPath = new vscode.ThemeIcon(n.paused ? 'debug-pause' : 'loading~spin');
        item.contextValue = n.paused ? 'child-paused' : 'child-running';
        item.tooltip = `Subagent ${n.label} — ${n.paused ? 'Paused' : 'Running'}\nPause or stop it without affecting the main agent`;
        return item;
      }
      case 'file': {
        const item = new vscode.TreeItem(path.basename(n.fsPath), vscode.TreeItemCollapsibleState.None);
        const dir = path.dirname(vscode.workspace.asRelativePath(n.fsPath));
        item.description = `${n.create ? 'added' : 'modified'}${dir && dir !== '.' ? ` · ${dir}` : ''}`;
        item.resourceUri = vscode.Uri.file(n.fsPath);
        item.iconPath = new vscode.ThemeIcon(n.create ? 'diff-added' : 'diff-modified', new vscode.ThemeColor(n.create ? 'gitDecoration.addedResourceForeground' : 'gitDecoration.modifiedResourceForeground'));
        item.tooltip = `${n.create ? 'Created' : 'Modified'} by the agent — click to view the diff; Accept keeps it, Reject puts the file back`;
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
      this.syncClock(running.size);
      // Nothing worth listing: return no roots so the contributed viewsWelcome content shows.
      if (!running.size && !this.queue?.list.length && sessions.every((s) => s.messageCount === 0 && !s.worktree && !this.controller.tracker.forSession(s.id).length)) {
        return [];
      }
      const needs = sessions.filter((s) => this.needsYou(s, running.has(s.id))).length + (this.queue?.list.filter((t) => ATTENTION.has(t.status)).length ?? 0);
      const working = sessions.filter((s) => running.has(s.id) && !this.needsYou(s, true)).length;
      const groups: Node[] = [];
      if (needs) {
        groups.push({ kind: 'group', id: 'attention', label: `Needs you (${needs})` });
      }
      if (working) {
        groups.push({ kind: 'group', id: 'running', label: `Running (${working})` });
      }
      if (this.queue?.list.length) {
        const q = this.queue;
        groups.push({ kind: 'group', id: 'queue', label: `Queue (${q.activeCount} running, ${q.pendingCount} waiting${q.paused ? ', paused' : ''})` });
      }
      // While agents run or wait, an empty Recent group is just noise.
      if (!groups.length || sessions.some((s) => !running.has(s.id) && !this.needsYou(s, false))) {
        groups.push({ kind: 'group', id: 'recent', label: groups.length ? 'Recent' : 'Chats' });
      }
      return groups;
    }
    if (n.kind === 'group' && n.id === 'queue') {
      return (this.queue?.list ?? []).map((task, i) => ({ kind: 'task', task, position: i + 1 }));
    }
    if (n.kind === 'group') {
      const pick = (s: SessionSummary): boolean => {
        const r = running.has(s.id);
        const needs = this.needsYou(s, r);
        return n.id === 'attention' ? needs : n.id === 'running' ? r && !needs : !r && !needs;
      };
      // Waiting agents first (they block on the user right now), then the ones with changes to review.
      const all = sessions.filter(pick).sort((a, b) => (n.id === 'attention' ? Number(this.controller.hasPendingPrompt(b.id)) - Number(this.controller.hasPendingPrompt(a.id)) : 0));
      const tasks: Node[] = n.id === 'attention' ? (this.queue?.list ?? []).flatMap((task, i): Node[] => (ATTENTION.has(task.status) ? [{ kind: 'task', task, position: i + 1, attention: true }] : [])) : [];
      const limit = n.id === 'recent' ? 25 : 50;
      if (!all.length && !tasks.length) {
        return sessions.length ? [] : [{ kind: 'empty', label: 'No chats yet. Start one with New Chat (+) or Run Tasks in Parallel.' }];
      }
      const out: Node[] = [...all.slice(0, limit).map((s): Node => ({ kind: 'session', session: s, running: running.has(s.id) })), ...tasks];
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
    this.syncClock(0);
    this.disposables.forEach((d) => d.dispose());
    this._onDidChangeTreeData.dispose();
  }
}

/** Markdown-escapes text from a chat (titles, paths) for a tooltip. */
function esc(s: string): string {
  return s.replace(/[\\`*_{}[\]()#+\-.!|<>]/g, '\\$&');
}
