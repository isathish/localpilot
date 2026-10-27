import * as vscode from 'vscode';
import { getConfig } from '../config';
import { ContextManager, effectiveContextWindow } from '../context/contextManager';
import { WorkspaceContext } from '../context/workspaceContext';
import { ProviderRegistry, ModelLoad } from '../providers/registry';
import { ModelRole } from '../providers/catalog';
import { streamsFromDisk } from '../providers/colibri';
import { getSystemProfile } from '../providers/system';
import { newId } from '../providers/http';
import { parseArgs, ToolRegistry } from '../tools/registry';
import { AgentEvent, ApprovalMode, ChatMessage, ModelInfo, Session, Tool, ToolCall, ToolContext, ToolDefinition, isWriteMode } from '../types';
import { ParallelPool } from './parallel';
import { buildSystemPrompt } from './prompts';
import { callKey, classifyModelError, describeModelError, isTransient, sleep, withWatchdog } from './resilience';
import { assessRequest, clarificationSteer, gatherRequestContext, hasContextBlocks, userText } from './clarify';
import { clampSkillBody, namesTool, PreloadReason, recommendSkills, SkillLearner, skillHint, SkillMatch, skillPreloadNote } from './skillRecommender';
import { RunControl } from './runControl';
import { SkillCatalog } from './skillCatalog';
import { skillsDestination } from './skillInstaller';
import { SkillManager } from './skills';
import { ChangeTracker } from './changeTracker';
import { MemoryStore } from './memory';
import { RunStats, Telemetry } from '../telemetry/telemetry';
import { HookRunner } from './hooks';
import { canonicalToolName, claudeToolInput, defaultModeDecision, evaluatePermission, fromClaudeToolInput, toolNames } from './permissions';
import { emptySettings, ProjectSettings } from './settings';

export type ApprovalHandler = (title: string, detail: string, kind: NonNullable<Tool['approvalKind']>) => Promise<boolean>;

/** Per-run permission/hook policy handed to tool execution. */
interface ToolPolicy {
  settings: ProjectSettings;
  /** Extra allow rules for this run (a slash command's `allowed-tools`). */
  extraAllow: string[];
  hooks?: HookRunner;
  root?: string;
  sessionId: string;
  /** Asks the user regardless of the approval settings (an `ask` rule or hook verdict). */
  ask: ApprovalHandler;
  signal: AbortSignal;
}

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
  /** Skills to preload into this run (subagents inherit the parent's active skills plus their agent file's `skills:`). */
  skills?: string[];
  /** Folder the tools operate in (an isolated worktree); defaults to the workspace root. */
  workspaceRoot?: string;
  depth?: number;
  emit: (e: AgentEvent) => void;
  signal: AbortSignal;
  requestApproval: ApprovalHandler;
  maxIterations?: number;
  /** Pause/resume/steer handle. When given, `signal` should be `control.signal`. */
  control?: RunControl;
  /** Transient-failure retries per model step (default 2). Subagents on a router-chosen model use 0 so a dead model fails fast and the caller can fall back. */
  maxModelRetries?: number;
  /** First-token watchdog for this run (default 180 s, scaled by queue depth). Shorter for router-chosen subagent models, which have a fallback. */
  firstTokenTimeoutMs?: number;
  /**
   * The model was not the user's explicit choice (Auto, or inherited from a parent): when it is saturated the router
   * may run this on a comparable idle model instead so parallel work really runs in parallel. Default: Auto chats
   * (no session model) and every subagent.
   */
  spreadModels?: boolean;
  /** Permission rules allowed for this run only (a custom slash command's `allowed-tools`). */
  permissionAllow?: string[];
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
/**
 * colibri prefills at a few tokens per second and, streaming experts from disk, decodes a token every few seconds when
 * cold: a long first-token wait and long gaps are progress there, not a stall. Multipliers for the watchdog limits.
 */
export function watchdogFor(model: Pick<ModelInfo, 'runtime' | 'diskGb'>, budgetGb: number | undefined): { first: number; idle: number } {
  if (model.runtime !== 'colibri') {
    return { first: 1, idle: 1 };
  }
  return streamsFromDisk(model, budgetGb) ? { first: 4, idle: 4 } : { first: 2, idle: 2 };
}
/** "implement the plan", "run the checklist", "go ahead with it"… — the plan's checklist should now be executed. */
const IMPLEMENT_PLAN = /\b(implement|execute|run|start|apply|build|do|carry out|go ahead with|proceed with|kick off)\b[^.!?]{0,40}\b(plan|checklist|todos?|steps|items|tasks)\b|^\s*(go ahead|proceed|do it|go|make it so|implement|execute)[\s!.]*$/i;
/** A request that waited this long for its first token while another request on the same model finished first was queued server-side. */
const SERIAL_DETECT_MS = 8_000;
/** Tools that hand work to subagents; running one is work done, and a later re-announcement of it is stale. */
const DELEGATION_TOOLS = new Set(['run_subagent', 'run_parallel_subagents', 'run_todos_parallel']);
/** Up to this many words a request is "brief": its single matching skill is preloaded rather than hinted, saving a load_skill round trip. */
const BRIEF_REQUEST_WORDS = 24;
/** A Stop / SubagentStop hook may send the agent back to work this many times in one turn. */
const MAX_STOP_HOOK_CONTINUES = 5;

/** Drives the model ⇄ tools loop for one user turn. Safe to run concurrently for different sessions. */
export class AgentRunner {
  /** Sessions currently streaming from each model id — lets a waiting chat say *why* it is waiting (local servers serve one request per model at a time). */
  private readonly inflight = new Map<string, Set<string>>();
  /**
   * Sessions assigned to each model id for the whole run (not only while a request streams): what the router
   * spreads parallel work against, so four workers started in the same tick do not all land on one model.
   */
  private readonly assigned = new Map<string, Set<string>>();
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
    private readonly learner?: SkillLearner,
    /** Skills that can be installed from configured repositories when a request matches one. */
    readonly catalog?: SkillCatalog
  ) {}

  /** Local-only metrics (runs, model calls, tools); nothing is sent anywhere. */
  telemetry?: Telemetry;
  /** Merged settings.json (permission rules, hooks); absent = no rules. */
  projectSettings?: () => ProjectSettings;
  /** Runs the settings' hooks; absent = hooks disabled. */
  hooks?: HookRunner;

  async run(o: AgentRunOptions): Promise<string> {
    const stats = new RunStats();
    let outcome: 'done' | 'stopped' | 'failed' = 'done';
    try {
      const text = await this.runTurn(o, stats);
      outcome = o.signal.aborted ? 'stopped' : 'done';
      return text;
    } catch (e) {
      outcome = o.signal.aborted ? 'stopped' : 'failed';
      throw e;
    } finally {
      this.unassign(o.session.id);
      this.telemetry?.record({
        type: 'run',
        sid: o.session.id,
        mode: o.session.mode,
        model: stats.model || o.session.model || '',
        depth: o.depth ?? 0,
        agent: (o.depth ?? 0) > 0 ? o.session.title.split(':')[0] : undefined,
        role: (o.depth ?? 0) > 0 && (o.role ?? 'agent') === 'agent' ? 'coding' : o.role ?? (o.session.mode === 'plan' ? 'reasoning' : 'agent'),
        outcome,
        durationMs: Date.now() - stats.startedAt,
        steps: stats.steps,
        toolCalls: stats.toolCalls,
        promptTokens: stats.promptTokens,
        completionTokens: stats.completionTokens,
        isolated: !!o.workspaceRoot && !!this.workspace.root && o.workspaceRoot !== this.workspace.root,
      });
    }
  }

  private async runTurn(o: AgentRunOptions, stats: RunStats): Promise<string> {
    const cfg = getConfig();
    const depth = o.depth ?? 0;
    const maxModelRetries = o.maxModelRetries ?? MAX_MODEL_RETRIES;
    const session = o.session;
    const emit = o.emit;
    const status = (text: string) => emit({ sessionId: session.id, type: 'status', payload: text });

    const route = await this.providers.route({
      role: o.role ?? (session.mode === 'plan' ? 'reasoning' : 'agent'),
      modelRef: o.modelRef ?? session.model,
      needsVision: !!o.userMessage.images?.length || session.messages.some((m) => m.role === 'user' && !!m.images?.length && Date.now() - (m.meta?.timestamp ?? 0) < 10 * 60_000),
      spread: o.spreadModels ?? (depth > 0 || !(o.modelRef ?? session.model)),
      load: this.loadFor(session.id),
    });
    const { provider } = route;
    // One number for the budget and for the request: the window the model is actually given (the setting, capped by
    // the model; 0 = the model's full native window). Budgeting against the native window while sending a smaller
    // num_ctx would let the server truncate silently before compaction ever triggered.
    const model: ModelInfo = { ...route.model, contextWindow: effectiveContextWindow(route.model, cfg.contextWindow) };
    stats.model = model.id;
    this.assign(model.id, session.id);
    const profile = model.runtime ? await getSystemProfile().catch(() => undefined) : undefined;
    if (route.reason) {
      status(route.reason);
    }
    // Keep the session on the user's chosen model when a turn was redirected (e.g. to a vision model); an
    // unavailable model is replaced for good so the picker reflects what is actually answering. A model chosen only
    // because the intended one was busy is not kept either: the next turn routes afresh.
    // Subagent sessions are ephemeral: record what actually answered so the parent can report or quarantine it.
    if ((!route.reason || route.fallback || depth > 0) && !(route.spread && depth === 0)) {
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
      workspaceRoot: o.workspaceRoot,
      model,
      toolsEnabled,
      textToolProtocol: toolsEnabled && !nativeTools,
      skills: this.skills,
      canLoadSkills: toolDefs.some((t) => t.name === 'load_skill'),
      workspace: this.workspace,
      append: cfg.systemPromptAppend,
      roleOverride: o.roleOverride,
      memory: cfg.memoryEnabled && depth === 0 ? await this.memory?.promptSection() : undefined,
      workingSet: session.workingSet,
      todos: session.todos,
    });
    const isolated = o.workspaceRoot && this.workspace.root && o.workspaceRoot !== this.workspace.root;
    const systemIsolated = isolated
      ? `${system}\n\n# Isolated workspace\nYou are working in an isolated copy of the repository (a git worktree at ${o.workspaceRoot}). It mirrors the user's checkout including their uncommitted work. Use relative paths as usual; file, search and terminal tools already run inside the copy. The user reviews your changes afterwards and applies them to the real workspace, so finish the task completely here — do not ask them to copy anything.`
      : system;
    const systemWithTextTools = !nativeTools && toolDefs.length ? `${systemIsolated}\n\n# Tools\n${toolDefs.map((t) => `- ${t.name}: ${t.description}\n  parameters: ${JSON.stringify(t.parameters)}`).join('\n')}` : systemIsolated;

    const wasEmpty = session.messages.length === 0;
    session.messages.push({ ...o.userMessage, meta: { ...o.userMessage.meta, timestamp: Date.now() } });

    // Hooks: SessionStart (first turn of a chat) and UserPromptSubmit may add context or block the prompt.
    const hookRoot = o.workspaceRoot ?? this.workspace.root;
    if (depth === 0 && this.hooks && (this.hooks.has('SessionStart') || this.hooks.has('UserPromptSubmit'))) {
      const hookContext: string[] = [];
      if (wasEmpty && this.hooks.has('SessionStart')) {
        const r = await this.hooks.run('SessionStart', { session_id: session.id, source: 'startup' }, { cwd: hookRoot, matchKey: 'startup', signal: o.signal });
        hookContext.push(...r.context);
      }
      if (this.hooks.has('UserPromptSubmit')) {
        status('Running prompt hooks…');
        const r = await this.hooks.run('UserPromptSubmit', { session_id: session.id, prompt: userText(o.userMessage.content) }, { cwd: hookRoot, signal: o.signal });
        if (r.block || r.stop) {
          const reason = r.reasons.join('\n') || r.stop || 'A UserPromptSubmit hook blocked this prompt.';
          const note = `Prompt blocked by a hook: ${reason}`;
          session.messages.pop(); // the prompt is erased, like Claude Code
          session.messages.push({ role: 'assistant', content: note, meta: { timestamp: Date.now() } });
          emit({ sessionId: session.id, type: 'assistant_delta', payload: note });
          emit({ sessionId: session.id, type: 'turn_end', payload: { text: note, contextTokens: session.contextTokens, durationMs: Date.now() - stats.startedAt, steps: 0, toolCalls: 0 } });
          return note;
        }
        hookContext.push(...r.context);
      }
      if (hookContext.length) {
        session.messages.push({ role: 'user', content: `<hook-context>\n${hookContext.join('\n\n')}\n</hook-context>`, meta: { timestamp: Date.now(), hidden: true } });
      }
    }

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

    // Skills: pick what this request should run with and put it in front of the model.
    // - Strong matches (name / trigger phrase), pinned skills and `/skill <name>` are PRELOADED: their full
    //   instructions go into a hidden message, so the model follows them instead of having to call load_skill —
    //   the step small local models most often skip or get wrong (hallucinated names, summarised steps).
    // - Loose matches are only hinted at — except on a brief request with a single candidate, where the hint would
    //   cost a whole model round trip (load_skill, then the real work) for a decision with nothing to weigh; the
    //   skill is preloaded and the note lets the model set it aside if it does not apply.
    // - The chat's skills mode (session override, else the global setting) decides whether registry skills are
    //   installed on the spot, offered as a chip, or left alone.
    // Skills in force for this run — handed to every subagent it spawns so a swarm follows the same playbook.
    const activeSkills = new Set<string>(session.skills?.pinned ?? []);
    if (depth === 0 && !o.roleOverride && (this.skills.enabledSkills.length || this.catalog)) {
      try {
        const request = o.userMessage.content;
        const text = userText(request);
        const forcedName = /^Use the "([^"]+)" skill\b/.exec(text)?.[1];
        const forced = !!forcedName || /^\/skill\b/.test(text);
        // "Use the write_file tool to…" — the user has prescribed the tool; a playbook detour would only cost turns.
        const prescribed = namesTool(request, toolDefs.map((t) => t.name));
        const ss = session.skills ?? {};
        // Registry behaviour follows the chat override, else `skills.autoInstall`. Only the chat-level "off" also
        // silences suggestions for installed skills — the global setting is about downloading, and matching what is
        // already on disk costs nothing.
        const mode: 'auto' | 'ask' | 'off' = ss.mode ?? cfg.skillAutoInstall;
        const quiet = ss.mode === 'off';
        const enabled = this.skills.enabledSkills;
        // Already in context: load_skill results and skills preloaded into earlier hidden messages.
        const loaded = new Set(
          session.messages.flatMap((m) => ((m.role === 'tool' && m.toolName === 'load_skill') || (m.role === 'user' && m.meta?.hidden) ? [...m.content.matchAll(/<skill name="([^"]+)"/g)].map((x) => x[1]) : []))
        );
        const suggestions = quiet && !forced ? { skills: [] as SkillMatch[], create: undefined } : this.learner ? await this.learner.observeRequest(request, enabled) : { skills: recommendSkills(request, enabled), create: undefined };
        let fresh: SkillMatch[] = suggestions.skills.filter((s) => !loaded.has(s.name));
        let installed: { name: string; repo: string; dir: string } | undefined;
        let available: { name: string; description: string; repo: string } | undefined;
        if (this.catalog && mode !== 'off' && !forced && !prescribed) {
          const remote = await this.catalog.match(request, enabled);
          if (remote && mode === 'ask') {
            available = { name: remote.name, description: remote.description, repo: remote.repo };
          } else if (remote) {
            status(`Installing skill "${remote.name}" from ${remote.repo}…`);
            try {
              const one = await this.catalog.install(remote, skillsDestination(cfg.skillAutoInstallScope, this.workspace.root), { signal: o.signal, timeoutMs: 20_000, progress: (t) => status(t), auto: true });
              await this.skills.refresh();
              if (one && this.skills.resolveSkill(one.name)) {
                installed = { name: one.name, repo: remote.repo, dir: one.dir };
                fresh = [{ name: one.name, description: remote.description, score: remote.score, strong: true }, ...fresh.filter((f) => f.name !== one.name)];
                this.log.info(`skill catalog: installed "${one.name}" from ${remote.repo} into ${one.dir}`);
              }
            } catch (e) {
              this.log.warn(`skill catalog: could not install "${remote.name}" from ${remote.repo}: ${String(e)}`);
              status(`Could not install skill "${remote.name}" — continuing without it`);
            }
          }
        }
        // What to preload, in priority order: the forced skill, pinned skills, then the top strong match.
        const wanted: { name: string; reason: 'forced' | 'pinned' | 'installed' | 'match' }[] = [];
        if (forcedName) {
          const r = this.skills.resolveSkill(forcedName);
          if (r) {
            wanted.push({ name: r.skill.name, reason: 'forced' });
          }
        }
        for (const p of ss.pinned ?? []) {
          const r = this.skills.resolveSkill(p);
          if (r) {
            wanted.push({ name: r.skill.name, reason: 'pinned' });
          }
        }
        const brief = text.trim().split(/\s+/).length <= BRIEF_REQUEST_WORDS;
        if (!quiet && !prescribed && !forcedName && fresh[0] && (fresh[0].strong || (brief && fresh.length === 1))) {
          wanted.push({ name: fresh[0].name, reason: installed?.name === fresh[0].name ? 'installed' : 'match' });
        }
        const items: { name: string; body: string; reason: (typeof wanted)[number]['reason'] }[] = [];
        // Roughly a fifth of the context window for skill text, so a long playbook cannot crowd out the code.
        const budget = Math.min(24_000, Math.max(4_000, Math.floor(model.contextWindow * 4 * 0.2)));
        for (const w of wanted) {
          if (loaded.has(w.name) || items.some((i) => i.name === w.name)) {
            continue;
          }
          const body = await this.skills.loadSkillBody(w.name);
          if (body) {
            items.push({ name: w.name, body: clampSkillBody(body, Math.max(2_000, Math.floor(budget / Math.max(1, wanted.length)))), reason: w.reason });
            void this.learner?.recordSkillUsed(w.name);
          }
        }
        const preloaded = items.map((i) => i.name);
        [...preloaded, ...loaded].forEach((n) => n && activeSkills.add(n));
        const remaining = fresh.filter((f) => !preloaded.includes(f.name) && !loaded.has(f.name));
        const notes: string[] = [];
        if (items.length) {
          notes.push(skillPreloadNote(items));
        } else if (installed) {
          notes.push(`The skill "${installed.name}" was just installed from ${installed.repo} because it matches this request.`);
        }
        if (remaining.length && !forced && !prescribed && !quiet) {
          notes.push(skillHint(remaining));
        }
        if (notes.length) {
          session.messages.push({ role: 'user', content: notes.join('\n\n'), meta: { timestamp: Date.now(), hidden: true } });
        }
        if (preloaded.length) {
          status(`Using skill${preloaded.length === 1 ? '' : 's'} ${preloaded.join(', ')}…`);
        }
        if (preloaded.length || remaining.length || suggestions.create || available) {
          emit({ sessionId: session.id, type: 'skill_suggestions', payload: { skills: remaining, preloaded: items.map((i) => ({ name: i.name, reason: i.reason })), create: suggestions.create, installed, available, mode } });
        }
      } catch (e) {
        this.log.warn(`skill recommendation failed: ${String(e)}`);
      }
    }

    // Subagents: no registry lookups or chips, but the same preloading — skills the parent handed down (its active
    // skills, or the agent file's `skills:`), plus a strong match on the worker's own brief. The brief rarely repeats
    // the user's words, so without this a worker would never see the playbook the parent is following.
    if ((depth > 0 || o.roleOverride) && this.skills.enabledSkills.length) {
      try {
        const wanted: string[] = [];
        for (const name of o.skills ?? []) {
          const r = this.skills.resolveSkill(name);
          if (r && !wanted.includes(r.skill.name)) {
            wanted.push(r.skill.name);
          }
        }
        const own = recommendSkills(o.userMessage.content, this.skills.enabledSkills, 1)[0];
        if (own?.strong && !wanted.includes(own.name) && !namesTool(o.userMessage.content, toolDefs.map((t) => t.name))) {
          wanted.push(own.name);
        }
        const inherited = new Set((o.skills ?? []).map((n) => this.skills.resolveSkill(n)?.skill.name).filter(Boolean));
        const items: { name: string; body: string; reason: PreloadReason }[] = [];
        const budget = Math.min(16_000, Math.max(3_000, Math.floor(model.contextWindow * 4 * 0.15)));
        for (const name of wanted) {
          const body = await this.skills.loadSkillBody(name);
          if (body) {
            items.push({ name, body: clampSkillBody(body, Math.max(1_500, Math.floor(budget / wanted.length))), reason: inherited.has(name) ? 'inherited' : 'match' });
          }
        }
        if (items.length) {
          session.messages.push({ role: 'user', content: skillPreloadNote(items), meta: { timestamp: Date.now(), hidden: true } });
          items.forEach((i) => activeSkills.add(i.name));
          status(`Using skill${items.length === 1 ? '' : 's'} ${items.map((i) => i.name).join(', ')}…`);
        }
      } catch (e) {
        this.log.warn(`subagent skill preload failed: ${String(e)}`);
      }
    }

    const control = o.control ?? new RunControl(session.id, undefined, o.signal);
    const toolCtx: ToolContext = {
      sessionId: session.id,
      skills: [...activeSkills],
      workspaceRoot: o.workspaceRoot ?? this.workspace.root,
      signal: o.signal,
      control,
      depth,
      modelRef: model.id,
      readOnly: !isWriteMode(session.mode),
      progress: (t) => status(t),
      // Edits inside an isolated worktree need no undo snapshots: discarding the worktree is the undo, and the
      // tracker stays about files in the real workspace (those applied from the worktree).
      trackChange: (fsPath) => (isolated ? Promise.resolve() : (this.tracker?.beforeChange(fsPath, session.id) ?? Promise.resolve())),
      todos: {
        get: () => session.todos ?? [],
        set: (items) => {
          session.todos = items;
          emit({ sessionId: session.id, type: 'todos', payload: items });
        },
      },
      requestApproval: (title, detail, kind) => this.gateApproval(kind, cfg.approvals[kind], () => o.requestApproval(title, detail, kind), emit, session.id, { title, detail, root: hookRoot }),
    };
    const policy: ToolPolicy = {
      settings: this.projectSettings?.() ?? emptySettings(),
      extraAllow: o.permissionAllow ?? [],
      hooks: this.hooks,
      root: hookRoot,
      sessionId: session.id,
      ask: (title, detail, kind) => {
        emit({ sessionId: session.id, type: 'approval_request', payload: { kind } });
        return o.requestApproval(title, detail, kind);
      },
      signal: o.signal,
    };
    /** Times a Stop / SubagentStop hook sent the agent back to work this turn. */
    let stopHookContinues = 0;

    let finalText = '';
    const maxIter = o.maxIterations ?? MAX_ITERATIONS_DEFAULT;
    // Read-only tool results are memoised for the turn (including in-flight calls, so identical
    // parallel requests run once); any mutating tool clears the cache.
    const toolCache = new Map<string, Promise<ChatMessage>>();
    const think = cfg.thinking === 'off' ? undefined : cfg.thinking === 'on' ? true : cfg.thinking;
    let toolsExecuted = 0;
    /** Tools that change the workspace (edits, deletes, commands) — a claimed change with none of these is a claim only. */
    let mutationsExecuted = 0;
    /** Fan-outs that actually started workers this turn; a later "I'll report back when they finish" is stale, not a plan. */
    let delegationsExecuted = 0;
    /** Corrective turns handed out so far; small models often need one after the plan and one after the first tool result. */
    let nudges = 0;
    const MAX_NUDGES = 2;
    let malformedNudged = false;
    /** (tool, args) → how often it was requested this turn; repeats beyond MAX_IDENTICAL_CALLS are refused. */
    const callCounts = new Map<string, number>();
    let completed = false;
    /** Hold here while the user has the run paused; the step that was in flight has finished by now. */
    const hold = async (): Promise<void> => {
      if (!control.paused) {
        return;
      }
      status('Paused');
      await control.waitWhilePaused();
      if (!control.aborted) {
        status('Resuming…');
      }
    };
    /** Append messages the user typed while the run was busy, so the next model call sees them. */
    const injectSteering = (): boolean => {
      const queued = control.takeSteering();
      if (!queued.length) {
        return false;
      }
      for (const m of queued) {
        session.messages.push({ ...m, meta: { ...m.meta, timestamp: Date.now(), steer: true } });
      }
      emit({ sessionId: session.id, type: 'steer', payload: { ids: queued.map((m) => m.meta?.steerId).filter(Boolean), count: queued.length } });
      status('Taking your new instructions into account…');
      return true;
    };

    for (let iter = 0; iter < maxIter; iter++) {
      await hold();
      if (o.signal.aborted || control.aborted) {
        break;
      }
      injectSteering();

      // --- Context management ---------------------------------------------------------------
      // Keep splitting until it fits: prune old tool outputs, summarise the older part, and tighten the verbatim
      // window if a few huge recent results still do not leave room for the answer.
      const budgetOf = (h: ChatMessage[]) => ctxMgr.budget(model, systemWithTextTools, nativeTools ? toolDefs : [], h, cfg.maxOutputTokens);
      let budget = budgetOf(session.messages);
      if (ctxMgr.needsCompaction(budget)) {
        if (this.hooks?.has('PreCompact')) {
          await this.hooks.run('PreCompact', { session_id: session.id, trigger: 'auto', custom_instructions: '' }, { cwd: hookRoot, matchKey: 'auto', signal: o.signal });
        }
        const fit = await ctxMgr.fit(session.messages, provider, model, budgetOf, o.signal, () => status('Compacting conversation to fit the context window…'));
        session.messages = fit.messages;
        budget = fit.budget;
        for (const result of fit.compactions) {
          session.compactions++;
          emit({ sessionId: session.id, type: 'compaction', payload: { before: result.before, after: result.after, removed: result.removed, summary: result.summary } });
        }
      }
      session.contextTokens = budget.historyTokens + budget.systemTokens + budget.toolsTokens;

      // --- Model call -----------------------------------------------------------------------
      // Back on the model after tools ran: hold the slot again (it was handed to workers during tool execution).
      this.assign(model.id, session.id);
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
        let firstAt: number | undefined;
        let usage: { promptTokens?: number; completionTokens?: number } | undefined;
        const modelEvent = (outcome: 'ok' | 'error' | 'retry' | 'aborted', reason?: string) =>
          this.telemetry?.record({ type: 'model', sid: session.id, model: model.modelId, provider: model.providerId, mode: session.mode, depth, promptTokens: usage?.promptTokens, completionTokens: usage?.completionTokens, ttftMs: firstAt ? firstAt - requestedAt : undefined, durationMs: Date.now() - requestedAt, outcome, reason });
        stats.steps++;
        try {
          const stream = provider.chat({
            model: model.modelId,
            messages: [{ role: 'system', content: systemWithTextTools }, ...session.messages.map(stripMeta)],
            tools: nativeTools && toolDefs.length ? toolDefs : undefined,
            temperature: cfg.temperature,
            maxTokens: cfg.maxOutputTokens,
            contextWindow: model.contextWindow,
            think,
            keepAlive: cfg.keepAlive || undefined,
            signal: ac.signal,
          });
          // A request queued behind `others` on a one-slot server legitimately waits for all of them: give it
          // their first-token budget too instead of calling it a stall and retrying (which only re-queues it).
          const patience = watchdogFor(model, profile?.modelBudgetGb);
          const guarded = withWatchdog(stream, {
            firstTokenMs: Math.min((o.firstTokenTimeoutMs ?? FIRST_TOKEN_TIMEOUT_MS) * patience.first * (1 + others), FIRST_TOKEN_TIMEOUT_MAX_MS * patience.first),
            idleMs: IDLE_TIMEOUT_MS * patience.idle,
            abort: () => ac.abort(),
            onWaiting: (s) => status(`${others ? `Waiting for ${model.name} — queued behind ${others} other request${others === 1 ? '' : 's'}` : `Waiting for ${model.name}`} · ${s}s${s >= 30 && !others ? ' (loading the model or a long prompt)' : ''}…`),
          });
          for await (const ev of guarded) {
            if (first && (ev.type === 'text' || ev.type === 'thinking' || ev.type === 'tool_call')) {
              first = false;
              firstAt = Date.now();
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
                usage = ev;
                if (ev.promptTokens) {
                  session.contextTokens = ev.promptTokens + (ev.completionTokens ?? 0);
                  stats.promptTokens += ev.promptTokens;
                  stats.completionTokens += ev.completionTokens ?? 0;
                }
                break;
            }
          }
        } catch (e) {
          o.signal.removeEventListener('abort', onAbort);
          if (o.signal.aborted) {
            modelEvent('aborted');
            aborted = true;
            break;
          }
          const kind = classifyModelError(e);
          const msg = e instanceof Error ? e.message : String(e);
          modelEvent(isTransient(kind) && first && attempt < maxModelRetries ? 'retry' : kind === 'overflow' && !compactedForOverflow ? 'retry' : 'error', kind);
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
          if (isTransient(kind) && first && attempt < maxModelRetries) {
            attempt++;
            const wait = RETRY_BACKOFF_MS[Math.min(attempt - 1, RETRY_BACKOFF_MS.length - 1)];
            this.log.warn(`model call failed (${kind}), retry ${attempt}/${maxModelRetries} in ${wait}ms: ${msg}`);
            status(`${kind === 'stall' ? 'The model stopped responding' : kind === 'ratelimit' ? 'The server is rate limiting' : 'Connection to the model failed'} — retrying (${attempt}/${maxModelRetries})…`);
            emit({ sessionId: session.id, type: 'retry', payload: { attempt, max: maxModelRetries, reason: kind, message: msg } });
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
        if (!text.trim() && !calls.length && attempt < maxModelRetries && !o.signal.aborted) {
          modelEvent('retry', 'empty');
          attempt++;
          this.log.warn(`empty completion from ${model.id}; retry ${attempt}/${maxModelRetries}`);
          status(`The model returned nothing — asking again (${attempt}/${maxModelRetries})…`);
          emit({ sessionId: session.id, type: 'retry', payload: { attempt, max: maxModelRetries, reason: 'empty', message: 'empty completion' } });
          await sleep(RETRY_BACKOFF_MS[0], o.signal);
          continue;
        }
        modelEvent(o.signal.aborted ? 'aborted' : 'ok');
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
      let malformedCalls: string[] = [];
      if (toolDefs.length && !calls.length) {
        const parsed = extractTextToolCalls(text, nativeTools ? new Set(toolDefs.map((t) => t.name)) : undefined, toolDefs);
        if (parsed.calls.length) {
          calls.push(...parsed.calls);
          text = parsed.remainder;
        } else {
          malformedCalls = parsed.malformed;
        }
      }

      assistant.content = text;
      assistant.thinking = thinking || undefined;
      assistant.toolCalls = calls.length ? calls : undefined;
      session.messages.push(assistant);
      finalText = text;

      if (!calls.length) {
        // The model tried to call a tool but the call did not parse: hand the error back once so it can
        // resend a corrected call instead of the turn ending as if the action had happened.
        if (malformedCalls.length && !malformedNudged && !o.signal.aborted) {
          malformedNudged = true;
          status('Fixing tool call…');
          const names = toolDefs.map((t) => t.name).join(', ');
          emit({ sessionId: session.id, type: 'nudge', payload: { reason: 'malformed' } });
          session.messages.push({
            role: 'user',
            content: `Your tool call could not be executed: ${malformedCalls[0]}. Nothing has been done. Resend it as one complete, valid JSON object {"name": <tool>, "arguments": {...}} using only these tools: ${names}.`,
            meta: { timestamp: Date.now(), hidden: true, nudge: 'malformed' },
          });
          continue;
        }
        // Small models sometimes answer "done" to an action request without doing anything. Once per
        // run, in agent mode, when nothing was executed and the reply is a bare claim, push back.
        // Small models also stop after announcing an action ("I will edit the file with edit_file.") or after
        // writing the call as text. The nudge fires once per run, so a false positive costs one short turn.
        const canNudge = isWriteMode(session.mode) && toolDefs.length > 0 && nudges < MAX_NUDGES && depth === 0;
        const toolNames = toolDefs.map((t) => t.name);
        const shown = canNudge && showsToolCallAsText(text, toolNames);
        // Workers already ran and reported, yet the reply re-announces the hand-off ("I'll report back when they finish").
        const stale = canNudge && !shown && delegationsExecuted > 0 && looksLikeStaleDelegation(text);
        const announced = canNudge && !shown && !stale && looksLikeUnfulfilledIntent(text, toolNames);
        const claimed = canNudge && !shown && !stale && !announced && mutationsExecuted === 0 && claimsChange(text, o.userMessage.content);
        if (shown || stale || announced || claimed || (canNudge && toolsExecuted === 0 && looksLikeBareClaim(text, o.userMessage.content))) {
          nudges++;
          status('Verifying…');
          const reason = shown ? 'shown' : stale ? 'stale' : claimed ? 'claimed' : announced ? 'announced' : 'bare';
          emit({ sessionId: session.id, type: 'nudge', payload: { reason } });
          const delegationClaim = claimed && /\bdelegat|\bworkers?\b|\bsubagents?\b/i.test(text);
          session.messages.push({
            role: 'user',
            content: shown
              ? 'You wrote the tool call (or the patch) as text, so it was not executed and the file is unchanged. Make the call through the tool interface now — one tool call with its JSON arguments, no code fence — and only then report.'
              : stale
                ? 'The workers have already finished — their reports are in the tool result above. Do not announce the delegation again. If anything still needs checking, verify it with the tools (list_dir, read_file, get_diagnostics, tests); then give the user the final outcome in a few lines.'
                : delegationClaim
                ? `You said the work was delegated to workers, but no tool was called, so no worker exists and nothing has started. Start them now with one tool call — ${toolNames.includes('run_todos_parallel') && (session.todos ?? []).some((t) => t.agent && t.status === 'pending') ? 'run_todos_parallel for the checklist items that have an agent' : 'run_parallel_subagents with each task (agent + complete prompt) inline'} — do not repeat the announcement, and report only when their results are back.`
                : claimed
                ? 'You described the change as done, but no tool that modifies files or runs commands was called, so nothing has changed. Apply it now with the tools (edit_file / write_file / run_command) and only then report.'
                : announced && toolsExecuted > 0
                  ? 'You announced the next action but did not call a tool, so it has not happened. Do it now with the tool and only then report.'
                  : 'You have not called any tools, so nothing has been done yet. If the request requires an action (creating or editing files, running commands), perform it now with the tools and only then report. If no action is needed, explain why in one or two sentences.',
            meta: { timestamp: Date.now(), hidden: true, nudge: reason },
          });
          continue;
        }
        // Instructions typed while the model was answering: continue with them instead of ending the turn.
        if (injectSteering()) {
          continue;
        }
        // Stop / SubagentStop hooks may judge the work unfinished and send the agent back (bounded).
        const stopEvent = depth === 0 ? 'Stop' : 'SubagentStop';
        if (this.hooks?.has(stopEvent) && !o.signal.aborted) {
          status('Running stop hooks…');
          const r = await this.hooks.run(stopEvent, { session_id: session.id, stop_hook_active: stopHookContinues > 0, last_assistant_message: text }, { cwd: hookRoot, signal: o.signal });
          if (r.block && stopHookContinues < MAX_STOP_HOOK_CONTINUES && !r.stop) {
            stopHookContinues++;
            const reason = r.reasons.join('\n') || 'A stop hook asked you to continue.';
            emit({ sessionId: session.id, type: 'nudge', payload: { reason: 'hook' } });
            session.messages.push({ role: 'user', content: `A Stop hook blocked finishing: ${reason}\nAddress this, then report again.`, meta: { timestamp: Date.now(), hidden: true, nudge: 'hook' } });
            status('Continuing (stop hook)…');
            continue;
          }
        }
        completed = true;
        break;
      }

      // --- Tool execution (parallel for read-only tools) ------------------------------------
      // A pause requested during the model call takes effect here, before any tool runs.
      await hold();
      if (o.signal.aborted || control.aborted) {
        // Stopped while holding: close the assistant's tool calls so the history stays well-formed for the next turn.
        for (const c of calls) {
          session.messages.push({ role: 'tool', content: nativeTools ? 'Cancelled by user.' : `<tool_result name="${c.name}">\nCancelled by user.\n</tool_result>`, toolCallId: c.id, toolName: c.name, meta: { timestamp: Date.now() } });
        }
        break;
      }
      stats.toolCalls += calls.length;
      // While tools run this session makes no requests: give the model slot up so workers it delegates to can take
      // it instead of being spread away from an idle model.
      this.unassign(session.id);
      const results = await this.executeToolCalls(calls, toolList, toolCtx, pool, ctxMgr, emit, session.id, nativeTools, toolCache, model.supportsVision, callCounts, session.mode, policy);
      toolsExecuted += calls.length;
      // Delegation counts as work done: the workers edited files on the agent's behalf, so a later
      // "created both files" is a report, not a claim.
      mutationsExecuted += calls.filter((c) => {
        const kind = toolList.find((t) => t.definition.name === c.name)?.approvalKind;
        return kind === 'write' || kind === 'delete' || kind === 'terminal' || DELEGATION_TOOLS.has(c.name);
      }).length;
      delegationsExecuted += calls.filter((c) => DELEGATION_TOOLS.has(c.name) && !results.find((r) => r.toolCallId === c.id)?.content.startsWith('Nothing to run')).length;
      for (const c of calls) {
        if (c.name === 'load_skill') {
          const loadedName = /<skill name="([^"]+)"/.exec(results.find((r) => r.toolCallId === c.id)?.content ?? '')?.[1];
          if (loadedName && !activeSkills.has(loadedName)) {
            activeSkills.add(loadedName);
            toolCtx.skills = [...activeSkills];
          }
        }
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
    const durationMs = Date.now() - stats.startedAt;
    const last = session.messages[session.messages.length - 1];
    if (last?.role === 'assistant') {
      last.meta = { ...last.meta, durationMs };
    }
    emit({ sessionId: session.id, type: 'turn_end', payload: { text: finalText, contextTokens: session.contextTokens, durationMs, steps: stats.steps, toolCalls: stats.toolCalls } });
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

  private assign(modelId: string, sessionId: string): void {
    this.unassign(sessionId);
    const set = this.assigned.get(modelId) ?? new Set<string>();
    set.add(sessionId);
    this.assigned.set(modelId, set);
    this.assignedCount.set(modelId, set.size);
  }

  private unassign(sessionId: string): void {
    for (const [id, set] of this.assigned) {
      if (set.delete(sessionId)) {
        if (set.size) {
          this.assignedCount.set(id, set.size);
        } else {
          this.assigned.delete(id);
          this.assignedCount.delete(id);
        }
      }
    }
  }

  /** Live run counts per model id (the Map instance the router reads, kept current by assign/unassign). */
  private readonly assignedCount = new Map<string, number>();

  /** Current load as the router sees it: runs per model and the models known to serve one request at a time. */
  get load(): ModelLoad {
    return { assigned: this.assignedCount, serial: this.serialWarned, slots: Math.min(4, Math.max(1, getConfig().parallel.maxConcurrency)) };
  }

  /** The load view for one run: the router reserves its pick for that session the moment it decides. */
  private loadFor(sessionId: string): ModelLoad {
    return { ...this.load, reserve: (modelId) => this.assign(modelId, sessionId) };
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
      this.markServedSerially(model.id);
      this.log.warn(`${model.id} appears to serve one request at a time (first token after ${Math.round(waited / 1000)}s behind ${others} other request(s)); parallel work spreads to other models where possible`);
      this.onSerialServer?.(model);
    }
  }

  /** Treat `modelId` as serving one request at a time: from now on a second simultaneous run on it is spread to a comparable idle model. */
  markServedSerially(modelId: string): void {
    this.serialWarned.add(modelId);
  }

  /** Model ids currently known to serve one request at a time. */
  get serialModels(): ReadonlySet<string> {
    return this.serialWarned;
  }

  /** A routed model stalled on a subagent: keep automatic picks away from it for a while. */
  markModelUnresponsive(modelId: string): void {
    this.providers.markUnresponsive(modelId);
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
    if (!isWriteMode(mode)) {
      // Read-only modes: strip mutating tools.
      list = list.filter((t) => !t.approvalKind || t.approvalKind === 'network');
    } else if (mode === 'multitask') {
      // The coordinator reads, plans, delegates and verifies; only its workers edit files.
      list = list.filter((t) => t.approvalKind !== 'write' && t.approvalKind !== 'delete');
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
    callCounts?: Map<string, number>,
    mode = 'agent',
    policy?: ToolPolicy
  ): Promise<ChatMessage[]> {
    const byName = new Map(available.map((t) => [t.definition.name, t]));
    // Images produced by tools (browser_screenshot) ride along in a user message, which every provider accepts.
    const captured: { callId: string; caption: string; data: string }[] = [];
    const toolMsg = (call: ToolCall, content: string): ChatMessage => ({ role: 'tool', content: nativeTools ? content : `<tool_result name="${call.name}">\n${content}\n</tool_result>`, toolCallId: call.id, toolName: call.name, meta: { timestamp: Date.now() } });
    const execute = async (call: ToolCall, tool: Tool | undefined, args: Record<string, unknown>): Promise<{ msg: ChatMessage; isError: boolean }> => {
      const started = Date.now();
      let result: { content: string; isError?: boolean; data?: unknown } | undefined;
      let callCtx = ctx;
      if (tool && policy) {
        // Permission rules from settings.json: deny → ask → allow, then the project's default mode.
        const verdict = evaluatePermission(policy.settings.permissions, call.name, args, { root: policy.root }, policy.extraAllow);
        let decision: 'allow' | 'deny' | 'ask' | 'none' = verdict.decision;
        let reason = verdict.rule ? `permission rule \`${verdict.rule}\`` : '';
        if (decision === 'deny') {
          result = { content: `Blocked by ${reason} in settings.json. Do not retry this exact action; choose another approach or ask the user to change the rule.`, isError: true };
        } else if (policy.hooks?.has('PreToolUse')) {
          const r = await policy.hooks.run('PreToolUse', { session_id: policy.sessionId, tool_name: canonicalToolName(call.name), tool_input: claudeToolInput(call.name, args), localpilot_tool_name: call.name }, { cwd: policy.root, matchKeys: toolNames(call.name), signal: policy.signal });
          if (r.block || r.permission === 'deny') {
            result = { content: `Blocked by a PreToolUse hook: ${r.reasons.join('\n') || 'no reason given'}. Nothing was done.`, isError: true };
          } else {
            if (r.updatedInput) {
              args = fromClaudeToolInput(call.name, r.updatedInput, args);
            }
            if (r.permission) {
              decision = r.permission;
              reason = 'a PreToolUse hook';
            }
            if (r.stop) {
              result = { content: `Stopped by a hook: ${r.stop}`, isError: true };
            }
          }
        }
        if (!result) {
          if (decision === 'none') {
            decision = defaultModeDecision(policy.settings.permissions.defaultMode, call.name);
            reason = decision === 'none' ? '' : `permissions.defaultMode = ${policy.settings.permissions.defaultMode}`;
          }
          if (decision === 'deny') {
            result = { content: `Blocked by ${reason}. Nothing was done.`, isError: true };
          } else if (decision === 'allow') {
            callCtx = { ...ctx, requestApproval: async () => true };
          } else if (decision === 'ask') {
            callCtx = { ...ctx, requestApproval: policy.ask };
          }
        }
        if (result?.isError) {
          this.log.info(`tool ${call.name} blocked: ${result.content.split('\n')[0]}`);
        }
      }
      if (!result) {
        result = tool
          ? await this.tools.execute(call.name, args, callCtx)
          : { content: `Tool "${call.name}" is not available in this mode. Available: ${[...byName.keys()].join(', ')}`, isError: true };
      }
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
      let content = ctxMgr.clampToolOutput(text);
      if (tool && policy?.hooks?.has('PostToolUse') && !ctx.signal.aborted) {
        const r = await policy.hooks.run(
          'PostToolUse',
          { session_id: policy.sessionId, tool_name: canonicalToolName(call.name), tool_input: claudeToolInput(call.name, args), tool_response: { content, is_error: !!result.isError }, localpilot_tool_name: call.name },
          { cwd: policy.root, matchKeys: toolNames(call.name), signal: policy.signal }
        );
        const extra = [...(r.block ? r.reasons.map((x) => `[hook] ${x}`) : []), ...r.context];
        if (extra.length) {
          content = `${content}\n\n${extra.join('\n')}`;
        }
      }
      this.telemetry?.record({ type: 'tool', sid: sessionId, name: call.name, mode, durationMs: Date.now() - started, error: !!result.isError });
      emit({ sessionId, type: 'tool_end', payload: { id: call.id, name: call.name, isError: result.isError, durationMs: Date.now() - started, content, data: result.data } });
      return { msg: toolMsg(call, content), isError: !!result.isError };
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
          this.telemetry?.record({ type: 'tool', sid: sessionId, name: call.name, mode, durationMs: 0, error: false, cached: true });
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

  private async gateApproval(kind: NonNullable<Tool['approvalKind']>, mode: ApprovalMode, ask: () => Promise<boolean>, emit: (e: AgentEvent) => void, sessionId: string, info?: { title: string; detail: string; root?: string }): Promise<boolean> {
    if (mode === 'always') {
      return true;
    }
    if (mode === 'never') {
      return false;
    }
    emit({ sessionId, type: 'approval_request', payload: { kind } });
    if (info && this.hooks?.has('Notification')) {
      // Fire-and-forget: a Notification hook may ping the user (desktop notification, sound) while the prompt waits.
      void this.hooks.run('Notification', { session_id: sessionId, message: `${info.title}\n${info.detail}`.trim(), notification_type: 'permission_prompt' }, { cwd: info.root, matchKey: 'permission_prompt' });
    }
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
 * The reply reports a change as already made ("I've edited add()", "The file has been updated", "Fixed.") in
 * answer to a request for one. Checked only when no mutating tool ran, so an honest report is never flagged.
 */
export function claimsChange(reply: string, request: string): boolean {
  const r = reply.trim();
  if (!r || /\?\s*$/.test(r)) {
    return false;
  }
  const imperative = /\b(create|write|add|edit|fix|update|change|rename|delete|remove|refactor|implement|make|generate|replace|move|save)\b/i.test(request);
  const claim =
    /\b(?:i'?ve|i have|has been|have been|is now|are now)\s+(?:\w+\s+){0,2}(?:edited|updated|fixed|changed|created|written|modified|applied|saved|removed|deleted|renamed|replaced|added|implemented|delegated|dispatched)\b/i.test(r) ||
    /(?:^|\n)\s*(?:fixed|done|updated|created|applied)[.!]?\s*$/i.test(r) ||
    // "Delegated to N background workers" with no tool call: the workers do not exist.
    /\bdelegated\s+(?:this|these|the|it|them|\d+|to)\b/i.test(r);
  return imperative && claim;
}

/**
 * After workers have run and reported, the reply still talks as if they were just dispatched
 * ("Delegated to 3 background workers. I'll report back when they finish."). Small models echo their opening line.
 */
export function looksLikeStaleDelegation(reply: string): boolean {
  const r = reply.trim();
  return /\bdelegat(?:ed|ing)\b[^.\n]{0,80}\b(?:workers?|subagents?|agents?)\b/i.test(r) && /\b(?:report back|when they (?:finish|complete|are done)|once they(?:'re| are) done|will (?:report|update you))\b/i.test(r);
}

/** A code fence or line that starts with a tool name ("edit_file: path:…", "write_file("), or a unified diff with file headers: the model showed the action instead of doing it. */
export function showsToolCallAsText(reply: string, toolNames: Iterable<string>): boolean {
  for (const raw of toolNames) {
    const name = raw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const fence = '```[^\\n]*\\n\\s*' + name + '\\b';
    const call = '(?:^|\\n)\\s*' + name + '\\s*\\(';
    if (new RegExp(`${fence}|${call}`).test(reply)) {
      return true;
    }
  }
  return /```diff\b[\s\S]*?\n(?:---|\+\+\+) /.test(reply);
}

/**
 * The reply shows a tool call as text instead of making it (a code fence or line starting with a tool name),
 * or ends by announcing an action it never took ("Let's proceed with fixing…", "I'll now update the file").
 * Small models do both regularly; either way nothing happened and the model should be told so.
 */
export function looksLikeUnfulfilledIntent(reply: string, toolNames: Iterable<string>): boolean {
  const r = reply.trim();
  if (!r) {
    return false;
  }
  if (showsToolCallAsText(r, toolNames)) {
    return true;
  }
  const tail = r.split(/\n+/).filter((l) => l.trim()).slice(-3).join(' ');
  if (/let me know|would you like|do you want|should i\b/i.test(tail)) {
    return false;
  }
  return /\b(?:let'?s|let us|i'?ll|i will|i'?m going to|i am going to|we'?ll|now i|next,? i|proceeding to|going to)\b[^.!?\n]{0,80}\b(?:proceed|start|begin|fix|edit|update|create|write|add|change|run|implement|apply|modify|read|open|check|look|delegate|hand off|dispatch|spawn|split)/i.test(tail);
}

/**
 * Parses tool calls out of free text: ```tool_call / ```json fenced blocks, <tool_call>…</tool_call> tags,
 * and bare `{"name": …, "arguments": …}` objects. When `known` is given, only those tool names count.
 */
export function extractTextToolCalls(text: string, known?: ReadonlySet<string>, tools?: readonly ToolDefinition[]): { calls: ToolCall[]; remainder: string; malformed: string[] } {
  const calls: ToolCall[] = [];
  /**
   * A fenced JSON object with no "name" but whose keys are the parameters of exactly one tool (`{"tasks": […]}`,
   * `{"path": "…", "content": "…"}`) is the model printing the arguments instead of calling the tool. Resolve it.
   */
  const toolForArgs = (obj: Record<string, unknown>): string | undefined => {
    const keys = Object.keys(obj);
    if (!tools?.length || !keys.length) {
      return undefined;
    }
    const matches = tools
      .filter((t) => {
        const props = (t.parameters as { properties?: Record<string, unknown>; required?: string[] } | undefined)?.properties ?? {};
        return keys.every((k) => k in props) && (!known || known.has(t.name));
      })
      .map((t) => {
        const req = (t.parameters as { required?: string[] }).required ?? [];
        return { name: t.name, satisfied: req.every((k) => keys.includes(k)), reqCount: req.length };
      })
      .filter((m) => m.satisfied)
      .sort((a, b) => b.reqCount - a.reqCount);
    return matches.length && (matches.length === 1 || matches[0].reqCount > matches[1].reqCount) ? matches[0].name : undefined;
  };
  // Blocks the model explicitly marked as tool calls but that did not parse — truncated JSON, a trailing
  // comma, an unknown tool name. Silently treating those as prose lets the model claim it acted when it did not.
  const malformed: string[] = [];
  let remainder = text;
  const accept = (raw: string, json: string, explicit: boolean): void => {
    try {
      const obj = JSON.parse(json) as { name?: string; arguments?: unknown; parameters?: unknown };
      if (obj && typeof obj.name === 'string' && (!known || known.has(obj.name))) {
        const args = obj.arguments ?? obj.parameters ?? {};
        calls.push({ id: newId(), name: obj.name, arguments: typeof args === 'string' ? args : JSON.stringify(args) });
        remainder = remainder.replace(raw, '');
      } else if (obj && typeof obj === 'object' && !Array.isArray(obj) && obj.name === undefined && toolForArgs(obj as Record<string, unknown>)) {
        calls.push({ id: newId(), name: toolForArgs(obj as Record<string, unknown>)!, arguments: JSON.stringify(obj) });
        remainder = remainder.replace(raw, '');
      } else if (explicit && obj && typeof obj.name === 'string') {
        malformed.push(`unknown tool "${obj.name}"`);
      }
    } catch (e) {
      if (explicit) {
        malformed.push(`invalid JSON (${e instanceof Error ? e.message : String(e)})`);
      }
    }
  };
  const re = /```(tool_call|json)?\s*\n?(\{[\s\S]*?\})\s*```|<tool_call>\s*(\{[\s\S]*?\})\s*<\/tool_call>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    accept(m[0], m[2] ?? m[3], m[1] === 'tool_call' || m[3] !== undefined);
  }
  if (!calls.length) {
    for (const obj of bareJsonObjects(text)) {
      accept(obj, obj, false);
    }
  }
  return { calls, remainder: remainder.trim(), malformed };
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
