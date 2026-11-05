import * as assert from 'assert';
import { promises as fs } from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { MarkdownViewSession, validateViewerMessage } from '../ui/markdown/viewSession';

suite('Markdown reader: webview message validation', () => {
  test('saveAs keeps a valid SVG and treats a missing one as "save Markdown"', () => {
    assert.deepStrictEqual(validateViewerMessage({ type: 'saveAs', svg: '<svg/>', name: 'd' }), { type: 'saveAs', svg: '<svg/>', name: 'd' });
    assert.deepStrictEqual(validateViewerMessage({ type: 'saveAs' }), { type: 'saveAs', svg: undefined, name: undefined });
  });

  test('saveAs with an oversize or non-string SVG is dropped instead of saving the Markdown', () => {
    assert.strictEqual(validateViewerMessage({ type: 'saveAs', svg: 'x'.repeat(20 * 1024 * 1024 + 1) }), undefined);
    assert.strictEqual(validateViewerMessage({ type: 'saveAs', svg: 42 }), undefined);
    assert.strictEqual(validateViewerMessage({ type: 'saveAs', svg: null }), undefined);
  });

  test('find (the toolbar Find button) is accepted with no payload', () => {
    assert.deepStrictEqual(validateViewerMessage({ type: 'find' }), { type: 'find' });
    assert.deepStrictEqual(validateViewerMessage({ type: 'find', query: 'x' }), { type: 'find' });
  });

  test('openSettings (More → Viewer settings…) is accepted; unknown types are still dropped', () => {
    assert.deepStrictEqual(validateViewerMessage({ type: 'openSettings' }), { type: 'openSettings' });
    assert.deepStrictEqual(validateViewerMessage({ type: 'openSettings', section: 'agent' }), { type: 'openSettings' });
    assert.strictEqual(validateViewerMessage({ type: 'runCommand', id: 'workbench.action.terminal.new' }), undefined);
    assert.strictEqual(validateViewerMessage({ type: 'opensettings' }), undefined);
  });

  test('close (error card and deleted-file banner) is accepted with no payload', () => {
    assert.deepStrictEqual(validateViewerMessage({ type: 'close' }), { type: 'close' });
    assert.deepStrictEqual(validateViewerMessage({ type: 'close', force: true }), { type: 'close' });
  });
});

suite('Markdown reader: session', () => {
  /** A session over a webview that records what it posts. */
  function session(): { s: MarkdownViewSession; posted: { type: string }[] } {
    const posted: { type: string }[] = [];
    const webview = {
      options: {},
      html: '',
      cspSource: 'vscode-resource:',
      asWebviewUri: (u: vscode.Uri) => u,
      postMessage: async (m: { type: string }) => (posted.push(m), true),
      onDidReceiveMessage: () => new vscode.Disposable(() => undefined),
    } as unknown as vscode.Webview;
    const state = new Map<string, unknown>();
    const ctx = {
      extensionUri: vscode.extensions.getExtension('localpilot.localpilot-agent')!.extensionUri,
      globalState: { get: (k: string) => state.get(k), update: async (k: string, v: unknown) => void state.set(k, v) },
    } as unknown as vscode.ExtensionContext;
    const log = { warn: () => undefined, error: () => undefined, info: () => undefined } as unknown as vscode.LogOutputChannel;
    return { s: new MarkdownViewSession({ webview, ctx, log, isCustomEditor: false, openMarkdown: async () => undefined }), posted };
  }
  const until = async (ok: () => boolean, ms: number) => {
    for (const end = Date.now() + ms; !ok() && Date.now() < end; ) {
      await new Promise((r) => setTimeout(r, 50));
    }
  };

  test('deleting the file posts "deleted"; creating it again posts "restored"', async function () {
    this.timeout(20_000);
    const dir = await fs.mkdtemp(path.join(vscode.workspace.workspaceFolders![0].uri.fsPath, 'md-session-'));
    const file = path.join(dir, 'gone.md');
    await fs.writeFile(file, '# Gone soon\n');
    const { s, posted } = session();
    try {
      await s.setSource({ kind: 'file', uri: vscode.Uri.file(file) });
      assert.ok(posted.some((m) => m.type === 'content' || m.type === 'error'), 'the first render posts something');
      // Give the watcher a moment to start before the change it must see.
      await new Promise((r) => setTimeout(r, 500));
      await fs.rm(file);
      await until(() => posted.some((m) => m.type === 'deleted'), 8000);
      assert.ok(posted.some((m) => m.type === 'deleted'), `posted: ${posted.map((m) => m.type).join(', ')}`);
      await fs.writeFile(file, '# Back\n');
      await until(() => posted.some((m) => m.type === 'restored'), 8000);
      assert.ok(posted.some((m) => m.type === 'restored'), `posted: ${posted.map((m) => m.type).join(', ')}`);
    } finally {
      s.dispose();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test('changing a markdownViewer setting re-renders open readers with it', async function () {
    this.timeout(20_000);
    const dir = await fs.mkdtemp(path.join(vscode.workspace.workspaceFolders![0].uri.fsPath, 'md-session-'));
    const file = path.join(dir, 'props.md');
    await fs.writeFile(file, '---\ntitle: Live settings\n---\n# Body\n');
    const cfg = vscode.workspace.getConfiguration('localpilot');
    const before = cfg.inspect<string>('markdownViewer.frontMatter')?.globalValue;
    const { s, posted } = session();
    type Content = { type: string; frontMatter?: Record<string, unknown>; frontMatterMode?: string };
    const contents = () => (posted as Content[]).filter((m) => m.type === 'content');
    try {
      await cfg.update('markdownViewer.frontMatter', 'collapsed', vscode.ConfigurationTarget.Global);
      await s.setSource({ kind: 'file', uri: vscode.Uri.file(file) });
      const first = contents().at(-1);
      assert.ok(first?.frontMatter && first.frontMatterMode === 'collapsed', 'front matter shown at first');
      const seen = contents().length;
      await cfg.update('markdownViewer.frontMatter', 'hidden', vscode.ConfigurationTarget.Global);
      await until(() => contents().length > seen && contents().at(-1)?.frontMatterMode === 'hidden', 8000);
      const next = contents().at(-1);
      assert.strictEqual(next?.frontMatterMode, 'hidden', `posted: ${posted.map((m) => m.type).join(', ')}`);
      assert.strictEqual(next?.frontMatter, undefined);
      assert.ok(!posted.some((m) => m.type === 'toast'), 'no toast for a settings change');
    } finally {
      s.dispose();
      await cfg.update('markdownViewer.frontMatter', before, vscode.ConfigurationTarget.Global);
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
