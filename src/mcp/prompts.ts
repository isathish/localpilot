import type { ImageAttachment } from '../ui/images';
import { McpContentItem, mcpContentToResult } from './content';

export interface McpPromptArg {
  name: string;
  description?: string;
  required?: boolean;
}

/** `/mcp:<server>:<prompt> args…`: the server is everything up to the last `:` (plugin servers are named `plugin:server`). */
export function parseMcpSlash(text: string): { server: string; prompt: string; args: string } | undefined {
  const m = /^\/mcp:(\S+):([^\s:]+)(?:\s+([\s\S]*))?$/.exec(text.trim());
  return m ? { server: m[1], prompt: m[2], args: (m[3] ?? '').trim() } : undefined;
}

/**
 * The images to send again with an `/mcp:` turn that is expanded again (regenerate, edit): `images` without the
 * prompt's own, the last `promptCount` of the stored message's, which the prompt brings back by itself.
 */
export function withoutMcpPromptImages(images: string[] | undefined, stored: { images?: string[]; meta?: { mcpPromptImages?: number } } | undefined): string[] | undefined {
  const n = stored?.meta?.mcpPromptImages ?? 0;
  const fromPrompt = n > 0 ? (stored?.images ?? []).slice(-n) : [];
  if (!images || !fromPrompt.length || images.length < fromPrompt.length || !fromPrompt.every((d, i) => images[images.length - fromPrompt.length + i] === d)) {
    return images;
  }
  const own = images.slice(0, images.length - fromPrompt.length);
  return own.length ? own : undefined;
}

/** The slash command that runs a prompt. */
export function mcpSlashName(server: string, prompt: string): string {
  return `/mcp:${server}:${prompt}`;
}

/** Splits on whitespace; "double" or 'single' quotes keep spaces, also inside `key="a b"`. */
export function splitPromptArgs(raw: string): string[] {
  const out: string[] = [];
  const re = /(?:[^\s"']+|"[^"]*"|'[^']*')+/g;
  for (const m of raw.match(re) ?? []) {
    out.push(m.replace(/"([^"]*)"|'([^']*)'/g, (_, a: string | undefined, b: string | undefined) => a ?? b ?? ''));
  }
  return out;
}

/**
 * Maps typed arguments onto a prompt's declared ones: `key=value` for a declared name, the rest by position. Words
 * beyond the declared arguments join the last positional one, so `/mcp:git:review fix the login bug` fills a single
 * argument with the whole sentence. Returns the missing required names too.
 */
export function mapPromptArgs(raw: string, declared: McpPromptArg[] = []): { args: Record<string, string>; missing: string[] } {
  const args: Record<string, string> = {};
  const names = new Set(declared.map((d) => d.name));
  const positional: string[] = [];
  for (const tok of splitPromptArgs(raw)) {
    const kv = /^([\w.-]+)=([\s\S]*)$/.exec(tok);
    if (kv && (names.has(kv[1]) || !declared.length)) {
      args[kv[1]] = kv[2];
    } else {
      positional.push(tok);
    }
  }
  const open = declared.filter((d) => !(d.name in args));
  open.forEach((d, i) => {
    if (i >= positional.length) {
      return;
    }
    args[d.name] = i === open.length - 1 ? positional.slice(i).join(' ') : positional[i];
  });
  const missing = declared.filter((d) => d.required && !args[d.name]).map((d) => d.name);
  return { args, missing };
}

/** A usage line for a prompt: `/mcp:s:p <required> [optional]`. */
export function mcpPromptUsage(server: string, prompt: string, declared: McpPromptArg[] = []): string {
  return [mcpSlashName(server, prompt), ...declared.map((d) => (d.required ? `<${d.name}>` : `[${d.name}]`))].join(' ');
}

/**
 * The messages `prompts/get` returned, as the text of one user turn. A single user message is used as written; a
 * conversation is laid out with a role line per message so the model sees who said what.
 */
export function promptMessagesToText(result: { description?: string; messages?: { role?: string; content?: McpContentItem | McpContentItem[] }[] }, label = 'prompt'): { text: string; images: ImageAttachment[] } {
  const msgs = Array.isArray(result?.messages) ? result.messages : [];
  const images: ImageAttachment[] = [];
  const parts = msgs.map((m) => {
    const items = Array.isArray(m.content) ? m.content : m.content ? [m.content] : [];
    const r = mcpContentToResult(items, undefined, `${label}-${images.length}`);
    images.push(...r.images);
    return { role: m.role === 'assistant' ? 'assistant' : 'user', text: r.text };
  });
  const text = parts.every((p) => p.role === 'user') ? parts.map((p) => p.text).join('\n\n') : parts.map((p) => `[${p.role}]\n${p.text}`).join('\n\n');
  return { text: text.trim(), images };
}
