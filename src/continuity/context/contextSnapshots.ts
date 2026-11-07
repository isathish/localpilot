// Context snapshots (CONTEXT, design §8.1): what the model saw. One `context_snapshot` per turn (its last model
// request) and one on each side of a compaction, built from what the agent loop already has: the history it sent,
// the memory section, the rules, the breakdown, the working set, todos, attachments and compaction details, plus a
// list of items with token estimates and the sha256 of the files involved. Powers the context ring's Items / Excluded
// tabs, "What did the model see?" and context restoration (a chat reopened after a restart, from another window or
// device, gets its working set, todos and attachments back; files whose hash changed are marked "changed since").
// Pure Node (fs, crypto); no vscode.
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { ContextBreakdown } from '../../context/contextBreakdown';
import { estimateMessageTokens, estimateTokens } from '../../context/tokenizer';
import type { ChatMessage, CompactionDetails, Session, TodoItem } from '../../types';
import type { EventLog } from '../data/eventLog';
import type { IndexClient } from '../data/index/indexClient';
import type { ContextSnapshotFields } from '../events';
import { newId } from '../ids';
import type { Excluded } from './contextPolicy';

export type SnapshotItem = ContextSnapshotFields['items'][number];
export type ContextSnapshot = ContextSnapshotFields & { id: string };

/** Items kept per snapshot (largest first); the rest are summed into one "… more" line. */
export const MAX_ITEMS = 80;
/** Files hashed per snapshot, and the largest file hashed. */
const MAX_HASHED = 60;
const MAX_HASH_BYTES = 5 * 1024 * 1024;

const ATTR = (attrs: string, name: string) => new RegExp(`\\b${name}="([^"]*)"`).exec(attrs)?.[1]?.replace(/&quot;/g, '"');

/** Context blocks a user message can carry, and the snapshot item kind of each. */
const BLOCKS: { re: RegExp; kind: SnapshotItem['kind']; ref: (attrs: string, tag: string) => string }[] = [
  { re: /<attachment\b([^>]*)>[\s\S]*?<\/attachment>/g, kind: 'file', ref: (a) => ATTR(a, 'path') ?? 'attachment' },
  { re: /<(workspace_tree|codebase|git|problems|open_editors|terminal_output|url_content|directory|commit)\b([^>]*)>[\s\S]*?<\/\1>/g, kind: 'selection', ref: (a, t) => `@${t === 'workspace_tree' ? 'workspace' : t === 'open_editors' ? 'editors' : t === 'terminal_output' ? 'terminal' : t === 'url_content' ? (ATTR(a, 'url') ?? 'url') : t}` },
  { re: /<memory_note\b([^>]*)>[\s\S]*?<\/memory_note>/g, kind: 'memory', ref: (a) => `#memory:${ATTR(a, 'name') ?? ''}` },
  { re: /<context_set\b([^>]*)>[\s\S]*?<\/context_set>/g, kind: 'library', ref: (a) => `#context:${ATTR(a, 'name') ?? ''}` },
  { re: /<chat_ref\b([^>]*)>[\s\S]*?<\/chat_ref>/g, kind: 'history', ref: (a) => `#chat:${ATTR(a, 'title') ?? ATTR(a, 'id') ?? ''}` },
];

/** Rules / instruction files: the `<!-- label -->` sections of the rules text (see buildInstructions), or one item. */
function ruleItems(rules: string | undefined, labels: readonly string[] = []): SnapshotItem[] {
  const out: SnapshotItem[] = [];
  if (rules?.trim()) {
    const parts = rules.split(/\n\n(?=<!-- )/);
    for (const p of parts) {
      const head = /^<!-- (.+?) -->/.exec(p.trim());
      out.push({ kind: 'rule', ref: (head?.[1] ?? (labels.length === 1 ? labels[0] : 'Project rules')).trim().slice(0, 120), tokens: estimateTokens(p) });
    }
  }
  // Conditional rules this turn brought in, when the text did not name them.
  for (const l of labels) {
    if (!out.some((o) => o.ref.startsWith(l))) {
      out.push({ kind: 'rule', ref: l, tokens: 0 });
    }
  }
  return out;
}

/** Memory section items: `<memory name=…>` bodies and `- name (scope): summary` index lines. */
function memoryItems(section: string | undefined): SnapshotItem[] {
  if (!section?.trim()) {
    return [];
  }
  const out = new Map<string, number>();
  for (const m of section.matchAll(/<memory\b([^>]*)>[\s\S]*?<\/memory>/g)) {
    const name = ATTR(m[1], 'name') ?? 'memory';
    out.set(name, (out.get(name) ?? 0) + estimateTokens(m[0]));
  }
  for (const m of section.matchAll(/^- ([^\n(]+?) \(([\w-]+)\): ?(.*)$/gm)) {
    const name = m[1].trim();
    out.set(name, (out.get(name) ?? 0) + estimateTokens(m[0]));
  }
  return [...out].map(([ref, tokens]) => ({ kind: 'memory' as const, ref, tokens }));
}

export interface SnapshotInput {
  messages: readonly ChatMessage[];
  memorySection?: string;
  rules?: string;
  ruleLabels?: readonly string[];
}

/**
 * The items of a request, largest first: attached files and context blocks, memory, rules, compaction summaries and
 * tool output (grouped per tool call). Token counts are estimates (src/context/tokenizer.ts).
 */
export function snapshotItems(o: SnapshotInput): SnapshotItem[] {
  const items: SnapshotItem[] = [];
  const add = (it: SnapshotItem) => {
    const same = items.find((x) => x.kind === it.kind && x.ref === it.ref);
    if (same) {
      same.tokens += it.tokens;
    } else {
      items.push({ ...it });
    }
  };
  // Tool calls by id, so a result is named after what it ran ("read_file src/a.ts").
  const calls = new Map<string, string>();
  for (const m of o.messages) {
    for (const c of m.toolCalls ?? []) {
      let arg = '';
      try {
        const a = JSON.parse(c.arguments || '{}') as Record<string, unknown>;
        arg = String(a.path ?? a.file ?? a.query ?? a.pattern ?? a.command ?? a.url ?? a.name ?? '').slice(0, 80);
      } catch {
        // partial arguments
      }
      calls.set(c.id, arg ? `${c.name} ${arg}` : c.name);
    }
  }
  let summaries = 0;
  for (const m of o.messages) {
    if (m.meta?.summary) {
      summaries++;
      add({ kind: 'summary', ref: `Compaction summary ${summaries}`, tokens: estimateMessageTokens(m) });
      continue;
    }
    if (m.role === 'tool') {
      add({ kind: 'tool', ref: (m.toolCallId && calls.get(m.toolCallId)) || m.toolName || 'tool output', tokens: estimateMessageTokens(m) });
      continue;
    }
    if (m.role === 'user' && typeof m.content === 'string' && m.content.includes('<')) {
      for (const b of BLOCKS) {
        for (const x of m.content.matchAll(b.re)) {
          const attrs = b.kind === 'selection' ? x[2] ?? '' : x[1] ?? '';
          add({ kind: b.kind, ref: b.ref(attrs, b.kind === 'selection' ? x[1] : ''), tokens: estimateTokens(x[0]) });
        }
      }
    }
  }
  for (const it of memoryItems(o.memorySection)) {
    add(it);
  }
  for (const it of ruleItems(o.rules, o.ruleLabels)) {
    add(it);
  }
  items.sort((a, b) => b.tokens - a.tokens);
  if (items.length > MAX_ITEMS) {
    const rest = items.splice(MAX_ITEMS - 1);
    items.push({ kind: 'tool', ref: `… ${rest.length} more items`, tokens: rest.reduce((n, i) => n + i.tokens, 0) });
  }
  return items;
}

/** sha256 of a file's bytes, or undefined (missing, a folder, too large). */
export function fileHash(abs: string): string | undefined {
  try {
    const st = fs.statSync(abs);
    if (!st.isFile() || st.size > MAX_HASH_BYTES) {
      return undefined;
    }
    return createHash('sha256').update(fs.readFileSync(abs)).digest('hex');
  } catch {
    return undefined;
  }
}

/** Hashes of the given workspace-relative (or absolute) files under `root`. */
export function hashFiles(root: string | undefined, files: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  if (!root) {
    return out;
  }
  for (const f of [...new Set(files)].slice(-MAX_HASHED)) {
    const clean = f.replace(/#.*$/, '');
    if (!clean || /^[@#]|^https?:/i.test(clean)) {
      continue;
    }
    const h = fileHash(path.isAbsolute(clean) ? clean : path.join(root, clean));
    if (h) {
      out[clean] = h;
    }
  }
  return out;
}

/** Files (relative to `root`) whose content differs from the snapshot's hashes, or that are gone. */
export function changedSince(root: string | undefined, hashes: Record<string, string> | undefined): { path: string; state: 'changed' | 'deleted' }[] {
  if (!root || !hashes) {
    return [];
  }
  const out: { path: string; state: 'changed' | 'deleted' }[] = [];
  for (const [rel, h] of Object.entries(hashes)) {
    const abs = path.isAbsolute(rel) ? rel : path.join(root, rel);
    if (!fs.existsSync(abs)) {
      out.push({ path: rel, state: 'deleted' });
    } else if (fileHash(abs) !== h) {
      out.push({ path: rel, state: 'changed' });
    }
  }
  return out;
}

/** What a reopened chat got back from its latest snapshot. */
export interface Restored {
  snapshotId: string;
  at: number;
  workingSet: number;
  todos: number;
  attachments: number;
  breakdown: boolean;
  changed: { path: string; state: 'changed' | 'deleted' }[];
}

/**
 * Puts the latest snapshot's state back on a chat that has none (a chat materialised from the log after a restart,
 * a remote update or on another device): working set, todos, attachments, breakdown. Live state always wins.
 * Returns what was restored plus the files changed since (hash mismatch); undefined when there is nothing to say.
 */
export function restoreInto(session: Session, snap: ContextSnapshot, root: string | undefined): Restored | undefined {
  const r: Restored = { snapshotId: snap.id, at: snap.createdAt, workingSet: 0, todos: 0, attachments: 0, breakdown: false, changed: [] };
  if (!session.workingSet?.length && snap.workingSet?.length) {
    session.workingSet = [...snap.workingSet];
    r.workingSet = snap.workingSet.length;
  }
  if (!session.todos?.length && snap.todos?.length) {
    session.todos = snap.todos.map((t) => ({ ...t }));
    r.todos = snap.todos.length;
  }
  if (!session.attachments?.length && snap.attachments?.length) {
    session.attachments = [...snap.attachments];
    r.attachments = snap.attachments.length;
  }
  if (!session.contextBreakdown && snap.breakdown) {
    session.contextBreakdown = snap.breakdown;
    session.contextTokens ||= snap.usedTokens;
    r.breakdown = true;
  }
  r.changed = changedSince(root, snap.fileHashes);
  return r.workingSet || r.todos || r.attachments || r.changed.length ? r : undefined;
}

/** A line for the next turn's context: the files that changed since the model last saw them. */
export function changedNote(changed: readonly { path: string; state: 'changed' | 'deleted' }[]): string | undefined {
  if (!changed.length) {
    return undefined;
  }
  const list = changed.slice(0, 20).map((c) => `${c.path}${c.state === 'deleted' ? ' (deleted)' : ''}`).join(', ');
  return `# Changed since this chat last ran\nThese files changed outside this conversation since the model last saw them; read them again before relying on earlier output: ${list}${changed.length > 20 ? ` and ${changed.length - 20} more` : ''}.`;
}

export interface RecordInput extends SnapshotInput {
  conversationId: string;
  messageId?: string;
  agentSessionId?: string;
  model: string;
  provider: string;
  remote: boolean;
  window: number;
  usedTokens: number;
  breakdown?: ContextBreakdown;
  excluded?: Excluded[];
  compaction?: CompactionDetails;
  phase: 'turn' | 'before-compaction' | 'after-compaction';
  attachments?: string[];
  workingSet?: string[];
  todos?: TodoItem[];
  root?: string;
}

function rowToSnapshot(r: { id: string; state?: string | null; created_at?: number }): ContextSnapshot | undefined {
  try {
    const st = r.state ? (JSON.parse(r.state) as { fields?: ContextSnapshotFields }) : undefined;
    if (!st?.fields?.conversationId) {
      return undefined;
    }
    return { ...st.fields, id: r.id, items: st.fields.items ?? [], attachments: st.fields.attachments ?? [], workingSet: st.fields.workingSet ?? [] };
  } catch {
    return undefined;
  }
}

/** Records and reads context snapshots (log entities, indexed in `context_snapshots`). */
export class ContextSnapshots {
  private readonly now: () => number;
  constructor(private readonly o: { log: EventLog; index: IndexClient; now?: () => number }) {
    this.now = o.now ?? Date.now;
  }

  /** Builds and appends a snapshot; returns it. Hashing reads at most 60 files of ≤ 5 MB. */
  record(i: RecordInput): ContextSnapshot {
    const items = snapshotItems(i);
    const attached = items.filter((x) => x.kind === 'file').map((x) => x.ref);
    const fileHashes = hashFiles(i.root, [...(i.workingSet ?? []).slice(-40), ...attached]);
    for (const it of items) {
      const h = it.kind === 'file' ? fileHashes[it.ref.replace(/#.*$/, '')] : undefined;
      if (h) {
        it.hash = h;
      }
    }
    const f: ContextSnapshotFields = {
      conversationId: i.conversationId,
      ...(i.agentSessionId ? { agentSessionId: i.agentSessionId } : {}),
      ...(i.messageId ? { messageId: i.messageId } : {}),
      model: i.model,
      provider: i.provider,
      window: i.window,
      usedTokens: i.usedTokens,
      ...(i.breakdown ? { breakdown: i.breakdown } : {}),
      items,
      ...(i.excluded?.length ? { excluded: dedupe(i.excluded) } : {}),
      ...(i.compaction ? { compaction: i.compaction } : {}),
      attachments: [...new Set(i.attachments ?? [])].slice(0, 100),
      workingSet: (i.workingSet ?? []).slice(-40),
      ...(i.todos?.length ? { todos: i.todos.map((t) => ({ id: t.id, title: t.title, status: t.status, ...(t.agent ? { agent: t.agent } : {}) })) } : {}),
      createdAt: this.now(),
      phase: i.phase,
      remote: i.remote,
      ...(i.root ? { root: i.root } : {}),
      ...(Object.keys(fileHashes).length ? { fileHashes } : {}),
    };
    const id = newId('ctx', f.createdAt);
    this.o.log.append('context_snapshot', id, 'create', f);
    return { ...f, id };
  }

  /** The newest snapshot of a conversation. */
  async latest(conversationId: string): Promise<ContextSnapshot | undefined> {
    return (await this.list(conversationId, 1))[0];
  }

  /** A conversation's snapshots, newest first. */
  async list(conversationId: string, limit = 50): Promise<ContextSnapshot[]> {
    const rows = await this.o.index.query<{ id: string; state?: string }>('contextSnapshots', { conversationId, limit });
    return rows.map(rowToSnapshot).filter((s): s is ContextSnapshot => !!s);
  }

  async get(id: string): Promise<ContextSnapshot | undefined> {
    const r = (await this.o.index.query<{ id: string; state?: string }>('contextSnapshot', { id }))[0];
    return r ? rowToSnapshot(r) : undefined;
  }

  /**
   * The snapshot of a message: the one recorded for it, else (a message in the middle of a turn, or a turn recorded
   * before the message had an id) the first turn snapshot of the conversation taken at or after `at`.
   */
  async forMessage(messageId: string, conversationId?: string, at?: number): Promise<ContextSnapshot | undefined> {
    const exact = (await this.o.index.query<{ id: string; state?: string }>('contextSnapshot', { messageId }))[0];
    const hit = exact ? rowToSnapshot(exact) : undefined;
    if (hit || !conversationId) {
      return hit;
    }
    const all = await this.list(conversationId, 500);
    const turns = all.filter((s) => s.phase !== 'before-compaction');
    if (at === undefined) {
      return turns[0];
    }
    // Newest first: the earliest snapshot at or after the message.
    return [...turns].reverse().find((s) => s.createdAt >= at - 1000) ?? turns[0];
  }
}

function dedupe(list: Excluded[]): Excluded[] {
  const seen = new Set<string>();
  return list.filter((e) => (seen.has(`${e.reason}:${e.ref}`) ? false : (seen.add(`${e.reason}:${e.ref}`), true))).slice(0, 100);
}
