import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { parseFrontMatter } from './frontMatter';
import { evaluatePermission } from './permissions';
import { PluginSource } from './plugins';
import { emptySettings } from './settings';

/**
 * Custom slash commands in the Claude Code format: a markdown file whose body is the prompt, with optional
 * front-matter (`description`, `argument-hint`, `allowed-tools`, `model`, `disable-model-invocation`).
 *
 *   <workspace>/.localpilot/commands/*.md, <workspace>/.claude/commands/*.md   (project; subfolders namespace)
 *   ~/.localpilot/commands/*.md, ~/.claude/commands/*.md                       (user)
 *   <plugin>/commands/*.md                                                    (/plugin-name:command)
 *
 * The prompt is expanded before it is sent: `$ARGUMENTS` / `$1`…`$9` take the text typed after the command,
 * `` !`cmd` `` runs a shell command (only when `allowed-tools` permits it) and inlines its output, and `@path`
 * inlines a workspace file.
 */

export interface CustomCommand {
  /** Bare name, e.g. `review`. */
  name: string;
  /** How it is invoked: `/review`, `/frontend:component`, `/my-plugin:deploy`. */
  invoke: string;
  namespace?: string;
  description: string;
  argumentHint?: string;
  /** Permission rules in force while the command's turn runs (`Bash(git add:*)`). */
  allowedTools: string[];
  model?: string;
  disableModelInvocation?: boolean;
  file: string;
  body: string;
  source: 'project' | 'user' | 'plugin';
  plugin?: string;
}

/** `Bash(git add:*), Bash(git status:*)` → two rules (commas inside parentheses do not split). */
export function splitRules(v: unknown): string[] {
  if (Array.isArray(v)) {
    return v.flatMap((x) => splitRules(x));
  }
  if (typeof v !== 'string') {
    return [];
  }
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const c of v) {
    if (c === '(') {
      depth++;
    } else if (c === ')') {
      depth--;
    }
    if (c === ',' && depth <= 0) {
      out.push(cur);
      cur = '';
    } else {
      cur += c;
    }
  }
  out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}

export function parseCommandFile(file: string, raw: string, opts: { source: CustomCommand['source']; namespace?: string; plugin?: string }): CustomCommand {
  const { meta, body } = parseFrontMatter(raw);
  const name = (typeof meta.name === 'string' && meta.name.trim()) || path.basename(file, '.md');
  const ns = opts.namespace;
  const dmi = meta['disable-model-invocation'];
  // `argument-hint: [issue-number]` is literal text, which the front-matter parser reads as a list.
  const hint = meta['argument-hint'];
  const argumentHint = typeof hint === 'string' ? hint : Array.isArray(hint) ? hint.map((h) => `[${String(h)}]`).join(' ') : undefined;
  return {
    name,
    invoke: ns ? `/${ns}:${name}` : `/${name}`,
    namespace: ns,
    description: typeof meta.description === 'string' ? meta.description : body.split('\n').find((l) => l.trim())?.trim().slice(0, 120) ?? '',
    argumentHint,
    allowedTools: splitRules(meta['allowed-tools']),
    model: typeof meta.model === 'string' && meta.model.trim() ? meta.model.trim() : undefined,
    disableModelInvocation: dmi === true || dmi === 'true',
    file,
    body: body.trim(),
    source: opts.source,
    plugin: opts.plugin,
  };
}

/** Shell-style split of the arguments typed after the command (quotes group words). */
export function splitArgs(s: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    out.push(m[1] ?? m[2] ?? m[3]);
  }
  return out;
}

export interface ExpandOptions {
  root?: string;
  signal?: AbortSignal;
  /** Override for tests. */
  runShell?: (command: string, cwd: string | undefined) => Promise<string>;
}

function runShell(command: string, cwd: string | undefined, signal?: AbortSignal): Promise<string> {
  const shell = process.platform === 'win32' ? process.env.ComSpec ?? 'cmd.exe' : process.env.SHELL ?? '/bin/sh';
  const args = process.platform === 'win32' ? ['/d', '/s', '/c', command] : ['-lc', command];
  return new Promise((resolve) => {
    let out = '';
    const child = cp.spawn(shell, args, { cwd, env: { ...process.env, CI: '1', GIT_PAGER: 'cat', PAGER: 'cat', NO_COLOR: '1' }, windowsHide: true });
    const t = setTimeout(() => child.kill('SIGKILL'), 30_000);
    signal?.addEventListener('abort', () => child.kill('SIGKILL'), { once: true });
    child.stdout.on('data', (d: Buffer) => (out.length < 60_000 ? (out += d.toString()) : undefined));
    child.stderr.on('data', (d: Buffer) => (out.length < 60_000 ? (out += d.toString()) : undefined));
    child.on('error', (e) => {
      clearTimeout(t);
      resolve(`(failed: ${e.message})`);
    });
    child.on('close', (code) => {
      clearTimeout(t);
      resolve(out.trim() + (code ? `\n[exit code ${code}]` : ''));
    });
  });
}

const MAX_INLINE_FILE = 30_000;

/** Expands a command body into the prompt to send. */
export async function expandCommand(cmd: CustomCommand, argText: string, opts: ExpandOptions = {}): Promise<{ prompt: string; notes: string[] }> {
  const notes: string[] = [];
  const args = splitArgs(argText);
  let text = cmd.body;
  // 1. Arguments (also inside !`…` so `!`gh pr view $1`` works).
  text = text.replace(/\$ARGUMENTS\b/g, argText.trim()).replace(/\$(\d)\b/g, (_, n: string) => args[Number(n) - 1] ?? '');
  // 2. Shell preprocessing — only what the command's allowed-tools permit, like Claude Code.
  const perm = { ...emptySettings().permissions, allow: cmd.allowedTools };
  const matches = [...text.matchAll(/!`([^`\n]+)`/g)];
  for (const m of matches) {
    const command = m[1].trim();
    const allowed = evaluatePermission(perm, 'run_command', { command }, { root: opts.root }).decision === 'allow';
    let replacement: string;
    if (!allowed) {
      replacement = `[skipped \`${command}\`: not permitted — add \`allowed-tools: Bash(${command.split(' ')[0]}:*)\` to ${path.basename(cmd.file)}]`;
      notes.push(`Skipped !\`${command}\` (not in allowed-tools).`);
    } else {
      const out = await (opts.runShell ?? ((c, cwd) => runShell(c, cwd, opts.signal)))(command, opts.root);
      replacement = out ? `\`\`\`\n$ ${command}\n${out}\n\`\`\`` : `(\`${command}\` produced no output)`;
    }
    text = text.replace(m[0], () => replacement);
  }
  // 3. @file references (a word starting with @ that names an existing path; emails and @mentions are left alone).
  const refs = [...text.matchAll(/(^|[\s(])@((?:\.{0,2}\/|~\/)?[\w./-][\w./@-]*)/g)];
  for (const m of refs) {
    const rel = m[2].replace(/[.,;:)]+$/, '');
    const abs = rel.startsWith('~/') ? path.join(os.homedir(), rel.slice(2)) : path.isAbsolute(rel) ? rel : path.resolve(opts.root ?? process.cwd(), rel);
    let st: import('fs').Stats | undefined;
    try {
      st = await fs.stat(abs);
    } catch {
      continue;
    }
    let block: string;
    if (st.isDirectory()) {
      const entries = (await fs.readdir(abs).catch(() => [] as string[])).slice(0, 200);
      block = `<directory path="${rel}">\n${entries.join('\n')}\n</directory>`;
    } else {
      let content = await fs.readFile(abs, 'utf8').catch(() => '');
      if (content.length > MAX_INLINE_FILE) {
        content = `${content.slice(0, MAX_INLINE_FILE)}\n…(truncated)`;
      }
      block = `<file path="${rel}">\n${content}\n</file>`;
    }
    text = text.replace(m[0], () => `${m[1]}${block}`);
  }
  return { prompt: text.trim(), notes };
}

async function listMarkdown(dir: string, depth = 2): Promise<{ file: string; sub: string[] }[]> {
  const out: { file: string; sub: string[] }[] = [];
  let entries: import('fs').Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isFile() && e.name.endsWith('.md')) {
      out.push({ file: p, sub: [] });
    } else if (e.isDirectory() && depth > 1 && !e.name.startsWith('.')) {
      for (const x of await listMarkdown(p, depth - 1)) {
        out.push({ file: x.file, sub: [e.name, ...x.sub] });
      }
    }
  }
  return out;
}

/** Distinct commands, highest-priority location first (project, user, plugins); the first with a given invocation wins. */
export async function discoverCommands(roots: string[], opts: { home?: string; plugins?: PluginSource; log?: { warn(m: string): void } } = {}): Promise<CustomCommand[]> {
  const home = opts.home ?? os.homedir();
  const dirs: { dir: string; source: CustomCommand['source'] }[] = [];
  for (const r of roots) {
    dirs.push({ dir: path.join(r, '.localpilot', 'commands'), source: 'project' }, { dir: path.join(r, '.claude', 'commands'), source: 'project' });
  }
  dirs.push({ dir: path.join(home, '.localpilot', 'commands'), source: 'user' }, { dir: path.join(home, '.claude', 'commands'), source: 'user' });
  const out: CustomCommand[] = [];
  const add = (c: CustomCommand) => {
    if (!out.some((x) => x.invoke === c.invoke)) {
      out.push(c);
    }
  };
  for (const { dir, source } of dirs) {
    for (const { file, sub } of await listMarkdown(dir)) {
      try {
        add(parseCommandFile(file, await fs.readFile(file, 'utf8'), { source, namespace: sub.length ? sub.join(':') : undefined }));
      } catch (e) {
        opts.log?.warn(`commands: cannot read ${file}: ${String(e)}`);
      }
    }
  }
  for (const { file, plugin } of opts.plugins?.commandFiles() ?? []) {
    try {
      add(parseCommandFile(file, await fs.readFile(file, 'utf8'), { source: 'plugin', namespace: plugin.name, plugin: plugin.name }));
    } catch (e) {
      opts.log?.warn(`commands: cannot read ${file}: ${String(e)}`);
    }
  }
  return out;
}

/** Lookup table by invocation: `/ns:name` always, plus `/name` when no other command claims it. */
export function indexCommands(list: CustomCommand[]): Map<string, CustomCommand> {
  const byInvoke = new Map<string, CustomCommand>();
  for (const c of list) {
    if (!byInvoke.has(c.invoke)) {
      byInvoke.set(c.invoke, c);
    }
  }
  for (const c of list) {
    if (c.namespace && !byInvoke.has(`/${c.name}`)) {
      byInvoke.set(`/${c.name}`, c);
    }
  }
  return byInvoke;
}

export class CommandManager implements vscode.Disposable {
  private list: CustomCommand[] = [];
  private byInvoke = new Map<string, CustomCommand>();
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;
  private readonly watcher: vscode.FileSystemWatcher;

  constructor(private readonly log: vscode.LogOutputChannel, private readonly plugins?: PluginSource, private readonly homeDir = os.homedir()) {
    this.watcher = vscode.workspace.createFileSystemWatcher('**/{.claude,.localpilot}/commands/**/*.md');
    const reload = () => void this.refresh();
    this.watcher.onDidChange(reload);
    this.watcher.onDidCreate(reload);
    this.watcher.onDidDelete(reload);
  }

  /** Distinct commands, sorted by invocation. */
  get all(): CustomCommand[] {
    return [...this.list].sort((a, b) => a.invoke.localeCompare(b.invoke));
  }

  /** Looks a command up by `/name` or `/ns:name` (leading slash optional). */
  get(invoke: string): CustomCommand | undefined {
    const key = invoke.startsWith('/') ? invoke : `/${invoke}`;
    return this.byInvoke.get(key);
  }

  async refresh(): Promise<void> {
    const roots = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
    this.list = await discoverCommands(roots, { home: this.homeDir, plugins: this.plugins, log: this.log });
    this.byInvoke = indexCommands(this.list);
    if (this.list.length) {
      this.log.info(`Commands: ${this.all.map((c) => c.invoke).join(', ')}`);
    }
    this._onDidChange.fire();
  }

  dispose(): void {
    this.watcher.dispose();
    this._onDidChange.dispose();
  }
}
