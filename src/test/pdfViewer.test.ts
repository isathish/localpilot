import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { WorkspaceContext } from '../context/workspaceContext';
import { loadOptionsBlock, pdfLoadOptions } from '../pdf/options';
import { openFileTool } from '../tools/editor';
import { ToolContext } from '../types';
import { ChatController } from '../ui/chatController';
import { isAllowedExternalLink, isBase64, MAX_RANGE_BYTES, pageFromFragment, rangeAllowed, rememberPosition, selectionDraft, validatePdfViewerMessage } from '../pdf/viewerMessages';
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

  test('range mode: a request split into 4 MB parts reaches pdf.js once, at its own begin, with every byte', () => {
    const view = fs.readFileSync(path.join(__dirname, '..', '..', 'media', 'pdfview.js'), 'utf8');
    const block = /\/\/ pdf-range-split:begin([\s\S]*?)\/\/ pdf-range-split:end/.exec(view);
    assert.ok(block, 'pdfview.js marks splitRange');
    type Split = { parts: { begin: number; end: number }[]; fill(part: { begin: number; end: number }, data: Uint8Array): void };
    const splitRange = new Function(`${block[1]}; return splitRange;`)() as (b: number, e: number, max: number, deliver: (b: number, d: Uint8Array) => void) => Split;
    const MB = 1024 * 1024;
    const begin = 3 * 262144;
    const end = begin + 9 * MB;
    const calls: { begin: number; data: Uint8Array }[] = [];
    const split = splitRange(begin, end, 4 * MB, (b, data) => calls.push({ begin: b, data }));
    assert.deepStrictEqual(split.parts.map((p) => p.end - p.begin), [4 * MB, 4 * MB, MB]);
    const bytes = (p: { begin: number; end: number }) => Uint8Array.from({ length: p.end - p.begin }, (_, i) => (p.begin + i) % 251);
    // Replies arrive out of order, one twice (a retry racing a late answer).
    for (const p of [split.parts[2], split.parts[0], split.parts[0], split.parts[1]]) {
      assert.strictEqual(calls.length, 0, 'nothing reaches pdf.js before every part is in');
      split.fill(p, bytes(p));
    }
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].begin, begin);
    assert.strictEqual(calls[0].data.length, end - begin);
    assert.ok(calls[0].data.every((v, i) => v === (begin + i) % 251), 'bytes land at their offsets');
    const small: number[] = [];
    const one = splitRange(0, 262144, 4 * MB, (b) => small.push(b));
    one.fill(one.parts[0], new Uint8Array(262144));
    assert.deepStrictEqual(small, [0]);
  });

  test('a page image attached before any chat view exists is kept until one boots', () => {
    const c = Object.create(ChatController.prototype) as any;
    const sent: unknown[] = [];
    Object.assign(c, { sinks: new Set(), pendingImages: [], broadcast: (m: unknown) => sent.push(m) });
    const img = { name: 'doc-p2.png', data: png, mime: 'image/png' };
    c.attachImage(img);
    assert.deepStrictEqual(c.pendingImages.map((p: { img: unknown }) => p.img), [img]);
    c.sinks.add({ post() {} });
    c.attachImage(img);
    assert.strictEqual(c.pendingImages.length, 1, 'a live chat view gets the broadcast; nothing more is queued');
    assert.strictEqual(sent.length, 2);
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
    await vscode.commands.executeCommand('localpilot.openPdf', uri.with({ fragment: 'page=2' }));
    // The extension runs from its bundle: watch the tab, not module state imported here.
    assert.ok(await waitFor(() => vscode.window.tabGroups.all.flatMap((g) => g.tabs).some((t) => t.input instanceof vscode.TabInputCustom && t.input.viewType === 'localpilot.pdfViewer' && /viewer-link\.pdf$/.test(t.input.uri.path))), 'PDF opened in the custom editor');
    await vscode.commands.executeCommand('localpilot.openPdf', uri.with({ fragment: 'page=1' }));
    const tabs = vscode.window.tabGroups.all.flatMap((g) => g.tabs);
    assert.strictEqual(tabs.filter((t) => t.input instanceof vscode.TabInputCustom && /viewer-link\.pdf$/.test(t.input.uri.path)).length, 1);
    assert.ok(!tabs.some((t) => t.input instanceof vscode.TabInputText && /viewer-link\.pdf$/.test(t.input.uri.path)), 'not as text');
  });

  const noTextTab = (name: string) =>
    !vscode.window.tabGroups.all.flatMap((g) => g.tabs).some((t) => t.input instanceof vscode.TabInputText && t.input.uri.path.endsWith(`/${name}`));

  test('a doc.pdf:2 link in chat opens the PDF viewer, not the text editor', async () => {
    await workspaceFile('viewer-chat.pdf', makePdf(['One', 'Two']));
    const log = vscode.window.createOutputChannel('LocalPilot PDF test', { log: true });
    const workspace = new WorkspaceContext(log);
    try {
      const c = Object.create(ChatController.prototype) as any;
      const sent: { type: string; text?: string }[] = [];
      Object.assign(c, { workspace, store: { peek: () => undefined }, broadcast: (m: { type: string }) => sent.push(m) });
      await c.handle({ type: 'openFile', path: 'viewer-chat.pdf', line: 2 });
      assert.ok(await waitFor(() => !!pdfTab() && /viewer-chat\.pdf$/.test((pdfTab()!.input as vscode.TabInputCustom).uri.path)), 'custom editor tab');
      assert.ok(noTextTab('viewer-chat.pdf'), 'not as text');
      assert.ok(!sent.some((m) => m.type === 'toast' && /Cannot open/.test(m.text ?? '')), 'no "Cannot open" toast');
    } finally {
      workspace.dispose();
      log.dispose();
    }
  });

  test('the open_file tool opens a PDF in the viewer at a page', async () => {
    await workspaceFile('viewer-tool.pdf', makePdf(['One', 'Two']));
    const ctx = {
      sessionId: 'test',
      workspaceRoot: vscode.workspace.workspaceFolders![0].uri.fsPath,
      signal: new AbortController().signal,
      depth: 0,
      requestApproval: async () => true,
      progress() {},
      async trackChange() {},
    } as unknown as ToolContext;
    const r = await openFileTool.execute({ path: 'viewer-tool.pdf', line: 2 }, ctx);
    assert.ok(!r.isError, r.content);
    assert.match(r.content, /at page 2/);
    assert.ok(await waitFor(() => !!pdfTab() && /viewer-tool\.pdf$/.test((pdfTab()!.input as vscode.TabInputCustom).uri.path)), 'custom editor tab');
    assert.ok(noTextTab('viewer-tool.pdf'), 'not as text');
  });
});
