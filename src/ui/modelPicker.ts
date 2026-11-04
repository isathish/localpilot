import * as vscode from 'vscode';
import { editableProviders } from '../config';
import { ProviderConfig } from '../types';

/** Model ids starred in the chat's model menu (pinned to its top), kept across windows in globalState. */
const FAVORITES_KEY = 'favoriteModels';

export function favoriteModels(state: vscode.Memento | undefined): string[] {
  const v = state?.get<unknown>(FAVORITES_KEY);
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && !!x) : [];
}

/** Stars or unstars a model; returns the new list. */
export async function toggleFavoriteModel(state: vscode.Memento | undefined, id: string): Promise<string[]> {
  const cur = favoriteModels(state);
  const next = cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id];
  await state?.update(FAVORITES_KEY, next);
  return next;
}

/**
 * Providers a typed model id can be used with: OpenAI-compatible and Anthropic APIs, which serve ids they do not
 * list (Ollama serves only what is pulled).
 */
export function manualModelProviders(providers: ProviderConfig[]): string[] {
  return providers.filter((p) => p.enabled !== false && p.type !== 'ollama').map((p) => p.id);
}

/** A model id typed into the picker: no spaces or control characters, a sane length. */
export function validModelId(raw: string): string | undefined {
  const id = raw.trim();
  return id && id.length <= 200 && !/[\s\u0000-\u001f]/.test(id) ? id : undefined;
}

/**
 * Adds a typed model id to the provider's `models` list in the settings scope the provider list lives in, so
 * discovery lists it (with the provider's overrides) and routing serves it. Returns the full `provider/model` id.
 */
export async function addManualModel(providerId: string, rawId: string): Promise<string> {
  const modelId = validModelId(rawId);
  if (!modelId) {
    throw new Error(`"${rawId}" is not a model id`);
  }
  const { list, target } = editableProviders();
  const i = list.findIndex((p) => p.id === providerId);
  if (i < 0) {
    throw new Error(`No provider "${providerId}" in your settings`);
  }
  const p = list[i];
  if (!(p.models ?? []).includes(modelId)) {
    list[i] = { ...p, models: [...(p.models ?? []), modelId] };
    await vscode.workspace.getConfiguration('localpilot').update('providers', list, target);
  }
  return `${providerId}/${modelId}`;
}
