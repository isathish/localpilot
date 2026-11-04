import { parseFrontMatter } from '../agent/frontMatter';
import { globToRegExp } from '../agent/permissions';

/**
 * Rule front matter: `disabled: true` (or the legacy `enabled: false`) turns a rule off; `paths:` / `globs:` (a list
 * or a comma-separated string) make it conditional, injected only while a matching file is in context. Cursor's
 * `.mdc` form (`alwaysApply: false` + `globs`) is read the same way; `alwaysApply: true` always applies.
 */
export interface RuleCondition {
  disabled: boolean;
  /** Globs (workspace-relative, POSIX) one context path must match; undefined = always applies, [] = never. */
  paths?: string[];
}

export interface ParsedRule {
  condition: RuleCondition;
  meta: Record<string, unknown>;
  /** The instructions: the body, or the whole file when the front matter is malformed (fail open). */
  body: string;
  invalid?: boolean;
}

const FRONT = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

const asBool = (v: unknown): boolean | undefined => {
  const s = typeof v === 'string' ? v.trim().toLowerCase() : v;
  return s === true || s === 'true' || s === 'yes' ? true : s === false || s === 'false' || s === 'no' ? false : undefined;
};

const asList = (v: unknown): string[] | undefined =>
  Array.isArray(v) ? v.map((s) => String(s).trim()).filter(Boolean) : typeof v === 'string' ? v.split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean) : undefined;

/** A front-matter block whose top-level lines are not all `key: value` (or comments) is not YAML we understand. */
export function frontMatterInvalid(raw: string): boolean {
  const m = FRONT.exec(raw.replace(/^\uFEFF/, ''));
  if (!m) {
    return false;
  }
  return m[1].split(/\r?\n/).some((l) => l.trim() && !/^\s/.test(l) && !/^#/.test(l) && !/^-\s/.test(l) && !/^[A-Za-z0-9_-]+:(\s|$)/.test(l));
}

export function ruleCondition(meta: Record<string, unknown>): RuleCondition {
  const disabled = asBool(meta.disabled) === true || asBool(meta.enabled) === false;
  if (asBool(meta.alwaysApply) === true) {
    return { disabled };
  }
  if ('paths' in meta) {
    return { disabled, paths: asList(meta.paths) ?? [] };
  }
  // An empty `globs:` is how Cursor writes "no globs": the rule stays unconditional.
  const globs = asList(meta.globs);
  return globs?.length ? { disabled, paths: globs } : { disabled };
}

export function parseRule(raw: string): ParsedRule {
  if (frontMatterInvalid(raw)) {
    return { condition: { disabled: false }, meta: {}, body: raw.replace(/^\uFEFF/, ''), invalid: true };
  }
  const { meta, body } = parseFrontMatter(raw);
  return { condition: ruleCondition(meta), meta, body };
}

const regexCache = new Map<string, RegExp[]>();

function globRegExps(glob: string): RegExp[] {
  let res = regexCache.get(glob);
  if (!res) {
    let g = glob.trim().replace(/\\/g, '/').replace(/^\.?\//, '');
    if (g.endsWith('/')) {
      g += '**';
    }
    const magic = /[*?{]/.test(g);
    res = [globToRegExp(g, { prefix: !magic })];
    if (!g.includes('/')) {
      // `*.tsx` / `README.md`: any depth, like .gitignore.
      res.push(globToRegExp(`**/${g}`, { prefix: !magic }));
    }
    if (regexCache.size > 500) {
      regexCache.clear();
    }
    regexCache.set(glob, res);
  }
  return res;
}

/** Does any context path match any of the globs? A bare file name (`Button.tsx`) is matched against the globs' last segment. */
export function ruleApplies(globs: string[], paths: readonly string[]): boolean {
  if (!globs.length || !paths.length) {
    return false;
  }
  return globs.some((g) => {
    const res = globRegExps(g);
    const last = g.replace(/\\/g, '/').replace(/\/+$/, '').split('/').pop() ?? '';
    const lastRe = last && last !== '**' ? globRegExps(last)[0] : undefined;
    return paths.some((p) => res.some((re) => re.test(p)) || (!p.includes('/') && !!lastRe && lastRe.test(p)));
  });
}

/** Workspace-relative POSIX form of a path, or undefined for absolute paths and paths that leave the workspace. */
export function normalizeContextPath(p: string): string | undefined {
  const s = p.trim().replace(/\\/g, '/').replace(/^@/, '').replace(/^(\.\/)+/, '').replace(/#L?\d+(?:-L?\d+)?$/i, '').replace(/:\d+(?::\d+)?$/, '').replace(/\/+$/, '');
  if (!s || s.startsWith('/') || s.startsWith('~') || /^[A-Za-z]:/.test(s) || s.split('/').includes('..')) {
    return undefined;
  }
  return s;
}

/**
 * A working-set path relative to its own workspace folder. In a multi-root workspace `asRelativePath` prefixes the
 * folder name (`web/src/ui/Button.tsx`), which rule globs written for the folder (`src/**` and the like) never match.
 */
export function folderRelativePath(p: string, folderNames: readonly string[]): string | undefined {
  const n = normalizeContextPath(p);
  if (!n || folderNames.length < 2) {
    return n;
  }
  const slash = n.indexOf('/');
  return slash > 0 && folderNames.includes(n.slice(0, slash)) ? n.slice(slash + 1) : n;
}

/**
 * Paths mentioned in a user message: attachment tags' `path`, `@mentions` and path-like words (with a `/` or a file
 * extension). Fenced code, attachment bodies, URLs and absolute paths are skipped.
 */
export function pathsInText(text: string, max = 200): string[] {
  const out = new Set<string>();
  const add = (p: string) => {
    const n = normalizeContextPath(p);
    if (n && out.size < max) {
      out.add(n);
    }
  };
  for (const m of text.matchAll(/<(?:attachment|directory)\s+path="([^"]+)"/g)) {
    add(m[1].replace(/&quot;/g, '"'));
  }
  const prose = text
    .replace(/<(attachment|directory)\b[^>]*>[\s\S]*?<\/\1>/g, ' ')
    .replace(/^(```|~~~)[^\n]*\n[\s\S]*?(?:^\1[^\n]*$|(?![\s\S]))/gm, ' ')
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, ' ');
  for (const m of prose.matchAll(/(?:^|[\s"'`(<[{,])@?((?:\.{1,2}\/)?[\w@.+-]+(?:\/[\w@.+-]+)*\/?(?:#L?\d+(?:-L?\d+)?|:\d+(?::\d+)?)?)/g)) {
    const word = m[1].replace(/[.,;:!?]+$/, '');
    const bare = word.replace(/#L?\d+(?:-L?\d+)?$|:\d+(?::\d+)?$/i, '').replace(/\/+$/, '');
    // A path has a folder part or a file extension (`notes.md`); `e.g`, `1.2.3` and plain words are not paths.
    if (bare.includes('/') ? /[A-Za-z]/.test(bare) : /^[\w@+-]*[A-Za-z_][\w@+-]*\.[A-Za-z][A-Za-z0-9]{0,9}$/.test(bare) && !/^(e\.g|i\.e)$/i.test(bare)) {
      add(word);
    }
  }
  return [...out];
}
