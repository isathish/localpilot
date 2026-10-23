/** Small HTTP helpers shared by providers (uses global fetch available in VS Code's Node runtime). */

export class HttpError extends Error {
  constructor(public status: number, public body: string, url: string) {
    super(`HTTP ${status} from ${url}: ${body.slice(0, 500)}`);
  }
}

export async function postJson<T>(url: string, body: unknown, headers: Record<string, string>, signal?: AbortSignal): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) {
    throw new HttpError(res.status, await res.text().catch(() => ''), url);
  }
  return (await res.json()) as T;
}

export async function getJson<T>(url: string, headers: Record<string, string>, signal?: AbortSignal): Promise<T> {
  const res = await fetch(url, { headers, signal });
  if (!res.ok) {
    throw new HttpError(res.status, await res.text().catch(() => ''), url);
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
    throw new HttpError(res.status, await res.text().catch(() => ''), url);
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

export function withTimeout(ms: number, parent?: AbortSignal): AbortSignal {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(new Error('timeout')), ms);
  parent?.addEventListener('abort', () => ctrl.abort(parent.reason), { once: true });
  ctrl.signal.addEventListener('abort', () => clearTimeout(t), { once: true });
  return ctrl.signal;
}

export function newId(prefix = 'call'): string {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}
