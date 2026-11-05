import { AgentEvent, SessionUsage } from '../types';
import { CompletionContract } from '../agent/healing/types';

/** Agent events written by `--json` one-shot runs; the rest (approval plumbing, UI refreshes) stay internal. */
export const NDJSON_EVENTS = new Set(['assistant_delta', 'thinking_delta', 'tool_start', 'tool_end', 'tool_progress', 'status', 'compaction', 'subagent_start', 'subagent_end', 'hook', 'nudge', 'recovery', 'error']);

export type FinishReason = 'completed' | 'max_steps' | 'mistake_limit' | 'error' | 'aborted' | 'timeout' | 'incomplete' | 'blocked';

export interface RunResult {
  finishReason: FinishReason;
  text: string;
  usage: { promptTokens: number; completionTokens: number; cacheReadTokens: number; cacheWriteTokens: number; requests: number };
  costUsd?: number;
  durationMs: number;
  model: string;
  sessionId: string;
  /** The quality gate's verdict, when self-healing ran. */
  outcome?: string;
  /** The completion contract behind `outcome`. */
  contract?: CompletionContract;
}

/** One agent event as an NDJSON record: `{type, ts, …}`; undefined for events the stream does not carry. */
export function eventRecord(e: AgentEvent, ts = Date.now()): Record<string, unknown> | undefined {
  if (!NDJSON_EVENTS.has(e.type)) {
    return undefined;
  }
  const p = e.payload;
  if (p && typeof p === 'object' && !Array.isArray(p)) {
    return { type: e.type, ts, ...(p as Record<string, unknown>) };
  }
  if (e.type === 'assistant_delta' || e.type === 'thinking_delta') {
    return { type: e.type, ts, text: String(p ?? '') };
  }
  return { type: e.type, ts, message: String(p ?? '') };
}

/** What one run added to a chat's usage totals (`after` minus `before`). */
export function runUsage(before: SessionUsage | undefined, after: SessionUsage | undefined): { usage: RunResult['usage']; costUsd?: number } {
  const n = (u: SessionUsage | undefined, k: 'promptTokens' | 'completionTokens' | 'cacheReadTokens' | 'cacheWriteTokens' | 'requests') => u?.[k] ?? 0;
  const usage = {
    promptTokens: n(after, 'promptTokens') - n(before, 'promptTokens'),
    completionTokens: n(after, 'completionTokens') - n(before, 'completionTokens'),
    cacheReadTokens: n(after, 'cacheReadTokens') - n(before, 'cacheReadTokens'),
    cacheWriteTokens: n(after, 'cacheWriteTokens') - n(before, 'cacheWriteTokens'),
    requests: n(after, 'requests') - n(before, 'requests'),
  };
  const cost = after?.costUsd === undefined ? undefined : after.costUsd - (before?.costUsd ?? 0);
  return { usage, ...(cost !== undefined ? { costUsd: Math.round(cost * 1e6) / 1e6 } : {}) };
}

/**
 * `localpilot --json "task"`: every event as one JSON object per line on stdout, errors as `{type: 'error', message}`
 * on stderr, and a final `run_result`. Lines are never split: a record is written with its newline in one call.
 */
export class NdjsonWriter {
  constructor(private readonly out: NodeJS.WritableStream = process.stdout, private readonly err: NodeJS.WritableStream = process.stderr, private readonly now: () => number = Date.now) {}

  event(e: AgentEvent): void {
    const r = eventRecord(e, this.now());
    if (!r) {
      return;
    }
    if (r.type === 'error') {
      this.error(typeof r.message === 'string' ? r.message : String(r.latest ?? 'error'), r);
      return;
    }
    this.write(this.out, r);
  }

  /** An error record on stderr; `extra` keeps the event's other fields (kind, count…). */
  error(message: string, extra: Record<string, unknown> = {}): void {
    this.write(this.err, { ...extra, type: 'error', ts: this.now(), message });
  }

  result(r: RunResult): void {
    const { outcome, contract, ...rest } = r;
    this.write(this.out, { type: 'run_result', ts: this.now(), ...rest, ...(outcome ? { outcome } : {}), ...(contract ? { contract } : {}) });
  }

  private write(stream: NodeJS.WritableStream, record: Record<string, unknown>): void {
    let line: string;
    try {
      line = JSON.stringify(record);
    } catch {
      line = JSON.stringify({ type: record.type, ts: record.ts, message: 'unserializable event' });
    }
    stream.write(`${line}\n`);
  }
}
