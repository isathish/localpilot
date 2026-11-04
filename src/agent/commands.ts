import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { parseFrontMatter } from './frontMatter';
import { ruleCondition } from '../context/ruleConditions';
import { evaluatePermission } from './permissions';
import { PluginSource } from './plugins';
import { emptySettings } from './settings';
import { alwaysEnabled, managedDir } from './managedPolicy';
import { onAbort } from './resilience';
import { killTree } from '../tools/terminal';
import { shellInvocation } from '../terminal/shell';
import { COMMAND_FILE, findSlashToken, normalizeCommandName, pickSlashTarget, SlashToken } from './slashNames';

/**
 * Custom slash commands in the Claude Code format: a markdown file whose body is the prompt, with optional
 * front-matter (`description`, `argument-hint`, `allowed-tools`, `model`, `disable-model-invocation`).
 *
 *   <workspace>/.localpilot/commands/*.md, <workspace>/.claude/commands/*.md   (project; subfolders namespace)
 *   ~/.localpilot/commands/*.md, ~/.claude/commands/*.md                       (user)
 *   <plugin>/commands/*.md                                                    (/plugin-name:command)
 *   <workspace>/.clinerules/workflows, .cline/workflows, ~/.cline/workflows, ~/Documents/Cline/Workflows (Cline workflows)
 *
 * `.md`, `.markdown` and `.txt` files are read; names are normalised (`My Review.md` → `/my-review`) and `disabled: true`
 * front matter hides a file.
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
  /** `managed`: the organisation's commands folder next to managed-settings.json. */
  source: 'managed' | 'project' | 'user' | 'plugin' | 'builtin';
  plugin?: string;
  /** Turned off with `disabled: true` (or `enabled: false`) front matter; only listed with `includeDisabled`. */
  disabled?: boolean;
  /** `alwaysEnabled: true` front matter: cannot be switched off. */
  alwaysEnabled?: boolean;
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
  const name = normalizeCommandName((typeof meta.name === 'string' && meta.name.trim()) || path.basename(file)) || 'command';
  const ns = opts.namespace?.split(':').map(normalizeCommandName).filter(Boolean).join(':') || undefined;
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
    ...(alwaysEnabled(meta) ? { alwaysEnabled: true } : ruleCondition(meta).disabled ? { disabled: true } : {}),
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
  const sh = shellInvocation(command, { login: true });
  return new Promise((resolve) => {
    let out = '';
    const child = cp.spawn(sh.file, sh.args, { cwd, env: { ...process.env, CI: '1', GIT_PAGER: 'cat', PAGER: 'cat', NO_COLOR: '1' }, windowsHide: true, windowsVerbatimArguments: sh.windowsVerbatimArguments, detached: process.platform !== 'win32' });
    child.stdin.on('error', () => undefined);
    child.stdin.end();
    let done = false;
    let grace: NodeJS.Timeout | undefined;
    let backstop: NodeJS.Timeout | undefined;
    const finish = (text: string) => {
      if (done) {
        return;
      }
      done = true;
      clearTimeout(t);
      clearTimeout(grace);
      clearTimeout(backstop);
      off();
      resolve(text);
    };
    const result = (code: number | null) => out.trim() + (code ? `\n[exit code ${code}]` : '');
    const kill = () => {
      killTree(child);
      backstop ??= setTimeout(() => {
        child.stdout.destroy();
        child.stderr.destroy();
        finish(result(null));
      }, 1000);
    };
    const t = setTimeout(kill, 30_000);
    const off = onAbort(signal, kill);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d: string) => (out.length < 60_000 ? (out += d) : undefined));
    child.stderr.on('data', (d: string) => (out.length < 60_000 ? (out += d) : undefined));
    child.on('error', (e) => finish(`(failed: ${e.message})`));
    // Background processes started by the command can keep the pipes open after the shell exits.
    child.on('exit', (code) => {
      grace ??= setTimeout(() => {
        child.stdout.destroy();
        child.stderr.destroy();
        finish(result(code));
      }, 500);
    });
    child.on('close', (code) => finish(result(code)));
  });
}

const MAX_INLINE_FILE = 30_000;

/** Expands a command body into the prompt to send. */
export async function expandCommand(cmd: CustomCommand, argText: string, opts: ExpandOptions = {}): Promise<{ prompt: string; notes: string[] }> {
  const notes: string[] = [];
  const args = splitArgs(argText);
  let text = cmd.body;
  // 1. Arguments (also inside !`…` so `!`gh pr view $1`` works).
  text = text.replace(/\$(ARGUMENTS\b|\d\b)/g, (_, k: string) => (k === 'ARGUMENTS' ? argText.trim() : args[Number(k) - 1] ?? ''));
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
    // A symlink counts as what it points to (the depth limit stops link loops).
    const st = e.isSymbolicLink() ? await fs.stat(p).catch(() => undefined) : e;
    if (st?.isFile() && COMMAND_FILE.test(e.name)) {
      out.push({ file: p, sub: [] });
    } else if (st?.isDirectory() && depth > 1 && !e.name.startsWith('.')) {
      for (const x of await listMarkdown(p, depth - 1)) {
        out.push({ file: x.file, sub: [e.name, ...x.sub] });
      }
    }
  }
  return out;
}

const NEW_RULE = `---
description: Inspect this project and write a rule file the agent follows in every chat
argument-hint: [what the rule should cover]
---
Write a project rule for this workspace. $ARGUMENTS

1. Inspect the repository first, without asking: the README, the package/build files, the lint and format configs, the test setup, a few representative source files, and the instruction files already in force (AGENTS.md, CLAUDE.md, .localpilot/rules/, .clinerules, .cursor/rules). Note the conventions the code actually follows.
2. Then ask at most 4 short questions in ONE ask_user call, each with options and your recommendation, only about what the code cannot tell you (what the rule should focus on, team preferences, things to avoid). Skip the questions when the request above already answers them.
3. Write the rule with write_file to \`.localpilot/rules/<name>.md\` (a short kebab-case name for the topic). If the user asked for AGENTS.md instead, read it and update it with edit_file, keeping what is there. Use front matter \`description: <one line>\`, plus \`paths: [<globs>]\` only when the rule applies to some files alone.
4. The body is terse, imperative Markdown: the build, test and lint commands, code style, naming, architecture boundaries, testing expectations and the pitfalls you found, each as a bullet a coding agent can follow. No generic advice, nothing the tools enforce on their own, no secrets.
5. Report the file you wrote and a one-line summary of each section.`;

/** `/deep-planning <task>`: the prompt of the Plan-mode turn it starts. */
export function deepPlanningPrompt(task: string): string {
  return `Deep planning for this task: ${task.trim()}

Work in four phases and do not change any files:
1. Investigate silently: read the code this touches (analyze_workspace or repo_graph for anything repository-wide, grep_search and read_file for the details, explore subagents for large areas). Do not narrate every file; gather what the plan needs — the entry points, the data flow, the tests, the conventions.
2. Ask: if anything that decides the design is still unclear, ask up to 4 focused questions in ONE ask_user call, each with options and your recommendation. Skip this when the code answers everything.
3. Write the plan with the heading "# Implementation plan: <short title>" and the sections Overview, Types and interfaces, Files (each file to create, change or delete and why), Functions (new and changed, with signatures), Implementation order (numbered, each step small and verifiable), Testing (what to add and the commands that verify it) and Risks. Also record the implementation order as a manage_todos checklist (one item per step, with "agent", a self-contained "prompt" and "dependsOn").
4. Hand off: end with one line telling the user the plan is saved and that switching to Agent mode and saying "implement the plan" will carry it out.`;
}

/**
 * Commands that ship with LocalPilot, below every project, user and plugin command (a `.claude/commands/pr.md` replaces
 * `/pr`). They drive the source-control tools (git_status, git_commit, git_push, pull_request, ci_status).
 */
const BUILTIN_COMMANDS: Record<string, string> = {
  scan: `---
description: Scan for vulnerable dependencies, committed secrets and risky code, then fix what is safe to fix
argument-hint: [folder]
---
Check this workspace for security problems and fix them. $ARGUMENTS

1. security_scan with all kinds.
2. Vulnerable dependencies: for each critical/high one, upgrade to the fixed version (prefer the smallest upgrade that fixes it; say so if it crosses a major version), update the lockfile with the package manager, and run the tests. Leave medium/low ones listed with their fix.
3. Secrets: move each value to an environment variable (and .env.example with a placeholder), make the code read it, and tell the user which credentials to rotate — a committed secret must be considered leaked even after removal.
4. Risky code: fix the high-severity patterns (parameterised SQL, argument lists instead of shell strings, TLS verification back on) when the intent is clear; otherwise explain the risk.
5. Run security_scan again and report what was fixed, what is left and why.`,
  newrule: NEW_RULE,
  init: NEW_RULE.replace('description: Inspect', 'description: (alias of /newrule) Inspect'),
  pr: `---
description: Commit the current changes on a branch, push it and open a pull request
argument-hint: [title or what the change is about]
---
Ship the current changes as a pull request. $ARGUMENTS

1. git_status (action "status", then "diff") to see exactly what changed. If nothing changed, say so and stop.
2. Run the project's checks that cover these files (repo_graph "impact" names the tests; use the test/lint/type-check commands the project defines). Fix anything that fails before going on.
3. If the current branch is the default branch, pick a short branch name from the change ("fix/…", "feat/…") and pass it to git_commit as \`branch\`. Commit with a conventional message that says why.
4. git_push, then pull_request "create" with a clear title and a body: what changed, why, how it was verified (the commands you ran and their result). Use draft=true if anything is unfinished.
5. Report the PR link and the checks you ran.`,
  'fix-ci': `---
description: Read the failing CI checks of this branch or PR, fix them and push
argument-hint: [PR number or run id]
---
Make the failing CI checks pass. $ARGUMENTS

1. If the arguments name a PR number, pull_request "view" with that number, then check it out with run_command \`gh pr checkout <number>\` so you reproduce and fix the PR's code, not the current branch's.
2. pull_request "view" (or ci_status "runs") to see which checks fail. If none fail, say so and stop.
3. ci_status "logs" for the failed run: read the actual error, not just the job name.
4. Reproduce it locally with run_command (the same command the workflow runs), find the root cause and fix it with the smallest change. Do not disable or skip the failing check.
5. Run the command again until it passes, then the related tests.
6. Never commit on the default branch: if the current branch is the default branch, pick a short branch name ("fix/…") and pass it to git_commit as \`branch\`. git_commit ("fix: …" explaining the cause) and git_push. Report what failed, why, the fix, and that the checks will run again.`,
};

export function builtinCommands(): CustomCommand[] {
  return Object.entries(BUILTIN_COMMANDS).map(([name, raw]) => parseCommandFile(`(built-in)/${name}.md`, raw, { source: 'builtin' }));
}

/** Distinct commands, highest-priority location first (project, user, plugins); the first with a given invocation wins. */
export async function discoverCommands(roots: string[], opts: { home?: string; plugins?: PluginSource; log?: { warn(m: string): void }; includeDisabled?: boolean; /** The organisation's commands folder; null for none. */ managedDir?: string | null } = {}): Promise<CustomCommand[]> {
  const home = opts.home ?? os.homedir();
  const dirs: { dir: string; source: CustomCommand['source'] }[] = [];
  // The organisation's commands come first, so a project or user file cannot take their names.
  const orgDir = opts.managedDir === undefined ? managedDir('commands') : opts.managedDir;
  if (orgDir) {
    dirs.push({ dir: orgDir, source: 'managed' });
  }
  for (const r of roots) {
    dirs.push(
      { dir: path.join(r, '.localpilot', 'commands'), source: 'project' },
      { dir: path.join(r, '.claude', 'commands'), source: 'project' },
      { dir: path.join(r, '.clinerules', 'workflows'), source: 'project' },
      { dir: path.join(r, '.cline', 'workflows'), source: 'project' }
    );
  }
  dirs.push(
    { dir: path.join(home, '.localpilot', 'commands'), source: 'user' },
    { dir: path.join(home, '.claude', 'commands'), source: 'user' },
    { dir: path.join(home, '.cline', 'workflows'), source: 'user' },
    { dir: path.join(home, 'Documents', 'Cline', 'Workflows'), source: 'user' }
  );
  const out: CustomCommand[] = [];
  const add = (c: CustomCommand) => {
    // Listing everything (Settings → Customize) keeps shadowed files too; otherwise the first per invocation wins.
    if (opts.includeDisabled ? !out.some((x) => x.file === c.file) : !c.disabled && !out.some((x) => x.invoke === c.invoke)) {
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
  builtinCommands().forEach(add);
  return out;
}

/** Lookup table by invocation: `/ns:name` always, plus `/name` when no other command claims it. */
/** `/skill <name> <task>`: the prompt the chat and the CLI run (the agent loop preloads a skill named this way). */
export function skillTaskPrompt(skill: string, task: string): string {
  return `Use the "${skill}" skill for this task: ${task.trim() || 'follow the skill instructions.'}\nIts instructions are loaded for you; perform every step the skill describes using the tools, then report what you did.`;
}

/** `/agent <name> <task>`: the prompt that hands the task to that subagent. */
export function agentTaskPrompt(agent: string, task: string): string {
  return `Delegate this to the "${agent}" subagent via run_subagent and relay its report: ${task.trim()}`;
}

/** `<name> <task>` after `/skill` or `/agent`: the task keeps its newlines and indentation. */
export function parseTaskArgs(rest: string): { name: string; task: string } {
  const m = /^(\S+)\s*([\s\S]*)$/.exec(rest.trim());
  return { name: m?.[1] ?? '', task: (m?.[2] ?? '').trim() };
}

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

/**
 * What a typed message runs besides the built-in commands: `/name args` reaches a LocalPilot command, then an enabled
 * skill of that name, then a custom command or workflow; without one, the first custom command or workflow named
 * inside the message is expanded where it stands (`inline`).
 */
export function resolveSlashMessage(text: string, commands: CustomCommand[], skills: { name: string }[]): { skill: string; task: string } | { command: CustomCommand; args: string; inline?: SlashToken } | undefined {
  const byInvoke = indexCommands(commands);
  const m = /^\/([\w.:@-]+)\s*([\s\S]*)$/.exec(text.trim());
  if (m) {
    const name = normalizeCommandName(m[1]);
    const target = pickSlashTarget(byInvoke.get(`/${name}`), skills.find((s) => normalizeCommandName(s.name) === name));
    if (target) {
      return 'skill' in target ? { skill: target.skill.name, task: m[2].trim() } : { command: target.command, args: m[2] };
    }
  }
  const tok = findSlashToken(text, (n) => {
    const c = byInvoke.get(`/${n}`);
    return !!c && c.source !== 'builtin';
  });
  const command = tok && byInvoke.get(`/${tok.name}`);
  return tok && command ? { command, args: '', inline: tok } : undefined;
}

export class CommandManager implements vscode.Disposable {
  private list: CustomCommand[] = [];
  private byInvoke = new Map<string, CustomCommand>();
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;
  private readonly watcher: vscode.FileSystemWatcher;

  constructor(private readonly log: vscode.LogOutputChannel, private readonly plugins?: PluginSource, private readonly homeDir = os.homedir()) {
    this.watcher = vscode.workspace.createFileSystemWatcher('**/{.claude/commands,.localpilot/commands,.clinerules/workflows,.cline/workflows}/**/*.{md,markdown,txt}');
    const reload = () => void this.refresh();
    this.watcher.onDidChange(reload);
    this.watcher.onDidCreate(reload);
    this.watcher.onDidDelete(reload);
  }

  /** Distinct commands, sorted by invocation. */
  get all(): CustomCommand[] {
    return [...this.list].sort((a, b) => a.invoke.localeCompare(b.invoke));
  }

  /** Looks a command up by `/name` or `/ns:name` (leading slash and a `.md` suffix optional, any case). */
  get(invoke: string): CustomCommand | undefined {
    return this.byInvoke.get(`/${normalizeCommandName(invoke)}`);
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
