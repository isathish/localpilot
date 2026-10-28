import { HttpError } from '../providers/http';
import { StreamEvent } from '../types';

/** Why a model request failed, used to decide whether and how to retry. */
export type ModelFailure = 'network' | 'server' | 'ratelimit' | 'overflow' | 'stall' | 'toolcall' | 'other';

export class ModelStallError extends Error {
  constructor(public readonly phase: 'first-token' | 'mid-stream', seconds: number) {
    super(phase === 'first-token' ? `The model produced nothing for ${seconds}s` : `The model stopped responding mid-answer (${seconds}s without output)`);
  }
}

const OVERFLOW = /context (length|window|size)|too (long|large|many tokens)|exceeds? .*(limit|maximum|context)|maximum context|prompt is too long|input length|num_ctx|token limit|reduce the length/i;
const NETWORK = /ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|EAI_AGAIN|ENOTFOUND|socket hang up|fetch failed|network|terminated|aborted|other side closed|UND_ERR/i;

export function classifyModelError(e: unknown): ModelFailure {
  if (e instanceof ModelStallError) {
    return 'stall';
  }
  if (e instanceof HttpError) {
    if (e.status === 429) {
      return 'ratelimit';
    }
    if (OVERFLOW.test(e.body)) {
      return 'overflow';
    }
    // Ollama's parser rejected the tool call the model generated (gpt-oss does this now and then): the model, not the server, should retry.
    if (/error parsing tool call/i.test(e.body)) {
      return 'toolcall';
    }
    if (e.status >= 500 || e.status === 408) {
      return 'server';
    }
    return 'other';
  }
  const msg = e instanceof Error ? `${e.message} ${(e as { cause?: { message?: string; code?: string } }).cause?.message ?? ''} ${(e as { cause?: { code?: string } }).cause?.code ?? ''}` : String(e);
  if (OVERFLOW.test(msg)) {
    return 'overflow';
  }
  if (NETWORK.test(msg)) {
    return 'network';
  }
  return 'other';
}

export const isTransient = (k: ModelFailure): boolean => k === 'network' || k === 'server' || k === 'ratelimit' || k === 'stall';

/** One-line, actionable wording for the chat; the raw message stays in the log. */
export function describeModelError(kind: ModelFailure, raw: string, modelName: string): string {
  const detail = raw.replace(/^HTTP \d+ from \S+:\s*/, '').replace(/\s+/g, ' ').trim().slice(0, 240);
  switch (kind) {
    case 'network':
      return `Could not reach the model server for ${modelName}. Check that it is running (Settings → Providers → Check all connections) and try again.${detail ? ` (${detail})` : ''}`;
    case 'server':
      return `The model server returned an error for ${modelName}. It may be out of memory or restarting — try again, or pick a smaller model.${detail ? ` (${detail})` : ''}`;
    case 'ratelimit':
      return `The server is rate limiting requests for ${modelName}. Wait a moment and try again.${detail ? ` (${detail})` : ''}`;
    case 'overflow':
      return `The conversation no longer fits ${modelName}'s context window even after compacting. Start a new chat, raise the context window in Settings → Models, or pick a model with a larger window.`;
    case 'stall':
      return `${modelName} stopped responding. ${detail}. The request was cancelled — try again; if it keeps happening, the model may be too large for this machine.`;
    default:
      return detail || raw;
  }
}

export interface WatchdogOptions {
  /** Max wait for the first event (local models can take a while to load and prefill). */
  firstTokenMs: number;
  /** Max silence between events once streaming has started. */
  idleMs: number;
  /** Called every ~5s while waiting for the first event, with the seconds elapsed. */
  onWaiting?: (seconds: number) => void;
  /** Cancels the underlying request when a stall is detected. */
  abort: () => void;
}

/**
 * Wraps a provider stream with stall detection: rejects with ModelStallError when nothing arrives for
 * `firstTokenMs` (before any output) or `idleMs` (after), aborting the request so the server frees the slot.
 */
export async function* withWatchdog(stream: AsyncIterable<StreamEvent>, opts: WatchdogOptions): AsyncGenerator<StreamEvent> {
  const it = stream[Symbol.asyncIterator]();
  let seen = false;
  const started = Date.now();
  try {
    while (true) {
      const limit = seen ? opts.idleMs : opts.firstTokenMs;
      let timer: NodeJS.Timeout | undefined;
      let ticker: NodeJS.Timeout | undefined;
      const stalled = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          opts.abort();
          reject(new ModelStallError(seen ? 'mid-stream' : 'first-token', Math.round(limit / 1000)));
        }, limit);
        if (!seen && opts.onWaiting) {
          ticker = setInterval(() => opts.onWaiting?.(Math.round((Date.now() - started) / 1000)), 5000);
        }
      });
      let next: IteratorResult<StreamEvent>;
      try {
        next = await Promise.race([it.next(), stalled]);
      } finally {
        clearTimeout(timer);
        clearInterval(ticker);
      }
      if (next.done) {
        return;
      }
      if (next.value.type === 'text' || next.value.type === 'thinking' || next.value.type === 'tool_call') {
        seen = true;
      }
      yield next.value;
    }
  } finally {
    await it.return?.().catch(() => undefined);
  }
}

export const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      resolve();
    }, { once: true });
  });

/** Stable key for "the same tool call again" detection. */
export function callKey(name: string, args: Record<string, unknown>): string {
  const sorted = Object.keys(args)
    .sort()
    .map((k) => `${k}=${JSON.stringify(args[k])}`)
    .join('&');
  return `${name}?${sorted}`;
}
