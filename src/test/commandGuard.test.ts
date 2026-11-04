import * as assert from 'assert';
import { checkReadOnlyCommand } from '../agent/commandGuard';
import { COMMAND_GUARD_CASES } from './commandGuardCases';

suite('Plan/Ask mode command guard', () => {
  test(`${COMMAND_GUARD_CASES.length} commands are classified as read-only or mutating`, () => {
    const wrong: string[] = [];
    for (const [cmd, ok, windows] of COMMAND_GUARD_CASES) {
      const v = checkReadOnlyCommand(cmd, { windows: !!windows });
      if (v.ok !== ok) {
        wrong.push(`${JSON.stringify(cmd)}: expected ${ok ? 'allowed' : 'blocked'}${v.ok ? '' : ` (${v.reason})`}`);
      }
    }
    assert.deepStrictEqual(wrong, []);
  });

  test('a blocked command says why', () => {
    const v = checkReadOnlyCommand('git -C . commit -m x', { windows: false });
    assert.ok(!v.ok && /git commit/.test(v.reason));
    const r = checkReadOnlyCommand('echo a > f', { windows: false });
    assert.ok(!r.ok && /writes to a file/.test(r.reason));
  });

  test('Windows file commands are only blocked when checking for Windows', () => {
    assert.strictEqual(checkReadOnlyCommand('del x', { windows: false }).ok, true);
    assert.strictEqual(checkReadOnlyCommand('DEL x', { windows: true }).ok, false);
  });
});
