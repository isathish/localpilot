import { scanText } from '../security/scan';
import { ChatMessage, LLMProvider, Session, TodoItem } from '../types';
import { MemoryStore } from './memory';

/**
 * After a substantial run, keep what it taught about the project. Small local models rarely call memory_save on their
 * own, so the next session would rediscover the same build command or gotcha. One short request to the same model reads
 * a digest of the run and returns at most three durable facts, which are appended to project memory (duplicates are
 * skipped by the store). Anything that looks like a credential is dropped.
 */

export interface MemoryNoteDraft {
  name: string;
  content: string;
  /** `pitfall`: an error and what fixed it (an `agent` lesson in 1.7); otherwise a project fact. */
  kind?: 'fact' | 'pitfall';
}

/** Pure: a compact account of the run — the request, each tool call with its key argument and outcome, the answer. */
export function runDigest(request: string, turn: readonly ChatMessage[], answer: string, maxChars = 6000): string {
  const lines: string[] = [`Request: ${request.replace(/\s+/g, ' ').slice(0, 600)}`];
  const results = new Map(turn.filter((m) => m.role === 'tool' && m.toolCallId).map((m) => [m.toolCallId!, m]));
  for (const m of turn) {
    for (const c of m.toolCalls ?? []) {
      let arg = '';
      try {
        const a = JSON.parse(c.arguments) as Record<string, unknown>;
        arg = String(a.command ?? a.path ?? a.query ?? a.action ?? '').slice(0, 160);
      } catch {
        /* unparsable arguments */
      }
      const r = results.get(c.id);
      const outcome = !r ? '' : /^(Tool .* failed|Blocked|Error|Refused)|exit code [1-9]|exited [1-9]/i.test(r.content) ? ' → failed' : ' → ok';
      const tail = c.name === 'run_command' && r ? `: ${r.content.replace(/\s+/g, ' ').slice(-200)}` : '';
      lines.push(`- ${c.name}${arg ? ` ${arg}` : ''}${outcome}${tail}`);
    }
  }
  lines.push(`Answer: ${answer.replace(/\s+/g, ' ').slice(0, 1200)}`);
  const text = lines.join('\n');
  return text.length > maxChars ? `${text.slice(0, maxChars / 2)}\n…\n${text.slice(-maxChars / 2)}` : text;
}

/** Pure: notes from the model's reply (JSON, possibly fenced), cleaned; secrets and empty or oversized notes dropped. */
export function parseMemoryNotes(reply: string): MemoryNoteDraft[] {
  const json = /\{[\s\S]*\}/.exec(reply.replace(/```(?:json)?/g, ''))?.[0];
  if (!json) {
    return [];
  }
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return [];
  }
  const notes = Array.isArray((raw as { notes?: unknown })?.notes) ? ((raw as { notes: unknown[] }).notes as unknown[]) : [];
  return notes
    .map((n) => n as { name?: unknown; content?: unknown; kind?: unknown })
    .filter((n) => typeof n.name === 'string' && typeof n.content === 'string')
    .map((n) => ({ name: String(n.name).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40), content: String(n.content).trim(), ...(n.kind === 'pitfall' ? { kind: 'pitfall' as const } : {}) }))
    .filter((n) => n.name && n.content.length >= 10 && n.content.length <= 800 && !scanText('note.md', n.content, { secrets: true, code: false }).length)
    .slice(0, 3);
}

const PROMPT = `You keep the long-term memory of a coding assistant for this project. Read the account of a finished task and decide whether it revealed anything a future session should know without rediscovering it:
- commands that were verified to build, test, lint or run the project;
- project conventions and structure that are not obvious from file names;
- pitfalls: an error and what fixed it, a required flag, a version constraint;
- the user's stated preferences.
Only durable facts confirmed by the task (a command that ran successfully, a fix that worked). Not the task itself, not what changed in this task, not guesses, never secrets.
Reply with JSON only: {"notes":[{"name":"short-kebab-topic","content":"- fact\\n- fact","kind":"fact"}]}. Use "kind":"pitfall" for an error and what fixed it, "fact" otherwise. Reuse an existing note name when the topic matches. Usually the right answer is {"notes":[]}.`;

export async function extractMemories(
  o: { provider: LLMProvider; model: string; contextWindow: number; keepAlive?: string; signal?: AbortSignal },
  digest: string,
  existing: string
): Promise<MemoryNoteDraft[]> {
  const messages: ChatMessage[] = [
    { role: 'system', content: PROMPT },
    { role: 'user', content: `${existing ? `Existing notes:\n${existing.slice(0, 2000)}\n\n` : ''}Task:\n${digest}` },
  ];
  let out = '';
  for await (const ev of o.provider.chat({ model: o.model, messages, temperature: 0, think: false, maxTokens: 400, contextWindow: o.contextWindow, keepAlive: o.keepAlive, signal: o.signal })) {
    if (ev.type === 'text') {
      out += ev.text;
    }
  }
  return parseMemoryNotes(out);
}

/** Runs the extraction and saves the notes; returns the names saved (empty when nothing was worth keeping). */
export async function saveRunMemories(memory: MemoryStore, o: Parameters<typeof extractMemories>[0], digest: string): Promise<string[]> {
  const all = await memory.list().catch(() => []);
  const project = all.filter((n) => n.scope === 'project');
  const projectNames = new Set(project.map((n) => n.name.toLowerCase()));
  const globalOnly = new Set(all.filter((n) => n.scope === 'global' && !projectNames.has(n.name.toLowerCase())).map((n) => n.name.toLowerCase()));
  const index = project.map((n) => `- ${n.name}: ${n.summary}`).join('\n');
  const notes = await extractMemories(o, digest, index);
  const saved: string[] = [];
  for (const n of notes) {
    if (globalOnly.has(n.name.toLowerCase())) {
      continue;
    }
    // 1.7: pitfalls and their fixes are the agent's lessons (listed by name, read on demand); facts stay project notes.
    if (n.kind === 'pitfall' && memory.typed) {
      const ok = await memory.typed.save({ type: 'agent', name: n.name, content: n.content, mode: 'append', source: 'auto' }).then(() => true, () => false);
      if (ok) {
        saved.push(n.name);
        continue;
      }
    }
    const r = await memory.write(n.name, n.content, 'project', 'append', 'auto').catch(() => undefined);
    if (r && !r.unchanged) {
      saved.push(n.name);
    }
  }
  return saved;
}

// ---------------------------------------------------------------------------------------------- 1.7: conversation and task memory

/** What continuity's MemoryManager offers the agent loop (conversation summaries, task checklists). */
export interface ConversationMemoryTarget {
  conversationSummary(conversationId: string, summary: string): Promise<unknown>;
  taskProgress(o: { sessionId: string; todos: readonly TodoItem[]; plan?: Session['plan'] }): Promise<unknown>;
}

export interface AfterTurn {
  session: Session;
  provider: LLMProvider;
  model: string;
  contextWindow: number;
  keepAlive?: string;
  signal: AbortSignal;
  /** The summary of a compaction that happened during this turn. */
  compaction?: string;
}

/** Hooks the agent loop calls (AgentRunner.memoryHooks); both never throw and never delay an answer. */
export interface MemoryTurnHooks {
  onTodos?(session: Session, todos: TodoItem[]): void;
  afterTurn?(o: AfterTurn): Promise<void>;
}

/** Pure: the transcript as compact text for a summary (newest kept when long). */
export function conversationDigest(messages: readonly ChatMessage[], maxChars = 8000): string {
  const lines: string[] = [];
  for (const m of messages) {
    if (m.role === 'system' || m.role === 'tool' || m.meta?.hidden) {
      continue;
    }
    const text = (typeof m.content === 'string' ? m.content : '').replace(/<attachment[\s\S]*?<\/attachment>/g, '[attachment]').replace(/\s+/g, ' ').trim();
    if (text) {
      lines.push(`${m.role === 'user' ? 'User' : 'Assistant'}: ${text.slice(0, 800)}`);
    }
  }
  const out = lines.join('\n');
  return out.length > maxChars ? `…\n${out.slice(out.length - maxChars)}` : out;
}

const SUMMARY_PROMPT = `Summarise this conversation between a developer and a coding assistant for the assistant's memory of it. At most 8 short bullets: the goal, decisions taken, facts established (files, commands, constraints), the current state and what is still open. No preamble, no secrets.`;

/** One request to the chat's own model: a short bullet summary of the conversation ('' when it gave nothing). */
export async function summarizeConversation(o: Omit<AfterTurn, 'session' | 'compaction'>, messages: readonly ChatMessage[]): Promise<string> {
  const digest = conversationDigest(messages);
  if (!digest) {
    return '';
  }
  let out = '';
  for await (const ev of o.provider.chat({ model: o.model, messages: [{ role: 'system', content: SUMMARY_PROMPT }, { role: 'user', content: digest }], temperature: 0, think: false, maxTokens: 500, contextWindow: o.contextWindow, keepAlive: o.keepAlive, signal: o.signal })) {
    if (ev.type === 'text') {
      out += ev.text;
    }
  }
  out = out.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  return out && !scanText('summary.md', out, { secrets: true, code: false }).length ? out.slice(0, 4000) : '';
}

/**
 * Conversation memory (§7): after a compaction the compaction's summary is kept as the chat's summary (no extra
 * request); otherwise every `every` messages one short request to the same model writes it, after the answer.
 * Task memory: the checklist of a running plan / todo list.
 */
export function createMemoryHooks(target: ConversationMemoryTarget, o: { every?: number; log?: (m: string) => void } = {}): MemoryTurnHooks {
  const every = o.every ?? 20;
  const last = new Map<string, number>();
  return {
    onTodos: (session, todos) => {
      void target.taskProgress({ sessionId: session.id, todos, plan: session.plan }).catch((e) => o.log?.(`memory: task note skipped: ${String(e)}`));
    },
    afterTurn: async (a) => {
      const n = a.session.messages.length;
      if (a.compaction?.trim()) {
        last.set(a.session.id, n);
        await target.conversationSummary(a.session.id, a.compaction.replace(/<\/?conversation_summary>/g, '').trim());
        return;
      }
      const since = n - (last.get(a.session.id) ?? 0);
      if (since < every) {
        return;
      }
      last.set(a.session.id, n);
      const summary = await summarizeConversation(a, a.session.messages);
      if (summary && !a.signal.aborted) {
        await target.conversationSummary(a.session.id, summary);
      }
    },
  };
}
