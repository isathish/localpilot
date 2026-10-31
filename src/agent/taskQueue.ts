import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import { Session } from '../types';
import { nextWave } from './parallel';

export type QueueTaskStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled' | 'blocked';

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
}

export interface QueueTaskInput {
  prompt: string;
  mode?: Session['mode'];
  model?: string;
  dependsOn?: string[];
}

/** Runs one task as an agent chat. Calls `started` with the chat id first, then resolves when the run ends. */
export type QueueRunner = (task: QueueTask, started: (sessionId: string) => void) => Promise<{ ok: boolean; error?: string }>;

interface QueueFile {
  version: 1;
  paused: boolean;
  tasks: QueueTask[];
}

const FINISHED: ReadonlySet<QueueTaskStatus> = new Set(['done', 'failed', 'cancelled', 'blocked']);

/**
 * Persistent agent task queue. Tasks run as ordinary chats, `concurrency()` at a time (1 = strictly sequential),
 * in the order they were added unless `dependsOn` says otherwise — scheduling uses the same dependency waves as
 * parallel checklists, so a failed prerequisite blocks its dependents instead of running them on a broken base.
 * The queue is saved after every change; tasks that were running when the window closed start again on load.
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
    private readonly log?: vscode.LogOutputChannel
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

  /** Reads the saved queue; interrupted runs go back to `queued`. Starts work unless the queue was paused. */
  async load(): Promise<void> {
    try {
      const raw = JSON.parse(await fs.readFile(this.file, 'utf8')) as Partial<QueueFile>;
      this._paused = !!raw.paused;
      this.tasks = (Array.isArray(raw.tasks) ? raw.tasks : [])
        .filter((t): t is QueueTask => !!t && typeof t.id === 'string' && typeof t.prompt === 'string')
        .map((t) => (t.status === 'running' ? { ...t, status: 'queued', sessionId: undefined, startedAt: undefined } : t));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.log?.warn(`Task queue: could not read ${this.file}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    this.changed();
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

  /** Puts a finished task (and anything it blocked) back in line. */
  retry(id: string): boolean {
    const t = this.tasks.find((x) => x.id === id);
    if (!t || !FINISHED.has(t.status) || t.status === 'done') {
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
        Object.assign(x, { status: 'queued', error: undefined, sessionId: undefined, startedAt: undefined, endedAt: undefined });
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

  /** Starts whatever the dependency waves and the concurrency limit allow. */
  private pump(): void {
    if (this._paused || this.disposed) {
      return;
    }
    const pending = this.tasks.filter((t) => t.status === 'queued');
    if (!pending.length) {
      return;
    }
    const ids = new Set(this.tasks.map((t) => t.id));
    // A prerequisite removed from the queue no longer holds anything up.
    const satisfied = new Set([...this.tasks.filter((t) => t.status === 'done').map((t) => t.id), ...pending.flatMap((t) => t.dependsOn ?? []).filter((d) => !ids.has(d))]);
    const failed = new Set(this.tasks.filter((t) => t.status === 'failed' || t.status === 'cancelled' || t.status === 'blocked').map((t) => t.id));
    const wave = nextWave(pending, satisfied, failed);
    let blockedAny = false;
    for (const t of [...wave.blocked, ...wave.cyclic]) {
      t.status = 'blocked';
      t.endedAt = Date.now();
      t.error = wave.cyclic.includes(t) ? 'Its dependencies wait on each other.' : 'A task it depends on did not finish.';
      blockedAny = true;
    }
    const slots = Math.max(1, this.concurrency()) - this.running.size;
    for (const t of wave.ready.slice(0, Math.max(0, slots))) {
      this.start(t);
    }
    if (blockedAny) {
      // Newly blocked tasks may unblock nothing, but they can block others in turn.
      this.changed();
    }
  }

  private start(t: QueueTask): void {
    t.status = 'running';
    t.startedAt = Date.now();
    this.running.add(t.id);
    this.log?.info(`Task queue: starting ${t.id} (${t.mode}${t.model ? `, ${t.model}` : ''}): ${t.prompt.slice(0, 80)}`);
    const started = (sessionId: string) => {
      t.sessionId = sessionId;
      this.changed();
    };
    void this.runner(t, started)
      .catch((e: unknown) => ({ ok: false, error: e instanceof Error ? e.message : String(e) }))
      .then((r) => {
        this.running.delete(t.id);
        if (t.status === 'running') {
          t.status = r.ok ? 'done' : 'failed';
          t.error = r.ok ? undefined : r.error || 'The agent stopped without an answer.';
        }
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
