// Pure helpers for read_file: argument normalization, line windows and lenient file-name matching (no vscode, so smoke tests can load them).

export interface ReadRequest {
  path: string;
  start?: number;
  end?: number;
}

/** At most this many files per read_file call. */
export const MAX_READ_FILES = 8;
/** Per window: lines, characters, and characters per line. */
export const WINDOW_LINES = 2000;
export const WINDOW_CHARS = 48_000;
export const LINE_CHARS = 2000;
/** Room kept for the header and footer around a window, so the whole result fits the tool-output limit. */
export const WINDOW_MARGIN = 400;

/** Characters each of `files` windows may use so the read_file result is never cut again by `maxToolOutputChars`. */
export function windowBudget(maxToolOutputChars: number, files = 1): number {
  const n = Math.max(1, files);
  return Math.max(200, Math.min(WINDOW_CHARS, Math.floor((maxToolOutputChars - WINDOW_MARGIN * n) / n)));
}

/** A positive line number from a number or a numeric string ("12"); undefined when absent or not a number. */
function lineNo(v: unknown): number | undefined {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v.trim()) : NaN;
  return Number.isFinite(n) ? Math.max(1, Math.floor(n)) : undefined;
}

function entry(v: unknown, start?: unknown, end?: unknown): ReadRequest | undefined {
  if (typeof v === 'string') {
    const p = v.trim();
    return p ? { path: p, start: lineNo(start), end: lineNo(end) } : undefined;
  }
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    const o = v as Record<string, unknown>;
    const p = o.path ?? o.file_path ?? o.filePath ?? o.file ?? o.name;
    return typeof p === 'string' ? entry(p, o.start_line ?? o.startLine ?? o.start, o.end_line ?? o.endLine ?? o.end) : undefined;
  }
  return undefined;
}

/** A list given as an array, a JSON array string, or a comma/newline-separated string. */
function list(v: unknown): unknown[] {
  if (Array.isArray(v)) {
    return v;
  }
  if (typeof v === 'string') {
    const t = v.trim();
    if (t.startsWith('[')) {
      try {
        const parsed: unknown = JSON.parse(t);
        if (Array.isArray(parsed)) {
          return parsed;
        }
      } catch {
        /* a plain string */
      }
    }
    return t.split(/[\n,]/).map((s) => s.trim()).filter(Boolean);
  }
  return v ? [v] : [];
}

/**
 * The files a read_file call asks for. Accepts `{path}`, `{files: [{path, start_line?, end_line?}]}`, a bare string
 * (parsed as `_raw`), and the `paths` / `file_path` / `filePath` / `file_paths` aliases; line numbers may be strings.
 * Top-level start_line/end_line apply to entries that have none. A string is the error to report.
 */
export function normalizeReadArgs(args: unknown): ReadRequest[] | string {
  if (typeof args === 'string') {
    args = { path: args };
  }
  const a = (args && typeof args === 'object' && !Array.isArray(args) ? args : Array.isArray(args) ? { files: args } : {}) as Record<string, unknown>;
  const start = a.start_line ?? a.startLine;
  const end = a.end_line ?? a.endLine;
  const raw: unknown[] = [];
  for (const key of ['files', 'paths', 'file_paths', 'filePaths']) {
    raw.push(...list(a[key]));
  }
  for (const key of ['path', 'file_path', 'filePath', 'file', '_raw']) {
    const v = a[key];
    if (Array.isArray(v)) {
      raw.push(...v);
    } else if (typeof v === 'string' && v.trim()) {
      raw.push(key === '_raw' ? v.trim().replace(/^["']|["']$/g, '') : v);
    }
  }
  const out: ReadRequest[] = [];
  for (const v of raw) {
    const r = entry(v);
    if (r && !out.some((o) => o.path === r.path && o.start === r.start && o.end === r.end)) {
      out.push({ path: r.path, start: r.start ?? lineNo(start), end: r.end ?? lineNo(end) });
    }
  }
  if (!out.length) {
    return 'read_file needs "path" (a workspace-relative path) or "files": [{"path": "…", "start_line"?: N, "end_line"?: N}]. Nothing was read.';
  }
  if (out.length > MAX_READ_FILES) {
    return `read_file reads at most ${MAX_READ_FILES} files per call (got ${out.length}). Split them over several read_file calls in the same response.`;
  }
  return out;
}

/**
 * Numbered lines `start..end` of a file (1-based, inclusive), cut to the window limits (`maxChars` characters), with a
 * footer saying how to continue while lines remain. `line(i)` returns line i (0-based) of `total`.
 */
export function renderWindow(line: (i: number) => string, total: number, start = 1, end?: number, maxChars = WINDOW_CHARS): { text: string; start: number; end: number } {
  const lineChars = Math.max(1, Math.min(LINE_CHARS, maxChars - 30));
  const first = Math.min(Math.max(1, start), Math.max(1, total));
  const last = Math.min(total, end ?? total, first + WINDOW_LINES - 1);
  const lines: string[] = [];
  let chars = 0;
  let shown = first - 1;
  for (let i = first - 1; i < last; i++) {
    const t = line(i);
    const body = t.length > lineChars ? `${t.slice(0, lineChars)} [line truncated]` : t;
    const row = `${String(i + 1).padStart(5)} | ${body}`;
    if (lines.length && chars + row.length + 1 > maxChars) {
      break;
    }
    lines.push(row);
    chars += row.length + 1;
    shown = i + 1;
  }
  const footer = shown < total ? `\n[Showing lines ${first}-${shown} of ${total}. Use start_line/end_line to read more.]` : '';
  return { text: `${lines.join('\n')}${footer}`, start: first, end: shown };
}

/** Folds every kind of Unicode space (U+202F in macOS screenshot names, NBSP …) to a plain space. */
export function foldSpaces(s: string): string {
  return s.normalize('NFC').replace(/[\s\u200B]+/g, ' ');
}

/** The directory entry `name` most likely means when it differs only in the kind of whitespace; undefined when none or several match. */
export function lenientMatch(name: string, entries: string[]): string | undefined {
  const want = foldSpaces(name);
  const hits = entries.filter((e) => foldSpaces(e) === want);
  return hits.length === 1 ? hits[0] : undefined;
}

/** True when the first bytes look like binary data (a NUL byte, or many control characters). */
export function looksBinary(head: Uint8Array): boolean {
  let control = 0;
  for (const b of head) {
    if (b === 0) {
      return true;
    }
    if (b < 32 && b !== 9 && b !== 10 && b !== 13 && b !== 12 && b !== 27) {
      control++;
    }
  }
  return head.length > 0 && control / head.length > 0.1;
}
