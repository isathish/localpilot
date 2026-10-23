import * as vscode from 'vscode';
import { getConfig } from '../config';
import { ContextManager } from '../context/contextManager';
import { estimateMessagesTokens } from '../context/tokenizer';
import { WorkspaceContext } from '../context/workspaceContext';
import { ProviderRegistry } from '../providers/registry';
import { newId } from '../providers/http';
import { parseArgs, ToolRegistry } from '../tools/registry';
import { AgentEvent, ApprovalMode, ChatMessage, Session, Tool, ToolCall, ToolContext, ToolDefinition } from '../types';
import { ParallelPool } from './parallel';
import { buildSystemPrompt } from './prompts';
import { SkillManager } from './skills';
import { ChangeTracker } from './changeTracker';
import { MemoryStore } from './memory';

export type ApprovalHandler = (title: string, detail: string, kind: NonNullable<Tool['approvalKind']>) => Promise<boolean>;

export interface AgentRunOptions {
  session: Session;
  /** The new user message to process (appended to the session). */
  userMessage: ChatMessage;
  modelRef?: string;
  /** Restrict tool set (subagents). */
  toolFilter?: string[];
  /** Replace the default persona (subagents). */
  roleOverride?: string;
  depth?: number;
  emit: (e: AgentEvent) => void;
  signal: AbortSignal;
  requestApproval: ApprovalHandler;
  maxIterations?: number;
}

const MAX_ITERATIONS_DEFAULT = 40;

/** Drives the model ⇄ tools loop for one user turn. Safe to run concurrently for different sessions. */
export class AgentRunner {
  constructor(
    private readonly providers: ProviderRegistry,
    private readonly tools: ToolRegistry,
    private readonly skills: SkillManager,
    private readonly workspace: WorkspaceContext,
    private readonly log: vscode.LogOutputChannel,
    private readonly tracker?: ChangeTracker,
    private readonly memory?: MemoryStore
  ) {}

  async run(o: AgentRunOptions): Promise<string> {
    const cfg = getConfig();
    const depth = o.depth ?? 0;
    const session = o.session;
    const emit = o.emit;
    const status = (text: string) => emit({ sessionId: session.id, type: 'status', payload: text });

    const { provider, model } = await this.providers.resolve(o.modelRef ?? session.model);
    session.model = model.id;

    const ctxMgr = new ContextManager({ compactionThreshold: cfg.compactionThreshold, maxToolOutputChars: cfg.maxToolOutputChars });
    const pool = new ParallelPool(cfg.parallel.maxConcurrency);

    const toolsEnabled = session.mode !== 'ask' || true; // ask mode still gets read-only tools
    const toolList = this.selectTools(session.mode, o.toolFilter);
    const nativeTools = model.supportsTools;
    const toolDefs: ToolDefinition[] = toolsEnabled ? toolList.map((t) => t.definition) : [];

    const system = await buildSystemPrompt({
      mode: session.mode,
      model,
      toolsEnabled,
      textToolProtocol: toolsEnabled && !nativeTools,
      skills: this.skills,
      workspace: this.workspace,
      append: cfg.systemPromptAppend,
      roleOverride: o.roleOverride,
      memory: cfg.memoryEnabled && depth === 0 ? await this.memory?.promptSection() : undefined,
      workingSet: session.workingSet,
      todos: session.todos,
    });
    const systemWithTextTools = !nativeTools && toolDefs.length ? `${system}\n\n# Tools\n${toolDefs.map((t) => `- ${t.name}: ${t.description}\n  parameters: ${JSON.stringify(t.parameters)}`).join('\n')}` : system;

    session.messages.push({ ...o.userMessage, meta: { ...o.userMessage.meta, timestamp: Date.now() } });

    const toolCtx: ToolContext = {
      sessionId: session.id,
      workspaceRoot: this.workspace.root,
      signal: o.signal,
      depth,
      progress: (t) => status(t),
      trackChange: (fsPath) => this.tracker?.beforeChange(fsPath, session.id) ?? Promise.resolve(),
      todos: {
        get: () => session.todos ?? [],
        set: (items) => {
          session.todos = items;
          emit({ sessionId: session.id, type: 'todos', payload: items });
        },
      },
      requestApproval: (title, detail, kind) => this.gateApproval(kind, cfg.approvals[kind], () => o.requestApproval(title, detail, kind), emit, session.id),
    };

    let finalText = '';
    const maxIter = o.maxIterations ?? MAX_ITERATIONS_DEFAULT;
    // Read-only tool results are memoised for the turn (including in-flight calls, so identical
    // parallel requests run once); any mutating tool clears the cache.
    const toolCache = new Map<string, Promise<ChatMessage>>();
    const think = cfg.thinking === 'off' ? undefined : cfg.thinking === 'on' ? true : cfg.thinking;
    let toolsExecuted = 0;
    let nudged = false;

    for (let iter = 0; iter < maxIter; iter++) {
      if (o.signal.aborted) {
        break;
      }

      // --- Context management ---------------------------------------------------------------
      let budget = ctxMgr.budget(model, systemWithTextTools, nativeTools ? toolDefs : [], session.messages, cfg.maxOutputTokens);
      if (ctxMgr.needsCompaction(budget)) {
        const pruned = ctxMgr.pruneToolOutputs(session.messages);
        if (pruned.saved > 0) {
          session.messages = pruned.messages;
          budget = ctxMgr.budget(model, systemWithTextTools, nativeTools ? toolDefs : [], session.messages, cfg.maxOutputTokens);
        }
      }
      if (ctxMgr.needsCompaction(budget)) {
        status('Compacting conversation to fit the context window…');
        const result = await ctxMgr.compact(session.messages, provider, model, o.signal);
        if (result.removed > 0) {
          session.messages = result.messages;
          session.compactions++;
          emit({ sessionId: session.id, type: 'compaction', payload: { before: result.before, after: result.after, removed: result.removed, summary: result.summary } });
        }
      }
      session.contextTokens = estimateMessagesTokens(session.messages) + budget.systemTokens + budget.toolsTokens;

      // --- Model call -----------------------------------------------------------------------
      status(iter === 0 ? `Thinking with ${model.name}…` : `Continuing (${iter + 1})…`);
      const assistant: ChatMessage = { role: 'assistant', content: '', toolCalls: [], meta: { timestamp: Date.now() } };
      let text = '';
      let thinking = '';
      const calls: ToolCall[] = [];
      try {
        const stream = provider.chat({
          model: model.modelId,
          messages: [{ role: 'system', content: systemWithTextTools }, ...session.messages.map(stripMeta)],
          tools: nativeTools && toolDefs.length ? toolDefs : undefined,
          temperature: cfg.temperature,
          maxTokens: cfg.maxOutputTokens,
          contextWindow: Math.min(model.contextWindow, Math.max(cfg.contextWindow, 4096)),
          think,
          keepAlive: cfg.keepAlive || undefined,
          signal: o.signal,
        });
        let first = true;
        for await (const ev of stream) {
          if (first && (ev.type === 'text' || ev.type === 'thinking' || ev.type === 'tool_call')) {
            first = false;
            emit({ sessionId: session.id, type: 'status', payload: ev.type === 'thinking' ? 'Thinking…' : 'Responding…' });
          }
          switch (ev.type) {
            case 'text':
              text += ev.text;
              emit({ sessionId: session.id, type: 'assistant_delta', payload: ev.text });
              break;
            case 'thinking':
              thinking += ev.text;
              emit({ sessionId: session.id, type: 'thinking_delta', payload: ev.text });
              break;
            case 'tool_call':
              calls.push(ev.call);
              break;
            case 'usage':
              if (ev.promptTokens) {
                session.contextTokens = ev.promptTokens + (ev.completionTokens ?? 0);
              }
              break;
          }
        }
      } catch (e) {
        if (o.signal.aborted) {
          break;
        }
        const msg = e instanceof Error ? e.message : String(e);
        this.log.error(`model call failed: ${msg}`);
        emit({ sessionId: session.id, type: 'error', payload: msg });
        session.messages.push({ role: 'assistant', content: text || `(error: ${msg})`, meta: { timestamp: Date.now() } });
        throw e;
      }

      // Models without native tool support emit tool calls as text. Small "tool-capable" models also
      // frequently print the call as bare JSON instead of using the tool channel, so fall back to
      // parsing text whenever no native call arrived — restricted to known tool names.
      if (toolDefs.length && !calls.length) {
        const parsed = extractTextToolCalls(text, nativeTools ? new Set(toolDefs.map((t) => t.name)) : undefined);
        if (parsed.calls.length) {
          calls.push(...parsed.calls);
          text = parsed.remainder;
        }
      }

      assistant.content = text;
      assistant.thinking = thinking || undefined;
      assistant.toolCalls = calls.length ? calls : undefined;
      session.messages.push(assistant);
      finalText = text;

      if (!calls.length) {
        // Small models sometimes answer "done" to an action request without doing anything. Once per
        // run, in agent mode, when nothing was executed and the reply is a bare claim, push back.
        if (session.mode === 'agent' && toolDefs.length && !nudged && toolsExecuted === 0 && depth === 0 && looksLikeBareClaim(text, o.userMessage.content)) {
          nudged = true;
          status('Verifying…');
          session.messages.push({
            role: 'user',
            content: 'You have not called any tools, so nothing has been done yet. If the request requires an action (creating or editing files, running commands), perform it now with the tools and only then report. If no action is needed, explain why in one or two sentences.',
            meta: { timestamp: Date.now(), hidden: true },
          });
          continue;
        }
        break;
      }

      // --- Tool execution (parallel for read-only tools) ------------------------------------
      const results = await this.executeToolCalls(calls, toolList, toolCtx, pool, ctxMgr, emit, session.id, nativeTools, toolCache);
      toolsExecuted += calls.length;
      session.messages.push(...results);
      this.trackWorkingSet(session, calls);
      session.updatedAt = Date.now();
    }

    session.updatedAt = Date.now();
    emit({ sessionId: session.id, type: 'turn_end', payload: { text: finalText, contextTokens: session.contextTokens } });
    return finalText;
  }

  private selectTools(mode: Session['mode'], filter?: string[]): Tool[] {
    let list = this.tools.list();
    if (filter) {
      const allowed = new Set(filter);
      list = list.filter((t) => allowed.has(t.definition.name));
    }
    if (mode !== 'agent') {
      // Read-only modes: strip mutating tools.
      list = list.filter((t) => !t.approvalKind || t.approvalKind === 'network');
    }
    return list;
  }

  private trackWorkingSet(session: Session, calls: ToolCall[]): void {
    const set = session.workingSet ?? [];
    for (const c of calls) {
      if (!/^(read_file|edit_file|write_file)$/.test(c.name)) {
        continue;
      }
      const p = parseArgs(c.arguments).path;
      if (typeof p !== 'string' || !p) {
        continue;
      }
      const rel = vscode.workspace.asRelativePath(p);
      const idx = set.indexOf(rel);
      if (idx >= 0) {
        set.splice(idx, 1);
      }
      set.push(rel);
    }
    session.workingSet = set.slice(-40);
  }

  private async executeToolCalls(
    calls: ToolCall[],
    available: Tool[],
    ctx: ToolContext,
    pool: ParallelPool,
    ctxMgr: ContextManager,
    emit: (e: AgentEvent) => void,
    sessionId: string,
    nativeTools: boolean,
    cache: Map<string, Promise<ChatMessage>>
  ): Promise<ChatMessage[]> {
    const byName = new Map(available.map((t) => [t.definition.name, t]));
    const execute = async (call: ToolCall, tool: Tool | undefined, args: Record<string, unknown>): Promise<{ msg: ChatMessage; isError: boolean }> => {
      const started = Date.now();
      let result = tool
        ? await this.tools.execute(call.name, args, ctx)
        : { content: `Tool "${call.name}" is not available in this mode. Available: ${[...byName.keys()].join(', ')}`, isError: true };
      if (ctx.signal.aborted) {
        result = { content: 'Cancelled by user.', isError: true };
      }
      const content = ctxMgr.clampToolOutput(result.content ?? '');
      emit({ sessionId, type: 'tool_end', payload: { id: call.id, name: call.name, isError: result.isError, durationMs: Date.now() - started, content, data: result.data } });
      return {
        msg: { role: 'tool', content: nativeTools ? content : `<tool_result name="${call.name}">\n${content}\n</tool_result>`, toolCallId: call.id, toolName: call.name, meta: { timestamp: Date.now() } },
        isError: !!result.isError,
      };
    };
    const runOne = async (call: ToolCall): Promise<ChatMessage> => {
      const args = parseArgs(call.arguments);
      const tool = byName.get(call.name);
      emit({ sessionId, type: 'tool_start', payload: { id: call.id, name: call.name, args } });
      const cacheKey = tool?.parallelSafe ? `${call.name}:${JSON.stringify(args)}` : undefined;
      if (cacheKey) {
        const inflight = cache.get(cacheKey);
        if (inflight) {
          const hit = await inflight;
          emit({ sessionId, type: 'tool_end', payload: { id: call.id, name: call.name, isError: false, durationMs: 0, content: hit.content, cached: true } });
          return { ...hit, toolCallId: call.id, meta: { timestamp: Date.now() } };
        }
        const p = execute(call, tool, args).then((r) => {
          if (r.isError) {
            cache.delete(cacheKey);
          }
          return r.msg;
        });
        cache.set(cacheKey, p);
        return p;
      }
      cache.clear();
      return (await execute(call, tool, args)).msg;
    };

    // Parallel-safe tools run concurrently; mutating tools run sequentially in order, after reads.
    const parallel = calls.filter((c) => byName.get(c.name)?.parallelSafe);
    const serial = calls.filter((c) => !byName.get(c.name)?.parallelSafe);
    const results = new Map<string, ChatMessage>();
    const settled = await pool.map(parallel, runOne);
    settled.forEach((r, i) => {
      const call = parallel[i];
      results.set(call.id, r.status === 'fulfilled' ? r.value : { role: 'tool', content: `Tool failed: ${String(r.reason)}`, toolCallId: call.id, toolName: call.name });
    });
    for (const call of serial) {
      results.set(call.id, await runOne(call));
    }
    // Preserve the model's original call order in the transcript.
    const ordered = calls.map((c) => results.get(c.id)!);
    if (!nativeTools) {
      // Text protocol: tool results go back as a single user message.
      return [{ role: 'user', content: ordered.map((m) => m.content).join('\n\n'), meta: { timestamp: Date.now() } }];
    }
    return ordered;
  }

  private async gateApproval(kind: NonNullable<Tool['approvalKind']>, mode: ApprovalMode, ask: () => Promise<boolean>, emit: (e: AgentEvent) => void, sessionId: string): Promise<boolean> {
    if (mode === 'always') {
      return true;
    }
    if (mode === 'never') {
      return false;
    }
    emit({ sessionId, type: 'approval_request', payload: { kind } });
    return ask();
  }
}

function stripMeta(m: ChatMessage): ChatMessage {
  const { meta: _meta, thinking: _thinking, ...rest } = m;
  return rest;
}

/** A short, code-free reply to an imperative request that reads like "done" rather than an explanation or a question. */
export function looksLikeBareClaim(reply: string, request: string): boolean {
  const r = reply.trim();
  if (!r || r.length > 240 || r.includes('```') || /\?\s*$/.test(r)) {
    return false;
  }
  const imperative = /\b(create|write|add|edit|fix|update|change|rename|delete|remove|run|install|refactor|implement|make|generate|replace|move|save)\b/i.test(request);
  const claim = /\b(done|fixed|created|written|added|updated|completed|finished|implemented|saved|removed|deleted|changed|greeted|ok)\b/i.test(r);
  return imperative && claim;
}

/**
 * Parses tool calls out of free text: ```tool_call / ```json fenced blocks, <tool_call>…</tool_call> tags,
 * and bare `{"name": …, "arguments": …}` objects. When `known` is given, only those tool names count.
 */
export function extractTextToolCalls(text: string, known?: ReadonlySet<string>): { calls: ToolCall[]; remainder: string } {
  const calls: ToolCall[] = [];
  let remainder = text;
  const accept = (raw: string, json: string): void => {
    try {
      const obj = JSON.parse(json) as { name?: string; arguments?: unknown; parameters?: unknown };
      if (obj && typeof obj.name === 'string' && (!known || known.has(obj.name))) {
        const args = obj.arguments ?? obj.parameters ?? {};
        calls.push({ id: newId(), name: obj.name, arguments: typeof args === 'string' ? args : JSON.stringify(args) });
        remainder = remainder.replace(raw, '');
      }
    } catch {
      /* not a tool call */
    }
  };
  const re = /```(?:tool_call|json)?\s*\n?(\{[\s\S]*?\})\s*```|<tool_call>\s*(\{[\s\S]*?\})\s*<\/tool_call>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    accept(m[0], m[1] ?? m[2]);
  }
  if (!calls.length) {
    for (const obj of bareJsonObjects(text)) {
      accept(obj, obj);
    }
  }
  return { calls, remainder: remainder.trim() };
}

/** Balanced top-level `{ "name": … }` objects found anywhere in `text` (string-aware brace matching). */
function bareJsonObjects(text: string): string[] {
  const out: string[] = [];
  const start = /\{\s*"name"\s*:/g;
  let m: RegExpExecArray | null;
  while ((m = start.exec(text))) {
    let depth = 0;
    let inStr = false;
    for (let i = m.index; i < text.length; i++) {
      const ch = text[i];
      if (inStr) {
        if (ch === '\\') {
          i++;
        } else if (ch === '"') {
          inStr = false;
        }
      } else if (ch === '"') {
        inStr = true;
      } else if (ch === '{') {
        depth++;
      } else if (ch === '}' && --depth === 0) {
        out.push(text.slice(m.index, i + 1));
        start.lastIndex = i + 1;
        break;
      }
    }
  }
  return out;
}
