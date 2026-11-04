import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { getConfig } from '../config';
import { checkPathsExist, MAX_PATH_CHECKS, pathCandidates, uiPrefsMsg } from '../ui/chatUiExtras';
import { changelogHighlights, LAST_SEEN_VERSION, WhatsNew } from '../ui/whatsNew';

function memento(init: Record<string, unknown> = {}) {
  const data: Record<string, unknown> = { ...init };
  return { data, get: <T>(k: string) => data[k] as T | undefined, update: async (k: string, v: unknown) => { data[k] = v; }, keys: () => Object.keys(data) };
}

const LOG = [
  '# Changelog',
  '',
  '## Unreleased',
  '- **Pending.** Not released yet.',
  '',
  '## 2.0.0 — 2026-11-04',
  '',
  '### Added',
  '- **Task header.** A card under the tabs shows the first prompt.',
  '- Mermaid diagrams render in the chat. Copy the source.',
  '- **`@` mentions** are faster',
  '  and wrap onto a second line.',
  '### Fixed',
  '- **Escape stops the run.**',
  '',
  '## 1.9.0',
  '- **Older entry.**',
].join('\n');

suite('Chat UX: What\'s new', () => {
  test('changelogHighlights keeps the bold titles of the version\'s section, in order', () => {
    assert.deepStrictEqual(changelogHighlights(LOG, '2.0.0'), ['Task header.', 'Mermaid diagrams render in the chat.', '@ mentions', 'Escape stops the run.']);
    assert.deepStrictEqual(changelogHighlights(LOG, 'v2.0.0', 2), ['Task header.', 'Mermaid diagrams render in the chat.']);
    assert.deepStrictEqual(changelogHighlights(LOG, '1.9.0'), ['Older entry.']);
    assert.deepStrictEqual(changelogHighlights(LOG, '3.0.0'), []);
    // "2.0.0" must not match "2.0.01".
    assert.deepStrictEqual(changelogHighlights('## 2.0.01\n- **x**', '2.0.0'), []);
  });

  test('the card shows once after an update and never on a fresh install', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lp-wn-'));
    try {
      const file = path.join(dir, 'CHANGELOG.md');
      fs.writeFileSync(file, LOG);
      const fresh = memento();
      assert.strictEqual(new WhatsNew(fresh, '2.0.0', file).pending, undefined);
      assert.strictEqual(fresh.data[LAST_SEEN_VERSION], '2.0.0');

      // Used before the version was tracked: other keys exist, so this is an update.
      const legacy = memento({ 'localpilot.favorites': [] });
      assert.strictEqual(new WhatsNew(legacy, '2.0.0', file).pending?.version, '2.0.0');

      const updated = memento({ [LAST_SEEN_VERSION]: '1.9.0' });
      const w = new WhatsNew(updated, '2.0.0', file);
      assert.strictEqual(w.pending?.bullets.length, 4);
      await w.dismiss();
      assert.strictEqual(w.pending, undefined);
      assert.strictEqual(updated.data[LAST_SEEN_VERSION], '2.0.0');
      assert.strictEqual(new WhatsNew(updated, '2.0.0', file).pending, undefined);

      // A version without a changelog section has nothing to show and is marked seen.
      const noSection = memento({ [LAST_SEEN_VERSION]: '1.9.0' });
      assert.strictEqual(new WhatsNew(noSection, '2.0.1', file).pending, undefined);
      assert.strictEqual(noSection.data[LAST_SEEN_VERSION], '2.0.1');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

suite('Chat UX: path links', () => {
  test('candidates: worktree first, named folder, every folder; never outside', () => {
    const roots = { folders: [{ name: 'app', fsPath: '/w/app' }, { name: 'lib', fsPath: '/w/lib' }], worktreeRoot: '/wt/x' };
    assert.deepStrictEqual(pathCandidates('lib/a.ts', roots), [path.join('/wt/x', 'lib/a.ts'), path.join('/w/lib', 'a.ts'), path.join('/w/app', 'lib/a.ts'), path.join('/w/lib', 'lib/a.ts')]);
    assert.deepStrictEqual(pathCandidates('/abs/file.ts', roots), ['/abs/file.ts']);
    assert.deepStrictEqual(pathCandidates('src/../../etc/passwd', roots), []);
    assert.deepStrictEqual(pathCandidates('a.ts#L10', { folders: [{ name: 'w', fsPath: '/w' }] }), [path.join('/w', 'a.ts')]);
  });

  test('checkPathsExist answers each path once and caps the batch', async () => {
    const seen: string[] = [];
    const exists = async (abs: string) => { seen.push(abs); return abs.endsWith(`${path.sep}real.ts`); };
    const roots = { folders: [{ name: 'w', fsPath: '/w' }] };
    const r = await checkPathsExist(['real.ts', 'real.ts', 'gone.ts'], roots, exists);
    assert.deepStrictEqual(r, { 'real.ts': true, 'gone.ts': false });
    assert.strictEqual(seen.length, 2);
    const many = Array.from({ length: MAX_PATH_CHECKS + 50 }, (_, i) => `f${i}.ts`);
    assert.strictEqual(Object.keys(await checkPathsExist(many, roots, async () => false)).length, MAX_PATH_CHECKS);
  });

  test('checkPathsExist finds real files and folders on disk', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lp-paths-'));
    try {
      fs.mkdirSync(path.join(dir, 'src'));
      fs.writeFileSync(path.join(dir, 'src', 'index.ts'), '');
      const r = await checkPathsExist(['src/index.ts', 'src', 'src/nope.ts'], { folders: [{ name: 'w', fsPath: dir }] });
      assert.deepStrictEqual(r, { 'src/index.ts': true, src: true, 'src/nope.ts': false });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

suite('Chat UX: settings', () => {
  test('localpilot.showTips is contributed and on by default', () => {
    const ext = vscode.extensions.getExtension('localpilot.localpilot-agent')!;
    const prop = ext.packageJSON.contributes.configuration.properties['localpilot.showTips'];
    assert.ok(prop, 'localpilot.showTips is missing from package.json');
    assert.strictEqual(prop.type, 'boolean');
    assert.strictEqual(prop.default, true);
    assert.strictEqual(getConfig().showTips, true);
  });

  test('uiPrefs carries the tips switch and the auto-compact threshold', () => {
    const m = uiPrefsMsg({ version: '2.0.0', bullets: ['x'] });
    assert.strictEqual(m.type, 'uiPrefs');
    assert.strictEqual(m.showTips, true);
    assert.strictEqual(m.compactionThreshold, getConfig().compactionThreshold);
    assert.strictEqual(m.autoCompact, getConfig().compactionStrategy !== 'off');
    assert.deepStrictEqual(m.whatsNew, { version: '2.0.0', bullets: ['x'] });
  });
});
