// Conversation export and import (design §16.1 Export ▸): JSON (complete and re-importable, schema
// `localpilot-conversation/v1`, every branch included), Markdown and HTML (the 1.6 exports), and PDF as a
// print-ready HTML page (opened in the browser, Print → Save as PDF; the CLI writes the file). Pure Node.
import type { ChatMessage, Session } from '../../types';
import { sessionHtml, sessionMarkdown } from '../../sessions/sessionExport';
import type { BranchRow, ConversationRow } from '../data/index/queries';

export type ExportFormat = 'json' | 'markdown' | 'html' | 'pdf';
export const EXPORT_SCHEMA = 'localpilot-conversation/v1';

export interface ConversationExport {
  schema: typeof EXPORT_SCHEMA;
  exportedAt: number;
  app: string;
  /** The conversation as the chat shows it (active branch). */
  session: Session;
  /** Navigator state: favorite, archived, tags, project name. */
  conversation?: { favorite?: boolean; archived?: boolean; tags?: string[]; project?: string; origin?: string };
  /** Every other branch, with its messages from the fork point on. */
  branches?: { id: string; label?: string; reason?: string; forkedFromMessageId?: string; messages: ChatMessage[] }[];
}

export function exportJson(s: Session, o: { row?: ConversationRow; branches?: (BranchRow & { messages: ChatMessage[] })[]; app?: string; now?: number } = {}): string {
  const doc: ConversationExport = {
    schema: EXPORT_SCHEMA,
    exportedAt: o.now ?? Date.now(),
    app: o.app ?? 'LocalPilot',
    session: { ...s, meta: undefined },
    ...(o.row ? { conversation: { favorite: o.row.favorite, archived: o.row.archived, tags: o.row.tags, project: o.row.projectName, origin: o.row.origin } } : {}),
    ...(o.branches?.length ? { branches: o.branches.map((b) => ({ id: b.id, label: b.label, reason: b.reason, forkedFromMessageId: b.forkedFromMessageId, messages: b.messages })) } : {}),
  };
  return `${JSON.stringify(doc, null, 2)}\n`;
}

/** Parses a JSON export (or a bare 1.6 session file); throws with a readable reason. */
export function parseExport(text: string): ConversationExport {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    throw new Error('not a JSON file');
  }
  const d = doc as Partial<ConversationExport> & Partial<Session>;
  if (d.schema === EXPORT_SCHEMA && d.session && Array.isArray(d.session.messages)) {
    return d as ConversationExport;
  }
  if (typeof d.id === 'string' && Array.isArray(d.messages)) {
    return { schema: EXPORT_SCHEMA, exportedAt: Date.now(), app: 'LocalPilot', session: d as Session };
  }
  throw new Error(`not a LocalPilot conversation export (expected schema ${EXPORT_SCHEMA})`);
}

const PRINT_CSS = [
  '@page{margin:18mm 16mm}',
  '@media print{:root{--fg:#000;--bg:#fff;--muted:#444;--border:#bbb;--code:#f4f4f4}body{font-size:11pt}main{max-width:none;padding:0}pre{white-space:pre-wrap;page-break-inside:auto}.print-hint{display:none}}',
  '.print-hint{font:13px/1.5 system-ui,sans-serif;border:1px solid var(--border);border-radius:6px;padding:8px 12px;margin:16px auto;max-width:860px;color:var(--muted)}',
].join('\n');

/** The print-ready page: the HTML export plus print styles and a one-line hint (no script: the CSP forbids it). */
export function exportPrintHtml(s: Session): string {
  const html = sessionHtml(s.title, sessionMarkdown(s));
  return html
    .replace('</style>', `${PRINT_CSS}\n</style>`)
    .replace('<body>\n', '<body>\n<p class="print-hint">To save as PDF: Print (Ctrl+P / Cmd+P) and choose “Save as PDF”.</p>\n');
}

export function exportAs(format: ExportFormat, s: Session, o: Parameters<typeof exportJson>[1] = {}): { text: string; ext: string } {
  switch (format) {
    case 'json':
      return { text: exportJson(s, o), ext: 'json' };
    case 'markdown':
      return { text: sessionMarkdown(s), ext: 'md' };
    case 'html':
      return { text: sessionHtml(s.title, sessionMarkdown(s)), ext: 'html' };
    case 'pdf':
      return { text: exportPrintHtml(s), ext: 'print.html' };
  }
}

/** A file name for a conversation: its title, safe on every OS. */
export function exportFileName(title: string, ext: string, taken?: Set<string>): string {
  const base = (title || 'chat').replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'chat';
  let name = `${base}.${ext}`;
  for (let i = 2; taken?.has(name.toLowerCase()); i++) {
    name = `${base}-${i}.${ext}`;
  }
  taken?.add(name.toLowerCase());
  return name;
}

/**
 * The session to create from an import: a new id when this one exists, ids of messages cleared (the bridge gives
 * new ones, keeping `copiedFrom`), `origin` kept or set.
 */
export function sessionFromExport(doc: ConversationExport, o: { exists: (id: string) => boolean; newId: () => string; origin?: Session['origin'] }): Session {
  const src = doc.session;
  const id = src.id && !o.exists(src.id) && /^[\w.-]{1,120}$/.test(src.id) ? src.id : o.newId();
  const now = Date.now();
  return {
    ...src,
    id,
    meta: undefined,
    createdAt: src.createdAt ?? now,
    updatedAt: src.updatedAt ?? now,
    messages: src.messages.map((m) => ({ ...m, meta: m.meta ? { ...m.meta, ...(m.meta.id ? { id: undefined, copiedFrom: m.meta.id } : {}) } : undefined })),
    messageCount: src.messages.length,
    contextTokens: 0,
    compactions: src.compactions ?? 0,
    attachments: src.attachments ?? [],
    runningSince: undefined,
    worktree: undefined,
    ...(o.origin ? { origin: o.origin } : {}),
  };
}
