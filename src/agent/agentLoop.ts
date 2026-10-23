import * as vscode from 'vscode';
import { getConfig } from '../config';
import { ContextManager } from '../context/contextManager';
import { WorkspaceContext } from '../context/workspaceContext';
import { ProviderRegistry } from '../providers/registry';
import { ModelRole } from '../providers/catalog';
import { newId } from '../providers/http';
import { parseArgs, ToolRegistry } from '../tools/registry';
import { AgentEvent, ApprovalMode, ChatMessage, Session, Tool, ToolCall, ToolContext, ToolDefinition } from '../types';
import { ParallelPool } from './parallel';
import { buildSystemPrompt } from './prompts';
import { callKey, classifyModelError, describeModelError, isTransient, sleep, withWatchdog } from './resilience';
import { assessRequest, clarificationSteer, gatherRequestContext, hasContextBlocks, userText } from './clarify';
import { recommendSkills, SkillLearner, skillHint } from './skillRecommender';
import { SkillManager } from './skills';
import { ChangeTracker } from './changeTracker';
import { MemoryStore } from './memory';

export type ApprovalHandler = (title: string, detail: string, kind: NonNullable<Tool['approvalKind']>) => Promise<boolean>;

export interface AgentRunOptions {
  session: Session;
  /** The new user message to process (appended to the session). */
  userMessage: ChatMessage;
  modelRef?: string;
  /** Routing role for this run (subagents pass `fast` for read-only work). Defaults to agent / reasoning in Plan mode. */
  role?: ModelRole;
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
/** Transient model failures (network, 5xx/429, stall, empty completion) are retried this many times per step. */
const MAX_MODEL_RETRIES = 2;
const RETRY_BACKOFF_MS = [800, 2500];
/** Local models may need to load weights and prefill a long prompt before the first token. */
const FIRST_TOKEN_TIMEOUT_MS = 180_000;
/** Once streaming, this much silence means the server hung (a slow token is seconds, not a minute). */
const IDLE_TIMEOUT_MS = 90_000;
/** The same tool with the same arguments this many times in one turn is a loop, not progress. */
const MAX_IDENTICAL_CALLS = 3;
/** Queued requests wait for the ones ahead of them; the first-token budget grows with the queue, up to this. */
const FIRST_TOKEN_TIMEOUT_MAX_MS = 15 * 60_000;
/** "implement the plan", "run the checklist", "go ahead with it"… — the plan's checklist should now be executed. */
const IMPLEMENT_PLAN = /\b(implement|execute|run|start|apply|build|do|carry out|go ahead with|proceed with|kick off)\b[^.!?]{0,40}\b(plan|checklist|todos?|steps|items|tasks)\b|^\s*(go ahead|proceed|do it|go|make it so|implement|execute)[\s!.]*$/i;
/** A request that waited this long for its first token while another request on the same model finished first was queued server-side. */
const SERIAL_DETECT_MS = 8_000;

/** Drives the model ⇄ tools loop for one user turn. Safe to run concurrently for different sessions. */
export class AgentRunner {
  /** Sessions currently streaming from each model id — lets a waiting chat say *why* it is waiting (local servers serve one request per model at a time). */
  private readonly inflight = new Map<string, Set<string>>();
  /** When the last request to each model id finished — used to notice a server that answers one request at a time. */
  private readonly lastFinished = new Map<string, number>();
  /** Model ids already flagged as served serially, so the user is told once. */
  private readonly serialWarned = new Set<string>();
  /** Called once per model when concurrent requests are observed to queue at the server. */
  onSerialServer?: (model: { id: string; name: string; providerId: string }) => void;

  constructor(
    private readonly providers: ProviderRegistry,
    private readonly tools: ToolRegistry,
    private readonly skills: SkillManager,
    private readonly workspace: WorkspaceContext,
    private readonly log: vscode.LogOutputChannel,
    private readonly tracker?: ChangeTracker,
    private readonly memory?: MemoryStore,
    private readonly learner?: SkillLearner
  ) {}

  async run(o: AgentRunOptions): Promise<string> {
    const cfg = getConfig();
    const depth = o.depth ?? 0;
    const session = o.session;
    const emit = o.emit;
    const status = (text: string) => emit({ sessionId: session.id, type: 'status', payload: text });

    const route = await this.providers.route({
      role: o.role ?? (session.mode === 'plan' ? 'reasoning' : 'agent'),
      modelRef: o.modelRef ?? session.model,
      needsVision: !!o.userMessage.images?.length || session.messages.some((m) => m.role === 'user' && !!m.images?.length && Date.now() - (m.meta?.timestamp ?? 0) < 10 * 60_000),
    });
    const { provider, model } = route;
    if (route.reason) {
      status(route.reason);
    }
    // Keep the session on the user's chosen model when a turn was redirected (e.g. to a vision model); an
    // unavailable model is replaced for good so the picker reflects what is actually answering.
    if (!route.reason || route.fallback) {
      session.model = model.id;
    }

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

    // Vague request ("fix this", "make it faster")? Hand the model a snapshot of what the user is looking at and
    // working on so it resolves the target itself and states its interpretation, instead of guessing or stalling.
    if (depth === 0 && cfg.autoClarify && !o.roleOverride) {
      const assessment = assessRequest(o.userMessage.content, {
        hasAttachments: hasContextBlocks(o.userMessage.content),
        hasImages: !!o.userMessage.images?.length,
        hasSelection: this.workspace.hasSelection(),
        hasHistory: session.messages.some((m) => m.role === 'assistant' && !!m.content.trim()),
      });
      if (!assessment.clear) {
        status('Interpreting the request…');
        const snapshot = await gatherRequestContext(this.workspace, session);
        session.messages.push({ role: 'user', content: clarificationSteer(assessment, snapshot), meta: { timestamp: Date.now(), hidden: true } });
        emit({ sessionId: session.id, type: 'clarify', payload: { reasons: assessment.reasons } });
      }
    }

    // "Implement the plan": the checklist already holds delegable items, so make the fan-out the first step
    // instead of hoping the model remembers run_todos_parallel.
    if (depth === 0 && session.mode === 'agent' && !o.roleOverride) {
      const delegable = (session.todos ?? []).filter((t) => t.status === 'pending' && t.agent);
      if (delegable.length && isImplementPlanRequest(userText(o.userMessage.content))) {
        session.messages.push({
          role: 'user',
          content: `The checklist from the plan has ${delegable.length} pending item${delegable.length === 1 ? '' : 's'} with an agent (${delegable.map((t) => t.id).join(', ')}). Start by calling run_todos_parallel with no arguments — independent items run concurrently and dependent ones follow in later waves with their prerequisites' reports. Then integrate the results, verify the combined change (get_diagnostics / tests) and finish any remaining items yourself.`,
          meta: { timestamp: Date.now(), hidden: true },
        });
        status(`Executing the plan: ${delegable.length} item${delegable.length === 1 ? '' : 's'} as parallel subagents…`);
      }
    }

    // Skill recommendation: nudge the model towards a matching playbook and tell the UI; the learner also
    // notices recurring request types that no skill covers and proposes creating one.
    if (depth === 0 && !o.roleOverride && this.skills.allSkills.length) {
      try {
        const suggestions = this.learner ? await this.learner.observeRequest(o.userMessage.content, this.skills.allSkills) : { skills: recommendSkills(o.userMessage.content, this.skills.allSkills) };
        const loaded = new Set(session.messages.filter((m) => m.role === 'tool' && m.toolName === 'load_skill').map((m) => /<skill name="([^"]+)"/.exec(m.content)?.[1]));
        const fresh = suggestions.skills.filter((s) => !loaded.has(s.name));
        if (fresh.length && !/^\/skill\b|^Use the "/.test(userText(o.userMessage.content))) {
          session.messages.push({ role: 'user', content: skillHint(fresh), meta: { timestamp: Date.now(), hidden: true } });
        }
        if (fresh.length || suggestions.create) {
          emit({ sessionId: session.id, type: 'skill_suggestions', payload: { skills: fresh, create: suggestions.create } });
        }
      } catch (e) {
        this.log.warn(`skill recommendation failed: ${String(e)}`);
      }
    }

    const toolCtx: ToolContext = {
      sessionId: session.id,
      workspaceRoot: this.workspace.root,
      signal: o.signal,
      depth,
      modelRef: model.id,
      readOnly: session.mode !== 'agent',
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
    /** (tool, args) → how often it was requested this turn; repeats beyond MAX_IDENTICAL_CALLS are refused. */
    const callCounts = new Map<string, number>();
    let completed = false;

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
          budget = { ...budget, historyTokens: result.after };
        }
      }
      session.contextTokens = budget.historyTokens + budget.systemTokens + budget.toolsTokens;

      // --- Model call -----------------------------------------------------------------------
      const busy = this.inflight.get(model.id) ?? new Set<string>();
      const others = [...busy].filter((id) => id !== session.id).length;
      status(others ? `Waiting for ${model.name} — busy with ${others} other chat${others === 1 ? '' : 's'}…` : iter === 0 ? `Thinking with ${model.name}…` : `Continuing (${iter + 1})…`);
      emit({ sessionId: session.id, type: 'model_request', payload: { model: model.id, name: model.name, queued: others } });
      busy.add(session.id);
      this.inflight.set(model.id, busy);
      const assistant: ChatMessage = { role: 'assistant', content: '', toolCalls: [], meta: { timestamp: Date.now() } };
      let text = '';
      let thinking = '';
      const calls: ToolCall[] = [];
      // Transient failures (connection drops, 5xx, a stalled server, an empty completion) are retried a
      // couple of times before the user sees an error; a context-overflow reply compacts once and retries.
      let attempt = 0;
      let compactedForOverflow = false;
      let aborted = false;
      while (true) {
        text = '';
        thinking = '';
        calls.length = 0;
        const ac = new AbortController();
        const onAbort = () => ac.abort();
        o.signal.addEventListener('abort', onAbort, { once: true });
        let first = true;
        const requestedAt = Date.now();
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
            signal: ac.signal,
          });
          // A request queued behind `others` on a one-slot server legitimately waits for all of them: give it
          // their first-token budget too instead of calling it a stall and retrying (which only re-queues it).
          const guarded = withWatchdog(stream, {
            firstTokenMs: Math.min(FIRST_TOKEN_TIMEOUT_MS * (1 + others), FIRST_TOKEN_TIMEOUT_MAX_MS),
            idleMs: IDLE_TIMEOUT_MS,
            abort: () => ac.abort(),
            onWaiting: (s) => status(`${others ? `Waiting for ${model.name} — queued behind ${others} other request${others === 1 ? '' : 's'}` : `Waiting for ${model.name}`} · ${s}s${s >= 30 && !others ? ' (loading the model or a long prompt)' : ''}…`),
          });
          for await (const ev of guarded) {
            if (first && (ev.type === 'text' || ev.type === 'thinking' || ev.type === 'tool_call')) {
              first = false;
              emit({ sessionId: session.id, type: 'status', payload: ev.type === 'thinking' ? 'Thinking…' : 'Responding…' });
              this.noteFirstToken(model, others, requestedAt);
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
          o.signal.removeEventListener('abort', onAbort);
          if (o.signal.aborted) {
            aborted = true;
            break;
          }
          const kind = classifyModelError(e);
          const msg = e instanceof Error ? e.message : String(e);
          if (kind === 'overflow' && !compactedForOverflow) {
            // The server knows better than our estimate: shrink the history and send again.
            compactedForOverflow = true;
            this.log.warn(`model rejected the prompt as too long; compacting and retrying: ${msg}`);
            status('Prompt too long for the model — compacting and retrying…');
            session.messages = ctxMgr.pruneToolOutputs(session.messages, 0).messages;
            const result = await ctxMgr.compact(session.messages, provider, model, o.signal, 4);
            if (result.removed > 0) {
              session.messages = result.messages;
              session.compactions++;
              emit({ sessionId: session.id, type: 'compaction', payload: { before: result.before, after: result.after, removed: result.removed, summary: result.summary } });
            }
            continue;
          }
          if (isTransient(kind) && first && attempt < MAX_MODEL_RETRIES) {
            attempt++;
            const wait = RETRY_BACKOFF_MS[Math.min(attempt - 1, RETRY_BACKOFF_MS.length - 1)];
            this.log.warn(`model call failed (${kind}), retry ${attempt}/${MAX_MODEL_RETRIES} in ${wait}ms: ${msg}`);
            status(`${kind === 'stall' ? 'The model stopped responding' : kind === 'ratelimit' ? 'The server is rate limiting' : 'Connection to the model failed'} — retrying (${attempt}/${MAX_MODEL_RETRIES})…`);
            emit({ sessionId: session.id, type: 'retry', payload: { attempt, max: MAX_MODEL_RETRIES, reason: kind, message: msg } });
            await sleep(wait, o.signal);
            if (o.signal.aborted) {
              aborted = true;
              break;
            }
            continue;
          }
          this.release(model.id, session.id);
          this.log.error(`model call failed: ${msg}`);
          const friendly = describeModelError(kind, msg, model.name);
          emit({ sessionId: session.id, type: 'error', payload: friendly });
          session.messages.push({ role: 'assistant', content: text || `(error: ${friendly})`, meta: { timestamp: Date.now() } });
          const err = e instanceof Error ? e : new Error(msg);
          (err as Error & { reported?: boolean }).reported = true;
          throw err;
        }
        o.signal.removeEventListener('abort', onAbort);
        // A completion with neither text nor a tool call is a server hiccup far more often than an answer.
        if (!text.trim() && !calls.length && attempt < MAX_MODEL_RETRIES && !o.signal.aborted) {
          attempt++;
          this.log.warn(`empty completion from ${model.id}; retry ${attempt}/${MAX_MODEL_RETRIES}`);
          status(`The model returned nothing — asking again (${attempt}/${MAX_MODEL_RETRIES})…`);
          emit({ sessionId: session.id, type: 'retry', payload: { attempt, max: MAX_MODEL_RETRIES, reason: 'empty', message: 'empty completion' } });
          await sleep(RETRY_BACKOFF_MS[0], o.signal);
          continue;
        }
        break;
      }
      if (aborted) {
        this.release(model.id, session.id);
        break;
      }

      this.release(model.id, session.id);

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
        completed = true;
        break;
      }

      // --- Tool execution (parallel for read-only tools) ------------------------------------
      const results = await this.executeToolCalls(calls, toolList, toolCtx, pool, ctxMgr, emit, session.id, nativeTools, toolCache, model.supportsVision, callCounts);
      toolsExecuted += calls.length;
      for (const c of calls) {
        if (c.name === 'load_skill' && depth === 0) {
          const name = parseArgs(c.arguments).name;
          if (typeof name === 'string') {
            void this.learner?.recordSkillUsed(name);
          }
        }
      }
      session.messages.push(...results);
      this.trackWorkingSet(session, calls);
      session.updatedAt = Date.now();
    }

    if (!completed && !o.signal.aborted) {
      // Ran out of steps with tool results pending: say so instead of ending on a dangling tool call.
      const note = `Stopped after ${maxIter} model steps in one turn without reaching a final answer. Reply "continue" to carry on from here, or narrow the task.`;
      this.log.warn(`session ${session.id}: ${note}`);
      session.messages.push({ role: 'assistant', content: note, meta: { timestamp: Date.now() } });
      emit({ sessionId: session.id, type: 'assistant_delta', payload: note });
      finalText = finalText || note;
    }

    session.updatedAt = Date.now();
    emit({ sessionId: session.id, type: 'turn_end', payload: { text: finalText, contextTokens: session.contextTokens } });
    return finalText;
  }

  private release(modelId: string, sessionId: string): void {
    this.lastFinished.set(modelId, Date.now());
    const set = this.inflight.get(modelId);
    if (set) {
      set.delete(sessionId);
      if (!set.size) {
        this.inflight.delete(modelId);
      }
    }
  }

  /**
   * Heuristic for a server that serves one request per model at a time (Ollama's default `OLLAMA_NUM_PARALLEL`):
   * our request was queued behind others, waited a while, and only got its first token after one of them finished.
   */
  private noteFirstToken(model: { id: string; name: string; providerId: string }, others: number, requestedAt: number): void {
    if (!others || this.serialWarned.has(model.id)) {
      return;
    }
    const finished = this.lastFinished.get(model.id) ?? 0;
    const waited = Date.now() - requestedAt;
    if (finished > requestedAt && waited >= SERIAL_DETECT_MS) {
      this.serialWarned.add(model.id);
      this.log.warn(`${model.id} appears to serve one request at a time (first token after ${Math.round(waited / 1000)}s behind ${others} other request(s)); parallel subagents will queue`);
      this.onSerialServer?.(model);
    }
  }

  /** Model ids with a request in flight and the sessions using them (for the Agents view / tab tooltips). */
  get activeModelRequests(): { model: string; sessions: string[] }[] {
    return [...this.inflight].map(([model, set]) => ({ model, sessions: [...set] }));
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
    cache: Map<string, Promise<ChatMessage>>,
    vision = false,
    callCounts?: Map<string, number>
  ): Promise<ChatMessage[]> {
    const byName = new Map(available.map((t) => [t.definition.name, t]));
    // Images produced by tools (browser_screenshot) ride along in a user message, which every provider accepts.
    const captured: { callId: string; caption: string; data: string }[] = [];
    const execute = async (call: ToolCall, tool: Tool | undefined, args: Record<string, unknown>): Promise<{ msg: ChatMessage; isError: boolean }> => {
      const started = Date.now();
      let result = tool
        ? await this.tools.execute(call.name, args, ctx)
        : { content: `Tool "${call.name}" is not available in this mode. Available: ${[...byName.keys()].join(', ')}`, isError: true };
      if (ctx.signal.aborted) {
        result = { content: 'Cancelled by user.', isError: true };
      }
      const img = (result.data as { image?: { data?: string }; caption?: string } | undefined)?.image;
      let text = result.content ?? '';
      if (img?.data && !result.isError) {
        if (vision) {
          captured.push({ callId: call.id, caption: (result.data as { caption?: string }).caption ?? `Image from ${call.name}`, data: img.data });
        } else {
          text += ' Note: the current model cannot see images — the screenshot is shown to the user only. Switch to a vision model (gemma4, nemotron-3.5-bolt, qwen2.5vl) to inspect it, or use web_fetch for the page text.';
        }
      }
      const content = ctxMgr.clampToolOutput(text);
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
      if (callCounts) {
        const key = callKey(call.name, args);
        const n = (callCounts.get(key) ?? 0) + 1;
        callCounts.set(key, n);
        if (n > MAX_IDENTICAL_CALLS) {
          const content = `Refused: this exact call (${call.name} with the same arguments) has already been made ${n - 1} times this turn and would return the same result. Use the earlier result, change the arguments, or take a different approach — if you are finished, answer the user.`;
          emit({ sessionId, type: 'tool_end', payload: { id: call.id, name: call.name, isError: true, durationMs: 0, content } });
          return { role: 'tool', content: nativeTools ? content : `<tool_result name="${call.name}">\n${content}\n</tool_result>`, toolCallId: call.id, toolName: call.name, meta: { timestamp: Date.now() } };
        }
      }
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
    const imageMsg: ChatMessage | undefined = captured.length
      ? { role: 'user', content: captured.map((c) => `[${c.caption}]`).join('\n'), images: captured.map((c) => c.data), meta: { timestamp: Date.now(), toolImages: captured.map((c) => c.callId) } }
      : undefined;
    if (!nativeTools) {
      // Text protocol: tool results go back as a single user message (with any captured images attached to it).
      return [{ role: 'user', content: ordered.map((m) => m.content).join('\n\n'), images: imageMsg?.images, meta: { timestamp: Date.now(), toolImages: imageMsg?.meta?.toolImages } }];
    }
    return imageMsg ? [...ordered, imageMsg] : ordered;
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

/** True when the user is asking to execute the plan/checklist that is already in the session. */
export function isImplementPlanRequest(text: string): boolean {
  return IMPLEMENT_PLAN.test(text.trim());
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
