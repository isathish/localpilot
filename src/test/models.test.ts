import * as assert from 'assert';
import * as http from 'http';
import * as net from 'net';
import { AddressInfo } from 'net';
import * as vscode from 'vscode';
import { catalogForSystem, lookupCatalog, matchesCatalog, MODEL_CATALOG, modelFootprintGb, starterPlan } from '../providers/catalog';
import { ModelManager, ollamaInstallCommand } from '../providers/modelManager';
import { imageMime } from '../providers/imageMime';
import { OpenAICompatProvider } from '../providers/openaiCompat';
import { AnthropicProvider } from '../providers/anthropic';
import { isSaturated, pickAlternative, pickForRole, preferResident, ProviderRegistry, scoreForRole } from '../providers/registry';
import { briefDescription } from '../agent/skills';
import { buildProfile, estimateModelGb, fits, overrideSystemProfile, parameterSizeB, windowsGpu } from '../providers/system';
import type { LocalPilotApi } from '../extension';
import { ModelInfo, StreamEvent } from '../types';
import { classifyModelError } from '../agent/resilience';
import { HttpError } from '../providers/http';
import { pairToolCalls } from '../providers/toolPairing';
import { endpointKey } from '../providers/discovery';

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

  test('auto-detect treats loopback aliases and /v1 suffixes as the same server', () => {
    assert.strictEqual(endpointKey('http://127.0.0.1:11434'), endpointKey('http://localhost:11434/'));
    assert.strictEqual(endpointKey('http://localhost:12434/engines/v1'), endpointKey('http://127.0.0.1:12434'));
    assert.strictEqual(endpointKey('http://localhost:1234/v1'), endpointKey('http://localhost:1234'));
    assert.notStrictEqual(endpointKey('http://localhost:11434'), endpointKey('http://localhost:11435'));
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

  test('Windows GPU probe ignores the saturated 4 GB WMI size and prefers the 64-bit registry size', () => {
    assert.strictEqual(windowsGpu(JSON.stringify([{ Name: 'AMD Radeon', Bytes: 4293918720, Wmi: true }])).vramGb, 0);
    assert.deepStrictEqual(windowsGpu(JSON.stringify([{ Name: 'AMD Radeon RX 7800', Bytes: 17163091968 }, { Name: 'AMD Radeon', Bytes: 4293918720, Wmi: true }])), { vramGb: 16, name: 'AMD Radeon RX 7800' });
    assert.strictEqual(windowsGpu(JSON.stringify({ Name: 'Intel', Bytes: 2147483648, Wmi: true })).vramGb, 2);
    assert.strictEqual(windowsGpu('not json').vramGb, 0);
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

  test('Auto prefers the bigger of two frontier-class models when it fits, and the smaller one when it does not', () => {
    // Both call tools and see images; only Gemma is recognised by name. The 27B must not lose on the name bonus.
    const gemma = m('gemma4:12b', { supportsVision: true, sizeBytes: 7.7e9 });
    const qwen = m('qwen3.8:27b', { supportsVision: true, sizeBytes: 18.2e9 });
    const mac36 = buildProfile({ platform: 'darwin', arch: 'arm64', cpuCores: 12, ramGb: 36, vramGb: 0 });
    assert.strictEqual(pickForRole([gemma, qwen], 'agent', mac36)?.modelId, 'qwen3.8:27b');
    assert.strictEqual(pickForRole([gemma, qwen], 'reasoning', mac36)?.modelId, 'qwen3.8:27b');
    assert.strictEqual(pickForRole([gemma, qwen], 'fast', mac36)?.modelId, 'gemma4:12b', 'read-only helpers still take the small one');
    const mac16 = buildProfile({ platform: 'darwin', arch: 'arm64', cpuCores: 8, ramGb: 16, vramGb: 0 });
    assert.strictEqual(pickForRole([gemma, qwen], 'agent', mac16)?.modelId, 'gemma4:12b', 'the 27B does not fit in 16 GB');
  });

  test('helper roles use the model already in memory when loading another would not fit beside it', () => {
    const gemma = m('gemma4:12b', { supportsVision: true, sizeBytes: 7.7e9 });
    const qwen = m('qwen3.8:27b', { supportsVision: true, sizeBytes: 18.2e9 });
    const tiny = m('qwen2.5-coder:1.5b', { sizeBytes: 1.0e9 });
    const mac36 = buildProfile({ platform: 'darwin', arch: 'arm64', cpuCores: 12, ramGb: 36, vramGb: 0 });
    const resident = new Set([qwen.id]);
    assert.strictEqual(preferResident(gemma, [gemma, qwen], 'fast', resident, mac36).modelId, 'qwen3.8:27b', 'no room for the 12B next to the 27B: reuse the 27B');
    assert.strictEqual(preferResident(tiny, [tiny, qwen], 'fast', resident, mac36).modelId, 'qwen2.5-coder:1.5b', 'a small model that fits is still loaded');
    assert.strictEqual(preferResident(gemma, [gemma, qwen], 'fast', new Set(), mac36).modelId, 'gemma4:12b', 'nothing loaded: nothing to reuse');
    assert.strictEqual(preferResident(gemma, [gemma, qwen], 'fast', new Set([gemma.id]), mac36).modelId, 'gemma4:12b');
  });

  test('the skill index shows a short first sentence, not the trigger lists', () => {
    assert.strictEqual(briefDescription('Build Azure apps end to end. USE FOR: foundry, azd, deploy, many more words here.'), 'Build Azure apps end to end.');
    assert.strictEqual(briefDescription('Use for docs, e.g. README files. Covers more.'), 'Use for docs, e.g. README files.');
    assert.strictEqual(briefDescription('Short one'), 'Short one');
    const long = briefDescription(`Design ${'very '.repeat(60)}calm interfaces`);
    assert.ok(long.length <= 150 && long.endsWith('…'), long);
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
    // A model already loaded (it has a run, with a free slot) adds no weights: a fine neighbour where the pair fits…
    assert.strictEqual(pickAlternative(models, coder, 'agent', load({ 'qwen2.5-coder:14b': 1, 'gemma4:12b': 1 }, ['qwen2.5-coder:14b']), profile)?.modelId, 'gemma4:12b');
    // …but on the laptop the two already overflow the memory budget, and more concurrent work there is what kills the
    // server mid-request, so the run queues.
    assert.strictEqual(pickAlternative(models, coder, 'agent', load({ 'qwen2.5-coder:14b': 1, 'gemma4:12b': 1 }, ['qwen2.5-coder:14b']), laptop), undefined);
    // Image turns only spread to a model that can see.
    assert.strictEqual(pickAlternative([gemma, coder], gemma, 'agent', load({ 'gemma4:12b': 1 }, ['gemma4:12b']), profile, true), undefined);
    // Quality floor: a much weaker model is not "comparable" even when idle.
    const weak = m('tinyllama:1.1b', { sizeBytes: 0.7e9 });
    assert.strictEqual(pickAlternative([big, weak], big, 'agent', load({ 'qwen2.5-coder:32b': 1 }, ['qwen2.5-coder:32b']), profile), undefined);
    // The least loaded comparable model wins; ties go to the better score (on a machine where all three fit)…
    const workstation = buildProfile({ platform: 'darwin', arch: 'arm64', cpuCores: 16, ramGb: 128, vramGb: 0 });
    assert.strictEqual(pickAlternative(models, coder, 'agent', load({ 'qwen2.5-coder:14b': 4, 'gemma4:12b': 2, 'qwen2.5-coder:32b': 1 }), workstation)?.modelId, 'qwen2.5-coder:32b');
    // …while on the 36 GB Mac those three (about 41 GB) are already over budget: no more concurrent work, the run queues.
    assert.strictEqual(pickAlternative(models, coder, 'agent', load({ 'qwen2.5-coder:14b': 4, 'gemma4:12b': 2, 'qwen2.5-coder:32b': 1 }), profile), undefined);
    // A model already resident in memory (idle, but loaded per the server) costs no extra weights and no load time:
    // a fine neighbour where the pair fits, and preferred over an equally idle model that would have to load first.
    const resident = new Set(['ollama/gemma4:12b']);
    assert.strictEqual(pickAlternative(models, coder, 'agent', load({ 'qwen2.5-coder:14b': 1 }, ['qwen2.5-coder:14b']), profile, false, undefined, resident)?.modelId, 'gemma4:12b');
    assert.strictEqual(pickAlternative(models, coder, 'agent', load({ 'qwen2.5-coder:14b': 1 }, ['qwen2.5-coder:14b']), laptop, false, undefined, resident), undefined, 'loaded or not, the pair overflows the laptop');
    // What the server reports beats the estimate from the weights. On a 36 GB Mac, gemma4:12b took 13.1 GB with its
    // context cache and a resident 27B model 19.5 GB (32.6 GB together): sending work to both at once crashed Ollama.
    const q27 = m('qwen3.8:27b', { sizeBytes: 18.2e9 });
    const sizes = new Map([['ollama/gemma4:12b', 13.1], ['ollama/qwen3.8:27b', 19.5]]);
    const gemmaBusy = load({ 'gemma4:12b': 1 }, ['gemma4:12b']);
    assert.strictEqual(pickAlternative([gemma, q27], gemma, 'agent', gemmaBusy, profile, false, undefined, new Set(sizes.keys()), sizes), undefined, 'both resident but over budget: queue on gemma');
    assert.strictEqual(pickAlternative([gemma, q27], gemma, 'agent', gemmaBusy, profile, false, undefined, new Set(['ollama/gemma4:12b']), new Map([['ollama/gemma4:12b', 13.1]])), undefined, 'the 27B model (~20 GB) does not fit beside 13.1 GB');
    assert.strictEqual(pickAlternative([gemma, q27], gemma, 'agent', gemmaBusy, profile, false, undefined, new Set(['ollama/gemma4:12b']), new Map([['ollama/gemma4:12b', 4]]))?.modelId, 'qwen3.8:27b', 'it does beside a small resident footprint');
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

  test('an empty Ollama listing (server still starting) does not count as every model uninstalled', async function () {
    this.timeout(30_000);
    const srv = await fakeOllama();
    const cfg = vscode.workspace.getConfiguration('localpilot');
    const prev = { providers: cfg.inspect('providers')?.globalValue, def: cfg.inspect('defaultModel')?.globalValue };
    const reg = new ProviderRegistry(log);
    const removed: string[] = [];
    reg.onDidRemoveModels((ids) => removed.push(...ids));
    try {
      await cfg.update('providers', [{ id: 'fake', type: 'ollama', baseUrl: srv.url }], vscode.ConfigurationTarget.Global);
      await cfg.update('defaultModel', 'fake/qwen2.5-coder:14b', vscode.ConfigurationTarget.Global);
      await new Promise((r) => setTimeout(r, 100));
      assert.ok((await reg.listModels(true)).length >= 2);
      srv.deleted.push(...srv.models.map((m) => m.name));
      assert.deepStrictEqual(await reg.listModels(true), []);
      await new Promise((r) => setTimeout(r, 100));
      assert.deepStrictEqual(removed, []);
      assert.strictEqual(vscode.workspace.getConfiguration('localpilot').get('defaultModel'), 'fake/qwen2.5-coder:14b');
    } finally {
      reg.dispose();
      srv.close();
      await cfg.update('providers', prev.providers, vscode.ConfigurationTarget.Global);
      await cfg.update('defaultModel', prev.def, vscode.ConfigurationTarget.Global);
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

  test('model manager waits for a duplicate pull instead of returning the running job', async function () {
    this.timeout(30_000);
    const srv = await fakeOllama();
    const cfg = vscode.workspace.getConfiguration('localpilot');
    const prevProviders = cfg.inspect('providers')?.globalValue;
    const reg = new ProviderRegistry(log);
    const mm = new ModelManager(reg, log);
    try {
      await cfg.update('providers', [{ id: 'fake', type: 'ollama', baseUrl: srv.url }], vscode.ConfigurationTarget.Global);
      await new Promise((r) => setTimeout(r, 100));
      const [a, b] = await Promise.all([mm.pull('ollama', 'smollm2:1.7b', 'fake'), mm.pull('ollama', 'smollm2:1.7b', 'fake')]);
      assert.strictEqual(a.status, 'done', a.error);
      assert.strictEqual(b.status, 'done', b.error);
      assert.deepStrictEqual(srv.pulled, ['smollm2:1.7b'], 'the model is downloaded once');
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

  test('auto-setup reports an installed Ollama that does not start instead of asking again', async function () {
    this.timeout(30_000);
    const cfg = vscode.workspace.getConfiguration('localpilot');
    const prevProviders = cfg.inspect('providers')?.globalValue;
    const reg = new ProviderRegistry(log);
    const mm = new ModelManager(reg, log);
    try {
      await cfg.update('providers', [{ id: 'dead', type: 'ollama', baseUrl: 'http://127.0.0.1:9' }], vscode.ConfigurationTarget.Global);
      await new Promise((r) => setTimeout(r, 100));
      const stub = mm as unknown as { detectRuntimes: () => Promise<unknown[]>; startOllama: () => Promise<unknown> };
      stub.detectRuntimes = async () => [
        { target: 'ollama', label: 'Ollama', installed: true, running: false },
        { target: 'docker', label: 'Docker', installed: false, running: false },
        { target: 'lmstudio', label: 'LM Studio', installed: false, running: false },
      ];
      const startJob = (status: string) => ({ id: 's', kind: 'start', target: 'ollama', model: 'Ollama', status, error: status === 'error' ? 'boom' : undefined, progress: -1, detail: '', startedAt: Date.now() });
      stub.startOllama = async () => startJob('error');
      const failed = await mm.autoSetup({ force: true });
      assert.strictEqual(failed.status, 'error');
      assert.match((failed as { error: string }).error, /boom/);
      stub.startOllama = async () => startJob('cancelled');
      const cancelled = await mm.autoSetup({ force: true });
      assert.strictEqual(cancelled.status, 'cancelled');
    } finally {
      mm.dispose();
      reg.dispose();
      await cfg.update('providers', prevProviders, vscode.ConfigurationTarget.Global);
    }
  });

  test('changing providers while a model listing is in flight lists the new providers, not the old ones', async function () {
    this.timeout(30_000);
    // An OpenAI-style server that answers /v1/models slowly, so the first listing is still running when the setting changes.
    const server = (id: string, delayMs: number) =>
      new Promise<{ url: string; close(): void }>((resolve) => {
        const srv = http.createServer((req, res) =>
          setTimeout(() => {
            res.setHeader('content-type', 'application/json');
            res.end(JSON.stringify({ data: req.url?.startsWith('/v1/models') ? [{ id, object: 'model' }] : [] }));
          }, delayMs)
        );
        srv.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${(srv.address() as AddressInfo).port}/v1`, close: () => srv.close() }));
      });
    const [oldSrv, newSrv] = await Promise.all([server('old-model', 1500), server('new-model', 0)]);
    const cfg = vscode.workspace.getConfiguration('localpilot');
    const prev = cfg.inspect('providers')?.globalValue;
    const reg = new ProviderRegistry(log);
    try {
      await cfg.update('providers', [{ id: 'old', type: 'openai', baseUrl: oldSrv.url }], vscode.ConfigurationTarget.Global);
      const inFlight = reg.listModels();
      await new Promise((r) => setTimeout(r, 200));
      await cfg.update('providers', [{ id: 'new', type: 'openai', baseUrl: newSrv.url }], vscode.ConfigurationTarget.Global);
      const [first, now] = await Promise.all([inFlight, reg.listModels()]);
      assert.deepStrictEqual(now.map((m) => m.id), ['new/new-model'], 'a caller after the change sees the new provider');
      assert.ok(!first.some((m) => m.id === 'old/old-model'), `the stale round is not handed out: ${first.map((m) => m.id).join(', ')}`);
      assert.deepStrictEqual(reg.cachedModels().map((m) => m.id), ['new/new-model'], 'and does not fill the cache');
    } finally {
      reg.dispose();
      oldSrv.close();
      newSrv.close();
      await cfg.update('providers', prev, vscode.ConfigurationTarget.Global);
    }
  });

  test('a stopped local Ollama is started when a run needs it, once; a local model never silently becomes a cloud one', async function () {
    this.timeout(30_000);
    const srv = await fakeOllama();
    // A port where nothing listens yet: "Ollama is installed but stopped". Starting it opens a proxy to the fake server.
    const port = await new Promise<number>((resolve) => {
      const s = net.createServer().listen(0, '127.0.0.1', () => {
        const p = (s.address() as AddressInfo).port;
        s.close(() => resolve(p));
      });
    });
    const sockets = new Set<net.Socket>();
    let proxy: net.Server | undefined;
    const target = Number(new URL(srv.url).port);
    const startProxy = () =>
      new Promise<void>((resolve) => {
        proxy = net.createServer((c) => {
          const up = net.connect(target, '127.0.0.1');
          sockets.add(c).add(up);
          c.on('error', () => undefined);
          up.on('error', () => undefined);
          c.pipe(up).pipe(c);
        });
        proxy.listen(port, '127.0.0.1', () => resolve());
      });
    const stopProxy = () => new Promise<void>((resolve) => (proxy ? (sockets.forEach((x) => x.destroy()), proxy.close(() => resolve())) : resolve()));
    // A stand-in cloud model, so a fallback off the machine would be possible.
    const cloud = http.createServer((req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ data: req.url?.startsWith('/v1/models') ? [{ id: 'cloud-model', object: 'model' }] : [] }));
    });
    await new Promise<void>((r) => cloud.listen(0, '127.0.0.1', () => r()));
    const cfg = vscode.workspace.getConfiguration('localpilot');
    const prev = { providers: cfg.inspect('providers')?.globalValue, def: cfg.inspect('defaultModel')?.globalValue };
    const reg = new ProviderRegistry(log);
    let starts = 0;
    reg.startLocalServer = async (p) => {
      assert.strictEqual(p.id, 'fake', 'the provider of the wanted model is started');
      starts++;
      await new Promise((r) => setTimeout(r, 200));
      await startProxy();
      return true;
    };
    try {
      await cfg.update(
        'providers',
        [
          { id: 'fake', type: 'ollama', baseUrl: `http://127.0.0.1:${port}` },
          { id: 'cloudy', type: 'openai', baseUrl: `http://127.0.0.1:${(cloud.address() as AddressInfo).port}/v1`, cloud: true },
        ],
        vscode.ConfigurationTarget.Global
      );
      await cfg.update('defaultModel', 'fake/qwen2.5-coder:14b', vscode.ConfigurationTarget.Global);
      await new Promise((r) => setTimeout(r, 100));
      assert.ok(!(await reg.listModels(true)).some((m) => m.providerId === 'fake'), 'the local server starts out stopped');
      const [a, b] = await Promise.all([reg.route({}), reg.route({})]);
      assert.strictEqual(starts, 1, 'two runs at once start it once');
      assert.strictEqual(a.model.id, 'fake/qwen2.5-coder:14b');
      assert.ok(!a.fallback && b.model.id === a.model.id, 'both runs get the model they asked for');

      // Stopped again, and this time it cannot be started: the run says so instead of moving to the cloud model.
      await stopProxy();
      reg.startLocalServer = async () => false;
      await reg.listModels(true);
      await assert.rejects(reg.route({}), (e: Error) => /qwen2\.5-coder:14b runs on fake/.test(e.message) && /could not be started/.test(e.message) && /does not switch a local model to a cloud one/.test(e.message));
      // Auto (no default) may still use the cloud model when nothing local can run: that is documented behaviour.
      await cfg.update('defaultModel', '', vscode.ConfigurationTarget.Global);
      await new Promise((r) => setTimeout(r, 100));
      assert.strictEqual((await reg.route({})).model.id, 'cloudy/cloud-model');
    } finally {
      reg.dispose();
      await stopProxy();
      srv.close();
      cloud.close();
      await cfg.update('providers', prev.providers, vscode.ConfigurationTarget.Global);
      await cfg.update('defaultModel', prev.def, vscode.ConfigurationTarget.Global);
    }
  });

  /** Serves `body` from a fake /v1/models and returns what an OpenAI-compatible provider lists from it. */
  async function listFrom(body: unknown): Promise<ModelInfo[]> {
    const srv = http.createServer((_req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(body));
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
    try {
      return await new OpenAICompatProvider({ id: 'fake', type: 'openai', baseUrl: `http://127.0.0.1:${(srv.address() as AddressInfo).port}/v1` }).listModels();
    } finally {
      srv.close();
    }
  }

  test('local OpenAI-compatible servers mark Gemma 4 and Mistral Small 3.2 as able to see images', async () => {
    const ids = ['ai/gemma4:e4b', 'google/gemma-4-e4b', 'mistral-small-3.2-24b-instruct-2506', 'qwen2.5-coder:7b'];
    const vision = Object.fromEntries((await listFrom({ data: ids.map((id) => ({ id })) })).map((m) => [m.modelId, m.supportsVision]));
    assert.deepStrictEqual(vision, { 'ai/gemma4:e4b': true, 'google/gemma-4-e4b': true, 'mistral-small-3.2-24b-instruct-2506': true, 'qwen2.5-coder:7b': false });
  });

  test('a /models that answers with a bare array (Together AI) lists its chat models only', async () => {
    const models = await listFrom([
      { id: 'meta-llama/Llama-3.3-70B-Instruct-Turbo', type: 'chat' },
      { id: 'black-forest-labs/FLUX.1-schnell', type: 'image' },
      { id: 'BAAI/bge-base-en-v1.5', type: 'embedding' },
    ]);
    assert.deepStrictEqual(models.map((m) => m.modelId), ['meta-llama/Llama-3.3-70B-Instruct-Turbo']);
  });

  /** Streams each chunk as an SSE event from a fake /chat/completions and returns what the provider made of it. */
  async function streamChunks(chunks: unknown[]): Promise<StreamEvent[]> {
    const srv = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(`${chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('')}data: [DONE]\n\n`);
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
    try {
      const p = new OpenAICompatProvider({ id: 'fake', type: 'openai', baseUrl: `http://127.0.0.1:${(srv.address() as AddressInfo).port}/v1` });
      const out: StreamEvent[] = [];
      for await (const ev of p.chat({ model: 'm', messages: [{ role: 'user', content: 'hi' }] })) {
        out.push(ev);
      }
      return out;
    } finally {
      srv.close();
    }
  }
  const callsOf = (evs: StreamEvent[]) => evs.flatMap((e) => (e.type === 'tool_call' ? [{ name: e.call.name, args: e.call.arguments }] : []));

  test('OpenAI-compatible streams keep index-less parallel tool calls apart and join indexed fragments', async () => {
    const a = { id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.ts"}' } };
    const b = { id: 'c2', type: 'function', function: { name: 'list_dir', arguments: '{"path":"src"}' } };
    const want = [{ name: 'read_file', args: '{"path":"a.ts"}' }, { name: 'list_dir', args: '{"path":"src"}' }];
    assert.deepStrictEqual(callsOf(await streamChunks([{ choices: [{ delta: { tool_calls: [a, b] } }] }])), want, 'both in one chunk');
    assert.deepStrictEqual(callsOf(await streamChunks([{ choices: [{ delta: { tool_calls: [a] } }] }, { choices: [{ delta: { tool_calls: [b] } }] }])), want, 'one chunk per call');
    const frags = [
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'x', function: { name: 'read_file', arguments: '' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"pa' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'th":"a.ts"}' } }] } }] },
    ];
    assert.deepStrictEqual(callsOf(await streamChunks(frags)), [want[0]], 'indexed fragments join');
  });

  test('OpenAI-compatible streams read Mistral content lists as thinking and text', async () => {
    const evs = await streamChunks([
      { choices: [{ delta: { content: [{ type: 'thinking', thinking: [{ type: 'text', text: 'Let me ' }] }] } }] },
      { choices: [{ delta: { content: [{ type: 'thinking', thinking: [{ type: 'text', text: 'think.' }] }, { type: 'text', text: 'Hello' }] } }] },
      { choices: [{ delta: { content: ' world' } }] },
    ]);
    const join = (t: string) => evs.map((e) => (e.type === t && 'text' in e ? e.text : '')).join('');
    assert.strictEqual(join('thinking'), 'Let me think.');
    assert.strictEqual(join('text'), 'Hello world');
  });

  test('errors sent inside the stream are classified for retry', async () => {
    assert.strictEqual(classifyModelError(new Error('error parsing tool call: raw=\'{"path":"src",}\', err=network aborted')), 'toolcall');
    assert.strictEqual(classifyModelError(new Error('Overloaded')), 'server');
    assert.strictEqual(classifyModelError(new Error('Rate limit reached, try again later')), 'ratelimit');
    assert.strictEqual(classifyModelError(new Error('Insufficient credits on this account')), 'quota');
    assert.strictEqual(classifyModelError(new HttpError(529, '{"type":"overloaded_error","message":"Overloaded"}', 'http://x')), 'server');
    await assert.rejects(streamChunks([{ error: { message: 'upstream failed', type: 'server_error' } }]), (e: unknown) => e instanceof HttpError && e.status === 500 && classifyModelError(e) === 'server');
    await assert.rejects(streamChunks([{ error: { code: 502, message: 'Provider disconnected' } }]), (e: unknown) => e instanceof HttpError && e.status === 502 && classifyModelError(e) === 'server');
    await assert.rejects(streamChunks([{ error: { message: 'Upstream provider overloaded' } }]), (e: unknown) => e instanceof HttpError && e.status === 502);
    const srv = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end('event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":3}}}\n\nevent: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}\n\n');
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
    try {
      const p = new AnthropicProvider({ id: 'claude', type: 'anthropic', baseUrl: `http://127.0.0.1:${(srv.address() as AddressInfo).port}/v1`, apiKey: 'k' });
      await assert.rejects(
        (async () => {
          for await (const _ of p.chat({ model: 'claude-sonnet-4-5', messages: [{ role: 'user', content: 'hi' }] })) {
            // drain
          }
        })(),
        (e: unknown) => e instanceof HttpError && e.status === 529 && classifyModelError(e) === 'server'
      );
    } finally {
      srv.close();
    }
  });

  /** An OpenAI-style server: `models` on /v1/models (404 when undefined), a one-word answer on /v1/chat/completions. */
  const openaiServer = (models?: string[]) =>
    new Promise<{ url: string; close(): Promise<void> }>((resolve) => {
      const srv = http.createServer((req, res) => {
        if (req.url?.startsWith('/v1/models')) {
          res.writeHead(models ? 200 : 404, { 'content-type': 'application/json' });
          res.end(JSON.stringify(models ? { data: models.map((id) => ({ id, object: 'model' })) } : { error: 'not found' }));
          return;
        }
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n');
      });
      srv.listen(0, '127.0.0.1', () =>
        resolve({
          url: `http://127.0.0.1:${(srv.address() as AddressInfo).port}/v1`,
          close: () => new Promise<void>((r) => { srv.closeAllConnections(); srv.close(() => r()); }),
        })
      );
    });

  test('configured models of a server without /models are listed and routed; a stopped server is not listed', async function () {
    this.timeout(30_000);
    const gw = await openaiServer();
    const cfg = vscode.workspace.getConfiguration('localpilot');
    const prev = cfg.inspect('providers')?.globalValue;
    const reg = new ProviderRegistry(log);
    try {
      await cfg.update('providers', [{ id: 'gw', type: 'openai', baseUrl: gw.url, models: ['my-model'] }], vscode.ConfigurationTarget.Global);
      assert.ok((await reg.listModels(true)).some((m) => m.id === 'gw/my-model'), 'listed from the configuration');
      const route = await reg.route({ modelRef: 'gw/my-model' });
      assert.strictEqual(route.model.id, 'gw/my-model');
      assert.ok(!route.fallback && !route.reason, String(route.reason));
      await gw.close();
      assert.ok(!(await reg.listModels(true)).some((m) => m.providerId === 'gw'), 'a stopped server is not reported as up');
    } finally {
      reg.dispose();
      await gw.close().catch(() => undefined);
      await cfg.update('providers', prev, vscode.ConfigurationTarget.Global);
    }
  });

  test('a provider that misses one check is replaced for that turn only, not for good', async function () {
    this.timeout(30_000);
    const [a, b] = await Promise.all([openaiServer(['model-a']), openaiServer(['model-b'])]);
    const cfg = vscode.workspace.getConfiguration('localpilot');
    const prev = cfg.inspect('providers')?.globalValue;
    const reg = new ProviderRegistry(log);
    try {
      await cfg.update('providers', [{ id: 'A', type: 'openai', baseUrl: a.url }, { id: 'B', type: 'openai', baseUrl: b.url }], vscode.ConfigurationTarget.Global);
      assert.deepStrictEqual((await reg.listModels(true)).map((m) => m.id).sort(), ['A/model-a', 'B/model-b']);
      await a.close();
      await reg.listModels(true);
      const route = await reg.route({ modelRef: 'A/model-a' });
      assert.strictEqual(route.model.id, 'B/model-b');
      assert.ok(route.fallback && route.unavailable, JSON.stringify({ fallback: route.fallback, unavailable: route.unavailable }));
      assert.match(route.reason ?? '', /not answering/);
    } finally {
      reg.dispose();
      await a.close().catch(() => undefined);
      await b.close();
      await cfg.update('providers', prev, vscode.ConfigurationTarget.Global);
    }
  });

  /** A fake /chat/completions that records each request body; `reject` answers a body with a 400 and that message. */
  async function recordingServer(reject?: (body: Record<string, unknown>) => string | undefined) {
    const bodies: Record<string, unknown>[] = [];
    const srv = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        const body = JSON.parse(raw) as Record<string, unknown>;
        bodies.push(body);
        const err = reject?.(body);
        if (err) {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { message: err } }));
          return;
        }
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n');
      });
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
    return { bodies, url: `http://127.0.0.1:${(srv.address() as AddressInfo).port}/v1`, close: () => srv.close() };
  }

  const drain = async (it: AsyncIterable<StreamEvent>) => {
    for await (const _ of it) {
      // consume
    }
  };

  test('Mistral models get 9-character alphanumeric tool-call ids that still pair up', async () => {
    const srv = await recordingServer();
    try {
      const p = new OpenAICompatProvider({ id: 'fake', type: 'openai', baseUrl: srv.url });
      await drain(
        p.chat({
          model: 'mistral-large-latest',
          messages: [
            { role: 'user', content: 'go' },
            { role: 'assistant', content: '', toolCalls: [{ id: 'call_abc123def456gh', name: 'read_file', arguments: '{}' }] },
            { role: 'tool', toolCallId: 'call_abc123def456gh', content: 'a' },
            { role: 'assistant', content: '', toolCalls: [{ id: 'toolu_01XYZ', name: 'list_files', arguments: '{}' }] },
            { role: 'tool', toolCallId: 'toolu_01XYZ', content: 'b' },
          ],
        })
      );
      const msgs = srv.bodies[0].messages as { role: string; tool_calls?: { id: string }[]; tool_call_id?: string }[];
      const calls = msgs.flatMap((m) => m.tool_calls?.map((t) => t.id) ?? []);
      const results = msgs.filter((m) => m.role === 'tool').map((m) => m.tool_call_id);
      assert.strictEqual(calls.length, 2);
      for (const id of [...calls, ...results]) {
        assert.match(String(id), /^[a-zA-Z0-9]{9}$/);
      }
      assert.deepStrictEqual(results, calls);
      assert.notStrictEqual(calls[0], calls[1]);
    } finally {
      srv.close();
    }
  });

  test('think:false sends reasoning_effort none to cloud servers, dropped once if rejected without losing real levels', async () => {
    const srv = await recordingServer((b) => (b.reasoning_effort === 'none' ? 'Unsupported value for reasoning_effort' : undefined));
    try {
      const p = new OpenAICompatProvider({ id: 'fake', type: 'openai', baseUrl: srv.url, cloud: true });
      await drain(p.chat({ model: 'gpt-x', messages: [{ role: 'user', content: 'hi' }], think: false }));
      assert.strictEqual(srv.bodies[0].reasoning_effort, 'none');
      assert.strictEqual(srv.bodies.length, 2);
      assert.strictEqual(srv.bodies[1].reasoning_effort, undefined);
      await drain(p.chat({ model: 'gpt-x', messages: [{ role: 'user', content: 'hi' }], think: 'high' }));
      assert.strictEqual(srv.bodies[2].reasoning_effort, 'high');
    } finally {
      srv.close();
    }
  });

  test('pairToolCalls turns unanswered tool calls back into text and leaves paired history alone', () => {
    const text = pairToolCalls([
      { role: 'user', content: 'read a.ts' },
      { role: 'assistant', content: 'Reading.', toolCalls: [{ id: 'call_x', name: 'read_file', arguments: '{"path":"a.ts"}' }] },
      { role: 'user', content: '<tool_result name="read_file">…</tool_result>' },
    ]);
    assert.ok(!text.some((m) => m.toolCalls), JSON.stringify(text));
    assert.match(text[1].content, /<tool_call>\{"name":"read_file","arguments":\{"path":"a\.ts"\}\}<\/tool_call>/);
    const native = [
      { role: 'user' as const, content: 'read a.ts' },
      { role: 'assistant' as const, content: '', toolCalls: [{ id: 'call_y', name: 'read_file', arguments: '{}' }] },
      { role: 'tool' as const, toolCallId: 'call_y', content: 'x' },
    ];
    assert.deepStrictEqual(pairToolCalls(native), native);
  });

  test('imageMime recognises PNG, JPEG, GIF and WebP data', () => {
    const b64 = (bytes: number[] | string) => Buffer.from(typeof bytes === 'string' ? Buffer.from(bytes, 'latin1') : bytes).toString('base64');
    assert.strictEqual(imageMime(b64([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d])), 'image/png');
    assert.strictEqual(imageMime(b64([0xff, 0xd8, 0xff, 0xe0, 0, 0x10])), 'image/jpeg');
    assert.strictEqual(imageMime(b64('GIF89a\x01\x00')), 'image/gif');
    assert.strictEqual(imageMime(b64('RIFF\x24\x00\x00\x00WEBPVP8 ')), 'image/webp');
    assert.strictEqual(imageMime(b64('RIFF\x24\x00\x00\x00WAVEfmt ')), 'image/png', 'a RIFF file that is not WebP');
  });
});
