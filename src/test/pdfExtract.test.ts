import * as assert from 'assert';
import { assertNodeVersion, extractPdfText, formatPdfText, joinTextItems, parsePageRange, PdfText } from '../pdf/extract';
import { attachmentKind, binaryNote, extractDocumentText, looksBinary, notebookToText, splitAttachmentRef } from '../context/extractors';
import { makePdf } from './fixtures/makePdf';
import { makeDocx, makeZip } from './fixtures/makeDocx';

suite('PDF text (pure)', () => {
  test('parsePageRange accepts single pages, ranges, open ends and "last N"', () => {
    assert.deepStrictEqual(parsePageRange('3', 10), { from: 3, to: 3 });
    assert.deepStrictEqual(parsePageRange('3-7', 10), { from: 3, to: 7 });
    assert.deepStrictEqual(parsePageRange(' 3 – 7 ', 10), { from: 3, to: 7 });
    assert.deepStrictEqual(parsePageRange('5-', 10), { from: 5, to: 10 });
    assert.deepStrictEqual(parsePageRange('-2', 10), { from: 9, to: 10 });
    assert.deepStrictEqual(parsePageRange('8-30', 10), { from: 8, to: 10 }, 'the end is clamped');
    assert.throws(() => parsePageRange('0', 10), /start at 1/);
    assert.throws(() => parsePageRange('7-3', 10), /backwards/);
    assert.throws(() => parsePageRange('abc', 10), /Invalid page range/);
    assert.throws(() => parsePageRange('12', 10), /past the end.*10 pages/);
  });

  test('joinTextItems rebuilds lines and spaces from item positions', () => {
    const at = (str: string, x: number, y: number, width: number, hasEOL = false) => ({ str, transform: [12, 0, 0, 12, x, y], width, height: 12, hasEOL });
    assert.strictEqual(joinTextItems([at('Hello', 72, 720, 30), at('world', 110, 720, 30)]), 'Hello world', 'an x gap is a space');
    assert.strictEqual(joinTextItems([at('Hel', 72, 720, 18), at('lo', 90, 720, 12)]), 'Hello', 'touching items join');
    assert.strictEqual(joinTextItems([at('one', 72, 720, 20), at('two', 72, 706, 20)]), 'one\ntwo', 'a baseline change is a newline');
    assert.strictEqual(joinTextItems([at('one', 72, 720, 20, true), at('two', 72, 706, 20)]), 'one\ntwo', 'hasEOL does not double the newline');
    assert.strictEqual(joinTextItems([at('inter-', 72, 720, 30, true), at('national', 72, 706, 40)]), 'inter-\nnational', 'hyphenation is left as it is');
    assert.strictEqual(joinTextItems([{}, at('a\u0000b\uFFFD', 72, 720, 20)]), 'ab', 'marked content skipped, junk stripped');
    assert.strictEqual(joinTextItems([at('a', 72, 720, 5, true), at('', 0, 0, 0, true), at('', 0, 0, 0, true), at('', 0, 0, 0, true), at('', 0, 0, 0, true), at('b', 72, 600, 5)]), 'a\n\n\nb', 'runs of blank lines collapse');
  });

  test('formatPdfText: header, outline, empty pages and the read-more hint', () => {
    const r: PdfText = {
      path: '/x/spec.pdf',
      numPages: 42,
      from: 1,
      to: 2,
      pages: [
        { n: 1, text: 'Intro', empty: false },
        { n: 2, text: '', empty: true },
      ],
      info: { title: 'Spec', author: 'Ann' },
      outline: ['1 Introduction', '2 Architecture'],
      truncated: false,
      encrypted: false,
    };
    const out = formatPdfText(r, 'docs/spec.pdf');
    assert.match(out, /^PDF: docs\/spec\.pdf \(42 pages, showing pages 1-2\) — Title: "Spec"/);
    assert.match(out, /Outline: 1 Introduction · 2 Architecture/);
    assert.match(out, /--- Page 1 ---\nIntro/);
    assert.match(out, /--- Page 2 ---\n\(no extractable text — scanned image/);
    assert.match(out, /read more with read_pdf path="docs\/spec\.pdf" pages="3-22"/);
    const all = formatPdfText({ ...r, numPages: 2, truncated: true, pages: [{ n: 1, text: '', empty: true }], to: 1, from: 1 }, 'a.pdf');
    assert.match(all, /showing page 1\)/);
    assert.match(all, /stopped at the character limit; read more with read_pdf path="a\.pdf" pages="2-2"/);
    assert.match(all, /probably scanned/);
  });

  test('the Node version guard names the requirement', () => {
    assert.throws(() => assertNodeVersion('20.11.0'), /Node\.js 22\.13 or newer \(you have 20\.11\.0\)/);
    assert.doesNotThrow(() => assertNodeVersion('22.13.0'));
    assert.doesNotThrow(() => assertNodeVersion('24.1.0'));
  });

  test('extractPdfText reads a generated PDF in a child process', async function () {
    this.timeout(30_000);
    const r = await extractPdfText(makePdf(['Hello LocalPilot\nline two', 'Second page'], { outline: true }));
    assert.strictEqual(r.numPages, 2);
    assert.deepStrictEqual(r.pages.map((p) => p.text), ['Hello LocalPilot\nline two', 'Second page']);
    assert.deepStrictEqual(r.outline, ['Page 1', 'Page 2']);
    const only2 = await extractPdfText(makePdf(['one', 'two', 'three']), { from: 2, to: 2 });
    assert.deepStrictEqual(only2.pages.map((p) => p.n), [2]);
  });

  test('character limit, password, damaged files and the timeout', async function () {
    this.timeout(30_000);
    const long = await extractPdfText(makePdf(Array.from({ length: 5 }, (_, i) => `Page ${i + 1} `.repeat(8))), { maxChars: 150 });
    assert.ok(long.truncated && long.to < 5, `stopped early: ${long.to}`);
    await assert.rejects(extractPdfText(makePdf(['Secret'], { password: 'user' })), (e: Error) => e.name === 'PasswordException');
    const open = await extractPdfText(makePdf(['Secret text'], { password: 'user' }), { password: 'user' });
    assert.strictEqual(open.pages[0].text, 'Secret text');
    assert.ok(open.encrypted);
    await assert.rejects(extractPdfText(new Uint8Array(Buffer.from('not a pdf at all'))), (e: Error) => e.name === 'InvalidPDFException');
    await assert.rejects(extractPdfText(makePdf(['x']), { timeoutMs: 1 }), /timed out/);
    const ac = new AbortController();
    ac.abort();
    await assert.rejects(extractPdfText(makePdf(['x']), { signal: ac.signal }), /cancelled/);
  });

  test('a PDF with JavaScript is read as text and nothing runs', async function () {
    this.timeout(30_000);
    const r = await extractPdfText(makePdf(['Scripted'], { js: true }));
    assert.strictEqual(r.pages[0].text, 'Scripted');
  });
});

suite('Document attachments (pure)', () => {
  test('attachmentKind and the binary sniff', () => {
    assert.strictEqual(attachmentKind('a/B.PDF'), 'pdf');
    assert.strictEqual(attachmentKind('n.ipynb'), 'ipynb');
    assert.strictEqual(attachmentKind('w.docx'), 'docx');
    assert.strictEqual(attachmentKind('x.png'), 'image');
    assert.strictEqual(attachmentKind('x.zip'), 'binary');
    assert.strictEqual(attachmentKind('x.ts'), 'text');
    assert.ok(looksBinary(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00])));
    assert.ok(!looksBinary(Buffer.from('plain text\nwith lines\n')));
    assert.ok(!looksBinary(Buffer.from([0xff, 0xfe, 0x61, 0x00])), 'UTF-16 with a BOM is text');
    assert.strictEqual(binaryNote('a.zip', 2048), '(Binary or unsupported file: a.zip, 2.0 KB)');
  });

  test('splitAttachmentRef reads line and page ranges', () => {
    assert.deepStrictEqual(splitAttachmentRef('a.ts#L3-L7'), { path: 'a.ts', start: 3, end: 7 });
    assert.deepStrictEqual(splitAttachmentRef('a.ts#L3'), { path: 'a.ts', start: 3, end: undefined });
    assert.deepStrictEqual(splitAttachmentRef('d.pdf#page=2'), { path: 'd.pdf', start: 2, end: undefined, page: true });
    assert.deepStrictEqual(splitAttachmentRef('d.pdf#page=2-4'), { path: 'd.pdf', start: 2, end: 4, page: true });
    assert.deepStrictEqual(splitAttachmentRef('src/x#y.ts'), { path: 'src/x#y.ts' });
  });

  test('notebooks become cells with their text outputs', () => {
    const nb = JSON.stringify({
      metadata: { language_info: { name: 'python' } },
      cells: [
        { cell_type: 'markdown', source: ['# Title\n', 'Intro'] },
        { cell_type: 'code', source: 'print(1)', outputs: [{ output_type: 'stream', text: ['1\n'] }, { output_type: 'display_data', data: { 'image/png': 'iVBO', 'text/plain': '<Figure>' } }, { output_type: 'execute_result', data: { 'text/plain': ['42'] } }, { output_type: 'error', ename: 'ValueError', evalue: 'bad' }] },
      ],
    });
    assert.strictEqual(notebookToText(nb), '--- Cell 1 (markdown) ---\n# Title\nIntro\n--- Cell 2 (code, python) ---\nprint(1)\nOutput:\n1\n[image output]\n42\nValueError: bad');
    assert.match(notebookToText(JSON.stringify({ cells: [{ cell_type: 'code', source: 'x', outputs: [{ output_type: 'stream', text: 'y'.repeat(50) }] }] }), 10), /output cut at 10 characters/);
    assert.throws(() => notebookToText('{"nbformat": 4}'), /not a Jupyter notebook/);
  });

  test('extractDocumentText: docx through mammoth, binaries as a note, text left to the editor', async () => {
    assert.strictEqual(await extractDocumentText('w.docx', makeDocx(['Hello Word', 'Second <para> & more'])), 'Hello Word\n\nSecond <para> & more');
    assert.strictEqual(await extractDocumentText('a.zip', makeZip({ 'x.txt': 'hi' })), '(Binary or unsupported file: a.zip, 110 B)');
    assert.match((await extractDocumentText('blob.dat', Buffer.from([1, 0, 2])))!, /Binary or unsupported file: blob\.dat/);
    assert.strictEqual(await extractDocumentText('a.ts', Buffer.from('const x = 1;')), undefined);
  });
});
