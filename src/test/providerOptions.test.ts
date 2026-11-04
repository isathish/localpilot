import * as assert from 'assert';
import * as http from 'http';
import { AddressInfo } from 'net';
import { resolveHeaders, setSecretValues } from '../providers/cloud';
import { OpenAICompatProvider } from '../providers/openaiCompat';
import { applyModelOverrides, cleanHeaders, expandProviderRef, firstTokenFloor, withApiVersion, withExtraBody } from '../providers/providerOptions';
import { sanitizeProviderConfig } from '../providers/sanitize';
import { ModelInfo, ProviderConfig } from '../types';

/** An OpenAI-compatible server that records each request's URL, headers and body. */
async function recorder(): Promise<{ url: string; hits: { url: string; headers: http.IncomingHttpHeaders; body?: Record<string, unknown> }[]; close(): void }> {
  const hits: { url: string; headers: http.IncomingHttpHeaders; body?: Record<string, unknown> }[] = [];
  const srv = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      hits.push({ url: req.url ?? '', headers: req.headers, body: raw ? JSON.parse(raw) : undefined });
      if (req.method === 'GET') {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ data: [{ id: 'big-model', context_length: 32768 }, { id: 'other' }] }));
        return;
      }
      res.setHeader('content-type', 'text/event-stream');
      res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
    });
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${(srv.address() as AddressInfo).port}`, hits, close: () => srv.close() };
}

const model = (over: Partial<ModelInfo> = {}): ModelInfo => ({ id: 'p/m', providerId: 'p', modelId: 'm', name: 'm', contextWindow: 32768, maxOutputTokens: 8192, supportsTools: true, supportsVision: false, ...over });

suite('Provider options (pure)', () => {
  test('model overrides: limits, capabilities, prices and temperature win', () => {
    const [m] = applyModelOverrides([model({ pricing: { input: 1, output: 2, cacheRead: 0.1 } })], { M: { contextWindow: 200000, maxOutput: 300000, vision: true, reasoning: true, outputPrice: 4, temperature: 0.3 } });
    assert.strictEqual(m.contextWindow, 200000);
    assert.strictEqual(m.maxOutputTokens, 200000, 'output never above the context window');
    assert.strictEqual(m.supportsVision, true);
    assert.strictEqual(m.supportsThinking, true);
    assert.deepStrictEqual(m.pricing, { input: 1, output: 4, cacheRead: 0.1 });
    assert.strictEqual(m.temperature, 0.3);
    const [half] = applyModelOverrides([model()], { m: { inputPrice: 3 } });
    assert.strictEqual(half.pricing, undefined, 'a half-known price is not invented');
    const untouched = model();
    assert.strictEqual(applyModelOverrides([untouched], { other: { vision: true } })[0], untouched);
  });

  test('extraBody merges nested objects and never replaces the conversation', () => {
    const body: Record<string, unknown> = { model: 'a', messages: [1], provider: { order: ['x'] }, stream: true };
    withExtraBody(body, { model: 'evil', messages: [], stream: false, provider: { sort: 'price' }, top_k: 5 });
    assert.deepStrictEqual(body, { model: 'a', messages: [1], provider: { order: ['x'], sort: 'price' }, stream: true, top_k: 5 });
  });

  test('api-version, timeout floor and bare provider ids', () => {
    assert.strictEqual(withApiVersion('https://r.openai.azure.com/openai/deployments/d/chat/completions', '2024-10-21'), 'https://r.openai.azure.com/openai/deployments/d/chat/completions?api-version=2024-10-21');
    assert.strictEqual(withApiVersion('https://x/v1/models?limit=5', '1'), 'https://x/v1/models?limit=5&api-version=1');
    assert.strictEqual(withApiVersion('https://x/v1/models', undefined), 'https://x/v1/models');
    assert.strictEqual(firstTokenFloor({ timeoutMs: 90000 }), 90000);
    assert.strictEqual(firstTokenFloor({ timeoutMs: 5 }), 1000);
    assert.strictEqual(firstTokenFloor({}), 0);
    const providers: Pick<ProviderConfig, 'id' | 'defaultModel'>[] = [{ id: 'openrouter', defaultModel: 'qwen/qwen3-coder' }, { id: 'ollama' }];
    assert.strictEqual(expandProviderRef('openrouter', providers), 'openrouter/qwen/qwen3-coder');
    assert.strictEqual(expandProviderRef('ollama', providers), 'ollama');
    assert.strictEqual(expandProviderRef('openrouter/x', providers), 'openrouter/x');
  });

  test('settings are cleaned: bad header names, junk overrides and invalid URLs are dropped', () => {
    assert.deepStrictEqual(cleanHeaders({ 'X-Org': 'acme', 'bad name': 'x', 'X-Line': 'a\nb' }), { 'X-Org': 'acme' });
    const p = sanitizeProviderConfig({
      id: 'gw', type: 'openai', baseUrl: 'https://gw.example/v1',
      headers: { 'X-Team': '${env:TEAM}' }, timeoutMs: 120000, apiVersion: '2024-10-21', defaultModel: ' m1 ', modelsUrl: 'not a url',
      extraBody: { provider: { sort: 'latency' } },
      modelOverrides: { m1: { contextWindow: 65536, vision: 'yes' as unknown as boolean, inputPrice: -1, temperature: 0.2 }, empty: {} },
    });
    assert.deepStrictEqual(p.headers, { 'X-Team': '${env:TEAM}' });
    assert.strictEqual(p.timeoutMs, 120000);
    assert.strictEqual(p.apiVersion, '2024-10-21');
    assert.strictEqual(p.defaultModel, 'm1');
    assert.strictEqual(p.modelsUrl, undefined);
    assert.deepStrictEqual(p.extraBody, { provider: { sort: 'latency' } });
    assert.deepStrictEqual(p.modelOverrides, { m1: { contextWindow: 65536, temperature: 0.2 } });
  });

  test('header values expand ${env:} and ${secret:}; unresolved ones are left out', () => {
    process.env.LP_TEST_TEAM = 'blue';
    setSecretValues({ 'lp-test-token': 's3cret' });
    try {
      assert.deepStrictEqual(resolveHeaders({ headers: { 'X-Team': 'team-${env:LP_TEST_TEAM}', Authorization: 'Bearer ${secret:lp-test-token}', 'X-Missing': '${env:LP_TEST_NOPE}' } }), { 'X-Team': 'team-blue', Authorization: 'Bearer s3cret' });
    } finally {
      delete process.env.LP_TEST_TEAM;
      setSecretValues({ 'lp-test-token': undefined });
    }
  });
});

suite('Provider options on the wire', () => {
  test('custom headers (over the key), api-version, extraBody and the models URL', async () => {
    const srv = await recorder();
    try {
      const p = new OpenAICompatProvider({
        id: 'gw', type: 'openai', baseUrl: `${srv.url}/v1`, apiKey: 'key-1',
        headers: { 'X-Org': 'acme', Authorization: 'Bearer override' }, apiVersion: '2024-10-21', extraBody: { provider: { sort: 'price' } }, modelsUrl: `${srv.url}/catalog`,
      });
      const models = await p.listModels();
      assert.ok(models.some((m) => m.modelId === 'big-model'));
      assert.strictEqual(srv.hits[0].url, '/catalog');
      for await (const _ of p.chat({ model: 'big-model', messages: [{ role: 'user', content: 'hi' }] })) {
        // consume
      }
      const chat = srv.hits[srv.hits.length - 1];
      assert.strictEqual(chat.url, '/v1/chat/completions?api-version=2024-10-21');
      assert.strictEqual(chat.headers['x-org'], 'acme');
      assert.strictEqual(chat.headers.authorization, 'Bearer override');
      assert.deepStrictEqual(chat.body?.provider, { sort: 'price' });
    } finally {
      srv.close();
    }
  });

  test('model overrides apply to the listing', async () => {
    const srv = await recorder();
    try {
      const p = new OpenAICompatProvider({ id: 'gw', type: 'openai', baseUrl: `${srv.url}/v1`, modelOverrides: { 'big-model': { contextWindow: 131072, vision: true, inputPrice: 0.5, outputPrice: 1.5 } } });
      const m = (await p.listModels()).find((x) => x.modelId === 'big-model')!;
      assert.strictEqual(m.contextWindow, 131072);
      assert.strictEqual(m.supportsVision, true);
      assert.deepStrictEqual(m.pricing, { input: 0.5, output: 1.5 });
      assert.strictEqual((await p.listModels()).find((x) => x.modelId === 'other')!.pricing, undefined);
    } finally {
      srv.close();
    }
  });
});
