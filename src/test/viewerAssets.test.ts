import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

suite('LocalPilot vendored viewer assets', () => {
  const root = () => vscode.extensions.getExtension('localpilot.localpilot-agent')!.extensionPath;

  test('the build copies pdf.js, KaTeX, Mermaid and the notices into dist/', () => {
    const dist = path.join(root(), 'dist');
    const expected = [
      'pdfjs/pdf.mjs',
      'pdfjs/pdf.worker.mjs',
      'pdfjs/pdf_viewer.mjs',
      'pdfjs/pdf_viewer.css',
      'pdfjs/images',
      'pdfjs/cmaps/UniJIS-UTF16-H.bcmap',
      'pdfjs/standard_fonts/FoxitSerif.pfb',
      'pdfjs/wasm/openjpeg.wasm',
      'pdfjs/LICENSE',
      'webview/katex/katex.min.css',
      'webview/mermaid.js',
      'THIRD_PARTY_NOTICES.txt',
    ];
    const missing = expected.filter((f) => !fs.existsSync(path.join(dist, f)));
    assert.deepStrictEqual(missing, []);
    // Scripting is never enabled, so its sandbox is not shipped; source maps stay out of the package.
    assert.ok(!fs.readdirSync(path.join(dist, 'pdfjs', 'wasm')).some((f) => /quickjs/i.test(f)));
    assert.ok(!fs.readdirSync(path.join(dist, 'pdfjs')).some((f) => f.endsWith('.map')));
    assert.ok(fs.readdirSync(path.join(dist, 'webview', 'katex', 'fonts')).some((f) => f.endsWith('.woff2')));
    const notices = fs.readFileSync(path.join(dist, 'THIRD_PARTY_NOTICES.txt'), 'utf8');
    assert.ok(/pdfjs-dist/.test(notices) && /mermaid/.test(notices) && /KaTeX/.test(notices) && /DOMPurify/.test(notices));
  });

  test('pdf.js and Mermaid are not bundled into the extension', () => {
    const ext = fs.readFileSync(path.join(root(), 'dist', 'extension.js'), 'utf8');
    assert.ok(!/GlobalWorkerOptions/.test(ext), 'pdf.js leaked into dist/extension.js');
    assert.ok(!/flowchart-v2/.test(ext), 'Mermaid leaked into dist/extension.js');
  });

  test('the PDF extractor child is built for Node 22 next to the extension', function () {
    if (!fs.existsSync(path.join(root(), 'src', 'pdf', 'extractChild.ts'))) {
      this.skip();
    }
    assert.ok(fs.existsSync(path.join(root(), 'dist', 'pdf', 'extract-child.js')));
  });
});
