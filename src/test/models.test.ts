import * as assert from 'assert';
import * as http from 'http';
import { AddressInfo } from 'net';
import * as vscode from 'vscode';
import { catalogForSystem, lookupCatalog, matchesCatalog, MODEL_CATALOG, modelFootprintGb, starterPlan } from '../providers/catalog';
import { ModelManager, ollamaInstallCommand } from '../providers/modelManager';
import { isSaturated, pickAlternative, pickForRole, ProviderRegistry, scoreForRole } from '../providers/registry';
import { buildProfile, estimateModelGb, fits, overrideSystemProfile, parameterSizeB } from '../providers/system';
import type { LocalPilotApi } from '../extension';
import { ModelInfo } from '../types';

/** Ollama look-alike with pull/delete so the model manager can be exercised without downloading anything. */
interface FakeModel {
  name: string;
  caps: string[];
  ctx: number;
  size: number;
  params: string;
}

function fakeOllama(): Promise<{ url: string; close(): void; pulled: string[]; deleted: string[]; models: FakeModel[]; chats: Record<string, unknown>[]; loaded: string[] }> {
  const models: FakeModel[] = [
    { name: 'qwen2.5-coder:14b', caps: ['completion', 'tools'], ctx: 32768, size: 9.0e9, params: '14.8B' },
    { name: 'qwen2.5-coder:1.5b-base', caps: ['completion', 'insert'], ctx: 32768, size: 1.0e9, params: '1.5B' },
    { name: 'qwen2.5vl:7b', caps: ['completion', 'vision'], ctx: 32768, size: 6.0e9, params: '8.3B' },
    { name: 'nomic-embed-text', caps: ['embedding'], ctx: 2048, size: 0.3e9, params: '137M' },
  ];
  const pulled: string[] = [];
  const deleted: string[] = [];
  /** Bodies of /api/chat requests (warm-ups have no messages). */
  const chats: Record<string, unknown>[] = [];
  /** What /api/ps reports as loaded in memory. */
  const loaded: string[] = [];
  const srv = http.createServer((req, res) => {
    const json = (body: unknown) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(body));
    };
    const readBody = (cb: (b: Record<string, string>) => void) => {
      let body = '';
      req.on('data', (d) => (body += d));
      req.on('end', () => cb(JSON.parse(body || '{}')));
    };
    if (req.url === '/api/version') {
      return json({ version: '0.6.0' });
    }
    if (req.url === '/api/tags') {
      return json({ models: models.filter((m) => !deleted.includes(m.name)).map((m) => ({ name: m.name, model: m.name, size: m.size, details: { family: 'qwen2', parameter_size: m.params } })) });
    }
    if (req.url === '/api/show') {
      return readBody((b) => {
        const m = models.find((x) => x.name === b.model);
        json(m ? { capabilities: m.caps, model_info: { 'qwen2.context_length': m.ctx }, details: { family: 'qwen2', parameter_size: m.params } } : {});
      });
    }
    if (req.url === '/api/pull') {
      return readBody((b) => {
        res.setHeader('content-type', 'application/x-ndjson');
        if (b.model === 'nope:1b') {
          res.end(`${JSON.stringify({ error: 'pull model manifest: file does not exist' })}\n`);
          return;
        }
        const lines = [
          { status: 'pulling manifest' },
          { status: 'pulling abc', digest: 'abc', total: 1000, completed: 0 },
          { status: 'pulling abc', digest: 'abc', total: 1000, completed: 500 },
          { status: 'pulling def', digest: 'def', total: 200, completed: 200 },
          { status: 'pulling abc', digest: 'abc', total: 1000, completed: 1000 },
          { status: 'verifying sha256 digest' },
          { status: 'success' },
        ];
        let i = 0;
        const tick = () => {
          if (i >= lines.length) {
            pulled.push(b.model);
            models.push({ name: b.model, caps: ['completion', 'tools'], ctx: 8192, size: 1.2e9, params: '1.7B' });
            res.end();
            return;
          }
          res.write(`${JSON.stringify(lines[i++])}\n`);
          setTimeout(tick, 15);
        };
        tick();
      });
    }
    if (req.url === '/api/ps') {
      return json({ models: loaded.map((name) => ({ name, model: name })) });
    }
    if (req.url === '/api/chat') {
      let body = '';
      req.on('data', (d) => (body += d));
      req.on('end', () => {
        const b = JSON.parse(body || '{}') as { model: string; messages?: unknown[] };
        chats.push(b);
        if (!loaded.includes(b.model)) {
          loaded.push(b.model);
        }
        if (!b.messages?.length) {
          return json({ model: b.model, done: true, done_reason: 'load' });
        }
        res.setHeader('content-type', 'application/x-ndjson');
        res.write(`${JSON.stringify({ message: { role: 'assistant', content: 'OK' }, done: false })}\n`);
        res.end(`${JSON.stringify({ message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop', prompt_eval_count: 10, eval_count: 1 })}\n`);
      });
      return;
    }
    if (req.url === '/api/delete' && req.method === 'DELETE') {
      return readBody((b) => {
        deleted.push(b.model);
        res.end('{}');
      });
    }
    res.statusCode = 404;
    res.end();
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${(srv.address() as AddressInfo).port}`, close: () => srv.close(), pulled, deleted, models, chats, loaded })));
}

const log = vscode.window.createOutputChannel('LocalPilot tests', { log: true });
const m = (id: string, extra: Partial<ModelInfo> = {}): ModelInfo => ({ id: `ollama/${id}`, providerId: 'ollama', modelId: id, name: id, contextWindow: 32768, maxOutputTokens: 8192, supportsTools: true, supportsVision: false, ...extra });

suite('LocalPilot models: system profile, catalog, routing, model manager', () => {
  suiteSetup(async function () {
    this.timeout(30_000);
    await vscode.extensions.getExtension('localpilot.localpilot-agent')!.activate();
  });

  test('system profile derives a model budget and tier from RAM / GPU', () => {
    const m3 = buildProfile({ platform: 'darwin', arch: 'arm64', cpuCores: 12, ramGb: 36, vramGb: 0, gpu: 'Apple M3 Pro' });
    assert.strictEqual(m3.unifiedMemory, true);
    assert.ok(m3.modelBudgetGb > 20 && m3.modelBudgetGb < 30, String(m3.modelBudgetGb));
    assert.strictEqual(m3.tier, 'large');
    assert.match(m3.summary, /36 GB RAM · 12 cores · Apple M3 Pro/);
    const laptop = buildProfile({ platform: 'win32', arch: 'x64', cpuCores: 8, ramGb: 16, vramGb: 0 });
    assert.strictEqual(laptop.modelBudgetGb, 8);
    assert.strictEqual(laptop.tier, 'small');
    const gpu = buildProfile({ platform: 'linux', arch: 'x64', cpuCores: 16, ramGb: 64, vramGb: 24, gpu: 'RTX 4090' });
    assert.ok(gpu.modelBudgetGb >= 23 && gpu.modelBudgetGb <= 36, String(gpu.modelBudgetGb));
    assert.strictEqual(gpu.tier, 'large');
    assert.strictEqual(buildProfile({ platform: 'linux', arch: 'x64', cpuCores: 2, ramGb: 4, vramGb: 0 }).tier, 'tiny');
    assert.strictEqual(parameterSizeB('qwen2.5-coder:7b'), 7);
    assert.strictEqual(parameterSizeB('deepseek-r1:1.5b'), 1.5);
    assert.strictEqual(parameterSizeB('codestral'), undefined);
    assert.ok(estimateModelGb(7) > 4 && estimateModelGb(7) < 6);
    assert.ok(fits(laptop, 4.7) && !fits(laptop, 9));
  });

  test('starter plan picks the smallest useful set and grows with the machine', () => {
    const small = starterPlan(buildProfile({ platform: 'linux', arch: 'x64', cpuCores: 4, ramGb: 8, vramGb: 0 }));
    assert.strictEqual(small.agent.variant.ollama, 'gemma4:e2b', 'an 8 GB machine still gets the smallest Gemma 4');
    assert.strictEqual(small.completion, undefined, 'no second model when it would not fit');
    assert.strictEqual(small.vision, undefined);
    const mid = starterPlan(buildProfile({ platform: 'darwin', arch: 'arm64', cpuCores: 8, ramGb: 16, vramGb: 0 }));
    assert.strictEqual(mid.agent.variant.ollama, 'gemma4:e4b', 'a 16 GB Mac starts with e4b, not the biggest model that fits');
    assert.strictEqual(mid.completion?.variant.ollama, 'starcoder2:3b');
    const big = starterPlan(buildProfile({ platform: 'darwin', arch: 'arm64', cpuCores: 12, ramGb: 36, vramGb: 0 }));
    assert.strictEqual(big.agent.variant.ollama, 'gemma4:e4b');
    assert.strictEqual(big.vision, undefined, 'Gemma 4 reads images itself, so no separate vision model');
    assert.ok(big.agent.entry.supportsVision && big.agent.entry.supportsTools);
    const tiny = starterPlan(buildProfile({ platform: 'linux', arch: 'x64', cpuCores: 2, ramGb: 6, vramGb: 0 }));
    assert.strictEqual(tiny.agent.variant.ollama, 'llama3.2:3b', 'below Gemma 4 e2b fall back to a tiny tool-capable model');
    assert.strictEqual(tiny.completion, undefined);
    const minuscule = starterPlan(buildProfile({ platform: 'linux', arch: 'x64', cpuCores: 2, ramGb: 2, vramGb: 0 }));
    assert.strictEqual(minuscule.agent.variant.ollama, 'smollm2:360m');
    for (const p of [small, mid, big, tiny, minuscule]) {
      assert.ok(!p.agent.variant.ollama?.startsWith('qwen'), `starter agent is never a Qwen model: ${p.agent.variant.ollama}`);
      assert.ok(p.agent.entry.supportsTools, 'starter agent must call tools');
    }
  });

  test('catalog is well-formed and annotated per machine', () => {
    for (const e of MODEL_CATALOG) {
      assert.ok(e.variants.length > 0, e.key);
      for (const v of e.variants) {
        assert.ok(v.gb > 0 && v.paramsB > 0, `${e.key}:${v.tag}`);
        assert.ok(v.ollama || v.docker || v.lmstudio, `${e.key}:${v.tag} needs at least one install id`);
      }
      const sizes = e.variants.map((v) => v.gb);
      assert.deepStrictEqual(sizes, [...sizes].sort((a, b) => a - b), `${e.key} variants must be ordered smallest first`);
    }
    const installed = [m('qwen2.5-coder:7b', { sizeBytes: 4.7e9 }), m('gemma3:4b', { supportsVision: true })];
    const rows = catalogForSystem(buildProfile({ platform: 'darwin', arch: 'arm64', cpuCores: 8, ramGb: 16, vramGb: 0 }), installed);
    const coder7 = rows.find((r) => r.entry.key === 'qwen2.5-coder' && r.variant.tag === '7b')!;
    assert.deepStrictEqual(coder7.installed, ['ollama/qwen2.5-coder:7b']);
    assert.ok(coder7.fits);
    assert.ok(coder7.recommendedFor.includes('agent'), '7b is the recommended coder size for a 16 GB machine');
    const coder32 = rows.find((r) => r.entry.key === 'qwen2.5-coder' && r.variant.tag === '32b')!;
    assert.ok(!coder32.fits && !coder32.tight);
    assert.deepStrictEqual(coder32.recommendedFor, []);
    assert.ok(rows.find((r) => r.entry.key === 'gemma3' && r.variant.tag === '4b')!.installed.length === 1);
    // Exactly one recommended size per family that has any fitting size.
    for (const e of MODEL_CATALOG) {
      const rec = rows.filter((r) => r.entry === e && r.recommendedFor.length);
      assert.ok(rec.length <= 1, e.key);
    }
  });

  test('installed models map back to catalog entries across runtimes', () => {
    const coder = MODEL_CATALOG.find((e) => e.key === 'qwen2.5-coder')!;
    const v7 = coder.variants.find((v) => v.tag === '7b')!;
    assert.ok(matchesCatalog(m('qwen2.5-coder:7b'), { entry: coder, variant: v7 }));
    assert.ok(matchesCatalog({ ...m('ai/qwen2.5-coder:latest'), providerId: 'docker' }, { entry: coder, variant: v7 }));
    assert.ok(matchesCatalog({ ...m('qwen2.5-coder-7b-instruct'), providerId: 'lmstudio' }, { entry: coder, variant: v7 }));
    assert.ok(!matchesCatalog(m('qwen2.5-coder:14b'), { entry: coder, variant: v7 }));
    const gemma4 = MODEL_CATALOG.find((e) => e.key === 'gemma4')!;
    const e2b = gemma4.variants.find((v) => v.tag === 'e2b')!;
    const g12 = gemma4.variants.find((v) => v.tag === '12b')!;
    assert.ok(matchesCatalog(m('gemma4:e2b'), { entry: gemma4, variant: e2b }));
    assert.ok(matchesCatalog({ ...m('docker.io/ai/gemma4:e2b'), providerId: 'docker' }, { entry: gemma4, variant: e2b }));
    assert.ok(matchesCatalog({ ...m('gemma-4-e2b-it'), providerId: 'lmstudio' }, { entry: gemma4, variant: e2b }));
    assert.ok(matchesCatalog({ ...m('docker.io/ai/gemma4:latest'), providerId: 'docker' }, { entry: gemma4, variant: g12 }), 'the Docker latest tag is the 12b');
    assert.ok(!matchesCatalog({ ...m('docker.io/ai/gemma4:e2b'), providerId: 'docker' }, { entry: gemma4, variant: g12 }));
    assert.ok(!matchesCatalog(m('gemma4:e4b'), { entry: gemma4, variant: e2b }));
    assert.strictEqual(lookupCatalog(m('devstral:latest'))?.entry.key, 'devstral');
    assert.strictEqual(lookupCatalog(m('my-finetune:latest')), undefined);
    assert.strictEqual(modelFootprintGb(m('qwen2.5-coder:7b', { sizeBytes: 5 * 1024 ** 3 })), 6);
    assert.strictEqual(modelFootprintGb(m('qwen3:8b')), 5.2, 'catalog size when the server reports none');
    assert.ok(modelFootprintGb(m('custom-13b'))! > 8, 'estimated from the name');
    assert.strictEqual(modelFootprintGb(m('mystery')), undefined);
  });

  test('role scoring prefers tool-capable coders for agent, small FIM for completions, vision for images and memory fit', () => {
    const profile = buildProfile({ platform: 'win32', arch: 'x64', cpuCores: 8, ramGb: 16, vramGb: 0 });
    const models = [
      m('qwen2.5-coder:7b', { supportsFim: true, sizeBytes: 4.7e9 }),
      m('qwen2.5-coder:1.5b-base', { supportsFim: true, supportsTools: false, sizeBytes: 1.0e9 }),
      m('qwen2.5vl:7b', { supportsVision: true, supportsTools: false, sizeBytes: 6e9 }),
      m('qwen2.5-coder:32b', { supportsFim: true, sizeBytes: 20e9 }),
      m('nomic-embed-text', { supportsTools: false }),
    ];
    assert.strictEqual(pickForRole(models, 'agent', profile)?.modelId, 'qwen2.5-coder:7b', 'the 32b does not fit in 16 GB');
    assert.strictEqual(pickForRole(models, 'completion', profile)?.modelId, 'qwen2.5-coder:1.5b-base');
    assert.strictEqual(pickForRole(models, 'vision', profile)?.modelId, 'qwen2.5vl:7b');
    assert.strictEqual(pickForRole(models.filter((x) => !x.supportsVision), 'vision', profile), undefined);
    const xl = buildProfile({ platform: 'darwin', arch: 'arm64', cpuCores: 16, ramGb: 128, vramGb: 0 });
    assert.strictEqual(pickForRole(models, 'agent', xl)?.modelId, 'qwen2.5-coder:32b', 'with room to spare the bigger coder wins');
    assert.ok(scoreForRole(models[4], 'agent', profile) < 0, 'embedding models are never routed to');
    const withGemma = [...models, m('gemma4:e4b', { supportsVision: true, sizeBytes: 6.6e9 })];
    assert.strictEqual(pickForRole(withGemma, 'agent', profile)?.modelId, 'gemma4:e4b', 'a small Gemma 4 beats a same-size Qwen coder');
    assert.strictEqual(pickForRole(withGemma, 'vision', profile)?.modelId, 'gemma4:e4b');
    assert.strictEqual(pickForRole(withGemma, 'reasoning', profile)?.modelId, 'gemma4:e4b');
  });

  test('parallel work spreads to a comparable idle model only when the intended one is saturated and the pair fits in memory', () => {
    const profile = buildProfile({ platform: 'darwin', arch: 'arm64', cpuCores: 12, ramGb: 36, vramGb: 0 });
    const coder = m('qwen2.5-coder:14b', { sizeBytes: 9e9 });
    const gemma = m('gemma4:12b', { supportsVision: true, sizeBytes: 8e9 });
    const tiny = m('qwen2.5-coder:1.5b-base', { supportsFim: true, supportsTools: false, sizeBytes: 1e9 });
    const big = m('qwen2.5-coder:32b', { sizeBytes: 20e9 });
    const models = [coder, gemma, tiny, big];
    const load = (assigned: Record<string, number>, serial: string[] = [], slots = 4) => ({ assigned: new Map(Object.entries(assigned).map(([k, v]) => [`ollama/${k}`, v])), serial: new Set(serial.map((s) => `ollama/${s}`)), slots });

    // Idle, or busy on a server with free slots: no reason to move.
    assert.strictEqual(pickAlternative(models, coder, 'agent', load({}), profile), undefined);
    assert.strictEqual(pickAlternative(models, coder, 'agent', load({ 'qwen2.5-coder:14b': 1 }), profile), undefined, 'one run on a 4-slot model is not saturation');
    assert.strictEqual(isSaturated(coder, load({ 'qwen2.5-coder:14b': 4 })), true);
    // Known to answer one request at a time: the second run goes to the comparable model next door.
    assert.strictEqual(pickAlternative(models, coder, 'agent', load({ 'qwen2.5-coder:14b': 1 }, ['qwen2.5-coder:14b']), profile)?.modelId, 'gemma4:12b');
    // Never to a model that cannot call tools, and not to one that is itself saturated.
    assert.strictEqual(pickAlternative([coder, tiny], coder, 'agent', load({ 'qwen2.5-coder:14b': 1 }, ['qwen2.5-coder:14b']), profile), undefined, 'the FIM base model cannot run the agent loop');
    assert.strictEqual(pickAlternative(models, coder, 'agent', load({ 'qwen2.5-coder:14b': 1, 'gemma4:12b': 1 }, ['qwen2.5-coder:14b', 'gemma4:12b']), profile), undefined, 'both busy: queue');
    // Memory: on a 16 GB laptop the 14b coder plus a 12b Gemma do not fit side by side, so the run queues instead of thrashing.
    const laptop = buildProfile({ platform: 'win32', arch: 'x64', cpuCores: 8, ramGb: 16, vramGb: 0 });
    assert.strictEqual(pickAlternative(models, coder, 'agent', load({ 'qwen2.5-coder:14b': 1 }, ['qwen2.5-coder:14b']), laptop), undefined);
    // …but a model that is already loaded (has a run on it, with a free slot) is always a fine neighbour.
    assert.strictEqual(pickAlternative(models, coder, 'agent', load({ 'qwen2.5-coder:14b': 1, 'gemma4:12b': 1 }, ['qwen2.5-coder:14b']), laptop)?.modelId, 'gemma4:12b');
    // Image turns only spread to a model that can see.
    assert.strictEqual(pickAlternative([gemma, coder], gemma, 'agent', load({ 'gemma4:12b': 1 }, ['gemma4:12b']), profile, true), undefined);
    // Quality floor: a much weaker model is not "comparable" even when idle.
    const weak = m('tinyllama:1.1b', { sizeBytes: 0.7e9 });
    assert.strictEqual(pickAlternative([big, weak], big, 'agent', load({ 'qwen2.5-coder:32b': 1 }, ['qwen2.5-coder:32b']), profile), undefined);
    // The least loaded comparable model wins; ties go to the better score.
    assert.strictEqual(pickAlternative(models, coder, 'agent', load({ 'qwen2.5-coder:14b': 4, 'gemma4:12b': 2, 'qwen2.5-coder:32b': 1 }), profile)?.modelId, 'qwen2.5-coder:32b');
    // A model already resident in memory (idle, but loaded per the server) costs no extra memory and no load time:
    // fine as a neighbour on the laptop, and preferred over an equally idle model that would have to load first.
    const resident = new Set(['ollama/gemma4:12b']);
    assert.strictEqual(pickAlternative(models, coder, 'agent', load({ 'qwen2.5-coder:14b': 1 }, ['qwen2.5-coder:14b']), laptop, false, undefined, resident)?.modelId, 'gemma4:12b');
    const coder2 = m('qwen3:14b', { sizeBytes: 9e9 });
    const pool = [coder, coder2, gemma];
    const busy = load({ 'qwen2.5-coder:14b': 1 }, ['qwen2.5-coder:14b']);
    const unloaded = pickAlternative(pool, coder, 'agent', busy, profile)!.modelId;
    const other = unloaded === 'gemma4:12b' ? 'ollama/qwen3:14b' : 'ollama/gemma4:12b';
    assert.strictEqual(pickAlternative(pool, coder, 'agent', busy, profile, false, undefined, new Set([other]))?.id, other, 'the resident one wins among idle comparable models');
  });

  test('a model already in memory wins ties for Auto, but never beats a clearly better one', () => {
    const profile = buildProfile({ platform: 'darwin', arch: 'arm64', cpuCores: 12, ramGb: 64, vramGb: 0 });
    const a = m('alpha-coder:14b', { sizeBytes: 9e9 });
    const b = m('beta-coder:14b', { sizeBytes: 9e9 });
    const small = m('qwen2.5-coder:3b', { sizeBytes: 2e9 });
    const big = m('qwen2.5-coder:32b', { sizeBytes: 20e9 });
    const residentBonus = (ids: string[]) => (x: ModelInfo) => (ids.includes(x.id) ? 1.5 : 0);
    assert.strictEqual(scoreForRole(a, 'agent', profile), scoreForRole(b, 'agent', profile));
    assert.strictEqual(pickForRole([a, b], 'agent', profile, false, residentBonus([b.id]))?.id, b.id);
    assert.strictEqual(pickForRole([b, a], 'agent', profile, false, residentBonus([a.id]))?.id, a.id);
    assert.strictEqual(pickForRole([small, big], 'agent', profile, false, residentBonus([small.id]))?.id, big.id);
  });

  test('registry lists, hides disabled models and routes per role against a real Ollama-style server', async function () {
    this.timeout(30_000);
    const srv = await fakeOllama();
    const cfg = vscode.workspace.getConfiguration('localpilot');
    const prev = { providers: cfg.inspect('providers')?.globalValue, disabled: cfg.inspect('models.disabled')?.globalValue, def: cfg.inspect('defaultModel')?.globalValue, vision: cfg.inspect('routing.vision')?.globalValue, fim: cfg.inspect('inlineCompletion.model')?.globalValue };
    const reg = new ProviderRegistry(log);
    // Routing scores and the parallel spread weigh model footprints against the machine; pin a roomy one so the
    // expectations below hold on a 7 GB CI runner as well as on a workstation.
    overrideSystemProfile(buildProfile({ platform: 'darwin', arch: 'arm64', cpuCores: 12, ramGb: 64, vramGb: 0 }));
    try {
      await cfg.update('providers', [{ id: 'fake', type: 'ollama', baseUrl: srv.url }], vscode.ConfigurationTarget.Global);
      await cfg.update('models.disabled', [], vscode.ConfigurationTarget.Global);
      await cfg.update('defaultModel', '', vscode.ConfigurationTarget.Global);
      await cfg.update('routing.vision', '', vscode.ConfigurationTarget.Global);
      await cfg.update('inlineCompletion.model', '', vscode.ConfigurationTarget.Global);
      await new Promise((r) => setTimeout(r, 100));

      const all = await reg.listAllModels(true);
      assert.deepStrictEqual(all.map((x) => x.modelId).sort(), ['qwen2.5-coder:1.5b-base', 'qwen2.5-coder:14b', 'qwen2.5vl:7b']);
      assert.strictEqual(all.find((x) => x.modelId === 'qwen2.5-coder:14b')!.sizeBytes, 9.0e9);
      assert.strictEqual(all.find((x) => x.modelId === 'qwen2.5-coder:14b')!.parameterSize, '14.8B');

      // Auto default: the tool-capable coder. Completions: the small FIM base model. Images: the VL model.
      const agent = await reg.route({});
      assert.strictEqual(agent.model.modelId, 'qwen2.5-coder:14b');
      assert.strictEqual(agent.reason, undefined);
      assert.strictEqual((await reg.route({ role: 'completion' })).model.modelId, 'qwen2.5-coder:1.5b-base');
      const vis = await reg.route({ modelRef: 'fake/qwen2.5-coder:14b', needsVision: true });
      assert.strictEqual(vis.model.modelId, 'qwen2.5vl:7b');
      assert.match(vis.reason!, /cannot see images/);
      assert.ok(!vis.fallback);
      const same = await reg.route({ modelRef: 'fake/qwen2.5vl:7b', needsVision: true });
      assert.strictEqual(same.model.modelId, 'qwen2.5vl:7b');
      assert.strictEqual(same.reason, undefined);

      // Parallel work: the coder is known to answer one request at a time and already has a run; a spreadable
      // request (Auto / inherited) moves to the comparable idle model, an explicit choice never does, and the
      // setting turns the behaviour off. (Only the VL model is comparable here; it cannot call tools, so nothing
      // qualifies for an agent run — pull a second tool-capable model to see the spread.)
      const busy = { assigned: new Map([['fake/qwen2.5-coder:14b', 1]]), serial: new Set(['fake/qwen2.5-coder:14b']), slots: 4 };
      await cfg.update('defaultModel', 'fake/qwen2.5-coder:14b', vscode.ConfigurationTarget.Global);
      await new Promise((r) => setTimeout(r, 100));
      assert.strictEqual((await reg.route({ spread: true, load: busy })).model.modelId, 'qwen2.5-coder:14b', 'no tool-capable neighbour: queue on the same model');
      await (await fetch(`${srv.url}/api/pull`, { method: 'POST', body: JSON.stringify({ model: 'gemma4:12b' }) })).text();
      await reg.listModels(true);
      const spread = await reg.route({ spread: true, load: busy });
      assert.strictEqual(spread.model.modelId, 'gemma4:12b');
      assert.ok(spread.spread && /busy with 1 other request/.test(spread.reason!), spread.reason);
      assert.strictEqual((await reg.route({ load: busy })).model.modelId, 'qwen2.5-coder:14b', 'not spreadable: stays');
      assert.strictEqual((await reg.route({ modelRef: 'fake/qwen2.5-coder:14b', spread: true, load: busy })).model.modelId, 'gemma4:12b', 'an inherited ref is still spreadable when the caller says so');
      assert.strictEqual((await reg.route({ spread: true, load: { ...busy, serial: new Set() } })).model.modelId, 'qwen2.5-coder:14b', 'one run on a model with free slots is not saturation');
      await cfg.update('routing.parallelModels', false, vscode.ConfigurationTarget.Global);
      await new Promise((r) => setTimeout(r, 100));
      assert.strictEqual((await reg.route({ spread: true, load: busy })).model.modelId, 'qwen2.5-coder:14b', 'setting off: queue');
      await cfg.update('routing.parallelModels', undefined, vscode.ConfigurationTarget.Global);
      await cfg.update('defaultModel', '', vscode.ConfigurationTarget.Global);
      await (await fetch(`${srv.url}/api/delete`, { method: 'DELETE', body: JSON.stringify({ model: 'gemma4:12b' }) })).text();
      await reg.listModels(true);

      // Offline / unknown default → best available, flagged as a fallback.
      await cfg.update('defaultModel', 'fake/gone:70b', vscode.ConfigurationTarget.Global);
      const fb = await reg.route({});
      assert.strictEqual(fb.model.modelId, 'qwen2.5-coder:14b');
      assert.ok(fb.fallback && /not available/.test(fb.reason!));

      // A default the Ollama server does not have (uninstalled outside LocalPilot) is cleared on the next discovery.
      const removed = new Promise<string[]>((r) => reg.onDidRemoveModels((ids) => ids.includes('fake/gone:70b') && r(ids)));
      await reg.listModels(true);
      assert.deepStrictEqual(await removed, ['fake/gone:70b']);
      assert.strictEqual(vscode.workspace.getConfiguration('localpilot').get('defaultModel'), '');

      // Disabling a model hides it from listModels and from routing, but listAllModels still shows it flagged.
      await cfg.update('models.disabled', ['fake/qwen2.5-coder:14b'], vscode.ConfigurationTarget.Global);
      await cfg.update('defaultModel', '', vscode.ConfigurationTarget.Global);
      await new Promise((r) => setTimeout(r, 100));
      const enabled = await reg.listModels();
      assert.ok(!enabled.some((x) => x.modelId === 'qwen2.5-coder:14b'));
      assert.strictEqual((await reg.listAllModels()).find((x) => x.modelId === 'qwen2.5-coder:14b')!.disabled, true);
      assert.notStrictEqual((await reg.route({})).model.modelId, 'qwen2.5-coder:14b');
      assert.notStrictEqual((await reg.route({ modelRef: 'fake/qwen2.5-coder:14b' })).model.modelId, 'qwen2.5-coder:14b', 'an explicit ref to a disabled model falls back too');

      // Routing off: image turns stay on the session model.
      await cfg.update('models.disabled', [], vscode.ConfigurationTarget.Global);
      await cfg.update('routing.enabled', false, vscode.ConfigurationTarget.Global);
      await new Promise((r) => setTimeout(r, 100));
      assert.strictEqual((await reg.route({ modelRef: 'fake/qwen2.5-coder:14b', needsVision: true })).model.modelId, 'qwen2.5-coder:14b');
    } finally {
      reg.dispose();
      srv.close();
      overrideSystemProfile(undefined);
      await cfg.update('routing.enabled', undefined, vscode.ConfigurationTarget.Global);
      await cfg.update('providers', prev.providers, vscode.ConfigurationTarget.Global);
      await cfg.update('models.disabled', prev.disabled, vscode.ConfigurationTarget.Global);
      await cfg.update('defaultModel', prev.def, vscode.ConfigurationTarget.Global);
      await cfg.update('routing.vision', prev.vision, vscode.ConfigurationTarget.Global);
      await cfg.update('inlineCompletion.model', prev.fim, vscode.ConfigurationTarget.Global);
    }
  });

  test('registry keeps models loaded: warm matches num_ctx/keep_alive, follows residency, reuses providers and picks up new models', async function () {
    this.timeout(30_000);
    const srv = await fakeOllama();
    const cfg = vscode.workspace.getConfiguration('localpilot');
    const prev = { providers: cfg.inspect('providers')?.globalValue, def: cfg.inspect('defaultModel')?.globalValue, ctx: cfg.inspect('contextWindow')?.globalValue, keep: cfg.inspect('keepAlive')?.globalValue, disabled: cfg.inspect('models.disabled')?.globalValue };
    const reg = new ProviderRegistry(log);
    overrideSystemProfile(buildProfile({ platform: 'darwin', arch: 'arm64', cpuCores: 12, ramGb: 64, vramGb: 0 }));
    try {
      await cfg.update('providers', [{ id: 'fake', type: 'ollama', baseUrl: srv.url }], vscode.ConfigurationTarget.Global);
      await cfg.update('defaultModel', '', vscode.ConfigurationTarget.Global);
      await cfg.update('models.disabled', [], vscode.ConfigurationTarget.Global);
      await cfg.update('contextWindow', 16384, vscode.ConfigurationTarget.Global);
      await cfg.update('keepAlive', '45m', vscode.ConfigurationTarget.Global);
      await new Promise((r) => setTimeout(r, 100));
      await reg.listModels(true);
      const provider = reg.get('fake');

      // Warm-up loads with the num_ctx real requests use (a different one makes Ollama reload) and the keep_alive.
      await reg.warm('fake/qwen2.5-coder:14b');
      const warmBody = srv.chats.find((c) => c.model === 'qwen2.5-coder:14b' && !(c.messages as unknown[]).length) as { options?: { num_ctx?: number }; keep_alive?: string } | undefined;
      assert.ok(warmBody, 'warm request sent');
      assert.strictEqual(warmBody.options?.num_ctx, 16384);
      assert.strictEqual(warmBody.keep_alive, '45m');
      assert.ok((await reg.residentModels(0)).has('fake/qwen2.5-coder:14b'));

      // Still loaded: a second warm within the throttle window is skipped. Evicted: it loads again right away.
      const before = srv.chats.length;
      await reg.warm('fake/qwen2.5-coder:14b');
      assert.strictEqual(srv.chats.length, before, 'resident model not re-warmed');
      srv.loaded.length = 0;
      await reg.warm('fake/qwen2.5-coder:14b');
      assert.strictEqual(srv.chats.length, before + 1, 'evicted model warmed again');

      // A settings change that does not touch the provider keeps the same instance (and its model-info cache).
      await cfg.update('models.disabled', ['fake/qwen2.5vl:7b'], vscode.ConfigurationTarget.Global);
      await new Promise((r) => setTimeout(r, 100));
      assert.strictEqual(reg.get('fake'), provider);

      // Background refresh: a model pulled outside LocalPilot shows up without anyone asking.
      const sub = reg.startAutoRefresh(() => true, 50, 50);
      try {
        const appeared = new Promise<void>((resolve) => {
          const d = reg.onDidChange(() => {
            if (reg.cachedModels().some((x) => x.modelId === 'devstral:24b')) {
              d.dispose();
              resolve();
            }
          });
        });
        srv.models.push({ name: 'devstral:24b', caps: ['completion', 'tools'], ctx: 131072, size: 14e9, params: '23.6B' });
        await appeared;
      } finally {
        sub.dispose();
      }
    } finally {
      reg.dispose();
      srv.close();
      overrideSystemProfile(undefined);
      await cfg.update('providers', prev.providers, vscode.ConfigurationTarget.Global);
      await cfg.update('defaultModel', prev.def, vscode.ConfigurationTarget.Global);
      await cfg.update('contextWindow', prev.ctx, vscode.ConfigurationTarget.Global);
      await cfg.update('keepAlive', prev.keep, vscode.ConfigurationTarget.Global);
      await cfg.update('models.disabled', prev.disabled, vscode.ConfigurationTarget.Global);
    }
  });

  test('Auto routes to what is installed now: a better model pulled or a model removed outside LocalPilot is picked up on the next turn', async function () {
    this.timeout(30_000);
    const srv = await fakeOllama();
    const cfg = vscode.workspace.getConfiguration('localpilot');
    const prev = { providers: cfg.inspect('providers')?.globalValue, def: cfg.inspect('defaultModel')?.globalValue, disabled: cfg.inspect('models.disabled')?.globalValue };
    const reg = new ProviderRegistry(log);
    reg.freshnessMs = 0;
    overrideSystemProfile(buildProfile({ platform: 'darwin', arch: 'arm64', cpuCores: 12, ramGb: 64, vramGb: 0 }));
    try {
      await cfg.update('providers', [{ id: 'fake', type: 'ollama', baseUrl: srv.url }], vscode.ConfigurationTarget.Global);
      await cfg.update('defaultModel', '', vscode.ConfigurationTarget.Global);
      await cfg.update('models.disabled', [], vscode.ConfigurationTarget.Global);
      await new Promise((r) => setTimeout(r, 100));
      await reg.listModels(true);
      assert.strictEqual((await reg.route({ fresh: true })).model.modelId, 'qwen2.5-coder:14b');

      // `ollama pull` in a terminal: the next turn sees it without a manual refresh or waiting for the 30 s cache.
      srv.models.push({ name: 'gemma4:12b', caps: ['completion', 'tools', 'vision'], ctx: 131072, size: 8e9, params: '12B' });
      assert.strictEqual((await reg.route({})).model.modelId, 'qwen2.5-coder:14b', 'without `fresh` the cached list is used');
      const better = await reg.route({ fresh: true });
      assert.strictEqual(better.model.modelId, 'gemma4:12b');
      assert.strictEqual(better.reason, undefined, 'Auto switching to a better installed model is not a fallback');

      // `ollama rm`: Auto goes back to the best remaining model, silently.
      srv.deleted.push('gemma4:12b');
      const back = await reg.route({ fresh: true });
      assert.strictEqual(back.model.modelId, 'qwen2.5-coder:14b');
      assert.ok(!back.fallback && !back.reason);

      // A default that gets removed: this turn falls back, and the setting is cleared so later turns are plain Auto.
      srv.deleted.splice(srv.deleted.indexOf('gemma4:12b'), 1);
      await reg.listModels(true);
      await cfg.update('defaultModel', 'fake/gemma4:12b', vscode.ConfigurationTarget.Global);
      await new Promise((r) => setTimeout(r, 100));
      assert.strictEqual((await reg.route({ fresh: true })).model.modelId, 'gemma4:12b');
      const removed = new Promise<string[]>((r) => reg.onDidRemoveModels((ids) => ids.includes('fake/gemma4:12b') && r(ids)));
      srv.deleted.push('gemma4:12b');
      const fb = await reg.route({ fresh: true });
      assert.strictEqual(fb.model.modelId, 'qwen2.5-coder:14b');
      assert.ok(fb.fallback);
      await removed;
      assert.strictEqual(vscode.workspace.getConfiguration('localpilot').get('defaultModel'), '');
      const after = await reg.route({ fresh: true });
      assert.ok(!after.fallback && !after.reason, after.reason);
    } finally {
      reg.dispose();
      srv.close();
      overrideSystemProfile(undefined);
      await cfg.update('providers', prev.providers, vscode.ConfigurationTarget.Global);
      await cfg.update('defaultModel', prev.def, vscode.ConfigurationTarget.Global);
      await cfg.update('models.disabled', prev.disabled, vscode.ConfigurationTarget.Global);
    }
  });

  test('an Auto chat stays on Auto across turns (each turn is routed again) instead of pinning the first model', async function () {
    this.timeout(60_000);
    const srv = await fakeOllama();
    const cfg = vscode.workspace.getConfiguration('localpilot');
    const prev = { providers: cfg.inspect('providers')?.globalValue, def: cfg.inspect('defaultModel')?.globalValue, disabled: cfg.inspect('models.disabled')?.globalValue };
    const api = (await vscode.extensions.getExtension('localpilot.localpilot-agent')!.activate()) as LocalPilotApi;
    const idle = (id: string) =>
      new Promise<void>((resolve) => {
        const check = () => {
          if (!api.runningSessionIds.includes(id)) {
            sub.dispose();
            resolve();
          }
        };
        const sub = api.onDidChangeRuns(check);
        check();
      });
    try {
      await cfg.update('providers', [{ id: 'fake', type: 'ollama', baseUrl: srv.url }], vscode.ConfigurationTarget.Global);
      await cfg.update('defaultModel', '', vscode.ConfigurationTarget.Global);
      await cfg.update('models.disabled', [], vscode.ConfigurationTarget.Global);
      await new Promise((r) => setTimeout(r, 200));
      await api.listModels();
      const id = await api.runPrompt('Reply OK', 'ask');
      await idle(id);
      assert.strictEqual(api.getSession(id)!.model, '', 'first turn leaves the chat on Auto');
      assert.ok(srv.chats.some((c) => (c.messages as unknown[]).length), 'the model was asked');
      await api.send(id, 'Again');
      assert.strictEqual(api.getSession(id)!.model, '', 'still Auto after the second turn');

      // The model that answered is removed and another one installed outside LocalPilot: the next turn uses the new one.
      const asked = () => srv.chats.filter((c) => (c.messages as unknown[]).length).map((c) => c.model as string);
      const answered = asked().pop()!;
      srv.deleted.push(answered);
      srv.models.push({ name: 'devstral:24b', caps: ['completion', 'tools'], ctx: 131072, size: 14e9, params: '23.6B' });
      // Past the registry's short freshness window, so the turn re-reads the installed list.
      await new Promise((r) => setTimeout(r, 3_200));
      await api.send(id, 'Once more');
      await idle(id);
      assert.strictEqual(asked().pop(), 'devstral:24b', `answered by ${asked().pop()} after ${answered} was removed`);
      assert.strictEqual(api.getSession(id)!.model, '', 'still Auto after the installed models changed');
    } finally {
      srv.close();
      await cfg.update('providers', prev.providers, vscode.ConfigurationTarget.Global);
      await cfg.update('defaultModel', prev.def, vscode.ConfigurationTarget.Global);
      await cfg.update('models.disabled', prev.disabled, vscode.ConfigurationTarget.Global);
    }
  });

  test('model manager pulls with progress, removes, reports errors and refreshes discovery', async function () {
    this.timeout(30_000);
    const srv = await fakeOllama();
    const cfg = vscode.workspace.getConfiguration('localpilot');
    const prevProviders = cfg.inspect('providers')?.globalValue;
    const reg = new ProviderRegistry(log);
    const mm = new ModelManager(reg, log);
    try {
      await cfg.update('providers', [{ id: 'fake', type: 'ollama', baseUrl: srv.url }], vscode.ConfigurationTarget.Global);
      await new Promise((r) => setTimeout(r, 100));
      const progress: number[] = [];
      const sub = mm.onDidChange(() => {
        const j = mm.activeJobs[0];
        if (j && j.progress >= 0) {
          progress.push(j.progress);
        }
      });
      const job = await mm.pull('ollama', 'smollm2:1.7b', 'fake');
      sub.dispose();
      assert.strictEqual(job.status, 'done', job.error);
      assert.strictEqual(job.progress, 1);
      assert.ok(progress.some((p) => p > 0.3 && p < 0.9), `progress should pass through the middle: ${progress.join(',')}`);
      assert.deepStrictEqual(srv.pulled, ['smollm2:1.7b']);
      assert.ok((await reg.listModels(true)).some((x) => x.modelId === 'smollm2:1.7b'), 'discovery sees the new model');

      const bad = await mm.pull('ollama', 'nope:1b', 'fake');
      assert.strictEqual(bad.status, 'error');
      assert.match(bad.error!, /manifest/);

      const rm = await mm.remove('ollama', 'smollm2:1.7b', 'fake');
      assert.strictEqual(rm.status, 'done', rm.error);
      assert.deepStrictEqual(srv.deleted, ['smollm2:1.7b']);
      assert.ok(!(await reg.listModels(true)).some((x) => x.modelId === 'smollm2:1.7b'));

      const lms = await mm.remove('lmstudio', 'whatever');
      assert.strictEqual(lms.status, 'error');
      assert.match(lms.error!, /LM Studio/);

      assert.strictEqual(mm.allJobs.length, 4);
      mm.clearFinished();
      assert.strictEqual(mm.allJobs.length, 0);

      const runtimes = await mm.detectRuntimes();
      assert.deepStrictEqual(runtimes.map((r) => r.target), ['ollama', 'docker', 'lmstudio']);
      assert.strictEqual(runtimes[0].running, true, 'the fake Ollama counts as a running Ollama runtime');
      assert.strictEqual(runtimes[0].providerId, 'fake');
      assert.strictEqual(runtimes[2].canRemove, false);
      assert.match(ollamaInstallCommand('linux').command, /ollama\.com\/install\.sh/);
      assert.match(ollamaInstallCommand('win32').command, /winget/);
      assert.match(ollamaInstallCommand('darwin').command, /brew/);
    } finally {
      mm.dispose();
      reg.dispose();
      srv.close();
      await cfg.update('providers', prevProviders, vscode.ConfigurationTarget.Global);
    }
  });

  test('auto-setup is a no-op when models already exist and the commands are registered', async function () {
    this.timeout(30_000);
    const srv = await fakeOllama();
    const cfg = vscode.workspace.getConfiguration('localpilot');
    const prevProviders = cfg.inspect('providers')?.globalValue;
    const reg = new ProviderRegistry(log);
    const mm = new ModelManager(reg, log);
    try {
      await cfg.update('providers', [{ id: 'fake', type: 'ollama', baseUrl: srv.url }], vscode.ConfigurationTarget.Global);
      await new Promise((r) => setTimeout(r, 100));
      const r = await mm.autoSetup();
      assert.strictEqual(r.status, 'already');
      assert.strictEqual((r as { models: number }).models, 3);
      assert.deepStrictEqual(srv.pulled, [], 'nothing is downloaded when models exist');
      const plan = await mm.plan();
      assert.ok(plan.agent.entry.supportsTools && !plan.agent.variant.ollama?.startsWith('qwen'), plan.agent.variant.ollama);
      const commands = await vscode.commands.getCommands(true);
      for (const id of ['localpilot.autoSetupModels', 'localpilot.installModel', 'localpilot.removeModel', 'localpilot.toggleModel', 'localpilot.manageModels', 'localpilot.browseModelGallery']) {
        assert.ok(commands.includes(id), `missing command ${id}`);
      }
      const props = vscode.extensions.getExtension('localpilot.localpilot-agent')!.packageJSON.contributes.configuration.properties;
      for (const key of ['localpilot.models.disabled', 'localpilot.models.autoSetup', 'localpilot.routing.enabled', 'localpilot.routing.vision', 'localpilot.routing.reasoning']) {
        assert.ok(props[key], `missing setting ${key}`);
      }
    } finally {
      mm.dispose();
      reg.dispose();
      srv.close();
      await cfg.update('providers', prevProviders, vscode.ConfigurationTarget.Global);
    }
  });
});
