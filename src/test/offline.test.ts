import * as assert from 'assert';
import type * as os from 'os';
import * as vscode from 'vscode';
import { checkOnline, ConnectivityMonitor, hasExternalInterface, probeHosts } from '../providers/connectivity';
import { ProviderRegistry } from '../providers/registry';
import type { ModelInfo, ProviderConfig } from '../types';
import { LONG_RUN_MS, shouldNotifyFinish } from '../ui/notifyPolicy';
import { formatDuration } from '../ui/runNotifier';

const log = vscode.window.createOutputChannel('LocalPilot offline test', { log: true });

type Ifaces = NodeJS.Dict<os.NetworkInterfaceInfo[]>;
const iface = (address: string, family: 'IPv4' | 'IPv6', internal = false): os.NetworkInterfaceInfo =>
  ({ address, family, internal, netmask: '', mac: '', cidr: null, ...(family === 'IPv6' ? { scopeid: 0 } : {}) }) as os.NetworkInterfaceInfo;
const LOOPBACK: Ifaces = { lo0: [iface('127.0.0.1', 'IPv4', true), iface('::1', 'IPv6', true)] };
const LINK_LOCAL: Ifaces = { ...LOOPBACK, en0: [iface('169.254.10.2', 'IPv4'), iface('fe80::1', 'IPv6')] };
const WIFI: Ifaces = { ...LOOPBACK, en0: [iface('192.168.1.20', 'IPv4')] };
const cloud: ProviderConfig = { id: 'openai', type: 'openai', baseUrl: 'https://api.openai.com/v1' };
const local: ProviderConfig = { id: 'ollama', type: 'ollama', baseUrl: 'http://localhost:11434' };
const fail = (code: string) => () => Promise.reject(Object.assign(new Error(code), { code }));

suite('Offline: connectivity checks, the offline route and run notifications', () => {
  test('only loopback or link-local addresses means no network', () => {
    assert.strictEqual(hasExternalInterface(LOOPBACK), false);
    assert.strictEqual(hasExternalInterface(LINK_LOCAL), false);
    assert.strictEqual(hasExternalInterface(WIFI), true);
    assert.strictEqual(hasExternalInterface({ en0: [iface('2a01:4f8::1', 'IPv6')] }), true);
  });

  test('only enabled cloud providers with a host name are looked up', () => {
    const hosts = probeHosts([
      cloud,
      local,
      { id: 'lan', type: 'openai', baseUrl: 'http://192.168.1.5:8080/v1' },
      { id: 'off', type: 'openai', baseUrl: 'https://api.mistral.ai/v1', enabled: false },
      { id: 'claude', type: 'anthropic', baseUrl: '' },
      { id: 'copilot', type: 'vscode-lm', baseUrl: '' },
      { id: 'ip', type: 'openai', baseUrl: 'https://8.8.8.8/v1' },
    ]);
    assert.deepStrictEqual(hosts, ['api.openai.com', 'api.anthropic.com']);
  });

  test('a check is offline when interfaces are gone or every DNS lookup is unreachable; an answer of any kind is online', async () => {
    const deps = { interfaces: () => WIFI, providers: () => [cloud], proxy: () => false, resolve: () => Promise.resolve(['1.2.3.4']) };
    assert.strictEqual(await checkOnline(deps), true);
    assert.strictEqual(await checkOnline({ ...deps, interfaces: () => LOOPBACK }), false, 'no network at all');
    assert.strictEqual(await checkOnline({ ...deps, resolve: fail('ETIMEOUT') }), false, 'DNS servers unreachable');
    assert.strictEqual(await checkOnline({ ...deps, resolve: fail('ENOTFOUND') }), true, 'the server answered "no such name": the network works');
    assert.strictEqual(await checkOnline({ ...deps, resolve: fail('ETIMEOUT'), proxy: () => true }), true, 'behind a proxy only interfaces count');
    assert.strictEqual(await checkOnline({ ...deps, resolve: fail('ETIMEOUT'), providers: () => [local] }), true, 'no cloud provider: nothing is looked up');
    let asked = 0;
    await checkOnline({ ...deps, providers: () => [local], resolve: () => (asked++, Promise.resolve([])) });
    assert.strictEqual(asked, 0, 'no lookup without a cloud provider');
  });

  test('the monitor needs two failed lookups in a row, but goes offline at once when the interfaces are gone', async () => {
    let ifaces = WIFI;
    let resolve: (h: string) => Promise<unknown> = () => Promise.resolve([]);
    const mon = new ConnectivityMonitor({ interfaces: () => ifaces, providers: () => [cloud], proxy: () => false, resolve: (h) => resolve(h), now: () => 42 });
    const seen: boolean[] = [];
    mon.onChange((s) => seen.push(s.offline));
    try {
      assert.strictEqual((await mon.check()).offline, false);
      resolve = fail('ETIMEOUT');
      assert.strictEqual((await mon.check()).offline, false, 'one slow lookup does not flip it');
      assert.strictEqual((await mon.check()).offline, true);
      resolve = () => Promise.resolve([]);
      assert.strictEqual((await mon.check()).offline, false);
      ifaces = LOOPBACK;
      assert.strictEqual((await mon.check()).offline, true, 'no interfaces: offline right away');
      assert.deepStrictEqual(seen, [true, false, true]);
      assert.strictEqual(mon.current.since, 42);
    } finally {
      mon.dispose();
    }
  });

  test('offline, a chat on a cloud model falls back to a local model for the turn (never the other way)', async () => {
    const cfg = vscode.workspace.getConfiguration('localpilot');
    const prev = cfg.inspect('providers')?.globalValue;
    await cfg.update('providers', [{ id: 'lm', type: 'openai', baseUrl: 'http://127.0.0.1:9' }, { id: 'cloud', type: 'openai', baseUrl: 'https://api.example.com/v1', apiKey: 'k' }], vscode.ConfigurationTarget.Global);
    const reg = new ProviderRegistry(log);
    try {
      const mk = (pid: string, id: string, remote?: boolean): ModelInfo => ({ id: `${pid}/${id}`, providerId: pid, modelId: id, name: id, contextWindow: 32768, maxOutputTokens: 4096, supportsTools: true, supportsVision: false, ...(remote ? { remote } : {}) });
      const models = [mk('lm', 'qwen-coder'), mk('cloud', 'big-coder', true)];
      (reg as unknown as { listModels: () => Promise<ModelInfo[]> }).listModels = async () => models;
      const online = await reg.route({ modelRef: 'cloud/big-coder', start: false });
      assert.strictEqual(online.model.id, 'cloud/big-coder');
      reg.offline = true;
      const off = await reg.route({ modelRef: 'cloud/big-coder', start: false });
      assert.strictEqual(off.model.id, 'lm/qwen-coder');
      assert.strictEqual(off.fallback, true);
      assert.strictEqual(off.unavailable, true);
      assert.match(off.reason ?? '', /^No network — big-coder needs the internet/);
      assert.strictEqual((await reg.route({ start: false })).model.id, 'lm/qwen-coder', 'Auto picks a local model');
      // Nothing local to fall back on: routing is unchanged and the request reports the network error itself.
      models.splice(0, 1);
      assert.strictEqual((await reg.route({ modelRef: 'cloud/big-coder', start: false })).model.id, 'cloud/big-coder');
    } finally {
      reg.dispose();
      await cfg.update('providers', prev, vscode.ConfigurationTarget.Global);
    }
  });

  test('image turns never move a local chat to a cloud model; models.localOnly keeps every automatic pick local', async () => {
    const cfg = vscode.workspace.getConfiguration('localpilot');
    const prev = { providers: cfg.inspect('providers')?.globalValue, localOnly: cfg.inspect('models.localOnly')?.globalValue, vision: cfg.inspect('routing.vision')?.globalValue, fallbacks: cfg.inspect('routing.fallbackModels')?.globalValue };
    await cfg.update('providers', [{ id: 'lm', type: 'openai', baseUrl: 'http://127.0.0.1:9' }, { id: 'cloud', type: 'openai', baseUrl: 'https://api.example.com/v1', apiKey: 'k' }], vscode.ConfigurationTarget.Global);
    await cfg.update('routing.vision', '', vscode.ConfigurationTarget.Global);
    const reg = new ProviderRegistry(log);
    try {
      const mk = (pid: string, id: string, o: Partial<ModelInfo> = {}): ModelInfo => ({ id: `${pid}/${id}`, providerId: pid, modelId: id, name: id, contextWindow: 32768, maxOutputTokens: 4096, supportsTools: true, supportsVision: false, ...o });
      const models = [mk('lm', 'qwen-coder'), mk('cloud', 'big-vision', { remote: true, supportsVision: true }), mk('cloud', 'big-coder', { remote: true, supportsFim: true })];
      (reg as unknown as { listModels: () => Promise<ModelInfo[]> }).listModels = async () => models;
      // A local chat with an image and only a cloud model that can see: it stays local and says why.
      const img = await reg.route({ modelRef: 'lm/qwen-coder', needsVision: true, start: false });
      assert.strictEqual(img.model.id, 'lm/qwen-coder');
      assert.match(img.visionNotice ?? '', /only vision model available is big-vision, a cloud model .* does not send your images to the cloud on its own/);
      assert.match(img.visionNotice ?? '', /Install a local vision model .* or pick big-vision for this chat or set localpilot\.routing\.vision/);
      // Auto with an image: also stays local.
      const autoImg = await reg.route({ needsVision: true, start: false });
      assert.strictEqual(autoImg.model.id, 'lm/qwen-coder');
      assert.ok(autoImg.visionNotice);
      // A cloud chat may move to another cloud model that can see, and an explicitly configured cloud vision model is used.
      assert.strictEqual((await reg.route({ modelRef: 'cloud/big-coder', needsVision: true, start: false })).model.id, 'cloud/big-vision');
      await cfg.update('routing.vision', 'cloud/big-vision', vscode.ConfigurationTarget.Global);
      const chosen = await reg.route({ modelRef: 'lm/qwen-coder', needsVision: true, start: false });
      assert.strictEqual(chosen.model.id, 'cloud/big-vision', 'the user picked it in localpilot.routing.vision');
      assert.strictEqual(chosen.visionNotice, undefined);
      await cfg.update('routing.vision', '', vscode.ConfigurationTarget.Global);
      // Completions on a local model never move to a cloud FIM model on their own.
      assert.strictEqual((await reg.route({ modelRef: 'lm/qwen-coder', role: 'completion', start: false })).model.id, 'lm/qwen-coder');

      // localOnly: Auto, fallback (also the user's fallback order) and every role stay local; an explicit choice still works.
      await cfg.update('routing.fallbackModels', ['cloud/big-coder'], vscode.ConfigurationTarget.Global);
      await cfg.update('models.localOnly', true, vscode.ConfigurationTarget.Global);
      for (const role of ['agent', 'fast', 'reasoning', 'completion', 'vision'] as const) {
        assert.ok(!(await reg.route({ role, start: false })).model.remote, `${role} picks a local model`);
      }
      const gone = await reg.route({ modelRef: 'lm/missing', start: false });
      assert.strictEqual(gone.model.id, 'lm/qwen-coder', 'the fallback order skips cloud entries');
      assert.strictEqual((await reg.route({ modelRef: 'cloud/big-coder', start: false })).model.id, 'cloud/big-coder', 'an explicit cloud choice is honoured');
      models.splice(0, 1);
      await assert.rejects(reg.route({ start: false }), /localpilot\.models\.localOnly/);
      await cfg.update('models.localOnly', false, vscode.ConfigurationTarget.Global);
      assert.ok((await reg.route({ start: false })).model.remote, 'setting off: with nothing local, a cloud model is the last resort as before');
    } finally {
      reg.dispose();
      await cfg.update('providers', prev.providers, vscode.ConfigurationTarget.Global);
      await cfg.update('models.localOnly', prev.localOnly, vscode.ConfigurationTarget.Global);
      await cfg.update('routing.vision', prev.vision, vscode.ConfigurationTarget.Global);
      await cfg.update('routing.fallbackModels', prev.fallbacks, vscode.ConfigurationTarget.Global);
    }
  });

  test('a finished run notifies when hidden after a long run, or at once when it failed or needs you', () => {
    assert.strictEqual(shouldNotifyFinish('whenHidden', false, true, 5_000, 'ok'), false, 'a short run that went fine');
    assert.strictEqual(shouldNotifyFinish('whenHidden', false, true, LONG_RUN_MS, 'ok'), true);
    assert.strictEqual(shouldNotifyFinish('whenHidden', true, false, 3_000, 'error'), true);
    assert.strictEqual(shouldNotifyFinish('whenHidden', false, true, 3_000, 'attention'), true);
    assert.strictEqual(shouldNotifyFinish('whenHidden', true, true, 600_000, 'error'), false, 'the chat is on screen');
    assert.strictEqual(shouldNotifyFinish('always', true, true, 1_000, 'ok'), true);
    assert.strictEqual(shouldNotifyFinish('off', false, false, 600_000, 'error'), false);
    assert.deepStrictEqual([formatDuration(45_000), formatDuration(185_000), formatDuration(3_900_000), formatDuration(3_600_000)], ['45 s', '3 min', '1 h 5 min', '1 h']);
  });
});
