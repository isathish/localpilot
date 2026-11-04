import { ModelPricing, ProviderConfig } from '../types';
import * as bundled from './modelFacts.json';
import { PROVIDER_PRESETS } from './presets';

/** What models.dev says about a cloud model (see scripts/update-model-facts.mjs). Prices are US dollars per 1M tokens. */
export interface ModelFacts {
  contextWindow?: number;
  maxOutput?: number;
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  vision?: boolean;
  reasoning?: boolean;
  promptCache?: boolean;
}

/** Facts by preset key, then lower-case model id. Bundled only: refreshed by hand, never fetched at runtime. */
const TABLES = (bundled as unknown as { providers: Record<string, Record<string, ModelFacts>> }).providers;

/** Billed by subscription rather than per token: its limits are used, its prices are not. */
const UNPRICED = new Set(['ollama-cloud']);

function hostOf(url: string): string | undefined {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return undefined;
  }
}

/**
 * The facts table for a configured provider: the cloud preset it points at (same API host), or Anthropic for any
 * Anthropic-type provider. Gateways and custom OpenAI-compatible servers have none, so their prices stay unknown.
 */
export function factsProvider(cfg: Pick<ProviderConfig, 'type' | 'baseUrl'>): string | undefined {
  if (cfg.type === 'anthropic') {
    return 'anthropic';
  }
  const host = hostOf(cfg.baseUrl);
  return PROVIDER_PRESETS.find((p) => p.group === 'cloud' && p.cfg.type === cfg.type && TABLES[p.key] && hostOf(p.cfg.baseUrl) === host)?.key;
}

/** Ids to try for a listed model: as listed, then without a release date or `-latest` (pinned snapshots share facts). */
function candidates(modelId: string): string[] {
  const n = modelId.trim().toLowerCase().replace(/^models\//, '');
  const out = [n];
  for (const re of [/-\d{8}$/, /-\d{4}-\d{2}-\d{2}$/, /-latest$/]) {
    const s = n.replace(re, '');
    if (s !== n && !out.includes(s)) {
      out.push(s);
    }
  }
  return out;
}

/** Facts for a model of one provider (a key from `factsProvider`). */
export function modelFacts(modelId: string, provider: string | undefined): ModelFacts | undefined {
  const table = provider ? TABLES[provider] : undefined;
  if (!table) {
    return undefined;
  }
  for (const id of candidates(modelId)) {
    if (Object.prototype.hasOwnProperty.call(table, id)) {
      return table[id];
    }
  }
  return undefined;
}

/**
 * Facts for a model behind an unknown cloud endpoint (a gateway or proxy), matched by id in any provider's table,
 * with or without a `vendor/` prefix. Only for limits and capabilities: the gateway's prices are its own.
 */
export function anyModelFacts(modelId: string): ModelFacts | undefined {
  const ids = candidates(modelId);
  const bare = ids.map((id) => id.slice(id.lastIndexOf('/') + 1));
  for (const key of Object.keys(TABLES)) {
    for (const id of [...ids, ...bare]) {
      if (Object.prototype.hasOwnProperty.call(TABLES[key], id)) {
        return TABLES[key][id];
      }
    }
  }
  return undefined;
}

/** Prices of a model when its provider bills per token and both input and output prices are known. */
export function pricingOf(facts: ModelFacts | undefined, provider: string | undefined): ModelPricing | undefined {
  if (!facts || !provider || UNPRICED.has(provider) || facts.input === undefined || facts.output === undefined) {
    return undefined;
  }
  return { input: facts.input, output: facts.output, cacheRead: facts.cacheRead, cacheWrite: facts.cacheWrite };
}

/** Output limit to report: the model's own, never above its context window; local models are bounded by context only. */
export function outputLimit(facts: ModelFacts | undefined, contextWindow: number, remote: boolean): number {
  if (facts?.maxOutput) {
    return Math.min(facts.maxOutput, contextWindow);
  }
  return remote ? Math.min(8192, contextWindow) : contextWindow;
}

/** Date of the bundled snapshot (`YYYY-MM-DD`). */
export const MODEL_FACTS_UPDATED: string = (bundled as unknown as { updated: string }).updated;
