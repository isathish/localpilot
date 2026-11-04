import * as assert from 'assert';
import * as http from 'http';
import { AddressInfo } from 'net';
import { parseThinkChoice, thinkFor, thinkingLevel } from '../agent/thinking';
import { sessionThinking } from '../cli/thinkingPref';
import { AnthropicProvider } from '../providers/anthropic';
import { ollamaThink } from '../providers/ollama';
import { OpenAICompatProvider } from '../providers/openaiCompat';
import { anthropicBudget, anthropicEffort, effortOf, MAX_THINKING_BUDGET, openRouterReasoning } from '../providers/thinkingParams';

/** A server that records each request body and answers `/models` and a one-line stream in the API's shape. */
async function recorder(kind: 'openai' | 'anthropic'): Promise<{ url: string; bodies: Record<string, unknown>[]; close(): void }> {
  const bodies: Record<string, unknown>[] = [];
  const srv = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      if (req.method === 'GET' && /\/models/.test(req.url ?? '')) {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(kind === 'anthropic' ? { data: [{ id: 'claude-sonnet-4-5', max_tokens: 8192 }, { id: 'claude-opus-4-6', max_tokens: 64000 }] } : { data: [{ id: 'o-model' }] }));
        return;
      }
      bodies.push(JSON.parse(raw || '{}'));
      res.setHeader('content-type', 'text/event-stream');
      if (kind === 'anthropic') {
        res.write(`data: ${JSON.stringify({ type: 'message_start', message: { usage: { input_tokens: 3 } } })}\n\n`);
        res.write(`data: ${JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'ok' } })}\n\n`);
        res.write(`data: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } })}\n\n`);
      } else {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
      }
      res.end();
    });
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${(srv.address() as AddressInfo).port}`, bodies, close: () => srv.close() };
}

async function drain(it: AsyncIterable<unknown>): Promise<void> {
  for await (const _ of it) {
    // consume
  }
}

suite('Thinking level per chat (pure)', () => {
  test('typed levels and aliases; a bare flag means medium; junk is rejected', () => {
    assert.strictEqual(parseThinkChoice(undefined), 'medium');
    assert.strictEqual(parseThinkChoice(''), 'medium');
    assert.strictEqual(parseThinkChoice('High'), 'high');
    assert.strictEqual(parseThinkChoice('none'), 'off');
    assert.strictEqual(parseThinkChoice('xhigh'), 'max');
    assert.strictEqual(parseThinkChoice('auto'), 'auto');
    assert.strictEqual(parseThinkChoice('loud'), undefined);
  });

  test("the chat's level wins over the setting; unset follows it", () => {
    assert.strictEqual(thinkingLevel({ think: 'max' }, 'auto'), 'max');
    assert.strictEqual(thinkingLevel({}, 'low'), 'low');
    assert.strictEqual(thinkFor(thinkingLevel({ think: 'off' }, 'high'), { mode: 'plan', depth: 0 }), false);
    assert.strictEqual(thinkFor(thinkingLevel({ think: 'max' }, 'off'), { mode: 'agent', depth: 0 }), 'max');
    assert.strictEqual(thinkFor(thinkingLevel({ think: 'auto' }, 'off'), { mode: 'plan', depth: 0 }), 'high');
    assert.strictEqual(thinkFor('max', 'helper'), false, 'helpers never think');
  });

  test('CLI: --thinking wins, then the session, then the remembered level', () => {
    assert.strictEqual(sessionThinking('high', 'low', 'off'), 'high');
    assert.strictEqual(sessionThinking(undefined, 'low', 'off'), 'low');
    assert.strictEqual(sessionThinking(undefined, undefined, 'off'), 'off');
    assert.strictEqual(sessionThinking(undefined, undefined, undefined), undefined);
  });

  test('per-API mapping: effort caps at high, OpenRouter object, Ollama gpt-oss', () => {
    assert.strictEqual(effortOf('max'), 'high');
    assert.strictEqual(effortOf('low'), 'low');
    assert.deepStrictEqual(openRouterReasoning('medium'), { effort: 'medium' });
    assert.deepStrictEqual(openRouterReasoning(false), { enabled: false });
    assert.strictEqual(ollamaThink('gpt-oss:20b', 'max'), 'high');
    assert.strictEqual(ollamaThink('qwen3:8b', 'max'), true);
    assert.strictEqual(anthropicEffort('max', 'claude-opus-4-6'), 'max');
    assert.strictEqual(anthropicEffort('max', 'claude-sonnet-4-6'), 'high');
  });

  test('Claude budget: a share of the maximum, at least 1024, leaving room for the answer', () => {
    assert.strictEqual(anthropicBudget('max'), MAX_THINKING_BUDGET);
    assert.ok(anthropicBudget('low') < anthropicBudget('medium') && anthropicBudget('medium') < anthropicBudget('high'));
    assert.strictEqual(anthropicBudget('max', 8192), 8192 - 4096, 'capped below the output limit');
    assert.strictEqual(anthropicBudget('high', 2000), 1024, 'never below the API minimum');
  });
});

suite('Thinking level on the wire', () => {
  test('OpenAI-compatible: reasoning_effort, with max sent as high', async () => {
    const srv = await recorder('openai');
    try {
      const p = new OpenAICompatProvider({ id: 'srv', type: 'openai', baseUrl: `${srv.url}/v1` });
      await drain(p.chat({ model: 'o-model', messages: [{ role: 'user', content: 'hi' }], think: 'max' }));
      assert.strictEqual(srv.bodies[0].reasoning_effort, 'high');
      assert.strictEqual(srv.bodies[0].reasoning, undefined);
    } finally {
      srv.close();
    }
  });

  test('OpenRouter: one `reasoning` object instead of reasoning_effort', async () => {
    const srv = await recorder('openai');
    const realFetch = globalThis.fetch;
    // The provider recognises OpenRouter by its host; requests are redirected to the local recorder.
    globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => realFetch(String(input).replace('https://openrouter.ai/api/v1', `${srv.url}/v1`), init)) as typeof fetch;
    try {
      const p = new OpenAICompatProvider({ id: 'openrouter', type: 'openai', baseUrl: 'https://openrouter.ai/api/v1', apiKey: 'k' });
      await drain(p.chat({ model: 'x/y', messages: [{ role: 'user', content: 'hi' }], think: 'low' }));
      await drain(p.chat({ model: 'x/y', messages: [{ role: 'user', content: 'hi' }], think: false }));
      assert.deepStrictEqual(srv.bodies[0].reasoning, { effort: 'low' });
      assert.strictEqual(srv.bodies[0].reasoning_effort, undefined);
      assert.deepStrictEqual(srv.bodies[1].reasoning, { enabled: false });
    } finally {
      globalThis.fetch = realFetch;
      srv.close();
    }
  });

  test("Anthropic budget models: budget_tokens from the level, within the model's output limit", async () => {
    const srv = await recorder('anthropic');
    try {
      const p = new AnthropicProvider({ id: 'claude', type: 'anthropic', baseUrl: `${srv.url}/v1`, apiKey: 'k' });
      await p.listModels();
      await drain(p.chat({ model: 'claude-sonnet-4-5', messages: [{ role: 'user', content: 'hi' }], maxTokens: 4096, think: 'max' }));
      const body = srv.bodies[0] as { thinking?: { budget_tokens?: number }; max_tokens?: number };
      assert.strictEqual(body.thinking?.budget_tokens, 4096);
      assert.strictEqual(body.max_tokens, 8192);
      await drain(p.chat({ model: 'claude-opus-4-6', messages: [{ role: 'user', content: 'hi' }], think: 'max' }));
      assert.deepStrictEqual((srv.bodies[1] as { output_config?: unknown }).output_config, { effort: 'max' });
    } finally {
      srv.close();
    }
  });
});
