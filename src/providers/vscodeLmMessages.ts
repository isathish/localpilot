import { ChatMessage, ModelInfo } from '../types';

/** LocalPilot's own vendor in VS Code's Language Model API (src/ui/lmProvider.ts): never used as a source, or a request would loop back here. */
export const OWN_LM_VENDOR = 'localpilot';
/** Placeholder base URL for `vscode-lm` providers: the models live in VS Code, not behind a server. */
export const VSCODE_LM_BASE_URL = 'vscode://lm';

export type LmPart = { kind: 'text'; text: string } | { kind: 'call'; callId: string; name: string; input: object } | { kind: 'result'; callId: string; text: string };
export interface LmTurn {
  role: 'user' | 'assistant';
  parts: LmPart[];
}

/** The fields of a `vscode.LanguageModelChat` the listing needs. */
export interface LmModelLike {
  id: string;
  name: string;
  vendor: string;
  family: string;
  maxInputTokens: number;
}

export function isOwnVendor(vendor: string): boolean {
  return vendor.trim().toLowerCase() === OWN_LM_VENDOR;
}

/** Remembers the last model id set; true only when `ids` differs from it (the first call just records it). */
export function lmIdsChangeGate(initial?: readonly string[]): (ids: readonly string[]) => boolean {
  let last = initial ? [...initial].sort().join('\n') : undefined;
  return (ids) => {
    const key = [...ids].sort().join('\n');
    const changed = last !== undefined && key !== last;
    last = key;
    return changed;
  };
}

/** Maps a VS Code chat model to LocalPilot's model info: a cloud model with tools, no pricing (VS Code bills it, not a key). */
export function lmModelInfo(providerId: string, m: LmModelLike): ModelInfo {
  const input = m.maxInputTokens > 0 ? m.maxInputTokens : 32_768;
  const out = Math.max(1024, Math.min(16_384, Math.floor(input / 4)));
  return {
    id: `${providerId}/${m.id}`,
    providerId,
    modelId: m.id,
    name: `${m.name} (${m.vendor})`,
    family: m.family,
    contextWindow: input + out,
    maxOutputTokens: out,
    supportsTools: true,
    // The stable API (1.104) has no image part for requests.
    supportsVision: false,
    supportsThinking: false,
    remote: true,
  };
}

function parseArgs(args: string): object {
  try {
    const v: unknown = JSON.parse(args || '{}');
    return v && typeof v === 'object' && !Array.isArray(v) ? v : { input: v };
  } catch {
    return { input: args };
  }
}

/**
 * Converts a LocalPilot transcript into the user/assistant turns the Language Model API accepts: it has no system
 * role (system text leads the first user turn), tool results are parts of a user turn, and consecutive turns of the
 * same role are merged so tool results that answer one assistant turn travel together.
 */
export function toLmTurns(messages: ChatMessage[]): LmTurn[] {
  const system = messages.filter((m) => m.role === 'system' && m.content.trim()).map((m) => m.content);
  const turns: LmTurn[] = [];
  const push = (role: LmTurn['role'], parts: LmPart[]) => {
    if (!parts.length) {
      return;
    }
    const last = turns[turns.length - 1];
    if (last && last.role === role) {
      last.parts.push(...parts);
    } else {
      turns.push({ role, parts: [...parts] });
    }
  };
  for (const m of messages) {
    if (m.role === 'system') {
      continue;
    }
    if (m.role === 'tool') {
      push('user', [{ kind: 'result', callId: m.toolCallId ?? '', text: m.content || '(no output)' }]);
    } else if (m.role === 'assistant') {
      const parts: LmPart[] = m.content ? [{ kind: 'text', text: m.content }] : [];
      for (const c of m.toolCalls ?? []) {
        parts.push({ kind: 'call', callId: c.id, name: c.name, input: parseArgs(c.arguments) });
      }
      push('assistant', parts);
    } else {
      const text = m.images?.length ? `${m.content}\n[${m.images.length} image(s) omitted: this model cannot take images]` : m.content;
      push('user', text ? [{ kind: 'text', text }] : []);
    }
  }
  if (system.length) {
    const head = { kind: 'text' as const, text: system.join('\n\n') };
    if (turns[0]?.role === 'user') {
      turns[0].parts.unshift(head);
    } else {
      turns.unshift({ role: 'user', parts: [head] });
    }
  }
  if (!turns.length) {
    turns.push({ role: 'user', parts: [{ kind: 'text', text: '' }] });
  }
  // Tool results go first in a user turn, before any text typed after them.
  for (const t of turns) {
    if (t.role === 'user' && t.parts.some((p) => p.kind === 'result')) {
      t.parts.sort((a, b) => Number(b.kind === 'result') - Number(a.kind === 'result'));
    }
  }
  return turns;
}
