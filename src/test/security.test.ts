import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { checkDependencies, cvss3BaseScore, osvFixes, osvSeverity, parseLockfile, ScanResult, scanText, scanWorkspace, toSarif } from '../security/scan';

const names = (file: string, text: string) =>
  parseLockfile(file, text)
    .map((d) => `${d.name}@${d.version}`)
    .sort()
    .join(' ');
const crlf = (s: string) => s.replace(/\n/g, '\r\n');

const YARN = '"@s/p@^1.0.0", "@s/p@^1.1":\n  version "1.2.0"\n  resolved "x"\n\nlodash@^4:\n  version "4.17.21"\n';
const GEMFILE = 'GEM\n  remote: https://rubygems.org/\n  specs:\n    rack (2.0.1)\n    nokogiri (1.10.0-x86_64-linux)\n      racc (~> 1.4)\n\nPLATFORMS\n  ruby\n\nDEPENDENCIES\n  rack\n';

suite('LocalPilot security scan', () => {
  test('workspace and local packages are not sent to OSV.dev', () => {
    const npm = JSON.stringify({ lockfileVersion: 3, packages: { '': { name: 'root', version: '1.0.0' }, 'packages/core': { version: '2.0.0' }, 'node_modules/e': { version: '1.0.0' }, 'packages/core/node_modules/f': { version: '3.0.0' } } });
    assert.strictEqual(names('package-lock.json', npm), 'e@1.0.0 f@3.0.0');
    const npmWs = JSON.stringify({ lockfileVersion: 3, packages: { 'packages/e': { name: 'e', version: '2.0.0' } } });
    assert.strictEqual(names('package-lock.json', npmWs), '');
    assert.strictEqual(names('yarn.lock', '"my-app@workspace:.":\n  version: 0.0.0-use.local\n\n"lodash@npm:^4":\n  version: 4.17.21\n'), 'lodash@4.17.21');
    assert.strictEqual(names('uv.lock', '[[package]]\nname = "app"\nversion = "0.1.0"\nsource = { editable = "." }\n\n[[package]]\nname = "rich"\nversion = "13.0.0"\nsource = { registry = "https://pypi.org/simple" }\n'), 'rich@13.0.0');
    assert.strictEqual(names('poetry.lock', '[[package]]\nname = "lib"\nversion = "0.1.0"\n\n[package.source]\ntype = "directory"\nurl = "../lib"\n\n[[package]]\nname = "rich"\nversion = "13.0.0"\n'), 'rich@13.0.0');
  });

  test('yarn.lock and Gemfile.lock parse the same with LF and CRLF line endings', () => {
    assert.strictEqual(names('yarn.lock', YARN), '@s/p@1.2.0 lodash@4.17.21');
    assert.strictEqual(names('yarn.lock', crlf(YARN)), '@s/p@1.2.0 lodash@4.17.21');
    assert.strictEqual(names('Gemfile.lock', GEMFILE), 'nokogiri@1.10.0 rack@2.0.1');
    assert.strictEqual(names('Gemfile.lock', crlf(GEMFILE)), 'nokogiri@1.10.0 rack@2.0.1');
    assert.strictEqual(names('Gemfile.lock', `\uFEFF${crlf(GEMFILE)}`), 'nokogiri@1.10.0 rack@2.0.1');
  });

  test('Gemfile.lock: only GEM sections count, and every one of them', () => {
    const mixed =
      'GIT\n  remote: https://github.com/x/y.git\n  revision: abc\n  specs:\n    y (0.1.0)\n\n' +
      'PATH\n  remote: .\n  specs:\n    mygem (1.0.0)\n      rack\n\n' +
      'GEM\n  remote: https://rubygems.org/\n  specs:\n    rack (2.0.1)\n\n' +
      'PLATFORMS\n  ruby\n';
    assert.strictEqual(names('Gemfile.lock', mixed), 'rack@2.0.1');
    const two = 'GEM\n  remote: https://rubygems.org/\n  specs:\n    rack (2.0.1)\n\nGEM\n  remote: https://gems.example.com/\n  specs:\n    private-gem (3.1.0)\n\nPLATFORMS\n  ruby\n';
    assert.strictEqual(names('Gemfile.lock', two), 'private-gem@3.1.0 rack@2.0.1');
  });

  test('OSV severity from CVSS v3 vectors, malicious-package records and bare scores', () => {
    assert.strictEqual(cvss3BaseScore('CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H'), 9.8);
    assert.strictEqual(cvss3BaseScore('CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:C/C:H/I:H/A:H'), 10);
    assert.strictEqual(osvSeverity({ id: 'x', severity: [{ type: 'CVSS_V3', score: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H' }] }), 'critical');
    assert.strictEqual(osvSeverity({ id: 'x', severity: [{ type: 'CVSS_V3', score: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:L' }] }), 'medium');
    assert.strictEqual(osvSeverity({ id: 'MAL-2025-1' }), 'critical');
    assert.strictEqual(osvSeverity({ id: 'x', severity: [{ type: 'CVSS_V3', score: '9.8' }] }), 'critical');
    assert.strictEqual(osvSeverity({ id: 'x', affected: [{ ecosystem_specific: { severity: 'HIGH' } }] }), 'high');
    assert.strictEqual(osvSeverity({ id: 'RUSTSEC-2020-1', affected: [{ database_specific: { informational: 'unmaintained' } }] }), 'low');
  });

  test('scanWorkspace accepts ".", the absolute root and sub-folders, and rejects a folder with no files', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lp-scan-'));
    try {
      fs.mkdirSync(path.join(root, 'src'));
      fs.writeFileSync(path.join(root, 'src', 'a.ts'), 'export const a = 1;\n');
      fs.writeFileSync(path.join(root, 'b.py'), 'print(1)\n');
      const kinds = { dependencies: false, secrets: true, code: true };
      assert.strictEqual((await scanWorkspace(root, { kinds, path: '.' })).files, 2);
      assert.strictEqual((await scanWorkspace(root, { kinds, path: root })).files, 2);
      assert.strictEqual((await scanWorkspace(root, { kinds, path: './src/' })).files, 1);
      assert.strictEqual((await scanWorkspace(root, { kinds: { dependencies: false, secrets: false, code: false } })).files, 0);
      await assert.rejects(scanWorkspace(root, { kinds, path: 'nope' }), /No such file or folder: nope/);
      fs.mkdirSync(path.join(root, 'empty'));
      await assert.rejects(scanWorkspace(root, { kinds, path: 'empty' }), /No files under "empty"/);
      await assert.rejects(scanWorkspace(root, { kinds, path: '../x' }), /outside the workspace/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('PyPI names are PEP 503 normalised and GIT ranges give no fix versions', () => {
    assert.strictEqual(names('requirements.txt', 'jupyter_server==2.14.2'), 'jupyter-server@2.14.2');
    assert.strictEqual(names('poetry.lock', '[[package]]\nname = "Zope.Interface"\nversion = "5.0.0"\n'), 'zope-interface@5.0.0');
    const v = { id: 'GHSA-j', affected: [{ package: { name: 'jupyter-server', ecosystem: 'PyPI' }, ranges: [{ type: 'GIT', events: [{ introduced: '0' }, { fixed: 'a1b2c3d4e5' }] }, { type: 'ECOSYSTEM', events: [{ introduced: '0' }, { fixed: '2.14.3' }] }] }] };
    assert.deepStrictEqual(osvFixes(v, { name: 'jupyter_server', ecosystem: 'PyPI' }), ['2.14.3']);
  });

  test('go.mod: replace rewrites or drops requirements, exclude is ignored', () => {
    const gomod = 'module x\n\ngo 1.22\n\nrequire (\n\tgolang.org/x/net v0.0.0 // indirect\n\texample.com/forked v1.2.0\n\tgithub.com/c/d v2.0.0+incompatible\n)\nrequire github.com/a/b v1.2.3\n\nreplace (\n\tgolang.org/x/net => golang.org/x/net v0.0.1\n\texample.com/forked v1.2.0 => ../forked\n)\n\nexclude (\n\texample.com/bad v0.9.0\n)\nexclude example.com/bad v0.9.1\n';
    assert.strictEqual(names('go.mod', gomod), 'github.com/a/b@v1.2.3 github.com/c/d@v2.0.0 golang.org/x/net@v0.0.1');
  });

  const ghsa = { id: 'GHSA-1', summary: 'Bad thing', database_specific: { severity: 'HIGH' }, affected: [{ package: { name: 'left-pad', ecosystem: 'npm' }, ranges: [{ type: 'SEMVER', events: [{ introduced: '0' }, { fixed: '1.3.0' }] }] }] };
  const fakeOsv = (detail: (url: string) => { ok: boolean; status: number; body?: unknown }) =>
    (async (url: string, init?: { body?: string }) => {
      if (String(url).includes('querybatch')) {
        const queries = (JSON.parse(init?.body ?? '{}') as { queries: unknown[] }).queries;
        return { ok: true, status: 200, json: async () => ({ results: queries.map(() => ({ vulns: [{ id: 'GHSA-1' }] })) }) };
      }
      const r = detail(String(url));
      return { ok: r.ok, status: r.status, statusText: '', json: async () => r.body };
    }) as unknown as typeof fetch;

  test('the same package and version in two lockfiles is reported against each', async () => {
    const deps = [
      { ecosystem: 'npm' as const, name: 'left-pad', version: '1.0.0', file: 'a/package-lock.json' },
      { ecosystem: 'npm' as const, name: 'left-pad', version: '1.0.0', file: 'b/package-lock.json' },
    ];
    const out = await checkDependencies(deps, { fetchImpl: fakeOsv(() => ({ ok: true, status: 200, body: ghsa })) });
    assert.deepStrictEqual(out.map((f) => f.file).sort(), ['a/package-lock.json', 'b/package-lock.json']);
    assert.ok(out.every((f) => f.title === 'Bad thing' && f.severity === 'high' && f.fix === 'upgrade left-pad to 1.3.0'));
  });

  test('advisory details OSV.dev cannot serve are reported as skipped, not silently downgraded', async function () {
    this.timeout(10_000);
    const skipped: string[] = [];
    let calls = 0;
    const out = await checkDependencies([{ ecosystem: 'npm', name: 'left-pad', version: '1.0.0', file: 'package-lock.json' }], {
      fetchImpl: fakeOsv(() => (calls++, { ok: false, status: 503 })),
      onSkip: (t) => skipped.push(t),
    });
    assert.strictEqual(calls, 2, 'retried once');
    assert.deepStrictEqual(skipped, ['dependencies: details for 1 advisory could not be fetched']);
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].title, 'GHSA-1 (details unavailable)');
  });

  test('hard-coded credentials inside identifiers, unquoted .env values and PGP keys are found; placeholders are not', () => {
    const ids = (file: string, text: string) => scanText(file, text, { secrets: true, code: false }).map((f) => f.id);
    assert.deepStrictEqual(ids('config.py', 'DB_PASSWORD = "x9Fq2LmZ8vR1tY6wB3nC"'), ['hardcoded-credential']);
    assert.deepStrictEqual(ids('src/db.ts', 'const dbPassword = "x9Fq2LmZ8vR1tY6wB3nC";'), ['hardcoded-credential']);
    assert.deepStrictEqual(ids('.env', 'API_KEY=x9Fq2LmZ8vR1tY6wB3nC'), ['hardcoded-credential']);
    assert.deepStrictEqual(ids('src/a.ts', 'API_KEY=x9Fq2LmZ8vR1tY6wB3nC'), []);
    assert.deepStrictEqual(ids('config.py', 'password = "changeme"'), []);
    assert.deepStrictEqual(ids('app.yaml', 'password: ${DB_PASSWORD_FROM_ENV}'), []);
    assert.deepStrictEqual(ids('key.asc', '-----BEGIN PGP PRIVATE KEY BLOCK-----'), ['private-key']);
  });

  test('requirements layouts are read as lockfiles', () => {
    const req = 'Django==4.2.0\n';
    assert.strictEqual(names('dev-requirements.txt', req), 'django@4.2.0');
    assert.strictEqual(names('constraints.txt', req), 'django@4.2.0');
    assert.strictEqual(names('requirements/base.txt', req), 'django@4.2.0');
    assert.strictEqual(names('notes.txt', req), '');
  });

  test('SARIF rates a rule by its most severe finding and makes paths repository-relative', () => {
    const r: ScanResult = {
      root: '/r',
      prefix: 'sub',
      dependencies: 0,
      files: 2,
      skipped: [],
      findings: [
        { kind: 'code', severity: 'low', id: 'eval', title: 'eval / dynamic code', file: 'tests/a.ts', line: 1 },
        { kind: 'code', severity: 'high', id: 'eval', title: 'eval / dynamic code', file: 'src/a.ts', line: 1 },
      ],
    };
    const run = (toSarif(r, '0') as { runs: { tool: { driver: { rules: { properties: Record<string, string> }[] } }; results: { locations: { physicalLocation: { artifactLocation: { uri: string } } }[] }[] }[] }).runs[0];
    assert.strictEqual(run.tool.driver.rules.length, 1);
    assert.strictEqual(run.tool.driver.rules[0].properties['security-severity'], '8.0');
    assert.deepStrictEqual(run.results.map((x) => x.locations[0].physicalLocation.artifactLocation.uri), ['sub/tests/a.ts', 'sub/src/a.ts']);
  });

  test('unsupported lockfiles and a missing lockfile are reported, not silently clean', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lp-scan-'));
    try {
      fs.writeFileSync(path.join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');
      const r = await scanWorkspace(root, { kinds: { dependencies: true, secrets: false, code: false } });
      assert.deepStrictEqual(r.skipped.filter((t) => !t.startsWith('git ls-files failed')), ['dependencies: pnpm-lock.yaml is not supported, not checked', 'dependencies: no supported lockfile found']);
      assert.strictEqual(r.findings.length, 0);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
