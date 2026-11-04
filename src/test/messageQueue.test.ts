import * as assert from 'assert';
import { MessageQueue, parseRunLine, queueLabel } from '../agent/messageQueue';
import { RunControl } from '../agent/runControl';

suite('LocalPilot message queue and steer cancellation', () => {
  test('removeSteer withdraws a pending steer so the loop never takes it', () => {
    const c = new RunControl('s');
    let changes = 0;
    c.onDidChange(() => changes++);
    c.steer({ role: 'user', content: 'first', meta: { steerId: 'a' } });
    c.steer({ role: 'user', content: 'second', meta: { steerId: 'b' } });
    assert.deepStrictEqual(c.pendingSteers().map((m) => m.content), ['first', 'second']);
    const before = changes;
    assert.strictEqual(c.removeSteer('a')?.content, 'first');
    assert.ok(changes > before, 'listeners hear about the removal');
    assert.strictEqual(c.removeSteer('a'), undefined);
    assert.strictEqual(c.pendingSteering, 1);
    assert.deepStrictEqual(c.takeSteering().map((m) => m.content), ['second']);
    assert.strictEqual(c.removeSteer('b'), undefined, 'an injected steer can no longer be cancelled');
  });

  test('queued messages leave the queue when taken, so each runs exactly once', () => {
    const q = new MessageQueue();
    const a = q.add('s1', { text: 'one', attachments: [] });
    q.add('s1', { text: 'two', attachments: ['src/a.ts'] });
    q.add('s1', { text: 'leftover', attachments: [] }, true);
    q.add('s2', { text: 'other chat', attachments: [] });
    assert.deepStrictEqual(q.list('s1').map((m) => m.text), ['leftover', 'one', 'two']);
    assert.strictEqual(q.remove('s1', a.id)?.text, 'one');
    assert.strictEqual(q.remove('s1', a.id), undefined);
    assert.strictEqual(q.shift('s1')?.text, 'leftover');
    assert.strictEqual(q.shift('s1')?.text, 'two');
    assert.strictEqual(q.shift('s1'), undefined);
    assert.deepStrictEqual(q.list('s2').map((m) => m.text), ['other chat']);
    q.clear('s2');
    assert.strictEqual(q.list('s2').length, 0);
  });

  test('banner label counts both kinds', () => {
    assert.strictEqual(queueLabel([]), '');
    assert.strictEqual(queueLabel([{ id: '1', kind: 'after', text: 'a' }, { id: '2', kind: 'after', text: 'b' }, { id: '3', kind: 'steer', text: 'c' }]), '2 queued · 1 steering');
    assert.strictEqual(queueLabel([{ id: '3', kind: 'steer', text: 'c' }]), '1 steering');
  });

  test('CLI lines typed during a run: >> queues, /queue manages, anything else steers', () => {
    assert.deepStrictEqual(parseRunLine('>> run the tests next'), { kind: 'after', text: 'run the tests next' });
    assert.deepStrictEqual(parseRunLine('use pnpm'), { kind: 'steer', text: 'use pnpm' });
    assert.deepStrictEqual(parseRunLine('/queue'), { kind: 'list' });
    assert.deepStrictEqual(parseRunLine('/queue rm 2'), { kind: 'remove', index: 2 });
    assert.deepStrictEqual(parseRunLine('/queue nonsense'), { kind: 'queueUsage' });
    assert.deepStrictEqual(parseRunLine('/queued thing'), { kind: 'steer', text: '/queued thing' });
  });
});
