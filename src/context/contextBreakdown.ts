import { ChatMessage, ToolDefinition } from '../types';
import { estimateMessageTokens, estimateTokens, estimateToolsTokens } from './tokenizer';

/**
 * What fills a chat's context window, in the model's tokens: the parts of the prompt sent on the last request. The
 * context ring's hover card and `/context` show it so the user can see which part to trim (rules, MCP tools,
 * attached files, tool output) instead of only a percentage.
 */
export interface ContextBreakdown {
  /** LocalPilot's own instructions: identity, mode, environment, project map, skills index. */
  system: number;
  /** Project rules and instruction files (AGENTS.md, CLAUDE.md, .localpilot/rules…). */
  rules: number;
  /** Saved memory notes. */
  memory: number;
  /** Built-in tool definitions. */
  tools: number;
  /** Tool definitions from MCP servers (`mcp_<server>__<tool>`). */
  mcpTools: number;
  /** The user's requests and the model's replies. */
  conversation: number;
  /** Attached context: files, folders, @workspace, #codebase, @git, @problems, URLs, images. */
  files: number;
  /** Output of the tools the agent ran (reads, searches, commands). */
  toolResults: number;
  /** Compaction summaries standing in for older messages. */
  summary: number;
}

export const BREAKDOWN_KEYS: readonly (keyof ContextBreakdown)[] = ['system', 'rules', 'memory', 'tools', 'mcpTools', 'conversation', 'files', 'toolResults', 'summary'];

/** Context blocks the composer attaches to a user message (see WorkspaceContext.readAttachment). */
const ATTACHED = /<(attachment|workspace_tree|codebase|git|problems|open_editors|terminal_output|url_content|directory|commit)\b[^>]*>[\s\S]*?<\/\1>/g;
const IMAGE_TOKENS = 768;

export const isMcpTool = (name: string): boolean => /^mcp_.+__/.test(name) || name === 'mcp_read_resource';

/**
 * Splits a prompt into the parts above. `rules` and `memory` are sections of `system` (subtracted from it), and with
 * the text tool protocol (`toolsInSystem`) so are the tool definitions. `scale` turns estimates into the model's
 * tokens (TokenCalibration); `total`, when given, rescales the parts to a count the server reported.
 */
export function contextBreakdown(o: { system: string; rules?: string; memory?: string; tools: readonly ToolDefinition[]; toolsInSystem?: boolean; messages: readonly ChatMessage[]; scale?: number; total?: number }): ContextBreakdown {
  const mcp = o.tools.filter((t) => isMcpTool(t.name));
  const own = o.tools.filter((t) => !isMcpTool(t.name));
  const raw: ContextBreakdown = { system: 0, rules: 0, memory: 0, tools: estimateToolsTokens(own), mcpTools: estimateToolsTokens(mcp), conversation: 0, files: 0, toolResults: 0, summary: 0 };
  raw.rules = o.rules ? estimateTokens(o.rules) : 0;
  raw.memory = o.memory ? estimateTokens(o.memory) : 0;
  raw.system = Math.max(0, estimateTokens(o.system) - raw.rules - raw.memory - (o.toolsInSystem ? raw.tools + raw.mcpTools : 0));
  Object.assign(raw, historyBreakdown(o.messages));
  const sum = BREAKDOWN_KEYS.reduce((a, k) => a + raw[k], 0);
  const f = o.total !== undefined && sum > 0 ? o.total / sum : (o.scale ?? 1);
  const out = { ...raw };
  for (const k of BREAKDOWN_KEYS) {
    out[k] = Math.round(raw[k] * f);
  }
  return out;
}

/** The history's share of a breakdown (conversation, files, tool output, summaries), in estimated tokens × `scale`. */
export function historyBreakdown(messages: readonly ChatMessage[], scale = 1): Pick<ContextBreakdown, 'conversation' | 'files' | 'toolResults' | 'summary'> {
  const h = { conversation: 0, files: 0, toolResults: 0, summary: 0 };
  for (const m of messages) {
    const n = estimateMessageTokens(m);
    if (m.meta?.summary) {
      h.summary += n;
    } else if (m.role === 'tool' || m.meta?.toolResults || m.meta?.toolImages) {
      h.toolResults += n;
    } else if (m.role === 'user') {
      let attached = (m.images?.length ?? 0) * IMAGE_TOKENS;
      for (const b of m.content.matchAll(ATTACHED)) {
        attached += estimateTokens(b[0]);
      }
      attached = Math.min(n, attached);
      h.files += attached;
      h.conversation += n - attached;
    } else {
      h.conversation += n;
    }
  }
  return { conversation: Math.round(h.conversation * scale), files: Math.round(h.files * scale), toolResults: Math.round(h.toolResults * scale), summary: Math.round(h.summary * scale) };
}

const LABELS: Record<keyof ContextBreakdown, string> = { system: 'System prompt', rules: 'Rules', memory: 'Memory', tools: 'Tools', mcpTools: 'MCP tools', conversation: 'Conversation', files: 'Attached files', toolResults: 'Tool output', summary: 'Compaction summary' };

/** Markdown lines for `/context`: the non-empty parts, largest first, with their share of the window. */
export function formatBreakdown(b: ContextBreakdown, window?: number): string {
  const rows = BREAKDOWN_KEYS.filter((k) => b[k] > 0).sort((x, y) => b[y] - b[x]);
  return rows.map((k) => `- ${LABELS[k]}: ${b[k].toLocaleString()} tokens${window ? ` (${Math.max(b[k] > 0 ? 1 : 0, Math.round((b[k] / window) * 100))}%)` : ''}`).join('\n');
}
