import * as crypto from 'crypto';
import * as vscode from 'vscode';
import { ProviderConfig } from '../types';
import { keyForName } from '../secrets/storeStorage';
import { secretRefs, setSecretValues } from './cloud';

const PREFIX = 'localpilot.provider.';
/**
 * Names stored so far and who owns each ('user', or the hash of the workspace whose settings hold the reference), so
 * keys of removed providers can be deleted (SecretStorage cannot list its keys) without touching another workspace's.
 * Names from the older `localpilot.providerSecretNames` list have no owner and are never swept.
 */
const OWNERS_KEY = 'localpilot.providerSecretOwners';
/** Names stored by older versions (no owner); still reserved so a new key never takes one over. */
const LEGACY_NAMES_KEY = 'localpilot.providerSecretNames';

/** Every provider key name this extension stored so far (owned or legacy), for the one-time move into the secret store. */
export function knownSecretNames(state: Pick<vscode.Memento, 'get'>): string[] {
  return [...new Set([...Object.keys(state.get<Record<string, string>>(OWNERS_KEY, {})), ...state.get<string[]>(LEGACY_NAMES_KEY, [])])];
}

/**
 * Provider API keys kept in LocalPilot's encrypted secret store (shared with the CLI; VS Code's secret storage when it
 * cannot open) instead of settings.json. Settings hold a
 * `${secret:<name>}` reference; the values are loaded into memory so providers resolve keys synchronously.
 */
export class ProviderSecrets implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    readonly storage: vscode.SecretStorage,
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
    const names = [...new Set([...configuredProviders().flatMap(providerRefs), ...webSearchRefs()])];
    if (!names.length) {
      return;
    }
    const values = await Promise.all(names.map((n) => this.storage.get(PREFIX + n)));
    setSecretValues(Object.fromEntries(names.map((n, i) => [n, values[i]])));
  }

  /** Stores a key under `name` and returns the reference to put in settings. */
  async store(name: string, key: string, owner: 'user' | 'workspace' = 'user'): Promise<string> {
    await this.storage.store(PREFIX + name, key);
    await this.remember(name, owner === 'user' ? 'user' : this.workspaceOwner());
    setSecretValues({ [name]: key });
    return `\${secret:${name}}`;
  }

  /**
   * Moves pasted keys into secret storage, returning the providers with `${secret:<id>}` in their place. Workspace keys
   * get a per-workspace name so they never overwrite a user-scope key of a provider with the same id, and every pasted
   * key gets a name nothing references yet (`<id>-2`, …), so it never overwrites a key another entry, scope or window
   * still uses; the replaced one is deleted by `prune`.
   */
  async protect(providers: ProviderConfig[], scope: 'user' | 'workspace' = 'user'): Promise<ProviderConfig[]> {
    const taken = new Set([
      ...Object.keys(this.state.get<Record<string, string>>(OWNERS_KEY, {})),
      ...this.state.get<string[]>(LEGACY_NAMES_KEY, []),
      ...[...configuredProviders(), ...providers].flatMap(providerRefs),
    ]);
    const out: ProviderConfig[] = [];
    for (const p of providers) {
      const key = p.apiKey?.trim();
      if (!key || key.includes('${')) {
        out.push(p);
        continue;
      }
      const base = (scope === 'workspace' ? `${p.id}.ws-${this.workspaceOwner()}` : p.id).replace(/[^A-Za-z0-9_.-]/g, '_');
      let name = base;
      for (let n = 2; taken.has(name); n++) {
        name = `${base}-${n}`;
      }
      taken.add(name);
      out.push({ ...p, apiKey: await this.store(name, key, scope) });
    }
    return out;
  }

  /**
   * Deletes stored keys of this user or this workspace that no provider visible here references any more. Keys owned
   * by other workspaces are kept: their settings are not visible from this window. With `only`, just those names
   * (the references a settings write dropped) are candidates.
   */
  async prune(providers: ProviderConfig[] = configuredProviders(), only?: string[]): Promise<void> {
    const used = new Set([...[...providers, ...configuredProviders()].flatMap(providerRefs), ...webSearchRefs()]);
    const owners = this.state.get<Record<string, string>>(OWNERS_KEY, {});
    const here = this.workspaceOwner();
    const stale = [...new Set(only ?? Object.keys(owners))].filter((n) => n in owners && !used.has(n) && (owners[n] === 'user' || owners[n] === here));
    if (!stale.length) {
      return;
    }
    await Promise.all(stale.map((n) => this.storage.delete(PREFIX + n)));
    const kept = { ...owners };
    for (const n of stale) {
      delete kept[n];
    }
    await this.state.update(OWNERS_KEY, kept);
    setSecretValues(Object.fromEntries(stale.map((n) => [n, undefined])));
  }

  /** Loads the named keys (those MCP server configurations reference) that are not loaded yet. */
  async loadNames(names: string[]): Promise<void> {
    const want = [...new Set(names)];
    if (!want.length) {
      return;
    }
    const values = await Promise.all(want.map((n) => this.storage.get(PREFIX + n)));
    setSecretValues(Object.fromEntries(want.map((n, i) => [n, values[i]]).filter(([, v]) => v)));
  }

  /**
   * Stores a value an MCP server file references (`${secret:<name>}`). It has no owner, so `prune` (which only knows
   * provider and web search references) never deletes it.
   */
  async storeUnowned(name: string, value: string): Promise<string> {
    await this.storage.store(PREFIX + name, value);
    setSecretValues({ [name]: value });
    return `\${secret:${name}}`;
  }

  /** Replaces the value of a stored secret by its store name (Settings → Secrets → Replace…). */
  async replace(name: string, value: string): Promise<void> {
    await this.storage.store(keyForName(name), value);
    if (!name.startsWith('localpilot.')) {
      setSecretValues({ [name]: value });
    }
  }

  /** Deletes a stored secret by its store name (Settings → Secrets → Delete). */
  async remove(name: string): Promise<void> {
    await this.storage.delete(keyForName(name));
    if (!name.startsWith('localpilot.')) {
      setSecretValues({ [name]: undefined });
    }
  }

  private async remember(name: string, owner: string): Promise<void> {
    const owners = this.state.get<Record<string, string>>(OWNERS_KEY, {});
    if (owners[name] !== owner) {
      await this.state.update(OWNERS_KEY, { ...owners, [name]: owner });
    }
  }

  /** Short stable id of the open workspace (or folder). */
  private workspaceOwner(): string {
    const id = vscode.workspace.workspaceFile?.toString() ?? vscode.workspace.workspaceFolders?.[0]?.uri.toString() ?? '';
    return crypto.createHash('sha256').update(id).digest('hex').slice(0, 8);
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

/** Secret names a provider references, in its API key or its header values. */
function providerRefs(p: ProviderConfig): string[] {
  const headers = p.headers && typeof p.headers === 'object' ? Object.values(p.headers) : [];
  return [...secretRefs(p.apiKey), ...headers.flatMap((v) => secretRefs(String(v)))];
}

/** The web search API key's references in every settings scope; it shares the keychain with provider keys. */
function webSearchRefs(): string[] {
  const i = vscode.workspace.getConfiguration('localpilot').inspect<string>('webSearch.apiKey');
  return [i?.globalValue, i?.workspaceValue, i?.workspaceFolderValue].flatMap((v) => (typeof v === 'string' ? secretRefs(v) : []));
}
