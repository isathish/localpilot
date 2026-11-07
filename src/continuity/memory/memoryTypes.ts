// Memory types (design §7): six kinds of memory with their scope, storage, lifetime and prompt rules. `global` (1.6 and
// the tools' scope name) stays an alias of `developer`. Pure: no vscode, no I/O.
import type { MemoryType } from '../events';

export type { MemoryType } from '../events';

export const MEMORY_TYPES: readonly MemoryType[] = ['conversation', 'project', 'developer', 'task', 'knowledge', 'agent'];

/** How a type reaches the model. */
export type PromptRule =
  /** Index line + small bodies inlined in every chat it applies to (project, developer: from the files, as in 1.6). */
  | 'always'
  /** Index line + body inline, only in its own conversation. */
  | 'conversation'
  /** Index line + body inline, in chats working on that task (same project), until it expires. */
  | 'task'
  /** Never automatically: `memory_search` and `#memory:<name>` only. */
  | 'onDemand'
  /** Index line only; the body via `memory_read`. */
  | 'indexOnly';

export interface MemoryTypeInfo {
  label: string;
  /** One line for the Memory manager and the tools. */
  description: string;
  /** Kept in a Markdown file (the editable surface) as well as the log. */
  fileBacked: boolean;
  /** What links the item to its scope. */
  scope: 'conversation' | 'project' | 'user' | 'task';
  prompt: PromptRule;
}

export const TYPE_INFO: Readonly<Record<MemoryType, MemoryTypeInfo>> = {
  conversation: { label: 'Conversation', description: 'What one conversation has established; only that conversation sees it', fileBacked: false, scope: 'conversation', prompt: 'conversation' },
  project: { label: 'Project', description: 'Facts about this project (.localpilot/memory); every chat in the project sees them', fileBacked: true, scope: 'project', prompt: 'always' },
  developer: { label: 'Developer', description: 'Your preferences and habits; every chat in every project sees them', fileBacked: true, scope: 'user', prompt: 'always' },
  task: { label: 'Task', description: 'Working notes of a plan or todo list; expires after the task is done', fileBacked: false, scope: 'task', prompt: 'task' },
  knowledge: { label: 'Knowledge', description: 'Reference material; used only when asked for (#memory:name, memory_search)', fileBacked: false, scope: 'user', prompt: 'onDemand' },
  agent: { label: 'Agent', description: "What the agent learned: pitfalls, fixes that worked; listed by name, read on demand", fileBacked: false, scope: 'user', prompt: 'indexOnly' },
};

/** At most this many `agent` items; the least recently updated go to Trash beyond it. */
export const AGENT_MAX = 200;
/** Default `localpilot.memory.taskExpiryDays`. */
export const DEFAULT_TASK_EXPIRY_DAYS = 14;
const DAY = 86_400_000;

/** A type name from a tool, a setting or the CLI; `global` = `developer`. Undefined for anything else. */
export function normalizeType(t: unknown): MemoryType | undefined {
  const s = typeof t === 'string' ? t.trim().toLowerCase() : '';
  if (s === 'global' || s === 'user') {
    return 'developer';
  }
  return (MEMORY_TYPES as readonly string[]).includes(s) ? (s as MemoryType) : undefined;
}

/** The 1.6 file scope of a file-backed type. */
export function fileScope(t: MemoryType): 'project' | 'global' | undefined {
  return t === 'project' ? 'project' : t === 'developer' ? 'global' : undefined;
}

/** The note file name a name becomes (same rule as MemoryStore: lower-case kebab, ≤ 64 chars). */
export function safeNoteName(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64) || 'note';
}

export interface ScopeRefs {
  projectId?: string;
  conversationId?: string;
  taskRef?: string;
}

/**
 * The scope key in a memory item id (`stableId('mem', type, scopeKey, name)`): project notes by project, conversation
 * notes by conversation, task notes by task, user-level types by 'user' (or their project when one is given, so a
 * project-specific knowledge note and a general one with the same name stay apart).
 */
export function scopeKey(type: MemoryType, s: ScopeRefs): string {
  switch (type) {
    case 'project':
      return s.projectId ?? 'user';
    case 'conversation':
      return s.conversationId ?? 'none';
    case 'task':
      return `${s.projectId ?? 'user'}:${s.taskRef ?? 'none'}`;
    default:
      return s.projectId && type !== 'developer' ? s.projectId : 'user';
  }
}

/** What the scope fields of a new item must be; throws a readable error when a link is missing. */
export function checkScope(type: MemoryType, s: ScopeRefs): void {
  if (type === 'project' && !s.projectId) {
    throw new Error('Project memory needs an open project folder.');
  }
  if (type === 'conversation' && !s.conversationId) {
    throw new Error('Conversation memory belongs to a conversation; open one first.');
  }
  if (type === 'task' && !s.taskRef) {
    throw new Error('Task memory belongs to a plan or todo list; none is running in this chat.');
  }
}

export interface PromptContext {
  conversationId?: string;
  projectId?: string;
  /** Plans / todo lists this chat works on (`taskRef`s). */
  taskRefs?: string[];
  now?: number;
}

type ItemLike = { type: MemoryType | string; projectId?: string; conversationId?: string; taskRef?: string; expiresAt?: number; trashedAt?: number };

export function isExpired(item: { expiresAt?: number }, now: number): boolean {
  return typeof item.expiresAt === 'number' && item.expiresAt > 0 && item.expiresAt <= now;
}

/**
 * Whether an item belongs in the prompt of a chat, and how (§7 "In the prompt"). Project and developer notes come from
 * their files through MemoryStore (as in 1.6), so they are not repeated here. Knowledge is on demand only.
 */
export function promptRule(item: ItemLike, ctx: PromptContext): 'inline' | 'index' | undefined {
  if (item.trashedAt || isExpired(item, ctx.now ?? Date.now())) {
    return undefined;
  }
  switch (item.type) {
    case 'conversation':
      return ctx.conversationId && item.conversationId === ctx.conversationId ? 'inline' : undefined;
    case 'task': {
      const sameProject = !item.projectId || !ctx.projectId || item.projectId === ctx.projectId;
      const onTask = (!!item.taskRef && (ctx.taskRefs ?? []).includes(item.taskRef)) || (!!ctx.conversationId && item.conversationId === ctx.conversationId);
      return sameProject && onTask ? 'inline' : undefined;
    }
    case 'agent':
      return !item.projectId || item.projectId === ctx.projectId ? 'index' : undefined;
    default:
      return undefined;
  }
}

/** When a task's memory expires: `days` after its todos were all done; undefined while any is open. */
export function taskExpiry(todos: readonly { status: string }[], doneAt: number, days = DEFAULT_TASK_EXPIRY_DAYS): number | undefined {
  if (!todos.length || todos.some((t) => t.status !== 'done' && t.status !== 'skipped')) {
    return undefined;
  }
  return doneAt + Math.max(1, days) * DAY;
}

/** The `taskRef` of a chat's work: its plan file, else its todo list. */
export function taskRefOf(o: { plan?: { file?: string }; sessionId: string }): string {
  return o.plan?.file ? `plan:${o.plan.file.replace(/\\/g, '/')}` : `todos:${o.sessionId}`;
}

/** First non-heading line of a body (≤ 200 chars), as in MemoryStore's index. */
export function summaryOf(body: string): string {
  return (body.split('\n').map((l) => l.replace(/^#+\s*/, '').trim()).find(Boolean) ?? '').slice(0, 200);
}
