// Pure message rules of the PDF viewer webview (no `vscode` import), shared by the host and the tests.

export type PdfPageColors = 'auto' | 'original' | 'dark' | 'sepia';
export type PdfSidebar = 'auto' | 'outline' | 'thumbnails' | 'hidden';
export type PdfZoom = 'auto' | 'page-width' | 'page-fit' | 'page-actual';

export interface PdfViewerPrefs {
  pageColors: PdfPageColors;
  sidebar: PdfSidebar;
  defaultZoom: PdfZoom;
}

export type FromPdfViewer =
  | { type: 'ready' }
  | { type: 'clientError'; where: string; message: string; stack?: string }
  | { type: 'range'; id: number; begin: number; end: number }
  | { type: 'openLink'; href: string }
  | { type: 'openAnyway' }
  | { type: 'openExternal' }
  | { type: 'reveal' }
  /** `key`: sent by Ctrl/Cmd+' in the webview (the keybinding's command then stands down). */
  | { type: 'ask'; key?: boolean }
  /** "Viewer settings…" and the too-large panel's "Change limit…": Settings → Markdown & PDF. */
  | { type: 'openSettings' }
  /** `text` is cut to `MAX_QUOTE` by the webview; `total` is the selection's full length when it was cut. */
  | { type: 'askSelection'; text: string; page: number; total?: number; key?: boolean }
  | { type: 'attachImage'; name: string; data: string; mime: 'image/png' }
  | { type: 'copyText'; text: string }
  | { type: 'position'; page: number; scale: string | number }
  | { type: 'prefs'; patch: Partial<PdfViewerPrefs> };

/** Largest image the viewer may attach (decoded bytes), the same cap as images attached from disk. */
export const MAX_PAGE_IMAGE_BYTES = 12 * 1024 * 1024;
/** Largest single range the webview may ask for, and the most requests in flight at once. */
export const MAX_RANGE_BYTES = 4 * 1024 * 1024;
export const MAX_PENDING_RANGES = 8;
/** Characters of a selection or document quoted into the chat draft, the one limit of both viewers (sent to their webviews). */
export const MAX_QUOTE = 4000;
/** Per-file reading positions kept in workspace state. */
export const MAX_POSITIONS = 200;

export const PAGE_COLORS: readonly PdfPageColors[] = ['auto', 'original', 'dark', 'sepia'];
export const SIDEBARS: readonly PdfSidebar[] = ['auto', 'outline', 'thumbnails', 'hidden'];
export const ZOOMS: readonly PdfZoom[] = ['auto', 'page-width', 'page-fit', 'page-actual'];

const str = (v: unknown, max: number): string | undefined => (typeof v === 'string' && v.length <= max ? v : undefined);
const int = (v: unknown, max = 1e9): number | undefined => (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= max ? v : undefined);
const oneOf = <T extends string>(v: unknown, list: readonly T[]): T | undefined => list.find((x) => x === v);

/** Base64 of at most `maxBytes` decoded bytes: the alphabet only, padded to a multiple of 4. */
export function isBase64(data: string, maxBytes = MAX_PAGE_IMAGE_BYTES): boolean {
  return data.length > 0 && data.length % 4 === 0 && data.length <= Math.ceil(maxBytes / 3) * 4 && /^[A-Za-z0-9+/]+={0,2}$/.test(data);
}

/** A page image the webview rendered: PNG only, valid base64 within the size cap, and a plain file name. */
export function validatePageImage(m: Record<string, unknown>): { name: string; data: string; mime: 'image/png' } | undefined {
  if (m.mime !== 'image/png' || typeof m.data !== 'string' || !isBase64(m.data)) {
    return undefined;
  }
  const name = (str(m.name, 200) ?? '').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '-').trim() || 'page.png';
  return { name: /\.png$/i.test(name) ? name : `${name}.png`, data: m.data, mime: 'image/png' };
}

/** Checks every field of a webview message; anything malformed or unknown is dropped. */
export function validatePdfViewerMessage(raw: unknown): FromPdfViewer | undefined {
  if (!raw || typeof raw !== 'object') {
    return undefined;
  }
  const m = raw as Record<string, unknown>;
  switch (m.type) {
    case 'ready':
    case 'openAnyway':
    case 'openExternal':
    case 'reveal':
    case 'openSettings':
      return { type: m.type };
    case 'ask':
      return m.key === true ? { type: 'ask', key: true } : { type: 'ask' };
    case 'clientError':
      return { type: 'clientError', where: str(m.where, 200) ?? '?', message: str(m.message, 4000) ?? '?', stack: str(m.stack, 8000) };
    case 'range': {
      const id = int(m.id);
      const begin = int(m.begin, Number.MAX_SAFE_INTEGER);
      const end = int(m.end, Number.MAX_SAFE_INTEGER);
      return id !== undefined && begin !== undefined && end !== undefined ? { type: 'range', id, begin, end } : undefined;
    }
    case 'openLink': {
      const href = str(m.href, 4000);
      return href ? { type: 'openLink', href } : undefined;
    }
    case 'askSelection': {
      const text = typeof m.text === 'string' ? m.text.slice(0, MAX_QUOTE).trim() : '';
      const page = int(m.page, 1e6);
      const total = int(m.total, 1e8);
      return text && page ? { type: 'askSelection', text, page, ...(total !== undefined && total > text.length ? { total } : {}), ...(m.key === true ? { key: true } : {}) } : undefined;
    }
    case 'attachImage': {
      const img = validatePageImage(m);
      return img ? { type: 'attachImage', ...img } : undefined;
    }
    case 'copyText': {
      const text = str(m.text, 2_000_000);
      return text !== undefined ? { type: 'copyText', text } : undefined;
    }
    case 'position': {
      const page = int(m.page, 1e6);
      const scale = typeof m.scale === 'number' ? (Number.isFinite(m.scale) && m.scale > 0 && m.scale <= 25 ? m.scale : undefined) : oneOf(m.scale, ['auto', 'page-width', 'page-fit', 'page-actual'] as const);
      return page && scale !== undefined ? { type: 'position', page, scale } : undefined;
    }
    case 'prefs': {
      const p = m.patch && typeof m.patch === 'object' ? (m.patch as Record<string, unknown>) : {};
      const patch: Partial<PdfViewerPrefs> = {};
      const pageColors = oneOf(p.pageColors, PAGE_COLORS);
      const sidebar = oneOf(p.sidebar, SIDEBARS);
      const defaultZoom = oneOf(p.defaultZoom, ZOOMS);
      if (pageColors) {
        patch.pageColors = pageColors;
      }
      if (sidebar) {
        patch.sidebar = sidebar;
      }
      if (defaultZoom) {
        patch.defaultZoom = defaultZoom;
      }
      return Object.keys(patch).length ? { type: 'prefs', patch } : undefined;
    }
  }
  return undefined;
}

/** A range the host may serve: inside `[0, length)`, non-empty and no larger than `MAX_RANGE_BYTES`. */
export function rangeAllowed(begin: number, end: number, length: number): boolean {
  return begin >= 0 && end > begin && end <= length && end - begin <= MAX_RANGE_BYTES;
}

/** Links a PDF may open outside the viewer: web pages and mail only (no `file:`, `javascript:`, `command:` …). */
export function isAllowedExternalLink(href: string): boolean {
  return /^(https?:\/\/|mailto:)/i.test(href.trim()) && !/[\s<>"]/.test(href.trim());
}

/** The page asked for by a `page=N` URI fragment (also `#page=N` and `N`), if any. */
export function pageFromFragment(fragment: string): number | undefined {
  const m = /^#?(?:page=)?(\d{1,6})$/.exec(fragment.trim());
  const n = m ? Number(m[1]) : 0;
  return n >= 1 ? n : undefined;
}

export interface PdfPosition {
  page: number;
  scale: string | number;
}

/** Records a reading position, most recent last, keeping at most `max` files. */
export function rememberPosition(all: Record<string, PdfPosition>, key: string, pos: PdfPosition, max = MAX_POSITIONS): Record<string, PdfPosition> {
  const next: Record<string, PdfPosition> = {};
  const keys = Object.keys(all).filter((k) => k !== key);
  for (const k of keys.slice(Math.max(0, keys.length - (max - 1)))) {
    next[k] = all[k];
  }
  next[key] = pos;
  return next;
}

/** The draft both viewers (PDF and Markdown) start an "Ask about this document" with. */
export const askDraft = (fileName: string): string => `About ${fileName}: `;

/** The viewer toast when a selection was longer than the quote limit. */
export function quoteCutNotice(total: number): string {
  return `Quoted the first ${MAX_QUOTE.toLocaleString('en-US')} of ${total.toLocaleString('en-US')} characters. Attach the file to include everything.`;
}

/** The draft placed in the chat for "Ask about selection": the selection quoted, then room for the question. */
export function selectionDraft(text: string): string {
  const quoted = text
    .slice(0, MAX_QUOTE)
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => `> ${l}`.trimEnd())
    .join('\n');
  return `${quoted}\n\n`;
}
