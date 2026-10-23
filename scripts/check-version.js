#!/usr/bin/env node
/**
 * Verifies that everything that carries the version agrees, so a release can never ship with
 * mismatched metadata or empty release notes:
 *   - package.json, package-lock.json (root + packages[""]) and docs/_config.yml have the same version
 *   - CHANGELOG.md has a "## <version>" section with at least one entry
 *   - @types/vscode is not newer than engines.vscode (the Marketplace rejects installs otherwise)
 * Usage: node scripts/check-version.js [--quiet]      (also: npm run check:version)
 */
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const errors = [];

const pkg = JSON.parse(read('package.json'));
const version = pkg.version;
if (!/^\d+\.\d+\.\d+$/.test(version)) {
  errors.push(`package.json version "${version}" is not X.Y.Z`);
}

if (fs.existsSync(path.join(root, 'package-lock.json'))) {
  const lock = JSON.parse(read('package-lock.json'));
  if (lock.version !== version) {
    errors.push(`package-lock.json version is ${lock.version}, package.json is ${version}`);
  }
  const rootPkg = lock.packages && lock.packages[''];
  if (rootPkg && rootPkg.version !== version) {
    errors.push(`package-lock.json packages[""].version is ${rootPkg.version}, package.json is ${version}`);
  }
}

const cfg = read('docs/_config.yml');
const cfgVersion = (cfg.match(/^version:\s*(\S+)\s*$/m) || [])[1];
if (cfgVersion !== version) {
  errors.push(`docs/_config.yml version is ${cfgVersion || '(missing)'}, package.json is ${version}`);
}

const changelog = read('CHANGELOG.md');
const section = changelogSection(changelog, version);
if (section === null) {
  errors.push(`CHANGELOG.md has no "## ${version}" section (run "npm run release" to generate one from commits, or add it)`);
} else if (!/^\s*[-*] /m.test(section)) {
  errors.push(`CHANGELOG.md section "## ${version}" has no entries`);
}

const engine = ((pkg.engines && pkg.engines.vscode) || '').replace(/^[\^~>=]+/, '');
const types = ((pkg.devDependencies && pkg.devDependencies['@types/vscode']) || '').replace(/^[\^~>=]+/, '');
if (engine && types && compareMinor(types, engine) > 0) {
  errors.push(`@types/vscode ${types} is newer than engines.vscode ${engine}; VS Code older than ${types} would refuse to install the extension`);
}

if (errors.length) {
  for (const e of errors) {
    console.error(`check-version: ${e}`);
  }
  process.exit(1);
}
if (!process.argv.includes('--quiet')) {
  console.log(`check-version: ${version} is consistent across package.json, package-lock.json, docs/_config.yml and CHANGELOG.md`);
}

function changelogSection(text, v) {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => new RegExp(`^## \\[?v?${v.replace(/\./g, '\\.')}\\]?(\\s|$)`).test(l));
  if (start < 0) {
    return null;
  }
  let end = lines.findIndex((l, i) => i > start && /^## /.test(l));
  if (end < 0) {
    end = lines.length;
  }
  return lines.slice(start + 1, end).join('\n');
}

function compareMinor(a, b) {
  const [a1, a2] = a.split('.').map(Number);
  const [b1, b2] = b.split('.').map(Number);
  return a1 !== b1 ? a1 - b1 : a2 - b2;
}
