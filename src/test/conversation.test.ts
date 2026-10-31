import * as assert from 'assert';
import * as http from 'http';
import { AddressInfo } from 'net';
import { questionPolicy } from '../agent/prompts';
import { thinkFor } from '../agent/thinking';
import { ollamaThink, OllamaProvider } from '../providers/ollama';
import { askUserTool, formatAnswers, parseQuestions } from '../tools/editor';
import { ToolContext } from '../types';

suite('Conversation: questions before work and thinking per task', () => {
  test('auto thinking: deep for Plan/Debug, medium for the agent, light for Ask and subagents, none for helpers', () => {
    assert.strictEqual(thinkFor('auto', { mode: 'plan', depth: 0 }), 'high');
    assert.strictEqual(thinkFor('auto', { mode: 'debug', depth: 0 }), 'high');
    assert.strictEqual(thinkFor('auto', { mode: 'agent', depth: 0 }), 'medium');
    assert.strictEqual(thinkFor('auto', { mode: 'multitask', depth: 0 }), 'medium');
    assert.strictEqual(thinkFor('auto', { mode: 'ask', depth: 0 }), 'low');
    assert.strictEqual(thinkFor('auto', { mode: 'agent', depth: 1 }), 'low');
    assert.strictEqual(thinkFor('auto', 'helper'), false);
    assert.strictEqual(thinkFor('off', { mode: 'plan', depth: 0 }), false, 'off is sent as false, not left to the model default');
    assert.strictEqual(thinkFor('on', { mode: 'ask', depth: 0 }), true);
    assert.strictEqual(thinkFor('high', { mode: 'agent', depth: 2 }), 'high');
    assert.strictEqual(thinkFor('high', 'helper'), false, 'helpers never think');
    // Ollama takes effort levels from gpt-oss only; elsewhere a level becomes on/off.
    assert.strictEqual(ollamaThink('gpt-oss:20b', 'low'), 'low');
    assert.strictEqual(ollamaThink('gemma4:12b', 'high'), true);
    assert.strictEqual(ollamaThink('qwen3.8:27b', 'medium'), true);
    assert.strictEqual(ollamaThink('qwen3.8:27b', 'low'), false);
    assert.strictEqual(ollamaThink('qwen3.8:27b', false), false);
  });

  test('ask_user reads several explained questions, and the older single-question form', () => {
    const qs = parseQuestions({
      questions: [
        { header: 'Storage', question: 'Where?', options: [{ label: 'SQLite', description: 'one file' }, { label: 'JSON' }], recommended: 'SQLite' },
        { question: 'Extras?', options: ['Stats', 'Export'], multiSelect: true, recommended: 'not an option' },
        { question: '' },
      ],
    });
    assert.strictEqual(qs.length, 2, 'empty questions are dropped');
    assert.deepStrictEqual(qs[0], { header: 'Storage', question: 'Where?', options: [{ label: 'SQLite', description: 'one file' }, { label: 'JSON', description: undefined }], multiSelect: false, recommended: 'SQLite' });
    assert.deepStrictEqual(qs[1].options.map((o) => o.label), ['Stats', 'Export']);
    assert.strictEqual(qs[1].multiSelect, true);
    assert.strictEqual(qs[1].recommended, undefined, 'a recommendation must be one of the options');
    const legacy = parseQuestions({ question: 'Which file?', options: ['a.ts', 'b.ts'], recommended: 'a.ts' });
    assert.strictEqual(legacy.length, 1);
    assert.strictEqual(legacy[0].recommended, 'a.ts');
    assert.strictEqual(parseQuestions({ questions: Array.from({ length: 6 }, (_, i) => ({ question: `q${i}?`, options: [] })) }).length, 4, 'at most 4 per call');

    const text = formatAnswers([{ question: 'Where?', selected: ['SQLite'] }, { question: 'Extras?', selected: ['Stats', 'Export'], other: 'also a chart' }]);
    assert.ok(text.includes('Where?\n  → SQLite'));
    assert.ok(text.includes('Stats; Export; (in their words) also a chart'));
  });

  test('ask_user uses the chat card when there is one; a skip means "go with your recommendations"', async () => {
    const ctx = (askUser: ToolContext['askUser']) => ({ sessionId: 's', signal: new AbortController().signal, depth: 0, requestApproval: async () => true, progress: () => undefined, trackChange: async () => undefined, askUser }) as ToolContext;
    const args = { questions: [{ question: 'Where?', options: [{ label: 'SQLite' }, { label: 'JSON' }], recommended: 'SQLite' }] };
    const shown: unknown[] = [];
    const answered = await askUserTool.execute(args, ctx(async (q) => (shown.push(q), [{ question: 'Where?', selected: ['JSON'] }])));
    assert.strictEqual(shown.length, 1);
    assert.ok(answered.content.includes('→ JSON'));
    const skipped = await askUserTool.execute(args, ctx(async () => null));
    assert.ok(/skipped/.test(skipped.content) && skipped.content.includes('"SQLite"'), skipped.content);
  });

  test('question policy: smart asks for open-ended work only, interview confirms a plan, minimal and Ask mode stay quiet', () => {
    const smart = questionPolicy('smart', 'agent');
    assert.ok(/new feature/.test(smart) && /ONCE/.test(smart) && /recommended/.test(smart) && /need no questions/.test(smart));
    assert.ok(/Go ahead/.test(questionPolicy('interview', 'agent')));
    assert.ok(/only when two plausible readings/.test(questionPolicy('minimal', 'agent')));
    assert.ok(/only when two plausible readings/.test(questionPolicy('smart', 'ask')), 'Ask mode answers, it does not interview');
  });

  test('a model that cannot think is retried without `think` once, then never sent it again', async () => {
    const bodies: Record<string, unknown>[] = [];
    const srv = http.createServer((req, res) => {
      let body = '';
      req.on('data', (d) => (body += d));
      req.on('end', () => {
        const b = JSON.parse(body || '{}') as Record<string, unknown>;
        bodies.push(b);
        if ('think' in b) {
          res.statusCode = 400;
          res.end(JSON.stringify({ error: '"plain:7b" does not support thinking' }));
          return;
        }
        res.setHeader('content-type', 'application/x-ndjson');
        res.end(`${JSON.stringify({ message: { role: 'assistant', content: 'hi' }, done: true, done_reason: 'stop' })}\n`);
      });
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
    try {
      const p = new OllamaProvider({ id: 'o', type: 'ollama', baseUrl: `http://127.0.0.1:${(srv.address() as AddressInfo).port}` });
      const run = async () => {
        let text = '';
        for await (const ev of p.chat({ model: 'plain:7b', messages: [{ role: 'user', content: 'x' }], think: 'medium' })) {
          text += ev.type === 'text' ? ev.text : '';
        }
        return text;
      };
      assert.strictEqual(await run(), 'hi');
      assert.deepStrictEqual(bodies.map((b) => 'think' in b), [true, false]);
      assert.strictEqual(await run(), 'hi');
      assert.deepStrictEqual(bodies.map((b) => 'think' in b), [true, false, false], 'remembered: no failed request the second time');
    } finally {
      srv.close();
    }
  });
});
