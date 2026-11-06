import * as vscode from 'vscode';
import { getConfig } from '../config';
import { AgentEvent, Session } from '../types';
import { LONG_COMMAND_MS, shouldNotify, shouldNotifyFinish } from './notifyPolicy';

interface RunningCommand {
  sessionId: string;
  command: string;
  timer: ReturnType<typeof setTimeout>;
  /** The user approved this command in a prompt, so they know it runs. */
  asked: boolean;
  long?: boolean;
}

/** What the notification buttons do that only the chat controller can: replay the failed turn, keep the changes. */
export interface RunNotifierActions {
  retry(sessionId: string): unknown;
  keep(sessionId: string): unknown;
}

/**
 * Native notifications (`localpilot.notifications`): a chat run or a batch of agents finishing (by default only runs
 * longer than 20 s, or ones that failed or need you), a run waiting on an approval or a question, and an auto-approved
 * command that is still running after 30 s (a status-bar item plus one message per command). By default only while
 * the chat view is hidden or the window has no focus.
 */
export class RunNotifier implements vscode.Disposable {
  private commands = new Map<string, RunningCommand>();
  private status?: vscode.StatusBarItem;
  /** When each chat's current run started, for the long-run threshold of the finish notice. */
  private readonly startedAt = new Map<string, number>();
  /** Chats that already got a "needs your approval" notice in this run: one per run, not one per prompt. */
  private readonly waitNoticed = new Set<string>();

  constructor(
    private readonly chatVisible: () => boolean,
    private readonly actions?: RunNotifierActions
  ) {}

  private due(): boolean {
    return shouldNotify(getConfig().notifications, this.chatVisible(), vscode.window.state?.focused ?? true);
  }

  /** Follows the top-level tool events of a run. */
  event(e: AgentEvent): void {
    const p = e.payload as { id?: string; name?: string; args?: { command?: unknown }; childId?: string } | undefined;
    if (!p?.id || p.childId) {
      return;
    }
    if (e.type === 'tool_start' && p.name === 'run_command') {
      const command = String(p.args?.command ?? '').trim();
      const timer = setTimeout(() => this.longRunning(p.id!), LONG_COMMAND_MS);
      this.commands.set(p.id, { sessionId: e.sessionId, command, timer, asked: false });
    } else if (e.type === 'tool_end') {
      this.clear(p.id);
    }
  }

  /** A chat run started: the finish notice measures from here. */
  started(sessionId: string, at = Date.now()): void {
    this.startedAt.set(sessionId, at);
    this.waitNoticed.delete(sessionId);
  }

  /**
   * The run waits on the user (an approval card or a question in the chat) while nobody is looking: one notice per
   * run with Open chat, so a long run does not sit blocked until someone happens to come back.
   */
  waiting(sessionId: string, title: string, what: string): void {
    if (this.waitNoticed.has(sessionId) || !this.due()) {
      return;
    }
    this.waitNoticed.add(sessionId);
    const name = title || 'chat';
    const short = what.length > 120 ? `${what.slice(0, 117)}…` : what;
    void vscode.window.showWarningMessage(`LocalPilot is waiting for you in “${name}”: ${short}`, 'Open chat').then((pick) => {
      if (pick) {
        void vscode.commands.executeCommand('localpilot.openSession', sessionId);
      }
    });
  }

  /** An approval prompt was shown in this session: commands waiting on it are not auto-approved. */
  asked(sessionId: string): void {
    for (const c of this.commands.values()) {
      if (c.sessionId === sessionId && !c.long) {
        c.asked = true;
      }
    }
  }

  /**
   * A run ended; `silent` for a stopped run or one of a group (those get {@link groupFinished}). An error is a warning
   * with Retry; a self-healing run that ended incomplete or blocked (`attention`, `detail` = its report) is a warning
   * that opens the chat; a run that changed files offers the review.
   */
  finished(sessionId: string, title: string, silent = false, outcome: 'ok' | 'error' | 'attention' = 'ok', changedFiles = 0, detail?: string): void {
    for (const [id, c] of this.commands) {
      if (c.sessionId === sessionId) {
        this.clear(id);
      }
    }
    const started = this.startedAt.get(sessionId);
    this.startedAt.delete(sessionId);
    this.waitNoticed.delete(sessionId);
    const ms = started === undefined ? Number.POSITIVE_INFINITY : Date.now() - started;
    if (silent || !shouldNotifyFinish(getConfig().notifications, this.chatVisible(), vscode.window.state?.focused ?? true, ms, outcome)) {
      return;
    }
    const name = title || 'chat';
    const took = Number.isFinite(ms) ? ` after ${formatDuration(ms)}` : '';
    const open = () => vscode.commands.executeCommand('localpilot.openSession', sessionId);
    if (outcome === 'error') {
      void vscode.window.showWarningMessage(`LocalPilot stopped with an error${took}: ${name}`, 'Open chat', ...(this.actions ? ['Retry'] : [])).then((pick) => {
        if (pick === 'Open chat') {
          void open();
        } else if (pick === 'Retry') {
          void open();
          void this.actions?.retry(sessionId);
        }
      });
      return;
    }
    if (outcome === 'attention') {
      const why = detail?.split('\n').find((l) => l.trim())?.trim().slice(0, 200);
      void vscode.window.showWarningMessage(`LocalPilot needs your attention: ${name}${why ? ` — ${why}` : ''}`, 'Open chat').then((pick) => {
        if (pick) {
          void open();
        }
      });
      return;
    }
    if (changedFiles > 0) {
      const files = `${changedFiles} file${changedFiles === 1 ? '' : 's'} changed`;
      void vscode.window.showInformationMessage(`LocalPilot finished${took}: ${name}. ${files}`, 'Review', ...(this.actions ? ['Keep All'] : [])).then((pick) => {
        if (pick === 'Review') {
          void open();
        } else if (pick === 'Keep All') {
          void this.actions?.keep(sessionId);
        }
      });
      return;
    }
    void vscode.window.showInformationMessage(`LocalPilot finished${took}: ${name}`, 'Open chat').then((pick) => {
      if (pick) {
        void open();
      }
    });
  }

  /** The last agent of a batch (Best of N or split tasks) finished: offer to compare and apply their results. */
  groupFinished(group: NonNullable<Session['group']>, count: number): void {
    if (!this.due()) {
      return;
    }
    const text =
      group.kind === 'bestOf'
        ? `All ${count} agents finished “${group.prompt.slice(0, 50)}”. Compare their results and apply the best one.`
        : `All ${count} agents finished their tasks. Review what each one changed and apply what you like.`;
    void vscode.window.showInformationMessage(text, 'Compare results').then((pick) => {
      if (pick) {
        void vscode.commands.executeCommand('localpilot.compareResults', group.id);
      }
    });
  }

  private longRunning(id: string): void {
    const c = this.commands.get(id);
    if (!c || c.asked || !this.due()) {
      return;
    }
    c.long = true;
    const short = c.command.length > 60 ? `${c.command.slice(0, 57)}…` : c.command;
    this.status ??= vscode.window.createStatusBarItem('localpilot.longCommand', vscode.StatusBarAlignment.Left, 90);
    this.status.name = 'LocalPilot long-running command';
    this.status.text = '$(terminal) LocalPilot: command running';
    this.status.tooltip = `Still running after ${LONG_COMMAND_MS / 1000} s: ${c.command}`;
    this.status.command = { title: 'Open chat', command: 'localpilot.openSession', arguments: [c.sessionId] };
    this.status.show();
    void vscode.window.showInformationMessage(`LocalPilot: "${short}" is still running after ${LONG_COMMAND_MS / 1000} s.`, 'Open chat').then((pick) => {
      if (pick) {
        void vscode.commands.executeCommand('localpilot.openSession', c.sessionId);
      }
    });
  }

  private clear(id: string): void {
    const c = this.commands.get(id);
    if (!c) {
      return;
    }
    clearTimeout(c.timer);
    this.commands.delete(id);
    if (![...this.commands.values()].some((x) => x.long)) {
      this.status?.hide();
    }
  }

  dispose(): void {
    for (const c of this.commands.values()) {
      clearTimeout(c.timer);
    }
    this.commands.clear();
    this.status?.dispose();
  }
}

/** "45 s", "3 min", "1 h 5 min": the run length in a notification. */
export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) {
    return `${s} s`;
  }
  const m = Math.round(s / 60);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}`;
}
