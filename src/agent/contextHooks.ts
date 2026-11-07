// The agent loop's view of continuity's CONTEXT module (design §8): optional hooks, so the loop behaves exactly as in
// 1.6 without them. Built by src/ui/contextHost.ts (VS Code and the CLI).
import type { ContextBreakdown } from '../context/contextBreakdown';
import type { ChatMessage, CompactionDetails, ModelInfo, Session } from '../types';

export interface ExcludedRef {
  ref: string;
  reason: 'localOnly' | 'budget' | 'ignored';
}

export interface ContextRequest {
  session: Session;
  model: ModelInfo;
  /** What is about to be sent (system prompt and history). */
  messages: ChatMessage[];
  /** 0 = the chat's own turn; subagents get the policy but no notice and no snapshot. */
  depth: number;
  /** Memory notes the prompt left out this turn (local only for a cloud model, or over budget). */
  memoryExcluded?: ExcludedRef[];
}

export interface ContextSnapshotRequest {
  session: Session;
  model: ModelInfo;
  phase: 'turn' | 'before-compaction' | 'after-compaction';
  /** The history of the request (before or after the compaction). */
  messages: readonly ChatMessage[];
  usedTokens: number;
  breakdown?: ContextBreakdown;
  memorySection?: string;
  memoryExcluded?: ExcludedRef[];
  rules?: string;
  ruleLabels?: string[];
  compaction?: CompactionDetails;
  /** The folder the run works in (a worktree for isolated chats). */
  root?: string;
}

export interface ContextTurnHooks {
  /**
   * Before every model request: the messages to send (local-only blocks removed for a cloud model). `block` refuses
   * the request (a conversation tagged `local-only` and a cloud model); `notice` is shown once (local -> cloud).
   */
  beforeRequest?(r: ContextRequest): Promise<{ messages: ChatMessage[]; block?: string }>;
  /** A note for this turn's context (files changed since the chat last ran), once. */
  turnNote?(session: Session): string | undefined;
  /** Records what the model saw: the turn's last request, and both sides of a compaction. */
  snapshot?(r: ContextSnapshotRequest): void;
}
