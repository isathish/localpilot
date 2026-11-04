import { createHash } from 'crypto';

/** Longest tool name every provider accepts (OpenAI, Anthropic, Gemini). */
export const MCP_TOOL_NAME_MAX = 64;

const shortHash = (server: string, tool: string) => createHash('sha1').update(`${server}/${tool}`).digest('hex').slice(0, 8);

/**
 * The registered name of an MCP tool: `mcp_<server>__<tool>`. A name that had to be sanitised to `[A-Za-z0-9_-]` or cut
 * to 64 characters ends in an 8-character sha1 of the real server and tool, so two tools never share a name.
 */
export function mcpToolName(server: string, tool: string, forceHash = false): string {
  const raw = `mcp_${server}__${tool}`;
  const safe = raw.replace(/[^A-Za-z0-9_-]/g, '_');
  if (!forceHash && safe === raw && raw.length <= MCP_TOOL_NAME_MAX) {
    return raw;
  }
  return `${safe.slice(0, MCP_TOOL_NAME_MAX - 9)}_${shortHash(server, tool)}`;
}

/** The name earlier versions registered (`mcp_<server>_<tool>`, cut to 60): still accepted in permission rules and tool lists. */
export function legacyMcpToolName(server: string, tool: string): string {
  return `mcp_${`${server}_${tool}`.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 60)}`;
}

/** Server and tool of an unregistered `mcp_<server>__<tool>` name (best effort: the first `__` separates them). */
export function splitMcpToolName(name: string): { server: string; tool: string } | undefined {
  const m = /^mcp_(.+?)__(.+)$/.exec(name);
  return m ? { server: m[1], tool: m[2] } : undefined;
}
