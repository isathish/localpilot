// IndexClient (design §6.1): the main thread's view of the index. `WorkerIndexClient` talks to dist/continuityWorker.js
// over postMessage; `LocalIndexClient` runs the same engine in-process (tests, and a fallback when the worker file is
// missing). Both expose the same async API. Pure Node.
import * as fs from 'fs';
import { Worker } from 'worker_threads';
import type { EntityKind } from '../../events';
import { Emitter, Subscribable } from '../eventLog';
import { AppliedNotice, EngineOptions, IndexEngine, IndexState, IndexStatus } from './engine';
import type * as Q from './queries';
import { dispatch, IndexMethod } from './rpc';

export interface IndexProgress {
  state: IndexState;
  progress?: number;
  events: number;
}

export interface IndexClient {
  readonly ready: Promise<void>;
  readonly onProgress: Subscribable<IndexProgress>;
  readonly onApplied: Subscribable<AppliedNotice>;
  status(): Promise<IndexStatus>;
  history(q: Q.IndexHistoryQuery): Promise<Q.IndexHistoryPage>;
  counts(projectId?: string): Promise<Q.NavCounts>;
  search(q: Q.SearchQuery | string): Promise<Q.SearchHit[]>;
  searchMemory(text: string, o?: { projectId?: string; limit?: number }): Promise<Q.SearchHit[]>;
  conversation(id: string): Promise<Q.ConversationRow | undefined>;
  messages(conversationId: string, branchId?: string): Promise<Q.MessageRow[]>;
  branches(conversationId: string): Promise<Q.BranchRow[]>;
  memory(q: Q.MemoryQuery): Promise<Q.MemoryRow[]>;
  versions(ent: EntityKind, id: string): Promise<Q.VersionRow[]>;
  query<T = unknown>(name: Q.NamedQuery, params?: Record<string, unknown>): Promise<T[]>;
  /** Applies new events now (after this process appended some). */
  catchUp(): Promise<number>;
  rebuild(): Promise<void>;
  persist(): Promise<boolean>;
  pruneVersions(days: number): Promise<number>;
  syncEvent(row: { at: number; kind: string; remote?: string; uploaded?: number; downloaded?: number; bytes?: number; error?: string }): Promise<void>;
  dispose(): Promise<void>;
}

abstract class BaseClient implements IndexClient {
  abstract readonly ready: Promise<void>;
  protected readonly progressEmitter = new Emitter<IndexProgress>();
  protected readonly appliedEmitter = new Emitter<AppliedNotice>();
  readonly onProgress = this.progressEmitter.event;
  readonly onApplied = this.appliedEmitter.event;
  protected abstract call<T>(method: IndexMethod, ...args: unknown[]): Promise<T>;
  status() {
    return this.call<IndexStatus>('status');
  }
  history(q: Q.IndexHistoryQuery) {
    return this.call<Q.IndexHistoryPage>('history', q);
  }
  counts(projectId?: string) {
    return this.call<Q.NavCounts>('counts', projectId);
  }
  search(q: Q.SearchQuery | string) {
    return this.call<Q.SearchHit[]>('search', q);
  }
  searchMemory(text: string, o?: { projectId?: string; limit?: number }) {
    return this.call<Q.SearchHit[]>('searchMemory', text, o ?? {});
  }
  conversation(id: string) {
    return this.call<Q.ConversationRow | undefined>('conversation', id);
  }
  messages(conversationId: string, branchId?: string) {
    return this.call<Q.MessageRow[]>('messages', conversationId, branchId);
  }
  branches(conversationId: string) {
    return this.call<Q.BranchRow[]>('branches', conversationId);
  }
  memory(q: Q.MemoryQuery) {
    return this.call<Q.MemoryRow[]>('memory', q);
  }
  versions(ent: EntityKind, id: string) {
    return this.call<Q.VersionRow[]>('versions', ent, id);
  }
  query<T = unknown>(name: Q.NamedQuery, params: Record<string, unknown> = {}) {
    return this.call<T[]>('query', name, params);
  }
  catchUp() {
    return this.call<number>('catchUp');
  }
  async rebuild() {
    await this.call('rebuild');
  }
  persist() {
    return this.call<boolean>('persist', true);
  }
  pruneVersions(days: number) {
    return this.call<number>('pruneVersions', days);
  }
  async syncEvent(row: { at: number; kind: string; remote?: string; uploaded?: number; downloaded?: number; bytes?: number; error?: string }) {
    await this.call('syncEvent', row);
  }
  abstract dispose(): Promise<void>;
}

export type ClientOptions = Omit<EngineOptions, 'onProgress' | 'onApplied'>;

/** The engine in this thread. */
export class LocalIndexClient extends BaseClient {
  readonly engine: IndexEngine;
  readonly ready: Promise<void>;

  constructor(o: ClientOptions) {
    super();
    this.engine = new IndexEngine({ ...o, onProgress: (p) => this.progressEmitter.fire(p), onApplied: (n) => this.appliedEmitter.fire(n) });
    this.ready = this.engine.init();
    this.ready.catch(() => undefined);
  }

  protected async call<T>(method: IndexMethod, ...args: unknown[]): Promise<T> {
    await this.ready;
    // Structured clone, as across the worker boundary, so callers never share rows with the engine.
    return structuredClone(dispatch(this.engine, method, args)) as T;
  }

  async dispose(): Promise<void> {
    await this.ready.catch(() => undefined);
    this.engine.dispose();
  }
}

/** The engine in a worker thread (dist/continuityWorker.js). */
export class WorkerIndexClient extends BaseClient {
  readonly ready: Promise<void>;
  private readonly worker: Worker;
  private seq = 0;
  private readonly calls = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private closed = false;

  constructor(workerPath: string, o: ClientOptions) {
    super();
    const { log, now: _now, sqlJs: _sql, ...data } = o;
    void _now;
    void _sql;
    this.worker = new Worker(workerPath, { workerData: data });
    // The worker keeps the process alive only while something waits for it (start-up, a pending call).
    this.worker.ref();
    let readyResolve!: () => void;
    let readyReject!: (e: Error) => void;
    this.ready = new Promise<void>((res, rej) => {
      readyResolve = res;
      readyReject = rej;
    });
    this.ready.catch(() => undefined);
    this.worker.on('message', (m: { id?: number; ok?: boolean; result?: unknown; error?: string; event?: string; level?: 'info' | 'warn' | 'error'; message?: string } & Record<string, unknown>) => {
      if (m.event === 'ready') {
        readyResolve();
        this.updateRef();
      } else if (m.event === 'failed') {
        readyReject(new Error(String(m.error)));
      } else if (m.event === 'progress') {
        this.progressEmitter.fire(m as unknown as IndexProgress);
      } else if (m.event === 'applied') {
        this.appliedEmitter.fire(m as unknown as AppliedNotice);
      } else if (m.event === 'log') {
        log?.(m.level ?? 'info', String(m.message));
      } else if (typeof m.id === 'number') {
        const c = this.calls.get(m.id);
        this.calls.delete(m.id);
        this.updateRef();
        if (c) {
          if (m.ok) {
            c.resolve(m.result);
          } else {
            c.reject(new Error(String(m.error)));
          }
        }
      }
    });
    const fail = (e: Error) => {
      readyReject(e);
      for (const c of this.calls.values()) {
        c.reject(e);
      }
      this.calls.clear();
      this.closed = true;
    };
    this.worker.on('error', (e) => fail(e));
    this.worker.on('exit', (code) => fail(new Error(`index worker exited (${code})`)));
  }

  private started = false;
  private updateRef(): void {
    if (this.closed) {
      return;
    }
    this.started = true;
    if (this.calls.size) {
      this.worker.ref();
    } else {
      this.worker.unref();
    }
  }

  protected call<T>(method: IndexMethod, ...args: unknown[]): Promise<T> {
    if (this.closed) {
      return Promise.reject(new Error('index worker is not running'));
    }
    const id = ++this.seq;
    return new Promise<T>((resolve, reject) => {
      this.calls.set(id, { resolve: resolve as (v: unknown) => void, reject });
      if (this.started) {
        this.worker.ref();
      }
      this.worker.postMessage({ id, method, args });
    });
  }

  async dispose(): Promise<void> {
    if (this.closed) {
      return;
    }
    await Promise.race([this.call('dispose').catch(() => undefined), new Promise((r) => setTimeout(r, 5000).unref?.())]);
    this.closed = true;
    await this.worker.terminate().catch(() => undefined);
  }
}

/** A worker client when the worker file exists, else the in-process engine. */
export function createIndexClient(workerPath: string | undefined, o: ClientOptions): IndexClient {
  if (workerPath && fs.existsSync(workerPath)) {
    return new WorkerIndexClient(workerPath, o);
  }
  return new LocalIndexClient(o);
}
