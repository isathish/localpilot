import { ProviderConfig } from '../types';

/** Keep only known fields and normalise URLs/ids so a malformed form can't produce a broken provider. */
export function sanitizeProviderConfig(p: ProviderConfig): ProviderConfig {
  const id = String(p.id || '').trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'provider';
  const type: ProviderConfig['type'] = p.type === 'ollama' || p.type === 'anthropic' ? p.type : 'openai';
  let baseUrl = String(p.baseUrl || '').trim().replace(/\/+$/, '');
  if (baseUrl && !/^https?:\/\//i.test(baseUrl)) {
    baseUrl = `http://${baseUrl}`;
  }
  const out: ProviderConfig = { id, type, baseUrl };
  if (p.displayName && String(p.displayName).trim()) {
    out.displayName = String(p.displayName).trim();
  }
  if (p.apiKey && String(p.apiKey).trim()) {
    out.apiKey = String(p.apiKey).trim();
  }
  if (Array.isArray(p.models) && p.models.length) {
    out.models = p.models.map((m) => String(m).trim()).filter(Boolean);
  }
  if (typeof p.contextWindow === 'number' && p.contextWindow > 0) {
    out.contextWindow = Math.round(p.contextWindow);
  }
  if (typeof p.cloud === 'boolean') {
    out.cloud = p.cloud;
  }
  if (p.enabled === false) {
    out.enabled = false;
  }
  return out;
}
