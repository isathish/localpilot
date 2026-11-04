import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { ExtractReply, ExtractRequest, joinTextItems, PdfPage, TextItemLike } from './extract';

/**
 * Forked by `extractPdfText` as plain Node (ELECTRON_RUN_AS_NODE). Receives one request, replies once, exits.
 * pdf.js is ESM only: the specifier below is computed, so neither esbuild nor tsc rewrites the `import()` into a
 * `require` — keep it that way.
 */

interface PdfjsDoc {
  numPages: number;
  getPage(n: number): Promise<{ getTextContent(o: object): Promise<{ items: TextItemLike[] }> }>;
  getMetadata(): Promise<{ info?: Record<string, unknown> }>;
  getOutline(): Promise<{ title: string; items?: { title: string }[] }[] | null>;
}

async function run(req: ExtractRequest): Promise<ExtractReply> {
  const url = pathToFileURL(path.join(req.lib, 'pdf.mjs')).href;
  const pdfjs = (await import(url)) as { getDocument(o: object): { promise: Promise<PdfjsDoc>; destroy(): Promise<void> } };
  const data = req.data ? new Uint8Array(req.data) : new Uint8Array(fs.readFileSync(req.file!));
  // pdf.js insists on a trailing '/' (a Windows `\` is rejected); forward slashes work for Node's fs everywhere.
  const dir = (d: string) => `${path.join(req.assets, d).replace(/\\/g, '/')}/`;
  const task = pdfjs.getDocument({
    data,
    password: req.password,
    cMapUrl: dir('cmaps'),
    cMapPacked: true,
    standardFontDataUrl: dir('standard_fonts'),
    wasmUrl: dir('wasm'),
    iccUrl: dir('iccs'),
    useSystemFonts: false,
    disableFontFace: true,
    isOffscreenCanvasSupported: false,
    enableXfa: false,
    verbosity: 0,
  });
  const doc = await task.promise;
  const numPages = doc.numPages;
  const from = Math.max(1, Math.min(req.from ?? 1, numPages));
  const last = Math.max(from, Math.min(req.to ?? numPages, numPages));
  const pages: PdfPage[] = [];
  let chars = 0;
  let truncated = false;
  for (let n = from; n <= last; n++) {
    const page = await doc.getPage(n);
    const content = await page.getTextContent({ includeMarkedContent: false, disableNormalization: false });
    let text = joinTextItems(content.items);
    if (chars + text.length > req.maxChars) {
      truncated = true;
      if (pages.length) {
        break;
      }
      // A single page larger than the whole budget is cut rather than skipped.
      text = `${text.slice(0, req.maxChars)}\n… [page cut at ${req.maxChars.toLocaleString()} characters]`;
    }
    chars += text.length;
    pages.push({ n, text, empty: !text.trim() });
    if (truncated) {
      break;
    }
  }
  const meta = await doc.getMetadata().catch(() => ({ info: undefined }));
  const info = meta.info ?? {};
  const s = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 300) : undefined);
  const outline: string[] = [];
  for (const top of (await doc.getOutline().catch(() => null)) ?? []) {
    outline.push(top.title);
    for (const sub of top.items ?? []) {
      outline.push(sub.title);
    }
  }
  await task.destroy().catch(() => undefined);
  return {
    ok: true,
    result: {
      numPages,
      from,
      to: pages.length ? pages[pages.length - 1].n : from,
      pages,
      info: { title: s(info.Title), author: s(info.Author), producer: s(info.Producer) },
      outline: outline.slice(0, 60).map((t) => t.replace(/\s+/g, ' ').trim()).filter(Boolean),
      truncated,
      encrypted: !!info.EncryptFilterName || !!req.password,
    },
  };
}

process.once('message', (req: ExtractRequest) => {
  run(req)
    .catch((e: unknown): ExtractReply => ({ ok: false, name: (e as { name?: string })?.name ?? 'Error', message: e instanceof Error ? e.message : String(e) }))
    .then((reply) => process.send!(reply, () => process.exit(0)));
});
