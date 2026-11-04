import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import { ChangeTracker } from '../agent/changeTracker';

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
});
