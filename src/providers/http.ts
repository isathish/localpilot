/** Small HTTP helpers shared by providers (uses global fetch available in VS Code's Node runtime). */

export class HttpError extends Error {
  /** How long the server asked to wait before retrying (`retry-after` / `retry-after-ms`), when it said. */
  readonly retryAfterMs?: number;

  constructor(public status: number, public body: string, url: string, headers?: Headers) {
    super(`HTTP ${status} from ${url}: ${body.slice(0, 500)}`);
    this.retryAfterMs = headers ? retryAfter(headers) : undefined;
  }
}

/** `retry-after-ms`, or `retry-after` as seconds or an HTTP date. */
export function retryAfter(headers: Headers): number | undefined {
  const ms = Number(headers.get('retry-after-ms'));
  if (ms > 0) {
    return ms;
  }
  const v = headers.get('retry-after')?.trim();
  if (!v) {
    return undefined;
  }
  const secs = Number(v);
  if (Number.isFinite(secs)) {
    return secs > 0 ? secs * 1000 : undefined;
  }
  const at = Date.parse(v);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : undefined;
}

export async function postJson<T>(url: string, body: unknown, headers: Record<string, string>, signal?: AbortSignal): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) {
    throw new HttpError(res.status, await res.text().catch(() => ''), url, res.headers);
  }
  return (await res.json()) as T;
}

export async function getJson<T>(url: string, headers: Record<string, string>, signal?: AbortSignal): Promise<T> {
  const res = await fetch(url, { headers, signal });
  if (!res.ok) {
    throw new HttpError(res.status, await res.text().catch(() => ''), url, res.headers);
  }
  return (await res.json()) as T;
}

/** Yields each newline-delimited line of a streaming response body. */
export async function* streamLines(url: string, body: unknown, headers: Record<string, string>, signal?: AbortSignal): AsyncGenerator<string> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok || !res.body) {
    throw new HttpError(res.status, await res.text().catch(() => ''), url, res.headers);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).replace(/\r$/, '');
        buffer = buffer.slice(idx + 1);
        if (line.length) {
          yield line;
        }
      }
    }
    if (buffer.trim().length) {
      yield buffer;
    }
  } finally {
    reader.releaseLock();
  }
}

/** Yields parsed JSON payloads from a Server-Sent-Events stream (`data: {...}` lines). */
export async function* streamSse<T>(url: string, body: unknown, headers: Record<string, string>, signal?: AbortSignal): AsyncGenerator<T> {
  for await (const line of streamLines(url, body, headers, signal)) {
    if (!line.startsWith('data:')) {
      continue;
    }
    const data = line.slice(5).trim();
    if (data === '[DONE]') {
      return;
    }
    try {
      yield JSON.parse(data) as T;
    } catch {
      // ignore keep-alives / partial lines
    }
  }
}

/**
 * A signal that aborts after `ms` or with `parent`. Built from AbortSignal.any/timeout, which hold no listener on the
 * parent once they are collected: a long run's signal used to gain one listener (and a live timer) per request.
 */
export function withTimeout(ms: number, parent?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(ms);
  return parent ? AbortSignal.any([parent, timeout]) : timeout;
}

export function newId(prefix = 'call'): string {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}
