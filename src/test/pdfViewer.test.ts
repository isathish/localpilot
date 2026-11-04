import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { loadOptionsBlock, pdfLoadOptions } from '../pdf/options';
import { isAllowedExternalLink, isBase64, MAX_RANGE_BYTES, pageFromFragment, rangeAllowed, rememberPosition, selectionDraft, validatePdfViewerMessage } from '../pdf/viewerMessages';
import { livePdfViews, openPdf } from '../ui/pdf/open';
import { makePdf } from './fixtures/makePdf';

const EXT = 'localpilot.localpilot-agent';
const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex').toString('base64');

suite('PDF viewer: pure rules', () => {
  test('getDocument options never enable XFA, scripting or worker fetches', () => {
    const o = pdfLoadOptions({ cmaps: 'c/', standardFonts: 's/', wasm: 'w/', iccs: 'i/' }, { data: new Uint8Array(1) });
    assert.strictEqual(o.enableXfa, false);
    assert.strictEqual(o.useWorkerFetch, false);
    assert.notStrictEqual(o.enableScripting, true);
    assert.strictEqual(o.cMapUrl, 'c/');
    assert.ok(o.data instanceof Uint8Array);
  });

  test('media/pdfview.js carries the same load options as the host', () => {
    const host = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'pdf', 'options.ts'), 'utf8');
    const view = fs.readFileSync(path.join(__dirname, '..', '..', 'media', 'pdfview.js'), 'utf8');
    const a = loadOptionsBlock(host);
    assert.ok(a, 'options.ts marks its block');
    assert.strictEqual(loadOptionsBlock(view), a);
    assert.ok(!/enableScripting:\s*true/.test(view));
    assert.ok(/AnnotationMode\.ENABLE\b/.test(view) && !/ENABLE_FORMS/.test(view), 'forms render flat');
  });

  test('attachImage: PNG only, valid base64, size-capped', () => {
    assert.deepStrictEqual(validatePdfViewerMessage({ type: 'attachImage', name: 'spec-p3.png', data: png, mime: 'image/png' }), { type: 'attachImage', name: 'spec-p3.png', data: png, mime: 'image/png' });
    assert.strictEqual(validatePdfViewerMessage({ type: 'attachImage', name: 'x.svg', data: png, mime: 'image/svg+xml' }), undefined);
    assert.strictEqual(validatePdfViewerMessage({ type: 'attachImage', name: 'x.png', data: 'not base64!', mime: 'image/png' }), undefined);
    assert.strictEqual(validatePdfViewerMessage({ type: 'attachImage', name: 'x.png', data: 'abc', mime: 'image/png' }), undefined);
    assert.strictEqual(validatePdfViewerMessage({ type: 'attachImage', name: 'x.png', data: 42, mime: 'image/png' }), undefined);
    assert.strictEqual(isBase64('A'.repeat(17 * 1024 * 1024)), false);
    const named = validatePdfViewerMessage({ type: 'attachImage', name: '../../etc/passwd', data: png, mime: 'image/png' });
    assert.ok(named?.type === 'attachImage' && !named.name.includes('/') && named.name.endsWith('.png'));
  });

  test('other messages are checked field by field; unknown ones are dropped', () => {
    assert.strictEqual(validatePdfViewerMessage({ type: 'eval', code: '1' }), undefined);
    assert.strictEqual(validatePdfViewerMessage(null), undefined);
    assert.deepStrictEqual(validatePdfViewerMessage({ type: 'range', id: 1, begin: 0, end: 10 }), { type: 'range', id: 1, begin: 0, end: 10 });
    assert.strictEqual(validatePdfViewerMessage({ type: 'range', id: 1, begin: -1, end: 10 }), undefined);
    assert.strictEqual(validatePdfViewerMessage({ type: 'range', id: 1.5, begin: 0, end: 10 }), undefined);
    assert.strictEqual(validatePdfViewerMessage({ type: 'askSelection', text: '  ', page: 2 }), undefined);
    const sel = validatePdfViewerMessage({ type: 'askSelection', text: 'x'.repeat(9000), page: 2 });
    assert.ok(sel?.type === 'askSelection' && sel.text.length === 4000);
    assert.deepStrictEqual(validatePdfViewerMessage({ type: 'position', page: 3, scale: 'page-fit' }), { type: 'position', page: 3, scale: 'page-fit' });
    assert.strictEqual(validatePdfViewerMessage({ type: 'position', page: 3, scale: 'huge' }), undefined);
    assert.deepStrictEqual(validatePdfViewerMessage({ type: 'prefs', patch: { pageColors: 'sepia', sidebar: 'nope' } }), { type: 'prefs', patch: { pageColors: 'sepia' } });
  });

  test('ranges, links, fragments, positions and quotes', () => {
    assert.ok(rangeAllowed(0, 100, 100));
    assert.ok(!rangeAllowed(0, 101, 100));
    assert.ok(!rangeAllowed(10, 10, 100));
    assert.ok(!rangeAllowed(0, MAX_RANGE_BYTES + 1, MAX_RANGE_BYTES * 2));
    assert.ok(isAllowedExternalLink('https://example.com/a'));
    assert.ok(isAllowedExternalLink('mailto:a@b.c'));
    for (const bad of ['javascript:alert(1)', 'file:///etc/passwd', 'command:workbench.action.quit', 'vscode://x', 'data:text/html,x']) {
      assert.ok(!isAllowedExternalLink(bad), bad);
    }
    assert.strictEqual(pageFromFragment('page=3'), 3);
    assert.strictEqual(pageFromFragment('#page=12'), 12);
    assert.strictEqual(pageFromFragment('page=0'), undefined);
    assert.strictEqual(pageFromFragment('L3'), undefined);
    let all = {};
    for (let i = 0; i < 5; i++) {
      all = rememberPosition(all, `f${i}`, { page: i + 1, scale: 'auto' }, 3);
    }
    assert.deepStrictEqual(Object.keys(all), ['f2', 'f3', 'f4']);
    all = rememberPosition(all, 'f2', { page: 9, scale: 1.5 }, 3);
    assert.deepStrictEqual(Object.keys(all), ['f3', 'f4', 'f2']);
    assert.strictEqual(selectionDraft('a\nb'), '> a\n> b\n\n');
  });
});

suite('PDF viewer: VS Code integration', () => {
  suiteSetup(async () => {
    await vscode.extensions.getExtension(EXT)!.activate();
  });
  teardown(async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  });

  const workspaceFile = async (name: string, data: Buffer): Promise<vscode.Uri> => {
    const root = vscode.workspace.workspaceFolders![0].uri;
    const uri = vscode.Uri.joinPath(root, name);
    await vscode.workspace.fs.writeFile(uri, data);
    return uri;
  };
  const pdfTab = () =>
    vscode.window.tabGroups.all
      .flatMap((g) => g.tabs)
      .find((t) => t.input instanceof vscode.TabInputCustom && t.input.viewType === 'localpilot.pdfViewer');
  const waitFor = async (ok: () => boolean, ms = 5000) => {
    const end = Date.now() + ms;
    while (!ok() && Date.now() < end) {
      await new Promise((r) => setTimeout(r, 50));
    }
    return ok();
  };

  test('contributions: custom editor, commands, settings and menus', async () => {
    const pkg = vscode.extensions.getExtension(EXT)!.packageJSON;
    const editor = pkg.contributes.customEditors.find((e: { viewType: string }) => e.viewType === 'localpilot.pdfViewer');
    assert.ok(editor && editor.selector.some((s: { filenamePattern: string }) => s.filenamePattern === '*.pdf'));
    assert.strictEqual(editor.priority, 'default');
    const cmds = await vscode.commands.getCommands(true);
    assert.ok(cmds.includes('localpilot.openPdf') && cmds.includes('localpilot.pdf.attachPageImage'));
    const props = pkg.contributes.configuration.properties ?? Object.assign({}, ...pkg.contributes.configuration.map((c: { properties: object }) => c.properties));
    assert.strictEqual(props['localpilot.pdfViewer.pageColors'].default, 'auto');
    assert.strictEqual(props['localpilot.pdfViewer.rangeThresholdMB'].default, 16);
    assert.strictEqual(props['localpilot.pdfViewer.maxFileSizeMB'].default, 1024);
    assert.ok(pkg.contributes.menus['explorer/context'].some((m: { command: string }) => m.command === 'localpilot.openPdf'));
  });

  test('vscode.openWith and localpilot.openPdf open the viewer; a JavaScript PDF opens without error', async () => {
    const uri = await workspaceFile('viewer-js.pdf', makePdf(['Hello viewer', 'Second page'], { js: true }));
    await vscode.commands.executeCommand('vscode.openWith', uri, 'localpilot.pdfViewer');
    assert.ok(await waitFor(() => !!pdfTab()), 'custom editor tab');
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await vscode.commands.executeCommand('localpilot.openPdf', uri);
    assert.ok(await waitFor(() => !!pdfTab()), 'opened by command');
  });

  test('openPdf with a page opens the viewer once; a second link reuses the tab', async () => {
    const uri = await workspaceFile('viewer-link.pdf', makePdf(['One', 'Two']));
    await openPdf(uri, 2);
    assert.ok(await waitFor(() => !!pdfTab() && livePdfViews.views.has(uri.toString())), 'PDF opened in the custom editor');
    await openPdf(uri, 1);
    const tabs = vscode.window.tabGroups.all.flatMap((g) => g.tabs);
    assert.strictEqual(tabs.filter((t) => t.input instanceof vscode.TabInputCustom && /viewer-link\.pdf$/.test(t.input.uri.path)).length, 1);
    assert.ok(!tabs.some((t) => t.input instanceof vscode.TabInputText && /viewer-link\.pdf$/.test(t.input.uri.path)), 'not as text');
  });
});
