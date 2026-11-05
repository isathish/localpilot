import * as fs from 'fs';
import * as path from 'path';
import { relativePath } from './signature';
import type { AttemptRecord, CheckEcosystem, Failure, FailureCategory, MemoryEntry } from './types';
import type { MemorySuggestion } from './failureMemory';

/**
 * Root Cause Analyzer (design §5.1-5.2): picks the first root-cause group of a failure set, extracts tight evidence
 * (code excerpts, assertion block, stack frames, category extras, this turn's diff, memory suggestions) under a
 * character cap, renders the hidden fix prompt / fixer brief, parses the model's `Root cause:` / `Blocked:` lines and
 * expands the fixed dependency resolver templates. Deterministic; the only I/O is reading workspace files.
 */

export const EXCERPT_RADIUS = 6;
export const EXCERPT_MAX_LINES = 60;
export const EVIDENCE_CHAR_CAP = 6000;
export const EVIDENCE_CHAR_MIN = 1500;
export const MAX_GROUP_FAILURES = 3;
const MAX_MESSAGE_CHARS = 360;
export const MAX_FRAMES = 3;
export const MAX_NEIGHBOURS = 5;
export const MAX_DIFF_LINES = 80;
export const MAX_MEMORY = 2;
const MAX_READ_BYTES = 2 * 1024 * 1024;

export const TEST_RULE = 'Do not change tests, test config or package.json scripts; LocalPilot will not count that as a fix.';

export interface Excerpt {
  /** Workspace-relative. */
  file: string;
  /** 1-based, inclusive. */
  start: number;
  end: number;
  /** Numbered lines; the failing lines are marked with `>`. */
  text: string;
}

export interface PreviousAttempt {
  n?: number;
  rootCause?: string;
  strategy?: string;
  result?: AttemptRecord['result'];
  /** Free text: what was changed. */
  summary?: string;
}

export interface EvidenceInput {
  /** One root-cause group (see `groupFailures`); only the first `MAX_GROUP_FAILURES` are used. */
  group: readonly Failure[];
  root: string;
  /** This turn's patch diff for the files in the group (PatchManager previews). */
  patchDiff?: string;
  /** Already sanitised entries (`sanitiseForPrompt` / `FailureMemory.suggest`). */
  memory?: readonly (MemoryEntry | MemorySuggestion)[];
  /** repoGraph neighbours (importers/imports) of a file, or a precomputed list. */
  neighbours?: readonly string[] | ((file: string) => readonly string[]);
  previousAttempts?: readonly PreviousAttempt[];
  /** Model context window in tokens; scales the character cap down for tiny windows. */
  contextWindow?: number;
  /** Workspace-relative files changed this turn (database: touched migrations). */
  changedFiles?: readonly string[];
}

export interface DependencyInfo {
  ecosystem?: CheckEcosystem;
  /** Workspace-relative manifest path. */
  manifest?: string;
  snippet?: string;
  lockfiles: string[];
  /** The missing package is named in the manifest (install from the manifest instead of adding it). */
  declared?: boolean;
}

export interface MemoryNote {
  rootCause: string;
  strategy: string;
  patchSummary: string;
  codeChanged: boolean;
}

export interface Evidence {
  primary: Failure;
  failures: Failure[];
  category: FailureCategory;
  code?: string;
  signature: string;
  /** 'src/api/user.ts:42', or the test id. */
  where?: string;
  hypothesis: string;
  excerpts: Excerpt[];
  assertion?: string;
  frames: string[];
  /** Labelled category extras ('Declared type', 'Related files', 'Manifest'…). */
  extras: { label: string; text: string }[];
  diff?: string;
  memory: MemoryNote[];
  previous: string[];
  dependency?: DependencyInfo;
  charCap: number;
}

// ---- Grouping ----

const COMPILE_LIKE: readonly FailureCategory[] = ['compile', 'typescript', 'build'];
const TEST_LIKE: readonly FailureCategory[] = ['unit_test', 'integration_test', 'runtime'];
const SEVERITY_RANK = { critical: 4, high: 3, medium: 2, low: 1, info: 0 } as const;

/**
 * Root-cause candidates: same file + same code share a group; a test/runtime failure whose top in-workspace frame is
 * in a file with a compile error joins that compile group (compile wins, the test is likely a consequence).
 * Groups are ordered compile-first, then by severity, then by first appearance.
 */
export function groupFailures(failures: readonly Failure[], root?: string): Failure[][] {
  const groups: { key: string; items: Failure[]; order: number }[] = [];
  const byKey = new Map<string, Failure[]>();
  const add = (key: string, f: Failure) => {
    const g = byKey.get(key);
    if (g) {
      g.push(f);
      return;
    }
    const items = [f];
    byKey.set(key, items);
    groups.push({ key, items, order: groups.length });
  };
  const fileOf = (f: Failure) => (f.file ? relativePath(f.file, root) : '');
  const compileFiles = new Map<string, string>();
  for (const f of failures) {
    if (COMPILE_LIKE.includes(f.category) && f.file) {
      const key = `${fileOf(f)}|${f.code ?? f.category}`;
      if (!compileFiles.has(fileOf(f))) {
        compileFiles.set(fileOf(f), key);
      }
    }
  }
  for (const f of failures) {
    if (TEST_LIKE.includes(f.category)) {
      const top = frames(f.evidence, root)[0];
      const topFile = top ? top.replace(/:\d+(?::\d+)?$/, '') : '';
      const compileKey = compileFiles.get(topFile) ?? (f.file ? compileFiles.get(fileOf(f)) : undefined);
      if (compileKey) {
        add(compileKey, f);
        continue;
      }
    }
    add(f.file || f.test ? `${fileOf(f) || f.test}|${f.code ?? f.category}` : `${f.signature}`, f);
  }
  const rank = (g: { items: Failure[] }) => {
    const first = g.items[0];
    const compile = COMPILE_LIKE.includes(first.category) ? 1 : 0;
    const sev = Math.max(...g.items.map((f) => SEVERITY_RANK[f.severity] ?? 0));
    return compile * 10 + sev;
  };
  return groups.sort((a, b) => rank(b) - rank(a) || a.order - b.order).map((g) => g.items);
}

// ---- Evidence ----

/** Character cap of the evidence: 6000, scaled to 3% of the context window (about 4 chars per token), at least 1500. */
export function evidenceCharCap(contextWindow?: number): number {
  if (!contextWindow || !Number.isFinite(contextWindow) || contextWindow <= 0) {
    return EVIDENCE_CHAR_CAP;
  }
  return Math.max(EVIDENCE_CHAR_MIN, Math.min(EVIDENCE_CHAR_CAP, Math.floor(contextWindow * 0.03 * 4)));
}

/** Absolute path of a workspace-relative (or absolute in-workspace) file, or undefined when it escapes the root. */
function inRoot(root: string, file: string): string | undefined {
  const abs = path.resolve(root, file);
  const rel = path.relative(root, abs);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? abs : undefined;
}

function readLines(root: string, file: string): string[] | undefined {
  const abs = inRoot(root, file);
  if (!abs) {
    return undefined;
  }
  try {
    const st = fs.statSync(abs);
    if (!st.isFile() || st.size > MAX_READ_BYTES) {
      return undefined;
    }
    const text = fs.readFileSync(abs, 'utf8');
    return text.includes('\u0000') ? undefined : text.replace(/\r\n?/g, '\n').split('\n');
  } catch {
    return undefined;
  }
}

const exists = (root: string, file: string) => {
  const abs = inRoot(root, file);
  try {
    return !!abs && fs.statSync(abs).isFile();
  } catch {
    return false;
  }
};

/** Top in-workspace stack frames (`file:line[:col]`, workspace-relative) found in a failure's raw evidence. */
export function frames(evidence: string, root?: string, max = MAX_FRAMES): string[] {
  const out: string[] = [];
  const res = [
    /\bat\s+(?:.*?\()?((?:[A-Za-z]:)?[^\s():]+\.[A-Za-z]+):(\d+):(\d+)\)?/g,
    /File "([^"]+)", line (\d+)/g,
    /-->\s+([^\s:]+\.rs):(\d+):(\d+)/g,
    /^\s+((?:[A-Za-z]:)?[^\s:]+\.go):(\d+)/gm,
  ];
  const found: { at: number; loc: string }[] = [];
  for (const re of res) {
    for (const m of (evidence ?? '').matchAll(re)) {
      const file = relativePath(m[1], root);
      if (/node_modules|site-packages|^internal\/|^node:|^\/usr\/|\.cargo\/registry|\/go\/pkg\//.test(file) || path.isAbsolute(file)) {
        continue;
      }
      if (root && !exists(root, file)) {
        continue;
      }
      found.push({ at: m.index ?? 0, loc: `${file}:${m[2]}${m[3] ? `:${m[3]}` : ''}` });
    }
  }
  for (const f of found.sort((a, b) => a.at - b.at)) {
    if (!out.includes(f.loc)) {
      out.push(f.loc);
    }
    if (out.length >= max) {
      break;
    }
  }
  return out;
}

/** ±EXCERPT_RADIUS lines around each location, merged per file, at most `maxLines` in total. */
export function buildExcerpts(root: string, locs: readonly { file: string; line: number }[], maxLines = EXCERPT_MAX_LINES): Excerpt[] {
  const ranges: { file: string; start: number; end: number; marks: Set<number> }[] = [];
  const cache = new Map<string, string[] | undefined>();
  for (const loc of locs) {
    const file = relativePath(loc.file, root);
    if (!cache.has(file)) {
      cache.set(file, readLines(root, file));
    }
    const ls = cache.get(file);
    if (!ls || !(loc.line >= 1) || loc.line > ls.length) {
      continue;
    }
    const start = Math.max(1, loc.line - EXCERPT_RADIUS);
    const end = Math.min(ls.length, loc.line + EXCERPT_RADIUS);
    const hit = ranges.find((r) => r.file === file && start <= r.end + 1 && end >= r.start - 1);
    if (hit) {
      hit.start = Math.min(hit.start, start);
      hit.end = Math.max(hit.end, end);
      hit.marks.add(loc.line);
    } else {
      ranges.push({ file, start, end, marks: new Set([loc.line]) });
    }
  }
  const out: Excerpt[] = [];
  let left = maxLines;
  for (const r of ranges) {
    if (left <= 0) {
      break;
    }
    let { start, end } = r;
    if (end - start + 1 > left) {
      // Keep the window centred on the first marked line.
      const mark = Math.min(...r.marks);
      start = Math.max(r.start, mark - Math.floor((left - 1) / 2));
      end = Math.min(r.end, start + left - 1);
    }
    const ls = cache.get(r.file)!;
    const width = String(end).length;
    const text = ls
      .slice(start - 1, end)
      .map((l, i) => `${r.marks.has(start + i) ? '>' : ' '}${String(start + i).padStart(width)}| ${l}`)
      .join('\n');
    out.push({ file: r.file, start, end, text });
    left -= end - start + 1;
  }
  return out;
}

const ASSERT_START = /(Expected|Received|AssertionError|^\s*E\s{2,}|expected .+ (?:to|but) |assert(?:ion)? failed|!==|got:|want:|left:|right:)/i;

/** The failing test's assertion block (Expected/Received, pytest `E` lines, mocha `actual !== expected`). */
export function assertionBlock(evidence: string, maxLines = 8): string | undefined {
  const ls = (evidence ?? '').replace(/\r\n?/g, '\n').split('\n');
  const at = ls.findIndex((l) => ASSERT_START.test(l));
  if (at < 0) {
    return undefined;
  }
  const block = ls.slice(at, at + maxLines);
  while (block.length && !block[block.length - 1].trim()) {
    block.pop();
  }
  return block.join('\n').trim() || undefined;
}

const IDENT = /^[A-Za-z_$][\w$]*$/;

/** typescript extra: the declaration of a symbol named in the message, when the excerpt file declares it. */
function declaredType(root: string, f: Failure): string | undefined {
  if (!f.file) {
    return undefined;
  }
  const ls = readLines(root, relativePath(f.file, root));
  if (!ls) {
    return undefined;
  }
  const names = new Set<string>();
  for (const m of f.message.matchAll(/'([^']+)'/g)) {
    const base = m[1].replace(/<.*$/, '').replace(/\[\]$/, '').trim();
    if (IDENT.test(base)) {
      names.add(base);
    }
  }
  if (f.symbol && IDENT.test(f.symbol)) {
    names.add(f.symbol);
  }
  for (const name of names) {
    const re = new RegExp(`^\\s*(?:export\\s+)?(?:default\\s+)?(?:declare\\s+)?(?:async\\s+)?(?:interface|type|function|class|enum|const)\\s+${name.replace(/\$/g, '\\$')}\\b`);
    const at = ls.findIndex((l) => re.test(l));
    if (at < 0) {
      continue;
    }
    const block: string[] = [];
    let depth = 0;
    for (let i = at; i < ls.length && block.length < 8; i++) {
      block.push(`${i + 1}| ${ls[i]}`);
      depth += (ls[i].match(/[{(]/g) ?? []).length - (ls[i].match(/[})]/g) ?? []).length;
      if (depth <= 0 && (i > at || /[;}]\s*$|=>|\)\s*:/.test(ls[i]))) {
        break;
      }
    }
    return `${name} (${relativePath(f.file, root)}):\n${block.join('\n')}`;
  }
  return undefined;
}

const LOCKFILES: Record<string, string[]> = {
  node: ['package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb'],
  python: ['poetry.lock', 'uv.lock', 'Pipfile.lock', 'pdm.lock'],
  go: ['go.sum'],
  rust: ['Cargo.lock'],
  dotnet: ['packages.lock.json'],
  maven: [],
  gradle: ['gradle.lockfile'],
};
const MANIFESTS: Record<string, string[]> = {
  node: ['package.json'],
  python: ['requirements.txt', 'pyproject.toml', 'Pipfile', 'setup.py'],
  go: ['go.mod'],
  rust: ['Cargo.toml'],
  maven: ['pom.xml'],
  gradle: ['build.gradle.kts', 'build.gradle'],
  dotnet: [],
};

const NODE_CODES = /^(MODULE_NOT_FOUND|ERR_MODULE_NOT_FOUND|TS2307|E404|ERESOLVE|ETARGET|ENOVERSIONS)$/;
const PY_CODES = /^(ModuleNotFoundError|ImportError|pip_\w+)$/;

/** The ecosystem a failure belongs to, from its code, then its file extension. */
export function inferEcosystem(f: Pick<Failure, 'code' | 'file' | 'category' | 'message'>): CheckEcosystem | undefined {
  const code = f.code ?? '';
  if (NODE_CODES.test(code)) {
    return 'node';
  }
  if (PY_CODES.test(code)) {
    return 'python';
  }
  if (code === 'missing_module') {
    return 'go';
  }
  if (/^E\d{4}$/.test(code) || code === 'no_matching_package') {
    return 'rust';
  }
  if (/^(NU\d{4}|CS\d{4})$/.test(code)) {
    return 'dotnet';
  }
  const ext = path.extname(f.file ?? '').toLowerCase();
  if (/^\.(ts|tsx|js|jsx|mjs|cjs|mts|cts|vue|svelte)$/.test(ext) || /package\.json$/.test(f.file ?? '')) {
    return 'node';
  }
  if (ext === '.py') {
    return 'python';
  }
  if (ext === '.go') {
    return 'go';
  }
  if (ext === '.rs') {
    return 'rust';
  }
  if (ext === '.cs' || ext === '.csproj') {
    return 'dotnet';
  }
  if (ext === '.java' || ext === '.kt') {
    return code === 'unresolved_dependency' && /gradle/i.test(f.message) ? 'gradle' : 'maven';
  }
  return undefined;
}

/** Nearest folder from the failure's file up to the root that holds one of `names`. */
function nearest(root: string, from: string | undefined, names: readonly string[]): string | undefined {
  let dir = from ? path.dirname(relativePath(from, root)) : '.';
  for (let i = 0; i < 20; i++) {
    for (const n of names) {
      const rel = dir === '.' ? n : `${dir}/${n}`;
      if (exists(root, rel)) {
        return rel;
      }
    }
    if (dir === '.' || !dir) {
      return undefined;
    }
    const up = path.posix.dirname(dir);
    dir = up === dir ? '.' : up;
  }
  return undefined;
}

const normPkg = (s: string) => s.toLowerCase().replace(/[-_.]+/g, '-');

/** Manifest snippet (dependency section), lockfile presence and whether the missing package is declared. */
export function dependencyInfo(root: string, f: Failure, ecosystem = inferEcosystem(f)): DependencyInfo {
  const info: DependencyInfo = { ecosystem, lockfiles: [] };
  if (!ecosystem) {
    return info;
  }
  const extra = ecosystem === 'dotnet' ? csproj(root, f.file) : undefined;
  const manifest = extra ?? nearest(root, f.file, MANIFESTS[ecosystem] ?? []);
  const dir = manifest ? path.posix.dirname(manifest) : '.';
  info.lockfiles = (LOCKFILES[ecosystem] ?? []).filter((l) => exists(root, dir === '.' ? l : `${dir}/${l}`) || exists(root, l));
  if (!manifest) {
    return info;
  }
  info.manifest = manifest;
  const ls = readLines(root, manifest) ?? [];
  const pkg = f.symbol ? pythonDist(f.symbol, ecosystem) : undefined;
  let names: string[] = [];
  if (ecosystem === 'node') {
    try {
      const json = JSON.parse(ls.join('\n')) as Record<string, unknown>;
      const rows: string[] = [];
      for (const section of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
        const deps = json[section];
        if (deps && typeof deps === 'object') {
          const entries = Object.entries(deps as Record<string, unknown>);
          names.push(...entries.map(([k]) => k));
          rows.push(`${section}: ${entries.slice(0, 25).map(([k, v]) => `${k}@${String(v)}`).join(', ')}${entries.length > 25 ? ', …' : ''}`);
        }
      }
      info.snippet = rows.join('\n') || '(no dependencies section)';
    } catch {
      info.snippet = '(package.json is not valid JSON)';
    }
  } else {
    const section = sectionLines(ls, ecosystem, manifest);
    info.snippet = section.slice(0, 25).join('\n') + (section.length > 25 ? '\n…' : '');
    names = section.map((l) => depName(l, ecosystem)).filter((n): n is string => !!n);
  }
  if (f.symbol) {
    const want = [f.symbol, pkg ?? ''].filter(Boolean).map(normPkg);
    info.declared = names.some((n) => {
      const m = normPkg(n);
      return want.includes(m) || (ecosystem === 'go' && want.some((w) => w === m || w.startsWith(`${m}/`)));
    });
  }
  return info;
}

function csproj(root: string, from?: string): string | undefined {
  let dir = from ? path.dirname(relativePath(from, root)) : '.';
  for (let i = 0; i < 20; i++) {
    const abs = inRoot(root, dir) ?? root;
    try {
      const hit = fs.readdirSync(abs).find((n) => /\.(cs|fs|vb)proj$/.test(n));
      if (hit) {
        return dir === '.' ? hit : `${dir}/${hit}`;
      }
    } catch {
      /* unreadable folder */
    }
    if (dir === '.' || !dir) {
      return undefined;
    }
    const up = path.posix.dirname(dir);
    dir = up === dir ? '.' : up;
  }
  return undefined;
}

/** The dependency lines of a non-JSON manifest. */
function sectionLines(ls: readonly string[], ecosystem: string, manifest: string): string[] {
  const base = path.posix.basename(manifest);
  if (base === 'requirements.txt') {
    return ls.filter((l) => l.trim() && !l.trim().startsWith('#'));
  }
  if (/\.(cs|fs|vb)proj$/.test(base)) {
    return ls.filter((l) => /<PackageReference\b/.test(l)).map((l) => l.trim());
  }
  if (base === 'pom.xml') {
    return ls.filter((l) => /<artifactId>/.test(l)).map((l) => l.trim());
  }
  if (base === 'go.mod') {
    const out: string[] = [];
    let block = false;
    for (const l of ls) {
      if (/^require\s*\($/.test(l.trim())) {
        block = true;
      } else if (block && l.trim() === ')') {
        block = false;
      } else if (block || /^require\s+\S/.test(l.trim())) {
        out.push(l.trim().replace(/^require\s+/, ''));
      }
    }
    return out;
  }
  if (/\.gradle(\.kts)?$/.test(base)) {
    return ls.filter((l) => /\b(implementation|api|compileOnly|runtimeOnly|testImplementation)\b/.test(l)).map((l) => l.trim());
  }
  // TOML/INI-like: Cargo.toml [dependencies], pyproject [project] dependencies / [tool.poetry.dependencies], Pipfile [packages].
  const headers = ecosystem === 'rust' ? /^\[(dev-|build-)?dependencies\]/ : /^\[(tool\.poetry\.(dev-)?dependencies|packages|dev-packages|project)\]/;
  const out: string[] = [];
  let on = false;
  let list = false;
  for (const l of ls) {
    const t = l.trim();
    if (/^\[.*\]$/.test(t)) {
      on = headers.test(t);
      list = false;
      continue;
    }
    if (!on || !t || t.startsWith('#')) {
      continue;
    }
    if (base === 'pyproject.toml' && /^dependencies\s*=\s*\[/.test(t)) {
      list = !/\]\s*$/.test(t);
      out.push(...[...t.matchAll(/"([^"]+)"/g)].map((m) => m[1]));
      continue;
    }
    if (list) {
      if (t.startsWith(']')) {
        list = false;
      } else {
        out.push(t.replace(/^["']|["'],?$/g, ''));
      }
      continue;
    }
    if (/^[\w.\-"]+\s*=/.test(t)) {
      out.push(t);
    }
  }
  return base === 'pyproject.toml' ? out.filter((l) => !/^(name|version|description|readme|requires-python|license|authors)\s*=/.test(l)) : out;
}

function depName(line: string, ecosystem: string): string | undefined {
  const t = line.trim();
  if (ecosystem === 'dotnet') {
    return /Include="([^"]+)"/.exec(t)?.[1];
  }
  if (ecosystem === 'maven') {
    return /<artifactId>([^<]+)<\/artifactId>/.exec(t)?.[1];
  }
  if (ecosystem === 'gradle') {
    return /["']([^:"']+):([^:"']+)/.exec(t)?.[2];
  }
  if (ecosystem === 'go') {
    return t.split(/\s+/)[0];
  }
  return /^["']?([A-Za-z0-9][\w.\-]*)/.exec(t)?.[1];
}

/** Related files (repoGraph neighbours) of the group's files, at most MAX_NEIGHBOURS. */
function neighbourList(input: EvidenceInput, files: readonly string[]): string[] {
  const n = input.neighbours;
  if (!n) {
    return [];
  }
  const out: string[] = [];
  const list = typeof n === 'function' ? files.flatMap((f) => {
    try {
      return [...n(f)];
    } catch {
      return [];
    }
  }) : [...n];
  for (const f of list) {
    const rel = relativePath(f, input.root);
    if (!files.includes(rel) && !out.includes(rel)) {
      out.push(rel);
    }
    if (out.length >= MAX_NEIGHBOURS) {
      break;
    }
  }
  return out;
}

/** security extra: finding id, package@version, fixed version. */
function securityDetails(f: Failure): string {
  const text = `${f.message}\n${f.evidence}`;
  const id = f.code ?? /\b(GHSA-[\w-]+|CVE-\d{4}-\d+)\b/.exec(text)?.[1];
  const pkg = /(?:^|\s)((?:@[\w.-]+\/)?[\w.-]+)@(\d[\w.+-]*)/.exec(text);
  const fixed = /(?:fixed in|fix(?:ed)? version|patched in|upgrade to)\s*:?\s*(?:[\w@/.-]+@)?(\d[\w.+-]*)/i.exec(text)?.[1];
  return [id && `Finding: ${id}`, pkg && `Package: ${pkg[1]}@${pkg[2]}`, fixed && `Fixed version: ${fixed}`, f.file && `Location: ${loc(f)}`].filter(Boolean).join('\n') || f.message;
}

const loc = (f: Pick<Failure, 'file' | 'line' | 'test'>, root?: string) =>
  f.file ? `${relativePath(f.file, root)}${f.line ? `:${f.line}` : ''}` : f.test;

const quoteOf = (s: string) => s.replace(/^['"`]|['"`]$/g, '');

/** Deterministic root-cause hypothesis from message templates. */
export function hypothesis(f: Failure, root?: string): string {
  const at = loc(f, root);
  const where = at ? ` at ${at}` : '';
  const msg = f.message.trim();
  const code = f.code ?? '';
  let m: RegExpExecArray | null;
  if (code === 'TS2345' && (m = /Argument of type '(.+?)' is not assignable to parameter of type '(.+?)'/.exec(msg))) {
    return `Argument of type ${m[1]} is not assignable to parameter of type ${m[2]}${where}`;
  }
  if ((code === 'TS2322' || code === 'TS2741') && (m = /Type '(.+?)' is not assignable to type '(.+?)'/.exec(msg))) {
    return `A value of type ${m[1]} is used where ${m[2]} is expected${where}`;
  }
  if ((code === 'TS2339' || code === 'TS2551') && (m = /Property '(.+?)' does not exist on type '(.+?)'/.exec(msg))) {
    return `Property ${m[1]} does not exist on type ${m[2]}${where}`;
  }
  if ((code === 'TS2304' || code === 'TS2552') && (m = /Cannot find name '(.+?)'/.exec(msg))) {
    return `${m[1]} is used but not declared or imported${where}`;
  }
  if (code === 'TS2554' && (m = /Expected (\d+(?:-\d+)?) arguments?, but got (\d+)/.exec(msg))) {
    return `A call passes ${m[2]} argument(s) where ${m[1]} are expected${where}`;
  }
  if (code === 'TS2305' && (m = /Module '(.+?)' has no exported member '(.+?)'/.exec(msg))) {
    return `${m[1]} does not export ${m[2]}${where}`;
  }
  if (f.category === 'dependency' || /^(TS2307|MODULE_NOT_FOUND|ERR_MODULE_NOT_FOUND|ModuleNotFoundError|missing_module)$/.test(code)) {
    const name = f.symbol ?? /(?:module|package|crate) ['"]?([^'"\s]+)['"]?/i.exec(msg)?.[1];
    return `Module '${name ? quoteOf(name) : 'unknown'}' is not installed or not declared${where}`;
  }
  if (f.category === 'unit_test' || f.category === 'integration_test') {
    const name = f.test ?? 'The test';
    const block = `${f.evidence}\n${msg}`;
    const exp = /Expected(?: value)?:\s*(.+)/.exec(block)?.[1]?.trim();
    const rec = /Received(?: value)?:\s*(.+)/.exec(block)?.[1]?.trim();
    if (exp && rec) {
      return `${name} expects ${exp} but gets ${rec}`;
    }
    const py = /^\s*E\s+assert (.+?) == (.+)$/m.exec(block) ?? /AssertionError: assert (.+?) == (.+)$/m.exec(block);
    if (py) {
      return `${name} expects ${py[2].trim()} but gets ${py[1].trim()}`;
    }
    const strict = /^\s*(.+?) !== (.+)$/m.exec(block);
    if (strict && /strictly equal|AssertionError/.test(block)) {
      return `${name} expects ${strict[2].trim()} but gets ${strict[1].trim()}`;
    }
    const goFail = /--- FAIL: (\S+)/.exec(block);
    if (goFail) {
      const first = block.split('\n').map((l) => l.trim()).find((l) => l && !l.startsWith('--- FAIL') && !/^=== RUN/.test(l));
      return `${goFail[1]} fails: ${first ?? msg}`;
    }
    return `${name} fails: ${msg}${where}`;
  }
  if (f.category === 'runtime') {
    const top = frames(f.evidence, root)[0];
    return `${msg} is thrown${top ? ` at ${top}` : where}`;
  }
  if (f.category === 'lint') {
    return `Lint rule ${code || 'violation'}${where}: ${msg}`;
  }
  if (f.category === 'security') {
    return `Security finding ${code}${where}: ${msg}`;
  }
  return `${code || f.category}${where}: ${msg}`;
}

const isSuggestion = (m: MemoryEntry | MemorySuggestion): m is MemorySuggestion => !!(m as MemorySuggestion).entry;

/** Lines that close or open a fence are dropped, so suggestion text can never escape its fenced block. */
const unfence = (s: string) =>
  s
    .split(/\r?\n/)
    .filter((l) => !/^\s*(?:```|~~~)/.test(l))
    .map((l) => l.replace(/`{3,}|~{3,}/g, ''))
    .join('\n');

/** Clamp to `max` chars on a line boundary, marking the cut. */
function clampText(s: string, max: number): string {
  if (s.length <= max) {
    return s;
  }
  if (max <= 1) {
    return '';
  }
  const cut = s.slice(0, max - 2);
  const nl = cut.lastIndexOf('\n');
  return `${nl > max / 3 ? cut.slice(0, nl) : cut}\n…`;
}

/** One-line clip for failure messages and the hypothesis (long type errors run to several KB). */
function clipLine(s: string, max = MAX_MESSAGE_CHARS): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function clampLines(s: string, max: number): string {
  const ls = s.split('\n');
  return ls.length <= max ? s : `${ls.slice(0, max).join('\n')}\n… (${ls.length - max} more lines)`;
}

/** Evidence for the first root-cause group: excerpts, extras, diff, memory, previous attempts; capped. */
export function buildEvidence(input: EvidenceInput): Evidence {
  if (!input.group.length) {
    throw new Error('buildEvidence: empty failure group');
  }
  const root = input.root;
  const failures = input.group.slice(0, MAX_GROUP_FAILURES);
  const primary = failures[0];
  const charCap = evidenceCharCap(input.contextWindow);
  const frameList = [...new Set(failures.flatMap((f) => frames(f.evidence, root)))].slice(0, MAX_FRAMES);
  const locs: { file: string; line: number }[] = [];
  for (const f of failures) {
    if (f.file && f.line) {
      locs.push({ file: f.file, line: f.line });
    }
  }
  if (TEST_LIKE.includes(primary.category) || !locs.length) {
    for (const fr of frameList) {
      const m = /^(.+?):(\d+)(?::\d+)?$/.exec(fr);
      if (m) {
        locs.push({ file: m[1], line: Number(m[2]) });
      }
    }
  }
  const excerpts = buildExcerpts(root, locs);
  const files = [...new Set(failures.map((f) => f.file && relativePath(f.file, root)).filter((f): f is string => !!f))];
  const extras: Evidence['extras'] = [];
  let dependency: DependencyInfo | undefined;
  switch (primary.category) {
    case 'typescript': {
      const decl = failures.map((f) => declaredType(root, f)).find(Boolean);
      if (decl) {
        extras.push({ label: 'Declared type', text: decl });
      }
      break;
    }
    case 'integration_test': {
      const related = neighbourList(input, files.length ? files : frameList.map((f) => f.replace(/:\d+(?::\d+)?$/, '')));
      if (related.length) {
        extras.push({ label: 'Related files (imports/importers)', text: related.join('\n') });
      }
      break;
    }
    case 'dependency': {
      dependency = dependencyInfo(root, primary);
      if (dependency.manifest) {
        extras.push({ label: `Manifest ${dependency.manifest}`, text: dependency.snippet ?? '' });
      }
      extras.push({
        label: 'Lockfile',
        text: dependency.lockfiles.length ? dependency.lockfiles.join(', ') : 'none',
      });
      if (primary.symbol && dependency.declared !== undefined) {
        extras.push({ label: 'Declared in manifest', text: `${primary.symbol}: ${dependency.declared ? 'yes' : 'no'}` });
      }
      break;
    }
    case 'runtime':
      if (frameList.length) {
        extras.push({ label: 'Stack (workspace frames)', text: frameList.join('\n') });
      }
      break;
    case 'database': {
      const touched = [...(input.changedFiles ?? []), ...diffFiles(input.patchDiff ?? '')]
        .map((f) => relativePath(f, root))
        .filter((f, i, a) => a.indexOf(f) === i && /migrat|alembic|(^|\/)schema\.(sql|prisma)$|\.sql$/i.test(f));
      if (touched.length) {
        extras.push({ label: 'Migrations touched this turn', text: touched.slice(0, 10).join('\n') });
      }
      break;
    }
    case 'security':
      extras.push({ label: 'Finding', text: securityDetails(primary) });
      break;
    default:
      break;
  }
  const memory: MemoryNote[] = (input.memory ?? []).slice(0, MAX_MEMORY).map((m) => {
    const e = isSuggestion(m) ? m.entry : m;
    return {
      rootCause: unfence(e.rootCause).replace(/\s+/g, ' ').trim(),
      strategy: unfence(e.strategy).replace(/\s+/g, ' ').trim(),
      patchSummary: unfence(e.patchSummary).trim(),
      codeChanged: isSuggestion(m) ? m.codeChanged : false,
    };
  });
  const previous = (input.previousAttempts ?? [])
    .map((a) => [a.n ? `#${a.n}` : '', a.rootCause ?? a.strategy ?? '', a.summary ? `(${a.summary})` : '', a.result ? `-> ${a.result}` : '']
      .filter(Boolean).join(' ').replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .slice(-3);
  const ev: Evidence = {
    primary,
    failures,
    category: primary.category,
    code: primary.code,
    signature: primary.signature,
    where: loc(primary, root),
    hypothesis: clipLine(hypothesis(primary, root)),
    excerpts,
    assertion: TEST_LIKE.includes(primary.category) ? failures.map((f) => assertionBlock(f.evidence)).find(Boolean) : undefined,
    frames: frameList,
    extras,
    diff: input.patchDiff?.trim() ? clampLines(input.patchDiff.trim(), MAX_DIFF_LINES) : undefined,
    memory,
    previous,
    dependency,
    charCap,
  };
  return fitEvidence(ev);
}

/** Files named by unified-diff headers. */
function diffFiles(diff: string): string[] {
  return [...diff.matchAll(/^(?:\+\+\+|---) (?:[ab]\/)?(\S+)/gm)].map((m) => m[1]).filter((f) => f !== '/dev/null');
}

/**
 * Shrink the evidence to its char cap: the lowest-value parts go first (memory patches, previous attempts, extras,
 * the diff), then the excerpts are cut down, then the `Also:` failures, and last the first excerpt itself.
 */
function fitEvidence(ev: Evidence): Evidence {
  const size = () => renderEvidence(ev).length;
  if (size() <= ev.charCap) {
    return ev;
  }
  const shrink = (get: () => string | undefined, set: (s: string | undefined) => void) => {
    let cur = get();
    while (cur && size() > ev.charCap) {
      const next = cur.length > 200 ? clampText(cur, Math.floor(cur.length * 0.6)) : undefined;
      set(next);
      cur = next;
    }
  };
  for (const m of ev.memory) {
    shrink(() => m.patchSummary || undefined, (s) => (m.patchSummary = s ?? ''));
  }
  while (ev.previous.length > 1 && size() > ev.charCap) {
    ev.previous.shift();
  }
  for (let i = ev.extras.length - 1; i >= 0 && size() > ev.charCap; i--) {
    const x = ev.extras[i];
    shrink(() => x.text, (s) => (x.text = s ?? ''));
    if (!x.text) {
      ev.extras.splice(i, 1);
    }
  }
  shrink(() => ev.diff, (s) => (ev.diff = s));
  while (ev.memory.length && size() > ev.charCap) {
    ev.memory.pop();
  }
  for (let i = ev.excerpts.length - 1; i > 0 && size() > ev.charCap; i--) {
    ev.excerpts.pop();
  }
  shrink(() => ev.assertion, (s) => (ev.assertion = s));
  while (ev.failures.length > 1 && size() > ev.charCap) {
    ev.failures.pop();
  }
  const first = ev.excerpts[0];
  if (first && size() > ev.charCap) {
    const over = size() - ev.charCap;
    first.text = clampText(first.text, Math.max(0, first.text.length - over - 4));
    if (!first.text) {
      ev.excerpts.length = 0;
    }
  }
  return ev;
}

/** A fence longer than any backtick run inside `body`. */
function fence(body: string): string {
  const longest = Math.max(2, ...[...body.matchAll(/`+/g)].map((m) => m[0].length));
  return '`'.repeat(longest + 1);
}

const fenced = (body: string, info = '') => {
  const f = fence(body);
  return `${f}${info}\n${body}\n${f}`;
};

/** The evidence body shared by the fix prompt and the fixer brief (the part the char cap applies to). */
export function renderEvidence(ev: Evidence): string {
  const out: string[] = [];
  out.push(`Problem: ${clipLine(ev.primary.message)}`);
  out.push(`Where: ${ev.where ?? 'unknown location'}${ev.excerpts.length ? '  (code below)' : ''}`);
  out.push(`Likely cause: ${ev.hypothesis}`);
  for (const f of ev.failures.slice(1)) {
    out.push(`Also: ${f.code ? `${f.code} ` : ''}${loc(f) ?? ''}: ${clipLine(f.message)}`.replace(/\s+:/, ':'));
  }
  for (const x of ev.excerpts) {
    out.push(`${x.file}:${x.start}-${x.end}`);
    out.push(fenced(x.text));
  }
  if (ev.assertion) {
    out.push('Assertion:');
    out.push(fenced(ev.assertion));
  }
  if (ev.frames.length && ev.category !== 'runtime') {
    out.push(`Stack: ${ev.frames.join(' <- ')}`);
  }
  for (const x of ev.extras) {
    out.push(`${x.label}:`);
    out.push(x.text.includes('\n') ? fenced(x.text) : x.text);
  }
  if (ev.diff) {
    out.push('Your change this turn in that file:');
    out.push(fenced(ev.diff, 'diff'));
  }
  if (ev.memory.length) {
    out.push('Earlier fix for a similar error (an unverified suggestion from memory; it may not apply, check it against the code first):');
    const body = ev.memory
      .map((m, i) => [
        `Suggestion ${i + 1}${m.codeChanged ? ' (the code has changed since)' : ''}`,
        m.rootCause && `Root cause: ${m.rootCause}`,
        m.strategy && `Strategy: ${m.strategy}`,
        m.patchSummary,
      ].filter(Boolean).join('\n'))
      .join('\n\n');
    out.push(fenced(body, 'unverified-suggestion'));
  }
  if (ev.previous.length) {
    out.push('Previous attempts that did not work:');
    out.push(...ev.previous.map((p) => `- ${p}`));
  }
  return out.join('\n');
}

// ---- Prompts ----

export interface FixPromptOptions {
  attempt: number;
  max: number;
  category: FailureCategory;
  code?: string;
  /** 'the previous fix did not change this error'. */
  duplicateNote?: string;
  /** 'the previous attempt made it worse (new: …); it was reverted'. */
  worseNote?: string;
}

export interface FixPromptMessage {
  content: string;
  meta: { hidden: true; healing: { attempt: number; category: FailureCategory; signature: string } };
}

/** The hidden user message of an inline fix attempt (§5.2). No `nudge` meta: chat.js would retract the reply. */
export function fixPrompt(ev: Evidence, opts: FixPromptOptions): FixPromptMessage {
  const head = `[LocalPilot self-healing · attempt ${opts.attempt}/${opts.max} · ${opts.category}${opts.code ? ` ${opts.code}` : ''}]`;
  const lines = [head, 'Checks ran by LocalPilot failed. Fix ONLY this problem, with the smallest change.'];
  if (opts.duplicateNote) {
    lines.push(`Note: ${opts.duplicateNote.trim()}`);
  }
  if (opts.worseNote) {
    lines.push(`Note: ${opts.worseNote.trim()}`);
  }
  lines.push(renderEvidence(ev));
  lines.push(
    'Steps:',
    '1. First line of your reply: "Root cause: <one sentence>".',
    '2. Edit the code (edit_file/apply_patch).',
    '3. Do not run the checks yourself; LocalPilot reruns them after your reply.',
    '4. If it cannot be fixed without the user (credentials, product decision), reply "Blocked: <reason>".',
    TEST_RULE,
  );
  return {
    content: lines.join('\n'),
    meta: { hidden: true, healing: { attempt: opts.attempt, category: opts.category, signature: ev.signature } },
  };
}

/** Task text for a `fixer` subagent (delegated mode, §5.3): the same evidence and a tight report contract. */
export function fixBrief(ev: Evidence): string {
  return [
    `Fix exactly this ${ev.category}${ev.code ? ` ${ev.code}` : ''} failure with the smallest change. Do not touch unrelated code.`,
    renderEvidence(ev),
    'Rules:',
    `- ${TEST_RULE}`,
    '- Do not install packages or run destructive commands.',
    '- If it cannot be fixed without the user (credentials, product decision), report "Blocked: <reason>".',
    'Report, one per line:',
    'Root cause: <one sentence>',
    'Files: <comma-separated paths you changed>',
    'Done: yes | no',
  ].join('\n');
}

export interface ParsedReply {
  rootCause?: string;
  blocked?: string;
  files?: string[];
  done?: boolean;
}

const PREFIX = String.raw`^[ \t]*(?:[-*>#]+[ \t]*)?(?:\*\*|__)?`;
const lineValue = (text: string, label: string) => {
  const m = new RegExp(`${PREFIX}${label}(?:\\*\\*|__)?[ \\t]*[:\\-–][ \\t]*(?:\\*\\*|__)?[ \\t]*(.+)$`, 'im').exec(text);
  const v = m?.[1].replace(/(\*\*|__)$/g, '').replace(/^["'`]|["'`]$/g, '').replace(/\s+/g, ' ').trim();
  return v ? (v.length > 300 ? `${v.slice(0, 299)}…` : v) : undefined;
};

/** Template filler a small model writes instead of leaving the line out. */
const PLACEHOLDER = /^(none|no|n\/?a|nothing|false|-)\.?$/i;

/** `Root cause:` / `Blocked:` (and the fixer's `Files:` / `Done:`) lines of a model reply. */
export function parseReply(text: string): ParsedReply {
  const t = String(text ?? '').replace(/\r\n?/g, '\n');
  const out: ParsedReply = {};
  const rc = lineValue(t, 'root[ \\t]*cause');
  if (rc && !PLACEHOLDER.test(rc)) {
    out.rootCause = rc;
  }
  const blocked = lineValue(t, 'blocked');
  if (blocked && !PLACEHOLDER.test(blocked)) {
    out.blocked = blocked;
  }
  const files = lineValue(t, 'files(?:[ \\t]+changed)?');
  if (files && !/^(none|n\/a|-)$/i.test(files)) {
    out.files = files.split(/[,\s]+/).map((f) => f.replace(/^`|`$/g, '')).filter(Boolean);
  }
  const done = lineValue(t, 'done');
  if (done) {
    out.done = /^(yes|true|y)\b/i.test(done);
  }
  return out;
}

// ---- Dependency resolver ----

export type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun';

export interface ResolverTemplate {
  id: string;
  ecosystem: CheckEcosystem;
  pm?: PackageManager;
  /** add = install a missing package by name; manifest = install what the manifest already declares. */
  kind: 'add' | 'manifest';
  /** `{pkg}` = validated package name; `{file}` = workspace-relative requirements file. */
  template: string;
}

/** The only commands the engine ever proposes to install dependencies; each runs with `requires_approval: true`. */
export const RESOLVER_TEMPLATES: readonly ResolverTemplate[] = Object.freeze([
  { id: 'npm:add', ecosystem: 'node', pm: 'npm', kind: 'add', template: 'npm install {pkg}' },
  { id: 'pnpm:add', ecosystem: 'node', pm: 'pnpm', kind: 'add', template: 'pnpm add {pkg}' },
  { id: 'yarn:add', ecosystem: 'node', pm: 'yarn', kind: 'add', template: 'yarn add {pkg}' },
  { id: 'bun:add', ecosystem: 'node', pm: 'bun', kind: 'add', template: 'bun add {pkg}' },
  { id: 'npm:ci', ecosystem: 'node', pm: 'npm', kind: 'manifest', template: 'npm ci' },
  { id: 'npm:install', ecosystem: 'node', pm: 'npm', kind: 'manifest', template: 'npm install' },
  { id: 'pnpm:install', ecosystem: 'node', pm: 'pnpm', kind: 'manifest', template: 'pnpm install' },
  { id: 'yarn:install', ecosystem: 'node', pm: 'yarn', kind: 'manifest', template: 'yarn install' },
  { id: 'bun:install', ecosystem: 'node', pm: 'bun', kind: 'manifest', template: 'bun install' },
  { id: 'pip:add', ecosystem: 'python', kind: 'add', template: 'pip install {pkg}' },
  { id: 'pip:requirements', ecosystem: 'python', kind: 'manifest', template: 'pip install -r {file}' },
  { id: 'cargo:add', ecosystem: 'rust', kind: 'add', template: 'cargo add {pkg}' },
  { id: 'cargo:fetch', ecosystem: 'rust', kind: 'manifest', template: 'cargo fetch' },
  { id: 'go:get', ecosystem: 'go', kind: 'add', template: 'go get {pkg}' },
  { id: 'go:download', ecosystem: 'go', kind: 'manifest', template: 'go mod download' },
  { id: 'dotnet:add', ecosystem: 'dotnet', kind: 'add', template: 'dotnet add package {pkg}' },
  { id: 'dotnet:restore', ecosystem: 'dotnet', kind: 'manifest', template: 'dotnet restore' },
] as ResolverTemplate[]);

/** Python import name -> distribution name, where they differ. */
export const PYTHON_DISTRIBUTIONS: Readonly<Record<string, string>> = Object.freeze({
  yaml: 'PyYAML',
  cv2: 'opencv-python',
  PIL: 'Pillow',
  sklearn: 'scikit-learn',
  skimage: 'scikit-image',
  bs4: 'beautifulsoup4',
  dateutil: 'python-dateutil',
  dotenv: 'python-dotenv',
  jwt: 'PyJWT',
  jose: 'python-jose',
  Crypto: 'pycryptodome',
  OpenSSL: 'pyOpenSSL',
  MySQLdb: 'mysqlclient',
  psycopg2: 'psycopg2-binary',
  attr: 'attrs',
  serial: 'pyserial',
  usb: 'pyusb',
  magic: 'python-magic',
  docx: 'python-docx',
  pptx: 'python-pptx',
  fitz: 'PyMuPDF',
  git: 'GitPython',
  zmq: 'pyzmq',
  Levenshtein: 'python-Levenshtein',
  multipart: 'python-multipart',
  telegram: 'python-telegram-bot',
  websocket: 'websocket-client',
  win32api: 'pywin32',
  win32con: 'pywin32',
  gi: 'PyGObject',
  google: 'protobuf',
  slugify: 'python-slugify',
  markdown: 'Markdown',
  Bio: 'biopython',
  sentry_sdk: 'sentry-sdk',
});

const PACKAGE_NAME = /^[@a-z0-9][\w.\-/@]*$/i;

/** A package name taken from an error message that is safe to put on a command line. */
export function isValidPackageName(name: string | undefined): name is string {
  return !!name && name.length <= 214 && PACKAGE_NAME.test(name) && !name.includes('..') && !name.endsWith('/') && !/\/\//.test(name);
}

function pythonDist(symbol: string, ecosystem?: CheckEcosystem): string {
  return ecosystem === 'python' ? PYTHON_DISTRIBUTIONS[symbol.split('.')[0]] ?? symbol.split('.')[0] : symbol;
}

export interface ResolverCommand {
  command: string;
  requires_approval: true;
  template: string;
  kind: 'add' | 'manifest';
  /** The validated package (add only). */
  pkg?: string;
  /** Workspace-relative folder to run in (the manifest's), when not the root. */
  cwd?: string;
}

export interface ResolverOptions {
  /** The package is declared in the manifest: install from the manifest instead of adding it. */
  declared?: boolean;
  /** Workspace-relative manifest; its folder becomes the command's cwd (requirements file for pip). */
  manifest?: string;
  /** A lockfile exists (npm: `npm ci` instead of `npm install`). */
  lockfile?: boolean;
}

/**
 * Per-ecosystem name shape: node allows `name` or `@scope/name` only (`user/repo` is GitHub shorthand to npm/yarn/
 * pnpm/bun), go keeps module paths, the rest forbid `/` and `@` (`a/b` is a local path to pip).
 */
export function isValidPackageFor(ecosystem: CheckEcosystem, name: string | undefined): name is string {
  if (!isValidPackageName(name)) {
    return false;
  }
  switch (ecosystem) {
    case 'node':
      return /^(?:@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/i.test(name);
    case 'go':
      return true;
    default:
      return !/[/@]/.test(name);
  }
}

/** Expand one template; `undefined` when the package name or file is not safe. */
export function expandTemplate(t: ResolverTemplate, vars: { pkg?: string; file?: string }): string | undefined {
  if (t.template.includes('{pkg}') && !isValidPackageFor(t.ecosystem, vars.pkg)) {
    return undefined;
  }
  if (t.template.includes('{file}') && !(vars.file && /^[\w.\-/]+$/.test(vars.file) && !vars.file.includes('..') && !vars.file.startsWith('/'))) {
    return undefined;
  }
  return t.template.replace('{pkg}', vars.pkg ?? '').replace('{file}', vars.file ?? '');
}

/**
 * Deterministic install commands for a dependency failure: declared-but-missing -> install from the manifest;
 * undeclared -> add the package named in the error. Always `requires_approval: true`; empty when nothing safe applies.
 */
export function resolverCommands(failure: Failure, ecosystem: CheckEcosystem | undefined, pm: PackageManager = 'npm', opts: ResolverOptions = {}): ResolverCommand[] {
  const eco = ecosystem ?? inferEcosystem(failure);
  if (!eco || failure.category !== 'dependency') {
    return [];
  }
  const templates = RESOLVER_TEMPLATES.filter((t) => t.ecosystem === eco && (eco !== 'node' || t.pm === pm));
  const dir = opts.manifest ? path.posix.dirname(opts.manifest.replace(/\\/g, '/')) : '.';
  const cwd = dir && dir !== '.' && !dir.includes('..') ? dir : undefined;
  const make = (t: ResolverTemplate, vars: { pkg?: string; file?: string }): ResolverCommand[] => {
    const command = expandTemplate(t, vars);
    return command ? [{ command, requires_approval: true, template: t.id, kind: t.kind, pkg: t.kind === 'add' ? vars.pkg : undefined, cwd }] : [];
  };
  if (opts.declared) {
    let manifestTemplates = templates.filter((t) => t.kind === 'manifest');
    if (eco === 'node' && pm === 'npm') {
      manifestTemplates = manifestTemplates.filter((t) => t.id === (opts.lockfile ? 'npm:ci' : 'npm:install'));
    }
    if (eco === 'python') {
      const base = opts.manifest ? path.posix.basename(opts.manifest.replace(/\\/g, '/')) : '';
      return /^requirements.*\.txt$/.test(base) ? make(manifestTemplates[0], { file: base }) : [];
    }
    return manifestTemplates.length ? make(manifestTemplates[0], {}) : [];
  }
  const add = templates.find((t) => t.kind === 'add');
  const symbol = failure.symbol?.trim();
  if (!add || !symbol) {
    return [];
  }
  const pkg = eco === 'python' ? pythonDist(symbol, eco) : symbol;
  return make(add, { pkg });
}
