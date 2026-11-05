import { HttpError } from '../providers/http';
import { StreamEvent } from '../types';

/** Why a model request failed, used to decide whether and how to retry. */
export type ModelFailure = 'network' | 'server' | 'overload' | 'ratelimit' | 'overflow' | 'stall' | 'toolcall' | 'auth' | 'quota' | 'unroutable' | 'other';

export class ModelStallError extends Error {
  constructor(public readonly phase: 'first-token' | 'mid-stream', seconds: number) {
    super(phase === 'first-token' ? `The model produced nothing for ${seconds}s` : `The model stopped responding mid-answer (${seconds}s without output)`);
  }
}

const OVERFLOW = /context (length|window|size)|too (long|large|many tokens)|exceeds? .*(limit|maximum|context)|maximum context|prompt is too long|input length|num_ctx|token limit|reduce the length/i;
const UNROUTABLE = /no (eligible|available|healthy|matching|valid) (route|provider|account|target|deployment|connection)s?|no providers? (are |is )?(configured|connected|available)|all (providers|accounts|targets|routes) (failed|exhausted|unavailable)|no deployments? available|invalid model name passed in model=/i;
const QUOTA = /insufficient_quota|exceeded your current quota|quota exceeded|credit balance is too low|billing|payment required|out of credits|no credits|insufficient (credits|balance|funds)/i;
/** The server ran out of memory loading or running the model (Ollama, llama.cpp, vLLM): retrying unchanged rarely helps. */
const OVERLOAD = /out of memory|\bOOM\b|CUDA error|failed to allocate|requires more system memory|insufficient memory|llama runner process has terminated/i;
const NETWORK = /ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|EAI_AGAIN|ENOTFOUND|socket hang up|fetch failed|network|terminated|aborted|other side closed|UND_ERR/i;

export function classifyModelError(e: unknown): ModelFailure {
  if (e instanceof ModelStallError) {
    return 'stall';
  }
  if (e instanceof HttpError) {
    // Out of credits or quota is also sent as 429 (OpenAI) or 400/402 (Anthropic): waiting does not help.
    if (QUOTA.test(e.body) && (e.status === 429 || e.status === 402 || e.status === 400 || e.status === 403)) {
      return 'quota';
    }
    // A gateway (OmniRoute, LiteLLM) that is up but has no upstream it may send this model to: not worth retrying.
    if (UNROUTABLE.test(e.body)) {
      return 'unroutable';
    }
    if (e.status === 429) {
      return 'ratelimit';
    }
    if (e.status === 401 || (e.status === 403 && /api[ _-]?key|auth|permission|forbidden|unauthori[sz]ed/i.test(e.body))) {
      return 'auth';
    }
    if (OVERFLOW.test(e.body)) {
      return 'overflow';
    }
    // Ollama's parser rejected the tool call the model generated (gpt-oss does this now and then): the model, not the server, should retry.
    if (/error parsing tool call/i.test(e.body)) {
      return 'toolcall';
    }
    if (e.status >= 500 && OVERLOAD.test(e.body)) {
      return 'overload';
    }
    if (e.status >= 500 || e.status === 408) {
      return 'server';
    }
    return 'other';
  }
  const msg = e instanceof Error ? `${e.message} ${(e as { cause?: { message?: string; code?: string } }).cause?.message ?? ''} ${(e as { cause?: { code?: string } }).cause?.code ?? ''}` : String(e);
  // Errors sent inside the stream as plain text. The tool-call check comes first: its message quotes the model's raw output.
  if (/error parsing tool call/i.test(msg)) {
    return 'toolcall';
  }
  if (QUOTA.test(msg)) {
    return 'quota';
  }
  if (UNROUTABLE.test(msg)) {
    return 'unroutable';
  }
  if (OVERFLOW.test(msg)) {
    return 'overflow';
  }
  if (/rate.?limit|too many requests/i.test(msg)) {
    return 'ratelimit';
  }
  if (OVERLOAD.test(msg)) {
    return 'overload';
  }
  if (/overloaded|internal server error|service unavailable|bad gateway/i.test(msg)) {
    return 'server';
  }
  if (NETWORK.test(msg)) {
    return 'network';
  }
  return 'other';
}

/** `overload` stays transient here so the legacy path keeps retrying OOM 500s as before; the healing policy treats it as environmental. */
export const isTransient = (k: ModelFailure): boolean => k === 'network' || k === 'server' || k === 'overload' || k === 'ratelimit' || k === 'stall';

/**
 * How long to wait before retry `attempt` (1-based). Rate limits wait as long as the server asks (cloud APIs usually
 * want seconds, not milliseconds), or 5 s, 10 s… when it does not say; capped so a run never sits idle for minutes.
 */
export function retryDelayMs(kind: ModelFailure, e: unknown, attempt: number, backoff: readonly number[]): number {
  const base = backoff[Math.min(attempt - 1, backoff.length - 1)];
  if (kind !== 'ratelimit') {
    return base;
  }
  const asked = e instanceof HttpError ? e.retryAfterMs : undefined;
  return Math.min(60_000, Math.max(base, asked ?? 5_000 * attempt));
}

/** One-line, actionable wording for the chat; the raw message stays in the log. */
export function describeModelError(kind: ModelFailure, raw: string, modelName: string): string {
  const detail = raw.replace(/^HTTP \d+ from \S+:\s*/, '').replace(/\s+/g, ' ').trim().slice(0, 240);
  switch (kind) {
    case 'network':
      return `Could not reach the model server for ${modelName}. Check that it is running (Settings → Providers → Check all connections) and try again.${detail ? ` (${detail})` : ''}`;
    case 'server':
      return `The model server returned an error for ${modelName}. It may be out of memory or restarting — try again, or pick a smaller model.${detail ? ` (${detail})` : ''}`;
    case 'overload':
      return `The model server ran out of memory running ${modelName}. Close other models or apps, lower the context window in Settings → Models, or pick a smaller model.${detail ? ` (${detail})` : ''}`;
    case 'ratelimit':
      return `The server is rate limiting requests for ${modelName}. Wait a moment and try again.${detail ? ` (${detail})` : ''}`;
    case 'auth':
      return `The provider rejected the API key for ${modelName}. Set a valid key in Settings → Providers (or \`localpilot providers key <id>\` in the terminal).${detail ? ` (${detail})` : ''}`;
    case 'unroutable':
      return `The gateway serving ${modelName} has no provider it can send this request to. Connect a provider in its dashboard (OmniRoute: Providers; LiteLLM: model_list in its config), or pick a specific model instead of an automatic route.${detail ? ` (${detail})` : ''}`;
    case 'quota':
      return `The provider says the account behind ${modelName} is out of credits or quota. Add credits or raise the limit with the provider, or pick another model.${detail ? ` (${detail})` : ''}`;
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
  /** Called every second while waiting for the first event, with the seconds elapsed. */
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
          ticker = setInterval(() => opts.onWaiting?.(Math.round((Date.now() - started) / 1000)), 1000);
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

/**
 * Calls `fn` when `signal` aborts and returns the function that removes the listener. Call it when the work ends:
 * a run's signal lives as long as the run, and listeners left on it pile up (MaxListenersExceeded) and keep their
 * closures — a child process and all its output — in memory.
 */
export function onAbort(signal: AbortSignal | undefined, fn: () => void): () => void {
  if (!signal) {
    return () => undefined;
  }
  // An already-aborted signal never fires 'abort' again, so run the handler — in a microtask, because callers
  // usually declare what the handler touches (`const off = onAbort(…)`, a timer) after this call returns.
  if (signal.aborted) {
    queueMicrotask(fn);
    return () => undefined;
  }
  signal.addEventListener('abort', fn, { once: true });
  return () => signal.removeEventListener('abort', fn);
}

export const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal?.aborted) {
      return resolve();
    }
    const t = setTimeout(() => {
      off();
      resolve();
    }, ms);
    const off = onAbort(signal, () => {
      clearTimeout(t);
      resolve();
    });
  });

/** Stable key for "the same tool call again" detection. */
export function callKey(name: string, args: Record<string, unknown>): string {
  const sorted = Object.keys(args)
    .sort()
    .map((k) => `${k}=${JSON.stringify(args[k])}`)
    .join('&');
  return `${name}?${sorted}`;
}
