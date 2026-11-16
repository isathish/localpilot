// The secret store seen through the shape of vscode.SecretStorage (get / store / delete / onDidChange), so code written
// for VS Code's secret storage (MCP sign-in, sync credentials) runs over the shared store in the CLI too. Pure Node.
import type { SecretStore } from './store';

/** Prefix VS Code code gives provider keys; in the store they are kept under the bare name (`openai`). */
export const PROVIDER_KEY_PREFIX = 'localpilot.provider.';

/** Store name of a SecretStorage key: `localpilot.provider.openai` → `openai`; other keys keep their full name. */
export function nameForKey(key: string): string {
  return key.startsWith(PROVIDER_KEY_PREFIX) ? key.slice(PROVIDER_KEY_PREFIX.length) : key;
}

/** SecretStorage key of a store name: the inverse of `nameForKey`. */
export function keyForName(name: string): string {
  return name.startsWith('localpilot.') ? name : PROVIDER_KEY_PREFIX + name;
}

export class StoreSecretStorage {
  private readonly listeners = new Set<(e: { key: string }) => unknown>();
  private readonly sub: { dispose(): void };

  constructor(
    readonly backing: SecretStore,
    private readonly source = 'cli'
  ) {
    this.sub = backing.onDidChange((names) => {
      for (const n of names) {
        this.listeners.forEach((l) => l({ key: keyForName(n) }));
      }
    });
  }

  async get(key: string): Promise<string | undefined> {
    return this.backing.get(nameForKey(key));
  }

  async store(key: string, value: string): Promise<void> {
    this.backing.set(nameForKey(key), value, this.source);
  }

  async delete(key: string): Promise<void> {
    this.backing.delete(nameForKey(key));
  }

  async keys(): Promise<string[]> {
    return this.backing.list().map((m) => keyForName(m.name));
  }

  onDidChange = (listener: (e: { key: string }) => unknown): { dispose(): void } => {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  };

  dispose(): void {
    this.sub.dispose();
    this.listeners.clear();
  }
}
