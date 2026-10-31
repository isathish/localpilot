import * as assert from 'assert';
import * as http from 'http';
import { AddressInfo } from 'net';
import * as vscode from 'vscode';
import { withTurnContext } from '../agent/agentLoop';
import { cleanImprovedPrompt } from '../ui/chatController';
import { ModelManager } from '../providers/modelManager';
import { OllamaProvider } from '../providers/ollama';
import { ChatMessage } from '../types';

suite('LocalPilot prompt cache and model residency', () => {
  test('turn context rides on the current user message; earlier turns and the system prompt stay byte-identical', () => {
    const first: ChatMessage = { role: 'user', content: 'explain foo', meta: { timestamp: 1 } };
    const reply: ChatMessage = { role: 'assistant', content: 'foo does x', meta: { timestamp: 2 } };
    const second: ChatMessage = { role: 'user', content: 'now fix it', meta: { timestamp: 3 } };

    const turn1 = withTurnContext('SYSTEM', [first], first, '<turn-context>cursor at line 10</turn-context>');
    const turn2 = withTurnContext('SYSTEM', [first, reply, second], second, '<turn-context>cursor at line 42</turn-context>');

    assert.strictEqual(turn2[0].content, 'SYSTEM', 'system prompt carries no per-turn data');
    assert.strictEqual(turn2[1].content, 'explain foo', 'earlier turns are sent as stored');
    assert.ok(turn2[3].content.startsWith('<turn-context>cursor at line 42'));
    assert.ok(turn2[3].content.endsWith('now fix it'));
    assert.ok(turn1[1].content.includes('line 10'));
    assert.ok(turn2.every((m) => !('meta' in m)), 'meta is stripped');
    assert.strictEqual(second.content, 'now fix it', 'the stored message is not modified');

    // Compaction folded the turn's message into a summary: the context still reaches the model.
    const compacted = withTurnContext('SYSTEM', [reply], second, '<turn-context>x</turn-context>');
    assert.ok(compacted[0].content.endsWith('<turn-context>x</turn-context>'));
    assert.deepStrictEqual(withTurnContext('SYSTEM', [first], first, '')[1], { role: 'user', content: 'explain foo' });
  });

  test('completions send num_ctx so a model loaded for chat is not reloaded', async () => {
    const bodies: Record<string, unknown>[] = [];
    const srv = http.createServer((req, res) => {
      let body = '';
      req.on('data', (d) => (body += d));
      req.on('end', () => {
        bodies.push(JSON.parse(body || '{}'));
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ response: 'x' }));
      });
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
    try {
      const p = new OllamaProvider({ id: 'o', type: 'ollama', baseUrl: `http://127.0.0.1:${(srv.address() as AddressInfo).port}`, contextWindow: 8192 });
      await p.complete({ model: 'm', prompt: 'a', contextWindow: 16384 });
      await p.complete({ model: 'm', prompt: 'a' });
      assert.strictEqual((bodies[0].options as { num_ctx?: number }).num_ctx, 16384);
      assert.strictEqual((bodies[1].options as { num_ctx?: number }).num_ctx, 8192, 'falls back to the provider default');
    } finally {
      srv.close();
    }
  });

  test('a LocalPilot-started Ollama gets the configured flash attention and KV cache type', async () => {
    const cfg = vscode.workspace.getConfiguration('localpilot');
    const prev = { fa: cfg.inspect('ollama.flashAttention')?.globalValue, kv: cfg.inspect('ollama.kvCacheType')?.globalValue };
    try {
      assert.deepStrictEqual({ fa: ModelManager.ollamaServerEnv().OLLAMA_FLASH_ATTENTION, kv: ModelManager.ollamaServerEnv().OLLAMA_KV_CACHE_TYPE }, { fa: '1', kv: 'q8_0' }, 'defaults');
      await cfg.update('ollama.kvCacheType', 'q4_0', vscode.ConfigurationTarget.Global);
      assert.strictEqual(ModelManager.ollamaServerEnv().OLLAMA_KV_CACHE_TYPE, 'q4_0');
      // Ollama only quantises the cache with flash attention on: without it the type is not sent at all.
      await cfg.update('ollama.flashAttention', false, vscode.ConfigurationTarget.Global);
      const env = ModelManager.ollamaServerEnv();
      assert.strictEqual(env.OLLAMA_FLASH_ATTENTION, '0');
      assert.ok(!('OLLAMA_KV_CACHE_TYPE' in env));
    } finally {
      await cfg.update('ollama.flashAttention', prev.fa, vscode.ConfigurationTarget.Global);
      await cfg.update('ollama.kvCacheType', prev.kv, vscode.ConfigurationTarget.Global);
    }
  });

  test('an improved prompt is unwrapped from the labels, quotes and fences small models add', () => {
    assert.strictEqual(cleanImprovedPrompt('Rewritten request: Fix `roll_dice` in src/dice.py.'), 'Fix `roll_dice` in src/dice.py.');
    assert.strictEqual(cleanImprovedPrompt('```\nWrite tests for roll_dice.\n```'), 'Write tests for roll_dice.');
    assert.strictEqual(cleanImprovedPrompt('"Why does roll_dice crash on 3d6+2?"'), 'Why does roll_dice crash on 3d6+2?');
    assert.strictEqual(cleanImprovedPrompt('<request>\nAdd input validation.\n</request>'), 'Add input validation.');
    assert.strictEqual(cleanImprovedPrompt('Use "d6" and "2d10" as examples.'), 'Use "d6" and "2d10" as examples.', 'inner quotes are kept');
  });
});
