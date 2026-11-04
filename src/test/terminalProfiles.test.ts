import * as assert from 'assert';
import * as vscode from 'vscode';
import { getConfig } from '../config';
import { isSupportedShell, profileInvocation, profileNames, profileOsKey, resolveTerminalProfile } from '../terminal/profiles';

suite('Agent terminal profile and shell integration timeout', () => {
  const profiles = {
    zsh: { path: 'zsh', args: ['-l'] },
    'Git Bash': { path: ['C:\\missing\\bash.exe', '${env:PROGRAMFILES}\\Git\\bin\\bash.exe'], args: '--login' },
    PowerShell: { source: 'PowerShell' },
    tmux: null,
  };
  const exists = (p: string) => p === 'C:\\Programs\\Git\\bin\\bash.exe';

  test('profileOsKey and profileNames', () => {
    assert.strictEqual(profileOsKey('darwin'), 'osx');
    assert.strictEqual(profileOsKey('win32'), 'windows');
    assert.strictEqual(profileOsKey('linux'), 'linux');
    assert.deepStrictEqual(profileNames(profiles), ['zsh', 'Git Bash', 'PowerShell']);
    assert.deepStrictEqual(profileNames(undefined), []);
  });

  test('resolveTerminalProfile picks the first existing path, expands env vars and normalises args', () => {
    const posix = { env: { PATH: '/usr/bin:/bin' }, exists: (p: string) => p === '/bin/zsh', platform: 'linux' as const };
    assert.strictEqual(resolveTerminalProfile('default', profiles), undefined);
    assert.strictEqual(resolveTerminalProfile('nope', profiles), undefined);
    assert.strictEqual(resolveTerminalProfile('tmux', profiles), undefined, 'disabled profile');
    assert.deepStrictEqual(resolveTerminalProfile('zsh', profiles, posix), { name: 'zsh', path: '/bin/zsh', args: ['-l'], env: undefined }, 'bare name found on PATH');
    assert.strictEqual(resolveTerminalProfile('fish', { fish: { path: 'fish' } }, posix), undefined, 'bare name not on PATH');
    const git = resolveTerminalProfile('Git Bash', profiles, { env: { PROGRAMFILES: 'C:\\Programs' }, exists });
    assert.deepStrictEqual(git && { path: git.path, args: git.args }, { path: 'C:\\Programs\\Git\\bin\\bash.exe', args: ['--login'] });
    assert.strictEqual(resolveTerminalProfile('Git Bash', profiles, { env: {}, exists }), undefined, 'no candidate exists');
  });

  test('resolveTerminalProfile finds the built-in PowerShell and Git Bash source profiles', () => {
    const win = { platform: 'win32' as const };
    const env = { Path: 'C:\\Windows;C:\\Tools', PATHEXT: '.COM;.EXE', SystemRoot: 'C:\\Windows', ProgramFiles: 'C:\\Program Files', LocalAppData: 'C:\\Users\\me\\AppData\\Local' };
    const ps = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
    assert.strictEqual(resolveTerminalProfile('PowerShell', profiles, { ...win, env, exists: (p) => p === ps })?.path, ps, 'Windows PowerShell');
    assert.strictEqual(resolveTerminalProfile('PowerShell', profiles, { ...win, env, exists: (p) => p === ps || p === 'C:\\Tools\\pwsh.exe' })?.path, 'C:\\Tools\\pwsh.exe', 'pwsh on PATH first');
    assert.strictEqual(resolveTerminalProfile('PowerShell', profiles, { ...win, env, exists: () => false }), undefined);
    const src = { 'Git Bash': { source: 'Git Bash' } };
    const local = 'C:\\Users\\me\\AppData\\Local\\Programs\\Git\\bin\\bash.exe';
    const gb = resolveTerminalProfile('Git Bash', src, { ...win, env, exists: (p) => p === local });
    assert.deepStrictEqual(gb && { path: gb.path, args: gb.args }, { path: local, args: ['--login'] });
    assert.strictEqual(resolveTerminalProfile('Git Bash', src, { ...win, env, exists: (p) => p === 'C:\\Program Files\\Git\\bin\\bash.exe' })?.path, 'C:\\Program Files\\Git\\bin\\bash.exe');
    assert.strictEqual(resolveTerminalProfile('Git Bash', src, { ...win, env, exists: () => false }), undefined);
  });

  test('profileInvocation builds the child-process command line per shell', () => {
    assert.deepStrictEqual(profileInvocation('ls', { name: 'zsh', path: '/bin/zsh', args: ['-l', '-o', 'x'] }, { login: true }), { file: '/bin/zsh', args: ['-o', 'x', '-lc', 'ls'] });
    assert.deepStrictEqual(profileInvocation('ls', { name: 'fish', path: '/usr/bin/fish', args: [] }), { file: '/usr/bin/fish', args: ['-c', 'ls'] });
    assert.deepStrictEqual(profileInvocation('dir', { name: 'cmd', path: 'C:\\Windows\\System32\\cmd.exe', args: ['/k', 'init.bat'] }), {
      file: 'C:\\Windows\\System32\\cmd.exe',
      args: ['/d', '/s', '/c', '"dir"'],
      windowsVerbatimArguments: true,
    });
    assert.deepStrictEqual(profileInvocation('gci', { name: 'pwsh', path: 'C:\\pwsh\\pwsh.exe', args: ['-NoLogo', '-NoExit'] }).args, ['-NoLogo', '-Command', 'gci']);
    assert.strictEqual(profileInvocation('ls', undefined, { platform: 'linux' }).args.at(-1), 'ls');
    const tmux = profileInvocation('ls', { name: 'tmux', path: '/usr/bin/tmux', args: ['new-session'] }, { login: true, platform: 'linux' });
    assert.notStrictEqual(tmux.file, '/usr/bin/tmux', 'a non-shell profile falls back to the system shell');
    assert.ok(!tmux.args.includes('new-session') && tmux.args.at(-1) === 'ls');
    assert.ok(!isSupportedShell({ name: 'WSL', path: 'C:\\Windows\\System32\\wsl.exe', args: ['-d', 'Ubuntu'] }));
    assert.ok(isSupportedShell({ name: 'pwsh', path: 'C:\\pwsh\\pwsh.exe', args: [] }));
  });

  test('getConfig reads the timeout (clamped) and the profile name', async () => {
    const cfg = vscode.workspace.getConfiguration('localpilot');
    assert.strictEqual(getConfig().terminal.shellIntegrationTimeout, 4000);
    assert.strictEqual(getConfig().terminal.profile, 'default');
    try {
      await cfg.update('terminal.shellIntegrationTimeout', 100, vscode.ConfigurationTarget.Global);
      await cfg.update('terminal.profile', 'zsh', vscode.ConfigurationTarget.Global);
      assert.strictEqual(getConfig().terminal.shellIntegrationTimeout, 500);
      assert.strictEqual(getConfig().terminal.profile, 'zsh');
      await cfg.update('terminal.shellIntegrationTimeout', 9000, vscode.ConfigurationTarget.Global);
      assert.strictEqual(getConfig().terminal.shellIntegrationTimeout, 9000);
    } finally {
      await cfg.update('terminal.shellIntegrationTimeout', undefined, vscode.ConfigurationTarget.Global);
      await cfg.update('terminal.profile', undefined, vscode.ConfigurationTarget.Global);
    }
  });

  test('the profile picker command is registered', async () => {
    assert.ok((await vscode.commands.getCommands(true)).includes('localpilot.selectTerminalProfile'));
  });
});
