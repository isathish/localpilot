import * as vscode from 'vscode';
import * as path from 'path';
import { TodoItem, Tool } from '../types';
import { MEMORY_TYPES, normalizeType, TYPE_INFO } from '../continuity/memory/memoryTypes';

export type MemoryScope = 'project' | 'global';

/** A note file written or deleted through the store (continuity's MemoryBridge logs it). */
export type MemoryChangeListener = (note: string, scope: MemoryScope, op: 'write' | 'delete', body: string | undefined, info: { path: string; source?: 'user' | 'agent' | 'auto' }) => void;

/** A memory item of any type (1.7 continuity), as the tools and the prompt see it. */
export interface TypedMemoryItem {
  id?: string;
  type: string;
  name: string;
  summary?: string;
  body?: string;
  chars?: number;
  snippet?: string;
  pinned?: boolean;
  /** Never sent to a cloud model (CONTEXT's policy strips it). */
  localOnly?: boolean;
}

/**
 * The 1.7 memory types beyond the note files (conversation, task, knowledge, agent), provided by continuity's
 * MemoryManager once it is open. Absent (continuity off or still starting): the tools keep to project/global files.
 */
export interface TypedMemory {
  save(o: { type: string; name: string; content: string; mode: 'replace' | 'append'; sessionId?: string; source?: 'user' | 'agent' | 'auto' }): Promise<string>;
  read(name: string, o: { type?: string; sessionId?: string }): Promise<TypedMemoryItem[]>;
  list(o: { type?: string; sessionId?: string }): Promise<TypedMemoryItem[]>;
  delete(name: string, o: { type: string; sessionId?: string }): Promise<boolean>;
  search(query: string, o: { type?: string; sessionId?: string; allProjects?: boolean; limit?: number }): Promise<TypedMemoryItem[]>;
  /** The chat's items beyond the files: index lines and bodies to inline (design §7 "In the prompt"). */
  prompt(o: { sessionId?: string }): Promise<{ index: TypedMemoryItem[]; inline: TypedMemoryItem[] }>;
  /** Items of every type marked "local only" (file notes as `project` / `developer` with their file stem). */
  localOnly?(): Promise<{ type: string; name: string }[]>;
}

/** A memory block's attribute when the note must stay away from cloud models (CONTEXT's policy strips it). */
const LOCAL_ATTR = (on: boolean | undefined) => (on ? ' local-only="true"' : '');

/** The type names the tools accept (`global` = `developer`). */
const TOOL_TYPES = [...MEMORY_TYPES, 'global'];
const LOG_ONLY = (t: string) => !TYPE_INFO[t as keyof typeof TYPE_INFO]?.fileBacked;

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
  /** Fired after every write and delete of a note file (continuity's MemoryBridge; set late, when it opens). */
  onChange?: MemoryChangeListener;
  /** The 1.7 memory types (conversation, task, knowledge, agent); set by continuity when it is open. */
  typed?: TypedMemory;

  constructor(
    private readonly globalDir: vscode.Uri,
    private readonly log: vscode.LogOutputChannel,
    /** Size caps applied on every write; absent = unlimited. */
    private readonly limits?: () => { maxNoteChars: number; maxNotes: number },
    options: { onChange?: MemoryChangeListener } = {}
  ) {
    this.onChange = options.onChange;
  }

  private changed(uri: vscode.Uri, scope: MemoryScope, op: 'write' | 'delete', body?: string, source?: 'user' | 'agent' | 'auto'): void {
    try {
      this.onChange?.(path.basename(uri.fsPath ?? uri.path, '.md'), scope, op, body, { path: uri.fsPath, source });
    } catch (e) {
      this.log.warn(`memory: change listener failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** The folder of a scope (undefined: no workspace folder for project memory). */
  folder(scope: MemoryScope): string | undefined {
    return this.dir(scope)?.fsPath;
  }

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
  async write(name: string, content: string, scope: MemoryScope, mode: 'replace' | 'append' = 'replace', source?: 'user' | 'agent' | 'auto'): Promise<MemoryWriteResult> {
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
      this.changed(uri, scope, 'write', fit.text, source);
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
        this.changed(vscode.Uri.joinPath(dir, `${n.name}.md`), scope, 'delete');
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
      this.changed(uri, scope, 'delete');
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Prompt section within `maxChars`: an index of the notes (newest first) taking at most half the budget, then the
   * bodies of small notes inlined while the budget lasts. Notes that do not fit are counted, not listed, so a large
   * memory never crowds a small context window; memory_list and memory_read still reach all of them.
   * With continuity (1.7) the chat's other memory (its conversation and task notes, the agent's index) follows in
   * whatever the notes left of the same budget: the notes' part is unchanged and the total never exceeds `maxChars`.
   */
  async promptSection(maxChars = 6000, ctx: { sessionId?: string; cloud?: boolean; excluded?: { ref: string; reason: 'localOnly' | 'budget' | 'ignored' }[] } = {}): Promise<string> {
    // CONTEXT: a cloud model never gets notes marked "local only"; they are listed as excluded instead.
    const local = ctx.cloud ? await this.localOnlyKeys() : undefined;
    const all = await this.list();
    const notes = local?.size ? all.filter((n) => !local.has(`${n.scope === 'global' ? 'developer' : 'project'}:${n.name}`)) : all;
    for (const n of all) {
      if (!notes.includes(n)) {
        ctx.excluded?.push({ ref: `memory:${n.name}`, reason: 'localOnly' });
      }
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
      for (const n of notes.slice(listed.length)) {
        ctx.excluded?.push({ ref: `memory:${n.name}`, reason: 'budget' });
      }
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
    const base = notes.length ? `${lines.join('\n')}${inlined.length ? `\n\n${inlined.join('\n')}` : ''}` : '';
    const raw = this.typed ? await this.typed.prompt({ sessionId: ctx.sessionId }).catch(() => undefined) : undefined;
    const keep = (it: TypedMemoryItem) => {
      if (ctx.cloud && it.localOnly) {
        ctx.excluded?.push({ ref: `memory:${it.name}`, reason: 'localOnly' });
        return false;
      }
      return true;
    };
    const extra = raw && ctx.cloud ? { index: raw.index.filter(keep), inline: raw.inline.filter(keep) } : raw;
    if (!extra || (!extra.index.length && !extra.inline.length)) {
      return base;
    }
    // The other memory types share what the notes left of the budget: index lines first, then bodies.
    let left = maxChars - base.length - 2;
    const moreLines: string[] = [];
    for (const it of [...extra.inline, ...extra.index]) {
      const head = `- ${it.name} (${it.type}): ${(it.summary ?? '').slice(0, 160)}`;
      if (head.length + 1 > left) {
        break;
      }
      moreLines.push(head);
      left -= head.length + 1;
    }
    const moreInline: string[] = [];
    for (const it of extra.inline) {
      const body = (it.body ?? '').trim();
      const block = `<memory name="${it.name}" type="${it.type}">\n${body}\n</memory>`;
      if (!body || block.length + 1 > left) {
        continue;
      }
      moreInline.push(block);
      left -= block.length + 1;
    }
    if (!moreLines.length) {
      return base;
    }
    const allLines = [...(notes.length ? lines : []), ...moreLines];
    const allInline = [...inlined, ...moreInline];
    return `${allLines.join('\n')}${allInline.length ? `\n\n${allInline.join('\n')}` : ''}`;
  }

  private localCache?: { at: number; keys: Set<string> };
  /** `type:name` of every note marked "local only" (file notes as project / developer), cached for 5 s. */
  async localOnlyKeys(): Promise<Set<string>> {
    if (!this.typed?.localOnly) {
      return new Set();
    }
    if (this.localCache && Date.now() - this.localCache.at < 5000) {
      return this.localCache.keys;
    }
    const list = await this.typed.localOnly().catch(() => []);
    const keys = new Set(list.map((x) => `${x.type}:${x.name}`));
    this.localCache = { at: Date.now(), keys };
    return keys;
  }

  /** `#memory:<name>`: a note file (project, then global) or another memory item by name, as an attachment block. */
  async mention(name: string, sessionId?: string): Promise<string> {
    const n = name.trim();
    const local = await this.localOnlyKeys();
    for (const scope of ['project', 'global'] as MemoryScope[]) {
      const body = await this.read(n, scope);
      if (body !== undefined) {
        const type = scope === 'global' ? 'developer' : 'project';
        return `<memory_note name="${n}" type="${type}"${LOCAL_ATTR(local.has(`${type}:${n}`))}>\n${body.trim()}\n</memory_note>`;
      }
    }
    const hit = (await this.typed?.read(n, { sessionId }).catch(() => []))?.[0];
    if (hit?.body !== undefined) {
      return `<memory_note name="${hit.name}" type="${hit.type}"${LOCAL_ATTR(hit.localOnly)}>\n${hit.body.trim()}\n</memory_note>`;
    }
    return `<memory_note name="${n}" error="not found">\n(No memory named "${n}". memory_list shows the notes.)\n</memory_note>`;
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

const NO_TYPED = (t: string) => `"${t}" memory needs conversation storage (LocalPilot 1.7), which is not available in this window; use type "project" or "developer".`;

/** A note body as a tool returns it; a "local only" note is wrapped so CONTEXT's policy keeps it from cloud models. */
function wrapLocal(name: string, type: string, body: string, localOnly: boolean | undefined): string {
  return localOnly ? `<memory name="${name.replace(/"/g, '&quot;')}" type="${type}"${LOCAL_ATTR(true)}>\n${body}\n</memory>` : body;
}

/** The tool's `type` (or 1.6 `scope`): a 1.7 type, `project`/`developer` for the note files. Undefined = not given. */
function toolType(args: Record<string, unknown>): string | undefined {
  return normalizeType(args.type) ?? (args.scope === 'global' ? 'developer' : args.scope === 'project' ? 'project' : undefined);
}

export function createMemoryTools(memory: MemoryStore): Tool[] {
  const typeProp = { type: 'string', enum: TOOL_TYPES, description: 'project (default; .localpilot/memory, every chat of this project), developer (alias global: your preferences, every project), conversation (this chat only), task (the running plan or todo list; expires after it is done), knowledge (reference, read only when asked), agent (pitfalls and fixes the agent learned)' };
  const save: Tool = {
    definition: {
      name: 'memory_save',
      description:
        'Persist a durable note for future sessions: project conventions, architecture facts, decisions, user preferences, verified commands. Keep notes short and factual. Use scope "project" for repo-specific facts (shared via git) and "global" for the user\'s general preferences. With `type` you can also keep a note for this conversation only, for the running task, as reference knowledge, or as an agent lesson.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Short kebab-case topic, e.g. "build-and-test", "api-conventions", "user-preferences"' },
          content: { type: 'string', description: 'Markdown content (bullets preferred)' },
          scope: { type: 'string', enum: ['project', 'global'], description: 'Default project' },
          mode: { type: 'string', enum: ['replace', 'append'], description: 'Default replace' },
          type: typeProp,
        },
        required: ['name', 'content'],
      },
    },
    async execute(args, ctx) {
      const type = toolType(args) ?? 'project';
      const mode = args.mode === 'append' ? 'append' : 'replace';
      if (LOG_ONLY(type)) {
        if (!memory.typed) {
          return { content: NO_TYPED(type), isError: true };
        }
        try {
          return { content: await memory.typed.save({ type, name: String(args.name), content: String(args.content ?? ''), mode, sessionId: ctx.sessionId, source: 'agent' }) };
        } catch (e) {
          return { content: e instanceof Error ? e.message : String(e), isError: true };
        }
      }
      const scope = type === 'developer' ? 'global' : 'project';
      const r = await memory.write(String(args.name), String(args.content ?? ''), scope, mode, 'agent');
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
        properties: { name: { type: 'string' }, scope: { type: 'string', enum: ['project', 'global'], description: 'Default: both' }, type: { ...typeProp, description: 'Default: any type' } },
        required: ['name'],
      },
    },
    async execute(args, ctx) {
      const name = String(args.name);
      const type = toolType(args);
      if (type && LOG_ONLY(type)) {
        if (!memory.typed) {
          return { content: NO_TYPED(type), isError: true };
        }
        const hit = (await memory.typed.read(name, { type, sessionId: ctx.sessionId }))[0];
        return hit ? { content: wrapLocal(hit.name, hit.type, hit.body ?? '', hit.localOnly) } : { content: `No ${type} memory named "${name}".`, isError: true };
      }
      const local = await memory.localOnlyKeys();
      if (type) {
        const scope = type === 'developer' ? 'global' : 'project';
        const one = await memory.read(name, scope);
        return one ? { content: wrapLocal(name, type, one, local.has(`${type}:${name}`)) } : { content: `No ${scope} memory named "${name}".`, isError: true };
      }
      const project = await memory.read(name, 'project');
      const global = await memory.read(name, 'global');
      if (project !== undefined && global !== undefined) {
        return { content: `## project\n${wrapLocal(name, 'project', project.trim(), local.has(`project:${name}`))}\n\n## global\n${wrapLocal(name, 'developer', global.trim(), local.has(`developer:${name}`))}` };
      }
      const body = project ?? global;
      if (body) {
        return { content: wrapLocal(name, project !== undefined ? 'project' : 'developer', body, local.has(`${project !== undefined ? 'project' : 'developer'}:${name}`)) };
      }
      // The other memory types (conversation, task, knowledge, agent) by name.
      const other = (await memory.typed?.read(name, { sessionId: ctx.sessionId }).catch(() => [])) ?? [];
      if (other.length) {
        return { content: other.length === 1 ? wrapLocal(other[0].name, other[0].type, other[0].body ?? '', other[0].localOnly) : other.map((o) => `## ${o.type}\n${wrapLocal(o.name, o.type, (o.body ?? '').trim(), o.localOnly)}`).join('\n\n') };
      }
      return { content: `No memory named "${name}".`, isError: true };
    },
  };
  const list: Tool = {
    parallelSafe: true,
    definition: {
      name: 'memory_list',
      description: 'List all memory notes with their summaries.',
      parameters: { type: 'object', properties: { type: { ...typeProp, description: 'Only this type (default: all)' } } },
    },
    async execute(args, ctx) {
      const type = toolType(args);
      const files = !type || !LOG_ONLY(type) ? (await memory.list()).filter((n) => !type || n.scope === (type === 'developer' ? 'global' : 'project')) : [];
      const other = !type || LOG_ONLY(type) ? ((await memory.typed?.list({ type, sessionId: ctx.sessionId }).catch(() => [])) ?? []) : [];
      const out = [...files.map((n) => `- ${n.name} (${n.scope}, ${n.chars} chars): ${n.summary}`), ...other.map((n) => `- ${n.name} (${n.type}${n.chars !== undefined ? `, ${n.chars} chars` : ''}): ${n.summary ?? ''}`)];
      return { content: out.length ? out.join('\n') : 'No memory notes yet.' };
    },
  };
  const del: Tool = {
    approvalKind: 'delete',
    definition: {
      name: 'memory_delete',
      description: 'Delete a memory note that is wrong or obsolete.',
      parameters: { type: 'object', properties: { name: { type: 'string' }, scope: { type: 'string', enum: ['project', 'global'] }, type: typeProp }, required: ['name'] },
    },
    async execute(args, ctx) {
      const type = toolType(args);
      if (!type) {
        return { content: 'memory_delete needs scope ("project" or "global") or type.', isError: true };
      }
      if (!(await ctx.requestApproval(`Delete memory "${String(args.name)}"`, `${type} memory note`, 'delete'))) {
        return { content: 'User declined deleting the memory note.', isError: true };
      }
      if (LOG_ONLY(type)) {
        if (!memory.typed) {
          return { content: NO_TYPED(type), isError: true };
        }
        const ok = await memory.typed.delete(String(args.name), { type, sessionId: ctx.sessionId });
        return { content: ok ? `Moved ${type} memory "${args.name}" to Trash.` : `No ${type} memory named "${args.name}".`, isError: !ok };
      }
      const ok = await memory.delete(String(args.name), type === 'developer' ? 'global' : 'project');
      return { content: ok ? `Deleted memory "${args.name}".` : `No memory named "${args.name}".`, isError: !ok };
    },
  };
  const search: Tool = {
    parallelSafe: true,
    definition: {
      name: 'memory_search',
      description: 'Search memory (every type: project and developer notes, this chat\'s notes, task notes, knowledge, agent lessons) for words or "a phrase"; returns matching notes with a snippet. Use it before answering from general knowledge when the project may have documented the answer.',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string' }, type: { ...typeProp, description: 'Only this type (default: all)' }, all_projects: { type: 'boolean', description: 'Also notes of other projects (default: this project and your own)' } },
        required: ['query'],
      },
    },
    async execute(args, ctx) {
      const query = String(args.query ?? '').trim();
      if (!query) {
        return { content: 'memory_search needs a query.', isError: true };
      }
      const type = toolType(args);
      const strip = (s: string) => s.replace(/[\u0002\u0003]/g, '');
      if (memory.typed) {
        const hits = await memory.typed.search(query, { type, sessionId: ctx.sessionId, allProjects: args.all_projects === true, limit: 12 }).catch(() => undefined);
        if (hits) {
          return { content: hits.length ? hits.map((h) => wrapLocal(h.name, h.type, `- ${h.name} (${h.type}): ${strip(h.snippet ?? h.summary ?? '').replace(/\s+/g, ' ').slice(0, 300)}`, h.localOnly)).join('\n') + '\n\nRead one in full with memory_read.' : `No memory matches "${query}".` };
        }
      }
      // Without continuity: the note files, by words.
      const words = query.toLowerCase().replace(/["*]/g, ' ').split(/\s+/).filter((w) => w && !w.startsWith('-'));
      const out: string[] = [];
      for (const n of await memory.list()) {
        if (type && n.scope !== (type === 'developer' ? 'global' : 'project')) {
          continue;
        }
        const body = (await memory.read(n.name, n.scope)) ?? '';
        const hay = `${n.name}\n${body}`.toLowerCase();
        if (words.length && words.every((w) => hay.includes(w))) {
          const at = Math.max(0, hay.indexOf(words[0]) - 60);
          out.push(`- ${n.name} (${n.scope}): ${body.slice(at, at + 240).replace(/\s+/g, ' ')}`);
        }
      }
      return { content: out.length ? `${out.slice(0, 12).join('\n')}\n\nRead one in full with memory_read.` : `No memory matches "${query}".` };
    },
  };
  return [save, read, list, del, search];
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
