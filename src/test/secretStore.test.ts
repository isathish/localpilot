import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { resolveApiKey, setSecretValues } from '../providers/cloud';
import { ProviderSecrets } from '../providers/secrets';
import { MemoryKeychain } from '../secrets/keychain';
import { SecretStore, SecretStoreLockedError } from '../secrets/store';
import { SharedSecretStorage } from '../secrets/vscodeStorage';

/** VS Code's own SecretStorage, in memory. */
function fakeVsSecrets(entries: [string, string][] = []) {
  const vault = new Map(entries);
  const changed = new vscode.EventEmitter<vscode.SecretStorageChangeEvent>();
  const storage = {
    get: async (k: string) => vault.get(k),
    store: async (k: string, v: string) => {
      vault.set(k, v);
      changed.fire({ key: k });
    },
    delete: async (k: string) => {
      vault.delete(k);
      changed.fire({ key: k });
    },
    onDidChange: changed.event,
  } as unknown as vscode.SecretStorage;
  return { vault, storage, dispose: () => changed.dispose() };
}

function memento(init: Record<string, unknown> = {}): vscode.Memento & { data: Map<string, unknown> } {
  const data = new Map(Object.entries(init));
  return { data, get: (k: string, d?: unknown) => (data.has(k) ? data.get(k) : d), update: async (k: string, v: unknown) => void data.set(k, v), keys: () => [...data.keys()] } as unknown as vscode.Memento & { data: Map<string, unknown> };
}

const wasm = () => {
  const ext = vscode.extensions.getExtension('localpilot.localpilot-agent');
  const dist = ext ? path.join(ext.extensionPath, 'dist', 'sqljs', 'sql-wasm.wasm') : '';
  return fs.existsSync(dist) ? dist : undefined;
};

suite('Secret store (shared with the CLI)', () => {
  let dir: string;
  setup(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lp-secret-store-test-'));
  });
  teardown(() => fs.rmSync(dir, { recursive: true, force: true }));

  const open = (keychain = new MemoryKeychain()) => () => SecretStore.open({ dir, keychain, wasmPath: wasm() });

  test('provider keys in VS Code secret storage move into the store once; the copies stay for a downgrade', async () => {
    const vs = fakeVsSecrets([
      ['localpilot.provider.openai', 'sk-vs-openai'],
      ['localpilot.provider.old-legacy', 'sk-vs-legacy'],
    ]);
    const state = memento({ 'localpilot.providerSecretOwners': { openai: 'user', gone: 'user' }, 'localpilot.providerSecretNames': ['old-legacy'] });
    const shared = new SharedSecretStorage(vs.storage, state, open(), undefined, { refreshMs: 60_000 });
    try {
      await shared.ready;
      assert.strictEqual(shared.error, undefined);
      const store = shared.secretStore!;
      assert.strictEqual(store.get('openai'), 'sk-vs-openai');
      assert.strictEqual(store.get('old-legacy'), 'sk-vs-legacy');
      assert.strictEqual(store.list().find((m) => m.name === 'openai')?.source, 'migrated:vscode');
      assert.strictEqual(vs.vault.get('localpilot.provider.openai'), 'sk-vs-openai', 'the VS Code copy is left for a downgrade');
      assert.deepStrictEqual(new Set(state.data.get('localpilot.secretStore.migrated') as string[]), new Set(['openai', 'gone', 'old-legacy']));
      assert.strictEqual(await shared.get('localpilot.provider.openai'), 'sk-vs-openai');
      assert.ok(!fs.readFileSync(store.file).includes('sk-vs-openai'), 'encrypted on disk');
    } finally {
      shared.dispose();
      vs.dispose();
    }
  });

  test('a deleted key does not come back from VS Code storage; other keys move over when first asked for', async () => {
    const vs = fakeVsSecrets([['localpilot.mcp.oauth.https://mcp.example.com/mcp', '{"t":1}']]);
    const state = memento({ 'localpilot.providerSecretOwners': { groq: 'user' } });
    const shared = new SharedSecretStorage(vs.storage, state, open(), undefined, { refreshMs: 60_000 });
    try {
      await shared.store('localpilot.provider.groq', 'gsk-1');
      assert.strictEqual(shared.secretStore!.get('groq'), 'gsk-1', 'stored under the bare name ${secret:groq} uses');
      assert.strictEqual(vs.vault.get('localpilot.provider.groq'), undefined, 'not written to VS Code storage');
      // A stale copy in VS Code's storage (an older version wrote it) must not resurrect a key deleted in the store.
      vs.vault.set('localpilot.provider.groq', 'gsk-stale');
      await shared.delete('localpilot.provider.groq');
      assert.strictEqual(await shared.get('localpilot.provider.groq'), undefined);
      assert.strictEqual(vs.vault.get('localpilot.provider.groq'), undefined, 'deleted there too');
      assert.strictEqual(await shared.get('localpilot.mcp.oauth.https://mcp.example.com/mcp'), '{"t":1}');
      assert.strictEqual(shared.secretStore!.get('localpilot.mcp.oauth.https://mcp.example.com/mcp'), '{"t":1}', 'moved on first use');
      assert.deepStrictEqual((await shared.keys()).sort(), ['localpilot.mcp.oauth.https://mcp.example.com/mcp']);
    } finally {
      shared.dispose();
      vs.dispose();
    }
  });

  test('another process writing the store reaches ProviderSecrets after a refresh', async () => {
    const kc = new MemoryKeychain();
    const vs = fakeVsSecrets();
    const shared = new SharedSecretStorage(vs.storage, memento(), open(kc), undefined, { refreshMs: 60_000 });
    const secrets = new ProviderSecrets(shared, memento());
    const cli = await SecretStore.open({ dir, keychain: kc, wasmPath: wasm() });
    try {
      await shared.ready;
      setSecretValues({ 'from-cli': undefined });
      const changed = new Promise<string>((resolve) => shared.onDidChange((e) => resolve(e.key)));
      cli.set('from-cli', 'sk-written-by-the-cli', 'cli');
      shared.refresh();
      assert.strictEqual(await changed, 'localpilot.provider.from-cli');
      // ProviderSecrets' listener loads the value (async get).
      for (let i = 0; i < 50 && !resolveApiKey({ apiKey: '${secret:from-cli}' }); i++) {
        await new Promise((r) => setTimeout(r, 10));
      }
      assert.strictEqual(resolveApiKey({ apiKey: '${secret:from-cli}' }), 'sk-written-by-the-cli');
    } finally {
      setSecretValues({ 'from-cli': undefined });
      cli.close();
      secrets.dispose();
      shared.dispose();
      vs.dispose();
    }
  });

  test('when the store cannot open, VS Code secret storage is used and the reason is kept for Settings', async () => {
    const vs = fakeVsSecrets([['localpilot.provider.a', 'sk-a']]);
    const shared = new SharedSecretStorage(vs.storage, memento(), () => SecretStore.open({ dir, keychain: null, passphrase: '', wasmPath: wasm() }));
    try {
      await shared.ready;
      assert.match(shared.error ?? '', /LOCALPILOT_SECRETS_PASSPHRASE/);
      assert.strictEqual(shared.secretStore, undefined);
      assert.strictEqual(await shared.get('localpilot.provider.a'), 'sk-a');
      await shared.store('localpilot.provider.b', 'sk-b');
      assert.strictEqual(vs.vault.get('localpilot.provider.b'), 'sk-b');
      assert.ok(!fs.existsSync(path.join(dir, 'secrets.db')), 'no file written without a key');
    } finally {
      shared.dispose();
      vs.dispose();
    }
  });

  test('a wrong passphrase is refused with SecretStoreLockedError', async () => {
    const s = await SecretStore.open({ dir, keychain: null, passphrase: 'right', wasmPath: wasm() });
    s.set('k', 'v');
    s.close();
    await assert.rejects(SecretStore.open({ dir, keychain: null, passphrase: 'wrong', wasmPath: wasm() }), (e: unknown) => e instanceof SecretStoreLockedError);
  });
});
