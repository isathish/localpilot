import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { SessionStore } from '../sessions/sessionStore';
import { cliDataDir, cliWorkspaceDir } from '../sessions/cliStorage';
import { userText } from '../agent/clarify';
import { Session, SessionSummary } from '../types';
import { Style } from './providers';

/**
 * The CLI's saved chats for one folder: a SessionStore over `<data>/workspaces/<hash>/sessions`, the folder VS Code
 * reads to list them in its history. New ids start with `cli-` and every chat is tagged `origin: 'cli'`.
 */
export async function openCliStore(cwd: string, dataDir: string | undefined, log: vscode.LogOutputChannel): Promise<SessionStore> {
  const data = cliDataDir(dataDir);
  const ctx = { storageUri: vscode.Uri.file(cliWorkspaceDir(cwd, data)), globalStorageUri: vscode.Uri.file(data) } as unknown as vscode.ExtensionContext;
  const store = new SessionStore(ctx, log);
  store.idPrefix = 'cli-';
  store.origin = 'cli';
  await store.load();
  return store;
}

/** Most recently used first (the store's own list puts pinned chats first). */
export function newestFirst(list: SessionSummary[]): SessionSummary[] {
  return [...list].sort((a, b) => b.updatedAt - a.updatedAt);
}

/** "just now", "5 min ago", "3 h ago", "2 d ago", or the date for older ones. */
export function ageLabel(at: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 60) {
    return 'just now';
  }
  if (s < 3600) {
    return `${Math.floor(s / 60)} min ago`;
  }
  if (s < 86_400) {
    return `${Math.floor(s / 3600)} h ago`;
  }
  if (s < 30 * 86_400) {
    return `${Math.floor(s / 86_400)} d ago`;
  }
  return new Date(at).toISOString().slice(0, 10);
}

/** Numbered rows (1 = newest): title, age, messages, model, and the fork parent when there is one. */
export function sessionRows(list: SessionSummary[], st: Style, opts: { now?: number; current?: string } = {}): string[] {
  const width = String(list.length).length;
  return list.map((s, i) => {
    const n = String(i + 1).padStart(width);
    const meta = [ageLabel(s.updatedAt, opts.now), `${s.messageCount} message${s.messageCount === 1 ? '' : 's'}`, s.model, s.parentId ? `forked from ${s.parentTitle ?? s.parentId}` : ''].filter(Boolean).join(' · ');
    return `  ${st.amber(n)}. ${st.bold(s.title || 'New chat')}${s.id === opts.current ? ` ${st.green('(current)')}` : ''}  ${st.dim(`${meta} · ${s.id}`)}`;
  });
}

/** A session by list number (1 = newest), id, or unique id prefix. `ambiguous` when a prefix matches several. */
export function findSession(list: SessionSummary[], ref: string): { session?: SessionSummary; ambiguous?: SessionSummary[] } {
  const r = ref.trim();
  if (/^\d+$/.test(r)) {
    const i = Number(r) - 1;
    if (i >= 0 && i < list.length) {
      return { session: list[i] };
    }
  }
  const exact = list.find((s) => s.id === r);
  if (exact) {
    return { session: exact };
  }
  const matches = r ? list.filter((s) => s.id.startsWith(r)) : [];
  return matches.length === 1 ? { session: matches[0] } : matches.length ? { ambiguous: matches } : {};
}

/** The machine-readable history row (`localpilot history --json`). */
export function historyEntry(s: SessionSummary): Record<string, unknown> {
  return {
    id: s.id,
    title: s.title,
    createdAt: new Date(s.createdAt).toISOString(),
    updatedAt: new Date(s.updatedAt).toISOString(),
    messages: s.messageCount,
    model: s.model,
    mode: s.mode,
    ...(s.origin ? { origin: s.origin } : {}),
    ...(s.parentId ? { parentId: s.parentId, parentTitle: s.parentTitle } : {}),
    ...(s.pinned ? { pinned: true } : {}),
  };
}

/**
 * Shows the saved chats and reads a number (or id). Undefined when there is nothing to pick, no TTY, or the answer is
 * empty; `ask` reads one line.
 */
export async function pickSession(list: SessionSummary[], st: Style, ask: (q: string) => Promise<string | undefined>, out: NodeJS.WritableStream = process.stdout, current?: string): Promise<SessionSummary | undefined> {
  if (!list.length) {
    out.write(`${st.dim('No saved sessions in this folder yet.')}\n`);
    return undefined;
  }
  out.write(`${sessionRows(list, st, { current }).join('\n')}\n`);
  const a = (await ask(`${st.amber('?')} Resume which session? ${st.dim('(number or id, Enter to cancel)')} `))?.trim();
  if (!a) {
    return undefined;
  }
  const hit = findSession(list, a);
  if (!hit.session) {
    out.write(`${st.red(hit.ambiguous ? `"${a}" matches ${hit.ambiguous.length} sessions` : `no session "${a}"`)}\n`);
  }
  return hit.session;
}

export interface HistoryOpts {
  json: boolean;
  limit: number;
  output?: string;
}

/**
 * `localpilot history [--json] [--limit N]`, `history delete <id>`, `history export <id> [-o file.md|file.html]`.
 * Returns the exit code.
 */
export async function cmdHistory(store: SessionStore, words: string[], opts: HistoryOpts, st: Style, cwd: string): Promise<number> {
  const [action = 'list', ref = ''] = words;
  const list = newestFirst(store.list());
  if (action === 'list' || action === 'ls') {
    const rows = list.slice(0, Math.max(1, opts.limit));
    if (opts.json) {
      process.stdout.write(`${JSON.stringify(rows.map(historyEntry), null, 2)}\n`);
      return 0;
    }
    if (!rows.length) {
      console.log(st.dim(`No saved sessions for ${cwd}.`));
      return 0;
    }
    console.log(sessionRows(rows, st).join('\n'));
    console.log(st.dim(`\n${list.length > rows.length ? `${rows.length} of ${list.length} shown (--limit). ` : ''}Resume one with: localpilot -r <number|id>`));
    return 0;
  }
  if (action !== 'delete' && action !== 'rm' && action !== 'export') {
    console.error(st.red(`unknown history action "${action}" — use list, delete <id> or export <id> [-o file]`));
    return 2;
  }
  if (!ref) {
    console.error(st.red(`usage: localpilot history ${action} <number|id>`));
    return 2;
  }
  const hit = findSession(list, ref);
  if (!hit.session) {
    console.error(st.red(hit.ambiguous ? `"${ref}" matches ${hit.ambiguous.length} sessions: ${hit.ambiguous.map((s) => s.id).join(', ')}` : `no saved session "${ref}" — localpilot history lists them`));
    return 2;
  }
  const s = hit.session;
  if (action === 'export') {
    const html = !!opts.output && /\.html?$/i.test(opts.output);
    const text = html ? await store.exportHtml(s.id) : await store.exportMarkdown(s.id);
    if (!opts.output) {
      process.stdout.write(text.endsWith('\n') ? text : `${text}\n`);
      return 0;
    }
    const file = path.resolve(cwd, opts.output);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
    console.log(`${st.green('✔')} Exported "${s.title}" to ${file}`);
    return 0;
  }
  await store.delete(s.id);
  console.log(`${st.green('✔')} Deleted "${s.title}" ${st.dim(`(${s.id})`)}`);
  return 0;
}

/** What is printed when a saved chat is reopened: its title and size, and the last thing said on each side. */
export function resumeBanner(s: Session, st: Style, how: 'Resumed' | 'Forked' = 'Resumed'): string {
  const said = s.messages.filter((m) => (m.role === 'user' || m.role === 'assistant') && !m.meta?.hidden && !m.meta?.summary && !m.meta?.toolResults && !m.meta?.toolImages && (m.role === 'user' || m.content.trim()));
  const clip = (t: string) => {
    const one = t.replace(/\s+/g, ' ').trim();
    return one.length > 160 ? `${one.slice(0, 159)}…` : one;
  };
  const lastUser = [...said].reverse().find((m) => m.role === 'user');
  const lastReply = [...said].reverse().find((m) => m.role === 'assistant');
  const lines = [`${st.amber('↺')} ${how} ${st.bold(s.title || 'New chat')} ${st.dim(`· ${s.messages.length} message${s.messages.length === 1 ? '' : 's'} · ${s.id}`)}`];
  if (s.parentId) {
    lines.push(st.dim(`  forked from ${s.parentTitle ?? s.parentId}`));
  }
  if (lastUser) {
    lines.push(`  ${st.dim('you:')} ${clip(lastUser.meta?.display ?? userText(lastUser.content))}`);
  }
  if (lastReply) {
    lines.push(`  ${st.dim('agent:')} ${clip(lastReply.content)}`);
  }
  return lines.join('\n');
}
