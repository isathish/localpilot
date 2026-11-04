import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { buildInstructions, collectInstructionFiles } from '../context/instructions';
import { SkillManager } from '../agent/skills';

const tmp = async (name: string) => fs.mkdtemp(path.join(os.tmpdir(), `localpilot-${name}-`));
const write = async (file: string, text: string) => {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, text);
};
const posix = process.platform !== 'win32';

suite('Cline compatibility: rule locations', () => {
  test('picks up .clinerules (file or folder), .cline/rules and the user rule folders, sorted by rule name', async () => {
    const home = await tmp('clinehome');
    const root = await tmp('clineroot');
    await write(path.join(home, '.agents', 'AGENTS.md'), 'AGENTS USER');
    await write(path.join(home, '.localpilot', 'rules', 'lp.md'), 'LP USER RULE');
    await write(path.join(home, '.claude', 'rules', 'cl.markdown'), 'CLAUDE USER RULE');
    await write(path.join(home, '.cline', 'rules', 'cline.txt'), 'CLINE USER RULE');
    await write(path.join(home, 'Documents', 'Cline', 'Rules', 'docs.md'), 'DOCS CLINE RULE');
    await write(path.join(home, 'Cline', 'Rules', 'plain.md'), 'PLAIN CLINE RULE');
    await write(path.join(root, '.clinerules', 'b.md'), '---\nname: alpha\n---\nRULE B');
    await write(path.join(root, '.clinerules', 'a.txt'), 'RULE A');
    await write(path.join(root, '.clinerules', 'empty.md'), '---\nname: empty\n---\n\n');
    await write(path.join(root, '.clinerules', 'image.png'), 'not a rule');
    await write(path.join(root, '.clinerules', 'skills', 'x', 'SKILL.md'), 'NOT A RULE');
    await write(path.join(root, '.cline', 'rules', 'c.mdc'), 'RULE C');
    const files = await collectInstructionFiles([root], home);
    assert.deepStrictEqual(
      files.map((f) => `${f.scope}:${f.label}`),
      [
        'user:~/.agents/AGENTS.md',
        'user:~/.localpilot/rules/lp.md',
        'user:~/.claude/rules/cl.markdown',
        'user:~/.cline/rules/cline.txt',
        'user:~/Documents/Cline/Rules/docs.md',
        'user:~/Cline/Rules/plain.md',
        'project:.clinerules/a.txt',
        'project:.clinerules/b.md',
        'project:.cline/rules/c.mdc',
      ]
    );
    const { text } = await buildInstructions([root], { home });
    assert.ok(text.includes('## a\nRULE A') && text.includes('## alpha\nRULE B') && text.includes('## cline\nCLINE USER RULE'), text);
    assert.ok(text.indexOf('RULE A') < text.indexOf('RULE B'), 'sorted by name: "a" before "alpha"');
    assert.ok(!text.includes('NOT A RULE') && !text.includes('not a rule') && !text.includes('name: alpha'));
  });

  test('the legacy single-file .clinerules is read as a project rule', async () => {
    const home = await tmp('clinehome');
    const root = await tmp('clineroot');
    await write(path.join(root, '.clinerules'), 'LEGACY CLINE RULES');
    const files = await collectInstructionFiles([root], home);
    assert.deepStrictEqual(files.map((f) => `${f.scope}:${f.label}`), ['project:.clinerules']);
    assert.match((await buildInstructions([root], { home })).text, /LEGACY CLINE RULES/);
  });
});

suite('Cline compatibility: skill locations', () => {
  test('loads skills from .agents/skills, .cline/skills and .clinerules/skills, following symlinked folders', async function () {
    this.timeout(20_000);
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) {
      this.skip();
      return;
    }
    const outside = await tmp('clineskill');
    const made: string[] = [];
    const mk = async (dir: string, name: string) => {
      await write(path.join(dir, name, 'SKILL.md'), `---\nname: ${name}\ndescription: ${name} skill\n---\nbody of ${name}`);
    };
    const log = { info() {}, warn() {}, error() {}, debug() {}, trace() {} } as unknown as vscode.LogOutputChannel;
    const mgr = new SkillManager(log);
    try {
      for (const [dir, name] of [['.agents', 'lp-agents-skill'], ['.cline', 'lp-cline-skill'], ['.clinerules', 'lp-clinerules-skill']]) {
        const top = path.join(root, dir);
        if (!(await fs.stat(top).catch(() => undefined))) {
          made.push(top);
        }
        await mk(path.join(top, 'skills'), name);
      }
      if (posix) {
        await mk(outside, 'lp-linked-skill');
        await fs.symlink(path.join(outside, 'lp-linked-skill'), path.join(root, '.cline', 'skills', 'lp-linked-skill'), 'dir');
      }
      await mgr.refresh();
      for (const name of ['lp-agents-skill', 'lp-cline-skill', 'lp-clinerules-skill', ...(posix ? ['lp-linked-skill'] : [])]) {
        const s = mgr.getSkill(name);
        assert.ok(s && s.source === 'workspace', `${name}: ${JSON.stringify(s)}`);
      }
      assert.match((await mgr.loadSkillBody('lp-cline-skill')) ?? '', /body of lp-cline-skill/);
    } finally {
      mgr.dispose();
      for (const [dir, name] of [['.agents', 'lp-agents-skill'], ['.cline', 'lp-cline-skill'], ['.clinerules', 'lp-clinerules-skill'], ['.cline', 'lp-linked-skill']]) {
        await fs.rm(path.join(root, dir, 'skills', name), { recursive: true, force: true });
      }
      for (const top of made) {
        await fs.rm(top, { recursive: true, force: true });
      }
      await fs.rm(outside, { recursive: true, force: true });
    }
  });
});
