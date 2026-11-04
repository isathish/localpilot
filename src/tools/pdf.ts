import * as fs from 'fs';
import { Tool, ToolContext, ToolResult } from '../types';
import { getConfig } from '../config';
import { describePdfError, extractPdfText, formatPdfText, parsePageRange } from '../pdf/extract';
import { displayPath, resolveWorkspacePath } from './fs';

/** Pages returned by one read_pdf call at most. */
export const PDF_PAGES_PER_CALL = 20;

/** True when the first kilobyte holds the `%PDF-` signature (it may follow a little junk, as readers allow). */
export function looksLikePdf(head: Uint8Array): boolean {
  return Buffer.from(head.subarray(0, 1024)).includes('%PDF-');
}

async function readHead(fsPath: string): Promise<Buffer> {
  const fh = await fs.promises.open(fsPath, 'r');
  try {
    const buf = Buffer.alloc(1024);
    const { bytesRead } = await fh.read(buf, 0, 1024, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}

/** Runs a PDF read for the tool: the path checks, page-range handling and error wording shared by read_pdf and read_file. */
export async function readPdf(args: { path: string; pages?: string; password?: string }, ctx: ToolContext): Promise<ToolResult> {
  const uri = resolveWorkspacePath(args.path, ctx);
  const rel = displayPath(uri, ctx);
  let size: number;
  try {
    const st = await fs.promises.stat(uri.fsPath);
    if (!st.isFile()) {
      return { content: `${rel} is not a file.`, isError: true };
    }
    size = st.size;
  } catch {
    return { content: `${rel} does not exist.`, isError: true };
  }
  const { maxReadSizeMB, maxChars } = getConfig().pdf;
  if (size > maxReadSizeMB * 1024 * 1024) {
    return { content: `${rel} is ${(size / 1024 / 1024).toFixed(1)} MB, over the ${maxReadSizeMB} MB limit for reading PDFs (localpilot.pdf.maxReadSizeMB).`, isError: true };
  }
  if (!looksLikePdf(await readHead(uri.fsPath))) {
    return { content: `${rel} is not a PDF (no %PDF- header). Read it with read_file instead.`, isError: true };
  }
  const password = args.password || undefined;
  try {
    let from = 1;
    let to = PDF_PAGES_PER_CALL;
    if (args.pages?.trim()) {
      // Only "-N" (the last N pages) needs the page count up front; past-the-end starts are reported after the read.
      const count = /^\s*-\s*\d+\s*$/.test(args.pages) ? (await extractPdfText(uri.fsPath, { from: 1, to: 1, maxChars: 1, password, signal: ctx.signal })).numPages : Number.MAX_SAFE_INTEGER;
      ({ from, to } = parsePageRange(args.pages, count));
      to = Math.min(to, from + PDF_PAGES_PER_CALL - 1);
    }
    const r = await extractPdfText(uri.fsPath, { from, to, maxChars, password, signal: ctx.signal });
    if (from > r.numPages) {
      return { content: `Page ${from} is past the end: ${rel} has ${r.numPages} page${r.numPages === 1 ? '' : 's'}.`, isError: true };
    }
    return { content: formatPdfText(r, rel) };
  } catch (e) {
    return { content: describePdfError(e, !!password), isError: true };
  }
}

export const readPdfTool: Tool = {
  parallelSafe: true,
  definition: {
    name: 'read_pdf',
    description:
      'Extract the text of a PDF in the workspace, page by page. Use pages to read a range ("3", "3-7", "10-"); at most 20 pages or 60,000 characters per call. Scanned pages have no text.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Workspace-relative or absolute path to the .pdf file' },
        pages: { type: 'string', description: 'Page range, 1-based, e.g. "1-5"' },
        password: { type: 'string', description: 'Password of a protected PDF (only when the user gave one)' },
      },
      required: ['path'],
    },
  },
  async execute(args, ctx) {
    if (typeof args.path !== 'string' || !args.path) {
      throw new Error('Missing required string argument "path"');
    }
    const pages = typeof args.pages === 'number' ? String(args.pages) : typeof args.pages === 'string' ? args.pages : undefined;
    return readPdf({ path: args.path, pages, password: typeof args.password === 'string' ? args.password : undefined }, ctx);
  },
};

export const pdfTools: Tool[] = [readPdfTool];
