import * as assert from 'assert';
import { promises as fs } from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { buildExportDocument, exportImageSrc, MAX_INLINE_IMAGE } from '../ui/markdown/export';
import { DEFAULT_PREFS } from '../ui/markdown/prefs';
import { askAboutFile, ReaderChat } from '../ui/markdown/viewSession';

// 1×1 transparent PNG.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');

/** The schemes the export page's CSP lets an <img> load. */
function imgSchemes(doc: string): string[] {
  const csp = /http-equiv="Content-Security-Policy" content="([^"]*)"/.exec(doc)?.[1] ?? '';
  return (/img-src ([^;]*)/.exec(csp)?.[1] ?? '').trim().split(/\s+/);
}

suite('Markdown reader: Ask LocalPilot and export end to end', () => {
  let root: string;
  suiteSetup(async function () {
    this.timeout(30_000);
    await vscode.extensions.getExtension('localpilot.localpilot-agent')!.activate();
    root = await fs.mkdtemp(path.join(vscode.workspace.workspaceFolders![0].uri.fsPath, 'md-e2e-'));
  });
  suiteTeardown(async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await fs.rm(root, { recursive: true, force: true });
  });

  test('Ask LocalPilot sends the file chip and the draft together through the buffered path', async () => {
    const file = path.join(root, 'ask.md');
    await fs.writeFile(file, '# Ask\n');
    const calls: { text: string; attachments: string[] }[] = [];
    const drafts: string[] = [];
    const chat: ReaderChat = { addToComposer: (text, attachments) => void calls.push({ text, attachments }), draft: (t) => void drafts.push(t) };
    await askAboutFile(chat, vscode.Uri.file(file));
    assert.deepStrictEqual(calls, [{ text: 'About this document: ', attachments: [vscode.workspace.asRelativePath(vscode.Uri.file(file))] }]);
    assert.deepStrictEqual(drafts, [], 'no separate, unbuffered draft');
  });

  test('images over the inline limit or of unknown type become file: URLs the export CSP allows', async () => {
    const big = await exportImageSrc('/x/big.png', MAX_INLINE_IMAGE + 1, async () => assert.fail('a large image is not read'));
    const odd = await exportImageSrc('/x/scan.tiff', 10, async () => PNG);
    const broken = await exportImageSrc('/x/gone.png', undefined, async () => PNG);
    const small = await exportImageSrc('/x/a.png', PNG.length, async () => PNG);
    assert.ok(small.startsWith('data:image/png;base64,'), small);
    const doc = buildExportDocument({ title: 't', article: `<img src="${big}"><img src="${odd}"><img src="${broken}">`, css: '', theme: 'light', prefs: DEFAULT_PREFS });
    for (const src of [big, odd, broken]) {
      assert.ok(src.startsWith('file:'), src);
      assert.ok(imgSchemes(doc).includes(`${new URL(src).protocol}`), `${src} allowed by ${imgSchemes(doc).join(' ')}`);
    }
  });

  test('exportMarkdownHtml writes a self-contained file with no script, embedded images and KaTeX fonts', async function () {
    this.timeout(60_000);
    const md = path.join(root, 'doc.md');
    const out = path.join(root, 'doc-export.html');
    await fs.writeFile(path.join(root, 'pic.png'), PNG);
    await fs.writeFile(md, '# Export\n\n![pic](pic.png)\n\nInline math $x^2$ here.\n');
    const win = vscode.window as unknown as Record<string, unknown>;
    const original = { save: win.showSaveDialog, info: win.showInformationMessage };
    win.showSaveDialog = async () => vscode.Uri.file(out);
    win.showInformationMessage = async () => undefined;
    try {
      await vscode.commands.executeCommand('localpilot.exportMarkdownHtml', vscode.Uri.file(md));
      let html: string | undefined;
      for (const end = Date.now() + 45_000; !html && Date.now() < end; ) {
        html = await fs.readFile(out, 'utf8').catch(() => undefined);
        if (!html) {
          await new Promise((r) => setTimeout(r, 250));
        }
      }
      assert.ok(html, 'the export file was written');
      assert.ok(!/<script/i.test(html), 'no script in the exported page');
      assert.ok(html.includes('src="data:image/png;base64,'), 'the relative image is embedded');
      assert.ok(html.includes('data:font/woff2'), 'KaTeX fonts are embedded when math is present');
    } finally {
      win.showSaveDialog = original.save;
      win.showInformationMessage = original.info;
    }
  });
});
