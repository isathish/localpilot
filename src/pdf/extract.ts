import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

/**
 * PDF text extraction. pdf.js never runs in the extension host: it takes VS Code's Electron utility process for a
 * browser, and a hostile PDF must not be able to take the host's memory down with it. Every call forks a plain-Node
 * child (`dist/pdf/extract-child.js`), which loads the bundled pdf.js and replies with the text.
 */

export interface PdfPage {
  n: number;
  text: string;
  empty: boolean;
}

export interface PdfText {
  path: string;
  numPages: number;
  from: number;
  to: number;
  pages: PdfPage[];
  info?: { title?: string; author?: string; producer?: string };
  outline?: string[];
  truncated: boolean;
  encrypted: boolean;
}

export interface ExtractOptions {
  from?: number;
  to?: number;
  maxChars?: number;
  password?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/** What the parent sends the child. */
export interface ExtractRequest {
  file?: string;
  data?: Uint8Array;
  from?: number;
  to?: number;
  maxChars: number;
  password?: string;
  lib: string;
  assets: string;
}

export type ExtractReply = { ok: true; result: Omit<PdfText, 'path'> } | { ok: false; name: string; message: string };

export const MIN_NODE = [22, 13] as const;

/** Throws when this Node cannot run pdf.js (only possible in the CLI on an old Node). */
export function assertNodeVersion(version = process.versions.node): void {
  const [maj, min] = version.split('.').map(Number);
  if (maj < MIN_NODE[0] || (maj === MIN_NODE[0] && min < MIN_NODE[1])) {
    throw new Error(`Reading PDFs needs Node.js ${MIN_NODE.join('.')} or newer (you have ${version}).`);
  }
}

/**
 * Where pdf.js lives: `lib` holds `pdf.mjs` (and `pdf.worker.mjs` beside it), `assets` holds `cmaps/`,
 * `standard_fonts/`, `wasm/` and `iccs/`. In the packaged extension and CLI both are `dist/pdfjs`; with
 * `LOCALPILOT_PDFJS_DIR` pointing at `node_modules/pdfjs-dist/legacy/build` the assets sit two levels up.
 */
export function pdfjsDir(): { lib: string; assets: string } {
  const candidates = [
    process.env.LOCALPILOT_PDFJS_DIR,
    path.join(__dirname, 'pdfjs'),
    // Compiled sources (out/pdf) in tests: the built dist/ next to them, else the package itself.
    path.resolve(__dirname, '..', '..', 'dist', 'pdfjs'),
    path.resolve(__dirname, '..', '..', 'node_modules', 'pdfjs-dist', 'legacy', 'build'),
  ].filter((d): d is string => !!d);
  const lib = candidates.find((d) => fs.existsSync(path.join(d, 'pdf.mjs'))) ?? candidates[0];
  const assets = fs.existsSync(path.join(lib, 'cmaps')) ? lib : path.resolve(lib, '..', '..');
  return { lib, assets };
}

/** The child script: bundled next to the extension (`dist/pdf/extract-child.js`), or the compiled source in tests. */
export function childPath(): string {
  const candidates = [
    path.join(__dirname, 'pdf', 'extract-child.js'),
    path.join(__dirname, 'extractChild.js'),
    path.resolve(__dirname, '..', '..', 'dist', 'pdf', 'extract-child.js'),
  ];
  return candidates.find((c) => fs.existsSync(c)) ?? candidates[0];
}

/** A 1-based page range: "3", "3-7", "5-" (to the end), "-2" (the last two). Throws with a message the model can act on. */
export function parsePageRange(s: string, numPages: number): { from: number; to: number } {
  const t = s.trim().replace(/^pages?\s*/i, '').replace(/\s+/g, '').replace(/[–—]/g, '-');
  let from: number;
  let to: number;
  let m: RegExpExecArray | null;
  if ((m = /^(\d+)$/.exec(t))) {
    from = to = Number(m[1]);
  } else if ((m = /^(\d+)-(\d+)$/.exec(t))) {
    from = Number(m[1]);
    to = Number(m[2]);
  } else if ((m = /^(\d+)-$/.exec(t))) {
    from = Number(m[1]);
    to = numPages;
  } else if ((m = /^-(\d+)$/.exec(t))) {
    from = Math.max(1, numPages - Number(m[1]) + 1);
    to = numPages;
  } else {
    throw new Error(`Invalid page range "${s}": use "3", "3-7", "5-" or "-2".`);
  }
  if (from < 1 || to < from) {
    throw new Error(`Invalid page range "${s}": pages start at 1 and the range must not run backwards.`);
  }
  if (from > numPages) {
    throw new Error(`Page ${from} is past the end: the PDF has ${numPages} page${numPages === 1 ? '' : 's'}.`);
  }
  return { from, to: Math.min(to, numPages) };
}

/** The part of a pdf.js text item the line rebuild reads. Marked-content items (no `str`) are skipped. */
export interface TextItemLike {
  str?: string;
  hasEOL?: boolean;
  transform?: number[];
  width?: number;
  height?: number;
}

/**
 * Rebuilds page text from pdf.js items in stream order: a newline at `hasEOL` or when the baseline moves by more than
 * half the font height, a space when the horizontal gap exceeds a quarter of it. Hyphenation is left as it is.
 */
export function joinTextItems(items: TextItemLike[]): string {
  let out = '';
  let prev: { x2: number; y: number; h: number } | undefined;
  for (const it of items) {
    if (typeof it.str !== 'string') {
      continue;
    }
    const t = it.transform;
    const x = t?.[4];
    const y = t?.[5];
    const h = Math.abs(it.height || t?.[3] || 0);
    if (prev && typeof x === 'number' && typeof y === 'number') {
      const unit = Math.max(h, prev.h, 1);
      if (Math.abs(y - prev.y) > 0.5 * unit) {
        if (out && !out.endsWith('\n')) {
          out += '\n';
        }
      } else if (x - prev.x2 > 0.25 * unit && out && !/\s$/.test(out) && !/^\s/.test(it.str)) {
        out += ' ';
      }
    }
    out += it.str;
    if (it.hasEOL) {
      out += '\n';
    }
    prev = typeof x === 'number' && typeof y === 'number' ? { x2: x + (it.width ?? 0), y, h } : undefined;
  }
  return out
    .replace(/[\u0000\uFFFD]+/g, '')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim();
}

const NO_TEXT = '(no extractable text — scanned image; ask the user to attach the page as an image for a vision model)';

/** The text the model reads; same shape as read_file (header, then the content, then where to continue). */
export function formatPdfText(r: PdfText, display: string): string {
  const shown = r.pages.length ? `showing page${r.from === r.to ? ` ${r.from}` : `s ${r.from}-${r.to}`}` : 'no pages shown';
  const title = r.info?.title ? ` — Title: "${r.info.title}"` : '';
  const lines = [`PDF: ${display} (${r.numPages} page${r.numPages === 1 ? '' : 's'}, ${shown})${title}`];
  if (r.info?.author) {
    lines.push(`Author: ${r.info.author}`);
  }
  if (r.outline?.length) {
    lines.push(`Outline: ${r.outline.join(' · ')}`);
  }
  for (const p of r.pages) {
    lines.push(`--- Page ${p.n} ---`, p.empty ? NO_TEXT : p.text);
  }
  if (r.pages.length && r.pages.every((p) => p.empty)) {
    lines.push('(None of these pages has a text layer: the PDF is probably scanned.)');
  }
  if (r.to < r.numPages) {
    const next = `${r.to + 1}-${Math.min(r.numPages, r.to + 20)}`;
    lines.push(`… ${r.truncated ? 'stopped at the character limit; ' : ''}read more with read_pdf path="${display}" pages="${next}"`);
  } else if (r.truncated) {
    lines.push('… [the last page was cut at the character limit]');
  }
  return lines.join('\n');
}

/** Extracts the text of a PDF file (path) or of PDF bytes in a forked child process. */
export function extractPdfText(fsPathOrBytes: string | Uint8Array, opts: ExtractOptions = {}): Promise<PdfText> {
  assertNodeVersion();
  const { lib, assets } = pdfjsDir();
  if (!fs.existsSync(path.join(lib, 'pdf.mjs'))) {
    return Promise.reject(new Error(`pdf.js is missing from this installation (looked in ${lib}); reinstall LocalPilot.`));
  }
  const script = childPath();
  if (!fs.existsSync(script)) {
    return Promise.reject(new Error(`The PDF extractor is missing from this installation (${script}); reinstall LocalPilot.`));
  }
  if (opts.signal?.aborted) {
    return Promise.reject(new Error('PDF extraction cancelled'));
  }
  const req: ExtractRequest = {
    ...(typeof fsPathOrBytes === 'string' ? { file: fsPathOrBytes } : { data: fsPathOrBytes }),
    from: opts.from,
    to: opts.to,
    maxChars: opts.maxChars ?? 60_000,
    password: opts.password,
    lib,
    assets,
  };
  return new Promise<PdfText>((resolve, reject) => {
    const child = cp.fork(script, [], {
      execPath: process.execPath,
      // VS Code's executable is Electron: this makes it a plain Node (harmless under node itself, as in the CLI).
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      execArgv: ['--max-old-space-size=1024'],
      serialization: 'advanced',
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    let stderr = '';
    let settled = false;
    const finish = (err: Error | undefined, value?: PdfText) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
      }
      if (err) {
        reject(err);
      } else {
        resolve(value!);
      }
    };
    const onAbort = () => finish(new Error('PDF extraction cancelled'));
    const timer = setTimeout(() => finish(new Error('PDF extraction timed out')), Math.max(1, opts.timeoutMs ?? 60_000));
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    child.stderr?.on('data', (d: Buffer) => {
      stderr = (stderr + d.toString()).slice(-2000);
    });
    child.on('message', (m: ExtractReply) => {
      if (m && m.ok) {
        finish(undefined, { path: typeof fsPathOrBytes === 'string' ? fsPathOrBytes : '', ...m.result });
      } else if (m) {
        const e = new Error(m.message);
        e.name = m.name;
        finish(e);
      }
    });
    child.on('error', (e) => finish(e));
    child.on('exit', (code, signal) => finish(new Error(`PDF extraction failed (${signal ?? `exit ${code}`})${stderr.trim() ? `: ${stderr.trim().split('\n').slice(-3).join(' ')}` : ''}`)));
    child.send(req);
  });
}

/** Turns an extraction error into the sentence the model and the user see. */
export function describePdfError(e: unknown, passwordGiven: boolean): string {
  const name = e instanceof Error ? e.name : '';
  const msg = e instanceof Error ? e.message : String(e);
  if (name === 'PasswordException') {
    return passwordGiven ? 'The password for this PDF is incorrect; ask the user for the right one.' : 'This PDF is password-protected; pass password or ask the user.';
  }
  if (name === 'InvalidPDFException') {
    return `This file is not a valid PDF or is damaged (${msg}).`;
  }
  return msg;
}
