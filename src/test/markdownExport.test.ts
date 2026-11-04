import * as assert from 'assert';
import * as vscode from 'vscode';
import { buildExportDocument, imageSources, inlineKatexFonts, printToPdfArgs, quoteForDraft, rewriteImageSources, sanitizeExportHtml, themeVars } from '../ui/markdown/export';
import { DEFAULT_PREFS, prefsCss, readPrefs, sanitizePrefsPatch } from '../ui/markdown/prefs';
import { validateViewerMessage } from '../ui/markdown/viewSession';

suite('Markdown reader: export, Ask LocalPilot and reading controls', () => {
  test('the commands, menus and the export theme setting are contributed and registered', async function () {
    this.timeout(30_000);
    const ext = vscode.extensions.getExtension('localpilot.localpilot-agent')!;
    await ext.activate();
    const ids = ['localpilot.askAboutDocument', 'localpilot.exportMarkdownHtml', 'localpilot.exportMarkdownPdf', 'localpilot.openMarkdownViewerToSide'];
    const pkg = ext.packageJSON;
    const registered = await vscode.commands.getCommands(true);
    for (const id of ids) {
      assert.ok(pkg.contributes.commands.some((c: { command: string }) => c.command === id), `${id} contributed`);
      assert.ok(registered.includes(id), `${id} registered`);
    }
    assert.ok(pkg.contributes.menus['explorer/context'].some((m: { command: string; when: string }) => m.command === 'localpilot.askAboutDocument' && /pdf/.test(m.when)));
    assert.ok(pkg.contributes.menus['editor/title'].some((m: { command: string; when: string }) => m.command === 'localpilot.askAboutDocument' && /localpilot\.markdownEditor/.test(m.when)));
    assert.strictEqual(vscode.workspace.getConfiguration('localpilot').get('markdownViewer.exportTheme'), 'light');
  });

  test('an exported page is self-contained and runs nothing', () => {
    const article = sanitizeExportHtml('<article class="md"><h1 onclick="x()">T</h1><script>alert(1)</script><a href="javascript:alert(1)">a</a><a href=" jav&#x61;script:x">b</a><iframe src="https://x"></iframe><svg><style>.a{fill:red}</style></svg></article>');
    assert.ok(!/<script|onclick|javascript:|<iframe/i.test(article), article);
    assert.ok(article.includes('<style>.a{fill:red}</style>'), 'Mermaid SVG styles survive');
    const doc = buildExportDocument({ title: 'A <b>', article, css: '.md{color:red}', theme: 'light', prefs: DEFAULT_PREFS });
    assert.ok(!/<script/i.test(doc));
    assert.ok(doc.includes("default-src 'none'; img-src data: https: file:; style-src 'unsafe-inline'; font-src data:;"));
    assert.ok(doc.includes('<title>A &lt;b&gt;</title>') && doc.includes('class="vscode-light"') && doc.includes('--measure: 80ch'));
  });

  test('the match theme only takes --vscode-* variables and a known theme class', () => {
    assert.strictEqual(themeVars('--vscode-foo: #fff; color: red; --vscode-bar: 1px </style>; --vscode-x: a{b}'), '--vscode-foo: #fff');
    const doc = buildExportDocument({ title: 't', article: '', css: '', theme: 'match', vars: '--vscode-editor-background: #000', themeClass: 'vscode-dark', prefs: DEFAULT_PREFS });
    assert.ok(doc.includes('--vscode-editor-background: #000') && doc.includes('class="vscode-dark"'));
    const evil = buildExportDocument({ title: 't', article: '', css: '', theme: 'match', vars: '--vscode-a: 1', themeClass: '"><script>', prefs: DEFAULT_PREFS });
    assert.ok(evil.includes('class="vscode-light"') && !evil.includes('<script>'));
  });

  test('images: local sources are rewritten, lazy loading and webview-only srcset are dropped', () => {
    const local = (s: string) => s.startsWith('https://file+.vscode-resource');
    const html = '<p><img src="https://file+.vscode-resource/a.png?x=1&amp;y=2" loading="lazy" alt="a"><img src="https://example.com/b.png"></p><picture><source srcset="https://file+.vscode-resource/c.png 2x"></picture>';
    assert.deepStrictEqual(imageSources(html), ['https://file+.vscode-resource/a.png?x=1&y=2', 'https://example.com/b.png']);
    const out = rewriteImageSources(html, new Map([['https://file+.vscode-resource/a.png?x=1&y=2', 'data:image/png;base64,AA==']]), local);
    assert.ok(out.includes('src="data:image/png;base64,AA=="') && out.includes('src="https://example.com/b.png"'));
    assert.ok(!out.includes('loading=') && !out.includes('srcset'), out);
  });

  test('KaTeX fonts are embedded as woff2 and the other formats dropped', () => {
    const css = '@font-face{src:url(fonts/KaTeX_Main-Regular.woff2) format("woff2"),url(fonts/KaTeX_Main-Regular.woff) format("woff"),url(fonts/KaTeX_Main-Regular.ttf) format("truetype")}';
    assert.strictEqual(inlineKatexFonts(css, (n) => (n === 'KaTeX_Main-Regular.woff2' ? 'QUJD' : undefined)), '@font-face{src:url(data:font/woff2;base64,QUJD) format("woff2")}');
  });

  test('PDF printing uses a throwaway profile and no header or footer', () => {
    const args = printToPdfArgs('file:///tmp/a.html', '/tmp/a.pdf', '/tmp/p');
    assert.ok(args.includes('--headless=new') && args.includes('--no-pdf-header-footer') && args.includes('--print-to-pdf=/tmp/a.pdf') && args.includes('--user-data-dir=/tmp/p'));
    assert.strictEqual(args[args.length - 1], 'file:///tmp/a.html');
  });

  test('reading preferences: defaults, migration of the old font size, and validation', () => {
    assert.deepStrictEqual(readPrefs(undefined, undefined), DEFAULT_PREFS);
    assert.strictEqual(readPrefs(undefined, 18).fontSize, 18);
    assert.strictEqual(readPrefs({ width: 'wide' }, 18).fontSize, DEFAULT_PREFS.fontSize, 'a saved set wins over the legacy key');
    assert.deepStrictEqual(sanitizePrefsPatch({ width: 'huge', font: 'serif', lineHeight: 3, fontSize: 99 }), { font: 'serif', fontSize: 24 });
    assert.strictEqual(prefsCss({ ...DEFAULT_PREFS, width: 'full' })['--measure'], 'none');
  });

  test('webview messages: export HTML over 20 MB, bad targets and empty selections are rejected', () => {
    assert.strictEqual(validateViewerMessage({ type: 'exportHtml', html: 'x'.repeat(20 * 1024 * 1024 + 1), target: 'html' }), undefined);
    assert.strictEqual(validateViewerMessage({ type: 'exportHtml', html: '<p/>', target: 'exe' }), undefined);
    assert.deepStrictEqual(validateViewerMessage({ type: 'exportHtml', html: '<p/>', target: 'pdf' }), { type: 'exportHtml', html: '<p/>', target: 'pdf', preface: undefined, vars: undefined, themeClass: undefined });
    assert.strictEqual(validateViewerMessage({ type: 'askSelection', text: '   ' }), undefined);
    assert.deepStrictEqual(validateViewerMessage({ type: 'askSelection', text: 'hi', line: Infinity }), { type: 'askSelection', text: 'hi', line: undefined });
    assert.strictEqual(validateViewerMessage({ type: 'prefs', patch: { width: 'huge' } }), undefined);
    assert.deepStrictEqual(validateViewerMessage({ type: 'prefs', patch: { width: 'wide' } }), { type: 'prefs', patch: { width: 'wide' } });
  });

  test('a selection is quoted into the draft', () => {
    assert.strictEqual(quoteForDraft('a\r\n\r\nb'), '> a\n>\n> b');
    assert.ok(quoteForDraft('x'.repeat(50), 10).endsWith('…'));
  });
});
