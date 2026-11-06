/**
 * The prompt library: saved prompts are custom slash commands, so a prompt saved here also runs as `/name`, and a
 * command written by hand shows up in the library. No `vscode` import (the smoke tests and the CLI load it).
 *
 *   workspace scope: <folder>/.localpilot/commands/<name>.md   (commit it to share the prompt with the team)
 *   user scope:      ~/.localpilot/commands/<name>.md          (every workspace)
 *
 * Commands from `.claude/commands`, Cline workflows, plugins and the organisation's folder are listed too; the ones in
 * the workspace or the home folder can be edited and deleted, the others are read-only (insert only).
 */
import * as fs from 'fs/promises';
import * as path from 'path';
import { CustomCommand } from './commands';
import { normalizeCommandName } from './slashNames';

export type PromptScope = 'workspace' | 'user';

export interface PromptItem {
  name: string;
  /** How it runs as a command: `/review`, `/frontend:component`. */
  invoke: string;
  description: string;
  body: string;
  argumentHint?: string;
  file: string;
  /** workspace / user: files the library can edit; plugin / organization: read-only. */
  scope: PromptScope | 'plugin' | 'organization';
  /** Shown next to the scope: `.claude/commands`, `plugin my-plugin`. */
  origin: string;
  editable: boolean;
  /** Has front matter the library does not edit (allowed-tools, model…): kept as it is when saving. */
  extra?: string[];
}

export interface PromptDirs {
  /** `<folder>/.localpilot/commands`; absent with no folder open. */
  workspace?: string;
  user: string;
}

export const promptDirs = (root: string | undefined, home: string): PromptDirs => ({ ...(root ? { workspace: path.join(root, '.localpilot', 'commands') } : {}), user: path.join(home, '.localpilot', 'commands') });

/** A name the library accepts: a file name without folders, 1-64 characters once normalised. */
export function promptName(raw: string): { name: string } | { error: string } {
  const t = raw.trim().replace(/^\//, '');
  if (!t) {
    return { error: 'Give the prompt a name.' };
  }
  if (/[\\/]/.test(t) || t.includes('..')) {
    return { error: 'A name cannot contain "/", "\\" or "..".' };
  }
  const name = normalizeCommandName(t).replace(/[:@]/g, '-').replace(/^[-.]+|[-.]+$/g, '');
  if (!name) {
    return { error: 'Use letters or digits in the name.' };
  }
  if (name.length > 64) {
    return { error: 'Keep the name under 64 characters.' };
  }
  return { name };
}

/** A name suggested from the prompt's first words: `Review this diff for security issues` → `review-diff-security-issues`. */
export function suggestPromptName(text: string): string {
  const STOP = new Set(['a', 'an', 'the', 'this', 'that', 'these', 'to', 'for', 'of', 'in', 'on', 'and', 'or', 'with', 'please', 'me', 'my', 'it', 'is', 'be', 'can', 'you']);
  const first = text.replace(/```[\s\S]*?(```|$)/g, ' ').split('\n').find((l) => l.trim()) ?? '';
  const words = first.toLowerCase().replace(/[@#][\w./-]+/g, ' ').split(/[^a-z0-9]+/).filter((w) => w && !STOP.has(w));
  return words.slice(0, 4).join('-').slice(0, 40) || 'prompt';
}

/** The library's view of the discovered commands: built-ins left out, workspace first, then user, plugins, organization. */
export function promptItems(commands: readonly CustomCommand[], dirs: PromptDirs, roots: readonly string[] = []): PromptItem[] {
  const ORDER = { workspace: 0, user: 1, plugin: 2, organization: 3 } as const;
  const rel = (file: string, base: string) => path.relative(base, path.dirname(file)).split(path.sep).join('/');
  const out: PromptItem[] = [];
  for (const c of commands) {
    if (c.source === 'builtin') {
      continue;
    }
    const scope: PromptItem['scope'] = c.source === 'project' ? 'workspace' : c.source === 'user' ? 'user' : c.source === 'plugin' ? 'plugin' : 'organization';
    const root = scope === 'workspace' ? roots.find((r) => isInside(c.file, r)) : undefined;
    const origin = scope === 'plugin' ? `plugin ${c.plugin ?? ''}`.trim() : scope === 'organization' ? 'organization' : root ? rel(c.file, root) : scope === 'user' ? `~/${rel(c.file, path.dirname(path.dirname(dirs.user)))}` : path.dirname(c.file);
    const extra = [c.argumentHint ? 'argument-hint' : '', c.allowedTools.length ? 'allowed-tools' : '', c.model ? 'model' : '', c.disableModelInvocation ? 'disable-model-invocation' : ''].filter(Boolean);
    out.push({ name: c.name, invoke: c.invoke, description: c.description, body: c.body, ...(c.argumentHint ? { argumentHint: c.argumentHint } : {}), file: c.file, scope, origin, editable: (scope === 'workspace' || scope === 'user') && !c.alwaysEnabled, ...(extra.length ? { extra } : {}) });
  }
  return out.sort((a, b) => ORDER[a.scope] - ORDER[b.scope] || a.invoke.localeCompare(b.invoke));
}

/** Every query word must appear in the name, description or text; name hits rank first. Empty query: all, in order. */
export function searchPrompts(items: readonly PromptItem[], query: string): PromptItem[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) {
    return [...items];
  }
  const scored: { it: PromptItem; score: number; i: number }[] = [];
  items.forEach((it, i) => {
    const name = it.invoke.toLowerCase();
    const hay = `${name} ${it.description.toLowerCase()} ${it.body.toLowerCase()}`;
    if (!words.every((w) => hay.includes(w))) {
      return;
    }
    scored.push({ it, i, score: words.reduce((s, w) => s + (name.includes(w) ? 10 : it.description.toLowerCase().includes(w) ? 3 : 1), 0) });
  });
  return scored.sort((a, b) => b.score - a.score || a.i - b.i).map((x) => x.it);
}

function isInside(file: string, dir: string): boolean {
  const r = path.relative(path.resolve(dir), path.resolve(file));
  return !!r && !r.startsWith('..') && !path.isAbsolute(r);
}

/** A front-matter value on one line: quoted when YAML would read it differently. */
function yamlLine(v: string): string {
  const s = v.replace(/\s*\r?\n\s*/g, ' ').trim();
  return /^[\s'"[{>|*&!%@`#-]|: | #|^(true|false|null|yes|no|~)$/i.test(s) ? `"${s.replace(/"/g, "'")}"` : s;
}

/**
 * The file text for a prompt. `previous` (the file being edited) keeps its other front matter (`allowed-tools`,
 * `argument-hint`, `model`…) and line endings; only `description` and the body change.
 */
export function promptFileText(description: string, body: string, previous?: string): string {
  const desc = description.trim();
  const text = body.replace(/\r\n/g, '\n').trim();
  const m = previous ? /^(\uFEFF?)---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(previous) : null;
  const eol = previous && /\r\n/.test(previous) ? '\r\n' : '\n';
  const kept: string[] = [];
  if (m) {
    const lines = m[2].split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      if (/^description:(\s|$)/.test(lines[i])) {
        while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1])) {
          i++;
        }
        continue;
      }
      kept.push(lines[i]);
    }
  }
  const meta = [...(desc ? [`description: ${yamlLine(desc)}`] : []), ...kept.filter((l, i, a) => l.trim() || (i > 0 && i < a.length - 1))];
  const head = meta.length ? `${m?.[1] ?? ''}---${eol}${meta.join(eol)}${eol}---${eol}` : m?.[1] ?? '';
  return `${head}${text.split('\n').join(eol)}${eol}`;
}

export interface SavePromptInput {
  name: string;
  description: string;
  body: string;
  scope: PromptScope;
  /** The file being edited and the scope it is listed in; a new name or scope moves it. */
  file?: string;
  fileScope?: PromptScope;
  /** Replace another prompt that already has this name in this scope. */
  overwrite?: boolean;
}

export type SavePromptResult = { ok: true; file: string; invoke: string; moved?: string } | { ok: false; error: string; exists?: string };

/** Writes a prompt into its scope's folder. Refuses an empty text, a bad name, a missing folder, or (unless `overwrite`) a name taken. */
export async function savePrompt(input: SavePromptInput, dirs: PromptDirs, editableFiles: ReadonlySet<string> = new Set()): Promise<SavePromptResult> {
  const n = promptName(input.name);
  if ('error' in n) {
    return { ok: false, error: n.error };
  }
  if (!input.body.trim()) {
    return { ok: false, error: 'The prompt text is empty.' };
  }
  const dir = input.scope === 'workspace' ? dirs.workspace : dirs.user;
  if (!dir) {
    return { ok: false, error: 'Open a folder to save prompts for this workspace, or save it for yourself.' };
  }
  const prev = input.file ? path.resolve(input.file) : undefined;
  if (prev && !editableFiles.has(prev) && !isInside(prev, dirs.user) && !(dirs.workspace && isInside(prev, dirs.workspace))) {
    return { ok: false, error: 'That prompt is read-only here.' };
  }
  const prevText = prev ? await fs.readFile(prev, 'utf8').catch(() => undefined) : undefined;
  // Editing a file in place keeps its location (a `.claude/commands` file stays there) unless the name or scope changed.
  const sameName = prev && normalizeCommandName(path.basename(prev)) === n.name;
  const target = prev && sameName && (input.fileScope ?? input.scope) === input.scope ? prev : path.join(dir, `${n.name}.md`);
  if (target !== prev) {
    const taken = await fs.stat(target).then(() => true, () => false);
    if (taken && !input.overwrite) {
      return { ok: false, error: `A prompt named /${n.name} already exists here.`, exists: target };
    }
  }
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, promptFileText(input.description, input.body, prevText), 'utf8');
  let moved: string | undefined;
  if (prev && target !== prev && prevText !== undefined) {
    await fs.rm(prev, { force: true });
    moved = prev;
  }
  return { ok: true, file: target, invoke: `/${n.name}`, ...(moved ? { moved } : {}) };
}

/** Deletes a prompt file, but only one the library lists as editable (never a plugin's or the organisation's). */
export async function deletePrompt(file: string, editableFiles: ReadonlySet<string>): Promise<boolean> {
  const f = path.resolve(file);
  if (!editableFiles.has(f)) {
    return false;
  }
  await fs.rm(f, { force: true });
  return true;
}

/** `/prompts` as text (the CLI, and the chat when the library sheet is not available). */
export function promptsMarkdown(items: readonly PromptItem[]): string {
  if (!items.length) {
    return 'No saved prompts yet. Save one from the message box (⋯ → **Save as prompt…**) or from a sent message, or add a Markdown file to `.localpilot/commands/` (this workspace) or `~/.localpilot/commands/` (you). Each prompt also runs as `/name`.';
  }
  const label = { workspace: 'Workspace', user: 'You', plugin: 'Plugins', organization: 'Organization' } as const;
  const out: string[] = ['**Prompt library**'];
  for (const scope of ['workspace', 'user', 'plugin', 'organization'] as const) {
    const group = items.filter((i) => i.scope === scope);
    if (group.length) {
      out.push('', `${label[scope]} (${group.length})`, ...group.map((i) => `- \`${i.invoke}${i.argumentHint ? ` ${i.argumentHint}` : ''}\`: ${i.description || i.body.split('\n')[0].slice(0, 100)}`));
    }
  }
  out.push('', 'Run one with `/name`, or open the library with `/prompts` in the chat to insert, edit or delete.');
  return out.join('\n');
}
