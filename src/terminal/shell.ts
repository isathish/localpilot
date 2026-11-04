import * as fs from 'fs';

export interface ShellInvocation {
  file: string;
  args: string[];
  windowsVerbatimArguments?: boolean;
}

/**
 * How to run `command` through the system shell in a child process. On Windows this mirrors Node's own
 * `shell: true` (cmd.exe with the command line passed verbatim, so its quotes survive); elsewhere it uses
 * $SHELL when it exists, then bash, then sh (containers often have neither zsh nor bash).
 */
export function shellInvocation(command: string, o: { login?: boolean; posixShell?: string; platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv; exists?: (p: string) => boolean } = {}): ShellInvocation {
  const platform = o.platform ?? process.platform;
  const env = o.env ?? process.env;
  if (platform === 'win32') {
    return { file: env.ComSpec ?? 'cmd.exe', args: ['/d', '/s', '/c', `"${command}"`], windowsVerbatimArguments: true };
  }
  const exists = o.exists ?? fs.existsSync;
  const file = o.posixShell ?? (env.SHELL && exists(env.SHELL) ? env.SHELL : exists('/bin/bash') ? '/bin/bash' : '/bin/sh');
  return { file, args: [o.login ? '-lc' : '-c', command] };
}
