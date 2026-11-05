import * as assert from 'assert';
import * as vscode from 'vscode';
import type { QueueTask } from '../agent/taskQueue';
import { resumeRecoveryApi } from '../extension';
import type { Session } from '../types';

function fakeQueue(tasks: QueueTask[], canRetry = true) {
  const changed = new vscode.EventEmitter<void>();
  const retried: string[] = [];
  return {
    list: tasks,
    onDidChange: changed.event,
    retried,
    fire: () => changed.fire(),
    retry(id: string) {
      const t = tasks.find((x) => x.id === id);
      if (!t || !canRetry) {
        return false;
      }
      retried.push(id);
      Object.assign(t, { status: 'queued', resume: true, outcome: undefined, interventionId: undefined });
      return true;
    },
  };
}

const task = (over: Partial<QueueTask>): QueueTask => ({ id: 'q1', prompt: 'fix it', mode: 'agent', status: 'incomplete', sessionId: 's1', createdAt: 1, ...over });
const sessions = (answer: string) => ({ get: (id: string) => (id === 's1' ? ({ messages: [{ role: 'user', content: 'x' }, { role: 'assistant', content: answer }] } as unknown as Session) : undefined) });

suite('api.recovery.resume', () => {
  test('a chat without a queue task gets the resume turn', async () => {
    const q = fakeQueue([]);
    const calls: string[] = [];
    const out = await resumeRecoveryApi('s1', q, { resumeRecovery: async (sid) => (calls.push(sid), 'resumed') }, sessions(''));
    assert.strictEqual(out, 'resumed');
    assert.deepStrictEqual(calls, ['s1']);
    assert.deepStrictEqual(q.retried, []);
  });

  test('an incomplete queue task goes back to the queue and settles with the run', async () => {
    const t = task({ outcome: 'incomplete' as QueueTask['outcome'], interventionId: 'i1' });
    const q = fakeQueue([t]);
    let resumed = false;
    let settled = false;
    const p = resumeRecoveryApi('s1', q, { resumeRecovery: async () => ((resumed = true), '') }, sessions('all checks pass')).then((v) => ((settled = true), v));
    await new Promise((r) => setImmediate(r));
    assert.deepStrictEqual(q.retried, ['q1']);
    assert.strictEqual(resumed, false);
    assert.strictEqual(t.interventionId, undefined);
    t.status = 'running';
    q.fire();
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(settled, false);
    t.status = 'done';
    q.fire();
    assert.strictEqual(await p, 'all checks pass');
  });

  test('a task the queue refuses to retry rejects', async () => {
    const q = fakeQueue([task({ status: 'needs_input' })], false);
    await assert.rejects(resumeRecoveryApi('s1', q, { resumeRecovery: async () => '' }, sessions('')), /cannot be resumed/);
  });
});
