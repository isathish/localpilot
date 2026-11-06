import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { parseJsonc } from './jsonc';
import { hasSubstitution, parseRule, splitCommandChain, toolNames } from './permissions';
import { settingsFilesFor, userSettingsFiles } from './settings';

/**
 * Saved command rules: the `Bash(<pattern>)` permission rules of the settings files (the same storage the approval
 * gate already reads, Claude Code compatible). Settings lists them with their scope and edits the two files LocalPilot
 * owns: `~/.localpilot/settings.json` (User, every workspace) and `<folder>/.localpilot/settings.local.json`
 * (Workspace, personal: kept out of git). Rules in other files (`.claude/…`, a committed `.localpilot/settings.json`)
 * are listed read-only.
 */

export type CommandRuleKind = 'allow' | 'ask' | 'block';
export type CommandRuleScope = 'user' | 'workspace';

export interface CommandRule {
  /** The command pattern: `npm test` (exact), `npm run test:*` (prefix), `git *` (wildcards); '' = every command. */
  pattern: string;
  kind: CommandRuleKind;
  /** The rule as written in the file (`Bash(npm test)`), to find it again for an edit or delete. */
  raw: string;
  file: string;
  scope: CommandRuleScope;
  /** False for files LocalPilot does not write (another tool's, or a project file meant to be committed). */
  editable: boolean;
}

const LIST: Record<CommandRuleKind, 'allow' | 'ask' | 'deny'> = { allow: 'allow', ask: 'ask', block: 'deny' };
const COMMAND_TOOLS = new Set(toolNames('run_command'));

/** The two files Settings writes: User and (with a folder open) Workspace. */
export function commandRuleFiles(root: string | undefined, home = os.homedir()): { user: string; workspace?: string } {
  return { user: path.join(home, '.localpilot', 'settings.json'), workspace: root ? path.join(root, '.localpilot', 'settings.local.json') : undefined };
}

/** `npm test` → `Bash(npm test)`; an empty pattern is the bare tool (every command). */
export function commandRuleText(pattern: string): string {
  const p = pattern.trim().replace(/\s+/g, ' ');
  return p ? `Bash(${p})` : 'Bash';
}

/** The command pattern of a rule about shell commands, or undefined for any other rule. */
export function commandPatternOf(raw: string): string | undefined {
  const r = parseRule(raw);
  return r && COMMAND_TOOLS.has(r.tool) ? r.specifier ?? '' : undefined;
}

/** Why a pattern cannot be saved, or '' when it can. */
export function validateCommandPattern(pattern: string): string {
  const p = pattern.trim();
  if (!p) {
    return 'Type a command or pattern, e.g. npm test or npm run test:*';
  }
  if (p.length > 300) {
    return 'Keep the pattern under 300 characters';
  }
  if (/[\r\n]/.test(p)) {
    return 'One command per rule (no line breaks)';
  }
  return '';
}

/**
 * The pattern "Always allow" offers for a command from an approval prompt: the command itself, when it is one simple
 * command (no chain, pipe or substitution, which a rule could not judge as a whole). Undefined otherwise.
 */
export function suggestedCommandPattern(command: string): string | undefined {
  const c = command.trim().replace(/\s+/g, ' ');
  if (!c || c.length > 200 || /[\r\n()]/.test(command) || hasSubstitution(c) || splitCommandChain(c).length !== 1 || /[<>|;&]/.test(c)) {
    return undefined;
  }
  return c;
}

/** True when the JSONC text has a comment outside strings (rewriting it would lose the comment). */
export function hasJsonComments(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      for (i++; i < text.length && text[i] !== '"'; i++) {
        if (text[i] === '\\') {
          i++;
        }
      }
    } else if (c === '/' && (text[i + 1] === '/' || text[i + 1] === '*')) {
      return true;
    }
  }
  return false;
}

async function readObject(file: string): Promise<{ obj: Record<string, unknown>; text?: string }> {
  let text: string;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch {
    return { obj: {} };
  }
  if (!text.trim()) {
    return { obj: {}, text };
  }
  const v = parseJsonc(text);
  if (!v || typeof v !== 'object' || Array.isArray(v)) {
    throw new Error(`${file} is not a JSON object`);
  }
  return { obj: v as Record<string, unknown>, text };
}

/** Every command rule in the settings files that apply here (User files first), with the files Settings may write. */
export async function listCommandRules(roots: string[], home = os.homedir()): Promise<CommandRule[]> {
  const own = new Set<string>([commandRuleFiles(undefined, home).user, ...roots.map((r) => commandRuleFiles(r, home).workspace!)]);
  const files: [string, CommandRuleScope][] = [...userSettingsFiles(home).map((f) => [f, 'user'] as [string, CommandRuleScope]), ...roots.flatMap((r) => settingsFilesFor(r).map((f) => [f, 'workspace'] as [string, CommandRuleScope]))];
  const out: CommandRule[] = [];
  for (const [file, scope] of files) {
    let obj: Record<string, unknown>;
    try {
      obj = (await readObject(file)).obj;
    } catch {
      continue; // unreadable: the gate skips it too (settings.ts logs it)
    }
    const perms = (obj.permissions ?? {}) as Record<string, unknown>;
    for (const kind of ['block', 'ask', 'allow'] as CommandRuleKind[]) {
      const list = perms[LIST[kind]];
      for (const raw of Array.isArray(list) ? list : typeof list === 'string' ? [list] : []) {
        if (typeof raw !== 'string') {
          continue;
        }
        const pattern = commandPatternOf(raw);
        if (pattern !== undefined) {
          out.push({ pattern, kind, raw: raw.trim(), file, scope, editable: own.has(file) });
        }
      }
    }
  }
  return out;
}

/** The rules of a settings object with `rule` removed from `kind`'s list (when given) and `add` added to its kind's list. */
export function editPermissions(obj: Record<string, unknown>, change: { remove?: { kind: CommandRuleKind; raw: string }; add?: { kind: CommandRuleKind; raw: string } }): Record<string, unknown> {
  const perms = { ...((obj.permissions && typeof obj.permissions === 'object' && !Array.isArray(obj.permissions) ? obj.permissions : {}) as Record<string, unknown>) };
  const listOf = (k: CommandRuleKind): string[] => {
    const v = perms[LIST[k]];
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : typeof v === 'string' ? [v] : [];
  };
  if (change.remove) {
    const k = change.remove.kind;
    perms[LIST[k]] = listOf(k).filter((r) => r.trim() !== change.remove!.raw.trim());
  }
  if (change.add) {
    const k = change.add.kind;
    const list = listOf(k);
    if (!list.some((r) => r.trim() === change.add!.raw)) {
      perms[LIST[k]] = [...list, change.add.raw];
    }
    // One pattern has one verdict per file: saving it as Block drops the same pattern from Allow and Ask.
    for (const other of ['allow', 'ask', 'block'] as CommandRuleKind[]) {
      if (other !== k && listOf(other).some((r) => r.trim() === change.add!.raw)) {
        perms[LIST[other]] = listOf(other).filter((r) => r.trim() !== change.add!.raw);
      }
    }
  }
  for (const k of ['allow', 'ask', 'deny']) {
    if (Array.isArray(perms[k]) && !(perms[k] as unknown[]).length) {
      delete perms[k];
    }
  }
  const next = { ...obj };
  if (Object.keys(perms).length) {
    next.permissions = perms;
  } else {
    delete next.permissions;
  }
  return next;
}

/**
 * Applies one change to a settings file LocalPilot owns. A file with comments is not rewritten (the comments would be
 * lost): the error says to edit it by hand. A new Workspace file is kept out of git through `.git/info/exclude`.
 */
export async function writeCommandRule(file: string, change: Parameters<typeof editPermissions>[1]): Promise<void> {
  const { obj, text } = await readObject(file);
  if (text && hasJsonComments(text)) {
    throw new Error(`${path.basename(file)} has comments, which saving from Settings would remove. Edit it by hand: ${file}`);
  }
  const next = editPermissions(obj, change);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  if (text === undefined && path.basename(file) === 'settings.local.json') {
    await excludeFromGit(path.dirname(path.dirname(file)), path.relative(path.dirname(path.dirname(file)), file)).catch(() => undefined);
  }
}

/** Adds `rel` to `<root>/.git/info/exclude` (personal settings are not committed by accident). No git, no change. */
async function excludeFromGit(root: string, rel: string): Promise<void> {
  const info = path.join(root, '.git', 'info');
  const st = await fs.stat(path.join(root, '.git')).catch(() => undefined);
  if (!st?.isDirectory()) {
    return;
  }
  const file = path.join(info, 'exclude');
  const line = rel.split(path.sep).join('/');
  const cur = await fs.readFile(file, 'utf8').catch(() => '');
  if (cur.split(/\r?\n/).some((l) => l.trim() === line || l.trim() === `/${line}`)) {
    return;
  }
  await fs.mkdir(info, { recursive: true });
  await fs.writeFile(file, `${cur}${cur && !cur.endsWith('\n') ? '\n' : ''}${line}\n`, 'utf8');
}

/** The kind of the rule list a decision name refers to (for messages from the webviews). */
export const isCommandRuleKind = (v: unknown): v is CommandRuleKind => v === 'allow' || v === 'ask' || v === 'block';
