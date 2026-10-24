/** Shared domain types used across providers, agent loop, tools and UI. */

export type Role = 'system' | 'user' | 'assistant' | 'tool';

export interface ToolCall {
  id: string;
  name: string;
  /** Raw JSON string of arguments as emitted by the model. */
  arguments: string;
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
    /** User-role carrier for images produced by tools (browser_screenshot); lists the originating tool call ids. */
    toolImages?: string[];
    /** A user message typed while the agent was running/paused and injected at a step boundary. */
    steer?: boolean;
    /** Correlates a steering message with the "queued" bubble the UI showed before it was injected. */
    steerId?: string;
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
  /** On-disk size when the server reports it (Ollama). */
  sizeBytes?: number;
  /** Parameter count label when reported, e.g. `7.6B`. */
  parameterSize?: string;
  /** Hidden from pickers and routing via `localpilot.models.disabled`. Only set by the registry's full listing. */
  disabled?: boolean;
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
  think?: boolean | 'low' | 'medium' | 'high';
  /** Keep the model loaded between turns (Ollama keep_alive). */
  keepAlive?: string;
  signal?: AbortSignal;
}

export type StreamEvent =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'tool_call'; call: ToolCall }
  | { type: 'usage'; promptTokens?: number; completionTokens?: number }
  | { type: 'done'; finishReason?: string };

export interface CompletionRequestOptions {
  model: string;
  prompt: string;
  suffix?: string;
  maxTokens?: number;
  temperature?: number;
  stop?: string[];
  signal?: AbortSignal;
}

export interface LLMProvider {
  readonly id: string;
  readonly type: 'ollama' | 'openai';
  readonly displayName: string;
  readonly baseUrl: string;
  listModels(signal?: AbortSignal): Promise<ModelInfo[]>;
  chat(opts: ChatRequestOptions): AsyncIterable<StreamEvent>;
  /** Fill-in-the-middle / plain completion for inline suggestions. */
  complete(opts: CompletionRequestOptions): Promise<string>;
  embed?(model: string, input: string[]): Promise<number[][]>;
  healthCheck(signal?: AbortSignal): Promise<boolean>;
}

export interface ProviderConfig {
  id: string;
  type: 'ollama' | 'openai';
  baseUrl: string;
  apiKey?: string;
  displayName?: string;
  /** Optional explicit model list (for servers whose /models is empty, e.g. some llama.cpp builds). */
  models?: string[];
  /** Default context window if the server does not report one. */
  contextWindow?: number;
  enabled?: boolean;
}

export type ApprovalMode = 'always' | 'never' | 'ask';

export interface ToolContext {
  sessionId: string;
  workspaceRoot?: string;
  signal: AbortSignal;
  /** Ask the user to approve a dangerous action. Resolves true when approved. */
  requestApproval(title: string, detail: string, kind: 'terminal' | 'write' | 'delete' | 'network'): Promise<boolean>;
  /** Stream progress text to the UI. */
  progress(text: string): void;
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
  /** Pause/stop/steer handle of the run executing this tool; subagents register their own control under it. */
  control?: import('./agent/runControl').RunControl;
}

export interface ToolResult {
  content: string;
  isError?: boolean;
  /** Structured data for UI rendering (e.g. diffs). */
  data?: unknown;
}

export interface Tool {
  definition: ToolDefinition;
  /** Which approval setting governs this tool. */
  approvalKind?: 'terminal' | 'write' | 'delete' | 'network';
  /** Safe to run concurrently with other tools (read-only). */
  parallelSafe?: boolean;
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
  source: 'workspace' | 'user' | 'builtin';
}

export interface SubagentDefinition {
  name: string;
  description: string;
  systemPrompt: string;
  /** Restrict tools available to the subagent. */
  tools?: string[];
  model?: string;
  source: 'workspace' | 'user' | 'builtin';
}

export interface SessionSummary {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  model: string;
  mode: 'agent' | 'ask' | 'plan';
  messageCount: number;
  pinned?: boolean;
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
}

export interface TodoItem {
  id: string;
  title: string;
  status: 'pending' | 'in_progress' | 'done' | 'skipped';
  /** Subagent to delegate this item to (run_todos_parallel); omit for items the main agent does itself. */
  agent?: string;
  /** Self-contained brief for the subagent. */
  prompt?: string;
  /** Optional provider/model override for the delegated item. */
  model?: string;
  /** Ids of items that must be done first; run_todos_parallel schedules items in dependency waves. */
  dependsOn?: string[];
  /** Delegated item's report (truncated), filled in by run_todos_parallel. */
  result?: string;
}

export type ThinkingLevel = 'off' | 'on' | 'low' | 'medium' | 'high';

export interface AgentEvent {
  sessionId: string;
  type:
    | 'assistant_delta'
    | 'thinking_delta'
    | 'tool_start'
    | 'tool_end'
    | 'approval_request'
    | 'model_request'
    | 'status'
    | 'error'
    | 'compaction'
    /** A model request failed transiently (or came back empty) and is being retried. Payload: { attempt, max, reason, message }. */
    | 'retry'
    /** The request looked ambiguous; the agent was given a workspace snapshot to resolve it. Payload: { reasons }. */
    | 'clarify'
    /**
     * Skills matching the request and/or a recurring request type worth turning into a skill.
     * Payload: { skills, create?, installed? (a catalog skill installed for this request), available? (one on offer) }.
     */
    | 'skill_suggestions'
    | 'subagent_start'
    | 'subagent_end'
    /** Queued steering messages were appended to the conversation. Payload: { ids: string[], count }. */
    | 'steer'
    | 'todos'
    | 'turn_end';
  payload?: unknown;
}
