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

/**
 * Persistent agent memory as plain Markdown files the user can read and edit:
 *   project: <workspace>/.localpilot/memory/<name>.md   (commit it to share with the team)
 *   global:  <globalStorage>/memory/<name>.md           (follows the user across workspaces)
 * A compact index (name + first line) is injected into every system prompt; bodies load on demand
 * via memory_read, except small notes which are inlined.
 */
export class MemoryStore {
  private cache = new Map<string, { text: string; mtime: number }>();

  constructor(private readonly globalDir: vscode.Uri, private readonly log: vscode.LogOutputChannel) {}

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
      const uri = vscode.Uri.joinPath(dir, `${this.safeName(name)}.md`);
      try {
        const stat = await vscode.workspace.fs.stat(uri);
        return await this.readUri(uri, stat.mtime);
      } catch {
        /* try next scope */
      }
    }
    return undefined;
  }

  async write(name: string, content: string, scope: MemoryScope, mode: 'replace' | 'append' = 'replace'): Promise<string> {
    const dir = this.dir(scope);
    if (!dir) {
      throw new Error('No workspace folder open; use scope "global".');
    }
    await vscode.workspace.fs.createDirectory(dir);
    const uri = vscode.Uri.joinPath(dir, `${this.safeName(name)}.md`);
    let text = content.trim() + '\n';
    if (mode === 'append') {
      const existing = (await this.read(name, scope)) ?? '';
      text = `${existing.trimEnd()}\n\n${content.trim()}\n`;
    }
    await vscode.workspace.fs.writeFile(uri, Buffer.from(text, 'utf8'));
    this.cache.delete(uri.toString());
    this.log.info(`memory: wrote ${scope}/${this.safeName(name)} (${text.length} chars)`);
    return uri.fsPath;
  }

  async delete(name: string, scope: MemoryScope): Promise<boolean> {
    const dir = this.dir(scope);
    if (!dir) {
      return false;
    }
    try {
      await vscode.workspace.fs.delete(vscode.Uri.joinPath(dir, `${this.safeName(name)}.md`));
      return true;
    } catch {
      return false;
    }
  }

  /** Prompt section: index of all notes plus inlined bodies of small ones, within a character budget. */
  async promptSection(maxChars = 6000): Promise<string> {
    const notes = await this.list();
    if (!notes.length) {
      return '';
    }
    const lines: string[] = [];
    let used = 0;
    for (const n of notes) {
      const head = `- ${n.name} (${n.scope}): ${n.summary}`;
      lines.push(head);
      used += head.length;
    }
    const inlined: string[] = [];
    for (const n of notes) {
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
    const text = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
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
      const p = await memory.write(String(args.name), String(args.content ?? ''), scope, args.mode === 'append' ? 'append' : 'replace');
      return { content: `Saved memory "${args.name}" (${scope}) → ${vscode.workspace.asRelativePath(p)}` };
    },
  };
  const read: Tool = {
    parallelSafe: true,
    definition: {
      name: 'memory_read',
      description: 'Read the full content of a memory note by name (see the Memory index in your instructions).',
      parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
    },
    async execute(args) {
      const body = await memory.read(String(args.name));
      return body ? { content: body } : { content: `No memory named "${args.name}".`, isError: true };
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
    const items = Array.isArray(args.todos) ? (args.todos as { id?: unknown; title?: unknown; status?: unknown; agent?: unknown; prompt?: unknown; model?: unknown; dependsOn?: unknown; skills?: unknown }[]) : [];
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
