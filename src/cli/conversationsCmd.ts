// `localpilot history …` on the conversation log (1.7): every project's conversations, Trash and Archived, search
// with inline filters, flags and tags, versions and branches, duplicate and merge, export (JSON, Markdown, HTML, PDF
// page), import, and secure share. The 1.6 forms (`history`, `history delete|export <id>`) keep working on this
// folder's chat files. Also the interactive `/history search`, `/trash` and `/branch` commands.
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { Continuity } from '../continuity/continuity';
import type { ConversationManager } from '../continuity/conversation/conversationManager';
import { exportFileName, ExportFormat } from '../continuity/conversation/export';
import { createShare, findSecrets, formatCode, openShare, redactSecrets, WrongShareCodeError } from '../continuity/conversation/share';
import type { ConversationRow, NavView } from '../continuity/data/index/queries';
import type { SessionStore } from '../sessions/sessionStore';
import { openCliContinuity } from './continuityCmd';
import { printRuns } from './sessionsCmd';
import type { Style } from './providers';
import { ageLabel, openCliStore } from './sessions';

export const CONVERSATION_ACTIONS = new Set(['help', 'search', 'show', 'import', 'pin', 'unpin', 'favorite', 'unfavorite', 'archive', 'unarchive', 'trash', 'restore', 'purge', 'tag', 'rename', 'versions', 'branches', 'duplicate', 'merge', 'share', 'open-share', 'empty-trash']);

export const HISTORY_USAGE = `localpilot history [list] [--view all|pinned|favorites|archived|trash] [--tag t] [--all-projects] [--json]
localpilot history search <query> [--in code,errors,…] [--all-projects] [--json]   (inline filters: in: from: project: tag: model: is: before: after:)
localpilot history show <id> [--branch b]       print a conversation
localpilot history show --runs <id> [--json]    its agent runs: outcome, model, tokens, what ran, files changed
localpilot history export <id…> --format json|md|html|pdf [-o file|folder]
localpilot history import <file.json|file.lpshare|claude|codex> [--code CODE]
localpilot history pin|unpin|favorite|unfavorite|archive|unarchive|trash|restore|purge <id…>
localpilot history tag <id> +a -b · rename <id> <title> · versions <id> · branches <id>
localpilot history duplicate <id> [--from <messageId>] · merge <id> <id>
localpilot history share <id> [-o file] [--redact|--keep] · open-share <file> [--code CODE]
localpilot history empty-trash`;

/** Whether `localpilot history …` needs the conversation log (new actions or flags) rather than the 1.6 chat files. */
export function wantsConversationLog(argv: string[]): boolean {
  const action = argv.find((a) => !a.startsWith('-'));
  return (!!action && CONVERSATION_ACTIONS.has(action)) || argv.some((a) => ['--view', '--tag', '--all-projects', '--format'].includes(a)) || (action === 'export' && argv.includes('--format'));
}

interface Parsed {
  words: string[];
  flags: Map<string, string | true>;
}

function parse(argv: string[]): Parsed {
  const words: string[] = [];
  const flags = new Map<string, string | true>();
  const valued = new Set(['--view', '--tag', '--in', '--format', '-o', '--output', '--branch', '--from', '--code', '--limit', '--data-dir']);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (valued.has(a)) {
      flags.set(a === '--output' ? '-o' : a, argv[++i] ?? '');
    } else if (a.startsWith('--') || a === '-o') {
      flags.set(a, true);
    } else {
      words.push(a);
    }
  }
  return { words, flags };
}

const FORMATS: Record<string, ExportFormat> = { json: 'json', md: 'markdown', markdown: 'markdown', html: 'html', pdf: 'pdf' };

function rowLine(r: ConversationRow, st: Style, i?: number): string {
  const badges = [r.pinned ? 'pinned' : '', r.favorite ? '★' : '', r.archived ? 'archived' : '', r.trashedAt ? 'in Trash' : '', r.origin === 'cli' ? 'CLI' : '', r.branchCount > 1 ? `${r.branchCount} branches` : '', ...r.tags.map((t) => `#${t}`)].filter(Boolean);
  return `${i !== undefined ? `  ${st.amber(String(i + 1).padStart(3))}. ` : '  '}${st.bold(r.title || 'New chat')}  ${st.dim(`${r.projectName ? `${r.projectName} · ` : ''}${ageLabel(r.updatedAt)} · ${r.messageCount} message${r.messageCount === 1 ? '' : 's'} · ${r.id}`)}${badges.length ? ` ${st.dim(badges.join(' '))}` : ''}`;
}

const stripMarks = (s: string) => s.replace(/\u0002/g, '').replace(/\u0003/g, '');

export interface ConvCtx {
  c: Continuity;
  mgr: ConversationManager;
  store: SessionStore;
  project?: string;
}

/** Resolves an id, a unique id prefix, or a list number (from the last list order). */
async function resolveIds(ctx: ConvCtx, refs: string[], st: Style): Promise<string[] | undefined> {
  const all = await ctx.c.index.query<string>('conversationIds', {});
  const out: string[] = [];
  for (const ref of refs) {
    const exact = all.find((id) => id === ref);
    const pre = exact ? [exact] : all.filter((id) => id.startsWith(ref));
    if (pre.length !== 1) {
      console.error(st.red(pre.length ? `"${ref}" matches ${pre.length} conversations: ${pre.slice(0, 5).join(', ')}` : `no conversation "${ref}" — localpilot history --all-projects lists them`));
      return undefined;
    }
    out.push(pre[0]);
  }
  return out;
}

/** Opens continuity and the folder's chat store for a one-shot `history` command; runs the 1.6 import first if due. */
export async function openConversationCtx(o: { cwd: string; dataDir?: string; version?: string; log: vscode.LogOutputChannel }): Promise<ConvCtx | string> {
  const c = await openCliContinuity({ cwd: o.cwd, dataDir: o.dataDir, log: o.log, schedules: false, autoMigrate: false, version: o.version });
  if (c.degraded) {
    return `conversation storage is off: ${c.degraded}`;
  }
  await c.ready;
  if (c.indexFailed) {
    await c.dispose();
    return `the conversation index could not start: ${c.indexFailed}`;
  }
  if (c.migration.needed()) {
    await c.migration.run();
  }
  const store = await openCliStore(o.cwd, o.dataDir, o.log);
  c.attachSessionStore(store, { defaultFolder: () => o.cwd });
  await c.index.catchUp();
  // Chats saved by runs that ended before their log was written.
  await c.bridge!.reconcile(store.list(), (id) => (store.has(id) ? store.get(id) : undefined));
  const project = (await c.projects!.resolve(o.cwd).catch(() => undefined))?.id;
  await c.log.flush();
  await c.index.catchUp();
  return { c, mgr: c.conversations!, store, project };
}

export async function closeConversationCtx(ctx: ConvCtx): Promise<void> {
  await ctx.c.bridge?.settle();
  ctx.store.dispose();
  await ctx.c.dispose();
}

async function readCode(flag: string | true | undefined, ask?: (q: string) => Promise<string | undefined>): Promise<string | undefined> {
  if (typeof flag === 'string' && flag) {
    return flag;
  }
  if (process.env.LOCALPILOT_SHARE_CODE) {
    return process.env.LOCALPILOT_SHARE_CODE;
  }
  return ask ? (await ask('Share code: '))?.trim() : undefined;
}

/** `localpilot history <action> …` on the conversation log. Returns the exit code. */
export async function cmdConversations(argv: string[], st: Style, o: { cwd: string; dataDir?: string; version?: string; log: vscode.LogOutputChannel; ask?: (q: string) => Promise<string | undefined> }): Promise<number> {
  const { words, flags } = parse(argv);
  if (flags.has('--help') || words[0] === 'help') {
    console.log(HISTORY_USAGE);
    return 0;
  }
  const opened = await openConversationCtx(o);
  if (typeof opened === 'string') {
    console.error(st.red(opened));
    return 1;
  }
  const ctx = opened;
  try {
    return await run(ctx, words, flags, st, o);
  } finally {
    await closeConversationCtx(ctx);
  }
}

async function run(ctx: ConvCtx, words: string[], flags: Map<string, string | true>, st: Style, o: { cwd: string; ask?: (q: string) => Promise<string | undefined> }): Promise<number> {
  const { mgr } = ctx;
  const json = flags.has('--json');
  const [action = 'list', ...rest] = words;
  const scope = flags.has('--all-projects') ? 'all' : (ctx.project ?? 'all');
  switch (action) {
    case 'list':
    case 'ls': {
      const view = String(flags.get('--view') ?? 'all') as NavView;
      if (!['all', 'pinned', 'favorites', 'archived', 'trash'].includes(view)) {
        console.error(st.red('--view takes all, pinned, favorites, archived or trash'));
        return 2;
      }
      const tag = typeof flags.get('--tag') === 'string' ? String(flags.get('--tag')) : undefined;
      const page = await mgr.list({ view, projectId: scope, tag, limit: Math.max(1, Number(flags.get('--limit')) || 50) });
      if (json) {
        process.stdout.write(`${JSON.stringify(page.rows, null, 2)}\n`);
        return 0;
      }
      const counts = await mgr.counts(scope === 'all' ? undefined : scope);
      console.log(st.dim(`${scope === 'all' ? 'All projects' : 'This project'} · All ${counts.all} · Pinned ${counts.pinned} · Favorites ${counts.favorites} · Archived ${counts.archived} · Trash ${counts.trash}`));
      if (!page.rows.length) {
        console.log(st.dim(view === 'trash' ? 'Trash is empty.' : 'No conversations here. --all-projects shows every project.'));
        return 0;
      }
      console.log(page.rows.map((r, i) => rowLine(r, st, i)).join('\n'));
      if (page.total > page.rows.length) {
        console.log(st.dim(`${page.rows.length} of ${page.total} shown (--limit).`));
      }
      return 0;
    }
    case 'search': {
      const q = rest.join(' ').trim();
      if (!q) {
        console.error(st.red('usage: localpilot history search <query>'));
        return 2;
      }
      const inFlag = typeof flags.get('--in') === 'string' ? String(flags.get('--in')).split(',').map((x) => x.trim()) : undefined;
      const hits = await mgr.search({ text: q, projectId: scope, ...(inFlag ? { in: inFlag as never } : {}), limit: 50 });
      if (json) {
        process.stdout.write(`${JSON.stringify(hits.map((h) => ({ ...h, snippet: stripMarks(h.snippet) })), null, 2)}\n`);
        return 0;
      }
      if (!hits.length) {
        console.log(st.dim(`Nothing matches “${q}”${scope === 'all' ? '' : ' in this project (--all-projects searches every project)'}.`));
        return 0;
      }
      for (const h of hits) {
        const snip = h.snippet.replace(/\u0002/g, '\x1b[1m').replace(/\u0003/g, '\x1b[22m').replace(/\s+/g, ' ');
        console.log(`  ${st.bold(h.title ?? h.conversationId)} ${st.dim(`· ${h.field} · ${ageLabel(h.at)} · ${h.conversationId}`)}\n    ${snip}`);
      }
      return 0;
    }
    case 'show': {
      const ids = await resolveIds(ctx, rest.slice(0, 1), st);
      if (!ids) {
        return 2;
      }
      if (flags.has('--runs')) {
        // SESSION: the conversation's agent runs, newest first, with what each did.
        const sessions = ctx.c.attachSessions();
        if (!sessions) {
          console.error(st.red('runs are not available'));
          return 1;
        }
        await sessions.recoverInterrupted();
        const runs = await sessions.runs(ids[0]);
        if (!runs.length && !json) {
          console.log(st.dim('No agent runs recorded for this conversation (runs are recorded from LocalPilot 1.7 on; earlier ones come from their run traces).'));
          return 0;
        }
        await printRuns(sessions, runs, st, { json });
        return 0;
      }
      const branch = typeof flags.get('--branch') === 'string' ? String(flags.get('--branch')) : undefined;
      const m = await mgr.materialize(ids[0], branch);
      if (!m) {
        console.error(st.red('not found'));
        return 2;
      }
      if (json) {
        process.stdout.write(`${JSON.stringify(m.session, null, 2)}\n`);
        return 0;
      }
      console.log(rowLine(m.row, st));
      for (const msg of m.session.messages) {
        if (msg.meta?.hidden || msg.role === 'tool' || msg.meta?.toolResults) {
          continue;
        }
        const who = msg.meta?.summary ? st.dim('summary') : msg.role === 'user' ? st.amber('you') : st.green('agent');
        console.log(`\n${who}${msg.meta?.id ? st.dim(` ${msg.meta.id}`) : ''}\n${(msg.meta?.display ?? msg.content).trim()}`);
      }
      return 0;
    }
    case 'export': {
      const fmt = FORMATS[String(flags.get('--format') ?? 'md')];
      if (!fmt) {
        console.error(st.red('--format takes json, md, html or pdf'));
        return 2;
      }
      const ids = await resolveIds(ctx, rest, st);
      if (!ids?.length) {
        return 2;
      }
      const target = typeof flags.get('-o') === 'string' ? path.resolve(o.cwd, String(flags.get('-o'))) : undefined;
      const taken = new Set<string>();
      for (const id of ids) {
        const out = await mgr.exportText(id, fmt);
        if (!out) {
          continue;
        }
        if (!target && ids.length === 1 && fmt !== 'pdf') {
          process.stdout.write(out.text.endsWith('\n') ? out.text : `${out.text}\n`);
          continue;
        }
        const dir = target && (ids.length > 1 || (fs.existsSync(target) && fs.statSync(target).isDirectory())) ? target : undefined;
        const file = dir ? path.join(dir, exportFileName(out.title, out.ext, taken)) : (target ?? path.resolve(o.cwd, exportFileName(out.title, out.ext, taken)));
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, out.text);
        console.log(`${st.green('✔')} ${out.title} → ${file}`);
      }
      if (fmt === 'pdf') {
        console.log(st.dim('Open the page in a browser and Print → Save as PDF.'));
      }
      return 0;
    }
    case 'import': {
      const file = rest[0];
      if (!file) {
        console.error(st.red('usage: localpilot history import <file.json|file.lpshare>'));
        return 2;
      }
      const data = fs.readFileSync(path.resolve(o.cwd, file));
      try {
        const s = file.endsWith('.lpshare') ? mgr.importDoc(openShare(data, (await readCode(flags.get('--code'), o.ask)) ?? ''), 'share') : mgr.importText(data.toString('utf8'));
        await ctx.store.flush(s);
        await ctx.c.bridge?.settle();
        console.log(`${st.green('✔')} Imported “${s.title}” ${st.dim(`(${s.id}) — resume with: localpilot -r ${s.id}`)}`);
        return 0;
      } catch (e) {
        console.error(st.red(e instanceof WrongShareCodeError ? e.message : `could not import: ${e instanceof Error ? e.message : String(e)}`));
        return 1;
      }
    }
    case 'pin':
    case 'unpin':
    case 'favorite':
    case 'unfavorite':
    case 'archive':
    case 'unarchive':
    case 'trash':
    case 'restore':
    case 'purge': {
      const ids = await resolveIds(ctx, rest, st);
      if (!ids?.length) {
        return 2;
      }
      if (action === 'trash') {
        await mgr.trash(ids);
      } else if (action === 'restore') {
        await mgr.restore(ids, { into: (r) => !!ctx.project && r.projectId === ctx.project });
      } else if (action === 'purge') {
        if (!flags.has('--yes') && o.ask) {
          const a = (await o.ask(`Delete ${ids.length} conversation(s) permanently? [y/N] `))?.trim().toLowerCase();
          if (a !== 'y' && a !== 'yes') {
            return 1;
          }
        }
        await mgr.purge(ids);
      } else {
        const on = !action.startsWith('un');
        const key = action.replace(/^un/, '') as 'pin' | 'favorite' | 'archive';
        await mgr.setFlags(ids, key === 'pin' ? { pinned: on } : key === 'favorite' ? { favorite: on } : { archived: on });
      }
      const verb: Record<string, string> = { pin: 'Pinned', unpin: 'Unpinned', favorite: 'Added to Favorites', unfavorite: 'Removed from Favorites', archive: 'Archived', unarchive: 'Unarchived', trash: 'Moved to Trash', restore: 'Restored', purge: 'Deleted permanently' };
      console.log(`${st.green('✔')} ${verb[action]}: ${ids.join(', ')}${action === 'trash' ? st.dim(' — undo with: localpilot history restore <id>') : ''}`);
      return 0;
    }
    case 'empty-trash': {
      const n = await ctx.c.data.emptyTrash();
      console.log(`${st.green('✔')} ${n ? `Deleted ${n} item(s) permanently` : 'Trash is already empty'}`);
      return 0;
    }
    case 'tag': {
      const ids = await resolveIds(ctx, rest.slice(0, 1), st);
      if (!ids) {
        return 2;
      }
      const add = rest.slice(1).filter((t) => !t.startsWith('-')).map((t) => t.replace(/^\+/, ''));
      const remove = rest.slice(1).filter((t) => t.startsWith('-')).map((t) => t.slice(1));
      await mgr.setTags(ids, add, remove);
      console.log(`${st.green('✔')} Tags: ${(await mgr.conversation(ids[0]))?.tags.map((t) => `#${t}`).join(' ') || 'none'}`);
      return 0;
    }
    case 'rename': {
      const ids = await resolveIds(ctx, rest.slice(0, 1), st);
      const title = rest.slice(1).join(' ').trim();
      if (!ids || !title) {
        console.error(st.red('usage: localpilot history rename <id> <title>'));
        return 2;
      }
      await mgr.rename(ids[0], title);
      console.log(`${st.green('✔')} Renamed to “${title}”`);
      return 0;
    }
    case 'versions': {
      const ids = await resolveIds(ctx, rest.slice(0, 1), st);
      if (!ids) {
        return 2;
      }
      const v = await mgr.versions(ids[0]);
      if (json) {
        process.stdout.write(`${JSON.stringify(v, null, 2)}\n`);
        return 0;
      }
      for (const r of v.versions) {
        const f = r.fields ?? {};
        const what = r.op === 'patch' ? Object.keys(f).filter((k) => k !== 'updatedAt').join(', ') : r.op;
        console.log(`  ${st.dim(new Date(r.at).toLocaleString())}  ${what || 'activity'}${typeof f.title === 'string' ? ` → “${f.title}”` : ''}  ${st.dim(r.hlc)}`);
      }
      console.log(st.dim(`${v.branches.length} branch(es) — localpilot history branches ${ids[0]}`));
      return 0;
    }
    case 'branches': {
      const ids = await resolveIds(ctx, rest.slice(0, 1), st);
      if (!ids) {
        return 2;
      }
      const b = await mgr.branches(ids[0]);
      if (json) {
        process.stdout.write(`${JSON.stringify(b, null, 2)}\n`);
        return 0;
      }
      for (const x of b.branches) {
        console.log(`  ${x.id === b.active ? st.green('●') : ' '} ${x.label ?? (x.reason ? `${x.reason} branch` : 'main')} ${st.dim(`· ${new Date(x.createdAt).toLocaleString()} · ${x.id}`)}`);
      }
      return 0;
    }
    case 'duplicate': {
      const ids = await resolveIds(ctx, rest.slice(0, 1), st);
      if (!ids) {
        return 2;
      }
      const from = typeof flags.get('--from') === 'string' ? String(flags.get('--from')) : undefined;
      const s = await mgr.duplicate(ids[0], from);
      if (!s) {
        return 1;
      }
      await ctx.store.flush(s);
      await ctx.c.bridge?.settle();
      console.log(`${st.green('✔')} Duplicated as “${s.title}” ${st.dim(`(${s.id})`)}`);
      return 0;
    }
    case 'merge': {
      const ids = await resolveIds(ctx, rest.slice(0, 2), st);
      if (!ids || ids.length < 2) {
        console.error(st.red('usage: localpilot history merge <id> <id>'));
        return 2;
      }
      const s = await mgr.merge(ids[0], ids[1]);
      if (!s) {
        return 1;
      }
      console.log(`${st.green('✔')} Merged into “${s.title}” ${st.dim(`(${s.id}) — resume with: localpilot -r ${s.id}`)}`);
      return 0;
    }
    case 'share': {
      const ids = await resolveIds(ctx, rest.slice(0, 1), st);
      if (!ids) {
        return 2;
      }
      const m = ctx.store.has(ids[0]) ? ctx.store.get(ids[0]) : (await mgr.materialize(ids[0]))?.session;
      if (!m) {
        return 1;
      }
      let session = m;
      const secrets = findSecrets(m);
      if (secrets.length) {
        let redact = flags.has('--redact');
        if (!redact && !flags.has('--keep')) {
          if (!o.ask) {
            console.error(st.red(`${secrets.length} secret(s) found — pass --redact or --keep`));
            return 2;
          }
          redact = !/^k/i.test((await o.ask(`${secrets.length} secret(s) found (${secrets[0].title}). Redact them in the shared copy? [R]edact / [k]eep `))?.trim() ?? '');
        }
        if (redact) {
          session = redactSecrets(m).session;
        }
      }
      const { data, code } = createShare(session);
      const file = typeof flags.get('-o') === 'string' ? path.resolve(o.cwd, String(flags.get('-o'))) : path.resolve(o.cwd, exportFileName(m.title, 'lpshare'));
      fs.writeFileSync(file, data);
      console.log(`${st.green('✔')} ${file}\n  Share code (shown once): ${st.bold(formatCode(code))}\n  ${st.dim('Send the file and the code separately; open with: localpilot history open-share <file>')}`);
      return 0;
    }
    case 'open-share': {
      const file = rest[0];
      if (!file) {
        console.error(st.red('usage: localpilot history open-share <file.lpshare> [--code CODE]'));
        return 2;
      }
      const code = await readCode(flags.get('--code'), o.ask);
      if (!code) {
        console.error(st.red('the share code is needed (--code, LOCALPILOT_SHARE_CODE, or the prompt)'));
        return 2;
      }
      try {
        const s = mgr.importDoc(openShare(fs.readFileSync(path.resolve(o.cwd, file)), code), 'share');
        await ctx.store.flush(s);
        await ctx.c.bridge?.settle();
        await new Promise((r) => setTimeout(r, 20));
        console.log(`${st.green('✔')} Opened “${s.title}” ${st.dim(`(${s.id}) — resume with: localpilot -r ${s.id}`)}`);
        return 0;
      } catch (e) {
        console.error(st.red(e instanceof Error ? e.message : String(e)));
        return 1;
      }
    }
    default:
      console.error(st.red(`unknown history action "${action}"\n${HISTORY_USAGE}`));
      return 2;
  }
}

/** Interactive `/history search <q>`, `/trash [restore <id>]`, `/branch [list|switch <n>|from <messageId>]`. */
export async function conversationSlash(cmd: 'history-search' | 'trash' | 'branch', arg: string, o: { c?: Continuity; sessionId: () => string; switchTo?: (id: string) => Promise<void> | void; style: Style; reload?: (id: string) => void }): Promise<boolean> {
  const st = o.style;
  const mgr = o.c && !o.c.degraded ? o.c.conversations : undefined;
  if (!mgr) {
    console.log(st.dim('conversation storage is still starting (or off) — try again in a moment'));
    return true;
  }
  await o.c!.ready;
  await mgr.sync();
  if (cmd === 'history-search') {
    const hits = await mgr.search(arg);
    console.log(hits.length ? hits.slice(0, 15).map((h) => `  ${st.bold(h.title ?? h.conversationId)} ${st.dim(`· ${h.field} · ${h.conversationId}`)}\n    ${stripMarks(h.snippet).replace(/\s+/g, ' ')}`).join('\n') : st.dim(`nothing matches “${arg}”`));
    return true;
  }
  if (cmd === 'trash') {
    const [sub, id] = arg.split(/\s+/);
    if (sub === 'restore' && id) {
      await mgr.restore([id]);
      console.log(`${st.green('✔')} restored ${id} — /resume ${id}`);
      return true;
    }
    const page = await mgr.list({ view: 'trash', projectId: 'all' });
    console.log(page.rows.length ? page.rows.map((r) => rowLine(r, st)).join('\n') + st.dim('\n/trash restore <id> brings one back') : st.dim('Trash is empty'));
    return true;
  }
  const sid = o.sessionId();
  const [sub, ref] = arg.split(/\s+/).filter(Boolean);
  const info = await mgr.branches(sid);
  if (!sub || sub === 'list') {
    console.log(info.branches.length ? info.branches.map((b, i) => `  ${b.id === info.active ? st.green('●') : ' '} ${i + 1}. ${b.label ?? (b.reason ? `${b.reason} branch` : 'main')} ${st.dim(b.id)}`).join('\n') + st.dim('\n/branch switch <n> · /branch from <messageId>') : st.dim('no branches yet'));
    return true;
  }
  if (sub === 'switch' && ref) {
    const b = info.branches[Number(ref) - 1] ?? info.branches.find((x) => x.id === ref);
    if (!b) {
      console.log(st.red(`no branch ${ref}`));
      return true;
    }
    await mgr.switchBranch(sid, b.id);
    o.reload?.(sid);
    console.log(`${st.green('✔')} switched to ${b.label ?? b.reason ?? 'main'}`);
    return true;
  }
  if (sub === 'from' && ref) {
    await mgr.continueFrom(sid, ref);
    o.reload?.(sid);
    console.log(`${st.green('✔')} continuing from ${ref} on a new branch`);
    return true;
  }
  console.log(st.dim('/branch [list] · /branch switch <n> · /branch from <messageId>'));
  return true;
}
