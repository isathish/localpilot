import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { PLAN_FILE, planToSave, saveImplementationPlan } from '../agent/deepPlanning';
import { ChatController } from '../ui/chatController';

suite('/deep-planning plan file and /newtask hand-off', () => {
  test('only a completed, error-free, unstopped turn is a plan', () => {
    assert.strictEqual(planToSave({ text: '  # Plan\n', completed: true }), '# Plan');
    assert.strictEqual(planToSave({ text: 'Blocked by a hook', completed: undefined }), undefined, 'hook-blocked prompt');
    assert.strictEqual(planToSave({ text: 'Stopped after 40 model steps…', completed: false }), undefined, 'step limit');
    assert.strictEqual(planToSave({ text: 'server down', completed: false, errored: true }), undefined, 'error');
    assert.strictEqual(planToSave({ text: 'half a plan', completed: true, aborted: true }), undefined, 'stopped by the user');
    assert.strictEqual(planToSave({ text: '   ', completed: true }), undefined, 'empty answer');
  });

  test('an incomplete or errored turn leaves an existing implementation_plan.md unchanged', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lp-plan-'));
    try {
      const file = path.join(root, PLAN_FILE);
      await fs.writeFile(file, 'old plan\n', 'utf8');
      for (const o of [
        { text: 'Stopped after 40 model steps', completed: false },
        { text: 'Prompt blocked by a hook' },
        { text: 'model call failed', completed: false, errored: true },
        { text: 'partial', completed: true, aborted: true },
      ]) {
        assert.strictEqual(await saveImplementationPlan(root, o), undefined);
        assert.strictEqual(await fs.readFile(file, 'utf8'), 'old plan\n');
      }
      assert.strictEqual(await saveImplementationPlan(root, { text: '# New plan', completed: true }), file);
      assert.strictEqual(await fs.readFile(file, 'utf8'), '# New plan\n');

      // The chat controller goes through the same gate and only announces a save it made.
      const c = Object.create(ChatController.prototype) as any;
      const toasts: string[] = [];
      Object.assign(c, { sessionRoot: () => root, broadcast: (m: any) => toasts.push(m.text), log: { warn() {} } });
      await c.writeImplementationPlan('s1', { text: 'error text', completed: false, errored: true });
      assert.strictEqual(await fs.readFile(file, 'utf8'), '# New plan\n');
      assert.deepStrictEqual(toasts, []);
      await c.writeImplementationPlan('s1', { text: '# Final plan', completed: true, errored: false, aborted: false });
      assert.strictEqual(await fs.readFile(file, 'utf8'), '# Final plan\n');
      assert.strictEqual(toasts.length, 1);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test('/newtask still hands off when the summary call fails', async () => {
    const c = Object.create(ChatController.prototype) as any;
    const parent: any = {
      id: 'p1',
      title: 'Parent chat',
      mode: 'agent',
      model: 'm/x',
      messages: [
        { role: 'user', content: 'Add OAuth login to src/auth.ts' },
        { role: 'assistant', content: 'I read src/auth.ts and added the callback route.' },
        { role: 'user', content: 'now the tests' },
        { role: 'assistant', content: 'Added src/test/auth.test.ts.' },
      ],
    };
    const saved: any[] = [];
    const toasts: any[] = [];
    let active: any;
    const provider = {
      id: 'm',
      chat: async function* () {
        throw new Error('connection refused');
      },
    };
    const model = { id: 'm/x', providerId: 'm', modelId: 'x', name: 'X', contextWindow: 32768, maxOutputTokens: 4096, supportsTools: true, supportsVision: false };
    Object.assign(c, {
      store: { get: (id: string) => (id === 'p1' ? parent : undefined), save: (s: any) => saved.push(s) },
      isRunning: () => false,
      compacting: new Map(),
      providers: { resolve: async () => ({ provider, model }) },
      createSession: (mode: string) => ({ id: 'c1', mode, messages: [], title: '' }),
      setActive: (s: any) => (active = s),
      broadcast: (m: any) => toasts.push(m),
      log: { warn() {}, info() {} },
    });
    await c.newTask('p1', 'finish the tests');
    assert.ok(active, 'the child chat was created');
    assert.strictEqual(active.parentId, 'p1');
    assert.strictEqual(active.parentTitle, 'Parent chat');
    assert.strictEqual(active.messages.length, 1);
    assert.strictEqual(active.messages[0].meta.summary, true);
    assert.match(active.messages[0].content, /<conversation_summary>[\s\S]*src\/test\/auth\.test\.ts[\s\S]*<\/conversation_summary>/);
    assert.match(active.messages[0].content, /Note for this task: finish the tests/);
    assert.ok(saved.includes(active));
    assert.ok(!toasts.some((t) => t.type === 'toast' && t.level === 'error'), 'no error toast');
    assert.strictEqual(c.compacting.size, 0);
  });
});
