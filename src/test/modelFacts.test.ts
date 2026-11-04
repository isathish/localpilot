import * as assert from 'assert';
import * as http from 'http';
import { AddressInfo } from 'net';
import { AnthropicProvider } from '../providers/anthropic';
import { anyModelFacts, factsProvider, MODEL_FACTS_UPDATED, modelFacts, outputLimit, pricingOf } from '../providers/modelFacts';
import { OllamaProvider } from '../providers/ollama';
import { OpenAICompatProvider } from '../providers/openaiCompat';
import { costOf, formatCost, withCost } from '../providers/pricing';
import { PROVIDER_PRESETS } from '../providers/presets';

suite('Model facts and pricing', () => {
  const sonnet = { pricing: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 } };
  const close = (a: number | undefined, b: number) => assert.ok(a !== undefined && Math.abs(a - b) < 1e-12, `${a} ≠ ${b}`);

  test('costOf splits cached input out of the prompt', () => {
    close(costOf({ promptTokens: 1_000_000, completionTokens: 100_000 }, sonnet), 4.5);
    close(costOf({ promptTokens: 1_000_000, cacheReadTokens: 600_000, cacheWriteTokens: 200_000 }, sonnet), 0.6 + 0.18 + 0.75);
    close(costOf({ promptTokens: 100, cacheReadTokens: 400 }, sonnet), 400 * 0.3 / 1e6);
  });

  test('cache prices fall back to input and 1.25 × input', () => {
    close(costOf({ promptTokens: 200, cacheReadTokens: 100, cacheWriteTokens: 100 }, { pricing: { input: 2, output: 8 } }), (200 + 250) / 1e6);
  });

  test('a reported cost wins and unpriced models cost nothing known', () => {
    assert.strictEqual(costOf({ promptTokens: 5, costUsd: 0.5 }, sonnet), 0.5);
    assert.strictEqual(costOf({ promptTokens: 5 }, {}), undefined);
    assert.strictEqual(costOf(undefined, sonnet), undefined);
    assert.strictEqual(withCost({ promptTokens: 1_000_000 }, sonnet)?.costUsd, 3);
    assert.strictEqual(withCost({ promptTokens: 1_000_000, costUsd: 0.1 }, sonnet)?.costUsd, 0.1);
    assert.strictEqual(formatCost(undefined), 'local · free');
    assert.strictEqual(formatCost(0.01234), '$0.0123');
  });

  test('the bundled table covers the priced cloud presets', () => {
    assert.match(MODEL_FACTS_UPDATED, /^\d{4}-\d{2}-\d{2}$/);
    for (const key of ['openai', 'anthropic', 'openrouter', 'groq', 'deepseek', 'mistral', 'gemini', 'xai', 'together', 'fireworks']) {
      const preset = PROVIDER_PRESETS.find((p) => p.key === key)!;
      assert.strictEqual(factsProvider(preset.cfg), key, key);
    }
    assert.strictEqual(factsProvider({ type: 'openai', baseUrl: 'http://localhost:4000/v1' }), undefined, 'gateways are not priced');
  });

  test('lookups tolerate dated snapshots and prefixes', () => {
    assert.ok(modelFacts('claude-sonnet-4-5-20250929', 'anthropic')?.maxOutput);
    assert.ok(modelFacts('models/gemini-2.5-pro', 'gemini')?.contextWindow);
    assert.ok(anyModelFacts('openai/gpt-4o'));
    assert.strictEqual(modelFacts('nobody-knows', 'openai'), undefined);
    assert.strictEqual(pricingOf({ input: 1, output: 1 }, 'ollama-cloud'), undefined);
    assert.strictEqual(outputLimit({ maxOutput: 100_000 }, 50_000, true), 50_000);
    assert.strictEqual(outputLimit(undefined, 65_536, false), 65_536);
  });

  test('listings fill limits and prices from the facts', async () => {
    const srv = http.createServer((req, res) => {
      res.setHeader('content-type', 'application/json');
      if (req.url?.startsWith('/v1/models')) {
        res.end(JSON.stringify({ data: [{ id: 'claude-sonnet-4-5-20250929' }, { id: 'gpt-4o' }, { id: 'local-model' }] }));
      } else if (req.url === '/api/tags') {
        res.end(JSON.stringify({ models: [{ name: 'qwen3:8b', size: 5e9 }] }));
      } else if (req.url === '/api/show') {
        res.end(JSON.stringify({ capabilities: ['completion', 'tools'], model_info: { 'qwen3.context_length': 40960 } }));
      } else {
        res.statusCode = 404;
        res.end('{}');
      }
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const root = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
    try {
      const facts = modelFacts('claude-sonnet-4-5', 'anthropic')!;
      const claude = (await new AnthropicProvider({ id: 'anthropic', type: 'anthropic', baseUrl: `${root}/v1` }).listModels())[0];
      assert.strictEqual(claude.maxOutputTokens, facts.maxOutput);
      assert.deepStrictEqual(claude.pricing, { input: facts.input, output: facts.output, cacheRead: facts.cacheRead, cacheWrite: facts.cacheWrite });

      const gateway = await new OpenAICompatProvider({ id: 'litellm', type: 'openai', baseUrl: `${root}/v1`, cloud: true }).listModels();
      const gpt = gateway.find((m) => m.modelId === 'gpt-4o')!;
      assert.strictEqual(gpt.contextWindow, modelFacts('gpt-4o', 'openai')?.contextWindow);
      assert.strictEqual(gpt.pricing, undefined, 'a gateway has its own prices');

      const local = (await new OpenAICompatProvider({ id: 'vllm', type: 'openai', baseUrl: `${root}/v1`, contextWindow: 65536 }).listModels()).find((m) => m.modelId === 'local-model')!;
      assert.strictEqual(local.maxOutputTokens, 65536);
      assert.strictEqual(local.pricing, undefined);

      const ollama = (await new OllamaProvider({ id: 'ollama', type: 'ollama', baseUrl: root }).listModels())[0];
      assert.strictEqual(ollama.maxOutputTokens, 40960, 'local Ollama is bounded by its context, not 8192');
      assert.strictEqual(ollama.pricing, undefined);
    } finally {
      srv.close();
    }
  });
});
