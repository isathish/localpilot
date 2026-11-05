import * as vscode from 'vscode';
import * as path from 'path';
import type { FailureMemory, HealingService, RecoveryActionKind, RecoveryStore } from '../agent/healing';
import { interruptedNotice } from '../agent/healing/hostAdapters';
import type { QueueTask, TaskQueue } from '../agent/taskQueue';
import { getConfig } from '../config';
import { recoverySnapshotUri } from '../healingHost';
import type { ChatController } from './chatController';

/** Commands of the self-healing engine (Agents view, palette, notifications, Dashboard → Human Intervention Queue). */
export const RECOVERY_COMMANDS = {
  showQueue: 'localpilot.recovery.showQueue',
  open: 'localpilot.recovery.open',
  resume: 'localpilot.recovery.resume',
  rollback: 'localpilot.recovery.rollback',
} as const;

export interface RecoveryTarget {
  sessionId: string;
  taskId?: string;
  interventionId?: string;
}

/**
 * A command argument as a recovery target: a session id (+ intervention id, as the Agents view passes them), an
 * Agents view task or session node, or `{ sessionId }`.
 */
export function recoveryTarget(arg: unknown, second?: unknown): RecoveryTarget | undefined {
  if (typeof arg === 'string' && arg) {
    return { sessionId: arg, ...(typeof second === 'string' && second ? { interventionId: second } : {}) };
  }
  if (!arg || typeof arg !== 'object') {
    return undefined;
  }
  const a = arg as { task?: Partial<QueueTask>; session?: { id?: unknown }; sessionId?: unknown; interventionId?: unknown; id?: unknown };
  if (a.task && typeof a.task.sessionId === 'string') {
    return { sessionId: a.task.sessionId, ...(a.task.id ? { taskId: a.task.id } : {}), ...(a.task.interventionId ? { interventionId: a.task.interventionId } : {}) };
  }
  if (a.session && typeof a.session.id === 'string') {
    return { sessionId: a.session.id };
  }
  if (typeof a.sessionId === 'string' && a.sessionId) {
    const iv = typeof a.interventionId === 'string' ? a.interventionId : typeof a.id === 'string' ? a.id : undefined;
    return { sessionId: a.sessionId, ...(iv ? { interventionId: iv } : {}) };
  }
  return undefined;
}

/** The queue entry a recovery belongs to: by id, else the latest one that ran in the chat and ended incomplete or waiting. */
export function queueTaskFor(queue: Pick<TaskQueue, 'list'>, t: RecoveryTarget): QueueTask | undefined {
  const byId = t.taskId ? queue.list.find((x) => x.id === t.taskId) : undefined;
  if (byId) {
    return byId;
  }
  return [...queue.list].reverse().find((x) => x.sessionId === t.sessionId && (x.status === 'incomplete' || x.status === 'needs_input'));
}

export interface RecoveryCommandDeps {
  controller: Pick<ChatController, 'handle' | 'resumeRecovery' | 'isRunning' | 'store'>;
  queue: TaskQueue;
  healing: HealingService;
  store: RecoveryStore;
  memory: (root: string) => FailureMemory | undefined;
  root: () => string | undefined;
  log: vscode.LogOutputChannel;
  /** Shows the chat view (the session itself is selected through `localpilot.openSession`). */
  reveal: () => void;
  showDashboard: () => void;
  showProviders: () => void;
  pickModel: () => Thenable<unknown> | Promise<unknown>;
  startServer: () => Promise<boolean>;
}

export class RecoveryCommands {
  constructor(private readonly d: RecoveryCommandDeps) {}

  register(): vscode.Disposable[] {
    const reg = (id: string, fn: (...a: unknown[]) => unknown) => vscode.commands.registerCommand(id, fn);
    return [
      reg(RECOVERY_COMMANDS.showQueue, () => this.d.showDashboard()),
      reg(RECOVERY_COMMANDS.open, async (a?: unknown, b?: unknown) => {
        const t = recoveryTarget(a, b) ?? (await this.pick('Open which recovery?'));
        return t ? this.open(t) : undefined;
      }),
      reg(RECOVERY_COMMANDS.resume, async (a?: unknown, b?: unknown) => {
        const t = recoveryTarget(a, b) ?? (await this.pick('Resume which task?'));
        return t ? this.resume(t) : undefined;
      }),
      reg(RECOVERY_COMMANDS.rollback, async (a?: unknown, b?: unknown) => {
        const t = recoveryTarget(a, b) ?? (await this.pick('Roll back the fixes of which task?'));
        return t ? this.rollback(t) : undefined;
      }),
    ];
  }

  private sessionRoot(sid: string): string | undefined {
    const wt = this.d.controller.store.get(sid)?.worktree;
    return wt ? path.join(wt.path, wt.subdir ?? '') : this.d.root();
  }

  private exists(sid: string): boolean {
    return !!this.d.controller.store.get(sid);
  }

  /** Open interventions and interrupted recoveries, newest first, as a quick pick. */
  private async pick(title: string): Promise<RecoveryTarget | undefined> {
    const items: (vscode.QuickPickItem & { target: RecoveryTarget })[] = [];
    const seen = new Set<string>();
    for (const i of this.d.healing.interrupted()) {
      seen.add(i.sid);
      items.push({ label: `$(debug-pause) ${this.d.controller.store.get(i.sid)?.title ?? i.sid}`, description: `interrupted · attempt ${i.attempt}/${i.max}${i.category ? ` · ${i.category.replace(/_/g, ' ')}` : ''}`, target: { sessionId: i.sid } });
    }
    for (const iv of await this.d.store.listInterventions().catch(() => [])) {
      if (!seen.has(iv.sessionId)) {
        seen.add(iv.sessionId);
        items.push({ label: `$(bell) ${iv.title}`, description: iv.reason.replace(/_/g, ' '), detail: iv.rootCause, target: { sessionId: iv.sessionId, interventionId: iv.id, ...(iv.taskId ? { taskId: iv.taskId } : {}) } });
      }
    }
    if (!items.length) {
      void vscode.window.showInformationMessage('No self-healing recovery needs your attention.');
      return undefined;
    }
    return (await vscode.window.showQuickPick(items, { title, matchOnDescription: true, matchOnDetail: true }))?.target;
  }

  async open(t: RecoveryTarget): Promise<boolean> {
    if (!this.exists(t.sessionId)) {
      void vscode.window.showWarningMessage('The chat of this recovery no longer exists. Its report is in the Dashboard\'s Human Intervention Queue.');
      this.d.showDashboard();
      return false;
    }
    await vscode.commands.executeCommand('localpilot.openSession', t.sessionId);
    return true;
  }

  /** Queue tasks go back to the queue with `resume` (Retry keeps the chat); other chats get the resume turn. */
  async resume(t: RecoveryTarget): Promise<boolean> {
    const task = queueTaskFor(this.d.queue, t);
    if (task && (task.status === 'incomplete' || task.status === 'needs_input' || task.status === 'failed' || task.status === 'cancelled')) {
      if (!this.d.queue.retry(task.id)) {
        void vscode.window.showWarningMessage('This task cannot be resumed right now.');
        return false;
      }
      if (this.d.queue.paused) {
        void vscode.window.showInformationMessage('Task requeued. The queue is paused — resume it to continue.', 'Resume Queue').then((r) => r && this.d.queue.setPaused(false));
      }
      return true;
    }
    if (!this.exists(t.sessionId)) {
      void vscode.window.showWarningMessage('This chat no longer exists — its recovery cannot be resumed.');
      return false;
    }
    if (this.d.controller.isRunning(t.sessionId)) {
      void vscode.window.showInformationMessage('This chat is still running — stop it before resuming the recovery.');
      return false;
    }
    await this.open(t);
    void this.d.controller.resumeRecovery(t.sessionId).catch((e) => this.d.log.warn(`Self-healing: resume failed: ${e instanceof Error ? e.message : String(e)}`));
    return true;
  }

  async rollback(t: RecoveryTarget, attempt?: number): Promise<boolean> {
    if (!this.exists(t.sessionId)) {
      void vscode.window.showWarningMessage('The chat of this recovery no longer exists, so its fixes cannot be rolled back from here.');
      return false;
    }
    const pick = await vscode.window.showWarningMessage(
      'Roll back the fixes self-healing applied in this task?',
      { modal: true, detail: 'Files LocalPilot changed during its fix attempts are restored to their content before the attempt. Files changed since by you or another agent are kept.' },
      'Roll Back'
    );
    if (pick !== 'Roll Back') {
      return false;
    }
    // Through the chat, which refuses while the chat runs, shows the result there and drops the interrupted card.
    await this.open(t);
    await this.d.controller.handle({ type: 'recoveryAction', sessionId: t.sessionId, action: 'rollback', ...(attempt ? { attempt } : {}) });
    return true;
  }

  /** Dashboard → Human Intervention Queue. `acceptRisk` arrives already confirmed by the panel. */
  async action(sessionId: string, action: RecoveryActionKind, interventionId?: string): Promise<boolean> {
    const t: RecoveryTarget = { sessionId, ...(interventionId ? { interventionId } : {}) };
    switch (action) {
      case 'resume':
      case 'approveInstall':
      case 'retry':
        return this.resume(t);
      case 'rollback':
        return this.rollback(t);
      case 'dismiss': {
        if (this.exists(sessionId)) {
          await this.d.controller.handle({ type: 'recoveryAction', sessionId, action: 'dismiss' });
        } else {
          await this.d.healing.dismiss(sessionId);
        }
        if (interventionId) {
          await this.d.store.resolveIntervention(interventionId);
        }
        return true;
      }
      case 'acceptRisk':
        return !!(await this.d.healing.acceptRisk(sessionId, 'user'));
      case 'openMergeEditor':
        if (!(await this.open(t))) {
          return false;
        }
        await this.d.controller.handle({ type: 'recoveryAction', sessionId, action: 'openMergeEditor' });
        return true;
      case 'setApiKey':
        this.d.showProviders();
        return true;
      case 'pickModel':
        await this.d.pickModel();
        return true;
      case 'startServer':
        return this.d.startServer();
      default:
        // openChat, inspect, installManually, restoreCheckpoint, retryWithGuidance: all happen in the chat.
        return this.open(t);
    }
  }

  /** Dashboard "Don't suggest again" / "Suggest again" on a failure-memory entry of the current workspace. */
  async memoryReuse(id: string, allowed: boolean): Promise<boolean> {
    const root = this.d.root();
    const m = root ? this.d.memory(root) : undefined;
    return m ? m.setReuse(id, allowed) : false;
  }

  /** Dashboard → Applied Patches → Open diff: the file before the attempt against the file now. */
  async openDiff(sessionId: string, attempt: number, file: string): Promise<void> {
    const root = this.sessionRoot(sessionId);
    if (!root) {
      throw new Error('no workspace folder for this chat');
    }
    const rel = path.isAbsolute(file) ? path.relative(root, file) : file;
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new Error(`${file} is outside the workspace`);
    }
    await vscode.commands.executeCommand('vscode.diff', recoverySnapshotUri(sessionId, attempt, rel), vscode.Uri.file(path.join(root, rel)), `${rel} (before fix attempt ${attempt}) ↔ now`);
  }

  /**
   * One notification after start-up for recoveries a closed window interrupted, unless the task queue resumes them
   * anyway. Follows `localpilot.notifications`: `off` never, `whenHidden` only while the chat is not on screen.
   */
  notifyInterrupted(chatVisible: boolean): void {
    const mode = getConfig().notifications;
    if (mode === 'off' || (mode === 'whenHidden' && chatVisible)) {
      return;
    }
    const resumedByQueue = new Set(this.d.queue.list.filter((t) => t.resume && t.status === 'queued' && t.sessionId).map((t) => t.sessionId!));
    const notice = interruptedNotice(this.d.healing.interrupted().filter((i) => this.exists(i.sid)), resumedByQueue);
    if (!notice) {
      return;
    }
    const single = notice.sids.length === 1 ? notice.sids[0] : undefined;
    const actions = single ? ['Resume', 'Open Chat'] : ['Choose…', 'Show Dashboard'];
    void vscode.window.showInformationMessage(notice.text, ...actions).then((pick) => {
      if (pick === 'Resume' && single) {
        return this.resume({ sessionId: single });
      }
      if (pick === 'Open Chat' && single) {
        return this.open({ sessionId: single });
      }
      if (pick === 'Choose…') {
        return vscode.commands.executeCommand(RECOVERY_COMMANDS.resume);
      }
      if (pick === 'Show Dashboard') {
        this.d.showDashboard();
      }
      return undefined;
    });
  }
}
