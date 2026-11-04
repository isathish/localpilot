import * as assert from 'assert';
import * as cp from 'child_process';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { discoverHookScripts, hookScriptHooks, hookTemplate, quoteHookArg, scriptEvent, scriptInterpreter } from '../agent/hookScripts';
import { HookRunInfo, HookRunner, hookRunStatus } from '../agent/hooks';
import { HOOK_EVENTS, loadProjectSettings } from '../agent/settings';
import { createItem, deleteItem, listCustomizations, newItemFileName, setItemEnabled } from '../ui/customize';

const unix = process.platform !== 'win32';
const quiet = { info() {}, warn() {}, debug() {} };
const tmp = (p: string) => fs.mkdtemp(path.join(os.tmpdir(), p));

suite('Hook scripts: names and interpreters', () => {
  test('file names map to events, case-insensitively, with Cline names folded in', () => {
    assert.deepStrictEqual(scriptEvent('PreToolUse.sh'), { event: 'PreToolUse' });
    assert.deepStrictEqual(scriptEvent('pretooluse'), { event: 'PreToolUse' });
    assert.deepStrictEqual(scriptEvent('TaskStart.py'), { event: 'SessionStart', matcher: 'startup' });
    assert.deepStrictEqual(scriptEvent('taskresume.js'), { event: 'SessionStart', matcher: 'resume' });
    assert.deepStrictEqual(scriptEvent('TaskComplete.ps1'), { event: 'Stop' });
    assert.deepStrictEqual(scriptEvent('TaskCancel.sh'), { event: 'TaskCancel' });
    assert.deepStrictEqual(scriptEvent('TaskError'), { event: 'TaskError' });
    assert.strictEqual(scriptEvent('README.md'), undefined);
    assert.strictEqual(scriptEvent('lint.sh'), undefined);
    assert.ok(HOOK_EVENTS.includes('TaskCancel') && HOOK_EVENTS.includes('TaskError'));
  });

  test('the interpreter comes from the shebang, else the extension, else bash', () => {
    assert.deepStrictEqual(scriptInterpreter('/h/Stop', '#!/usr/bin/env -S python3 -u\nprint()', 'linux'), ['python3', '-u']);
    assert.deepStrictEqual(scriptInterpreter('/h/Stop', '#!/bin/zsh\n', 'darwin'), ['/bin/zsh']);
    assert.deepStrictEqual(scriptInterpreter('C:\\h\\Stop', '#!/bin/bash\n', 'win32'), ['bash']);
    assert.deepStrictEqual(scriptInterpreter('/h/Stop.mjs', '', 'linux'), ['node']);
    assert.deepStrictEqual(scriptInterpreter('/h/Stop.ts', '', 'linux'), ['node', '--experimental-strip-types']);
    assert.deepStrictEqual(scriptInterpreter('/h/Stop.py', '', 'linux'), ['python3']);
    assert.deepStrictEqual(scriptInterpreter('/h/Stop.py', '', 'win32'), ['python']);
    assert.deepStrictEqual(scriptInterpreter('/h/Stop.ps1', '', 'linux'), ['pwsh', '-NoProfile', '-File']);
    assert.deepStrictEqual(scriptInterpreter('/h/Stop', 'echo hi', 'linux'), ['bash']);
  });

  test('paths are quoted for the hook shell', () => {
    assert.strictEqual(quoteHookArg('/a/b.sh', 'linux'), '/a/b.sh');
    assert.strictEqual(quoteHookArg("/a b/it's.sh", 'linux'), `'/a b/it'\\''s.sh'`);
    assert.strictEqual(quoteHookArg('C:\\My Hooks\\Stop.ps1', 'win32'), '"C:\\My Hooks\\Stop.ps1"');
  });
});

suite('Hook scripts: discovery and running', () => {
  test('scripts in the hook folders are found; on Unix one without the executable bit is listed but not run', async () => {
    const home = await tmp('lp-hk-home-');
    const root = await tmp('lp-hk-root-');
    const extra = await tmp('lp-hk-extra-');
    await fs.mkdir(path.join(root, '.clinerules', 'hooks'), { recursive: true });
    await fs.mkdir(path.join(home, '.cline', 'hooks'), { recursive: true });
    await fs.writeFile(path.join(root, '.clinerules', 'hooks', 'PreToolUse.sh'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    await fs.writeFile(path.join(root, '.clinerules', 'hooks', 'notes.txt'), 'x');
    await fs.writeFile(path.join(home, '.cline', 'hooks', 'TaskStart'), '#!/bin/sh\nexit 0\n', { mode: 0o644 });
    await fs.writeFile(path.join(extra, 'TaskError.sh'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const found = await discoverHookScripts([root], { home, extraDirs: [extra], env: {} });
    const by = (n: string) => found.find((s) => s.name === n);
    assert.strictEqual(by('PreToolUse.sh')?.event, 'PreToolUse');
    assert.strictEqual(by('PreToolUse.sh')?.scope, 'workspace');
    assert.strictEqual(by('notes.txt')?.event, undefined);
    assert.strictEqual(by('TaskStart')?.matcher, 'startup');
    assert.strictEqual(by('TaskStart')?.scope, 'global');
    assert.strictEqual(by('TaskStart')?.enabled, !unix);
    assert.strictEqual(by('TaskError.sh')?.event, 'TaskError');
    const hooks = hookScriptHooks(found);
    assert.strictEqual(hooks.PreToolUse?.length, 1);
    assert.strictEqual(hooks.PreToolUse?.[0].hooks[0].name, 'PreToolUse.sh');
    assert.strictEqual(!!hooks.SessionStart, !unix, 'a script without the executable bit does not run');
    assert.strictEqual(hooks.TaskError?.length, 1);
  });

  test('a hook script runs through loadProjectSettings and the HookRunner, and reports its rows', async function () {
    if (!unix) {
      this.skip();
    }
    const home = await tmp('lp-hk-home-');
    const root = await tmp('lp-hk-root-');
    const dir = path.join(root, '.localpilot', 'hooks');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'pretooluse.sh'), '#!/bin/sh\ncat > "$LOCALPILOT_PROJECT_DIR/seen.json"\necho "no rm" >&2\nexit 2\n', { mode: 0o755 });
    await fs.writeFile(path.join(dir, 'TaskCancel'), '#!/bin/sh\ncat > "$LOCALPILOT_PROJECT_DIR/cancel.json"\n', { mode: 0o755 });
    const settings = await loadProjectSettings([root], { home });
    const runner = new HookRunner(() => settings, quiet);
    assert.ok(runner.has('PreToolUse') && runner.has('TaskCancel'));
    const rows: HookRunInfo[] = [];
    const r = await runner.run('PreToolUse', { session_id: 's1', tool_name: 'Bash', localpilot_tool_name: 'run_command' }, { cwd: root, matchKeys: ['run_command', 'Bash'], onRun: (h) => rows.push(h) });
    assert.ok(r.block);
    assert.deepStrictEqual(r.reasons, ['no rm']);
    const seen = JSON.parse(await fs.readFile(path.join(root, 'seen.json'), 'utf8')) as Record<string, unknown>;
    assert.strictEqual(seen.hook_event_name, 'PreToolUse');
    assert.strictEqual(seen.tool_name, 'Bash');
    assert.deepStrictEqual(rows.map((x) => x.status), ['running', 'blocked']);
    assert.strictEqual(rows[1].name, 'pretooluse.sh');
    assert.strictEqual(rows[1].tool, 'run_command');
    assert.strictEqual(rows[0].id, rows[1].id);
    assert.ok(typeof rows[1].ms === 'number');
    await runner.run('TaskCancel', { session_id: 's1' }, { cwd: root });
    assert.strictEqual((JSON.parse(await fs.readFile(path.join(root, 'cancel.json'), 'utf8')) as { hook_event_name: string }).hook_event_name, 'TaskCancel');
  });

  test('a finished hook reads ok, failed or blocked', () => {
    const r = (code: number | null, stdout = '', timedOut = false) => ({ code, stdout, stderr: '', timedOut });
    assert.strictEqual(hookRunStatus('Stop', r(0)), 'ok');
    assert.strictEqual(hookRunStatus('Stop', r(1)), 'failed');
    assert.strictEqual(hookRunStatus('Stop', r(null, '', true)), 'failed');
    assert.strictEqual(hookRunStatus('Stop', r(2)), 'blocked');
    assert.strictEqual(hookRunStatus('PreToolUse', r(0, '{"hookSpecificOutput":{"permissionDecision":"deny"}}')), 'blocked');
  });
});

suite('Hook scripts: templates and the Customize Hooks tab', () => {
  test('the bash template prints a valid, neutral response', async function () {
    if (!unix) {
      this.skip();
    }
    const t = hookTemplate('PreToolUse', 'bash');
    assert.ok(t.startsWith('#!/usr/bin/env bash') && t.includes('tool_input'));
    const out = cp.spawnSync('bash', ['-c', t], { input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash' }), encoding: 'utf8' });
    assert.strictEqual(out.status, 0, out.stderr);
    assert.deepStrictEqual(JSON.parse(out.stdout), { continue: true });
    assert.match(out.stderr, /tool_name=.*Bash/);
    assert.match(hookTemplate('TaskError', 'powershell'), /ConvertFrom-Json[\s\S]*'\{"continue": true\}'/);
  });

  test('new hooks are named after an event; only events without a hook are offered', async () => {
    const home = await tmp('lp-hk-home-');
    const root = await tmp('lp-hk-root-');
    assert.strictEqual(newItemFileName('hook', 'pretooluse.sh'), 'PreToolUse.sh');
    assert.strictEqual(newItemFileName('hook', 'Stop.ps1'), 'Stop.ps1');
    assert.throws(() => newItemFileName('hook', 'lint-guard'), /named after its event/);
    assert.throws(() => newItemFileName('hook', 'Stop.py'), /bash/);
    const before = await listCustomizations([root], home);
    assert.ok(before.events.includes('Stop'));
    const r = await createItem('hook', 'Stop.sh', 'workspace', [root], home);
    assert.ok(r.created && r.file === path.join(root, '.localpilot', 'hooks', 'Stop.sh'));
    const after = await listCustomizations([root], home);
    assert.ok(!after.events.includes('Stop'));
    const item = after.hooks.find((h) => h.file === r.file);
    assert.ok(item && item.editable && !item.notRun, JSON.stringify(item));
    if (unix) {
      assert.strictEqual((await fs.stat(r.file)).mode & 0o777 & ~0o022, 0o644 & ~0o022);
      assert.ok(item.disabled, 'created switched off');
      await setItemEnabled('hook', r.file, true, [root], home);
      assert.ok(((await fs.stat(r.file)).mode & 0o111) !== 0);
      assert.ok(!(await listCustomizations([root], home)).hooks.find((h) => h.file === r.file)?.disabled);
      await setItemEnabled('hook', r.file, false, [root], home);
      assert.strictEqual((await fs.stat(r.file)).mode & 0o111, 0);
    }
    await deleteItem('hook', r.file, [root], home);
    await assert.rejects(fs.stat(r.file));
  });
});

suite('Customize: plugins tab', () => {
  test('installed plugins are listed, switched through enabledPlugins and removed from a plugins folder', async () => {
    const home = await tmp('lp-pl-home-');
    const root = await tmp('lp-pl-root-');
    const plug = path.join(root, '.localpilot', 'plugins', 'demo');
    await fs.mkdir(path.join(plug, '.claude-plugin'), { recursive: true });
    await fs.writeFile(path.join(plug, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'demo', description: 'A demo plugin', version: '1.2.0' }));
    await fs.mkdir(path.join(plug, 'commands'), { recursive: true });
    await fs.writeFile(path.join(plug, 'commands', 'hi.md'), 'Say hi');
    let p = (await listCustomizations([root], home)).plugins.find((x) => x.name === 'demo');
    assert.ok(p && !p.disabled && p.removable && p.scope === 'workspace' && p.version === '1.2.0', JSON.stringify(p));
    await setItemEnabled('plugin', plug, false, [root], home);
    const settings = JSON.parse(await fs.readFile(path.join(root, '.localpilot', 'settings.json'), 'utf8')) as { enabledPlugins: Record<string, boolean> };
    assert.strictEqual(settings.enabledPlugins.demo, false);
    p = (await listCustomizations([root], home)).plugins.find((x) => x.name === 'demo');
    assert.ok(p?.disabled);
    await setItemEnabled('plugin', plug, true, [root], home);
    assert.ok(!(await listCustomizations([root], home)).plugins.find((x) => x.name === 'demo')?.disabled);
    await assert.rejects(createItem('plugin', 'x', 'workspace', [root], home), /Browse Plugins/);
    await deleteItem('plugin', plug, [root], home);
    await assert.rejects(fs.stat(plug));
  });

  test('a workspace that is itself a plugin is listed but never deleted from here', async () => {
    const home = await tmp('lp-pl-home-');
    const root = await tmp('lp-pl-root-');
    await fs.mkdir(path.join(root, '.claude-plugin'), { recursive: true });
    await fs.writeFile(path.join(root, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'self' }));
    const p = (await listCustomizations([root], home)).plugins.find((x) => x.name === 'self');
    assert.ok(p && !p.removable);
    await assert.rejects(deleteItem('plugin', root, [root], home), /not in a plugins folder/);
    await fs.stat(path.join(root, '.claude-plugin', 'plugin.json'));
  });
});
