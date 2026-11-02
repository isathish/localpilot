import * as fs from 'fs';
import * as path from 'path';

/**
 * Repository intelligence without a language server: an import graph and a symbol index built from source text.
 * Works the same in VS Code and the CLI (plain `fs`), stays fast on large repositories (files are re-parsed only when
 * their mtime changes) and answers the questions an agent asks before a change: who imports this file, what does it
 * depend on, what could break if it changes, which modules are central, where are the cycles, which packages are used
 * where, and where is a symbol defined.
 */

export type Lang = 'ts' | 'py' | 'go' | 'rs' | 'java' | 'cs';

const LANG_BY_EXT: Record<string, Lang> = {
  ts: 'ts', tsx: 'ts', js: 'ts', jsx: 'ts', mjs: 'ts', cjs: 'ts', mts: 'ts', cts: 'ts', vue: 'ts', svelte: 'ts',
  py: 'py', go: 'go', rs: 'rs', java: 'java', kt: 'java', kts: 'java', cs: 'cs',
};
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'out', 'build', '.venv', 'venv', '__pycache__', '.next', 'target', 'coverage', '.vscode-test', '.turbo', '.cache', 'vendor', '.localpilot']);
const MAX_FILES = 30_000;
const MAX_BYTES = 512 * 1024;

export interface ParsedFile {
  /** Import specifiers as written (`./util`, `react`, `pkg.module`, `crate::a::b`). */
  imports: string[];
  /** Top-level definitions: name and 1-based line. */
  symbols: { name: string; kind: string; line: number }[];
}

export function langOf(file: string): Lang | undefined {
  return LANG_BY_EXT[path.extname(file).slice(1).toLowerCase()];
}

/** Imports and top-level symbols of one file. Regex-based: robust to syntax errors and fast enough for whole repos. */
export function parseSource(text: string, lang: Lang): ParsedFile {
  const imports = new Set<string>();
  const symbols: ParsedFile['symbols'] = [];
  const add = (re: RegExp, group = 1) => {
    for (const m of text.matchAll(re)) {
      if (m[group]) {
        imports.add(m[group]);
      }
    }
  };
  const lines = text.split('\n');
  const sym = (re: RegExp, kind: (m: RegExpExecArray) => string) => {
    lines.forEach((l, i) => {
      const m = re.exec(l);
      if (m) {
        symbols.push({ name: m[m.length - 1], kind: kind(m), line: i + 1 });
      }
    });
  };
  switch (lang) {
    case 'ts':
      add(/(?:^|[\s;])(?:import|export)\s+(?:type\s+)?(?:[\w*{}\s,$]+\s+from\s+)?['"]([^'"\n]+)['"]/gm);
      add(/\brequire\(\s*['"]([^'"\n]+)['"]\s*\)/g);
      add(/\bimport\(\s*['"]([^'"\n]+)['"]\s*\)/g);
      sym(/^\s*export\s+(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(function\*?|class|interface|type|enum|const|let|var)\s+([A-Za-z_$][\w$]*)/, (m) => m[1].replace('*', ''));
      break;
    case 'py':
      for (const m of text.matchAll(/^\s*from\s+([.\w]+)\s+import\s+([^\n#]+)/gm)) {
        // `from . import a, b` names modules, not symbols: record each so the package's submodules resolve.
        if (/^\.+$/.test(m[1])) {
          m[2].replace(/[()]/g, '').split(',').map((s) => s.trim().split(/\s+as\s+/)[0]).filter(Boolean).forEach((n) => imports.add(`${m[1]}${n}`));
        } else {
          imports.add(m[1]);
        }
      }
      for (const m of text.matchAll(/^\s*import\s+([\w., ]+)/gm)) {
        m[1].split(',').map((s) => s.trim().split(/\s+as\s+/)[0]).filter(Boolean).forEach((n) => imports.add(n));
      }
      sym(/^(def|class|async def)\s+([A-Za-z_]\w*)/, (m) => (m[1] === 'class' ? 'class' : 'function'));
      break;
    case 'go':
      add(/^\s*import\s+(?:\w+\s+)?"([^"]+)"/gm);
      for (const block of text.matchAll(/^\s*import\s*\(([\s\S]*?)\)/gm)) {
        for (const m of block[1].matchAll(/"([^"]+)"/g)) {
          imports.add(m[1]);
        }
      }
      sym(/^(func|type)\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/, (m) => (m[1] === 'func' ? 'function' : 'type'));
      break;
    case 'rs':
      add(/^\s*(?:pub\s+)?use\s+((?:crate|super|self)(?:::\w+)+)/gm);
      add(/^\s*(?:pub\s+)?mod\s+(\w+)\s*;/gm);
      add(/^\s*(?:pub\s+)?use\s+(\w+)::/gm);
      sym(/^\s*(?:pub(?:\([^)]*\))?\s+)?(fn|struct|enum|trait|type|const|static)\s+([A-Za-z_]\w*)/, (m) => m[1]);
      break;
    case 'java':
      add(/^\s*import\s+(?:static\s+)?([\w.]+?)(?:\.\*)?\s*;?\s*$/gm);
      sym(/^\s*(?:public\s+|private\s+|protected\s+|internal\s+|abstract\s+|final\s+|open\s+|data\s+|sealed\s+)*(class|interface|enum|object|record|fun)\s+([A-Za-z_]\w*)/, (m) => m[1]);
      break;
    case 'cs':
      add(/^\s*using\s+(?:static\s+)?([\w.]+)\s*;/gm);
      sym(/^\s*(?:public\s+|internal\s+|private\s+|protected\s+|static\s+|sealed\s+|abstract\s+|partial\s+)*(class|interface|struct|enum|record)\s+([A-Za-z_]\w*)/, (m) => m[1]);
      break;
  }
  return { imports: [...imports], symbols };
}

export interface RepoGraph {
  root: string;
  files: string[];
  /** file → files it imports (workspace-relative, `/` separators). */
  deps: Map<string, Set<string>>;
  /** file → files that import it. */
  rdeps: Map<string, Set<string>>;
  /** external package → files that import it. */
  external: Map<string, Set<string>>;
  symbols: Map<string, { file: string; kind: string; line: number }[]>;
  truncated: boolean;
}

const TS_EXTS = ['', '.ts', '.tsx', '.d.ts', '.js', '.jsx', '.mjs', '.cjs', '.vue', '.svelte', '/index.ts', '/index.tsx', '/index.js', '/index.jsx', '/index.mjs'];

/** Package name for an external import (`@scope/pkg/x` → `@scope/pkg`, `lodash/fp` → `lodash`, `os.path` → `os`). */
function packageOf(spec: string, lang: Lang): string {
  if (lang === 'ts') {
    const parts = spec.replace(/^node:/, '').split('/');
    return spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
  }
  if (lang === 'go') {
    return spec.split('/').slice(0, spec.includes('.') ? 3 : 1).join('/');
  }
  return spec.split(/[.:]+/)[0];
}

/**
 * Resolves one import of `from` to a workspace file, or undefined when it is external. `has` answers whether a
 * workspace-relative path exists; `goModule` is the module path from go.mod, `tsPaths` the tsconfig `paths` prefixes.
 */
export function resolveImport(spec: string, from: string, lang: Lang, has: (p: string) => boolean, ctx: { goModule?: string; tsPaths?: [string, string][]; javaIndex?: Map<string, string> } = {}): string | undefined {
  const dir = path.posix.dirname(from);
  const tryAll = (base: string, exts: string[]) => exts.map((e) => path.posix.normalize(base + e)).find((p) => !p.startsWith('..') && has(p));
  switch (lang) {
    case 'ts': {
      if (spec.startsWith('.')) {
        // `./x.js` in TypeScript ESM sources means `./x.ts`.
        const base = path.posix.join(dir, spec);
        return tryAll(base, TS_EXTS) ?? tryAll(base.replace(/\.[cm]?js$/, ''), TS_EXTS);
      }
      for (const [prefix, target] of ctx.tsPaths ?? []) {
        if (spec === prefix || spec.startsWith(`${prefix}/`)) {
          const hit = tryAll(path.posix.join(target, spec.slice(prefix.length)), TS_EXTS);
          if (hit) {
            return hit;
          }
        }
      }
      return undefined;
    }
    case 'py': {
      const dots = /^\.+/.exec(spec)?.[0].length ?? 0;
      const rest = spec.slice(dots).replace(/\./g, '/');
      const bases = dots ? [path.posix.join(dir, ...Array(dots - 1).fill('..'), rest)] : [rest, `src/${rest}`];
      for (const b of bases) {
        const hit = tryAll(b, ['.py', '/__init__.py']);
        if (hit) {
          return hit;
        }
      }
      return undefined;
    }
    case 'go': {
      if (!ctx.goModule || !(spec === ctx.goModule || spec.startsWith(`${ctx.goModule}/`))) {
        return undefined;
      }
      // A Go import names a package (folder): the edge goes to its first file, which stands for the package.
      return `${spec.slice(ctx.goModule.length + 1) || '.'}/`;
    }
    case 'rs': {
      if (!/^(crate|super|self)::/.test(spec) && spec.includes('::')) {
        return undefined;
      }
      const segs = spec.split('::');
      const base = segs[0] === 'crate' ? 'src' : segs[0] === 'super' ? path.posix.dirname(dir) : dir;
      const names = /^(crate|super|self)$/.test(segs[0]) ? segs.slice(1) : segs;
      // `use crate::a::b::Item` → try src/a/b.rs, src/a/b/mod.rs, then src/a.rs (Item is a symbol).
      for (let n = names.length; n > 0; n--) {
        const p = path.posix.join(base, ...names.slice(0, n));
        const hit = tryAll(p, ['.rs', '/mod.rs']);
        if (hit) {
          return hit;
        }
      }
      return undefined;
    }
    case 'java':
    case 'cs':
      return ctx.javaIndex?.get(spec) ?? ctx.javaIndex?.get(spec.split('.').slice(0, -1).join('.'));
  }
}

interface CacheEntry {
  mtime: number;
  parsed: ParsedFile;
}

/** One cache per root: an incremental rebuild re-parses only files whose mtime changed. */
const caches = new Map<string, { files: Map<string, CacheEntry>; graph?: RepoGraph; builtAt: number }>();

async function walk(root: string): Promise<{ files: { rel: string; mtime: number }[]; truncated: boolean }> {
  const out: { rel: string; mtime: number }[] = [];
  const stack = [''];
  while (stack.length && out.length < MAX_FILES) {
    const rel = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(path.join(root, rel), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) {
          stack.push(r);
        }
      } else if (e.isFile() && (langOf(e.name) || /^(go\.mod|tsconfig\.json)$/.test(e.name))) {
        try {
          const st = await fs.promises.stat(path.join(root, r));
          if (st.size <= MAX_BYTES) {
            out.push({ rel: r, mtime: st.mtimeMs });
          }
        } catch {
          /* vanished */
        }
      }
    }
  }
  return { files: out, truncated: out.length >= MAX_FILES };
}

/** Builds (or incrementally refreshes) the graph for `root`. Rebuilt at most every `maxAgeMs`. */
export async function buildRepoGraph(root: string, maxAgeMs = 5_000): Promise<RepoGraph> {
  const cache = caches.get(root) ?? { files: new Map<string, CacheEntry>(), builtAt: 0 };
  caches.set(root, cache);
  if (cache.graph && Date.now() - cache.builtAt < maxAgeMs) {
    return cache.graph;
  }
  const { files: listed, truncated } = await walk(root);
  const seen = new Set<string>();
  let goModule: string | undefined;
  let tsPaths: [string, string][] = [];
  for (const f of listed) {
    seen.add(f.rel);
    if (f.rel === 'go.mod') {
      goModule = /^module\s+(\S+)/m.exec(await fs.promises.readFile(path.join(root, f.rel), 'utf8').catch(() => ''))?.[1];
      continue;
    }
    if (f.rel === 'tsconfig.json') {
      tsPaths = readTsPaths(await fs.promises.readFile(path.join(root, f.rel), 'utf8').catch(() => ''));
      continue;
    }
    if (!langOf(f.rel)) {
      continue;
    }
    const hit = cache.files.get(f.rel);
    if (hit && hit.mtime === f.mtime) {
      continue;
    }
    const text = await fs.promises.readFile(path.join(root, f.rel), 'utf8').catch(() => '');
    cache.files.set(f.rel, { mtime: f.mtime, parsed: parseSource(text, langOf(f.rel)!) });
  }
  for (const k of [...cache.files.keys()]) {
    if (!seen.has(k)) {
      cache.files.delete(k);
    }
  }
  cache.graph = assembleGraph(root, new Map([...cache.files].map(([k, v]) => [k, v.parsed])), { goModule, tsPaths }, truncated);
  cache.builtAt = Date.now();
  return cache.graph;
}

/** `compilerOptions.paths` prefixes (`@/*` → `src/*`) from a tsconfig, tolerating comments and trailing commas. */
export function readTsPaths(text: string): [string, string][] {
  try {
    const json = JSON.parse(text.replace(/\/\*[\s\S]*?\*\/|(^|[^:"])\/\/.*$/gm, '$1').replace(/,(\s*[}\]])/g, '$1')) as { compilerOptions?: { baseUrl?: string; paths?: Record<string, string[]> } };
    const base = json.compilerOptions?.baseUrl ?? '.';
    return Object.entries(json.compilerOptions?.paths ?? {}).flatMap(([k, v]) => (v[0] ? [[k.replace(/\/\*$/, ''), path.posix.normalize(path.posix.join(base, v[0].replace(/\/\*$/, '')))] as [string, string]] : []));
  } catch {
    return [];
  }
}

/** Pure: the graph from parsed files. Exposed for tests. */
export function assembleGraph(root: string, parsed: Map<string, ParsedFile>, ctx: { goModule?: string; tsPaths?: [string, string][] } = {}, truncated = false): RepoGraph {
  const files = [...parsed.keys()].sort();
  const has = (p: string) => parsed.has(p);
  // Java/Kotlin/C#: a fully qualified name maps to the file declaring that type in that package/namespace.
  const javaIndex = new Map<string, string>();
  // Go: a package folder maps to its first file.
  const goPkg = new Map<string, string>();
  for (const f of files) {
    const lang = langOf(f);
    if (lang === 'go' && !/_test\.go$/.test(f)) {
      const d = `${path.posix.dirname(f)}/`;
      if (!goPkg.has(d)) {
        goPkg.set(d, f);
      }
    }
  }
  const deps = new Map<string, Set<string>>();
  const rdeps = new Map<string, Set<string>>();
  const external = new Map<string, Set<string>>();
  const symbols = new Map<string, { file: string; kind: string; line: number }[]>();
  for (const f of files) {
    const p = parsed.get(f)!;
    for (const s of p.symbols) {
      const list = symbols.get(s.name) ?? [];
      list.push({ file: f, kind: s.kind, line: s.line });
      symbols.set(s.name, list);
      if (langOf(f) === 'java' || langOf(f) === 'cs') {
        javaIndex.set(`${packageName(f, p) ?? ''}.${s.name}`.replace(/^\./, ''), f);
      }
    }
  }
  for (const f of files) {
    const lang = langOf(f)!;
    const out = new Set<string>();
    for (const spec of parsed.get(f)!.imports) {
      let target = resolveImport(spec, f, lang, has, { ...ctx, javaIndex });
      if (target?.endsWith('/')) {
        target = goPkg.get(target);
      }
      if (target && target !== f) {
        out.add(target);
        const r = rdeps.get(target) ?? new Set<string>();
        r.add(f);
        rdeps.set(target, r);
      } else if (!target && !isLocalSpec(spec, lang)) {
        const pkg = packageOf(spec, lang);
        if (pkg) {
          const e = external.get(pkg) ?? new Set<string>();
          e.add(f);
          external.set(pkg, e);
        }
      }
    }
    deps.set(f, out);
  }
  return { root, files, deps, rdeps, external, symbols, truncated };
}

const packageDecl = new WeakMap<ParsedFile, string | undefined>();
function packageName(file: string, p: ParsedFile): string | undefined {
  // The package is not kept by parseSource; derive it from the path as Java/Kotlin layouts do (src/main/java/a/b/C.java).
  if (!packageDecl.has(p)) {
    const m = /(?:^|\/)(?:java|kotlin|src)\/(.+)\/[^/]+$/.exec(file);
    packageDecl.set(p, m ? m[1].replace(/\//g, '.') : undefined);
  }
  return packageDecl.get(p);
}

function isLocalSpec(spec: string, lang: Lang): boolean {
  return (lang === 'ts' && spec.startsWith('.')) || (lang === 'py' && spec.startsWith('.')) || (lang === 'rs' && /^(crate|super|self)\b/.test(spec)) || (lang === 'rs' && !spec.includes('::'));
}

/** Files reachable along `edges` from `start`, with their distance (breadth first, up to `maxDepth`). */
export function reach(edges: Map<string, Set<string>>, start: string, maxDepth = 6): Map<string, number> {
  const dist = new Map<string, number>([[start, 0]]);
  let frontier = [start];
  for (let d = 1; d <= maxDepth && frontier.length; d++) {
    const next: string[] = [];
    for (const f of frontier) {
      for (const g of edges.get(f) ?? []) {
        if (!dist.has(g)) {
          dist.set(g, d);
          next.push(g);
        }
      }
    }
    frontier = next;
  }
  dist.delete(start);
  return dist;
}

/** Import cycles (strongly connected components with more than one file, or a file importing itself), largest first. */
export function findCycles(g: RepoGraph, max = 10): string[][] {
  let index = 0;
  const idx = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const out: string[][] = [];
  // Iterative Tarjan: recursion would overflow on long import chains.
  for (const start of g.files) {
    if (idx.has(start)) {
      continue;
    }
    const work: { v: string; it: Iterator<string> }[] = [];
    const open = (v: string) => {
      idx.set(v, index);
      low.set(v, index++);
      stack.push(v);
      onStack.add(v);
      work.push({ v, it: (g.deps.get(v) ?? new Set<string>()).values() });
    };
    open(start);
    while (work.length) {
      const top = work[work.length - 1];
      const n = top.it.next();
      if (!n.done) {
        const w = n.value;
        if (!idx.has(w)) {
          open(w);
        } else if (onStack.has(w)) {
          low.set(top.v, Math.min(low.get(top.v)!, idx.get(w)!));
        }
        continue;
      }
      work.pop();
      if (work.length) {
        const parent = work[work.length - 1].v;
        low.set(parent, Math.min(low.get(parent)!, low.get(top.v)!));
      }
      if (low.get(top.v) === idx.get(top.v)) {
        const comp: string[] = [];
        let w: string;
        do {
          w = stack.pop()!;
          onStack.delete(w);
          comp.push(w);
        } while (w !== top.v);
        if (comp.length > 1) {
          out.push(comp.sort());
        }
      }
    }
  }
  return out.sort((a, b) => b.length - a.length).slice(0, max);
}

/** Most-imported files: the modules a change ripples out from. */
export function hubs(g: RepoGraph, max = 15): { file: string; importedBy: number; imports: number }[] {
  return g.files
    .map((file) => ({ file, importedBy: g.rdeps.get(file)?.size ?? 0, imports: g.deps.get(file)?.size ?? 0 }))
    .filter((h) => h.importedBy > 0)
    .sort((a, b) => b.importedBy - a.importedBy || a.file.localeCompare(b.file))
    .slice(0, max);
}

/** Normalises a user-given path to the graph's key (workspace-relative, `/`), or suggests the closest match. */
export function fileKey(g: RepoGraph, input: string): { key?: string; suggestions: string[] } {
  const norm = input.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
  const rel = path.isAbsolute(input) ? path.relative(g.root, input).split(path.sep).join('/') : norm;
  if (g.deps.has(rel)) {
    return { key: rel, suggestions: [] };
  }
  const base = path.posix.basename(rel);
  const matches = g.files.filter((f) => f.endsWith(`/${rel}`) || f === rel || path.posix.basename(f) === base || path.posix.basename(f).replace(/\.[^.]+$/, '') === base);
  return matches.length === 1 ? { key: matches[0], suggestions: [] } : { suggestions: matches.slice(0, 8) };
}
