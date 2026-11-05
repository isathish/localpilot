import * as vscode from 'vscode';
import { getConfig } from '../config';
import { AgentEvent, Session } from '../types';
import { LONG_COMMAND_MS, shouldNotify } from './notifyPolicy';

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
 * Native notifications (`localpilot.notifications`): a chat run or a batch of agents finishing, and an auto-approved command that is still
 * running after 30 s (a status-bar item plus one message per command). By default only while the chat view is hidden
 * or the window has no focus.
 */
export class RunNotifier implements vscode.Disposable {
  private commands = new Map<string, RunningCommand>();
  private status?: vscode.StatusBarItem;

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
    if (silent || !this.due()) {
      return;
    }
    const name = title || 'chat';
    const open = () => vscode.commands.executeCommand('localpilot.openSession', sessionId);
    if (outcome === 'error') {
      void vscode.window.showWarningMessage(`LocalPilot stopped with an error: ${name}`, 'Open', ...(this.actions ? ['Retry'] : [])).then((pick) => {
        if (pick === 'Open') {
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
      void vscode.window.showWarningMessage(`LocalPilot needs your attention: ${name}${why ? ` — ${why}` : ''}`, 'Open').then((pick) => {
        if (pick) {
          void open();
        }
      });
      return;
    }
    if (changedFiles > 0) {
      const files = `${changedFiles} file${changedFiles === 1 ? '' : 's'} changed`;
      void vscode.window.showInformationMessage(`LocalPilot finished: ${name}. ${files}`, 'Review', ...(this.actions ? ['Keep All'] : [])).then((pick) => {
        if (pick === 'Review') {
          void open();
        } else if (pick === 'Keep All') {
          void this.actions?.keep(sessionId);
        }
      });
      return;
    }
    void vscode.window.showInformationMessage(`LocalPilot finished: ${name}`, 'Open').then((pick) => {
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
    void vscode.window.showInformationMessage(`LocalPilot: "${short}" is still running after ${LONG_COMMAND_MS / 1000} s.`, 'Open').then((pick) => {
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
