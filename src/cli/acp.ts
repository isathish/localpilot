import * as readline from 'readline';
import { AgentEvent, ALL_MODES, ApprovalDecision, ApprovalOptions, Session, TodoItem } from '../types';

/**
 * `localpilot --acp`: the agent behind the Agent Client Protocol (JSON-RPC 2.0, one message per line on stdio), so
 * Zed, JetBrains IDEs and Neovim plugins can drive LocalPilot like any ACP agent. Supported: `initialize`,
 * `authenticate` (nothing to do), `session/new`, `session/load` (replays a saved chat), `session/prompt`,
 * `session/cancel`, `session/set_mode`, `session/set_model` and `session/set_config_option` (mode, model). Runs stream
 * back as `session/update` notifications; approvals become `session/request_permission` requests. Nothing is
 * approved without asking the client unless the user chose "always" for that kind in the session.
 */

export const ACP_PROTOCOL_VERSION = 1;

type ApprovalKind = 'terminal' | 'write' | 'delete' | 'network' | 'mcp';

/**
 * Pure: setting overrides for `--acp` without `--yes`, so every approval goes to the client: each kind asks (one set to
 * `never` stays refused) and no auto-mode reviewer answers for the user. Organization-policy floors still apply on top.
 */
export function acpApprovalOverrides(approvals: Record<ApprovalKind, string>): Record<string, unknown> {
  const out: Record<string, unknown> = { 'autoMode.enabled': false };
  for (const k of ['terminal', 'write', 'delete', 'network', 'mcp'] as const) {
    out[`approvals.${k}`] = approvals[k] === 'never' ? 'never' : 'ask';
  }
  return out;
}

export interface AcpRunRequest {
  session: Session;
  text: string;
  images: string[];
  cwd: string;
  signal: AbortSignal;
  /** Stops the run (session/cancel). */
  stop: () => void;
  emit(e: AgentEvent): void;
  requestApproval(title: string, detail: string, kind: ApprovalKind, opts?: ApprovalOptions): Promise<boolean | ApprovalDecision>;
}

/** What the server needs from the CLI: chats, models and the agent loop. */
export interface AcpHost {
  version: string;
  newSession(cwd: string): Promise<Session>;
  loadSession(id: string, cwd: string): Promise<Session | undefined>;
  models(): Promise<{ id: string; name: string }[]>;
  defaultModel(): string;
  /** Runs one turn; resolves the final answer. Rejects when the run fails before it starts. */
  run(r: AcpRunRequest): Promise<{ text: string; completed: boolean; error?: { message: string; kind?: string } }>;
  /** The CLI's `--yes`: approve without asking the client. */
  autoApprove?(): boolean;
}

interface Live {
  session: Session;
  cwd: string;
  running?: { stop: () => void; cancelled: boolean };
  /** Kinds the user chose "Always allow" for in this session. */
  always: Set<string>;
  /** Tool calls started and not yet finished, oldest first (approvals belong to the newest). */
  open: string[];
  /** Answer text sent in this prompt so far (the self-healing footer is sent at turn_end when it was not). */
  streamed?: string;
}

type Json = Record<string, unknown>;

const MODE_INFO: Record<string, { name: string; description: string }> = {
  agent: { name: 'Agent', description: 'Reads, edits and runs commands to finish the task' },
  multitask: { name: 'Multitask', description: 'Splits the task and hands the pieces to background workers' },
  debug: { name: 'Debug', description: 'Reproduces the bug, fixes its cause and proves the fix' },
  plan: { name: 'Plan', description: 'Read-only: investigates and writes a plan' },
  ask: { name: 'Ask', description: 'Read-only: answers questions about the code' },
};

/** Pure: the ACP tool kind of a LocalPilot tool. */
export function toolKind(name: string): 'read' | 'edit' | 'delete' | 'move' | 'search' | 'execute' | 'think' | 'fetch' | 'other' {
  if (/^(read_file|read_pdf|list_dir|get_editor_state|gather_context|mcp_read_resource|memory_read|load_skill)$/.test(name)) {
    return 'read';
  }
  if (/^(edit_file|write_file|apply_patch|notebook_edit|create_directory|memory_save)$/.test(name)) {
    return 'edit';
  }
  if (name === 'delete_path') {
    return 'delete';
  }
  if (/^(grep_search|file_search|find_symbol|find_references|repo_graph|analyze_workspace|web_search)$/.test(name)) {
    return 'search';
  }
  if (/^(run_command|git_\w+|pull_request|ci_status|repos|schedule)$/.test(name)) {
    return 'execute';
  }
  if (/^(web_fetch|browser_\w+)$/.test(name)) {
    return 'fetch';
  }
  if (/^(manage_todos|run_subagent|run_parallel_subagents|run_todos_parallel)$/.test(name)) {
    return 'think';
  }
  return 'other';
}

/** Pure: a short title for a tool call. */
export function toolTitle(name: string, args: Json): string {
  const s = (v: unknown, n = 80) => {
    const t = typeof v === 'string' ? v : JSON.stringify(v ?? '');
    return t.length > n ? `${t.slice(0, n - 1)}…` : t;
  };
  switch (name) {
    case 'read_file': return `Read ${s(args.path ?? (Array.isArray(args.files) ? `${args.files.length} files` : ''))}`;
    case 'edit_file': return `Edit ${s(args.path)}`;
    case 'write_file': return `Write ${s(args.path)}`;
    case 'delete_path': return `Delete ${s(args.path)}`;
    case 'list_dir': return `List ${s(args.path || '.')}`;
    case 'grep_search': return `Search "${s(args.query, 60)}"`;
    case 'file_search': return `Find files ${s(args.pattern)}`;
    case 'run_command': return `$ ${s(args.command, 100)}`;
    case 'web_fetch': return `Fetch ${s(args.url)}`;
    case 'web_search': return `Web search "${s(args.query, 60)}"`;
    case 'run_subagent': return `Subagent ${s(args.agent, 30)}: ${s(args.prompt, 60)}`;
    default: return name;
  }
}

/** Pure: the user's prompt from ACP content blocks — text, embedded resources as file blocks, links, images. */
export function promptFromBlocks(blocks: unknown): { text: string; images: string[] } {
  const parts: string[] = [];
  const images: string[] = [];
  for (const b of Array.isArray(blocks) ? (blocks as Json[]) : []) {
    if (!b || typeof b !== 'object') {
      continue;
    }
    if (b.type === 'text' && typeof b.text === 'string') {
      parts.push(b.text);
    } else if (b.type === 'image' && typeof b.data === 'string') {
      images.push(b.data);
    } else if (b.type === 'resource' && b.resource && typeof b.resource === 'object') {
      const r = b.resource as Json;
      const where = String(r.uri ?? '').replace(/^file:\/\//, '');
      if (typeof r.text === 'string') {
        parts.push(`<file path="${where}">\n${r.text}\n</file>`);
      } else {
        parts.push(`@${where}`);
      }
    } else if (b.type === 'resource_link' && typeof b.uri === 'string') {
      parts.push(`@${decodeURIComponent(b.uri.replace(/^file:\/\//, ''))}`);
    }
  }
  return { text: parts.join('\n\n').trim(), images };
}

const toolText = (s: string) => (s.length > 8000 ? `${s.slice(0, 8000)}\n… (${s.length - 8000} more characters)` : s);

export class AcpServer {
  private readonly sessions = new Map<string, Live>();
  private nextId = 1;
  private readonly pending = new Map<number, (r: { result?: unknown; error?: unknown }) => void>();

  constructor(private readonly host: AcpHost, private readonly write: (line: string) => void) {}

  private send(msg: Json): void {
    this.write(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`);
  }

  private notify(method: string, params: Json): void {
    this.send({ method, params });
  }

  private update(sessionId: string, update: Json): void {
    this.notify('session/update', { sessionId, update });
  }

  /** A request to the client; resolves its result (rejects on a JSON-RPC error). */
  request(method: string, params: Json): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, (r) => (r.error ? reject(new Error(String((r.error as Json).message ?? 'error'))) : resolve(r.result)));
      this.send({ id, method, params });
    });
  }

  /** One line from the client. Requests are answered asynchronously, so a prompt can wait on a permission reply. */
  async handle(line: string): Promise<void> {
    if (!line.trim()) {
      return;
    }
    let msg: Json;
    try {
      msg = JSON.parse(line) as Json;
    } catch {
      this.send({ id: null, error: { code: -32700, message: 'Parse error' } });
      return;
    }
    if (msg.method === undefined && msg.id !== undefined) {
      this.pending.get(Number(msg.id))?.({ result: msg.result, error: msg.error });
      this.pending.delete(Number(msg.id));
      return;
    }
    const method = String(msg.method ?? '');
    const params = (msg.params ?? {}) as Json;
    const isRequest = msg.id !== undefined && msg.id !== null;
    try {
      const result = await this.dispatch(method, params);
      if (isRequest) {
        this.send({ id: msg.id, result: result ?? null });
      }
    } catch (e) {
      const err = e as Error & { code?: number };
      if (isRequest) {
        this.send({ id: msg.id, error: { code: err.code ?? -32603, message: err.message } });
      }
    }
  }

  private fail(code: number, message: string): never {
    throw Object.assign(new Error(message), { code });
  }

  private live(params: Json): Live {
    const s = this.sessions.get(String(params.sessionId ?? ''));
    return s ?? this.fail(-32602, `Unknown session "${String(params.sessionId)}"`);
  }

  private async dispatch(method: string, params: Json): Promise<unknown> {
    switch (method) {
      case 'initialize':
        return {
          protocolVersion: ACP_PROTOCOL_VERSION,
          agentCapabilities: { loadSession: true, promptCapabilities: { image: true, audio: false, embeddedContext: true }, mcpCapabilities: { http: false, sse: false } },
          authMethods: [],
          agentInfo: { name: 'localpilot', title: 'LocalPilot', version: this.host.version },
        };
      case 'authenticate':
        return {};
      case 'session/new': {
        const cwd = String(params.cwd ?? process.cwd());
        const session = await this.host.newSession(cwd);
        this.sessions.set(session.id, { session, cwd, always: new Set(), open: [] });
        return { sessionId: session.id, ...(await this.sessionState(session)) };
      }
      case 'session/load': {
        const cwd = String(params.cwd ?? process.cwd());
        const id = String(params.sessionId ?? '');
        const session = this.sessions.get(id)?.session ?? (await this.host.loadSession(id, cwd));
        if (!session) {
          this.fail(-32602, `No saved session "${id}" for ${cwd}`);
        }
        this.sessions.set(session.id, { session, cwd, always: new Set(), open: [] });
        this.replay(session);
        return this.sessionState(session);
      }
      case 'session/set_mode':
        this.setMode(this.live(params), String(params.modeId ?? ''));
        return {};
      case 'session/set_model':
        this.live(params).session.model = String(params.modelId ?? '');
        return {};
      case 'session/set_config_option': {
        const l = this.live(params);
        const id = String(params.configId ?? '');
        if (id === 'mode') {
          this.setMode(l, String(params.value ?? ''));
        } else if (id === 'model') {
          l.session.model = String(params.value ?? '');
        } else {
          this.fail(-32602, `Unknown config option "${id}"`);
        }
        return { configOptions: (await this.sessionState(l.session)).configOptions };
      }
      case 'session/prompt':
        return this.prompt(this.live(params), params.prompt);
      case 'session/cancel': {
        const l = this.sessions.get(String(params.sessionId ?? ''));
        if (l?.running) {
          l.running.cancelled = true;
          l.running.stop();
        }
        return undefined;
      }
    }
    return this.fail(-32601, `Method not found: ${method}`);
  }

  private setMode(l: Live, mode: string): void {
    if (!(ALL_MODES as readonly string[]).includes(mode)) {
      this.fail(-32602, `Unknown mode "${mode}" (${ALL_MODES.join(', ')})`);
    }
    l.session.mode = mode as Session['mode'];
    this.update(l.session.id, { sessionUpdate: 'current_mode_update', currentModeId: mode });
  }

  private async sessionState(s: Session): Promise<Json> {
    const models = await this.host.models().catch(() => []);
    const current = s.model || this.host.defaultModel();
    const modes = ALL_MODES.map((id) => ({ id, ...MODE_INFO[id] }));
    return {
      modes: { currentModeId: s.mode, availableModes: modes },
      models: { currentModelId: current, availableModels: models.map((m) => ({ modelId: m.id, name: m.name })) },
      configOptions: [
        { id: 'mode', name: 'Mode', type: 'select', currentValue: s.mode, options: modes.map((m) => ({ value: m.id, name: m.name, description: m.description })) },
        { id: 'model', name: 'Model', type: 'select', currentValue: current, options: models.map((m) => ({ value: m.id, name: m.name })) },
      ],
    };
  }

  /** `session/load`: the saved conversation as updates, so the client shows it before the next prompt. */
  private replay(s: Session): void {
    for (const m of s.messages) {
      if (m.meta?.hidden || m.meta?.summary || m.meta?.toolImages || m.meta?.toolResults) {
        continue;
      }
      if (m.role === 'user' && (m.meta?.display ?? m.content).trim()) {
        this.update(s.id, { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: m.meta?.display ?? m.content } });
      } else if (m.role === 'assistant') {
        if (m.content.trim()) {
          this.update(s.id, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: m.content } });
        }
        for (const c of m.toolCalls ?? []) {
          let args: Json = {};
          try {
            args = JSON.parse(c.arguments) as Json;
          } catch {
            /* keep empty */
          }
          this.update(s.id, { sessionUpdate: 'tool_call', toolCallId: c.id, title: toolTitle(c.name, args), kind: toolKind(c.name), status: 'completed', rawInput: args });
        }
      } else if (m.role === 'tool' && m.toolCallId) {
        this.update(s.id, { sessionUpdate: 'tool_call_update', toolCallId: m.toolCallId, status: m.meta?.failed ? 'failed' : 'completed', content: [{ type: 'content', content: { type: 'text', text: toolText(m.content) } }] });
      }
    }
  }

  /** The client went away: pending permission requests are refused and running prompts stopped. */
  close(): void {
    for (const [id, settle] of this.pending) {
      settle({ error: { message: 'client disconnected' } });
      this.pending.delete(id);
    }
    for (const l of this.sessions.values()) {
      l.running?.stop();
    }
  }

  /** The newest running session: subagents' approvals (asked outside a run's own callback) go to its client. */
  activeSessionId(): string | undefined {
    return [...this.sessions.values()].reverse().find((l) => l.running)?.session.id;
  }

  /** Asks the client to allow an action; "always" is remembered for the session (never for deletes). */
  async approve(sessionId: string, title: string, detail: string, kind: ApprovalKind, opts?: ApprovalOptions): Promise<boolean | ApprovalDecision> {
    const l = this.sessions.get(sessionId);
    if (!l) {
      return false;
    }
    const mandatory = !!opts?.mandatory;
    if (!mandatory && (l.always.has(kind) || this.host.autoApprove?.())) {
      return true;
    }
    const rememberable = !mandatory && kind !== 'delete' && !/destructive/i.test(title);
    const toolCallId = l.open[l.open.length - 1] ?? `approval-${this.nextId}`;
    let res: Json;
    try {
      res = (await this.request('session/request_permission', {
        sessionId,
        toolCall: { toolCallId, title, kind: kind === 'terminal' ? 'execute' : kind === 'write' ? 'edit' : kind === 'delete' ? 'delete' : kind === 'network' ? 'fetch' : 'other', status: 'pending', content: detail ? [{ type: 'content', content: { type: 'text', text: toolText(detail) } }] : [] },
        options: [
          { optionId: 'allow_once', name: 'Allow', kind: 'allow_once' },
          ...(rememberable ? [{ optionId: 'allow_always', name: `Always allow ${kind === 'terminal' ? 'commands' : kind === 'write' ? 'edits' : kind} in this session`, kind: 'allow_always' }] : []),
          { optionId: 'reject_once', name: 'Reject', kind: 'reject_once' },
        ],
      })) as Json;
    } catch {
      return false;
    }
    const outcome = (res?.outcome ?? {}) as Json;
    if (outcome.outcome !== 'selected') {
      return false;
    }
    if (outcome.optionId === 'allow_always' && rememberable) {
      l.always.add(kind);
      return true;
    }
    return outcome.optionId === 'allow_once' || outcome.optionId === 'allow_always' ? true : { ok: false };
  }

  private async prompt(l: Live, blocks: unknown): Promise<Json> {
    if (l.running) {
      this.fail(-32000, 'A prompt is already running in this session; cancel it first (session/cancel).');
    }
    const { text, images } = promptFromBlocks(blocks);
    if (!text && !images.length) {
      this.fail(-32602, 'The prompt is empty.');
    }
    const ctl = new AbortController();
    const running = { stop: () => ctl.abort(), cancelled: false };
    l.running = running;
    l.open = [];
    l.streamed = '';
    const sid = l.session.id;
    let failed: { message: string; kind?: string } | undefined;
    try {
      const r = await this.host.run({
        session: l.session,
        text,
        images,
        cwd: l.cwd,
        signal: ctl.signal,
        stop: running.stop,
        requestApproval: (title, detail, kind, opts) => this.approve(sid, title, detail, kind, opts),
        emit: (e) => this.onEvent(l, e),
      });
      failed = r.error;
      if (running.cancelled || ctl.signal.aborted) {
        return { stopReason: 'cancelled' };
      }
      if (failed) {
        this.update(sid, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `\n\n**Error:** ${failed.message}` } });
        return { stopReason: failed.kind === 'mistake_limit' ? 'max_turn_requests' : 'end_turn' };
      }
      return { stopReason: r.completed ? 'end_turn' : 'max_turn_requests' };
    } finally {
      l.running = undefined;
      for (const id of l.open) {
        this.update(sid, { sessionUpdate: 'tool_call_update', toolCallId: id, status: 'failed' });
      }
      l.open = [];
    }
  }

  private onEvent(l: Live, e: AgentEvent): void {
    const sid = l.session.id;
    const p = (e.payload && typeof e.payload === 'object' ? e.payload : {}) as Json;
    if (p.childId) {
      return;
    }
    switch (e.type) {
      case 'assistant_delta':
        l.streamed = (l.streamed ?? '') + String(e.payload ?? '');
        this.update(sid, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: String(e.payload ?? '') } });
        return;
      case 'turn_end': {
        // The self-healing footer (Verified / Not verified / Incomplete) is appended to the answer, not streamed.
        const report = (p.recovery as { report?: unknown } | undefined)?.report;
        if (typeof report === 'string' && report && !(l.streamed ?? '').includes(report)) {
          this.update(sid, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `\n\n${report}` } });
        }
        return;
      }
      case 'thinking_delta':
        this.update(sid, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: String(e.payload ?? '') } });
        return;
      case 'tool_start': {
        const id = String(p.id);
        const args = (p.args ?? {}) as Json;
        l.open.push(id);
        this.update(sid, { sessionUpdate: 'tool_call', toolCallId: id, title: toolTitle(String(p.name), args), kind: toolKind(String(p.name)), status: 'pending', rawInput: args, ...(typeof args.path === 'string' ? { locations: [{ path: args.path }] } : {}) });
        return;
      }
      case 'tool_progress':
        if (l.open.includes(String(p.id))) {
          this.update(sid, { sessionUpdate: 'tool_call_update', toolCallId: String(p.id), status: 'in_progress' });
        }
        return;
      case 'tool_end': {
        const id = String(p.id);
        l.open = l.open.filter((x) => x !== id);
        this.update(sid, { sessionUpdate: 'tool_call_update', toolCallId: id, status: p.isError ? 'failed' : 'completed', content: [{ type: 'content', content: { type: 'text', text: toolText(String(p.content ?? '')) } }] });
        return;
      }
      case 'todos': {
        const todos = Array.isArray(e.payload) ? (e.payload as TodoItem[]) : [];
        this.update(sid, { sessionUpdate: 'plan', entries: todos.map((t) => ({ content: t.title, priority: 'medium', status: t.status === 'done' || t.status === 'skipped' ? 'completed' : t.status === 'in_progress' ? 'in_progress' : 'pending' })) });
        return;
      }
    }
  }
}

/** Serves ACP on `input`/`output` until the input ends. */
export function serveAcp(host: AcpHost, input: NodeJS.ReadableStream = process.stdin, output: NodeJS.WritableStream = process.stdout): { server: AcpServer; done: Promise<void> } {
  const server = new AcpServer(host, (line) => output.write(line));
  const rl = readline.createInterface({ input, terminal: false });
  const inflight = new Set<Promise<void>>();
  rl.on('line', (line) => {
    const p = server.handle(line).finally(() => inflight.delete(p));
    inflight.add(p);
  });
  const done = new Promise<void>((resolve) => rl.on('close', () => {
    server.close();
    void Promise.allSettled([...inflight]).then(() => resolve());
  }));
  return { server, done };
}
