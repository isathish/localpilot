import * as assert from 'assert';
import { EXIT, exitCodeFor, finishReasonFor } from '../cli/headless';
import { eventRecord, NdjsonWriter } from '../cli/ndjson';

function sink(): { stream: NodeJS.WritableStream; lines: () => Record<string, unknown>[] } {
  const chunks: string[] = [];
  const stream = { write: (s: string) => { chunks.push(s); return true; } } as unknown as NodeJS.WritableStream;
  return { stream, lines: () => chunks.join('').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>) };
}

suite('CLI outcome exit codes', () => {
  test('outcomes map to exit codes', () => {
    assert.strictEqual(EXIT.incomplete, 4);
    assert.strictEqual(EXIT.blocked, 5);
    assert.strictEqual(exitCodeFor({ outcome: 'completed' }), 0);
    assert.strictEqual(exitCodeFor({ outcome: 'completed_unverified' }), 0);
    assert.strictEqual(exitCodeFor({ outcome: 'completed_unverified', requireVerified: true }), 4);
    assert.strictEqual(exitCodeFor({ outcome: 'incomplete' }), 4);
    assert.strictEqual(exitCodeFor({ outcome: 'blocked', error: 'x' }), 5);
    assert.strictEqual(exitCodeFor({ outcome: 'failed', error: 'boom' }), 1);
    assert.strictEqual(exitCodeFor({ outcome: 'failed' }), 1);
    assert.strictEqual(exitCodeFor({ outcome: 'cancelled' }), 130);
  });

  test('timeout, stop and mistake limit win over the outcome', () => {
    assert.strictEqual(exitCodeFor({ outcome: 'blocked', timedOut: true }), 124);
    assert.strictEqual(exitCodeFor({ outcome: 'incomplete', aborted: true }), 130);
    assert.strictEqual(exitCodeFor({ outcome: 'incomplete', errorKind: 'mistake_limit', error: 'x' }), 3);
  });

  test('finish reasons', () => {
    assert.strictEqual(finishReasonFor({ outcome: 'blocked' }), 'blocked');
    assert.strictEqual(finishReasonFor({ outcome: 'incomplete' }), 'incomplete');
    assert.strictEqual(finishReasonFor({ outcome: 'completed_unverified' }), 'completed');
    assert.strictEqual(finishReasonFor({ outcome: 'completed_unverified', requireVerified: true }), 'incomplete');
    assert.strictEqual(finishReasonFor({ outcome: 'incomplete', timedOut: true }), 'timeout');
    assert.strictEqual(finishReasonFor({ outcome: 'failed', error: 'x' }), 'error');
    assert.strictEqual(finishReasonFor({ outcome: 'failed' }), 'error');
    assert.strictEqual(finishReasonFor({ outcome: 'cancelled' }), 'aborted');
  });

  test('run_result carries outcome and contract only when present', () => {
    const out = sink();
    const w = new NdjsonWriter(out.stream, sink().stream, () => 7);
    const base = { finishReason: 'incomplete' as const, text: 't', usage: { promptTokens: 0, completionTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, requests: 0 }, durationMs: 1, model: 'm', sessionId: 's' };
    w.result(base);
    w.result({ ...base, outcome: 'incomplete', contract: { requirementsSatisfied: 'passed', codeChangesApplied: 'passed', compilationPassed: 'failed', testsPassed: 'skipped', lintPassed: 'n/a', securityChecksPassed: 'n/a', regressionChecksPassed: 'n/a', approvalRequirementsSatisfied: 'passed', unresolved: [], outstandingRecovery: false, checksModified: [] } as never });
    const [a, b] = out.lines();
    assert.ok(!('outcome' in a) && !('contract' in a));
    assert.strictEqual(b.outcome, 'incomplete');
    assert.strictEqual((b.contract as Record<string, unknown>).compilationPassed, 'failed');
    assert.strictEqual(b.type, 'run_result');
  });

  test('recovery events stream as NDJSON', () => {
    const rec = eventRecord({ type: 'recovery', payload: { phase: 'diagnosing', attempt: 1 } } as never, 3);
    assert.deepStrictEqual(rec, { type: 'recovery', ts: 3, phase: 'diagnosing', attempt: 1 });
    const out = sink();
    new NdjsonWriter(out.stream, sink().stream, () => 1).event({ type: 'recovery', payload: { phase: 'verifying' } } as never);
    assert.strictEqual(out.lines()[0].type, 'recovery');
  });
});
