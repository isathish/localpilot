// SessionManager (SESSION, design §2.1 `Continuity.sessions`): agent runs, what they did, the checkpoints taken before
// them and the models that answered, linked by id to their conversation. Owns the RunBridge (writes), the DraftStore
// (partial answers) and crash recovery; answers the Run interrupted card, the Checkpoints page and the CLI.
// Pure Node (no vscode).
import type { Session, ChatMessage } from '../../types';
import type { BlobStore } from '../data/blobs';
import { Emitter } from '../data/eventLog';
import type { FileEventLog } from '../data/eventLog';
import type { IndexClient } from '../data/index/indexClient';
import {
  agentSessionRow,
  AgentSessionRow,
  checkpointRow,
  CheckpointRow,
  executionEventRow,
  ExecutionEventRow,
  interruptedRun,
  InterruptedRun,
  markInterrupted,
  modelSessionRow,
  ModelSessionRow,
  WriterCheck,
} from './crashRecovery';
import { Draft, DraftStore, partialFromDraft } from './drafts';
import { CaptureMode, RunBridge } from './runBridge';

export interface SessionManagerOptions {
  log: FileEventLog;
  index: IndexClient;
  blobs: BlobStore;
  /** Data root (drafts, stream leases). */
  root: string;
  /** Index caught up and the 1.6 import settled. */
  ready: Promise<unknown>;
  capture: () => CaptureMode;
  now?: () => number;
  modelInfo?: (modelId: string) => { local?: boolean; window?: number } | undefined;
  projectOf?: (root: string) => string | undefined;
  /** Tests: draft write period. */
  draftIntervalMs?: number;
  warn?: (m: string) => void;
}

export interface SessionsChange {
  /** Conversations whose runs, checkpoints or model sessions changed in another process or on another device. */
  conversations: string[];
}

export class SessionManager {
  readonly bridge: RunBridge;
  readonly drafts: DraftStore;
  private readonly changed = new Emitter<SessionsChange>();
  readonly onRemoteChange = this.changed.event;
  private readonly subs: { dispose(): void }[] = [];
  /** The scan in progress (callers at the same time share it; the next call scans again). */
  private scanning?: Promise<AgentSessionRow[]>;

  constructor(private readonly o: SessionManagerOptions) {
    this.drafts = new DraftStore({ root: o.root, stream: o.log.stream, now: o.now, intervalMs: o.draftIntervalMs, warn: o.warn });
    this.bridge = new RunBridge({
      log: o.log,
      blobs: o.blobs,
      deviceId: o.log.device.deviceId,
      capture: o.capture,
      drafts: this.drafts,
      now: o.now,
      modelInfo: o.modelInfo,
      projectOf: o.projectOf,
      lastModelSession: async (conv) => {
        const rows = await this.modelSessions(conv).catch(() => []);
        const open = rows.filter((r) => !r.endedAt).pop();
        return open ? { id: open.id, model: open.model, promptTokens: open.promptTokens, completionTokens: open.completionTokens } : undefined;
      },
      warn: o.warn,
    });
    this.subs.push(
      o.index.onApplied((n) => {
        if (n.remoteEntities > 0 && n.remoteConversations.length) {
          this.changed.fire({ conversations: n.remoteConversations });
        }
      })
    );
  }

  private get writer(): WriterCheck {
    return { root: this.o.root, deviceId: this.o.log.device.deviceId, ownStream: this.o.log.stream, isActive: (id) => this.bridge.isActive(id), now: this.o.now };
  }

  /**
   * Crash recovery (after the index caught up): runs whose writer died become `interrupted`. Run at start and again
   * whenever a card or the CLI asks (another window or the CLI may have died since); one query when nothing is running.
   */
  recoverInterrupted(): Promise<AgentSessionRow[]> {
    if (this.scanning) {
      return this.scanning;
    }
    this.scanning = (async () => {
      await this.o.ready;
      // Other processes' latest events first (a window that just died wrote its last ones a moment ago).
      await this.o.index.catchUp().catch(() => 0);
      const out = await markInterrupted(this.o.index, this.o.log, this.writer);
      if (out.length) {
        await this.o.log.flush();
        await this.o.index.catchUp().catch(() => 0);
      }
      return out;
    })()
      .catch((e) => {
        this.o.warn?.(`continuity: crash recovery: ${e instanceof Error ? e.message : String(e)}`);
        return [] as AgentSessionRow[];
      })
      .finally(() => (this.scanning = undefined));
    return this.scanning;
  }

  /** A conversation's runs, newest first. */
  async runs(conversationId: string): Promise<AgentSessionRow[]> {
    return (await this.o.index.query<Record<string, unknown>>('agentSessions', { conversationId })).map(agentSessionRow);
  }

  /** What one run did, in order. */
  async events(agentSessionId: string): Promise<ExecutionEventRow[]> {
    return (await this.o.index.query<Record<string, unknown>>('executionEvents', { agentSessionId })).map(executionEventRow);
  }

  /** Checkpoints of a conversation, of a project, or of every project; newest first. */
  async checkpoints(q: { projectId?: string; conversationId?: string } = {}): Promise<CheckpointRow[]> {
    const p = q.conversationId ? { conversationId: q.conversationId } : q.projectId && q.projectId !== 'all' ? { projectId: q.projectId } : {};
    return (await this.o.index.query<Record<string, unknown>>('checkpoints', p)).map(checkpointRow);
  }

  /** The models that answered a conversation, oldest first. */
  async modelSessions(conversationId: string): Promise<ModelSessionRow[]> {
    return (await this.o.index.query<Record<string, unknown>>('modelSessions', { conversationId })).map(modelSessionRow);
  }

  /** Every run that did not finish (after crash recovery), newest first. */
  async interrupted(): Promise<AgentSessionRow[]> {
    await this.recoverInterrupted();
    return (await this.o.index.query<Record<string, unknown>>('interruptedAgentSessions', {})).map(agentSessionRow);
  }

  /** The chat's last run if it did not finish, with what ran and its checkpoint (the Run interrupted card). */
  async interruptedRun(conversationId: string, limit?: number): Promise<InterruptedRun | undefined> {
    await this.recoverInterrupted();
    return interruptedRun(this.o.index, conversationId, this.writer, limit);
  }

  /** The draft a chat left (laptop off, crash), unless its run is still streaming somewhere. */
  draft(conversationId: string): Draft | undefined {
    const d = this.drafts.read(conversationId);
    return d && !this.drafts.live(d, (id) => this.bridge.isRunning(id)) ? d : undefined;
  }

  /**
   * The partial answer of a chat's draft (`meta.partial`), when the draft is newer than the chat's last message; the
   * draft is removed either way once read (a stale one is never offered twice). Undefined while the chat runs here.
   */
  takePartial(session: Pick<Session, 'id' | 'messages'>): ChatMessage | undefined {
    if (this.bridge.isRunning(session.id)) {
      return undefined;
    }
    const d = this.draft(session.id);
    if (!d) {
      return undefined;
    }
    const m = partialFromDraft(session, d);
    this.drafts.clear(session.id);
    return m;
  }

  dispose(): void {
    this.subs.forEach((s) => s.dispose());
    this.changed.dispose();
    this.bridge.dispose();
  }
}
