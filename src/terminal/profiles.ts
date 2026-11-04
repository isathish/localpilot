import * as fs from 'fs';
import * as path from 'path';
import { ShellInvocation, shellInvocation } from './shell';

/** One entry of VS Code's `terminal.integrated.profiles.<os>` (null disables a built-in profile). */
export interface TerminalProfileEntry {
  path?: string | string[];
  args?: string | string[];
  source?: string;
  env?: Record<string, string | null>;
}

export interface ResolvedProfile {
  name: string;
  path: string;
  args: string[];
  env?: Record<string, string | null>;
}

/** The settings key suffix VS Code uses for this platform's profiles. */
export function profileOsKey(platform: NodeJS.Platform = process.platform): 'windows' | 'osx' | 'linux' {
  return platform === 'win32' ? 'windows' : platform === 'darwin' ? 'osx' : 'linux';
}

/** Profile names that can be chosen: enabled entries (not null), in settings order. */
export function profileNames(profiles: Record<string, TerminalProfileEntry | null> | undefined): string[] {
  return Object.entries(profiles ?? {})
    .filter(([, p]) => p && typeof p === 'object')
    .map(([name]) => name);
}

const expandVars = (s: string, env: NodeJS.ProcessEnv): string => s.replace(/\$\{env:([^}]+)\}/g, (_, k: string) => env[k] ?? '').replace(/^~(?=$|[\\/])/, env.HOME ?? env.USERPROFILE ?? '~');

/** `name` looked up on PATH (with PATHEXT on Windows), as a full path; undefined when not found. */
export function findOnPath(name: string, env: NodeJS.ProcessEnv, exists: (p: string) => boolean, platform: NodeJS.Platform = process.platform): string | undefined {
  const win = platform === 'win32';
  const p = win ? path.win32 : path.posix;
  const dirs = (env.PATH ?? env.Path ?? '').split(win ? ';' : ':').filter(Boolean);
  const exts = win && !/\.[^.\\/]+$/.test(name) ? (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean) : [''];
  for (const dir of dirs) {
    for (const ext of exts) {
      const full = p.join(dir, name + ext.toLowerCase());
      if (exists(full)) {
        return full;
      }
    }
  }
  return undefined;
}

/** Where VS Code's built-in `source` profiles live on Windows. */
function resolveSource(source: string, env: NodeJS.ProcessEnv, exists: (p: string) => boolean, platform: NodeJS.Platform): { path: string; args: string[] } | undefined {
  const j = path.win32.join;
  if (source === 'PowerShell') {
    const pwsh = findOnPath('pwsh', env, exists, platform);
    const builtin = env.SystemRoot ?? env.SYSTEMROOT ?? env.windir ?? env.WINDIR;
    const shell = pwsh ?? (builtin ? [j(builtin, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')].find(exists) : undefined);
    return shell ? { path: shell, args: [] } : undefined;
  }
  if (source === 'Git Bash') {
    const roots = [env.ProgramFiles ?? env.PROGRAMFILES, env['ProgramFiles(x86)'] ?? env['PROGRAMFILES(X86)']].map((r) => r && j(r, 'Git'));
    const local = env.LocalAppData ?? env.LOCALAPPDATA;
    const shell = [...roots, local && j(local, 'Programs', 'Git')].filter((r): r is string => !!r).map((r) => j(r, 'bin', 'bash.exe')).find(exists);
    return shell ? { path: shell, args: ['--login'] } : undefined;
  }
  return undefined;
}

/**
 * The shell for profile `name`: its first existing `path` (VS Code tries a list in order; bare names are looked up
 * on PATH) with `${env:X}` and `~` expanded, and its args. A `source` profile (PowerShell, Git Bash) resolves to its
 * usual install location. Undefined for 'default', an unknown or disabled name, or a shell that is not installed —
 * callers then use the default shell.
 */
export function resolveTerminalProfile(
  name: string,
  profiles: Record<string, TerminalProfileEntry | null> | undefined,
  o: { env?: NodeJS.ProcessEnv; exists?: (p: string) => boolean; platform?: NodeJS.Platform } = {}
): ResolvedProfile | undefined {
  if (!name || name === 'default') {
    return undefined;
  }
  const entry = profiles?.[name];
  if (!entry || typeof entry !== 'object') {
    return undefined;
  }
  const env = o.env ?? process.env;
  const exists = o.exists ?? fs.existsSync;
  const platform = o.platform ?? process.platform;
  const args = Array.isArray(entry.args) ? entry.args.filter((a) => typeof a === 'string') : typeof entry.args === 'string' && entry.args.trim() ? [entry.args] : [];
  const candidates = (Array.isArray(entry.path) ? entry.path : entry.path ? [entry.path] : []).filter((p) => typeof p === 'string' && p.trim()).map((p) => expandVars(p.trim(), env));
  if (!candidates.length && typeof entry.source === 'string') {
    const src = resolveSource(entry.source, env, exists, platform);
    return src && { name, path: src.path, args: entry.args === undefined ? src.args : args, env: entry.env };
  }
  for (const c of candidates) {
    const shell = /[\\/]/.test(c) ? (exists(c) ? c : undefined) : findOnPath(c, env, exists, platform);
    if (shell) {
      return { name, path: shell, args, env: entry.env };
    }
  }
  return undefined;
}

const SUPPORTED_SHELLS = new Set(['sh', 'bash', 'zsh', 'fish', 'dash', 'ksh', 'cmd', 'pwsh', 'powershell']);

const shellBase = (p: string): string => path.basename(p.replace(/\\/g, '/')).toLowerCase().replace(/\.exe$/, '');

/** Whether commands can be run through `profile` in a child process (tmux, wsl and other launchers cannot). */
export const isSupportedShell = (profile: ResolvedProfile): boolean => SUPPORTED_SHELLS.has(shellBase(profile.path));

/**
 * How to run `command` in a child process through `profile`'s shell: cmd.exe gets its verbatim `/c` form,
 * PowerShell `-Command`, POSIX shells (bash, zsh, fish, Git Bash) `-c` (`-lc` with `login`). Without a profile, or
 * for a profile that is not a shell (tmux, wsl), the system shell.
 */
export function profileInvocation(command: string, profile: ResolvedProfile | undefined, o: { login?: boolean; platform?: NodeJS.Platform } = {}): ShellInvocation {
  if (!profile || !isSupportedShell(profile)) {
    return shellInvocation(command, o);
  }
  const base = shellBase(profile.path);
  if (base === 'cmd') {
    // Profile args such as /k would keep cmd open; the child process needs exactly /d /s /c.
    return { file: profile.path, args: ['/d', '/s', '/c', `"${command}"`], windowsVerbatimArguments: true };
  }
  if (base === 'pwsh' || base === 'powershell') {
    return { file: profile.path, args: [...profile.args.filter((a) => !/^-(noexit|command|c)$/i.test(a)), '-Command', command] };
  }
  const flag = o.login ? '-lc' : '-c';
  return { file: profile.path, args: [...profile.args.filter((a) => a !== '-l' && a !== '--login' && a !== '-i'), flag, command] };
}
