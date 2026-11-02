/**
 * The version after `current` for a bump level. Each part counts 0–9 and carries into the one above, like a decimal
 * counter: 1.2.9 → 1.3.0 and 1.3.9 → 1.4.0 on a patch, 1.9.9 → 2.0.0, and a minor bump from 1.9.x gives 2.0.0.
 * A part already past 9 (1.3.11, from before the rule) carries on the next bump too.
 */
function nextVersion(current, level) {
  let [maj, min, pat] = current.split('.').map(Number);
  if (level === 'major') {
    return `${maj + 1}.0.0`;
  }
  if (level === 'patch') {
    pat += 1;
  }
  if (level === 'minor' || pat > 9) {
    min += 1;
    pat = 0;
  }
  if (min > 9) {
    maj += 1;
    min = 0;
    pat = 0;
  }
  return `${maj}.${min}.${pat}`;
}

module.exports = { nextVersion };
