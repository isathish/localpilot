import * as fs from 'fs/promises';
import * as path from 'path';
import type { CheckEcosystem, CheckKind, CheckOverride, CheckSpec, ChecksFile } from '../agent/healing/types';
import { HEALING_POLICY_CATEGORIES, HEALING_POLICY_MAX } from '../healingSettings';

/** What the Settings page shows of the self-healing checks and retry policies. Reads files only; nothing is executed. */

export interface DetectedCheck extends Pick<CheckSpec, 'id' | 'kind' | 'command' | 'cwd' | 'required' | 'source' | 'ecosystem'> {
  /** For source 'setting': which settings scope defined it. */
  scope?: 'user' | 'workspace';
}

export interface HealingPolicyRow {
  category: string;
  attempts: number;
  backoffMs: number[];
  timeoutSeconds?: number;
  /** Attempts a setting can never raise above (0 = always escalates). */
  max: number;
}

export interface HealingView {
  checks: DetectedCheck[];
  /** Discovered ids `.localpilot/checks.json` switches off. */
  disabled: string[];
  trusted: boolean;
  hasRoot: boolean;
  checksJson: 'missing' | 'present' | 'invalid';
  policies: HealingPolicyRow[];
}

/** Defaults of the recovery policy per failure category (design §4.2), shown in the Retry configuration table. */
export const HEALING_POLICY_DEFAULTS: Record<string, { attempts: number; backoffMs: number[]; timeoutSeconds?: number }> = {
  model_timeout: { attempts: 3, backoffMs: [1000, 2000, 4000] },
  model_unavailable: { attempts: 3, backoffMs: [1000, 2000, 4000] },
  model_overload: { attempts: 2, backoffMs: [2000, 5000] },
  model_output: { attempts: 2, backoffMs: [] },
  compile: { attempts: 3, backoffMs: [] },
  typescript: { attempts: 3, backoffMs: [] },
  lint: { attempts: 2, backoffMs: [] },
  build: { attempts: 3, backoffMs: [] },
  dependency: { attempts: 1, backoffMs: [] },
  unit_test: { attempts: 3, backoffMs: [] },
  integration_test: { attempts: 2, backoffMs: [] },
  runtime: { attempts: 2, backoffMs: [] },
  database: { attempts: 1, backoffMs: [] },
  data_corruption: { attempts: 0, backoffMs: [] },
  mcp: { attempts: 2, backoffMs: [1000, 3000] },
  git_conflict: { attempts: 0, backoffMs: [] },
  security: { attempts: 2, backoffMs: [] },
  tool: { attempts: 1, backoffMs: [] },
  permission: { attempts: 0, backoffMs: [] },
  check_timeout: { attempts: 1, backoffMs: [] },
  loop: { attempts: 0, backoffMs: [] },
  unknown: { attempts: 1, backoffMs: [] },
};

export function healingPolicyRows(): HealingPolicyRow[] {
  return HEALING_POLICY_CATEGORIES.map((category) => ({ category, ...HEALING_POLICY_DEFAULTS[category], max: HEALING_POLICY_MAX[category] ?? 10 }));
}

/** Written by "Open checks.json" when the file does not exist yet: no checks of its own, so nothing changes until edited. */
export const CHECKS_JSON_TEMPLATE = `${JSON.stringify(
  {
    $comment: 'Add or override checks by id, e.g. { "id": "custom:e2e", "kind": "test", "command": "npm run test:e2e", "required": false, "timeoutSeconds": 900, "when": ["src/api/**"] }. "disable" lists detected ids to skip, e.g. "npm:lint".',
    checks: [],
    disable: [],
  },
  null,
  2,
)}\n`;

const DEFAULT_REQUIRED: Record<CheckKind, boolean> = { build: true, typecheck: true, test: true, lint: false, security: true, custom: false };
const KINDS: readonly CheckKind[] = ['build', 'typecheck', 'lint', 'test', 'security', 'custom'];

const read = (file: string) => fs.readFile(file, 'utf8').catch(() => undefined);
const exists = (file: string) => fs.stat(file).then(() => true, () => false);

/** Static scan of the workspace root, mirroring the discovery rules (design §2.2) for the root folder. */
export async function discoverRootChecks(root: string): Promise<DetectedCheck[]> {
  const out: DetectedCheck[] = [];
  const add = (ecosystem: CheckEcosystem, id: string, kind: CheckKind, command: string) => out.push({ id, kind, command, required: DEFAULT_REQUIRED[kind], source: 'discovered', ecosystem });
  const at = (f: string) => path.join(root, f);
  const names = await fs.readdir(root).catch(() => [] as string[]);
  const has = (f: string) => names.includes(f);

  const pkgText = has('package.json') ? await read(at('package.json')) : undefined;
  if (pkgText !== undefined) {
    let scripts: Record<string, unknown> = {};
    try {
      const pkg = JSON.parse(pkgText) as { scripts?: Record<string, unknown> };
      scripts = pkg.scripts && typeof pkg.scripts === 'object' ? pkg.scripts : {};
    } catch {
      scripts = {};
    }
    const pm = has('pnpm-lock.yaml') ? 'pnpm' : has('yarn.lock') ? 'yarn' : has('bun.lock') || has('bun.lockb') ? 'bun' : 'npm';
    const script = (...cands: string[]) => cands.find((s) => typeof scripts[s] === 'string');
    const build = script('build', 'compile');
    if (build) {
      add('node', 'npm:build', 'build', `${pm} run ${build}`);
    }
    const tc = script('typecheck', 'type-check', 'check-types', 'tsc');
    if (tc) {
      add('node', 'npm:typecheck', 'typecheck', `${pm} run ${tc}`);
    } else if (has('tsconfig.json') && (await exists(at('node_modules/.bin/tsc')))) {
      add('node', 'npm:typecheck', 'typecheck', 'node_modules/.bin/tsc --noEmit -p tsconfig.json');
    }
    if (script('lint')) {
      add('node', 'npm:lint', 'lint', `${pm} run lint`);
    }
    const test = scripts.test;
    if (typeof test === 'string' && !/no test specified/.test(test)) {
      add('node', 'npm:test', 'test', `${pm} run test`);
    }
  }

  const pyproject = has('pyproject.toml') ? ((await read(at('pyproject.toml'))) ?? '') : '';
  if (has('pyproject.toml') || has('setup.cfg') || has('pytest.ini') || has('tox.ini') || names.some((n) => /^requirements.*\.txt$/.test(n))) {
    add('python', 'python:compile', 'build', 'python -m compileall -q .');
    if (/\[tool\.mypy\]/.test(pyproject) || has('mypy.ini')) {
      add('python', 'mypy', 'typecheck', 'mypy .');
    } else if (has('pyrightconfig.json')) {
      add('python', 'pyright', 'typecheck', 'pyright');
    }
    if (/\[tool\.ruff/.test(pyproject) || has('ruff.toml') || has('.ruff.toml')) {
      add('python', 'ruff', 'lint', 'ruff check');
    } else if (has('.flake8')) {
      add('python', 'flake8', 'lint', 'flake8');
    }
    add('python', 'pytest', 'test', 'python -m pytest -q -x --no-header -p no:cacheprovider');
  }

  if (has('go.mod')) {
    add('go', 'go:build', 'build', 'go build ./...');
    add('go', 'go:vet', 'lint', 'go vet ./...');
    add('go', 'go:test', 'test', 'go test ./...');
  }

  if (has('Cargo.toml')) {
    add('rust', 'cargo:check', 'typecheck', 'cargo check -q --all-targets');
    const toolchain = ((await read(at('rust-toolchain.toml'))) ?? (await read(at('rust-toolchain'))) ?? '');
    if (/clippy/.test(toolchain)) {
      add('rust', 'cargo:clippy', 'lint', 'cargo clippy -q');
    }
    add('rust', 'cargo:test', 'test', 'cargo test -q');
  }

  if (has('pom.xml')) {
    const mvn = has('mvnw') ? './mvnw' : 'mvn';
    add('maven', 'maven:compile', 'build', `${mvn} -q -DskipTests compile`);
    add('maven', 'maven:test', 'test', `${mvn} -q test`);
  } else if (has('build.gradle') || has('build.gradle.kts')) {
    const gradle = has('gradlew') ? './gradlew' : 'gradle';
    const buildFile = (await read(at(has('build.gradle.kts') ? 'build.gradle.kts' : 'build.gradle'))) ?? '';
    add('gradle', 'gradle:compile', 'build', `${gradle} -q ${/kotlin/i.test(buildFile) ? 'compileKotlin' : 'compileJava'}`);
    add('gradle', 'gradle:test', 'test', `${gradle} -q test`);
  }

  if (names.some((n) => /\.(sln|csproj|fsproj)$/.test(n))) {
    add('dotnet', 'dotnet:build', 'build', 'dotnet build --nologo -v q');
    add('dotnet', 'dotnet:test', 'test', 'dotnet test --nologo');
  }

  const makefile = has('Makefile') ? ((await read(at('Makefile'))) ?? '') : '';
  if (makefile) {
    const target = (t: string) => new RegExp(`^${t}\\s*:`, 'm').test(makefile);
    const taken = (k: CheckKind) => out.some((c) => c.kind === k);
    for (const [t, kind] of [['build', 'build'], ['typecheck', 'typecheck'], ['lint', 'lint'], ['test', 'test'], ['check', 'test']] as const) {
      if (target(t) && !taken(kind)) {
        add('make', `make:${t}`, kind, `make -s ${t}`);
      }
    }
  }

  add('custom', 'security', 'security', 'Built-in scan of the changed files (secrets, unsafe code)');
  return out;
}

const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

/** Merges overrides onto `checks` by id; an unknown id needs a kind and a command to become a check of its own. */
function applyOverrides(checks: DetectedCheck[], overrides: unknown[], source: DetectedCheck['source'], scope?: 'user' | 'workspace'): void {
  overrides.forEach((raw, i) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return;
    }
    const o = raw as Partial<CheckOverride> & Record<string, unknown>;
    const kind = KINDS.find((k) => k === o.kind);
    const command = str(o.command);
    const id = str(o.id) ?? (kind ? `custom:${kind}${i ? `-${i + 1}` : ''}` : undefined);
    if (!id) {
      return;
    }
    const cur = checks.find((c) => c.id === id);
    if (cur) {
      Object.assign(cur, { source, scope, ...(kind ? { kind } : {}), ...(command ? { command } : {}), ...(str(o.cwd) ? { cwd: str(o.cwd) } : {}), ...(typeof o.required === 'boolean' ? { required: o.required } : {}) });
      return;
    }
    if (kind && command) {
      checks.push({ id, kind, command, cwd: str(o.cwd), required: typeof o.required === 'boolean' ? o.required : DEFAULT_REQUIRED[kind], source, scope, ecosystem: 'custom' });
    }
  });
}

/** Discovery + `localpilot.healing.checks` + `.localpilot/checks.json`, with the precedence and trust rules of design §2.2:
 *  checks.json wins over the setting, which wins over discovery; in an untrusted workspace checks.json and the
 *  workspace value of the setting are ignored, the User value still applies. */
export async function healingView(root: string | undefined, setting: { user?: unknown; workspace?: unknown }, trusted: boolean): Promise<HealingView> {
  const policies = healingPolicyRows();
  if (!root) {
    return { checks: [], disabled: [], trusted, hasRoot: false, checksJson: 'missing', policies };
  }
  const checks = await discoverRootChecks(root);
  const asList = (v: unknown) => (Array.isArray(v) ? v : []);
  // VS Code does not merge arrays: a trusted workspace value replaces the User one.
  if (trusted && Array.isArray(setting.workspace)) {
    applyOverrides(checks, asList(setting.workspace), 'setting', 'workspace');
  } else {
    applyOverrides(checks, asList(setting.user), 'setting', 'user');
  }
  const text = await read(path.join(root, '.localpilot', 'checks.json'));
  let checksJson: HealingView['checksJson'] = text === undefined ? 'missing' : 'present';
  let disabled: string[] = [];
  if (text !== undefined) {
    let file: ChecksFile | undefined;
    try {
      const parsed: unknown = JSON.parse(text);
      file = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as ChecksFile) : undefined;
    } catch {
      file = undefined;
    }
    if (!file) {
      checksJson = 'invalid';
    } else if (trusted) {
      applyOverrides(checks, asList(file.checks), 'checks.json');
      disabled = asList(file.disable).map(str).filter((d): d is string => !!d && checks.some((c) => c.id === d));
    }
  }
  return { checks: checks.filter((c) => !disabled.includes(c.id)), disabled, trusted, hasRoot: true, checksJson, policies };
}

/** Creates `.localpilot/checks.json` from the template unless it exists; returns its path. */
export async function ensureChecksJson(root: string): Promise<{ file: string; created: boolean }> {
  const file = path.join(root, '.localpilot', 'checks.json');
  if (await exists(file)) {
    return { file, created: false };
  }
  await fs.mkdir(path.dirname(file), { recursive: true });
  // 'wx': never overwrite a file that appeared in the meantime.
  const created = await fs.writeFile(file, CHECKS_JSON_TEMPLATE, { encoding: 'utf8', flag: 'wx' }).then(() => true, (e: NodeJS.ErrnoException) => {
    if (e.code === 'EEXIST') {
      return false;
    }
    throw e;
  });
  return { file, created };
}
