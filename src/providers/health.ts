import { ProviderConfig } from '../types';
import { isRemoteUrl, keyStatus } from './cloud';

/**
 * Provider health for Settings → Providers and the chat's model picker, from the registry's own discovery rounds
 * (a health check plus the model listing, at most every 30 s while something asks for models). Nothing extra is
 * probed for it: a provider that was never checked has no state.
 */
export type ProviderHealthState = 'ok' | 'slow' | 'down' | 'nokey' | 'off';

export interface ProviderHealth {
  state: ProviderHealthState;
  /** Duration of the last check (health check + listing), ms. */
  ms?: number;
  /** Models the last check listed. */
  models?: number;
  /** Why it is down or has no key, in a few words. */
  detail?: string;
  /** When it was last checked (epoch ms). */
  checkedAt?: number;
}

/** One discovery result as the registry keeps it. */
export interface HealthRecord {
  ok: boolean;
  ms: number;
  at: number;
  models?: number;
  error?: string;
}

/** A local server answering slower than this (health check + listing) is "slow"; cloud APIs get more room. */
export const SLOW_LOCAL_MS = 1500;
export const SLOW_CLOUD_MS = 4000;

const AUTH_ERROR = /\b(401|403)\b|unauthori[sz]ed|forbidden|invalid[^.]{0,20}(api[ _-]?)?key|api[ _-]?key[^.]{0,30}(missing|required|invalid|not set)|authentication/i;

/** The badge state for one configured provider. */
export function classifyProviderHealth(p: Pick<ProviderConfig, 'baseUrl' | 'apiKey' | 'enabled' | 'type'>, rec: HealthRecord | undefined): ProviderHealth | undefined {
  if (p.enabled === false) {
    return { state: 'off' };
  }
  // A cloud API without a usable key is "no key" before anything is sent (VS Code's own models need none).
  const needsKey = isRemoteUrl(p.baseUrl) && p.type !== 'vscode-lm';
  if (needsKey && !keyStatus(p).ok) {
    return { state: 'nokey', detail: p.apiKey ? 'key not found' : 'no API key', ...(rec ? { checkedAt: rec.at } : {}) };
  }
  if (!rec) {
    return undefined;
  }
  const base = { ms: rec.ms, checkedAt: rec.at, ...(rec.models !== undefined ? { models: rec.models } : {}) };
  if (!rec.ok) {
    return AUTH_ERROR.test(rec.error ?? '') ? { ...base, state: 'nokey', detail: 'key rejected' } : { ...base, state: 'down', detail: shortError(rec.error) };
  }
  return { ...base, state: rec.ms > (isRemoteUrl(p.baseUrl) ? SLOW_CLOUD_MS : SLOW_LOCAL_MS) ? 'slow' : 'ok' };
}

function shortError(e: string | undefined): string {
  if (!e || e === 'unreachable') {
    return 'not answering';
  }
  if (/ECONNREFUSED|connect|fetch failed|ENOTFOUND|EAI_AGAIN|socket/i.test(e)) {
    return 'not answering';
  }
  if (/timed? ?out|abort/i.test(e)) {
    return 'timed out';
  }
  const http = /\b(5\d\d|4\d\d)\b/.exec(e);
  return http ? `HTTP ${http[1]}` : e.replace(/\s+/g, ' ').slice(0, 60);
}

/** Short label for a badge: "120 ms", "3.2 s". */
export function formatHealthMs(ms: number | undefined): string {
  if (ms === undefined) {
    return '';
  }
  return ms >= 1000 ? `${(ms / 1000).toFixed(ms >= 10_000 ? 0 : 1)} s` : `${Math.round(ms)} ms`;
}
