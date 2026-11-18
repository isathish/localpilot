import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';
import * as cloud from '../providers/cloud';

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

suite('Settings → Providers card', () => {
  /** One `const name = …;` of media/settings.js (a line, or a block up to its closing `  };`), run as is. */
  const lift = <T>(name: string, ctx: Record<string, unknown> = {}): T => {
    const src = read('media/settings.js');
    const m = new RegExp(`\\n  const ${name} = (?:[^\\n]*\\{\\n[^]*?\\n  \\};|[^\\n]+)`).exec(src);
    assert.ok(m, `${name} not found in media/settings.js`);
    const sb: Record<string, unknown> = { ...ctx };
    vm.runInNewContext(`${m[0]}\nout_ = ${name};`, sb, { timeout: 5_000 });
    return sb.out_ as T;
  };

  test('detects Azure OpenAI resources like isAzureUrl in src/providers/cloud.ts', () => {
    const page = lift<(u: string) => boolean>('isAzureUrl');
    const { isAzureUrl } = cloud;
    for (const u of ['https://res.openai.azure.com/openai/v1', 'https://res.services.ai.azure.com/models', 'https://res.cognitiveservices.azure.com', 'https://res.openai.azure.com:443/x', 'https://api.openai.com/v1', 'http://localhost:1234/v1', 'https://openai.azure.com.evil.example/v1']) {
      assert.strictEqual(page(u), isAzureUrl(u), u);
    }
  });

  test('external links keep their icon on the same line as the last word', () => {
    const esc = (s: string) => String(s).replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
    const extLink = lift<(url: string, text: string) => string>('extLink', { esc, I: { external: '<svg></svg>' } });
    assert.match(extLink('https://portal.azure.com', 'Get an API key'), /Get an API <span class="nowrap">key<svg><\/svg><\/span><\/a>$/);
    assert.match(extLink('https://x', 'Docs'), /<span class="nowrap">Docs<svg><\/svg><\/span>/);
    assert.doesNotMatch(read('media/settings.js'), /↗/, 'no text arrow that can wrap on its own');
    assert.match(read('media/settings.css'), /\.nowrap \{ white-space: nowrap; \}/);
  });

  test('the saved-key placeholder is short, and the two Remove buttons say what they remove', () => {
    const js = read('media/settings.js');
    assert.doesNotMatch(js, /saved in the secret store — type to replace/);
    assert.strictEqual(js.match(/'Saved — type to replace'/g)?.length, 2, 'both the own and the organization provider card');
    assert.strictEqual(js.match(/\$\{I\.trash\}Remove key`/g)?.length, 2);
    assert.match(js, /<button class="btn danger" id="rm"[^>]*>\$\{I\.trash\}Remove provider<\/button>/, 'only the provider removal is a danger button');
    assert.doesNotMatch(js, /class="btn[^"]*danger[^"]*"[^>]*>\$\{I\.trash\}Remove key/);
  });

  test('Models becomes Deployments for Azure, shows what was found, and the default model offers it', () => {
    const js = read('media/settings.js');
    assert.match(js, /row\(azure \? 'Deployments' : 'Models'/);
    assert.match(js, /foundList\(found, azure \? plural\(found\.length, 'deployment'\)/);
    // The page state's model list counts too, so a card opened before its check still offers the models.
    assert.match(js, /const knownIds = \(p, probe\) => \{[^]*?state\.data\.models/);
    assert.match(js, /const ids = knownIds\(p, probe\);[^]*?<option value="\$\{OTHER\}">Other…<\/option>/);
  });
});
