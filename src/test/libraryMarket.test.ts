import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vm from 'vm';
import * as vscode from 'vscode';
import { dispatch, miniDocument } from './miniDom';
import { discoverCommands } from '../agent/commands';
import { deletePrompt, promptDirs, promptFileText, promptItems, promptName, promptsMarkdown, savePrompt, searchPrompts, suggestPromptName } from '../agent/promptLibrary';
import { catalogRows, contentsText, installedPlugin, loadPluginCatalog } from '../agent/pluginCatalog';
import { historyModeKey, inHistoryFolder, queryHistory } from '../sessions/historyQuery';
import { diskPreflight, DISK_HEADROOM_GB, modelPresent } from '../providers/colibriSetup';
import { COLIBRI_MODELS } from '../providers/colibri';
import { ChatController } from '../ui/chatController';
import type { PluginInfo } from '../agent/plugins';
import type { SessionSummary } from '../types';

const EXT_ROOT = path.resolve(__dirname, '..', '..');
const tmp = (p: string) => fs.mkdtempSync(path.join(os.tmpdir(), p));

suite('Prompt library: files, names, search', () => {
  test('names are checked and suggested from the first words', () => {
    assert.deepStrictEqual(promptName('  Review Diff '), { name: 'review-diff' });
    assert.deepStrictEqual(promptName('/release.md'), { name: 'release' });
    assert.ok('error' in promptName(''));
    assert.ok('error' in promptName('../x'));
    assert.ok('error' in promptName('a/b'));
    assert.ok('error' in promptName('!!!'));
    assert.strictEqual(suggestPromptName('Review this diff for security issues please'), 'review-diff-security-issues');
    assert.strictEqual(suggestPromptName('```\ncode\n```\nExplain @src/a.ts to me'), 'explain');
    assert.strictEqual(suggestPromptName(''), 'prompt');
  });

  test('a file keeps the front matter the library does not edit', () => {
    assert.strictEqual(promptFileText('Find bugs', 'Look for bugs.\n'), '---\ndescription: Find bugs\n---\nLook for bugs.\n');
    assert.strictEqual(promptFileText('', 'Just text'), 'Just text\n');
    assert.strictEqual(promptFileText('Note: risky', 'x'), '---\ndescription: "Note: risky"\n---\nx\n', 'a ": " is quoted');
    const prev = '---\r\ndescription: old\r\nallowed-tools: Bash(git diff:*)\r\nargument-hint: [file]\r\n---\r\nOld body\r\n';
    const next = promptFileText('New one', 'New\nbody', prev);
    assert.strictEqual(next, '---\r\ndescription: New one\r\nallowed-tools: Bash(git diff:*)\r\nargument-hint: [file]\r\n---\r\nNew\r\nbody\r\n');
    // Removing the description leaves the other keys.
    assert.strictEqual(promptFileText('', 'b', '---\ndescription: d\nmodel: x\n---\na\n'), '---\nmodel: x\n---\nb\n');
  });

  test('save, rename, move between scopes, refuse a taken name unless replacing, delete only listed files', async () => {
    const root = tmp('lp-pl-root-'); const home = tmp('lp-pl-home-');
    const dirs = promptDirs(root, home);
    const r1 = await savePrompt({ name: 'Review Diff', description: 'Find bugs', body: 'Review the diff.', scope: 'workspace' }, dirs);
    assert.ok(r1.ok);
    const f1 = path.join(root, '.localpilot', 'commands', 'review-diff.md');
    assert.strictEqual(r1.ok && r1.file, f1);
    assert.strictEqual(fs.readFileSync(f1, 'utf8'), '---\ndescription: Find bugs\n---\nReview the diff.\n');
    const taken = await savePrompt({ name: 'review-diff', description: '', body: 'Other', scope: 'workspace' }, dirs);
    assert.ok(!taken.ok && taken.exists === f1 && /already exists/.test(taken.error));
    const replaced = await savePrompt({ name: 'review-diff', description: '', body: 'Other', scope: 'workspace', overwrite: true }, dirs);
    assert.ok(replaced.ok);
    assert.strictEqual(fs.readFileSync(f1, 'utf8'), 'Other\n');
    // Editing in place keeps the file; a new name moves it; a new scope moves it to the home folder.
    const same = await savePrompt({ name: 'review-diff', description: 'd', body: 'Edited', scope: 'workspace', file: f1, fileScope: 'workspace' }, dirs, new Set([f1]));
    assert.ok(same.ok && same.file === f1 && !same.moved);
    const renamed = await savePrompt({ name: 'code-review', description: 'd', body: 'Edited', scope: 'workspace', file: f1, fileScope: 'workspace' }, dirs, new Set([f1]));
    const f2 = path.join(root, '.localpilot', 'commands', 'code-review.md');
    assert.ok(renamed.ok && renamed.file === f2 && renamed.moved === f1);
    assert.ok(!fs.existsSync(f1));
    const moved = await savePrompt({ name: 'code-review', description: 'd', body: 'Edited', scope: 'user', file: f2, fileScope: 'workspace' }, dirs, new Set([f2]));
    const f3 = path.join(home, '.localpilot', 'commands', 'code-review.md');
    assert.ok(moved.ok && moved.file === f3 && !fs.existsSync(f2));
    // No folder: workspace prompts are refused with a reason; empty text too.
    assert.match(String((await savePrompt({ name: 'x', description: '', body: 'y', scope: 'workspace' }, promptDirs(undefined, home)) as { error: string }).error), /Open a folder/);
    assert.match(String((await savePrompt({ name: 'x', description: '', body: '  ', scope: 'user' }, dirs) as { error: string }).error), /empty/);
    // A file outside the prompt folders and not listed as editable is never written over or deleted.
    const outside = path.join(root, 'notes.md'); fs.writeFileSync(outside, 'keep');
    assert.ok(!(await savePrompt({ name: 'notes', description: '', body: 'x', scope: 'user', file: outside, fileScope: 'user' }, dirs)).ok);
    assert.strictEqual(await deletePrompt(outside, new Set([f3])), false);
    assert.strictEqual(fs.readFileSync(outside, 'utf8'), 'keep');
    assert.strictEqual(await deletePrompt(f3, new Set([f3])), true);
    assert.ok(!fs.existsSync(f3));
  });

  test('the library lists workspace and user prompts as editable, plugins read-only, and searches them', async () => {
    const root = tmp('lp-pl-root-'); const home = tmp('lp-pl-home-');
    fs.mkdirSync(path.join(root, '.claude', 'commands'), { recursive: true });
    fs.mkdirSync(path.join(home, '.localpilot', 'commands'), { recursive: true });
    fs.writeFileSync(path.join(root, '.claude', 'commands', 'explain.md'), '---\nallowed-tools: Bash(git log:*)\n---\nExplain the errors');
    fs.writeFileSync(path.join(home, '.localpilot', 'commands', 'notes.md'), '---\ndescription: Release notes\n---\nDraft release notes for $ARGUMENTS');
    const pluginDir = path.join(root, 'plug'); fs.mkdirSync(path.join(pluginDir, 'commands'), { recursive: true });
    fs.writeFileSync(path.join(pluginDir, 'commands', 'commit.md'), 'Write a commit message');
    const plugins = { commandFiles: () => [{ file: path.join(pluginDir, 'commands', 'commit.md'), plugin: { name: 'git-tools' } }] } as never;
    const cmds = await discoverCommands([root], { home, plugins, managedDir: null });
    const items = promptItems(cmds, promptDirs(root, home), [root]);
    assert.deepStrictEqual(items.map((i) => [i.invoke, i.scope, i.editable]), [['/explain', 'workspace', true], ['/notes', 'user', true], ['/git-tools:commit', 'plugin', false]]);
    assert.strictEqual(items[0].origin, '.claude/commands');
    assert.deepStrictEqual(items[0].extra, ['allowed-tools']);
    assert.ok(!items.some((i) => i.invoke === '/pr'), 'built-in commands are not saved prompts');
    assert.deepStrictEqual(searchPrompts(items, 'release').map((i) => i.invoke), ['/notes']);
    assert.deepStrictEqual(searchPrompts(items, 'commit message').map((i) => i.invoke), ['/git-tools:commit']);
    assert.strictEqual(searchPrompts(items, '').length, 3);
    const md = promptsMarkdown(items);
    assert.match(md, /Workspace \(1\)[\s\S]*`\/explain`[\s\S]*You \(1\)[\s\S]*Plugins \(1\)/);
    assert.match(promptsMarkdown([]), /No saved prompts yet/);
  });
});

suite('Prompt library: chat host', () => {
  /** A controller with only what the prompt library uses, its commands rediscovered from temp folders. */
  function host(root: string, home: string) {
    const c = Object.create(ChatController.prototype) as any;
    const posted: any[] = [];
    let all: any[] = [];
    Object.assign(c, {
      promptHome: home,
      workspace: { root },
      store: { get: () => undefined },
      broadcast: (m: unknown) => posted.push(m),
      _commands: { get all() { return all; }, refresh: async () => { all = await discoverCommands([root], { home, managedDir: null }); } },
    });
    return { c, posted, refresh: () => c._commands.refresh() };
  }

  test('list, save (with a taken name), delete after the confirmation, open only listed files', async () => {
    const root = tmp('lp-plh-root-'); const home = tmp('lp-plh-home-');
    const h = host(root, home);
    await h.c.handle({ type: 'promptLibrary' });
    assert.deepStrictEqual(h.posted.pop(), { type: 'prompts', items: [], workspace: true, dirs: promptDirs(root, home) });
    await h.c.handle({ type: 'savePrompt', name: 'Fix tests', description: 'Run and fix', body: 'Run the tests and fix failures.', scope: 'workspace' });
    const list = h.posted.pop(); const saved = h.posted.pop();
    assert.deepStrictEqual(saved, { type: 'promptSaved', ok: true, invoke: '/fix-tests', file: path.join(root, '.localpilot', 'commands', 'fix-tests.md') });
    assert.deepStrictEqual(list.items.map((i: any) => [i.invoke, i.scope, i.description]), [['/fix-tests', 'workspace', 'Run and fix']]);
    await h.c.handle({ type: 'savePrompt', name: 'fix-tests', description: '', body: 'Again', scope: 'workspace' });
    assert.deepStrictEqual(h.posted.pop(), { type: 'promptSaved', ok: false, error: 'A prompt named /fix-tests already exists here.', exists: true });
    const file = list.items[0].file;
    const win = vscode.window as any; const original = win.showWarningMessage; const answers: (string | undefined)[] = [undefined, 'Delete'];
    win.showWarningMessage = async () => answers.shift();
    try {
      await h.c.handle({ type: 'deletePrompt', file });
      assert.ok(fs.existsSync(file), 'kept when the confirmation is dismissed');
      await h.c.handle({ type: 'deletePrompt', file });
      assert.ok(!fs.existsSync(file));
      assert.deepStrictEqual(h.posted.slice(-2).map((m: any) => m.type === 'toast' ? m.text : m.items.length), ['Deleted /fix-tests', 0]);
      // A path the library does not list is refused without asking.
      await h.c.handle({ type: 'deletePrompt', file: path.join(root, 'package.json') });
      assert.deepStrictEqual(h.posted.pop(), { type: 'toast', level: 'error', text: 'That prompt is read-only here' });
    } finally {
      win.showWarningMessage = original;
    }
  });

  test('/prompts in a message lists them when the chat sheet is not there', async () => {
    const root = tmp('lp-plh-root-'); const home = tmp('lp-plh-home-');
    fs.mkdirSync(path.join(home, '.localpilot', 'commands'), { recursive: true });
    fs.writeFileSync(path.join(home, '.localpilot', 'commands', 'standup.md'), 'Summarise what changed yesterday');
    const h = host(root, home); await h.refresh();
    const s: any = { id: 's1', messages: [], mode: 'agent' };
    Object.assign(h.c, { store: { get: () => undefined, save() {} }, sessionMsg: () => ({ type: 'session' }) });
    const out = String(h.c.handleSlash(s, '/prompts'));
    assert.match(out, /You \(1\)[\s\S]*`\/standup`: Summarise what changed yesterday/);
  });
});

type Fn = (...a: any[]) => any;

/** The prompt library section of media/chat.js, run against the markup the chat ships. */
function loadLibrary() {
  const src = fs.readFileSync(path.join(EXT_ROOT, 'media', 'chat.js'), 'utf8');
  const a = src.indexOf('  // ------------------------------------------------------------------ prompt library');
  const b = src.indexOf('  // end of prompt library', a);
  assert.ok(a > 0 && b > a, 'the prompt library section is in media/chat.js');
  const provider = fs.readFileSync(path.join(EXT_ROOT, 'src', 'ui', 'chatViewProvider.ts'), 'utf8');
  assert.match(provider, /<div id="promptLib" class="sheet hidden" role="dialog" aria-modal="true" aria-label="Prompt library"><\/div>/);
  for (const f of ['ui-preview.html', 'ui-preview-parallel.html']) {
    assert.ok(fs.readFileSync(path.join(EXT_ROOT, 'scripts', f), 'utf8').includes('id="promptLib"'), `${f} mirrors #promptLib`);
  }
  const doc = miniDocument();
  const sheet = doc.body.appendChild(doc.createElement('div')); sheet.setAttribute('id', 'promptLib'); sheet.className = 'sheet hidden';
  const input = doc.body.appendChild(doc.createElement('textarea'));
  const posted: any[] = []; const toasts: string[] = [];
  const document = { activeElement: null as unknown, createElement: doc.createElement, body: doc.body };
  const sandbox: Record<string, unknown> = {
    document, I: new Proxy({}, { get: () => '<svg></svg>' }),
    els: { promptLib: sheet, input },
    state: { session: { id: 's1' } },
    post: (m: unknown) => posted.push(JSON.parse(JSON.stringify(m))),
    toast: (t: string) => toasts.push(t),
    autoGrow: () => undefined, updateSendEnabled: () => undefined,
    el: (tag: string, cls?: string, html?: string) => { const e = doc.createElement(tag); if (cls) { e.className = cls; } if (html !== undefined) { e.innerHTML = html; } return e; },
    esc: (s: unknown) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!)),
  };
  vm.runInNewContext(`${src.slice(a, b)}\nout_ = { openPromptLib, closePromptLib, onPrompts, onPromptSaved, lib, suggestPromptName };`, sandbox, { timeout: 5000 });
  const out = sandbox.out_ as { openPromptLib: Fn; closePromptLib: Fn; onPrompts: Fn; onPromptSaved: Fn; suggestPromptName: Fn; lib: any };
  return { ...out, sheet, input, posted, toasts };
}

suite('Prompt library: chat sheet', () => {
  const items = [
    { name: 'review-diff', invoke: '/review-diff', description: 'Review the diff', body: 'Review my changes.', file: '/w/.localpilot/commands/review-diff.md', scope: 'workspace', origin: '.localpilot/commands', editable: true },
    { name: 'notes', invoke: '/notes', description: '', body: 'Draft release notes', file: '/h/.localpilot/commands/notes.md', scope: 'user', origin: '~/.localpilot/commands', editable: true },
    { name: 'commit', invoke: '/git:commit', description: 'Commit message', body: 'Write a commit message', file: '/p/commit.md', scope: 'plugin', origin: 'plugin git', editable: false },
  ];

  test('lists, filters by scope and search, inserts into the message box', () => {
    const l = loadLibrary();
    l.openPromptLib({});
    assert.ok(!l.sheet.classList.contains('hidden'));
    assert.deepStrictEqual(l.posted.pop(), { type: 'promptLibrary', sessionId: 's1' });
    assert.match(l.sheet.querySelector('.pl-rows')!.textContent, /Loading prompts/);
    l.onPrompts({ items, workspace: true });
    const names = () => l.sheet.querySelectorAll('.pl-row .nm').map((n) => n.textContent);
    assert.deepStrictEqual(names(), ['/review-diff', '/notes', '/git:commit']);
    assert.strictEqual(l.sheet.querySelectorAll('.pl-row')[2].querySelector('[data-l="edit"]'), null, 'plugin prompts are read-only');
    dispatch(l.sheet.querySelector('[data-scope-f="user"]')!, 'click');
    assert.deepStrictEqual(names(), ['/notes']);
    dispatch(l.sheet.querySelector('[data-scope-f="all"]')!, 'click');
    const search = l.sheet.querySelector('.search')!; search.value = 'commit'; dispatch(search, 'input');
    assert.deepStrictEqual(names(), ['/git:commit']);
    search.value = 'zzz'; dispatch(search, 'input');
    assert.match(l.sheet.querySelector('.pl-empty')!.textContent, /No prompt matches/);
    search.value = ''; dispatch(search, 'input');
    // Enter inserts the selected prompt below what is already typed and closes the sheet.
    l.input.value = 'Context first';
    dispatch(search, 'keydown', { key: 'ArrowDown' });
    dispatch(search, 'keydown', { key: 'Enter' });
    assert.strictEqual(l.input.value, 'Context first\n\nDraft release notes');
    assert.ok(l.sheet.classList.contains('hidden'));
    // Delete and Open go to the host (which asks before deleting).
    l.openPromptLib({}); l.onPrompts({ items, workspace: true });
    dispatch(l.sheet.querySelector('.pl-row [data-l="delete"]')!, 'click');
    assert.deepStrictEqual(l.posted.pop(), { type: 'deletePrompt', file: items[0].file, sessionId: 's1' });
    dispatch(l.sheet.querySelectorAll('.pl-row')[2].querySelector('[data-l="open"]')!, 'click');
    assert.deepStrictEqual(l.posted.pop(), { type: 'openPromptFile', file: '/p/commit.md' });
  });

  test('save as prompt: a suggested name, the scope, a taken name offers Replace, and saving closes', () => {
    const l = loadLibrary();
    l.openPromptLib({ edit: { body: 'Review this diff for security issues' } });
    const form = l.sheet.querySelector('.pl-form')!;
    const name = form.querySelector('[name="name"]')!;
    assert.strictEqual(name.getAttribute('value'), 'review-diff-security-issues');
    assert.match(l.sheet.querySelector('#pl-runs')!.textContent, /Runs as \/review-diff-security-issues/);
    l.onPrompts({ items: [], workspace: true });
    dispatch(l.sheet.querySelector('[data-scope="user"]')!, 'click');
    const f = () => l.sheet.querySelector('.pl-form')!;
    f().querySelector('[name="name"]')!.value = 'Sec Review'; f().querySelector('[name="desc"]')!.value = 'Security pass'; f().querySelector('[name="body"]')!.value = 'Review this diff for security issues';
    dispatch(f(), 'submit');
    assert.deepStrictEqual(l.posted.pop(), { type: 'savePrompt', name: 'Sec Review', description: 'Security pass', body: 'Review this diff for security issues', scope: 'user', sessionId: 's1' });
    l.onPromptSaved({ ok: false, error: 'A prompt named /sec-review already exists here.', exists: true });
    assert.match(l.sheet.querySelector('.pl-err')!.textContent, /already exists/);
    f().querySelector('[name="name"]')!.value = 'Sec Review'; f().querySelector('[name="desc"]')!.value = 'Security pass'; f().querySelector('[name="body"]')!.value = 'Review this diff for security issues';
    dispatch(l.sheet.querySelector('[data-l="replace"]')!, 'click');
    assert.strictEqual(l.posted.pop().overwrite, true);
    l.onPromptSaved({ ok: true, invoke: '/sec-review' });
    assert.ok(l.sheet.classList.contains('hidden'), 'saved from the composer: the sheet closes');
    assert.match(l.toasts.pop()!, /Saved \/sec-review/);
    // Without a folder, "This workspace" is off and new prompts go to the user's folder.
    l.openPromptLib({ edit: { body: 'x' } }); l.onPrompts({ items: [], workspace: false });
    assert.ok(l.sheet.querySelector('[data-scope="workspace"]')!.hasAttribute('disabled'));
    assert.strictEqual(l.sheet.querySelector('[data-scope="user"]')!.getAttribute('aria-checked'), 'true');
    // An empty name is refused in place, nothing is posted.
    f().querySelector('[name="name"]')!.value = '  '; f().querySelector('[name="body"]')!.value = 'x';
    dispatch(f(), 'submit');
    assert.match(l.sheet.querySelector('.pl-err')!.textContent, /Give the prompt a name/);
    assert.ok(!l.posted.some((m) => m.type === 'savePrompt' && m.name.trim() === ''));
  });

  test('the ⋯ menu, a sent message and /prompts reach the library', () => {
    const js = fs.readFileSync(path.join(EXT_ROOT, 'media', 'chat.js'), 'utf8');
    assert.match(js, /label: 'Prompt library…'[^\n]*openPromptLib\(/);
    assert.match(js, /label: 'Save as prompt…'[^\n]*openPromptLib\(\{ edit: \{ body: draft \}/);
    assert.match(js, /label: 'Marketplace…'[^\n]*post\(\{ type: 'openSettings', section: 'marketplace' \}\)/);
    assert.match(js, /dataset\.act === 'savePrompt'\) \{ openPromptLib\(\{ edit: \{ body: text\.trim\(\) \}/);
    assert.ok(js.includes("openPromptLib({ q: (lp[1] || '').trim() })"), '/prompts [words] opens the sheet');
    assert.match(js, /case 'prompts': onPrompts\(m\); break;/);
    assert.match(js, /case 'promptSaved': onPromptSaved\(m\); break;/);
    // The ⋯ button is shown at every width now (no narrow-only class).
    assert.match(fs.readFileSync(path.join(EXT_ROOT, 'src', 'ui', 'chatViewProvider.ts'), 'utf8'), /id="btnComposerMore" class="ib"/);
  });

  test('editing a listed prompt sends its file and scope; Esc goes back to the list', () => {
    const l = loadLibrary();
    l.openPromptLib({}); l.onPrompts({ items, workspace: true });
    dispatch(l.sheet.querySelector('.pl-row [data-l="edit"]')!, 'click');
    assert.match(l.sheet.querySelector('.tr-h')!.textContent, /Edit \/review-diff/);
    const f = l.sheet.querySelector('.pl-form')!;
    f.querySelector('[name="name"]')!.value = 'review-diff'; f.querySelector('[name="desc"]')!.value = 'Review the diff'; f.querySelector('[name="body"]')!.value = 'Changed';
    dispatch(f, 'submit');
    assert.deepStrictEqual(l.posted.pop(), { type: 'savePrompt', name: 'review-diff', description: 'Review the diff', body: 'Changed', scope: 'workspace', file: items[0].file, fileScope: 'workspace', sessionId: 's1' });
    l.lib.busy = false;
    dispatch(l.sheet.querySelector('.pl-form')!, 'keydown', { key: 'Escape' });
    assert.ok(l.sheet.querySelector('.pl-rows'), 'back on the list');
  });
});

suite('History: mode and folder filters', () => {
  const row = (id: string, o: Partial<SessionSummary>): SessionSummary => ({ id, title: id, createdAt: 0, updatedAt: Number(id.slice(1)), model: '', mode: 'agent', messageCount: 2, ...o });
  const rootA = path.resolve('/w/a'); const rootB = path.resolve('/w/b');
  const all = [row('s1', { mode: 'ask' }), row('s2', { mode: 'ask', specialist: 'review' }), row('s3', { mode: 'agent', specialist: 'review' }), row('s4', { mode: 'debug', folder: rootB }), row('s5', { mode: 'ask', folder: rootB })];

  test('a specialist counts only while it applies; a chat without a folder is in the first one', () => {
    assert.strictEqual(historyModeKey(all[1]), 'review');
    assert.strictEqual(historyModeKey(all[2]), 'agent', 'Review does not run in Agent: filed under Agent');
    assert.ok(inHistoryFolder({}, rootA, rootA));
    assert.ok(!inHistoryFolder({}, rootB, rootA));
    assert.ok(inHistoryFolder({ folder: `${rootB}${path.sep}` }, rootB));
    assert.ok(inHistoryFolder({ folder: 'C:\\Work\\API' }, 'c:\\work\\api'), 'Windows paths compare without case');
  });

  test('queryHistory narrows by mode and folder, together with search and pins', () => {
    const ids = (q: Parameters<typeof queryHistory>[1]) => queryHistory(all, q).rows.map((r) => r.id);
    assert.deepStrictEqual(ids({ mode: 'ask' }), ['s5', 's1']);
    assert.deepStrictEqual(ids({ mode: 'review' }), ['s2']);
    assert.deepStrictEqual(ids({ folder: rootB, defaultFolder: rootA }), ['s5', 's4']);
    assert.deepStrictEqual(ids({ folder: rootA, defaultFolder: rootA }), ['s3', 's2', 's1']);
    assert.deepStrictEqual(ids({ mode: 'ask', folder: rootB, defaultFolder: rootA }), ['s5']);
    assert.deepStrictEqual(ids({ mode: 'ask', query: 's1' }), ['s1']);
    const page = queryHistory(all, { mode: 'debug', folder: rootB });
    assert.deepStrictEqual([page.mode, page.folder, page.total], ['debug', rootB, 1]);
  });
});

suite('Marketplace: plugin catalog', () => {
  test('a local marketplace lists its plugins with what they add and whether they are installed', async () => {
    const dir = tmp('lp-mkt-');
    fs.mkdirSync(path.join(dir, '.claude-plugin'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.claude-plugin', 'marketplace.json'), JSON.stringify({ name: 'team', plugins: [{ name: 'feature-dev', description: 'Build features', source: './plugins/feature-dev', category: 'dev' }, { name: 'remote-one', source: { source: 'github', repo: 'a/b' } }] }));
    const p = path.join(dir, 'plugins', 'feature-dev');
    fs.mkdirSync(path.join(p, '.claude-plugin'), { recursive: true });
    fs.mkdirSync(path.join(p, 'agents')); fs.mkdirSync(path.join(p, 'commands')); fs.mkdirSync(path.join(p, 'skills', 'plan'), { recursive: true });
    fs.writeFileSync(path.join(p, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'feature-dev', version: '1.0.0' }));
    fs.writeFileSync(path.join(p, 'agents', 'architect.md'), '---\nname: architect\n---\nx');
    fs.writeFileSync(path.join(p, 'agents', 'explorer.md'), '---\nname: explorer\n---\nx');
    fs.writeFileSync(path.join(p, 'commands', 'feature.md'), 'Build $ARGUMENTS');
    fs.writeFileSync(path.join(p, 'skills', 'plan', 'SKILL.md'), '---\nname: plan\n---\nx');
    const installed = [{ name: 'remote-one', root: '/h/.localpilot/plugins/remote-one', source: 'workspace', enabled: false, version: '2.0' } as PluginInfo];
    const cat = await loadPluginCatalog([dir, path.join(dir, 'missing')], installed);
    assert.strictEqual(cat.errors.length, 1);
    assert.match(cat.errors[0].error, /no \.claude-plugin\/marketplace\.json/);
    assert.deepStrictEqual(cat.entries.map((e) => [e.name, e.market, e.contains && contentsText(e.contains), e.installed]), [
      ['feature-dev', 'team', '1 command, 2 subagents, 1 skill', undefined],
      ['remote-one', 'team', undefined, { scope: 'workspace', version: '2.0', enabled: false }],
    ]);
    // The first marketplace that lists a name wins; installed copies match by folder name too.
    assert.strictEqual(catalogRows([cat.markets[0], { ...cat.markets[0], spec: 'other', name: 'other' }], []).length, 2);
    assert.ok(installedPlugin({ name: 'My Plugin' }, [{ name: 'x', root: '/p/My-Plugin' } as PluginInfo]));
    assert.strictEqual(contentsText(undefined), '');
  });

  test('the settings webview has the Marketplace section, its host messages and a preview mock', () => {
    const js = fs.readFileSync(path.join(EXT_ROOT, 'media', 'settings.js'), 'utf8');
    assert.match(js, /marketplace: secMarketplace/);
    for (const t of ["type: 'pluginCatalog'", "type: 'installPlugin'", "type: 'installMcpCatalog'", "type: 'installRegistrySkill'"]) { assert.ok(js.includes(t), t); }
    const panel = fs.readFileSync(path.join(EXT_ROOT, 'src', 'ui', 'settingsPanel.ts'), 'utf8');
    assert.match(panel, /case 'pluginCatalog':/);
    assert.match(panel, /case 'installPlugin':/);
    const preview = fs.readFileSync(path.join(EXT_ROOT, 'scripts', 'settings-preview.html'), 'utf8');
    assert.match(preview, /m\.type === 'pluginCatalog'/);
  });
});

suite('colibri: disk-space preflight', () => {
  const smallest = COLIBRI_MODELS.find((m) => m.name === 'qwen3-coder-30b')!;

  test('enough room, too little room (with how much is missing and smaller models), unknown, nothing to download', () => {
    const ok = diskPreflight({ model: 'qwen3-coder-30b', dir: '/m', freeGb: 100, ramGb: 32 });
    assert.ok(ok.ok && ok.needGb === smallest.diskGb + DISK_HEADROOM_GB && ok.shortGb === 0);
    const short = diskPreflight({ model: 'glm-5.2', dir: '/m', freeGb: 120.7, ramGb: 32 });
    assert.ok(!short.ok);
    assert.strictEqual(short.shortGb, Math.ceil(429 + DISK_HEADROOM_GB - 120.7));
    assert.strictEqual(short.message, `glm-5.2 needs about 431 GB (a 429 GB download plus ${DISK_HEADROOM_GB} GB to work in), but the disk that holds /m has 120 GB free: 311 GB short.`);
    assert.ok(short.smaller.length > 0 && short.smaller.every((m) => m.diskGb + DISK_HEADROOM_GB <= 120.7), 'only models that fit are offered');
    const rec = diskPreflight({ model: 'recommended', dir: '/m', freeGb: 10, ramGb: 32 });
    assert.ok(!rec.ok && rec.spec?.name === 'qwen3-coder-30b');
    assert.match(rec.message, /Even the smallest model colibri can pick/);
    assert.deepStrictEqual(rec.smaller, []);
    assert.ok(diskPreflight({ model: 'glm-5.2', dir: '/m', freeGb: undefined, ramGb: 32 }).unknown);
    assert.ok(diskPreflight({ model: 'glm-5.2', dir: '/m', freeGb: 1, ramGb: 32, present: true }).ok, 'already downloaded');
    assert.ok(diskPreflight({ model: '/models/glm', dir: '/m', freeGb: 1, ramGb: 32 }).ok, 'a model folder downloads nothing');
  });

  test('a model already in the folder counts as present (a partial download too)', () => {
    const dir = tmp('lp-coli-');
    assert.ok(!modelPresent(dir, smallest));
    fs.mkdirSync(path.join(dir, 'qwen3-coder-30b'));
    assert.ok(!modelPresent(dir, smallest), 'an empty folder is not a download');
    fs.writeFileSync(path.join(dir, 'qwen3-coder-30b', 'part-0001.bin'), 'x');
    assert.ok(modelPresent(dir, smallest));
    assert.ok(!modelPresent(path.join(dir, 'nope'), smallest));
    assert.ok(!modelPresent(dir, undefined));
  });
});
