import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import { ChangeTracker, kindOf } from '../agent/changeTracker';
import { mergeFragment, planCodeApply } from '../agent/codeApplyPlan';
import { applyCodeBlock, CodeApplyDeps } from '../ui/codeBlockApply';

suite('Code block Apply: what it does to the file', () => {
  const file = ['import random', '', 'def roll(sides):', '    return random.randint(1, sides)', '', 'def roll_many(n, sides):', '    out = []', '    for _ in range(n):', '        out.append(roll(sides))', '    return out', '', 'def main():', '    print(roll_many(3, 6))', ''].join('\n');

  test('a missing file is created with a final newline', () => {
    assert.deepStrictEqual(planCodeApply(undefined, 'x = 1'), { kind: 'create', text: 'x = 1\n' });
  });

  test('a block equal to the file (trailing space aside) changes nothing', () => {
    assert.deepStrictEqual(planCodeApply('a\nb\n', 'a  \nb\n\n'), { kind: 'same' });
  });

  test('a block that looks like the whole file replaces it, keeping the file\'s line endings', () => {
    const p = planCodeApply('one\r\ntwo\r\nthree\r\n', 'one\nTWO\nthree');
    assert.deepStrictEqual(p, { kind: 'replace', text: 'one\r\nTWO\r\nthree\r\n' });
  });

  test('an indentation-scoped fragment (a Python function) replaces that function only', () => {
    const p = planCodeApply(file, 'def roll_many(n, sides):\n    return [roll(sides) for _ in range(n)]\n');
    assert.strictEqual(p.kind, 'merge');
    if (p.kind !== 'merge') {
      return;
    }
    assert.deepStrictEqual([p.from, p.to], [5, 9]);
    assert.strictEqual(p.text, file.replace('    out = []\n    for _ in range(n):\n        out.append(roll(sides))\n    return out', '    return [roll(sides) for _ in range(n)]'));
  });

  test('a brace-scoped fragment ends at its closing brace at the same depth, and a dedented method is re-indented', () => {
    const ts = ['export class Dice {', '  roll(sides: number): number {', '    if (sides < 1) {', '      throw new Error("bad");', '    }', '    return 1 + Math.floor(Math.random() * sides);', '  }', '', '  many(n: number) {', '    return [];', '  }', '}', ''].join('\n');
    const block = 'roll(sides: number): number {\n  return sides;\n}';
    const r = mergeFragment(ts.split('\n').slice(0, -1), block.split('\n'));
    assert.ok(r);
    assert.deepStrictEqual([r.from, r.to], [1, 6], 'the inner brace at line 4 is not mistaken for the end');
    assert.deepStrictEqual(r.lines.slice(0, 5), ['export class Dice {', '  roll(sides: number): number {', '    return sides;', '  }', '']);
  });

  test('a fragment whose first line is ambiguous or missing is left to the user', () => {
    assert.deepStrictEqual(planCodeApply(file, '    out.append(x)\n    return out\n'), { kind: 'partial' });
    assert.deepStrictEqual(planCodeApply(file, '    return out\n'), { kind: 'same' }, 'a one-line fragment already in the file');
    assert.deepStrictEqual(planCodeApply(file, 'def nowhere():\n    pass\n'), { kind: 'partial' });
    assert.deepStrictEqual(planCodeApply(`${file}\ndef roll(sides):\n    pass\n`, 'def roll(sides):\n    return 6\n'), { kind: 'partial' }, 'two matches: no guess');
  });
});

suite('Code block Apply: writes go through the change tracker', function () {
  this.timeout(30_000);
  let tracker: ChangeTracker;
  let dir: string;
  let root: string;
  const sid = 'code-apply-session';
  let toasts: { level: string; text: string; review?: string }[];
  let asked: string[];

  const deps = (over: Partial<CodeApplyDeps> = {}): CodeApplyDeps => ({
    tracker,
    root,
    canAskAgent: true,
    askAgent: async (t) => {
      asked.push(t);
    },
    toast: (level, text, action) => toasts.push({ level, text, review: action?.fsPath }),
    ...over,
    ui: { confirmApply: async () => true, confirmPath: async (rel) => rel, pickPartial: async () => 'agent', ...over.ui },
  });

  setup(async () => {
    root = vscode.workspace.workspaceFolders![0].uri.fsPath;
    dir = await fs.mkdtemp(path.join(root, '.lp-code-apply-'));
    tracker = new ChangeTracker(vscode.window.createOutputChannel('lp-code-apply-test', { log: true }));
    tracker.beginTurn(sid, 3);
    toasts = [];
    asked = [];
  });

  teardown(async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    tracker.dispose();
    await fs.rm(dir, { recursive: true, force: true });
  });

  const rel = (p: string) => path.relative(root, p).split(path.sep).join('/');

  test('Create: the confirmed path is created, recorded as an added file in review and in the turn checkpoint', async () => {
    const target = path.join(dir, 'pkg', 'new_mod.py');
    let confirmed = '';
    const out = await applyCodeBlock({ sessionId: sid, code: 'X = 1', path: rel(target), create: true }, deps({ ui: { confirmPath: async (r) => ((confirmed = r), r) } }));
    assert.strictEqual(out, 'created');
    assert.strictEqual(confirmed, rel(target), 'the path is offered for confirmation');
    assert.strictEqual(await fs.readFile(target, 'utf8'), 'X = 1\n');
    const [c] = tracker.forSession(sid);
    assert.strictEqual(c.fsPath, target);
    assert.strictEqual(kindOf(c), 'create');
    assert.ok(tracker.turnOriginals(sid, 3).has(target), 'part of the latest message\'s checkpoint');
    assert.strictEqual(toasts[toasts.length - 1]?.review, target, 'the toast offers Review');
  });

  test('Create can be renamed in the confirmation, and cancelling writes nothing', async () => {
    const target = path.join(dir, 'a.ts');
    const renamed = path.join(dir, 'lib', 'b.ts');
    assert.strictEqual(await applyCodeBlock({ sessionId: sid, code: 'x', path: rel(target) }, deps({ ui: { confirmPath: async () => undefined } })), 'cancelled');
    await assert.rejects(fs.stat(target));
    assert.strictEqual(tracker.forSession(sid).length, 0);
    assert.strictEqual(await applyCodeBlock({ sessionId: sid, code: 'x', path: rel(target) }, deps({ ui: { confirmPath: async () => rel(renamed) } })), 'created');
    assert.strictEqual(await fs.readFile(renamed, 'utf8'), 'x\n');
    await assert.rejects(fs.stat(target));
  });

  test('Apply to an existing file is confirmed first, then tracked as a modification with the old content as original', async () => {
    const target = path.join(dir, 'dice.py');
    await fs.writeFile(target, 'a = 1\nb = 2\n');
    let question = '';
    assert.strictEqual(await applyCodeBlock({ sessionId: sid, code: 'a = 1\nb = 3\n', path: rel(target) }, deps({ ui: { confirmApply: async (_r, q) => ((question = q), false) } })), 'cancelled');
    assert.match(question, /Replace the contents of .*dice\.py/);
    assert.strictEqual(await fs.readFile(target, 'utf8'), 'a = 1\nb = 2\n', 'declined: untouched');
    assert.strictEqual(tracker.forSession(sid).length, 0);
    assert.strictEqual(await applyCodeBlock({ sessionId: sid, code: 'a = 1\nb = 3\n', path: rel(target) }, deps()), 'replaced');
    assert.strictEqual(await fs.readFile(target, 'utf8'), 'a = 1\nb = 3\n');
    const [c] = tracker.forSession(sid);
    assert.strictEqual(c.original, 'a = 1\nb = 2\n');
    assert.strictEqual(kindOf(c), 'modify');
    // Reject restores the file like any agent edit.
    await tracker.reject(sid, target);
    assert.strictEqual(await fs.readFile(target, 'utf8'), 'a = 1\nb = 2\n');
  });

  test('a fragment that cannot be placed asks: the agent gets a merge request, or the whole file is replaced', async () => {
    const target = path.join(dir, 'm.py');
    const body = Array.from({ length: 20 }, (_, i) => `v${i} = ${i}`).join('\n') + '\n';
    await fs.writeFile(target, body);
    assert.strictEqual(await applyCodeBlock({ sessionId: sid, code: 'def helper():\n    return 1\n', path: rel(target), lang: 'python' }, deps()), 'asked-agent');
    assert.match(asked[0], /^Merge this code block into .*m\.py/);
    assert.match(asked[0], /```python\ndef helper\(\):\n {4}return 1\n```/);
    assert.strictEqual(await fs.readFile(target, 'utf8'), body, 'nothing written by the chat itself');
    assert.strictEqual(await applyCodeBlock({ sessionId: sid, code: 'def helper():\n    return 1\n', path: rel(target) }, deps({ ui: { pickPartial: async () => 'replace' } })), 'replaced');
    assert.strictEqual(await fs.readFile(target, 'utf8'), 'def helper():\n    return 1\n');
  });

  test('paths outside the workspace and blocks without a chat are refused', async () => {
    assert.strictEqual(await applyCodeBlock({ sessionId: sid, code: 'x', path: path.join(path.dirname(root), 'outside.txt') }, deps()), 'failed');
    assert.strictEqual(await applyCodeBlock({ code: 'x', path: 'a.txt' }, deps()), 'failed');
    assert.ok(toasts.every((t) => t.level === 'error'));
  });

  test('no path: the active editor\'s file is the target', async () => {
    const target = path.join(dir, 'active.txt');
    await fs.writeFile(target, 'old\n');
    const doc = await vscode.workspace.openTextDocument(target);
    assert.strictEqual(await applyCodeBlock({ sessionId: sid, code: 'new\n' }, deps({ activeDocument: doc })), 'replaced');
    assert.strictEqual(await fs.readFile(target, 'utf8'), 'new\n');
    assert.strictEqual(tracker.forSession(sid)[0].fsPath, target);
  });
});
