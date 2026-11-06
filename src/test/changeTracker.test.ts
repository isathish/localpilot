import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import { AGENT_WRITE_MS, ChangeTracker, REDO_WINDOW_MS } from '../agent/changeTracker';

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
  test('accepts and rejects are listed for review until the next turn; Restore edits brings back one file of a reject', async () => {
    const a = path.join(dir, 'qa.txt');
    const b = path.join(dir, 'qb.txt');
    const c = path.join(dir, 'qc.txt');
    for (const [f, t] of [[a, 'A0'], [b, 'B0'], [c, 'C0']]) {
      await fs.writeFile(f, t);
    }
    tracker.beginTurn(sid, 1);
    for (const [f, t] of [[a, 'A1'], [b, 'B1'], [c, 'C1']]) {
      await tracker.beforeChange(f, sid);
      await fs.writeFile(f, t);
    }
    tracker.keep(sid, a);
    await tracker.reject(sid); // b and c in one reject
    const rows = tracker.reviewedFor(sid);
    assert.deepStrictEqual(rows.map((r) => `${path.basename(r.fsPath)}:${r.state}:${r.kind}`), ['qa.txt:accepted:modify', 'qb.txt:rejected:modify', 'qc.txt:rejected:modify']);
    assert.ok(rows[1].redoUntil && rows[1].redoUntil > Date.now(), 'a fresh reject can be restored');
    assert.strictEqual(rows[0].redoUntil, undefined);
    assert.strictEqual(await tracker.restoreRejected(sid, c), 1);
    assert.strictEqual(await read(c), 'C1');
    assert.strictEqual(await read(b), 'B0', 'the other file of the same reject stays rejected');
    assert.deepStrictEqual(tracker.forSession(sid).map((x) => path.basename(x.fsPath)), ['qc.txt']);
    assert.deepStrictEqual(tracker.reviewedFor(sid).map((r) => path.basename(r.fsPath)), ['qa.txt', 'qb.txt']);
    assert.strictEqual(await tracker.restoreRejected(sid, b), 1, 'the rest of the reject is still restorable');
    tracker.beginTurn(sid, 2);
    assert.deepStrictEqual(tracker.reviewedFor(sid), [], 'a new message starts a fresh review list');
  });

  test('undoing a review puts accepted files back in the queue and restores rejected ones', async () => {
    const a = path.join(dir, 'ua.txt');
    const b = path.join(dir, 'ub.txt');
    await fs.writeFile(a, 'A0');
    await fs.writeFile(b, 'B0');
    tracker.beginTurn(sid, 1);
    await tracker.beforeChange(a, sid);
    await fs.writeFile(a, 'A1');
    await tracker.beforeChange(b, sid);
    await fs.writeFile(b, 'B1');
    tracker.keep(sid, a);
    await tracker.reject(sid, b);
    assert.strictEqual(tracker.forSession(sid).length, 0);
    const r = await tracker.undoReview(sid);
    assert.deepStrictEqual(r, { accepted: 1, rejected: 1, expired: 0 });
    assert.deepStrictEqual(tracker.forSession(sid).map((x) => path.basename(x.fsPath)), ['ua.txt', 'ub.txt']);
    assert.strictEqual(await read(b), 'B1');
    assert.strictEqual(tracker.forSession(sid)[0].original, 'A0', 'the accepted file keeps its original for the diff');
    assert.deepStrictEqual(tracker.reviewedFor(sid), []);
    tracker.keep(sid);
    tracker.clearReviewed(sid);
    assert.deepStrictEqual(tracker.reviewedFor(sid), []);
  });

  test('a deleted file is listed as deleted, counts its removed lines and opens in a diff', async () => {
    const d = path.join(dir, 'gone.txt');
    await fs.writeFile(d, 'one\ntwo\nthree');
    tracker.beginTurn(sid, 1);
    await tracker.beforeChange(d, sid);
    await fs.rm(d);
    const [c] = tracker.forSession(sid);
    assert.deepStrictEqual(await tracker.lineStats(c), { added: 0, removed: 3 });
    assert.strictEqual(await tracker.showDiff(sid, d), true);
    tracker.keep(sid, d);
    assert.strictEqual(tracker.reviewedFor(sid)[0].kind, 'delete');
    assert.strictEqual(await tracker.showDiff(sid, d), false, 'nothing to show once it is no longer tracked');
  });

  test('line stats count added and removed lines against the original', async () => {
    const f = path.join(dir, 'stat.txt');
    await fs.writeFile(f, 'a\nb\nc\n');
    tracker.beginTurn(sid, 1);
    await tracker.beforeChange(f, sid);
    await fs.writeFile(f, 'a\nB\nc\nd\n');
    const [c] = tracker.forSession(sid);
    assert.deepStrictEqual(await tracker.lineStats(c), { added: 2, removed: 1 });
  });
  test('a user edit after the agent wrote a file marks it "edited by you" until the decision, and the decision keeps the mark', async () => {
    const g = path.join(dir, 'g.txt');
    const h = path.join(dir, 'h.txt');
    await fs.writeFile(g, 'G0');
    await fs.writeFile(h, 'H0');
    let clock = 1_000_000;
    tracker.now = () => clock;
    tracker.beginTurn(sid, 1);
    await tracker.beforeChange(g, sid);
    await fs.writeFile(g, 'G1');
    await tracker.beforeChange(h, sid);
    await fs.writeFile(h, 'H1');
    // Right after the agent's write the document change is the agent's own.
    assert.strictEqual(tracker.markUserEdited(g), false);
    assert.ok(!tracker.forSession(sid).find((c) => c.fsPath === g)!.userEdited);
    clock += AGENT_WRITE_MS + 1;
    assert.strictEqual(tracker.markUserEdited(g), true);
    assert.strictEqual(tracker.markUserEdited(g), false, 'already marked');
    assert.ok(tracker.forSession(sid).find((c) => c.fsPath === g)!.userEdited);
    assert.ok(!tracker.forSession(sid).find((c) => c.fsPath === h)!.userEdited, 'other files are untouched');
    assert.strictEqual(tracker.markUserEdited(path.join(dir, 'untracked.txt')), false, 'a file the agent did not change is not marked');
    tracker.keep(sid, g);
    await tracker.reject(sid, h);
    const rows = tracker.reviewedFor(sid);
    assert.deepStrictEqual(rows.map((r) => [path.basename(r.fsPath), r.state, !!r.userEdited]), [
      ['g.txt', 'accepted', true],
      ['h.txt', 'rejected', false],
    ]);
  });

  test('typing in the file in an editor (the review diff\'s right side) marks it "edited by you"', async () => {
    const m = path.join(dir, 'm.txt');
    await fs.writeFile(m, 'M0\n');
    tracker.beginTurn(sid, 1);
    await tracker.beforeChange(m, sid);
    await fs.writeFile(m, 'M1\n');
    const ed = await vscode.window.showTextDocument(vscode.Uri.file(m));
    tracker.now = () => Date.now() + AGENT_WRITE_MS + 1_000; // the agent's write is long past
    await ed.edit((b) => b.insert(new vscode.Position(0, 0), 'mine '));
    for (let i = 0; i < 20 && !tracker.forSession(sid)[0].userEdited; i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.ok(tracker.forSession(sid)[0].userEdited);
    await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
  });

  test('a reject restoring the file is not taken for a user edit', async () => {
    const k = path.join(dir, 'k.txt');
    await fs.writeFile(k, 'K0');
    let clock = 2_000_000;
    tracker.now = () => clock;
    tracker.beginTurn(sid, 1);
    await tracker.beforeChange(k, sid);
    await fs.writeFile(k, 'K1');
    clock += AGENT_WRITE_MS + 1;
    const { token } = await tracker.reject(sid, k);
    assert.strictEqual(await tracker.redo(token!), 1);
    // The redo just announced its own write: the change event it causes is ignored.
    assert.strictEqual(tracker.markUserEdited(k), false);
    assert.ok(!tracker.forSession(sid).find((c) => c.fsPath === k)!.userEdited);
    clock += AGENT_WRITE_MS + 1;
    assert.strictEqual(tracker.markUserEdited(k), true, 'a later edit by the user counts');
  });
});
