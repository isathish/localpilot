import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import { Session } from '../types';
import type { TaskOutcome } from './healing/types';
import { nextWave } from './parallel';

/** `incomplete`: the run ended with checks still failing; `needs_input`: it stopped for a person (approval, credentials, conflict). */
export type QueueTaskStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled' | 'blocked' | 'incomplete' | 'needs_input';

export interface QueueTask {
  id: string;
  prompt: string;
  mode: Session['mode'];
  /** `provider/model`; empty = the router's choice for the chat. */
  model?: string;
  /** Ids of queue tasks that must finish successfully first. */
  dependsOn?: string[];
  status: QueueTaskStatus;
  /** The chat the task runs in, set as soon as it starts. */
  sessionId?: string;
  createdAt: number;
  startedAt?: number;
  endedAt?: number;
  error?: string;
  /** The self-healing outcome of the last run, when it reported one. */
  outcome?: TaskOutcome;
  /** The open human-intervention item the last run raised. */
  interventionId?: string;
  /** Continue in `sessionId` with a resume turn instead of sending the prompt again. */
  resume?: boolean;
}

export interface QueueTaskInput {
  prompt: string;
  mode?: Session['mode'];
  model?: string;
  dependsOn?: string[];
}

/** Runs one task as an agent chat. Calls `started` with the chat id first, then resolves when the run ends. */
export type QueueRunner = (task: QueueTask, started: (sessionId: string) => void) => Promise<QueueRunResult>;

export interface QueueRunResult {
  ok: boolean;
  error?: string;
  cancelled?: boolean;
  /** Missing when the run threw before reporting one (a final model failure): `ok` decides then. */
  outcome?: TaskOutcome;
  interventionId?: string;
  /** The run was stopped because the window is closing (`stop('shutdown')`): not recorded, so `load()` picks it up again. */
  shutdown?: boolean;
}

export interface TaskQueueOptions {
  /** Whether an interrupted task's chat has recovery state to continue from (synchronous: checked during `load()`). */
  resumable?: (sessionId: string) => boolean;
}

interface QueueFile {
  version: 1;
  paused: boolean;
  tasks: QueueTask[];
}

const FINISHED: ReadonlySet<QueueTaskStatus> = new Set(['done', 'failed', 'cancelled', 'blocked', 'incomplete', 'needs_input']);
/** Finished without success: dependents of these are blocked rather than run on a broken base. */
const UNSUCCESSFUL: ReadonlySet<QueueTaskStatus> = new Set(['failed', 'cancelled', 'blocked', 'incomplete', 'needs_input']);
/** Outcomes whose retry continues in the same chat, where the recovery state lives. */
const RESUMABLE: ReadonlySet<QueueTaskStatus> = new Set(['incomplete', 'needs_input']);

function statusFor(r: QueueRunResult): QueueTaskStatus {
  if (r.cancelled) {
    return 'cancelled';
  }
  switch (r.outcome) {
    case 'completed':
    case 'completed_unverified':
      return 'done';
    case 'incomplete':
      return 'incomplete';
    case 'blocked':
      return 'needs_input';
    case 'failed':
      return 'failed';
    case 'cancelled':
      return 'cancelled';
    default:
      return r.ok ? 'done' : 'failed';
  }
}

function errorFor(status: QueueTaskStatus, r: QueueRunResult): string | undefined {
  switch (status) {
    case 'done':
      return undefined;
    case 'cancelled':
      return r.error || 'Stopped by the user.';
    case 'incomplete':
      return r.error || 'The task ended with problems still unresolved.';
    case 'needs_input':
      return r.error || 'The task is waiting for your input.';
    default:
      return r.error || 'The agent stopped without an answer.';
  }
}

/**
 * Persistent agent task queue. Tasks run as ordinary chats, `concurrency()` at a time (1 = strictly sequential),
 * in the order they were added unless `dependsOn` says otherwise — scheduling uses the same dependency waves as
 * parallel checklists, so a failed prerequisite blocks its dependents instead of running them on a broken base.
 * The queue is saved after every change; tasks that were running when the window closed start again on load
 * (continuing their chat when `resumable` says it has recovery state). A run ended by shutdown is not recorded and
 * stays `running` on disk: either the queue is already disposed when it settles, or the runner reports `shutdown`
 * (so the result does not depend on whether the queue or the chat controller is disposed first).
 */
export class TaskQueue implements vscode.Disposable {
  private tasks: QueueTask[] = [];
  private _paused = false;
  private readonly running = new Set<string>();
  private writing: Promise<void> = Promise.resolve();
  private disposed = false;
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;

  constructor(
    private readonly file: string,
    private readonly runner: QueueRunner,
    private readonly concurrency: () => number,
    private readonly log?: vscode.LogOutputChannel,
    private readonly options: TaskQueueOptions = {}
  ) {}

  get list(): readonly QueueTask[] {
    return this.tasks;
  }
  get paused(): boolean {
    return this._paused;
  }
  get activeCount(): number {
    return this.running.size;
  }
  get pendingCount(): number {
    return this.tasks.filter((t) => t.status === 'queued').length;
  }

  /** Reads the saved queue; interrupted runs go back to `queued` (resumable ones keep their chat). Starts work unless the queue was paused. */
  async load(): Promise<void> {
    try {
      const raw = JSON.parse(await fs.readFile(this.file, 'utf8')) as Partial<QueueFile>;
      this._paused = !!raw.paused;
      this.tasks = (Array.isArray(raw.tasks) ? raw.tasks : [])
        .filter((t): t is QueueTask => !!t && typeof t.id === 'string' && typeof t.prompt === 'string')
        .map((t) => (t.status === 'running' ? this.requeueInterrupted(t) : t));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.log?.warn(`Task queue: could not read ${this.file}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    this.changed();
  }

  private requeueInterrupted(t: QueueTask): QueueTask {
    let resume = false;
    if (t.sessionId && this.options.resumable) {
      try {
        resume = this.options.resumable(t.sessionId);
      } catch (e) {
        this.log?.warn(`Task queue: could not check whether ${t.id} can resume: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    return resume ? { ...t, status: 'queued', resume: true, startedAt: undefined } : { ...t, status: 'queued', sessionId: undefined, startedAt: undefined, resume: undefined };
  }

  add(input: QueueTaskInput): QueueTask {
    const known = new Set(this.tasks.map((t) => t.id));
    const task: QueueTask = {
      id: `q_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      prompt: input.prompt.trim(),
      mode: input.mode ?? 'agent',
      model: input.model || undefined,
      dependsOn: input.dependsOn?.filter((d) => known.has(d)),
      status: 'queued',
      createdAt: Date.now(),
    };
    if (!task.dependsOn?.length) {
      delete task.dependsOn;
    }
    this.tasks.push(task);
    this.changed();
    return task;
  }

  /** Removes a waiting task, or marks a running one cancelled (the caller stops its chat). */
  cancel(id: string): QueueTask | undefined {
    const t = this.tasks.find((x) => x.id === id);
    if (!t || FINISHED.has(t.status)) {
      return undefined;
    }
    t.status = 'cancelled';
    t.endedAt = Date.now();
    this.changed();
    return t;
  }

  /** Puts a finished task (and anything it blocked) back in line; an incomplete or waiting one continues in its chat. */
  retry(id: string): boolean {
    const t = this.tasks.find((x) => x.id === id);
    // A cancelled task whose run is still winding down cannot start again yet: it would run twice.
    if (!t || !FINISHED.has(t.status) || t.status === 'done' || this.running.has(id)) {
      return false;
    }
    const again = new Set([id]);
    for (let grew = true; grew; ) {
      grew = false;
      for (const x of this.tasks) {
        if (x.status === 'blocked' && !again.has(x.id) && x.dependsOn?.some((d) => again.has(d))) {
          again.add(x.id);
          grew = true;
        }
      }
    }
    for (const x of this.tasks) {
      if (again.has(x.id)) {
        const resume = RESUMABLE.has(x.status) && !!x.sessionId;
        Object.assign(x, { status: 'queued', error: undefined, outcome: undefined, interventionId: undefined, startedAt: undefined, endedAt: undefined });
        x.resume = resume || undefined;
        if (!resume) {
          x.sessionId = undefined;
        }
      }
    }
    this.changed();
    return true;
  }

  remove(id: string): boolean {
    const t = this.tasks.find((x) => x.id === id);
    if (!t || t.status === 'running') {
      return false;
    }
    this.tasks = this.tasks.filter((x) => x !== t);
    this.changed();
    return true;
  }

  /** Drops every finished task; returns how many were removed. */
  clearFinished(): number {
    const before = this.tasks.length;
    this.tasks = this.tasks.filter((t) => !FINISHED.has(t.status));
    this.changed();
    return before - this.tasks.length;
  }

  setPaused(paused: boolean): void {
    this._paused = paused;
    this.changed();
  }

  private pumping = false;
  private repump = false;

  /** Starts whatever the dependency waves and the concurrency limit allow. */
  private pump(): void {
    if (this._paused || this.disposed) {
      return;
    }
    // A task's `started` callback re-enters through changed(): run once more afterwards instead of nesting.
    if (this.pumping) {
      this.repump = true;
      return;
    }
    this.pumping = true;
    try {
      this.pumpOnce();
    } finally {
      this.pumping = false;
    }
    if (this.repump) {
      this.repump = false;
      this.pump();
    }
  }

  private pumpOnce(): void {
    const pending = this.tasks.filter((t) => t.status === 'queued');
    if (!pending.length) {
      return;
    }
    const ids = new Set(this.tasks.map((t) => t.id));
    // A prerequisite removed from the queue no longer holds anything up.
    const satisfied = new Set([...this.tasks.filter((t) => t.status === 'done').map((t) => t.id), ...pending.flatMap((t) => t.dependsOn ?? []).filter((d) => !ids.has(d))]);
    const failed = new Set(this.tasks.filter((t) => UNSUCCESSFUL.has(t.status)).map((t) => t.id));
    const wave = nextWave(pending, satisfied, failed);
    let blockedAny = false;
    for (const t of [...wave.blocked, ...wave.cyclic]) {
      t.status = 'blocked';
      t.endedAt = Date.now();
      t.error = wave.cyclic.includes(t) ? 'Its dependencies wait on each other.' : 'A task it depends on did not finish.';
      blockedAny = true;
    }
    for (const t of wave.ready) {
      if (this.running.size >= Math.max(1, this.concurrency())) {
        break;
      }
      if (t.status !== 'queued') {
        continue;
      }
      this.start(t);
    }
    if (blockedAny) {
      // Newly blocked tasks may unblock nothing, but they can block others in turn.
      this.changed();
    }
  }

  /** The current run of each task: a finish from an older run (cancelled, then retried) must not touch the newer one. */
  private readonly runTokens = new Map<string, symbol>();

  private start(t: QueueTask): void {
    if (this.running.has(t.id)) {
      return;
    }
    t.status = 'running';
    t.startedAt = Date.now();
    this.running.add(t.id);
    const token = Symbol(t.id);
    this.runTokens.set(t.id, token);
    this.log?.info(`Task queue: starting ${t.id} (${t.mode}${t.model ? `, ${t.model}` : ''}): ${t.prompt.slice(0, 80)}`);
    const started = (sessionId: string) => {
      t.sessionId = sessionId;
      this.changed();
    };
    void this.runner(t, started)
      .catch((e: unknown): QueueRunResult => ({ ok: false, error: e instanceof Error ? e.message : String(e) }))
      .then((r) => {
        // Shutdown: the run was stopped by the window closing, not finished. Leave it `running` on disk for load().
        if (this.disposed || r.shutdown || this.runTokens.get(t.id) !== token) {
          return;
        }
        this.runTokens.delete(t.id);
        this.running.delete(t.id);
        if (t.status === 'running') {
          t.status = statusFor(r);
          t.error = errorFor(t.status, r);
          t.outcome = r.outcome;
          t.interventionId = r.interventionId;
        }
        delete t.resume;
        t.endedAt = Date.now();
        this.log?.info(`Task queue: ${t.id} ${t.status}${t.error ? ` — ${t.error}` : ''}`);
        this.changed();
      });
  }

  private changed(): void {
    if (this.disposed) {
      return;
    }
    this.pump();
    this.save();
    this._onDidChange.fire();
  }

  private save(): void {
    const body = JSON.stringify({ version: 1, paused: this._paused, tasks: this.tasks } satisfies QueueFile, null, 2);
    this.writing = this.writing.then(async () => {
      try {
        await fs.mkdir(path.dirname(this.file), { recursive: true });
        const tmp = `${this.file}.tmp`;
        await fs.writeFile(tmp, body, 'utf8');
        await fs.rename(tmp, this.file);
      } catch (e) {
        this.log?.warn(`Task queue: could not save: ${e instanceof Error ? e.message : String(e)}`);
      }
    });
  }

  /** Resolves once every pending write has reached disk (tests, shutdown). */
  flush(): Promise<void> {
    return this.writing;
  }

  dispose(): void {
    this.disposed = true;
    this._onDidChange.dispose();
  }
}
