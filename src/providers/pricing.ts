import { ModelInfo, ProviderUsage } from '../types';

/**
 * Cost of one request in US dollars. A cost the provider reported (OpenRouter) wins; otherwise it is computed from the
 * model's per-1M prices, with `promptTokens` counting the whole input (cached parts included):
 * (input − cacheRead − cacheWrite) × input + output × output + cacheRead × cacheRead + cacheWrite × cacheWrite.
 * Undefined when the price is unknown, which includes every local model.
 */
export function costOf(usage: ProviderUsage | undefined, model: Pick<ModelInfo, 'pricing'> | undefined): number | undefined {
  if (!usage) {
    return undefined;
  }
  if (typeof usage.costUsd === 'number' && Number.isFinite(usage.costUsd)) {
    return usage.costUsd;
  }
  const p = model?.pricing;
  if (!p) {
    return undefined;
  }
  const n = (v: number | undefined) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);
  const read = n(usage.cacheReadTokens);
  const write = n(usage.cacheWriteTokens);
  const input = Math.max(0, n(usage.promptTokens) - read - write);
  const cost = input * p.input + n(usage.completionTokens) * p.output + read * (p.cacheRead ?? p.input) + write * (p.cacheWrite ?? p.input * 1.25);
  return cost / 1_000_000;
}

/** The usage with its cost filled in when the provider did not report one and the model's price is known. */
export function withCost(usage: ProviderUsage | undefined, model: Pick<ModelInfo, 'pricing'> | undefined): ProviderUsage | undefined {
  if (!usage || usage.costUsd !== undefined) {
    return usage;
  }
  const costUsd = costOf(usage, model);
  return costUsd === undefined ? usage : { ...usage, costUsd };
}

/** Short label for a cost: `$0.0123`, `<$0.0001`, or `local · free` for models without a price on this machine. */
export function formatCost(costUsd: number | undefined, remote?: boolean): string {
  if (costUsd === undefined) {
    return remote ? '' : 'local · free';
  }
  if (costUsd > 0 && costUsd < 0.0001) {
    return '<$0.0001';
  }
  return `$${costUsd >= 1 ? costUsd.toFixed(2) : costUsd.toFixed(4)}`;
}
