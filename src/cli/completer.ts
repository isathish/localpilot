import * as fs from 'fs';
import * as path from 'path';
import { foldersOf, MentionEntry, rankMentions } from '../context/mentionSearch';

/** Folders never walked for `@path` completion (the same idea as the chat's file index exclude). */
const SKIP_DIRS = new Set(['.git', 'node_modules', '.hg', '.svn', 'dist', 'out', 'build', '.next', '.nuxt', 'target', 'coverage', '__pycache__', '.venv', 'venv', '.tox', '.mypy_cache', '.pytest_cache', '.gradle', '.idea', '.cache', 'vendor', 'Pods', '.terraform', '.localpilot-worktrees']);
const MAX_FILES = 5000;
const INDEX_TTL_MS = 30_000;

/** Workspace files (relative, POSIX), breadth-first so a huge tree still yields its top levels; at most `max`. */
export function listWorkspaceFiles(root: string, max = MAX_FILES): string[] {
  const out: string[] = [];
  const queue: string[] = [''];
  while (queue.length && out.length < max) {
    const rel = queue.shift()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) {
          queue.push(r);
        }
      } else if (e.isFile() && out.length < max) {
        out.push(r);
      }
    }
  }
  return out;
}

/** The token being completed at the end of the line: `/name` at the start, or an `@path` anywhere. */
export function completionToken(line: string): { kind: 'command' | 'path'; token: string } | undefined {
  const cmd = /^\/[\w:.-]*$/.exec(line);
  if (cmd) {
    return { kind: 'command', token: cmd[0] };
  }
  const at = /(?:^|\s)(@[^\s@]*)$/.exec(line);
  return at ? { kind: 'path', token: at[1] } : undefined;
}

/** Names that complete `prefix` (case-insensitive), in their given order, without duplicates. */
export function completeCommand(prefix: string, names: readonly string[]): string[] {
  const p = prefix.toLowerCase();
  return [...new Set(names)].filter((n) => n.toLowerCase().startsWith(p));
}

/**
 * The REPL's Tab completion: `/` commands (built-ins, custom commands, skills, MCP prompts) and `@paths` in the
 * workspace, ranked by the same fuzzy match as the chat's @ menu. `skip()` true makes a Tab do nothing (Shift+Tab).
 */
export function createCompleter(opts: { commands: () => string[]; root: () => string; skip?: () => boolean }): (line: string) => [string[], string] {
  let index: { root: string; at: number; entries: MentionEntry[] } | undefined;
  const entries = (): MentionEntry[] => {
    const root = opts.root();
    if (!index || index.root !== root || Date.now() - index.at > INDEX_TTL_MS) {
      const files = listWorkspaceFiles(root).map((ref): MentionEntry => ({ ref, display: ref, kind: 'file' }));
      index = { root, at: Date.now(), entries: [...files, ...foldersOf(files)] };
    }
    return index.entries;
  };
  return (line: string) => {
    const t = opts.skip?.() ? undefined : completionToken(line);
    if (!t) {
      return [[], line];
    }
    if (t.kind === 'command') {
      return [completeCommand(t.token, opts.commands()), t.token];
    }
    const q = t.token.slice(1);
    // A path typed out (`@./src/`, `@../x`) completes against the folder it names; anything else is a fuzzy search.
    if (/^(\.{1,2}\/|\/|~\/)/.test(q)) {
      return [listDir(opts.root(), q).map((p) => `@${p}`), t.token];
    }
    const hits = rankMentions(q, entries(), { limit: 20 }).map((h) => `@${h.ref}`);
    return [hits, t.token];
  };
}

/** Entries of the folder a typed path points into, as the path plus the entry name (folders end in `/`). */
function listDir(root: string, typed: string): string[] {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? '';
  const abs = typed.startsWith('~/') ? path.join(home, typed.slice(2)) : path.resolve(root, typed);
  const dir = typed.endsWith('/') ? abs : path.dirname(abs);
  const base = typed.endsWith('/') ? '' : path.basename(abs);
  const prefix = typed.endsWith('/') ? typed : typed.slice(0, typed.length - base.length);
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.name.startsWith(base) && (base.startsWith('.') || !e.name.startsWith('.')))
      .map((e) => `${prefix}${e.name}${e.isDirectory() ? '/' : ''}`)
      .sort()
      .slice(0, 50);
  } catch {
    return [];
  }
}
