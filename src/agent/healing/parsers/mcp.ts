import { finish, lines, make, type ParsedFailure } from './common';

/** Errors proving the request never reached the server: safe to replay after a reconnect. */
const NOT_SENT = /\bnot connected\b|server is not running|no connected MCP server|transport (?:was |is )?closed before (?:the request (?:was )?)?(?:sen[dt]|sending)|closed before (?:the request (?:was )?)?sen[dt]|connection (?:was )?closed before (?:the request (?:was )?)?sen[dt]/i;
/** The call may have reached the server (side effects possible): reported, never replayed. */
const TIMEOUT = /\btimed? ?out\b/i;
const CLOSED = /\b(?:connection|transport|stream|socket) (?:was |is |has been )?closed\b|\bserver (?:has )?(?:exited|crashed|disconnected)\b|\bECONNRESET\b|\bEPIPE\b/i;
const RPC = /(?:MCP error|JSON-?RPC error|"code"\s*:)\s*(-32\d{3})|\b(-32\d{3})\b/i;
const DETERMINISTIC_RPC = new Set(['-32600', '-32601', '-32602']);

/** An MCP tool error: connection state (replayable or not), timeouts, JSON-RPC error codes. */
export function parseMcp(text: string, root: string): ParsedFailure[] {
  const body = lines(text).join('\n').trim();
  if (!body) {
    return [];
  }
  const first = body.split('\n').find((l) => l.trim())!.trim();
  const rpc = RPC.exec(body);
  const code = rpc?.[1] ?? rpc?.[2] ?? (/invalid params/i.test(body) ? '-32602' : /method not found/i.test(body) ? '-32601' : undefined);
  if (NOT_SENT.test(body)) {
    return finish([make('mcp', { code: 'MCP:not_connected', message: first, cls: 'transient', notExecuted: true, evidence: body }, root)], root);
  }
  if (TIMEOUT.test(body)) {
    return finish([make('mcp', { code: 'MCP:timeout', message: first, cls: 'transient', notExecuted: false, evidence: body }, root)], root);
  }
  if (code) {
    const deterministic = DETERMINISTIC_RPC.has(code);
    return finish([make('mcp', { code: `MCP:${code}`, message: first, cls: deterministic ? 'deterministic' : 'transient', severity: deterministic ? 'low' : 'medium', notExecuted: false, evidence: body }, root)], root);
  }
  if (CLOSED.test(body)) {
    return finish([make('mcp', { code: 'MCP:closed', message: first, cls: 'transient', notExecuted: false, evidence: body }, root)], root);
  }
  return [];
}
