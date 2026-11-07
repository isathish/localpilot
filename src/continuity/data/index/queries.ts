// Typed queries over the index (design §6.1): history pages, navigator counts, full-text search with the inline filter
// syntax, message paths, memory, version history and a small allow-list of named queries. No caller passes SQL.
// Pure: runs inside the index engine.
import type { EntityKind, EventLoc } from '../../events';
import { Hlc } from '../../hlc';
import type { Db } from './db';
import type { FtsKind } from './schema';

export type NavView = 'all' | 'pinned' | 'favorites' | 'archived' | 'trash';
export type IndexSort = 'newest' | 'oldest' | 'tokens' | 'cost' | 'size' | 'title';

export interface IndexHistoryQuery {
  view?: NavView;
  /** A project id, 'all' (default) for every project. */
  projectId?: string | 'all';
  /** Title filter (substring, case-insensitive); full-text search is `search`. */
  query?: string;
  tag?: string;
  mode?: string;
  folder?: string;
  origin?: string;
  sort?: IndexSort;
  offset?: number;
  limit?: number;
}

export interface ConversationRow {
  id: string;
  title: string;
  projectId?: string;
  projectName?: string;
  folder?: string;
  model?: string;
  mode?: string;
  specialist?: string;
  pinned: boolean;
  favorite: boolean;
  archived: boolean;
  trashedAt?: number;
  activeBranchId?: string;
  parentId?: string;
  parentTitle?: string;
  origin?: string;
  summary?: string;
  messageCount: number;
  branchCount: number;
  tokens?: number;
  costUsd?: number;
  createdAt: number;
  updatedAt: number;
  lastDevice?: string;
  groupId?: string;
  tags: string[];
}

export interface IndexHistoryPage {
  rows: ConversationRow[];
  total: number;
  offset: number;
  limit: number;
}

export interface NavCounts {
  all: number;
  pinned: number;
  favorites: number;
  archived: number;
  trash: number;
  projects: { id: string; name: string; path?: string; count: number }[];
  /** Conversations of archived/trashed chats whose message text was dropped by the size cap. */
  titleOnly: number;
}

export type SearchIn = 'title' | 'messages' | 'responses' | 'code' | 'errors' | 'memory';
export interface SearchQuery {
  text: string;
  in?: SearchIn[];
  projectId?: string | 'all';
  role?: 'user' | 'assistant';
  model?: string;
  tag?: string;
  mode?: string;
  after?: number;
  before?: number;
  includeArchived?: boolean;
  includeTrash?: boolean;
  /** Only pinned / favorite / archived / trashed conversations (from `is:`). */
  is?: 'pinned' | 'favorite' | 'archived' | 'trashed';
  /** Project name filter (from `project:`), resolved against project names. */
  projectName?: string;
  limit?: number;
  offset?: number;
}

export interface SearchHit {
  conversationId: string;
  title?: string;
  messageId?: string;
  memoryId?: string;
  field: 'title' | 'prose' | 'code' | 'errors' | 'memory';
  /** Matched words are wrapped in \u0002 … \u0003 (the UI turns them into <mark>). */
  snippet: string;
  score: number;
  at: number;
  projectId?: string;
  role?: string;
}

export interface MessageRow {
  id: string;
  conversationId: string;
  branchId: string;
  parentId?: string;
  role: string;
  createdAt: number;
  hlc: string;
  model?: string;
  supersedes?: string;
  partial: boolean;
  summary: boolean;
  hidden: boolean;
  loc: EventLoc;
}

export interface BranchRow {
  id: string;
  conversationId: string;
  label?: string;
  forkedFromMessageId?: string;
  headId?: string;
  reason?: string;
  createdAt: number;
}

export interface MemoryQuery {
  type?: string;
  /** Several types (MEMORY: the prompt items of a chat). */
  types?: string[];
  projectId?: string;
  /** With `projectId`: only items of that project (not the user-level ones). */
  projectOnly?: boolean;
  conversationId?: string;
  /** One item (MEMORY: look-ups by id, trashed ones included when `includeTrash`). */
  id?: string;
  ids?: string[];
  /** Exact name (case-insensitive). */
  name?: string;
  taskRef?: string;
  includeTrash?: boolean;
  /** Only trashed items (the Trash page). */
  trashedOnly?: boolean;
  text?: string;
  /** Only items marked "local only" (CONTEXT's policy). */
  localOnly?: boolean;
  limit?: number;
}

export interface MemoryRow {
  id: string;
  type: string;
  name: string;
  summary?: string;
  body: string;
  projectId?: string;
  conversationId?: string;
  taskRef?: string;
  source?: string;
  file?: string;
  localOnly: boolean;
  pinned: boolean;
  expiresAt?: number;
  trashedAt?: number;
  createdAt?: number;
  updatedAt?: number;
}

export interface VersionRow {
  hlc: string;
  op: string;
  at: number;
  device: string;
  stream: string;
  seq: number;
  /** The payload of that event (absent for messages: bodies are read from the log). */
  fields?: Record<string, unknown>;
  loc: EventLoc;
}

/** Named queries other modules may run (`IndexClient.query`). */
export const NAMED_QUERIES = [
  'referencedBlobs', 'trashedBefore', 'streamCursors', 'conversationIds', 'runningAgentSessions', 'checkpoints', 'conflicts', 'sizes', 'branches', 'siblings', 'executionEvents', 'agentSessions', 'projectByPathHash', 'projectByGit', 'latestContextSnapshot', 'syncEvents',
  // CONVERSATION
  'messageIds', 'entityStates', 'attachments', 'conversationVersions', 'purgedConversations', 'children', 'projects',
  'projectMemory',
  // CONTEXT
  'contextSnapshots', 'contextSnapshot', 'contextLibrary', 'relatedTerms', 'projectConversationCount', 'conversationTags',
  // SESSION
  'modelSessions', 'interruptedAgentSessions',
  // SYNC
  'syncDevices', 'checkpointsWithoutContent', 'promptTemplates', 'preferences',
] as const;
export type NamedQuery = (typeof NAMED_QUERIES)[number];

const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined);
const numu = (v: unknown) => (typeof v === 'number' ? v : undefined);

function convRow(r: Record<string, unknown>): ConversationRow {
  return {
    id: String(r.id),
    title: String(r.title ?? ''),
    projectId: str(r.project_id),
    projectName: str(r.project_name),
    folder: str(r.folder),
    model: str(r.model),
    mode: str(r.mode),
    specialist: str(r.specialist),
    pinned: !!r.pinned,
    favorite: !!r.favorite,
    archived: !!r.archived,
    trashedAt: numu(r.trashed_at),
    activeBranchId: str(r.active_branch_id),
    parentId: str(r.parent_id),
    parentTitle: str(r.parent_title),
    origin: str(r.origin),
    summary: str(r.summary),
    messageCount: Number(r.message_count ?? 0),
    branchCount: Number(r.branch_count ?? 0),
    tokens: numu(r.tokens),
    costUsd: numu(r.cost_usd),
    createdAt: Number(r.created_at ?? 0),
    updatedAt: Number(r.updated_at ?? 0),
    lastDevice: str(r.last_device),
    groupId: str(r.group_id),
    tags: typeof r.tags === 'string' && r.tags ? r.tags.split('\u0001') : [],
  };
}

const CONV_COLUMNS = `c.*, p.name AS project_name,
  (SELECT group_concat(tag, char(1)) FROM conversation_tags t WHERE t.conversation_id = c.id) AS tags,
  (SELECT count(*) FROM conversation_branches b WHERE b.conversation_id = c.id) AS branch_count`;

function viewWhere(view: NavView | undefined): string {
  switch (view) {
    case 'pinned':
      return 'c.pinned = 1 AND c.trashed_at IS NULL';
    case 'favorites':
      return 'c.favorite = 1 AND c.trashed_at IS NULL';
    case 'archived':
      return 'c.archived = 1 AND c.trashed_at IS NULL';
    case 'trash':
      return 'c.trashed_at IS NOT NULL';
    default:
      return 'c.trashed_at IS NULL AND c.archived = 0';
  }
}

const SORTS: Record<IndexSort, string> = {
  newest: 'c.pinned DESC, c.updated_at DESC',
  oldest: 'c.updated_at ASC',
  tokens: 'coalesce(c.tokens, 0) DESC',
  cost: 'coalesce(c.cost_usd, 0) DESC',
  size: 'c.message_count DESC',
  title: 'c.title COLLATE NOCASE ASC',
};

export function history(db: Db, q: IndexHistoryQuery = {}): IndexHistoryPage {
  const where = ['c.purged = 0', "c.title != ''", viewWhere(q.view)];
  const params: (string | number)[] = [];
  if (q.projectId && q.projectId !== 'all') {
    where.push('c.project_id = ?');
    params.push(q.projectId);
  }
  if (q.query) {
    where.push("c.title LIKE ? ESCAPE '\\'");
    params.push(`%${q.query.replace(/[\\%_]/g, (m) => `\\${m}`)}%`);
  }
  if (q.tag) {
    where.push('EXISTS (SELECT 1 FROM conversation_tags t WHERE t.conversation_id = c.id AND t.tag = ?)');
    params.push(q.tag);
  }
  if (q.mode) {
    where.push('(c.mode = ? OR c.specialist = ?)');
    params.push(q.mode, q.mode);
  }
  if (q.folder) {
    where.push('c.folder = ?');
    params.push(q.folder);
  }
  if (q.origin) {
    where.push('c.origin = ?');
    params.push(q.origin);
  }
  const offset = Math.max(0, Math.floor(q.offset ?? 0));
  const limit = Math.max(1, Math.min(500, Math.floor(q.limit ?? 50)));
  const w = where.join(' AND ');
  const total = Number(db.get<{ n: number }>(`SELECT count(*) AS n FROM conversations c WHERE ${w}`, params)?.n ?? 0);
  const order = q.view === 'trash' ? 'c.trashed_at DESC' : SORTS[q.sort ?? 'newest'] ?? SORTS.newest;
  const rows = db.all(`SELECT ${CONV_COLUMNS} FROM conversations c LEFT JOIN projects p ON p.id = c.project_id WHERE ${w} ORDER BY ${order} LIMIT ${limit} OFFSET ${offset}`, params).map(convRow);
  return { rows, total, offset, limit };
}

export function counts(db: Db, projectId?: string): NavCounts {
  const scope = projectId && projectId !== 'all' ? ' AND c.project_id = ?' : '';
  const params = scope ? [projectId!] : [];
  const one = (w: string) => Number(db.get<{ n: number }>(`SELECT count(*) AS n FROM conversations c WHERE c.purged = 0 AND c.title != '' AND ${w}${scope}`, params)?.n ?? 0);
  const projects = db
    .all<{ id: string; name: string; path: string | null; n: number }>(
      `SELECT p.id, p.name, p.path, count(c.id) AS n FROM projects p JOIN conversations c ON c.project_id = p.id
       WHERE c.purged = 0 AND c.title != '' AND c.trashed_at IS NULL AND c.archived = 0 GROUP BY p.id ORDER BY max(c.updated_at) DESC`
    )
    .map((r) => ({ id: r.id, name: r.name, path: r.path ?? undefined, count: Number(r.n) }));
  return {
    all: one(viewWhere('all')),
    pinned: one(viewWhere('pinned')),
    favorites: one(viewWhere('favorites')),
    archived: one(viewWhere('archived')),
    trash: one(viewWhere('trash')),
    projects,
    titleOnly: Number(db.get<{ n: number }>('SELECT count(*) AS n FROM conversations WHERE text_dropped = 1')?.n ?? 0),
  };
}

// ---------------------------------------------------------------------------------------------- search

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Splits inline filters (`in:code from:user project:api tag:x model:y is:pinned before:2026-01-01 after:…`) off the
 * search text. Unknown `word:` tokens stay in the text.
 */
export function parseInlineFilters(input: string): SearchQuery {
  const q: SearchQuery = { text: '' };
  const rest: string[] = [];
  const tokens = input.match(/-?"[^"]*"|\S+/g) ?? [];
  for (const t of tokens) {
    const m = /^(in|from|project|tag|model|is|before|after|mode):(.+)$/i.exec(t);
    if (!m) {
      rest.push(t);
      continue;
    }
    const key = m[1].toLowerCase();
    const v = m[2].replace(/^"|"$/g, '');
    if (key === 'in') {
      const parts = v.toLowerCase().split(',').filter((x): x is SearchIn => ['title', 'messages', 'responses', 'code', 'errors', 'memory'].includes(x));
      q.in = [...(q.in ?? []), ...parts];
    } else if (key === 'from' && (v === 'user' || v === 'assistant' || v === 'me' || v === 'model')) {
      q.role = v === 'me' ? 'user' : v === 'model' ? 'assistant' : v;
    } else if (key === 'project') {
      q.projectName = v;
    } else if (key === 'tag') {
      q.tag = v;
    } else if (key === 'model') {
      q.model = v;
    } else if (key === 'mode') {
      q.mode = v;
    } else if (key === 'is' && ['pinned', 'favorite', 'archived', 'trashed'].includes(v.toLowerCase())) {
      q.is = v.toLowerCase() as SearchQuery['is'];
      if (q.is === 'archived') {
        q.includeArchived = true;
      }
      if (q.is === 'trashed') {
        q.includeTrash = true;
      }
    } else if ((key === 'before' || key === 'after') && DATE.test(v)) {
      const t = Date.parse(`${v}T00:00:00`);
      if (key === 'before') {
        q.before = t;
      } else {
        q.after = t;
      }
    } else {
      rest.push(t);
    }
  }
  q.text = rest.join(' ');
  return q;
}

/** User search text -> an FTS MATCH expression (words, "phrases", prefix*, -exclude), or undefined when empty. */
export function toMatch(text: string, fts: FtsKind, column?: string): string | undefined {
  const tokens = text.match(/-?"[^"]*"|\S+/g) ?? [];
  const pos: string[] = [];
  const neg: string[] = [];
  for (const raw of tokens) {
    const negative = raw.startsWith('-') && raw.length > 1;
    const t = negative ? raw.slice(1) : raw;
    let term: string | undefined;
    if (t.startsWith('"')) {
      const words = t.replace(/"/g, '').match(/[\p{L}\p{N}_]+/gu) ?? [];
      term = words.length ? `"${words.join(' ')}"` : undefined;
    } else {
      const prefix = t.endsWith('*');
      const words = t.match(/[\p{L}\p{N}_]+/gu) ?? [];
      // "foo.bar" or "ECONN-REFUSED" are several tokens to the tokenizer: search them as a phrase.
      term = words.length > 1 ? `"${words.join(' ')}${prefix ? '*' : ''}"` : words.length ? `${words[0]}${prefix ? '*' : ''}` : undefined;
    }
    if (term) {
      (negative ? neg : pos).push(column && fts === 'fts4' ? `${column}:${term}` : term);
    }
  }
  if (!pos.length) {
    return undefined;
  }
  return [...pos, ...neg.map((n) => `NOT ${n}`)].join(' ');
}

const STX = '\u0002';
const ETX = '\u0003';

export function search(db: Db, fts: FtsKind, input: SearchQuery | string): SearchHit[] {
  const q: SearchQuery = typeof input === 'string' ? parseInlineFilters(input) : { ...parseInlineFilters(input.text), ...stripUndefined({ ...input, text: undefined }), text: parseInlineFilters(input.text).text };
  const limit = Math.max(1, Math.min(200, Math.floor(q.limit ?? 50)));
  const offset = Math.max(0, Math.floor(q.offset ?? 0));
  const want = new Set<SearchIn>(q.in?.length ? q.in : ['title', 'messages', 'code', 'errors']);
  if (want.has('responses')) {
    want.add('messages');
    q.role ??= 'assistant';
  }
  // Conversation-level filters shared by every part of the search.
  const convWhere = ['c.purged = 0'];
  const convParams: (string | number)[] = [];
  if (!q.includeTrash) {
    convWhere.push('c.trashed_at IS NULL');
  }
  if (!q.includeArchived) {
    convWhere.push('c.archived = 0');
  }
  if (q.is === 'pinned') {
    convWhere.push('c.pinned = 1');
  } else if (q.is === 'favorite') {
    convWhere.push('c.favorite = 1');
  } else if (q.is === 'archived') {
    convWhere.push('c.archived = 1');
  } else if (q.is === 'trashed') {
    convWhere.push('c.trashed_at IS NOT NULL');
  }
  if (q.projectId && q.projectId !== 'all') {
    convWhere.push('c.project_id = ?');
    convParams.push(q.projectId);
  }
  if (q.projectName) {
    convWhere.push("c.project_id IN (SELECT id FROM projects WHERE name LIKE ? ESCAPE '\\')");
    convParams.push(`%${q.projectName.replace(/[\\%_]/g, (m) => `\\${m}`)}%`);
  }
  if (q.tag) {
    convWhere.push('EXISTS (SELECT 1 FROM conversation_tags t WHERE t.conversation_id = c.id AND t.tag = ?)');
    convParams.push(q.tag);
  }
  if (q.mode) {
    convWhere.push('(c.mode = ? OR c.specialist = ?)');
    convParams.push(q.mode, q.mode);
  }
  const hits: SearchHit[] = [];
  const text = q.text.trim();
  // Filters only (no words): matching conversations, newest first.
  if (!toMatch(text, fts)) {
    if (q.model) {
      convWhere.push("c.model LIKE ? ESCAPE '\\'");
      convParams.push(`%${q.model.replace(/[\\%_]/g, (m) => `\\${m}`)}%`);
    }
    if (q.after) {
      convWhere.push('c.updated_at >= ?');
      convParams.push(q.after);
    }
    if (q.before) {
      convWhere.push('c.updated_at < ?');
      convParams.push(q.before);
    }
    if (!text && (q.projectName || q.tag || q.model || q.is || q.mode || q.after || q.before)) {
      return db
        .all<{ id: string; title: string; updated_at: number; project_id: string | null }>(`SELECT c.id, c.title, c.updated_at, c.project_id FROM conversations c WHERE ${convWhere.join(' AND ')} AND c.title != '' ORDER BY c.updated_at DESC LIMIT ${limit} OFFSET ${offset}`, convParams)
        .map((r) => ({ conversationId: r.id, title: r.title, field: 'title' as const, snippet: r.title, score: 0, at: r.updated_at, projectId: r.project_id ?? undefined }));
    }
    return hits;
  }
  const cw = convWhere.join(' AND ');
  const pull = limit + offset;
  if (want.has('title') && !q.role) {
    const m = toMatch(text, fts);
    for (const r of db.all<{ id: string; title: string; updated_at: number; project_id: string | null; s: string }>(
      `SELECT c.id, c.title, c.updated_at, c.project_id, snippet(conversation_fts, '${STX}', '${ETX}', '…', -1, 12) AS s
       FROM conversation_fts JOIN conversations c ON c.rowid = conversation_fts.rowid
       WHERE conversation_fts MATCH ? AND ${cw}${q.after ? ` AND c.updated_at >= ${Number(q.after)}` : ''}${q.before ? ` AND c.updated_at < ${Number(q.before)}` : ''} ORDER BY c.updated_at DESC LIMIT ${pull}`,
      [m!, ...convParams]
    )) {
      hits.push({ conversationId: r.id, title: r.title, field: 'title', snippet: r.s, score: 3, at: r.updated_at, projectId: r.project_id ?? undefined });
    }
  }
  const columns: ('prose' | 'code' | 'errors')[] = [];
  if (want.has('messages')) {
    columns.push('prose');
  }
  if (want.has('code')) {
    columns.push('code');
  }
  if (want.has('errors')) {
    columns.push('errors');
  }
  const seen = new Set<string>();
  for (const col of columns) {
    const m = toMatch(text, fts, col);
    if (!m) {
      continue;
    }
    const where = [cw];
    const params: (string | number)[] = [m, ...convParams];
    if (q.role) {
      where.push('m.role = ?');
      params.push(q.role);
    }
    if (q.model) {
      where.push("(m.model LIKE ? ESCAPE '\\' OR c.model LIKE ? ESCAPE '\\')");
      const like = `%${q.model.replace(/[\\%_]/g, (x) => `\\${x}`)}%`;
      params.push(like, like);
    }
    if (q.after) {
      where.push('m.created_at >= ?');
      params.push(q.after);
    }
    if (q.before) {
      where.push('m.created_at < ?');
      params.push(q.before);
    }
    const colIndex = col === 'prose' ? 0 : col === 'code' ? 1 : 2;
    for (const r of db.all<{ mid: string; cid: string; title: string; created_at: number; project_id: string | null; role: string; s: string }>(
      `SELECT m.id AS mid, c.id AS cid, c.title, m.created_at, c.project_id, m.role, snippet(message_fts, '${STX}', '${ETX}', '…', ${colIndex}, 12) AS s
       FROM message_fts JOIN messages m ON m.rowid = message_fts.rowid JOIN conversations c ON c.id = m.conversation_id
       WHERE message_fts MATCH ? AND ${where.join(' AND ')} ORDER BY m.created_at DESC LIMIT ${pull}`,
      params
    )) {
      const key = `${r.mid}:${col}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      hits.push({ conversationId: r.cid, title: r.title, messageId: r.mid, field: col, snippet: r.s, score: col === 'errors' ? 2 : 1, at: r.created_at, projectId: r.project_id ?? undefined, role: r.role });
    }
  }
  if (want.has('memory') && q.in?.includes('memory')) {
    for (const r of searchMemory(db, fts, text, { projectId: q.projectId, limit: pull })) {
      hits.push(r);
    }
  }
  hits.sort((a, b) => b.at - a.at || b.score - a.score);
  return hits.slice(offset, offset + limit);
}

export function searchMemory(db: Db, fts: FtsKind, text: string, o: { projectId?: string; limit?: number; includeTrash?: boolean } = {}): SearchHit[] {
  const m = toMatch(text, fts);
  if (!m) {
    return [];
  }
  const where = ['memory_fts MATCH ?'];
  const params: (string | number)[] = [m];
  if (!o.includeTrash) {
    where.push('mi.trashed_at IS NULL');
  }
  if (o.projectId && o.projectId !== 'all') {
    where.push('(mi.project_id = ? OR mi.project_id IS NULL)');
    params.push(o.projectId);
  }
  return db
    .all<{ id: string; name: string; project_id: string | null; conversation_id: string | null; updated_at: number; s: string }>(
      `SELECT mi.id, mi.name, mi.project_id, mi.conversation_id, mi.updated_at, snippet(memory_fts, '${STX}', '${ETX}', '…', -1, 12) AS s
       FROM memory_fts JOIN memory_items mi ON mi.rowid = memory_fts.rowid WHERE ${where.join(' AND ')} ORDER BY mi.updated_at DESC LIMIT ${Math.max(1, Math.min(200, o.limit ?? 50))}`,
      params
    )
    .map((r) => ({ conversationId: r.conversation_id ?? '', memoryId: r.id, title: r.name, field: 'memory' as const, snippet: r.s, score: 1, at: r.updated_at, projectId: r.project_id ?? undefined }));
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

// ---------------------------------------------------------------------------------------------- rows

export function conversation(db: Db, id: string): ConversationRow | undefined {
  const r = db.get(`SELECT ${CONV_COLUMNS} FROM conversations c LEFT JOIN projects p ON p.id = c.project_id WHERE c.id = ? AND c.purged = 0`, [id]);
  return r ? convRow(r) : undefined;
}

function messageRow(r: Record<string, unknown>): MessageRow {
  return {
    id: String(r.id),
    conversationId: String(r.conversation_id),
    branchId: String(r.branch_id),
    parentId: str(r.parent_id),
    role: String(r.role),
    createdAt: Number(r.created_at),
    hlc: String(r.hlc),
    model: str(r.model),
    supersedes: str(r.supersedes),
    partial: !!r.partial,
    summary: !!r.summary,
    hidden: !!r.hidden,
    loc: { stream: String(r.loc_stream), segment: Number(r.loc_segment), offset: Number(r.loc_offset), length: Number(r.loc_length) },
  };
}

/**
 * The messages of a branch in order: the path from the root to the branch's head (ancestors on other branches
 * included). Without a branch id: the conversation's active branch.
 */
export function messages(db: Db, conversationId: string, branchId?: string): MessageRow[] {
  const branch = branchId ?? db.get<{ b: string | null }>('SELECT active_branch_id AS b FROM conversations WHERE id = ?', [conversationId])?.b ?? undefined;
  let head = branch ? db.get<{ head_id: string | null }>('SELECT head_id FROM conversation_branches WHERE id = ?', [branch])?.head_id ?? undefined : undefined;
  if (!head) {
    head = db.get<{ id: string }>(`SELECT id FROM messages WHERE conversation_id = ?${branch ? ' AND branch_id = ?' : ''} ORDER BY created_at DESC, hlc DESC LIMIT 1`, branch ? [conversationId, branch] : [conversationId])?.id;
  }
  if (!head) {
    return [];
  }
  const rows = db.all(
    `WITH RECURSIVE path(id, depth) AS (SELECT ?, 0 UNION ALL SELECT m.parent_id, path.depth + 1 FROM messages m JOIN path ON m.id = path.id WHERE m.parent_id IS NOT NULL AND path.depth < 100000)
     SELECT m.* FROM path JOIN messages m ON m.id = path.id ORDER BY path.depth DESC`,
    [head]
  );
  return rows.map(messageRow);
}

export function branches(db: Db, conversationId: string): BranchRow[] {
  return db
    .all('SELECT * FROM conversation_branches WHERE conversation_id = ? ORDER BY created_at', [conversationId])
    .map((r) => ({ id: String(r.id), conversationId: String(r.conversation_id), label: str(r.label), forkedFromMessageId: str(r.forked_from_message_id), headId: str(r.head_id), reason: str(r.reason), createdAt: Number(r.created_at) }));
}

export function memory(db: Db, q: MemoryQuery = {}): MemoryRow[] {
  const where = ['1 = 1'];
  const params: (string | number)[] = [];
  if (q.type) {
    where.push('type = ?');
    params.push(q.type === 'global' ? 'developer' : q.type);
  }
  if (q.types?.length) {
    where.push(`type IN (${q.types.map(() => '?').join(',')})`);
    params.push(...q.types.map((t) => (t === 'global' ? 'developer' : t)));
  }
  if (q.projectId) {
    where.push(q.projectOnly ? 'project_id = ?' : '(project_id = ? OR project_id IS NULL)');
    params.push(q.projectId);
  }
  if (q.conversationId) {
    where.push('conversation_id = ?');
    params.push(q.conversationId);
  }
  if (q.localOnly) {
    where.push('local_only = 1');
  }
  if (q.id) {
    where.push('id = ?');
    params.push(q.id);
  }
  if (q.ids) {
    const ids = q.ids.slice(0, 500);
    where.push(ids.length ? `id IN (${ids.map(() => '?').join(',')})` : '0 = 1');
    params.push(...ids);
  }
  if (q.name) {
    where.push('lower(name) = lower(?)');
    params.push(q.name);
  }
  if (q.taskRef) {
    where.push('task_ref = ?');
    params.push(q.taskRef);
  }
  if (q.trashedOnly) {
    where.push('trashed_at IS NOT NULL');
  } else if (!q.includeTrash) {
    where.push('trashed_at IS NULL');
  }
  if (q.text) {
    where.push("(name LIKE ? ESCAPE '\\' OR summary LIKE ? ESCAPE '\\')");
    const like = `%${q.text.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
    params.push(like, like);
  }
  return db
    .all(`SELECT * FROM memory_items WHERE ${where.join(' AND ')} ORDER BY pinned DESC, updated_at DESC LIMIT ${Math.max(1, Math.min(2000, q.limit ?? 500))}`, params)
    .map((r) => ({
      id: String(r.id),
      type: String(r.type),
      name: String(r.name),
      summary: str(r.summary),
      body: String(r.body ?? ''),
      projectId: str(r.project_id),
      conversationId: str(r.conversation_id),
      taskRef: str(r.task_ref),
      source: str(r.source),
      file: str(r.file),
      localOnly: !!r.local_only,
      pinned: !!r.pinned,
      expiresAt: numu(r.expires_at),
      trashedAt: numu(r.trashed_at),
      createdAt: numu(r.created_at),
      updatedAt: numu(r.updated_at),
    }));
}

export function versions(db: Db, ent: EntityKind, id: string): VersionRow[] {
  return db
    .all('SELECT * FROM entity_events WHERE id = ? AND (ent = ? OR ent IS NULL) ORDER BY hlc DESC LIMIT 500', [id, ent])
    .map((r) => ({
      hlc: String(r.hlc),
      op: String(r.op),
      at: Hlc.physical(String(r.hlc)),
      device: Hlc.device(String(r.hlc)),
      stream: String(r.stream),
      seq: Number(r.seq),
      fields: typeof r.fields === 'string' ? safeJson(r.fields) : undefined,
      loc: { stream: String(r.stream), segment: Number(r.segment), offset: Number(r.offset), length: Number(r.length) },
    }));
}

function safeJson(s: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(s) as Record<string, unknown>;
  } catch {
    return undefined; // truncated history payload
  }
}

/** Allow-listed named queries (no raw SQL from callers). */
export function named(db: Db, name: NamedQuery, p: Record<string, unknown>, fts: FtsKind = 'fts4'): unknown[] {
  const s = (k: string) => String(p[k] ?? '');
  const n = (k: string) => Number(p[k] ?? 0);
  switch (name) {
    case 'referencedBlobs':
      return db.all<{ blob: string }>(
        `SELECT blob FROM attachments WHERE present = 1 UNION SELECT output_blob FROM execution_events WHERE output_blob IS NOT NULL
         UNION SELECT content_blob FROM checkpoints WHERE content_blob IS NOT NULL UNION SELECT blob FROM message_parts WHERE blob IS NOT NULL`
      ).map((r) => r.blob);
    case 'trashedBefore':
      return [
        ...db.all("SELECT 'conversation' AS ent, id, trashed_at FROM conversations WHERE trashed_at IS NOT NULL AND trashed_at < ? AND purged = 0", [n('before')]),
        ...db.all("SELECT 'memory' AS ent, id, trashed_at FROM memory_items WHERE trashed_at IS NOT NULL AND trashed_at < ?", [n('before')]),
        ...db.all("SELECT 'context_item' AS ent, id, trashed_at FROM context_library WHERE trashed_at IS NOT NULL AND trashed_at < ?", [n('before')]),
        ...db.all("SELECT 'prompt_template' AS ent, id, trashed_at FROM prompt_templates WHERE trashed_at IS NOT NULL AND trashed_at < ?", [n('before')]),
      ];
    case 'streamCursors':
      return db.all('SELECT * FROM stream_cursors ORDER BY stream');
    case 'purgedConversations': {
      // Which of these conversations were purged (deleted for good), here or on another device.
      const ids = (Array.isArray(p.ids) ? p.ids : []).map(String).slice(0, 2000);
      return ids.length ? db.all<{ id: string }>(`SELECT id FROM conversations WHERE purged = 1 AND id IN (${ids.map(() => '?').join(',')})`, ids) : [];
    }
    case 'conversationIds':
      return db.all<{ id: string }>('SELECT id FROM conversations WHERE purged = 0 ORDER BY updated_at DESC').map((r) => r.id);
    case 'runningAgentSessions':
      return db.all("SELECT * FROM agent_sessions WHERE outcome = 'running' ORDER BY started_at DESC");
    case 'agentSessions':
      return db.all('SELECT * FROM agent_sessions WHERE conversation_id = ? ORDER BY started_at DESC', [s('conversationId')]);
    case 'executionEvents':
      return db.all('SELECT * FROM execution_events WHERE agent_session_id = ? ORDER BY seq', [s('agentSessionId')]);
    case 'checkpoints':
      return p.conversationId
        ? db.all('SELECT * FROM checkpoints WHERE conversation_id = ? ORDER BY created_at DESC', [s('conversationId')])
        : p.projectId
          ? db.all('SELECT * FROM checkpoints WHERE project_id = ? ORDER BY created_at DESC LIMIT 500', [s('projectId')])
          : db.all('SELECT * FROM checkpoints ORDER BY created_at DESC LIMIT 500');
    case 'modelSessions':
      // SESSION: the models that answered a conversation, oldest first.
      return db.all('SELECT * FROM model_sessions WHERE conversation_id = ? ORDER BY started_at, id', [s('conversationId')]);
    case 'interruptedAgentSessions':
      // SESSION: runs that did not finish (crash, closed window), newest first.
      return db.all("SELECT * FROM agent_sessions WHERE outcome = 'interrupted' ORDER BY started_at DESC LIMIT 200");
    case 'projectMemory':
      // MEMORY: the project notes of a project with the hash of their last logged body.
      return db.all('SELECT project_id, memory_id, file, content_hash FROM project_memory WHERE project_id = ?', [s('projectId')]);
    case 'conflicts':
      return db.all(p.all ? 'SELECT * FROM sync_conflicts ORDER BY created_at DESC LIMIT 500' : 'SELECT * FROM sync_conflicts WHERE resolved_at IS NULL ORDER BY created_at DESC LIMIT 500');
    case 'branches':
      return branches(db, s('conversationId'));
    case 'siblings':
      return db.all('SELECT id, branch_id, hlc, created_at, role FROM messages WHERE parent_id = (SELECT parent_id FROM messages WHERE id = ?) ORDER BY hlc', [s('messageId')]);
    case 'projectByPathHash':
      return db.all('SELECT p.* FROM project_paths pp JOIN projects p ON p.id = pp.project_id WHERE pp.path_hash = ?', [s('pathHash')]);
    case 'projectByGit':
      return db.all('SELECT * FROM projects WHERE git_remote = ? AND root_commit = ?', [s('gitRemote'), s('rootCommit')]);
    case 'latestContextSnapshot':
      return db.all('SELECT * FROM context_snapshots WHERE conversation_id = ? ORDER BY created_at DESC LIMIT 1', [s('conversationId')]);
    case 'syncEvents':
      return db.all('SELECT * FROM sync_events ORDER BY id DESC LIMIT 100');
    case 'syncDevices':
      // SYNC: the device registry (device entities).
      return db.all('SELECT * FROM sync_devices ORDER BY this_device DESC, last_seen DESC');
    case 'promptTemplates':
      // SYNC: prompt templates of a scope (user-level custom commands), trashed ones included.
      return db.all('SELECT id, name, body, scope, file, trashed_at FROM prompt_templates WHERE scope = ? ORDER BY name', [s('scope') || 'user']);
    case 'preferences':
      // SYNC: synced preferences (allow-listed keys only ever reach the log).
      return db.all('SELECT key, value, updated_at FROM preferences ORDER BY key');
    case 'checkpointsWithoutContent':
      // SYNC: this device's git checkpoints whose contents have not been bundled yet (checkpointContents).
      return db.all("SELECT id, conversation_id, run, ref, sha, root, kind FROM checkpoints WHERE device = ? AND content_blob IS NULL AND ref IS NOT NULL AND ref != '' ORDER BY created_at DESC LIMIT ?", [s('device'), Math.max(1, Math.min(200, n('limit') || 20))]);
    case 'contextSnapshots':
      // CONTEXT: a conversation's snapshots, newest first, with their full reduced fields (todos, working set, hashes).
      return db.all(
        `SELECT s.id, s.conversation_id, s.message_id, s.model, s.provider, s.window, s.used_tokens, s.created_at, e.state FROM context_snapshots s
         LEFT JOIN entity_clocks e ON e.id = s.id WHERE s.conversation_id = ? ORDER BY s.created_at DESC LIMIT ?`,
        [s('conversationId'), Math.max(1, Math.min(500, n('limit') || 50))]
      );
    case 'contextSnapshot':
      // CONTEXT: one snapshot by id, or the snapshot recorded for a message ("What did the model see?").
      return db.all(
        `SELECT s.id, s.conversation_id, s.message_id, s.model, s.provider, s.window, s.used_tokens, s.created_at, e.state FROM context_snapshots s
         LEFT JOIN entity_clocks e ON e.id = s.id WHERE ${p.id ? 's.id = ?' : 's.message_id = ?'} ORDER BY s.created_at DESC LIMIT 1`,
        [p.id ? s('id') : s('messageId')]
      );
    case 'contextLibrary': {
      // CONTEXT: context sets (with their reduced fields: localOnly), this project's and the user's, or one by id.
      const where: string[] = [];
      const args: (string | number)[] = [];
      if (p.id) {
        where.push('l.id = ?');
        args.push(s('id'));
      }
      if (p.trash === 'only') {
        where.push('l.trashed_at IS NOT NULL');
      } else if (p.trash !== 'include') {
        where.push('l.trashed_at IS NULL');
      }
      if (p.projectId && p.projectId !== 'all') {
        where.push('(l.project_id = ? OR l.project_id IS NULL)');
        args.push(s('projectId'));
      }
      return db.all(`SELECT l.*, e.state FROM context_library l LEFT JOIN entity_clocks e ON e.id = l.id ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY l.updated_at DESC LIMIT 500`, args);
    }
    case 'relatedTerms': {
      // CONTEXT: for each search term, the conversations (of a project, not trashed) whose messages' prose or errors,
      // or whose title or summary, contain it. relatedContext.ts turns the term hits into a score.
      const terms = (Array.isArray(p.terms) ? p.terms : []).map(String).filter((t) => /^[\p{L}\p{N}_]+$/u.test(t)).slice(0, 10);
      const scope = p.projectId && p.projectId !== 'all' ? ' AND c.project_id = ?' : '';
      const extra: string[] = scope ? [s('projectId')] : [];
      const out: unknown[] = [];
      for (const t of terms) {
        const msg = fts === 'fts5' ? `{prose errors}: ${t}` : `prose:${t} OR errors:${t}`;
        const conv = fts === 'fts5' ? `{title summary}: ${t}` : `title:${t} OR summary:${t}`;
        const rows = db.all<{ id: string; title: string; updated_at: number; via: string }>(
          `SELECT c.id, c.title, c.updated_at, 'message' AS via FROM message_fts JOIN messages m ON m.rowid = message_fts.rowid JOIN conversations c ON c.id = m.conversation_id
             WHERE message_fts MATCH ? AND c.purged = 0 AND c.trashed_at IS NULL AND c.title != '' AND c.id != ?${scope} GROUP BY c.id
           UNION SELECT c.id, c.title, c.updated_at, 'title' AS via FROM conversation_fts JOIN conversations c ON c.rowid = conversation_fts.rowid
             WHERE conversation_fts MATCH ? AND c.purged = 0 AND c.trashed_at IS NULL AND c.title != '' AND c.id != ?${scope}
           LIMIT 400`,
          [msg, s('excludeId'), ...extra, conv, s('excludeId'), ...extra]
        );
        for (const r of rows) {
          out.push({ term: t, id: r.id, title: r.title, updated_at: r.updated_at, via: r.via });
        }
      }
      return out;
    }
    case 'projectConversationCount':
      return [{ n: Number(db.get<{ n: number }>(`SELECT count(*) AS n FROM conversations WHERE purged = 0 AND trashed_at IS NULL AND title != ''${p.projectId && p.projectId !== 'all' ? ' AND project_id = ?' : ''}`, p.projectId && p.projectId !== 'all' ? [s('projectId')] : [])?.n ?? 0) }];
    case 'conversationTags': {
      // CONTEXT: tags of several conversations (the local-only policy).
      const ids = (Array.isArray(p.ids) ? p.ids : []).map(String).slice(0, 500);
      return ids.length ? db.all(`SELECT conversation_id, tag FROM conversation_tags WHERE conversation_id IN (${ids.map(() => '?').join(',')})`, ids) : [];
    }
    case 'messageIds':
      // Every message of a conversation (all branches): what the SessionBridge already logged.
      return db.all('SELECT id, branch_id, parent_id, role, hlc, summary FROM messages WHERE conversation_id = ? ORDER BY hlc', [s('conversationId')]);
    case 'entityStates': {
      // Reduced states (message parts stripped) of up to 5,000 entities, for materialisation.
      const ids = (Array.isArray(p.ids) ? p.ids : []).map(String).slice(0, 5000);
      const out: unknown[] = [];
      for (let i = 0; i < ids.length; i += 500) {
        const chunk = ids.slice(i, i + 500);
        out.push(...db.all(`SELECT id, ent, version, state FROM entity_clocks WHERE id IN (${chunk.map(() => '?').join(',')})`, chunk));
      }
      return out;
    }
    case 'attachments': {
      const ids = (Array.isArray(p.ids) ? p.ids : []).map(String).slice(0, 2000);
      return ids.length ? db.all(`SELECT id, blob, mime, bytes, name, present FROM attachments WHERE id IN (${ids.map(() => '?').join(',')})`, ids) : [];
    }
    case 'conversationVersions': {
      // The newest event HLC per conversation over the conversation, its branches and its messages.
      const ids = (Array.isArray(p.ids) ? p.ids : []).map(String).slice(0, 2000);
      if (!ids.length) {
        return [];
      }
      const q = ids.map(() => '?').join(',');
      return db.all(
        `SELECT conv AS id, max(hlc) AS version FROM (
           SELECT e.id AS conv, e.hlc FROM entity_events e WHERE e.ent = 'conversation' AND e.id IN (${q})
           UNION ALL SELECT m.conversation_id AS conv, e.hlc FROM messages m JOIN entity_events e ON e.id = m.id WHERE m.conversation_id IN (${q})
           UNION ALL SELECT b.conversation_id AS conv, e.hlc FROM conversation_branches b JOIN entity_events e ON e.id = b.id WHERE b.conversation_id IN (${q})
         ) GROUP BY conv`,
        [...ids, ...ids, ...ids]
      );
    }
    case 'children':
      // Messages with the same parent, per parent, for the branch switcher (`< 2/3 >`).
      // Roots (no parent) are siblings of each other: an edited first prompt. Root rows report parent_id ''.
      return db.all(
        `SELECT id, coalesce(parent_id, '') AS parent_id, branch_id, role, hlc, created_at, model, supersedes FROM messages
         WHERE conversation_id = ?1 AND coalesce(parent_id, '') IN (SELECT coalesce(parent_id, '') FROM messages WHERE conversation_id = ?1 GROUP BY coalesce(parent_id, '') HAVING count(*) > 1) ORDER BY hlc`,
        [s('conversationId')]
      );
    case 'projects':
      return db.all('SELECT p.*, (SELECT group_concat(device || char(2) || path_hash || char(2) || coalesce(pp.path, \'\'), char(1)) FROM project_paths pp WHERE pp.project_id = p.id) AS paths FROM projects p ORDER BY p.name');
    case 'sizes':
      return [
        {
          conversations: Number(db.get<{ n: number }>('SELECT count(*) AS n FROM conversations WHERE purged = 0')?.n ?? 0),
          messages: Number(db.get<{ n: number }>('SELECT count(*) AS n FROM messages')?.n ?? 0),
          memory: Number(db.get<{ n: number }>('SELECT count(*) AS n FROM memory_items')?.n ?? 0),
          trash: Number(db.get<{ n: number }>('SELECT count(*) AS n FROM conversations WHERE trashed_at IS NOT NULL AND purged = 0')?.n ?? 0),
          events: Number(db.get<{ n: number }>('SELECT count(*) AS n FROM entity_events')?.n ?? 0),
        },
      ];
    default:
      throw new Error(`unknown query ${String(name)}`);
  }
}
