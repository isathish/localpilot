import * as assert from 'assert';
import * as http from 'http';
import { AddressInfo } from 'net';
import * as path from 'path';
import { questionPolicy } from '../agent/prompts';
import { thinkFor } from '../agent/thinking';
import { ollamaThink, OllamaProvider } from '../providers/ollama';
import { askUserTool, formatAnswers, parseQuestions } from '../tools/editor';
import { ToolContext } from '../types';
import { ChatController } from '../ui/chatController';

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

  test('@localpilot sessions answer approvals and questions natively instead of waiting for a card', async () => {
    const c = Object.create(ChatController.prototype) as any;
    c.sinks = new Set([{ post() {}, handlesPrompts: (s: string) => s === 'p1' }]);
    assert.strictEqual(await c.requestQuestions('p1', [{ question: 'q', options: [] }]), undefined);
    assert.strictEqual(c.promptsNative('other'), true, 'no card surface attached');
    c.sinks.add({ post() {} });
    assert.strictEqual(c.promptsNative('p1'), true);
    assert.strictEqual(c.promptsNative('other'), false);
  });

  test('rewinding a message: task refills the composer, workspace keeps the chat, both reverts files outside the repo too', async () => {
    const root = path.resolve('/repo');
    const make = (git: boolean) => {
      const user = {
        role: 'user',
        content: 'fix it\n<attachment path="src/a.ts">\nx\n</attachment>',
        images: ['aW1nMQ==', 'aW1nMg=='],
        meta: { checkpoint: 3, display: 'fix it' },
      };
      const s: any = {
        id: 's1',
        messages: [{ role: 'user', content: 'first', meta: { checkpoint: 1 } }, { role: 'assistant', content: 'ok' }, user, { role: 'assistant', content: 'done' }],
        checkpoints: git ? { history: [{ run: 3, kind: 'stash', sha: 'abc', root }] } : undefined,
      };
      const c = Object.create(ChatController.prototype) as any;
      const calls = { restoreTurn: [] as any[], dropped: [] as number[], posted: [] as any[], broadcast: [] as any[] };
      Object.assign(c, {
        compacting: new Set(),
        runs: new Map(),
        replays: new Map(),
        offers: new Map(),
        store: { get: () => s, historyBefore: async (x: any, i: number) => x.messages.slice(0, i), save() {} },
        tracker: {
          restoreTurn: async (_sid: string, turn: number, only?: (p: string) => boolean) => {
            calls.restoreTurn.push({ turn, only });
            return { restored: only ? 1 : 2, failed: 0 };
          },
          dropTurnsFrom: (_sid: string, turn: number) => calls.dropped.push(turn),
          settle: async () => undefined,
        },
        runner: { checkpoints: git ? { restoreWorkspace: async () => ({ ok: true, files: 2 }), dropFrom: async () => undefined } : undefined },
        log: { warn() {} },
        broadcast: (m: any) => calls.broadcast.push(m),
        pushChanges() {},
      });
      return { c, s, calls, sink: { post: (m: any) => calls.posted.push(m) } };
    };

    const task = make(false);
    await task.c.handle({ type: 'restoreCheckpoint', sessionId: 's1', messageIndex: 2, restoreType: 'task' }, task.sink);
    assert.strictEqual(task.s.messages.length, 2, 'the message and everything after it are removed');
    const draft = task.calls.posted.find((m) => m.type === 'draft');
    assert.deepStrictEqual(draft, { type: 'draft', text: 'fix it', images: ['aW1nMQ==', 'aW1nMg=='], attachments: ['src/a.ts'] });
    assert.strictEqual(task.calls.restoreTurn.length, 0, 'task keeps the files');

    const ws = make(false);
    const before = [...ws.s.messages];
    await ws.c.handle({ type: 'restoreCheckpoint', sessionId: 's1', messageIndex: 2, restoreType: 'workspace' }, ws.sink);
    assert.deepStrictEqual(ws.s.messages, before, 'a files-only restore keeps the chat');
    assert.ok(!ws.calls.posted.some((m) => m.type === 'draft'));
    assert.deepStrictEqual(
      ws.calls.restoreTurn.map((r) => r.turn),
      [3]
    );

    const both = make(true);
    await both.c.handle({ type: 'restoreCheckpoint', sessionId: 's1', messageIndex: 2, restoreType: 'both' }, both.sink);
    assert.strictEqual(both.s.messages.length, 2);
    const only = both.calls.restoreTurn[0]?.only as (p: string) => boolean;
    assert.ok(only, 'files outside the git root come back from the turn snapshots');
    assert.strictEqual(only(path.join(root, 'a.ts')), false);
    assert.strictEqual(only(path.resolve('/other/x.ts')), true);
    assert.deepStrictEqual(both.calls.dropped, [3]);
    assert.match(both.calls.broadcast.find((m) => m.type === 'toast')?.text ?? '', /reverted 3 files/);
  });
});
