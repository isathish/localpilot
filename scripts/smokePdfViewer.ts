/**
 * Smoke checks for the PDF viewer (bundled into scripts/smoke.ts): the webview's copy of the pdf.js load options, and
 * the host-side validation of viewer messages (page images, ranges, links).
 */
import * as fs from 'fs';
import * as path from 'path';
import { loadOptionsBlock, pdfLoadOptions } from '../src/pdf/options';
import { isAllowedExternalLink, rangeAllowed, validatePdfViewerMessage } from '../src/pdf/viewerMessages';

type Check = (name: string, cond: boolean, detail?: unknown) => void;

export function pdfViewer(check: Check): void {
  const root = path.join(__dirname, '..');
  const read = (f: string) => fs.readFileSync(path.join(root, f), 'utf8');
  const host = loadOptionsBlock(read('src/pdf/options.ts'));
  check('pdf viewer: webview load options match the host copy', !!host && loadOptionsBlock(read('media/pdfview.js')) === host);
  const o = pdfLoadOptions({ cmaps: 'c/', standardFonts: 's/', wasm: 'w/', iccs: 'i/' }, {});
  check('pdf viewer: no XFA, no worker fetch', o.enableXfa === false && o.useWorkerFetch === false && o.enableScripting === undefined);
  const png = Buffer.from('89504e470d0a1a0a', 'hex').toString('base64');
  check('pdf viewer: a PNG page image is accepted', validatePdfViewerMessage({ type: 'attachImage', name: 'a-p1.png', data: png, mime: 'image/png' })?.type === 'attachImage');
  check('pdf viewer: bad mime or base64 is rejected', !validatePdfViewerMessage({ type: 'attachImage', name: 'a', data: png, mime: 'text/html' }) && !validatePdfViewerMessage({ type: 'attachImage', name: 'a', data: '<svg>', mime: 'image/png' }));
  check('pdf viewer: ranges stay inside the file', rangeAllowed(0, 10, 10) && !rangeAllowed(5, 11, 10));
  check('pdf viewer: only web and mail links leave the viewer', isAllowedExternalLink('https://x.dev') && !isAllowedExternalLink('javascript:alert(1)') && !isAllowedExternalLink('file:///etc/hosts'));
}
