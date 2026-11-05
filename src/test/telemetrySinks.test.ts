import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { FileTelemetrySink, STORE_SINK, summarize, Telemetry } from '../telemetry/telemetry';
import type { TelemetryBatch, TelemetryEvent, TelemetryInput, TelemetryRemote, TelemetrySink } from '../telemetry/telemetry';
import { lineDelta, measureEdits, mentionKind, recordEditDecision, recordTelemetry, setTelemetryRecorder } from '../telemetry/catalog';
import { hookRunOutcome } from '../agent/hooks';

/** A sink that remembers everything it was given. */
class MemorySink implements TelemetrySink {
  batches: TelemetryBatch[] = [];
  counters: [string, number, unknown][] = [];
  histograms: [string, number][] = [];
  flushed = 0;
  shut = 0;
  failWrites = false;
  async write(b: TelemetryBatch): Promise<void> {
    if (this.failWrites) {
      throw new Error('sink down');
    }
    this.batches.push(b);
  }
  async flush(): Promise<void> {
    this.flushed++;
  }
  async shutdown(): Promise<void> {
    this.shut++;
  }
  counter(name: string, value: number, attrs?: unknown): void {
    this.counters.push([name, value, attrs]);
  }
  histogram(name: string, value: number): void {
    this.histograms.push([name, value]);
  }
  get events(): TelemetryEvent[] {
    return this.batches.flatMap((b) => b.events);
  }
}

const tmpDir = () => fs.mkdtemp(path.join(os.tmpdir(), 'lp-sinks-'));

suite('Telemetry sinks', () => {
  test('the store is the first sink; extra sinks get the same batch and the files are still written', async () => {
    const dir = await tmpDir();
    const mem = new MemorySink();
    const t = new Telemetry({ dir, retentionDays: () => 0, sinks: [{ name: 'mem', sink: mem }] });
    try {
      assert.deepStrictEqual(t.sinkNames(), [STORE_SINK, 'mem']);
      t.record({ type: 'worktree', action: 'create' });
      t.log('info', 'line one\nline two');
      await t.flush();
      assert.strictEqual(mem.events.length, 1);
      assert.strictEqual(mem.batches[0].logs[0].msg, 'line one\nline two');
      assert.ok(mem.flushed >= 1, 'flush reaches the sinks');
      const files = await fs.readdir(dir);
      assert.ok(files.some((f) => f.startsWith('events-')) && files.some((f) => f.startsWith('localpilot-')), files.join(','));
      assert.strictEqual((await t.events(0)).length, 1);
    } finally {
      await t.shutdown();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test('a failing sink is reported and does not stop the store or the other sinks', async () => {
    const dir = await tmpDir();
    const bad = new MemorySink();
    bad.failWrites = true;
    const good = new MemorySink();
    const errors: string[] = [];
    const t = new Telemetry({ dir, retentionDays: () => 0, onSinkError: (name, e) => errors.push(`${name}: ${(e as Error).message}`) });
    try {
      t.add('bad', bad);
      t.add('good', good);
      t.record({ type: 'slash', command: 'help' });
      await t.flush();
      assert.deepStrictEqual(errors, ['bad: sink down']);
      assert.strictEqual(good.events.length, 1);
      assert.strictEqual((await t.events(0)).length, 1, 'the event reached the file store');
    } finally {
      await t.shutdown();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test('remove flushes what is queued, shuts the sink down and detaches it; the store cannot be removed or replaced', async () => {
    const dir = await tmpDir();
    const mem = new MemorySink();
    const t = new Telemetry({ dir, retentionDays: () => 0 });
    try {
      t.add('mem', mem);
      t.record({ type: 'mention', kind: 'file' });
      assert.strictEqual(await t.remove('mem'), true);
      assert.strictEqual(mem.events.length, 1, 'queued event delivered before removal');
      assert.strictEqual(mem.shut, 1);
      t.record({ type: 'mention', kind: 'git' });
      await t.flush();
      assert.strictEqual(mem.events.length, 1, 'nothing after removal');
      assert.strictEqual(await t.remove('mem'), false);
      assert.strictEqual(await t.remove(STORE_SINK), false);
      assert.throws(() => t.add(STORE_SINK, mem));
      // Replacing a sink shuts the old one down.
      const a = new MemorySink();
      const b = new MemorySink();
      t.add('x', a);
      t.add('x', b);
      await new Promise((r) => setImmediate(r));
      assert.strictEqual(a.shut, 1);
      assert.strictEqual(b.shut, 0);
    } finally {
      await t.shutdown();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test('counters and histograms reach sinks that keep metrics, and nothing is recorded while telemetry is off', async () => {
    const dir = await tmpDir();
    let on = true;
    const mem = new MemorySink();
    const plain: TelemetrySink = { write: async () => undefined, flush: async () => undefined, shutdown: async () => undefined };
    const t = new Telemetry({ dir, retentionDays: () => 0, enabled: () => on, sinks: [{ name: 'plain', sink: plain }, { name: 'mem', sink: mem }] });
    try {
      t.counter('localpilot.task.count', 1, { action: 'created' });
      t.histogram('localpilot.hook.duration', 42);
      on = false;
      t.counter('localpilot.task.count');
      t.record({ type: 'slash', command: 'x' });
      await t.flush();
      assert.deepStrictEqual(mem.counters, [['localpilot.task.count', 1, { action: 'created' }]]);
      assert.deepStrictEqual(mem.histograms, [['localpilot.hook.duration', 42]]);
      assert.strictEqual(mem.events.length, 0);
    } finally {
      await t.shutdown();
      assert.strictEqual(mem.shut, 1, 'shutdown reaches every sink');
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test('a failed remote write still falls back to files, and the extra sinks still get the batch', async () => {
    const dir = await tmpDir();
    const mem = new MemorySink();
    let remoteErrors = 0;
    const remote: TelemetryRemote = {
      label: 'stub',
      write: () => Promise.reject(new Error('down')),
      events: async () => undefined,
      recentLogs: async () => [],
      stats: async () => ({ events: 0, bytes: 0 }),
      prune: async () => undefined,
      clear: async () => undefined,
    };
    const t = new Telemetry({ dir, retentionDays: () => 0, remote: () => remote, onRemoteError: () => remoteErrors++, sinks: [{ name: 'mem', sink: mem }] });
    try {
      t.record({ type: 'worktree', action: 'discard' });
      await t.flush();
      assert.strictEqual(remoteErrors, 1);
      assert.ok((await fs.readdir(dir)).some((f) => f.startsWith('events-')));
      assert.strictEqual(mem.events.length, 1);
    } finally {
      await t.shutdown();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test('FileTelemetrySink splits a batch by day', async () => {
    const dir = await tmpDir();
    try {
      const day = 86400_000;
      const t0 = new Date(2026, 0, 10, 12).getTime();
      await new FileTelemetrySink(dir).write({ events: [{ t: t0, type: 'worktree', action: 'create' }, { t: t0 + day, type: 'worktree', action: 'apply' }], logs: [{ t: t0, level: 'warn', msg: 'a\\b' }] });
      assert.deepStrictEqual((await fs.readdir(dir)).sort(), ['events-2026-01-10.jsonl', 'events-2026-01-11.jsonl', 'localpilot-2026-01-10.log']);
      assert.match(await fs.readFile(path.join(dir, 'localpilot-2026-01-10.log'), 'utf8'), /\[warn\] a\\\\b\n$/);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

suite('Telemetry event catalog', () => {
  test('mention kinds never keep the reference', () => {
    assert.strictEqual(mentionKind('src/a.ts'), 'file');
    assert.strictEqual(mentionKind('src/a.ts#L3-L9'), 'range');
    assert.strictEqual(mentionKind('src/lib/'), 'folder');
    assert.strictEqual(mentionKind('@git'), 'git');
    assert.strictEqual(mentionKind('problems'), 'problems');
    assert.strictEqual(mentionKind('https://example.com/x'), 'url');
    assert.strictEqual(mentionKind('file:///tmp/x'), 'file');
    assert.strictEqual(mentionKind('  '), 'other');
  });

  test('lineDelta counts added and removed lines, ignoring moves and a trailing newline', () => {
    assert.deepStrictEqual(lineDelta('a\nb\nc\n', 'a\nB\nc\nd'), { added: 2, removed: 1 });
    assert.deepStrictEqual(lineDelta(undefined, 'x\ny\n'), { added: 2, removed: 0 });
    assert.deepStrictEqual(lineDelta('x\ny', undefined), { added: 0, removed: 2 });
    assert.deepStrictEqual(lineDelta('a\nb', 'b\na'), { added: 0, removed: 0 });
    assert.deepStrictEqual(lineDelta('a\r\nb\r\n', 'a\nb\n'), { added: 0, removed: 0 });
  });

  test('measureEdits and recordEditDecision compare snapshots with the files on disk', async () => {
    const dir = await tmpDir();
    try {
      const edited = path.join(dir, 'a.txt');
      const created = path.join(dir, 'b.txt');
      await fs.writeFile(edited, 'one\nTWO\nthree\nfour\n');
      await fs.writeFile(created, 'new\n');
      const changes = [
        { fsPath: edited, original: 'one\ntwo\nthree\n' },
        { fsPath: created },
        { fsPath: path.join(dir, 'gone.txt'), original: 'x\ny\n' },
      ];
      assert.deepStrictEqual(await measureEdits(changes), { added: 3, removed: 3, files: 3 });
      const seen: TelemetryInput[] = [];
      await recordEditDecision('rejected', changes, { record: (e) => void seen.push(e) });
      assert.deepStrictEqual(seen, [{ type: 'edit_decision', decision: 'rejected', added: 3, removed: 3, files: 3 }]);
      await recordEditDecision('accepted', [], { record: (e) => void seen.push(e) });
      assert.strictEqual(seen.length, 1, 'no event for an empty decision');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test('the shared recorder is optional and never throws', () => {
    const seen: TelemetryInput[] = [];
    setTelemetryRecorder({ record: (e) => void seen.push(e) });
    recordTelemetry({ type: 'mention', kind: 'git' });
    setTelemetryRecorder({
      record: () => {
        throw new Error('boom');
      },
    });
    recordTelemetry({ type: 'mention', kind: 'git' });
    setTelemetryRecorder(undefined);
    recordTelemetry({ type: 'mention', kind: 'git' });
    assert.strictEqual(seen.length, 1);
  });

  test('hook outcomes: exit 0 ok, exit 2 blocked, others failed, timeouts first', () => {
    assert.strictEqual(hookRunOutcome({ code: 0, stdout: '', stderr: '', timedOut: false }), 'ok');
    assert.strictEqual(hookRunOutcome({ code: 2, stdout: '', stderr: '', timedOut: false }), 'blocked');
    assert.strictEqual(hookRunOutcome({ code: 1, stdout: '', stderr: '', timedOut: false }), 'failed');
    assert.strictEqual(hookRunOutcome({ code: null, stdout: '', stderr: '', timedOut: true }), 'timeout');
  });

  test('the summary aggregates tasks, edit lines, hooks, MCP calls, checkpoints and choices', () => {
    const now = new Date(2026, 2, 3, 15).getTime();
    const ev = (e: TelemetryInput): TelemetryEvent => ({ ...e, t: now }) as TelemetryEvent;
    const s = summarize(
      [
        ev({ type: 'task', sid: 's', action: 'created', mode: 'agent' }),
        ev({ type: 'task', sid: 's', action: 'completed', mode: 'agent' }),
        ev({ type: 'task', sid: 's', action: 'mistake_limit', mode: 'agent' }),
        ev({ type: 'task', sid: 's', action: 'failed', mode: 'agent' }),
        ev({ type: 'edit_decision', decision: 'accepted', added: 10, removed: 2, files: 2 }),
        ev({ type: 'edit_decision', decision: 'rejected', added: 4, removed: 1, files: 1 }),
        ev({ type: 'hook', event: 'PreToolUse', durationMs: 30, outcome: 'ok' }),
        ev({ type: 'hook', event: 'PreToolUse', durationMs: 50, outcome: 'blocked' }),
        ev({ type: 'hook', event: 'Stop', durationMs: 60_000, outcome: 'timeout' }),
        ev({ type: 'hook', event: 'Stop', durationMs: 10, outcome: 'failed' }),
        ev({ type: 'mcp_call', server: 'gh', tool: 'search', durationMs: 120, ok: true }),
        ev({ type: 'mcp_call', server: 'gh', tool: 'search', durationMs: 80, ok: false }),
        ev({ type: 'checkpoint', action: 'restore', outcome: 'ok', files: 3 }),
        ev({ type: 'checkpoint', action: 'rewind', outcome: 'ok' }),
        ev({ type: 'checkpoint', action: 'restore', outcome: 'failed' }),
        ev({ type: 'mode_switch', from: 'agent', to: 'plan', source: 'picker' }),
        ev({ type: 'mode_switch', from: 'plan', to: 'agent', source: 'plan' }),
        ev({ type: 'mode_switch', from: 'ask', to: 'agent', source: 'slash' }),
        ev({ type: 'model_selected', model: 'ollama/qwen', source: 'picker' }),
        ev({ type: 'slash', command: 'compact' }),
        ev({ type: 'slash', command: 'compact' }),
        ev({ type: 'slash', command: 'review', custom: true }),
        ev({ type: 'mention', kind: 'file' }),
      ],
      { days: 1, from: now, to: now }
    );
    const a = s.activity;
    assert.deepStrictEqual(a.tasks, { created: 1, completed: 1, aborted: 0, failed: 1, mistakeLimit: 1, unverified: 0, incomplete: 0, blocked: 0 });
    assert.deepStrictEqual(a.edits, { accepted: 1, rejected: 1, acceptedAdded: 10, acceptedRemoved: 2, rejectedAdded: 4, rejectedRemoved: 1, acceptedFiles: 2, rejectedFiles: 1 });
    assert.strictEqual(s.series[0].acceptedLines, 12);
    assert.strictEqual(s.series[0].rejectedLines, 5);
    assert.strictEqual(s.series[0].hookFailures, 2);
    assert.deepStrictEqual([a.hooks.runs, a.hooks.ok, a.hooks.blocked, a.hooks.failed, a.hooks.timeout], [4, 1, 1, 1, 1]);
    assert.deepStrictEqual(a.hooks.byEvent, [{ event: 'PreToolUse', runs: 2, failures: 0 }, { event: 'Stop', runs: 2, failures: 2 }]);
    assert.deepStrictEqual([a.mcp.calls, a.mcp.errors, a.mcp.servers[0].server], [2, 1, 'gh']);
    assert.deepStrictEqual(a.checkpoints, { created: 0, restores: 1, rewinds: 1, failed: 1, files: 3 });
    assert.deepStrictEqual(a.modeSwitches, [{ to: 'agent', count: 2 }, { to: 'plan', count: 1 }]);
    assert.deepStrictEqual(a.modelSelections, [{ model: 'ollama/qwen', count: 1 }]);
    assert.deepStrictEqual(a.slash[0], { command: 'compact', count: 2 });
    assert.deepStrictEqual(a.mentions, [{ kind: 'file', count: 1 }]);
    assert.deepStrictEqual(s.errors.map((e) => e.kind).sort(), ['hook', 'hook', 'mcp']);
  });
});
