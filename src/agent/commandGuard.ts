/**
 * Read-only command guard for Plan and Ask mode: `run_command` stays available there, but only for commands that
 * cannot change the workspace (`git log`, `ls`, `npm test`). The check is static and conservative: quoted text,
 * heredoc bodies and comments are masked, the line is split into simple commands, wrappers (`sudo`, `env`, `xargs`…)
 * are looked through, and each command is matched against the known mutating programs, subcommands and redirections.
 * Pure: no vscode, no I/O.
 */

export type GuardVerdict = { ok: true } | { ok: false; reason: string };

export interface GuardOptions {
  /** Also block cmd/PowerShell file commands (`del`, `copy`, `Set-Content`…). Default: running on Windows. */
  windows?: boolean;
}

type Tok = { t: 'w'; v: string } | { t: 'op'; v: string } | { t: 'redir'; v: string };

const MUTATING = new Set(['rm', 'rmdir', 'unlink', 'mv', 'cp', 'dd', 'touch', 'mkdir', 'ln', 'chmod', 'chown', 'chgrp', 'truncate', 'shred', 'install', 'patch', 'rsync', 'tee', 'mkfifo', 'mknod']);

const WINDOWS_MUTATING = new Set([
  'del', 'erase', 'move', 'copy', 'xcopy', 'robocopy', 'ren', 'rename', 'rd', 'md', 'mklink',
  'new-item', 'ni', 'set-content', 'sc', 'add-content', 'ac', 'out-file', 'remove-item', 'ri', 'move-item', 'mi',
  'copy-item', 'cpi', 'rename-item', 'rni', 'clear-content', 'clc', 'set-item', 'si', 'new-itemproperty', 'set-itemproperty', 'sp',
]);

const GIT_MUTATING = new Set(['add', 'am', 'apply', 'checkout', 'cherry-pick', 'clean', 'clone', 'commit', 'init', 'merge', 'mv', 'pull', 'push', 'rebase', 'reset', 'restore', 'revert', 'rm', 'stash', 'switch', 'tag', 'branch', 'worktree', 'submodule', 'gc', 'prune', 'update-ref', 'update-index', 'notes', 'filter-branch', 'replace']);

const words = (s: string) => new Set(s.split(' '));
/** Package-manager subcommands that install, remove or rewrite dependencies. */
const PKG: Record<string, Set<string>> = {
  npm: words('install i in ins inst insta instal isnt isnta isntal isntall add ci clean-install ic install-clean uninstall remove rm r un unlink update up upgrade udpate link ln publish unpublish dedupe ddp prune init create version deprecate'),
  pnpm: words('add install i remove rm uninstall un update up upgrade link ln unlink prune import publish init dedupe patch patch-commit'),
  yarn: words('add install remove upgrade up link unlink publish init dedupe import'),
  bun: words('add a install i remove rm uninstall update upgrade link unlink publish init create'),
  pip: words('install uninstall download'),
  pipx: words('install uninstall reinstall upgrade upgrade-all inject'),
  cargo: words('install uninstall add remove rm update publish new init fix'),
  gem: words('install uninstall update cleanup'),
  composer: words('install require remove update upgrade create-project'),
  go: words('install get'),
  dotnet: words('add remove new'),
  brew: words('install uninstall remove rm reinstall upgrade update tap untap link unlink cleanup pin unpin'),
  apt: words('install remove purge autoremove upgrade update dist-upgrade full-upgrade reinstall'),
  winget: words('install uninstall remove upgrade update import'),
  nuget: words('install update delete push add'),
  choco: words('install uninstall upgrade update'),
  scoop: words('install uninstall update'),
  conda: words('install remove uninstall update upgrade create'),
  poetry: words('add remove install update lock'),
  uv: words('add remove sync lock'),
  deno: words('install uninstall add remove'),
};
const PKG_ALIAS: Record<string, string> = { pip3: 'pip', 'apt-get': 'apt', dnf: 'apt', yum: 'apt', apk: 'apt', zypper: 'apt', mamba: 'conda', micromamba: 'conda' };

const SAFE_TARGETS = /^(\/dev\/(null|stdout|stderr|tty)|nul|\$null)$/i;
const KEYWORDS = new Set(['if', 'then', 'else', 'elif', 'do', 'while', 'until', '!', '{', '}', 'time']);
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish']);

/** Whether `cmd` may run in a read-only mode; the reason names the first part that could change something. */
export function checkReadOnlyCommand(cmd: string, opts: GuardOptions = {}): GuardVerdict {
  const windows = opts.windows ?? process.platform === 'win32';
  return check(cmd, windows, 0);
}

function check(cmd: string, windows: boolean, depth: number): GuardVerdict {
  if (depth > 4) {
    return { ok: false, reason: 'the command nests too deeply to check' };
  }
  const { toks, subs } = lex(cmd);
  for (const s of subs) {
    const v = check(s, windows, depth + 1);
    if (!v.ok) {
      return v;
    }
  }
  let seg: string[] = [];
  const segments: string[][] = [seg];
  for (let i = 0; i < toks.length; i++) {
    const tk = toks[i];
    if (tk.t === 'op') {
      seg = [];
      segments.push(seg);
    } else if (tk.t === 'redir') {
      const next = toks[i + 1];
      const target = next?.t === 'w' ? next.v : '';
      if (next?.t === 'w') {
        i++;
      }
      if ((tk.v === '>' || tk.v === '>>') && !SAFE_TARGETS.test(target)) {
        return { ok: false, reason: `\`${tk.v}${target ? ` ${target}` : ''}\` writes to a file` };
      }
    } else {
      seg.push(tk.v);
    }
  }
  for (const s of segments) {
    const v = checkSimple(s, windows, depth);
    if (!v.ok) {
      return v;
    }
  }
  return { ok: true };
}

/** Tokenises a command line the way a POSIX shell would, closely enough to find commands and redirections. */
function lex(s: string): { toks: Tok[]; subs: string[] } {
  const toks: Tok[] = [];
  const subs: string[] = [];
  const heredocs: { delim: string; strip: boolean }[] = [];
  const n = s.length;
  let word = '';
  let inWord = false;
  let quoted = false;
  const flush = () => {
    if (inWord) {
      toks.push({ t: 'w', v: word });
    }
    word = '';
    inWord = false;
    quoted = false;
  };
  const closeParen = (open: number): number => {
    // `open` is the index of '('; returns the index of its ')' (or the end), skipping quotes.
    let level = 0;
    for (let j = open; j < n; j++) {
      const c = s[j];
      if (c === '\\') {
        j++;
      } else if (c === "'") {
        const e = s.indexOf("'", j + 1);
        j = e < 0 ? n : e;
      } else if (c === '"') {
        let e = j + 1;
        while (e < n && s[e] !== '"') {
          e += s[e] === '\\' ? 2 : 1;
        }
        j = e;
      } else if (c === '(') {
        level++;
      } else if (c === ')' && --level === 0) {
        return j;
      }
    }
    return n;
  };
  let i = 0;
  while (i < n) {
    const c = s[i];
    if (c === '\\') {
      if (s[i + 1] !== '\n') {
        word += s[i + 1] ?? '';
        inWord = true;
      }
      i += 2;
      continue;
    }
    if (c === "'") {
      const e = s.indexOf("'", i + 1);
      const stop = e < 0 ? n : e;
      word += s.slice(i + 1, stop);
      inWord = quoted = true;
      i = stop + 1;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      while (j < n && s[j] !== '"') {
        if (s[j] === '\\') {
          word += s[j + 1] ?? '';
          j += 2;
        } else if (s[j] === '$' && s[j + 1] === '(') {
          const e = closeParen(j + 1);
          if (s[j + 2] !== '(') {
            subs.push(s.slice(j + 2, e));
          }
          word += '$';
          j = e + 1;
        } else if (s[j] === '`') {
          const e = s.indexOf('`', j + 1);
          const stop = e < 0 ? n : e;
          subs.push(s.slice(j + 1, stop));
          word += '$';
          j = stop + 1;
        } else {
          word += s[j++];
        }
      }
      inWord = quoted = true;
      i = j + 1;
      continue;
    }
    if (c === '`') {
      const e = s.indexOf('`', i + 1);
      const stop = e < 0 ? n : e;
      subs.push(s.slice(i + 1, stop));
      word += '$';
      inWord = true;
      i = stop + 1;
      continue;
    }
    if (c === '$' && s[i + 1] === '(') {
      const e = closeParen(i + 1);
      // $(( … )) is arithmetic, not a command.
      if (s[i + 2] !== '(') {
        subs.push(s.slice(i + 2, e));
      }
      word += '$';
      inWord = true;
      i = e + 1;
      continue;
    }
    if ((c === '<' || c === '>') && s[i + 1] === '(' && !inWord) {
      // Process substitution: <(cmd) / >(cmd).
      const e = closeParen(i + 1);
      subs.push(s.slice(i + 2, e));
      word += '$';
      inWord = true;
      i = e + 1;
      continue;
    }
    if (c === '#' && !inWord) {
      const e = s.indexOf('\n', i);
      i = e < 0 ? n : e;
      continue;
    }
    if (c === '\n') {
      flush();
      toks.push({ t: 'op', v: '\n' });
      i++;
      // Heredoc bodies are data, not commands.
      for (const h of heredocs.splice(0)) {
        while (i < n) {
          const e = s.indexOf('\n', i);
          const line = s.slice(i, e < 0 ? n : e);
          i = e < 0 ? n : e + 1;
          if ((h.strip ? line.replace(/^\t+/, '') : line).trim() === h.delim) {
            break;
          }
        }
      }
      continue;
    }
    if (c === ' ' || c === '\t' || c === '\r') {
      flush();
      i++;
      continue;
    }
    if (c === '&' && s[i + 1] === '>') {
      flush();
      i += s[i + 2] === '>' ? 3 : 2;
      toks.push({ t: 'redir', v: '>' });
      continue;
    }
    if (c === ';' || c === '|' || c === '&' || c === '(' || c === ')') {
      flush();
      const two = s.slice(i, i + 2);
      const op = two === '&&' || two === '||' || two === ';;' || two === '|&' ? two : c;
      toks.push({ t: 'op', v: op });
      i += op.length;
      continue;
    }
    if (c === '>' || c === '<') {
      // A bare number right before the operator is a file descriptor (2>, 1>>), not an argument.
      if (inWord && !quoted && /^\d+$/.test(word)) {
        word = '';
        inWord = false;
      } else {
        flush();
      }
      if (c === '<') {
        if (s[i + 1] === '<' && s[i + 2] === '<') {
          i += 3;
          toks.push({ t: 'redir', v: '<<<' });
        } else if (s[i + 1] === '<') {
          i += 2;
          const strip = s[i] === '-';
          if (strip) {
            i++;
          }
          while (s[i] === ' ' || s[i] === '\t') {
            i++;
          }
          let delim = '';
          while (i < n && !/[\s;&|<>()]/.test(s[i])) {
            if (s[i] !== '"' && s[i] !== "'" && s[i] !== '\\') {
              delim += s[i];
            }
            i++;
          }
          heredocs.push({ delim, strip });
        } else if (s[i + 1] === '>') {
          i += 2;
          toks.push({ t: 'redir', v: '>' });
        } else if (s[i + 1] === '&') {
          i += 2;
          while (i < n && /[\d-]/.test(s[i])) {
            i++;
          }
        } else {
          i++;
          toks.push({ t: 'redir', v: '<' });
        }
        continue;
      }
      let j = i + 1;
      let op = '>';
      if (s[j] === '>') {
        op = '>>';
        j++;
      } else if (s[j] === '|') {
        j++;
      }
      if (s[j] === '&') {
        // >&2, 2>&1, >&- duplicate a descriptor; `>&file` (bash) writes the file.
        let k = j + 1;
        while (k < n && /[\d-]/.test(s[k])) {
          k++;
        }
        if (k > j + 1) {
          i = k;
          continue;
        }
        j++;
      }
      i = j;
      toks.push({ t: 'redir', v: op });
      continue;
    }
    word += c;
    inWord = true;
    i++;
  }
  flush();
  return { toks, subs };
}

const isAssignment = (w: string) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(w);
const base = (w: string) => w.replace(/^.*[\\/]/, '').replace(/\.(exe|cmd|bat|com|ps1)$/i, '').toLowerCase();
/** Variables that make an otherwise read-only program find, load or run other code. */
const CODE_ENV = /^(PATH|LD_\w+|DYLD_\w+|GIT_\w+|NODE_OPTIONS|NODE_PATH|PYTHON\w*|PERL5\w*|PERLLIB|RUBYOPT|RUBYLIB|BASH_ENV|ENV|ZDOTDIR|PROMPT_COMMAND|IFS|SHELLOPTS|BASHOPTS|PAGER|LESSOPEN|LESSCLOSE|EDITOR|VISUAL)=/;
/** git options before the subcommand that run configured programs or point git at another repository's config. */
const GIT_CODE_OPTS = /^(-c|--config-env|--exec-path|--git-dir|--work-tree)(=|$)/;

/** The words `stripWrappers` looked through (`FOO=1`, `env -S …`, `sudo -u x`) before the program name. */
function wrapperPrefix(words0: string[], w: string[] | 'lookup'): string[] {
  return w === 'lookup' ? words0 : words0.slice(0, words0.length - w.length);
}

/** A prefix that changes which program runs or what it loads: a code-loading variable, or `env -S` (a whole command line). */
function codeEnv(prefix: string[]): string | undefined {
  return prefix.find((p, i) => CODE_ENV.test(p) || (/^(-S|--split-string)(=|$)/.test(p) && prefix.slice(0, i).some((x) => base(x) === 'env')));
}

function stripWrappers(w: string[]): string[] | 'lookup' {
  while (w.length) {
    const h = w[0];
    const name = base(h);
    if (isAssignment(h) || KEYWORDS.has(h)) {
      w = w.slice(1);
    } else if (name === 'sudo' || name === 'doas') {
      w = w.slice(1);
      while (w[0]?.startsWith('-')) {
        const f = w.shift()!;
        if (f === '--') {
          break;
        }
        if (/^-[ugCDhpRrTt]$/.test(f) || /^--(user|group|chdir|prompt|role|type|host|close-from)$/.test(f)) {
          w.shift();
        }
      }
    } else if (name === 'env') {
      w = w.slice(1);
      while (w[0] && (w[0].startsWith('-') || isAssignment(w[0]))) {
        const f = w.shift()!;
        if (/^-[uCS]$/.test(f) || /^--(unset|chdir|split-string)$/.test(f)) {
          w.shift();
        }
      }
    } else if (name === 'xargs') {
      w = w.slice(1);
      while (w[0]?.startsWith('-')) {
        const f = w.shift()!;
        if (/^-[IEdLnPsa]$/.test(f)) {
          w.shift();
        }
      }
    } else if (name === 'nice' || name === 'ionice') {
      w = w.slice(1);
      while (w[0]?.startsWith('-')) {
        const f = w.shift()!;
        if (/^-[ncp]$/.test(f)) {
          w.shift();
        }
      }
    } else if (name === 'timeout') {
      w = w.slice(1);
      while (w[0]?.startsWith('-')) {
        const f = w.shift()!;
        if (/^-[sk]$/.test(f)) {
          w.shift();
        }
      }
      w = w.slice(1); // the duration
    } else if (name === 'command' || name === 'builtin' || name === 'exec' || name === 'nohup' || name === 'stdbuf') {
      w = w.slice(1);
      while (w[0]?.startsWith('-')) {
        const f = w.shift()!;
        if (name === 'command' && /^-[vV]$/.test(f)) {
          return 'lookup';
        }
        if (name === 'exec' && f === '-a') {
          w.shift();
        }
      }
    } else {
      break;
    }
  }
  return w;
}

/** First word that is not an option; `withArg` options consume the following word. */
function subcommand(args: string[], withArg: RegExp = /^$/): { sub: string; rest: string[] } {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--') {
      return { sub: args[i + 1] ?? '', rest: args.slice(i + 2) };
    }
    if (a.startsWith('-')) {
      if (withArg.test(a)) {
        i++;
      }
      continue;
    }
    return { sub: a, rest: args.slice(i + 1) };
  }
  return { sub: '', rest: [] };
}

function checkSimple(words0: string[], windows: boolean, depth: number): GuardVerdict {
  const w = stripWrappers(words0);
  const env = codeEnv(wrapperPrefix(words0, w));
  if (env) {
    return { ok: false, reason: `\`${env.slice(0, 40)}\` changes which program runs or what it loads` };
  }
  if (w === 'lookup' || !w.length) {
    return { ok: true };
  }
  const name = base(w[0]);
  const args = w.slice(1);
  const no = (reason: string): GuardVerdict => ({ ok: false, reason });

  if (/[$`]/.test(w[0])) {
    // PowerShell `$x = Get-ChildItem` (or a bare `$x`, which prints it): only the right-hand side runs.
    if (windows && /^\$[\w:]+$/.test(w[0]) && (w.length === 1 || w[1] === '=')) {
      return w.length > 2 ? checkSimple(w.slice(2), windows, depth) : { ok: true };
    }
    return no('the command name comes from a variable or substitution, so it cannot be checked');
  }
  if (/^(export|declare|typeset|readonly|local)$/.test(name) && args.some((a) => CODE_ENV.test(a))) {
    return no(`\`${name}\` changes which program later commands run or what they load`);
  }
  if (MUTATING.has(name)) {
    return no(`\`${name}\` changes files`);
  }
  if (windows && WINDOWS_MUTATING.has(name)) {
    return no(`\`${w[0]}\` changes files`);
  }
  if (SHELLS.has(name) || name === 'pwsh' || name === 'powershell' || name === 'cmd') {
    const at = args.findIndex((a) => a === '-c' || /^-(command|c)$/i.test(a) || /^\/c$/i.test(a) || /^-[a-z]*c$/.test(a));
    return at >= 0 ? check(args.slice(at + 1).join(' '), windows || name === 'cmd' || name === 'pwsh' || name === 'powershell', depth + 1) : { ok: true };
  }
  if (name === 'eval') {
    return check(args.join(' '), windows, depth + 1);
  }
  if (name === 'sed' || name === 'gsed') {
    for (const a of args) {
      if (a === '--in-place' || a.startsWith('--in-place=') || clusterHas(a, 'i', 'efl')) {
        return no(`\`${name} -i\` edits files in place`);
      }
    }
    return { ok: true };
  }
  if (name === 'perl') {
    for (const a of args) {
      if (clusterHas(a, 'i', 'IMmeExdDC')) {
        return no('`perl -i` edits files in place');
      }
    }
    return { ok: true };
  }
  if (name === 'find') {
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === '-delete') {
        return no('`find -delete` deletes files');
      }
      if (/^-f(print0?|printf|ls)$/.test(a)) {
        return no(`\`find ${a}\` writes to a file`);
      }
      if (/^-(exec|execdir|ok|okdir)$/.test(a)) {
        const end = args.findIndex((x, k) => k > i && (x === ';' || x === '+'));
        const v = checkSimple(args.slice(i + 1, end < 0 ? args.length : end), windows, depth + 1);
        if (!v.ok) {
          return v;
        }
      }
    }
    return { ok: true };
  }
  if (name === 'curl') {
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (/^--(remote-name|remote-name-all|output-dir)$/.test(a) || (/^-[A-Za-z]+$/.test(a) && a.includes('O'))) {
        return no('`curl -O` saves a file');
      }
      if (a === '--output' || (/^-[A-Za-z]+$/.test(a) && a.endsWith('o'))) {
        if (!['-', ...['/dev/null', 'nul']].includes(args[i + 1] ?? '')) {
          return no('`curl -o` saves a file');
        }
      } else if (/^--output=/.test(a) && !SAFE_TARGETS.test(a.slice(9)) && a.slice(9) !== '-') {
        return no('`curl -o` saves a file');
      }
    }
    return { ok: true };
  }
  if (name === 'wget') {
    const stdout = args.some((a, i) => a === '--spider' || /^-[A-Za-z]*O-$/.test(a) || a === '--output-document=-' || ((a === '-O' || a === '--output-document' || /^-[A-Za-z]*O$/.test(a)) && args[i + 1] === '-'));
    return stdout ? { ok: true } : no('`wget` saves files');
  }
  if (name === 'git') {
    return checkGit(args);
  }
  if (/^python[\d.]*$|^py$/.test(name)) {
    const m = args.indexOf('-m');
    return m >= 0 && args[m + 1] ? checkSimple(args.slice(m + 1), windows, depth + 1) : { ok: true };
  }
  if (name === 'dpkg' && args.some((a) => /^(-[irP]|--(install|remove|purge|unpack|configure))$/.test(a))) {
    return no('`dpkg` installs or removes packages');
  }
  const pm = PKG_ALIAS[name] ?? name;
  const subs = PKG[pm];
  if (subs) {
    if (pm === 'yarn' && !subcommand(args).sub) {
      return no('`yarn` installs packages');
    }
    const { sub, rest } = subcommand(args, pm === 'npm' || pm === 'pnpm' ? /^--(prefix|workspace|filter|dir|cwd)$|^-[CwF]$/ : /^$/);
    const s = sub.toLowerCase();
    if (pm === 'uv' && s === 'pip') {
      return checkSimple(['pip', ...rest], windows, depth + 1);
    }
    if ((pm === 'uv' || pm === 'dotnet') && (s === 'tool' || s === 'workload') && /^(install|uninstall|update|upgrade)$/.test(rest[0] ?? '')) {
      return no(`\`${name} ${s} ${rest[0]}\` installs or removes packages`);
    }
    if (pm === 'go' && (s === 'mod' || s === 'work') && /^(tidy|edit|init|vendor|download|use|sync)$/.test(rest[0] ?? '')) {
      return no(`\`go ${s} ${rest[0]}\` changes the module files`);
    }
    if (pm === 'npm' && s === 'audit' && rest.includes('fix')) {
      return no('`npm audit fix` installs packages');
    }
    if (pm === 'npm' && s === 'pkg' && /^(set|delete|fix)$/.test(rest[0] ?? '')) {
      return no(`\`npm pkg ${rest[0]}\` edits package.json`);
    }
    if (subs.has(s)) {
      return no(`\`${name} ${sub}\` installs or removes packages`);
    }
  }
  return { ok: true };
}

/** Whether a short-option cluster (`-ni`, `-i.bak`) sets `flag`; letters in `stop` take the rest as their value. */
function clusterHas(a: string, flag: string, stop: string): boolean {
  if (!/^-[A-Za-z]/.test(a)) {
    return false;
  }
  for (const ch of a.slice(1)) {
    if (ch === flag) {
      return true;
    }
    if (stop.includes(ch) || !/[A-Za-z0-9]/.test(ch)) {
      return false;
    }
  }
  return false;
}

function checkGit(args: string[]): GuardVerdict {
  let i = 0;
  while (i < args.length && args[i].startsWith('-')) {
    if (GIT_CODE_OPTS.test(args[i])) {
      return { ok: false, reason: `\`git ${args[i].replace(/=.*/, '')}\` can make git run other programs` };
    }
    i += /^(-C|--namespace|--super-prefix)$/.test(args[i]) ? 2 : 1;
  }
  const sub = (args[i] ?? '').toLowerCase();
  const rest = args.slice(i + 1);
  if (!GIT_MUTATING.has(sub)) {
    return { ok: true };
  }
  const positional = rest.filter((a) => !a.startsWith('-'));
  const has = (re: RegExp) => rest.some((a) => re.test(a));
  let readOnly = false;
  if (sub === 'stash') {
    readOnly = /^(list|show)$/.test(rest[0] ?? '');
  } else if (sub === 'tag') {
    readOnly = !has(/^(-d|--delete|-f|--force|-a|--annotate|-s|--sign|-u|-m|-F|--message.*|--file.*)$/) && (!positional.length || has(/^(-l|--list)$/));
  } else if (sub === 'branch') {
    readOnly =
      !has(/^(-d|-D|-m|-M|-c|-C|-f|-u|--delete|--move|--copy|--force|--set-upstream-to.*|--unset-upstream|--edit-description)$/) &&
      (!positional.length || has(/^(-l|--list|-a|--all|-r|--remotes|--contains|--no-contains|--merged|--no-merged|--points-at)$/));
  } else if (sub === 'worktree' || sub === 'submodule' || sub === 'notes') {
    readOnly = /^(list|status|show|summary|foreach)?$/.test(rest[0] ?? '') && !(sub === 'submodule' && rest[0] === 'foreach');
  } else if (sub === 'apply') {
    readOnly = has(/^--(check|stat|numstat|summary)$/) && !has(/^--(apply|index|cached|3way)$/);
  }
  return readOnly ? { ok: true } : { ok: false, reason: `\`git ${sub}\` changes the repository` };
}

/** Programs that only read or print (`approvals.terminal = safe`); anything not listed here asks. */
const SAFE_PROGRAMS = new Set([
  'ls', 'll', 'cat', 'head', 'tail', 'less', 'more', 'wc', 'grep', 'egrep', 'fgrep', 'rg', 'ag', 'ack', 'fd', 'tree', 'pwd', 'echo', 'printf',
  'which', 'whereis', 'type', 'file', 'stat', 'du', 'df', 'date', 'whoami', 'id', 'uname', 'hostname', 'printenv', 'sort', 'uniq', 'cut',
  'tr', 'diff', 'cmp', 'comm', 'basename', 'dirname', 'realpath', 'readlink', 'jq', 'column', 'nl', 'od', 'hexdump', 'md5sum',
  'sha1sum', 'sha256sum', 'shasum', 'true', 'false', 'test', '[', 'seq', 'tsc', 'pytest', 'find',
  'dir', 'findstr', 'where', 'get-childitem', 'gci', 'get-content', 'gc', 'select-string', 'sls', 'get-location', 'gl', 'get-item', 'gi',
]);
const GIT_SAFE = new Set(['status', 'log', 'diff', 'show', 'blame', 'rev-parse', 'ls-files', 'ls-tree', 'describe', 'shortlog', 'grep', 'cat-file', 'branch', 'tag', 'stash', 'remote', 'reflog']);
/** Test, lint and build commands that are routine in a coding session. */
const SAFE_TASKS: RegExp[] = [
  /^(npm|pnpm|yarn|bun) (run )?(test|lint|build|typecheck|type-check|check)( .*)?$/,
  /^npm t( .*)?$/,
  /^npx tsc( .*)?$/,
  /^cargo (build|test|check|clippy)( .*)?$/,
  /^go (test|build|vet)( .*)?$/,
  /^make (test|check)$/,
  /^python[\d.]* -m (pytest|unittest)( .*)?$/,
  /^dotnet (build|test)( .*)?$/,
];

/**
 * Whether `cmd` may run without asking under `approvals.terminal = safe`: every part is a known read-only program, a
 * read-only git subcommand or a routine test/build command, and nothing writes a file. Unlike the Plan-mode guard this
 * is an allow-list: an unknown program is not safe.
 */
export function isReadOnlyOrSafe(cmd: string, opts: GuardOptions = {}): GuardVerdict {
  const windows = opts.windows ?? process.platform === 'win32';
  const guard = check(cmd, windows, 0);
  return guard.ok ? checkSafe(cmd, 0) : guard;
}

function checkSafe(cmd: string, depth: number): GuardVerdict {
  if (depth > 4) {
    return { ok: false, reason: 'the command nests too deeply to check' };
  }
  const { toks, subs } = lex(cmd);
  for (const s of subs) {
    const v = checkSafe(s, depth + 1);
    if (!v.ok) {
      return v;
    }
  }
  let seg: string[] = [];
  const segments: string[][] = [seg];
  for (let i = 0; i < toks.length; i++) {
    const tk = toks[i];
    if (tk.t === 'op') {
      seg = [];
      segments.push(seg);
    } else if (tk.t === 'redir') {
      if (toks[i + 1]?.t === 'w') {
        i++;
      }
    } else {
      seg.push(tk.v);
    }
  }
  for (const s of segments) {
    const v = safeSimple(s, depth);
    if (!v.ok) {
      return v;
    }
  }
  return { ok: true };
}

function safeSimple(words0: string[], depth: number): GuardVerdict {
  if (words0.some((w) => /^(sudo|doas)$/.test(base(w)))) {
    return { ok: false, reason: '`sudo` runs with elevated rights' };
  }
  const w = stripWrappers(words0);
  // Any variable set for the command (`PATH=. ls`, `GIT_EXTERNAL_DIFF=./x git diff`) can change what it runs.
  const assigned = wrapperPrefix(words0, w).find(isAssignment) ?? codeEnv(wrapperPrefix(words0, w));
  if (assigned) {
    return { ok: false, reason: `\`${assigned.slice(0, 40)}\` sets the command's environment` };
  }
  if (w === 'lookup' || !w.length) {
    return { ok: true };
  }
  const name = base(w[0]);
  const args = w.slice(1);
  const no = (): GuardVerdict => ({ ok: false, reason: `\`${[name, ...args].join(' ').slice(0, 60)}\` is not a known read-only, test or build command` });
  if (/[$`]/.test(w[0])) {
    return no();
  }
  if (args.length === 1 && args[0] === '--version') {
    return { ok: true };
  }
  if (SHELLS.has(name)) {
    const at = args.findIndex((a) => a === '-c' || /^-[a-z]*c$/.test(a));
    return at >= 0 && args[at + 1] !== undefined ? checkSafe(args.slice(at + 1).join(' '), depth + 1) : no();
  }
  if (name === 'git') {
    let i = 0;
    while (i < args.length && args[i].startsWith('-')) {
      if (GIT_CODE_OPTS.test(args[i])) {
        return no();
      }
      i += /^(-C|--namespace)$/.test(args[i]) ? 2 : 1;
    }
    const sub = (args[i] ?? '').toLowerCase();
    const rest = args.slice(i + 1);
    if (!GIT_SAFE.has(sub)) {
      return no();
    }
    if (sub === 'remote' && rest.some((a) => !a.startsWith('-')) && !/^(show|get-url)$/.test(rest.find((a) => !a.startsWith('-')) ?? '')) {
      return no();
    }
    if (sub === 'reflog' && /^(expire|delete)$/.test(rest[0] ?? '')) {
      return no();
    }
    if (rest.some((a) => /^(--output|--ext-diff|-O|--open-files-in-pager)/.test(a))) {
      return no();
    }
    return { ok: true };
  }
  if (name === 'find' && args.some((a) => /^-(exec|execdir|ok|okdir|delete|fprint0?|fprintf|fls)$/.test(a))) {
    return no();
  }
  // Options of otherwise read-only programs that write a file or run another program.
  const risky: Record<string, RegExp> = { tsc: /^--init$/, sort: /^(-o|--output.*)$/, tree: /^-o$/, rg: /^--pre/, fd: /^(-x|-X|--exec.*)$/, date: /^(-s|--set.*)$/ };
  if (risky[name] && args.some((a) => risky[name].test(a))) {
    return no();
  }
  if ((name === 'uniq' && args.filter((a) => !a.startsWith('-')).length > 1) || (name === 'hostname' && args.some((a) => !a.startsWith('-')))) {
    return no();
  }
  if (SAFE_PROGRAMS.has(name)) {
    return { ok: true };
  }
  const line = [name, ...args.filter((a) => !/^--?(silent|s|q|quiet|watch=false|no-color|ci)$/.test(a))].join(' ');
  return SAFE_TASKS.some((re) => re.test(line)) ? { ok: true } : no();
}
