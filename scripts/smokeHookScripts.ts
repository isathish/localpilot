/**
 * Smoke checks for hook scripts in hook folders (bundled into scripts/smoke.ts): event names (Cline's included),
 * interpreters, quoting, discovery with the executable bit, the synthesized hooks, and the hook-row status.
 */
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { discoverHookScripts, hookScriptHooks, hookTemplate, quoteHookArg, scriptEvent, scriptInterpreter } from '../src/agent/hookScripts';
import { hookRunStatus } from '../src/agent/hooks';

type Check = (name: string, cond: boolean, detail?: unknown) => void;

export async function hookScripts(check: Check): Promise<void> {
  console.log('\n[Hook scripts]');
  check('event names: native and Cline names, any case, optional extension', scriptEvent('pretooluse.SH')?.event === 'PreToolUse' && scriptEvent('TaskStart.py')?.matcher === 'startup' && scriptEvent('TaskResume')?.matcher === 'resume' && scriptEvent('taskcomplete.js')?.event === 'Stop' && scriptEvent('TaskCancel')?.event === 'TaskCancel' && !scriptEvent('lint.sh'));
  check('interpreter: shebang (env -S stripped), extension, bash', scriptInterpreter('/x/Stop', '#!/usr/bin/env -S node --no-warnings\n', 'linux').join(' ') === 'node --no-warnings' && scriptInterpreter('/x/Stop.ts', '', 'linux').join(' ') === 'node --experimental-strip-types' && scriptInterpreter('/x/Stop.ps1', '', 'win32')[0] === 'pwsh' && scriptInterpreter('/x/Stop', '', 'linux')[0] === 'bash');
  check('quoting for sh and cmd', quoteHookArg("/a b/c'd", 'linux') === `'/a b/c'\\''d'` && quoteHookArg('C:\\a b\\x.ps1', 'win32') === '"C:\\a b\\x.ps1"' && quoteHookArg('/plain/x.sh', 'linux') === '/plain/x.sh');
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'lp-smoke-hk-home-'));
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lp-smoke-hk-root-'));
  await fs.mkdir(path.join(root, '.cline', 'hooks'), { recursive: true });
  await fs.writeFile(path.join(root, '.cline', 'hooks', 'PostToolUse.py'), 'print("{}")\n', { mode: 0o755 });
  await fs.writeFile(path.join(root, '.cline', 'hooks', 'Stop.sh'), 'exit 0\n', { mode: 0o644 });
  const found = await discoverHookScripts([root], { home, env: {} });
  const hooks = hookScriptHooks(found);
  const unix = process.platform !== 'win32';
  check('discovery: scripts become hooks; on Unix a script without +x is listed but not run', found.length === 2 && /python/.test(hooks.PostToolUse?.[0].hooks[0].command ?? '') && hooks.PostToolUse?.[0].hooks[0].name === 'PostToolUse.py' && !!hooks.Stop === !unix, { found, hooks });
  await fs.writeFile(path.join(root, '.cline', 'hooks', 'PreToolUse.ps1.disabled'), 'exit 0\n', { mode: 0o755 });
  const off = (await discoverHookScripts([root], { home, env: {}, platform: 'win32' })).find((s) => s.name === 'PreToolUse.ps1.disabled');
  check('discovery: a script named ….disabled is listed off on every platform, with its own interpreter', off?.event === 'PreToolUse' && !off.enabled && /pwsh/.test(off.command), off);
  const r = (code: number | null, stdout = '') => ({ code, stdout, stderr: '', timedOut: false });
  check('hook rows: ok, failed, blocked (exit 2 or a deny)', hookRunStatus('Stop', r(0)) === 'ok' && hookRunStatus('Stop', r(1)) === 'failed' && hookRunStatus('UserPromptSubmit', r(2)) === 'blocked' && hookRunStatus('PreToolUse', r(0, '{"decision":"block"}')) === 'blocked');
  check('templates: bash and PowerShell, with the event fields and a neutral response', /tool_response/.test(hookTemplate('PostToolUse', 'bash')) && /echo '\{"continue": true\}'/.test(hookTemplate('Stop', 'bash')) && /ConvertFrom-Json/.test(hookTemplate('Stop', 'powershell')));
}
