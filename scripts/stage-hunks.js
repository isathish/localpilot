// Stage only the hunks of a file that mention one of the given keywords (used when a working tree has
// unrelated edits from someone else). Usage: node scripts/stage-hunks.js <file> <keyword> [keyword…]
// Not part of the product; a maintenance helper.
const { execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const [file, ...keywords] = process.argv.slice(2);
if (!file || !keywords.length) {
  console.error('usage: node scripts/stage-hunks.js <file> <keyword> [keyword…]');
  process.exit(2);
}
const diff = execSync(`git diff -U3 -- "${file}"`, { encoding: 'utf8' });
const lines = diff.split('\n');
const headerEnd = lines.findIndex((l) => l.startsWith('@@'));
if (headerEnd < 0) {
  console.log('no changes');
  process.exit(0);
}
const header = lines.slice(0, headerEnd);
const hunks = [];
let cur = null;
for (const l of lines.slice(headerEnd)) {
  if (l.startsWith('@@')) {
    cur = [l];
    hunks.push(cur);
  } else if (cur) {
    cur.push(l);
  }
}
const keep = hunks.filter((h) => h.some((l) => /^[+-]/.test(l) && keywords.some((k) => l.includes(k))));
if (!keep.length) {
  console.log('no matching hunks');
  process.exit(0);
}
const patch = [...header, ...keep.flat()].join('\n').replace(/\n*$/, '\n');
const tmp = path.join(os.tmpdir(), `stage-${Date.now()}.patch`);
fs.writeFileSync(tmp, patch);
execSync(`git apply --cached --recount "${tmp}"`, { stdio: 'inherit' });
fs.unlinkSync(tmp);
console.log(`staged ${keep.length}/${hunks.length} hunk(s) of ${file}`);
