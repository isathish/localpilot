import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as http from 'http';
import { AddressInfo } from 'net';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { addUsage } from '../agent/usage';
import { AnthropicProvider } from '../providers/anthropic';
import { usageOf } from '../providers/openaiCompat';
import { SessionStore } from '../sessions/sessionStore';
import { StreamEvent } from '../types';

const log = vscode.window.createOutputChannel('LocalPilot usage test', { log: true });

suite('session usage (tokens, cache, cost)', () => {
  test('requests add up; cached input is kept apart from uncached input; subagents get a breakdown', () => {
    let u = addUsage(undefined, { promptTokens: 1200, completionTokens: 80, cacheReadTokens: 1000, cacheWriteTokens: 100 }, 'claude-sonnet-4-5', 'claude');
    u = addUsage(u, { promptTokens: 300, completionTokens: 20, costUsd: 0.002 }, 'm', 'openrouter');
    u = addUsage(u, { promptTokens: 50, completionTokens: 5, costUsd: 0.001 }, undefined, undefined, true);
    u = addUsage(u, undefined);
    assert.strictEqual(u.promptTokens, 100 + 300 + 50);
    assert.strictEqual(u.cacheReadTokens, 1000);
    assert.strictEqual(u.cacheWriteTokens, 100);
    assert.strictEqual(u.completionTokens, 105);
    assert.strictEqual(u.requests, 4, 'a request without a usage report still counts');
    assert.ok(Math.abs((u.costUsd ?? 0) - 0.003) < 1e-12);
    assert.deepStrictEqual(u.subagentTokens, { promptTokens: 50, completionTokens: 5, requests: 1 });
    assert.strictEqual(u.model, 'm', 'a subagent request does not replace the last model');
    assert.strictEqual(u.provider, 'openrouter');
    assert.strictEqual(addUsage(undefined, { promptTokens: 10 }).costUsd, undefined, 'no cost when none was reported');
  });

  test('OpenAI-compatible usage: cached_tokens and the OpenRouter cost are read', () => {
    assert.deepStrictEqual(usageOf({ prompt_tokens: 900, completion_tokens: 40, prompt_tokens_details: { cached_tokens: 512 }, cost: 0.0042 }), {
      promptTokens: 900,
      completionTokens: 40,
      cacheReadTokens: 512,
      cacheWriteTokens: undefined,
      costUsd: 0.0042,
    });
    const plain = usageOf({ prompt_tokens: 10, completion_tokens: 2, prompt_tokens_details: null });
    assert.strictEqual(plain.cacheReadTokens, undefined);
    assert.strictEqual(plain.costUsd, undefined);
  });

  test('Anthropic reports cache reads and writes beside the whole prompt size', async () => {
    const srv = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const ev = (e: unknown) => `event: x\ndata: ${JSON.stringify(e)}\n\n`;
      res.end(
        ev({ type: 'message_start', message: { usage: { input_tokens: 20, cache_read_input_tokens: 3000, cache_creation_input_tokens: 400 } } }) +
          ev({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'hi' } }) +
          ev({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 7 } }) +
          ev({ type: 'message_stop' })
      );
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
    try {
      const p = new AnthropicProvider({ id: 'claude', type: 'anthropic', baseUrl: `http://127.0.0.1:${(srv.address() as AddressInfo).port}/v1`, apiKey: 'k' });
      const events: StreamEvent[] = [];
      for await (const e of p.chat({ model: 'claude-sonnet-4-5', messages: [{ role: 'user', content: 'hi' }] })) {
        events.push(e);
      }
      const usage = events.find((e) => e.type === 'usage');
      assert.deepStrictEqual(usage, { type: 'usage', promptTokens: 3420, completionTokens: 7, cacheReadTokens: 3000, cacheWriteTokens: 400 });
      const total = addUsage(undefined, usage?.type === 'usage' ? usage : undefined, 'claude-sonnet-4-5', 'claude');
      assert.strictEqual(total.promptTokens, 20);
      assert.strictEqual(total.cacheReadTokens, 3000);
    } finally {
      srv.close();
    }
  });

  test('the session file keeps the usage, and the list row carries the totals and the file size', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lp-usage-'));
    const store = new SessionStore({ storageUri: vscode.Uri.file(dir) } as vscode.ExtensionContext, log);
    try {
      await store.load();
      const s = store.create('m');
      s.messages.push({ role: 'user', content: 'hello' });
      s.usage = addUsage(undefined, { promptTokens: 1500, completionTokens: 30, cacheReadTokens: 1024 }, 'claude-sonnet-4-5', 'claude');
      store.save(s);
      await store.flush(s);
      const file = path.join(dir, 'sessions', `${s.id}.json`);
      const saved = JSON.parse(await fs.readFile(file, 'utf8'));
      assert.strictEqual(saved.usage.cacheReadTokens, 1024);
      assert.strictEqual(saved.usage.promptTokens, 476);
      const row = store.list().find((r) => r.id === s.id);
      assert.strictEqual(row?.usage?.requests, 1);
      assert.strictEqual(row?.bytes, (await fs.stat(file)).size);
      store.dispose();

      const reopened = new SessionStore({ storageUri: vscode.Uri.file(dir) } as vscode.ExtensionContext, log);
      await reopened.load();
      const again = reopened.list().find((r) => r.id === s.id);
      assert.strictEqual(again?.usage?.cacheReadTokens, 1024);
      assert.strictEqual(again?.bytes, (await fs.stat(file)).size);
      reopened.dispose();
    } finally {
      store.dispose();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
