import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { getConfig } from '../config';
import { ContextManager, effectiveContextWindow, FitResult, MIN_CONTEXT_WINDOW, tokenCalibration } from '../context/contextManager';
import { contextBreakdown } from '../context/contextBreakdown';
import { toolResultCache } from '../context/toolResultCache';
import { WorkspaceContext } from '../context/workspaceContext';
import { ProviderRegistry, ModelLoad, pickFallback } from '../providers/registry';
import { ModelRole } from '../providers/catalog';
import { isCloudProvider } from '../providers/cloud';
import { streamsFromDisk } from '../providers/colibri';
import { getSystemProfile } from '../providers/system';
import { newId } from '../providers/http';
import { parseArgs, ToolRegistry } from '../tools/registry';
import { approvalModeFor, deniedResultText, effectiveApproval, toDecision } from './approvalLevel';
import type { TestSummary } from './healing/parsers/testSummary';
import { isReadOnlyOrSafe } from './commandGuard';
import { AgentEvent, ApprovalDecision, ApprovalOptions, TerminalApprovalMode, ChatMessage, CompactionDetails, HealingRawOutcome, ModelInfo, ProviderUsage, Session, Tool, ToolCall, ToolCallDecision, ToolContext, ToolDefinition, ToolResult, isWriteMode } from '../types';
import { addUsage } from './usage';
import { withCost } from '../providers/pricing';
import { ParallelPool } from './parallel';
import { buildSystemPrompt, buildTurnContext } from './prompts';
import { callKey, classifyModelError, describeModelError, isTransient, ModelFailure, retryDelayMs, sleep, withWatchdog, onAbort } from './resilience';
import { assessRequest, clarificationSteer, gatherRequestContext, hasContextBlocks, needsQuestions, questionSteer, userText } from './clarify';
import { asksToRemember, clampSkillBody, namesTool, PreloadReason, recommendSkills, SkillLearner, skillHint, SkillMatch, skillPreloadNote } from './skillRecommender';
import { RunControl } from './runControl';
import { SkillCatalog } from './skillCatalog';
import { skillsDestination } from './skillInstaller';
import { SkillManager } from './skills';
import { ChangeTracker } from './changeTracker';
import { CheckpointService } from './checkpoints';
import { MemoryStore } from './memory';
import { RunStats, Telemetry } from '../telemetry/telemetry';
import { endRunSpan, recordModelSpan, spanIds, startRunSpan, traceTool } from '../telemetry/tracing';
import { HookRunInfo, HookRunner } from './hooks';
import { AutoReviewer } from './autoReviewer';
import { thinkFor, thinkingLevel } from './thinking';
import { firstTokenFloor } from '../providers/providerOptions';
import { canonicalToolName, claudeToolInput, defaultModeDecision, evaluatePermission, fromClaudeToolInput, toolNames } from './permissions';
import { audit, autoApprovedMode, flooredApproval, getManagedPolicy, policyVerdict, toolAllowed, WEB_TOOLS } from './managedPolicy';
import { emptySettings, ProjectSettings } from './settings';
import { MemoryTurnHooks, runDigest, saveRunMemories } from './autoMemory';
import type { ContextTurnHooks, ExcludedRef } from './contextHooks';
import type { RunEndInfo, RunHandle, SessionRunHooks } from './sessionHooks';
import { editToolsToOmit, irrelevantTools } from './toolRelevance';
import { withEditPreview } from '../ui/editPreview';
import { MistakeCounter, mistakeLimitMessage } from './mistakes';
import { CONTINUE_NUDGE, hasUnterminatedToolCall, joinContinuation, LENGTH_NUDGE, lengthAction, lengthGiveUpMessage } from './outputLimit';
import { toolDisabled, toolInFilter } from './toolAliases';
import { listRepos } from './repos';
import { markRepoGraphStale } from '../context/repoGraph';
import { archiveCompaction, TranscriptArchive } from '../sessions/transcriptArchive';
import type { HealingDelegate, HealingEngine, HealingExec, HealingService, ModelFailureResult } from './healing/engine';
import { effectivePolicies } from './healing/policy';
import { repairToolCallText } from './healing/jsonRepair';
import { diff as treeDiff, snapshot as treeSnapshot } from './healing/treeSnapshot';
import type { RerouteRequirement } from './healing/retryController';
import type { FixPromptMessage } from './healing/rca';
import type { ApprovalRecord, CompletionContract, EscalationReason, ObserveResult, TaskOutcome } from './healing/types';
import { ChildWrites, type HealingSyntheticContext } from './childEvents';

/**
 * `mandatory`: the organization's policy requires this prompt; no auto-approval, session memory or "always" answer applies.
 * A person's answer is an `ApprovalDecision` (or `true`); a bare `false` is a refusal nobody gave (non-interactive, no TTY).
 */
export type ApprovalHandler = (title: string, detail: string, kind: NonNullable<Tool['approvalKind']>, opts?: ApprovalOptions) => Promise<boolean | ApprovalDecision>;
/** An approval gate that also reports the reason given with a denial. */
type DecisionHandler = (title: string, detail: string, kind: NonNullable<Tool['approvalKind']>, opts?: ApprovalOptions) => Promise<ApprovalDecision>;

/** Per-run permission/hook policy handed to tool execution. */
interface ToolPolicy {
  settings: ProjectSettings;
  /** Extra allow rules for this run (a slash command's `allowed-tools`). */
  extraAllow: string[];
  hooks?: HookRunner;
  root?: string;
  sessionId: string;
  /** Asks the user regardless of the approval settings (an `ask` rule or hook verdict). */
  ask: DecisionHandler;
  /** Like `ask`, for a prompt the organization's policy requires. */
  askMandatory: DecisionHandler;
  signal: AbortSignal;
}

/** Options of one `executeToolCalls` step; the self-healing engine's synthetic calls run with `origin: 'healing'`. */
interface ExecOptions {
  /** Tags the step's tool_start/tool_end payloads (the chat groups them under the recovery card). */
  origin?: 'healing';
  /** Identical-call counts for this step; synthetic calls bring their own so the turn's limit never refuses a check. */
  callCounts?: Map<string, number>;
  /** The step does not count towards the consecutive-mistake limit (synthetic calls, re-executed MCP calls). */
  skipMistakes?: boolean;
  /** Tools to resolve the calls against instead of the turn's filtered list. */
  tools?: Tool[];
  /** Wraps a model-originated run_command that is about to execute (tree snapshot before/after). */
  aroundCommand?: () => Promise<() => Promise<void>>;
}

/** What gateApproval needs from the turn's healing engine. */
type ApprovalRecorder = Pick<HealingEngine, 'inRecovery' | 'recordApproval'>;

/** Who settled an approval (`decided`'s `by`), keyed by the returned decision, for the step's structured decisions. */
const DECIDED_BY = new WeakMap<ApprovalDecision, string>();

/** Maps an approval refusal onto the structured decision of the call it blocked. */
function refusalOf(d: ApprovalDecision): ToolCallDecision {
  if (d.byUser) {
    return { deniedByUser: true };
  }
  const by = DECIDED_BY.get(d);
  return { blockedBy: by === 'stopped' || by === 'policy' || by === 'setting' ? by : 'unattended' };
}

/** The run's stats plus the self-healing outcome of its turn. */
type HealedStats = RunStats & { outcome?: TaskOutcome };

export interface AgentRunOptions {
  session: Session;
  /** The new user message to process (appended to the session). */
  userMessage: ChatMessage;
  /** Called once the top-level run has appended its user message to the session. */
  onUserMessage?: (m: ChatMessage) => void;
  modelRef?: string;
  /** Runs this turn in another mode (an empty-chat suggestion) without changing the chat's own mode. */
  mode?: Session['mode'];
  /** Auto mode: the specialist this turn runs as (with `mode` as its base), instead of the chat's own. */
  specialist?: Session['specialist'];
  /**
   * Auto mode's model role for this task (`reasoning` for plans and reviews, `fast` for a quick question). Used only
   * when the chat's model is Auto: an explicit model is never second-guessed.
   */
  taskRole?: ModelRole;
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
  /** The real folder an isolated run's `workspaceRoot` mirrors; set only for isolated runs. */
  isolatedFrom?: string;
  depth?: number;
  emit: (e: AgentEvent) => void;
  signal: AbortSignal;
  requestApproval: ApprovalHandler;
  /** False when `requestApproval` will answer this kind without showing a prompt (allowed for the session): no edit preview then. */
  willPrompt?: (kind: NonNullable<Tool['approvalKind']>, mandatory: boolean) => boolean;
  /** Shows ask_user questions in the chat; absent = native pickers. Only the main agent gets it. */
  askUser?: ToolContext['askUser'];
  /** Nobody is watching this run (task queue): no question round before work starts. */
  unattended?: boolean;
  /** A throwaway workspace unrelated to the user's project (benchmark): no project map, rules, memory or hooks. */
  scratch?: boolean;
  maxIterations?: number;
  /** Pause/resume/steer handle. When given, `signal` should be `control.signal`. */
  control?: RunControl;
  /** Transient-failure retries per model step (default 2). Subagents on a router-chosen model use 0 so a dead model fails fast and the caller can fall back. */
  maxModelRetries?: number;
  /** First-token watchdog for this run (default 180 s, scaled by queue depth). Shorter for router-chosen subagent models, which have a fallback. */
  firstTokenTimeoutMs?: number;
  /** When set, `maxModelRetries` and `firstTokenTimeoutMs` apply only if the routed model differs from this id (a side model). */
  sideModelOf?: string;
  /**
   * The model was not the user's explicit choice (Auto, or inherited from a parent): when it is saturated the router
   * may run this on a comparable idle model instead so parallel work really runs in parallel. Default: Auto chats
   * (no session model) and every subagent.
   */
  spreadModels?: boolean;
  /** Permission rules allowed for this run only (a custom slash command's `allowed-tools`). */
  permissionAllow?: string[];
  /** Every model request of this run and of its subagents, for the parent to add to its own totals (subagents). */
  onUsage?: (u: ProviderUsage | undefined, model: string, provider: string) => void;
  /** A fixer worker the self-healing engine started: the child runs its own engine in worker mode (scoped checks, one attempt). */
  healingRole?: 'fixer';
  /** Resume an interrupted recovery: rerun the checks before the first model call instead of redoing the task's edits. */
  resume?: boolean;
  /** The task-queue entry this run executes: kept in the recovery state, so interventions find their queue task. */
  taskId?: string;
  /** The chat's Trace recorder id for this run (continuity: the agent session id derives from it). */
  traceId?: string;
}

const MAX_ITERATIONS_DEFAULT = 40;
/** Transient model failures (network, 5xx/429, stall, empty completion) are retried this many times per step. */
const MAX_MODEL_RETRIES = 2;
const RETRY_BACKOFF_MS = [800, 2500];
/** Tool calls the server could not parse are handed back to the model at most this many times per run. */
const MAX_TOOLCALL_REPAIRS = 2;
/** The kind a failed turn reports to the chat, which picks the fix it offers (start the server, set a key, compact). */
export type TurnErrorKind = 'connection' | 'auth' | 'ratelimit' | 'stall' | 'context' | 'server' | 'other';

export function errorKind(k: ModelFailure): TurnErrorKind {
  return k === 'network' || k === 'unroutable' ? 'connection' : k === 'auth' || k === 'quota' ? 'auth' : k === 'overflow' ? 'context' : k === 'ratelimit' || k === 'stall' || k === 'server' ? k : k === 'overload' ? 'server' : 'other';
}

/** Local models may need to load weights and prefill a long prompt before the first token (`localpilot.firstTokenTimeoutSeconds`, default 180). */
const FIRST_TOKEN_TIMEOUT_MS = 180_000;
/** `firstTokenTimeoutSeconds: 0`: wait without a limit (a day stands for "never" in the watchdog). */
const NO_FIRST_TOKEN_LIMIT_MS = 24 * 3600_000;
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
  /** "Keep waiting" on the chat's wait row: extends the first-token limit of the session's request in flight. */
  private readonly waitExtenders = new Map<string, () => void>();
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
    readonly memory?: MemoryStore,
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
  /** Reviews prompts when `localpilot.autoMode.enabled` is on; absent = always ask. */
  autoReviewer?: AutoReviewer;
  /** Git checkpoints before each user turn (`localpilot.checkpoints.enabled`); absent = file snapshots only. */
  checkpoints?: CheckpointService;
  /** Keeps what compaction replaces (`<id>.archive.jsonl`); absent = compacted messages are gone. */
  archive?: TranscriptArchive;
  /** Self-healing engine service (detect, retry, fix, verify); absent = the loop behaves exactly as without it. */
  healing?: HealingService;
  /** 1.7 conversation and task memory (continuity); absent = 1.6 behaviour. */
  memoryHooks?: MemoryTurnHooks;
  /** 1.7 context snapshots, the local-only policy and restoration notes (continuity); absent = 1.6 behaviour. */
  contextHooks?: ContextTurnHooks;
  /** 1.7 agent sessions, execution events and drafts of partial answers (continuity SESSION); absent = 1.6 behaviour. */
  sessionHooks?: SessionRunHooks;
  /** The last compaction summary of each chat's running turn (conversation memory). */
  private readonly turnCompactions = new Map<string, string>();

  async run(o: AgentRunOptions): Promise<string> {
    // The user is waiting on this run: background model work from earlier runs gives way.
    if ((o.depth ?? 0) === 0) {
      this.backgroundAborts.forEach((a) => a.abort());
    }
    const stats = new RunStats();
    let outcome: 'done' | 'stopped' | 'failed' = 'done';
    const topLevel = (o.depth ?? 0) === 0;
    if (topLevel && !o.session.messages.some((m) => m.role === 'user')) {
      this.telemetry?.record({ type: 'task', sid: o.session.id, action: 'created', mode: o.mode ?? o.session.mode });
    }
    let error: string | undefined;
    let reply: string | undefined;
    const span = startRunSpan(this.telemetry?.tracing, { sid: o.session.id, mode: o.mode ?? o.session.mode, depth: o.depth ?? 0, agent: (o.depth ?? 0) > 0 ? o.session.title.split(':')[0] : undefined, input: () => o.session.messages.filter((m) => m.role === 'user').pop()?.content });
    /** The turn's healing engine, disposed when the run ends (stop reason `shutdown` -> interrupted, a user stop -> cancelled). */
    const life: { heal?: HealingEngine; run?: RunHandle } = {};
    // Continuity (SESSION): the run becomes an agent session; its events, execution events; its streaming text, a draft.
    if (topLevel && !o.scratch && this.sessionHooks) {
      try {
        life.run = this.sessionHooks.start({ session: o.session, userMessage: o.userMessage, run: o.userMessage.meta?.checkpoint, traceId: o.traceId, mode: o.mode ?? o.session.mode, specialist: o.specialist ?? o.session.specialist, model: o.modelRef ?? o.session.model, root: o.workspaceRoot ?? this.workspace.root });
      } catch (e) {
        this.log.warn(`continuity: run start: ${e instanceof Error ? e.message : String(e)}`);
      }
      const h = life.run;
      if (h) {
        const base = o.emit;
        o = {
          ...o,
          emit: (e) => {
            base(e);
            try {
              h.event(e);
            } catch {
              // never breaks the run
            }
          },
        };
      }
    }
    try {
      const tracing = this.telemetry?.tracing;
      const text = await (tracing ? tracing.with(span, () => this.runTurn(o, stats, life)) : this.runTurn(o, stats, life));
      outcome = o.signal.aborted ? 'stopped' : 'done';
      const last = o.session.messages[o.session.messages.length - 1];
      error = last?.role === 'assistant' ? last.meta?.error : undefined;
      reply = text;
      return text;
    } catch (e) {
      outcome = o.signal.aborted ? 'stopped' : 'failed';
      error = e instanceof Error ? e.message : String(e);
      throw e;
    } finally {
      if (life.heal) {
        const reason: unknown = o.signal.aborted ? o.signal.reason : undefined;
        await life.heal.dispose(reason instanceof Error ? reason.message : typeof reason === 'string' ? reason : o.signal.aborted ? 'cancelled' : undefined).catch((e) => this.log.warn(`Self-healing: could not close the recovery state: ${e instanceof Error ? e.message : String(e)}`));
      }
      this.unassign(o.session.id);
      if (life.run) {
        try {
          life.run.end(this.runEnd(o, stats, outcome, error));
        } catch (e) {
          this.log.warn(`continuity: run end: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      if (topLevel && !o.scratch && (outcome === 'stopped' || error)) {
        this.endHook(o, outcome === 'stopped' ? 'TaskCancel' : 'TaskError', error);
      }
      this.telemetry?.record({
        type: 'run',
        sid: o.session.id,
        mode: o.mode ?? o.session.mode,
        model: stats.model || o.session.model || '',
        depth: o.depth ?? 0,
        agent: (o.depth ?? 0) > 0 ? o.session.title.split(':')[0] : undefined,
        role: (o.depth ?? 0) > 0 && (o.role ?? 'agent') === 'agent' ? 'coding' : o.role ?? ((o.mode ?? o.session.mode) === 'plan' ? 'reasoning' : 'agent'),
        outcome,
        durationMs: Date.now() - stats.startedAt,
        steps: stats.steps,
        toolCalls: stats.toolCalls,
        promptTokens: stats.promptTokens,
        completionTokens: stats.completionTokens,
        isolated: !!o.isolatedFrom,
        ...spanIds(span),
      });
      endRunSpan(span, { model: stats.model || o.session.model, outcome, error, steps: stats.steps, toolCalls: stats.toolCalls, promptTokens: stats.promptTokens, completionTokens: stats.completionTokens, output: reply });
      if (topLevel) {
        const healed = (stats as HealedStats).outcome;
        const done = stats.mistakeLimited ? 'mistake_limit' : healed === 'incomplete' || healed === 'blocked' || healed === 'completed_unverified' ? healed : healed === 'cancelled' ? 'aborted' : healed === 'failed' ? 'failed' : 'completed';
        this.telemetry?.record({ type: 'task', sid: o.session.id, action: outcome === 'done' ? done : outcome === 'stopped' ? 'aborted' : 'failed', mode: o.mode ?? o.session.mode });
      }
    }
  }

  /** What the SESSION hooks record when a run ends: the outcome (a shutdown stop is `interrupted`), tokens, files touched. */
  private runEnd(o: AgentRunOptions, stats: RunStats, outcome: 'done' | 'stopped' | 'failed', error: string | undefined): RunEndInfo {
    const reason: unknown = o.signal.aborted ? o.signal.reason : undefined;
    const why = reason instanceof Error ? reason.message : typeof reason === 'string' ? reason : '';
    const root = o.workspaceRoot ?? this.workspace.root;
    const run = o.userMessage.meta?.checkpoint;
    const filesTouched: NonNullable<RunEndInfo['filesTouched']> = [];
    if (run !== undefined && this.tracker) {
      for (const [fsPath, original] of this.tracker.turnOriginals(o.session.id, run)) {
        if (filesTouched.length >= 200) {
          break;
        }
        const rel = root ? path.relative(root, fsPath) : fsPath;
        const shown = rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel.split(path.sep).join('/') : fsPath;
        filesTouched.push({ path: shown, status: original === undefined ? 'A' : fs.existsSync(fsPath) ? 'M' : 'D' });
      }
    }
    return {
      outcome: outcome === 'stopped' ? (/shutdown/i.test(why) ? 'interrupted' : 'stopped') : outcome === 'failed' || error ? 'error' : 'ok',
      ...(error ? { error } : {}),
      ...(stats.model ? { model: stats.model } : {}),
      ...(stats.promptTokens ? { promptTokens: stats.promptTokens } : {}),
      ...(stats.completionTokens ? { completionTokens: stats.completionTokens } : {}),
      filesTouched,
    };
  }

  /**
   * TaskCancel / TaskError hooks: not awaited by the run, since it is already over (and a stopped run's signal is
   * aborted). A process about to exit waits for them with `hooksSettled()`; `idle()` waits for them too.
   */
  private endHook(o: AgentRunOptions, event: 'TaskCancel' | 'TaskError', error?: string): void {
    if (!this.hooks?.has(event)) {
      return;
    }
    const sessionId = o.session.id;
    const p = this.hooks
      .run(event, { session_id: sessionId, ...(event === 'TaskError' ? { error: error ?? '' } : {}) }, { cwd: o.workspaceRoot ?? this.workspace.root, onRun: (h) => o.emit({ sessionId, type: 'hook', payload: h }) })
      .catch((e) => this.log.warn(`hooks: ${event} failed: ${e instanceof Error ? e.message : String(e)}`));
    this.pendingHooks.add(p);
    void p.finally(() => this.pendingHooks.delete(p));
    this.track(p);
  }

  /** TaskCancel / TaskError hooks still running. */
  private readonly pendingHooks = new Set<Promise<unknown>>();
  /** Resolves when the TaskCancel / TaskError hooks have finished, or after `timeoutMs`; true when some were still running. */
  async hooksSettled(timeoutMs = 5_000): Promise<boolean> {
    if (!this.pendingHooks.size) {
      return false;
    }
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([Promise.allSettled([...this.pendingHooks]), new Promise((r) => (timer = setTimeout(r, timeoutMs)))]);
    clearTimeout(timer);
    return true;
  }

  private async runTurn(o: AgentRunOptions, stats: HealedStats, life: { heal?: HealingEngine; run?: RunHandle } = {}): Promise<string> {
    const cfg = getConfig();
    const depth = o.depth ?? 0;
    const session = o.session;
    const turnMode = o.mode ?? session.mode;
    const emit = o.emit;
    const status = (text: string) => emit({ sessionId: session.id, type: 'status', payload: text });
    const hookRow = (h: HookRunInfo) => emit({ sessionId: session.id, type: 'hook', payload: h });

    // Captured before routing: the user may pick another model while the route is resolved, and that pick must stand.
    const requested = o.modelRef ?? session.model;
    const ownChoice = !!session.model && (!o.modelRef || o.modelRef === session.model);
    let route: Awaited<ReturnType<ProviderRegistry['route']>>;
    const routeOnce = () =>
      this.providers.route({
        role: o.role ?? (!requested && o.taskRole ? o.taskRole : turnMode === 'plan' ? 'reasoning' : 'agent'),
        byTask: !requested && !!o.taskRole && depth === 0,
        modelRef: requested,
        fresh: true,
        needsVision: !!o.userMessage.images?.length || session.messages.some((m) => m.role === 'user' && !!m.images?.length && Date.now() - (m.meta?.timestamp ?? 0) < 10 * 60_000),
        spread: o.spreadModels ?? (depth > 0 || !requested),
        load: this.loadFor(session.id),
        signal: o.signal,
      });
    // Self-healing: "no server reachable" is retried with backoff and a health probe before the turn gives up.
    const healRouting = this.healing && !o.scratch && cfg.healing.enabled && (depth === 0 || o.healingRole === 'fixer') ? this.healing : undefined;
    try {
      route = healRouting
        ? await healRouting.routeRetry(effectivePolicies(cfg.healing).model_unavailable, routeOnce, requested ?? cfg.providers.find((p) => p.enabled !== false)?.id, o.signal, session.id)
        : await routeOnce();
    } catch (e) {
      if (o.signal.aborted) {
        throw e;
      }
      if (healRouting && depth === 0) {
        const failure = classifyModelError(e);
        await healRouting.escalateRun(session.id, failure === 'auth' || failure === 'quota' ? 'credentials' : 'model_unavailable', e).catch((x) => this.log.warn(`Self-healing: could not record the routing failure: ${String(x)}`));
      }
      // No model to answer (server down, model missing): keep the prompt and the error in the chat so Retry has something to resend.
      const friendly = e instanceof Error ? e.message : String(e);
      this.log.error(`model routing failed: ${friendly}`);
      session.messages.push({ ...o.userMessage, meta: { ...o.userMessage.meta, timestamp: Date.now() } });
      session.messages.push({ role: 'assistant', content: `(error: ${friendly})`, meta: { timestamp: Date.now(), error: friendly } });
      const slash = requested?.indexOf('/') ?? -1;
      const providerType = (slash > 0 ? this.providers.get(requested!.slice(0, slash))?.type : undefined) ?? (cfg.providers.some((p) => p.enabled !== false && p.type === 'ollama') ? 'ollama' : undefined);
      // Routing fails when no server answers or no model is installed: the fix is the same as for a refused connection.
      const kind = errorKind(classifyModelError(e));
      emit({ sessionId: session.id, type: 'error', payload: { message: friendly, kind: kind === 'other' ? 'connection' : kind, provider: providerType } });
      const err = e instanceof Error ? e : new Error(friendly);
      (err as Error & { reported?: boolean }).reported = true;
      throw err;
    }
    // Reassigned only by a self-healing reroute after an overload (same tool protocol, capabilities and locality).
    let { provider } = route;
    // The stricter limits are for a side model with a fallback; the parent's own model gets the normal patience.
    const onSide = !o.sideModelOf || route.model.id !== o.sideModelOf;
    const maxModelRetries = onSide ? o.maxModelRetries ?? MAX_MODEL_RETRIES : MAX_MODEL_RETRIES;
    // One number for the budget and for the request: the window the model is actually given (the setting, capped by
    // the model; 0 = the model's full native window). Budgeting against the native window while sending a smaller
    // num_ctx would let the server truncate silently before compaction ever triggered.
    let model: ModelInfo = { ...route.model, contextWindow: effectiveContextWindow(route.model, cfg.contextWindow) };
    stats.model = model.id;
    this.assign(model.id, session.id);
    const profile = model.runtime ? await getSystemProfile().catch(() => undefined) : undefined;
    if (route.reason) {
      status(route.reason);
    }
    // A substitute model answers this turn: say so in the chat (a note at the top of the turn), not only in the status line.
    if (depth === 0 && route.fallback && requested && requested !== model.id) {
      emit({ sessionId: session.id, type: 'route', payload: { wanted: requested, used: model.id, usedName: model.name, reason: route.reason ?? '', fallback: true, unavailable: !!route.unavailable, cloud: !!model.remote } });
    }
    // Keep the session on the user's chosen model when a turn was redirected (e.g. to a vision model); an
    // unavailable model is replaced for good so the picker reflects what is actually answering — unless only its
    // server missed the last check, then the substitute answers this turn and the next one tries it again. A model chosen only
    // because the intended one was busy is not kept either: the next turn routes afresh. An Auto chat stays Auto:
    // every turn is routed again (to the default, a vision model for images, or an idle model when this one is busy),
    // and the UI shows what answered from the `model_request` event. A one-off model (a command's `model:`) does not
    // change the chat's model either.
    // Subagent sessions are ephemeral: record what actually answered so the parent can report or quarantine it.
    // A cloud model standing in for a local (or unknown) one is never written into the chat: the next turn tries the local one again.
    const wantedCfg = session.model ? cfg.providers.find((p) => session.model!.startsWith(`${p.id}/`)) : undefined;
    const cloudForLocal = route.fallback && !!model.remote && !(wantedCfg && isCloudProvider(wantedCfg));
    if (depth > 0 || (session.model === requested && ownChoice && (!route.reason || (route.fallback && !route.unavailable)) && !route.spread && !cloudForLocal)) {
      session.model = model.id;
    }

    const ctxMgr = new ContextManager({ compactionThreshold: cfg.compactionThreshold, maxToolOutputChars: cfg.maxToolOutputChars, keepAlive: cfg.keepAlive || undefined, scale: () => tokenCalibration.scale(model.id), sessionId: session.id, strategy: cfg.compactionStrategy });
    let pool = new ParallelPool(cfg.parallel.maxConcurrency);

    const toolsEnabled = turnMode !== 'ask' || true; // ask mode still gets read-only tools
    // Situational tools (git/CI, board, repositories, security) only when the recent conversation or the workspace calls for them.
    const recent = [...session.messages.filter((m) => m.role === 'user' && !m.meta?.toolResults && !m.meta?.toolImages).slice(-3).map((m) => userText(m.content)), userText(o.userMessage.content), o.roleOverride ?? ''].join('\n');
    // Shared state (the board, repos.json) lives in the real checkout, not in an isolated worktree.
    const root = this.workspace.root ?? o.workspaceRoot;
    // Once offered in a chat, a tool stays offered: tool definitions sit at the start of the prompt, and a list that
    // changes from turn to turn would make the server re-read the whole prompt (no prefix cache) on every change.
    const offered = this.offeredTools.get(session.id) ?? new Set<string>();
    const omit = o.toolFilter ? undefined : irrelevantTools(recent, root, root ? listRepos(root, (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath), getConfig().repos).length : 0);
    offered.forEach((n) => omit?.delete(n));
    // Scratch runs (benchmark) work in throwaway folders: this project's memory is neither shown nor written.
    const selected = this.selectTools(turnMode, o.toolFilter, omit).filter((t) => !o.scratch || !t.definition.name.startsWith('memory_'));
    // GPT/Codex/gpt-oss models edit with apply_patch, the rest with edit_file/write_file (localpilot.editTool).
    const editOmit = editToolsToOmit(selected.map((t) => t.definition.name), model.id, getConfig().editTool);
    const toolList = selected.filter((t) => !editOmit.has(t.definition.name));
    if (!o.toolFilter && depth === 0) {
      toolList.forEach((t) => offered.add(t.definition.name));
      this.offeredTools.delete(session.id);
      this.offeredTools.set(session.id, offered);
      // Most recently used chats only: the map must not grow with every chat ever opened.
      if (this.offeredTools.size > 200) {
        this.offeredTools.delete(this.offeredTools.keys().next().value!);
      }
    }
    const nativeTools = model.supportsTools;
    const toolDefs: ToolDefinition[] = toolsEnabled ? toolList.map((t) => t.definition) : [];

    // Conditional rules (`paths:` / `globs:` front matter) follow the files in context this turn.
    const contextPaths = o.scratch ? [] : this.workspace.contextPaths(o.userMessage.content, session.workingSet);
    // About 5% of the window for memory (1.5k–12k characters), so notes never crowd out the conversation on a small model.
    // Notes the prompt leaves out (local only for a cloud model, over budget) are listed in the context snapshot.
    const memoryExcluded: ExcludedRef[] = [];
    const memorySection = cfg.memoryEnabled && depth === 0 && !o.scratch ? await this.memory?.promptSection(Math.min(12_000, Math.max(1_500, Math.floor(model.contextWindow * 4 * 0.05))), { sessionId: session.id, cloud: !!model.remote, excluded: memoryExcluded }) : undefined;
    const system = await buildSystemPrompt({
      contextPaths,
      mode: turnMode,
      // Only the chat's own turns: a one-off mode (an empty-chat suggestion) or a subagent run is not the specialist.
      specialist: depth === 0 && !o.roleOverride ? (o.specialist ?? (turnMode === session.mode ? session.specialist : undefined)) : undefined,
      workspaceRoot: o.workspaceRoot,
      model,
      toolsEnabled,
      textToolProtocol: toolsEnabled && !nativeTools,
      skills: this.skills,
      canLoadSkills: toolDefs.some((t) => t.name === 'load_skill'),
      workspace: this.workspace,
      append: cfg.systemPromptAppend,
      roleOverride: o.roleOverride,
      clarify: cfg.clarify,
      canSaveMemory: toolDefs.some((t) => t.name === 'memory_save'),
      canScreenshot: toolDefs.some((t) => t.name === 'browser_screenshot'),
      canInspect: toolDefs.some((t) => t.name === 'browser_inspect'),
      canOpenBrowser: toolDefs.some((t) => t.name === 'open_browser'),
      canSearchWeb: toolDefs.some((t) => t.name === 'web_search' || t.name === 'web_fetch'),
      patchEdits: toolDefs.some((t) => t.name === 'apply_patch') && !toolDefs.some((t) => t.name === 'edit_file'),
      preferredLanguage: cfg.preferredLanguage,
      project: !o.scratch,
      memory: memorySection,
    });
    const conditional = depth === 0 && !o.scratch ? this.workspace.conditionalRulesFor(contextPaths) : [];
    if (conditional.length) {
      emit({ sessionId: session.id, type: 'rules_applied', payload: { files: conditional.map((f) => f.label) } });
    }
    const turnContextBase = buildTurnContext({ mode: turnMode, workspace: this.workspace, workingSet: session.workingSet, todos: session.todos });
    // A chat reopened after its files changed elsewhere: say which ones, once (continuity's context restoration).
    const changedNote = depth === 0 && !o.scratch ? this.contextHooks?.turnNote?.(session) : undefined;
    const turnContext = changedNote ? (turnContextBase ? turnContextBase.replace(/<\/turn-context>$/, `\n${changedNote}\n</turn-context>`) : `<turn-context>\n${changedNote}\n</turn-context>`) : turnContextBase;
    const isolated = !!o.isolatedFrom;
    const systemIsolated = isolated && !o.scratch
      ? `${system}\n\n# Isolated workspace\nYou are working in an isolated copy of the repository (a git worktree at ${o.workspaceRoot}). It mirrors the user's checkout including their uncommitted work. Use relative paths as usual; file, search and terminal tools already run inside the copy. The user reviews your changes afterwards and applies them to the real workspace, so finish the task completely here — do not ask them to copy anything.`
      : system;
    const systemWithTextTools = !nativeTools && toolDefs.length ? `${systemIsolated}\n\n# Tools\n${toolDefs.map((t) => `- ${t.name}: ${t.description}\n  parameters: ${JSON.stringify(t.parameters)}`).join('\n')}` : systemIsolated;
    // What fills the window, for the context ring's card and /context (rules are cached by the prompt build above).
    const rulesText = o.scratch || depth > 0 ? '' : await this.workspace.loadInstructions(undefined, contextPaths);
    const breakdownOf = (history: readonly ChatMessage[], total?: number) =>
      contextBreakdown({ system: turnContext ? `${systemWithTextTools}\n\n${turnContext}` : systemWithTextTools, rules: rulesText, memory: memorySection, tools: toolDefs, toolsInSystem: !nativeTools, messages: history, scale: tokenCalibration.scale(model.id), total });
    const emitContext = (total?: number) => {
      if (depth === 0) {
        session.contextBreakdown = breakdownOf(session.messages, total);
      }
      emit({ sessionId: session.id, type: 'context', payload: { contextTokens: session.contextTokens, contextWindow: model.contextWindow, ...(depth === 0 ? { breakdown: session.contextBreakdown } : {}) } });
    };
    // Continuity (1.7): what the model saw, per turn and around each compaction. Never fails the turn.
    const recordContext = (phase: 'turn' | 'before-compaction' | 'after-compaction', history: readonly ChatMessage[], usedTokens: number, compaction?: CompactionDetails) => {
      if (depth !== 0 || o.scratch || !this.contextHooks?.snapshot) {
        return;
      }
      try {
        this.contextHooks.snapshot({ session, model, phase, messages: history, usedTokens, breakdown: phase === 'turn' && session.contextBreakdown ? session.contextBreakdown : breakdownOf(history), memorySection, memoryExcluded, rules: rulesText, ruleLabels: conditional.map((f) => f.label), compaction, root: o.workspaceRoot ?? this.workspace.root });
      } catch (e) {
        this.log.debug(`context snapshot skipped: ${e instanceof Error ? e.message : String(e)}`);
      }
    };
    /** The history and size of the turn's latest request (the turn's snapshot). */
    let lastRequest: { messages: ChatMessage[]; tokens: number } | undefined;

    const wasEmpty = session.messages.length === 0;
    // A chat with earlier messages that this runner has not run yet was reopened (history, `--resume`): SessionStart `resume`.
    const resumed = depth === 0 && !o.scratch && !wasEmpty && !this.startedSessions.has(session.id);
    if (depth === 0 && !o.scratch) {
      this.startedSessions.add(session.id);
    }
    const turnMessage: ChatMessage = { ...o.userMessage, meta: { ...o.userMessage.meta, timestamp: Date.now() } };
    if (nativeTools) {
      closeDanglingToolCalls(session.messages);
    }
    session.messages.push(turnMessage);
    if (depth === 0) {
      o.onUserMessage?.(turnMessage);
      try {
        life.run?.userMessage?.(turnMessage);
      } catch {
        // continuity never breaks a run
      }
    }
    if (depth === 0 && !o.scratch && this.checkpoints) {
      // Before hooks and the first model call, so everything this turn changes (shell commands included) can be rolled back.
      const run = o.userMessage.meta?.checkpoint ?? this.tracker?.currentTurnOf(session.id) ?? session.messages.length - 1;
      const taken = await this.checkpoints.snapshot(session, run, o.workspaceRoot ?? this.workspace.root);
      if (taken && taken.outcome !== 'skipped') {
        this.telemetry?.record({ type: 'checkpoint', action: 'create', outcome: 'ok' });
      }
    }

    // Hooks: SessionStart (first turn of a chat, or of a resumed one) and UserPromptSubmit may add context or block the prompt.
    const hookRoot = o.workspaceRoot ?? this.workspace.root;
    if (depth === 0 && !o.scratch && this.hooks && (this.hooks.has('SessionStart') || this.hooks.has('UserPromptSubmit'))) {
      const hookContext: string[] = [];
      if ((wasEmpty || resumed) && this.hooks.has('SessionStart')) {
        const source = wasEmpty ? 'startup' : 'resume';
        const r = await this.hooks.run('SessionStart', { session_id: session.id, source }, { cwd: hookRoot, matchKey: source, signal: o.signal, onRun: hookRow });
        if (r.stop) {
          const note = `Stopped by a hook: ${r.stop}`;
          session.messages.push({ role: 'assistant', content: note, meta: { timestamp: Date.now() } });
          emit({ sessionId: session.id, type: 'assistant_delta', payload: note });
          emit({ sessionId: session.id, type: 'turn_end', payload: { text: note, contextTokens: session.contextTokens, durationMs: Date.now() - stats.startedAt, steps: 0, toolCalls: 0 } });
          return note;
        }
        hookContext.push(...r.context);
      }
      if (this.hooks.has('UserPromptSubmit')) {
        status('Running prompt hooks…');
        const r = await this.hooks.run('UserPromptSubmit', { session_id: session.id, prompt: userText(o.userMessage.content) }, { cwd: hookRoot, signal: o.signal, onRun: hookRow });
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
        const snapshot = await gatherRequestContext(this.workspace, session, o.workspaceRoot);
        session.messages.push({ role: 'user', content: clarificationSteer(assessment, snapshot), meta: { timestamp: Date.now(), hidden: true } });
        emit({ sessionId: session.id, type: 'clarify', payload: { reasons: assessment.reasons } });
      }
    }

    // A first request to build something: ask the open questions in one card before work starts (clarify.questions).
    // Only when the chat can show questions — queued and API runs have nobody to answer.
    if (depth === 0 && !o.roleOverride && o.askUser && !o.unattended && needsQuestions(o.userMessage.content, cfg.clarify, { mode: turnMode, hasHistory: session.messages.some((m) => m.role === 'assistant' && !!m.content.trim()) })) {
      session.messages.push({ role: 'user', content: questionSteer(cfg.clarify), meta: { timestamp: Date.now(), hidden: true } });
    }

    // "Implement the plan": the checklist already holds delegable items, so make the fan-out the first step
    // instead of hoping the model remembers run_todos_parallel.
    if (depth === 0 && turnMode === 'agent' && !o.roleOverride) {
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
        // "Remember that…" is the memory tools' job; a skill detour would store it somewhere the next session never reads.
        const prescribed = namesTool(request, toolDefs.map((t) => t.name)) || (toolDefs.some((t) => t.name === 'memory_save') && asksToRemember(request));
        const ss = session.skills ?? {};
        // Registry behaviour follows the chat override, else `skills.autoInstall`. Only the chat-level "off" also
        // silences suggestions for installed skills — the global setting is about downloading, and matching what is
        // already on disk costs nothing.
        // An organisation that turned skill downloads off gets no catalog matching at all (installed skills still match).
        const mode: 'auto' | 'ask' | 'off' = getManagedPolicy(this.log).allowSkillInstall ? ss.mode ?? cfg.skillAutoInstall : 'off';
        const quiet = ss.mode === 'off';
        const enabled = this.skills.enabledSkills;
        // Already in context: load_skill results and skills preloaded into earlier hidden messages.
        const loaded = new Set(
          session.messages.flatMap((m) => ((m.role === 'tool' && m.toolName === 'load_skill') || (m.role === 'user' && (m.meta?.hidden || m.meta?.toolResults)) ? [...m.content.matchAll(/<skill name="([^"]+)"/g)].map((x) => x[1]) : []))
        );
        const suggestions = quiet && !forced ? { skills: [] as SkillMatch[], create: undefined } : this.learner ? await this.learner.observeRequest(request, enabled) : { skills: recommendSkills(request, enabled), create: undefined };
        let fresh: SkillMatch[] = suggestions.skills.filter((s) => !loaded.has(s.name));
        let installed: { name: string; repo: string; dir: string } | undefined;
        let available: { name: string; description: string; repo: string } | undefined;
        if (this.catalog && mode !== 'off' && !forced && !prescribed) {
          const remote = await this.catalog.match(request, enabled, this.skills.allSkills.map((s) => s.name));
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
    // The diff preview opens only beside a real prompt; an edit allowed for the session is left to afterEditWritten.
    const prompt = (title: string, detail: string, kind: NonNullable<Tool['approvalKind']>, mandatory: boolean, opts?: ApprovalOptions) => {
      const ask = () => o.requestApproval(title, detail, kind, { mandatory });
      return o.willPrompt?.(kind, mandatory) === false ? ask() : withEditPreview(opts?.preview, ask);
    };
    /** The turn's self-healing engine (created below, once the tool context exists); undefined = healing is off for this run. */
    let heal: HealingEngine | undefined;
    // Children without their own engine route their writes to the root session's engine (its patch scopes and fingerprints).
    const writeHeal = (): HealingEngine | undefined => heal ?? (depth > 0 ? this.healing?.forRoot(ChangeTracker.rootSession(session.id)) : undefined);
    const rootHeal = (): HealingEngine | undefined => (depth > 0 ? this.healing?.forRoot(ChangeTracker.rootSession(session.id)) : undefined);
    // Subagents and fixer workers of a root recovery write the fixes: their dangerous commands always ask too, and
    // their approvals land in the root's audit trail when they have no engine of their own.
    const approvalHeal: ApprovalRecorder | undefined = this.healing
      ? {
          inRecovery: () => !!heal?.inRecovery() || !!rootHeal()?.inRecovery(),
          recordApproval: (r) => (heal ?? rootHeal())?.recordApproval(r),
        }
      : undefined;
    const toolCtx: ToolContext = {
      sessionId: session.id,
      skills: [...activeSkills],
      workspaceRoot: o.workspaceRoot ?? this.workspace.root,
      isolatedFrom: o.isolatedFrom,
      mainRoot: this.workspace.root,
      signal: o.signal,
      control,
      depth,
      modelRef: model.id,
      readOnly: !isWriteMode(turnMode),
      mode: turnMode,
      progress: (t) => status(t),
      // Edits inside an isolated worktree need no undo snapshots: discarding the worktree is the undo, and the
      // tracker stays about files in the real workspace (those applied from the worktree).
      trackChange: (fsPath) => {
        const track = () => (isolated ? Promise.resolve() : (this.tracker?.beforeChange(fsPath, session.id) ?? Promise.resolve()));
        const h = writeHeal();
        return h ? h.beforeWrite(fsPath, heal ? undefined : session.id).catch((e) => this.log.warn(`Self-healing: could not snapshot ${fsPath}: ${String(e)}`)).then(track) : track();
      },
      todos: {
        get: () => session.todos ?? [],
        set: (items) => {
          session.todos = items;
          emit({ sessionId: session.id, type: 'todos', payload: items });
          if (depth === 0 && !o.scratch) {
            try {
              this.memoryHooks?.onTodos?.(session, items);
            } catch (e) {
              this.log.debug(`memory: task note skipped: ${String(e)}`);
            }
          }
        },
      },
      // The approval setting is read at each request, so a change in the composer's auto-approve bar applies mid-run.
      approve: (title, detail, kind, opts) => this.gateApproval(kind, getConfig().approvals[kind], (mandatory) => prompt(title, detail, kind, mandatory, opts), emit, session.id, { ...opts, title, detail, root: hookRoot, request: userText(o.userMessage.content), signal: o.signal, heal: approvalHeal }),
      requestApproval: async (title, detail, kind, opts) => (await toolCtx.approve!(title, detail, kind, opts)).ok,
      askUser: depth === 0 ? o.askUser : undefined,
      recordUsage: (u, m, p) => {
        // The chat's own last model stays the one it answers with; the subagent's model only travels upwards.
        session.usage = addUsage(session.usage, u, undefined, undefined, true);
        o.onUsage?.(u, m ?? '', p ?? '');
      },
    };
    const makePolicy = (origin?: 'healing', signal: AbortSignal = o.signal): ToolPolicy => ({
      settings: this.projectSettings?.() ?? emptySettings(),
      extraAllow: o.permissionAllow ?? [],
      hooks: this.hooks,
      root: hookRoot,
      sessionId: session.id,
      // An `ask` rule still goes through auto mode's reviewer; only an explicit `deny` skips the model.
      ask: (title, detail, kind, opts) => this.gateApproval(kind, 'ask', (mandatory) => prompt(title, detail, kind, mandatory, opts), emit, session.id, { title, detail, root: hookRoot, request: userText(o.userMessage.content), signal, mandatory: opts?.mandatory, dangerous: opts?.dangerous, confirm: opts?.confirm, heal: approvalHeal, ...(origin ? { origin, unattended: o.unattended } : {}) }),
      askMandatory: (title, detail, kind, opts) => this.gateApproval(kind, 'ask', (mandatory) => prompt(title, detail, kind, mandatory, opts), emit, session.id, { title, detail, root: hookRoot, request: userText(o.userMessage.content), signal, mandatory: true, heal: approvalHeal, ...(origin ? { origin, unattended: o.unattended } : {}) }),
      signal,
    });
    const policy = makePolicy();

    // --- Self-healing (design §2.5, §5.3, §10) ----------------------------------------------
    /**
     * A check or resolver command of the engine: a synthetic run_command through managed policy, permission rules,
     * hooks, the approval gate and the audit log, isolated from the model's turn (own identical-call counts, no
     * mistake counting, no step counters, nothing appended to the transcript). The raw outcome, not the clamped tool
     * text, goes back to the classifier.
     */
    const runSyntheticCommand: HealingExec = async (spec, signal, flags) => {
      // From the full registry: an agent whose tool filter omits run_command is still verified.
      const tool = this.tools.get('run_command');
      if (!tool) {
        return { exitCode: null, output: 'Tool "run_command" is not available.' };
      }
      const args = { command: spec.command, ...(spec.cwd ? { cwd: spec.cwd } : {}), timeout_seconds: flags.timeoutSeconds, ...(flags.requiresApproval ? { requires_approval: true } : {}) };
      const call: ToolCall = { id: `heal_${newId()}`, name: 'run_command', arguments: JSON.stringify(args) };
      const got: { raw?: HealingRawOutcome } = {};
      const healingAllowance = flags.kind === 'check' ? flags.allowance : undefined;
      const approve: NonNullable<ToolContext['approve']> = (title, detail, kind, opts) =>
        this.gateApproval(kind, getConfig().approvals[kind], (mandatory) => prompt(healingAllowance ? 'Run verification checks (LocalPilot self-healing)' : title, detail, kind, mandatory, opts), emit, session.id, {
          ...opts, ...(healingAllowance ? { healingAllowance } : {}), title, detail, root: hookRoot, request: userText(o.userMessage.content), signal, heal: approvalHeal, origin: 'healing', unattended: o.unattended,
        });
      const ctx: ToolContext = {
        ...toolCtx,
        signal,
        approve,
        requestApproval: async (title, detail, kind, opts) => (await approve(title, detail, kind, opts)).ok,
        healingExec: {
          origin: 'healing',
          noAutoDetach: true,
          timeoutSeconds: flags.timeoutSeconds,
          checkSpecMatch: flags.checkSpecMatch,
          rawOutcome: (r) => {
            got.raw = r;
          },
        },
      };
      const step = await this.executeToolCalls([call], [tool], ctx, pool, ctxMgr, emit, session.id, nativeTools, new Map(), false, undefined, turnMode, makePolicy('healing', signal), false, { origin: 'healing', callCounts: new Map(), skipMistakes: true, tools: [tool] });
      const text = step.perCall[0]?.content ?? '';
      const skipped = step.decisions.get(call.id);
      if (skipped) {
        return { exitCode: null, output: text, skipped };
      }
      const r = got.raw;
      if (!r) {
        return { exitCode: null, output: text };
      }
      return { exitCode: r.exitCode ?? null, output: r.failed ? `${r.failed}\n${r.output}` : r.output, ...(r.timedOut ? { timedOut: true } : {}), ...(r.detached ? { detached: true } : {}) };
    };
    /** Hidden fix prompt of an inline attempt: `meta.healing` only, never `meta.nudge` (the chat would retract the reply). */
    const injectHidden = (msg: FixPromptMessage) => {
      session.messages.push({ role: 'user', content: msg.content, meta: { timestamp: Date.now(), hidden: true, healing: { ...msg.meta.healing } } });
    };
    /** Delegated fix: a synthetic run_parallel_subagents call (fixer workers), kept in the transcript so it stays well-formed. */
    const runSyntheticDelegation: HealingDelegate = async (tasks, signal) => {
      const tool = this.tools.get('run_parallel_subagents');
      if (!tool) {
        return { ok: false, content: 'Tool "run_parallel_subagents" is not available.' };
      }
      const items = tasks.map((t) => ({ agent: t.agent, prompt: t.prompt, origin: t.origin }));
      const call: ToolCall = { id: newId(), name: 'run_parallel_subagents', arguments: JSON.stringify({ tasks: items }) };
      // Text-protocol models read calls from the reply text, so the synthetic call is written there too.
      const asText = nativeTools ? '' : `\`\`\`tool_call\n${JSON.stringify({ name: call.name, arguments: { tasks: items } })}\n\`\`\``;
      session.messages.push({ role: 'assistant', content: asText, toolCalls: [call], meta: { timestamp: Date.now(), synthetic: 'healing' } });
      let writtenFiles: string[] = [];
      const capture = (e: AgentEvent) => {
        const p = e.payload as { id?: string; data?: { writtenFiles?: unknown } } | undefined;
        if (e.type === 'tool_end' && p?.id === call.id && Array.isArray(p.data?.writtenFiles)) {
          writtenFiles = p.data.writtenFiles.filter((f): f is string => typeof f === 'string');
        }
        emit(e);
      };
      const ctx: HealingSyntheticContext = { ...toolCtx, signal, healingSynthetic: true };
      const step = await this.executeToolCalls([call], [tool], ctx, pool, ctxMgr, capture, session.id, nativeTools, new Map(), model.supportsVision, undefined, turnMode, makePolicy('healing', signal), false, { origin: 'healing', callCounts: new Map(), skipMistakes: true, tools: [tool] });
      session.messages.push(...step.messages);
      return { ok: !step.failed.has(call.id) && !step.decisions.has(call.id), content: step.perCall[0]?.content ?? '', writtenFiles };
    };
    try {
      heal = this.healing?.begin({
        session, depth, mode: turnMode, role: o.healingRole, root: toolCtx.workspaceRoot, signal: o.signal, control, emit, unattended: o.unattended,
        exec: runSyntheticCommand, injectHidden, delegate: runSyntheticDelegation, contextWindow: model.contextWindow, resume: o.resume, scratch: o.scratch, taskId: o.taskId,
        turnKey: o.userMessage.meta?.checkpoint ?? this.tracker?.currentTurnOf(session.id) ?? Math.max(0, session.messages.indexOf(turnMessage)),
        maxConcurrency: cfg.parallel.maxConcurrency, mainRoot: o.isolatedFrom,
      });
    } catch (e) {
      this.log.warn(`Self-healing: could not start for this run: ${e instanceof Error ? e.message : String(e)}`);
      heal = undefined;
    }
    life.heal = heal;
    /** Outcome of the turn as the engine settled it (gate, escalation); undefined without healing. */
    let outcome: TaskOutcome | undefined;
    let contract: CompletionContract | undefined;
    /** The engine ended the turn (policy stop, deadline, resume verdict): its report is the final message. */
    let healStop: string | undefined;
    /** Times a Stop / SubagentStop hook sent the agent back to work this turn. */
    let stopHookContinues = 0;

    let finalText = '';
    const maxIter = o.maxIterations ?? MAX_ITERATIONS_DEFAULT;
    /** maxIterations plus the recovery steps the engine granted (at most `healing.extraSteps` in total). */
    let iterLimit = maxIter;
    // Read-only tool results are memoised for the turn (including in-flight calls, so identical
    // parallel requests run once); any mutating tool clears the cache.
    const toolCache = new Map<string, Promise<{ msg: ChatMessage; isError: boolean }>>();
    // A model that cannot think gets no `think` at all (Ollama rejects any value but false for it).
    // Reassigned to false when the model spends a whole reply thinking (see the empty-completion retry below).
    let think = model.supportsThinking === false ? undefined : thinkFor(thinkingLevel(session, cfg.thinking), { mode: turnMode, depth });
    let toolsExecuted = 0;
    /** Tools that change the workspace (edits, deletes, commands) — a claimed change with none of these is a claim only. */
    let mutationsExecuted = 0;
    /** Fan-outs that actually started workers this turn; a later "I'll report back when they finish" is stale, not a plan. */
    let delegationsExecuted = 0;
    /** Corrective turns handed out so far; small models often need one after the plan and one after the first tool result. */
    let nudges = 0;
    const MAX_NUDGES = 2;
    let malformedNudged = false;
    /** Malformed-call nudges so far (the self-healing model_output policy bounds them). */
    let malformedRepairs = 0;
    let toolCallRepairs = 0;
    /** Steps in a row whose tool calls all failed (or had to be repaired); the run stops at localpilot.maxConsecutiveMistakes. */
    const mistakes = new MistakeCounter(cfg.maxConsecutiveMistakes);
    /** Set when the run gives up (mistake limit, repeated output cut-offs): shown as an error and kept in the transcript. */
    let stopError: { payload: string | Record<string, unknown>; note: string; reason?: EscalationReason } | undefined;
    const stopForMistakes = () => {
      const note = mistakeLimitMessage(mistakes.count, mistakes.latest);
      stopError = { payload: { kind: 'mistake_limit', count: mistakes.count, latest: mistakes.latest, message: note }, note, reason: 'mistake_limit' };
      stats.mistakeLimited = true;
    };
    /** Cut-off tool calls retried in a row; reset by any reply that ends normally. */
    let lengthRetries = 0;
    /** The prose reply cut off at the output limit that the next reply continues (the two are joined). */
    let continuing: { message: ChatMessage; nudge: ChatMessage } | undefined;
    /** (tool, args) → how often it was requested this turn; repeats beyond MAX_IDENTICAL_CALLS are refused; reset after a successful edit. */
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
      if (!model.supportsVision && queued.some((m) => m.images?.length)) {
        status('This model cannot see images — the image was not sent; switch to a vision model.');
      }
      emit({ sessionId: session.id, type: 'steer', payload: { ids: queued.map((m) => m.meta?.steerId).filter(Boolean), count: queued.length } });
      status('Taking your new instructions into account…');
      return true;
    };

    /** Attempts of a self-healing retry policy (the `retry` note's "n/max"). */
    const healMax = (f: ModelFailureResult['failure']): number => effectivePolicies(cfg.healing)[f?.category ?? 'model_unavailable'].attempts;
    /** Model failures go to the engine unless this run must fail fast (a side model with a fallback, `maxModelRetries: 0`). */
    const healModel = (): HealingEngine | undefined => (maxModelRetries > 0 ? heal : undefined);
    /** The window may shrink after an overload, but never below what the system prompt, tool schemas and a reply need. */
    const contextFloor = (b: { systemTokens: number; toolsTokens: number }) => Math.max(MIN_CONTEXT_WINDOW, b.systemTokens + b.toolsTokens + cfg.maxOutputTokens + 1024);
    const rerouteNeeds = (): RerouteRequirement => ({
      protocol: nativeTools ? 'native' : 'text',
      vision: !!o.userMessage.images?.length || session.messages.some((m) => m.role === 'user' && !!m.images?.length && !m.meta?.toolImages),
      locality: model.remote ? 'remote' : 'local',
    });
    /** Applies the engine's resource adjustment before a model retry (§4.2 overload row). */
    const applyAdjustment = async (adjust: NonNullable<ModelFailureResult['adjust']>, floor: number): Promise<string | undefined> => {
      switch (adjust.kind) {
        case 'thinking_off':
          think = think === undefined ? undefined : false;
          return 'thinking off';
        case 'halve_context': {
          const win = Math.max(floor, Math.min(model.contextWindow, adjust.contextWindow));
          if (win >= model.contextWindow) {
            return undefined;
          }
          model = { ...model, contextWindow: win };
          return `context ${win.toLocaleString()} tokens`;
        }
        case 'serial':
          pool = new ParallelPool(1);
          this.markServedSerially(model.id);
          return 'one request at a time';
        case 'reroute': {
          const next = await this.rerouteTarget(model, adjust.require, !!cloudForLocal);
          if (!next) {
            return undefined;
          }
          // The run's model bookkeeping moves with it: the old model's slot is freed, the new one is held.
          this.release(model.id, session.id);
          provider = next.provider;
          model = { ...next.model, contextWindow: effectiveContextWindow(next.model, cfg.contextWindow) };
          stats.model = model.id;
          this.assign(model.id, session.id);
          const busyNext = this.inflight.get(model.id) ?? new Set<string>();
          busyNext.add(session.id);
          this.inflight.set(model.id, busyNext);
          return `rerouted to ${model.name}`;
        }
      }
    };

    // Resume of an interrupted recovery: rerun the checks before the model is asked anything (no edits are replayed).
    if (heal && o.resume && !o.signal.aborted) {
      const r = await heal.resumeEntry({ todos: session.todos, request: userText(o.userMessage.content) });
      if (r.action === 'continue') {
        iterLimit = Math.min(iterLimit + r.grantSteps, maxIter + cfg.healing.extraSteps);
      } else if (r.action === 'complete') {
        outcome = r.outcome;
        contract = r.contract;
        healStop = r.report ?? (r.outcome === 'completed' ? 'Verified: nothing left to fix.' : `Recovery ended: ${r.outcome.replace(/_/g, ' ')}.`);
        completed = true;
      }
    }

    for (let iter = 0; iter < iterLimit && healStop === undefined; iter++) {
      toolResultCache.tick(session.id);
      await hold();
      if (o.signal.aborted || control.aborted) {
        break;
      }
      // The recovery deadline counts only while a recovery attempt is active (no recovery, no deadline).
      if (heal?.deadlineHit()) {
        healStop = await heal.escalate('deadline');
        break;
      }
      injectSteering();

      // --- Context management ---------------------------------------------------------------
      // Keep splitting until it fits: prune old tool outputs, summarise the older part, and tighten the verbatim
      // window if a few huge recent results still do not leave room for the answer.
      const budgetOf = (h: ChatMessage[]) => ctxMgr.budget(model, turnContext ? `${systemWithTextTools}\n\n${turnContext}` : systemWithTextTools, nativeTools ? toolDefs : [], h, cfg.maxOutputTokens);
      let budget = budgetOf(session.messages);
      if (ctxMgr.needsCompaction(budget)) {
        let fit: FitResult | undefined;
        try {
          if (this.hooks?.has('PreCompact')) {
            await this.hooks.run('PreCompact', { session_id: session.id, trigger: 'auto', custom_instructions: '' }, { cwd: hookRoot, matchKey: 'auto', signal: o.signal, onRun: hookRow });
          }
          fit = await ctxMgr.fit(session.messages, provider, model, budgetOf, o.signal, () => status('Compacting conversation to fit the context window…'));
        } catch (e) {
          if (!o.signal.aborted && !control.aborted) {
            throw e;
          }
        }
        // Stopped while compacting: keep the history as it was rather than a half-finished (or truncated) summary.
        if (!fit || o.signal.aborted || control.aborted) {
          break;
        }
        if (fit.compactions.length) {
          archiveCompaction(depth === 0 ? this.archive : undefined, session.id, session.compactions, session.messages, fit.messages);
          recordContext('before-compaction', session.messages, budget.historyTokens + budget.systemTokens + budget.toolsTokens, fit.compactions[0].details);
        }
        session.messages = fit.messages;
        budget = fit.budget;
        if (fit.compactions.length) {
          recordContext('after-compaction', session.messages, budget.historyTokens + budget.systemTokens + budget.toolsTokens, fit.compactions[fit.compactions.length - 1].details);
        }
        for (const result of fit.compactions) {
          session.compactions++;
          emit({ sessionId: session.id, type: 'compaction', payload: { before: result.before, after: result.after, removed: result.removed, summary: result.summary, details: result.details } });
          if (depth === 0 && result.summary) {
            this.turnCompactions.set(session.id, result.summary);
          }
        }
      }
      session.contextTokens = budget.historyTokens + budget.systemTokens + budget.toolsTokens;
      emitContext();

      // --- Model call -----------------------------------------------------------------------
      // Back on the model after tools ran: hold the slot again (it was handed to workers during tool execution).
      this.assign(model.id, session.id);
      const busy = this.inflight.get(model.id) ?? new Set<string>();
      const others = [...busy].filter((id) => id !== session.id).length;
      // Say what the wait before the first token is: a weight load (seconds to minutes) or reading the prompt.
      const loaded = provider.loadedModels ? (await this.providers.residentModels().catch(() => undefined))?.has(model.id) : undefined;
      const promptTokens = budget.historyTokens + budget.systemTokens + budget.toolsTokens;
      const waitingFor =
        others ? `Waiting for ${model.name} — queued behind ${others} other request${others === 1 ? '' : 's'}`
        : loaded === false ? `Loading ${model.name} into memory`
        : `${model.name} is reading the prompt (~${promptTokens.toLocaleString()} tokens)`;
      const waitPhase: 'queue' | 'load' | 'prefill' = others ? 'queue' : loaded === false ? 'load' : 'prefill';
      status(others ? `Waiting for ${model.name} — busy with ${others} other chat${others === 1 ? '' : 's'}…` : loaded === false ? `${waitingFor}…` : iter === 0 ? `Thinking with ${model.name}…` : `Continuing (${iter + 1})…`);
      emit({ sessionId: session.id, type: 'model_request', payload: { model: model.id, name: model.name, queued: others } });
      busy.add(session.id);
      this.inflight.set(model.id, busy);
      const assistant: ChatMessage = { role: 'assistant', content: '', toolCalls: [], meta: { timestamp: Date.now() } };
      let text = '';
      let thinking = '';
      const calls: ToolCall[] = [];
      let finish: string | undefined;
      // Transient failures (connection drops, 5xx, a stalled server, an empty completion) are retried a
      // couple of times before the user sees an error; a context-overflow reply compacts once and retries.
      let attempt = 0;
      // compaction.strategy off: an overflow is reported, not compacted away.
      let compactedForOverflow = ctxMgr.strategy === 'off';
      let aborted = false;
      while (true) {
        text = '';
        thinking = '';
        calls.length = 0;
        finish = undefined;
        if (o.signal.aborted) {
          aborted = true;
          break;
        }
        const ac = new AbortController();
        const onAbort = () => ac.abort();
        o.signal.addEventListener('abort', onAbort, { once: true });
        let first = true;
        const requestedAt = Date.now();
        let firstAt: number | undefined;
        let usage: ProviderUsage | undefined;
        // Called exactly once per request, so it is also where the request is booked into the session's usage.
        const modelEvent = (outcome: 'ok' | 'error' | 'retry' | 'aborted', reason?: string, endedAt = Date.now()) => {
          // Priced from the bundled model facts unless the provider reported a cost; subagents pass theirs upwards.
          const priced = withCost(usage, model);
          const traced = recordModelSpan(this.telemetry?.tracing, { sid: session.id, model: model.modelId, provider: model.providerId, startMs: requestedAt, outcome, reason, finishReason: finish, promptTokens: usage?.promptTokens, completionTokens: usage?.completionTokens, ttftMs: firstAt ? firstAt - requestedAt : undefined, maxTokens: cfg.maxOutputTokens, temperature: cfg.temperature, input: () => session.messages, output: calls.length ? `${text}\n${calls.map((c) => `[tool call] ${c.name} ${c.arguments}`).join('\n')}` : text });
          this.telemetry?.record({ type: 'model', sid: session.id, model: model.modelId, provider: model.providerId, mode: turnMode, depth, promptTokens: usage?.promptTokens, completionTokens: usage?.completionTokens, cacheReadTokens: usage?.cacheReadTokens, cacheWriteTokens: usage?.cacheWriteTokens, costUsd: priced?.costUsd, ttftMs: firstAt ? firstAt - requestedAt : undefined, durationMs: endedAt - requestedAt, outcome, reason, ...traced });
          session.usage = addUsage(session.usage, priced, model.modelId, model.providerId);
          o.onUsage?.(priced, model.modelId, model.providerId);
        };
        // Continuity's context policy: a cloud model never gets blocks marked local only (memory notes, context sets,
        // conversations); a conversation tagged local-only is not sent to one at all.
        let outgoing = withTurnContext(systemWithTextTools, session.messages, turnMessage, turnContext, !model.supportsVision);
        if (this.contextHooks?.beforeRequest && !o.scratch) {
          const policed = await this.contextHooks.beforeRequest({ session, model, messages: outgoing, depth, memoryExcluded }).catch((e) => {
            this.log.warn(`context policy: ${e instanceof Error ? e.message : String(e)}`);
            return undefined;
          });
          if (policed?.block) {
            o.signal.removeEventListener('abort', onAbort);
            this.release(model.id, session.id);
            emit({ sessionId: session.id, type: 'error', payload: { message: policed.block, kind: 'other' } });
            session.messages.push({ role: 'assistant', content: `(error: ${policed.block})`, meta: { timestamp: Date.now(), error: policed.block } });
            const err = new Error(policed.block);
            (err as Error & { reported?: boolean }).reported = true;
            throw err;
          }
          outgoing = policed?.messages ?? outgoing;
        }
        lastRequest = { messages: session.messages.slice(), tokens: budget.historyTokens + budget.systemTokens + budget.toolsTokens };
        stats.steps++;
        try {
          const stream = provider.chat({
            model: model.modelId,
            messages: outgoing,
            tools: nativeTools && toolDefs.length ? toolDefs : undefined,
            temperature: model.temperature ?? cfg.temperature,
            maxTokens: cfg.maxOutputTokens,
            contextWindow: model.contextWindow,
            think,
            keepAlive: cfg.keepAlive || undefined,
            signal: ac.signal,
          });
          // A request queued behind `others` on a one-slot server legitimately waits for all of them: give it
          // their first-token budget too instead of calling it a stall and retrying (which only re-queues it).
          const patience = watchdogFor(model, profile?.modelBudgetGb);
          // Ollama sends nothing while it buffers a tool call: a measured-slow model gets time for a max-length one.
          const measured = stats.genMs && stats.genTokens ? (cfg.maxOutputTokens / (stats.genTokens / (stats.genMs / 1000))) * 1.5 * 1000 : 0;
          // The provider's own timeout is a floor: a slow gateway or cold start is not called a stall before it.
          // localpilot.firstTokenTimeoutSeconds (0 = no limit); a router-chosen side model keeps its own shorter limit.
          const sideLimit = onSide ? o.firstTokenTimeoutMs : undefined;
          const unlimited = sideLimit === undefined && cfg.firstTokenTimeoutSeconds === 0;
          const baseFirst = sideLimit ?? (cfg.firstTokenTimeoutSeconds ? cfg.firstTokenTimeoutSeconds * 1000 : FIRST_TOKEN_TIMEOUT_MS);
          const firstTokenMs = unlimited ? NO_FIRST_TOKEN_LIMIT_MS : Math.max(
            firstTokenFloor(cfg.providers.find((p) => p.id === model.providerId)),
            Math.min(baseFirst * patience.first * (1 + others), Math.max(FIRST_TOKEN_TIMEOUT_MAX_MS, baseFirst) * patience.first)
          );
          const waitLimit = { ms: firstTokenMs };
          // The first model of the fallback order that is up now, offered on the wait row as a one-click switch.
          const fallbackTo = depth === 0 ? pickFallback(cfg.routing.fallbackModels ?? [], this.providers.cachedModels(), model.id) : undefined;
          const waitPayload = (s: number) => ({ phase: waitPhase, model: model.id, name: model.name, seconds: s, limitSec: unlimited ? 0 : Math.round(waitLimit.ms / 1000), ...(fallbackTo ? { fallback: { id: fallbackTo.id, name: fallbackTo.name } } : {}) });
          let waitedSec = 0;
          if (depth === 0 && !unlimited) {
            this.waitExtenders.set(session.id, () => {
              // Another full limit from now, at least a minute.
              waitLimit.ms = Date.now() - requestedAt + Math.max(60_000, baseFirst * patience.first);
              emit({ sessionId: session.id, type: 'waiting', payload: { ...waitPayload(waitedSec), extended: true } });
            });
          }
          const guarded = withWatchdog(stream, {
            firstTokenMs,
            firstTokenLimit: () => waitLimit.ms,
            idleMs: Math.max(IDLE_TIMEOUT_MS * patience.idle, measured),
            abort: () => ac.abort(),
            onWaiting: (s) => {
              waitedSec = s;
              status(`${waitingFor} · ${s}s…`);
              emit({ sessionId: session.id, type: 'waiting', payload: waitPayload(s) });
            },
          });
          for await (const ev of guarded) {
            if (first && (ev.type === 'text' || ev.type === 'thinking' || ev.type === 'tool_call')) {
              first = false;
              firstAt = Date.now();
              this.waitExtenders.delete(session.id);
              // The chat's "Loading … into memory" row goes once output starts (it only appears after a few seconds).
              if (firstAt - requestedAt > 1500) {
                emit({ sessionId: session.id, type: 'waiting', payload: { done: true } });
              }
              emit({ sessionId: session.id, type: 'status', payload: ev.type === 'thinking' ? 'Thinking…' : 'Responding…' });
              this.noteFirstToken(model, others, requestedAt);
            }
            switch (ev.type) {
              case 'text':
                if (!text && thinking) {
                  // Reasoning is over and the answer starts: the status line must not keep saying "Thinking…".
                  emit({ sessionId: session.id, type: 'status', payload: 'Responding…' });
                }
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
              case 'done':
                finish = ev.finishReason;
                break;
              case 'usage':
                usage = ev;
                if (ev.promptTokens) {
                  // The server's count is the real size of this prompt: show it, and let it correct the estimate for
                  // the next request. A count the calibration rejects (e.g. only the uncached part) keeps the estimate.
                  const scaleBefore = tokenCalibration.scale(model.id);
                  if (tokenCalibration.record(model.id, budget.rawPromptTokens, ev.promptTokens, model.contextWindow)) {
                    if (Math.abs(tokenCalibration.scale(model.id) / scaleBefore - 1) > 0.1) {
                      this.log.info(`context: ${model.id} prompt was ${ev.promptTokens.toLocaleString()} tokens (estimated ${budget.rawPromptTokens.toLocaleString()}); estimates for it are now scaled ×${tokenCalibration.scale(model.id).toFixed(2)}`);
                    }
                    session.contextTokens = ev.promptTokens + (ev.completionTokens ?? 0);
                    emitContext(session.contextTokens);
                  }
                  stats.promptTokens += ev.promptTokens;
                  stats.completionTokens += ev.completionTokens ?? 0;
                }
                break;
            }
          }
        } catch (e) {
          o.signal.removeEventListener('abort', onAbort);
          if (depth === 0) {
            this.waitExtenders.delete(session.id);
          }
          if (o.signal.aborted) {
            modelEvent('aborted');
            aborted = true;
            break;
          }
          const kind = classifyModelError(e);
          const msg = e instanceof Error ? e.message : String(e);
          const failedAt = Date.now();
          /** The engine's verdict on this failure (healing on); it already waited its backoff when it says retry. */
          let healed: ModelFailureResult | undefined;
          // A tool call the server could not parse: repaired by resending, MAX_TOOLCALL_REPAIRS or the model_output policy.
          if (kind === 'toolcall' && heal) {
            healed = await heal.onModelFailure(kind, e, toolCallRepairs + 1, { streamed: false, modelName: model.name, target: model.id });
          }
          const repairMax = healed ? healMax(healed.failure) : MAX_TOOLCALL_REPAIRS;
          if (kind === 'toolcall' && (healed ? healed.decision.action === 'fix' || healed.decision.action === 'retry' : toolCallRepairs < MAX_TOOLCALL_REPAIRS)) {
            toolCallRepairs++;
            modelEvent('retry', kind, failedAt);
            this.log.warn(`model sent a tool call the server could not parse; asking it to resend (${toolCallRepairs}/${repairMax}): ${msg}`);
            if (mistakes.recordRepair(msg.replace(/^HTTP \d+ from \S+:\s*/, '').slice(0, 120))) {
              stopForMistakes();
              aborted = true;
              break;
            }
            status('Fixing tool call…');
            emit({ sessionId: session.id, type: 'nudge', payload: { reason: 'malformed' } });
            session.messages.push({
              role: 'user',
              content: `Your last tool call was rejected as invalid JSON (${msg.replace(/^HTTP \d+ from \S+:\s*/, '').slice(0, 200)}). Nothing was executed. Send the call again with complete, valid JSON arguments.`,
              meta: { timestamp: Date.now(), hidden: true, nudge: 'malformed' },
            });
            continue;
          }
          // Only thinking streamed before a stall (no answer text, no tool call): nothing was produced that a retry could duplicate.
          const replayable = first || (kind === 'stall' && !text && !calls.length);
          const healer = healModel();
          if (healer && !healed && !(kind === 'overflow' && !compactedForOverflow)) {
            healed = await healer.onModelFailure(kind, e, attempt + 1, {
              streamed: !replayable, modelName: model.name, target: model.id, thinking: think !== undefined && think !== false, contextWindow: model.contextWindow,
              contextFloor: contextFloor(budget), serial: this.serialWarned.has(model.id), reroute: rerouteNeeds(),
            });
          }
          const retryable = healed && healer ? healed.decision.action === 'retry' && replayable : isTransient(kind) && replayable && attempt < maxModelRetries;
          modelEvent(retryable ? 'retry' : kind === 'overflow' && !compactedForOverflow ? 'retry' : 'error', kind, failedAt);
          if (kind === 'overflow' && !compactedForOverflow) {
            // The server knows better than our estimate: shrink the history and send again.
            compactedForOverflow = true;
            this.log.warn(`model rejected the prompt as too long; compacting and retrying: ${msg}`);
            status('Prompt too long for the model — compacting and retrying…');
            const prunedForOverflow = ctxMgr.pruneToolOutputs(session.messages, 0).messages;
            let result: Awaited<ReturnType<typeof ctxMgr.compact>> | undefined;
            try {
              result = await ctxMgr.compact(prunedForOverflow, provider, model, o.signal, 4);
            } catch (ce) {
              if (!o.signal.aborted) {
                throw ce;
              }
            }
            if (!result || o.signal.aborted) {
              aborted = true;
              break;
            }
            if (result.removed > 0) {
              archiveCompaction(depth === 0 ? this.archive : undefined, session.id, session.compactions, session.messages, result.messages);
              recordContext('before-compaction', session.messages, budget.historyTokens + budget.systemTokens + budget.toolsTokens, result.details);
            }
            session.messages = prunedForOverflow;
            if (result.removed > 0) {
              session.messages = result.messages;
              recordContext('after-compaction', session.messages, budgetOf(session.messages).historyTokens, result.details);
              session.compactions++;
              emit({ sessionId: session.id, type: 'compaction', payload: { before: result.before, after: result.after, removed: result.removed, summary: result.summary, details: result.details } });
              if (depth === 0 && result.summary) {
                this.turnCompactions.set(session.id, result.summary);
              }
            }
            // Re-measure, so the retry's real count calibrates against the prompt actually sent.
            budget = budgetOf(session.messages);
            session.contextTokens = budget.historyTokens + budget.systemTokens + budget.toolsTokens;
            emitContext();
            continue;
          }
          if (retryable && healed) {
            attempt++;
            thinking = '';
            first = true;
            if (o.signal.aborted) {
              aborted = true;
              break;
            }
            const max = healMax(healed.failure);
            const adjusted = healed.adjust ? await applyAdjustment(healed.adjust, contextFloor(budget)) : undefined;
            this.log.warn(`model call failed (${kind}), self-healing retry ${attempt}/${max}${adjusted ? ` (${adjusted})` : ''}: ${msg}`);
            status(`${kind === 'stall' ? 'The model stopped responding' : kind === 'ratelimit' ? 'The server is rate limiting' : kind === 'overload' ? 'The model ran out of memory' : 'Connection to the model failed'} — retrying (${attempt}/${max})${adjusted ? ` with ${adjusted}` : ''}…`);
            emit({ sessionId: session.id, type: 'retry', payload: { attempt, max, reason: kind, message: msg, ...(adjusted ? { adjust: adjusted } : {}) } });
            continue;
          }
          if (retryable) {
            attempt++;
            // A model that went silent inside a tool call after thinking samples afresh; its partial reasoning goes.
            thinking = '';
            first = true;
            const wait = retryDelayMs(kind, e, attempt, RETRY_BACKOFF_MS);
            this.log.warn(`model call failed (${kind}), retry ${attempt}/${maxModelRetries} in ${wait}ms: ${msg}`);
            status(`${kind === 'stall' ? 'The model stopped responding' : kind === 'ratelimit' ? `The server is rate limiting — waiting ${Math.round(wait / 1000)} s` : 'Connection to the model failed'} — retrying (${attempt}/${maxModelRetries})…`);
            emit({ sessionId: session.id, type: 'retry', payload: { attempt, max: maxModelRetries, reason: kind, message: msg, delayMs: wait } });
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
          emit({ sessionId: session.id, type: 'error', payload: { message: friendly, kind: errorKind(kind), provider: provider.type } });
          // meta.error lets the transcript show the failure as an error box (with Retry) after the live turn is gone.
          session.messages.push({ role: 'assistant', content: text || `(error: ${friendly})`, meta: { timestamp: Date.now(), error: friendly } });
          // No turn_end follows: the outcome (failed / blocked) and the intervention are persisted before the throw.
          await heal?.escalate(kind === 'auth' || kind === 'quota' ? 'credentials' : 'model_unavailable', { detail: friendly }).catch((x) => this.log.warn(`Self-healing: could not record the model failure: ${String(x)}`));
          const err = e instanceof Error ? e : new Error(msg);
          (err as Error & { reported?: boolean }).reported = true;
          throw err;
        }
        o.signal.removeEventListener('abort', onAbort);
        if (depth === 0) {
          this.waitExtenders.delete(session.id);
        }
        // A completion with neither text nor a tool call is a server hiccup far more often than an answer.
        const emptyHealer = !text.trim() && !calls.length && !o.signal.aborted ? healModel() : undefined;
        const emptyVerdict = emptyHealer ? await emptyHealer.onModelFailure('empty', new Error('empty completion'), attempt + 1, { streamed: false, modelName: model.name, target: model.id }) : undefined;
        if (emptyVerdict && (emptyVerdict.decision.action === 'retry' || emptyVerdict.decision.action === 'fix') && !o.signal.aborted) {
          // Self-healing: the model_output policy bounds the re-asks; it has no backoff (nothing failed on the server).
          const overthought = !!thinking.trim() && think !== false && think !== undefined;
          if (overthought) {
            think = false;
          }
          modelEvent('retry', overthought ? 'overthought' : 'empty');
          attempt++;
          const max = healMax(emptyVerdict.failure);
          this.log.warn(`${overthought ? 'reasoning-only' : 'empty'} completion from ${model.id}; self-healing retry ${attempt}/${max}${overthought ? ' without thinking' : ''}`);
          status(overthought ? `The model used its whole reply for thinking — asking again without thinking (${attempt}/${max})…` : `The model returned nothing — asking again (${attempt}/${max})…`);
          emit({ sessionId: session.id, type: 'retry', payload: { attempt, max, reason: 'empty', message: 'empty completion' } });
          continue;
        }
        if (!emptyHealer && !text.trim() && !calls.length && attempt < maxModelRetries && !o.signal.aborted) {
          // Only reasoning came back: the model thought until the output limit. The same request would do the same,
          // so ask again without thinking — and keep it off for the rest of this turn.
          const overthought = !!thinking.trim() && think !== false && think !== undefined;
          if (overthought) {
            think = false;
          }
          modelEvent('retry', overthought ? 'overthought' : 'empty');
          attempt++;
          this.log.warn(`${overthought ? 'reasoning-only' : 'empty'} completion from ${model.id}; retry ${attempt}/${maxModelRetries}${overthought ? ' without thinking' : ''}`);
          status(overthought ? `The model used its whole reply for thinking — asking again without thinking (${attempt}/${maxModelRetries})…` : `The model returned nothing — asking again (${attempt}/${maxModelRetries})…`);
          emit({ sessionId: session.id, type: 'retry', payload: { attempt, max: maxModelRetries, reason: 'empty', message: 'empty completion' } });
          await sleep(RETRY_BACKOFF_MS[0], o.signal);
          if (o.signal.aborted) {
            aborted = true;
            break;
          }
          continue;
        }
        modelEvent(o.signal.aborted ? 'aborted' : 'ok');
        // Generation speed for the answer footer: only steps that reported tokens, timed from their first token.
        if (firstAt && usage?.completionTokens) {
          stats.genMs += Date.now() - firstAt;
          stats.genTokens += usage.completionTokens;
        }
        break;
      }
      if (aborted) {
        this.release(model.id, session.id);
        break;
      }

      this.release(model.id, session.id);

      // The reply continues one that stopped at the output limit: keep a single message, without the hidden request.
      // Joined before parsing, so a text-protocol call that spans both halves is still found.
      const joined = !!continuing;
      if (continuing) {
        const { message: before, nudge } = continuing;
        continuing = undefined;
        session.messages = session.messages.filter((m) => m !== before && m !== nudge);
        text = joinContinuation(before.content, text);
        thinking = [before.thinking, thinking].filter(Boolean).join('\n');
        assistant.meta = before.meta ?? assistant.meta;
      }

      // Models without native tool support emit tool calls as text. Small "tool-capable" models also
      // frequently print the call as bare JSON instead of using the tool channel, so fall back to
      // parsing text whenever no native call arrived — restricted to known tool names.
      let malformedCalls: string[] = [];
      if (toolDefs.length && !calls.length) {
        const parsed = extractTextToolCalls(text, new Set(toolDefs.map((t) => t.name)), toolDefs);
        if (parsed.calls.length) {
          calls.push(...parsed.calls);
          text = parsed.remainder;
        } else {
          malformedCalls = parsed.malformed;
        }
      }
      // Self-healing: a call written as broken JSON is repaired deterministically before the model is asked to resend
      // it. Never for a cut-off reply, a truncated mutating call, or arguments missing a required parameter (§5.6).
      if (heal && toolDefs.length && !calls.length && (malformedCalls.length || /\{\s*["'“]?name["'”]?\s*:/.test(text))) {
        const repaired = repairToolCallText(text, {
          knownToolNames: new Set(toolDefs.map((t) => t.name)),
          finish,
          requiredParams: (name) => schemaOf(toolDefs, name).required ?? [],
          paramTypes: (name) => Object.fromEntries(Object.entries(schemaOf(toolDefs, name).properties ?? {}).filter(([, v]) => typeof v?.type === 'string').map(([k, v]) => [k, String(v?.type)])),
          isReadOnly: (name) => {
            const t = this.tools.get(name);
            return !!t && (!!t.readOnly || !t.approvalKind);
          },
        });
        const parsed = repaired ? extractTextToolCalls(repaired.text, new Set(toolDefs.map((t) => t.name)), toolDefs) : undefined;
        if (repaired && parsed?.calls.length) {
          this.log.info(`self-healing: repaired a ${repaired.name} call written as invalid JSON (${repaired.fixes.join(', ') || 'normalised'})`);
          calls.push(...parsed.calls);
          text = parsed.remainder;
          malformedCalls = [];
        }
      }

      assistant.content = text;
      assistant.thinking = thinking || undefined;
      assistant.toolCalls = calls.length ? calls : undefined;
      session.messages.push(assistant);
      finalText = text;

      const truncatedCall = calls.length > 0 || malformedCalls.length > 0 || (finish === 'length' && toolDefs.length > 0 && hasUnterminatedToolCall(text, new Set(toolDefs.map((t) => t.name))));
      const cutOff = lengthAction({ finish, truncatedCall, text, retries: lengthRetries, continuing: joined });
      if (finish !== 'length') {
        lengthRetries = 0;
      }
      if (cutOff === 'retry' || cutOff === 'give_up') {
        // The arguments were cut off mid-call: running them would fail with a misleading error (or write half a file).
        const note = `Your output reached the ${cfg.maxOutputTokens}-token output limit while writing this call, so nothing was executed.`;
        for (const c of calls) {
          session.messages.push({ role: 'tool', content: nativeTools ? note : `<tool_result name="${c.name}">\n${note}\n</tool_result>`, toolCallId: c.id, toolName: c.name, meta: { timestamp: Date.now() } });
        }
        lengthRetries++;
        if (cutOff === 'give_up') {
          const msg = lengthGiveUpMessage(cfg.maxOutputTokens, lengthRetries);
          stopError = { payload: msg, note: msg, reason: 'exhausted' };
          break;
        }
        this.log.warn(`reply cut off at the output limit inside a tool call; asking for a shorter one (${lengthRetries})`);
        status('Output limit reached — asking for a shorter call…');
        emit({ sessionId: session.id, type: 'nudge', payload: { reason: 'length' } });
        session.messages.push({ role: 'user', content: LENGTH_NUDGE, meta: { timestamp: Date.now(), hidden: true, nudge: 'length' } });
        continue;
      }
      if (cutOff === 'continue' && !o.signal.aborted) {
        status('Output limit reached — asking the model to continue…');
        emit({ sessionId: session.id, type: 'nudge', payload: { reason: 'length', continued: true } });
        const nudge: ChatMessage = { role: 'user', content: CONTINUE_NUDGE, meta: { timestamp: Date.now(), hidden: true, nudge: 'length' } };
        session.messages.push(nudge);
        continuing = { message: assistant, nudge };
        continue;
      }
      if (finish === 'length') {
        status('Reply truncated at the output limit');
      }

      if (!calls.length) {
        // The model tried to call a tool but the call did not parse: hand the error back once so it can
        // resend a corrected call instead of the turn ending as if the action had happened.
        // Self-healing: the model_output policy bounds the repair nudges (instead of once per run); exhausted -> escalated.
        let malformedVerdict: ModelFailureResult | undefined;
        if (heal && malformedCalls.length && !o.signal.aborted) {
          malformedVerdict = await heal.onModelFailure('malformed', new Error(malformedCalls[0]), malformedRepairs + 1, { streamed: false, modelName: model.name, target: model.id });
          if (malformedVerdict.decision.action === 'escalate') {
            healStop = await heal.escalate('exhausted', { detail: `the model kept sending tool calls that could not be parsed (${malformedCalls[0].slice(0, 120)})` });
            break;
          }
        }
        if (malformedCalls.length && (malformedVerdict ? malformedVerdict.decision.action === 'fix' || malformedVerdict.decision.action === 'retry' : !malformedNudged) && !o.signal.aborted) {
          malformedNudged = true;
          malformedRepairs++;
          if (mistakes.recordRepair(malformedCalls[0].slice(0, 120))) {
            stopForMistakes();
            break;
          }
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
        const canNudge = isWriteMode(turnMode) && toolDefs.length > 0 && nudges < MAX_NUDGES && depth === 0;
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
        if (this.hooks?.has(stopEvent) && !o.scratch && !o.signal.aborted) {
          status('Running stop hooks…');
          const r = await this.hooks.run(stopEvent, { session_id: session.id, stop_hook_active: stopHookContinues > 0, last_assistant_message: text }, { cwd: hookRoot, signal: o.signal, onRun: hookRow });
          if (r.block && stopHookContinues < MAX_STOP_HOOK_CONTINUES && !r.stop) {
            stopHookContinues++;
            const reason = r.reasons.join('\n') || 'A stop hook asked you to continue.';
            emit({ sessionId: session.id, type: 'nudge', payload: { reason: 'hook' } });
            session.messages.push({ role: 'user', content: `A Stop hook blocked finishing: ${reason}\nAddress this, then report again.`, meta: { timestamp: Date.now(), hidden: true, nudge: 'hook' } });
            status('Continuing (stop hook)…');
            continue;
          }
        }
        // A message typed while the stop hooks ran.
        if (!o.signal.aborted && !control.aborted && injectSteering()) {
          continue;
        }
        // Self-healing completion gate: checks run only when files actually changed; a failure becomes a fix step
        // (the engine injects the prompt and grants recovery steps) or ends the task with its outcome and contract.
        if (heal && !o.signal.aborted && !control.aborted) {
          const gate = await heal.beforeComplete({ todos: session.todos, finalText: text, request: userText(o.userMessage.content) });
          if (gate.action === 'continue') {
            iterLimit = Math.min(iterLimit + gate.grantSteps, maxIter + cfg.healing.extraSteps);
            status('Self-healing: fixing what the checks found…');
            continue;
          }
          outcome = gate.outcome;
          contract = gate.contract;
          if (gate.report) {
            finalText = this.appendReport(session, assistant, gate.report);
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
      // A coordinator that has not delegated yet uses the shell to do the work itself (echo > file); send it to the workers.
      const coordinatorFirst = turnMode === 'multitask' && delegationsExecuted === 0 && !calls.some((c) => DELEGATION_TOOLS.has(c.name));
      // Self-healing: the preexisting-failure baseline runs once, before the first step that changes files or delegates
      // (a shell command that is not read-only may write files too: codegen, `sed -i`, `echo > file`).
      if (heal && calls.some((c) => DELEGATION_TOOLS.has(c.name) || ['write', 'delete'].includes(toolList.find((t) => t.definition.name === c.name)?.approvalKind ?? '') || (c.name === 'run_command' && !isReadOnlyOrSafe(String(parseArgs(c.arguments).command ?? '')).ok))) {
        await heal.ensureBaseline();
      }
      // Files written this step (own edits, and what delegated workers report) for the engine's patch tracking.
      const stepHeal = writeHeal();
      const writes = stepHeal ? new ChildWrites(toolCtx.workspaceRoot) : undefined;
      const healOpts: ExecOptions = heal ? { aroundCommand: () => this.commandSnapshot(heal!) } : {};
      const stepEmit = writes
        ? (e: AgentEvent) => {
            writes.note(e);
            emit(e);
          }
        : emit;
      const step = await this.executeToolCalls(calls, toolList, toolCtx, pool, ctxMgr, stepEmit, session.id, nativeTools, toolCache, model.supportsVision, callCounts, turnMode, policy, coordinatorFirst, healOpts);
      let { messages: results, perCall } = step;
      const { hookStop, failed } = step;
      if (stepHeal && writes?.list().length) {
        await stepHeal.afterWrite(writes.list(), heal ? undefined : session.id).catch((e) => this.log.warn(`Self-healing: could not record written files: ${String(e)}`));
      }
      let observed: ObserveResult = {};
      if (heal) {
        observed = await heal.observe(calls, perCall, failed, step.decisions);
        // MCP calls proven not to have executed (server not connected) run again, through the same approvals.
        if (observed.retryCalls?.length && !o.signal.aborted) {
          const again = await this.executeToolCalls(observed.retryCalls, toolList, toolCtx, pool, ctxMgr, emit, session.id, nativeTools, toolCache, model.supportsVision, new Map(), turnMode, policy, false, { skipMistakes: true });
          const redone = new Map(again.perCall.map((m) => [m.toolCallId, m]));
          for (const c of observed.retryCalls) {
            failed.delete(c.id);
            if (again.failed.has(c.id)) {
              failed.add(c.id);
            }
          }
          perCall = perCall.map((m) => redone.get(m.toolCallId) ?? m);
          results = nativeTools
            ? results.map((m) => (m.role === 'tool' && redone.has(m.toolCallId) ? redone.get(m.toolCallId)! : m))
            : results.map((m, i) => (i === 0 ? { ...m, content: perCall.map((x) => x.content).join('\n\n') } : m));
        }
      }
      toolsExecuted += calls.length;
      // Delegation counts as work done: the workers edited files on the agent's behalf, so a later
      // "created both files" is a report, not a claim.
      mutationsExecuted += calls.filter((c) => {
        if (coordinatorFirst && c.name === 'run_command') {
          return false;
        }
        const kind = toolList.find((t) => t.definition.name === c.name)?.approvalKind;
        return kind === 'write' || kind === 'delete' || kind === 'terminal' || DELEGATION_TOOLS.has(c.name);
      }).length;
      delegationsExecuted += calls.filter((c) => DELEGATION_TOOLS.has(c.name) && !perCall.find((r) => r.toolCallId === c.id)?.content.startsWith('Nothing to run')).length;
      for (const c of calls) {
        if (c.name === 'load_skill') {
          const loadedName = /<skill name="([^"]+)"/.exec(perCall.find((r) => r.toolCallId === c.id)?.content ?? '')?.[1];
          if (loadedName && !activeSkills.has(loadedName)) {
            activeSkills.add(loadedName);
            toolCtx.skills = [...activeSkills];
          }
          // Count what actually loaded (resolved name), not a misspelt, disabled or invented request.
          if (loadedName && depth === 0) {
            void this.learner?.recordSkillUsed(loadedName);
          }
        }
      }
      session.messages.push(...results);
      if (observed.inject) {
        session.messages.push({ role: 'user', content: observed.inject, meta: { timestamp: Date.now(), hidden: true, healing: {} } });
      }
      this.trackWorkingSet(session, calls);
      session.updatedAt = Date.now();
      // A PreToolUse/PostToolUse hook answered `continue: false`: the run ends here.
      if (hookStop) {
        const note = `Stopped by a hook: ${hookStop}`;
        session.messages.push({ role: 'assistant', content: note, meta: { timestamp: Date.now() } });
        emit({ sessionId: session.id, type: 'assistant_delta', payload: note });
        finalText = note;
        completed = true;
        break;
      }
      // Data corruption or a git conflict: the engine escalated; nothing more is written this turn.
      if (observed.stop) {
        healStop = observed.stop.message;
        break;
      }
      if (!o.signal.aborted && !control.aborted && mistakes.recordStep(perCall.map((m) => ({ isError: failed.has(m.toolCallId ?? ''), content: m.content })))) {
        stopForMistakes();
        break;
      }
    }

    /** The engine's report for a run that gave up (mistake limit, step limit, output cut-offs); payload kinds stay as they are. */
    const escalated = async (reason: EscalationReason, detail: string): Promise<string | undefined> => {
      if (!heal) {
        return undefined;
      }
      try {
        return await heal.escalate(reason, { detail });
      } catch (e) {
        this.log.warn(`Self-healing: escalation failed: ${e instanceof Error ? e.message : String(e)}`);
        return undefined;
      }
    };
    if (healStop !== undefined && !o.signal.aborted) {
      // The engine ended the turn (data corruption, git conflict, deadline, exhausted repairs, a resume verdict): its report is the answer.
      session.messages.push({ role: 'assistant', content: healStop, meta: { timestamp: Date.now(), healing: { report: healStop } } });
      emit({ sessionId: session.id, type: 'assistant_delta', payload: healStop });
      finalText = healStop;
    } else if (stopError && !o.signal.aborted) {
      // The run gave up: an error row now, and the reason kept in the transcript (meta.error) for the next turn and replays.
      this.log.warn(`session ${session.id}: ${stopError.note}`);
      const report = stopError.reason ? await escalated(stopError.reason, stopError.note) : undefined;
      emit({ sessionId: session.id, type: 'error', payload: stopError.payload });
      session.messages.push({ role: 'assistant', content: `(error: ${stopError.note})`, meta: { timestamp: Date.now(), error: stopError.note, ...(report ? { healing: { report } } : {}) } });
      finalText = stopError.note;
    } else if (!completed && !o.signal.aborted) {
      // Ran out of steps with tool results pending: say so instead of ending on a dangling tool call.
      const granted = iterLimit - maxIter;
      const note = `Stopped after ${maxIter} model steps${granted > 0 ? ` + ${granted} recovery steps` : ''} in one turn without reaching a final answer. Reply "continue" to carry on from here, or narrow the task.`;
      this.log.warn(`session ${session.id}: ${note}`);
      const report = await escalated('loop', note);
      session.messages.push({ role: 'assistant', content: report ? `${note}\n\n${report}` : note, meta: { timestamp: Date.now(), ...(report ? { healing: { report } } : {}) } });
      emit({ sessionId: session.id, type: 'assistant_delta', payload: note });
      finalText = finalText || note;
    }

    session.updatedAt = Date.now();
    const durationMs = Date.now() - stats.startedAt;
    const last = session.messages[session.messages.length - 1];
    if (last?.role === 'assistant') {
      // Which model answered and how fast, for the footer under the answer (kept with the transcript, never sent).
      last.meta = { ...last.meta, durationMs, model: stats.model || undefined, outputTokens: stats.genTokens || undefined, genMs: stats.genMs || undefined };
    }
    // A turn the user stopped is marked on its last assistant message (the transcript may end on a tool result), so the
    // chat redraws it as "Stopped by you" with Continue / Discard changes rather than as finished work.
    if (depth === 0 && (o.signal.aborted || control.aborted)) {
      const at = session.messages.map((m) => m.role).lastIndexOf('assistant');
      if (at >= 0) {
        const m = session.messages[at];
        m.meta = { ...m.meta, stopped: true, durationMs: m.meta?.durationMs ?? durationMs };
      }
    }
    // Self-healing: the turn's outcome (completed, completed_unverified, incomplete, blocked, cancelled), its contract and recovery summary.
    let healed: Record<string, unknown> | undefined;
    if (heal) {
      const settled = heal.result();
      outcome = outcome ?? settled?.outcome ?? (o.signal.aborted || control.aborted ? 'cancelled' : completed ? 'completed' : 'incomplete');
      contract = contract ?? settled?.contract;
      stats.outcome = outcome;
      const recovery = heal.summary();
      if (recovery) {
        session.recovery = recovery;
      }
      healed = { outcome, ...(contract ? { contract } : {}), ...(recovery ? { recovery } : {}) };
    }
    emit({ sessionId: session.id, type: 'turn_end', payload: { text: finalText, completed, contextTokens: session.contextTokens, durationMs, steps: stats.steps, toolCalls: stats.toolCalls, model: stats.model, promptTokens: stats.promptTokens, completionTokens: stats.completionTokens, ...healed } });
    if (lastRequest) {
      recordContext('turn', lastRequest.messages, session.contextTokens || lastRequest.tokens);
    }
    // Keep what a substantial run taught about the project, after the answer is out (never delays the reply).
    const turnStart = session.messages.indexOf(turnMessage);
    const turnMsgs = turnStart >= 0 ? session.messages.slice(turnStart) : session.messages.slice(-30);
    const savedByModel = turnMsgs.some((m) => m.toolCalls?.some((c) => c.name === 'memory_save'));
    const turnCompaction = depth === 0 ? this.turnCompactions.get(session.id) : undefined;
    if (depth === 0) {
      this.turnCompactions.delete(session.id);
    }
    let autoSave: Promise<unknown> = Promise.resolve();
    // Not for scratch runs: benchmark tasks run in throwaway folders whose facts do not belong to this project.
    if (this.memory && cfg.memoryEnabled && cfg.memoryAutoSave && depth === 0 && !o.scratch && !o.signal.aborted && stats.toolCalls >= 3 && finalText && !savedByModel && ['agent', 'debug', 'multitask'].includes(turnMode)) {
      // At most 90 s, and cancelled by the next run: on a one-slot server it must never hold the model the user is waiting for.
      const memoryAbort = new AbortController();
      this.backgroundAborts.add(memoryAbort);
      autoSave = saveRunMemories(this.memory, { provider, model: model.modelId, contextWindow: model.contextWindow, keepAlive: cfg.keepAlive || undefined, signal: AbortSignal.any([memoryAbort.signal, AbortSignal.timeout(90_000)]) }, runDigest(userText(o.userMessage.content), turnMsgs, finalText))
        .finally(() => this.backgroundAborts.delete(memoryAbort))
        .then((saved) => {
          if (saved.length) {
            this.log.info(`memory: saved ${saved.join(', ')} from the run`);
            emit({ sessionId: session.id, type: 'memory', payload: { saved } });
          }
        })
        .catch((e) => this.log.debug(`memory: automatic save skipped: ${e instanceof Error ? e.message : String(e)}`));
      this.track(autoSave);
    }
    // 1.7 conversation memory: the chat's summary after a compaction (free) or every 20 messages (one request to the
    // same model), after the automatic save so a one-slot server is asked one thing at a time; never delays the answer.
    const afterTurn = this.memoryHooks?.afterTurn;
    if (afterTurn && cfg.memoryEnabled && depth === 0 && !o.scratch && !o.signal.aborted && finalText) {
      const summaryAbort = new AbortController();
      this.backgroundAborts.add(summaryAbort);
      this.track(
        autoSave
          .catch(() => undefined)
          .then(() => afterTurn({ session, provider, model: model.modelId, contextWindow: model.contextWindow, keepAlive: cfg.keepAlive || undefined, signal: AbortSignal.any([summaryAbort.signal, AbortSignal.timeout(90_000)]), compaction: turnCompaction }))
          .finally(() => this.backgroundAborts.delete(summaryAbort))
          .catch((e) => this.log.debug(`memory: conversation summary skipped: ${e instanceof Error ? e.message : String(e)}`))
      );
    }
    return finalText;
  }

  /** Chats this runner has run a top-level turn of; a chat with history not in here is being resumed. */
  private readonly startedSessions = new Set<string>();

  /** Tools offered so far per chat (see the tool gating in run): the list only grows, so the prompt prefix stays cacheable. */
  private readonly offeredTools = new Map<string, Set<string>>();

  /** Cancels background model requests (memory saves) when a new run needs the model. */
  private readonly backgroundAborts = new Set<AbortController>();

  /** Work that outlives a run (the automatic memory save); a process about to exit waits for it with `idle()`. */
  private readonly background = new Set<Promise<unknown>>();
  private track(p: Promise<unknown>): void {
    this.background.add(p);
    void p.finally(() => this.background.delete(p));
  }
  /** Resolves when background work has finished, or after `timeoutMs`; true when something was still running. */
  async idle(timeoutMs = 60_000): Promise<boolean> {
    if (!this.background.size) {
      return false;
    }
    await Promise.race([Promise.allSettled([...this.background]), new Promise((r) => setTimeout(r, timeoutMs))]);
    return true;
  }
  /** Aborts background work (the memory save), e.g. when the user presses Ctrl+C while the CLI waits on it. */
  cancelBackground(): void {
    this.backgroundAborts.forEach((a) => a.abort());
  }

  /** Adds the self-healing footer to the turn's answer (`meta.healing.report`); a message of its own when the engine wrote after it. */
  private appendReport(session: Session, answer: ChatMessage, report: string): string {
    const withReport = answer.content.trim() ? `${answer.content.trimEnd()}\n\n${report}` : report;
    if (session.messages[session.messages.length - 1] === answer) {
      answer.content = withReport;
      answer.meta = { ...answer.meta, healing: { ...answer.meta?.healing, report } };
    } else {
      session.messages.push({ role: 'assistant', content: report, meta: { timestamp: Date.now(), healing: { report } } });
    }
    return withReport;
  }

  /** Tree snapshot around a model-originated run_command: what it changed (sed -i, codegen, lockfiles) counts as changed files (§2.4). */
  private async commandSnapshot(heal: HealingEngine): Promise<() => Promise<void>> {
    const before = await treeSnapshot(heal.root);
    return async () => {
      try {
        const files = treeDiff(before, await treeSnapshot(heal.root));
        if (files.length) {
          await heal.noteCommandChanges(files);
        }
      } catch (e) {
        this.log.warn(`Self-healing: could not record the command's changes: ${e instanceof Error ? e.message : String(e)}`);
      }
    };
  }

  /**
   * A smaller model to reroute an overloaded run to: the same tool protocol (the turn's tool definitions are fixed),
   * vision when the turn has images, and the same locality (local never becomes cloud unless the route already allowed it).
   */
  private async rerouteTarget(current: ModelInfo, need: RerouteRequirement, cloudAllowed: boolean): Promise<Awaited<ReturnType<ProviderRegistry['resolve']>> | undefined> {
    const models = await this.providers.listModels().catch(() => [] as ModelInfo[]);
    const size = (m: ModelInfo) => m.sizeBytes ?? Number.POSITIVE_INFINITY;
    const fits = models
      .filter((m) => m.id !== current.id && !m.disabled && m.supportsTools === (need.protocol === 'native') && (!need.vision || m.supportsVision))
      .filter((m) => (need.locality === 'remote' ? !!m.remote : !m.remote || cloudAllowed))
      .filter((m) => current.sizeBytes === undefined || size(m) < current.sizeBytes)
      .sort((a, b) => (current.sizeBytes === undefined ? size(a) - size(b) : size(b) - size(a)));
    for (const m of fits) {
      try {
        return await this.providers.resolve(m.id);
      } catch {
        // gone since the listing: try the next one
      }
    }
    return undefined;
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

  /** Forget the serial-server mark for `modelIds` (all models when omitted), e.g. after the server was restarted with parallel slots. */
  clearServedSerially(modelIds?: Iterable<string>): void {
    if (!modelIds) {
      this.serialWarned.clear();
      return;
    }
    for (const id of modelIds) {
      this.serialWarned.delete(id);
    }
  }

  /** Model ids currently known to serve one request at a time. */
  get serialModels(): ReadonlySet<string> {
    return this.serialWarned;
  }

  /** "Keep waiting" on the chat's wait row: the request in flight gets another full first-token limit. False when nothing is waiting. */
  keepWaiting(sessionId: string): boolean {
    const extend = this.waitExtenders.get(sessionId);
    extend?.();
    return !!extend;
  }

  /** A routed model stalled on a subagent: keep automatic picks away from it for a while. */
  markModelUnresponsive(modelId: string): void {
    this.providers.markUnresponsive(modelId);
  }

  /** Model ids with a request in flight and the sessions using them (for the Agents view / tab tooltips). */
  get activeModelRequests(): { model: string; sessions: string[] }[] {
    return [...this.inflight].map(([model, set]) => ({ model, sessions: [...set] }));
  }

  private selectTools(mode: Session['mode'], filter?: string[], omit?: Set<string>): Tool[] {
    let list = this.tools.list();
    if (omit?.size) {
      list = list.filter((t) => !omit.has(t.definition.name));
    }
    if (filter) {
      const allowed = new Set(filter);
      list = list.filter((t) => toolInFilter(t.definition.name, allowed));
    }
    // Organisation policy: web access and other tool families it switched off are not offered at all.
    const managed = getManagedPolicy(this.log);
    list = list.filter((t) => toolAllowed(managed, t.definition.name));
    // The user's own switch for the same family (localpilot.webSearch.enabled).
    if (!getConfig().webEnabled) {
      list = list.filter((t) => !WEB_TOOLS.test(t.definition.name));
    }
    // Tools the user switched off (localpilot.disabledTools) are never sent to the model.
    const disabled = getConfig().disabledTools;
    if (disabled.length) {
      list = list.filter((t) => !toolDisabled(t.definition.name, disabled));
    }
    // Memory off: no notes are loaded into the prompt, so none should be written or looked up either.
    if (!getConfig().memoryEnabled) {
      list = list.filter((t) => !t.definition.name.startsWith('memory_'));
    }
    if (!isWriteMode(mode)) {
      // Read-only modes: strip mutating tools. run_command stays; its guard refuses commands that could write.
      list = list.filter((t) => t.definition.name === 'run_command' || ((!t.approvalKind || t.approvalKind === 'network' || t.approvalKind === 'mcp') && (!t.definition.name.startsWith('mcp_') || t.readOnly)));
    } else if (mode === 'multitask') {
      // The coordinator reads, plans, delegates and verifies; only its workers edit files.
      list = list.filter((t) => t.approvalKind !== 'write' && t.approvalKind !== 'delete' && (!t.definition.name.startsWith('mcp_') || t.readOnly));
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
    cache: Map<string, Promise<{ msg: ChatMessage; isError: boolean }>>,
    vision = false,
    callCounts?: Map<string, number>,
    mode = 'agent',
    policy?: ToolPolicy,
    coordinatorFirst = false,
    opts: ExecOptions = {}
  ): Promise<{ messages: ChatMessage[]; perCall: ChatMessage[]; hookStop?: string; failed: Set<string>; decisions: Map<string, ToolCallDecision> }> {
    let hookStop: string | undefined;
    /** Ids of the calls whose result is an error (for the consecutive-mistake limit). */
    const failed = new Set<string>();
    /** Why a call did not run (denied, blocked by policy / a rule / a hook / a setting, unattended, stopped); the text stays as it was. */
    const decisions = new Map<string, ToolCallDecision>();
    const origin = opts.origin;
    if (origin) {
      // Synthetic self-healing calls: tool rows carry their origin so the chat groups them under the recovery card.
      const base = emit;
      emit = (e) => base(e.type === 'tool_start' || e.type === 'tool_end' ? { ...e, payload: { ...(e.payload as object), origin } } : e);
    }
    callCounts = opts.callCounts ?? callCounts;
    const byName = new Map((opts.tools ?? available).map((t) => [t.definition.name, t]));
    // Images produced by tools (browser_screenshot) ride along in a user message, which every provider accepts.
    const captured: { callId: string; caption: string; data: string }[] = [];
    const toolMsg = (call: ToolCall, content: string, isError = false): ChatMessage => ({ role: 'tool', content: nativeTools ? content : `<tool_result name="${call.name}">\n${content}\n</tool_result>`, toolCallId: call.id, toolName: call.name, meta: { timestamp: Date.now(), ...(isError ? { failed: true } : {}) } });
    const notRun = 'Not run: the user stopped the run. Nothing was done.';
    const hookRow = (h: HookRunInfo) => emit({ sessionId, type: 'hook', payload: h });
    const execute = async (call: ToolCall, tool: Tool | undefined, args: Record<string, unknown>): Promise<{ msg: ChatMessage; isError: boolean }> => {
      if (ctx.signal.aborted) {
        emit({ sessionId, type: 'tool_end', payload: { id: call.id, name: call.name, isError: true, durationMs: 0, content: notRun } });
        failed.add(call.id);
        decisions.set(call.id, { blockedBy: 'stopped' });
        return { msg: toolMsg(call, notRun, true), isError: true };
      }
      const started = Date.now();
      let result: ToolResult | undefined;
      let callCtx: ToolContext = { ...ctx, callId: call.id, output: (chunk) => emit({ sessionId, type: 'tool_progress', payload: { id: call.id, chunk } }) };
      /** Set when the user denied an approval of this call: the reason they gave, or '' for none. */
      let denial: string | undefined;
      /** The command line the user edited in this call's approval prompt before allowing it. */
      let edited: string | undefined;
      if (coordinatorFirst && call.name === 'run_command') {
        result = { content: 'Nothing was run. In Multitask mode you coordinate and workers do the work: call run_todos_parallel now with each piece in "tasks" (title, agent, complete prompt). Use run_command only to verify after the workers report.', isError: true };
      }
      const managed = getManagedPolicy(this.log);
      const org = tool && !result ? policyVerdict(managed, call.name, args, policy?.root ?? ctx.workspaceRoot) : { decision: 'none' as const };
      if (org.decision === 'deny') {
        result = { content: `Blocked by ${org.reason}. Nothing was done; do not retry this action — choose another approach or tell the user it is not permitted here.`, isError: true };
        decisions.set(call.id, { blockedBy: 'policy' });
      }
      if (tool && policy && !result) {
        // Organisation policy first (it cannot be overridden), then settings.json: deny → ask → allow, then the default mode.
        const proj = evaluatePermission(policy.settings.permissions, call.name, args, { root: policy.root }, policy.extraAllow);
        const verdict = proj.decision === 'deny' ? proj : org.decision === 'ask' ? { decision: 'ask' as const, rule: undefined } : proj;
        let decision: 'allow' | 'deny' | 'ask' | 'none' = verdict.decision;
        let reason = verdict !== proj ? org.reason! : verdict.rule ? `permission rule \`${verdict.rule}\`` : '';
        if (decision === 'deny') {
          result = { content: `Blocked by ${reason} in settings.json. Do not retry this exact action; choose another approach or ask the user to change the rule.`, isError: true };
          decisions.set(call.id, { blockedBy: 'rule' });
        } else if (policy.hooks?.has('PreToolUse')) {
          const r = await policy.hooks.run('PreToolUse', { session_id: policy.sessionId, tool_name: canonicalToolName(call.name), tool_input: claudeToolInput(call.name, args), localpilot_tool_name: call.name }, { cwd: policy.root, matchKeys: toolNames(call.name), signal: policy.signal, onRun: hookRow });
          if (r.block || r.permission === 'deny') {
            result = { content: `Blocked by a PreToolUse hook: ${r.reasons.join('\n') || 'no reason given'}. Nothing was done.`, isError: true };
            decisions.set(call.id, { blockedBy: 'hook' });
          } else {
            if (r.updatedInput) {
              args = fromClaudeToolInput(call.name, r.updatedInput, args);
            }
            // A hook may tighten a policy prompt to a block, never loosen it to an allow.
            if (r.permission && !(org.decision === 'ask' && r.permission === 'allow')) {
              decision = r.permission;
              reason = 'a PreToolUse hook';
            }
            if (r.stop) {
              result = { content: `Stopped by a hook: ${r.stop}`, isError: true };
              hookStop = r.stop;
              decisions.set(call.id, { blockedBy: 'hook' });
            }
          }
        }
        if (!result) {
          const defaultMode = policy.settings.permissions.defaultMode;
          if (decision === 'none' && !(managed.disableBypassPermissions && (defaultMode === 'bypassPermissions' || defaultMode === 'acceptEdits'))) {
            const configured = tool.approvalKind ? getConfig().approvals[tool.approvalKind] : undefined;
            // `safe` runs a read-only or routine test/build command as if it were `always`.
            const level = configured === 'safe' ? (call.name === 'run_command' && isReadOnlyOrSafe(String(args.command ?? '')).ok && args.requires_approval !== true ? 'always' : 'ask') : configured;
            const effective = tool.approvalKind && level ? flooredApproval(managed, tool.approvalKind, level) : undefined;
            decision = defaultModeDecision(defaultMode, call.name, tool.approvalKind, effective);
            reason = decision === 'none' ? '' : `permissions.defaultMode = ${defaultMode}`;
          } else if (decision === 'ask' && defaultMode === 'dontAsk') {
            // dontAsk never prompts: an ask rule or hook ask becomes a refusal.
            decision = 'deny';
            reason = 'permissions.defaultMode = dontAsk';
          }
          if (decision === 'deny') {
            result = { content: `Blocked by ${reason}. Nothing was done.`, isError: true };
            decisions.set(call.id, { blockedBy: 'setting' });
          } else if (decision === 'allow' && !(tool.approvalKind && managed.approvals[tool.approvalKind])) {
            // A project allow skips the prompt, unless the organisation set an approval floor for this kind of action.
            callCtx = { ...callCtx, requestApproval: async () => !ctx.signal.aborted, approve: async () => ({ ok: !ctx.signal.aborted }) };
          } else if (decision === 'ask') {
            // An organization `ask` must reach the user every time.
            const ask = org.decision === 'ask' ? policy.askMandatory : policy.ask;
            callCtx = { ...callCtx, requestApproval: async (t, d, k, opts) => (await ask(t, d, k, opts)).ok, approve: ask };
            // Tools that never ask for approval themselves (reads, searches) would run straight through an `ask`
            // rule (`Read(.env)`): prompt here, before the call.
            if (!tool.approvalKind) {
              const target = Object.values(args).find((v) => typeof v === 'string') as string | undefined;
              const d = await ask(`${call.name}${target ? ` ${target.slice(0, 80)}` : ''}`, `Requires approval: ${reason}`, 'write');
              if (!d.ok && d.byUser) {
                denial = d.feedback ?? '';
                result = { content: `The user declined ${call.name} (${reason}). Nothing was done.`, isError: true };
              } else if (!d.ok) {
                result = { content: `${call.name} was not approved (${reason}). Nothing was done.`, isError: true };
              }
              if (!d.ok) {
                decisions.set(call.id, ctx.signal.aborted ? { blockedBy: 'stopped' } : refusalOf(d));
              }
            }
          }
        }
        if (result?.isError) {
          this.log.info(`tool ${call.name} blocked: ${result.content.split('\n')[0]}`);
        }
      }
      /** The tool's own approval was refused (the call did not run). */
      let refused: ToolCallDecision | undefined;
      if (!result) {
        const approve = callCtx.approve;
        if (approve && tool) {
          // Tools see a yes/no answer; a denial's reason goes to the model in place of the tool's fixed refusal text.
          callCtx = {
            ...callCtx,
            approvalEdit: () => edited,
            requestApproval: async (t, d, k, o) => {
              const v = await approve(t, d, k, o);
              if (!v.ok && v.byUser) {
                denial = v.feedback ?? denial ?? '';
              }
              if (v.ok && v.edited && call.name === 'run_command') {
                edited = v.edited;
              }
              if (!v.ok) {
                refused = ctx.signal.aborted ? { blockedBy: 'stopped' } : refusalOf(v);
              }
              return v.ok;
            },
          };
        }
        // A model-originated command is bracketed by tree snapshots (self-healing), so its file changes are known.
        const settle = tool && opts.aroundCommand && !origin && call.name === 'run_command' ? await opts.aroundCommand().catch(() => undefined) : undefined;
        const run = async (): Promise<ToolResult> =>
          tool ? this.tools.execute(call.name, args, callCtx) : { content: `Tool "${call.name}" is not available in this mode. Available: ${[...byName.keys()].join(', ')}`, isError: true };
        if (settle) {
          try {
            result = await run();
          } finally {
            await settle();
          }
        } else {
          result = await run();
        }
      }
      if (refused && result.isError) {
        decisions.set(call.id, refused);
      }
      if (denial !== undefined && result.isError) {
        result = { ...result, content: deniedResultText(result.content, denial) };
      }
      if (ctx.signal.aborted && !result.isError) {
        // The step really ran; keep its result so the model knows what changed.
        result = { ...result, content: `${result.content ?? ''} (The user pressed Stop after this step finished.)` };
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
      if (result.images?.length && !result.isError) {
        if (vision) {
          captured.push(...result.images.map((im) => ({ callId: call.id, caption: `Image ${im.name} from ${call.name}`, data: im.data })));
        } else {
          // Without vision an image read is an error, unless the same call also returned text (other files of a batch).
          const onlyImages = !text.replace(/^\[image [^\n]*$/gm, '').trim();
          text += `\n\nError: ${result.images.map((im) => im.name).join(', ')} ${result.images.length > 1 ? 'are images' : 'is an image'} and the current model cannot see images. Switch to a vision model (gemma4, qwen2.5vl) to inspect ${result.images.length > 1 ? 'them' : 'it'}.`;
          result = { ...result, isError: result.isError || onlyImages };
        }
      }
      let content = ctxMgr.clampToolOutput(text);
      if (tool && policy?.hooks?.has('PostToolUse') && !ctx.signal.aborted) {
        const r = await policy.hooks.run(
          'PostToolUse',
          { session_id: policy.sessionId, tool_name: canonicalToolName(call.name), tool_input: claudeToolInput(call.name, args), tool_response: { content, is_error: !!result.isError }, localpilot_tool_name: call.name },
          { cwd: policy.root, matchKeys: toolNames(call.name), signal: policy.signal, onRun: hookRow }
        );
        if (r.stop) {
          hookStop = r.stop;
        }
        const extra = [...(r.block ? r.reasons.map((x) => `[hook] ${x}`) : []), ...r.context];
        if (extra.length) {
          content = `${content}\n\n${extra.join('\n')}`;
        }
      }
      this.telemetry?.record({ type: 'tool', sid: sessionId, name: call.name, mode, durationMs: Date.now() - started, error: !!result.isError });
      audit(managed, { event: 'tool', session: sessionId, tool: call.name, args: JSON.stringify(args).slice(0, 2000), outcome: result.isError ? 'error' : 'ok', blocked: /^Blocked by /.test(result.content ?? '') || undefined, durationMs: Date.now() - started }, policy?.root ?? ctx.workspaceRoot, this.log);
      emit({ sessionId, type: 'tool_end', payload: { id: call.id, name: call.name, isError: result.isError, durationMs: Date.now() - started, content, data: result.data, denied: (denial !== undefined && result.isError) || undefined } });
      // A user's denial is guidance, not a mistake of the model.
      if (result.isError && denial === undefined) {
        failed.add(call.id);
      }
      const msg = toolMsg(call, content, !!result.isError);
      const tests = call.name === 'run_command' ? (result.data as { tests?: TestSummary } | undefined)?.tests : undefined;
      if (tests) {
        msg.meta = { ...msg.meta, tests };
      }
      return { msg, isError: !!result.isError };
    };
    const runOne = async (call: ToolCall): Promise<ChatMessage> => {
      const args = parseArgs(call.arguments);
      const tool = byName.get(call.name);
      // The checklist item in progress when the call starts: the chat links the row to that task (and back).
      const todoId = call.name === 'manage_todos' ? undefined : ctx.todos?.get().find((t) => t.status === 'in_progress')?.id;
      emit({ sessionId, type: 'tool_start', payload: { id: call.id, name: call.name, args, ...(todoId ? { todoId } : {}) } });
      const key = callKey(call.name, args);
      if (callCounts) {
        const n = (callCounts.get(key) ?? 0) + 1;
        callCounts.set(key, n);
        if (n > MAX_IDENTICAL_CALLS) {
          const content = `Refused: this exact call (${call.name} with the same arguments) has already been made ${n - 1} times since the last change and would return the same result. Use the earlier result, change the arguments, or take a different approach — if you are finished, answer the user.`;
          emit({ sessionId, type: 'tool_end', payload: { id: call.id, name: call.name, isError: true, durationMs: 0, content } });
          failed.add(call.id);
          return { role: 'tool', content: nativeTools ? content : `<tool_result name="${call.name}">\n${content}\n</tool_result>`, toolCallId: call.id, toolName: call.name, meta: { timestamp: Date.now() } };
        }
      }
      // An edit can change what reads, tests and diagnostics return, so earlier identical calls no longer count.
      const afterEdit = (r: { msg: ChatMessage; isError: boolean }) => {
        if (callCounts && !r.isError && (tool?.approvalKind === 'write' || tool?.approvalKind === 'delete' || DELEGATION_TOOLS.has(call.name))) {
          for (const k of [...callCounts.keys()]) {
            if (k !== key) {
              callCounts.delete(k);
            }
          }
        }
        return r;
      };
      const cacheKey = tool?.parallelSafe ? `${call.name}:${JSON.stringify(args)}` : undefined;
      if (cacheKey) {
        const inflight = cache.get(cacheKey);
        if (inflight) {
          const hit = await inflight;
          if (hit.isError) {
            failed.add(call.id);
          }
          this.telemetry?.record({ type: 'tool', sid: sessionId, name: call.name, mode, durationMs: 0, error: hit.isError, cached: true });
          emit({ sessionId, type: 'tool_end', payload: { id: call.id, name: call.name, isError: hit.isError, durationMs: 0, content: hit.msg.content, cached: true } });
          return { ...hit.msg, toolCallId: call.id, meta: { timestamp: Date.now() } };
        }
        const p = traceTool(this.telemetry?.tracing, call, args, () => execute(call, tool, args)).then(afterEdit).then((r) => {
          if (r.isError) {
            cache.delete(cacheKey);
          }
          return r;
        });
        cache.set(cacheKey, p);
        return (await p).msg;
      }
      cache.clear();
      try {
        return (await traceTool(this.telemetry?.tracing, call, args, () => execute(call, tool, args)).then(afterEdit)).msg;
      } finally {
        markRepoGraphStale(ctx.workspaceRoot);
      }
    };

    // Consecutive parallel-safe tools run concurrently; a mutating tool runs alone, in the model's order.
    const results = new Map<string, ChatMessage>();
    let group: ToolCall[] = [];
    const flush = async () => {
      if (!group.length) {return;}
      const batch = group;
      group = [];
      const settled = await pool.map(batch, runOne);
      settled.forEach((r, i) => {
        const call = batch[i];
        if (r.status !== 'fulfilled') {
          failed.add(call.id);
        }
        results.set(call.id, r.status === 'fulfilled' ? r.value : { role: 'tool', content: `Tool failed: ${String(r.reason)}`, toolCallId: call.id, toolName: call.name });
      });
    };
    for (const call of calls) {
      if (byName.get(call.name)?.parallelSafe) {
        group.push(call);
        continue;
      }
      await flush();
      if (ctx.signal.aborted) {
        emit({ sessionId, type: 'tool_start', payload: { id: call.id, name: call.name, args: parseArgs(call.arguments) } });
        emit({ sessionId, type: 'tool_end', payload: { id: call.id, name: call.name, isError: true, durationMs: 0, content: notRun } });
        results.set(call.id, toolMsg(call, notRun, true));
        decisions.set(call.id, { blockedBy: 'stopped' });
        continue;
      }
      results.set(call.id, await runOne(call));
    }
    await flush();
    // Preserve the model's original call order in the transcript.
    const ordered = calls.map((c) => results.get(c.id)!);
    const imageMsg: ChatMessage | undefined = captured.length
      ? { role: 'user', content: captured.map((c) => `[${c.caption}]`).join('\n'), images: captured.map((c) => c.data), meta: { timestamp: Date.now(), toolImages: captured.map((c) => c.callId) } }
      : undefined;
    if (!nativeTools) {
      // Text protocol: tool results go back as a single user message (with any captured images attached to it).
      const carrier: ChatMessage = { role: 'user', content: ordered.map((m) => m.content).join('\n\n'), images: imageMsg?.images, meta: { timestamp: Date.now(), toolImages: imageMsg?.meta?.toolImages, toolResults: calls.map((c) => c.id) } };
      return { messages: [carrier], perCall: ordered, hookStop, failed, decisions };
    }
    return { messages: imageMsg ? [...ordered, imageMsg] : ordered, perCall: ordered, hookStop, failed, decisions };
  }

  private async gateApproval(
    kind: NonNullable<Tool['approvalKind']>,
    mode: TerminalApprovalMode,
    ask: (mandatory: boolean) => Promise<boolean | ApprovalDecision>,
    emit: (e: AgentEvent) => void,
    sessionId: string,
    info?: ApprovalOptions & { title: string; detail: string; root?: string; request?: string; signal?: AbortSignal; heal?: ApprovalRecorder; origin?: 'healing'; unattended?: boolean }
  ): Promise<ApprovalDecision> {
    const managed = getManagedPolicy(this.log);
    const heal = info?.heal;
    // `safe` resolves per command; a destructive command or the model's requires_approval makes this one prompt mandatory.
    // While a self-healing recovery is active a destructive command always asks, whatever dangerousAlwaysAsk says.
    // Settings → MCP servers: a per-tool Allow / Ask / Block replaces the MCP category for that tool (floors still apply below).
    const chosen = approvalModeFor(kind, mode, info);
    const level = effectiveApproval(chosen, info, getConfig().dangerousAlwaysAsk || (!!info?.dangerous && !!heal?.inRecovery()));
    const strict = !!info?.mandatory || level.mustAsk;
    const base = flooredApproval(managed, kind, level.mode);
    const floored = autoApprovedMode(managed, kind, strict && base === 'always' ? 'ask' : base, { autoApprove: info?.autoApprove, mandatory: strict });
    const mandatory = strict || managed.approvals[kind] === 'ask';
    const decided = (ok: boolean | ApprovalDecision, by: string): ApprovalDecision => {
      const d = toDecision(ok);
      const byUser = by === 'user' && ok !== false;
      const who = by === 'user' && !byUser ? 'non-interactive' : by;
      audit(managed, { event: 'approval', session: sessionId, kind, title: info?.title, approved: d.ok, by: who }, info?.root, this.log);
      const out = byUser ? { ...d, byUser } : d;
      DECIDED_BY.set(out, who);
      // Every decision of the turn goes into the recovery state (audit() is a no-op without an org audit log).
      if (heal) {
        const record: ApprovalRecord = {
          at: Date.now(), kind, command: /^\$ (.+)$/m.exec(info?.detail ?? '')?.[1] ?? info?.title, decision: !d.ok ? 'denied' : byUser ? 'approved' : 'auto', mandatory,
          ...(d.ok ? {} : { blockedBy: byUser ? 'user' : who }), ...(info?.origin ? { origin: info.origin } : {}),
        };
        heal.recordApproval(record);
      }
      return out;
    };
    // A stopped run (or a single stopped subagent lane) must not approve anything or hang on a prompt nobody will answer now.
    const sig = info?.signal;
    if (sig?.aborted) {
      return decided(false, 'stopped');
    }
    if (floored === 'always') {
      return decided(true, 'setting');
    }
    if (floored === 'never') {
      if (managed.approvals[kind] === 'never') {
        emit({ sessionId, type: 'status', payload: `${info?.title ?? kind} is not permitted by your organization's policy` });
      }
      return decided(false, managed.approvals[kind] === 'never' ? 'policy' : 'setting');
    }
    // Self-healing checks: one "yes" covers this turn's check commands while their definitions are unchanged. Never
    // for a mandatory, destructive or confirm-required prompt, nor when the organization set the terminal approval.
    const allowance = kind === 'terminal' && !mandatory && !strict && !info?.dangerous && !info?.confirm && !managed.approvals.terminal ? info?.healingAllowance : undefined;
    if (allowance?.granted) {
      return decided(true, 'allowance');
    }
    const auto = getConfig().autoMode;
    if (auto.enabled && info && this.autoReviewer && !managed.disableBypassPermissions && !mandatory) {
      emit({ sessionId, type: 'status', payload: `Auto mode: reviewing "${info.title.slice(0, 60)}"…` });
      const v = await this.autoReviewer.review({ kind, title: info.title, detail: info.detail, request: info.request ?? '', signal: info.signal }, auto.model);
      if (sig?.aborted) {
        return decided(false, 'stopped');
      }
      if (v.decision === 'allow') {
        emit({ sessionId, type: 'status', payload: `Auto mode approved: ${info.title.slice(0, 60)}${v.reason ? ` (${v.reason})` : ''}` });
        return decided(true, 'auto-mode');
      }
      emit({ sessionId, type: 'status', payload: `Auto mode needs you: ${v.reason || info.title.slice(0, 60)}` });
    }
    // Nobody is watching a queued run: an engine command that needs a prompt is skipped, not left waiting.
    if (info?.origin === 'healing' && info.unattended) {
      return decided(false, 'unattended');
    }
    emit({ sessionId, type: 'approval_request', payload: { kind } });
    if (info && this.hooks?.has('Notification')) {
      // Fire-and-forget: a Notification hook may ping the user (desktop notification, sound) while the prompt waits.
      void this.hooks.run('Notification', { session_id: sessionId, message: `${info.title}\n${info.detail}`.trim(), notification_type: 'permission_prompt' }, { cwd: info.root, matchKey: 'permission_prompt', onRun: (h) => emit({ sessionId, type: 'hook', payload: h }) });
    }
    if (sig?.aborted) {
      return decided(false, 'stopped');
    }
    const asked = ask(mandatory);
    const stopped = new Promise<boolean | ApprovalDecision>((r) => {
      const off = onAbort(sig, () => r(false));
      void asked.finally(off).catch(() => undefined);
    });
    const answer = decided(await Promise.race([asked, stopped]), sig?.aborted ? 'stopped' : 'user');
    if (allowance && answer.ok && answer.byUser) {
      allowance.grant();
    }
    return answer;
  }
}

/** The JSON-schema `properties` / `required` of a tool definition (empty when it has none). */
function schemaOf(defs: readonly ToolDefinition[], name: string): { properties?: Record<string, { type?: unknown } | undefined>; required?: string[] } {
  const params = defs.find((d) => d.name === name)?.parameters as { properties?: Record<string, { type?: unknown } | undefined>; required?: unknown } | undefined;
  return { properties: params?.properties, required: Array.isArray(params?.required) ? params.required.filter((r): r is string => typeof r === 'string') : undefined };
}

/** True when the user is asking to execute the plan/checklist that is already in the session. */
export function isImplementPlanRequest(text: string): boolean {
  return IMPLEMENT_PLAN.test(text.trim());
}

/**
 * The request's messages: the stable system prompt, then the history with this turn's context in front of the turn's
 * user message. Earlier turns go out exactly as they did before, so the server reuses its KV cache for all of them.
 * When compaction has folded the turn's message into a summary, the context rides on the system prompt instead.
 */
export function withTurnContext(system: string, history: ChatMessage[], turnMessage: ChatMessage, turnContext: string, dropImages = false): ChatMessage[] {
  const at = turnContext ? history.indexOf(turnMessage) : -1;
  const head: ChatMessage = { role: 'system', content: turnContext && at < 0 ? `${system}\n\n${turnContext}` : system };
  const out = (m: ChatMessage) => (dropImages ? withoutImages(stripMeta(m)) : stripMeta(m));
  return [head, ...history.map((m, i) => (i === at ? { ...out(m), content: `${turnContext}\n\n${out(m).content}` } : out(m)))];
}

/** For a model that cannot see: the images leave the request (the transcript keeps them) and a note says so. */
function withoutImages(m: ChatMessage): ChatMessage {
  if (!m.images?.length) {
    return m;
  }
  const { images, ...rest } = m;
  return { ...rest, content: `${m.content}\n\n[${images.length} image${images.length === 1 ? '' : 's'} omitted: the current model cannot see images]` };
}

/** A session saved mid-batch (window closed or reloaded) keeps tool calls without results; give each one so the history stays well-formed. */
export function closeDanglingToolCalls(messages: ChatMessage[]): void {
  for (let i = 0; i < messages.length; i++) {
    const calls = messages[i].role === 'assistant' ? messages[i].toolCalls : undefined;
    if (!calls?.length) {
      continue;
    }
    const answered = new Set<string>();
    let end = i + 1;
    let last = i;
    for (; end < messages.length; end++) {
      const m = messages[end];
      if (m.role === 'tool') {
        if (m.toolCallId) {
          answered.add(m.toolCallId);
        }
        last = end;
      } else if (!(m.role === 'user' && m.meta?.toolImages)) {
        break;
      }
    }
    const missing = calls.filter((c) => !answered.has(c.id));
    if (missing.length) {
      messages.splice(last + 1, 0, ...missing.map((c): ChatMessage => ({ role: 'tool', toolCallId: c.id, toolName: c.name, content: 'Interrupted: this tool did not finish (the window was closed or reloaded).', meta: { timestamp: Date.now() } })));
      i = last + missing.length;
    }
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
