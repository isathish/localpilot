/**
 * Smoke checks for rule front matter (bundled into scripts/smoke.ts): `disabled`, conditional `paths:` / `globs:`, the
 * context-path extractor and matcher, the front-matter switch used by Settings → Customize, and creating items there.
 */
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { buildInstructions } from '../src/context/instructions';
import { parseRule, pathsInText, ruleApplies } from '../src/context/ruleConditions';
import { FrontMatterError, setDisabled } from '../src/agent/frontMatterEdit';
import { createItem, listCustomizations, newItemFileName, setItemEnabled } from '../src/ui/customize';

type Check = (name: string, cond: boolean, detail?: unknown) => void;

const throws = (fn: () => unknown) => {
  try {
    fn();
    return false;
  } catch (e) {
    return e instanceof FrontMatterError;
  }
};

export async function rules(check: Check): Promise<void> {
  console.log('\n[Rules: front matter and Customize]');
  const paths = pathsInText('Fix src/ui/Button.tsx and @lib/a.ts#L3-L9, see https://x.dev/a/b.ts and /etc/hosts\n```\nnot/this.ts\n```\n<attachment path="docs/x.md">\nbody/inside.ts\n</attachment>\ne.g. version 1.2.3, ../up.ts');
  check('paths: message words, mentions and attachment tags; not fences, URLs, absolute, ..', JSON.stringify(paths.sort()) === JSON.stringify(['docs/x.md', 'lib/a.ts', 'src/ui/Button.tsx']), paths);
  check('match: src/**/*.tsx, bare name against the last segment, *.ts at any depth', ruleApplies(['src/**/*.tsx'], ['src/ui/Button.tsx']) && ruleApplies(['src/**/*.tsx'], ['Button.tsx']) && ruleApplies(['*.ts'], ['a/b/c.ts']) && !ruleApplies(['src/**/*.tsx'], ['lib/x.tsx']) && !ruleApplies([], ['a.ts']));
  const cond = (raw: string) => JSON.stringify(parseRule(raw).condition);
  check('front matter: disabled, enabled: false, paths list, comma globs, alwaysApply', cond('---\ndisabled: true\n---\nx') === '{"disabled":true}' && cond('---\nenabled: false\n---\nx') === '{"disabled":true}' && cond('---\npaths:\n  - "src/**"\n  - lib/*.ts\n---\nx') === '{"disabled":false,"paths":["src/**","lib/*.ts"]}' && cond('---\nglobs: src/**/*.tsx, *.css\nalwaysApply: false\n---\nx') === '{"disabled":false,"paths":["src/**/*.tsx","*.css"]}' && cond('---\nglobs: src/**\nalwaysApply: true\n---\nx') === '{"disabled":false}' && cond('---\nglobs:\nalwaysApply: false\n---\nx') === '{"disabled":false}' && cond('---\npaths: []\n---\nx') === '{"disabled":false,"paths":[]}');
  const bad = parseRule('---\npaths: src/**\nthis is not yaml\n---\nBODY');
  check('invalid front matter fails open with the raw content', !!bad.invalid && !bad.condition.paths && bad.body.startsWith('---'));

  check('setDisabled: adds a block when there is none, keeping the BOM and CRLF', setDisabled('\uFEFF# T\r\nbody\r\n', true) === '\uFEFF---\r\ndisabled: true\r\n---\r\n# T\r\nbody\r\n');
  check('setDisabled: keeps other keys and replaces an existing disabled', setDisabled('---\nname: a\ndisabled: false\nglobs: x\n---\nB', true) === '---\nname: a\nglobs: x\ndisabled: true\n---\nB');
  check('setDisabled: enabling removes disabled and enabled: false, and an emptied block', setDisabled('---\ndisabled: true\nenabled: false\n---\nB', false) === 'B' && setDisabled('---\nname: a\ndisabled: true\n---\r\nB', false) === '---\nname: a\n---\r\nB');
  check('setDisabled: round trip is identity for a file without front matter', setDisabled(setDisabled('# x\n', true), false) === '# x\n');
  check('setDisabled: malformed front matter is refused', throws(() => setDisabled('---\nname: a\nno close\n', true)) && throws(() => setDisabled('---\njust words here\n---\nB', true)));
  check('new item names: .md appended, .txt kept for rules, folders refused', newItemFileName('rule', 'testing') === 'testing.md' && newItemFileName('rule', 'a.txt') === 'a.txt' && newItemFileName('command', 'review') === 'review.md' && /^PreToolUse\.(sh|ps1)$/.test(newItemFileName('hook', 'pretooluse')) && (() => { try { newItemFileName('rule', '../x'); return false; } catch { return true; } })() && (() => { try { newItemFileName('command', 'x.txt'); return false; } catch { return true; } })());

  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'lp-smoke-rules-home-'));
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lp-smoke-rules-root-'));
  await fs.mkdir(path.join(root, '.cursor', 'rules'), { recursive: true });
  await fs.writeFile(path.join(root, '.cursor', 'rules', 'react.mdc'), '---\ndescription: React\nglobs: src/**/*.tsx\nalwaysApply: false\n---\nREACT RULE');
  await fs.writeFile(path.join(root, '.cursorrules'), 'CURSOR RULES');
  const without = await buildInstructions([root], { home, contextPaths: ['src/a.ts'] });
  const withTsx = await buildInstructions([root], { home, contextPaths: ['src/ui/App.tsx'] });
  check('a .mdc with globs: src/**/*.tsx is injected only when a .tsx file is in context', !without.text.includes('REACT RULE') && withTsx.text.includes('REACT RULE') && without.text.includes('CURSOR RULES') && withTsx.files.some((f) => f.applied === true));

  await setItemEnabled('rule', path.join(root, '.cursorrules'), false, [root], home);
  const off = await buildInstructions([root], { home });
  check('switching .cursorrules off removes it from the prompt and the file list', !off.text.includes('CURSOR RULES') && !off.files.some((f) => f.label === '.cursorrules') && (await listCustomizations([root], home)).rules.some((r) => r.label === '.cursorrules' && r.disabled));
  await setItemEnabled('rule', path.join(root, '.cursorrules'), true, [root], home);
  check('switching it back on restores the original file', (await fs.readFile(path.join(root, '.cursorrules'), 'utf8')) === 'CURSOR RULES');

  const created = await createItem('rule', 'testing', 'workspace', [root], home);
  const again = await createItem('rule', 'testing', 'workspace', [root], home);
  check('creating "testing" makes .localpilot/rules/testing.md; a second time opens it', created.created && created.file === path.join(root, '.localpilot', 'rules', 'testing.md') && !again.created);
  let refused = false;
  try {
    await setItemEnabled('rule', path.join(os.tmpdir(), 'not-listed.md'), false, [root], home);
  } catch {
    refused = true;
  }
  check('a file that is not listed is never written', refused);
  if (process.platform !== 'win32') {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'lp-smoke-rules-out-'));
    await fs.writeFile(path.join(outside, 'x.md'), 'OUTSIDE');
    await fs.mkdir(path.join(root, '.claude', 'rules'), { recursive: true });
    await fs.symlink(path.join(outside, 'x.md'), path.join(root, '.claude', 'rules', 'linked.md'));
    let symRefused = false;
    try {
      await setItemEnabled('rule', path.join(root, '.claude', 'rules', 'linked.md'), false, [root], home);
    } catch {
      symRefused = true;
    }
    check('a rule symlinked outside the workspace is not written', symRefused && (await fs.readFile(path.join(outside, 'x.md'), 'utf8')) === 'OUTSIDE');
    const hook = await createItem('hook', 'PreToolUse', 'workspace', [root], home);
    const listed = (await listCustomizations([root], home)).hooks.find((h) => h.file === hook.file);
    await setItemEnabled('hook', hook.file, true, [root], home);
    check('a new hook script starts off; the switch sets the executable bit', !!listed?.disabled && ((await fs.stat(hook.file)).mode & 0o111) !== 0);
  }
}
