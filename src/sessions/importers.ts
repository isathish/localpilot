import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ChatMessage, Session, SessionSummary, ToolCall } from '../types';

/**
 * Chats from other agents, brought into LocalPilot's history: Claude Code keeps one JSONL transcript per chat under
 * `~/.claude/projects/<folder slug>/`, Codex one rollout per chat under `~/.codex/sessions/YYYY/MM/DD/`. User, assistant
 * and tool messages map onto ChatMessage; the imported chat is tagged with its `origin` and can be resumed like any other.
 */

export type ImportSource = 'claude-code' | 'codex';

export interface ImportedSession {
  source: ImportSource;
  /** The other tool's session id. */
  id: string;
  title: string;
  cwd?: string;
  model?: string;
  createdAt: number;
  updatedAt: number;
  messages: ChatMessage[];
}

/** An importable chat as listed in the picker (messages are read again on import). */
export interface ImportCandidate {
  source: ImportSource;
  file: string;
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
}

export const SOURCE_LABEL: Record<ImportSource, string> = { 'claude-code': 'Claude Code', codex: 'Codex' };

const MAX_FILE_BYTES = 64 * 1024 * 1024;
const MAX_TOOL_OUTPUT = 20_000;

const time = (v: unknown): number | undefined => {
  const t = typeof v === 'string' || typeof v === 'number' ? new Date(v).getTime() : NaN;
  return Number.isFinite(t) ? t : undefined;
};

const clip = (s: string) => (s.length > MAX_TOOL_OUTPUT ? `${s.slice(0, MAX_TOOL_OUTPUT)}\n… (${s.length - MAX_TOOL_OUTPUT} more characters not imported)` : s);

/** Text of a content value: a string, or text blocks (`text`, `input_text`, `output_text`) joined. */
function textOf(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((b) => (b && typeof b === 'object' ? (b as { text?: unknown; type?: unknown }) : undefined))
      .filter((b) => b && typeof b.text === 'string' && (b.type === undefined || /text$/.test(String(b.type))))
      .map((b) => String(b!.text))
      .join('\n');
  }
  return '';
}

function lines(text: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const l of text.split('\n')) {
    if (!l.trim()) {
      continue;
    }
    try {
      const v: unknown = JSON.parse(l);
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        out.push(v as Record<string, unknown>);
      }
    } catch {
      /* a torn last line */
    }
  }
  return out;
}

const firstUserTitle = (messages: ChatMessage[]) => messages.find((m) => m.role === 'user')?.content.replace(/\s+/g, ' ').trim().slice(0, 60) || 'Imported chat';

/** Claude Code wraps slash commands and local command output in tags; those turns are not the user's words. */
const CLAUDE_NOISE = /^\s*<(command-name|command-message|local-command-stdout|local-command-caveat|system-reminder|bash-stdout|bash-input)>/;

/** Pure: one Claude Code transcript (`~/.claude/projects/<slug>/<id>.jsonl`). */
export function parseClaudeSession(text: string, fallbackId = ''): ImportedSession {
  const messages: ChatMessage[] = [];
  const toolNames = new Map<string, string>();
  let title = '';
  let id = fallbackId;
  let cwd: string | undefined;
  let model: string | undefined;
  let first: number | undefined;
  let last: number | undefined;
  let lastAssistantId: string | undefined;
  for (const r of lines(text)) {
    if (r.type === 'summary' && typeof r.summary === 'string') {
      title ||= r.summary;
      continue;
    }
    if (r.type === 'custom-title' && typeof r.customTitle === 'string') {
      title = r.customTitle;
      continue;
    }
    if (r.type === 'ai-title' && typeof r.aiTitle === 'string') {
      title ||= r.aiTitle;
      continue;
    }
    if ((r.type !== 'user' && r.type !== 'assistant') || r.isSidechain || r.isMeta) {
      continue;
    }
    id ||= typeof r.sessionId === 'string' ? r.sessionId : '';
    cwd ??= typeof r.cwd === 'string' ? r.cwd : undefined;
    const at = time(r.timestamp);
    if (at !== undefined) {
      first ??= at;
      last = at;
    }
    const msg = (r.message ?? {}) as { id?: string; role?: string; content?: unknown; model?: string };
    const blocks: Record<string, unknown>[] = Array.isArray(msg.content) ? msg.content.filter((b): b is Record<string, unknown> => !!b && typeof b === 'object') : typeof msg.content === 'string' ? [{ type: 'text', text: msg.content }] : [];
    if (r.type === 'assistant') {
      if (typeof msg.model === 'string' && !msg.model.startsWith('<')) {
        model = msg.model;
      }
      // One API message is streamed as several lines (one per block): they share message.id and become one ChatMessage.
      const prev = messages[messages.length - 1];
      const target: ChatMessage = prev && prev.role === 'assistant' && msg.id && msg.id === lastAssistantId ? prev : { role: 'assistant', content: '', meta: at !== undefined ? { timestamp: at } : undefined };
      for (const b of blocks) {
        if (b.type === 'text' && typeof b.text === 'string') {
          target.content = target.content ? `${target.content}\n\n${b.text}` : b.text;
        } else if (b.type === 'thinking' && typeof b.thinking === 'string' && b.thinking) {
          target.thinking = target.thinking ? `${target.thinking}\n\n${b.thinking}` : b.thinking;
        } else if (b.type === 'tool_use' && typeof b.id === 'string') {
          const call: ToolCall = { id: b.id, name: String(b.name ?? 'tool'), arguments: JSON.stringify(b.input ?? {}) };
          toolNames.set(call.id, call.name);
          (target.toolCalls ??= []).push(call);
        }
      }
      if (target !== prev && (target.content || target.toolCalls?.length || target.thinking)) {
        messages.push(target);
      }
      lastAssistantId = msg.id;
      continue;
    }
    lastAssistantId = undefined;
    const results = blocks.filter((b) => b.type === 'tool_result');
    for (const b of results) {
      const callId = String(b.tool_use_id ?? '');
      const content = typeof b.content === 'string' ? b.content : textOf(b.content);
      messages.push({ role: 'tool', toolCallId: callId, toolName: toolNames.get(callId) ?? 'tool', content: clip(content), meta: { ...(at !== undefined ? { timestamp: at } : {}), ...(b.is_error ? { failed: true } : {}) } });
    }
    const said = blocks.filter((b) => b.type === 'text' && typeof b.text === 'string').map((b) => String(b.text)).join('\n').trim();
    const images = blocks.filter((b) => b.type === 'image' && (b.source as { data?: unknown } | undefined)?.data).map((b) => String((b.source as { data: string }).data));
    if ((said && !CLAUDE_NOISE.test(said)) || images.length) {
      messages.push({ role: 'user', content: said, ...(images.length ? { images } : {}), meta: at !== undefined ? { timestamp: at } : undefined });
    }
  }
  const now = Date.now();
  return { source: 'claude-code', id, title: (title || firstUserTitle(messages)).slice(0, 120), cwd, model, createdAt: first ?? now, updatedAt: last ?? first ?? now, messages };
}

/** Codex prepends its environment and AGENTS.md instructions as user messages; they are context, not the user. */
const CODEX_NOISE = /^\s*(<environment_context>|<user_instructions>|<user_shell_command>|# AGENTS\.md instructions)/;

/** Pure: one Codex rollout (`~/.codex/sessions/YYYY/MM/DD/rollout-…jsonl`), current and older layouts. */
export function parseCodexSession(text: string, fallbackId = ''): ImportedSession {
  const messages: ChatMessage[] = [];
  const toolNames = new Map<string, string>();
  let id = fallbackId;
  let cwd: string | undefined;
  let model: string | undefined;
  let first: number | undefined;
  let last: number | undefined;
  let reasoning = '';
  const assistantFor = (at: number | undefined): ChatMessage => {
    const prev = messages[messages.length - 1];
    if (prev?.role === 'assistant' && !prev.toolCalls?.length) {
      return prev;
    }
    const m: ChatMessage = { role: 'assistant', content: '', meta: at !== undefined ? { timestamp: at } : undefined };
    messages.push(m);
    return m;
  };
  const takeReasoning = (m: ChatMessage) => {
    if (reasoning) {
      m.thinking = m.thinking ? `${m.thinking}\n\n${reasoning}` : reasoning;
      reasoning = '';
    }
  };
  for (const r of lines(text)) {
    const at = time(r.timestamp);
    if (at !== undefined) {
      first ??= at;
      last = at;
    }
    // Current layout: {timestamp, type, payload}; the first rollouts wrote the items (and a header) bare.
    const kind = typeof r.type === 'string' ? r.type : '';
    const p = (r.payload && typeof r.payload === 'object' ? r.payload : r) as Record<string, unknown>;
    if (kind === 'session_meta' || (!kind && typeof r.id === 'string' && 'instructions' in r)) {
      id ||= String(p.id ?? '');
      cwd ??= typeof p.cwd === 'string' ? p.cwd : undefined;
      const t = time(p.timestamp);
      if (t !== undefined) {
        first = Math.min(first ?? t, t);
      }
      continue;
    }
    if (kind === 'turn_context') {
      model = typeof p.model === 'string' ? p.model : model;
      cwd ??= typeof p.cwd === 'string' ? p.cwd : undefined;
      continue;
    }
    if (kind && kind !== 'response_item' && !(kind === 'message' || kind.startsWith('function_call') || kind === 'reasoning' || kind.startsWith('custom_tool_call') || kind === 'local_shell_call')) {
      continue;
    }
    const type = String(p.type ?? '');
    if (type === 'message') {
      const said = textOf(p.content).trim();
      if (p.role === 'user' && said && !CODEX_NOISE.test(said)) {
        messages.push({ role: 'user', content: said, meta: at !== undefined ? { timestamp: at } : undefined });
      } else if (p.role === 'assistant' && said) {
        const m = assistantFor(at);
        m.content = m.content ? `${m.content}\n\n${said}` : said;
        takeReasoning(m);
      }
    } else if (type === 'reasoning') {
      const summary = Array.isArray(p.summary) ? p.summary.map((s) => (s && typeof s === 'object' ? String((s as { text?: unknown }).text ?? '') : '')).filter(Boolean).join('\n') : '';
      if (summary) {
        reasoning = reasoning ? `${reasoning}\n\n${summary}` : summary;
      }
    } else if (type === 'function_call' || type === 'custom_tool_call' || type === 'local_shell_call') {
      const callId = String(p.call_id ?? p.id ?? `call_${messages.length}`);
      const name = type === 'local_shell_call' ? 'shell' : String(p.name ?? 'tool');
      const args = type === 'local_shell_call' ? JSON.stringify(p.action ?? {}) : typeof p.arguments === 'string' ? p.arguments : typeof p.input === 'string' ? JSON.stringify({ input: p.input }) : JSON.stringify(p.arguments ?? {});
      const prev = messages[messages.length - 1];
      const m = prev?.role === 'assistant' ? prev : assistantFor(at);
      takeReasoning(m);
      (m.toolCalls ??= []).push({ id: callId, name, arguments: args });
      toolNames.set(callId, name);
    } else if (type === 'function_call_output' || type === 'custom_tool_call_output' || type === 'local_shell_call_output') {
      const callId = String(p.call_id ?? '');
      const out = p.output;
      const content = typeof out === 'string' ? out : out && typeof out === 'object' ? String((out as { content?: unknown }).content ?? JSON.stringify(out)) : '';
      messages.push({ role: 'tool', toolCallId: callId, toolName: toolNames.get(callId) ?? 'tool', content: clip(content), meta: at !== undefined ? { timestamp: at } : undefined });
    }
  }
  const now = Date.now();
  return { source: 'codex', id, title: firstUserTitle(messages).slice(0, 120), cwd, model, createdAt: first ?? now, updatedAt: last ?? first ?? now, messages };
}

/** Pure: Claude Code's folder name for a workspace path (every character other than a letter or digit becomes `-`). */
export function claudeProjectSlug(cwd: string): string {
  return path.resolve(cwd).replace(/[^A-Za-z0-9]/g, '-');
}

const samePath = (a: string | undefined, b: string) => !!a && path.resolve(a).replace(/[\\/]+$/, '').toLowerCase() === path.resolve(b).replace(/[\\/]+$/, '').toLowerCase();

/** The first `bytes` of a file, for reading a rollout's header without parsing the whole chat. */
function head(file: string, bytes = 65_536): string {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(bytes);
    const n = fs.readSync(fd, buf, 0, bytes, 0);
    return buf.subarray(0, n).toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

function walkJsonl(dir: string, depth: number, out: string[]): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory() && depth > 0) {
      walkJsonl(p, depth - 1, out);
    } else if (e.isFile() && e.name.endsWith('.jsonl')) {
      out.push(p);
    }
  }
}

/** Parses one candidate file. */
export function readImport(c: Pick<ImportCandidate, 'source' | 'file'>): ImportedSession {
  const text = fs.readFileSync(c.file, 'utf8');
  const id = path.basename(c.file, '.jsonl');
  return c.source === 'claude-code' ? parseClaudeSession(text, id) : parseCodexSession(text, id.replace(/^rollout-[\d-T]+-/, ''));
}

/**
 * The Claude Code and Codex chats of a workspace folder, newest first. `home` is the user's home (tests pass a fixture
 * folder); empty chats and files over 64 MB are left out.
 */
export function findImportable(cwd: string, opts: { home?: string; sources?: ImportSource[] } = {}): ImportCandidate[] {
  const home = opts.home ?? os.homedir();
  const sources = opts.sources ?? ['claude-code', 'codex'];
  const files: { source: ImportSource; file: string }[] = [];
  if (sources.includes('claude-code')) {
    const dir = path.join(home, '.claude', 'projects', claudeProjectSlug(cwd));
    const found: string[] = [];
    walkJsonl(dir, 0, found);
    files.push(...found.map((file) => ({ source: 'claude-code' as const, file })));
  }
  if (sources.includes('codex')) {
    const found: string[] = [];
    walkJsonl(path.join(home, '.codex', 'sessions'), 4, found);
    for (const file of found) {
      try {
        const meta = parseCodexSession(head(file).split('\n').slice(0, 3).join('\n'));
        if (samePath(meta.cwd, cwd)) {
          files.push({ source: 'codex', file });
        }
      } catch {
        /* unreadable */
      }
    }
  }
  const out: ImportCandidate[] = [];
  for (const f of files) {
    try {
      if (fs.statSync(f.file).size > MAX_FILE_BYTES) {
        continue;
      }
      const s = readImport(f);
      // A Claude Code folder slug can be shared by two paths that differ only in punctuation; the transcript says which.
      if (!s.messages.some((m) => m.role === 'user') || (s.cwd && !samePath(s.cwd, cwd))) {
        continue;
      }
      out.push({ source: f.source, file: f.file, id: s.id, title: s.title, createdAt: s.createdAt, updatedAt: s.updatedAt, messageCount: s.messages.length });
    } catch {
      /* unreadable */
    }
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt);
}

/** Pure: whether `existing` already holds an import of this chat (same origin and start time). */
export function alreadyImported(existing: SessionSummary[], c: Pick<ImportCandidate, 'source' | 'createdAt'>): SessionSummary | undefined {
  return existing.find((s) => s.origin === c.source && s.createdAt === c.createdAt);
}

/** The store calls an import needs (a SessionStore). */
export interface ImportTarget {
  list(): SessionSummary[];
  create(model: string, mode?: Session['mode']): Session;
  save(s: Session, immediate?: boolean): void;
  flush(s: Session): Promise<void>;
}

/** Saves one imported chat (or returns the earlier import of it); `created` says which. */
export async function importInto(store: ImportTarget, s: ImportedSession): Promise<{ session: Session | SessionSummary; created: boolean }> {
  const dup = alreadyImported(store.list(), s);
  if (dup) {
    return { session: dup, created: false };
  }
  // The other tool's model is not one of this user's providers: the chat continues on the default model.
  const chat = store.create('', 'agent');
  chat.title = s.title;
  chat.createdAt = s.createdAt;
  chat.messages = s.messages;
  chat.origin = s.source;
  store.save(chat, true);
  await store.flush(chat);
  return { session: chat, created: true };
}
