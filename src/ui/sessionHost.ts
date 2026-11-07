// The host side of continuity's SESSION module (design §9.3, §13, §16.2), shared by VS Code and the CLI: connects the
// SessionManager's RunBridge to the agent loop (`sessionHooks`), the CheckpointService (`onSnapshot` / `onRestore`),
// the RecoveryStore (`onSave`) and the TraceStore (`onAdd`); answers the Run interrupted card ("What ran", "Changed
// files", the checkpoint), adopts partial answers kept in drafts, and builds the Checkpoints page's data. The command
// `localpilot.continuity.openCheckpoints` is registered with the other continuity commands in continuityHost.ts.
import type { AgentRunner } from '../agent/agentLoop';
import type { CheckpointService } from '../agent/checkpoints';
import type { RecoveryStore } from '../agent/healing/recoveryStore';
import type { Continuity } from '../continuity/continuity';
import type { CheckpointRow } from '../continuity/session/crashRecovery';
import type { SessionManager } from '../continuity/session/sessionManager';
import type { SessionStore } from '../sessions/sessionStore';
import type { TraceStore } from '../telemetry/traceStore';
import type { ChatMessage, ModelInfo, Session } from '../types';
import type { ChatSessionRuns, RunInterruptedState } from './chatController';

export interface SessionHostDeps {
  runner: AgentRunner;
  checkpoints?: CheckpointService;
  recovery?: RecoveryStore;
  traces?: TraceStore;
  /** The chat a session id names (checkpoint entities of turns taken before 1.7, on restore). */
  sessionOf?: (id: string) => Session | undefined;
  /** Known models (local or cloud, window) for model sessions. */
  models?: () => ModelInfo[];
  log: { warn(m: string): void; debug?(m: string): void };
}

/** Starts the SESSION module and wires its hooks; the returned disposable unhooks everything. */
export function attachSessions(c: Continuity, d: SessionHostDeps): { manager?: SessionManager; dispose(): void } {
  const mgr = c.attachSessions({
    modelInfo: (id) => {
      const m = d.models?.().find((x) => x.id === id);
      return m ? { local: !m.remote, window: m.contextWindow } : undefined;
    },
    warn: (m) => d.log.warn(m),
  });
  if (!mgr) {
    return { dispose: () => undefined };
  }
  const bridge = mgr.bridge;
  d.runner.sessionHooks = bridge;
  const cps = d.checkpoints;
  if (cps) {
    cps.onSnapshot = (s, e) => bridge.checkpoint(s, e);
    cps.onRestore = (sid, run) => bridge.restored(sid, run, d.sessionOf?.(sid)?.checkpoints?.history.find((e) => e.run === run));
  }
  if (d.recovery) {
    d.recovery.onSave = (st) => bridge.recovery(st);
  }
  if (d.traces) {
    d.traces.onAdd = (t) => bridge.traceAdded(t);
  }
  return {
    manager: mgr,
    dispose: () => {
      if (d.runner.sessionHooks === bridge) {
        d.runner.sessionHooks = undefined;
      }
      if (cps) {
        cps.onSnapshot = undefined;
        cps.onRestore = undefined;
      }
      if (d.recovery) {
        d.recovery.onSave = undefined;
      }
      if (d.traces) {
        d.traces.onAdd = undefined;
      }
    },
  };
}

/** What the chat controller asks of the SESSION module (Run interrupted card, partial answers). */
export function chatSessionRuns(mgr: () => SessionManager | undefined, ready: () => Promise<boolean>): ChatSessionRuns {
  return {
    details: async (sessionId) => {
      const m = mgr();
      if (!m || !(await ready())) {
        return undefined;
      }
      return runDetails(m, sessionId);
    },
    takePartial: (session: Session): ChatMessage | undefined => mgr()?.takePartial(session),
  };
}

/** The Run interrupted card's details: what the run did (last 12 steps), the files it changed, its checkpoint. */
export async function runDetails(m: SessionManager, conversationId: string, limit = 12): Promise<Pick<RunInterruptedState, 'ran' | 'ranMore' | 'changed' | 'checkpoint'> | undefined> {
  const r = await m.interruptedRun(conversationId, limit);
  if (!r) {
    return undefined;
  }
  const changed = r.checkpoint?.files.length ? r.checkpoint.files : r.agentSession.filesTouched.map((p) => ({ path: p, status: 'M' as const }));
  return {
    ran: r.events.map((e) => ({ kind: e.kind, name: e.name, ...(e.status ? { status: e.status } : {}), ...(e.detail ? { detail: e.detail } : {}), ...(e.error ? { error: e.error } : {}), start: e.start, ...(e.end ? { end: e.end } : {}) })),
    ranMore: r.more,
    changed,
    ...(r.checkpoint ? { checkpoint: { run: r.checkpoint.run, kind: r.checkpoint.kind, createdAt: r.checkpoint.createdAt } } : {}),
  };
}

export interface CheckpointPageRow {
  id: string;
  conversationId: string;
  title: string;
  run: number;
  kind?: string;
  createdAt: number;
  restoredAt?: number;
  files: CheckpointRow['files'];
  root?: string;
  /** Taken on this computer (its content is here: git refs, file snapshots). */
  thisDevice: boolean;
  /** Another device's name (short id until the sync device registry names it). */
  device?: string;
  /** Content synced with the checkpoint (`checkpointContents`): restorable on any device. */
  hasContent: boolean;
  /** The chat is in this window's store and still has that turn: View changes / Restore work here. */
  available: boolean;
  /** Why not (shown on the row). */
  why?: string;
}

/** Checkpoints page data (§16.2): this project's checkpoints (or every project's), newest first, with what can be done. */
export async function checkpointsPageData(c: Continuity, store: SessionStore, params: Record<string, unknown>, currentProject: string | undefined): Promise<unknown> {
  const mgr = c.sessions;
  if (!mgr) {
    return { off: 'starting' };
  }
  const all = params.all === true || !currentProject;
  const rows = await mgr.checkpoints(all ? {} : { projectId: currentProject });
  const titles = new Map<string, string>();
  const out: CheckpointPageRow[] = [];
  for (const r of rows.slice(0, 200)) {
    if (!titles.has(r.conversationId)) {
      const s = store.has(r.conversationId) ? store.get(r.conversationId) : undefined;
      titles.set(r.conversationId, s?.title ?? (await c.index.conversation(r.conversationId).catch(() => undefined))?.title ?? '');
    }
    const thisDevice = !r.device || r.device === c.device.deviceId;
    const s = store.has(r.conversationId) ? store.get(r.conversationId) : undefined;
    const turn = s?.messages.some((m) => m.role === 'user' && m.meta?.checkpoint === r.run);
    const why = !thisDevice && !r.contentBlob ? 'content on another device' : !s ? 'chat not in this window' : !turn ? 'turn no longer in the chat' : undefined;
    out.push({
      id: r.id,
      conversationId: r.conversationId,
      title: titles.get(r.conversationId) ?? '',
      run: r.run,
      kind: r.kind,
      createdAt: r.createdAt,
      ...(r.restoredAt ? { restoredAt: r.restoredAt } : {}),
      files: r.files,
      ...(r.root ? { root: r.root } : {}),
      thisDevice,
      ...(thisDevice ? {} : { device: (r.device ?? '').replace(/^dev_/, '').slice(0, 8) }),
      hasContent: !!r.contentBlob,
      available: !why,
      ...(why ? { why } : {}),
    });
  }
  return { rows: out, all, project: currentProject, total: rows.length };
}

/** The user message of a chat whose turn a checkpoint was taken before (Restore from the Checkpoints page). */
export function checkpointMessageIndex(s: Session, run: number): number {
  for (let i = s.messages.length - 1; i >= 0; i--) {
    const m = s.messages[i];
    if (m.role === 'user' && m.meta?.checkpoint === run) {
      return i;
    }
  }
  return -1;
}
