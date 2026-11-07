// `localpilot memory …` (1.7): every memory type from the terminal — list, show, add, edit, rm (to Trash), restore,
// search, move between types, local only, pin, versions — and the interactive `/memory <action>` forms. Project and
// developer notes stay files (`.localpilot/memory`, `~/.localpilot/memory`); the others live in the continuity log.
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { MemoryStore } from '../agent/memory';
import { getConfig } from '../config';
import type { Continuity } from '../continuity/continuity';
import type { MemoryItem, MemoryManager } from '../continuity/memory/memoryManager';
import { MEMORY_TYPES, normalizeType, TYPE_INFO } from '../continuity/memory/memoryTypes';
import { openCliContinuity } from './continuityCmd';
import type { Style } from './providers';
import { ageLabel } from './sessions';
import { setWorkspaceRoot } from './vscodeShim';

export const MEMORY_ACTIONS = new Set(['help', 'list', 'ls', 'show', 'add', 'edit', 'rm', 'remove', 'delete', 'restore', 'purge', 'search', 'move', 'pin', 'unpin', 'local-only', 'versions']);

export const MEMORY_USAGE = `localpilot memory list [--type t] [--all-projects] [--trash] [--json]
localpilot memory show <id|name> [--type t]
localpilot memory add --type t <name> [text|-]        (text from stdin with - or when piped)
localpilot memory edit <id|name> [text|-]             (no text: opens $EDITOR; project/developer notes are files)
localpilot memory rm <id|name> · restore <id> · purge <id>
localpilot memory search <query> [--all-projects] [--json]
localpilot memory move <id|name> <type> · pin|unpin <id|name> · local-only <id|name> on|off · versions <id|name>
Types: ${MEMORY_TYPES.join(', ')} (global = developer).`;

/** `localpilot memory <action> …` handles it (a known action); anything else is a prompt as before. */
export function wantsMemoryCommand(argv: string[]): boolean {
  return argv.length === 0 || MEMORY_ACTIONS.has(argv[0]);
}

function parse(argv: string[]): { words: string[]; flags: Map<string, string | true> } {
  const words: string[] = [];
  const flags = new Map<string, string | true>();
  const valued = new Set(['--type', '--data-dir', '--limit']);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (valued.has(a)) {
      flags.set(a, argv[++i] ?? '');
    } else if (a.startsWith('--')) {
      flags.set(a, true);
    } else {
      words.push(a);
    }
  }
  return { words, flags };
}

function line(m: MemoryItem, st: Style): string {
  const badges = [m.pinned ? 'pinned' : '', m.localOnly ? 'local only' : '', m.trashedAt ? 'in Trash' : '', m.expired ? 'expired' : m.expiresAt ? `expires ${new Date(m.expiresAt).toISOString().slice(0, 10)}` : ''].filter(Boolean);
  return `  ${st.bold(m.name)} ${st.dim(`(${m.type}) · ${m.updatedAt ? ageLabel(m.updatedAt) : ''} · ${m.id}`)}${badges.length ? ` ${st.amber(badges.join(' · '))}` : ''}${m.summary ? `\n    ${m.summary.slice(0, 160)}` : ''}`;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) {
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** The text argument: words after the first, `-` = stdin, nothing + piped stdin = stdin. */
async function textArg(words: string[]): Promise<string | undefined> {
  if (words.length === 1 && words[0] === '-') {
    return readStdin();
  }
  if (words.length) {
    return words.join(' ');
  }
  return process.stdin.isTTY ? undefined : readStdin();
}

/** Opens $VISUAL / $EDITOR on a temp copy of `text`; returns the edited text (undefined = no editor or unchanged). */
function editInEditor(text: string, name: string): string | undefined {
  const editor = process.env.VISUAL || process.env.EDITOR;
  if (!editor || !process.stdin.isTTY) {
    return undefined;
  }
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lp-memory-')), `${name.replace(/[^\w.-]+/g, '-') || 'note'}.md`);
  fs.writeFileSync(file, text, 'utf8');
  const r = spawnSync(editor, [file], { stdio: 'inherit', shell: process.platform === 'win32' });
  const out = r.status === 0 ? fs.readFileSync(file, 'utf8') : undefined;
  fs.rmSync(path.dirname(file), { recursive: true, force: true });
  return out !== undefined && out !== text ? out : undefined;
}

export interface MemoryCtx {
  c: Continuity;
  mgr: MemoryManager;
  store?: MemoryStore;
}

/** Opens continuity with this folder's and the user's memory attached (one-shot commands). */
export async function openMemoryCtx(o: { cwd: string; dataDir?: string; version?: string; log: vscode.LogOutputChannel }): Promise<MemoryCtx | string> {
  setWorkspaceRoot(o.cwd);
  const c = await openCliContinuity({ cwd: o.cwd, dataDir: o.dataDir, log: o.log, schedules: false, autoMigrate: false, version: o.version });
  if (c.degraded) {
    return `memory storage is off: ${c.degraded}`;
  }
  await c.ready;
  if (c.indexFailed) {
    await c.dispose();
    return `the memory index could not start: ${c.indexFailed}`;
  }
  if (c.migration.needed()) {
    await c.migration.run();
  }
  const store = new MemoryStore(vscode.Uri.file(path.join(os.homedir(), '.localpilot')), o.log, () => getConfig().memoryLimits);
  const d = c.attachMemoryStore(store, { projectFolders: () => [o.cwd], watch: false, taskExpiryDays: () => getConfig().memoryTaskExpiryDays, warn: (m) => o.log.warn(m) });
  // Notes written by hand (or by 1.6) since the last run are logged before anything is listed.
  await d.refreshFolders();
  await c.memory!.sync();
  return { c, mgr: c.memory!, store };
}

async function resolve(ctx: MemoryCtx, ref: string | undefined, st: Style, type?: string, includeTrash = false): Promise<MemoryItem | undefined> {
  if (!ref) {
    console.error(st.red('which note? give an id or a name — localpilot memory list shows them'));
    return undefined;
  }
  const it = await ctx.mgr.get(ref, { type, includeTrash });
  if (!it) {
    console.error(st.red(`no memory note "${ref}"${type ? ` of type ${type}` : ''} — localpilot memory list --all-projects shows them`));
  }
  return it;
}

/** Runs one `memory` action on an open context; returns the exit code. */
export async function runMemoryAction(ctx: MemoryCtx, argv: string[], st: Style): Promise<number> {
  const { words, flags } = parse(argv);
  const action = words.shift() ?? 'list';
  const json = flags.has('--json');
  const typeFlag = typeof flags.get('--type') === 'string' ? (flags.get('--type') as string) : undefined;
  const type = typeFlag ? normalizeType(typeFlag) : undefined;
  if (typeFlag && !type) {
    console.error(st.red(`unknown type "${typeFlag}" — ${MEMORY_TYPES.join(', ')}`));
    return 2;
  }
  const all = flags.has('--all-projects');
  switch (action) {
    case 'help':
      console.log(MEMORY_USAGE);
      return 0;
    case 'list':
    case 'ls': {
      const rows = await ctx.mgr.list({ type, projectId: all ? 'all' : undefined, trash: flags.has('--trash') });
      if (json) {
        console.log(JSON.stringify(rows.map(({ body, ...r }) => ({ ...r, chars: body.length })), null, 2));
        return 0;
      }
      if (!rows.length) {
        console.log(st.dim(flags.has('--trash') ? 'no memory notes in Trash' : `no ${type ? `${type} ` : ''}memory notes yet — localpilot memory add --type knowledge <name> <text>`));
        return 0;
      }
      for (const t of MEMORY_TYPES) {
        const of = rows.filter((r) => r.type === t);
        if (of.length) {
          console.log(`${st.cyan(TYPE_INFO[t].label)} ${st.dim(`(${of.length})`)}`);
          console.log(of.map((r) => line(r, st)).join('\n'));
        }
      }
      return 0;
    }
    case 'show': {
      const it = await resolve(ctx, words[0], st, type, true);
      if (!it) {
        return 1;
      }
      if (json) {
        console.log(JSON.stringify(it, null, 2));
        return 0;
      }
      console.log(line(it, st));
      if (it.path) {
        console.log(st.dim(`  file: ${it.path}`));
      }
      console.log(`\n${it.body.trimEnd()}`);
      return 0;
    }
    case 'add': {
      const name = words.shift();
      if (!name) {
        console.error(st.red('memory add needs a name: localpilot memory add --type knowledge <name> <text>'));
        return 2;
      }
      const body = await textArg(words);
      if (!body?.trim()) {
        console.error(st.red('memory add needs some text (an argument, - for stdin, or piped input)'));
        return 2;
      }
      const t = type ?? 'project';
      const id = await ctx.mgr.create(t, { name, body, source: 'user', mode: flags.has('--append') ? 'append' : 'replace' });
      console.log(`${st.green('✔')} saved ${TYPE_INFO[t].label.toLowerCase()} memory "${name}" ${st.dim(id)}`);
      return 0;
    }
    case 'edit': {
      const it = await resolve(ctx, words.shift(), st, type);
      if (!it) {
        return 1;
      }
      let body = await textArg(words);
      if (body === undefined) {
        if (it.path && !process.env.VISUAL && !process.env.EDITOR) {
          console.log(`${it.path}\n${st.dim('edit the file; LocalPilot picks the change up')}`);
          return 0;
        }
        body = editInEditor(it.body, it.name);
        if (body === undefined) {
          console.log(st.dim('unchanged (set $EDITOR, or pass the new text: localpilot memory edit <id> <text|->)'));
          return 0;
        }
      }
      await ctx.mgr.update(it.id, { body });
      console.log(`${st.green('✔')} updated "${it.name}"`);
      return 0;
    }
    case 'rm':
    case 'remove':
    case 'delete': {
      const it = await resolve(ctx, words[0], st, type);
      if (!it) {
        return 1;
      }
      await ctx.mgr.trash([it.id]);
      console.log(`${st.green('✔')} moved "${it.name}" to Trash ${st.dim(`— localpilot memory restore ${it.id}`)}`);
      return 0;
    }
    case 'restore': {
      const it = await resolve(ctx, words[0], st, type, true);
      if (!it) {
        return 1;
      }
      await ctx.mgr.restore([it.id]);
      console.log(`${st.green('✔')} restored "${it.name}"`);
      return 0;
    }
    case 'purge': {
      const it = await resolve(ctx, words[0], st, type, true);
      if (!it) {
        return 1;
      }
      await ctx.mgr.purge([it.id]);
      console.log(`${st.green('✔')} deleted "${it.name}" permanently`);
      return 0;
    }
    case 'search': {
      const q = words.join(' ').trim();
      if (!q) {
        console.error(st.red('memory search needs a query'));
        return 2;
      }
      const hits = await ctx.mgr.search(q, { projectId: all ? 'all' : undefined });
      const rows = hits.length ? await ctx.mgr.list({ projectId: 'all', limit: 2000 }) : [];
      const byId = new Map(rows.map((r) => [r.id, r]));
      const out = hits.map((h) => ({ ...h, item: byId.get(h.memoryId ?? '') })).filter((h) => h.item && (!type || h.item.type === type));
      if (json) {
        console.log(JSON.stringify(out.map((h) => ({ id: h.memoryId, name: h.item!.name, type: h.item!.type, snippet: h.snippet.replace(/[\u0002\u0003]/g, '') })), null, 2));
        return 0;
      }
      console.log(out.length ? out.map((h) => `  ${st.bold(h.item!.name)} ${st.dim(`(${h.item!.type}) · ${h.memoryId}`)}\n    ${h.snippet.replace(/\u0002/g, '').replace(/\u0003/g, '').replace(/\s+/g, ' ')}`).join('\n') : st.dim(`nothing in memory matches “${q}”`));
      return 0;
    }
    case 'move': {
      const it = await resolve(ctx, words[0], st, type);
      const to = normalizeType(words[1]);
      if (!it) {
        return 1;
      }
      if (!to) {
        console.error(st.red(`move to which type? ${MEMORY_TYPES.join(', ')}`));
        return 2;
      }
      const nid = await ctx.mgr.moveType(it.id, to);
      console.log(`${st.green('✔')} "${it.name}" is now ${TYPE_INFO[to].label.toLowerCase()} memory ${st.dim(nid)}`);
      return 0;
    }
    case 'pin':
    case 'unpin': {
      const it = await resolve(ctx, words[0], st, type);
      if (!it) {
        return 1;
      }
      await ctx.mgr.pin([it.id], action === 'pin');
      console.log(`${st.green('✔')} ${action === 'pin' ? 'pinned' : 'unpinned'} "${it.name}"`);
      return 0;
    }
    case 'local-only': {
      const it = await resolve(ctx, words[0], st, type);
      if (!it) {
        return 1;
      }
      const on = words[1] !== 'off';
      await ctx.mgr.setLocalOnly([it.id], on);
      console.log(`${st.green('✔')} "${it.name}" ${on ? 'is never sent to a cloud model' : 'can be sent to any model'}`);
      return 0;
    }
    case 'versions': {
      const it = await resolve(ctx, words[0], st, type, true);
      if (!it) {
        return 1;
      }
      const vs = await ctx.mgr.versions(it.id);
      if (json) {
        console.log(JSON.stringify(vs, null, 2));
        return 0;
      }
      console.log(vs.length ? vs.map((v) => `  ${new Date(v.at).toLocaleString()} ${st.dim(v.hlc)} ${v.op}${v.body !== undefined ? ` · ${v.body.length} chars` : ''}${v.changes.length ? ` · ${v.changes.join(', ')}` : ''}`).join('\n') : st.dim('no versions recorded'));
      return 0;
    }
    default:
      console.error(st.red(`unknown memory action "${action}"`));
      console.log(MEMORY_USAGE);
      return 2;
  }
}

/** `localpilot memory …`: opens continuity, runs the action, closes. */
export async function cmdMemory(argv: string[], st: Style, o: { cwd: string; dataDir?: string; version?: string; log: vscode.LogOutputChannel }): Promise<number> {
  if (argv[0] === 'help' || argv.includes('--help')) {
    console.log(MEMORY_USAGE);
    return 0;
  }
  const ctx = await openMemoryCtx(o);
  if (typeof ctx === 'string') {
    console.error(st.red(ctx));
    return 1;
  }
  try {
    return await runMemoryAction(ctx, argv, st);
  } finally {
    await ctx.mgr.sync().catch(() => undefined);
    await ctx.c.dispose();
  }
}

/** The interactive `/memory <action> …` (no action: the 1.6 report). Returns false when it did not handle it. */
export async function memorySlash(arg: string, o: { c?: Continuity; style: Style }): Promise<boolean> {
  const argv = arg.split(/\s+/).filter(Boolean);
  if (!argv.length || !MEMORY_ACTIONS.has(argv[0])) {
    return false;
  }
  const st = o.style;
  const mgr = o.c && !o.c.degraded ? o.c.memory : undefined;
  if (!mgr) {
    console.log(st.dim('memory storage is still starting (or off) — try again in a moment'));
    return true;
  }
  await o.c!.ready;
  await mgr.sync();
  await runMemoryAction({ c: o.c!, mgr }, argv, st);
  return true;
}
