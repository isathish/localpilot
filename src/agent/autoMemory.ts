import { scanText } from '../security/scan';
import { ChatMessage, LLMProvider } from '../types';
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
    .map((n) => n as { name?: unknown; content?: unknown })
    .filter((n) => typeof n.name === 'string' && typeof n.content === 'string')
    .map((n) => ({ name: String(n.name).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40), content: String(n.content).trim() }))
    .filter((n) => n.name && n.content.length >= 10 && n.content.length <= 800 && !scanText('note.md', n.content, { secrets: true, code: false }).length)
    .slice(0, 3);
}

const PROMPT = `You keep the long-term memory of a coding assistant for this project. Read the account of a finished task and decide whether it revealed anything a future session should know without rediscovering it:
- commands that were verified to build, test, lint or run the project;
- project conventions and structure that are not obvious from file names;
- pitfalls: an error and what fixed it, a required flag, a version constraint;
- the user's stated preferences.
Only durable facts confirmed by the task (a command that ran successfully, a fix that worked). Not the task itself, not what changed in this task, not guesses, never secrets.
Reply with JSON only: {"notes":[{"name":"short-kebab-topic","content":"- fact\\n- fact"}]}. Reuse an existing note name when the topic matches. Usually the right answer is {"notes":[]}.`;

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
    const r = await memory.write(n.name, n.content, 'project', 'append').catch(() => undefined);
    if (r && !r.unchanged) {
      saved.push(n.name);
    }
  }
  return saved;
}
