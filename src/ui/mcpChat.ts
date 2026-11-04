import type { McpManager, McpServerStatus } from '../mcp/mcpManager';
import { mcpPromptUsage } from '../mcp/prompts';

/** One server as the chat's MCP popover and slash menu show it. */
export interface McpChatServer {
  name: string;
  state: McpServerStatus['state'];
  tools: number;
  error?: string;
  /** Where it is defined; plugin servers cannot be switched from the chat. */
  source?: string;
  prompts: { invoke: string; usage: string; description?: string }[];
}

export type McpChatMessage = { type: 'mcpStatus'; servers: McpChatServer[] };

/** The servers for the chat (an empty list when MCP is not running). */
export function mcpChatStatus(mcp: McpManager | undefined): McpChatMessage {
  const servers = (mcp?.status ?? []).map((s) => ({
    name: s.name,
    state: s.state,
    tools: s.tools,
    error: s.error,
    source: s.source,
    prompts: (s.prompts ?? []).map((p) => ({ invoke: `/mcp:${s.name}:${p.name}`, usage: mcpPromptUsage(s.name, p.name, p.arguments), description: p.description })),
  }));
  return { type: 'mcpStatus', servers };
}

/**
 * The popover's actions: switch a server on or off (written where it is defined) and restart it. Errors become toasts;
 * the status the manager fires afterwards redraws the popover. The popover shows the new state before the host
 * confirms it, so on a failure the real status is sent at once (`status`) to put it back.
 */
export async function handleMcpChatAction(
  mcp: McpManager | undefined,
  msg: { type: 'mcpToggle'; name: string; enabled: boolean } | { type: 'mcpRestart'; name: string },
  toast: (level: 'info' | 'error', text: string) => void,
  status: (m: McpChatMessage) => void = () => undefined
): Promise<void> {
  if (!mcp) {
    toast('error', 'MCP is not running in this window');
    status(mcpChatStatus(mcp));
    return;
  }
  try {
    if (msg.type === 'mcpToggle') {
      await mcp.setEnabled(msg.name, msg.enabled);
    } else if (!(await mcp.restart(msg.name))) {
      toast('error', `${msg.name}: ${mcp.status.find((s) => s.name === msg.name)?.error ?? 'could not be started'}`);
      status(mcpChatStatus(mcp));
    }
  } catch (e) {
    toast('error', e instanceof Error ? e.message : String(e));
    status(mcpChatStatus(mcp));
  }
}
