import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { fakeJest, fakePass, fakeRequireTest, fakeSlow, fakeTsc, script, type JestSuite, type ToolRun } from './toolchains';

/**
 * Project folders for the self-healing end-to-end tests. Each one is created as a fresh package folder inside the test
 * workspace (the engine discovers its checks from the nearest manifest of the changed files, like a monorepo package)
 * with fake toolchains from `toolchains.ts`. The source variants the scripted model writes live here too, so the test
 * and the model agree on what "buggy" and "fixed" look like.
 */

export type FixtureName = 'typescript' | 'unit' | 'integration' | 'dependency' | 'conflict' | 'security' | 'slow' | 'fanout';

export interface Fixture {
  name: FixtureName;
  /** Absolute folder. */
  dir: string;
  /** Workspace-relative folder, `/` separators (what the model passes to write_file). */
  rel: string;
  /** JSON-lines log of every fake tool run (outside the workspace). */
  logFile: string;
  /** Where the slow check writes its pid. */
  pidFile: string;
  read(file: string): string;
  exists(file: string): boolean;
  runs(): ToolRun[];
}

export const TS_A = {
  original: 'export function double(n: number): number {\n  return n * 2;\n}\n',
  buggy: "export function double(n: number): number {\n  return n * 2;\n}\n\nexport const BUG_TOTAL: number = double('2');\n",
  fixed: 'export function double(n: number): number {\n  return n * 2;\n}\n\nexport const total: number = double(2);\n',
};

export const SUM = {
  original: 'export const sum = (a: number, b: number): number => a + b;\n',
  buggy: '// Refactored: one arrow per operation.\nexport const sum = (a: number, b: number): number => a - b;\n',
  fixed: '// Refactored: one arrow per operation.\nexport const sum = (a: number, b: number): number => a + b;\n',
  test: "import { sum } from './sum';\n\ndescribe('sum', () => {\n  test('adds', () => {\n    expect(sum(1, 2)).toBe(3);\n  });\n});\n",
};

export const ROUTES = {
  server: (route: string) => `export const ROUTES = { users: '${route}' };\n\nexport function handle(path: string): number {\n  return Object.values(ROUTES).includes(path) ? 200 : 404;\n}\n`,
  routes: "import { handle } from '../server';\n\nexport const getUsers = (): number => handle('/users');\n",
  test: "import { getUsers } from './routes';\n\ntest('GET /users', () => expect(getUsers()).toBe(200));\n",
};

export const PAD = {
  module: "const leftPad = require('left-pad');\n\nmodule.exports = (s) => leftPad(s, 5);\n",
  test: "const pad = require('./pad');\n\ntest('pads', () => expect(pad('ab')).toBe('   ab'));\n",
};

/** An AWS access key id shape (not a real key, and not one of the placeholders the scanner skips). */
export const LEAKED_KEY = 'AKIAQ7LP4X2M9RZT3KWB';
export const SECRET = {
  original: "export const REGION = 'eu-west-1';\n",
  leaked: `export const REGION = 'eu-west-1';\nexport const ACCESS_KEY_ID = '${LEAKED_KEY}';\n`,
  fromEnv: "export const REGION = 'eu-west-1';\nexport const ACCESS_KEY_ID = process.env.AWS_ACCESS_KEY_ID ?? '';\n",
};

export const FAN = {
  alpha: (tag: 'ALPHA_OK' | 'ALPHA_BUG') => `// ${tag}\nexport const alphaValue = (n: number): number => n ${tag === 'ALPHA_OK' ? '+' : '-'} 1;\n`,
  beta: (tag: 'BETA_OK' | 'BETA_BUG' | 'BETA_WRONG') => `// ${tag}\nexport const betaValue = (n: number): number => n * ${tag === 'BETA_OK' ? 2 : tag === 'BETA_BUG' ? 3 : 4};\n`,
};

export const CONFLICT = {
  base: 'export const greeting = "hello";\n',
  ours: 'export const greeting = "hello from main";\n',
  theirs: 'export const greeting = "hello from feature";\n',
};

const pkg = (name: string, scripts: Record<string, string>, extra: Record<string, unknown> = {}) => `${JSON.stringify({ name, version: '1.0.0', private: true, scripts, ...extra }, null, 2)}\n`;

function jestSuites(name: FixtureName): JestSuite[] {
  switch (name) {
    case 'unit':
      return [
        { test: 'src/sum.test.ts', impl: ['src/sum.ts'], name: 'sum › adds', file: 'src/sum.ts', pass: 'a \\+ b', message: 'expect(received).toBe(expected) // Object.is equality', expected: '3', received: '-1', frames: ['src/sum.test.ts:5:23'] },
        { test: 'src/other.test.ts', impl: ['src/other.ts'], name: 'other › works', file: 'src/other.ts', pass: 'other', message: 'other failed', frames: ['src/other.test.ts:3:5'] },
      ];
    case 'integration':
      return [
        { test: 'api/routes.integration.test.ts', impl: ['server.ts', 'api/routes.ts'], name: 'api › GET /users', file: 'server.ts', pass: "users: '/users'", message: 'expected status 200 received 404', frames: ['api/routes.ts:3:42', 'api/routes.integration.test.ts:3:40'] },
      ];
    case 'fanout':
      return [
        { test: 'src/alpha.test.ts', impl: ['src/alpha.ts'], name: 'alpha › works', file: 'src/alpha.ts', pass: 'ALPHA_OK', message: 'expect(received).toBe(expected) // Object.is equality', expected: '2', received: '0', frames: ['src/alpha.test.ts:4:31'] },
        { test: 'src/beta.test.ts', impl: ['src/beta.ts'], name: 'beta › works', file: 'src/beta.ts', pass: 'BETA_OK', message: 'expect(received).toBe(expected) // Object.is equality', expected: '2', received: '3', frames: ['src/beta.test.ts:4:30'] },
      ];
    default:
      return [];
  }
}

function files(name: FixtureName, dir: string, logFile: string, pidFile: string): Record<string, string> {
  const jest = (holdMs = 50) => script(fakeJest, { dir, log: logFile, suites: jestSuites(name), holdMs });
  switch (name) {
    case 'typescript':
      return {
        'package.json': pkg('heal-ts', { typecheck: 'node tools/tsc.js', test: 'node tools/test.js' }),
        'src/a.ts': TS_A.original,
        'tools/tsc.js': script(fakeTsc, { dir, log: logFile, files: ['src/a.ts'] }),
        'tools/test.js': script(fakePass, { log: logFile, tool: 'test' }),
      };
    case 'unit':
      return {
        'package.json': pkg('heal-unit', { test: 'jest' }),
        'src/sum.ts': SUM.original,
        'src/sum.test.ts': SUM.test,
        'src/other.ts': 'export const other = (): string => "other";\n',
        'src/other.test.ts': "import { other } from './other';\n\ntest('works', () => expect(other()).toBe('other'));\n",
        'node_modules/.bin/jest': jest(),
      };
    case 'integration':
      return {
        'package.json': pkg('heal-integration', { test: 'jest' }),
        'server.ts': ROUTES.server('/users'),
        'api/routes.ts': ROUTES.routes,
        'api/routes.integration.test.ts': ROUTES.test,
        'node_modules/.bin/jest': jest(),
      };
    case 'dependency':
      return {
        'package.json': pkg('heal-dependency', { test: 'node tools/require-test.js' }, { dependencies: { 'left-pad': 'file:./vendor/left-pad' } }),
        '.npmrc': 'audit=false\nfund=false\nupdate-notifier=false\npackage-lock=false\n',
        'vendor/left-pad/package.json': `${JSON.stringify({ name: 'left-pad', version: '1.3.0', main: 'index.js' }, null, 2)}\n`,
        'vendor/left-pad/index.js': "module.exports = (s, n, c = ' ') => String(s).padStart(n, c);\n",
        'src/pad.test.js': PAD.test,
        'tools/require-test.js': script(fakeRequireTest, { dir, log: logFile, module: 'src/pad.js', test: 'src/pad.test.js' }),
      };
    case 'conflict':
      return { 'a.ts': CONFLICT.base };
    case 'security':
      return {
        'package.json': pkg('heal-security', { typecheck: 'node tools/tsc.js' }),
        'src/config.ts': SECRET.original,
        'tools/tsc.js': script(fakeTsc, { dir, log: logFile, files: ['src/config.ts'] }),
      };
    case 'slow':
      return {
        'package.json': pkg('heal-slow', { typecheck: 'node tools/slow.js' }),
        'src/x.ts': 'export const x = 1;\n',
        'tools/slow.js': script(fakeSlow, { log: logFile, pidFile, seconds: 60 }),
      };
    case 'fanout':
      return {
        'package.json': pkg('heal-fanout', { test: 'jest' }),
        'src/alpha.ts': FAN.alpha('ALPHA_OK'),
        'src/beta.ts': FAN.beta('BETA_OK'),
        'src/alpha.test.ts': "import { alphaValue } from './alpha';\n\ndescribe('alpha', () => {\n  test('works', () => expect(alphaValue(1)).toBe(2));\n});\n",
        'src/beta.test.ts': "import { betaValue } from './beta';\n\ndescribe('beta', () => {\n  test('works', () => expect(betaValue(1)).toBe(2));\n});\n",
        'node_modules/.bin/jest': jest(250),
      };
  }
}

const git = (cwd: string, args: string) => cp.execSync(`git ${args}`, { cwd, stdio: 'pipe', env: { ...process.env, GIT_AUTHOR_NAME: 'heal', GIT_AUTHOR_EMAIL: 'heal@localpilot', GIT_COMMITTER_NAME: 'heal', GIT_COMMITTER_EMAIL: 'heal@localpilot' } }).toString();

/** A repository in the middle of a merge: `a.ts` is unmerged (`UU`) and holds conflict markers, as the user left it. */
function startConflictedMerge(dir: string): void {
  git(dir, 'init -q -b main');
  git(dir, 'add -A');
  git(dir, 'commit -q -m base');
  git(dir, 'checkout -q -b feature');
  fs.writeFileSync(path.join(dir, 'a.ts'), CONFLICT.theirs);
  git(dir, 'commit -q -am feature');
  git(dir, 'checkout -q main');
  fs.writeFileSync(path.join(dir, 'a.ts'), CONFLICT.ours);
  git(dir, 'commit -q -am main');
  try {
    git(dir, 'merge feature');
  } catch {
    /* exits 1 on the conflict, which is the point */
  }
}

/**
 * Creates `<root>/lp-heal-<name>-XXXX/` from the named fixture; tool logs and pid files go to `scratch` (outside the
 * workspace). Remove the folder with `removeTemp(fixture.dir)`.
 */
export function materialize(root: string, name: FixtureName, scratch: string): Fixture {
  const dir = fs.mkdtempSync(path.join(root, `lp-heal-${name}-`));
  const base = path.basename(dir);
  const logFile = path.join(scratch, `${base}.jsonl`);
  const pidFile = path.join(scratch, `${base}.pid`);
  fs.writeFileSync(logFile, '');
  for (const [file, text] of Object.entries(files(name, dir, logFile, pidFile))) {
    const abs = path.join(dir, file);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text, { mode: file.startsWith('node_modules/.bin/') ? 0o755 : 0o644 });
  }
  if (name === 'conflict') {
    startConflictedMerge(dir);
  }
  return {
    name,
    dir,
    rel: path.relative(root, dir).split(path.sep).join('/'),
    logFile,
    pidFile,
    read: (file) => fs.readFileSync(path.join(dir, file), 'utf8'),
    exists: (file) => fs.existsSync(path.join(dir, file)),
    runs: () =>
      fs
        .readFileSync(logFile, 'utf8')
        .split('\n')
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l) as ToolRun),
  };
}

/** Largest number of tool runs that were in flight at the same moment (finished runs only). */
export function runOverlap(runs: readonly ToolRun[]): number {
  const ev = runs.filter((r) => r.end !== undefined).flatMap((r) => [[r.start, 1], [r.end!, -1]] as const).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let n = 0;
  let max = 0;
  for (const [, d] of ev) {
    n += d;
    max = Math.max(max, n);
  }
  return max;
}
