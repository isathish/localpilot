/**
 * Smoke checks for src/agent/healing/checks.ts + testMap.ts + commandGuard.isSafeHealingCheck (design §2.1-2.3).
 *   node scripts/healing/run.js scripts/healing/checks.smoke.ts
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { isReadOnlyOrSafe, isSafeHealingCheck } from '../../src/agent/commandGuard';
import {
  CHECKS_TEMPLATE, checkDefiningFiles, clearChecksCache, definitionBodies, discoverChecks, fastSpecs, isInCheckScope, loadChecksFile, scopeGlobs,
} from '../../src/agent/healing/checks';
import { affectedTests, fillScoped, repoGraphImporters } from '../../src/agent/healing/testMap';
import type { CheckSpec } from '../../src/agent/healing/types';

type Check = (name: string, cond: boolean, detail?: unknown) => void;

function workspace(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lp-checks-'));
  for (const [rel, body] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body);
  }
  return root;
}

const byId = (specs: CheckSpec[], id: string) => specs.find((s) => s.id === id);
const ids = (specs: CheckSpec[]) => specs.map((s) => s.id).sort();

export async function checksSmoke(check: Check): Promise<void> {
  const temps: string[] = [];
  const ws = (files: Record<string, string>) => {
    const r = workspace(files);
    temps.push(r);
    return r;
  };
  try {
    // ---- Node / TS ----
    const node = ws({
      'package.json': JSON.stringify({ scripts: { build: 'tsc -p .', lint: 'eslint src', test: 'jest --config jest.config.js', pretest: 'node scripts/prep.js' } }),
      'pnpm-lock.yaml': '',
      'tsconfig.json': '{}',
      'node_modules/.bin/tsc': '#!/bin/sh\n',
      'jest.config.js': 'module.exports = {};',
      'scripts/prep.js': 'console.log(1)',
      'src/a/foo.ts': 'export const foo = 1;',
      'src/a/foo.test.ts': "import { foo } from './foo';",
      'src/a/bar.ts': "import { foo } from './foo';",
      'src/a/baz.ts': '',
      'test/bar.test.ts': '',
      'README.md': '# x',
    });
    const ns = await discoverChecks(node, { trusted: true });
    check('node: pnpm build/lint/test discovered', byId(ns, 'npm:build')?.command === 'pnpm run build' && byId(ns, 'npm:lint')?.command === 'pnpm run lint' && byId(ns, 'npm:test')?.command === 'pnpm test', ns);
    check('node: tsc via node_modules/.bin only', byId(ns, 'npm:typecheck')?.command === 'node_modules/.bin/tsc --noEmit -p tsconfig.json', byId(ns, 'npm:typecheck'));
    check('node: jest scoped template', byId(ns, 'npm:test')?.scoped === 'pnpm exec jest --config jest.config.js --findRelatedTests {files}', byId(ns, 'npm:test'));
    check('node: defaults (timeouts, required)', byId(ns, 'npm:test')?.timeoutSeconds === 600 && byId(ns, 'npm:lint')?.required === false && byId(ns, 'npm:build')?.required === true && byId(ns, 'npm:lint')?.timeoutSeconds === 180);
    check('node: no security spec unless requested', !byId(ns, 'security'));
    const withSec = await discoverChecks(node, { trusted: true, security: true });
    check('security spec is in-process (empty command)', byId(withSec, 'security')?.kind === 'security' && byId(withSec, 'security')?.command === '');

    const fast = fastSpecs(ns);
    check('fastSpecs = typecheck + lint, never build/test', fast.length === 2 && fast.every((s) => s.kind === 'typecheck' || s.kind === 'lint'), fast);
    check('README.md is out of check scope', !isInCheckScope('README.md', ns) && !isInCheckScope('docs/guide.md', ns) && !isInCheckScope('src/assets/logo.png', ns) && !isInCheckScope('LICENSE', ns) && !isInCheckScope('.localpilot/checks.json', ns));
    check('code under assets/ and docs/ is in check scope', isInCheckScope('src/assets/x.ts', ns) && isInCheckScope('docs/site/x.ts', ns));
    check('src/a/foo.ts is in check scope', isInCheckScope('src/a/foo.ts', ns) && isInCheckScope('package.json', ns));
    check('scopeGlobs: node sources', scopeGlobs(byId(ns, 'npm:test')!).some((g) => g.includes('ts,tsx')));

    const defs = checkDefiningFiles(ns, node);
    check('checkDefiningFiles: package.json, tsconfig, jest config, checks.json, wrapper', ['package.json', 'tsconfig*.json', 'jest.config.*', '.localpilot/checks.json', 'scripts/prep.js'].every((f) => defs.includes(f)), defs);
    const body1 = definitionBodies(ns, node);
    check('definitionBodies includes scripts and the wrapper', body1.includes('"pretest"') && body1.includes('console.log(1)'), body1);
    fs.writeFileSync(path.join(node, 'scripts/prep.js'), 'console.log(2)');
    check('definitionBodies changes with the wrapper body', definitionBodies(ns, node) !== body1);

    const aff = await affectedTests(['src/a/foo.ts'], node, 'node');
    check('testMap: foo.ts -> foo.test.ts', aff.tests.includes('src/a/foo.test.ts') && aff.files.includes('src/a/foo.ts'), aff);
    const graph = repoGraphImporters({ rdeps: new Map([['src/a/foo.ts', new Set(['src/a/bar.ts', 'test/bar.test.ts'])]]) });
    const aff2 = await affectedTests([path.join(node, 'src/a/foo.ts')], node, 'node', graph);
    check('testMap: one-hop test importers from the graph (absolute input)', aff2.tests.includes('test/bar.test.ts') && aff2.tests.includes('src/a/foo.test.ts'), aff2);
    const none = await affectedTests(['src/a/baz.ts'], node, 'node');
    check('testMap: unmapped source gives no tests', none.tests.length === 0, none);
    const filled = fillScoped(byId(ns, 'npm:test')!.scoped!, aff, 'linux');
    check('fillScoped: jest files', filled === 'pnpm exec jest --config jest.config.js --findRelatedTests src/a/foo.ts', filled);
    check('fillScoped: empty list -> undefined (run full)', fillScoped('python -m pytest -q {tests}', { tests: [] }) === undefined);
    check('fillScoped: shell-quoting', fillScoped('x {files}', { files: ["a b.ts", "it's.ts"] }, 'linux') === `x 'a b.ts' 'it'\\''s.ts'`, fillScoped('x {files}', { files: ['a b.ts', "it's.ts"] }, 'linux'));
    check('fillScoped: gradle repeats --tests', fillScoped('./gradlew -q test --tests {classes}', { classes: ['ATest', 'BTest'] }, 'linux') === './gradlew -q test --tests ATest --tests BTest');
    check('fillScoped: maven joins with commas', fillScoped('mvn -q test -Dtest={classes}', { classes: ['ATest', 'BTest'] }, 'linux') === 'mvn -q test -Dtest=ATest,BTest');
    check('fillScoped: dotnet filter alternatives quoted', fillScoped('dotnet test --nologo --filter FullyQualifiedName~{classes}', { classes: ['A', 'B'] }, 'linux') === "dotnet test --nologo --filter 'FullyQualifiedName~A|FullyQualifiedName~B'");
    check('fillScoped: cargo -p per crate', fillScoped('cargo test -q -p {crate}', { pkgs: ['a', 'b'] }, 'linux') === 'cargo test -q -p a -p b');

    // ---- commandGuard ----
    const specs = [{ command: 'node_modules/.bin/tsc --noEmit -p tsconfig.json' }, { command: 'pnpm test', scopedFilled: [filled!] }];
    check('isSafeHealingCheck: exact command', isSafeHealingCheck('node_modules/.bin/tsc --noEmit -p tsconfig.json', specs));
    check('isSafeHealingCheck: exact filled scoped', isSafeHealingCheck(filled!, specs));
    check(
      'isSafeHealingCheck: no prefix/suffix/whitespace variants',
      !isSafeHealingCheck('node_modules/.bin/tsc --noEmit -p tsconfig.json && rm -rf /', specs) && !isSafeHealingCheck(' pnpm test', specs) && !isSafeHealingCheck('pnpm test --watch', specs) && !isSafeHealingCheck('', [{ command: '' }]),
    );
    // Today's verdicts, untouched: the guard matches `tsc` by basename; wrappers and `<pm> exec` are not safe.
    check('isReadOnlyOrSafe unchanged', isReadOnlyOrSafe('node_modules/.bin/tsc --noEmit').ok && !isReadOnlyOrSafe('./gradlew -q test').ok && !isReadOnlyOrSafe('./mvnw -q test').ok && !isReadOnlyOrSafe('pnpm exec jest --config x').ok);
    check('isReadOnlyOrSafe still allows routine tasks', isReadOnlyOrSafe('npm test').ok && isReadOnlyOrSafe('npx tsc --noEmit').ok);

    // ---- precedence + trust ----
    const prec = ws({
      'package.json': JSON.stringify({ scripts: { lint: 'eslint .', test: 'mocha', typecheck: 'tsc --noEmit' } }),
      '.localpilot/checks.json': JSON.stringify({
        checks: [
          { id: 'npm:test', command: 'npm run test:unit' },
          { id: 'custom:e2e', kind: 'test', command: 'npm run e2e', when: ['src/api/**'], required: false },
          { id: 'bad', command: 'x' },
        ],
        disable: ['npm:lint'],
        timeBudgetSeconds: 1200,
      }),
    });
    const settingChecks = [{ id: 'npm:test', kind: 'test', command: 'npm run from-setting' }, { id: 'npm:typecheck', kind: 'typecheck', command: 'npm run tc2', timeoutSeconds: 99 }];
    const ps = await discoverChecks(prec, { trusted: true, settingChecks });
    check('precedence: checks.json beats setting', byId(ps, 'npm:test')?.command === 'npm run test:unit' && byId(ps, 'npm:test')?.source === 'checks.json', byId(ps, 'npm:test'));
    check('precedence: changed command drops stale scoped template', byId(ps, 'npm:test')?.scoped === undefined);
    check('precedence: setting beats discovery', byId(ps, 'npm:typecheck')?.command === 'npm run tc2' && byId(ps, 'npm:typecheck')?.timeoutSeconds === 99 && byId(ps, 'npm:typecheck')?.source === 'setting');
    check('disable drops npm:lint; partial new id ignored', !byId(ps, 'npm:lint') && !byId(ps, 'bad'), ids(ps));
    check('custom check added with when + budget', byId(ps, 'custom:e2e')?.ecosystem === 'custom' && ps.timeBudgetSeconds === 1200);
    check('when globs scope custom checks', isInCheckScope('src/api/x.go', [byId(ps, 'custom:e2e')!]) && !isInCheckScope('src/web/x.go', [byId(ps, 'custom:e2e')!]));
    const un = await discoverChecks(prec, { trusted: false });
    check(
      'untrusted: checks.json ignored',
      byId(un, 'npm:test')?.command === 'npm test' && byId(un, 'npm:test')?.scoped === 'npm exec --no -- mocha {tests}' && !!byId(un, 'npm:lint') && !byId(un, 'custom:e2e') && byId(un, 'npm:typecheck')?.command === 'npm run typecheck' && un.timeBudgetSeconds === undefined,
      un,
    );
    // The caller passes only the User value when untrusted; it still applies.
    const unUser = await discoverChecks(prec, { trusted: false, settingChecks });
    check(
      'untrusted: (user) setting checks still apply, checks.json still ignored',
      byId(unUser, 'npm:test')?.command === 'npm run from-setting' && byId(unUser, 'npm:typecheck')?.command === 'npm run tc2' && !!byId(unUser, 'npm:lint') && !byId(unUser, 'custom:e2e'),
      unUser,
    );
    const loaded = await loadChecksFile(prec);
    check('loadChecksFile sanitises', loaded?.checks?.length === 3 && loaded.disable?.[0] === 'npm:lint');
    check('CHECKS_TEMPLATE parses', Array.isArray((JSON.parse(CHECKS_TEMPLATE) as { checks: unknown[] }).checks));

    const placeholder = ws({ 'package.json': JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }) });
    check('npm placeholder test ignored; no tsc without node_modules', (await discoverChecks(placeholder, { trusted: true })).length === 0);

    const bun = ws({ 'package.json': JSON.stringify({ scripts: { test: 'mocha', lint: 'eslint .' } }), 'bun.lockb': '' });
    const bs = await discoverChecks(bun, { trusted: true });
    check('bun: test script via `bun run test`, never the built-in `bun test`', byId(bs, 'npm:test')?.command === 'bun run test' && byId(bs, 'npm:lint')?.command === 'bun run lint', bs);
    check('bun: package.json scripts are check-defining for `bun run test`', definitionBodies([byId(bs, 'npm:test')!], bun).includes('"mocha"'));

    const vitest = ws({ 'package.json': JSON.stringify({ scripts: { test: 'vitest' } }), 'yarn.lock': '' });
    check('vitest scoped template (yarn)', byId(await discoverChecks(vitest, { trusted: true }), 'npm:test')?.scoped === 'yarn vitest related --run {files}');

    // ---- monorepo ----
    const mono = ws({
      'package.json': JSON.stringify({ private: true, scripts: { lint: 'eslint .' } }),
      'package-lock.json': '{}',
      'packages/a/package.json': JSON.stringify({ scripts: { test: 'node --test' } }),
      'packages/a/src/x.ts': '',
    });
    const ms = await discoverChecks(mono, { trusted: true, changedFiles: ['packages/a/src/x.ts'] });
    check('monorepo: nearest manifest folder discovered with cwd', byId(ms, 'npm:test@packages/a')?.cwd === 'packages/a' && byId(ms, 'npm:test@packages/a')?.scoped === 'node --test {tests}' && !!byId(ms, 'npm:lint'), ids(ms));
    check('monorepo: scope under the package cwd', isInCheckScope('packages/a/src/x.ts', [byId(ms, 'npm:test@packages/a')!]) && !isInCheckScope('packages/b/src/x.ts', [byId(ms, 'npm:test@packages/a')!]));
    check('monorepo: package.json of the package is check-defining', checkDefiningFiles([byId(ms, 'npm:test@packages/a')!], mono).includes('packages/a/package.json'));

    // ---- Python ----
    const py = ws({ 'pyproject.toml': '[tool.ruff]\nline-length = 100\n[tool.mypy]\nstrict = true\n', 'pkg/foo.py': '', 'tests/test_foo.py': '', 'conftest.py': '' });
    const pys = await discoverChecks(py, { trusted: true });
    check('python: compileall, mypy, ruff, pytest', ['mypy', 'pytest', 'python:compile', 'ruff'].every((i) => !!byId(pys, i)) && byId(pys, 'pytest')?.scoped === 'python -m pytest -q {tests}', ids(pys));
    const pyAff = await affectedTests(['pkg/foo.py'], py, 'python');
    check('python testMap: pkg/foo.py -> tests/test_foo.py', pyAff.tests.includes('tests/test_foo.py'), pyAff);
    check('python: conftest.py is check-defining', checkDefiningFiles(pys, py).includes('**/conftest.py'));

    // ---- Go ----
    const go = ws({ 'go.mod': 'module x\n', 'internal/a/a.go': '', 'main.go': '' });
    const gos = await discoverChecks(go, { trusted: true });
    check('go: build, vet, test', ids(gos).join() === 'go:build,go:test,go:vet' && fastSpecs(gos).length === 1);
    const goAff = await affectedTests(['internal/a/a.go', 'main.go'], go, 'go');
    check('go testMap: package dirs', JSON.stringify(goAff.pkgs) === '["./internal/a","."]', goAff);

    // ---- Rust ----
    const rs = ws({ 'Cargo.toml': '[package]\nname = "demo"\n', 'rust-toolchain.toml': '[toolchain]\ncomponents = ["clippy"]\n', 'src/lib.rs': '' });
    const rss = await discoverChecks(rs, { trusted: true });
    check('rust: check, clippy, test; no build', !!byId(rss, 'cargo:check') && !!byId(rss, 'cargo:clippy') && !!byId(rss, 'cargo:test') && !rss.some((s) => s.kind === 'build'));
    const rsAff = await affectedTests(['src/lib.rs'], rs, 'rust');
    check('rust testMap: crate name', rsAff.pkgs[0] === 'demo', rsAff);
    const rs2 = ws({ 'Cargo.toml': '[package]\nauthors = ["A", "B"]\nedition = "2021"\nname = "demo2"\n\n[dependencies]\nname = "nope"\n', 'src/lib.rs': '' });
    const rs2Aff = await affectedTests(['src/lib.rs'], rs2, 'rust');
    check('rust testMap: crate name after an array value', JSON.stringify(rs2Aff.pkgs) === '["demo2"]', rs2Aff);
    const rs3 = ws({ 'Cargo.toml': '[workspace]\nmembers = ["a"]\n[dependencies]\nname = "nope"\n', 'src/lib.rs': '' });
    check('rust testMap: no [package] name -> no crate', (await affectedTests(['src/lib.rs'], rs3, 'rust')).pkgs.length === 0);

    // ---- Maven / Gradle / .NET ----
    const mvn = ws({ 'pom.xml': '<project/>', mvnw: '#!/bin/sh\n', 'src/main/java/Foo.java': '', 'src/test/java/FooTest.java': '' });
    const mvs = await discoverChecks(mvn, { trusted: true });
    check('maven: ./mvnw preferred', byId(mvs, 'maven:test')?.command === './mvnw -q test' && byId(mvs, 'maven:compile')?.command === './mvnw -q -DskipTests compile');
    check('maven: no fast specs (baseline skipped)', fastSpecs(mvs).length === 0);
    check('maven: mvnw is check-defining and in the hash', checkDefiningFiles(mvs, mvn).includes('mvnw') && definitionBodies(mvs, mvn).includes('== mvnw =='));
    const mvAff = await affectedTests(['src/main/java/Foo.java'], mvn, 'maven');
    check('jvm testMap: Foo -> FooTest', JSON.stringify(mvAff.classes) === '["FooTest"]', mvAff);

    const gr = ws({ 'build.gradle.kts': 'plugins { kotlin("jvm") }', gradlew: '' });
    check('gradle: kotlin compile via ./gradlew', byId(await discoverChecks(gr, { trusted: true }), 'gradle:compile')?.command === './gradlew -q compileKotlin');

    const net = ws({ 'App.sln': '', 'App.csproj': '' });
    const nets = await discoverChecks(net, { trusted: true });
    check('.NET: build/test naming the solution', byId(nets, 'dotnet:build')?.command === 'dotnet build App.sln --nologo -v q' && !!byId(nets, 'dotnet:test')?.scoped);

    // ---- Make ----
    const mk = ws({ Makefile: 'CC := gcc\n.PHONY: test lint\nlint:\n\t./tools/lint.sh\ntest: lint\n\tgo test ./...\n', 'tools/lint.sh': 'echo lint' });
    const mks = await discoverChecks(mk, { trusted: true });
    check('make: lint + test targets', byId(mks, 'make:test')?.command === 'make -s test' && !!byId(mks, 'make:lint') && !byId(mks, 'make:build'), ids(mks));
    const mkBody = definitionBodies(mks, mk);
    check('make: recipes and wrapper in definition bodies', mkBody.includes('go test ./...') && mkBody.includes('echo lint') && checkDefiningFiles(mks, mk).includes('tools/lint.sh'), mkBody);

    // ---- cache ----
    const before = await discoverChecks(go, { trusted: true });
    fs.writeFileSync(path.join(go, 'Makefile'), 'build:\n\tgo build\ntypecheck:\n\tgo vet\n');
    const bump = new Date(Date.now() + 5000);
    fs.utimesSync(go, bump, bump);
    const after = await discoverChecks(go, { trusted: true });
    check('cache invalidated on manifest change; make fills only uncovered kinds', before.length === 3 && !!byId(after, 'make:typecheck') && !after.some((s) => s.id === 'make:build'), ids(after));
    clearChecksCache();
  } finally {
    for (const t of temps) {
      fs.rmSync(t, { recursive: true, force: true });
    }
  }
}
