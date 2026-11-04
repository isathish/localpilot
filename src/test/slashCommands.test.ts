import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { builtinCommands, deepPlanningPrompt, discoverCommands, expandCommand, indexCommands, parseCommandFile, resolveSlashMessage, skillTaskPrompt } from '../agent/commands';
import { findSlashToken, normalizeCommandName, pickSlashTarget, spliceSlashToken } from '../agent/slashNames';
import { ChatController } from '../ui/chatController';

const tmp = async (name: string) => fs.mkdtemp(path.join(os.tmpdir(), `localpilot-${name}-`));
const write = async (file: string, text: string) => {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, text);
};

suite('Slash commands: names, workflows, skills and inline commands', () => {
  test('names are normalised: lowercase, spaces to -, only [a-z0-9_.:@-], no .md/.markdown/.txt', () => {
    assert.strictEqual(normalizeCommandName('My Review.MD'), 'my-review');
    assert.strictEqual(normalizeCommandName('/Deploy  Prod!.markdown'), 'deploy-prod');
    assert.strictEqual(normalizeCommandName('release_notes.txt'), 'release_notes');
    assert.strictEqual(normalizeCommandName('frontend:Component'), 'frontend:component');
    assert.strictEqual(normalizeCommandName('v1.2@team'), 'v1.2@team');
    const c = parseCommandFile('/w/.clinerules/workflows/Ship It.txt', 'Ship the release.', { source: 'project' });
    assert.strictEqual(c.invoke, '/ship-it');
    assert.strictEqual(parseCommandFile('/w/x.md', '---\nname: Fix Bug\n---\nbody', { source: 'project' }).invoke, '/fix-bug');
  });

  test('/newrule and its /init alias are built in and write a rule through write_file', () => {
    const by = Object.fromEntries(indexCommands(builtinCommands()));
    assert.ok(by['/newrule'] && by['/init'], 'both are discovered');
    assert.strictEqual(by['/newrule'].source, 'builtin');
    assert.match(by['/newrule'].body, /write_file to `\.localpilot\/rules\/<name>\.md`/);
    assert.match(by['/newrule'].body, /at most 4 short questions in ONE ask_user call/);
    assert.match(by['/newrule'].body, /AGENTS\.md/);
    assert.strictEqual(by['/init'].body, by['/newrule'].body);
    assert.match(deepPlanningPrompt('add OAuth'), /^Deep planning for this task: add OAuth/);
    assert.match(deepPlanningPrompt('x'), /ask_user/);
  });

  test('discovery: Cline workflow folders, .txt/.markdown, disabled front matter, workspace beats global', async () => {
    const home = await tmp('wfhome');
    const root = await tmp('wfroot');
    await write(path.join(root, '.clinerules', 'workflows', 'release.md'), 'project release');
    await write(path.join(root, '.cline', 'workflows', 'notes.markdown'), 'notes body');
    await write(path.join(root, '.clinerules', 'workflows', 'off.md'), '---\ndisabled: true\n---\nhidden');
    await write(path.join(root, '.clinerules', 'workflows', 'readme.json'), '{}');
    await write(path.join(home, '.cline', 'workflows', 'release.md'), 'global release');
    await write(path.join(home, '.cline', 'workflows', 'cleanup.txt'), 'clean up');
    await write(path.join(home, 'Documents', 'Cline', 'Workflows', 'Daily Standup.md'), 'standup');
    const list = await discoverCommands([root], { home });
    const by = Object.fromEntries(indexCommands(list));
    assert.strictEqual(by['/release'].body, 'project release', 'the workspace workflow overrides the global one');
    assert.strictEqual(by['/release'].source, 'project');
    assert.strictEqual(by['/notes'].body, 'notes body');
    assert.strictEqual(by['/cleanup'].source, 'user');
    assert.strictEqual(by['/daily-standup'].body, 'standup');
    assert.ok(!by['/off'], 'disabled: true hides the workflow');
    assert.ok(!by['/readme'], 'only .md, .markdown and .txt are commands');
    const all = await discoverCommands([root], { home, includeDisabled: true });
    assert.ok(all.some((c) => c.invoke === '/off' && c.disabled), 'Settings still lists the disabled file');
  });

  test('precedence: LocalPilot command, then skill, then custom command; any case, with or without .md', () => {
    const custom = parseCommandFile('/w/.claude/commands/review.md', 'custom review', { source: 'project' });
    const builtin = builtinCommands().find((c) => c.name === 'scan')!;
    assert.deepStrictEqual(pickSlashTarget(builtin, { name: 'scan' }), { command: builtin });
    assert.deepStrictEqual(pickSlashTarget(custom, { name: 'review' }), { skill: { name: 'review' } });
    assert.deepStrictEqual(pickSlashTarget(custom, undefined), { command: custom });
    assert.strictEqual(pickSlashTarget(undefined, undefined), undefined);
    const cmds = [custom, ...builtinCommands()];
    assert.deepStrictEqual(resolveSlashMessage('/review src/a.ts', cmds, [{ name: 'review' }]), { skill: 'review', task: 'src/a.ts' });
    const hit = resolveSlashMessage('/Review.md src/a.ts', cmds, []);
    assert.ok(hit && 'command' in hit && hit.command === custom && hit.args === 'src/a.ts' && !hit.inline);
    assert.deepStrictEqual(resolveSlashMessage('/pdf-tools extract page 2', cmds, [{ name: 'PDF Tools' }]), { skill: 'PDF Tools', task: 'extract page 2' });
    assert.strictEqual(resolveSlashMessage('/unknown thing', cmds, []), undefined);
  });

  test('findSlashToken: the first known command mid-message; paths, code and unknown names are skipped', () => {
    const known = (n: string) => n === 'review' || n === 'ship-it';
    assert.deepStrictEqual(findSlashToken('please /review this', known), { name: 'review', start: 7, end: 14 });
    assert.strictEqual(findSlashToken('see src/review and /usr/bin', known), undefined);
    assert.strictEqual(findSlashToken('/nope then /Ship-It', known)?.name, 'ship-it');
    assert.strictEqual(findSlashToken('```\n/review\n```\nthen go', known), undefined, 'fenced code is not a command');
    assert.strictEqual(findSlashToken('run /review, now', known), undefined, 'the token must end at whitespace');
    assert.strictEqual(findSlashToken('first /ship-it then /review', known)?.name, 'ship-it', 'only the first');
    const text = 'after the tests pass /review\nfocus on errors';
    const tok = findSlashToken(text, known)!;
    assert.strictEqual(spliceSlashToken(text, tok, 'REVIEW BODY'), 'after the tests pass REVIEW BODY\nfocus on errors');
  });

  test('inline expansion: a custom command mid-message expands, built-in commands only when they lead', async () => {
    const custom = parseCommandFile('/w/.claude/commands/review.md', 'Review the diff carefully.', { source: 'project' });
    const cmds = [custom, ...builtinCommands()];
    const hit = resolveSlashMessage('fix the bug, then /review', cmds, []);
    assert.ok(hit && 'command' in hit && hit.inline);
    const { prompt } = await expandCommand(hit.command, hit.args, { root: await tmp('inline') });
    assert.strictEqual(spliceSlashToken('fix the bug, then /review', hit.inline, prompt), 'fix the bug, then Review the diff carefully.');
    assert.strictEqual(resolveSlashMessage('please run /pr when done', cmds, []), undefined, 'a LocalPilot command expands only at the start');
    assert.strictEqual(resolveSlashMessage('then /compact', cmds, []), undefined);
  });

  test('chat: /smol compacts, /<skill> runs the skill, /deep-planning is a Plan-mode turn, /newtask hands off', async () => {
    const c = Object.create(ChatController.prototype) as any;
    const handled: any[] = [];
    const newTasks: any[] = [];
    const review = parseCommandFile('/w/.claude/commands/review.md', 'custom review', { source: 'project' });
    Object.assign(c, {
      handle: async (m: any) => handled.push(m),
      newTask: async (id: string, note: string) => newTasks.push({ id, note }),
      skills: { enabledSkills: [{ name: 'review' }, { name: 'pdf' }] },
      _commands: { get: (n: string) => (normalizeCommandName(n) === 'review' ? review : normalizeCommandName(n) === 'scan' ? builtinCommands().find((x) => x.name === 'scan') : undefined), all: [] },
      store: { save() {} },
      broadcast() {},
      sessionMsg: () => ({ type: 'session' }),
    });
    const s: any = { id: 's1', messages: [], mode: 'agent' };
    assert.strictEqual(c.handleSlash(s, '/smol'), '');
    assert.deepStrictEqual(handled, [{ type: 'compactNow', sessionId: 's1' }]);
    assert.strictEqual(c.handleSlash(s, '/newtask focus on the tests'), '');
    assert.deepStrictEqual(newTasks, [{ id: 's1', note: 'focus on the tests' }]);
    assert.deepStrictEqual(c.handleSlash(s, '/PDF fill the form'), { rewrite: skillTaskPrompt('pdf', 'fill the form') });
    assert.deepStrictEqual(c.handleSlash(s, '/review src'), { rewrite: skillTaskPrompt('review', 'src') }, 'a skill beats a custom command');
    assert.strictEqual(c.handleSlash(s, '/scan deps').command.name, 'scan', 'a LocalPilot command beats a skill');
    const plan = c.handleSlash(s, '/deep-planning add OAuth login');
    assert.strictEqual(plan.planTurn, true);
    assert.strictEqual(plan.rewrite, deepPlanningPrompt('add OAuth login'));
    assert.match(c.handleSlash(s, '/deep-planning'), /Usage/);
    assert.strictEqual(c.handleSlash(s, '/unknown'), undefined);
    assert.ok(c.inlineCommand('then /review it').inline, 'mid-message custom command');
    assert.strictEqual(c.inlineCommand('then /scan it'), undefined, 'built-in commands only lead');
  });
});
