#!/usr/bin/env node
/**
 * Prepare a release:
 *   npm run release -- patch            (or: minor | major | 1.2.3)
 *
 * 1. Picks the next version (or releases the version already in package.json if it has no tag yet).
 * 2. Updates package.json, package-lock.json and docs/_config.yml.
 * 3. Promotes the "## Unreleased" section of CHANGELOG.md to "## X.Y.Z — date". If there are no
 *    hand-written entries it generates them from the conventional commits since the previous tag
 *    (feat → Added, fix → Fixed, …) and leaves a fresh empty "## Unreleased" header for the next cycle.
 * 4. Verifies: check-version, compile, smoke, VSIX packaging.
 * 5. Commits "release: vX.Y.Z" and pushes main. The Release workflow then tests, tags, builds the VSIX,
 *    creates the GitHub Release and publishes to the Marketplace / Open VSX.
 *
 * Flags: --dry-run (change nothing, print the plan)  --no-push (commit only)  --no-verify (skip step 4)
 *        --ci (used by the "Prepare release" workflow: commits with the bot identity, no branch prompt)
 */
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith('--')));
const arg = args.find((a) => !a.startsWith('--'));
const dryRun = flags.has('--dry-run');
const sh = (cmd, opts = {}) => execSync(cmd, { cwd: root, stdio: opts.quiet ? 'pipe' : 'inherit', encoding: 'utf8' });
const out = (cmd) => sh(cmd, { quiet: true }).trim();
const fail = (msg) => {
  console.error(`\nrelease: ${msg}`);
  process.exit(1);
};
const log = (msg) => console.log(`release: ${msg}`);

if (!arg) {
  fail('usage: npm run release -- <patch|minor|major|X.Y.Z> [--dry-run] [--no-push] [--no-verify] [--ci]');
}

const pkgPath = path.join(root, 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
const current = pkg.version;

if (out('git status --porcelain')) {
  if (!dryRun) {
    fail('working tree is not clean; commit or stash first');
  }
  log('warning: working tree is not clean (allowed for --dry-run)');
}
if (out('git rev-parse --abbrev-ref HEAD') !== 'main' && !dryRun) {
  fail('releases are cut from main');
}
sh('git fetch --tags --quiet origin', { quiet: true });
const tags = out('git tag -l').split('\n').filter(Boolean);
const previousTag = out('git tag -l "v*" --sort=-v:refname | head -1');

// If package.json was already bumped by hand and that version has no tag, that is the pending release.
let next;
if (/^(patch|minor|major)$/.test(arg) && !tags.includes(`v${current}`) && previousTag && previousTag !== `v${current}`) {
  log(`package.json is already at ${current}, which has no tag yet; releasing it (pass an explicit version to override)`);
  next = current;
} else {
  const [maj, min, pat] = current.split('.').map(Number);
  next =
    arg === 'patch' ? `${maj}.${min}.${pat + 1}` : arg === 'minor' ? `${maj}.${min + 1}.0` : arg === 'major' ? `${maj + 1}.0.0` : arg.replace(/^v/, '');
}
if (!/^\d+\.\d+\.\d+$/.test(next)) {
  fail(`invalid version "${next}"`);
}
if (tags.includes(`v${next}`)) {
  fail(`tag v${next} already exists`);
}

// ---- changelog -------------------------------------------------------------------------------------
const clPath = path.join(root, 'CHANGELOG.md');
let changelog = fs.readFileSync(clPath, 'utf8');
const today = new Date().toISOString().slice(0, 10);
const heading = `## ${next} — ${today}`;
const sectionOf = (title) => {
  const re = new RegExp(`^## ${title}[^\\n]*\\n([\\s\\S]*?)(?=^## |(?![\\s\\S]))`, 'm');
  const m = changelog.match(re);
  return m ? { full: m[0], body: m[1] } : null;
};
const hasEntries = (s) => s && /^\s*[-*] /m.test(s.body);
const unreleased = sectionOf('Unreleased');
const existing = sectionOf(next.replace(/\./g, '\\.'));
let notesSource;

if (hasEntries(existing)) {
  notesSource = 'existing section';
  if (unreleased && !hasEntries(unreleased)) {
    changelog = changelog.replace(unreleased.full, '');
  }
} else if (hasEntries(unreleased)) {
  notesSource = 'Unreleased section';
  changelog = changelog.replace(unreleased.full, `## Unreleased\n\n${heading}\n${unreleased.body}`);
} else {
  const generated = notesFromCommits(previousTag);
  if (!generated) {
    fail(`CHANGELOG.md has no entries under "## Unreleased" or "## ${next}" and there are no releasable commits since ${previousTag || 'the beginning'}`);
  }
  notesSource = `commits since ${previousTag || 'the beginning'}`;
  const block = `## Unreleased\n\n${heading}\n${generated}\n`;
  if (unreleased) {
    changelog = changelog.replace(unreleased.full, block);
  } else if (existing) {
    changelog = changelog.replace(existing.full, block);
  } else {
    changelog = changelog.replace(/^(## )/m, `${block}$1`);
  }
}
if (!/^## Unreleased\s*$/m.test(changelog)) {
  changelog = changelog.replace(/^(## )/m, '## Unreleased\n\n$1');
}
changelog = changelog.replace(/\n{3,}/g, '\n\n');

// ---- plan / apply ----------------------------------------------------------------------------------
log(`${current} → ${next}  (notes from ${notesSource}; previous tag ${previousTag || 'none'})`);
if (dryRun) {
  const preview = (sectionOf(next.replace(/\./g, '\\.')) || { full: '' }).full;
  console.log(`\n${preview.trim()}\n\nrelease: dry run, nothing written`);
  process.exit(0);
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

sh('node scripts/check-version.js');
if (!flags.has('--no-verify')) {
  log(`verifying ${next}…`);
  sh('npm run compile');
  sh('npm run smoke');
  const vsix = path.join(require('os').tmpdir(), `localpilot-release-check-${next}.vsix`);
  sh(`npx @vscode/vsce package --no-dependencies --readme-path MARKETPLACE.md --out "${vsix}"`);
  fs.rmSync(vsix, { force: true });
}

const identity = flags.has('--ci') ? '-c user.name="github-actions[bot]" -c user.email="41898282+github-actions[bot]@users.noreply.github.com"' : '';
sh('git add package.json package-lock.json CHANGELOG.md docs/_config.yml');
sh(`git ${identity} commit -q -m "release: v${next}"`);
log(`committed release: v${next}`);

if (flags.has('--no-push')) {
  log('not pushed (--no-push). Push main to start the Release workflow.');
} else {
  sh('git push origin main');
  const repo = (pkg.repository && pkg.repository.url ? pkg.repository.url : '').replace(/\.git$/, '').replace(/^git\+/, '');
  log(`pushed. The Release workflow tests, tags v${next} and publishes: ${repo}/actions/workflows/release.yml`);
}

// ---- helpers ---------------------------------------------------------------------------------------
function notesFromCommits(sinceTag) {
  const range = sinceTag ? `${sinceTag}..HEAD` : 'HEAD';
  const subjects = out(`git log ${range} --no-merges --format=%s`).split('\n').map((s) => s.trim()).filter(Boolean);
  const groups = { Added: [], Changed: [], Fixed: [], Documentation: [] };
  const seen = new Set();
  for (const subject of subjects) {
    const m = subject.match(/^(\w+)(?:\([^)]*\))?(!)?:\s*(.+)$/);
    const type = m ? m[1].toLowerCase() : '';
    let text = m ? m[3] : subject;
    if (/^(release|chore|ci|build|test|tests|style|wip|merge)$/.test(type) || /^release: v?\d/.test(subject)) {
      continue;
    }
    text = text.replace(/\s+/g, ' ').trim();
    text = text.charAt(0).toUpperCase() + text.slice(1).replace(/\.$/, '');
    if (text.length > 160) {
      text = text.slice(0, 157).replace(/[\s,;:]+\S*$/, '') + '…';
    }
    if (seen.has(text.toLowerCase())) {
      continue;
    }
    seen.add(text.toLowerCase());
    if (m && m[2]) {
      text = `**Breaking:** ${text}`;
    }
    const bucket =
      type === 'feat' ? 'Added' : type === 'fix' ? 'Fixed' : /^(docs|site|copy|readme)$/.test(type) ? 'Documentation' : 'Changed';
    groups[bucket].push(`- ${text}`);
  }
  const parts = Object.entries(groups)
    .filter(([, items]) => items.length)
    .map(([title, items]) => `### ${title}\n${items.join('\n')}`);
  return parts.length ? `${parts.join('\n\n')}\n` : '';
}
