import * as vscode from 'vscode';
import * as path from 'path';
import { TodoItem, Tool } from '../types';

export type MemoryScope = 'project' | 'global';

export interface MemoryNote {
  name: string;
  scope: MemoryScope;
  /** First non-empty line, used in the prompt index. */
  summary: string;
  updatedAt: number;
  chars: number;
}

export interface MemoryWriteResult {
  path: string;
  /** An append that added nothing new; the file was not touched. */
  unchanged: boolean;
  duplicateLines: number;
  /** Old paragraphs dropped to stay under `memory.maxNoteChars`. */
  droppedBlocks: number;
  /** Notes removed from the scope to stay under `memory.maxNotes`. */
  pruned: string[];
}

const lineKey = (l: string) => l.trim().replace(/^(?:[-*+]|\d+[.)])\s+/, '').replace(/\s+/g, ' ').toLowerCase();

/**
 * The lines of `addition` that `existing` does not already contain (ignoring bullets, case and spacing), so repeated
 * appends of the same facts do not grow a note. Blank lines, short lines and code fences are always kept.
 */
export function newLines(existing: string, addition: string): { text: string; duplicates: number } {
  const seen = new Set(existing.split('\n').map(lineKey).filter((k) => k.length >= 8));
  let duplicates = 0;
  const kept = addition.split('\n').filter((l) => {
    const k = lineKey(l);
    if (k.length < 8 || k.startsWith('```')) {
      return true;
    }
    if (seen.has(k)) {
      duplicates++;
      return false;
    }
    seen.add(k);
    return true;
  });
  return { text: kept.join('\n').replace(/\n{3,}/g, '\n\n'), duplicates };
}

/**
 * Fits a note into `max` characters by dropping its oldest paragraphs, then its oldest lines (keeping a leading
 * heading line). The newest text always survives; `dropped` counts the paragraphs and lines removed.
 */
export function fitNote(text: string, max: number): { text: string; dropped: number } {
  text = text.replace(/\r\n?/g, '\n');
  if (text.length <= max) {
    return { text, dropped: 0 };
  }
  const blocks = text.trim().split(/\n{2,}/);
  const head: string[] = [];
  if (/^#/.test(blocks[0])) {
    const [first, ...rest] = blocks[0].split('\n');
    head.push(first);
    if (rest.join('\n').trim()) {
      blocks[0] = rest.join('\n').trim();
    } else {
      blocks.shift();
    }
  }
  let dropped = 0;
  const size = () => [...head, ...blocks].join('\n\n').length + 1;
  while (blocks.length > 1 && size() > max) {
    blocks.shift();
    dropped++;
  }
  if (blocks.length && size() > max) {
    const lines = blocks[0].split('\n');
    while (lines.length > 1 && size() > max) {
      lines.shift();
      blocks[0] = lines.join('\n');
      dropped++;
    }
  }
  const out = `${[...head, ...blocks].join('\n\n')}\n`;
  if (out.length <= max) {
    return { text: out, dropped };
  }
  // A single line (or the heading alone) is still too long: keep its end, where the newest text is.
  return { text: `${out.slice(out.length - max).trimStart()}`, dropped: dropped + 1 };
}

/**
 * Persistent agent memory as plain Markdown files the user can read and edit:
 *   project: <workspace>/.localpilot/memory/<name>.md   (commit it to share with the team)
 *   global:  <globalStorage>/memory/<name>.md           (follows the user across workspaces)
 * A compact index (name + first line) is injected into every system prompt; bodies load on demand
 * via memory_read, except small notes which are inlined.
 */
export class MemoryStore {
  private cache = new Map<string, { text: string; mtime: number }>();
  private locks = new Map<string, Promise<unknown>>();

  constructor(
    private readonly globalDir: vscode.Uri,
    private readonly log: vscode.LogOutputChannel,
    /** Size caps applied on every write; absent = unlimited. */
    private readonly limits?: () => { maxNoteChars: number; maxNotes: number }
  ) {}

  /** Runs `fn` after every earlier call with the same key has settled. */
  private withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const run = (this.locks.get(key) ?? Promise.resolve()).then(fn, fn);
    const tail = run.catch(() => undefined);
    this.locks.set(key, tail);
    void tail.then(() => {
      if (this.locks.get(key) === tail) {
        this.locks.delete(key);
      }
    });
    return run;
  }

  private dir(scope: MemoryScope): vscode.Uri | undefined {
    if (scope === 'global') {
      return vscode.Uri.joinPath(this.globalDir, 'memory');
    }
    const root = vscode.workspace.workspaceFolders?.[0]?.uri;
    return root ? vscode.Uri.joinPath(root, '.localpilot', 'memory') : undefined;
  }

  private safeName(name: string): string {
    return name.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64) || 'note';
  }

  /** The note file for `name`: a listed entry matching exactly, then case-insensitively, then by safe name; else the safe name. */
  private async resolve(dir: vscode.Uri, name: string): Promise<vscode.Uri> {
    let stems: string[] = [];
    try {
      stems = (await vscode.workspace.fs.readDirectory(dir))
        .filter(([f, t]) => t === vscode.FileType.File && f.endsWith('.md'))
        .map(([f]) => f.replace(/\.md$/, ''));
    } catch {
      /* no memory dir yet */
    }
    const safe = this.safeName(name);
    const hit =
      stems.find((s) => s === name) ??
      stems.find((s) => s.toLowerCase() === name.toLowerCase()) ??
      stems.find((s) => this.safeName(s) === safe);
    return vscode.Uri.joinPath(dir, hit !== undefined ? `${hit}.md` : `${safe}.md`);
  }

  async list(): Promise<MemoryNote[]> {
    const out: MemoryNote[] = [];
    for (const scope of ['project', 'global'] as MemoryScope[]) {
      const dir = this.dir(scope);
      if (!dir) {
        continue;
      }
      try {
        for (const [file, type] of await vscode.workspace.fs.readDirectory(dir)) {
          if (type !== vscode.FileType.File || !file.endsWith('.md')) {
            continue;
          }
          const uri = vscode.Uri.joinPath(dir, file);
          const stat = await vscode.workspace.fs.stat(uri);
          const text = await this.readUri(uri, stat.mtime);
          out.push({
            name: file.replace(/\.md$/, ''),
            scope,
            summary: text.split('\n').map((l) => l.replace(/^#+\s*/, '').trim()).find(Boolean)?.slice(0, 140) ?? '',
            updatedAt: stat.mtime,
            chars: text.length,
          });
        }
      } catch {
        /* no memory dir yet */
      }
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async read(name: string, scope?: MemoryScope): Promise<string | undefined> {
    for (const s of scope ? [scope] : (['project', 'global'] as MemoryScope[])) {
      const dir = this.dir(s);
      if (!dir) {
        continue;
      }
      const uri = await this.resolve(dir, name);
      try {
        const stat = await vscode.workspace.fs.stat(uri);
        return await this.readUri(uri, stat.mtime);
      } catch {
        /* try next scope */
      }
    }
    return undefined;
  }

  /**
   * Saves a note. Appends skip lines the note already has, notes over `maxNoteChars` lose their oldest paragraphs,
   * and when a scope holds more than `maxNotes` the least recently updated ones are removed (README is kept).
   */
  async write(name: string, content: string, scope: MemoryScope, mode: 'replace' | 'append' = 'replace'): Promise<MemoryWriteResult> {
    const dir = this.dir(scope);
    if (!dir) {
      throw new Error('No workspace folder open; use scope "global".');
    }
    await vscode.workspace.fs.createDirectory(dir);
    const uri = mode === 'append' ? await this.resolve(dir, name) : vscode.Uri.joinPath(dir, `${this.safeName(name)}.md`);
    const lim = this.limits?.();
    // Appends are read-modify-write: serialise writes to the same note so concurrent ones do not lose lines.
    const r = await this.withLock(uri.toString(), async () => {
      let text = content.trim() + '\n';
      let duplicateLines = 0;
      if (mode === 'append') {
        const existing = (await this.read(name, scope)) ?? '';
        const fresh = newLines(existing, content);
        duplicateLines = fresh.duplicates;
        if (existing.trim() && !fresh.text.trim()) {
          return { duplicateLines };
        }
        text = existing.trim() ? `${existing.trimEnd()}\n\n${fresh.text.trim()}\n` : text;
      }
      const fit = lim ? fitNote(text, lim.maxNoteChars) : { text, dropped: 0 };
      await vscode.workspace.fs.writeFile(uri, Buffer.from(fit.text, 'utf8'));
      this.cache.delete(uri.toString());
      this.log.info(`memory: wrote ${scope}/${this.safeName(name)} (${fit.text.length} chars${fit.dropped ? `, dropped ${fit.dropped} old paragraph(s)` : ''}${duplicateLines ? `, skipped ${duplicateLines} duplicate line(s)` : ''})`);
      return { duplicateLines, fit };
    });
    if (!r.fit) {
      return { path: uri.fsPath, unchanged: true, duplicateLines: r.duplicateLines, droppedBlocks: 0, pruned: [] };
    }
    const { duplicateLines, fit } = r;
    const pruned = lim ? await this.prune(scope, lim.maxNotes, path.basename(uri.path)) : [];
    return { path: uri.fsPath, unchanged: false, duplicateLines, droppedBlocks: fit.dropped, pruned };
  }

  /** Removes the least recently updated notes beyond `max` in a scope; never README or the file `keep`. */
  private async prune(scope: MemoryScope, max: number, keep: string): Promise<string[]> {
    const dir = this.dir(scope);
    const notes = (await this.list()).filter((n) => n.scope === scope);
    if (!dir || notes.length <= max) {
      return [];
    }
    // `list()` is newest first, so walk the candidates from the least recently updated.
    const candidates = notes.filter((n) => `${n.name}.md` !== keep && n.name.toLowerCase() !== 'readme').reverse();
    const removed: string[] = [];
    for (const n of candidates) {
      if (removed.length >= notes.length - max) {
        break;
      }
      try {
        await vscode.workspace.fs.delete(vscode.Uri.joinPath(dir, `${n.name}.md`));
        this.cache.delete(vscode.Uri.joinPath(dir, `${n.name}.md`).toString());
        removed.push(n.name);
      } catch {
        /* try the next candidate */
      }
    }
    if (removed.length) {
      this.log.info(`memory: ${scope} holds more than ${max} notes — removed the oldest: ${removed.join(', ')}`);
    }
    return removed;
  }

  async delete(name: string, scope: MemoryScope): Promise<boolean> {
    const dir = this.dir(scope);
    if (!dir) {
      return false;
    }
    try {
      const uri = await this.resolve(dir, name);
      await vscode.workspace.fs.stat(uri);
      await vscode.workspace.fs.delete(uri);
      this.cache.delete(uri.toString());
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Prompt section within `maxChars`: an index of the notes (newest first) taking at most half the budget, then the
   * bodies of small notes inlined while the budget lasts. Notes that do not fit are counted, not listed, so a large
   * memory never crowds a small context window; memory_list and memory_read still reach all of them.
   */
  async promptSection(maxChars = 6000): Promise<string> {
    const notes = await this.list();
    if (!notes.length) {
      return '';
    }
    const lines: string[] = [];
    const listed: MemoryNote[] = [];
    let used = 0;
    for (const n of notes) {
      const head = `- ${n.name} (${n.scope}): ${n.summary}`;
      if (lines.length && used + head.length > maxChars / 2) {
        break;
      }
      lines.push(head);
      listed.push(n);
      used += head.length + 1;
    }
    if (listed.length < notes.length) {
      lines.push(`- …and ${notes.length - listed.length} older note${notes.length - listed.length === 1 ? '' : 's'}: memory_list shows them all`);
    }
    const inlined: string[] = [];
    for (const n of listed) {
      if (n.chars <= 1200 && used + n.chars < maxChars) {
        const body = await this.read(n.name, n.scope);
        if (body) {
          inlined.push(`<memory name="${n.name}" scope="${n.scope}">\n${body.trim()}\n</memory>`);
          used += n.chars;
        }
      }
    }
    return `${lines.join('\n')}${inlined.length ? `\n\n${inlined.join('\n')}` : ''}`;
  }

  openFolder(scope: MemoryScope): vscode.Uri | undefined {
    return this.dir(scope);
  }

  private async readUri(uri: vscode.Uri, mtime: number): Promise<string> {
    const key = uri.toString();
    const hit = this.cache.get(key);
    if (hit && hit.mtime === mtime) {
      return hit.text;
    }
    const text = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8').replace(/\r\n?/g, '\n');
    this.cache.set(key, { text, mtime });
    return text;
  }
}

export function createMemoryTools(memory: MemoryStore): Tool[] {
  const save: Tool = {
    definition: {
      name: 'memory_save',
      description:
        'Persist a durable note for future sessions: project conventions, architecture facts, decisions, user preferences, verified commands. Keep notes short and factual. Use scope "project" for repo-specific facts (shared via git) and "global" for the user\'s general preferences.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Short kebab-case topic, e.g. "build-and-test", "api-conventions", "user-preferences"' },
          content: { type: 'string', description: 'Markdown content (bullets preferred)' },
          scope: { type: 'string', enum: ['project', 'global'], description: 'Default project' },
          mode: { type: 'string', enum: ['replace', 'append'], description: 'Default replace' },
        },
        required: ['name', 'content'],
      },
    },
    async execute(args) {
      const scope = args.scope === 'global' ? 'global' : 'project';
      const r = await memory.write(String(args.name), String(args.content ?? ''), scope, args.mode === 'append' ? 'append' : 'replace');
      if (r.unchanged) {
        return { content: `Memory "${args.name}" (${scope}) already has all of this; nothing was added.` };
      }
      const notes = [
        r.duplicateLines ? `skipped ${r.duplicateLines} line(s) it already had` : '',
        r.droppedBlocks ? `dropped ${r.droppedBlocks} of its oldest paragraph(s) or line(s) to stay under the size limit — keep notes short` : '',
        r.pruned.length ? `removed the oldest notes to stay under the note limit: ${r.pruned.join(', ')}` : '',
      ].filter(Boolean);
      return { content: `Saved memory "${args.name}" (${scope}) → ${vscode.workspace.asRelativePath(r.path)}${notes.length ? ` (${notes.join('; ')})` : ''}` };
    },
  };
  const read: Tool = {
    parallelSafe: true,
    definition: {
      name: 'memory_read',
      description: 'Read the full content of a memory note by name (see the Memory index in your instructions).',
      parameters: {
        type: 'object',
        properties: { name: { type: 'string' }, scope: { type: 'string', enum: ['project', 'global'], description: 'Default: both' } },
        required: ['name'],
      },
    },
    async execute(args) {
      const name = String(args.name);
      if (args.scope === 'project' || args.scope === 'global') {
        const one = await memory.read(name, args.scope);
        return one ? { content: one } : { content: `No ${args.scope} memory named "${name}".`, isError: true };
      }
      const project = await memory.read(name, 'project');
      const global = await memory.read(name, 'global');
      if (project !== undefined && global !== undefined) {
        return { content: `## project\n${project.trim()}\n\n## global\n${global.trim()}` };
      }
      const body = project ?? global;
      return body ? { content: body } : { content: `No memory named "${name}".`, isError: true };
    },
  };
  const list: Tool = {
    parallelSafe: true,
    definition: { name: 'memory_list', description: 'List all memory notes with their summaries.', parameters: { type: 'object', properties: {} } },
    async execute() {
      const notes = await memory.list();
      return { content: notes.length ? notes.map((n) => `- ${n.name} (${n.scope}, ${n.chars} chars): ${n.summary}`).join('\n') : 'No memory notes yet.' };
    },
  };
  const del: Tool = {
    approvalKind: 'delete',
    definition: {
      name: 'memory_delete',
      description: 'Delete a memory note that is wrong or obsolete.',
      parameters: { type: 'object', properties: { name: { type: 'string' }, scope: { type: 'string', enum: ['project', 'global'] } }, required: ['name', 'scope'] },
    },
    async execute(args, ctx) {
      const scope = args.scope === 'global' ? 'global' : 'project';
      if (!(await ctx.requestApproval(`Delete memory "${String(args.name)}"`, `${scope} memory note`, 'delete'))) {
        return { content: 'User declined deleting the memory note.', isError: true };
      }
      const ok = await memory.delete(String(args.name), scope);
      return { content: ok ? `Deleted memory "${args.name}".` : `No memory named "${args.name}".`, isError: !ok };
    },
  };
  return [save, read, list, del];
}

export const manageTodosTool: Tool = {
  definition: {
    name: 'manage_todos',
    description:
      'Create or update the task checklist shown to the user. Call it at the start of any multi-step task with all steps as "pending", then again whenever a step starts ("in_progress") or finishes ("done"). Always send the complete list. Keep 3–10 concise, outcome-oriented items. Give items an "agent" + "prompt" so run_todos_parallel executes them as subagents; use "dependsOn" (ids) for ordering — independent items run concurrently, dependent ones wait for their prerequisites. Leave agent/prompt off only for items you must do yourself.',
    parameters: {
      type: 'object',
      properties: {
        todos: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: 'Stable id, e.g. "1", "2"' },
              title: { type: 'string' },
              status: { type: 'string', enum: ['pending', 'in_progress', 'done', 'skipped'] },
              agent: { type: 'string', description: 'Optional subagent to delegate this item to (e.g. "coder", "tester", "explore")' },
              prompt: { type: 'string', description: 'Optional self-contained brief for the subagent: goal, files/symbols, constraints, what to return' },
              dependsOn: { type: 'array', items: { type: 'string' }, description: 'Ids of items that must finish first (omit for independent items)' },
              model: { type: 'string', description: 'Optional provider/model override for the delegated item' },
              skills: { type: 'array', items: { type: 'string' }, description: 'Optional installed skill names the worker must follow for this item' },
            },
            required: ['id', 'title', 'status'],
          },
        },
      },
      required: ['todos'],
    },
  },
  async execute(args, ctx) {
    if (!ctx.todos) {
      return { content: 'Todo list is not available in this context.' };
    }
    const previous = new Map(ctx.todos.get().map((t) => [t.id, t]));
    const bad = { content: 'manage_todos needs todos: an array of {id, title, status}. The checklist was not changed.', isError: true };
    let raw: unknown = args.todos;
    if (typeof raw === 'string') {
      try {
        raw = JSON.parse(raw);
      } catch {
        return bad;
      }
    }
    if (raw === undefined && Array.isArray(args)) {
      raw = args;
    }
    if (!Array.isArray(raw)) {
      return bad;
    }
    const items = (raw as unknown[]).map((t) => (typeof t === 'string' ? { title: t } : t && typeof t === 'object' ? t : {})) as { id?: unknown; title?: unknown; status?: unknown; agent?: unknown; prompt?: unknown; model?: unknown; dependsOn?: unknown; skills?: unknown }[];
    const str = (v: unknown, max: number) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined);
    const ids = new Set(items.map((t, i) => String(t.id ?? i + 1)));
    const clean: TodoItem[] = items
      .filter((t) => typeof t.title === 'string' && t.title.trim())
      .slice(0, 20)
      .map((t, i) => {
        const id = String(t.id ?? i + 1);
        const old = previous.get(id);
        const deps = Array.isArray(t.dependsOn) ? (t.dependsOn as unknown[]).map(String).filter((d) => d !== id && ids.has(d)) : undefined;
        return {
          id,
          title: String(t.title).trim().slice(0, 160),
          status: (['pending', 'in_progress', 'done', 'skipped'].includes(String(t.status)) ? String(t.status) : 'pending') as TodoItem['status'],
          agent: str(t.agent, 40) ?? old?.agent,
          prompt: str(t.prompt, 4000) ?? old?.prompt,
          model: str(t.model, 120) ?? old?.model,
          skills: Array.isArray(t.skills) ? (t.skills as unknown[]).map(String).map((x) => x.trim()).filter(Boolean).slice(0, 5) : old?.skills,
          dependsOn: deps?.length ? [...new Set(deps)] : deps ? undefined : old?.dependsOn,
          result: old?.result,
        };
      });
    if (items.length && !clean.length) {
      return bad;
    }
    ctx.todos.set(clean);
    const done = clean.filter((t) => t.status === 'done').length;
    const delegable = clean.filter((t) => t.status === 'pending' && t.agent).length;
    return {
      content: `Todo list updated: ${done}/${clean.length} done.\n${clean.map((t) => `[${t.status === 'done' ? 'x' : t.status === 'in_progress' ? '>' : t.status === 'skipped' ? '-' : ' '}] ${t.id}. ${t.title}${t.agent ? ` → ${t.agent}` : ''}${t.dependsOn?.length ? ` (after ${t.dependsOn.join(', ')})` : ''}`).join('\n')}${delegable ? `\n${delegable} item${delegable === 1 ? '' : 's'} can run as subagents with run_todos_parallel (independent items concurrently, dependents in later waves).` : ''}`,
    };
  },
};

export function relPath(p: string): string {
  return vscode.workspace.asRelativePath(path.normalize(p));
}
