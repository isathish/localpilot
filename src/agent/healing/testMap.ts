import * as fs from 'fs';
import * as path from 'path';
import type { RepoGraph } from '../../context/repoGraph';
import type { CheckEcosystem } from './types';

/** Changed files -> what a scoped check run needs (design §2.3). Every path is relative to the check's folder, `/` separators. */
export interface AffectedTests {
  /** Changed source files that still exist (jest `--findRelatedTests`, `compileall`). */
  files: string[];
  /** Mapped test files plus changed test files. */
  tests: string[];
  /** Go package dirs (`./internal/x`) or Rust crate names. */
  pkgs: string[];
  /** JVM / .NET test class names. */
  classes: string[];
}

/** One-hop importers of a file; paths relative to the same root as `affectedTests`. */
export interface TestMapGraph {
  importers(file: string): Iterable<string>;
}

const SKIP_DIRS = new Set(['node_modules', '.git', 'target', 'dist', 'out', 'build', '.venv', 'venv', '__pycache__', 'bin', 'obj', '.gradle', 'vendor', '.localpilot', '.next', 'coverage']);
const MAX_FILES = 20_000;

const JS_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|mts|cts|vue|svelte)$/;
const JS_TEST = /\.(test|spec)\.[cm]?[jt]sx?$/;
const TEST_DIR = /^(tests?|__tests__|specs?)$/;
const JVM_EXT = /\.(java|kt|kts|scala|groovy)$/;
const DOTNET_EXT = /\.(cs|fs|vb)$/;

const slash = (p: string) => p.replace(/\\/g, '/').replace(/^\.\//, '');

/** Adapts a workspace `RepoGraph` (paths relative to the workspace root) to a check folder `cwd` inside it. */
export function repoGraphImporters(g: Pick<RepoGraph, 'rdeps'>, cwd = ''): TestMapGraph {
  const prefix = cwd ? `${slash(cwd).replace(/\/$/, '')}/` : '';
  return {
    importers(file: string): string[] {
      const out: string[] = [];
      for (const f of g.rdeps.get(prefix + file) ?? []) {
        if (f.startsWith(prefix)) {
          out.push(f.slice(prefix.length));
        }
      }
      return out;
    },
  };
}

/** Bounded walk of `root`, skipping dependency/build folders; relative paths. */
function listFiles(root: string): string[] {
  const out: string[] = [];
  const stack = [''];
  while (stack.length && out.length < MAX_FILES) {
    const rel = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const p = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) {
          stack.push(p);
        }
      } else if (e.isFile()) {
        out.push(p);
      }
    }
  }
  return out.sort();
}

const exists = (root: string, rel: string) => {
  try {
    return fs.statSync(path.join(root, rel)).isFile();
  } catch {
    return false;
  }
};

const dirOf = (rel: string) => (rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '');
const baseOf = (rel: string) => rel.slice(rel.lastIndexOf('/') + 1);
const inTestDir = (rel: string) => dirOf(rel).split('/').some((d) => TEST_DIR.test(d));

function isTestFile(rel: string, eco: CheckEcosystem): boolean {
  const b = baseOf(rel);
  switch (eco) {
    case 'python':
      return /^test_.+\.py$|_test\.py$/.test(b);
    case 'go':
      return /_test\.go$/.test(b);
    case 'maven':
    case 'gradle':
      return JVM_EXT.test(b) && /(Tests?|Spec|IT)$/.test(b.replace(/\.[^.]+$/, ''));
    case 'dotnet':
      return DOTNET_EXT.test(b) && /(Tests?|Spec)$/.test(b.replace(/\.[^.]+$/, ''));
    default:
      return JS_TEST.test(b) || (JS_EXT.test(b) && inTestDir(rel));
  }
}

/** `foo.test.ts` -> `foo`, `test_foo.py` -> `foo`. */
function jsStem(base: string): string {
  return base.replace(JS_EXT, '').replace(/\.(test|spec)$/, '');
}

function jsTestsFor(src: string, testFiles: string[]): string[] {
  const stem = jsStem(baseOf(src));
  const dir = dirOf(src);
  const parent = baseOf(dir);
  return testFiles.filter((t) => {
    const tb = baseOf(t);
    if (!JS_EXT.test(tb) || jsStem(tb) !== stem) {
      return false;
    }
    const td = dirOf(t);
    if (td === dir && JS_TEST.test(tb)) {
      return true;
    }
    if (td === (dir ? `${dir}/__tests__` : '__tests__')) {
      return true;
    }
    // test(s)/**/foo.*, src/test/foo.test.ts; `index` needs its folder name in the test path too.
    return inTestDir(t) && (stem !== 'index' || (!!parent && t.split('/').includes(parent)));
  });
}

function pyTestsFor(src: string, testFiles: string[]): string[] {
  const stem = baseOf(src).replace(/\.pyi?$/, '');
  const names = new Set([`test_${stem}.py`, `${stem}_test.py`]);
  const dir = dirOf(src);
  return testFiles.filter((t) => names.has(baseOf(t)) && (dirOf(t) === dir || inTestDir(t)));
}

/** `name` of the `[package]` table, read line by line so array values (`authors = ["A"]`) before it do not matter. */
function packageName(toml: string): string | undefined {
  const lines = toml.split(/\r?\n/);
  const start = lines.findIndex((l) => /^\s*\[package\]\s*(#.*)?$/.test(l));
  if (start < 0) {
    return undefined;
  }
  for (const line of lines.slice(start + 1)) {
    if (/^\s*\[/.test(line)) {
      return undefined;
    }
    const m = /^\s*name\s*=\s*["']([^"']+)["']/.exec(line);
    if (m) {
      return m[1];
    }
  }
  return undefined;
}

/** Name of the crate whose Cargo.toml is nearest above `rel` (within root). */
function crateOf(root: string, rel: string): string | undefined {
  let dir = dirOf(rel);
  for (;;) {
    const manifest = path.join(root, dir, 'Cargo.toml');
    try {
      const text = fs.readFileSync(manifest, 'utf8');
      return packageName(text);
    } catch {
      // keep walking up
    }
    if (!dir) {
      return undefined;
    }
    dir = dirOf(dir);
  }
}

const uniq = (xs: string[]) => [...new Set(xs)];

/**
 * Affected tests for the files changed in a turn (design §2.3). `root` is the folder the check runs in; changed files
 * may be absolute or relative to it, files outside it are ignored. Empty lists mean "nothing maps": run the full check.
 */
export async function affectedTests(changedFiles: string[], root: string, ecosystem: CheckEcosystem, graph?: TestMapGraph): Promise<AffectedTests> {
  const rel = uniq(
    changedFiles
      .map((f) => slash(path.isAbsolute(f) ? path.relative(root, f) : f))
      .filter((f) => f && !f.startsWith('../') && f !== '..' && !path.isAbsolute(f)),
  );
  const live = rel.filter((f) => exists(root, f));
  const res: AffectedTests = { files: [], tests: [], pkgs: [], classes: [] };
  if (!live.length) {
    return res;
  }
  const lazyIndex = (() => {
    let all: string[] | undefined;
    return () => (all ??= listFiles(root).filter((f) => isTestFile(f, ecosystem)));
  })();

  switch (ecosystem) {
    case 'node': {
      const src = live.filter((f) => JS_EXT.test(f));
      res.files = src;
      const tests = src.filter((f) => isTestFile(f, 'node'));
      const plain = src.filter((f) => !isTestFile(f, 'node'));
      if (plain.length) {
        const idx = lazyIndex();
        for (const f of plain) {
          tests.push(...jsTestsFor(f, idx));
          for (const imp of graph?.importers(f) ?? []) {
            const i = slash(imp);
            if (isTestFile(i, 'node') && exists(root, i)) {
              tests.push(i);
            }
          }
        }
      }
      res.tests = uniq(tests);
      break;
    }
    case 'python': {
      const src = live.filter((f) => /\.pyi?$/.test(f));
      res.files = src.filter((f) => f.endsWith('.py'));
      const tests = src.filter((f) => isTestFile(f, 'python') || baseOf(f) === 'conftest.py');
      const plain = src.filter((f) => !tests.includes(f));
      if (plain.length) {
        const idx = lazyIndex();
        for (const f of plain) {
          tests.push(...pyTestsFor(f, idx));
          for (const imp of graph?.importers(f) ?? []) {
            const i = slash(imp);
            if (isTestFile(i, 'python') && exists(root, i)) {
              tests.push(i);
            }
          }
        }
      }
      res.tests = uniq(tests.filter((t) => baseOf(t) !== 'conftest.py'));
      break;
    }
    case 'go': {
      const src = live.filter((f) => f.endsWith('.go'));
      res.files = src;
      res.pkgs = uniq(src.map((f) => (dirOf(f) ? `./${dirOf(f)}` : '.')));
      break;
    }
    case 'rust': {
      const src = live.filter((f) => f.endsWith('.rs'));
      res.files = src;
      res.pkgs = uniq(src.map((f) => crateOf(root, f)).filter((c): c is string => !!c));
      break;
    }
    case 'maven':
    case 'gradle':
    case 'dotnet': {
      const ext = ecosystem === 'dotnet' ? DOTNET_EXT : JVM_EXT;
      const src = live.filter((f) => ext.test(f));
      res.files = src;
      const known = new Set(lazyIndex().map((t) => baseOf(t).replace(/\.[^.]+$/, '')));
      const classes: string[] = [];
      for (const f of src) {
        const cls = baseOf(f).replace(/\.[^.]+$/, '');
        if (isTestFile(f, ecosystem)) {
          classes.push(cls);
          continue;
        }
        classes.push(...[`${cls}Test`, `${cls}Tests`, `${cls}Spec`].filter((c) => known.has(c)));
      }
      res.classes = uniq(classes);
      break;
    }
    default:
      res.files = live;
  }
  return res;
}

/** One shell argument: POSIX single quotes, or PowerShell single quotes on Windows. */
export function quoteArg(s: string, platform: NodeJS.Platform = process.platform): string {
  if (/^[\w./:@=+,~-]+$/.test(s)) {
    return s;
  }
  return platform === 'win32' ? `'${s.replace(/'/g, "''")}'` : `'${s.replace(/'/g, `'\\''`)}'`;
}

const PLACEHOLDER = /(^|\s)((?:--tests|-p|--package)\s+)?([^\s{}]*)\{(files|tests|pkgs|classes|crate)\}(?=\s|$)/g;

/**
 * Fills a scoped template. `{files}`/`{tests}`/`{pkgs}`/`{crate}`/`{classes}` expand to the quoted list joined by
 * spaces; `--tests`, `-p` or `--package` right before the placeholder repeats per item (`--tests {classes}`, `-p {crate}`); an attached
 * `name=` prefix joins with commas (`-Dtest={classes}`), an attached `name~` prefix joins as alternatives
 * (`FullyQualifiedName~{classes}`). Returns undefined when a placeholder has nothing to expand (run the full check).
 */
export function fillScoped(template: string, a: Partial<AffectedTests>, platform: NodeJS.Platform = process.platform): string | undefined {
  let missing = false;
  const filled = template.replace(PLACEHOLDER, (_m, lead: string, flag: string | undefined, prefix: string, key: string) => {
    const list = (key === 'crate' ? a.pkgs : a[key as keyof AffectedTests]) ?? [];
    if (!list.length) {
      missing = true;
      return '';
    }
    const q = (s: string) => quoteArg(s, platform);
    let body: string;
    if (prefix.endsWith('=')) {
      body = q(prefix + list.join(','));
    } else if (prefix.endsWith('~')) {
      body = q(list.map((x) => prefix + x).join('|'));
    } else if (flag) {
      return lead + list.map((x) => `${flag}${q(prefix + x)}`).join(' ');
    } else {
      body = list.map((x) => q(prefix + x)).join(' ');
    }
    return lead + (flag ?? '') + body;
  });
  return missing ? undefined : filled;
}
