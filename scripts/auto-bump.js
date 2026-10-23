#!/usr/bin/env node
/**
 * Decide whether the commits since a tag earn an automatic release, and which bump.
 *   node scripts/auto-bump.js v0.2.7      → prints "patch", "minor", "major" or nothing
 *
 * Used by the Release workflow on every push to main whose version is already tagged.
 *   - "[skip release]" / "[release skip]" in any commit message        → nothing
 *   - "[release major|minor|patch]" in any commit message             → that bump (highest wins)
 *   - a breaking conventional commit ("feat!:", "BREAKING CHANGE:")   → minor (the project is 0.x)
 *   - at least one feat / fix / perf / refactor / other code commit   → patch
 *   - only docs / chore / ci / build / test / style / release commits → nothing
 */
const { execSync } = require('child_process');

const sinceTag = process.argv[2];
const range = sinceTag ? `${sinceTag}..HEAD` : 'HEAD';
const raw = execSync(`git log ${range} --no-merges --format=%B%x00`, { encoding: 'utf8' });
const messages = raw.split('\0').map((m) => m.trim()).filter(Boolean);

const SKIPPED_TYPES = /^(docs|site|copy|readme|chore|ci|build|test|tests|style|wip|merge|release)$/;
const ORDER = { patch: 1, minor: 2, major: 3 };
let bump = '';
const raise = (level) => {
  if (ORDER[level] > (ORDER[bump] || 0)) {
    bump = level;
  }
};

for (const message of messages) {
  if (/\[(skip release|release skip)\]/i.test(message)) {
    process.exit(0);
  }
  const forced = message.match(/\[release (major|minor|patch)\]/i);
  if (forced) {
    raise(forced[1].toLowerCase());
    continue;
  }
  const subject = message.split('\n', 1)[0];
  if (/^release: v?\d/.test(subject)) {
    continue;
  }
  const m = subject.match(/^(\w+)(?:\([^)]*\))?(!)?:\s*/);
  const type = m ? m[1].toLowerCase() : '';
  const breaking = (m && m[2]) || /^BREAKING CHANGE:/m.test(message);
  if (breaking) {
    raise('minor');
  } else if (!SKIPPED_TYPES.test(type)) {
    raise('patch');
  }
}

if (bump) {
  process.stdout.write(bump);
}
