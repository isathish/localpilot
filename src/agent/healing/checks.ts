import * as fs from 'fs';
import * as path from 'path';
import { sanitizeHealingChecks } from '../../healingSettings';
import { parseJsonc } from '../jsonc';
import { globToRegExp } from '../permissions';
import type { CheckEcosystem, CheckKind, CheckOverride, ChecksFile, CheckSpec } from './types';

/** Project check discovery (design §2.2): static reads only, nothing is executed. */

export const CHECKS_FILE = '.localpilot/checks.json';

export const CHECKS_TEMPLATE = `${JSON.stringify(
  {
    checks: [
      { id: 'custom:e2e', kind: 'test', command: 'npm run test:e2e', required: false, timeoutSeconds: 900, when: ['src/api/**'] },
      { id: 'npm:test', kind: 'test', command: 'npm run test:unit', scoped: 'npx mocha {tests}' },
    ],
    disable: ['npm:lint'],
    timeBudgetSeconds: 1200,
  },
  null,
  2,
)}\n`;

export const DEFAULT_TIMEOUTS: Record<CheckKind, number> = { build: 300, typecheck: 300, lint: 180, test: 600, security: 120, custom: 300 };
const DEFAULT_REQUIRED: Record<CheckKind, boolean> = { build: true, typecheck: true, lint: false, test: true, security: true, custom: false };
const KINDS: readonly CheckKind[] = ['build', 'typecheck', 'lint', 'test', 'custom'];

/** Discovery result; `timeBudgetSeconds` comes from a trusted `.localpilot/checks.json`. */
export type DiscoveredChecks = CheckSpec[] & { timeBudgetSeconds?: number };

export interface DiscoverOptions {
  /** Workspace-relative or absolute; their nearest manifest folders are discovered too (monorepos). */
  changedFiles?: string[];
  /**
   * `localpilot.healing.checks`, always applied. The caller passes only the User value when the workspace is untrusted
   * (VS Code: `inspect('healing.checks').globalValue`; the CLI shim already drops untrusted workspace values).
   */
  settingChecks?: unknown[];
  /** Workspace trust: when false, `.localpilot/checks.json` is ignored. */
  trusted: boolean;
  /** Add the built-in in-process `security` check. */
  security?: boolean;
}

/** Files whose presence marks a project folder. */
const MANIFESTS = ['package.json', 'pyproject.toml', 'setup.cfg', 'setup.py', 'pytest.ini', 'tox.ini', 'go.mod', 'Cargo.toml', 'pom.xml', 'build.gradle', 'build.gradle.kts', 'Makefile', 'makefile', 'GNUmakefile'];
const MANIFEST_RE = /^(requirements.*\.txt|.*\.(sln|csproj|fsproj|vbproj))$/;
/** Files whose mtime invalidates a folder's cached discovery. */
const WATCHED = [
  ...MANIFESTS, 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb', 'package-lock.json', 'tsconfig.json', 'node_modules/.bin/tsc',
  'mypy.ini', 'pyrightconfig.json', 'ruff.toml', '.ruff.toml', '.flake8', 'conftest.py', 'tests', 'test',
  'rust-toolchain', 'rust-toolchain.toml', 'mvnw', 'gradlew', 'settings.gradle', 'settings.gradle.kts',
];

const slash = (p: string) => p.replace(/\\/g, '/');

function read(file: string): string | undefined {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
}

function stat(file: string): fs.Stats | undefined {
  try {
    return fs.statSync(file);
  } catch {
    return undefined;
  }
}

function list(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

const isManifestDir = (abs: string) => MANIFESTS.some((m) => stat(path.join(abs, m))?.isFile()) || list(abs).some((f) => MANIFEST_RE.test(f));

function spec(kind: CheckKind, id: string, command: string, ecosystem: CheckEcosystem, cwd: string, scoped?: string): CheckSpec {
  return {
    id: cwd ? `${id}@${cwd}` : id,
    kind,
    command,
    ...(cwd ? { cwd } : {}),
    ...(scoped ? { scoped } : {}),
    timeoutSeconds: DEFAULT_TIMEOUTS[kind],
    required: DEFAULT_REQUIRED[kind],
    source: 'discovered',
    ecosystem,
  };
}

type PM = 'npm' | 'pnpm' | 'yarn' | 'bun';

/** Package manager from the nearest lockfile between `dir` and the root. */
function packageManager(root: string, dir: string): PM {
  let d = dir;
  for (;;) {
    const abs = path.join(root, d);
    if (stat(path.join(abs, 'pnpm-lock.yaml'))) {
      return 'pnpm';
    }
    if (stat(path.join(abs, 'yarn.lock'))) {
      return 'yarn';
    }
    if (stat(path.join(abs, 'bun.lock')) || stat(path.join(abs, 'bun.lockb'))) {
      return 'bun';
    }
    if (stat(path.join(abs, 'package-lock.json')) || !d) {
      return 'npm';
    }
    d = d.includes('/') ? d.slice(0, d.lastIndexOf('/')) : '';
  }
}

/** A local binary through the package manager, never a download. */
const pmExec = (pm: PM, bin: string) => (pm === 'npm' ? `npm exec --no -- ${bin}` : pm === 'yarn' ? `yarn ${bin}` : pm === 'bun' ? `bun run ${bin}` : `pnpm exec ${bin}`);
/** `bun test` is Bun's own runner and ignores `scripts.test`, so bun always goes through `run`. */
const pmRun = (pm: PM, script: string) => (script === 'test' && pm !== 'bun' ? `${pm} test` : `${pm} run ${script}`);

const PLACEHOLDER_TEST = /no test specified/;

function nodeChecks(root: string, dir: string): CheckSpec[] {
  const abs = path.join(root, dir);
  let pkg: { scripts?: Record<string, unknown> };
  try {
    pkg = JSON.parse(read(path.join(abs, 'package.json')) ?? '');
  } catch {
    return [];
  }
  const scripts: Record<string, string> = {};
  for (const [k, v] of Object.entries(pkg.scripts ?? {})) {
    if (typeof v === 'string' && v.trim()) {
      scripts[k] = v;
    }
  }
  const pm = packageManager(root, dir);
  const out: CheckSpec[] = [];
  const build = ['build', 'compile'].find((s) => scripts[s]);
  if (build) {
    out.push(spec('build', 'npm:build', pmRun(pm, build), 'node', dir));
  }
  const tc = ['typecheck', 'type-check', 'check-types', 'tsc'].find((s) => scripts[s]);
  if (tc) {
    out.push(spec('typecheck', 'npm:typecheck', pmRun(pm, tc), 'node', dir));
  } else if (stat(path.join(abs, 'tsconfig.json'))?.isFile()) {
    // Nearest node_modules/.bin/tsc (hoisted in workspaces); never npx, which may download.
    let up = '';
    for (let d = dir; ; d = d.includes('/') ? d.slice(0, d.lastIndexOf('/')) : '') {
      if (stat(path.join(root, d, 'node_modules', '.bin', 'tsc'))) {
        out.push(spec('typecheck', 'npm:typecheck', `${up}node_modules/.bin/tsc --noEmit -p tsconfig.json`, 'node', dir));
        break;
      }
      if (!d) {
        break;
      }
      up += '../';
    }
  }
  if (scripts.lint) {
    out.push(spec('lint', 'npm:lint', pmRun(pm, 'lint'), 'node', dir));
  }
  const test = scripts.test;
  if (test && !PLACEHOLDER_TEST.test(test)) {
    const config = /(?:^|\s)(--config|-c)[ =](\S+)/.exec(test);
    const cfg = config && /\b(jest|vitest)\b/.test(test) ? ` --config ${config[2]}` : '';
    let scoped: string | undefined;
    if (/\bjest\b/.test(test)) {
      scoped = `${pmExec(pm, 'jest')}${cfg} --findRelatedTests {files}`;
    } else if (/\bvitest\b/.test(test)) {
      scoped = `${pmExec(pm, 'vitest')} related --run${cfg} {files}`;
    } else if (/\bmocha\b/.test(test)) {
      scoped = `${pmExec(pm, 'mocha')} {tests}`;
    } else if (/\bnode\b[^&|;]*--test\b/.test(test)) {
      scoped = 'node --test {tests}';
    }
    out.push(spec('test', 'npm:test', pmRun(pm, 'test'), 'node', dir, scoped));
  }
  return out;
}

const iniHas = (text: string | undefined, header: RegExp) => !!text && text.split(/\r?\n/).some((l) => header.test(l.trim()));

function pythonChecks(root: string, dir: string): CheckSpec[] {
  const abs = path.join(root, dir);
  const names = list(abs);
  const has = (f: string) => names.includes(f);
  if (!['pyproject.toml', 'setup.cfg', 'setup.py', 'pytest.ini', 'tox.ini'].some(has) && !names.some((f) => /^requirements.*\.txt$/.test(f))) {
    return [];
  }
  const pyproject = read(path.join(abs, 'pyproject.toml'));
  const setupCfg = read(path.join(abs, 'setup.cfg'));
  const out: CheckSpec[] = [
    spec('build', 'python:compile', "python -m compileall -q -x '(^|[/\\\\])(\\.venv|venv|\\.git|node_modules|build|dist)([/\\\\]|$)' .", 'python', dir, 'python -m compileall -q {files}'),
  ];
  if (iniHas(pyproject, /^\[tool\.mypy/) || has('mypy.ini') || has('.mypy.ini') || iniHas(setupCfg, /^\[mypy/)) {
    out.push(spec('typecheck', 'mypy', 'python -m mypy .', 'python', dir));
  } else if (has('pyrightconfig.json') || iniHas(pyproject, /^\[tool\.pyright/)) {
    out.push(spec('typecheck', 'pyright', 'pyright', 'python', dir));
  }
  if (iniHas(pyproject, /^\[tool\.ruff/) || has('ruff.toml') || has('.ruff.toml')) {
    out.push(spec('lint', 'ruff', 'ruff check .', 'python', dir));
  } else if (has('.flake8') || iniHas(setupCfg, /^\[flake8/) || iniHas(read(path.join(abs, 'tox.ini')), /^\[flake8/)) {
    out.push(spec('lint', 'flake8', 'python -m flake8', 'python', dir));
  }
  const pytest =
    has('pytest.ini') || has('conftest.py') || has('tox.ini') || has('tests') || has('test') ||
    iniHas(pyproject, /^\[tool\.pytest/) || iniHas(setupCfg, /^\[tool:pytest/) || names.some((f) => /^test_.+\.py$|_test\.py$/.test(f));
  if (pytest) {
    out.push(spec('test', 'pytest', 'python -m pytest -q -x --no-header -p no:cacheprovider', 'python', dir, 'python -m pytest -q {tests}'));
  }
  return out;
}

function goChecks(root: string, dir: string): CheckSpec[] {
  if (!stat(path.join(root, dir, 'go.mod'))) {
    return [];
  }
  return [
    spec('build', 'go:build', 'go build ./...', 'go', dir),
    spec('lint', 'go:vet', 'go vet ./...', 'go', dir),
    spec('test', 'go:test', 'go test ./...', 'go', dir, 'go test {pkgs}'),
  ];
}

function rustChecks(root: string, dir: string): CheckSpec[] {
  const abs = path.join(root, dir);
  if (!stat(path.join(abs, 'Cargo.toml'))) {
    return [];
  }
  const out = [spec('typecheck', 'cargo:check', 'cargo check -q --all-targets', 'rust', dir)];
  const toolchain = (read(path.join(abs, 'rust-toolchain.toml')) ?? '') + (read(path.join(abs, 'rust-toolchain')) ?? '');
  if (/\bclippy\b/.test(toolchain)) {
    out.push(spec('lint', 'cargo:clippy', 'cargo clippy -q', 'rust', dir));
  }
  out.push(spec('test', 'cargo:test', 'cargo test -q', 'rust', dir, 'cargo test -q -p {crate}'));
  return out;
}

function jvmChecks(root: string, dir: string): CheckSpec[] {
  const abs = path.join(root, dir);
  if (stat(path.join(abs, 'pom.xml'))) {
    const mvn = stat(path.join(abs, 'mvnw')) ? './mvnw' : 'mvn';
    return [
      spec('build', 'maven:compile', `${mvn} -q -DskipTests compile`, 'maven', dir),
      spec('test', 'maven:test', `${mvn} -q test`, 'maven', dir, `${mvn} -q test -Dtest={classes}`),
    ];
  }
  const script = read(path.join(abs, 'build.gradle.kts')) ?? read(path.join(abs, 'build.gradle'));
  if (script === undefined) {
    return [];
  }
  const gradle = stat(path.join(abs, 'gradlew')) ? './gradlew' : 'gradle';
  const kotlin = /org\.jetbrains\.kotlin|kotlin\s*\(/.test(script);
  return [
    spec('build', 'gradle:compile', `${gradle} -q ${kotlin ? 'compileKotlin' : 'compileJava'}`, 'gradle', dir),
    spec('test', 'gradle:test', `${gradle} -q test`, 'gradle', dir, `${gradle} -q test --tests {classes}`),
  ];
}

function dotnetChecks(root: string, dir: string): CheckSpec[] {
  const names = list(path.join(root, dir));
  const sln = names.filter((f) => f.endsWith('.sln')).sort();
  const projects = names.filter((f) => /\.(csproj|fsproj|vbproj)$/.test(f)).sort();
  if (!sln.length && !projects.length) {
    return [];
  }
  // dotnet refuses a folder with several project/solution files unless one is named.
  const target = sln.length + projects.length > 1 ? ` ${sln[0] ?? projects[0]}` : '';
  return [
    spec('build', 'dotnet:build', `dotnet build${target} --nologo -v q`, 'dotnet', dir),
    spec('test', 'dotnet:test', `dotnet test${target} --nologo`, 'dotnet', dir, `dotnet test${target} --nologo --filter FullyQualifiedName~{classes}`),
  ];
}

/** Target names of a Makefile (no pattern rules, no variables). */
export function makeTargets(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/^([A-Za-z0-9_][A-Za-z0-9_.-]*(?:[ \t]+[A-Za-z0-9_][A-Za-z0-9_.-]*)*)[ \t]*::?(?!=)/gm)) {
    for (const t of m[1].split(/[ \t]+/)) {
      out.add(t);
    }
  }
  return [...out];
}

const MAKEFILES = ['GNUmakefile', 'makefile', 'Makefile'];
const makefileIn = (abs: string) => MAKEFILES.find((f) => stat(path.join(abs, f))?.isFile());

function makeChecks(root: string, dir: string, covered: Set<CheckKind>): CheckSpec[] {
  const file = makefileIn(path.join(root, dir));
  const text = file && read(path.join(root, dir, file));
  if (!text) {
    return [];
  }
  const targets = new Set(makeTargets(text));
  const out: CheckSpec[] = [];
  const add = (kind: CheckKind, target: string | undefined) => {
    if (target && !covered.has(kind)) {
      out.push(spec(kind, `make:${target}`, `make -s ${target}`, 'make', dir));
    }
  };
  add('build', targets.has('build') ? 'build' : undefined);
  add('typecheck', targets.has('typecheck') ? 'typecheck' : undefined);
  add('lint', targets.has('lint') ? 'lint' : undefined);
  add('test', targets.has('test') ? 'test' : targets.has('check') ? 'check' : undefined);
  return out;
}

const cache = new Map<string, { key: string; specs: CheckSpec[] }>();

function dirKey(abs: string): string {
  const parts = [`${stat(abs)?.mtimeMs ?? 0}`];
  for (const f of WATCHED) {
    const s = stat(path.join(abs, f));
    parts.push(s ? `${s.mtimeMs}:${s.size}` : '-');
  }
  return parts.join('|');
}

/** Checks of one project folder (workspace-relative `dir`), cached by its manifests' mtimes. */
function discoverDir(root: string, dir: string): CheckSpec[] {
  const abs = path.join(root, dir);
  const key = dirKey(abs);
  const hit = cache.get(abs);
  if (hit?.key === key) {
    return hit.specs;
  }
  const specs = [...nodeChecks(root, dir), ...pythonChecks(root, dir), ...goChecks(root, dir), ...rustChecks(root, dir), ...jvmChecks(root, dir), ...dotnetChecks(root, dir)];
  specs.push(...makeChecks(root, dir, new Set(specs.map((s) => s.kind))));
  cache.set(abs, { key, specs });
  return specs;
}

/** Root plus the nearest manifest folder above each changed file (monorepo packages). */
function projectDirs(root: string, changedFiles: string[]): string[] {
  const dirs = new Set<string>(['']);
  for (const f of changedFiles) {
    const rel = slash(path.isAbsolute(f) ? path.relative(root, f) : f).replace(/^\.\//, '');
    if (!rel || rel.startsWith('../') || path.isAbsolute(rel)) {
      continue;
    }
    let d = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '';
    while (d && !isManifestDir(path.join(root, d))) {
      d = d.includes('/') ? d.slice(0, d.lastIndexOf('/')) : '';
    }
    dirs.add(d);
  }
  return [...dirs].sort();
}

const insideRoot = (cwd: string) => !path.isAbsolute(cwd) && !/^[\\/]/.test(cwd) && !/^[a-zA-Z]:/.test(cwd) && !path.normalize(cwd).split(/[\\/]/).includes('..');

function sanitizeOverride(raw: unknown): CheckOverride | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return undefined;
  }
  const r = raw as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
  const id = str(r.id);
  const cwd = str(r.cwd);
  if (!id || /^security/i.test(id) || (cwd && !insideRoot(cwd))) {
    return undefined;
  }
  const o: CheckOverride = { id };
  const kind = KINDS.find((k) => k === r.kind);
  if (kind) {
    o.kind = kind;
  }
  for (const k of ['command', 'scoped'] as const) {
    const v = str(r[k]);
    if (v) {
      o[k] = v;
    }
  }
  if (cwd) {
    o.cwd = slash(cwd).replace(/^\.\/|\/$/g, '');
  }
  const t = Number(r.timeoutSeconds);
  if (r.timeoutSeconds !== undefined && Number.isFinite(t)) {
    o.timeoutSeconds = Math.max(10, Math.min(3600, Math.floor(t)));
  }
  if (typeof r.required === 'boolean') {
    o.required = r.required;
  }
  if (Array.isArray(r.when)) {
    const when = r.when.map(str).filter((g): g is string => !!g);
    if (when.length) {
      o.when = when;
    }
  }
  return o;
}

/** `.localpilot/checks.json` (JSONC), sanitised; undefined when absent or unreadable. */
export async function loadChecksFile(root: string): Promise<ChecksFile | undefined> {
  let text: string;
  try {
    text = await fs.promises.readFile(path.join(root, CHECKS_FILE), 'utf8');
  } catch {
    return undefined;
  }
  let raw: unknown;
  try {
    raw = parseJsonc(text);
  } catch {
    return undefined;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return undefined;
  }
  const r = raw as Record<string, unknown>;
  const out: ChecksFile = {};
  if (Array.isArray(r.checks)) {
    out.checks = r.checks.map(sanitizeOverride).filter((c): c is CheckOverride => !!c);
  }
  if (Array.isArray(r.disable)) {
    out.disable = r.disable.filter((d): d is string => typeof d === 'string' && !!d.trim()).map((d) => d.trim());
  }
  const budget = Number(r.timeBudgetSeconds);
  if (r.timeBudgetSeconds !== undefined && Number.isFinite(budget) && budget > 0) {
    out.timeBudgetSeconds = Math.max(30, Math.min(7200, Math.floor(budget)));
  }
  return out;
}

/** Merges overrides onto `specs` by id; a new id needs a kind and a command. A changed command drops a stale scoped template. */
function applyOverrides(specs: CheckSpec[], overrides: CheckOverride[], source: CheckSpec['source']): CheckSpec[] {
  const out = [...specs];
  for (const o of overrides) {
    const at = out.findIndex((s) => s.id === o.id);
    if (at >= 0) {
      const cur = out[at];
      const kind = o.kind ?? cur.kind;
      const commandChanged = o.command !== undefined && o.command !== cur.command;
      out[at] = {
        ...cur,
        kind,
        command: o.command ?? cur.command,
        cwd: o.cwd ?? cur.cwd,
        scoped: o.scoped ?? (commandChanged ? undefined : cur.scoped),
        timeoutSeconds: o.timeoutSeconds ?? (o.kind && o.kind !== cur.kind ? DEFAULT_TIMEOUTS[kind] : cur.timeoutSeconds),
        required: o.required ?? (o.kind && o.kind !== cur.kind ? DEFAULT_REQUIRED[kind] : cur.required),
        when: o.when ?? cur.when,
        source,
      };
      for (const k of ['cwd', 'scoped', 'when'] as const) {
        if (out[at][k] === undefined) {
          delete out[at][k];
        }
      }
    } else if (o.kind && o.command) {
      out.push({
        id: o.id,
        kind: o.kind,
        command: o.command,
        ...(o.cwd ? { cwd: o.cwd } : {}),
        ...(o.scoped ? { scoped: o.scoped } : {}),
        timeoutSeconds: o.timeoutSeconds ?? DEFAULT_TIMEOUTS[o.kind],
        required: o.required ?? DEFAULT_REQUIRED[o.kind],
        ...(o.when ? { when: o.when } : {}),
        source,
        ecosystem: 'custom',
      });
    }
  }
  return out;
}

const disabled = (id: string, list: string[]) => list.some((d) => id === d || id.startsWith(`${d}@`));

export const SECURITY_CHECK: Readonly<CheckSpec> = Object.freeze({
  id: 'security',
  kind: 'security',
  command: '',
  timeoutSeconds: DEFAULT_TIMEOUTS.security,
  required: true,
  source: 'discovered',
  ecosystem: 'custom',
});

/**
 * The checks of `root` (design §2.2). Precedence by id: `.localpilot/checks.json` > `settingChecks` > discovery; the
 * file's `disable` drops discovered/setting ids (`npm:lint` also drops `npm:lint@packages/a`). The file is ignored when
 * `!trusted`; `settingChecks` must already be trust-filtered by the caller. `security` is in-process (empty command) and only added when requested.
 */
export async function discoverChecks(root: string, opts: DiscoverOptions): Promise<DiscoveredChecks> {
  let specs: CheckSpec[] = [];
  for (const dir of projectDirs(root, opts.changedFiles ?? [])) {
    specs.push(...discoverDir(root, dir).map((s) => ({ ...s, ...(s.when ? { when: [...s.when] } : {}) })));
  }
  let budget: number | undefined;
  const settings = sanitizeHealingChecks(opts.settingChecks ?? []).map((c, i): CheckOverride => ({ ...c, id: c.id ?? `custom:${c.kind}${i ? `-${i + 1}` : ''}` }));
  specs = applyOverrides(specs, settings, 'setting');
  if (opts.trusted) {
    const file = await loadChecksFile(root);
    if (file) {
      specs = specs.filter((s) => !disabled(s.id, file.disable ?? []));
      specs = applyOverrides(specs, file.checks ?? [], 'checks.json');
      budget = file.timeBudgetSeconds;
    }
  }
  if (opts.security) {
    specs.push({ ...SECURITY_CHECK });
  }
  const out = specs as DiscoveredChecks;
  if (budget !== undefined) {
    out.timeBudgetSeconds = budget;
  }
  return out;
}

/** The checks run before the first edit of a turn (`healing.baseline: fast`): typecheck and lint, never build or tests. */
export function fastSpecs<T extends Pick<CheckSpec, 'kind'>>(specs: T[]): T[] {
  return specs.filter((s) => s.kind === 'typecheck' || s.kind === 'lint');
}

const CODE = 'ts,tsx,js,jsx,mjs,cjs,mts,cts,vue,svelte,py,pyi,go,rs,java,kt,kts,scala,groovy,cs,fs,vb,c,h,cc,cpp,cxx,hpp,hh,m,mm,swift';
const SOURCE_GLOBS: Record<CheckEcosystem, string[]> = {
  node: ['**/*.{ts,tsx,js,jsx,mjs,cjs,mts,cts,vue,svelte}', '**/package.json', '**/tsconfig*.json', '**/{package-lock.json,pnpm-lock.yaml,yarn.lock,bun.lock,bun.lockb}', '**/.eslintrc*', '**/.mocharc*'],
  python: ['**/*.{py,pyi}', '**/{pyproject.toml,setup.cfg,setup.py,pytest.ini,tox.ini,mypy.ini,ruff.toml,.flake8,pyrightconfig.json}', '**/requirements*.txt'],
  go: ['**/*.go', '**/go.mod', '**/go.sum'],
  rust: ['**/*.rs', '**/Cargo.toml', '**/Cargo.lock', '**/rust-toolchain*'],
  maven: ['**/*.{java,kt,kts,scala,groovy}', '**/pom.xml', '**/src/main/resources/**', '**/src/test/resources/**'],
  gradle: ['**/*.{java,kt,kts,scala,groovy}', '**/*.gradle', '**/gradle.properties', '**/src/main/resources/**', '**/src/test/resources/**'],
  dotnet: ['**/*.{cs,fs,vb,razor,cshtml,csproj,fsproj,vbproj,sln,props,targets,resx}'],
  make: [`**/*.{${CODE},s,S}`, '**/Makefile', '**/makefile', '**/GNUmakefile', '**/*.mk'],
  custom: ['**'],
};

/** Never in check scope, by file type only (code under `docs/` or `assets/` still counts): docs, media, LocalPilot's own state. */
const OUT_OF_SCOPE = [
  '.localpilot/**', '**/*.{md,mdx,markdown,rst,adoc}', '**/{LICENSE,LICENCE,COPYING,CHANGELOG,AUTHORS,NOTICE}{,.txt}',
  '**/*.{png,jpg,jpeg,gif,svg,ico,webp,bmp,tiff,avif,mp3,mp4,wav,ogg,webm,mov,woff,woff2,ttf,otf,eot,pdf,psd,zip}',
].map((g) => globToRegExp(g));

/** Workspace-relative globs whose changes make `spec` relevant: its `when` globs, else its ecosystem's sources under its cwd. */
export function scopeGlobs(spec: Pick<CheckSpec, 'kind' | 'ecosystem' | 'cwd' | 'when'>): string[] {
  if (spec.when?.length) {
    return [...spec.when];
  }
  if (spec.kind === 'security') {
    return [];
  }
  const prefix = spec.cwd ? `${slash(spec.cwd).replace(/^\.\/|\/$/g, '')}/` : '';
  return SOURCE_GLOBS[spec.ecosystem].map((g) => prefix + g);
}

const globCache = new Map<string, RegExp>();
const globRe = (g: string) => {
  let re = globCache.get(g);
  if (!re) {
    re = globToRegExp(slash(g).replace(/^\.\//, ''));
    globCache.set(g, re);
  }
  return re;
};

/** Whether a workspace-relative file can affect any of `specs` (`*.md`, images, fonts and `.localpilot/**` never do). */
export function isInCheckScope(file: string, specs: Pick<CheckSpec, 'kind' | 'ecosystem' | 'cwd' | 'when'>[]): boolean {
  const rel = slash(file).replace(/^\.\//, '');
  if (OUT_OF_SCOPE.some((re) => re.test(rel))) {
    return false;
  }
  return specs.some((s) => scopeGlobs(s).some((g) => globRe(g).test(rel)));
}

const CONFIG_GLOBS: Partial<Record<CheckEcosystem, string[]>> = {
  node: ['package.json', 'tsconfig*.json', 'jest.config.*', 'vitest.config.*', 'vite.config.*', '.mocharc*', '.eslintrc*', 'eslint.config.*', '.eslintignore', 'babel.config.*', '.babelrc*'],
  python: ['pyproject.toml', 'setup.cfg', 'pytest.ini', 'tox.ini', 'mypy.ini', '.mypy.ini', 'ruff.toml', '.ruff.toml', '.flake8', 'pyrightconfig.json', '**/conftest.py'],
  rust: ['rust-toolchain', 'rust-toolchain.toml', 'clippy.toml', '.clippy.toml'],
  maven: ['mvnw', '.mvn/**'],
  gradle: ['gradlew', 'gradle/wrapper/**'],
  dotnet: ['**/*.runsettings', 'Directory.Build.props', 'Directory.Build.targets'],
  make: ['Makefile', 'makefile', 'GNUmakefile', '*.mk'],
};

/** Script names `npm run x` reaches from `name`, including pre/post hooks. */
function reachableScripts(scripts: Record<string, string>, name: string, seen = new Set<string>()): string[] {
  for (const n of [`pre${name}`, name, `post${name}`]) {
    if (scripts[n] === undefined || seen.has(n)) {
      continue;
    }
    seen.add(n);
    for (const m of scripts[n].matchAll(/\b(?:npm|pnpm|yarn|bun)\s+(?:run(?:-script)?\s+)?([\w:.-]+)/g)) {
      reachableScripts(scripts, m[1], seen);
    }
  }
  return [...seen];
}

function scriptsOf(root: string, cwd: string): Record<string, string> {
  try {
    const pkg = JSON.parse(read(path.join(root, cwd, 'package.json')) ?? '') as { scripts?: Record<string, unknown> };
    return Object.fromEntries(Object.entries(pkg.scripts ?? {}).filter((e): e is [string, string] => typeof e[1] === 'string'));
  } catch {
    return {};
  }
}

/** The npm script a node check command runs (`npm test` -> test, `pnpm run lint` -> lint). */
function scriptName(command: string): string | undefined {
  const m = /^(?:(?:npm|pnpm|yarn)\s+(test|t)\b|(?:npm|pnpm|yarn|bun)\s+run(?:-script)?\s+([\w:.-]+))/.exec(command.trim());
  return m ? (m[2] ?? 'test') : undefined;
}

/** Make target a `make -s x` command invokes. */
const makeTarget = (command: string) => /^make\s+(?:-\S+\s+)*([A-Za-z0-9_][\w.-]*)/.exec(command.trim())?.[1];

/** Workspace-relative script files named by a command line (`./scripts/x.sh`, `node tools/check.js`, `./gradlew`). */
function namedFiles(root: string, cwd: string, text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/(?:^|[\s;&|(="'])((?:\.{1,2}\/)?[\w.-]+(?:\/[\w.-]+)*\.(?:sh|bash|js|mjs|cjs|ts|mts|py|ps1|bat|cmd|pl|rb)|\.\/[\w.-]+(?:\/[\w.-]+)*)(?=$|[\s;&|)"'])/g)) {
    const rel = slash(path.normalize(path.join(cwd, m[1])));
    if (!rel.startsWith('../') && rel !== '..' && stat(path.join(root, rel))?.isFile()) {
      out.push(rel);
    }
  }
  return out;
}

interface Definition {
  files: string[];
  bodies: [string, string][];
}

function definitionsOf(specs: Pick<CheckSpec, 'command' | 'scoped' | 'cwd' | 'ecosystem' | 'kind'>[], root: string): Definition {
  const files = new Set<string>([CHECKS_FILE]);
  const bodies = new Map<string, string>();
  const checksFile = read(path.join(root, CHECKS_FILE));
  if (checksFile !== undefined) {
    bodies.set(CHECKS_FILE, checksFile);
  }
  const addWrappers = (cwd: string, text: string) => {
    for (const f of namedFiles(root, cwd, text)) {
      files.add(f);
      const body = read(path.join(root, f));
      if (body !== undefined) {
        bodies.set(f, body);
      }
    }
  };
  for (const s of specs) {
    if (s.kind === 'security') {
      continue;
    }
    const cwd = s.cwd ? slash(s.cwd).replace(/^\.\/|\/$/g, '') : '';
    const pre = (g: string) => (cwd && !g.startsWith('**/') ? `${cwd}/${g}` : g);
    for (const g of CONFIG_GLOBS[s.ecosystem] ?? []) {
      files.add(pre(g));
    }
    for (const cmd of [s.command, s.scoped ?? '']) {
      addWrappers(cwd, cmd);
      const script = scriptName(cmd);
      if (script) {
        const scripts = scriptsOf(root, cwd);
        const pkgFile = pre('package.json');
        files.add(pkgFile);
        bodies.set(`${pkgFile} scripts`, JSON.stringify(scripts));
        for (const n of reachableScripts(scripts, script)) {
          addWrappers(cwd, scripts[n]);
        }
      }
      const target = makeTarget(cmd);
      const mk = target ? makefileIn(path.join(root, cwd)) : undefined;
      if (target && mk) {
        const text = read(path.join(root, cwd, mk)) ?? '';
        files.add(pre(mk));
        const recipe = makeRecipe(text, target);
        bodies.set(`${pre(mk)}:${target}`, recipe);
        addWrappers(cwd, recipe);
      }
    }
  }
  return { files: [...files].sort(), bodies: [...bodies].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)) };
}

/** Rule line and recipe lines of `target`, plus the recipes of its prerequisites (one level). */
function makeRecipe(text: string, target: string, depth = 0): string {
  const lines = text.split(/\r?\n/);
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^([^\t#=:][^=:]*?)\s*::?(?!=)(.*)$/.exec(lines[i]);
    if (!m || !m[1].split(/\s+/).includes(target)) {
      continue;
    }
    out.push(lines[i]);
    let j = i + 1;
    for (; j < lines.length && (lines[j].startsWith('\t') || (lines[j - 1].endsWith('\\') && lines[j].trim())); j++) {
      out.push(lines[j]);
    }
    if (depth < 1) {
      for (const dep of m[2].replace(/;.*$/, '').trim().split(/\s+/).filter((d) => /^[\w.-]+$/.test(d))) {
        out.push(makeRecipe(text, dep, depth + 1));
      }
    }
    i = j - 1;
  }
  return out.filter(Boolean).join('\n');
}

/**
 * Workspace-relative files and globs that define `specs` (anti-gaming and the allowance hash): `.localpilot/checks.json`,
 * package.json, Makefiles, tsconfig/jest/vitest/mocha/eslint/pytest/tox configs, conftest.py, and wrapper scripts named
 * by a check command or by the npm scripts / make recipes it runs.
 */
export function checkDefiningFiles(specs: Pick<CheckSpec, 'command' | 'scoped' | 'cwd' | 'ecosystem' | 'kind'>[], root: string): string[] {
  return definitionsOf(specs, root).files;
}

/**
 * The text that defines what `specs` run, for `commandsHash`: the `scripts` section of each involved package.json, the
 * invoked Makefile targets' recipes, `.localpilot/checks.json` and wrapper script contents. Stable order.
 */
export function definitionBodies(specs: Pick<CheckSpec, 'command' | 'scoped' | 'cwd' | 'ecosystem' | 'kind'>[], root: string): string {
  return definitionsOf(specs, root)
    .bodies.map(([name, body]) => `== ${name} ==\n${body}\n`)
    .join('');
}

/** Drops cached discovery (tests, or after a workspace folder is removed). */
export function clearChecksCache(root?: string): void {
  if (!root) {
    cache.clear();
    return;
  }
  for (const k of [...cache.keys()]) {
    if (k === root || k.startsWith(root + path.sep)) {
      cache.delete(k);
    }
  }
}
