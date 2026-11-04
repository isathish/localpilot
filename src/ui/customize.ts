import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { discoverCommands } from '../agent/commands';
import { setDisabled } from '../agent/frontMatterEdit';
import { HOOK_EVENTS, readSettingsFile, settingsFilesFor, userSettingsFiles } from '../agent/settings';
import { collectInstructionFiles } from '../context/instructions';

/**
 * Settings → Customize: the rule, command and hook files of the workspace and of the user, with on/off, open, delete
 * and create. Every write goes to a file that is in the current listing and whose real path lies inside an allowed
 * root, so a symlink cannot redirect a toggle or a delete outside the rule, command or hook folders.
 */

export type CustomKind = 'rule' | 'command' | 'hook';

export interface CustomItem {
  kind: CustomKind;
  file: string;
  name: string;
  /** Where it lives, shown under the name (`.cursor/rules/react.mdc`, `~/.localpilot/commands/x.md`). */
  label: string;
  scope: 'global' | 'workspace';
  description?: string;
  disabled?: boolean;
  /** Conditional rule globs (`paths:` / `globs:` front matter). */
  paths?: string[];
  /** Can be switched, deleted (otherwise only opened). */
  editable: boolean;
  /** A hook configured in a settings.json: `detail` is the matcher and command; Open shows the settings file. */
  fromSettings?: boolean;
  detail?: string;
  /** A hook script in a hooks folder: listed so it can be opened, but the agent does not run these yet. */
  notRun?: boolean;
}

export interface CustomizeData {
  rules: CustomItem[];
  commands: CustomItem[];
  hooks: CustomItem[];
  /** Hook events offered for a new hook script. */
  events: string[];
  hasWorkspace: boolean;
  /** Hook scripts are switched with the executable bit (not on Windows). */
  canSwitchHooks: boolean;
}

const WS_HOOK_DIRS = ['.localpilot/hooks', '.clinerules/hooks', '.cline/hooks'];
const USER_HOOK_DIRS = ['.localpilot/hooks', '.cline/hooks', 'Documents/Cline/Hooks'];
const HOOK_EXT = /\.(sh|bash|zsh|js|mjs|cjs|ts|py|ps1)$/i;
const NEW_DIR: Record<CustomKind, string> = { rule: '.localpilot/rules', command: '.localpilot/commands', hook: '.localpilot/hooks' };
const canChmod = process.platform !== 'win32';

const tilde = (p: string, home: string) => (p === home || p.startsWith(home + path.sep) ? `~${p.slice(home.length).replace(/\\/g, '/')}` : p);

/** Display path: relative to its workspace folder (prefixed with the folder name when there are several), or `~/…`. */
function labelFor(file: string, roots: string[], home: string): string {
  for (const r of roots) {
    const rel = path.relative(r, file);
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
      return (roots.length > 1 ? `${path.basename(r)}/` : '') + rel.replace(/\\/g, '/');
    }
  }
  return tilde(file, home);
}

const inside = (p: string, dir: string) => {
  const rel = path.relative(dir, p);
  return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel));
};
const real = (p: string) => fs.realpath(p).catch(() => path.resolve(p));

/** Folders a kind may be written in. Workspace rule files sit anywhere under the root (AGENTS.md, .cursor/rules/…). */
export function allowedRoots(kind: CustomKind, roots: string[], home = os.homedir()): string[] {
  const h = (rel: string) => path.join(home, rel);
  if (kind === 'rule') {
    return [...roots, h('.claude'), h('.localpilot'), h('.agents'), h('.cline'), h('Documents/Cline'), h('Cline')];
  }
  if (kind === 'command') {
    return [...roots.flatMap((r) => [path.join(r, '.localpilot', 'commands'), path.join(r, '.claude', 'commands')]), h('.localpilot/commands'), h('.claude/commands')];
  }
  return [...roots.flatMap((r) => WS_HOOK_DIRS.map((d) => path.join(r, d))), ...USER_HOOK_DIRS.map(h)];
}

async function listRules(roots: string[], home: string): Promise<CustomItem[]> {
  const files = await collectInstructionFiles(roots, home, { includeDisabled: true });
  return files.map((f) => ({
    kind: 'rule' as const,
    file: f.file,
    name: f.name ?? path.basename(f.file),
    label: f.label,
    scope: f.scope === 'user' ? ('global' as const) : ('workspace' as const),
    ...(f.disabled ? { disabled: true } : {}),
    ...(f.paths ? { paths: f.paths } : {}),
    // Ancestor folders' CLAUDE.md belong to another project: shown, not changed from here.
    editable: f.scope !== 'ancestor',
  }));
}

async function listCommands(roots: string[], home: string): Promise<CustomItem[]> {
  const all = await discoverCommands(roots, { home, includeDisabled: true });
  return all
    .filter((c) => c.source === 'project' || c.source === 'user')
    .map((c) => ({ kind: 'command' as const, file: c.file, name: c.invoke, label: labelFor(c.file, roots, home), scope: c.source === 'user' ? ('global' as const) : ('workspace' as const), description: c.description, ...(c.disabled ? { disabled: true } : {}), editable: true }));
}

async function listHookFiles(roots: string[], home: string): Promise<CustomItem[]> {
  const out: CustomItem[] = [];
  const dirs = [...roots.flatMap((r) => WS_HOOK_DIRS.map((d) => ({ dir: path.join(r, d), scope: 'workspace' as const }))), ...USER_HOOK_DIRS.map((d) => ({ dir: path.join(home, d), scope: 'global' as const }))];
  for (const { dir, scope } of dirs) {
    let names: string[];
    try {
      names = (await fs.readdir(dir)).filter((n) => !n.startsWith('.')).sort();
    } catch {
      continue;
    }
    for (const n of names) {
      const file = path.join(dir, n);
      const st = await fs.stat(file).catch(() => undefined);
      if (!st?.isFile()) {
        continue;
      }
      const event = HOOK_EVENTS.find((e) => e.toLowerCase() === n.replace(HOOK_EXT, '').toLowerCase());
      // Folder hook scripts are not run by the agent yet: shown read-only, so the listing does not suggest otherwise.
      out.push({ kind: 'hook', file, name: n, label: labelFor(file, roots, home), scope, description: event ? `${event} hook script` : 'Hook script', notRun: true, editable: false });
    }
  }
  return out;
}

async function listSettingsHooks(roots: string[], home: string): Promise<CustomItem[]> {
  const out: CustomItem[] = [];
  for (const file of [...userSettingsFiles(home), ...roots.flatMap(settingsFilesFor)]) {
    const s = await readSettingsFile(file);
    for (const [event, matchers] of Object.entries(s?.hooks ?? {})) {
      for (const m of matchers ?? []) {
        for (const h of m.hooks) {
          out.push({ kind: 'hook', file, name: event, label: labelFor(file, roots, home), scope: file.startsWith(home + path.sep) && !roots.some((r) => inside(file, r)) ? 'global' : 'workspace', detail: `${m.matcher && m.matcher !== '*' ? `${m.matcher}: ` : ''}${h.command}`, fromSettings: true, editable: false });
        }
      }
    }
  }
  return out;
}

export async function listCustomizations(roots: string[], home = os.homedir()): Promise<CustomizeData> {
  const [rules, commands, hookFiles, settingsHooks] = await Promise.all([listRules(roots, home), listCommands(roots, home), listHookFiles(roots, home), listSettingsHooks(roots, home)]);
  return { rules, commands, hooks: [...hookFiles, ...settingsHooks], events: [...HOOK_EVENTS], hasWorkspace: roots.length > 0, canSwitchHooks: canChmod };
}

/** The listed, editable item for `file`, after checking that its real path is inside an allowed root. */
async function writable(kind: CustomKind, file: string, roots: string[], home: string): Promise<CustomItem> {
  const data = await listCustomizations(roots, home);
  const items = kind === 'rule' ? data.rules : kind === 'command' ? data.commands : data.hooks;
  const item = items.find((i) => i.editable && path.resolve(i.file) === path.resolve(file));
  if (!item) {
    throw new Error(`Not a ${kind} file LocalPilot manages: ${file}`);
  }
  const target = await real(file);
  const allowed = await Promise.all(allowedRoots(kind, roots, home).map(real));
  if (!allowed.some((dir) => inside(target, dir))) {
    throw new Error(`Refusing to change ${file}: it resolves outside the ${kind} folders (${target}).`);
  }
  return item;
}

/** Rules and commands: `disabled: true` front matter; hook scripts: the executable bit. */
export async function setItemEnabled(kind: CustomKind, file: string, enabled: boolean, roots: string[], home = os.homedir()): Promise<void> {
  await writable(kind, file, roots, home);
  if (kind === 'hook') {
    if (!canChmod) {
      throw new Error('Hook scripts are switched on and off with the executable bit, which Windows does not have.');
    }
    await fs.chmod(file, enabled ? 0o755 : 0o644);
    return;
  }
  const raw = await fs.readFile(file, 'utf8');
  const next = setDisabled(raw, !enabled);
  if (next !== raw) {
    await fs.writeFile(file, next, 'utf8');
  }
}

export async function deleteItem(kind: CustomKind, file: string, roots: string[], home = os.homedir()): Promise<void> {
  await writable(kind, file, roots, home);
  await fs.rm(file);
}

/**
 * A file name for a new item: letters, digits, spaces, `.`, `_` and `-`, no folders. Rules take `.md`, `.txt` or no
 * extension and commands `.md` or none (`.md` is appended); hook scripts keep a script extension or none.
 */
export function newItemFileName(kind: CustomKind, raw: string): string {
  const name = raw.trim();
  if (!name) {
    throw new Error('Enter a name.');
  }
  if (name.length > 80 || !/^[\w][\w .-]*$/.test(name) || name.includes('..') || /[. ]$/.test(name)) {
    throw new Error('Use letters, digits, spaces, "-", "_" and "." only (no folders), up to 80 characters.');
  }
  if (kind === 'hook') {
    const ext = /\.[^.]+$/.exec(name)?.[0];
    if (ext && !HOOK_EXT.test(name)) {
      throw new Error(`Hook scripts end in .sh, .bash, .zsh, .js, .mjs, .cjs, .ts, .py or .ps1 (or have no extension), not ${ext}.`);
    }
    return name;
  }
  const allowed = kind === 'rule' ? /\.(md|txt)$/i : /\.md$/i;
  if (allowed.test(name)) {
    return name;
  }
  const ext = /\.[A-Za-z0-9]{1,8}$/.exec(name)?.[0];
  if (ext && !/^\.\d+$/.test(ext)) {
    throw new Error(kind === 'rule' ? `Rules are .md or .txt files, not ${ext}.` : `Commands are .md files, not ${ext}.`);
  }
  return `${name}.md`;
}

function template(kind: CustomKind, file: string): string {
  const base = path.basename(file).replace(/\.[^.]+$/, '');
  if (kind === 'rule') {
    return `---\n# Uncomment to apply this rule only while a matching file is in context:\n# paths: src/**/*.ts\n---\n# ${base}\n\n`;
  }
  if (kind === 'command') {
    return `---\ndescription: ${base}\nargument-hint: [what to do]\n---\n$ARGUMENTS\n`;
  }
  return `#!/usr/bin/env bash\n# LocalPilot hook script. The event arrives as JSON on stdin.\n# Exit 0 to continue, exit 2 to block the action (stderr is the reason given to the agent).\ncat > /dev/null\nexit 0\n`;
}

/**
 * Creates `.localpilot/{rules,commands}/<name>` in the first workspace folder or the home folder. An existing file is
 * left alone (`created: false`). Hook scripts are refused until the agent runs them.
 */
export async function createItem(kind: CustomKind, rawName: string, scope: 'global' | 'workspace', roots: string[], home = os.homedir()): Promise<{ file: string; created: boolean }> {
  if (kind === 'hook') {
    throw new Error('Hook scripts in a hooks folder are not run yet: add the hook to .localpilot/settings.json instead.');
  }
  const name = newItemFileName(kind, rawName);
  const base = scope === 'workspace' ? roots[0] : home;
  if (!base) {
    throw new Error('Open a folder to create workspace items.');
  }
  const dir = path.join(base, NEW_DIR[kind]);
  await fs.mkdir(dir, { recursive: true });
  const allowed = await Promise.all(allowedRoots(kind, roots, home).map(real));
  const realDir = await real(dir);
  if (!allowed.some((a) => inside(realDir, a))) {
    throw new Error(`Refusing to write in ${dir}: it resolves outside the ${kind} folders (${realDir}).`);
  }
  const file = path.join(dir, name);
  try {
    await fs.writeFile(file, template(kind, file), { encoding: 'utf8', flag: 'wx', mode: 0o644 });
    return { file, created: true };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') {
      return { file, created: false };
    }
    throw e;
  }
}
