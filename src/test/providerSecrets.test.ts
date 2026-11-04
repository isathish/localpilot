import * as assert from 'assert';
import * as vscode from 'vscode';
import { resolveHeaders, setSecretValues } from '../providers/cloud';
import { ProviderSecrets } from '../providers/secrets';
import { ProviderConfig } from '../types';

suite('Provider secrets', () => {
  test('a secret referenced only by a header is loaded at startup and never pruned', async () => {
    const vault = new Map<string, string>([['localpilot.provider.gw-header-only', 'tok-123']]);
    const changed = new vscode.EventEmitter<vscode.SecretStorageChangeEvent>();
    const storage = { get: async (k: string) => vault.get(k), store: async (k: string, v: string) => void vault.set(k, v), delete: async (k: string) => void vault.delete(k), keys: async () => [...vault.keys()], onDidChange: changed.event } as unknown as vscode.SecretStorage;
    const memo = new Map<string, unknown>([['localpilot.providerSecretOwners', { 'gw-header-only': 'user' }]]);
    const state = { get: (k: string, d?: unknown) => (memo.has(k) ? memo.get(k) : d), update: async (k: string, v: unknown) => void memo.set(k, v), keys: () => [...memo.keys()] } as unknown as vscode.Memento;
    const secrets = new ProviderSecrets(storage, state);
    const cfg = vscode.workspace.getConfiguration('localpilot');
    const before = cfg.inspect<ProviderConfig[]>('providers')?.globalValue;
    const gw: ProviderConfig = { id: 'gw-test', type: 'openai', baseUrl: 'https://gw.example/v1', headers: { Authorization: 'Bearer ${secret:gw-header-only}' } };
    try {
      await cfg.update('providers', [...(before ?? []), gw], vscode.ConfigurationTarget.Global);
      setSecretValues({ 'gw-header-only': undefined });
      await secrets.load();
      assert.deepStrictEqual(resolveHeaders(gw), { Authorization: 'Bearer tok-123' }, 'load() reads header references');
      await secrets.prune([gw]);
      assert.strictEqual(vault.get('localpilot.provider.gw-header-only'), 'tok-123', 'a header-only secret is not stale');
    } finally {
      await cfg.update('providers', before, vscode.ConfigurationTarget.Global);
      setSecretValues({ 'gw-header-only': undefined });
      secrets.dispose();
      changed.dispose();
    }
  });
});
