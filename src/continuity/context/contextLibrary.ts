// Context library (CONTEXT, design §8.2): named, reusable sets of context (files, globs, snippets, memory notes,
// earlier conversations, URLs) kept as `context_item` entities (synced, versioned, in Trash when deleted). A set is
// attached to a message with `#context:<name>` (or "Attach to chat" on the Context library page); `resolve` turns it
// into one `<context_set>` block. A set marked "local only" carries `local-only="true"`, so the context policy keeps
// it away from cloud models. Pure Node (fs); no vscode.
import * as fs from 'fs';
import * as path from 'path';
import type { EventLog } from '../data/eventLog';
import type { IndexClient } from '../data/index/indexClient';
import type { Retention } from '../data/retention';
import type { ContextLibraryFields } from '../events';
import { newId } from '../ids';
import { localOnlyAttr } from './contextPolicy';

export type LibraryItem = ContextLibraryFields['items'][number];
export type LibraryKind = LibraryItem['kind'];
export const LIBRARY_KINDS: readonly LibraryKind[] = ['file', 'glob', 'snippet', 'memory', 'conversation', 'url'];

export interface ContextSet {
  id: string;
  name: string;
  description?: string;
  projectId?: string;
  items: LibraryItem[];
  localOnly: boolean;
  trashedAt?: number;
  createdAt: number;
  updatedAt: number;
  /** The HLC of the last change this process saw (an edit's `base`, for conflict detection). */
  version?: string;
}

/** Caps of a resolved set: per file, per set, files a glob may add. */
export const FILE_CAP = 24_000;
export const SET_CAP = 80_000;
export const GLOB_FILES = 40;
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'out', 'build', 'target', 'vendor', '__pycache__', '.venv', '.next']);

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

/** A set name as written after `#context:` (letters, digits, `-`, `_`, `.`). */
export function slugName(name: string): string {
  return name.trim().toLowerCase().replace(/[^\p{L}\p{N}_.-]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 60);
}

/** `src/**\/*.ts` -> a RegExp over POSIX relative paths. */
export function globRegExp(glob: string): RegExp {
  let re = '';
  const g = glob.replace(/\\/g, '/').replace(/^\.\//, '');
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*') {
      if (g[i + 1] === '*') {
        re += g[i + 2] === '/' ? '(?:.*/)?' : '.*';
        i += g[i + 2] === '/' ? 2 : 1;
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else if (c === '{') {
      const end = g.indexOf('}', i);
      if (end > i) {
        re += `(?:${g.slice(i + 1, end).split(',').map((x) => x.replace(/[.+^$()|[\]\\]/g, '\\$&')).join('|')})`;
        i = end;
      } else {
        re += '\\{';
      }
    } else {
      re += c.replace(/[.+^$()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${re}$`);
}

/** Files under `root` matching a glob (POSIX relative paths, bounded walk). */
export function expandGlob(root: string, glob: string, max = GLOB_FILES): string[] {
  const re = globRegExp(glob);
  const out: string[] = [];
  let budget = 20_000;
  const walk = (dir: string, rel: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      if (out.length >= max || --budget < 0) {
        return;
      }
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) {
          walk(path.join(dir, e.name), r);
        }
      } else if (e.isFile() && re.test(r)) {
        out.push(r);
      }
    }
  };
  walk(root, '');
  return out;
}

/** Normalises user-given items (trimmed refs, known kinds, no empties). */
export function cleanItems(items: unknown): LibraryItem[] {
  if (!Array.isArray(items)) {
    return [];
  }
  const out: LibraryItem[] = [];
  for (const x of items as Partial<LibraryItem>[]) {
    const kind = LIBRARY_KINDS.includes(x?.kind as LibraryKind) ? (x!.kind as LibraryKind) : undefined;
    const ref = String(x?.ref ?? '').trim();
    const text = typeof x?.text === 'string' ? x.text : undefined;
    if (!kind || (!ref && !(kind === 'snippet' && text?.trim()))) {
      continue;
    }
    out.push({ kind, ref: ref || 'snippet', ...(kind === 'snippet' && text ? { text } : {}) });
  }
  return out.slice(0, 200);
}

function rowToSet(r: Record<string, unknown>): ContextSet {
  let fields: Partial<ContextLibraryFields> = {};
  let version: string | undefined;
  try {
    const st = JSON.parse(String(r.state ?? '{}')) as { fields?: ContextLibraryFields; version?: string };
    fields = st.fields ?? {};
    version = st.version;
  } catch {
    // keep the row's columns
  }
  let items: LibraryItem[] = [];
  try {
    items = JSON.parse(String(r.items ?? '[]')) as LibraryItem[];
  } catch {
    items = fields.items ?? [];
  }
  return {
    id: String(r.id),
    name: String(r.name ?? fields.name ?? ''),
    ...(r.description ? { description: String(r.description) } : {}),
    ...(r.project_id ? { projectId: String(r.project_id) } : {}),
    items,
    localOnly: !!fields.localOnly,
    ...(typeof r.trashed_at === 'number' ? { trashedAt: r.trashed_at } : {}),
    createdAt: Number(r.created_at ?? 0),
    updatedAt: Number(r.updated_at ?? 0),
    ...(version ? { version } : {}),
  };
}

export interface ResolveDeps {
  /** Folder relative file and glob items are read from. */
  root?: string;
  /** `memory` items: the note's block (MemoryStore.mention: already marks local-only notes). */
  memory?: (name: string) => Promise<string>;
  /** `conversation` items: a summary block of an earlier chat (relatedContext.chatBlock). */
  chat?: (ref: string) => Promise<string>;
}

export class ContextLibrary {
  private readonly now: () => number;
  constructor(private readonly o: { log: EventLog; index: IndexClient; retention: Retention; sync: () => Promise<void>; now?: () => number; onChange?: () => void }) {
    this.now = o.now ?? Date.now;
  }

  async list(o: { projectId?: string; trash?: 'only' | 'include' } = {}): Promise<ContextSet[]> {
    const rows = await this.o.index.query<Record<string, unknown>>('contextLibrary', { ...(o.projectId ? { projectId: o.projectId } : {}), ...(o.trash ? { trash: o.trash } : {}) });
    return rows.map(rowToSet);
  }

  async get(id: string): Promise<ContextSet | undefined> {
    const r = (await this.o.index.query<Record<string, unknown>>('contextLibrary', { id, trash: 'include' }))[0];
    return r ? rowToSet(r) : undefined;
  }

  /** A set by name (or its `#context:` slug), this project's before the user's; trashed sets are not found. */
  async byName(name: string, projectId?: string): Promise<ContextSet | undefined> {
    const want = slugName(name);
    const sets = (await this.list({ projectId })).filter((s) => s.name.toLowerCase() === name.trim().toLowerCase() || slugName(s.name) === want);
    return sets.find((s) => s.projectId && s.projectId === projectId) ?? sets[0];
  }

  async create(f: { name: string; description?: string; projectId?: string; items: unknown; localOnly?: boolean }): Promise<string> {
    const name = f.name.trim().slice(0, 80);
    if (!name) {
      throw new Error('Give the context set a name.');
    }
    if (await this.byName(name, f.projectId)) {
      throw new Error(`A context set named "${name}" exists already.`);
    }
    const id = newId('cxl', this.now());
    const fields: ContextLibraryFields = { name, ...(f.description?.trim() ? { description: f.description.trim() } : {}), ...(f.projectId ? { projectId: f.projectId } : {}), items: cleanItems(f.items), createdAt: this.now(), ...(f.localOnly ? { localOnly: true } : {}) };
    this.o.log.append('context_item', id, 'create', fields, { durable: true });
    await this.done();
    return id;
  }

  async update(id: string, f: { name?: string; description?: string; items?: unknown; localOnly?: boolean; projectId?: string | null }): Promise<void> {
    const cur = await this.get(id);
    if (!cur) {
      throw new Error('That context set is gone.');
    }
    const patch: Record<string, unknown> = {};
    if (f.name !== undefined && f.name.trim() && f.name.trim() !== cur.name) {
      const other = await this.byName(f.name, cur.projectId);
      if (other && other.id !== id) {
        throw new Error(`A context set named "${f.name.trim()}" exists already.`);
      }
      patch.name = f.name.trim().slice(0, 80);
    }
    if (f.description !== undefined && f.description.trim() !== (cur.description ?? '')) {
      patch.description = f.description.trim();
    }
    if (f.items !== undefined) {
      const items = cleanItems(f.items);
      if (JSON.stringify(items) !== JSON.stringify(cur.items)) {
        patch.items = items;
      }
    }
    if (f.localOnly !== undefined && f.localOnly !== cur.localOnly) {
      patch.localOnly = f.localOnly;
    }
    if (f.projectId !== undefined && (f.projectId ?? undefined) !== cur.projectId) {
      patch.projectId = f.projectId ?? null;
    }
    if (Object.keys(patch).length) {
      // `base` = the version this edit saw: a concurrent edit of `items` from another device becomes a conflict (§9.4).
      this.o.log.append('context_item', id, 'patch', patch, { durable: true, ...(cur.version ? { base: cur.version } : {}) });
      await this.done();
    }
  }

  async trash(ids: string[]): Promise<number> {
    let n = 0;
    for (const id of ids) {
      const s = await this.get(id);
      if (s && !s.trashedAt) {
        this.o.log.append('context_item', id, 'trash', { at: this.now(), reason: 'user' }, { durable: true });
        n++;
      }
    }
    await this.done();
    return n;
  }

  async restore(ids: string[]): Promise<number> {
    let n = 0;
    for (const id of ids) {
      const s = await this.get(id);
      if (s?.trashedAt) {
        this.o.log.append('context_item', id, 'restore', { at: this.now() }, { durable: true });
        n++;
      }
    }
    await this.done();
    return n;
  }

  async purge(ids: string[]): Promise<number> {
    const n = await this.o.retention.purge(ids.map((id) => ({ ent: 'context_item' as const, id })), 'user');
    await this.done();
    return n;
  }

  private async done(): Promise<void> {
    await this.o.sync();
    this.o.onChange?.();
  }

  /**
   * `#context:<name>`: the set as one block. Files and globs are read from `root` (capped per file and per set),
   * memory and conversation items through their resolvers, snippets inline, URLs as references (not fetched).
   */
  async resolve(name: string, d: ResolveDeps & { projectId?: string }): Promise<string> {
    const set = await this.byName(name, d.projectId);
    if (!set) {
      return `<context_set name="${esc(name)}" error="not found">\n(No context set named "${name}". The Context library lists them.)\n</context_set>`;
    }
    return this.render(set, d);
  }

  async render(set: ContextSet, d: ResolveDeps): Promise<string> {
    let left = SET_CAP;
    const parts: string[] = [];
    const push = (s: string) => {
      if (left <= 0) {
        return;
      }
      const t = s.length > left ? `${s.slice(0, left)}\n…(set truncated)` : s;
      parts.push(t);
      left -= t.length;
    };
    const readFile = (rel: string) => {
      const abs = d.root && !path.isAbsolute(rel) ? path.join(d.root, rel) : rel;
      try {
        const st = fs.statSync(abs);
        if (!st.isFile()) {
          return `<file path="${esc(rel)}" error="not a file"></file>`;
        }
        const buf = fs.readFileSync(abs);
        if (buf.subarray(0, 8000).includes(0)) {
          return `<file path="${esc(rel)}" error="binary file"></file>`;
        }
        const text = buf.toString('utf8');
        return `<file path="${esc(rel)}">\n${text.length > FILE_CAP ? `${text.slice(0, FILE_CAP)}\n…(truncated)` : text}\n</file>`;
      } catch {
        return `<file path="${esc(rel)}" error="not found"></file>`;
      }
    };
    for (const it of set.items) {
      switch (it.kind) {
        case 'file':
          push(readFile(it.ref));
          break;
        case 'glob': {
          const files = d.root ? expandGlob(d.root, it.ref) : [];
          if (!files.length) {
            push(`<file path="${esc(it.ref)}" error="no files match"></file>`);
          }
          for (const f of files) {
            push(readFile(f));
          }
          break;
        }
        case 'snippet':
          push(`<snippet name="${esc(it.ref)}">\n${it.text ?? ''}\n</snippet>`);
          break;
        case 'memory':
          push(d.memory ? await d.memory(it.ref).catch(() => `<memory_note name="${esc(it.ref)}" error="not found"></memory_note>`) : `<memory_note name="${esc(it.ref)}" error="memory unavailable"></memory_note>`);
          break;
        case 'conversation':
          push(d.chat ? await d.chat(it.ref).catch(() => `<chat_ref id="${esc(it.ref)}" error="not found"></chat_ref>`) : `<chat_ref id="${esc(it.ref)}" error="unavailable"></chat_ref>`);
          break;
        case 'url':
          push(`<url href="${esc(it.ref)}">(A reference the user keeps with this set; not fetched. Use web_fetch if its content is needed.)</url>`);
          break;
      }
    }
    return `<context_set name="${esc(set.name)}"${set.description ? ` description="${esc(set.description)}"` : ''}${localOnlyAttr(set.localOnly)}>\n${parts.join('\n')}\n</context_set>`;
  }
}
