import * as vscode from 'vscode';

export interface SupervisedService {
  id: string;
  label: string;
  /** Whether to keep this service running now. `seenUp`: it answered at least once since the window opened. */
  wanted(seenUp: boolean): boolean;
  isUp(): Promise<boolean>;
  /** Starts the service in the background; resolves true once it answers. */
  start(): Promise<boolean>;
}

export interface ServiceState {
  id: string;
  label: string;
  wanted: boolean;
  up?: boolean;
  seenUp: boolean;
  /** Restarts that brought the service back this session. */
  restarts: number;
  /** Failed start attempts in a row; reset when the service answers. */
  failures: number;
  /** No more attempts until the user retries (too many failures in a row). */
  gaveUp: boolean;
  nextAttemptAt: number;
  lastError?: string;
}

/** Failed starts in a row before the supervisor stops trying and tells the user. */
export const MAX_FAILURES = 4;

/** Wait before the next start attempt after `failures` failed ones: 30 s, 1 min, 2 min, … capped at 15 min. */
export function backoffMs(failures: number): number {
  return Math.min(15 * 60_000, 30_000 * 2 ** Math.max(0, failures - 1));
}

/**
 * Keeps local support services (Ollama, Redis) running while VS Code is open. Every interval it checks each wanted
 * service and starts it again when it stopped, backing off after failures and giving up — with one notification —
 * after `MAX_FAILURES` in a row, so a service the user quit on purpose is not fought over. Ollama is only wanted
 * once it has been seen running (or holds the default model); Redis only when Redis storage is turned on.
 */
export class ServiceSupervisor implements vscode.Disposable {
  private readonly states = new Map<string, ServiceState>();
  private timer?: NodeJS.Timeout;
  private ticking = false;
  private disposed = false;
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;

  constructor(
    private readonly services: SupervisedService[],
    private readonly intervalMs: () => number,
    private readonly log?: vscode.LogOutputChannel,
    /** Called once when a service is given up on; `retry` re-arms it. */
    private readonly onGaveUp?: (s: ServiceState, retry: () => Promise<void>) => void,
    private readonly now: () => number = Date.now
  ) {
    for (const s of services) {
      this.states.set(s.id, { id: s.id, label: s.label, wanted: false, seenUp: false, restarts: 0, failures: 0, gaveUp: false, nextAttemptAt: 0 });
    }
  }

  get status(): ServiceState[] {
    return [...this.states.values()].map((s) => ({ ...s }));
  }

  start(): void {
    const loop = async () => {
      await this.tick();
      if (!this.disposed) {
        this.timer = setTimeout(loop, this.intervalMs());
      }
    };
    this.timer = setTimeout(loop, 5_000);
  }

  /** Forget failures and check again right away. */
  retry(id?: string): Promise<void> {
    for (const s of this.states.values()) {
      if (!id || s.id === id) {
        Object.assign(s, { failures: 0, gaveUp: false, nextAttemptAt: 0, lastError: undefined });
      }
    }
    return this.tick();
  }

  /** One supervision pass over every service. Exposed for tests and "check now". */
  async tick(): Promise<void> {
    if (this.ticking || this.disposed) {
      return;
    }
    this.ticking = true;
    try {
      for (const svc of this.services) {
        await this.check(svc);
      }
    } finally {
      this.ticking = false;
      this._onDidChange.fire();
    }
  }

  private async check(svc: SupervisedService): Promise<void> {
    const st = this.states.get(svc.id)!;
    const up = await svc.isUp().catch(() => false);
    st.up = up;
    if (up) {
      st.seenUp = true;
      st.failures = 0;
      st.gaveUp = false;
      st.lastError = undefined;
      st.wanted = svc.wanted(true);
      return;
    }
    st.wanted = svc.wanted(st.seenUp);
    if (!st.wanted || st.gaveUp || this.now() < st.nextAttemptAt) {
      return;
    }
    this.log?.info(`supervisor: ${svc.label} is not answering — starting it`);
    const ok = await svc.start().catch((e: unknown) => {
      st.lastError = e instanceof Error ? e.message : String(e);
      return false;
    });
    if (ok) {
      st.up = true;
      st.seenUp = true;
      st.restarts++;
      st.failures = 0;
      st.lastError = undefined;
      this.log?.info(`supervisor: ${svc.label} is running again`);
      return;
    }
    st.failures++;
    st.nextAttemptAt = this.now() + backoffMs(st.failures);
    this.log?.warn(`supervisor: could not start ${svc.label} (attempt ${st.failures}/${MAX_FAILURES})${st.lastError ? `: ${st.lastError}` : ''}`);
    if (st.failures >= MAX_FAILURES) {
      st.gaveUp = true;
      this.onGaveUp?.({ ...st }, () => this.retry(svc.id));
    }
  }

  dispose(): void {
    this.disposed = true;
    clearTimeout(this.timer);
    this._onDidChange.dispose();
  }
}
