/**
 * Slash-command names shared by the chat and the CLI: Cline-style normalisation, which target a `/name` reaches
 * (built-in command, then skill, then custom command or workflow) and finding a command named inside a message.
 */

/** File types read as commands and workflows. */
export const COMMAND_FILE = /\.(md|markdown|txt)$/i;

/** `My Review.MD` → `my-review`: lowercase, spaces become `-`, only `[a-z0-9_.:@-]` is kept, a `.md`/`.markdown`/`.txt` suffix is dropped. */
export function normalizeCommandName(raw: string): string {
  return raw
    .trim()
    .replace(/^\//, '')
    .replace(COMMAND_FILE, '')
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9_.:@-]/g, '');
}

/** What `/name` runs: a LocalPilot built-in command first, then an enabled skill of that name, then a custom command. */
export function pickSlashTarget<C extends { source: string }, S>(command: C | undefined, skill: S | undefined): { command: C } | { skill: S } | undefined {
  if (command?.source === 'builtin') {
    return { command };
  }
  if (skill) {
    return { skill };
  }
  return command ? { command } : undefined;
}

export interface SlashToken {
  /** Normalised command name (no slash). */
  name: string;
  start: number;
  end: number;
}

/**
 * The first `/name` token (at the start or after whitespace, followed by whitespace or the end) that `isKnown`
 * accepts. Tokens inside fenced code blocks are skipped.
 */
export function findSlashToken(text: string, isKnown: (name: string) => boolean): SlashToken | undefined {
  const fences: [number, number][] = [];
  for (const f of text.matchAll(/```[\s\S]*?(?:```|$)/g)) {
    fences.push([f.index ?? 0, (f.index ?? 0) + f[0].length]);
  }
  for (const m of text.matchAll(/(^|\s)\/([a-z0-9_.:@-]+)(?=\s|$)/gi)) {
    const start = (m.index ?? 0) + m[1].length;
    if (fences.some(([a, b]) => start >= a && start < b)) {
      continue;
    }
    const name = normalizeCommandName(m[2]);
    if (name && isKnown(name)) {
      return { name, start, end: start + 1 + m[2].length };
    }
  }
  return undefined;
}

/** The message with the token replaced by `body`; the text around it stays as context. */
export function spliceSlashToken(text: string, tok: SlashToken, body: string): string {
  return `${text.slice(0, tok.start)}${body}${text.slice(tok.end)}`.trim();
}
