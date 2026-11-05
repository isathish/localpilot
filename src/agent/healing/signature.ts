import { createHash } from 'crypto';
import type { Failure } from './types';

/** The fields a failure's signatures are computed from. */
export type SignatureInput = Pick<Failure, 'category' | 'code' | 'message' | 'file' | 'test' | 'symbol'>;

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** `root`-relative, forward slashes, no leading `./`; paths outside the root keep their absolute form. */
export function relativePath(file: string, root?: string): string {
  let f = file.trim().replace(/^file:\/\//, '').replace(/\\/g, '/');
  if (root) {
    const r = root.replace(/\\/g, '/').replace(/\/+$/, '');
    const lower = f.toLowerCase();
    if (r && (lower === r.toLowerCase() || lower.startsWith(`${r.toLowerCase()}/`))) {
      f = f.slice(r.length + 1);
    }
  }
  return f.replace(/^(\.\/)+/, '');
}

/**
 * Lowercase; workspace paths made relative and other absolute paths cut to their last segment; uuids, hex ids and
 * timestamps -> `*`; quoted literals -> `'…'`; line/column positions dropped; numbers -> `#`; whitespace collapsed.
 */
export function normaliseMessage(msg: string, root?: string): string {
  let s = msg.replace(/\\/g, '/');
  if (root) {
    const r = root.replace(/\\/g, '/').replace(/\/+$/, '');
    if (r) {
      s = s.replace(new RegExp(`${escapeRe(r)}/?`, 'gi'), '');
    }
  }
  s = s
    .toLowerCase()
    .replace(/file:\/\/+/g, '/')
    .replace(/(^|[\s'"`(=[])(?:[a-z]:)?(?:\/[^\s/'"`():,]+)+\/(?=[^\s/'"`():,]+)/g, '$1')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g, '*')
    .replace(/\b\d{4}-\d{2}-\d{2}[t ]\d{2}:\d{2}(?::\d{2}(?:[.,]\d+)?)?(?:z|[+-]\d{2}:?\d{2})?\b/g, '*')
    .replace(/\b\d{2}:\d{2}:\d{2}(?:[.,]\d+)?\b/g, '*')
    .replace(/\b0x[0-9a-f]+\b/g, '*')
    .replace(/\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,}\b/g, '*')
    .replace(/(^|[^\w'])'[^'\n]*'/g, "$1'…'")
    .replace(/"[^"\n]*"/g, "'…'")
    .replace(/`[^`\n]*`/g, "'…'")
    .replace(/[‘“][^’”\n]*[’”]/g, "'…'")
    .replace(/(\.\w+):\d+(?::\d+)?/g, '$1')
    .replace(/(\.\w+)\(\d+,\s*\d+\)/g, '$1')
    .replace(/\b(?:line|ln|col|column)\s+\d+/g, '')
    .replace(/\d+(?:\.\d+)?/g, '#')
    .replace(/\s+/g, ' ')
    .trim();
  return s;
}

const sha16 = (s: string) => createHash('sha1').update(s).digest('hex').slice(0, 16);

/** The file path without a position, or the test id; both when a test has a file. */
export function fileKey(f: Pick<Failure, 'file' | 'test'>, root?: string): string {
  const file = f.file ? relativePath(f.file, root) : '';
  return [file, f.test?.trim() ?? ''].filter(Boolean).join('::');
}

/**
 * Exact signature (category, code, message, file): duplicate detection inside a task. Missing packages also key on
 * the package, so each one is resolved on its own.
 */
export function exactSignature(f: SignatureInput, root?: string): string {
  const where = f.category === 'dependency' && f.symbol ? `${fileKey(f, root)}#${f.symbol}` : fileKey(f, root);
  return sha16([f.category, f.code ?? '', normaliseMessage(f.message, root), where].join('|'));
}

/** Generic signature (category, code, message; no file): failure-memory retrieval across files and projects. */
export function genericSignature(f: SignatureInput, root?: string): string {
  return sha16([f.category, f.code ?? '', normaliseMessage(f.message, root)].join('|'));
}

/** 'TS2345@src/api/user.ts', for the local UI and store only (telemetry gets the hashes). */
export function humanKey(f: Pick<Failure, 'category' | 'code' | 'file' | 'test'>): string {
  const where = f.file ? relativePath(f.file) : f.test ?? '';
  const what = f.code ?? f.category;
  return where ? `${what}@${where}` : what;
}
