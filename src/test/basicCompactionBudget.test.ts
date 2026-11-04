import * as assert from 'assert';
import { basicSummary, clipMiddle } from '../context/basicCompaction';
import { ContextManager } from '../context/contextManager';
import { estimateMessagesTokens } from '../context/tokenizer';
import { ChatMessage, LLMProvider, ModelInfo } from '../types';

const model: ModelInfo = { id: 'p/m', providerId: 'p', modelId: 'm', name: 'm', contextWindow: 8192, maxOutputTokens: 1024, supportsTools: true, supportsVision: false };
const failing = { id: 'p', type: 'ollama', async *chat() { throw new Error('server down'); } } as unknown as LLMProvider;

/** A user who pastes a large log as plain text, then a short reply. */
function pasted(i: number): ChatMessage[] {
  const log = Array.from({ length: 400 }, (_, n) => `line ${n} of log ${i}: something happened at step ${n}`).join('\n');
  return [
    { role: 'user', content: `log ${i} start\n${log}\nlog ${i} end` },
    { role: 'assistant', content: `looked at log ${i}` },
  ];
}

suite('Basic compaction stays within the window', () => {
  test('clipMiddle keeps the head and the tail', () => {
    const out = clipMiddle(`HEAD${'x'.repeat(5000)}TAIL`, 300);
    assert.ok(out.startsWith('HEAD') && out.endsWith('TAIL') && out.includes('chars omitted') && out.length <= 320, out);
    assert.strictEqual(clipMiddle('short', 300), 'short');
  });

  test('without a budget nothing is shortened; with one the oldest entries go first', () => {
    const msgs = [1, 2, 3, 4, 5, 6].flatMap(pasted);
    assert.ok(basicSummary(msgs).includes('step 399'));
    const out = basicSummary(msgs, 3, 1000);
    assert.ok(out.length <= 1000, String(out.length));
    assert.ok(/earlier entr(y|ies) omitted/.test(out));
    assert.ok(out.includes('log 6 end'), 'the newest user message keeps its tail');
  });

  for (const strategy of ['basic', 'agentic'] as const) {
    test(`${strategy}: user messages larger than the window together still compact to something that fits, again and again`, async () => {
      const cm = new ContextManager({ compactionThreshold: 0.5, maxToolOutputChars: 1000, keepRecent: 2, strategy });
      let history: ChatMessage[] = [1, 2, 3, 4, 5, 6].flatMap(pasted);
      assert.ok(estimateMessagesTokens(history) > model.contextWindow);
      for (let round = 0; round < 4; round++) {
        history.push({ role: 'user', content: `small question ${round}` }, { role: 'assistant', content: `small answer ${round}` });
        const res = await cm.compact(history, failing, model);
        assert.ok(res.removed > 0);
        assert.ok(res.after < model.contextWindow / 2, `round ${round}: ${res.after} tokens`);
        assert.ok(!/## Earlier summary[\s\S]*## Earlier summary/.test(res.summary), 'earlier digests are flattened, not nested');
        history = [...res.messages, ...[7, 8, 9].map((i) => pasted(i + round * 10)).flat()];
      }
    });
  }
});
