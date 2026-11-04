import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { folderRelativePath, ruleApplies } from '../context/ruleConditions';
import { createItem, listCustomizations, setItemEnabled } from '../ui/customize';

suite('Conditional rules: multi-root working set', () => {
  test('a working-set path with a folder prefix still applies a src/**/*.tsx rule', () => {
    const folders = ['web', 'api'];
    const n = folderRelativePath('web/src/ui/Button.tsx', folders);
    assert.strictEqual(n, 'src/ui/Button.tsx');
    assert.ok(ruleApplies(['src/**/*.tsx'], [n!]));
    assert.ok(!ruleApplies(['src/**/*.tsx'], ['web/src/ui/Button.tsx']), 'the prefixed path alone does not match');
  });

  test('only a leading folder name is stripped, and only in a multi-root workspace', () => {
    assert.strictEqual(folderRelativePath('web/src/a.tsx', ['web']), 'web/src/a.tsx');
    assert.strictEqual(folderRelativePath('lib/web/a.ts', ['web', 'api']), 'lib/web/a.ts');
    assert.strictEqual(folderRelativePath('web', ['web', 'api']), 'web');
    assert.strictEqual(folderRelativePath('/abs/web/a.ts', ['web', 'api']), undefined);
  });
});

suite('Customize: hook scripts are listed and switchable', () => {
  test('folder hook scripts are editable, switched by the executable bit; new hooks are templates named after the event', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'localpilot-hhome-'));
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'localpilot-hroot-'));
    const script = path.join(root, '.localpilot', 'hooks', 'PreToolUse.sh');
    await fs.mkdir(path.dirname(script), { recursive: true });
    await fs.writeFile(script, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const hook = (await listCustomizations([root], home)).hooks.find((h) => h.file === script);
    assert.ok(hook && !hook.notRun && hook.editable && !hook.disabled, JSON.stringify(hook));
    if (process.platform !== 'win32') {
      await setItemEnabled('hook', script, false, [root], home);
      assert.strictEqual((await fs.stat(script)).mode & 0o111, 0);
    }
    const r = await createItem('hook', 'Stop', 'workspace', [root], home);
    assert.ok(r.created && /[\\/]Stop\.(sh|ps1(\.disabled)?)$/.test(r.file), r.file);
  });
});
