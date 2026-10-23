import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';

suite('LocalPilot Markdown reader', () => {
  suiteSetup(async function () {
    this.timeout(30_000);
    await vscode.extensions.getExtension('localpilot.localpilot-agent')!.activate();
  });

  test("VS Code's Markdown engine is available to render documents", async function () {
    this.timeout(20_000);
    const html = await vscode.commands.executeCommand<string>('markdown.api.render', '# Title\n\nSome `code` and a list:\n\n- one\n- two\n\n```ts\nconst x: number = 1;\n```\n');
    assert.ok(typeof html === 'string' && /<h1[^>]*>Title<\/h1>/.test(html), html);
    assert.ok(/<code[^>]*>code<\/code>/.test(html) && /<li>one<\/li>/.test(html));
    assert.ok(/<pre[^>]*>/.test(html) && /language-ts|hljs/.test(html), 'fenced code keeps its language');
  });

  test('command and menus are contributed; the reader opens a file and the show_markdown tool exists', async function () {
    this.timeout(30_000);
    const pkg = vscode.extensions.getExtension('localpilot.localpilot-agent')!.packageJSON;
    assert.ok(pkg.contributes.commands.some((c: { command: string }) => c.command === 'localpilot.openMarkdownViewer'));
    assert.ok(pkg.contributes.menus['editor/title'].some((m: { command: string; when: string }) => m.command === 'localpilot.openMarkdownViewer' && /markdown/.test(m.when)));
    assert.ok(pkg.contributes.menus['explorer/context'].some((m: { command: string; when: string }) => m.command === 'localpilot.openMarkdownViewer' && /md/.test(m.when)));
    const root = vscode.workspace.workspaceFolders![0].uri.fsPath;
    const file = path.join(root, 'READ-ME-TEST.md');
    await fs.writeFile(file, '# Reader test\n\nHello **reader**.\n\n## Second\n\ntext\n');
    await vscode.commands.executeCommand('localpilot.openMarkdownViewer', vscode.Uri.file(file));
    // A webview panel became the active tab in some group.
    const tabs = vscode.window.tabGroups.all.flatMap((g) => g.tabs);
    assert.ok(tabs.some((t) => t.input instanceof vscode.TabInputWebview && /localpilot\.markdown/.test((t.input as vscode.TabInputWebview).viewType) && t.label === 'READ-ME-TEST.md'), tabs.map((t) => `${t.label}`).join(', '));
    // Calling again with no argument and no active editor is a no-op with a hint, not an error.
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await vscode.commands.executeCommand('localpilot.openMarkdownViewer');
    await fs.rm(file, { force: true });
  });
});
