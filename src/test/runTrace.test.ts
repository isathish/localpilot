import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { MAX_TRACE_ENTRIES, RunTraceRecorder, toolDetail, traceExport, traceTotals } from '../telemetry/runTrace';
import { TraceStore } from '../telemetry/traceStore';
import type { AgentEvent } from '../types';
import { removeTemp } from './removeTemp';

/** A recorder on a hand-moved clock, so durations are exact. */
function recorder(): { r: RunTraceRecorder; at: (ms: number) => void; ev: (type: AgentEvent['type'], payload?: unknown) => void } {
  let now = 1_000_000;
  const r = new RunTraceRecorder({ id: 't1', sessionId: 's1', title: 'Fix the parser\nwith more detail', mode: 'debug', now }, () => now);
  return { r, at: (ms) => (now = 1_000_000 + ms), ev: (type, payload) => r.event({ sessionId: 's1', type, payload }) };
}

suite('Run traces: recorder, totals, export and store', () => {
  test('model calls, tools, retries, fallbacks and approvals are recorded in order with durations', () => {
    const { r, at, ev } = recorder();
    ev('route', { wanted: 'cloud/big', used: 'ollama/qwen', usedName: 'qwen', reason: 'No network — big needs the internet', fallback: true });
    at(100);
    ev('model_request', { model: 'ollama/qwen', name: 'qwen' });
    at(900);
    ev('assistant_delta', 'Let me look');
    at(1500);
    ev('tool_start', { id: 'c1', name: 'read_file', args: { path: 'src/dice.py' } });
    at(1600);
    ev('tool_end', { id: 'c1', name: 'read_file', isError: false, durationMs: 100 });
    ev('model_request', { model: 'ollama/qwen', name: 'qwen' });
    at(2000);
    ev('retry', { attempt: 1, max: 3, reason: 'connection', message: 'socket hang up', delayMs: 2000 });
    at(4000);
    ev('model_request', { model: 'ollama/qwen', name: 'qwen' });
    at(4500);
    ev('tool_start', { id: 'c2', name: 'run_command', args: { command: 'pytest -q' } });
    r.approvalAsked('a1', 'Run command', 'terminal');
    at(9500);
    r.approvalAnswered('a1', true);
    at(12_000);
    ev('tool_end', { id: 'c2', name: 'run_command', isError: true, durationMs: 7500, content: '1 failed' });
    ev('model_request', { model: 'ollama/qwen', name: 'qwen' });
    at(15_000);
    ev('turn_end', { model: 'ollama/qwen', promptTokens: 1200, completionTokens: 300 });
    const t = r.finish('ok');

    assert.strictEqual(t.title, 'Fix the parser');
    assert.strictEqual(t.outcome, 'ok');
    assert.strictEqual(t.durationMs, 15_000);
    assert.deepStrictEqual(t.entries.map((e) => `${e.kind}:${e.name}`), [
      'fallback:big → qwen',
      'model:qwen',
      'tool:read_file',
      'model:qwen',
      'retry:Retry 1/3',
      'model:qwen',
      'tool:run_command',
      'approval:Approval: terminal',
      'model:qwen',
    ]);
    const [, m1, read, m2, retry, , cmd, approval, last] = t.entries;
    assert.deepStrictEqual([m1.start, m1.end, m1.firstTokenMs, m1.status], [100, 1500, 800, 'ok']);
    assert.deepStrictEqual([read.start, read.end, read.detail, read.status], [1500, 1600, 'src/dice.py', 'ok']);
    assert.strictEqual(m2.status, 'error', 'the call that was retried failed');
    assert.match(retry.detail ?? '', /connection: socket hang up · waited 2s/);
    assert.deepStrictEqual([cmd.end, cmd.status], [12_000, 'error']);
    assert.match(cmd.detail ?? '', /pytest -q · 1 failed/);
    assert.deepStrictEqual([approval.start, approval.end, approval.status], [4500, 9500, 'ok']);
    assert.deepStrictEqual([last.end, last.status], [15_000, 'ok']);
    assert.deepStrictEqual([t.model, t.promptTokens, t.completionTokens], ['ollama/qwen', 1200, 300]);

    const totals = traceTotals(t);
    assert.deepStrictEqual(
      { modelCalls: totals.modelCalls, toolCalls: totals.toolCalls, failedTools: totals.failedTools, retries: totals.retries, fallbacks: totals.fallbacks, approvals: totals.approvals },
      { modelCalls: 4, toolCalls: 2, failedTools: 1, retries: 1, fallbacks: 1, approvals: 1 }
    );
    assert.strictEqual(totals.toolMs, 100 + 7500);
  });

  test('subagent work nests under its lane; a stopped run closes what was still open as cancelled', () => {
    const { r, at, ev } = recorder();
    ev('tool_start', { id: 'p', name: 'run_subagent', args: { agent: 'tester' } });
    ev('subagent_start', { childId: 'c1', agent: 'tester', label: 'Add a test', prompt: 'Add a regression test' });
    at(200);
    ev('model_request', { childId: 'c1', agent: 'tester', inner: 'model_request', data: { model: 'ollama/g', name: 'g' } });
    at(700);
    ev('status', { childId: 'c1', agent: 'tester', inner: 'assistant_delta', data: 'hi' });
    ev('tool_start', { childId: 'c1', agent: 'tester', inner: 'tool_start', data: { id: 'x', name: 'write_file', args: { path: 'tests/t.py' } } });
    at(900);
    ev('tool_end', { childId: 'c1', agent: 'tester', inner: 'tool_end', data: { id: 'x', isError: false } });
    ev('tool_start', { childId: 'c1', agent: 'tester', inner: 'tool_start', data: { id: 'y', name: 'run_command', args: { command: 'pytest' } } });
    at(3000);
    r.approvalAsked('a', 'Edit file', 'write');
    const t = r.finish('stopped');
    const sub = t.entries.find((e) => e.kind === 'subagent')!;
    assert.strictEqual(sub.name, 'tester · Add a test');
    assert.strictEqual(sub.status, 'cancelled');
    const childModel = t.entries.find((e) => e.kind === 'model' && e.depth === 1)!;
    assert.deepStrictEqual([childModel.agent, childModel.firstTokenMs, childModel.end], ['tester · Add a test', 500, 700]);
    const write = t.entries.find((e) => e.name === 'write_file')!;
    assert.deepStrictEqual([write.depth, write.status, write.end], [1, 'ok', 900]);
    const pytest = t.entries.find((e) => e.name === 'run_command')!;
    assert.deepStrictEqual([pytest.status, pytest.end], ['cancelled', 3000]);
    assert.strictEqual(t.entries.find((e) => e.kind === 'approval')!.status, 'cancelled');
    assert.strictEqual(t.entries.find((e) => e.name === 'run_subagent')!.status, 'cancelled');
    assert.strictEqual(t.outcome, 'stopped');
    // Finished traces ignore late events.
    ev('tool_start', { id: 'late', name: 'read_file' });
    assert.ok(!t.entries.some((e) => e.name === 'read_file'));
  });

  test('a runaway run keeps its first rows and says how many were dropped; errors are rows of their own', () => {
    const { r, ev } = recorder();
    ev('error', { message: 'Model stopped responding' });
    for (let i = 0; i < MAX_TRACE_ENTRIES + 5; i++) {
      ev('tool_start', { id: `c${i}`, name: 'grep_search', args: { query: 'x' } });
    }
    const t = r.finish('error');
    assert.strictEqual(t.entries[0].kind, 'error');
    assert.strictEqual(t.entries[0].detail, 'Model stopped responding');
    assert.strictEqual(t.entries.length, MAX_TRACE_ENTRIES + 1);
    assert.match(t.entries[t.entries.length - 1].name, /^6 more events not kept$/);
  });

  test('tool details pick the main argument and stay on one short line', () => {
    assert.strictEqual(toolDetail({ command: 'npm   test\n  --watch' }), 'npm test --watch');
    assert.strictEqual(toolDetail({ files: [{ path: 'a.ts' }, { path: 'b.ts' }] }), 'a.ts, b.ts');
    assert.strictEqual(toolDetail({ other: 1 }), undefined);
    assert.ok((toolDetail({ query: 'x'.repeat(500) }) ?? '').length <= 160);
  });

  test('the export is JSON with absolute times, durations and totals', () => {
    const { r, at, ev } = recorder();
    ev('tool_start', { id: 'c', name: 'read_file', args: { path: 'a' } });
    at(250);
    ev('tool_end', { id: 'c', isError: false });
    const parsed = JSON.parse(traceExport(r.finish('ok'))) as { totals: { toolCalls: number }; startedAtIso: string; entries: { at: string; durationMs: number }[] };
    assert.strictEqual(parsed.totals.toolCalls, 1);
    assert.strictEqual(parsed.startedAtIso, new Date(1_000_000).toISOString());
    assert.strictEqual(parsed.entries[0].durationMs, 250);
    assert.strictEqual(parsed.entries[0].at, new Date(1_000_000).toISOString());
  });

  test('the store keeps the last traces of each chat on disk, survives a new instance and forgets deleted chats', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lp-traces-'));
    try {
      const mk = (id: string, sid = 's1') => new RunTraceRecorder({ id, sessionId: sid, title: id, now: 1 }, () => 2).finish('ok');
      const store = new TraceStore(dir, 3);
      for (const id of ['a', 'b', 'c', 'd']) {
        await store.add(mk(id));
      }
      await store.add(mk('z', 's2'));
      assert.deepStrictEqual((await store.list('s1')).map((t) => t.id), ['b', 'c', 'd'], 'oldest dropped');
      const again = new TraceStore(dir, 3);
      assert.strictEqual((await again.get('s1', 'c'))?.title, 'c');
      assert.strictEqual(await again.get('s1', 'a'), undefined);
      await again.forget('s1');
      assert.ok(!fs.existsSync(path.join(dir, 's1.json')));
      assert.ok(fs.existsSync(path.join(dir, 's2.json')));
      // An id that would name a path outside the folder is kept in memory only.
      const evil = new TraceStore(dir);
      await evil.add(mk('x', '../escape'));
      assert.ok(!fs.existsSync(path.join(dir, '..', 'escape.json')));
      assert.strictEqual((await evil.get('../escape', 'x'))?.id, 'x');
    } finally {
      removeTemp(dir);
    }
  });
});
