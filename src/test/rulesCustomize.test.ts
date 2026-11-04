import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { buildInstructions, collectInstructionFiles } from '../context/instructions';
import { parseRule, pathsInText, ruleApplies } from '../context/ruleConditions';
import { FrontMatterError, setDisabled } from '../agent/frontMatterEdit';
import { discoverCommands } from '../agent/commands';
import { createItem, deleteItem, listCustomizations, newItemFileName, setItemEnabled } from '../ui/customize';

const tmp = async (name: string) => fs.mkdtemp(path.join(os.tmpdir(), `localpilot-${name}-`));
const write = async (file: string, text: string) => {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, text);
};

suite('Rule front matter: disabled and conditional paths', () => {
  test('a Cursor .mdc with globs is injected only when a matching file is in context', async () => {
    const home = await tmp('rhome');
    const root = await tmp('rroot');
    await write(path.join(root, '.cursor', 'rules', 'react.mdc'), '---\ndescription: React\nglobs: src/**/*.tsx\nalwaysApply: false\n---\nREACT RULE');
    await write(path.join(root, '.localpilot', 'rules', 'always.md'), 'ALWAYS RULE');
    const off = await buildInstructions([root], { home, contextPaths: ['src/index.ts', 'README.md'] });
    assert.ok(!off.text.includes('REACT RULE'));
    assert.ok(off.text.includes('ALWAYS RULE'));
    assert.strictEqual(off.files.find((f) => f.file.endsWith('react.mdc'))?.applied, false);
    const on = await buildInstructions([root], { home, contextPaths: ['src/components/App.tsx'] });
    assert.ok(on.text.includes('REACT RULE'));
    assert.ok(!on.text.includes('alwaysApply'), 'front matter is not part of the prompt');
  });

  test('disabled: true and enabled: false leave a rule out; paths: [] never applies; bad YAML fails open', async () => {
    const home = await tmp('rhome2');
    const root = await tmp('rroot2');
    await write(path.join(root, '.clinerules', 'off.md'), '---\ndisabled: true\n---\nOFF RULE');
    await write(path.join(root, '.clinerules', 'legacy.md'), '---\nenabled: false\n---\nLEGACY OFF');
    await write(path.join(root, '.clinerules', 'never.md'), '---\npaths: []\n---\nNEVER RULE');
    await write(path.join(root, '.clinerules', 'broken.md'), '---\npaths: src/**\nnot yaml at all\n---\nBROKEN RULE');
    const r = await buildInstructions([root], { home, contextPaths: ['src/a.ts'] });
    assert.ok(!r.text.includes('OFF RULE') && !r.text.includes('LEGACY OFF') && !r.text.includes('NEVER RULE'));
    assert.ok(r.text.includes('BROKEN RULE') && r.text.includes('not yaml at all'), 'raw content injected');
    const listed = await collectInstructionFiles([root], home, { includeDisabled: true });
    assert.strictEqual(listed.filter((f) => f.disabled).length, 2);
  });

  test('context paths come from the message, attachments and mentions, not fences or URLs', () => {
    const found = pathsInText('look at src/app/page.tsx and @lib/util.ts:12\n```ts\nimport x from "fenced/one.ts";\n```\nhttps://example.com/x/y.ts <attachment path="docs/guide.md">\nnested/in/body.ts\n</attachment> /abs/path.ts');
    assert.deepStrictEqual(found.sort(), ['docs/guide.md', 'lib/util.ts', 'src/app/page.tsx']);
    assert.ok(ruleApplies(['src/**/*.tsx'], found));
    assert.ok(!ruleApplies(['test/**'], found));
    assert.deepStrictEqual(parseRule('---\nglobs: "a/**", b/*.ts\n---\nx').condition.paths, ['a/**', 'b/*.ts']);
  });

  test('disabled commands are skipped unless listing everything', async () => {
    const home = await tmp('chome');
    const root = await tmp('croot');
    await write(path.join(root, '.localpilot', 'commands', 'review.md'), '---\ndescription: Review\ndisabled: true\n---\nReview it');
    assert.ok(!(await discoverCommands([root], { home })).some((c) => c.invoke === '/review'));
    assert.ok((await discoverCommands([root], { home, includeDisabled: true })).some((c) => c.invoke === '/review' && c.disabled));
  });
});

suite('Customize: front-matter switch', () => {
  test('keeps the BOM, CRLF line endings and other keys', () => {
    assert.strictEqual(setDisabled('\uFEFF---\r\nname: a\r\n---\r\nBody\r\n', true), '\uFEFF---\r\nname: a\r\ndisabled: true\r\n---\r\nBody\r\n');
    assert.strictEqual(setDisabled('\uFEFF---\r\nname: a\r\ndisabled: true\r\n---\r\nBody\r\n', false), '\uFEFF---\r\nname: a\r\n---\r\nBody\r\n');
  });

  test('adds a block to a file without front matter and removes it again', () => {
    const on = setDisabled('Just a rule\n', true);
    assert.strictEqual(on, '---\ndisabled: true\n---\nJust a rule\n');
    assert.strictEqual(setDisabled(on, false), 'Just a rule\n');
    assert.strictEqual(setDisabled('Just a rule\n', false), 'Just a rule\n');
  });

  test('enabling also drops a legacy enabled: false, keeping enabled: true', () => {
    assert.strictEqual(setDisabled('---\nenabled: false\nglobs: a\n---\nB', false), '---\nglobs: a\n---\nB');
    assert.strictEqual(setDisabled('---\nenabled: true\n---\nB', true), '---\nenabled: true\ndisabled: true\n---\nB');
  });

  test('refuses malformed front matter', () => {
    assert.throws(() => setDisabled('---\nname: a\nbody without a closing line\n', true), FrontMatterError);
    assert.throws(() => setDisabled('---\nthis is: fine\nbut this is not\n---\nB', true), FrontMatterError);
  });

  test('new names: .md appended, folders and other extensions refused', () => {
    assert.strictEqual(newItemFileName('rule', 'testing'), 'testing.md');
    assert.strictEqual(newItemFileName('rule', 'notes.txt'), 'notes.txt');
    assert.strictEqual(newItemFileName('command', 'deploy.md'), 'deploy.md');
    assert.throws(() => newItemFileName('rule', 'a/b'));
    assert.throws(() => newItemFileName('rule', '..'));
    assert.throws(() => newItemFileName('command', 'x.txt'));
    assert.throws(() => newItemFileName('hook', 'x.md'));
  });

  test('switching .cursorrules off removes it from the prompt; create, re-create and delete', async () => {
    const home = await tmp('zhome');
    const root = await tmp('zroot');
    await write(path.join(root, '.cursorrules'), 'CURSOR');
    await setItemEnabled('rule', path.join(root, '.cursorrules'), false, [root], home);
    assert.ok(!(await buildInstructions([root], { home })).text.includes('CURSOR'));
    await setItemEnabled('rule', path.join(root, '.cursorrules'), true, [root], home);
    assert.strictEqual(await fs.readFile(path.join(root, '.cursorrules'), 'utf8'), 'CURSOR');

    const first = await createItem('rule', 'testing', 'workspace', [root], home);
    assert.deepStrictEqual(first, { file: path.join(root, '.localpilot', 'rules', 'testing.md'), created: true });
    await fs.writeFile(first.file, 'MINE');
    assert.strictEqual((await createItem('rule', 'testing', 'workspace', [root], home)).created, false);
    assert.strictEqual(await fs.readFile(first.file, 'utf8'), 'MINE', 'an existing file is not overwritten');
    const cmd = await createItem('command', 'review', 'global', [root], home);
    assert.strictEqual(cmd.file, path.join(home, '.localpilot', 'commands', 'review.md'));
    assert.ok((await listCustomizations([root], home)).commands.some((c) => c.file === cmd.file && c.scope === 'global'));
    await deleteItem('command', cmd.file, [root], home);
    await assert.rejects(fs.stat(cmd.file));
    await assert.rejects(deleteItem('rule', path.join(home, 'elsewhere.md'), [root], home));
  });
});
