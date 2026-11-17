import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';

const EXT_ROOT = path.resolve(__dirname, '..', '..');
const read = (f: string): string => fs.readFileSync(path.join(EXT_ROOT, f), 'utf8');

/** localpilot.appearance.* end to end: the first paint, the live message, the stylesheet's tokens and the preview flags. */
suite('Chat appearance: density, text size, motion', () => {
  test('the chat page is rendered with the three attributes on <body>, from getConfig().appearance', () => {
    const view = read('src/ui/chatViewProvider.ts');
    assert.match(view, /const look = appearanceMsg\(\);/);
    assert.match(view, /<body data-mermaid="\$\{mermaidSrc\}" data-density="\$\{look\.density\}" data-text-size="\$\{look\.textSize\}" data-motion="\$\{look\.motion\}">/);
  });

  test('the host pushes an appearance message when the settings change, and on every (re)load', () => {
    const ctl = read('src/ui/chatController.ts');
    assert.match(ctl, /export type AppearanceMsg = \{ type: 'appearance' \} & LocalPilotConfig\['appearance'\];/);
    assert.match(ctl, /export type ToWebview =[\s\S]{0,200}\| AppearanceMsg/);
    // Registered with the controller's disposables, so it goes away with the chat.
    const reg = /this\.disposables\.push\(([\s\S]*?)\n {4}\);/.exec(ctl);
    assert.ok(reg && reg[1].includes("e.affectsConfiguration('localpilot.appearance') && this.broadcast(appearanceMsg())"), 'listener is disposed with the controller');
    assert.match(ctl, /post\(uiPrefsMsg\(this\.whatsNew\?\.pending\)\);\s*\/\/[^\n]*\n\s*post\(appearanceMsg\(\)\);/);
  });

  test('the webview sets the attributes from the message and ignores unknown values', () => {
    const js = read('media/chat.js');
    assert.match(js, /case 'appearance': applyAppearance\(m\); break;/);
    const a = js.indexOf('  function applyAppearance(m) {');
    const b = js.indexOf('\n  }\n', a);
    assert.ok(a > 0 && b > a, 'applyAppearance is in media/chat.js');
    const body = { dataset: {} as Record<string, string> };
    const sandbox: Record<string, unknown> = { document: { body } };
    vm.runInNewContext(`${js.slice(a, b + 4)}\nout_ = applyAppearance;`, sandbox, { timeout: 2000 });
    const apply = sandbox.out_ as (m: unknown) => void;
    apply({ type: 'appearance', density: 'compact', textSize: 'large', motion: 'reduced' });
    assert.deepStrictEqual({ ...body.dataset }, { density: 'compact', textSize: 'large', motion: 'reduced' });
    apply({ type: 'appearance', density: 'huge', textSize: 42, motion: undefined });
    assert.deepStrictEqual({ ...body.dataset }, { density: 'comfortable', textSize: 'default', motion: 'system' });
    // Smooth scrolling follows the setting as well as the OS.
    assert.match(js, /const calmMotion = \(\) => document\.body\.dataset\.motion === 'reduced' \|\| matchMedia\('\(prefers-reduced-motion: reduce\)'\)\.matches;/);
  });

  test('the ⋯ menu opens Settings at Appearance', () => {
    assert.match(read('media/chat.js'), /label: 'Appearance…'[^\n]*post\(\{ type: 'openSettings', section: 'appearance' \}\)/);
  });

  test('text size scales every font size, density only changes tokens', () => {
    const css = read('media/chat.css');
    assert.match(css, /body\[data-text-size="small"\] \{ --fs-scale: \.92; \}/);
    assert.match(css, /body\[data-text-size="large"\] \{ --fs-scale: 1\.12; \}/);
    assert.match(css, /--fs: calc\(var\(--vscode-font-size, 13px\) \* var\(--fs-scale\)\);/);
    assert.match(css, /body\[data-density="compact"\] \{[^}]*--gutter:[^}]*--row-h:[^}]*\}/);
    for (const f of ['media/chat.css', 'media/continuity.css']) {
      const fixed = read(f).match(/font-size: *\d+(\.\d+)?px/g) || [];
      assert.deepStrictEqual(fixed, [], `${f}: fixed font sizes go through --fs-scale`);
    }
  });

  test('reduced motion: the OS preference and the setting raise one flag that a single rule list reads', () => {
    const css = read('media/chat.css');
    assert.ok(css.includes('@media (prefers-reduced-motion: reduce) { body { --motion-reduced: 1; } }'));
    assert.ok(css.includes('body[data-motion="reduced"] { --motion-reduced: 1; }'));
    assert.strictEqual((css.match(/prefers-reduced-motion/g) || []).length, 1, 'no second, drifting list of reduced-motion rules');
    const i = css.indexOf('@container style(--motion-reduced: 1) {');
    assert.ok(i > 0);
    const list = css.slice(i);
    for (const sel of ['*, *::before, *::after', '.dot.live', '.typing i', '.stickyuser', '.ratecard']) { assert.ok(list.includes(sel), `${sel} is calmed`); }
    const cont = read('media/continuity.css');
    assert.ok(!cont.includes('prefers-reduced-motion') && cont.includes('@container style(--motion-reduced: 1)'));
  });

  test('the preview harnesses take ?density, ?text and ?motion', () => {
    for (const f of ['scripts/ui-preview.html', 'scripts/ui-preview-parallel.html']) {
      const html = read(f);
      for (const k of ["q.get('density')", "q.get('text')", "q.get('motion')"]) { assert.ok(html.includes(k), `${f} reads ${k}`); }
    }
  });
});
