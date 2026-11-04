import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import { editFileTool, writeFileTool } from '../tools/fs';
import { applyPatchTool } from '../tools/applyPatchTool';
import { hasProposedTab, PROPOSED_SCHEME, registerProposedContent, withEditPreview } from '../ui/editPreview';
import { ApprovalOptions, ToolContext } from '../types';

const root = (): string => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';

/** The proposed side of every open preview diff. */
function proposedDiffs(): vscode.TabInputTextDiff[] {
  return vscode.window.tabGroups.all.flatMap((g) => g.tabs.map((t) => t.input)).filter((i): i is vscode.TabInputTextDiff => i instanceof vscode.TabInputTextDiff && i.modified.scheme === PROPOSED_SCHEME);
}

/** A tool context whose approval goes through the preview like the agent loop's, and records what was open meanwhile. */
function ctx(answer: boolean) {
  const seen: { tabs: vscode.TabInputTextDiff[]; proposed: string[] }[] = [];
  const c: ToolContext = {
    sessionId: 'test',
    signal: new AbortController().signal,
    depth: 0,
    async requestApproval(_title: string, _detail: string, _kind: string, opts?: ApprovalOptions) {
      return withEditPreview(opts?.preview, async () => {
        const tabs = proposedDiffs();
        const proposed = await Promise.all(tabs.map(async (t) => (await vscode.workspace.openTextDocument(t.modified)).getText()));
        seen.push({ tabs, proposed });
        return answer;
      });
    },
    progress() {},
    async trackChange() {},
  };
  return { c, seen };
}

suite('Edit preview (localpilot.diffPreview)', () => {
  let dir = '';
  let reg: vscode.Disposable | undefined;
  const cfg = () => vscode.workspace.getConfiguration('localpilot');

  suiteSetup(async () => {
    assert.ok(root(), 'tests need a workspace folder');
    reg = registerProposedContent();
    dir = path.join(root(), `edit-preview-${Date.now()}`);
    await fs.mkdir(dir, { recursive: true });
  });
  suiteTeardown(async () => {
    await cfg().update('diffPreview', undefined, vscode.ConfigurationTarget.Global);
    reg?.dispose();
    await fs.rm(dir, { recursive: true, force: true });
  });

  test('a proposed diff is open while the approval is pending, and Deny closes it', async () => {
    const file = path.join(dir, 'a.ts');
    await fs.writeFile(file, 'const a = 1;\nconst b = 2;\n');
    const { c, seen } = ctx(false);
    const r = await editFileTool.execute({ path: file, old_text: 'const b = 2;', new_text: 'const b = 3;' }, c);
    assert.ok(r.isError, 'declined');
    assert.strictEqual(seen.length, 1);
    const tab = seen[0].tabs.find((t) => t.modified.fsPath === vscode.Uri.file(file).fsPath);
    assert.ok(tab, 'a TabInputTextDiff with the localpilot-proposed scheme existed while approval was pending');
    assert.ok(seen[0].proposed.includes('const a = 1;\nconst b = 3;\n'), 'the right side is the content the edit would write');
    assert.ok(!hasProposedTab(file), 'deny closed the tab');
    assert.strictEqual(await fs.readFile(file, 'utf8'), 'const a = 1;\nconst b = 2;\n');
  });

  test('approve closes the preview and writes; write_file previews a new file', async () => {
    const file = path.join(dir, 'new.txt');
    const { c, seen } = ctx(true);
    const r = await writeFileTool.execute({ path: file, content: 'hello\n' }, c);
    assert.ok(!r.isError, r.content);
    assert.ok(seen[0].tabs.some((t) => t.modified.fsPath === vscode.Uri.file(file).fsPath));
    assert.ok(!hasProposedTab(file));
    assert.strictEqual(await fs.readFile(file, 'utf8'), 'hello\n');
  });

  test('CRLF files are previewed with the CRLF content the edit writes', async () => {
    const file = path.join(dir, 'win.txt');
    await fs.writeFile(file, 'x\r\ny\r\n');
    const { c, seen } = ctx(false);
    await editFileTool.execute({ path: file, old_text: 'y', new_text: 'z\nw' }, c);
    const doc = seen[0].proposed.find((t) => t.startsWith('x'));
    assert.strictEqual(doc?.replace(/\r\n/g, '\n'), 'x\nz\nw\n');
  });

  test('apply_patch previews every file of the patch', async () => {
    await fs.writeFile(path.join(dir, 'p1.txt'), '1\n');
    await fs.writeFile(path.join(dir, 'p2.txt'), '2\n');
    const rel = (p: string) => path.relative(root(), path.join(dir, p));
    const input = ['*** Begin Patch', `*** Update File: ${rel('p1.txt')}`, '-1', '+one', `*** Update File: ${rel('p2.txt')}`, '-2', '+two', '*** End Patch'].join('\n');
    const { c, seen } = ctx(false);
    await applyPatchTool.execute({ input }, c);
    assert.strictEqual(seen[0].tabs.length, 2);
    assert.ok(!hasProposedTab(), 'both closed');
  });

  test('diffPreview off opens nothing', async () => {
    await cfg().update('diffPreview', 'off', vscode.ConfigurationTarget.Global);
    const file = path.join(dir, 'off.txt');
    await fs.writeFile(file, 'a\n');
    const { c, seen } = ctx(false);
    await editFileTool.execute({ path: file, old_text: 'a', new_text: 'b' }, c);
    assert.strictEqual(seen[0].tabs.length, 0);
    await cfg().update('diffPreview', undefined, vscode.ConfigurationTarget.Global);
  });
});
