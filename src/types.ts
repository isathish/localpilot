/** Shared domain types used across providers, agent loop, tools and UI. */

import type { CommandOutcome } from './terminal/commandRun';
import type { ImageAttachment } from './ui/images';

export type Role = 'system' | 'user' | 'assistant' | 'tool';

export interface ToolCall {
  id: string;
  name: string;
  /** Raw JSON string of arguments as emitted by the model. */
  arguments: string;
  /** Provider metadata echoed back with the call (e.g. Gemini thought signatures in `extra_content`). */
  extra?: Record<string, unknown>;
}

export interface ChatMessage {
  role: Role;
  content: string;
  /** Base64-encoded images (multimodal). */
  images?: string[];
  /** Assistant tool calls. */
  toolCalls?: ToolCall[];
  /** For role === 'tool': the call this result answers. */
  toolCallId?: string;
  toolName?: string;
  /** Model reasoning (thinking models). Never re-sent to the model. */
  thinking?: string;
  /** Internal metadata: not sent to the model. */
  meta?: {
    timestamp?: number;
    tokens?: number;
    /** Marks a compaction summary message. */
    summary?: boolean;
    /** Marks that the tool output was truncated / pruned. */
    pruned?: boolean;
    /** Internal steering message (e.g. the completion nudge); sent to the model but not shown in the transcript. */
    hidden?: boolean;
    /** Why a hidden nudge was sent ('claimed' | 'announced' | 'shown' | 'malformed' | 'bare'); the UI marks the retracted reply. */
    nudge?: string;
    /** User-role carrier for images produced by tools (browser_screenshot); lists the originating tool call ids. */
    toolImages?: string[];
    /** Text protocol: user-role carrier of tool results; lists the tool call ids whose results it holds. */
    toolResults?: string[];
    /** A user message typed while the agent was running/paused and injected at a step boundary. */
    steer?: boolean;
    /** Correlates a steering message with the "queued" bubble the UI showed before it was injected. */
    steerId?: string;
    /** On the last assistant message of a turn: wall-clock time of the whole turn, for the "Worked for …" summary. */
    durationMs?: number;
    /** On the last assistant message of a turn the user stopped: the chat shows "Stopped by you" instead of "Worked for". */
    stopped?: boolean;
    /** On a run_command result that was a test run: counts and the failing tests, for the row's "6 passed · 1 failed" badge. */
    tests?: import('./agent/healing/parsers/testSummary').TestSummary;
    /** On the last assistant message of a turn: the model that answered (provider-qualified id). */
    model?: string;
    /** On the last assistant message of a turn: tokens generated and the time spent generating them, for the speed shown under the answer. */
    outputTokens?: number;
    genMs?: number;
    /** The model call that ended this turn failed: the friendly message shown in the error box. */
    error?: string;
    /** What the transcript shows instead of the content (a slash command whose expanded prompt is the content). */
    display?: string;
    /** An `/mcp:` prompt turn: how many of `images` (the last ones) came from the prompt rather than the user. */
    mcpPromptImages?: number;
    /** Misspelled names in the request that were corrected to real workspace names before it was sent. */
    corrections?: { from: string; to: string }[];
    /** On a user message: the change-tracker turn key that Restore checkpoint reverts to. */
    checkpoint?: number;
    /** On a tool result: the call failed (compaction's one-line tool summaries report it). */
    failed?: boolean;
    /** Position of this message in the session's transcript archive (`<id>.archive.jsonl`), once a compaction archived it. */
    archived?: number;
    /** Self-healing: a hidden fix prompt (attempt, category, signature) or, on the final answer, the outcome footer (`report`). */
    healing?: { attempt?: number; category?: string; signature?: string; report?: string };
    /** A message the self-healing engine added (e.g. the assistant tool call of a delegated fix) rather than the model. */
    synthetic?: 'healing';
  };
}

export interface JsonSchema {
  type: 'object';
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: JsonSchema;
}

export interface ModelInfo {
  /** Globally unique: `${providerId}/${modelId}` */
  id: string;
  providerId: string;
  modelId: string;
  name: string;
  family?: string;
  contextWindow: number;
  maxOutputTokens: number;
  supportsTools: boolean;
  supportsVision: boolean;
  supportsFim?: boolean;
  /** The server reports a reasoning ("thinking") capability; false = it rejects `think`. Undefined = unknown. */
  supportsThinking?: boolean;
  /** On-disk size when the server reports it (Ollama). */
  sizeBytes?: number;
  /** Parameter count label when reported, e.g. `7.6B`. */
  parameterSize?: string;
  /** Hidden from pickers and routing via `localpilot.models.disabled`. Only set by the registry's full listing. */
  disabled?: boolean;
  /** Inference engine behind the server when it identified itself (colibri: experts streamed from disk). */
  runtime?: 'colibri';
  /** RAM the model needs while running when it differs from its size on disk (MoE engines that stream experts), in GB. */
  residentGb?: number;
  /** Size on disk in GB when known and different from the resident size. */
  diskGb?: number;
  /** Requests the server decodes at once for this model (colibri KV slots); undefined = LocalPilot's default assumption. */
  parallelSlots?: number;
  /** Served by a cloud API (not this machine or the private network): automatic routing prefers local models. */
  remote?: boolean;
  /** Prices of a cloud model from the bundled model facts; absent for local models and unknown prices. */
  pricing?: ModelPricing;
  /** Sampling temperature for this model from the provider's `modelOverrides`; wins over `localpilot.temperature`. */
  temperature?: number;
}

/** US dollars per 1M tokens. Cache prices default to the input price (reads) and 1.25 × input (writes). */
export interface ModelPricing {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
}

export interface ChatRequestOptions {
  model: string; // provider-local model id
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  temperature?: number;
  maxTokens?: number;
  /** Desired context window (Ollama num_ctx). */
  contextWindow?: number;
  stop?: string[];
  jsonSchema?: Record<string, unknown>;
  /** Thinking: false/true or an effort level for reasoning models. */
  think?: boolean | 'low' | 'medium' | 'high' | 'max';
  /** Keep the model loaded between turns (Ollama keep_alive). */
  keepAlive?: string;
  signal?: AbortSignal;
}

/**
 * Token counts a provider reports for one request. `promptTokens` is the whole input, cached parts included (the
 * real prompt size: context calibration and telemetry rely on it); the cache fields say how much of it was cached.
 */
export interface ProviderUsage {
  promptTokens?: number;
  completionTokens?: number;
  /** Input tokens served from the provider's prompt cache. */
  cacheReadTokens?: number;
  /** Input tokens written to the prompt cache (Anthropic cache creation). */
  cacheWriteTokens?: number;
  /** Cost the provider reported for the request (OpenRouter `usage.cost`), in US dollars. */
  costUsd?: number;
}

export type StreamEvent =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'tool_call'; call: ToolCall }
  | ({ type: 'usage' } & ProviderUsage)
  /** Liveness while a tool call's arguments stream (nothing to show yet). */
  | { type: 'progress' }
  | { type: 'done'; finishReason?: string };

export interface CompletionRequestOptions {
  model: string;
  prompt: string;
  suffix?: string;
  maxTokens?: number;
  temperature?: number;
  stop?: string[];
  /** Keep the model loaded between requests (Ollama keep_alive). */
  keepAlive?: string;
  /** Ollama num_ctx; must match what chat/warm send for the same model, or Ollama reloads the weights. */
  contextWindow?: number;
  signal?: AbortSignal;
}

export interface WarmOptions {
  keepAlive?: string;
  /** Must match the `contextWindow` later requests send: Ollama reloads the weights when `num_ctx` changes. */
  contextWindow?: number;
}

export interface LLMProvider {
  readonly id: string;
  readonly type: ProviderConfig['type'];
  readonly displayName: string;
  readonly baseUrl: string;
  listModels(signal?: AbortSignal): Promise<ModelInfo[]>;
  chat(opts: ChatRequestOptions): AsyncIterable<StreamEvent>;
  /** Fill-in-the-middle / plain completion for inline suggestions. */
  complete(opts: CompletionRequestOptions): Promise<string>;
  embed?(model: string, input: string[]): Promise<number[][]>;
  healthCheck(signal?: AbortSignal): Promise<boolean>;
  /** Load the model into memory ahead of the first request so the first token arrives sooner (optional, best effort). */
  warm?(model: string, opts: WarmOptions, signal?: AbortSignal): Promise<void>;
  /** Models currently loaded in memory (Ollama `/api/ps`): provider-local id and the memory each takes, context cache included; absent = unknown. */
  loadedModels?(signal?: AbortSignal): Promise<{ id: string; bytes?: number }[]>;
}

export interface ProviderConfig {
  id: string;
  /** `ollama` native API, `openai` any OpenAI-compatible `/v1` API (local servers and most clouds), `anthropic` Claude's Messages API, `vscode-lm` VS Code's language models (Copilot; VS Code only). */
  type: 'ollama' | 'openai' | 'anthropic' | 'vscode-lm';
  baseUrl: string;
  /** Literal key, an environment reference (`${env:OPENAI_API_KEY}`) or a key kept in VS Code's secret storage (`${secret:openai}`). */
  apiKey?: string;
  /**
   * The server forwards prompts to cloud models although it runs locally (gateways such as OmniRoute or LiteLLM).
   * Unset = decided by the URL: anything off this machine and the private network is cloud.
   */
  cloud?: boolean;
  displayName?: string;
  /** Optional explicit model list (for servers whose /models is empty, e.g. some llama.cpp builds). */
  models?: string[];
  /** Default context window if the server does not report one. */
  contextWindow?: number;
  enabled?: boolean;
  /** Extra request headers; values may use `${env:NAME}` and `${secret:NAME}` like the API key. */
  headers?: Record<string, string>;
  /** Least time to wait for the first token, in milliseconds (slow gateways, cold starts). */
  timeoutMs?: number;
  /** Azure OpenAI `api-version` query parameter (deployment-style endpoints). */
  apiVersion?: string;
  /** Per-model facts and settings that win over what the server and the bundled facts say. */
  modelOverrides?: Record<string, ModelOverride>;
  /** The model `<id>` alone refers to (`-m openrouter`, `defaultModel: "openrouter"`). */
  defaultModel?: string;
  /** Where the model list is read from when it is not `<baseUrl>/models`. */
  modelsUrl?: string;
  /** Fields merged into every chat request body (OpenRouter `provider.sort`, vendor options). */
  extraBody?: Record<string, unknown>;
}

/** One model's overrides in a provider's `modelOverrides`. Prices are US dollars per 1M tokens. */
export interface ModelOverride {
  contextWindow?: number;
  maxOutput?: number;
  vision?: boolean;
  reasoning?: boolean;
  inputPrice?: number;
  outputPrice?: number;
  temperature?: number;
}

export type ApprovalMode = 'always' | 'never' | 'ask';
/** `approvals.terminal` also has `safe`: read-only, test and build commands run without asking. */
export type TerminalApprovalMode = ApprovalMode | 'safe';

/** The user's answer to an approval prompt; `feedback` is the reason given with a denial. */
export interface ApprovalDecision {
  ok: boolean;
  feedback?: string;
  /** Set by the agent loop when a person answered the prompt (not a setting, policy, stop or non-interactive refusal). */
  byUser?: boolean;
  /** run_command: the command line the user edited in the prompt before allowing it (runs instead of the model's). */
  edited?: string;
}

/** Extra facts a tool passes with an approval request. */
export interface ApprovalOptions {
  /** The organization's policy requires this prompt. */
  mandatory?: boolean;
  /** An MCP server's autoApprove list covers this tool. */
  autoApprove?: boolean;
  /** run_command: the command is read-only or a known test/build command (`approvals.terminal = safe` runs it). */
  safeCommand?: boolean;
  /** run_command: the command looks destructive; it asks even under `always` (`approvals.dangerousAlwaysAsk`). */
  dangerous?: boolean;
  /** The model asked for confirmation (`requires_approval`): the user is asked even under `always` or `safe`. */
  confirm?: boolean;
  /** File edits: the proposed contents, shown as side-by-side diffs while the approval waits (`localpilot.diffPreview`). */
  preview?: ProposedEdit[];
  /**
   * Self-healing verification checks: a turn-scoped allowance for this exact set of check commands. gateApproval
   * honours it only when `!mandatory && !strict && !dangerous && !confirm` and `managed.approvals.terminal` is unset:
   * then a granted allowance runs without a prompt, otherwise one prompt is shown and a yes calls `grant()`. In every
   * other case the normal prompt is shown and `grant()` is never called.
   */
  healingAllowance?: { commandsHash: string; granted: boolean; grant: () => void };
}

/** Why a tool call did not run, reported by executeToolCalls next to the (unchanged) result text. */
export type ToolCallDecision = {
  deniedByUser?: boolean;
  blockedBy?: 'policy' | 'rule' | 'hook' | 'setting' | 'unattended' | 'stopped';
};

/** A file's content as an edit tool is about to write it. */
export interface ProposedEdit {
  fsPath: string;
  /** The file's current text (of a move's source); undefined when it does not exist yet. */
  before?: string;
  /** The text the tool will write; undefined when it deletes the file. */
  proposed?: string;
}

/** One question the agent asks the user (ask_user), shown as a card in the chat. */
export interface UserQuestion {
  /** Very short topic chip, e.g. "Auth method". */
  header?: string;
  question: string;
  /** 2–4 choices, each with a one-line explanation of what picking it means. Empty = free-text answer only. */
  options: { label: string; description?: string }[];
  /** Several options may be picked together. */
  multiSelect?: boolean;
  /** The option the agent would choose if the user has no preference. */
  recommended?: string;
}

/** The user's answer to one question: picked option labels and/or their own words. */
export interface UserAnswer {
  question: string;
  selected: string[];
  other?: string;
}

export interface ToolContext {
  sessionId: string;
  workspaceRoot?: string;
  /** The real checkout folder an isolated run mirrors (its worktree copy is `workspaceRoot`); unset when not isolated. */
  isolatedFrom?: string;
  /** The real checkout: shared state such as the team board and repos.json lives there, also for isolated runs. */
  mainRoot?: string;
  signal: AbortSignal;
  /** Ask the user to approve a dangerous action. Resolves true when approved. */
  requestApproval(title: string, detail: string, kind: 'terminal' | 'write' | 'delete' | 'network' | 'mcp', opts?: ApprovalOptions): Promise<boolean>;
  /** Like `requestApproval`, with the reason the user gave for a denial (set by the agent loop). */
  approve?(title: string, detail: string, kind: 'terminal' | 'write' | 'delete' | 'network' | 'mcp', opts?: ApprovalOptions): Promise<ApprovalDecision>;
  /** Stream progress text to the UI. */
  progress(text: string): void;
  /** Id of the tool call being executed (set per call by the agent loop). */
  callId?: string;
  /** The command the user edited in this call's approval prompt, once allowed (run_command runs it instead). */
  approvalEdit?(): string | undefined;
  /** Live output of the running call (run_command), shown under its row as a `tool_progress` event. */
  output?(chunk: string): void;
  /** Snapshot a file before modifying it so the user can review/undo the agent's changes. */
  trackChange(fsPath: string): Promise<void>;
  /** Read/replace the session's todo list (undefined for subagents without a session). */
  todos?: { get(): TodoItem[]; set(items: TodoItem[]): void };
  /** Depth of agent nesting (0 = main agent). */
  depth: number;
  /** `provider/model` answering the current turn (subagents inherit it unless routed elsewhere). */
  modelRef?: string;
  /** True in Plan/Ask mode: subagents spawned from here must not mutate the workspace either. */
  readOnly?: boolean;
  /** Mode of the run executing this tool; in Plan/Ask `run_command` only runs read-only commands. */
  mode?: Session['mode'];
  /** Pause/stop/steer handle of the run executing this tool; subagents register their own control under it. */
  control?: import('./agent/runControl').RunControl;
  /** Skills in force for this run (preloaded, pinned or loaded with load_skill); subagents spawned from here inherit them. */
  skills?: string[];
  /** Books a subagent's model request into this run's session (and on up to the top-level chat). */
  recordUsage?(u: ProviderUsage | undefined, model?: string, provider?: string): void;
  /**
   * Shows questions in the chat and waits. Resolves the answers, `null` when the user skipped them, or `undefined`
   * when no chat surface can show them (the tool then falls back to native pickers). Absent for subagents.
   */
  askUser?(questions: UserQuestion[]): Promise<UserAnswer[] | null | undefined>;
  /**
   * Set for a synthetic self-healing check / resolver command: no auto-detach (killed at the timeout), the higher
   * healing timeout cap, the safe-command shortcut only when the command matches a check spec, and the raw unclamped
   * outcome reported through `rawOutcome`.
   */
  healingExec?: {
    origin: 'healing';
    noAutoDetach: true;
    timeoutSeconds: number;
    checkSpecMatch: boolean;
    /** Required: every synthetic exec site collects the raw outcome the classifier parses. */
    rawOutcome: (o: HealingRawOutcome) => void;
  };
}

/** The unclamped `run_command` outcome reported to the self-healing engine (full captured output). */
export type HealingRawOutcome = CommandOutcome & { timedOut?: boolean };

export interface ToolResult {
  content: string;
  isError?: boolean;
  /** Structured data for UI rendering (e.g. diffs). */
  data?: unknown;
  /** Images for the model (read_file on a screenshot); sent with the tool results when the model has vision. */
  images?: ImageAttachment[];
}

export interface Tool {
  definition: ToolDefinition;
  /** Which approval setting governs this tool. */
  approvalKind?: 'terminal' | 'write' | 'delete' | 'network' | 'mcp';
  /** Safe to run concurrently with other tools (read-only). */
  parallelSafe?: boolean;
  /** Declared side-effect free (e.g. MCP readOnlyHint); allowed in Plan/Ask. */
  readOnly?: boolean;
  execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}

export interface Skill {
  name: string;
  description: string;
  /** Absolute path to SKILL.md */
  path: string;
  /** Folder containing the skill (for referenced resources). */
  dir: string;
  /** Lazily loaded body. */
  body?: string;
  /** `managed`: the organisation's skills folder next to managed-settings.json. */
  source: 'managed' | 'workspace' | 'user' | 'builtin';
  /** Listed in `localpilot.skills.disabled`: kept on disk, hidden from the agent. */
  disabled?: boolean;
  /** `alwaysEnabled: true` front matter: `localpilot.skills.disabled` cannot switch it off. */
  alwaysEnabled?: boolean;
}

/** How a chat uses skills; `mode` undefined inherits `localpilot.skills.autoInstall`. */
export interface SessionSkills {
  /** Registry behaviour for this chat (auto: install matches · ask: offer them · off: never). `off` here also silences suggestions for installed skills; pins and /skill still work. */
  mode?: 'auto' | 'ask' | 'off';
  /** Skills loaded into every request of this chat regardless of matching. */
  pinned?: string[];
}

export interface SubagentDefinition {
  name: string;
  description: string;
  systemPrompt: string;
  /** Restrict tools available to the subagent. */
  tools?: string[];
  model?: string;
  /** Skills preloaded into every run of this subagent (`skills:` in the agent file's front-matter). */
  skills?: string[];
  source: 'workspace' | 'user' | 'builtin';
}

/** Modes whose agent may change files and run commands. */
export const WRITE_MODES: ReadonlySet<string> = new Set(['agent', 'multitask', 'debug']);
export const ALL_MODES = ['agent', 'multitask', 'debug', 'plan', 'ask'] as const;
/** The "More modes" specialists; each maps to a core mode and a built-in agent (see SPECIALISTS in agent/builtinAgents). */
export const SPECIALIST_IDS = ['architect', 'review', 'test', 'refactor', 'explain', 'terminal', 'project'] as const;
export type SpecialistId = (typeof SPECIALIST_IDS)[number];
export function isSpecialistId(v: unknown): v is SpecialistId {
  return typeof v === 'string' && (SPECIALIST_IDS as readonly string[]).includes(v);
}
export function isWriteMode(mode: string): boolean {
  return WRITE_MODES.has(mode);
}

export interface SessionSummary {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  model: string;
  /**
   * agent: edit/run/verify · multitask: coordinate several background workers · debug: reproduce → localise → fix
   * · plan: read-only, produces an executable checklist · ask: read-only Q&A.
   */
  mode: 'agent' | 'multitask' | 'debug' | 'ask' | 'plan';
  /**
   * A specialist picked from "More modes" (Review, Test, …): runs in its base `mode` (which decides permissions) with
   * the matching built-in agent's playbook added to the system prompt. Ignored when `mode` is not its base mode.
   */
  specialist?: SpecialistId;
  /** Plan mode output saved to `.localpilot/plans/<slug>.plan.md`, shown as the "Prepared plan" card. */
  plan?: { file: string; title: string; summary: string };
  messageCount: number;
  pinned?: boolean;
  /** Isolated git worktree this session's agent works in (see WorktreeManager); absent when it edits the workspace directly. */
  worktree?: import('./agent/worktrees').WorktreeInfo;
  /** Set when the session was started as part of a parallel batch, so `worktrees.mode = parallel` isolates it. */
  isolated?: boolean;
  /** Runs against the real checkout even when worktrees.mode isolates chats (git-facing work: commit message, /pr, /fix-ci). */
  direct?: boolean;
  /** Sessions started together on the same prompt (Best of N): compared and one result applied. */
  group?: { id: string; kind: 'bestOf' | 'batch'; prompt: string; size: number };
  /** Per-chat skill behaviour overriding the global setting (see SessionSkills). */
  skills?: SessionSkills;
  /** Tokens and cost of every model request made for this chat, its subagents' included. */
  usage?: SessionUsage;
  /** Size of the session file on disk (history list). */
  bytes?: number;
  /** Where the chat was started: `cli` for the terminal (shown with a CLI badge in VS Code's history), or the agent it was imported from. */
  origin?: 'cli' | 'claude-code' | 'codex';
  /** The chat this one was forked from, and its title at the time (history shows "forked from …"). */
  parentId?: string;
  parentTitle?: string;
  /** How hard the model thinks in this chat; unset follows `localpilot.thinking`. */
  think?: ThinkingLevel;
}

/** Running totals for a chat. `promptTokens` is the uncached input only; cached input is counted in the cache fields. */
export interface SessionUsage {
  promptTokens: number;
  completionTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Sum of provider-reported costs; absent when no request reported one. */
  costUsd?: number;
  requests: number;
  /** The share of the totals spent by subagents. */
  subagentTokens?: { promptTokens: number; completionTokens: number; requests: number };
  /** Model and provider of the last request. */
  model?: string;
  provider?: string;
}

export interface Session extends SessionSummary {
  messages: ChatMessage[];
  /** Running estimate of tokens currently in context. */
  contextTokens: number;
  /** Number of compactions performed. */
  compactions: number;
  /** Attached context items (file URIs, selections). */
  attachments: string[];
  /** Agent-maintained plan / checklist for the current task. */
  todos?: TodoItem[];
  /** Files read or modified in this session (workspace-relative), most recent last. */
  workingSet?: string[];
  /** Checkpoints taken before each user turn (git refs, or file snapshots outside git). */
  checkpoints?: import('./agent/checkpoints').SessionCheckpoints;
  /** Self-healing summary of the last turn that ran recovery or verification. */
  recovery?: import('./agent/healing/types').RecoverySummary;
  /**
   * Set while a run is in flight and saved with the session, so a run cut off by a reload or a closed window is
   * shown as "Run interrupted" with Resume / Restore checkpoint / Dismiss. Cleared when the run ends or is dismissed.
   */
  runningSince?: number;
}

export interface TodoItem {
  id: string;
  title: string;
  status: 'pending' | 'in_progress' | 'done' | 'skipped';
  /** Subagent to delegate this item to (run_todos_parallel); omit for items the main agent does itself. */
  agent?: string;
  /** Skills the worker must follow for this item (preloaded into its brief). */
  skills?: string[];
  /** Self-contained brief for the subagent. */
  prompt?: string;
  /** Optional provider/model override for the delegated item. */
  model?: string;
  /** Ids of items that must be done first; run_todos_parallel schedules items in dependency waves. */
  dependsOn?: string[];
  /** Delegated item's report (truncated), filled in by run_todos_parallel. */
  result?: string;
}

/** `auto` picks per task: deeper for Plan/Debug, medium for the main agent, light for subagents, none for helpers. */
export type ThinkingLevel = 'off' | 'auto' | 'on' | 'low' | 'medium' | 'high' | 'max';

export interface AgentEvent {
  sessionId: string;
  type:
    | 'assistant_delta'
    | 'thinking_delta'
    | 'tool_start'
    | 'tool_end'
    /** Live output of a running tool call (run_command). Payload: { id, chunk }. */
    | 'tool_progress'
    | 'approval_request'
    | 'model_request'
    | 'status'
    | 'error'
    | 'compaction'
    /** Durable facts from the finished run were saved to project memory (after turn_end). Payload: { saved: string[] }. */
    | 'memory'
    /** The prompt size changed: an estimate before a request, the server's real count after it. Payload: { contextTokens, contextWindow }. */
    | 'context'
    /** A model request failed transiently (or came back empty) and is being retried. Payload: { attempt, max, reason, message }. */
    | 'retry'
    /** The request looked ambiguous; the agent was given a workspace snapshot to resolve it. Payload: { reasons }. */
    | 'clarify'
    /**
     * Skills matching the request and/or a recurring request type worth turning into a skill.
     * Payload: { skills, create?, installed? (a catalog skill installed for this request), available? (one on offer) }.
     */
    | 'skill_suggestions'
    /** A child agent started. Payload: { childId, agent, prompt, model?, label? (short checklist title when run from a todo) }. */
    | 'subagent_start'
    | 'subagent_end'
    /**
     * The reply claimed or announced an action without calling a tool (or the call did not parse); the model is being
     * asked to act. Text that streams afterwards replaces the retracted reply. Payload: { reason }.
     */
    | 'nudge'
    /** Queued steering messages were appended to the conversation. Payload: { ids: string[], count }. */
    | 'steer'
    /** Conditional rules (front-matter `paths:` / `globs:`) matched the files in context this turn. Payload: { files: string[] }. */
    | 'rules_applied'
    /** A hook started or finished. Payload: { id, event, name, tool?, status: running|ok|failed|blocked, ms? }. */
    | 'hook'
    | 'todos'
    /**
     * The self-healing engine detected, retried, fixed, validated or escalated a failure; one card per task, updated
     * in place by `payload.id`. Payload: RecoveryEventPayload (src/agent/healing/types.ts).
     */
    | 'recovery'
    /**
     * Still waiting for the model's first token (a weight load, prompt prefill or a queue), sent about once a second.
     * Payload: { phase: 'load' | 'prefill' | 'queue', model, seconds, limitSec }; `{ done: true }` once output starts.
     */
    | 'waiting'
    /**
     * The turn is answered by another model than the one asked for (unavailable, not allowed, cannot see images).
     * Payload: { wanted, used, usedName, reason, fallback, cloud }.
     */
    | 'route'
    | 'turn_end';
  payload?: unknown;
}
