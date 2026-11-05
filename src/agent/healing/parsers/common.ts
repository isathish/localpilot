import { exactSignature, relativePath } from '../signature';
import type { Failure, FailureCategory, FailureClass, FailureSource, Severity } from '../types';

/** What a parser reports: a failure without id, source and signatures (the classifier adds them). */
export type ParsedFailure = Omit<Failure, 'id' | 'signature' | 'generic' | 'source'> & { source?: FailureSource };

/** A toolchain parser: pure, at most MAX_FAILURES results, deduped by exact signature. */
export type Parser = (text: string, root: string) => ParsedFailure[];

export const MAX_FAILURES = 50;
export const MAX_EVIDENCE = 2048;
export const MAX_MESSAGE = 300;

const CLASS: Record<FailureCategory, FailureClass> = {
  model_timeout: 'transient', model_unavailable: 'transient', model_overload: 'environmental', model_output: 'deterministic',
  compile: 'deterministic', typescript: 'deterministic', lint: 'deterministic', build: 'deterministic', dependency: 'environmental',
  unit_test: 'deterministic', integration_test: 'deterministic', runtime: 'deterministic',
  database: 'deterministic', data_corruption: 'fatal', mcp: 'transient', git_conflict: 'policy', security: 'policy',
  tool: 'deterministic', permission: 'policy', check_timeout: 'environmental', loop: 'fatal', unknown: 'deterministic',
};

const SEVERITY: Record<FailureCategory, Severity> = {
  model_timeout: 'medium', model_unavailable: 'medium', model_overload: 'medium', model_output: 'medium',
  compile: 'high', typescript: 'high', lint: 'low', build: 'high', dependency: 'high',
  unit_test: 'medium', integration_test: 'medium', runtime: 'high',
  database: 'high', data_corruption: 'critical', mcp: 'medium', git_conflict: 'high', security: 'high',
  tool: 'low', permission: 'high', check_timeout: 'medium', loop: 'high', unknown: 'medium',
};

export const defaultClass = (c: FailureCategory): FailureClass => CLASS[c];
export const defaultSeverity = (c: FailureCategory): Severity => SEVERITY[c];

const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07/g;

/** Output lines without ANSI codes or carriage returns. */
export const lines = (text: string): string[] => text.replace(ANSI, '').replace(/\r\n?/g, '\n').split('\n');

export const clip = (s: string, max: number): string => (s.length <= max ? s : `${s.slice(0, max - 1)}…`);

/** Lines `from` to `to` (exclusive) joined, trailing blank lines dropped, at most MAX_EVIDENCE characters. */
export function excerpt(ls: readonly string[], from: number, to: number): string {
  const part = ls.slice(Math.max(0, from), Math.min(ls.length, to));
  while (part.length && !part[part.length - 1].trim()) {
    part.pop();
  }
  return clip(part.join('\n'), MAX_EVIDENCE);
}

export interface FailureInit {
  message: string;
  code?: string;
  file?: string;
  line?: number;
  column?: number;
  test?: string;
  symbol?: string;
  evidence?: string;
  cls?: FailureClass;
  severity?: Severity;
  notExecuted?: boolean;
}

/** A parsed failure with the category's default class and severity, a workspace-relative file and clipped texts. */
export function make(category: FailureCategory, init: FailureInit, root?: string): ParsedFailure {
  const message = clip(relativiseText(init.message.trim(), root).replace(/\s+/g, ' '), MAX_MESSAGE) || category;
  const f: ParsedFailure = {
    category,
    cls: init.cls ?? defaultClass(category),
    severity: init.severity ?? defaultSeverity(category),
    message,
    evidence: clip(init.evidence ?? init.message, MAX_EVIDENCE),
  };
  if (init.code) { f.code = init.code; }
  if (init.file) { f.file = relativePath(init.file, root); }
  if (init.line !== undefined && Number.isFinite(init.line)) { f.line = init.line; }
  if (init.column !== undefined && Number.isFinite(init.column)) { f.column = init.column; }
  if (init.test) { f.test = init.test.trim(); }
  if (init.symbol) { f.symbol = init.symbol; }
  if (init.notExecuted !== undefined) { f.notExecuted = init.notExecuted; }
  return f;
}

/** `text` with the workspace root prefix removed from absolute paths. */
export function relativiseText(text: string, root?: string): string {
  if (!root) {
    return text;
  }
  const r = root.replace(/[\\/]+$/, '');
  if (!r) {
    return text;
  }
  const variants = new Set([r, r.replace(/\\/g, '/')]);
  let out = text;
  for (const v of variants) {
    out = out.split(`${v}/`).join('').split(`${v}\\`).join('');
  }
  return out;
}

/**
 * `kept` with the messages, lines and symbols of failures that share its exact signature appended to the evidence
 * (at most MAX_EVIDENCE), so one fix covers every occurrence.
 */
export function withDuplicates<T extends ParsedFailure>(kept: T, dups: readonly ParsedFailure[]): T {
  const notes: string[] = [];
  const symbols = new Set(kept.symbol ? [kept.symbol] : []);
  for (const d of dups) {
    const note = `${d.line !== undefined ? `line ${d.line}: ` : ''}${d.message}`;
    if (!notes.includes(note)) {
      notes.push(note);
    }
    if (d.symbol) {
      symbols.add(d.symbol);
    }
  }
  if (!notes.length) {
    return kept;
  }
  let extra = `\n\nAlso (same error):\n${notes.map((n) => `- ${n}`).join('\n')}`;
  if (symbols.size > 1) {
    extra += `\nSymbols: ${[...symbols].join(', ')}`;
  }
  extra = clip(extra, Math.floor(MAX_EVIDENCE / 2));
  return { ...kept, evidence: `${clip(kept.evidence, MAX_EVIDENCE - extra.length)}${extra}` };
}

/** Deduped by exact signature (duplicates folded into the first), at most MAX_FAILURES. */
export function finish(list: readonly ParsedFailure[], root?: string): ParsedFailure[] {
  const bySig = new Map<string, { kept: ParsedFailure; dups: ParsedFailure[] }>();
  for (const f of list) {
    const sig = exactSignature(f, root);
    const hit = bySig.get(sig);
    if (hit) {
      hit.dups.push(f);
    } else if (bySig.size < MAX_FAILURES) {
      bySig.set(sig, { kept: f, dups: [] });
    }
  }
  return [...bySig.values()].map((e) => withDuplicates(e.kept, e.dups));
}

/** Lowercase words of an identifier or path, camelCase and snake_case split ('TestAPIGet' -> test api get). */
export function words(s: string): string[] {
  return s
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

const INTEGRATION_WORDS = new Set(['integration', 'integrations', 'e2e', 'api', 'apis', 'contract', 'contracts']);

/** A test path or name that names an integration, end-to-end, API or contract test. */
export const looksIntegration = (...names: (string | undefined)[]): boolean => names.some((n) => !!n && words(n).some((w) => INTEGRATION_WORDS.has(w)));

/** A module specifier that names a package, not a relative/absolute path or a common path alias. */
export function isPackageSpecifier(spec: string): boolean {
  return !!spec && !/^(\.{1,2}(\/|$)|\/|[A-Za-z]:[\\/]|~\/|@\/|#|node:|file:)/.test(spec);
}

/** The installable package of a specifier: '@scope/name' or the first path segment. */
export function packageName(spec: string): string {
  const parts = spec.split('/');
  return spec.startsWith('@') && parts.length > 1 ? `${parts[0]}/${parts[1]}` : parts[0];
}

const isLibraryPath = (p: string) => /(^|[\\/])(node_modules|site-packages|dist-packages|\.cargo|go[\\/]pkg[\\/]mod|lib[\\/]python\d)/.test(p) || /^(node:|internal[\\/])/.test(p);

/** Stack frames of a JS/Python/Go/Rust/.NET excerpt, innermost first, library and runtime frames excluded. */
export function stackFrames(text: string, root?: string): { file: string; line: number }[] {
  const out: { file: string; line: number }[] = [];
  const py: { file: string; line: number }[] = [];
  for (const l of lines(text)) {
    let m = /^\s*(?:at\s+(?:.*?\()?|❯\s+|→\s+)((?:file:\/\/)?(?:[A-Za-z]:)?[^\s()]+?\.[A-Za-z]\w*):(\d+)(?::\d+)?\)?\s*\{?\s*$/.exec(l);
    if (m) {
      out.push({ file: m[1], line: Number(m[2]) });
      continue;
    }
    m = /^\s*File "([^"]+)", line (\d+)/.exec(l);
    if (m) {
      py.push({ file: m[1], line: Number(m[2]) });
      continue;
    }
    m = /^\s+at .* in (.+?):line (\d+)\s*$/.exec(l) ?? /^\s+((?:[A-Za-z]:)?\/?[^\s:]+\.go):(\d+)(?: \+0x[0-9a-f]+)?\s*$/.exec(l);
    if (m) {
      out.push({ file: m[1], line: Number(m[2]) });
    }
  }
  // Python prints the innermost frame last.
  const all = [...out, ...py.reverse()]
    .filter((f) => !isLibraryPath(f.file))
    .map((f) => ({ file: relativePath(f.file, root), line: f.line }));
  // Prefer frames inside the workspace when there are any (runtime/stdlib frames stay absolute).
  const inside = all.filter((f) => !/^(?:[A-Za-z]:)?\//.test(f.file));
  return inside.length ? inside : all;
}

/** The innermost project frame of an excerpt, workspace-relative. */
export const topFrame = (text: string, root?: string): { file: string; line: number } | undefined => stackFrames(text, root)[0];
