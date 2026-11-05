import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { createShowMarkdownTool, MarkdownViewer } from '../ui/markdownViewer';
import { ToolContext } from '../types';

suite('LocalPilot Markdown reader', () => {
  suiteSetup(async function () {
    this.timeout(30_000);
    await vscode.extensions.getExtension('localpilot.localpilot-agent')!.activate();
  });

  test("VS Code's Markdown engine is available to render documents", async function () {
    this.timeout(20_000);
    const html = await vscode.commands.executeCommand<string>('markdown.api.render', '# Title\n\nSome `code` and a list:\n\n- one\n- two\n\n```ts\nconst x: number = 1;\n```\n');
    assert.ok(typeof html === 'string' && /<h1[^>]*>Title<\/h1>/.test(html), html);
    // VS Code's engine adds data-line / code-line attributes to block elements.
    assert.ok(/<code[^>]*>code<\/code>/.test(html) && /<li[^>]*>one<\/li>/.test(html), html);
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
    // (With no file and no Markdown editor on screen the command asks for a file with the native open dialog, which a
    // test host cannot answer, so that path is not exercised here.)
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await fs.rm(file, { force: true });
  });

  test('show_markdown resolves paths against the session worktree, not the main checkout', async () => {
    const wt = await fs.mkdtemp(path.join(os.tmpdir(), 'lp-md-wt-'));
    try {
      await fs.writeFile(path.join(wt, 'SPEC-WT.md'), '# Worktree spec\n');
      let shown: vscode.Uri | undefined;
      const viewer = { showFile: async (uri: vscode.Uri) => void (shown = uri) } as unknown as MarkdownViewer;
      const ctx: ToolContext = { sessionId: 'test', workspaceRoot: wt, signal: new AbortController().signal, depth: 0, requestApproval: async () => true, progress: () => undefined, trackChange: async () => undefined };
      const r = await createShowMarkdownTool(viewer).execute({ path: 'SPEC-WT.md' }, ctx);
      assert.ok(!r.isError, r.content);
      assert.strictEqual(shown?.fsPath, vscode.Uri.file(path.join(wt, 'SPEC-WT.md')).fsPath);
    } finally {
      await fs.rm(wt, { recursive: true, force: true });
    }
  });
  test('the custom editor, its settings and the panel serializer are contributed', () => {
    const pkg = vscode.extensions.getExtension('localpilot.localpilot-agent')!.packageJSON;
    const ed = (pkg.contributes.customEditors as { viewType: string; priority: string; selector: { filenamePattern: string }[] }[]).find((e) => e.viewType === 'localpilot.markdownEditor');
    assert.ok(ed, 'localpilot.markdownEditor is contributed');
    assert.strictEqual(ed.priority, 'option');
    assert.deepStrictEqual(ed.selector.map((s) => s.filenamePattern).sort(), ['*.markdown', '*.md']);
    const props = pkg.contributes.configuration.properties ?? Object.assign({}, ...pkg.contributes.configuration.map((c: { properties: object }) => c.properties));
    assert.strictEqual(props['localpilot.markdownViewer.scrollSync'].default, true);
    assert.strictEqual(props['localpilot.markdownViewer.outlineDepth'].default, 3);
    assert.strictEqual(props['localpilot.markdownViewer.frontMatter'].default, 'collapsed');
    assert.strictEqual(props['localpilot.markdownViewer.mermaid'].default, true);
    // The extension runs from its bundle, so module state imported here cannot show the registration; the
    // activation event that wakes the extension to restore reader panels after a reload is what users depend on.
    assert.ok(pkg.activationEvents.includes('onWebviewPanel:localpilot.markdown'), 'reader panels are restored after a reload');
  });

  test('Open With → LocalPilot Markdown Reader: two files open side by side and close independently', async function () {
    this.timeout(30_000);
    const root = vscode.workspace.workspaceFolders![0].uri.fsPath;
    const a = vscode.Uri.file(path.join(root, 'READER-A.md'));
    const b = vscode.Uri.file(path.join(root, 'READER-B.md'));
    await fs.writeFile(a.fsPath, '# A\n\ntext\n');
    await fs.writeFile(b.fsPath, '---\ntitle: B\n---\n# B\n\n```mermaid\nflowchart LR\n  x --> y\n```\n');
    const custom = () =>
      vscode.window.tabGroups.all
        .flatMap((g) => g.tabs)
        .filter((t) => t.input instanceof vscode.TabInputCustom && t.input.viewType === 'localpilot.markdownEditor')
        .map((t) => (t.input as vscode.TabInputCustom).uri.fsPath);
    try {
      await vscode.commands.executeCommand('vscode.openWith', a, 'localpilot.markdownEditor');
      await vscode.commands.executeCommand('vscode.openWith', b, 'localpilot.markdownEditor', vscode.ViewColumn.Beside);
      assert.deepStrictEqual(custom().sort(), [a.fsPath, b.fsPath].sort());
      const tabA = vscode.window.tabGroups.all.flatMap((g) => g.tabs).find((t) => t.input instanceof vscode.TabInputCustom && t.input.uri.fsPath === a.fsPath)!;
      await vscode.window.tabGroups.close(tabA);
      assert.deepStrictEqual(custom(), [b.fsPath]);
    } finally {
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      await fs.rm(a.fsPath, { force: true });
      await fs.rm(b.fsPath, { force: true });
    }
  });

  test("math renders through VS Code's engine (KaTeX output the reader styles)", async function () {
    if (!vscode.extensions.getExtension('vscode.markdown-math')) {
      this.skip();
    }
    this.timeout(20_000);
    const html = await vscode.commands.executeCommand<string>('markdown.api.render', 'Inline $a^2$ math.');
    assert.ok(/katex/.test(html), html);
  });
});
