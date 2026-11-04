import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { discoverCommands } from '../agent/commands';
import { setDisabled } from '../agent/frontMatterEdit';
import { discoverHookScripts, HOOK_DISABLED_SUFFIX, HOOK_SCRIPT_EXT, hookScriptDirs, hookScriptName, hookTemplate, scriptEvent } from '../agent/hookScripts';
import { describePlugin, setPluginEnabled } from '../agent/pluginInstaller';
import { discoverPlugins } from '../agent/plugins';
import { HOOK_EVENTS, loadProjectSettings, readSettingsFile, settingsFilesFor, userSettingsFiles } from '../agent/settings';
import { collectInstructionFiles } from '../context/instructions';

/**
 * Settings → Customize: the rule, command and hook files and the plugins of the workspace and of the user, with on/off,
 * open, delete and create. Every write goes to a file that is in the current listing and whose real path lies inside an allowed
 * root, so a symlink cannot redirect a toggle or a delete outside the rule, command or hook folders.
 */

export type CustomKind = 'rule' | 'command' | 'hook' | 'plugin';

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
  /** A hook script whose file name is not an event: listed, never run. */
  notRun?: boolean;
  /** Plugins: version, and whether it may be deleted from here (not the workspace itself or a `pluginPaths` folder). */
  version?: string;
  removable?: boolean;
  /** From the organisation's folder next to managed-settings.json: listed and opened, never changed from here. */
  managed?: boolean;
  /** `alwaysEnabled: true` front matter: cannot be switched off. */
  alwaysEnabled?: boolean;
}

export interface CustomizeData {
  rules: CustomItem[];
  commands: CustomItem[];
  hooks: CustomItem[];
  plugins: CustomItem[];
  /** Hook events offered for a new hook script: those with no hook yet. */
  events: string[];
  hasWorkspace: boolean;
  /** Hook scripts are switched with the executable bit, on Windows by renaming them `….disabled`. */
  canSwitchHooks: boolean;
}

const NEW_DIR: Record<Exclude<CustomKind, 'plugin'>, string> = { rule: '.localpilot/rules', command: '.localpilot/commands', hook: '.localpilot/hooks' };

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
  if (kind === 'plugin') {
    return [...roots.flatMap((r) => [path.join(r, '.localpilot', 'plugins'), path.join(r, '.claude', 'plugins')]), h('.localpilot/plugins'), h('.claude/plugins')];
  }
  return hookScriptDirs(roots, home).map((d) => d.dir);
}

async function listRules(roots: string[], home: string): Promise<CustomItem[]> {
  const files = await collectInstructionFiles(roots, home, { includeDisabled: true });
  return files.map((f) => ({
    kind: 'rule' as const,
    file: f.file,
    name: f.name ?? path.basename(f.file),
    label: f.label,
    scope: f.scope === 'user' || f.scope === 'managed' ? ('global' as const) : ('workspace' as const),
    ...(f.disabled ? { disabled: true } : {}),
    ...(f.paths ? { paths: f.paths } : {}),
    ...(f.scope === 'managed' ? { managed: true } : {}),
    ...(f.alwaysEnabled ? { alwaysEnabled: true } : {}),
    // Ancestor folders' CLAUDE.md belong to another project, the organisation's rules to the administrator: shown, not changed from here.
    editable: f.scope !== 'ancestor' && f.scope !== 'managed' && !f.alwaysEnabled,
  }));
}

async function listCommands(roots: string[], home: string): Promise<CustomItem[]> {
  const all = await discoverCommands(roots, { home, includeDisabled: true });
  return all
    .filter((c) => c.source === 'project' || c.source === 'user' || c.source === 'managed')
    .map((c) => ({
      kind: 'command' as const,
      file: c.file,
      name: c.invoke,
      label: c.source === 'managed' ? `organization/commands/${path.basename(c.file)}` : labelFor(c.file, roots, home),
      scope: c.source === 'project' ? ('workspace' as const) : ('global' as const),
      description: c.description,
      ...(c.disabled ? { disabled: true } : {}),
      ...(c.source === 'managed' ? { managed: true } : {}),
      ...(c.alwaysEnabled ? { alwaysEnabled: true } : {}),
      editable: c.source !== 'managed' && !c.alwaysEnabled,
    }));
}

async function listHookFiles(roots: string[], home: string): Promise<CustomItem[]> {
  const scripts = await discoverHookScripts(roots, { home });
  return scripts.map((sc) => {
    const base = hookScriptName(sc.name).replace(HOOK_SCRIPT_EXT, '');
    const description = !sc.event ? 'Not an event name: never runs' : base === sc.event ? `${sc.event} hook script` : `${base} → ${sc.event}${sc.matcher ? ` (${sc.matcher})` : ''}`;
    return { kind: 'hook' as const, file: sc.file, name: sc.name, label: labelFor(sc.file, roots, home), scope: sc.scope, description, ...(sc.enabled ? {} : { disabled: true }), ...(sc.event ? {} : { notRun: true }), editable: true };
  });
}

async function listPlugins(roots: string[], home: string, pluginDirs: string[]): Promise<CustomItem[]> {
  const { enabledPlugins } = await loadProjectSettings(roots, { home });
  const list = await discoverPlugins(roots, { home, extraDirs: pluginDirs, enabledPlugins });
  const managed = allowedRoots('plugin', roots, home);
  return list.map((p) => ({
    kind: 'plugin' as const,
    file: p.root,
    name: p.name,
    label: labelFor(p.root, roots, home),
    scope: p.source === 'user' ? ('global' as const) : ('workspace' as const),
    description: p.description || describePlugin(p).summary,
    detail: describePlugin(p).summary.replace(/^[^:]*: /, ''),
    ...(p.version ? { version: p.version } : {}),
    ...(p.enabled ? {} : { disabled: true }),
    editable: true,
    removable: managed.some((d) => inside(p.root, d) && path.resolve(p.root) !== path.resolve(d)),
  }));
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

export async function listCustomizations(roots: string[], home = os.homedir(), opts: { pluginDirs?: string[] } = {}): Promise<CustomizeData> {
  const [rules, commands, hookFiles, settingsHooks, plugins] = await Promise.all([listRules(roots, home), listCommands(roots, home), listHookFiles(roots, home), listSettingsHooks(roots, home), listPlugins(roots, home, opts.pluginDirs ?? [])]);
  const hooked = new Set<string>([...hookFiles.map((h) => scriptEvent(hookScriptName(h.name))?.event), ...settingsHooks.map((h) => h.name)].filter((e): e is string => !!e));
  return { rules, commands, hooks: [...hookFiles, ...settingsHooks], plugins, events: HOOK_EVENTS.filter((e) => !hooked.has(e)), hasWorkspace: roots.length > 0, canSwitchHooks: true };
}

/** The listed, editable item for `file`, after checking that its real path is inside an allowed root. */
async function writable(kind: CustomKind, file: string, roots: string[], home: string, pluginDirs: string[] = []): Promise<CustomItem> {
  const data = await listCustomizations(roots, home, { pluginDirs });
  const items = kind === 'rule' ? data.rules : kind === 'command' ? data.commands : kind === 'plugin' ? data.plugins : data.hooks;
  const item = items.find((i) => i.editable && path.resolve(i.file) === path.resolve(file));
  if (!item) {
    throw new Error(`Not a ${kind} file LocalPilot manages: ${file}`);
  }
  if (kind === 'plugin') {
    // Switching a plugin writes settings.json, not the plugin: only deleting needs the folder check (removable).
    return item;
  }
  const target = await real(file);
  const allowed = await Promise.all(allowedRoots(kind, roots, home).map(real));
  if (!allowed.some((dir) => inside(target, dir))) {
    throw new Error(`Refusing to change ${file}: it resolves outside the ${kind} folders (${target}).`);
  }
  return item;
}

/** The settings.json that switches a plugin: the user's for user plugins, the first workspace folder's otherwise. */
export function pluginSettingsFile(scope: 'global' | 'workspace', roots: string[], home = os.homedir()): string {
  return scope === 'global' || !roots[0] ? path.join(home, '.localpilot', 'settings.json') : path.join(roots[0], '.localpilot', 'settings.json');
}

/**
 * Rules and commands: `disabled: true` front matter; hook scripts: the executable bit (on Windows: a `.disabled`
 * suffix on the file name); plugins: `enabledPlugins`.
 */
export async function setItemEnabled(kind: CustomKind, file: string, enabled: boolean, roots: string[], home = os.homedir(), pluginDirs: string[] = [], platform: NodeJS.Platform = process.platform): Promise<void> {
  const item = await writable(kind, file, roots, home, pluginDirs);
  if (kind === 'plugin') {
    await setPluginEnabled(pluginSettingsFile(item.scope, roots, home), item.name, enabled);
    return;
  }
  if (kind === 'hook') {
    const bare = path.join(path.dirname(file), hookScriptName(path.basename(file)));
    // A `.disabled` name is off on every platform; Windows has no executable bit, so that is its only switch.
    const target = enabled ? bare : platform === 'win32' ? bare + HOOK_DISABLED_SUFFIX : file;
    if (target !== file) {
      if (await fs.stat(target).then(() => true, () => false)) {
        throw new Error(`${path.basename(file)} was not renamed: ${path.basename(target)} already exists.`);
      }
      await fs.rename(file, target);
    }
    if (platform !== 'win32') {
      await fs.chmod(target, enabled ? 0o755 : 0o644);
    }
    return;
  }
  const raw = await fs.readFile(file, 'utf8');
  const next = setDisabled(raw, !enabled);
  if (next !== raw) {
    await fs.writeFile(file, next, 'utf8');
  }
}

export async function deleteItem(kind: CustomKind, file: string, roots: string[], home = os.homedir(), pluginDirs: string[] = []): Promise<void> {
  const item = await writable(kind, file, roots, home, pluginDirs);
  if (kind === 'plugin') {
    const target = await real(file);
    const allowed = await Promise.all(allowedRoots('plugin', roots, home).map(real));
    if (!item.removable || !allowed.some((dir) => inside(target, dir) && target !== dir)) {
      throw new Error(`${item.name} is not in a plugins folder LocalPilot manages: remove ${file} yourself.`);
    }
    await fs.rm(file, { recursive: true, force: true });
    return;
  }
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
  if (kind === 'plugin') {
    throw new Error('Plugins are installed with LocalPilot: Browse Plugins…, not created here.');
  }
  if (kind === 'hook') {
    // A template is bash or PowerShell, named after its event: `PreToolUse.sh`.
    const ext = /\.[^.]+$/.exec(name)?.[0];
    if (ext && !/^\.(sh|bash|ps1)$/i.test(ext)) {
      throw new Error(`New hook scripts are bash (.sh) or PowerShell (.ps1), not ${ext}.`);
    }
    const base = ext ? name.slice(0, -ext.length) : name;
    const event = HOOK_EVENTS.find((e) => e.toLowerCase() === base.toLowerCase());
    if (!event) {
      throw new Error(`A hook script is named after its event: ${HOOK_EVENTS.join(', ')}.`);
    }
    return `${event}${ext ? ext.toLowerCase() : process.platform === 'win32' ? '.ps1' : '.sh'}`;
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

function template(kind: Exclude<CustomKind, 'plugin'>, file: string): string {
  const base = path.basename(file).replace(/\.[^.]+$/, '');
  if (kind === 'rule') {
    return `---\n# Uncomment to apply this rule only while a matching file is in context:\n# paths: src/**/*.ts\n---\n# ${base}\n\n`;
  }
  if (kind === 'command') {
    return `---\ndescription: ${base}\nargument-hint: [what to do]\n---\n$ARGUMENTS\n`;
  }
  const name = hookScriptName(path.basename(file));
  return hookTemplate(name.replace(HOOK_SCRIPT_EXT, ''), /\.ps1$/i.test(name) ? 'powershell' : 'bash');
}

/**
 * Creates `.localpilot/{rules,commands,hooks}/<name>` in the first workspace folder or the home folder. An existing
 * file is left alone (`created: false`). A hook script is a commented template created switched off: mode 0644, and
 * on Windows (no executable bit) named `<Event>.ps1.disabled`.
 */
export async function createItem(kind: CustomKind, rawName: string, scope: 'global' | 'workspace', roots: string[], home = os.homedir(), platform: NodeJS.Platform = process.platform): Promise<{ file: string; created: boolean }> {
  if (kind === 'plugin') {
    throw new Error('Plugins are installed with LocalPilot: Browse Plugins…, not created here.');
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
  let file = path.join(dir, name);
  if (kind === 'hook') {
    // The script may already be there, switched on or off.
    const off = file + HOOK_DISABLED_SUFFIX;
    for (const f of [file, off]) {
      if (await fs.stat(f).then(() => true, () => false)) {
        return { file: f, created: false };
      }
    }
    if (platform === 'win32') {
      file = off;
    }
  }
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
