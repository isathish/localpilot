import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import { ChangeTracker, REDO_WINDOW_MS } from '../agent/changeTracker';

suite('change tracker (restore checkpoint)', () => {
  let tracker: ChangeTracker;
  let dir: string;
  const sid = 'ct-test-session';
  const read = (f: string) => fs.readFile(f, 'utf8');

  setup(async () => {
    const root = vscode.workspace.workspaceFolders![0].uri.fsPath;
    dir = await fs.mkdtemp(path.join(root, '.lp-ct-test-'));
    tracker = new ChangeTracker(vscode.window.createOutputChannel('lp-ct-test', { log: true }));
  });

  teardown(async () => {
    tracker.dispose();
    await fs.rm(dir, { recursive: true, force: true });
  });

  test('restoring a turn reverts only that turn and later ones', async () => {
    const a = path.join(dir, 'a.txt');
    const b = path.join(dir, 'b.txt');
    await fs.writeFile(a, 'A0');
    await fs.writeFile(b, 'B0');
    tracker.beginTurn(sid, 1);
    await tracker.beforeChange(a, sid);
    await fs.writeFile(a, 'A1');
    tracker.beginTurn(sid, 2);
    await tracker.beforeChange(b, sid);
    await fs.writeFile(b, 'B2');
    assert.strictEqual(await tracker.restoreToTurn(sid, 2), 1);
    assert.strictEqual(await read(b), 'B0');
    assert.strictEqual(await read(a), 'A1', 'the earlier turn is untouched');
  });

  test('forget drops older snapshots so a later restore does not touch them', async () => {
    const c = path.join(dir, 'c.txt');
    const d = path.join(dir, 'd.txt');
    await fs.writeFile(d, 'D0');
    tracker.beginTurn(sid, 1);
    await tracker.beforeChange(c, sid);
    await fs.writeFile(c, 'C1');
    tracker.forget(sid);
    tracker.beginTurn(sid, 2);
    await tracker.beforeChange(d, sid);
    await fs.writeFile(d, 'D2');
    assert.strictEqual(await tracker.restoreToTurn(sid, 2), 1);
    assert.strictEqual(await read(d), 'D0');
    assert.strictEqual(await read(c), 'C1', 'the file created before forget still exists');
  });

  test('redo after a reject puts the agent\'s content back and tracks the file again', async () => {
    const e = path.join(dir, 'e.txt');
    const f = path.join(dir, 'f.txt');
    await fs.writeFile(e, 'E0');
    tracker.beginTurn(sid, 1);
    await tracker.beforeChange(e, sid);
    await fs.writeFile(e, 'E1');
    await tracker.beforeChange(f, sid);
    await fs.writeFile(f, 'F1');
    const { count, token } = await tracker.reject(sid);
    assert.strictEqual(count, 2);
    assert.strictEqual(await read(e), 'E0');
    await assert.rejects(fs.stat(f), 'the file the agent created is gone after the reject');
    assert.strictEqual(await tracker.redo(token!), 2);
    assert.strictEqual(await read(e), 'E1');
    assert.strictEqual(await read(f), 'F1');
    assert.deepStrictEqual(tracker.forSession(sid).map((c) => path.basename(c.fsPath)), ['e.txt', 'f.txt']);
    assert.strictEqual(await tracker.redo(token!), 0, 'a second redo has nothing left');
  });

  test('redo is a no-op once the window has passed', async () => {
    const g = path.join(dir, 'g.txt');
    await fs.writeFile(g, 'G0');
    tracker.beginTurn(sid, 1);
    await tracker.beforeChange(g, sid);
    await fs.writeFile(g, 'G1');
    let now = Date.now();
    tracker.now = () => now;
    const { count, token } = await tracker.reject(sid, g);
    assert.strictEqual(count, 1);
    now += REDO_WINDOW_MS + 1;
    assert.strictEqual(await tracker.redo(token!), 0);
    assert.strictEqual(await read(g), 'G0');
    assert.strictEqual(tracker.forSession(sid).length, 0);
  });

  test('each reject keeps its own redo: undoing an earlier one leaves a later one reverted', async () => {
    const a = path.join(dir, 'ra.txt');
    const b = path.join(dir, 'rb.txt');
    await fs.writeFile(a, 'A0');
    await fs.writeFile(b, 'B0');
    tracker.beginTurn(sid, 1);
    await tracker.beforeChange(a, sid);
    await fs.writeFile(a, 'A1');
    await tracker.beforeChange(b, sid);
    await fs.writeFile(b, 'B1');
    const ra = await tracker.reject(sid, a);
    const rb = await tracker.reject(sid, b);
    assert.notStrictEqual(ra.token, rb.token);
    assert.strictEqual(await tracker.redo(ra.token!), 1);
    assert.strictEqual(await read(a), 'A1');
    assert.strictEqual(await read(b), 'B0', 'the later reject is untouched');
    assert.deepStrictEqual(tracker.forSession(sid).map((c) => path.basename(c.fsPath)), ['ra.txt']);
    assert.strictEqual(await tracker.redo(rb.token!), 1, "the later reject's undo still works");
    assert.strictEqual(await read(b), 'B1');
  });
});
