// VS Code's view of the shared secret store: a vscode.SecretStorage over ~/.localpilot/secrets.db, so the extension in
// every window and the CLI read and write the same keys. Provider keys (`localpilot.provider.openai`) are stored under
// their bare name (`openai`), the name `${secret:openai}` references; other keys (MCP sign-in, sync credentials) under
// their full key. Opens in the background (`ready`); until then, and for good if it cannot open, every call goes to
// VS Code's own SecretStorage (the OS keychain), and `error` says why for Settings.
import * as vscode from 'vscode';
import { knownSecretNames } from '../providers/secrets';
import { SecretStore } from './store';
import { keyForName, nameForKey } from './storeStorage';

/** Names already moved out of VS Code's SecretStorage (or first written to the store), never copied in again. */
const MIGRATED_KEY = 'localpilot.secretStore.migrated';
const REFRESH_MS = 5_000;

export class SharedSecretStorage implements vscode.SecretStorage, vscode.Disposable {
  readonly ready: Promise<void>;
  /** The open store; undefined while opening or when it could not open. */
  secretStore: SecretStore | undefined;
  /** Why the store could not open (VS Code's SecretStorage is used instead). */
  error: string | undefined;
  private readonly emitter = new vscode.EventEmitter<vscode.SecretStorageChangeEvent>();
  readonly onDidChange = this.emitter.event;
  private readonly disposables: vscode.Disposable[] = [];
  /** Fires after the store opened, or failed to: Settings re-renders its status. */
  private readonly stateEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeState = this.stateEmitter.event;

  constructor(
    readonly fallback: vscode.SecretStorage,
    private readonly state: vscode.Memento,
    open: () => Promise<SecretStore>,
    private readonly log?: { info(m: string): void; warn(m: string): void },
    opts: { refreshMs?: number } = {}
  ) {
    // Changes in VS Code's storage matter while it is the one in use.
    this.disposables.push(this.emitter, this.stateEmitter, fallback.onDidChange((e) => !this.secretStore && this.emitter.fire(e)));
    this.ready = open()
      .then(async (store) => {
        this.secretStore = store;
        this.disposables.push(new vscode.Disposable(() => store.close()));
        store.onDidChange((names) => names.forEach((n) => this.emitter.fire({ key: keyForName(n) })));
        await this.migrate();
        // Another process (the CLI, another window) may change the file at any time: look every few seconds and when
        // this window gets focus.
        const timer = setInterval(() => this.refresh(), opts.refreshMs ?? REFRESH_MS);
        this.disposables.push(new vscode.Disposable(() => clearInterval(timer)), vscode.window.onDidChangeWindowState((w) => w.focused && this.refresh()));
      })
      .catch((e) => {
        this.error = e instanceof Error ? e.message : String(e);
        this.log?.warn(`secret store: ${this.error} — using VS Code's secret storage instead`);
      })
      .finally(() => this.stateEmitter.fire());
  }

  refresh(): void {
    try {
      this.secretStore?.refresh();
    } catch (e) {
      this.log?.warn(`secret store: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private migrated(): Set<string> {
    return new Set(this.state.get<string[]>(MIGRATED_KEY, []));
  }

  private async markMigrated(names: string[]): Promise<void> {
    const have = this.migrated();
    if (names.some((n) => !have.has(n))) {
      await this.state.update(MIGRATED_KEY, [...new Set([...have, ...names])]);
    }
  }

  /**
   * One time per name: copies the provider keys VS Code's SecretStorage holds into the store. The copies there stay
   * (an older LocalPilot still finds them after a downgrade); the store is the one used from now on.
   */
  private async migrate(): Promise<void> {
    const store = this.secretStore!;
    const done = this.migrated();
    const names = knownSecretNames(this.state).filter((n) => !done.has(n));
    if (!names.length) {
      return;
    }
    const found: Record<string, string> = {};
    for (const n of names) {
      if (store.get(n) !== undefined) {
        continue;
      }
      const v = await Promise.resolve(this.fallback.get(keyForName(n))).catch(() => undefined);
      if (v) {
        found[n] = v;
      }
    }
    if (Object.keys(found).length) {
      store.setMany(found, 'migrated:vscode');
      this.log?.info(`secret store: moved ${Object.keys(found).length} key(s) from VS Code's secret storage into ${store.file}`);
    }
    await this.markMigrated(names);
  }

  async get(key: string): Promise<string | undefined> {
    await this.ready;
    const store = this.secretStore;
    if (!store) {
      return this.fallback.get(key);
    }
    const name = nameForKey(key);
    const v = store.get(name);
    if (v !== undefined || this.migrated().has(name)) {
      return v;
    }
    // A key an earlier version kept in VS Code's storage that the one-time migration did not know about (an MCP
    // sign-in, a sync credential): moved over the first time it is asked for.
    const old = await Promise.resolve(this.fallback.get(key)).catch(() => undefined);
    if (old) {
      store.set(name, old, 'migrated:vscode');
    }
    await this.markMigrated([name]);
    return old;
  }

  async store(key: string, value: string): Promise<void> {
    await this.ready;
    if (!this.secretStore) {
      return this.fallback.store(key, value);
    }
    this.secretStore.set(nameForKey(key), value, 'vscode');
    await this.markMigrated([nameForKey(key)]);
  }

  async delete(key: string): Promise<void> {
    await this.ready;
    if (this.secretStore) {
      this.secretStore.delete(nameForKey(key));
      await this.markMigrated([nameForKey(key)]);
    }
    // Also VS Code's copy, so a deleted key never comes back from there.
    await Promise.resolve(this.fallback.delete(key)).catch(() => undefined);
  }

  async keys(): Promise<string[]> {
    await this.ready;
    return this.secretStore ? this.secretStore.list().map((m) => keyForName(m.name)) : [];
  }

  dispose(): void {
    for (const d of this.disposables.splice(0)) {
      d.dispose();
    }
  }
}
