import * as assert from 'assert';
import * as http from 'http';
import { AddressInfo } from 'net';
import * as path from 'path';
import { MessageQueue } from '../agent/messageQueue';
import { questionPolicy } from '../agent/prompts';
import { RunControl } from '../agent/runControl';
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

suite('Conversation: queued and steering messages', () => {
  /** A ChatController whose turns are fake runs held open until `release()`; each turn reads pending steers at its next step. */
  const harness = () => {
    const sid = 's1';
    const session: any = { id: sid, messages: [] };
    let alive = true;
    const turns: string[] = [];
    const received: string[] = [];
    const posted: any[] = [];
    const gates: (() => void)[] = [];
    const c = Object.create(ChatController.prototype) as any;
    Object.assign(c, {
      runs: new Map(),
      starting: new Set(),
      compacting: new Map(),
      replays: new Map(),
      steerDrafts: new Map(),
      afterTurn: new MessageQueue(),
      stoppedByUser: new Set(),
      approvals: new Map(),
      questions: new Map(),
      runStatus: new Map(),
      pushState: new Map(),
      activeSessionId: 'other',
      _onDidChangeRuns: { fire() {} },
      store: { get: (id: string) => (alive && id === sid ? session : undefined), delete: async () => void (alive = false), list: () => [] },
      tracker: { forget() {} },
      runner: {},
      sessionRoot: () => '/repo',
      // Deleting takes a moment (hooks, worktree); the stopped run finishes in between.
      dropWorktree: () => new Promise((r) => setTimeout(r, 20)),
      correctNames: async (_s: string, text: string) => ({ text, fixes: [] }),
      readAttachments: async () => [],
      broadcast: (m: any) => posted.push(m),
      async startRun(this: any, _s: unknown, id: string, text: string) {
        const control = new RunControl(id);
        this.runs.set(id, control);
        turns.push(text);
        await new Promise<void>((r) => {
          gates.push(r);
          control.signal.addEventListener('abort', () => r());
        });
        if (!control.aborted) {
          received.push(...control.takeSteering().map((m) => m.content));
        }
        this.runs.delete(id);
        this.deliverLeftovers(id, control);
        return 'done';
      },
    });
    const until = async (cond: () => boolean, what: string) => {
      for (let i = 0; i < 200 && !cond(); i++) {
        await new Promise((r) => setTimeout(r, 5));
      }
      assert.ok(cond(), `timed out waiting for ${what}`);
    };
    const release = async (n: number) => {
      await until(() => gates.length >= n, `turn ${n}`);
      gates[n - 1]();
    };
    const settle = () => new Promise((r) => setTimeout(r, 60));
    return { c, sid, turns, received, posted, until, release, settle };
  };

  test('messages sent after the turn each run exactly once, in order', async () => {
    const h = harness();
    void h.c.handle({ type: 'send', sessionId: h.sid, text: 'first' });
    await h.until(() => h.c.runs.has(h.sid), 'the first run');
    await h.c.handle({ type: 'queueAfterTurn', sessionId: h.sid, text: 'second' });
    await h.c.handle({ type: 'queueAfterTurn', sessionId: h.sid, text: 'third' });
    assert.deepStrictEqual(h.posted.filter((m) => m.type === 'queue').pop().items.map((r: any) => r.text), ['second', 'third']);
    await h.release(1);
    await h.release(2);
    await h.release(3);
    await h.settle();
    assert.deepStrictEqual(h.turns, ['first', 'second', 'third']);
    assert.strictEqual(h.c.afterTurn.list(h.sid).length, 0);
    assert.ok(!h.c.runs.has(h.sid));
  });

  test('a queued message still runs once when the turn ahead of it is stopped', async () => {
    const h = harness();
    void h.c.handle({ type: 'send', sessionId: h.sid, text: 'first' });
    await h.until(() => h.c.runs.has(h.sid), 'the first run');
    await h.c.handle({ type: 'queueAfterTurn', sessionId: h.sid, text: 'next' });
    h.c.stop(h.sid);
    await h.release(2);
    await h.settle();
    assert.deepStrictEqual(h.turns, ['first', 'next']);
  });

  test('a cancelled steer never reaches the model and leaves the banner', async () => {
    const h = harness();
    void h.c.handle({ type: 'send', sessionId: h.sid, text: 'first' });
    await h.until(() => h.c.runs.has(h.sid), 'the first run');
    await h.c.handle({ type: 'send', sessionId: h.sid, text: 'use tabs' });
    await h.c.handle({ type: 'send', sessionId: h.sid, text: 'keep it short' });
    const ids = h.posted.filter((m) => m.type === 'steerQueued').map((m) => m.id);
    assert.strictEqual(ids.length, 2);
    await h.c.handle({ type: 'cancelQueued', sessionId: h.sid, id: ids[0] });
    const q = h.posted.filter((m) => m.type === 'queue').pop();
    assert.deepStrictEqual(q.removed, [ids[0]]);
    assert.deepStrictEqual(q.items.map((r: any) => r.text), ['keep it short']);
    assert.ok(!h.posted.some((m) => m.type === 'draft'), 'no edit asked: nothing goes back to the composer');
    await h.release(1);
    await h.settle();
    assert.deepStrictEqual(h.received, ['keep it short']);
    assert.deepStrictEqual(h.turns, ['first']);
  });

  test('editing a queued message brings back its text, attachments and images, merged into the composer', async () => {
    const h = harness();
    void h.c.handle({ type: 'send', sessionId: h.sid, text: 'first' });
    await h.until(() => h.c.runs.has(h.sid), 'the first run');
    await h.c.handle({ type: 'queueAfterTurn', sessionId: h.sid, text: 'later', attachments: ['src/a.ts'], images: ['aW1n'] });
    const id = h.posted.filter((m) => m.type === 'queue').pop().items[0].id;
    await h.c.handle({ type: 'cancelQueued', sessionId: h.sid, id, edit: true });
    assert.deepStrictEqual(h.posted.find((m) => m.type === 'draft'), { type: 'draft', text: 'later', images: ['aW1n'], attachments: ['src/a.ts'], merge: true });
    assert.strictEqual(h.c.afterTurn.list(h.sid).length, 0);
    await h.release(1);
    await h.settle();
    assert.deepStrictEqual(h.turns, ['first'], 'the edited message is not sent');
  });

  test('deleting a running chat drops its queue instead of starting the next turn', async () => {
    const h = harness();
    void h.c.handle({ type: 'send', sessionId: h.sid, text: 'first' });
    await h.until(() => h.c.runs.has(h.sid), 'the first run');
    await h.c.handle({ type: 'queueAfterTurn', sessionId: h.sid, text: 'next' });
    await h.c.handle({ type: 'deleteSession', id: h.sid });
    await h.settle();
    assert.deepStrictEqual(h.turns, ['first']);
  });
});
