import { ModelInfo, ModelOverride, ProviderConfig } from '../types';

/** Per-provider options from `localpilot.providers` that every provider type applies the same way (no `vscode` import). */

/** OpenRouter ranks apps by these; set unless the provider's own headers name them. */
export const OPENROUTER_HEADERS: Readonly<Record<string, string>> = { 'HTTP-Referer': 'https://github.com/isathish/localpilot', 'X-Title': 'LocalPilot' };

export function isOpenRouterUrl(url: string): boolean {
  try {
    return new URL(url).hostname.toLowerCase() === 'openrouter.ai';
  } catch {
    return false;
  }
}

/** `url` with `?api-version=` (Azure OpenAI deployment endpoints); unchanged without a version. */
export function withApiVersion(url: string, apiVersion: string | undefined): string {
  const v = apiVersion?.trim();
  if (!v) {
    return url;
  }
  return `${url}${url.includes('?') ? '&' : '?'}api-version=${encodeURIComponent(v)}`;
}

/** The provider's `timeoutMs` as a first-token wait floor (1 s to 30 min), or 0 when unset. */
export function firstTokenFloor(cfg: Pick<ProviderConfig, 'timeoutMs'> | undefined): number {
  const n = Number(cfg?.timeoutMs);
  return Number.isFinite(n) && n > 0 ? Math.min(1_800_000, Math.max(1000, Math.round(n))) : 0;
}

/** The override for a model id: exact first, then ignoring case. */
export function overrideFor(overrides: ProviderConfig['modelOverrides'], modelId: string): ModelOverride | undefined {
  if (!overrides) {
    return undefined;
  }
  if (Object.prototype.hasOwnProperty.call(overrides, modelId)) {
    return overrides[modelId];
  }
  const lower = modelId.toLowerCase();
  const key = Object.keys(overrides).find((k) => k.toLowerCase() === lower);
  return key ? overrides[key] : undefined;
}

const positive = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined);
const price = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined);

/** Listed models with the provider's `modelOverrides` applied: limits, capabilities, prices and temperature. */
export function applyModelOverrides(models: ModelInfo[], overrides: ProviderConfig['modelOverrides']): ModelInfo[] {
  if (!overrides || !Object.keys(overrides).length) {
    return models;
  }
  return models.map((m) => {
    const o = overrideFor(overrides, m.modelId);
    if (!o) {
      return m;
    }
    const out: ModelInfo = { ...m };
    const ctx = positive(o.contextWindow);
    if (ctx) {
      out.contextWindow = Math.round(ctx);
    }
    const maxOut = positive(o.maxOutput);
    out.maxOutputTokens = Math.min(maxOut ? Math.round(maxOut) : out.maxOutputTokens, out.contextWindow);
    if (typeof o.vision === 'boolean') {
      out.supportsVision = o.vision;
    }
    if (typeof o.reasoning === 'boolean') {
      out.supportsThinking = o.reasoning;
    }
    const input = price(o.inputPrice);
    const output = price(o.outputPrice);
    if (input !== undefined || output !== undefined) {
      const base = out.pricing;
      const i = input ?? base?.input;
      const p = output ?? base?.output;
      // A half-known price would make every cost estimate wrong: both sides are needed.
      if (i !== undefined && p !== undefined) {
        out.pricing = { ...base, input: i, output: p };
      }
    }
    if (typeof o.temperature === 'number' && Number.isFinite(o.temperature) && o.temperature >= 0) {
      out.temperature = Math.min(2, o.temperature);
    }
    return out;
  });
}

/** Keys of a request body that `extraBody` must never replace: the conversation and how it streams. */
const PROTECTED = new Set(['model', 'messages', 'stream', 'stream_options', 'tools', 'system']);
const isPlain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** `extra` merged into `body` (nested objects merged key by key), leaving the protected keys alone. Mutates `body`. */
export function withExtraBody<T extends Record<string, unknown>>(body: T, extra: Record<string, unknown> | undefined): T {
  if (!isPlain(extra)) {
    return body;
  }
  const merge = (into: Record<string, unknown>, from: Record<string, unknown>, top: boolean) => {
    for (const [k, v] of Object.entries(from)) {
      if ((top && PROTECTED.has(k)) || k === '__proto__' || k === 'constructor' || k === 'prototype') {
        continue;
      }
      if (isPlain(v) && isPlain(into[k])) {
        const copy = { ...(into[k] as Record<string, unknown>) };
        merge(copy, v, false);
        into[k] = copy;
      } else {
        into[k] = v;
      }
    }
  };
  merge(body, extra, true);
  return body;
}

/** A header name as HTTP allows it (RFC 9110 token). */
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

/** Headers kept from settings: valid names, string values without line breaks. */
export function cleanHeaders(raw: unknown): Record<string, string> | undefined {
  if (!isPlain(raw)) {
    return undefined;
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    const name = k.trim();
    if (HEADER_NAME.test(name) && (typeof v === 'string' || typeof v === 'number') && !/[\r\n]/.test(String(v))) {
      out[name] = String(v).trim();
    }
  }
  return Object.keys(out).length ? out : undefined;
}

/** Model overrides kept from settings: known fields with sane values only. */
export function cleanModelOverrides(raw: unknown): Record<string, ModelOverride> | undefined {
  if (!isPlain(raw)) {
    return undefined;
  }
  const out: Record<string, ModelOverride> = {};
  for (const [id, v] of Object.entries(raw)) {
    if (!id.trim() || !isPlain(v)) {
      continue;
    }
    const o: ModelOverride = {};
    const ctx = positive(v.contextWindow);
    const maxOut = positive(v.maxOutput);
    if (ctx) {
      o.contextWindow = Math.round(ctx);
    }
    if (maxOut) {
      o.maxOutput = Math.round(maxOut);
    }
    if (typeof v.vision === 'boolean') {
      o.vision = v.vision;
    }
    if (typeof v.reasoning === 'boolean') {
      o.reasoning = v.reasoning;
    }
    if (price(v.inputPrice) !== undefined) {
      o.inputPrice = price(v.inputPrice);
    }
    if (price(v.outputPrice) !== undefined) {
      o.outputPrice = price(v.outputPrice);
    }
    if (typeof v.temperature === 'number' && v.temperature >= 0 && v.temperature <= 2) {
      o.temperature = v.temperature;
    }
    if (Object.keys(o).length) {
      out[id.trim()] = o;
    }
  }
  return Object.keys(out).length ? out : undefined;
}

/** The provider option fields of a settings entry, cleaned (for sanitizeProviderConfig). */
export function cleanProviderOptions(p: ProviderConfig): Partial<ProviderConfig> {
  const out: Partial<ProviderConfig> = {};
  const headers = cleanHeaders(p.headers);
  if (headers) {
    out.headers = headers;
  }
  if (firstTokenFloor(p)) {
    out.timeoutMs = firstTokenFloor(p);
  }
  if (typeof p.apiVersion === 'string' && /^[\w.-]+$/.test(p.apiVersion.trim())) {
    out.apiVersion = p.apiVersion.trim();
  }
  const overrides = cleanModelOverrides(p.modelOverrides);
  if (overrides) {
    out.modelOverrides = overrides;
  }
  if (typeof p.defaultModel === 'string' && p.defaultModel.trim()) {
    out.defaultModel = p.defaultModel.trim();
  }
  if (typeof p.modelsUrl === 'string' && /^https?:\/\/\S+$/i.test(p.modelsUrl.trim())) {
    out.modelsUrl = p.modelsUrl.trim();
  }
  if (isPlain(p.extraBody) && Object.keys(p.extraBody).length) {
    out.extraBody = JSON.parse(JSON.stringify(p.extraBody)) as Record<string, unknown>;
  }
  return out;
}

/**
 * A model reference as routing resolves it: a bare provider id (`openrouter`) stands for that provider's
 * `defaultModel`. Other references are returned unchanged.
 */
export function expandProviderRef(ref: string, providers: Pick<ProviderConfig, 'id' | 'defaultModel'>[]): string {
  if (!ref || ref.includes('/')) {
    return ref;
  }
  const p = providers.find((x) => x.id === ref && x.defaultModel);
  return p ? `${p.id}/${p.defaultModel}` : ref;
}

/** Header sets merged left to right; a later name replaces an earlier one whatever its case (`Authorization` over `authorization`). */
export function mergeHeaders(...layers: Record<string, string>[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const layer of layers) {
    for (const [k, v] of Object.entries(layer)) {
      for (const existing of Object.keys(out)) {
        if (existing.toLowerCase() === k.toLowerCase()) {
          delete out[existing];
        }
      }
      out[k] = v;
    }
  }
  return out;
}
