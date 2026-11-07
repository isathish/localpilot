// The agent loop's view of continuity's SESSION module (design §9.3): optional hooks, so the loop behaves exactly as in
// 1.6 without them. Built by src/ui/sessionHost.ts (VS Code and the CLI) over src/continuity/session/runBridge.ts.
import type { AgentEvent, ChatMessage, Session } from '../types';

export interface RunStartInfo {
  session: Session;
  /** The user message that starts the turn (before the loop appends its timestamped copy). */
  userMessage: ChatMessage;
  /** The change-tracker turn key (`meta.checkpoint`), the same `run` checkpoints use. */
  run?: number;
  /** The chat's Trace recorder id (VS Code); the agent session id derives from it, as migration does. */
  traceId?: string;
  mode: string;
  specialist?: string;
  /** The chat's model ('' = Auto); the model that really answers arrives with `model_request`. */
  model?: string;
  /** The folder the run works in (a worktree for isolated chats). */
  root?: string;
}

export interface RunEndInfo {
  outcome: 'ok' | 'error' | 'stopped' | 'interrupted';
  error?: string;
  model?: string;
  promptTokens?: number;
  completionTokens?: number;
  /** Files this turn changed (from the ChangeTracker), relative to the run's folder with `/` separators. */
  filesTouched?: { path: string; status: 'A' | 'M' | 'D' }[];
}

export interface RunHandle {
  /** The loop appended the turn's user message (the SessionBridge has given it its id by now, when attached). */
  userMessage?(m: ChatMessage): void;
  /** Every event of the run (the chat's own and its subagents'); deltas feed the draft, the rest execution events. */
  event(e: AgentEvent): void;
  end(r: RunEndInfo): void;
}

export interface SessionRunHooks {
  /** A top-level run starts (never for subagents or scratch runs). Must not throw. */
  start(r: RunStartInfo): RunHandle | undefined;
}
