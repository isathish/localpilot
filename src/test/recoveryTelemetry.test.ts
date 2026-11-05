import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { eventMetrics, eventRecord } from '../telemetry/otlp';
import { recoveryRate, summarize, Telemetry } from '../telemetry/telemetry';
import type { MetricAttributes, TelemetryEvent } from '../telemetry/telemetry';

const T = Date.UTC(2026, 10, 5, 12);
const range = { days: 1, from: T - 3_600_000, to: T + 3_600_000 };
const SIG_A = '0123456789abcdef';
const SIG_B = 'fedcba9876543210';

const ev = (i: number, e: Omit<Extract<TelemetryEvent, { type: 'recovery' }>, 't' | 'type' | 'sid'>): TelemetryEvent => ({ type: 'recovery', t: T + i * 1000, sid: 's1', ...e });

suite('Recovery telemetry', () => {
  test('the empty summary carries zeroed recovery fields', () => {
    const r = summarize([], range).recovery;
    assert.deepStrictEqual(r, {
      detected: 0, recovered: 0, escalated: 0, blocked: 0, exhausted: 0, rate: 0,
      mttr: { p50: 0, p95: 0, avg: 0 }, byCategory: [], topSignatures: [], memory: { suggested: 0, succeeded: 0 }, recent: [], acceptedRisks: 0,
    });
  });

  test('aggregates detections, outcomes, rate, MTTR, signatures and memory', () => {
    const s = summarize(
      [
        ev(0, { action: 'detected', category: 'typescript', severity: 'high', signature: SIG_A }),
        ev(1, { action: 'memory_hit', category: 'typescript', signature: SIG_A }),
        ev(2, { action: 'fix_attempt', category: 'typescript', signature: SIG_A, attempt: 1, max: 3 }),
        ev(3, { action: 'recovered', category: 'typescript', signature: SIG_A, attempt: 1, durationMs: 4000, outcome: 'memory' }),
        ev(4, { action: 'detected', category: 'unit_test', signature: SIG_B }),
        ev(5, { action: 'escalated', category: 'unit_test', signature: SIG_B, attempt: 3 }),
        ev(6, { action: 'detected', category: 'dependency', signature: 'TS2345@src/api/user.ts' }),
        ev(7, { action: 'blocked', category: 'dependency' }),
        ev(8, { action: 'detected', category: 'security', signature: SIG_A }),
        ev(9, { action: 'accept_risk', category: 'security', signature: SIG_A }),
        { type: 'task', t: T + 10_000, sid: 's1', action: 'completed_unverified', mode: 'agent' },
        { type: 'task', t: T + 11_000, sid: 's1', action: 'incomplete', mode: 'agent' },
        { type: 'task', t: T + 12_000, sid: 's1', action: 'blocked', mode: 'agent' },
      ],
      range
    );
    const r = s.recovery;
    assert.strictEqual(r.detected, 4);
    assert.strictEqual(r.recovered, 1);
    assert.strictEqual(r.escalated, 1);
    assert.strictEqual(r.blocked, 1);
    assert.strictEqual(r.exhausted, 0);
    assert.strictEqual(r.rate, recoveryRate({ recovered: 1, escalated: 1, exhausted: 0, blocked: 1 }));
    assert.strictEqual(r.rate, 33.3);
    assert.strictEqual(r.mttr.p50, 4000);
    assert.deepStrictEqual(r.memory, { suggested: 1, succeeded: 1 });
    assert.strictEqual(r.acceptedRisks, 1);
    assert.deepStrictEqual(r.topSignatures, [
      { signature: SIG_A, count: 2, recovered: 1 },
      { signature: SIG_B, count: 1, recovered: 0 },
    ]);
    assert.ok(!JSON.stringify(r).includes('src/api'), 'a human key never reaches the summary');
    const ts = r.byCategory.find((c) => c.category === 'typescript');
    assert.deepStrictEqual(ts && { detected: ts.detected, recovered: ts.recovered, p50: ts.attempts.p50 }, { detected: 1, recovered: 1, p50: 1 });
    assert.strictEqual(r.recent.length, 10);
    assert.strictEqual(r.recent[0].action, 'accept_risk');
    assert.ok(s.errors.some((e) => e.kind === 'run' && /unit_test escalated after 3 attempts/.test(e.detail)));
    assert.deepStrictEqual(s.activity.tasks, { created: 0, completed: 0, aborted: 0, failed: 0, mistakeLimit: 0, incomplete: 1, blocked: 1, unverified: 1 });
  });

  test('recovery rate is 0 with no ended episodes', () => {
    assert.strictEqual(recoveryRate({ recovered: 0, escalated: 0, exhausted: 0, blocked: 0 }), 0);
    assert.strictEqual(recoveryRate({ recovered: 2, escalated: 0, exhausted: 0, blocked: 0 }), 100);
  });

  test('OTLP metrics carry names and outcomes, never the signature', () => {
    const counters: [string, number, MetricAttributes | undefined][] = [];
    const histograms: [string, number, MetricAttributes | undefined][] = [];
    const e = ev(0, { action: 'recovered', category: 'typescript', signature: SIG_A, durationMs: 1200, outcome: 'fixed' });
    eventMetrics(e, { add: (n, v, a) => void counters.push([n, v, a]), record: (n, v, a) => void histograms.push([n, v, a]) });
    assert.deepStrictEqual(counters.find((c) => c[0] === 'localpilot.recovery.events')?.[2], { action: 'recovered', category: 'typescript' });
    assert.deepStrictEqual(counters.find((c) => c[0] === 'localpilot.recovery.outcomes')?.[2], { outcome: 'fixed' });
    assert.deepStrictEqual(histograms, [['localpilot.recovery.duration_ms', 1200, { category: 'typescript' }]]);
    assert.ok(!JSON.stringify([counters, histograms]).includes(SIG_A));
    assert.ok(!(JSON.stringify(eventRecord(e).attributes)).includes(SIG_A), 'the exported log record drops the signature');
    const quiet: string[] = [];
    eventMetrics(ev(0, { action: 'detected', category: 'lint' }), { add: (n) => void quiet.push(n), record: (n) => void quiet.push(n) });
    assert.deepStrictEqual(quiet, ['localpilot.events', 'localpilot.recovery.events']);
  });
  test('a human-key signature is dropped before it is stored or broadcast', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lp-recovery-tel-'));
    const t = new Telemetry({ dir, retentionDays: () => 0 });
    const heard: TelemetryEvent[] = [];
    t.onEvent((e) => heard.push(e));
    try {
      t.record({ type: 'recovery', sid: 's1', action: 'detected', category: 'typescript', signature: 'TS2345@src/api/user.ts' });
      t.record({ type: 'recovery', sid: 's1', action: 'detected', category: 'typescript', signature: SIG_A });
      await t.flush();
      const stored = (await t.events(0)).filter((e) => e.type === 'recovery');
      for (const list of [heard, stored]) {
        assert.strictEqual(list.length, 2);
        assert.ok(!('signature' in list[0]), 'the human key is never kept');
        assert.strictEqual((list[1] as Extract<TelemetryEvent, { type: 'recovery' }>).signature, SIG_A);
      }
      assert.ok(!JSON.stringify(stored).includes('src/api'));
    } finally {
      t.dispose();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
