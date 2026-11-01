import * as vscode from 'vscode';
import { ProviderConfig } from '../types';
import { secretRefs, setSecretValues } from './cloud';

const PREFIX = 'localpilot.provider.';
/** Names stored so far, so keys of removed providers can be deleted (SecretStorage cannot list its keys). */
const NAMES_KEY = 'localpilot.providerSecretNames';

/**
 * Provider API keys kept in VS Code's secret storage (the OS keychain) instead of settings.json. Settings hold a
 * `${secret:<name>}` reference; the values are loaded into memory so providers resolve keys synchronously.
 */
export class ProviderSecrets implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly storage: vscode.SecretStorage,
    private readonly state: vscode.Memento
  ) {
    // A key entered in another window, or deleted there.
    this.disposables.push(
      storage.onDidChange(async (e) => {
        if (e.key.startsWith(PREFIX)) {
          const name = e.key.slice(PREFIX.length);
          setSecretValues({ [name]: await storage.get(e.key) });
        }
      })
    );
  }

  /** Loads every key the configured providers reference (all settings scopes). */
  async load(): Promise<void> {
    const names = [...new Set(configuredProviders().flatMap((p) => secretRefs(p.apiKey)))];
    if (!names.length) {
      return;
    }
    const values = await Promise.all(names.map((n) => this.storage.get(PREFIX + n)));
    setSecretValues(Object.fromEntries(names.map((n, i) => [n, values[i]])));
  }

  /** Stores a key under `name` and returns the reference to put in settings. */
  async store(name: string, key: string): Promise<string> {
    await this.storage.store(PREFIX + name, key);
    await this.remember(name);
    setSecretValues({ [name]: key });
    return `\${secret:${name}}`;
  }

  /** Moves pasted keys into secret storage, returning the providers with `${secret:<id>}` in their place. */
  async protect(providers: ProviderConfig[]): Promise<ProviderConfig[]> {
    const out: ProviderConfig[] = [];
    for (const p of providers) {
      const key = p.apiKey?.trim();
      out.push(key && !key.includes('${') ? { ...p, apiKey: await this.store(p.id, key) } : p);
    }
    return out;
  }

  /** Deletes stored keys that no provider in any settings scope references any more. */
  async prune(providers: ProviderConfig[] = configuredProviders()): Promise<void> {
    const used = new Set([...providers, ...configuredProviders()].flatMap((p) => secretRefs(p.apiKey)));
    const known = this.state.get<string[]>(NAMES_KEY, []);
    const stale = known.filter((n) => !used.has(n));
    if (!stale.length) {
      return;
    }
    await Promise.all(stale.map((n) => this.storage.delete(PREFIX + n)));
    await this.state.update(NAMES_KEY, known.filter((n) => used.has(n)));
    setSecretValues(Object.fromEntries(stale.map((n) => [n, undefined])));
  }

  private async remember(name: string): Promise<void> {
    const known = this.state.get<string[]>(NAMES_KEY, []);
    if (!known.includes(name)) {
      await this.state.update(NAMES_KEY, [...known, name]);
    }
  }

  dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}

/** Providers from every settings scope, so a key referenced only by workspace settings is loaded and kept too. */
function configuredProviders(): ProviderConfig[] {
  const i = vscode.workspace.getConfiguration('localpilot').inspect<ProviderConfig[]>('providers');
  return [...(i?.globalValue ?? []), ...(i?.workspaceValue ?? []), ...(i?.workspaceFolderValue ?? [])].filter((p) => p && typeof p === 'object');
}
