import * as assert from 'assert';
import { ContextManager, effectiveContextWindow, MIN_CONTEXT_WINDOW } from '../context/contextManager';
import { estimateMessagesTokens, estimateMessageTokens, estimateTokens, estimateToolsTokens } from '../context/tokenizer';
import { ChatMessage, LLMProvider, ModelInfo, StreamEvent } from '../types';

const model: ModelInfo = { id: 'p/m', providerId: 'p', modelId: 'm', name: 'm', contextWindow: 8192, maxOutputTokens: 1024, supportsTools: true, supportsVision: false };

/** Provider whose chat() yields a fixed summary (or throws), recording every request. */
function fakeProvider(reply: string | Error): LLMProvider & { calls: number; lastMessages: ChatMessage[] } {
  const p = {
    id: 'p',
    type: 'ollama' as const,
    displayName: 'fake',
    baseUrl: 'http://localhost',
    calls: 0,
    lastMessages: [] as ChatMessage[],
    listModels: async () => [model],
    complete: async () => '',
    healthCheck: async () => true,
    async *chat(opts: { messages: ChatMessage[] }): AsyncIterable<StreamEvent> {
      p.calls++;
      p.lastMessages = opts.messages;
      if (reply instanceof Error) {
        throw reply;
      }
      yield { type: 'text', text: reply };
      yield { type: 'done' };
    },
  };
  return p;
}

function turn(i: number, toolChars = 0): ChatMessage[] {
  const out: ChatMessage[] = [
    { role: 'user', content: `request ${i}: please look at file${i}.ts` },
    { role: 'assistant', content: '', toolCalls: [{ id: `c${i}`, name: 'read_file', arguments: JSON.stringify({ path: `file${i}.ts` }) }] },
    { role: 'tool', toolCallId: `c${i}`, toolName: 'read_file', content: `line one of file${i}\n${'x'.repeat(toolChars)}` },
    { role: 'assistant', content: `done with ${i}` },
  ];
  return out;
}

suite('Tokenizer estimates', () => {
  test('estimateTokens is monotonic, zero for empty text and heavier for symbol-dense code', () => {
    assert.strictEqual(estimateTokens(''), 0);
    const prose = 'the quick brown fox jumps over the lazy dog and keeps on running through the field';
    const code = 'const f = (a, b) => { return [a, b].map((x) => x * 2); };'.padEnd(prose.length, ' ');
    assert.ok(estimateTokens(prose) > 0);
    assert.ok(estimateTokens(prose + prose) > estimateTokens(prose), 'longer text costs more');
    assert.ok(estimateTokens(code) > estimateTokens(prose), 'same length, more symbols → more tokens');
    // Roughly 3–4 chars per token for English prose; the heuristic errs high but not wildly.
    const n = estimateTokens(prose);
    assert.ok(n >= prose.length / 5 && n <= prose.length / 2, `prose estimate ${n} for ${prose.length} chars is out of range`);
  });

  test('message estimates add overhead for tool calls and images and are memoised per object', () => {
    const plain: ChatMessage = { role: 'user', content: 'hello world' };
    const withCall: ChatMessage = { role: 'assistant', content: 'hello world', toolCalls: [{ id: '1', name: 'read_file', arguments: '{"path":"a.ts"}' }] };
    const withImage: ChatMessage = { role: 'user', content: 'hello world', images: ['AAAA'] };
    assert.ok(estimateMessageTokens(withCall) > estimateMessageTokens(plain));
    assert.ok(estimateMessageTokens(withImage) >= estimateMessageTokens(plain) + 768, 'an image costs a fixed block of tokens');
    const first = estimateMessageTokens(plain);
    assert.strictEqual(estimateMessageTokens(plain), first, 'cached');
    plain.content = 'a much longer message than before, which must invalidate the cached count';
    assert.ok(estimateMessageTokens(plain) > first, 'content change invalidates the memo');
    assert.strictEqual(estimateMessagesTokens([plain, withCall]), estimateMessageTokens(plain) + estimateMessageTokens(withCall));
  });

  test('tool schemas are counted from their JSON', () => {
    const small = [{ name: 'a', description: 'x', parameters: { type: 'object' as const, properties: {} } }];
    const big = [{ name: 'a', description: 'x'.repeat(2000), parameters: { type: 'object' as const, properties: { p: { type: 'string', description: 'y'.repeat(500) } } } }];
    assert.strictEqual(estimateToolsTokens([]), 0);
    assert.ok(estimateToolsTokens(big) > estimateToolsTokens(small) * 10);
  });
});

suite('effectiveContextWindow', () => {
  test('0 or invalid requests use the native window, otherwise the request is clamped to it', () => {
    assert.strictEqual(effectiveContextWindow({ contextWindow: 32768 }, 0), 32768);
    assert.strictEqual(effectiveContextWindow({ contextWindow: 32768 }, -5), 32768);
    assert.strictEqual(effectiveContextWindow({ contextWindow: 32768 }, NaN), 32768);
    assert.strictEqual(effectiveContextWindow({ contextWindow: 32768 }, 16000), 16000);
    assert.strictEqual(effectiveContextWindow({ contextWindow: 8192 }, 128000), 8192, 'never above the native window');
    assert.strictEqual(effectiveContextWindow({ contextWindow: 8192 }, 1000), MIN_CONTEXT_WINDOW, 'never below the floor');
    assert.strictEqual(effectiveContextWindow({ contextWindow: 2048 }, 0), MIN_CONTEXT_WINDOW, 'a tiny native window is raised to the floor');
    assert.strictEqual(effectiveContextWindow({ contextWindow: 0 }, 0), 32768, 'unknown native window defaults to 32k');
  });
});

suite('ContextManager', () => {
  test('budget reserves output, counts system/tools/history and flags compaction at the threshold', () => {
    const cm = new ContextManager({ compactionThreshold: 0.8, maxToolOutputChars: 1000 });
    const history = turn(1);
    const b = cm.budget(model, 'system prompt', [], history, 4000);
    assert.strictEqual(b.contextWindow, 8192);
    assert.strictEqual(b.reservedForOutput, 2048, 'output reservation is capped at a quarter of the window');
    assert.strictEqual(b.historyTokens, estimateMessagesTokens(history));
    assert.strictEqual(b.available, 8192 - 2048 - b.systemTokens - b.toolsTokens - b.historyTokens);
    assert.ok(b.usageRatio < 0.8 && !cm.needsCompaction(b));
    const huge = cm.budget(model, 'x'.repeat(30000), [], history, 1024);
    assert.ok(huge.usageRatio > 1 && cm.needsCompaction(huge));
  });

  test('clampToolOutput keeps head and tail and says how much was cut', () => {
    const cm = new ContextManager({ compactionThreshold: 0.8, maxToolOutputChars: 100 });
    assert.strictEqual(cm.clampToolOutput('short'), 'short');
    const long = `${'H'.repeat(500)}${'T'.repeat(500)}`;
    const out = cm.clampToolOutput(long);
    assert.ok(out.startsWith('H'.repeat(70)), 'head is 70% of the budget');
    assert.ok(out.endsWith('T'.repeat(30)), 'tail is the remaining 30%');
    assert.ok(/900 characters omitted/.test(out), out);
  });

  test('pruneToolOutputs collapses only old, large tool results and leaves the recent window alone', () => {
    const cm = new ContextManager({ compactionThreshold: 0.8, maxToolOutputChars: 1000, keepRecent: 4 });
    const history = [...turn(1, 2000), ...turn(2, 100), ...turn(3, 2000)];
    const { messages, saved } = cm.pruneToolOutputs(history);
    assert.ok(saved > 0);
    assert.strictEqual(messages.length, history.length, 'pruning never drops messages');
    const oldBig = messages[2];
    assert.ok(oldBig.meta?.pruned && /pruned to save context/.test(oldBig.content) && /line one of file1/.test(oldBig.content), 'old big output → stub with its first line');
    assert.strictEqual(messages[6].meta?.pruned, undefined, 'small outputs (<400 chars) are kept verbatim');
    assert.strictEqual(messages[10].content, history[10].content, 'the recent window is untouched');
    assert.strictEqual(cm.pruneToolOutputs(messages).saved, 0, 'idempotent');
  });

  test('compact summarises the older part at a user-message boundary and keeps the recent turns verbatim', async () => {
    const cm = new ContextManager({ compactionThreshold: 0.8, maxToolOutputChars: 1000, keepRecent: 4 });
    const provider = fakeProvider('## Task & goals\n- did things');
    const history = [...turn(1), ...turn(2), ...turn(3)];
    const r = await cm.compact(history, provider, model);
    assert.strictEqual(provider.calls, 1);
    assert.strictEqual(r.removed, 8, 'two older turns of four messages summarised');
    assert.strictEqual(r.messages.length, 5);
    assert.ok(r.messages[0].meta?.summary && /<conversation_summary>/.test(r.messages[0].content) && /did things/.test(r.messages[0].content));
    assert.strictEqual(r.messages[1].role, 'user', 'the split lands on a user message so no tool call loses its result');
    assert.deepStrictEqual(r.messages.slice(1), history.slice(8));
    assert.ok(r.after < r.before);
    assert.ok(/USER: request 1/.test(provider.lastMessages[1].content) && !/request 3/.test(provider.lastMessages[1].content), 'only the older part is sent to the summariser');
  });

  test('compact is a no-op for short histories and when everything older is already a summary', async () => {
    const cm = new ContextManager({ compactionThreshold: 0.8, maxToolOutputChars: 1000, keepRecent: 4 });
    const provider = fakeProvider('summary');
    const short = turn(1);
    const r = await cm.compact(short, provider, model);
    assert.strictEqual(r.removed, 0);
    assert.strictEqual(provider.calls, 0);
    const summaryOnly: ChatMessage[] = [{ role: 'user', content: 'old summary', meta: { summary: true } }, ...turn(2), ...turn(3)];
    const r2 = await cm.compact(summaryOnly, provider, model, undefined, 8);
    assert.strictEqual(r2.removed, 0, 'nothing new to summarise');
    assert.strictEqual(provider.calls, 0);
  });

  test('compact folds a prior summary into the next one and falls back to a truncation note when the model fails', async () => {
    const cm = new ContextManager({ compactionThreshold: 0.8, maxToolOutputChars: 1000, keepRecent: 4 });
    const provider = fakeProvider('second summary');
    const history: ChatMessage[] = [{ role: 'user', content: 'FIRST SUMMARY', meta: { summary: true } }, ...turn(1), ...turn(2), ...turn(3)];
    const r = await cm.compact(history, provider, model);
    assert.ok(r.removed > 0);
    assert.ok(/Previous summary:\nFIRST SUMMARY/.test(provider.lastMessages[1].content), 'earlier summary is handed to the summariser');
    assert.strictEqual(r.messages.filter((m) => m.meta?.summary).length, 1, 'summaries collapse into one message');

    const broken = fakeProvider(new Error('server down'));
    const r2 = await cm.compact([...turn(1), ...turn(2), ...turn(3)], broken, model);
    assert.ok(r2.removed > 0, 'still shrinks the history');
    assert.ok(/truncated because the context window filled up/.test(r2.summary), r2.summary);
  });

  test('fit returns the history untouched below the threshold and prunes before it summarises', async () => {
    const cm = new ContextManager({ compactionThreshold: 0.8, maxToolOutputChars: 1000, keepRecent: 4 });
    const provider = fakeProvider('summary');
    const small = turn(1);
    const budgetOf = (h: ChatMessage[]) => cm.budget(model, 'sys', [], h, 1024);
    const r = await cm.fit(small, provider, model, budgetOf);
    assert.strictEqual(r.messages, small);
    assert.strictEqual(r.compactions.length, 0);
    assert.strictEqual(provider.calls, 0);

    // Old tool outputs large enough to blow the budget on their own: pruning must be enough, no model call.
    const bloated = [...turn(1, 20000), ...turn(2, 20000), ...turn(3)];
    let compacting = 0;
    const r2 = await cm.fit(bloated, provider, model, budgetOf, undefined, () => compacting++);
    assert.ok(!cm.needsCompaction(r2.budget), `still over budget: ${r2.budget.usageRatio}`);
    assert.strictEqual(provider.calls, 0, 'pruning alone solved it');
    assert.strictEqual(compacting, 0, 'onCompacting fires only before a model call');
    assert.strictEqual(r2.messages.length, bloated.length);
  });

  test('fit summarises when pruning is not enough and tightens the recent window on a tiny context', async () => {
    const cm = new ContextManager({ compactionThreshold: 0.8, maxToolOutputChars: 1000, keepRecent: 8 });
    const provider = fakeProvider('summary');
    const tiny: ModelInfo = { ...model, contextWindow: MIN_CONTEXT_WINDOW };
    // Lots of prose (not tool output) so pruning cannot help; recent turns are big too so one pass is not enough.
    const history: ChatMessage[] = [];
    for (let i = 0; i < 8; i++) {
      history.push({ role: 'user', content: `question ${i} ${'words '.repeat(400)}` }, { role: 'assistant', content: `answer ${i} ${'reply '.repeat(400)}` });
    }
    const budgetOf = (h: ChatMessage[]) => cm.budget(tiny, 'sys', [], h, 512);
    let compacting = 0;
    const r = await cm.fit(history, provider, model, budgetOf, undefined, () => compacting++);
    assert.ok(r.compactions.length >= 1, 'at least one summarisation pass');
    assert.strictEqual(compacting, 1, 'onCompacting fires once however many passes run');
    assert.ok(r.messages.length < history.length);
    assert.ok(r.messages[0].meta?.summary);
    assert.ok(r.budget.usageRatio < budgetOf(history).usageRatio, 'the result is smaller than the input');
    assert.ok(r.compactions.length <= 3, 'bounded number of passes');
  });

  test('fit stops on abort signals handed to the summariser', async () => {
    const cm = new ContextManager({ compactionThreshold: 0.8, maxToolOutputChars: 1000, keepRecent: 4 });
    const abort = new AbortController();
    const p = fakeProvider('summary');
    const orig = p.chat.bind(p);
    p.chat = (opts) => {
      assert.strictEqual(opts.signal, abort.signal, 'the caller\'s signal reaches the provider');
      return orig(opts);
    };
    const history: ChatMessage[] = [];
    for (let i = 0; i < 6; i++) {
      history.push({ role: 'user', content: `q${i} ${'w '.repeat(600)}` }, { role: 'assistant', content: `a${i} ${'r '.repeat(600)}` });
    }
    const budgetOf = (h: ChatMessage[]) => cm.budget({ ...model, contextWindow: MIN_CONTEXT_WINDOW }, 'sys', [], h, 512);
    await cm.fit(history, p, model, budgetOf, abort.signal);
    assert.ok(p.calls >= 1);
  });
});
