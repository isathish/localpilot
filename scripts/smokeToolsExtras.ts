/**
 * Smoke checks (bundled into scripts/smoke.ts) for the new-errors report after edits, the agent terminal profile
 * resolver and the compact notebook view of read_file.
 */
import { newErrorLines } from '../src/tools/editDiagnostics';
import { profileInvocation, profileNames, resolveTerminalProfile } from '../src/terminal/profiles';
import { notebookToCompactText } from '../src/context/extractors';

type Check = (name: string, cond: boolean, detail?: unknown) => void;

export function toolsExtras(check: Check): void {
  console.log('\n[new errors after edits / terminal profiles / notebooks]');
  const fresh = newErrorLines([{ line: 1, message: 'a' }], [{ line: 1, message: 'a' }, { line: 6, message: 'b' }]);
  check('newErrorLines reports only errors new since the edit, 1-based', JSON.stringify(fresh) === '["7: b"]', fresh);
  const shifted = newErrorLines([{ line: 49, message: 'a' }], [{ line: 52, message: 'a' }, { line: 10, message: 'c' }]);
  check('newErrorLines ignores old errors moved by inserted lines', JSON.stringify(shifted) === '["11: c"]', shifted);
  check('newErrorLines caps at 10', newErrorLines([], Array.from({ length: 20 }, (_, i) => ({ line: i, message: 'x' }))).length === 10);

  const profiles = { bash: { path: ['/nope/bash', '/bin/bash'], args: ['-l'] }, off: null, ps: { source: 'PowerShell' } };
  const exists = (p: string) => p === '/bin/bash';
  const bash = resolveTerminalProfile('bash', profiles, { exists });
  check('profile resolver: first existing path, args kept', bash?.path === '/bin/bash' && bash.args.join() === '-l', bash);
  check('profile resolver: default, disabled, missing source and unknown fall back', ['default', 'off', 'ps', 'zzz'].every((n) => resolveTerminalProfile(n, profiles, { exists, env: {} }) === undefined));
  const winEnv = { Path: 'C:\\Tools', SystemRoot: 'C:\\Windows', ProgramFiles: 'C:\\Program Files' };
  const ps = resolveTerminalProfile('ps', profiles, { env: winEnv, platform: 'win32', exists: (p) => p === 'C:\\Tools\\pwsh.exe' });
  check('profile resolver: source-only PowerShell finds pwsh on PATH', ps?.path === 'C:\\Tools\\pwsh.exe', ps);
  const gitBash = resolveTerminalProfile('g', { g: { source: 'Git Bash' } }, { env: winEnv, platform: 'win32', exists: (p) => p === 'C:\\Program Files\\Git\\bin\\bash.exe' });
  check('profile resolver: source-only Git Bash finds bash.exe with --login', gitBash?.path === 'C:\\Program Files\\Git\\bin\\bash.exe' && gitBash.args.join() === '--login', gitBash);
  check('profile resolver: bare name not on PATH falls back', resolveTerminalProfile('f', { f: { path: 'fish' } }, { env: { PATH: '/usr/bin' }, exists, platform: 'linux' }) === undefined);
  check('profileNames skips disabled entries', profileNames(profiles).join() === 'bash,ps');
  const inv = profileInvocation('echo hi', bash, { login: true });
  check('profileInvocation: posix shell with -lc, no duplicate login flag', inv.file === '/bin/bash' && JSON.stringify(inv.args) === '["-lc","echo hi"]', inv);
  const tmux = profileInvocation('ls', { name: 'tmux', path: 'tmux', args: ['new-session'] }, { platform: 'linux' });
  check('profileInvocation: non-shell profile (tmux) uses the system shell', tmux.file !== 'tmux' && JSON.stringify(tmux.args) === '["-c","ls"]', tmux);
  check('profileInvocation: cmd.exe verbatim /c', profileInvocation('dir', { name: 'cmd', path: 'C:\\Windows\\cmd.exe', args: ['/k'] }).args.join(' ') === '/d /s /c "dir"');

  const nb = notebookToCompactText(
    JSON.stringify({ cells: [{ cell_type: 'code', execution_count: 3, source: 'plot()', outputs: [{ output_type: 'display_data', data: { 'image/png': '', 'text/plain': '<Figure>' } }, { output_type: 'stream', text: 'ok' }] }] })
  );
  check('compact notebook: header with exec count, images dropped', nb.text === '# [code] cell 1 (exec 3)\nplot()\n# output:\nok', nb.text);
}
