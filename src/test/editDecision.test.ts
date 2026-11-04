import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { ChangeTracker } from '../agent/changeTracker';
import { inlineEditDecision, measureEdits, setTelemetryRecorder } from '../telemetry/catalog';
import type { TelemetryInput } from '../telemetry/telemetry';

suite('Edit decisions', () => {
  let dir: string;
  suiteSetup(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lp-editdecision-'));
  });
  suiteTeardown(async () => {
    setTelemetryRecorder(undefined);
    await fs.rm(dir, { recursive: true, force: true });
  });

  test('inline edit decisions count the replaced lines, one file', () => {
    assert.deepStrictEqual(inlineEditDecision('rejected', 'a\nb\n', 'a\nB\nc\n'), { type: 'edit_decision', decision: 'rejected', added: 2, removed: 1, files: 1 });
    assert.deepStrictEqual(inlineEditDecision('accepted', 'x', 'x'), { type: 'edit_decision', decision: 'accepted', added: 0, removed: 0, files: 1 });
  });

  test('measureEdits prefers unsaved editor text over the disk copy', async () => {
    const file = path.join(dir, 'live.txt');
    await fs.writeFile(file, 'one\n');
    assert.deepStrictEqual(await measureEdits([{ fsPath: file, original: 'one\n', live: 'one\ntwo\n' }]), { added: 1, removed: 0, files: 1 });
    assert.deepStrictEqual(await measureEdits([{ fsPath: file, original: 'one\n' }]), { added: 0, removed: 0, files: 1 });
  });

  test('an unsaved in-buffer edit is measured on keep, and a reverted one records nothing', async () => {
    const file = path.join(dir, 'inline.txt');
    await fs.writeFile(file, 'alpha\nbeta\n');
    const seen: TelemetryInput[] = [];
    setTelemetryRecorder({ record: (e) => void seen.push(e) });
    const tracker = new ChangeTracker(vscode.window.createOutputChannel('LocalPilot edit decision test', { log: true }));
    const doc = await vscode.workspace.openTextDocument(file);
    try {
      const replace = async (from: string, to: string) => {
        const text = doc.getText();
        const at = text.indexOf(from);
        const we = new vscode.WorkspaceEdit();
        we.replace(doc.uri, new vscode.Range(doc.positionAt(at), doc.positionAt(at + from.length)), to);
        assert.ok(await vscode.workspace.applyEdit(we));
      };
      await tracker.beforeChange(file, 'inline_keep');
      await replace('beta', 'BETA\ngamma');
      tracker.keep('inline_keep');
      await new Promise((r) => setTimeout(r, 50));
      assert.deepStrictEqual(seen, [{ type: 'edit_decision', decision: 'accepted', added: 2, removed: 1, files: 1 }]);

      // The Undo path of inline edit: the buffer is reverted, the snapshot dropped silently, the rejection recorded once.
      seen.length = 0;
      await tracker.beforeChange(file, 'inline_undo');
      await replace('alpha', 'ALPHA');
      await replace('ALPHA', 'alpha');
      tracker.keep('inline_undo', undefined, false);
      await new Promise((r) => setTimeout(r, 50));
      assert.deepStrictEqual(seen, []);
      assert.strictEqual(tracker.forSession('inline_undo').length, 0);
    } finally {
      setTelemetryRecorder(undefined);
      await doc.save();
      tracker.dispose();
    }
  });

  test('restoreTurn reports files it could not restore and keeps their snapshots', async () => {
    const root = vscode.workspace.workspaceFolders![0].uri.fsPath;
    const work = await fs.mkdtemp(path.join(root, '.lp-restore-fail-'));
    const tracker = new ChangeTracker(vscode.window.createOutputChannel('LocalPilot restore test', { log: true }));
    const sid = 'restore-fail-session';
    try {
      const ok = path.join(work, 'ok.txt');
      const sub = path.join(work, 'sub');
      const blocked = path.join(sub, 'blocked.txt');
      await fs.mkdir(sub);
      await fs.writeFile(ok, 'O0');
      await fs.writeFile(blocked, 'B0');
      tracker.beginTurn(sid, 1);
      await tracker.beforeChange(ok, sid);
      await tracker.beforeChange(blocked, sid);
      await fs.writeFile(ok, 'O1');
      // A file where the folder was: the snapshot of sub/blocked.txt cannot be written back.
      await fs.rm(sub, { recursive: true });
      await fs.writeFile(sub, 'not a folder');
      assert.deepStrictEqual(await tracker.restoreTurn(sid, 1), { restored: 1, failed: 1 });
      assert.strictEqual(await fs.readFile(ok, 'utf8'), 'O0');
      await fs.rm(sub);
      assert.deepStrictEqual(await tracker.restoreTurn(sid, 1), { restored: 1, failed: 0 }, 'the failed file is retried');
      assert.strictEqual(await fs.readFile(blocked, 'utf8'), 'B0');
    } finally {
      tracker.dispose();
      await fs.rm(work, { recursive: true, force: true });
    }
  });
});
