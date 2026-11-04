/**
 * Smoke checks for document text (bundled into scripts/smoke.ts): PDF extraction in the forked child (built by
 * run-smoke.js to out/pdf/extract-child.js, pdf.js from LOCALPILOT_PDFJS_DIR), page ranges and the attachment dispatch
 * for notebooks, Word documents and binaries.
 */
import { extractPdfText, formatPdfText, parsePageRange } from '../src/pdf/extract';
import { attachmentKind, extractDocumentText, splitAttachmentRef } from '../src/context/extractors';
import { makePdf } from '../src/test/fixtures/makePdf';
import { makeDocx, makeZip } from '../src/test/fixtures/makeDocx';

type Check = (name: string, cond: boolean, detail?: unknown) => void;

export async function documents(check: Check): Promise<void> {
  console.log('\n— documents —');
  check('parsePageRange: "3-7", "5-", "-2"', JSON.stringify([parsePageRange('3-7', 9), parsePageRange('5-', 9), parsePageRange('-2', 9)]) === JSON.stringify([{ from: 3, to: 7 }, { from: 5, to: 9 }, { from: 8, to: 9 }]));
  try {
    const r = await extractPdfText(makePdf(['smoke text', 'page two']), { from: 1, to: 1 });
    const out = formatPdfText(r, 'smoke.pdf');
    check('extractPdfText reads a PDF in a forked child', r.numPages === 2 && r.pages[0].text === 'smoke text' && /pages="2-2"/.test(out), out);
  } catch (e) {
    check('extractPdfText reads a PDF in a forked child', false, e);
  }
  const locked = await extractPdfText(makePdf(['x'], { password: 'pw' })).then(() => 'opened', (e: Error) => e.name);
  check('a password-protected PDF is reported as such', locked === 'PasswordException', locked);
  check('attachment kinds by extension', ['a.pdf', 'b.ipynb', 'c.docx', 'd.png', 'e.zip', 'f.ts'].map(attachmentKind).join() === 'pdf,ipynb,docx,image,binary,text');
  check('#page= and #L ranges', splitAttachmentRef('a.pdf#page=2-3').start === 2 && splitAttachmentRef('a.pdf#page=2-3').end === 3 && splitAttachmentRef('a.ts#L4').start === 4);
  const nb = await extractDocumentText('n.ipynb', Buffer.from(JSON.stringify({ cells: [{ cell_type: 'code', source: 'x = 1', outputs: [{ output_type: 'display_data', data: { 'image/png': '' } }] }] })));
  check('notebooks as cells, images as [image output]', !!nb && nb.includes('x = 1') && nb.includes('[image output]'), nb);
  const docx = await extractDocumentText('w.docx', makeDocx(['Smoke paragraph']));
  check('docx text through mammoth', docx === 'Smoke paragraph', docx);
  const zip = await extractDocumentText('a.zip', makeZip({ 'x': 'y' }));
  check('binaries become a visible note', !!zip && zip.startsWith('(Binary or unsupported file: a.zip'), zip);
}
