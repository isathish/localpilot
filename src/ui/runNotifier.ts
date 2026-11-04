import * as vscode from 'vscode';
import { getConfig } from '../config';
import { AgentEvent } from '../types';
import { LONG_COMMAND_MS, shouldNotify } from './notifyPolicy';

interface RunningCommand {
  sessionId: string;
  command: string;
  timer: ReturnType<typeof setTimeout>;
  /** The user approved this command in a prompt, so they know it runs. */
  asked: boolean;
  long?: boolean;
}

/**
 * Native notifications (`localpilot.notifications`): a chat run finishing, and an auto-approved command that is still
 * running after 30 s (a status-bar item plus one message per command). By default only while the chat view is hidden
 * or the window has no focus.
 */
export class RunNotifier implements vscode.Disposable {
  private commands = new Map<string, RunningCommand>();
  private status?: vscode.StatusBarItem;

  constructor(private readonly chatVisible: () => boolean) {}

  private due(): boolean {
    return shouldNotify(getConfig().notifications, this.chatVisible(), vscode.window.state.focused);
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

  /** A run ended; `silent` for a stopped run or one of a group (those get their own review offer). */
  finished(sessionId: string, title: string, silent = false): void {
    for (const [id, c] of this.commands) {
      if (c.sessionId === sessionId) {
        this.clear(id);
      }
    }
    if (silent || !this.due()) {
      return;
    }
    void vscode.window.showInformationMessage(`LocalPilot finished: ${title || 'chat'}`, 'Open').then((pick) => {
      if (pick) {
        void vscode.commands.executeCommand('localpilot.openSession', sessionId);
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
