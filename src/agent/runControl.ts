import { ChatMessage } from '../types';

export type RunControlListener = (source: RunControl) => void;

/**
 * Pause / resume / stop / steer handle for one agent run and, through `child()`, for its subagents.
 *
 * - `pause()` is cooperative: the loop finishes the step it is in (model call or tool batch) and then holds
 *   at the next boundary until `resume()`. `holding` tells whether it has actually reached that boundary.
 * - Pausing or stopping a control also pauses or stops every descendant; a child can be paused or stopped on
 *   its own without touching its parent, which then receives a "stopped by the user" report for it.
 * - `steer()` queues a user message that the loop appends to the conversation at the next boundary, so the
 *   user can redirect a running (or paused) agent without stopping it.
 */
export class RunControl {
  private readonly ac = new AbortController();
  /** Removes this control's listeners from the upstream/parent signals (see link in the constructor). */
  private readonly unlink: (() => void)[] = [];
  private ownPaused = false;
  private _holding = false;
  private readonly listeners = new Set<RunControlListener>();
  private readonly waiters = new Set<() => void>();
  private readonly queue: ChatMessage[] = [];
  private closed = false;
  private readonly endListeners = new Set<() => void>();
  readonly children = new Map<string, RunControl>();
  /** Set by the loop while it is actually holding at a step boundary (as opposed to a pause being requested). */
  get holding(): boolean {
    return this._holding;
  }

  constructor(
    readonly id: string,
    readonly parent?: RunControl,
    /** External signal (e.g. a caller's AbortController) that also stops this run. */
    upstream?: AbortSignal,
    /** Shown in UIs for subagent controls. */
    readonly label?: string
  ) {
    const link = (s: AbortSignal | undefined): void => {
      if (!s) {
        return;
      }
      if (s.aborted) {
        this.ac.abort(s.reason);
      } else {
        const relay = () => this.ac.abort(s.reason);
        s.addEventListener('abort', relay, { once: true });
        // Removed on dispose: a stopped or finished lane must not stay attached to its parent's signal.
        this.unlink.push(() => s.removeEventListener('abort', relay));
      }
    };
    link(upstream);
    if (parent) {
      link(parent.signal);
      parent.children.set(id, this);
    }
  }

  get signal(): AbortSignal {
    return this.ac.signal;
  }

  get aborted(): boolean {
    return this.ac.signal.aborted;
  }

  /** Paused by itself or by any ancestor. */
  get paused(): boolean {
    return this.ownPaused || !!this.parent?.paused;
  }

  /** Paused by an explicit call on this control (not inherited). */
  get pausedBySelf(): boolean {
    return this.ownPaused;
  }

  get pendingSteering(): number {
    return this.queue.length;
  }

  pause(): void {
    if (!this.ownPaused && !this.aborted) {
      this.ownPaused = true;
      this.notify();
    }
  }

  resume(): void {
    if (this.ownPaused) {
      this.ownPaused = false;
      this.notify();
    }
  }

  togglePause(): boolean {
    if (this.ownPaused) {
      this.resume();
    } else {
      this.pause();
    }
    return this.ownPaused;
  }

  stop(reason = 'cancelled'): void {
    if (!this.aborted) {
      this.ac.abort(new Error(reason));
      this.notify();
    }
  }

  /** Queue a user message for the loop to append at its next step boundary; false once the run has ended or was stopped. */
  steer(message: ChatMessage): boolean {
    if (this.closed || this.aborted) {
      return false;
    }
    this.queue.push(message);
    this.notify();
    return true;
  }

  /** Messages queued by `steer()` that the loop has not taken yet, oldest first. */
  pendingSteers(): readonly ChatMessage[] {
    return [...this.queue];
  }

  /** Withdraw a steer the loop has not injected yet (matched on `meta.steerId`); returns it, or undefined when it is gone. */
  removeSteer(steerId: string): ChatMessage | undefined {
    const i = this.queue.findIndex((m) => m.meta?.steerId === steerId);
    if (i < 0) {
      return undefined;
    }
    const [removed] = this.queue.splice(i, 1);
    this.notify();
    return removed;
  }

  takeSteering(): ChatMessage[] {
    return this.queue.splice(0);
  }

  /** The run has ended: refuse further steering and return the messages the loop never took. */
  close(): ChatMessage[] {
    this.end();
    return this.queue.splice(0);
  }

  /** True once the run has ended (closed or disposed): `steer()` refuses from then on. */
  get ended(): boolean {
    return this.closed;
  }

  /** Called once when the run ends (`close()` or `dispose()`); immediately when it already has. Returns an unsubscribe. */
  onEnd(listener: () => void): () => void {
    if (this.closed) {
      listener();
      return () => {};
    }
    this.endListeners.add(listener);
    return () => this.endListeners.delete(listener);
  }

  private end(): void {
    this.closed = true;
    const ls = [...this.endListeners];
    this.endListeners.clear();
    ls.forEach((l) => l());
  }

  /** Listeners fire for changes on this control and on any descendant (the changed control is passed). */
  onDidChange(listener: RunControlListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Create and register a child control (subagent). Disposed by the child when its run ends. */
  child(id: string, label?: string): RunControl {
    return new RunControl(id, this, undefined, label);
  }

  /** Find this control or a descendant by id. */
  find(id: string): RunControl | undefined {
    if (id === this.id) {
      return this;
    }
    for (const c of this.children.values()) {
      const hit = c.find(id);
      if (hit) {
        return hit;
      }
    }
    return undefined;
  }

  /** Every descendant, depth-first. */
  descendants(): RunControl[] {
    const out: RunControl[] = [];
    for (const c of this.children.values()) {
      out.push(c, ...c.descendants());
    }
    return out;
  }

  /**
   * Returns immediately while running; otherwise holds until resumed or stopped. Never throws — callers
   * check `aborted` afterwards, as they already do for the signal.
   */
  async waitWhilePaused(): Promise<void> {
    if (!this.paused || this.aborted) {
      return;
    }
    this._holding = true;
    this.notify();
    try {
      while (this.paused && !this.aborted) {
        await new Promise<void>((resolve) => this.waiters.add(resolve));
      }
    } finally {
      this._holding = false;
      this.notify();
    }
  }

  dispose(): void {
    this.end();
    this.unlink.splice(0).forEach((f) => f());
    this.parent?.children.delete(this.id);
    this.listeners.clear();
    this.wake();
  }

  /** Bubble the change up to every ancestor's listeners and wake waiters on this subtree. */
  private notify(): void {
    this.fire(this);
    this.wake();
  }

  private fire(source: RunControl): void {
    for (const l of [...this.listeners]) {
      l(source);
    }
    this.parent?.fire(source);
  }

  private wake(): void {
    const w = [...this.waiters];
    this.waiters.clear();
    for (const resolve of w) {
      resolve();
    }
    for (const c of this.children.values()) {
      c.wake();
    }
  }
}
