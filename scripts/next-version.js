/**
 * The version after `current` for a bump level, by plain semantic versioning: a patch bump raises the patch part
 * (1.9.9 → 1.9.10, never a rollover into the minor or major), a minor bump resets the patch (1.3.4 → 1.4.0) and a
 * major bump resets both (1.3.4 → 2.0.0). Pre-release or build suffixes on `current` are dropped.
 */
function nextVersion(current, level) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(current).trim());
  if (!m) {
    throw new Error(`not a version: ${current}`);
  }
  const [maj, min, pat] = m.slice(1).map(Number);
  if (level === 'major') {
    return `${maj + 1}.0.0`;
  }
  if (level === 'minor') {
    return `${maj}.${min + 1}.0`;
  }
  if (level === 'patch') {
    return `${maj}.${min}.${pat + 1}`;
  }
  throw new Error(`unknown bump level: ${level}`);
}

module.exports = { nextVersion };
