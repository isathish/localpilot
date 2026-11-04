import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { bestPreset, rankPresets } from '../providers/presetSearch';
import { findPreset, PROVIDER_PRESETS } from '../providers/presets';

suite('Provider preset search', () => {
  const keys = (q: string) => rankPresets(q, PROVIDER_PRESETS).map((h) => h.preset.key);

  test('exact names and keys lead, then name prefixes, then fuzzy matches', () => {
    assert.strictEqual(keys('groq')[0], 'groq');
    assert.strictEqual(keys('open')[0], 'openai');
    assert.ok(keys('open').includes('openrouter'));
    assert.strictEqual(keys('hf')[0], 'huggingface');
    assert.strictEqual(keys('vercel')[0], 'vercel');
    assert.deepStrictEqual(keys('zzqx'), []);
  });

  test('matched letters of the name are reported for highlighting', () => {
    const hit = rankPresets('lms', PROVIDER_PRESETS).find((h) => h.preset.key === 'lmstudio');
    assert.ok(hit);
    assert.strictEqual(hit.labelHl.map((i) => hit.preset.label[i]).join('').toLowerCase(), 'lms');
  });

  test('host and environment variable find a preset too', () => {
    assert.ok(keys('api.groq').includes('groq'));
    assert.ok(keys('SAMBANOVA_API').includes('sambanova'));
  });

  test('findPreset falls back to a close fuzzy match, never to a loose one', () => {
    assert.strictEqual(findPreset('hf', { fuzzy: true })?.key, 'huggingface');
    assert.strictEqual(findPreset('vercel gw', { fuzzy: true })?.key, 'vercel');
    assert.strictEqual(findPreset('work'), undefined, '-P lookups stay exact or prefix-only');
    assert.strictEqual(findPreset('hf'), undefined);
    assert.strictEqual(findPreset(''), undefined);
    assert.strictEqual(bestPreset('xq', PROVIDER_PRESETS), undefined);
  });

  test('the new cloud presets carry a key URL and an environment variable, in the CLI and in Settings', () => {
    const webview = fs.readFileSync(path.join(__dirname, '..', '..', 'media', 'settings.js'), 'utf8');
    for (const key of ['sambanova', 'minimax', 'zai', 'baseten', 'nebius', 'requesty', 'vercel', 'cerebras', 'huggingface', 'moonshot']) {
      const p = PROVIDER_PRESETS.find((x) => x.key === key);
      assert.ok(p, key);
      assert.ok(p.env && /^https:\/\//.test(p.keyUrl ?? ''), key);
      assert.strictEqual(p.cfg.apiKey, `\${env:${p.env}}`);
      assert.ok(webview.includes(`'${key}'`) && webview.includes(`'${p.cfg.baseUrl}'`) && webview.includes(`'${p.env}'`), `settings.js lists ${key}`);
    }
  });
});
