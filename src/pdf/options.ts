/** Webview URLs of the pdf.js asset folders, each ending in `/`. */
export interface PdfAssetUrls {
  cmaps: string;
  standardFonts: string;
  wasm: string;
  iccs: string;
}

/** The document source: the whole file (`data`) or a range transport, plus an optional password. */
export interface PdfLoadInit {
  data?: Uint8Array;
  range?: unknown;
  rangeChunkSize?: number;
  password?: string;
}

/**
 * `getDocument` options for the PDF viewer. `media/pdfview.js` carries a verbatim copy of the block between the
 * markers (it loads no modules); a test compares the two so they cannot drift. No XFA, no scripting, no worker fetches.
 */
export function pdfLoadOptions(urls: PdfAssetUrls, init: PdfLoadInit): Record<string, unknown> {
  // pdf-load-options:begin
  return {
    ...init,
    cMapUrl: urls.cmaps,
    cMapPacked: true,
    standardFontDataUrl: urls.standardFonts,
    wasmUrl: urls.wasm,
    iccUrl: urls.iccs,
    useWorkerFetch: false,
    enableXfa: false,
    isOffscreenCanvasSupported: true,
    disableAutoFetch: true,
    disableStream: true,
    stopAtErrors: false,
    maxImageSize: 64 * 1024 * 1024,
    canvasMaxAreaInBytes: 256 * 1024 * 1024,
  };
  // pdf-load-options:end
}

/** The text between the `pdf-load-options` markers with whitespace collapsed, for the drift check. */
export function loadOptionsBlock(source: string): string | undefined {
  const m = /\/\/ pdf-load-options:begin([\s\S]*?)\/\/ pdf-load-options:end/.exec(source);
  return m ? m[1].replace(/\s+/g, ' ').trim() : undefined;
}
