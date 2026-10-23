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
    | 'status'
    | 'error'
    | 'compaction'
    | 'subagent_start'
    | 'subagent_end'
    | 'todos'
    | 'turn_end';
  payload?: unknown;
}
