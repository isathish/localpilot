import * as assert from 'assert';
import * as http from 'http';
import { AddressInfo } from 'net';
import { OpenAICompatProvider } from '../providers/openaiCompat';
import { isLmStudio, lmStudioContexts, lmStudioRoot } from '../providers/lmstudio';
import { bedrockRegion, bedrockUrl, findPreset, withRegion } from '../providers/presets';

/** An OpenAI-compatible server whose `/v1/models` has no context fields; `native` adds LM Studio's `/api/v0/models`. */
async function fakeServer(native: boolean): Promise<{ url: string; hits: string[]; close(): void }> {
  const hits: string[] = [];
  const srv = http.createServer((req, res) => {
    hits.push(req.url ?? '');
    res.setHeader('content-type', 'application/json');
    if (req.url === '/v1/models') {
      res.end(JSON.stringify({ data: [{ id: 'qwen3-8b' }, { id: 'gemma-3-4b' }, { id: 'phi-4' }] }));
    } else if (native && req.url === '/api/v0/models') {
      res.end(JSON.stringify({
        object: 'list',
        data: [
          { id: 'qwen3-8b', type: 'llm', state: 'loaded', max_context_length: 40960, loaded_context_length: 16384 },
          { id: 'gemma-3-4b', type: 'vlm', state: 'not-loaded', max_context_length: 131072 },
          { id: 'text-embedding-nomic', type: 'embeddings', max_context_length: 2048 },
        ],
      }));
    } else {
      res.statusCode = 404;
      res.end('{"error":"not found"}');
    }
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${(srv.address() as AddressInfo).port}`, hits, close: () => srv.close() };
}

suite('LocalPilot provider presets: LM Studio context and Bedrock', () => {
  test('LM Studio context lengths: loaded length first, then the maximum', () => {
    const m = lmStudioContexts([
      { id: 'a', loaded_context_length: 8192, max_context_length: 32768 },
      { id: 'b', max_context_length: 65536 },
      { id: 'c' },
    ]);
    assert.strictEqual(m.get('a'), 8192);
    assert.strictEqual(m.get('b'), 65536);
    assert.ok(!m.has('c'));
    assert.strictEqual(lmStudioRoot('http://localhost:1234/v1/'), 'http://localhost:1234');
    assert.ok(isLmStudio({ id: 'lmstudio-2', baseUrl: 'http://10.0.0.5:9999/v1' }));
    assert.ok(isLmStudio({ id: 'box', baseUrl: 'http://localhost:1234/v1' }));
    assert.ok(!isLmStudio({ id: 'vllm', baseUrl: 'http://localhost:8000/v1' }));
  });

  test('a server without context fields in /v1/models gets them from LM Studio\'s native API', async () => {
    const srv = await fakeServer(true);
    try {
      const p = new OpenAICompatProvider({ id: 'lms', type: 'openai', baseUrl: `${srv.url}/v1`, contextWindow: 4096 });
      const models = await p.listModels();
      const ctx = Object.fromEntries(models.map((m) => [m.modelId, m.contextWindow]));
      assert.strictEqual(ctx['qwen3-8b'], 16384);
      assert.strictEqual(ctx['gemma-3-4b'], 131072);
      // Not in the native listing: the configured fallback still applies.
      assert.strictEqual(ctx['phi-4'], 4096);
    } finally {
      srv.close();
    }
  });

  test('a server with no native API is asked once, then falls back to the configured window', async () => {
    const srv = await fakeServer(false);
    try {
      const p = new OpenAICompatProvider({ id: 'llamacpp', type: 'openai', baseUrl: `${srv.url}/v1`, contextWindow: 8192 });
      assert.ok((await p.listModels()).every((m) => m.contextWindow === 8192));
      await p.listModels();
      assert.strictEqual(srv.hits.filter((u) => u === '/api/v0/models').length, 1);
    } finally {
      srv.close();
    }
  });

  test('Bedrock preset: API-key endpoint, listed models and a region that rewrites the URL', () => {
    const pr = findPreset('bedrock');
    assert.ok(pr);
    assert.strictEqual(pr.group, 'cloud');
    assert.strictEqual(pr.env, 'AWS_BEARER_TOKEN_BEDROCK');
    assert.strictEqual(pr.cfg.baseUrl, 'https://bedrock-runtime.us-east-1.amazonaws.com/openai/v1');
    assert.ok(pr.cfg.models?.length);
    assert.strictEqual(bedrockRegion(pr.cfg.baseUrl), 'us-east-1');
    assert.strictEqual(withRegion(pr.cfg.baseUrl, 'eu-central-1'), bedrockUrl('eu-central-1'));
    assert.strictEqual(withRegion(pr.cfg.baseUrl, 'not a region'), pr.cfg.baseUrl);
    assert.strictEqual(withRegion('https://api.openai.com/v1', 'us-west-2'), 'https://api.openai.com/v1');
    assert.strictEqual(bedrockRegion('https://api.openai.com/v1'), undefined);
  });
});
