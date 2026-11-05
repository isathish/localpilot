import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { QueueRunResult, QueueTask, TaskQueue } from '../agent/taskQueue';

/** A runner whose runs end only when the test says so, with whatever result it passes. */
function scriptedRunner() {
  const runs: { prompt: string; sessionId?: string; resume?: boolean }[] = [];
  const finish = new Map<string, (r: QueueRunResult) => void>();
  const runner = (task: QueueTask, onStart: (sid: string) => void) =>
    new Promise<QueueRunResult>((resolve) => {
      runs.push({ prompt: task.prompt, sessionId: task.sessionId, resume: task.resume });
      onStart(task.resume && task.sessionId ? task.sessionId : `s_${task.prompt}_${runs.length}`);
      finish.set(task.prompt, resolve);
    });
  const end = async (prompt: string, r: QueueRunResult) => {
    finish.get(prompt)!(r);
    await new Promise((res) => setImmediate(res));
  };
  return { runs, runner, end };
}

const tick = () => new Promise((r) => setImmediate(r));

suite('Task queue: self-healing outcomes, resume and shutdown', () => {
  let dir: string;
  setup(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lp-queue-heal-'));
  });
  teardown(() => fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));

  test('outcomes map to statuses; incomplete and needs_input block dependents', async () => {
    const r = scriptedRunner();
    const q = new TaskQueue(path.join(dir, 'q.json'), r.runner, () => 4);
    const a = q.add({ prompt: 'a' });
    const b = q.add({ prompt: 'b' });
    q.add({ prompt: 'c' });
    q.add({ prompt: 'd' });
    q.add({ prompt: 'a2', dependsOn: [a.id] });
    q.add({ prompt: 'b2', dependsOn: [b.id] });
    await tick();
    await r.end('a', { ok: true, outcome: 'incomplete', error: 'npm test still fails' });
    await r.end('b', { ok: true, outcome: 'blocked', interventionId: 'iv_1' });
    await r.end('c', { ok: true, outcome: 'completed_unverified' });
    await r.end('d', { ok: false, error: 'model down' });
    assert.deepStrictEqual(q.list.map((t) => t.status), ['incomplete', 'needs_input', 'done', 'failed', 'blocked', 'blocked']);
    assert.strictEqual(q.list[0].error, 'npm test still fails');
    assert.strictEqual(q.list[0].outcome, 'incomplete');
    assert.strictEqual(q.list[1].interventionId, 'iv_1');
    assert.strictEqual(q.list[2].outcome, 'completed_unverified');
    assert.strictEqual(q.list[2].error, undefined);
    assert.strictEqual(q.cancel(a.id), undefined, 'incomplete is finished');
    await q.flush();
    q.dispose();
  });

  test('retry of an incomplete task continues in the same chat and re-queues its dependents', async () => {
    const r = scriptedRunner();
    const q = new TaskQueue(path.join(dir, 'q.json'), r.runner, () => 1);
    const a = q.add({ prompt: 'a' });
    q.add({ prompt: 'a2', dependsOn: [a.id] });
    await tick();
    await r.end('a', { ok: true, outcome: 'incomplete' });
    const sid = q.list[0].sessionId;
    assert.ok(sid);
    assert.ok(q.retry(a.id));
    assert.deepStrictEqual(q.list.map((t) => t.status), ['running', 'queued']);
    assert.deepStrictEqual(r.runs[1], { prompt: 'a', sessionId: sid, resume: true });
    assert.strictEqual(q.list[0].outcome, undefined);
    await r.end('a', { ok: true, outcome: 'completed' });
    assert.strictEqual(q.list[0].status, 'done');
    assert.strictEqual(q.list[0].resume, undefined, 'resume is spent once the run ends');
    assert.deepStrictEqual(r.runs.map((x) => x.prompt), ['a', 'a', 'a2']);
    await q.flush();
    q.dispose();
  });

  test('retry of a failed task still starts a fresh chat', async () => {
    const r = scriptedRunner();
    const q = new TaskQueue(path.join(dir, 'q.json'), r.runner, () => 1);
    const a = q.add({ prompt: 'a' });
    await tick();
    await r.end('a', { ok: false });
    assert.ok(q.retry(a.id));
    assert.deepStrictEqual(r.runs[1], { prompt: 'a', sessionId: undefined, resume: undefined });
    await q.flush();
    q.dispose();
  });

  test('a run ended by shutdown stays running on disk and resumes in its chat when it has recovery state', async () => {
    const file = path.join(dir, 'q.json');
    const r1 = scriptedRunner();
    const q1 = new TaskQueue(file, r1.runner, () => 2);
    q1.add({ prompt: 'a' });
    q1.add({ prompt: 'b' });
    await tick();
    const [sa, sb] = q1.list.map((t) => t.sessionId);
    q1.setPaused(true);
    await q1.flush();
    q1.dispose(); // the extension disposes the queue first, then the controller stops the runs
    await r1.end('a', { ok: false, cancelled: true, error: 'Stopped.' });
    await q1.flush();
    const saved = JSON.parse(await fs.readFile(file, 'utf8')) as { tasks: QueueTask[] };
    assert.deepStrictEqual(saved.tasks.map((t) => t.status), ['running', 'running']);

    const r2 = scriptedRunner();
    const q2 = new TaskQueue(file, r2.runner, () => 2, undefined, { resumable: (sid) => sid === sa });
    await q2.load();
    assert.deepStrictEqual(q2.list.map((t) => t.status), ['queued', 'queued']);
    assert.strictEqual(q2.list[0].sessionId, sa);
    assert.strictEqual(q2.list[0].resume, true);
    assert.strictEqual(q2.list[1].sessionId, undefined, `no recovery state for ${sb}: a fresh chat`);
    assert.strictEqual(q2.list[1].resume, undefined);
    q2.setPaused(false);
    assert.deepStrictEqual(r2.runs, [
      { prompt: 'a', sessionId: sa, resume: true },
      { prompt: 'b', sessionId: undefined, resume: undefined },
    ]);
    await q2.flush();
    q2.dispose();
  });

  test('old queue files without the new fields load unchanged', async () => {
    const file = path.join(dir, 'q.json');
    await fs.writeFile(file, JSON.stringify({ version: 1, paused: true, tasks: [{ id: 'q_1', prompt: 'x', mode: 'agent', status: 'running', sessionId: 's_old', createdAt: 1 }, { id: 'q_2', prompt: 'y', mode: 'agent', status: 'failed', createdAt: 2, error: 'e' }] }));
    const q = new TaskQueue(file, scriptedRunner().runner, () => 1);
    await q.load();
    assert.deepStrictEqual(q.list.map((t) => [t.status, t.sessionId, t.resume]), [['queued', undefined, undefined], ['failed', undefined, undefined]]);
    await q.flush();
    q.dispose();
  });
});
