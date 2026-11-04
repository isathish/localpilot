import * as fs from 'fs';
import * as path from 'path';
import { globToRegExp } from './permissions';

/**
 * The agent ignore file: `.localpilotignore` in a workspace folder (Cline's `.clineignore` and Cursor's `.cursorignore`
 * are read as well). gitignore syntax — `#` comments, `!` negation, trailing `/` for folders, a leading or inner `/`
 * anchors to the folder — plus `!include <file>` to pull in another file's patterns (e.g. `!include .gitignore`).
 * Matching files are hidden from or lock-marked in listings and searches and refused by the file tools. Shell commands
 * are not affected: this keeps files out of the agent's context, it is not a security boundary.
 */
export const IGNORE_FILES = ['.localpilotignore', '.clineignore', '.cursorignore'] as const;

export interface IgnoreRule {
  negate: boolean;
  dirOnly: boolean;
  re: RegExp;
  /** The ignore file the rule came from (the including file for `!include`d patterns). */
  source: string;
}

const MAX_INCLUDE_DEPTH = 4;

/** Rules of one ignore file. `readInclude` returns the text of an `!include`d file (relative to the folder), if any. */
export function parseIgnoreRules(text: string, source: string, readInclude?: (rel: string) => string | undefined, depth = 0): IgnoreRule[] {
  const rules: IgnoreRule[] = [];
  for (const raw of text.split(/\r?\n/)) {
    if (!raw.trim() || raw.startsWith('#')) {
      continue;
    }
    const inc = /^!include\s+(.+?)\s*$/.exec(raw);
    if (inc) {
      const body = depth < MAX_INCLUDE_DEPTH ? readInclude?.(inc[1]) : undefined;
      if (body !== undefined) {
        rules.push(...parseIgnoreRules(body, source, readInclude, depth + 1));
      }
      continue;
    }
    let line = raw.replace(/(?<!\\)\s+$/, '');
    const negate = line.startsWith('!');
    if (negate) {
      line = line.slice(1);
    }
    line = line.replace(/^\\([#!])/, '$1').replace(/\\ /g, ' ');
    const dirOnly = line.endsWith('/');
    line = line.replace(/\/+$/, '');
    const anchored = line.includes('/');
    line = line.replace(/^\//, '');
    if (!line) {
      continue;
    }
    rules.push({ negate, dirOnly, re: globToRegExp(anchored ? line : `**/${line}`), source });
  }
  return rules;
}

export class IgnoreMatcher {
  constructor(
    readonly rules: readonly IgnoreRule[],
    /** Every file the rules were read from (for change detection). */
    readonly files: readonly string[] = []
  ) {}

  get empty(): boolean {
    return !this.rules.length;
  }

  /** The ignore file that excludes `rel` (relative to the folder), or undefined. A file in an excluded folder is excluded. */
  match(rel: string, isDir = false): string | undefined {
    const segs = rel.replace(/\\/g, '/').split('/').filter((s) => s && s !== '.');
    if (!segs.length || segs[0] === '..' || !this.rules.length) {
      return undefined;
    }
    for (let i = 1; i < segs.length; i++) {
      const hit = this.test(segs.slice(0, i).join('/'), true);
      if (hit) {
        return hit;
      }
    }
    return this.test(segs.join('/'), isDir);
  }

  /** gitignore precedence: the last matching rule decides. */
  private test(p: string, isDir: boolean): string | undefined {
    let last: IgnoreRule | undefined;
    for (const r of this.rules) {
      if ((!r.dirOnly || isDir) && r.re.test(p)) {
        last = r;
      }
    }
    return last && !last.negate ? last.source : undefined;
  }
}

const NONE = new IgnoreMatcher([]);

/** Reads the ignore files of `root` from disk. */
export function loadIgnore(root: string): IgnoreMatcher {
  const rules: IgnoreRule[] = [];
  const files: string[] = [];
  const read = (abs: string): string | undefined => {
    try {
      const text = fs.readFileSync(abs, 'utf8');
      files.push(abs);
      return text;
    } catch {
      return undefined;
    }
  };
  for (const name of IGNORE_FILES) {
    const text = read(path.join(root, name));
    if (text !== undefined) {
      rules.push(...parseIgnoreRules(text, name, (rel) => read(path.resolve(root, rel))));
    }
  }
  return rules.length ? new IgnoreMatcher(rules, files) : NONE;
}

const cache = new Map<string, { at: number; sig: string; matcher: IgnoreMatcher }>();
const RECHECK_MS = 2000;

function signature(root: string, extra: readonly string[]): string {
  return [...IGNORE_FILES.map((n) => path.join(root, n)), ...extra]
    .map((f) => {
      try {
        const st = fs.statSync(f);
        return `${st.mtimeMs}:${st.size}`;
      } catch {
        return '-';
      }
    })
    .join('|');
}

/** The matcher for `root`, cached; re-read when a watcher reports a change or the files' timestamps differ. */
export function ignoreFor(root: string): IgnoreMatcher {
  const hit = cache.get(root);
  if (hit && Date.now() - hit.at < RECHECK_MS) {
    return hit.matcher;
  }
  const sig = signature(root, hit?.matcher.files ?? []);
  if (hit && hit.sig === sig) {
    hit.at = Date.now();
    return hit.matcher;
  }
  const matcher = loadIgnore(root);
  cache.set(root, { at: Date.now(), sig: signature(root, matcher.files), matcher });
  return matcher;
}

/** Drops the cached rules (an ignore file was created, changed or deleted). */
export function invalidateIgnore(): void {
  cache.clear();
}

/** The ignore file excluding `abs`, judged by the innermost of `roots` that contains it. */
export function excludedBy(abs: string, roots: readonly string[], isDir = false): string | undefined {
  const fold = (s: string) => (process.platform === 'win32' ? s.toLowerCase() : s);
  let best: { root: string; rel: string } | undefined;
  for (const root of roots) {
    const rel = path.relative(fold(root), fold(abs));
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel) && (!best || root.length > best.root.length)) {
      best = { root, rel: path.relative(root, abs) };
    }
  }
  return best ? ignoreFor(best.root).match(best.rel.split(path.sep).join('/'), isDir) : undefined;
}

/** The message the file tools return for an excluded path. */
export const excludedMessage = (shown: string, source: string): string =>
  `${shown} is excluded by ${source}. The user keeps it out of the agent's context; do not try to read or change it another way.`;
