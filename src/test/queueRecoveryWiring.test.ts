import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { QueueRunResult, QueueTask, TaskQueue } from '../agent/taskQueue';
import { AgentsTreeProvider, RECOVERY_OPEN_COMMAND } from '../ui/agentsView';
import type { ChatController } from '../ui/chatController';

const tick = () => new Promise((r) => setImmediate(r));

function fakeController(): ChatController {
  const event = () => ({ dispose: () => undefined });
  return { store: { onDidChange: event }, onDidChangeRuns: event, tracker: { onDidChange: event }, onDidChangeActive: event, runStatus: new Map() } as unknown as ChatController;
}

suite('Task queue: shutdown order and recovery wiring', () => {
  let dir: string;
  setup(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lp-queue-wiring-'));
  });
  teardown(() => fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));

  test('a run stopped for shutdown before the queue is disposed stays running on disk', async () => {
    const file = path.join(dir, 'q.json');
    const finish: ((r: QueueRunResult) => void)[] = [];
    const runner = (_t: QueueTask, onStart: (sid: string) => void) =>
      new Promise<QueueRunResult>((resolve) => {
        onStart(`s_${finish.length}`);
        finish.push(resolve);
      });
    const q = new TaskQueue(file, runner, () => 1);
    q.add({ prompt: 'a' });
    await tick();
    // Controller disposed first: its stop('shutdown') settles the run while the queue is still alive.
    finish[0]({ ok: false, cancelled: true, shutdown: true, error: 'Stopped.' });
    await tick();
    await tick();
    assert.strictEqual(q.list[0].status, 'running');
    q.dispose();
    await q.flush();
    const saved = JSON.parse(await fs.readFile(file, 'utf8')) as { tasks: QueueTask[] };
    assert.deepStrictEqual(saved.tasks.map((t) => [t.status, t.sessionId]), [['running', 's_0']]);
  });

  test('incomplete tasks open the chat until the recovery commands are wired', async () => {
    const runner = (_t: QueueTask, onStart: (sid: string) => void) => {
      onStart('s_x');
      return Promise.resolve<QueueRunResult>({ ok: true, outcome: 'incomplete', interventionId: 'iv_1' });
    };
    const q = new TaskQueue(path.join(dir, 'q.json'), runner, () => 1);
    q.add({ prompt: 'a' });
    await tick();
    await tick();
    const task = q.list[0];
    assert.strictEqual(task.status, 'incomplete');
    const node = { kind: 'task' as const, task, position: 1 };
    const plain = new AgentsTreeProvider(fakeController(), q);
    const wired = new AgentsTreeProvider(fakeController(), q, { recovery: true });
    const a = plain.getTreeItem(node);
    const b = wired.getTreeItem(node);
    assert.strictEqual(a.contextValue, 'queueTask.incomplete');
    assert.deepStrictEqual(a.command?.command, 'localpilot.openSession');
    assert.deepStrictEqual(a.command?.arguments, ['s_x']);
    assert.strictEqual(b.command?.command, RECOVERY_OPEN_COMMAND);
    assert.deepStrictEqual(b.command?.arguments, ['s_x', 'iv_1']);
    assert.ok(b.iconPath instanceof vscode.ThemeIcon);
    plain.dispose();
    wired.dispose();
    await q.flush();
    q.dispose();
  });
});
