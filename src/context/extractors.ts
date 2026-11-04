import * as path from 'path';

/**
 * Text for files the editor cannot open as text: dispatch by extension, Jupyter notebooks as cells, Word documents
 * through mammoth, and a visible note for other binaries instead of an empty attachment. No VS Code here, so the
 * smoke test and the CLI use the same code. PDFs go through `src/pdf/extract.ts` (a forked child).
 */

export type AttachmentKind = 'pdf' | 'ipynb' | 'docx' | 'image' | 'binary' | 'text';

const IMAGE = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'tif', 'tiff', 'heic', 'avif']);
const BINARY = new Set([
  'zip', 'gz', 'tgz', 'bz2', 'xz', 'zst', 'tar', '7z', 'rar', 'jar', 'war', 'apk', 'ipa', 'dmg', 'iso', 'deb', 'rpm', 'msi',
  'exe', 'dll', 'so', 'dylib', 'bin', 'o', 'a', 'lib', 'obj', 'class', 'pyc', 'pyo', 'wasm', 'node',
  'mp3', 'mp4', 'm4a', 'mov', 'avi', 'mkv', 'webm', 'wav', 'flac', 'ogg', 'aac',
  'woff', 'woff2', 'ttf', 'otf', 'eot', 'psd', 'ai', 'sketch', 'fig',
  'doc', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods', 'odp', 'pages', 'numbers', 'key', 'epub',
  'sqlite', 'sqlite3', 'db', 'parquet', 'pkl', 'pickle', 'npy', 'npz', 'onnx', 'pt', 'pth', 'safetensors', 'gguf',
]);

/** How a file is turned into attachment text, from its extension alone. Unknown extensions are `text` (then sniffed). */
export function attachmentKind(fsPath: string): AttachmentKind {
  const ext = path.extname(fsPath).slice(1).toLowerCase();
  if (ext === 'pdf' || ext === 'ipynb' || ext === 'docx') {
    return ext;
  }
  if (IMAGE.has(ext)) {
    return 'image';
  }
  return BINARY.has(ext) ? 'binary' : 'text';
}

/** True when the first bytes look binary: a NUL byte, or mostly control characters (UTF-16 without a BOM, packed data). */
export function looksBinary(head: Uint8Array): boolean {
  const n = Math.min(head.length, 8192);
  if (n >= 2 && ((head[0] === 0xff && head[1] === 0xfe) || (head[0] === 0xfe && head[1] === 0xff))) {
    return false;
  }
  let control = 0;
  for (let i = 0; i < n; i++) {
    const b = head[i];
    if (b === 0) {
      return true;
    }
    if (b < 9 || (b > 13 && b < 32)) {
      control++;
    }
  }
  return n > 0 && control / n > 0.1;
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** The note that replaces the content of a file that has no text to attach. */
export function binaryNote(name: string, size: number, kind: AttachmentKind = 'binary'): string {
  return kind === 'image'
    ? `(Image file: ${name}, ${formatSize(size)}. Attach it as an image so a vision model can see it.)`
    : `(Binary or unsupported file: ${name}, ${formatSize(size)})`;
}

/**
 * Splits an attachment reference into the path and an optional range: `file#L3-L7` / `file#L3-7` (lines, or pages for
 * a PDF), `file.pdf#page=3` or `file.pdf#page=3-7`.
 */
export function splitAttachmentRef(ref: string): { path: string; start?: number; end?: number; page?: boolean } {
  const page = /^(.*?)#page=(\d+)(?:-(\d+))?$/.exec(ref);
  if (page) {
    return { path: page[1], start: Number(page[2]), end: page[3] ? Number(page[3]) : undefined, page: true };
  }
  const lines = /^(.*?)#L(\d+)(?:-L?(\d+))?$/.exec(ref);
  if (lines) {
    return { path: lines[1], start: Number(lines[2]), end: lines[3] ? Number(lines[3]) : undefined };
  }
  return { path: ref };
}

type NbOutput = { output_type?: string; text?: string | string[]; data?: Record<string, unknown>; ename?: string; evalue?: string };
type NbCell = { cell_type?: string; source?: string | string[]; outputs?: NbOutput[]; execution_count?: number | null };

const joined = (v: unknown): string => (Array.isArray(v) ? v.join('') : typeof v === 'string' ? v : '');

/**
 * A Jupyter notebook as readable text: each cell with its type and source, then the text of its outputs. Image outputs
 * become `[image output]`, long outputs are cut. Throws when the file is not notebook JSON.
 */
export function notebookToText(json: string, maxOutputChars = 2000): string {
  const nb = JSON.parse(json) as { cells?: NbCell[]; metadata?: { kernelspec?: { language?: string }; language_info?: { name?: string } } };
  if (!nb || !Array.isArray(nb.cells)) {
    throw new Error('not a Jupyter notebook (no "cells" array)');
  }
  const lang = nb.metadata?.language_info?.name ?? nb.metadata?.kernelspec?.language ?? '';
  const out: string[] = [];
  nb.cells.forEach((cell, i) => {
    const type = cell.cell_type ?? 'code';
    out.push(`--- Cell ${i + 1} (${type}${type === 'code' && lang ? `, ${lang}` : ''}) ---`, joined(cell.source).replace(/\s+$/, ''));
    const texts: string[] = [];
    for (const o of cell.outputs ?? []) {
      if (o.output_type === 'stream') {
        texts.push(joined(o.text));
      } else if (o.output_type === 'error') {
        texts.push(`${o.ename ?? 'Error'}: ${o.evalue ?? ''}`);
      } else if (o.data) {
        texts.push(Object.keys(o.data).some((k) => k.startsWith('image/')) ? '[image output]' : joined(o.data['text/plain']) || joined(o.data['text/markdown']) || `[${Object.keys(o.data)[0] ?? 'empty'} output]`);
      }
    }
    const text = texts.map((t) => t.replace(/\s+$/, '')).filter(Boolean).join('\n');
    if (text) {
      out.push(`Output:\n${text.length > maxOutputChars ? `${text.slice(0, maxOutputChars)}\n… [output cut at ${maxOutputChars.toLocaleString()} characters]` : text}`);
    }
  });
  return out.join('\n');
}

/**
 * A notebook for read_file: `# [code] cell 3 (exec 12)` then the source, then text outputs (each cell's cut at
 * `maxOutputChars`); image and other rich outputs are dropped. Throws when the file is not notebook JSON.
 */
export function notebookToCompactText(json: string, maxOutputChars = 2000): { text: string; cells: number } {
  const nb = JSON.parse(json) as { cells?: NbCell[] };
  if (!nb || !Array.isArray(nb.cells)) {
    throw new Error('not a Jupyter notebook (no "cells" array)');
  }
  const out: string[] = [];
  nb.cells.forEach((cell, i) => {
    const type = cell.cell_type ?? 'code';
    const exec = type === 'code' && typeof cell.execution_count === 'number' ? ` (exec ${cell.execution_count})` : '';
    out.push(`# [${type}] cell ${i + 1}${exec}`);
    const src = joined(cell.source).replace(/\s+$/, '');
    if (src) {
      out.push(src);
    }
    const texts: string[] = [];
    for (const o of cell.outputs ?? []) {
      if (o.output_type === 'stream') {
        texts.push(joined(o.text));
      } else if (o.output_type === 'error') {
        texts.push(`${o.ename ?? 'Error'}: ${o.evalue ?? ''}`);
      } else if (o.data && !Object.keys(o.data).some((k) => k.startsWith('image/'))) {
        // A plot's text/plain is only "<Figure size …>": dropped with the image.
        texts.push(joined(o.data['text/plain']));
      }
    }
    const text = texts.map((t) => t.replace(/\s+$/, '')).filter(Boolean).join('\n');
    if (text) {
      out.push(`# output:\n${text.length > maxOutputChars ? `${text.slice(0, maxOutputChars)}\n… [output cut at ${maxOutputChars.toLocaleString()} characters]` : text}`);
    }
  });
  return { text: out.join('\n'), cells: nb.cells.length };
}

/** The text of a Word (.docx) document: paragraphs, one per line. */
export async function docxToText(data: Uint8Array): Promise<string> {
  const mammoth = await import('mammoth');
  const r = await (mammoth.default ?? mammoth).extractRawText({ buffer: Buffer.from(data.buffer, data.byteOffset, data.byteLength) });
  return r.value.replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Text of a document attachment by kind: notebooks and Word documents are converted; images and binaries get the
 * note; `undefined` means a plain text file (the caller opens it as a text document). PDFs are handled by the caller.
 */
export async function extractDocumentText(name: string, data: Uint8Array, kind = attachmentKind(name)): Promise<string | undefined> {
  switch (kind) {
    case 'ipynb':
      return notebookToText(Buffer.from(data).toString('utf8'));
    case 'docx':
      return docxToText(data);
    case 'image':
    case 'binary':
      return binaryNote(path.basename(name), data.byteLength, kind);
    case 'text':
      return looksBinary(data.subarray(0, 8192)) ? binaryNote(path.basename(name), data.byteLength) : undefined;
    default:
      return undefined;
  }
}
