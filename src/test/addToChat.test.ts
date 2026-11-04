import * as assert from 'assert';
import * as os from 'os';
import * as vscode from 'vscode';
import { expandAroundLine, fenced, problemsDraft, readTerminalSelection, selectionLines, selectionRef, terminalSelectionDraft } from '../ui/addToChat';
import { LocalPilotCodeActions } from '../ui/inlineEdit';

suite('Add to Chat and code actions', () => {
  test('contributions: command, keybinding, editor menu and explorer entry', async () => {
    const pkg = vscode.extensions.getExtension('localpilot.localpilot-agent')!.packageJSON;
    const commands = pkg.contributes.commands as { command: string; title: string }[];
    assert.ok(commands.some((c) => c.command === 'localpilot.addToChat'));
    assert.strictEqual(commands.find((c) => c.command === 'localpilot.attachFile')?.title, 'Add File/Folder to Chat');
    const kb = (pkg.contributes.keybindings as { command: string; key: string; mac?: string; when?: string }[]).find((k) => k.command === 'localpilot.addToChat');
    assert.deepStrictEqual([kb?.key, kb?.mac, kb?.when], ["ctrl+'", "cmd+'", 'editorTextFocus']);
    const menu = (pkg.contributes.menus['editor/context'] as { command?: string; when?: string }[]).find((m) => m.command === 'localpilot.addToChat');
    assert.strictEqual(menu?.when, 'editorHasSelection');
    assert.ok((await vscode.commands.getCommands(true)).includes('localpilot.addToChat'));
  });

  test('selection lines, refs and the ±3 expansion', () => {
    assert.deepStrictEqual(selectionLines(4, 9, 0), { start: 4, end: 8 });
    assert.deepStrictEqual(selectionLines(4, 4, 0), { start: 4, end: 4 });
    assert.deepStrictEqual(selectionLines(4, 9, 3), { start: 4, end: 9 });
    assert.strictEqual(selectionRef('src/a.ts', { start: 4, end: 8 }), 'src/a.ts#L5-L9');
    assert.deepStrictEqual(expandAroundLine(10, 100), { start: 7, end: 13 });
    assert.deepStrictEqual(expandAroundLine(1, 3), { start: 0, end: 2 });
    assert.deepStrictEqual(expandAroundLine(0, 0), { start: 0, end: 0 });
  });

  test('problems draft sorts by severity and caps the list', () => {
    assert.strictEqual(problemsDraft('a.ts', []), '');
    const draft = problemsDraft('a.ts', [
      { line: 9, severity: 1, message: 'unused x' },
      { line: 2, severity: 0, message: "Cannot find name 'y'.\nmore", source: 'ts' },
    ]);
    assert.strictEqual(draft, "Problems:\n- a.ts:3 [error ts] Cannot find name 'y'.\n- a.ts:10 [warning] unused x");
    const many = problemsDraft('a.ts', Array.from({ length: 5 }, (_, i) => ({ line: i, severity: 0, message: 'e' })), 2);
    assert.ok(many.endsWith('- …and 3 more'));
  });

  test('fences survive backticks and terminal drafts are trimmed', () => {
    assert.strictEqual(fenced('a ``` b'), '````\na ``` b\n````');
    assert.strictEqual(terminalSelectionDraft('  $ ls\r\nfile\n\n'), 'Terminal output:\n```\n$ ls\nfile\n```');
    const long = terminalSelectionDraft('x'.repeat(100), 20);
    assert.ok(long.includes('…[80 chars omitted]…'));
  });

  test('terminal selection is read through the clipboard, which is restored', async () => {
    const run = async (selected: string | undefined, initial = 'mine') => {
      let clip = initial;
      const text = await readTerminalSelection({
        readText: async () => clip,
        writeText: async (v) => void (clip = v),
        copySelection: async () => {
          if (selected !== undefined) {
            clip = selected;
          }
        },
      });
      return { text, clip };
    };
    assert.deepStrictEqual(await run('npm ERR! boom'), { text: 'npm ERR! boom', clip: 'mine' });
    // Nothing selected: the old clipboard text must not be mistaken for a selection.
    assert.deepStrictEqual(await run(undefined), { text: '', clip: 'mine' });
    assert.deepStrictEqual(await run(undefined, ''), { text: '', clip: '' });
  });

  test('code actions: add, explain and improve; fix is preferred; empty selection grows to ±3 lines', async () => {
    const doc = await vscode.workspace.openTextDocument({ language: 'typescript', content: Array.from({ length: 20 }, (_, i) => `const v${i} = ${i};`).join('\n') });
    const provider = new LocalPilotCodeActions();
    const ctx = (diagnostics: vscode.Diagnostic[], only?: vscode.CodeActionKind): vscode.CodeActionContext => ({ diagnostics, only, triggerKind: vscode.CodeActionTriggerKind.Invoke });
    const actions = provider.provideCodeActions(doc, new vscode.Range(10, 2, 10, 2), ctx([]));
    const byTitle = (t: string) => actions.find((a) => a.title === t);
    assert.strictEqual(byTitle('Add to LocalPilot Chat')?.kind?.value, vscode.CodeActionKind.QuickFix.value);
    assert.strictEqual(byTitle('Explain with LocalPilot')?.kind?.value, vscode.CodeActionKind.RefactorExtract.value);
    assert.strictEqual(byTitle('Improve with LocalPilot')?.kind?.value, vscode.CodeActionKind.RefactorRewrite.value);
    assert.ok(!byTitle('Edit with LocalPilot…'), 'inline edit needs a selection');
    const range = byTitle('Add to LocalPilot Chat')!.command!.arguments![1] as vscode.Range;
    assert.deepStrictEqual([range.start.line, range.end.line], [7, 13]);

    const diag = new vscode.Diagnostic(new vscode.Range(3, 0, 3, 5), 'boom', vscode.DiagnosticSeverity.Error);
    const withDiag = provider.provideCodeActions(doc, new vscode.Range(3, 0, 4, 0), ctx([diag]));
    const fix = withDiag.find((a) => a.title.startsWith('Fix with LocalPilot'));
    assert.strictEqual(fix?.isPreferred, true);
    assert.ok(withDiag.some((a) => a.title === 'Edit with LocalPilot…'));

    const onlyRefactor = provider.provideCodeActions(doc, new vscode.Range(3, 0, 4, 0), ctx([diag], vscode.CodeActionKind.Refactor));
    assert.ok(onlyRefactor.length && onlyRefactor.every((a) => vscode.CodeActionKind.Refactor.contains(a.kind!)));
  });

  test('code actions: no light bulb on a bare cursor move, only when asked for or with a selection', async () => {
    const doc = await vscode.workspace.openTextDocument({ language: 'typescript', content: Array.from({ length: 20 }, (_, i) => `const v${i} = ${i};`).join('\n') });
    const provider = new LocalPilotCodeActions();
    const auto: vscode.CodeActionContext = { diagnostics: [], only: undefined, triggerKind: vscode.CodeActionTriggerKind.Automatic };
    const titles = ['Add to LocalPilot Chat', 'Explain with LocalPilot', 'Improve with LocalPilot'];
    const cursor = provider.provideCodeActions(doc, new vscode.Range(10, 2, 10, 2), auto).map((a) => a.title);
    assert.deepStrictEqual(cursor.filter((t) => titles.includes(t)), []);
    const selected = provider.provideCodeActions(doc, new vscode.Range(3, 0, 5, 0), auto).map((a) => a.title);
    assert.deepStrictEqual(selected.filter((t) => titles.includes(t)), titles);
  });

  test('Add to Chat command: appends a chip and the problems to the composer, sends nothing', async function () {
    this.timeout(20_000);
    const ext = vscode.extensions.getExtension('localpilot.localpilot-agent')!;
    await ext.activate();
    const api = ext.exports as { observeChat(post: (msg: { type: string; text?: string; attachments?: string[]; append?: boolean }) => void): vscode.Disposable; runningSessionIds: string[] };
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri ?? vscode.Uri.file(os.tmpdir());
    const uri = vscode.Uri.joinPath(folder, `add-to-chat-${Date.now()}.txt`);
    await vscode.workspace.fs.writeFile(uri, Buffer.from(Array.from({ length: 10 }, (_, i) => `const v${i} = ${i};`).join('\n')));
    const diags = vscode.languages.createDiagnosticCollection('addToChatTest');
    const seen: { type: string; text?: string; attachments?: string[]; append?: boolean }[] = [];
    const sub = api.observeChat((m) => seen.push(m));
    try {
      const boom = new vscode.Diagnostic(new vscode.Range(3, 0, 3, 5), 'boom', vscode.DiagnosticSeverity.Error);
      boom.source = 'test';
      diags.set(uri, [boom, new vscode.Diagnostic(new vscode.Range(8, 0, 8, 5), 'outside', vscode.DiagnosticSeverity.Error)]);
      const rel = vscode.workspace.asRelativePath(uri);
      // (uri, range) as a code action passes it; the range ends at column 0 of line 4, so line 4 is not included.
      await vscode.commands.executeCommand('localpilot.addToChat', uri, new vscode.Range(2, 0, 4, 0));
      await new Promise((r) => setTimeout(r, 300));
      const drafts = seen.filter((m) => m.type === 'draft');
      assert.strictEqual(drafts.length, 1, JSON.stringify(seen.map((m) => m.type)));
      assert.strictEqual(drafts[0].append, true);
      assert.deepStrictEqual(drafts[0].attachments, [`${rel}#L3-L4`]);
      assert.strictEqual(drafts[0].text, `Problems:\n- ${rel}:4 [error test] boom`);
      assert.deepStrictEqual(seen.filter((m) => ['session', 'sessions', 'running', 'event', 'sendQueued'].includes(m.type)).map((m) => m.type), [], 'no session is created and nothing is sent');
      assert.deepStrictEqual(api.runningSessionIds, []);

      // No selection: an empty append draft (focuses the composer, keeps what is typed).
      seen.length = 0;
      const ed = await vscode.window.showTextDocument(uri);
      ed.selection = new vscode.Selection(5, 3, 5, 3);
      await vscode.commands.executeCommand('localpilot.addToChat');
      await new Promise((r) => setTimeout(r, 300));
      const empty = seen.filter((m) => m.type === 'draft');
      assert.deepStrictEqual(empty.map((m) => [m.text, m.attachments, m.append]), [['', [], true]]);
      assert.ok(!seen.some((m) => m.type === 'session' || m.type === 'sessions'));
    } finally {
      sub.dispose();
      diags.dispose();
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      await vscode.workspace.fs.delete(uri);
    }
  });
});
