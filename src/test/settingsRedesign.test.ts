import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';

const EXT_ROOT = path.resolve(__dirname, '..', '..');
const read = (rel: string) => fs.readFileSync(path.join(EXT_ROOT, rel), 'utf8');

type Hit = { sec: string; key?: string; label: string };
/** Sections, sidebar groups, the search index and findSettings of `media/settings.js`, lifted out of the IIFE and run as is. */
function load(): { findSettings: (q: string) => Hit[]; SECTIONS: [string, string, string][]; NAV_HOME: string[]; NAV_GROUPS: { id: string; label: string; items: string[] }[]; NAV_GROUP_OF: Record<string, string>; FIELD_INDEX: [string, string, string][] } {
  const src = read('media/settings.js');
  const start = src.indexOf('  const I = {');
  const end = src.indexOf('  /** Remembered across reloads');
  assert.ok(start > 0 && end > start, 'icons, sections and findSettings not found in media/settings.js');
  const sb: Record<string, unknown> = {};
  vm.runInNewContext(`${src.slice(start, end)}\nout_ = { findSettings, SECTIONS, NAV_HOME, NAV_GROUPS, NAV_GROUP_OF, FIELD_INDEX };`, sb, { timeout: 5_000 });
  return sb.out_ as ReturnType<typeof load>;
}

suite('Settings redesign', () => {
  test('every section sits in the sidebar exactly once and has a group for its page eyebrow and search breadcrumb', () => {
    const { SECTIONS, NAV_HOME, NAV_GROUPS, NAV_GROUP_OF } = load();
    const order = [...NAV_HOME, ...NAV_GROUPS.flatMap((g) => g.items)];
    for (const [id, label, icon] of SECTIONS) {
      assert.strictEqual(order.filter((x) => x === id).length, 1, `${id} is listed once in the sidebar`);
      assert.ok(NAV_GROUP_OF[id], `${id} has a group`);
      assert.ok(label && /^<svg /.test(icon), `${id} has a label and an icon`);
    }
    assert.strictEqual(NAV_GROUP_OF.dashboard, 'Overview');
    assert.strictEqual(NAV_GROUP_OF.providers, 'Models');
    assert.strictEqual(NAV_GROUP_OF.secrets, 'Data & system');
  });

  test('the search index still finds every setting it lists, by its own label', () => {
    const { findSettings, FIELD_INDEX, SECTIONS } = load();
    const secs = new Set(SECTIONS.map(([id]) => id));
    const missed: string[] = [];
    for (const [sec, key, label] of FIELD_INDEX) {
      assert.ok(secs.has(sec), `${key} points at a real section (${sec})`);
      const words = label.replace(/\([^)]*\)/g, ' ').replace(/[^\p{L}\p{N}\s.-]/gu, ' ').trim();
      if (!findSettings(words).some((h) => h.key === key) && !findSettings(key).some((h) => h.key === key)) { missed.push(`${key} (“${label}”)`); }
    }
    assert.deepStrictEqual(missed, [], 'searching a setting\'s label or key lists it');
  });

  test('page header: icon, group eyebrow, title and lead; long pages get "On this page" jump links', () => {
    const js = read('media/settings.js');
    assert.match(js, /const head = \(sec, title, lead\) => \{[^\n]*<header class="sec-head">[^\n]*class="sec-ic" aria-hidden="true"[^\n]*<p class="eyebrow">\$\{esc\(grp\)\}<\/p>[^\n]*<h1>\$\{esc\(title\)\}<\/h1>[^\n]*<p class="lead">\$\{lead\}<\/p>/);
    assert.match(js, /function addToc\(sec\) \{[\s\S]{0,400}el\('nav', 'toc'\); nav\.setAttribute\('aria-label', 'On this page'\)/, 'the jump list is a labelled nav');
    assert.match(js, /addToc\(sec\);\n\s*wireGlobal\(sec\);/, 'every section render adds it');
    const css = read('media/settings.css');
    assert.match(css, /h2\.sub \{ scroll-margin-top: calc\(var\(--top-h\)/, 'a jump lands below the sticky header');
  });

  test('search results are grouped by section under a labelled group, with the matched words marked', () => {
    const js = read('media/settings.js');
    assert.match(js, /<div class="find-grp" role="group" aria-labelledby="\$\{id\}"><div class="find-gh" id="\$\{id\}">/);
    assert.match(js, /\$\{esc\(NAV_GROUP_OF\[sec\] \|\| ''\)\}<\/span><span class="sep" aria-hidden="true">›<\/span><b>\$\{esc\(secName\[sec\]\.label\)\}<\/b>/, 'breadcrumb: group › section');
    assert.match(js, /out \+= esc\(t\[i\]\)/, 'highlighting escapes the label character by character');
    assert.match(read('media/settings.css'), /\.find-item mark \{[^}]*font-weight: 600; text-decoration: underline;/, 'a match is bold and underlined, not only coloured');
  });

  test('Skills & subagents opens the Agent team map, and the host lets it', () => {
    const js = read('media/settings.js');
    const skills = js.slice(js.indexOf('  function secSkills(sec) {'), js.indexOf('  // ------------------------------------------------------------------ customize'));
    assert.match(skills, /<button class="btn" data-cmd="localpilot\.openAgentMap"[^>]*>\$\{I\.team\}Open Agent Map<\/button>/);
    assert.match(read('src/ui/settingsPanel.ts'), /const ALLOWED_COMMANDS = new Set\(\[[\s\S]*'localpilot\.openAgentMap'[\s\S]*?\]\);/);
    assert.doesNotMatch(skills, /<table/, 'subagents are rows that fit a sidebar, not a table');
  });

  test('the sidebar flags sections that need attention with a shape and words, not colour alone', () => {
    const js = read('media/settings.js');
    assert.match(js, /m\.className = `navst \$\{s\.tone\}`; m\.title = s\.text; m\.innerHTML = `<span class="sr-only">: \$\{esc\(s\.text\)\}<\/span>`;/);
    const css = read('media/settings.css');
    assert.match(css, /\.side a \.navst\.warn \{[^}]*clip-path: polygon/, 'a warning is a triangle');
    assert.match(css, /\.side a \.navst\.err \{[^}]*rotate\(45deg\)/, 'an error is a diamond');
  });

  test('setup wizard: a labelled stepper that says which step is current and which are done', () => {
    const js = read('media/settings.js');
    assert.match(js, /<ol class="steps" aria-label="Setup progress">\$\{\['Find server', 'Choose model', 'Approvals'\]\.map\(\(n, i\) => `<li class="\$\{i < su\.step \? 'on done' : i === su\.step \? 'on cur' : ''\}"\$\{i === su\.step \? ' aria-current="step"' : ''\}>/);
    assert.match(js, /<span class="sr-only">Step \$\{i \+ 1\} of 3: <\/span>\$\{n\}/);
  });

  test('one shape scale: 6 px controls, 10 px cards, 999 px pills; status tints come from the theme', () => {
    const css = read('media/settings.css');
    assert.match(css, /:root \{ --radius-sm: 6px; --radius: 10px; --radius-lg: 12px; --radius-pill: 999px;/);
    assert.match(css, /--ok-bg: color-mix\(in srgb, var\(--ok\) 16%, transparent\);/);
    assert.match(css, /\.seg > button, \.scope > button \{ white-space: nowrap; \}/, 'a segmented label never wraps');
    assert.match(css, /\.card:has\(> \.tbl\), \.card:has\(> table\) \{ overflow-x: auto; \}/, 'a table scrolls inside its card');
  });

  test('the preview harness has the high contrast palettes (?hc=1, ?hc=1&light=1)', () => {
    const html = read('scripts/settings-preview.html');
    assert.match(html, /html\.hc\{[^}]*--vscode-contrastBorder:#6fc3df/);
    assert.match(html, /html\.hc\.hcl\{[^}]*--vscode-contrastBorder:#0f4a85/);
    assert.match(html, /document\.body\.classList\.add\(q\.get\('hc'\) \? \(q\.get\('light'\) \? 'vscode-high-contrast-light' : 'vscode-high-contrast'\)/);
  });
});
