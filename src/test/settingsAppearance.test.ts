import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';

const EXT_ROOT = path.resolve(__dirname, '..', '..');
const read = (rel: string) => fs.readFileSync(path.join(EXT_ROOT, rel), 'utf8');

/** The section list, sidebar order and settings search of `media/settings.js`, lifted out of the IIFE and run as is. */
function loadSearch(): { findSettings: (q: string) => { sec: string; key?: string; label: string }[]; SECTIONS: [string, string, string][]; NAV_HOME: string[]; NAV_GROUPS: { items: string[] }[] } {
  const src = read('media/settings.js');
  const start = src.indexOf('  const I = {');
  const end = src.indexOf('  /** Remembered across reloads');
  assert.ok(start > 0 && end > start, 'icons, sections and findSettings not found in media/settings.js');
  const sb: Record<string, unknown> = {};
  vm.runInNewContext(`${src.slice(start, end)}\nout_ = { findSettings, SECTIONS, NAV_HOME, NAV_GROUPS };`, sb, { timeout: 5_000 });
  return sb.out_ as ReturnType<typeof loadSearch>;
}

suite('Settings → Appearance', () => {
  test('is a section with an icon, in the sidebar (and so in the ⋯ menu and the narrow icon strip)', () => {
    const { SECTIONS, NAV_HOME, NAV_GROUPS } = loadSearch();
    const sec = SECTIONS.find(([id]) => id === 'appearance');
    assert.ok(sec, 'appearance is in SECTIONS');
    assert.strictEqual(sec[1], 'Appearance');
    assert.match(sec[2], /^<svg /, 'it has an icon');
    const order = [...NAV_HOME, ...NAV_GROUPS.flatMap((g) => g.items)];
    assert.strictEqual(order.filter((id) => id === 'appearance').length, 1, 'listed once in the sidebar order');
    assert.ok(order.indexOf('appearance') < order.indexOf('providers'), 'near the top, above the Models group');
    assert.match(read('media/settings.js'), /appearance: secAppearance \}\[state\.section\]/, 'renderSection draws it');
  });

  test('search finds it by name, by its settings and by everyday words', () => {
    const { findSettings } = loadSearch();
    for (const q of ['appearance', 'density', 'font size', 'compact', 'text size', 'reduced motion', 'animation']) {
      assert.ok(findSettings(q).some((h) => h.sec === 'appearance'), `"${q}" finds Appearance`);
    }
    for (const [q, key] of [['density', 'appearance.density'], ['text size', 'appearance.textSize'], ['font', 'appearance.textSize'], ['motion', 'appearance.motion']]) {
      assert.ok(findSettings(q).some((h) => h.key === key), `"${q}" jumps to ${key} (FIELD_INDEX)`);
    }
  });

  test('the host opens it by id, may write its settings and stamps the preferences on <body>', () => {
    const panel = read('src/ui/settingsPanel.ts');
    const pkg = JSON.parse(read('package.json')) as { contributes: { configuration: { properties: Record<string, { enum?: string[] }> } } };
    const props = pkg.contributes.configuration.properties;
    assert.match(/export type SettingsSection = ([^;]*);/.exec(panel)?.[1] ?? '', /'appearance'/, "'appearance' is a SettingsSection (localpilot.openSettings 'appearance')");
    const keys = /const SETTING_KEYS = \[([\s\S]*?)\] as const;/.exec(panel)?.[1] ?? '';
    const js = read('media/settings.js');
    for (const [key, values] of [['appearance.density', ['comfortable', 'compact']], ['appearance.textSize', ['small', 'default', 'large']], ['appearance.motion', ['system', 'reduced']]] as const) {
      assert.ok(keys.includes(`'${key}'`), `${key} is writable from Settings`);
      assert.deepStrictEqual(props[`localpilot.${key}`]?.enum, [...values], `${key} options match package.json`);
      assert.match(js, new RegExp(`field\\('${key.replace('.', '\\.')}', [^\\n]*'seg', \\{ options: \\[${values.map((v) => `\\['${v}', '[^']+'\\]`).join(', ')}\\]`), `${key} is a segmented control with every option`);
    }
    assert.match(panel, /<body [^>]*data-density="\$\{look\.density\}" data-text-size="\$\{look\.textSize\}" data-motion="\$\{look\.motion\}"/, 'html() sets the body attributes');
    assert.match(panel, /affectsConfiguration\('localpilot\.appearance'\)[\s\S]{0,120}type: 'appearance'/, 'a change is posted at once');
    assert.match(js, /case 'appearance': applyAppearance\(m\)/, 'the page applies the message');
  });

  test('the stylesheet keys density, text size and motion off the body attributes; one reduced-motion guard for both triggers', () => {
    const css = read('media/settings.css');
    assert.match(css, /body\[data-density="compact"\] \{/);
    assert.match(css, /body\[data-text-size="small"\] \{ --fs-scale: \.92; \}/);
    assert.match(css, /body\[data-text-size="large"\] \{ --fs-scale: 1\.12;/);
    assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{ body \{ --calm: 1; \} \}\nbody\[data-motion="reduced"\] \{ --calm: 1; \}\n@container style\(--calm: 1\) \{/);
    assert.strictEqual(css.match(/prefers-reduced-motion/g)?.length, 1, 'no second, diverging guard');
    assert.doesNotMatch(css, /font-size: ?1[0-4](\.5)?px/, 'text sizes go through the --fs-* ramp so Text size scales them');
    assert.match(read('media/settings.js'), /const calm = \(\) => document\.body\.dataset\.motion === 'reduced' \|\| matchMedia/, 'scripted motion follows the setting too');
  });
});
