import * as assert from 'assert';
import { toDecision } from '../agent/approvalLevel';
import { summarizeTests } from '../agent/healing/parsers/testSummary';
import { CONTINUE_PROMPT, toolFailurePrompt } from '../agent/runActions';

suite('Run card actions', () => {
  test('a failed step becomes a plain request the agent can act on', () => {
    const edit = JSON.stringify({ path: 'src/utils.py', old_text: 'a', new_text: 'b' });
    assert.match(toolFailurePrompt({ action: 'retry', tool: 'edit_file', args: edit, error: 'old_text not found in src/utils.py\nmore' })!, /^The step `edit_file` on src\/utils\.py failed \(old_text not found in src\/utils\.py\)\. Try it again/);
    assert.match(toolFailurePrompt({ action: 'skip', tool: 'edit_file', args: edit })!, /^Skip the failed step `edit_file` on src\/utils\.py/);
    const cmd = JSON.stringify({ command: 'npm test' });
    assert.match(toolFailurePrompt({ action: 'rerun', tool: 'run_command', args: cmd })!, /Run the command `npm test` again exactly as written/);
    assert.match(toolFailurePrompt({ action: 'edit', tool: 'run_command', args: 'npm test -- --runInBand' })!, /```sh\nnpm test -- --runInBand\n```/);
    assert.match(toolFailurePrompt({ action: 'edit', tool: 'edit_file', args: '{"path":"a.ts"}' })!, /```json\n\{"path":"a\.ts"\}\n```/);
    assert.strictEqual(toolFailurePrompt({ action: 'edit', tool: 'run_command', args: '   ' }), undefined, 'an empty edit sends nothing');
    assert.match(toolFailurePrompt({ action: 'retry', tool: 'run_subagent', args: JSON.stringify({ agent: 'tester', prompt: 'Add tests for d20' }) })!, /Delegate it again with run_subagent to the tester agent, with this task:\nAdd tests for d20/);
  });

  test('test actions name the failing tests', () => {
    const cmd = JSON.stringify({ command: 'python -m pytest -q' });
    assert.match(toolFailurePrompt({ action: 'rerunFailed', tool: 'run_command', args: cmd, tests: ['test_spaces (tests/test_dice.py:31): AssertionError'] })!, /Re-run only the failing tests \(test_spaces\) of the command `python -m pytest -q`/);
    assert.match(toolFailurePrompt({ action: 'fixFailures', tool: 'run_command', args: cmd, tests: ['test_spaces (tests/test_dice.py:31): AssertionError'] })!, /- test_spaces \(tests\/test_dice\.py:31\): AssertionError/);
    assert.match(CONTINUE_PROMPT, /where you left off/);
  });

  test('an edited command survives the approval decision; a denial keeps only its reason', () => {
    assert.deepStrictEqual(toDecision({ ok: true, edited: '  npm ci  ' }), { ok: true, edited: 'npm ci' });
    assert.deepStrictEqual(toDecision({ ok: false, edited: 'npm ci' }), { ok: false });
    assert.deepStrictEqual(toDecision({ ok: true, edited: '  ' }), { ok: true });
  });
});

suite('Test run summaries', () => {
  test('pytest counts and the failing test', () => {
    const out = '.....F.\n=================================== FAILURES ===================================\n_________________________________ test_spaces __________________________________\n\n    def test_spaces():\n>       assert roll_dice("2d10 - 1") == 5\nE       AssertionError: assert 0 == 5\n\ntests/test_dice.py:31: AssertionError\n=========================== short test summary info ============================\nFAILED tests/test_dice.py::test_spaces - AssertionError: assert 0 == 5\n========================= 1 failed, 6 passed, 2 skipped in 0.31s =========================\n';
    const t = summarizeTests(out, '/repo', 'python -m pytest -q')!;
    assert.deepStrictEqual({ p: t.passed, f: t.failed, s: t.skipped, r: t.runner }, { p: 6, f: 1, s: 2, r: 'pytest' });
    assert.ok(t.failures.length >= 1 && /test_spaces/.test(t.failures[0].name), JSON.stringify(t.failures));
  });

  test('jest, vitest, mocha, cargo, dotnet, junit and go summaries', () => {
    const c = (o: string) => { const t = summarizeTests(o, '/repo'); return t && [t.runner, t.passed, t.failed, t.skipped]; };
    assert.deepStrictEqual(c('Tests:       1 failed, 2 skipped, 6 passed, 9 total\n'), ['jest', 6, 1, 2]);
    assert.deepStrictEqual(c(' Test Files  1 failed (1)\n      Tests  1 failed | 6 passed (7)\n'), ['vitest', 6, 1, 0]);
    assert.deepStrictEqual(c('  6 passing (12ms)\n  2 pending\n  1 failing\n'), ['mocha', 6, 1, 2]);
    assert.deepStrictEqual(c('test result: FAILED. 6 passed; 1 failed; 0 ignored; 0 measured\ntest result: ok. 2 passed; 0 failed; 1 ignored; 0 measured\n'), ['cargo', 8, 1, 1]);
    assert.deepStrictEqual(c('Failed!  - Failed:     1, Passed:     6, Skipped:     0, Total:     7, Duration: 1 s'), ['dotnet', 6, 1, 0]);
    assert.deepStrictEqual(c('[ERROR] Tests run: 7, Failures: 1, Errors: 0, Skipped: 1'), ['junit', 5, 1, 1]);
    assert.deepStrictEqual(c('=== RUN   TestA\n--- PASS: TestA (0.00s)\n=== RUN   TestB\n--- FAIL: TestB (0.00s)\n'), ['go', 1, 1, 0]);
  });

  test('output without a test summary is not a test run', () => {
    assert.strictEqual(summarizeTests('Compiled successfully in 2.1s\n', '/repo'), undefined);
    assert.strictEqual(summarizeTests('', '/repo'), undefined);
  });
});
