import { SessionUsage } from '../types';
import { formatCost } from '../providers/pricing';

/** Compact token count: `950`, `12.3k`, `123k`, `1.2M`. */
export function formatTokens(n: number | undefined): string {
  const v = typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : 0;
  if (v >= 1e6) {
    return `${(v / 1e6).toFixed(v >= 1e7 ? 0 : 1)}M`;
  }
  if (v >= 1e5) {
    return `${Math.round(v / 1e3)}k`;
  }
  if (v >= 1e3) {
    return `${(v / 1e3).toFixed(1)}k`;
  }
  return String(Math.round(v));
}

/** Input (cached parts included), output and total tokens of a chat's usage, plus its cost when one is known. */
export function usageTotals(u: SessionUsage | undefined): { input: number; output: number; total: number; costUsd?: number; requests: number } {
  if (!u) {
    return { input: 0, output: 0, total: 0, requests: 0 };
  }
  const input = (u.promptTokens || 0) + (u.cacheReadTokens || 0) + (u.cacheWriteTokens || 0);
  const output = u.completionTokens || 0;
  return { input, output, total: input + output, costUsd: u.costUsd, requests: u.requests || 0 };
}

/** What one turn added to a chat's usage (`before` is a copy taken when the turn started). */
export function usageDelta(before: SessionUsage | undefined, after: SessionUsage | undefined): { input: number; output: number; total: number; costUsd?: number; requests: number } {
  const a = usageTotals(after);
  const b = usageTotals(before);
  const cost = a.costUsd === undefined ? undefined : a.costUsd - (b.costUsd ?? 0);
  return { input: a.input - b.input, output: a.output - b.output, total: a.total - b.total, costUsd: cost, requests: a.requests - b.requests };
}

/** The CLI's line after a turn: `(13.4k tok · $0.0100)`; the cost only when the model is priced. Empty when no request was made. */
export function turnUsageLabel(d: { total: number; costUsd?: number; requests: number }): string {
  if (d.requests <= 0) {
    return '';
  }
  return `(${formatTokens(d.total)} tok${d.costUsd === undefined ? '' : ` · ${formatCost(d.costUsd, true)}`})`;
}

/** The pills of a chat: `↑12.3k ↓1.1k` and, for priced cloud models, `$0.0123`. */
export function usagePills(u: SessionUsage | undefined): { tokens: string; cost: string } | undefined {
  const t = usageTotals(u);
  if (!t.requests) {
    return undefined;
  }
  return { tokens: `↑${formatTokens(t.input)} ↓${formatTokens(t.output)}`, cost: t.costUsd === undefined ? '' : formatCost(t.costUsd, true) };
}
