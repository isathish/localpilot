import { ProviderUsage, SessionUsage } from '../types';

export function emptyUsage(): SessionUsage {
  return { promptTokens: 0, completionTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, requests: 0 };
}

/**
 * Adds one model request to a chat's totals. The provider's `promptTokens` includes cached input; it is split here so
 * the session keeps uncached input and cache reads/writes apart. `subagent` also books the request in the breakdown.
 */
export function addUsage(total: SessionUsage | undefined, u: ProviderUsage | undefined, model?: string, provider?: string, subagent = false): SessionUsage {
  const t = total ?? emptyUsage();
  const read = Math.max(0, u?.cacheReadTokens ?? 0);
  const write = Math.max(0, u?.cacheWriteTokens ?? 0);
  const prompt = Math.max(0, (u?.promptTokens ?? 0) - read - write);
  const completion = Math.max(0, u?.completionTokens ?? 0);
  t.promptTokens += prompt;
  t.completionTokens += completion;
  t.cacheReadTokens += read;
  t.cacheWriteTokens += write;
  t.requests++;
  if (typeof u?.costUsd === 'number' && Number.isFinite(u.costUsd)) {
    t.costUsd = (t.costUsd ?? 0) + u.costUsd;
  }
  if (subagent) {
    const s = (t.subagentTokens ??= { promptTokens: 0, completionTokens: 0, requests: 0 });
    s.promptTokens += prompt;
    s.completionTokens += completion;
    s.requests++;
  }
  if (model) {
    t.model = model;
  }
  if (provider) {
    t.provider = provider;
  }
  return t;
}
