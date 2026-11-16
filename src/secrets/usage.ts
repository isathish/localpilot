// What each stored secret is for, from the references settings hold (`${secret:NAME}` in a provider's key or headers,
// the web search key, MCP server env and headers) and the names LocalPilot gives its own secrets (MCP sign-in tokens,
// sync credentials). Shown next to every name in Settings and `localpilot secrets list`, and checked before a delete.
// Pure: the caller passes the settings.
import { secretRefs } from '../providers/cloud';

export interface UsageSources {
  providers?: readonly { id: string; displayName?: string; apiKey?: string; headers?: Record<string, string> }[];
  webSearchApiKey?: string;
  mcpServers?: Record<string, { env?: Record<string, unknown>; headers?: Record<string, unknown> } | undefined>;
}

/** name → what uses it ("provider OpenAI", "web search", "MCP github", "MCP sign-in", "sync"). */
export function secretUsage(src: UsageSources): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const add = (name: string, what: string) => {
    const list = out.get(name) ?? [];
    if (!list.includes(what)) {
      list.push(what);
    }
    out.set(name, list);
  };
  for (const p of src.providers ?? []) {
    if (!p || typeof p !== 'object') {
      continue;
    }
    const values = [p.apiKey, ...Object.values(p.headers && typeof p.headers === 'object' ? p.headers : {})].map((v) => String(v ?? ''));
    for (const n of values.flatMap((v) => secretRefs(v))) {
      add(n, `provider ${p.displayName || p.id}`);
    }
  }
  for (const n of secretRefs(src.webSearchApiKey)) {
    add(n, 'web search');
  }
  for (const [server, cfg] of Object.entries(src.mcpServers ?? {})) {
    const values = [...Object.values(cfg?.env ?? {}), ...Object.values(cfg?.headers ?? {})].map((v) => String(v ?? ''));
    for (const n of values.flatMap((v) => secretRefs(v))) {
      add(n, `MCP ${server}`);
    }
  }
  return out;
}

/** What a secret is for: its references, else what its name says (LocalPilot's own MCP sign-in and sync secrets). */
export function usedBy(name: string, usage: Map<string, string[]>): string[] {
  const refs = usage.get(name) ?? [];
  if (refs.length) {
    return refs;
  }
  if (name.startsWith('localpilot.mcp.oauth.')) {
    return [`MCP sign-in (${name.slice('localpilot.mcp.oauth.'.length)})`];
  }
  if (name.startsWith('localpilot.sync.') || name.startsWith('sync:')) {
    return ['sync'];
  }
  return [];
}
