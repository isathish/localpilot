// Reducer output -> SQL rows (design §6). Each event updates the entity's reduced state (kept in entity_clocks for
// incremental catch-up), its version-history row, and the domain table that serves queries. Messages keep only their
// shape and searchable text here; bodies stay in the log (`loc_*`). Runs inside the index engine. Pure.
import { createHash } from 'crypto';
import { ConflictFields, EventEnvelope, EventLoc, isKnown, isWithheld, MessagePart } from '../../events';
import { Hlc } from '../../hlc';
import { branchSplitLoser, DEFAULT_RULES, deviceBranchId, EntityState, noteEdit, reduce, trashedAt } from '../reducer';
import type { Db } from './db';

/** Searchable text caps (§6.2). */
export const TEXT_CAP = 32 * 1024;
export const TOOL_TEXT_CAP = 2 * 1024;
const ERROR_LINE = /error|exception|traceback|failed/i;
const FENCE = /```[^\n]*\n([\s\S]*?)(?:```|$)/g;

const cap = (s: string, n: number) => (s.length > n ? s.slice(0, n) : s);
const json = (v: unknown) => (v === undefined ? null : JSON.stringify(v));
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown) => (typeof v === 'string' ? v : null);
const bool = (v: unknown) => (v ? 1 : 0);

/** prose / code / errors of a message's parts (thinking excluded). */
export function messageText(role: string, parts: MessagePart[]): { prose: string; code: string; errors: string } {
  const prose: string[] = [];
  const code: string[] = [];
  const errors: string[] = [];
  for (const p of parts) {
    if (p.kind === 'text') {
      const t = p.text ?? '';
      let rest = t;
      for (const m of t.matchAll(FENCE)) {
        code.push(m[1]);
        rest = rest.replace(m[0], ' ');
      }
      prose.push(rest);
      if (role === 'assistant' || role === 'user') {
        // Pasted stack traces and error output in prose count as errors too.
        errors.push(...t.split('\n').filter((l) => ERROR_LINE.test(l) && l.length < 400).slice(0, 40));
      }
    } else if (p.kind === 'tool_call') {
      code.push(cap(p.args ?? '', TOOL_TEXT_CAP));
    } else if (p.kind === 'tool_result') {
      const t = p.text ?? '';
      if (p.isError) {
        errors.push(cap(t, TOOL_TEXT_CAP));
      } else {
        errors.push(cap(t.split('\n').filter((l) => ERROR_LINE.test(l)).join('\n'), TOOL_TEXT_CAP));
        code.push(cap(t, TOOL_TEXT_CAP));
      }
    }
  }
  const join = (a: string[]) => cap(a.filter(Boolean).join('\n'), TEXT_CAP);
  return { prose: join(prose), code: join(code), errors: join(errors) };
}

export interface ApplyStats {
  applied: number;
  skipped: number;
  conflicts: number;
}

/**
 * Applies events to the index. Keeps a write-back cache of entity states for the current batch; `flush()` writes them.
 */
export class Applier {
  private cache = new Map<string, EntityState>();
  private dirty = new Set<string>();
  private touchedConvs = new Set<string>();
  readonly stats: ApplyStats = { applied: 0, skipped: 0, conflicts: 0 };

  constructor(private readonly db: Db, private readonly thisDevice: string) {}

  private load(id: string): EntityState | undefined {
    const hit = this.cache.get(id);
    if (hit) {
      return hit;
    }
    const row = this.db.get<{ state: string }>('SELECT state FROM entity_clocks WHERE id = ?', [id]);
    if (!row) {
      return undefined;
    }
    const s = JSON.parse(row.state) as EntityState;
    this.cache.set(id, s);
    return s;
  }

  private save(s: EntityState): void {
    this.cache.set(s.id, s);
    this.dirty.add(s.id);
  }

  /** Writes cached states and derived conversation counters. Call once per transaction. */
  flush(): void {
    for (const id of this.dirty) {
      const s = this.cache.get(id)!;
      // Message bodies stay in the log: the stored state keeps every field but `parts`.
      const fields = s.ent === 'message' ? { ...s.fields, parts: undefined } : s.fields;
      this.db.run('INSERT OR REPLACE INTO entity_clocks (id, ent, clocks, version, state) VALUES (?, ?, ?, ?, ?)', [id, s.ent, JSON.stringify(s.clocks), s.version, JSON.stringify({ ...s, fields })]);
    }
    this.dirty.clear();
    for (const id of this.touchedConvs) {
      this.db.run(
        `UPDATE conversations SET message_count = (SELECT count(*) FROM messages WHERE conversation_id = ?1 AND hidden = 0),
           updated_at = max(updated_at, coalesce((SELECT max(created_at) FROM messages WHERE conversation_id = ?1), 0)) WHERE id = ?1`,
        [id]
      );
    }
    this.touchedConvs.clear();
    if (this.cache.size > 20_000) {
      this.cache.clear();
    }
  }

  apply(e: EventEnvelope, loc: EventLoc): void {
    if (isWithheld(e)) {
      return; // a SYNC stand-in for an event its writer did not sync
    }
    if (!isKnown(e)) {
      // Unknown entity or a newer schema: kept in the log, skipped here ("needs a newer LocalPilot").
      this.stats.skipped++;
      return;
    }
    const prev = this.load(e.eid);
    const r = reduce(prev, e, DEFAULT_RULES);
    this.save(r.state);
    const at = Hlc.physical(e.hlc);
    // Version history (bodies of messages are in the log only).
    const fields = e.ent === 'message' ? null : cap(JSON.stringify(e.p), 64 * 1024);
    this.db.run('INSERT OR IGNORE INTO entity_events (id, hlc, op, stream, seq, segment, offset, length, fields, ent, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [
      e.eid, e.hlc, e.op, e.stream, e.seq, loc.segment, loc.offset, loc.length, fields, e.ent, at,
    ]);
    for (const c of r.conflicts) {
      this.conflict(c, at);
    }
    this.project(r.state, e, loc, at);
    this.stats.applied++;
  }

  private conflict(c: ConflictFields & { id: string }, at: number): void {
    this.stats.conflicts++;
    this.db.run('INSERT OR IGNORE INTO sync_conflicts (id, entity, entity_id, field, kind, ours, theirs, applied, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', [
      c.id, c.entity, c.entityId, c.field, c.kind, JSON.stringify(c.ours), JSON.stringify(c.theirs), c.applied, at,
    ]);
  }

  private project(s: EntityState, e: EventEnvelope, loc: EventLoc, at: number): void {
    const f = s.fields;
    switch (s.ent) {
      case 'conversation':
        return this.conversation(s, e, at);
      case 'branch':
        if (s.purged) {
          this.db.run('DELETE FROM conversation_branches WHERE id = ?', [s.id]);
          return;
        }
        this.db.run('INSERT OR REPLACE INTO conversation_branches (id, conversation_id, label, forked_from_message_id, head_id, reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [
          s.id, str(f.conversationId) ?? '', str(f.label), str(f.forkedFromMessageId), str(f.headId), str(f.reason), num(f.createdAt) ?? at,
        ]);
        return;
      case 'message':
        return this.message(s, e, loc, at);
      case 'project':
        return this.projectRow(s, at);
      case 'memory':
        return this.memory(s, at);
      case 'attachment':
        if (s.purged) {
          this.db.run('DELETE FROM attachments WHERE id = ?', [s.id]);
          return;
        }
        this.db.run('INSERT OR REPLACE INTO attachments (id, blob, mime, bytes, name, conversation_id, created_at, present) VALUES (?, ?, ?, ?, ?, ?, ?, 1)', [
          s.id, str(f.blob) ?? '', str(f.mime), num(f.bytes), str(f.name), str(f.conversationId), num(f.createdAt) ?? at,
        ]);
        return;
      case 'context_snapshot':
        // Redacted (its conversation was purged) or purged: gone from the index.
        if (s.purged || !str(f.conversationId)) {
          this.db.run('DELETE FROM context_snapshots WHERE id = ?', [s.id]);
          return;
        }
        this.db.run('INSERT OR REPLACE INTO context_snapshots (id, conversation_id, agent_session_id, message_id, model, provider, window, used_tokens, breakdown, items, excluded, compaction, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [
          s.id, str(f.conversationId) ?? '', str(f.agentSessionId), str(f.messageId), str(f.model), str(f.provider), num(f.window), num(f.usedTokens), json(f.breakdown), json(f.items ?? []), json(f.excluded), json(f.compaction), num(f.createdAt) ?? at,
        ]);
        return;
      case 'context_item':
        if (s.purged) {
          this.db.run('DELETE FROM context_library WHERE id = ?', [s.id]);
          return;
        }
        this.db.run('INSERT OR REPLACE INTO context_library (id, name, description, project_id, items, trashed_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [
          s.id, str(f.name) ?? '', str(f.description), str(f.projectId), JSON.stringify(f.items ?? []), trashedAt(s) ?? null, num(f.createdAt) ?? at, at,
        ]);
        return;
      case 'agent_session':
        // Redacted (its conversation was purged) or purged: gone from the index.
        if (s.purged || !str(f.conversationId)) {
          this.db.run('DELETE FROM agent_sessions WHERE id = ?', [s.id]);
          return;
        }
        this.db.run('INSERT OR REPLACE INTO agent_sessions (id, conversation_id, message_id, run, mode, model, provider, started_at, ended_at, outcome, writer, files_touched, prompt_tokens, completion_tokens, cost_usd, recovery, trace_id, title) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [
          s.id, str(f.conversationId) ?? '', str(f.messageId), num(f.run), str(f.mode), str(f.model), str(f.provider), num(f.startedAt) ?? at, num(f.endedAt), str(f.outcome) ?? 'running', str(f.writer), json(f.filesTouched), num(f.promptTokens), num(f.completionTokens), num(f.costUsd), json(f.recovery), str(f.traceId), str(f.title),
        ]);
        return;
      case 'execution_event':
        if (s.purged || !str(f.conversationId)) {
          this.db.run('DELETE FROM execution_events WHERE id = ?', [s.id]);
          return;
        }
        this.db.run('INSERT OR REPLACE INTO execution_events (id, agent_session_id, conversation_id, seq, kind, name, status, start, end, detail, error, output, output_blob, depth, agent) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [
          s.id, str(f.agentSessionId) ?? '', str(f.conversationId) ?? '', num(f.seq) ?? 0, str(f.kind) ?? '', str(f.name), str(f.status), num(f.start), num(f.end), str(f.detail), str(f.error), str(f.output) && cap(String(f.output), TOOL_TEXT_CAP), str(f.outputBlob), num(f.depth), str(f.agent),
        ]);
        return;
      case 'checkpoint':
        if (s.purged || !str(f.conversationId)) {
          this.db.run('DELETE FROM checkpoints WHERE id = ?', [s.id]);
          return;
        }
        this.db.run('INSERT OR REPLACE INTO checkpoints (id, conversation_id, agent_session_id, message_id, run, kind, outcome, ref, sha, root, project_id, files, content_blob, device, created_at, restored_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [
          s.id, str(f.conversationId) ?? '', str(f.agentSessionId), str(f.messageId), num(f.run), str(f.kind), str(f.outcome), str(f.ref), str(f.sha), str(f.root), str(f.projectId), json(f.files), str(f.contentBlob), str(f.device), num(f.createdAt) ?? at, num(f.restoredAt),
        ]);
        return;
      case 'model_session':
        if (s.purged || !str(f.conversationId)) {
          this.db.run('DELETE FROM model_sessions WHERE id = ?', [s.id]);
          return;
        }
        this.db.run('INSERT OR REPLACE INTO model_sessions (id, conversation_id, provider, model, local, window, from_message_id, to_message_id, started_at, ended_at, prompt_tokens, completion_tokens, cost_usd, reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [
          s.id, str(f.conversationId) ?? '', str(f.provider), str(f.model), bool(f.local), num(f.window), str(f.fromMessageId), str(f.toMessageId), num(f.startedAt), num(f.endedAt), num(f.promptTokens), num(f.completionTokens), num(f.costUsd), str(f.reason),
        ]);
        return;
      case 'prompt_template':
        if (s.purged) {
          this.db.run('DELETE FROM prompt_templates WHERE id = ?', [s.id]);
          return;
        }
        this.db.run('INSERT OR REPLACE INTO prompt_templates (id, name, description, body, scope, project_id, file, trashed_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', [
          s.id, str(f.name) ?? '', str(f.description), str(f.body), str(f.scope), str(f.projectId), str(f.file), trashedAt(s) ?? null, at,
        ]);
        return;
      case 'instruction_file':
        this.db.run('INSERT OR REPLACE INTO instruction_files (id, scope, project_id, path, body_hash, git_tracked, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [
          s.id, str(f.scope), str(f.projectId), str(f.path), str(f.body) ? String(f.body).length.toString() : null, bool(f.gitTracked), at,
        ]);
        return;
      case 'preference':
        this.db.run('INSERT OR REPLACE INTO preferences (key, value, updated_at) VALUES (?, ?, ?)', [str(f.key) ?? s.id, json(f.value), at]);
        return;
      case 'device':
        this.db.run('INSERT OR REPLACE INTO sync_devices (id, name, platform, app_versions, last_seen, revoked_at, streams, this_device) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [
          s.id, str(f.name), str(f.platform), json(f.appVersions), num(f.lastSeen), num(f.revokedAt), json(f.streams), s.id === this.thisDevice ? 1 : 0,
        ]);
        return;
      case 'conflict': {
        // Conflict entities written by sync (resolutions travel to every device).
        this.db.run('INSERT OR REPLACE INTO sync_conflicts (id, entity, entity_id, field, kind, ours, theirs, applied, created_at, resolved_at, resolution) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [
          s.id, str(f.entity) ?? '', str(f.entityId) ?? '', str(f.field), str(f.kind) ?? 'field', json(f.ours), json(f.theirs), str(f.applied), at, num(f.resolvedAt), str(f.resolution),
        ]);
        return;
      }
      default:
        return;
    }
  }

  private conversation(s: EntityState, e: EventEnvelope, at: number): void {
    const f = s.fields;
    const row = this.db.get<{ rowid: number; updated_at: number }>('SELECT rowid, updated_at FROM conversations WHERE id = ?', [s.id]);
    if (s.purged) {
      if (row) {
        this.db.run('DELETE FROM conversation_fts WHERE rowid = ?', [row.rowid]);
        this.db.run('UPDATE conversations SET purged = 1, title = \'\', summary = NULL, trashed_at = NULL WHERE id = ?', [s.id]);
      }
      this.db.run('DELETE FROM conversation_tags WHERE conversation_id = ?', [s.id]);
      this.purgeMessages(s.id);
      return;
    }
    const tags = Object.entries((f.tags as Record<string, boolean>) ?? {}).filter(([, v]) => v).map(([k]) => k);
    const usage = (f.usage ?? {}) as { promptTokens?: number; completionTokens?: number; cacheReadTokens?: number; costUsd?: number };
    const tokens = (usage.promptTokens ?? 0) + (usage.completionTokens ?? 0) + (usage.cacheReadTokens ?? 0) || null;
    const updated = Math.max(row?.updated_at ?? 0, num(f.updatedAt) ?? 0, e.op === 'trash' || e.op === 'restore' ? 0 : at, num(f.createdAt) ?? 0);
    const group = f.group as { id?: string } | undefined;
    const vals = [
      s.id, str(f.projectId), str(f.folder), str(f.title) ?? '', str(f.model), str(f.mode), str(f.specialist), bool(f.pinned), bool(f.favorite), bool(f.archived), trashedAt(s) ?? null,
      str(f.activeBranchId), str(f.parentId), str(f.parentMessageId), str(f.parentTitle), str(f.origin), str(f.summary), tokens, num(usage.costUsd), num(f.createdAt) ?? at, updated, Hlc.device(s.version), group?.id ?? null,
    ];
    if (row) {
      this.db.run(
        `UPDATE conversations SET id = ?, project_id = ?, folder = ?, title = ?, model = ?, mode = ?, specialist = ?, pinned = ?, favorite = ?, archived = ?, trashed_at = ?,
          active_branch_id = ?, parent_id = ?, parent_message_id = ?, parent_title = ?, origin = ?, summary = ?, tokens = ?, cost_usd = ?, created_at = ?, updated_at = ?, last_device = ?, group_id = ?, purged = 0 WHERE rowid = ${row.rowid}`,
        vals
      );
      this.db.run('DELETE FROM conversation_fts WHERE rowid = ?', [row.rowid]);
    } else {
      this.db.run(
        `INSERT INTO conversations (id, project_id, folder, title, model, mode, specialist, pinned, favorite, archived, trashed_at, active_branch_id, parent_id, parent_message_id, parent_title, origin, summary, tokens, cost_usd, created_at, updated_at, last_device, group_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        vals
      );
    }
    const rowid = row?.rowid ?? this.db.get<{ rowid: number }>('SELECT rowid FROM conversations WHERE id = ?', [s.id])!.rowid;
    this.db.run('INSERT INTO conversation_fts (rowid, title, summary, tags) VALUES (?, ?, ?, ?)', [rowid, str(f.title) ?? '', str(f.summary) ?? '', tags.join(' ')]);
    this.db.run('DELETE FROM conversation_tags WHERE conversation_id = ?', [s.id]);
    for (const t of tags) {
      this.db.run('INSERT OR IGNORE INTO conversation_tags (conversation_id, tag) VALUES (?, ?)', [s.id, t]);
    }
    this.touchedConvs.add(s.id);
  }

  private purgeMessages(convId: string): void {
    this.db.run('DELETE FROM message_fts WHERE rowid IN (SELECT rowid FROM messages WHERE conversation_id = ?)', [convId]);
    this.db.run('DELETE FROM message_parts WHERE message_id IN (SELECT id FROM messages WHERE conversation_id = ?)', [convId]);
    this.db.run('DELETE FROM messages WHERE conversation_id = ?', [convId]);
    this.db.run('DELETE FROM conversation_branches WHERE conversation_id = ?', [convId]);
    this.db.run('UPDATE attachments SET present = 0 WHERE conversation_id = ?', [convId]);
    // What the model saw in that conversation goes with it (CONTEXT).
    this.db.run('DELETE FROM context_snapshots WHERE conversation_id = ?', [convId]);
    // Its runs, what they did, its checkpoints and model sessions too (SESSION).
    this.db.run('DELETE FROM execution_events WHERE conversation_id = ?', [convId]);
    this.db.run('DELETE FROM agent_sessions WHERE conversation_id = ?', [convId]);
    this.db.run('DELETE FROM checkpoints WHERE conversation_id = ?', [convId]);
    this.db.run('DELETE FROM model_sessions WHERE conversation_id = ?', [convId]);
  }

  private message(s: EntityState, e: EventEnvelope, loc: EventLoc, at: number): void {
    const f = s.fields;
    const convId = str(f.conversationId);
    const existing = this.db.get<{ rowid: number; branch_id: string; hlc: string }>('SELECT rowid, branch_id, hlc FROM messages WHERE id = ?', [s.id]);
    if (s.purged) {
      if (existing) {
        this.db.run('DELETE FROM message_fts WHERE rowid = ?', [existing.rowid]);
        this.db.run('DELETE FROM message_parts WHERE message_id = ?', [s.id]);
        this.db.run('DELETE FROM messages WHERE rowid = ?', [existing.rowid]);
      }
      if (convId) {
        this.touchedConvs.add(convId);
      }
      return;
    }
    if (!convId) {
      return;
    }
    const conv = this.load(convId);
    if (conv?.purged) {
      return; // a late message of a purged conversation stays out
    }
    if (e.op === 'create') {
      const r = noteEdit(conv, convId, e);
      this.save(r.state);
      for (const c of r.conflicts) {
        this.conflict(c, at);
      }
      if (r.changed.includes('trashed')) {
        this.db.run('UPDATE conversations SET trashed_at = ? WHERE id = ?', [trashedAt(r.state) ?? null, convId]);
      }
    }
    const meta = (f.meta ?? {}) as { summary?: boolean; hidden?: boolean; tokens?: number };
    const declared = str(f.branchId) ?? '';
    const parent = str(f.parentId);
    // Body location: the event that last set the parts.
    const partsEvent = Array.isArray((e.p as { parts?: unknown }).parts);
    let branch = existing?.branch_id ?? declared;
    if (!existing) {
      // A child of a message that moved to a device branch follows it there.
      if (parent) {
        const p = this.db.get<{ branch_id: string; declared_branch: string }>('SELECT branch_id, declared_branch FROM messages WHERE id = ?', [parent]);
        if (p && p.declared_branch === declared && p.branch_id !== declared) {
          branch = p.branch_id;
        }
      }
    }
    const created = num(f.createdAt) ?? at;
    if (existing) {
      this.db.run(
        `UPDATE messages SET role = ?, model = ?, provider = ?, agent_session_id = ?, supersedes = ?, partial = ?, summary = ?, hidden = ?, tokens = ?${partsEvent ? ', loc_stream = ?, loc_segment = ?, loc_offset = ?, loc_length = ?' : ''} WHERE rowid = ${existing.rowid}`,
        [str(f.role) ?? 'user', str(f.model), str(f.provider), str(f.agentSessionId), str(f.supersedes), bool(f.partial), bool(meta.summary), bool(meta.hidden), num(meta.tokens), ...(partsEvent ? [loc.stream, loc.segment, loc.offset, loc.length] : [])]
      );
    } else {
      this.db.run(
        `INSERT INTO messages (id, conversation_id, branch_id, declared_branch, parent_id, role, created_at, hlc, model, provider, agent_session_id, supersedes, partial, summary, hidden, tokens, loc_stream, loc_segment, loc_offset, loc_length)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [s.id, convId, branch, declared, parent, str(f.role) ?? 'user', created, s.created || e.hlc, str(f.model), str(f.provider), str(f.agentSessionId), str(f.supersedes), bool(f.partial), bool(meta.summary), bool(meta.hidden), num(meta.tokens), loc.stream, loc.segment, loc.offset, loc.length]
      );
      if (parent) {
        this.splitCheck(s.id, convId, declared, parent, s.created || e.hlc, at);
      }
    }
    if (partsEvent) {
      const parts = ((e.p as { parts: MessagePart[] }).parts ?? []) as MessagePart[];
      const rowid = existing?.rowid ?? this.db.get<{ rowid: number }>('SELECT rowid FROM messages WHERE id = ?', [s.id])!.rowid;
      this.db.run('DELETE FROM message_parts WHERE message_id = ?', [s.id]);
      parts.forEach((p, i) => {
        this.db.run('INSERT INTO message_parts (message_id, idx, kind, tool_name, call_id, is_error, attachment_id, chars, blob) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', [
          s.id, i, p.kind, 'name' in p ? p.name : null, 'callId' in p ? p.callId : null, p.kind === 'tool_result' ? bool(p.isError) : null, p.kind === 'image' ? p.attachmentId : null,
          'text' in p ? (p.text ?? '').length : p.kind === 'tool_call' ? (p.args ?? '').length : null, 'blob' in p ? (p.blob ?? null) : null,
        ]);
      });
      const t = messageText(str(f.role) ?? '', parts);
      this.db.run('DELETE FROM message_fts WHERE rowid = ?', [rowid]);
      if (!meta.hidden) {
        this.db.run('INSERT INTO message_fts (rowid, prose, code, errors) VALUES (?, ?, ?, ?)', [rowid, t.prose, t.code, t.errors]);
      }
      this.db.run('UPDATE messages SET has_code = ?, has_error = ? WHERE rowid = ?', [t.code ? 1 : 0, t.errors ? 1 : 0, rowid]);
    }
    // The branch's head and the conversation's activity.
    this.db.run('UPDATE conversation_branches SET head_id = ? WHERE id = ? AND (head_id IS NULL OR head_id = ?)', [s.id, branch, parent]);
    this.touchedConvs.add(convId);
  }

  /** Branch split (§9.4): two devices appended after the same parent on the same branch. */
  private splitCheck(id: string, convId: string, declared: string, parent: string, hlc: string, at: number): void {
    const dev = Hlc.device(hlc);
    const siblings = this.db.all<{ id: string; hlc: string; branch_id: string }>('SELECT id, hlc, branch_id FROM messages WHERE parent_id = ? AND declared_branch = ? AND id != ?', [parent, declared, id]);
    const rival = siblings.find((x) => Hlc.device(x.hlc) !== dev && x.branch_id === declared);
    if (!rival) {
      return;
    }
    const me = { id, hlc };
    const loser = branchSplitLoser(me, rival);
    const winner = loser === me ? rival : me;
    const target = deviceBranchId(declared, loser.id);
    this.db.run(
      `WITH RECURSIVE sub(id) AS (SELECT ?1 UNION SELECT m.id FROM messages m JOIN sub ON m.parent_id = sub.id WHERE m.declared_branch = ?2)
       UPDATE messages SET branch_id = ?3 WHERE id IN (SELECT id FROM sub)`,
      [loser.id, declared, target]
    );
    const head = this.db.get<{ id: string }>('SELECT id FROM messages WHERE branch_id = ? ORDER BY hlc DESC LIMIT 1', [target]);
    const device = Hlc.device(loser.hlc);
    this.db.run('INSERT OR REPLACE INTO conversation_branches (id, conversation_id, label, forked_from_message_id, head_id, reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [
      target, convId, `${device} · ${new Date(Hlc.physical(loser.hlc)).toISOString().slice(0, 16).replace('T', ' ')}`, parent, head?.id ?? loser.id, 'device-split', at,
    ]);
    // The original branch's head follows the winner's line.
    const winHead = this.db.get<{ id: string }>(
      `WITH RECURSIVE sub(id, hlc) AS (SELECT id, hlc FROM messages WHERE id = ?1 UNION SELECT m.id, m.hlc FROM messages m JOIN sub ON m.parent_id = sub.id WHERE m.branch_id = ?2)
       SELECT id FROM sub ORDER BY hlc DESC LIMIT 1`,
      [winner.id, declared]
    );
    if (winHead) {
      this.db.run('UPDATE conversation_branches SET head_id = ? WHERE id = ?', [winHead.id, declared]);
    }
    this.conflict(
      {
        id: deviceBranchId(`cf:${declared}`, loser.id).replace(/^br_/, 'cf_'),
        entity: 'conversation',
        entityId: convId,
        field: 'branch',
        kind: 'branch-split',
        ours: { value: winner.id, hlc: winner.hlc, device: Hlc.device(winner.hlc) },
        theirs: { value: target, hlc: loser.hlc, device },
        applied: 'both',
      },
      at
    );
  }

  private projectRow(s: EntityState, at: number): void {
    const f = s.fields;
    const fp = (f.fingerprints ?? {}) as { gitRemote?: string; rootCommit?: string; pathHash?: Record<string, string> };
    const paths = (f.paths ?? {}) as Record<string, string>;
    this.db.run('INSERT OR REPLACE INTO projects (id, name, git_remote, root_commit, path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [
      s.id, str(f.name) ?? s.id, fp.gitRemote ?? null, fp.rootCommit ?? null, paths[this.thisDevice] ?? Object.values(paths)[0] ?? null, num(f.createdAt) ?? at, at,
    ]);
    this.db.run('DELETE FROM project_paths WHERE project_id = ?', [s.id]);
    for (const [dev, hash] of Object.entries(fp.pathHash ?? {})) {
      this.db.run('INSERT OR REPLACE INTO project_paths (project_id, device, path_hash, path) VALUES (?, ?, ?, ?)', [s.id, dev, hash, paths[dev] ?? null]);
    }
  }

  private memory(s: EntityState, at: number): void {
    const f = s.fields;
    const row = this.db.get<{ rowid: number }>('SELECT rowid FROM memory_items WHERE id = ?', [s.id]);
    if (row) {
      this.db.run('DELETE FROM memory_fts WHERE rowid = ?', [row.rowid]);
    }
    if (s.purged) {
      this.db.run('DELETE FROM memory_items WHERE id = ?', [s.id]);
      this.db.run('DELETE FROM project_memory WHERE memory_id = ?', [s.id]);
      return;
    }
    const body = str(f.body) ?? '';
    const vals = [s.id, str(f.type) ?? 'project', str(f.name) ?? '', str(f.summary), body, str(f.projectId), str(f.conversationId), str(f.taskRef), str(f.source), str(f.file), bool(f.localOnly), bool(f.pinned), num(f.expiresAt), trashedAt(s) ?? null, num(f.createdAt) ?? at, at, body.length];
    if (row) {
      this.db.run(`UPDATE memory_items SET id = ?, type = ?, name = ?, summary = ?, body = ?, project_id = ?, conversation_id = ?, task_ref = ?, source = ?, file = ?, local_only = ?, pinned = ?, expires_at = ?, trashed_at = ?, created_at = ?, updated_at = ?, chars = ? WHERE rowid = ${row.rowid}`, vals);
    } else {
      this.db.run('INSERT INTO memory_items (id, type, name, summary, body, project_id, conversation_id, task_ref, source, file, local_only, pinned, expires_at, trashed_at, created_at, updated_at, chars) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', vals);
    }
    const rowid = row?.rowid ?? this.db.get<{ rowid: number }>('SELECT rowid FROM memory_items WHERE id = ?', [s.id])!.rowid;
    this.db.run('INSERT INTO memory_fts (rowid, name, body) VALUES (?, ?, ?)', [rowid, str(f.name) ?? '', cap(body, TEXT_CAP)]);
    if (f.projectId && f.file) {
      // content_hash: sha256 of the body as last logged (LF line ends), what MEMORY's bridge compares a note file with.
      this.db.run('INSERT OR REPLACE INTO project_memory (project_id, memory_id, file, content_hash) VALUES (?, ?, ?, ?)', [
        str(f.projectId), s.id, str(f.file), createHash('sha256').update(body.replace(/\r\n?/g, '\n')).digest('hex'),
      ]);
    }
  }
}
