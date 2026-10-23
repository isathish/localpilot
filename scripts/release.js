#!/usr/bin/env node
/**
 * Cut a release end to end:
 *   npm run release -- 0.2.0        (or: patch | minor | major)
 * Bumps package.json + docs/_config.yml, promotes the "Unreleased" changelog section,
 * runs the full verification, commits, tags vX.Y.Z and pushes. The Release workflow does the rest.
 */
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const sh = (cmd, opts = {}) => execSync(cmd, { cwd: root, stdio: opts.quiet ? 'pipe' : 'inherit', encoding: 'utf8' });
const fail = (msg) => {
  console.error(`\nrelease: ${msg}`);
  process.exit(1);
};

const arg = process.argv[2];
if (!arg) {
  fail('usage: npm run release -- <version|patch|minor|major>');
}

const pkgPath = path.join(root, 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
const [maj, min, pat] = pkg.version.split('.').map(Number);
const next =
  arg === 'patch' ? `${maj}.${min}.${pat + 1}` : arg === 'minor' ? `${maj}.${min + 1}.0` : arg === 'major' ? `${maj + 1}.0.0` : arg.replace(/^v/, '');
if (!/^\d+\.\d+\.\d+$/.test(next)) {
  fail(`invalid version "${next}"`);
}

if (sh('git status --porcelain', { quiet: true }).trim()) {
  fail('working tree is not clean — commit or stash first');
}
if (sh('git rev-parse --abbrev-ref HEAD', { quiet: true }).trim() !== 'main') {
  fail('releases are cut from main');
}
sh('git fetch --tags origin', { quiet: true });
if (sh('git tag -l', { quiet: true }).split('\n').includes(`v${next}`)) {
  fail(`tag v${next} already exists`);
}

// Changelog: promote "## Unreleased" or require an existing section for this version.
const clPath = path.join(root, 'CHANGELOG.md');
let changelog = fs.readFileSync(clPath, 'utf8');
const today = new Date().toISOString().slice(0, 10);
if (/^## Unreleased\s*$/m.test(changelog)) {
  changelog = changelog.replace(/^## Unreleased\s*$/m, `## ${next} — ${today}`);
} else if (!changelog.includes(`## ${next}`)) {
  fail(`CHANGELOG.md has no "## Unreleased" or "## ${next}" section`);
}
fs.writeFileSync(clPath, changelog);

pkg.version = next;
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');

const lockPath = path.join(root, 'package-lock.json');
if (fs.existsSync(lockPath)) {
  const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  lock.version = next;
  if (lock.packages && lock.packages['']) {
    lock.packages[''].version = next;
  }
  fs.writeFileSync(lockPath, JSON.stringify(lock, null, 2) + '\n');
}

const cfgPath = path.join(root, 'docs', '_config.yml');
fs.writeFileSync(cfgPath, fs.readFileSync(cfgPath, 'utf8').replace(/^version:.*$/m, `version: ${next}`));

console.log(`\nrelease: verifying ${next}…`);
sh('npm run compile');
sh('npm run smoke');
sh('npx @vscode/vsce package --no-dependencies --readme-path MARKETPLACE.md --out /tmp/localpilot-release-check.vsix');

sh(`git add package.json package-lock.json CHANGELOG.md docs/_config.yml`);
sh(`git commit -m "release: v${next}"`);
sh(`git tag -a v${next} -m "LocalPilot v${next}"`);
sh('git push origin main');
sh(`git push origin v${next}`);
console.log(`\nrelease: v${next} pushed — follow the Release workflow at ${pkg.repository.url.replace(/\.git$/, '')}/actions`);
