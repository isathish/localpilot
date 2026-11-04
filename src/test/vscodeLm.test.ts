import * as assert from 'assert';
import { isCloudProvider } from '../providers/cloud';
import { createProvider } from '../providers/registry';
import { sanitizeProviderConfig } from '../providers/sanitize';
import { selectLmModels, VscodeLmProvider, vscodeLmAvailable } from '../providers/vscodeLm';
import { isOwnVendor, lmIdsChangeGate, lmModelInfo, toLmTurns, VSCODE_LM_BASE_URL } from '../providers/vscodeLmMessages';

suite('VS Code language models provider (vscode-lm)', () => {
  test('maps a VS Code chat model to a cloud model with tools and no price', () => {
    const m = lmModelInfo('copilot', { id: 'gpt-4o', name: 'GPT-4o', vendor: 'copilot', family: 'gpt-4o', maxInputTokens: 64_000 });
    assert.strictEqual(m.id, 'copilot/gpt-4o');
    assert.strictEqual(m.name, 'GPT-4o (copilot)');
    assert.strictEqual(m.remote, true);
    assert.strictEqual(m.supportsTools, true);
    assert.strictEqual(m.pricing, undefined);
    assert.strictEqual(m.maxOutputTokens, 16_000);
    assert.strictEqual(m.contextWindow, 80_000);
  });

  test("LocalPilot's own vendor is never a source", () => {
    assert.ok(isOwnVendor('localpilot'));
    assert.ok(isOwnVendor(' LocalPilot '));
    assert.ok(!isOwnVendor('copilot'));
  });

  test('transcripts become user/assistant turns with system text first and tool results grouped', () => {
    const turns = toLmTurns([
      { role: 'system', content: 'Be brief.' },
      { role: 'user', content: 'list files' },
      { role: 'assistant', content: 'Looking.', toolCalls: [{ id: 'c1', name: 'list_dir', arguments: '{"path":"."}' }, { id: 'c2', name: 'read_file', arguments: 'oops' }] },
      { role: 'tool', content: 'a.ts', toolCallId: 'c1' },
      { role: 'tool', content: '', toolCallId: 'c2' },
      { role: 'user', content: 'thanks' },
    ]);
    assert.deepStrictEqual(turns.map((t) => t.role), ['user', 'assistant', 'user']);
    assert.deepStrictEqual(turns[0].parts, [{ kind: 'text', text: 'Be brief.' }, { kind: 'text', text: 'list files' }]);
    assert.deepStrictEqual(turns[1].parts[1], { kind: 'call', callId: 'c1', name: 'list_dir', input: { path: '.' } });
    assert.deepStrictEqual(turns[1].parts[2], { kind: 'call', callId: 'c2', name: 'read_file', input: { input: 'oops' } });
    assert.deepStrictEqual(turns[2].parts.map((p) => p.kind), ['result', 'result', 'text']);
    assert.deepStrictEqual(turns[2].parts[1], { kind: 'result', callId: 'c2', text: '(no output)' });
  });

  test('a system-only transcript still sends one user turn, and images are noted, not sent', () => {
    assert.deepStrictEqual(toLmTurns([{ role: 'system', content: 'S' }]), [{ role: 'user', parts: [{ kind: 'text', text: 'S' }] }]);
    const [t] = toLmTurns([{ role: 'user', content: 'see', images: ['AAAA'] }]);
    assert.match((t.parts[0] as { text: string }).text, /1 image\(s\) omitted/);
  });

  test('settings keep the type, use the placeholder URL and count as cloud', () => {
    const p = sanitizeProviderConfig({ id: 'Copilot', type: 'vscode-lm', baseUrl: '' });
    assert.deepStrictEqual([p.id, p.type, p.baseUrl], ['copilot', 'vscode-lm', VSCODE_LM_BASE_URL]);
    assert.ok(isCloudProvider(p));
    assert.ok(createProvider(p) instanceof VscodeLmProvider);
  });

  test('switching away from vscode-lm drops the placeholder URL', () => {
    assert.strictEqual(sanitizeProviderConfig({ id: 'x', type: 'openai', baseUrl: 'vscode://lm' }).baseUrl, '');
    assert.strictEqual(sanitizeProviderConfig({ id: 'x', type: 'ollama', baseUrl: VSCODE_LM_BASE_URL }).baseUrl, '');
  });

  test('model-change events rediscover only when the set of VS Code models changes', () => {
    const changed = lmIdsChangeGate();
    assert.strictEqual(changed(['copilot/gpt-4o', 'copilot/claude']), false, 'the first list only seeds the gate');
    assert.strictEqual(changed(['copilot/claude', 'copilot/gpt-4o']), false, 'same set, other order');
    assert.strictEqual(changed(['copilot/claude', 'copilot/gpt-4o']), false, 'an echo of our own refresh');
    assert.strictEqual(changed(['copilot/claude']), true);
    assert.strictEqual(changed(['copilot/claude']), false);
    assert.strictEqual(lmIdsChangeGate([])(['copilot/gpt-4o']), true, 'Copilot signing in after a seeded empty list');
  });

  test('lists and answers with a real VS Code model when one is available', async function () {
    this.timeout(60_000);
    const models = vscodeLmAvailable() ? await selectLmModels().catch(() => []) : [];
    if (!models.length) {
      this.skip();
    }
    assert.ok(models.every((m) => m.vendor !== 'localpilot'));
    const provider = new VscodeLmProvider({ id: 'vslm', type: 'vscode-lm', baseUrl: VSCODE_LM_BASE_URL });
    const listed = await provider.listModels();
    assert.ok(listed.length > 0 && listed.every((m) => m.providerId === 'vslm' && m.remote));
    assert.ok(await provider.healthCheck());
    // Sending needs the user's consent, which a test host cannot give: only check the request is attempted.
    const cts = new AbortController();
    cts.abort();
    await assert.rejects(async () => {
      for await (const _ of provider.chat({ model: listed[0].modelId, messages: [{ role: 'user', content: 'hi' }], signal: cts.signal })) {
        void _;
      }
    });
  });
});
