/** Reading controls of the Markdown reader ("Aa"): global, shared by every open reader. */
export interface ReaderPrefs {
  fontSize: number;
  width: 'narrow' | 'normal' | 'wide' | 'full';
  font: 'sans' | 'serif' | 'editor';
  lineHeight: number;
}

export const PREFS_KEY = 'localpilot.mdViewer.prefs';
/** The font size the reader stored before the other controls existed; migrated on first read. */
export const LEGACY_FONT_KEY = 'localpilot.mdViewer.fontSize';

export const WIDTHS: readonly ReaderPrefs['width'][] = ['narrow', 'normal', 'wide', 'full'];
export const FONTS: readonly ReaderPrefs['font'][] = ['sans', 'serif', 'editor'];
export const LINE_HEIGHTS: readonly number[] = [1.5, 1.65, 1.8];
export const DEFAULT_PREFS: ReaderPrefs = { fontSize: 15, width: 'normal', font: 'sans', lineHeight: 1.65 };

const clampSize = (v: number) => Math.min(24, Math.max(11, Math.round(v)));

/** Every valid field of `raw`; anything else is dropped (webview messages and stored state both go through it). */
export function sanitizePrefsPatch(raw: unknown): Partial<ReaderPrefs> {
  if (!raw || typeof raw !== 'object') {
    return {};
  }
  const r = raw as Record<string, unknown>;
  const out: Partial<ReaderPrefs> = {};
  if (typeof r.fontSize === 'number' && Number.isFinite(r.fontSize)) {
    out.fontSize = clampSize(r.fontSize);
  }
  const width = WIDTHS.find((w) => w === r.width);
  if (width) {
    out.width = width;
  }
  const font = FONTS.find((f) => f === r.font);
  if (font) {
    out.font = font;
  }
  if (typeof r.lineHeight === 'number' && LINE_HEIGHTS.includes(r.lineHeight)) {
    out.lineHeight = r.lineHeight;
  }
  return out;
}

/** Stored preferences with defaults filled in; a legacy font size is used when no preference set exists yet. */
export function readPrefs(stored: unknown, legacyFontSize?: unknown): ReaderPrefs {
  const legacy = stored === undefined ? sanitizePrefsPatch({ fontSize: legacyFontSize }) : {};
  return { ...DEFAULT_PREFS, ...legacy, ...sanitizePrefsPatch(stored) };
}

/** CSS custom properties the reader (and an export) sets from the preferences. */
export function prefsCss(p: ReaderPrefs): Record<string, string> {
  return {
    '--fs': `${p.fontSize}px`,
    '--measure': { narrow: '68ch', normal: '80ch', wide: '110ch', full: 'none' }[p.width],
    '--font': { sans: 'var(--vscode-font-family, system-ui, sans-serif)', serif: "Charter, 'Iowan Old Style', Georgia, Cambria, 'Times New Roman', serif", editor: 'var(--mono)' }[p.font],
    '--lh': String(p.lineHeight),
  };
}
