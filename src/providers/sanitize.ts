import { ProviderConfig } from '../types';
import { cleanProviderOptions } from './providerOptions';
import { VSCODE_LM_BASE_URL } from './vscodeLmMessages';

/** Keep only known fields and normalise URLs/ids so a malformed form can't produce a broken provider. */
export function sanitizeProviderConfig(p: ProviderConfig): ProviderConfig {
  const id = String(p.id || '').trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'provider';
  const type: ProviderConfig['type'] = p.type === 'ollama' || p.type === 'anthropic' || p.type === 'vscode-lm' ? p.type : 'openai';
  // VS Code's language models have no server: the placeholder URL keeps the required field meaningful.
  let baseUrl = type === 'vscode-lm' ? VSCODE_LM_BASE_URL : String(p.baseUrl || '').trim();
  if (type !== 'vscode-lm' && baseUrl === VSCODE_LM_BASE_URL) {
    baseUrl = '';
  }
  if (/^https?:\/*$/i.test(baseUrl)) {
    baseUrl = '';
  }
  baseUrl = baseUrl.replace(/\/+$/, '');
  if (baseUrl && type !== 'vscode-lm' && !/^https?:\/\//i.test(baseUrl)) {
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
  return { ...out, ...cleanProviderOptions(p) };
}
