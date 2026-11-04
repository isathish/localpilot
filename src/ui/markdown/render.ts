import * as path from 'path';
import * as vscode from 'vscode';
import { parseFrontMatter } from '../../agent/frontMatter';

export interface RenderInput {
  markdown: string;
  baseDir?: string;
  workspaceRoot?: string;
  /** Markdown → HTML; defaults to VS Code's own engine (`markdown.api.render`). */
  engine?: (markdown: string) => Promise<string>;
}

export interface RenderOutput {
  html: string;
  frontMatter?: Record<string, unknown>;
  /** Lines removed from the top with the front matter: the engine's `data-line` values are this much lower than the file's. */
  frontMatterLines: number;
  words: number;
  hasMermaid: boolean;
  hasMath: boolean;
  footnotes: number;
}

export type LinkTarget =
  | { kind: 'anchor'; anchor: string }
  | { kind: 'external'; href: string }
  | { kind: 'path'; path: string; line?: number; endLine?: number; anchor?: string; page?: number };

const escHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);

/** Splits off YAML front matter; `lines` is how many source lines it took (fences included). */
export function splitFrontMatter(markdown: string): { meta?: Record<string, unknown>; body: string; lines: number } {
  const m = /^\uFEFF?---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/.exec(markdown);
  if (!m) {
    return { body: markdown, lines: 0 };
  }
  const { meta } = parseFrontMatter(m[0].replace(/^\uFEFF/, '').replace(/---[ \t]*(\r?\n)?$/, '---\n'));
  return { meta: Object.keys(meta).length ? meta : undefined, body: markdown.slice(m[0].length), lines: m[0].split('\n').length - (m[0].endsWith('\n') ? 1 : 0) };
}

/** Footnote text is plain Markdown; only the common inline marks are kept (the reader's sanitiser still runs on it). */
function inlineMarkdown(s: string): string {
  return escHtml(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*\w])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2">$1</a>');
}

/**
 * GitHub-style footnotes, which VS Code's engine does not render. `[^id]:` definitions become blank lines and the
 * list is emitted as one HTML line where the last definition was, so every other line keeps its number (scroll sync
 * and "open source at line" depend on that). References are numbered in order of first use; unknown ones stay as written.
 */
export function preprocessFootnotes(md: string): string {
  return footnotes(md).text;
}

export function footnotes(md: string): { text: string; count: number } {
  const lines = md.split('\n');
  const defs = new Map<string, string>();
  const code = codeLines(lines);
  let lastDef = -1;
  lines.forEach((l, i) => {
    const m = code[i] ? null : /^\[\^([^\]\s]+)\]:\s?(.*?)\r?$/.exec(l);
    if (m) {
      defs.set(m[1], m[2]);
      lines[i] = l.endsWith('\r') ? '\r' : '';
      lastDef = i;
    }
  });
  if (!defs.size) {
    return { text: md, count: 0 };
  }
  const order: string[] = [];
  const refs = new Map<string, number>();
  for (let i = 0; i < lines.length; i++) {
    if (code[i]) {
      continue;
    }
    // Inline code spans keep their text.
    lines[i] = lines[i].replace(/(`+)[\s\S]*?\1|\[\^([^\]\s]+)\]/g, (m, tick: string | undefined, id: string | undefined) => {
      if (tick || !id || !defs.has(id)) {
        return m;
      }
      if (!order.includes(id)) {
        order.push(id);
      }
      const n = order.indexOf(id) + 1;
      const k = (refs.get(id) ?? 0) + 1;
      refs.set(id, k);
      const slug = encodeURIComponent(id);
      return `<sup class="fn-ref"><a href="#fn-${slug}" id="fnref-${slug}${k > 1 ? `-${k}` : ''}">${n}</a></sup>`;
    });
  }
  if (!order.length) {
    return { text: lines.join('\n'), count: 0 };
  }
  const items = order.map((id) => {
    const slug = encodeURIComponent(id);
    return `<li id="fn-${slug}">${inlineMarkdown(defs.get(id) ?? '')} <a href="#fnref-${slug}" class="fn-back" aria-label="Back to the reference">↩</a></li>`;
  });
  lines[lastDef] = `<section class="footnotes"><hr><ol>${items.join('')}</ol></section>${lines[lastDef]}`;
  return { text: lines.join('\n'), count: order.length };
}

/** Marks the lines inside fenced code blocks (fences included). */
function codeLines(lines: string[]): boolean[] {
  const out: boolean[] = [];
  let fence: string | undefined;
  for (const l of lines) {
    const m = /^ {0,3}(`{3,}|~{3,})/.exec(l);
    if (fence) {
      out.push(true);
      if (m && m[1][0] === fence[0] && m[1].length >= fence.length && !l.trim().slice(m[1].length).trim()) {
        fence = undefined;
      }
    } else {
      out.push(!!m);
      fence = m?.[1];
    }
  }
  return out;
}

/**
 * How a link in a rendered document should open. Shared by the host and (as a verbatim copy) media/mdview.js:
 * `#x` scrolls in the page, http(s) and mailto open externally, workspace paths open in VS Code — `a.ts:10`,
 * `a.ts#L10`, `a.ts#L10-L20`, `b.md#heading`, `x.pdf#page=3`. Any other scheme (`javascript:`, `file:`…) is ignored.
 */
export function parseLinkTarget(href: string): LinkTarget | undefined {
  const h = String(href ?? '').trim();
  if (!h) {
    return undefined;
  }
  if (h.startsWith('#')) {
    return h.length > 1 ? { kind: 'anchor', anchor: safeDecode(h.slice(1)) } : undefined;
  }
  if (/^(https?:\/\/|mailto:)/i.test(h)) {
    return { kind: 'external', href: h };
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(h) && !/^[a-z]:[\\/]/i.test(h)) {
    return undefined;
  }
  const hash = h.indexOf('#');
  const frag = hash >= 0 ? h.slice(hash + 1) : '';
  let p = safeDecode((hash >= 0 ? h.slice(0, hash) : h).replace(/\?.*$/, ''));
  if (!p) {
    return undefined;
  }
  const out: { kind: 'path'; path: string; line?: number; endLine?: number; anchor?: string; page?: number } = { kind: 'path', path: p };
  const pos = /^(.*?):L?(\d+)(?:-L?(\d+))?(?::\d+)?$/.exec(p);
  if (pos && pos[1] && !/^[a-z]$/i.test(pos[1])) {
    p = pos[1];
    out.path = p;
    out.line = Number(pos[2]);
    if (pos[3]) {
      out.endLine = Number(pos[3]);
    }
  }
  const lines = /^L(\d+)(?:-L?(\d+))?$/i.exec(frag);
  const page = /^page=(\d+)$/i.exec(frag);
  if (lines) {
    out.line = Number(lines[1]);
    if (lines[2]) {
      out.endLine = Number(lines[2]);
    }
  } else if (page) {
    out.page = Number(page[1]);
  } else if (frag) {
    out.anchor = safeDecode(frag);
  }
  if (out.endLine !== undefined && out.line !== undefined && out.endLine < out.line) {
    out.endLine = undefined;
  }
  return out;
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/**
 * Local images only load through webview URIs. Rewrites `<img src>`, `srcset` (img and picture `<source>`), paths
 * relative to the document and `/root`-relative paths (against the workspace root); remote, data:, blob: and
 * already-converted URLs stay as they are.
 */
export function rewriteResourceUrls(html: string, baseDir: string | undefined, root: string | undefined, toUri: (abs: string) => string): string {
  const resolve = (raw: string): string => {
    const src = raw.trim();
    if (!src || (/^([a-z][a-z0-9+.-]*:|\/\/|#)/i.test(src) && !/^[a-z]:[\\/]/i.test(src))) {
      return raw;
    }
    const clean = safeDecode(src.replace(/[?#].*$/, ''));
    let abs: string;
    if (/^[a-z]:[\\/]/i.test(clean) || (path.isAbsolute(clean) && (!root || isWithin(root, clean)))) {
      abs = clean;
    } else if (clean.startsWith('/') && root) {
      abs = path.join(root, clean);
    } else if (baseDir ?? root) {
      abs = path.join((baseDir ?? root)!, clean);
    } else {
      return raw;
    }
    return toUri(abs);
  };
  const attr = (_m: string, name: string, value: string) => {
    if (name.toLowerCase() === 'src') {
      return ` ${name}="${resolve(value)}"`;
    }
    const set = value
      .split(',')
      .map((part) => {
        const [url, ...desc] = part.trim().split(/\s+/);
        return [resolve(url ?? ''), ...desc].join(' ');
      })
      .join(', ');
    return ` ${name}="${set}"`;
  };
  return html.replace(/<(?:img|source)\b[^>]*>/gi, (tag) => tag.replace(/\s(src|srcset)="([^"]*)"/gi, attr));
}

function isWithin(root: string, p: string): boolean {
  const rel = path.relative(root, p);
  return !rel.startsWith('..') && !path.isAbsolute(rel);
}

async function vscodeEngine(markdown: string): Promise<string> {
  return (await vscode.commands.executeCommand<string>('markdown.api.render', markdown)) ?? '';
}

/** Front matter → footnotes → VS Code's Markdown engine (falls back to `<pre>`) → local resource URLs. */
export async function renderMarkdown(input: RenderInput, toResourceUri: (abs: string) => string): Promise<RenderOutput> {
  const fm = splitFrontMatter(input.markdown);
  const fn = footnotes(fm.body);
  let html: string;
  try {
    html = await (input.engine ?? vscodeEngine)(fn.text);
  } catch {
    html = `<pre>${escHtml(fm.body)}</pre>`;
  }
  html = rewriteResourceUrls(html, input.baseDir, input.workspaceRoot, toResourceUri);
  return {
    html,
    frontMatter: fm.meta,
    frontMatterLines: fm.lines,
    words: fm.body.split(/\s+/).filter(Boolean).length,
    hasMermaid: hasMermaid(html),
    hasMath: /class="[^"]*\bkatex\b/.test(html),
    footnotes: fn.count,
  };
}

export function hasMermaid(html: string): boolean {
  return /class="[^"]*\blanguage-mermaid\b/.test(html);
}
