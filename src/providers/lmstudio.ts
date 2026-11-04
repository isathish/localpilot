import { getJson, HttpError, withTimeout } from './http';

/** One entry of LM Studio's native `GET /api/v0/models`. */
export interface LmStudioModel {
  id: string;
  type?: string;
  state?: string;
  max_context_length?: number;
  loaded_context_length?: number;
}

/** A provider that is LM Studio: the preset id (`lmstudio`, `lmstudio-2`) or LM Studio's port. */
export function isLmStudio(cfg: { id: string; baseUrl: string }): boolean {
  if (cfg.id.replace(/-\d+$/, '') === 'lmstudio') {
    return true;
  }
  try {
    return new URL(cfg.baseUrl).port === '1234';
  } catch {
    return false;
  }
}

/** The server root the native API hangs off: the base URL without its trailing `/v1`. */
export function lmStudioRoot(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '').replace(/\/v1$/i, '');
}

/** Context window per model id: the length the model is loaded with, else the most it supports. */
export function lmStudioContexts(models: LmStudioModel[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const m of models) {
    const ctx = m.loaded_context_length || m.max_context_length;
    if (m?.id && typeof ctx === 'number' && ctx > 0) {
      out.set(m.id, ctx);
    }
  }
  return out;
}

/**
 * Asks LM Studio's native API for context lengths, which its `/v1/models` leaves out.
 * `null`: the server has no such endpoint (not LM Studio); `undefined`: it did not answer this time.
 */
export async function fetchLmStudioContexts(baseUrl: string, headers: Record<string, string>, signal?: AbortSignal): Promise<Map<string, number> | null | undefined> {
  try {
    const res = await getJson<{ data?: LmStudioModel[] } | LmStudioModel[]>(`${lmStudioRoot(baseUrl)}/api/v0/models`, headers, withTimeout(2500, signal));
    const list = Array.isArray(res) ? res : res?.data;
    return Array.isArray(list) ? lmStudioContexts(list) : null;
  } catch (e) {
    return e instanceof HttpError || e instanceof SyntaxError ? null : undefined;
  }
}
