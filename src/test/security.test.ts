import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { cvss3BaseScore, osvSeverity, parseLockfile, scanWorkspace } from '../security/scan';

const names = (file: string, text: string) =>
  parseLockfile(file, text)
    .map((d) => `${d.name}@${d.version}`)
    .sort()
    .join(' ');
const crlf = (s: string) => s.replace(/\n/g, '\r\n');

const YARN = '"@s/p@^1.0.0", "@s/p@^1.1":\n  version "1.2.0"\n  resolved "x"\n\nlodash@^4:\n  version "4.17.21"\n';
const GEMFILE = 'GEM\n  remote: https://rubygems.org/\n  specs:\n    rack (2.0.1)\n    nokogiri (1.10.0-x86_64-linux)\n      racc (~> 1.4)\n\nPLATFORMS\n  ruby\n\nDEPENDENCIES\n  rack\n';

suite('LocalPilot security scan', () => {
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
      await assert.rejects(scanWorkspace(root, { kinds, path: 'nope' }), /No files under "nope"/);
      await assert.rejects(scanWorkspace(root, { kinds, path: '../x' }), /outside the workspace/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
