// Index schema (design §6.2), `PRAGMA user_version = 1`. Differences from the first draft of the design, recorded
// there too: the bundled sql.js build has no FTS5, so full-text tables use FTS4 (the probe still prefers FTS5 when a
// future build has it); FTS tables keep their own text (no separate message_text table); tables whose rows an FTS table
// points at have an explicit INTEGER rowid; entity_clocks keeps the reducer state for incremental reduce.
import type { Db } from './db';

export const SCHEMA_VERSION = 1;
export type FtsKind = 'fts5' | 'fts4';

/** Which full-text module this sql.js build provides. */
export function probeFts(db: Db): FtsKind {
  for (const kind of ['fts5', 'fts4'] as const) {
    try {
      db.exec(`CREATE VIRTUAL TABLE temp.fts_probe USING ${kind}(x); DROP TABLE temp.fts_probe;`);
      return kind;
    } catch {
      // try the next one
    }
  }
  throw new Error('sql.js was built without full-text search');
}

export function ddl(fts: FtsKind): string {
  const ft = (name: string, cols: string[]) => (fts === 'fts5' ? `CREATE VIRTUAL TABLE ${name} USING fts5(${cols.join(', ')}, tokenize='unicode61 remove_diacritics 2');` : `CREATE VIRTUAL TABLE ${name} USING fts4(${cols.join(', ')}, tokenize=unicode61 "remove_diacritics=2");`);
  return `
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE stream_cursors (stream TEXT PRIMARY KEY, device TEXT NOT NULL, last_seq INTEGER NOT NULL, own INTEGER NOT NULL);
CREATE TABLE entity_clocks (id TEXT PRIMARY KEY, ent TEXT NOT NULL, clocks TEXT NOT NULL, version TEXT NOT NULL, state TEXT NOT NULL);
CREATE TABLE entity_events (id TEXT NOT NULL, hlc TEXT NOT NULL, op TEXT NOT NULL, stream TEXT NOT NULL, seq INTEGER NOT NULL,
  segment INTEGER NOT NULL, offset INTEGER NOT NULL, length INTEGER NOT NULL, fields TEXT, ent TEXT, at INTEGER, PRIMARY KEY (id, hlc));
CREATE INDEX entity_events_stream ON entity_events (stream, seq);
CREATE INDEX entity_events_at ON entity_events (at);

CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, git_remote TEXT, root_commit TEXT, path TEXT, created_at INTEGER, updated_at INTEGER);
CREATE INDEX projects_remote ON projects (git_remote, root_commit);
CREATE TABLE project_paths (project_id TEXT NOT NULL, device TEXT NOT NULL, path_hash TEXT NOT NULL, path TEXT, PRIMARY KEY (project_id, device));
CREATE INDEX project_paths_hash ON project_paths (path_hash);

CREATE TABLE conversations (rowid INTEGER PRIMARY KEY, id TEXT UNIQUE NOT NULL, project_id TEXT, folder TEXT, title TEXT NOT NULL, model TEXT, mode TEXT, specialist TEXT,
  pinned INTEGER NOT NULL DEFAULT 0, favorite INTEGER NOT NULL DEFAULT 0, archived INTEGER NOT NULL DEFAULT 0, trashed_at INTEGER, purged INTEGER NOT NULL DEFAULT 0,
  active_branch_id TEXT, parent_id TEXT, parent_message_id TEXT, parent_title TEXT, origin TEXT, summary TEXT, message_count INTEGER NOT NULL DEFAULT 0,
  tokens INTEGER, cost_usd REAL, bytes INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, last_device TEXT, group_id TEXT,
  text_dropped INTEGER NOT NULL DEFAULT 0);
CREATE INDEX conv_list ON conversations (project_id, trashed_at, archived, pinned DESC, updated_at DESC);
CREATE INDEX conv_fav ON conversations (favorite, updated_at DESC);
CREATE INDEX conv_updated ON conversations (updated_at DESC);
CREATE TABLE conversation_tags (conversation_id TEXT NOT NULL, tag TEXT NOT NULL, PRIMARY KEY (conversation_id, tag));
CREATE INDEX conversation_tags_tag ON conversation_tags (tag);
CREATE TABLE conversation_branches (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, label TEXT, forked_from_message_id TEXT, head_id TEXT,
  reason TEXT, created_at INTEGER NOT NULL);
CREATE INDEX branches_conv ON conversation_branches (conversation_id, created_at);
${ft('conversation_fts', ['title', 'summary', 'tags'])}

CREATE TABLE messages (rowid INTEGER PRIMARY KEY, id TEXT UNIQUE NOT NULL, conversation_id TEXT NOT NULL, branch_id TEXT NOT NULL, declared_branch TEXT NOT NULL, parent_id TEXT,
  role TEXT NOT NULL, created_at INTEGER NOT NULL, hlc TEXT NOT NULL, model TEXT, provider TEXT, agent_session_id TEXT, supersedes TEXT, partial INTEGER NOT NULL DEFAULT 0,
  summary INTEGER NOT NULL DEFAULT 0, hidden INTEGER NOT NULL DEFAULT 0, tokens INTEGER, has_code INTEGER NOT NULL DEFAULT 0, has_error INTEGER NOT NULL DEFAULT 0,
  loc_stream TEXT NOT NULL, loc_segment INTEGER NOT NULL, loc_offset INTEGER NOT NULL, loc_length INTEGER NOT NULL);
CREATE INDEX messages_conv ON messages (conversation_id, created_at);
CREATE INDEX messages_parent ON messages (parent_id);
CREATE TABLE message_parts (message_id TEXT NOT NULL, idx INTEGER NOT NULL, kind TEXT NOT NULL, tool_name TEXT, call_id TEXT, is_error INTEGER,
  attachment_id TEXT, chars INTEGER, blob TEXT, PRIMARY KEY (message_id, idx));
CREATE INDEX message_parts_tool ON message_parts (tool_name);
${ft('message_fts', ['prose', 'code', 'errors'])}

CREATE TABLE attachments (id TEXT PRIMARY KEY, blob TEXT NOT NULL, mime TEXT, bytes INTEGER, name TEXT, conversation_id TEXT, created_at INTEGER, present INTEGER NOT NULL DEFAULT 1);
CREATE INDEX attachments_blob ON attachments (blob);

CREATE TABLE memory_items (rowid INTEGER PRIMARY KEY, id TEXT UNIQUE NOT NULL, type TEXT NOT NULL, name TEXT NOT NULL, summary TEXT, body TEXT,
  project_id TEXT, conversation_id TEXT, task_ref TEXT, source TEXT, file TEXT, local_only INTEGER NOT NULL DEFAULT 0, pinned INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER, trashed_at INTEGER, created_at INTEGER, updated_at INTEGER, chars INTEGER);
CREATE INDEX memory_scope ON memory_items (type, project_id, trashed_at, updated_at DESC);
CREATE TABLE project_memory (project_id TEXT NOT NULL, memory_id TEXT NOT NULL, file TEXT NOT NULL, content_hash TEXT, PRIMARY KEY (project_id, memory_id));
${ft('memory_fts', ['name', 'body'])}

CREATE TABLE context_snapshots (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, agent_session_id TEXT, message_id TEXT, model TEXT, provider TEXT,
  window INTEGER, used_tokens INTEGER, breakdown TEXT, items TEXT, excluded TEXT, compaction TEXT, created_at INTEGER NOT NULL);
CREATE INDEX ctx_conv ON context_snapshots (conversation_id, created_at DESC);
CREATE TABLE context_library (id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT, project_id TEXT, items TEXT NOT NULL, trashed_at INTEGER, created_at INTEGER, updated_at INTEGER);

CREATE TABLE agent_sessions (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, message_id TEXT, run INTEGER, mode TEXT, model TEXT, provider TEXT,
  started_at INTEGER NOT NULL, ended_at INTEGER, outcome TEXT NOT NULL, writer TEXT, files_touched TEXT, prompt_tokens INTEGER, completion_tokens INTEGER, cost_usd REAL, recovery TEXT, trace_id TEXT, title TEXT);
CREATE INDEX as_conv ON agent_sessions (conversation_id, started_at DESC);
CREATE INDEX as_outcome ON agent_sessions (outcome);
CREATE TABLE execution_events (id TEXT PRIMARY KEY, agent_session_id TEXT NOT NULL, conversation_id TEXT NOT NULL, seq INTEGER NOT NULL, kind TEXT NOT NULL,
  name TEXT, status TEXT, start INTEGER, end INTEGER, detail TEXT, error TEXT, output TEXT, output_blob TEXT, depth INTEGER, agent TEXT);
CREATE INDEX ex_session ON execution_events (agent_session_id, seq);
CREATE INDEX ex_errors ON execution_events (status) WHERE status = 'error';
CREATE TABLE checkpoints (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, agent_session_id TEXT, message_id TEXT, run INTEGER, kind TEXT, outcome TEXT,
  ref TEXT, sha TEXT, root TEXT, project_id TEXT, files TEXT, content_blob TEXT, device TEXT, created_at INTEGER NOT NULL, restored_at INTEGER);
CREATE INDEX cp_conv ON checkpoints (conversation_id, created_at DESC);
CREATE INDEX cp_project ON checkpoints (project_id, created_at DESC);
CREATE TABLE model_sessions (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, provider TEXT, model TEXT, local INTEGER, window INTEGER,
  from_message_id TEXT, to_message_id TEXT, started_at INTEGER, ended_at INTEGER, prompt_tokens INTEGER, completion_tokens INTEGER, cost_usd REAL, reason TEXT);
CREATE INDEX ms_conv ON model_sessions (conversation_id, started_at);
CREATE TABLE prompt_templates (id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT, body TEXT, scope TEXT, project_id TEXT, file TEXT, trashed_at INTEGER, updated_at INTEGER);
CREATE TABLE instruction_files (id TEXT PRIMARY KEY, scope TEXT, project_id TEXT, path TEXT, body_hash TEXT, git_tracked INTEGER, updated_at INTEGER);
CREATE TABLE preferences (key TEXT PRIMARY KEY, value TEXT, updated_at INTEGER);

CREATE TABLE sync_devices (id TEXT PRIMARY KEY, name TEXT, platform TEXT, app_versions TEXT, last_seen INTEGER, revoked_at INTEGER, streams TEXT, this_device INTEGER NOT NULL DEFAULT 0);
CREATE TABLE sync_events (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, kind TEXT NOT NULL, remote TEXT, uploaded INTEGER, downloaded INTEGER,
  bytes INTEGER, error TEXT);
CREATE TABLE sync_conflicts (id TEXT PRIMARY KEY, entity TEXT NOT NULL, entity_id TEXT NOT NULL, field TEXT, kind TEXT NOT NULL, ours TEXT, theirs TEXT,
  applied TEXT, created_at INTEGER NOT NULL, resolved_at INTEGER, resolution TEXT);
CREATE INDEX conflicts_open ON sync_conflicts (resolved_at, created_at DESC);
PRAGMA user_version = ${SCHEMA_VERSION};
`;
}

export function createSchema(db: Db, fts: FtsKind): void {
  db.exec(ddl(fts));
  db.run('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)', ['fts', fts]);
}

/** user_version of a loaded database (0 for an empty one). */
export function userVersion(db: Db): number {
  const r = db.raw.exec('PRAGMA user_version');
  return Number(r[0]?.values[0]?.[0] ?? 0);
}
