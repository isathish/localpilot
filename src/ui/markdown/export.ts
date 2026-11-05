import { pathToFileURL } from 'url';
import { MAX_QUOTE } from '../../pdf/viewerMessages';
import { prefsCss, ReaderPrefs } from './prefs';

/** Largest decorated HTML the webview may send back for an export. */
export const MAX_EXPORT_HTML = 20 * 1024 * 1024;
/** Local images up to this size are embedded as data: URIs; larger ones (and unknown types) become file: URLs, which the export CSP allows. */
export const MAX_INLINE_IMAGE = 5 * 1024 * 1024;

export type ExportTarget = 'html' | 'pdf' | 'clipboard';
export type ExportTheme = 'light' | 'match';

/** A light palette for the `--vscode-*` variables mdview.css reads, so an export looks right outside VS Code. */
const LIGHT_VARS: Record<string, string> = {
  '--vscode-editor-background': '#ffffff',
  '--vscode-editor-foreground': '#1f2328',
  '--vscode-foreground': '#1f2328',
  '--vscode-descriptionForeground': '#59636e',
  '--vscode-widget-border': '#d1d9e0',
  '--vscode-textLink-foreground': '#0969da',
  '--vscode-font-family': "-apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, Helvetica, Arial, sans-serif",
  '--vscode-editor-font-family': "ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace",
  '--vscode-errorForeground': '#d1242f',
  '--vscode-editorInfo-foreground': '#0969da',
  '--vscode-editorWarning-foreground': '#9a6700',
  '--vscode-editorError-foreground': '#d1242f',
  '--vscode-testing-iconPassed': '#1a7f37',
  '--vscode-charts-purple': '#8250df',
};

/** Layout overrides: the reader is a fixed-height app with its own scroller; a document flows and prints. */
const EXPORT_CSS = `
html, body { height: auto; }
body { display: block; }
.doc { overflow: visible; padding: 40px clamp(16px, 6vw, 72px); }
.md .table-wrap { max-height: none; overflow: visible; }
.md thead th { position: static; }
.props summary { cursor: default; }
@media print {
  .doc { padding: 0; }
  .md pre, .md figure, .md .markdown-alert, .md tr, .md img { break-inside: avoid; }
  .md h1, .md h2, .md h3, .md h4 { break-after: avoid; }
  .md pre { white-space: pre-wrap; overflow-wrap: anywhere; }
}`;

const THEME_CLASSES = ['vscode-light', 'vscode-dark', 'vscode-high-contrast', 'vscode-high-contrast-light'];

const escHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);

/**
 * Removes anything executable from HTML the webview sent back: script-capable elements, event-handler attributes and
 * script: URLs. The webview has already scrubbed the document; this is the host's own guarantee for the exported file.
 * Inline `<style>` is kept because Mermaid's SVGs carry their styles that way.
 */
export function sanitizeExportHtml(html: string): string {
  let out = html;
  for (const tag of ['script', 'iframe', 'object', 'embed', 'noscript', 'template', 'form']) {
    out = out.replace(new RegExp(`<${tag}\\b[\\s\\S]*?(?:</${tag}\\s*>|$)`, 'gi'), '');
  }
  out = out.replace(/<\/?(?:base|meta|link|frame|frameset)\b[^>]*>/gi, '');
  // Attributes only inside tags: code samples in the text (escaped by the serialiser) must stay as written.
  return out.replace(/<[a-zA-Z][^>]*>/g, (tag) =>
    tag
      .replace(/[\s/](?:on[a-z]+|srcdoc|formaction)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
      .replace(/(\s(?:href|src|xlink:href|action)\s*=\s*)("[^"]*"|'[^']*'|[^\s>]+)/gi, (all, pre: string, val: string) =>
        /^(?:javascript|vbscript|data:text\/html)/i.test(decodeAttr(val.replace(/^["']|["']$/g, '')).replace(/[\s\u0000-\u001f]/g, '')) ? `${pre}"#"` : all
      )
  );
}

/** `src` values of every `<img>`, decoded from their attribute form. */
export function imageSources(html: string): string[] {
  const out = new Set<string>();
  for (const m of html.matchAll(/<img\b[^>]*?\ssrc\s*=\s*(["'])(.*?)\1/gi)) {
    out.add(decodeAttr(m[2]));
  }
  return [...out];
}

/**
 * Rewrites image sources with `map` (original src → replacement), drops `loading="lazy"` (a headless print would
 * leave lazy images blank) and removes `srcset` candidates that only resolve inside the webview.
 */
export function rewriteImageSources(html: string, map: ReadonlyMap<string, string>, isLocal: (src: string) => boolean): string {
  return html.replace(/<(img|source)\b[^>]*>/gi, (tag) =>
    tag
      .replace(/\s+loading\s*=\s*(["'])lazy\1/i, '')
      .replace(/(\ssrc\s*=\s*)(["'])(.*?)\2/i, (all, pre: string, q: string, v: string) => {
        const next = map.get(decodeAttr(v));
        return next === undefined ? all : `${pre}${q}${escHtml(next)}${q}`;
      })
      .replace(/\s+srcset\s*=\s*(["'])(.*?)\1/i, (all, _q: string, v: string) => (decodeAttr(v).split(',').some((c) => isLocal(c.trim().split(/\s+/)[0] ?? '')) ? '' : all))
  );
}

function decodeAttr(v: string): string {
  return v.replace(/&(?:#(\d+)|#x([0-9a-f]+)|(amp|lt|gt|quot|apos));?/gi, (all, dec?: string, hex?: string, name?: string) => {
    if (dec || hex) {
      const code = dec ? Number(dec) : parseInt(hex!, 16);
      return code > 0 && code < 0x110000 ? String.fromCodePoint(code) : all;
    }
    return ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" } as Record<string, string>)[name!.toLowerCase()] ?? all;
  });
}

/** Points KaTeX's font URLs at embedded woff2 data (the only format bundled); other formats are dropped. */
export function inlineKatexFonts(css: string, woff2: (name: string) => string | undefined): string {
  return css
    .replace(/,\s*url\(["']?fonts\/[^)"']+\.(?:woff|ttf)["']?\)\s*format\(["']?(?:woff|truetype)["']?\)/gi, '')
    .replace(/url\(["']?fonts\/([^)"']+\.woff2)["']?\)/gi, (all, name: string) => {
      const b64 = woff2(name);
      return b64 ? `url(data:font/woff2;base64,${b64})` : all;
    });
}

/** Keeps only `--vscode-*` declarations from the webview's theme variables, so nothing else can reach the stylesheet. */
export function themeVars(raw: string | undefined): string {
  return (raw ?? '')
    .split(';')
    .map((d) => d.trim())
    .filter((d) => /^--vscode-[\w-]+\s*:[^{}<>;]*$/.test(d))
    .join('; ');
}

export interface ExportDocumentInput {
  title: string;
  /** The decorated `<article>` from the webview (already sanitised and with images rewritten). */
  article: string;
  /** Properties table the reader showed above the article, if any. */
  preface?: string;
  css: string;
  katexCss?: string;
  theme: ExportTheme;
  /** The webview's `--vscode-*` variables and theme class, used by the `match` theme. */
  vars?: string;
  themeClass?: string;
  prefs: ReaderPrefs;
}

/** A self-contained page: inlined styles, no scripts, a CSP that allows nothing but inline styles and data:/https: images. */
export function buildExportDocument(input: ExportDocumentInput): string {
  const match = input.theme === 'match' && !!themeVars(input.vars);
  const vars = match ? themeVars(input.vars) : Object.entries(LIGHT_VARS).map(([k, v]) => `${k}: ${v}`).join('; ');
  const themeClass = match && THEME_CLASSES.includes(input.themeClass ?? '') ? input.themeClass! : 'vscode-light';
  const prefs = Object.entries(prefsCss(input.prefs)).map(([k, v]) => `${k}: ${v}`).join('; ');
  const css = [input.katexCss ?? '', input.css, EXPORT_CSS, `:root { ${vars}; ${prefs}; }`].join('\n').replace(/<\/style/gi, '<\\/style');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: https: file:; style-src 'unsafe-inline'; font-src data:;" />
<meta name="generator" content="LocalPilot Markdown reader" />
<title>${escHtml(input.title)}</title>
<style>
${css}
</style>
</head>
<body class="${themeClass}">
<main class="doc">
${input.preface ?? ''}${input.article}
</main>
</body>
</html>
`;
}

/** Chromium arguments that print `url` to `target` as a PDF, in a throwaway profile so a running browser cannot block it. */
export function printToPdfArgs(url: string, target: string, profileDir: string): string[] {
  return ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-background-networking', '--no-pdf-header-footer', `--user-data-dir=${profileDir}`, `--print-to-pdf=${target}`, url];
}

/** `> `-quotes a selection for a chat draft. */
export function quoteForDraft(text: string, max = MAX_QUOTE): string {
  const t = text.replace(/\r\n?/g, '\n').trim();
  const cut = t.length > max ? `${t.slice(0, max).trimEnd()}…` : t;
  return cut
    .split('\n')
    .map((l) => (l.trim() ? `> ${l}` : '>'))
    .join('\n');
}

/** The image mime type for a file name, or undefined when it is not an image a browser shows. */
export function imageMime(file: string): string | undefined {
  const ext = /\.([a-z0-9]+)$/i.exec(file)?.[1]?.toLowerCase();
  return ext ? ({ png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', avif: 'image/avif', bmp: 'image/bmp', ico: 'image/x-icon' } as Record<string, string>)[ext] : undefined;
}

/** The exported `src` for a local image: a data: URI when small and of a known type, else a file: URL (allowed by the export CSP). */
export async function exportImageSrc(file: string, size: number | undefined, read: () => Promise<Uint8Array>): Promise<string> {
  const mime = imageMime(file);
  if (mime && size !== undefined && size <= MAX_INLINE_IMAGE) {
    try {
      return `data:${mime};base64,${Buffer.from(await read()).toString('base64')}`;
    } catch {
      /* fall back to the path */
    }
  }
  return pathToFileURL(file).href;
}
