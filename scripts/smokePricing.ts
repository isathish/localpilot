/**
 * Smoke checks for the bundled model facts and pricing (bundled into scripts/smoke.ts): `costOf` cases, the facts
 * lookup, and the limits and prices a provider listing fills in from them.
 */
import * as http from 'http';
import { AnthropicProvider } from '../src/providers/anthropic';
import { anyModelFacts, factsProvider, modelFacts, outputLimit, pricingOf } from '../src/providers/modelFacts';
import { OpenAICompatProvider } from '../src/providers/openaiCompat';
import { costOf, formatCost, withCost } from '../src/providers/pricing';

type Check = (name: string, cond: boolean, detail?: unknown) => void;

const near = (a: number | undefined, b: number) => a !== undefined && Math.abs(a - b) < 1e-12;

export async function pricing(check: Check): Promise<void> {
  console.log('\n[Model facts and pricing]');
  const p = { pricing: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 } };
  check('costOf: plain input and output', near(costOf({ promptTokens: 1_000_000, completionTokens: 100_000 }, p), 3 + 1.5));
  check('costOf: cached input is billed at cache prices, not twice', near(costOf({ promptTokens: 1_000_000, completionTokens: 0, cacheReadTokens: 600_000, cacheWriteTokens: 200_000 }, p), 0.2 * 3 + 0.6 * 0.3 + 0.2 * 3.75));
  check('costOf: cache writes default to 1.25 × input, reads to input', near(costOf({ promptTokens: 200, cacheReadTokens: 100, cacheWriteTokens: 100 }, { pricing: { input: 2, output: 8 } }), (100 * 2 + 100 * 2.5) / 1e6));
  check('costOf: a provider-reported cost wins', costOf({ promptTokens: 1e6, costUsd: 0.42 }, p) === 0.42);
  check('costOf: local models (no price) are undefined', costOf({ promptTokens: 1e6, completionTokens: 1e6 }, {}) === undefined && costOf(undefined, p) === undefined);
  check('withCost fills only a missing cost', withCost({ promptTokens: 1e6 }, p)?.costUsd === 3 && withCost({ promptTokens: 1e6, costUsd: 1 }, p)?.costUsd === 1 && withCost({ promptTokens: 1 }, {})?.costUsd === undefined);
  check('formatCost', formatCost(0.01234) === '$0.0123' && formatCost(12.5) === '$12.50' && formatCost(undefined) === 'local · free' && formatCost(0.00001) === '<$0.0001');

  const sonnet = modelFacts('claude-sonnet-4-5-20250929', 'anthropic');
  check('facts: Anthropic model by dated id', !!sonnet?.contextWindow && !!sonnet.maxOutput && sonnet.input !== undefined && !!sonnet.promptCache, sonnet);
  check('facts: Gemini ids with a models/ prefix', !!modelFacts('models/gemini-2.5-pro', 'gemini')?.contextWindow);
  check('facts: unknown model or provider', modelFacts('my-finetune', 'openai') === undefined && modelFacts('gpt-4o', undefined) === undefined);
  check('facts: gateways match by bare id', !!anyModelFacts('openai/gpt-4o')?.contextWindow && anyModelFacts('qwen2.5-coder:7b-local-thing') === undefined);
  check('factsProvider: cloud presets by API host only', factsProvider({ type: 'openai', baseUrl: 'https://api.openai.com/v1' }) === 'openai' && factsProvider({ type: 'openai', baseUrl: 'https://openrouter.ai/api/v1/' }) === 'openrouter' && factsProvider({ type: 'openai', baseUrl: 'http://localhost:4000/v1' }) === undefined && factsProvider({ type: 'anthropic', baseUrl: 'http://localhost:9999' }) === 'anthropic');
  check('pricing: subscription and unknown prices stay unpriced', pricingOf({ input: 1, output: 2 }, 'ollama-cloud') === undefined && pricingOf({ input: 1 }, 'openai') === undefined && pricingOf({ input: 1, output: 2 }, undefined) === undefined);
  check('outputLimit: facts, capped by context; local = context', outputLimit({ maxOutput: 64000 }, 32000, true) === 32000 && outputLimit(undefined, 131072, false) === 131072 && outputLimit(undefined, 200000, true) === 8192);

  const srv = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url?.startsWith('/v1/models')) {
      res.end(JSON.stringify({ data: [{ id: 'claude-sonnet-4-5-20250929' }, { id: 'gpt-4o' }, { id: 'my-local-model' }] }));
    } else {
      res.statusCode = 404;
      res.end('{}');
    }
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(srv.address() as { port: number }).port}/v1`;
  try {
    const claude = (await new AnthropicProvider({ id: 'anthropic', type: 'anthropic', baseUrl: url }).listModels()).find((m) => m.modelId === 'claude-sonnet-4-5-20250929');
    check('Anthropic listing: limits and prices from the facts', claude?.maxOutputTokens === sonnet?.maxOutput && claude?.pricing?.input === sonnet?.input && claude?.pricing?.cacheWrite === sonnet?.cacheWrite, claude);
    const gateway = await new OpenAICompatProvider({ id: 'litellm', type: 'openai', baseUrl: url, cloud: true }).listModels();
    const gpt = gateway.find((m) => m.modelId === 'gpt-4o');
    check('gateway listing: limits from the facts, no prices', gpt?.maxOutputTokens === modelFacts('gpt-4o', 'openai')?.maxOutput && gpt?.contextWindow === modelFacts('gpt-4o', 'openai')?.contextWindow && gpt?.pricing === undefined, gpt);
    const local = (await new OpenAICompatProvider({ id: 'vllm', type: 'openai', baseUrl: url, contextWindow: 65536 }).listModels()).find((m) => m.modelId === 'my-local-model');
    check('local listing: output bounded by context, free', local?.maxOutputTokens === 65536 && local?.pricing === undefined && costOf({ promptTokens: 10 }, local) === undefined, local);
  } finally {
    srv.close();
  }
}
