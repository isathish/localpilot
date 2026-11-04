import type { ChangeTracker } from '../agent/changeTracker';
import { CheckpointService, gitCheckpoint, relativeIn, RestoreType } from '../agent/checkpoints';
import { userText } from '../agent/clarify';
import type { SessionStore } from '../sessions/sessionStore';
import type { Session } from '../types';
import type { Style } from './providers';

/** A user turn `/undo` can go back to: `n` is its number in the list, `index` its position in the chat. */
export interface UndoTurn {
  n: number;
  index: number;
  /** Change-tracker / checkpoint key of the turn; absent on turns saved before the CLI recorded one. */
  key?: number;
  prompt: string;
  /** Files a files-only restore would put back (unknown until counted). */
  files?: number;
}

/** Turns listed by the picker (the newest ones; the git diff per turn keeps the list short). */
export const MAX_UNDO_TURNS = 20;
const PROMPT_CHARS = 60;

/** A turn key above every key the chat has used, so restores (which revert a turn and all later ones) stay ordered across compaction and resume. */
export function nextTurnKey(session: Session, last = 0, now = Date.now()): number {
  let max = last;
  for (const m of session.messages) {
    const k = m.meta?.checkpoint;
    if (typeof k === 'number' && k > max) {
      max = k;
    }
  }
  return Math.max(now, max + 1);
}

/** The prompt of a user message as typed: `display` when set, else the text without inlined context blocks. */
function promptOf(content: string, display?: string): string {
  return (display ?? userText(content)).replace(/\s+/g, ' ').trim();
}

/** The user turns of a chat, oldest first (compaction summaries and steering lines are not turns). */
export function undoTurns(session: Session): UndoTurn[] {
  const out: UndoTurn[] = [];
  session.messages.forEach((m, index) => {
    if (m.role !== 'user' || m.meta?.summary || m.meta?.hidden || m.meta?.steer) {
      return;
    }
    out.push({ n: out.length + 1, index, key: m.meta?.checkpoint, prompt: promptOf(m.content, m.meta?.display) });
  });
  return out;
}

/** One line of the picker: number, the first 60 characters of the prompt, files changed since. */
export function formatUndoRow(t: UndoTurn, st: Style, width = String(t.n).length): string {
  const p = t.prompt.length > PROMPT_CHARS ? `${t.prompt.slice(0, PROMPT_CHARS - 1)}…` : t.prompt || '(images only)';
  const files = t.key === undefined ? st.dim('no checkpoint') : t.files === undefined ? '' : t.files ? st.yellow(`${t.files} file${t.files === 1 ? '' : 's'} changed since`) : st.dim('no file changes since');
  return `  ${st.amber(String(t.n).padStart(width))}. ${p.padEnd(PROMPT_CHARS)}  ${files}`.trimEnd();
}

/** `f`/`files`, `c`/`chat`, `b`/`both` (Enter = both); undefined for anything else. */
export function parseRestoreType(s: string | undefined): RestoreType | undefined {
  const a = (s ?? '').trim().toLowerCase();
  if (!a || a === 'b' || a === 'both') {
    return 'both';
  }
  return a === 'f' || a === 'files' || a === 'file' ? 'workspace' : a === 'c' || a === 'chat' ? 'task' : undefined;
}

/** "3", "3 f", "3b", "#3 chat": a turn number and an optional restore type; undefined when it is not one. */
export function parseUndoChoice(s: string, max: number): { n: number; type?: RestoreType } | undefined {
  const m = /^#?(\d+)\s*([a-z]*)$/i.exec(s.trim());
  const n = m ? Number(m[1]) : NaN;
  if (!m || n < 1 || n > max) {
    return undefined;
  }
  if (!m[2]) {
    return { n };
  }
  const type = parseRestoreType(m[2]);
  return type ? { n, type } : undefined;
}

export interface UndoContext {
  session: Session;
  store: Pick<SessionStore, 'historyBefore' | 'save'>;
  tracker: Pick<ChangeTracker, 'restoreTurn' | 'dropTurnsFrom' | 'turnOriginals' | 'settle'>;
  checkpoints?: Pick<CheckpointService, 'changedFiles' | 'restoreWorkspace' | 'dropFrom'>;
  ask: (q: string) => Promise<string | undefined>;
  style: Style;
  out?: NodeJS.WritableStream;
  /** Puts a rewound prompt back on the input line. */
  prefill?: (text: string) => void;
}

/** Counts the files a files-only restore of each turn would put back. */
async function countFiles(turns: UndoTurn[], ctx: UndoContext): Promise<void> {
  for (const t of turns) {
    if (t.key === undefined) {
      continue;
    }
    const entry = gitCheckpoint(ctx.session.checkpoints, t.key);
    const snaps = ctx.tracker.turnOriginals(ctx.session.id, t.key);
    if (entry && ctx.checkpoints) {
      const git = await ctx.checkpoints.changedFiles(entry).catch(() => undefined);
      if (git) {
        // The git checkpoint covers its repository; edits outside it come back from the snapshots.
        t.files = git.length + [...snaps.keys()].filter((p) => relativeIn(entry.root!, p) === undefined).length;
        continue;
      }
    }
    t.files = snaps.size;
  }
}

/**
 * Restores the chat (`task`), the files (`workspace`) or both to how they were before turn `t`, like Restore
 * checkpoint in VS Code: files come back from the git checkpoint (shell command changes included) or the snapshots.
 */
export async function undoTo(t: UndoTurn, type: RestoreType, ctx: UndoContext): Promise<{ ok: boolean; message: string }> {
  const { session: s, tracker } = ctx;
  const n = (k: number) => `${k} file${k === 1 ? '' : 's'}`;
  let restore = { restored: 0, failed: 0 };
  let stash = '';
  const files = type !== 'task';
  if (files && t.key === undefined) {
    return { ok: false, message: 'no checkpoint was recorded for that turn — use c to rewind only the chat' };
  }
  if (files && s.worktree) {
    return { ok: false, message: 'this session works in an isolated worktree — /discard drops its changes' };
  }
  if (files && t.key !== undefined) {
    const entry = gitCheckpoint(s.checkpoints, t.key);
    if (entry && ctx.checkpoints) {
      const r = await ctx.checkpoints.restoreWorkspace(entry);
      if (!r.ok) {
        return { ok: false, message: `could not restore the checkpoint: ${r.error}${r.safetyStash ? ' (your state before the restore is in git stash "localpilot pre-restore")' : ''}` };
      }
      const outside = await tracker.restoreTurn(s.id, t.key, (p) => relativeIn(entry.root!, p) === undefined);
      restore = { restored: r.files + outside.restored, failed: outside.failed };
      stash = r.safetyStash ? ' (previous state in git stash "localpilot pre-restore")' : '';
      await tracker.settle(s.id);
    } else {
      restore = await tracker.restoreTurn(s.id, t.key);
    }
  }
  if (type !== 'workspace') {
    const target = s.messages[t.index];
    s.messages = await ctx.store.historyBefore(s, t.index);
    s.contextTokens = 0;
    if (t.key !== undefined && !restore.failed) {
      tracker.dropTurnsFrom(s.id, t.key);
      await ctx.checkpoints?.dropFrom(s, t.key).catch(() => undefined);
    }
    ctx.store.save(s);
    if (target) {
      ctx.prefill?.(promptOf(target.content, target.meta?.display));
    }
  }
  const chat = type === 'workspace' ? '' : `rewound the chat to before turn ${t.n}`;
  const what = files ? (restore.failed ? `reverted ${n(restore.restored)}; ${restore.failed} could not be restored` : restore.restored ? `reverted ${n(restore.restored)}${stash}` : 'no file changes to revert') : 'files kept';
  return { ok: !restore.failed, message: [chat, what].filter(Boolean).join(' — ') };
}

/**
 * `/undo` with no `/undo all`: lists the earlier turns and restores the one picked. `arg` may name the turn and
 * type directly ("3 f"); otherwise the number and then f(iles), c(hat) or b(oth) are asked for.
 */
export async function undoPicker(arg: string, ctx: UndoContext): Promise<void> {
  const st = ctx.style;
  const out = ctx.out ?? process.stdout;
  const say = (x: string) => out.write(`${x}\n`);
  const all = undoTurns(ctx.session);
  if (!all.length) {
    say(st.dim('nothing to undo — no turns in this session yet'));
    return;
  }
  let choice = arg ? parseUndoChoice(arg, all.length) : undefined;
  if (arg && !choice) {
    say(st.red(`no turn "${arg}" — /undo lists them (1-${all.length}), /undo all reverts every pending change`));
    return;
  }
  if (!choice) {
    const shown = all.slice(-MAX_UNDO_TURNS);
    await countFiles(shown, ctx);
    const w = String(all.length).length;
    say(`${all.length > shown.length ? `${st.dim(`… ${all.length - shown.length} earlier turns`)}\n` : ''}${shown.map((t) => formatUndoRow(t, st, w)).join('\n')}`);
    const a = (await ctx.ask(`${st.amber('?')} Undo back to which turn? ${st.dim('(number, Enter to cancel)')} `))?.trim();
    if (!a) {
      return;
    }
    choice = parseUndoChoice(a, all.length);
    if (!choice) {
      say(st.red(`no turn "${a}"`));
      return;
    }
  }
  let type = choice.type;
  if (!type) {
    const a = await ctx.ask(`${st.amber('?')} Restore ${st.bold('f')}iles, ${st.bold('c')}hat or ${st.bold('b')}oth? ${st.dim('(Enter = both)')} `);
    if (a === undefined) {
      return;
    }
    type = parseRestoreType(a);
    if (!type) {
      say(st.red(`"${a.trim()}" is not f, c or b`));
      return;
    }
  }
  const r = await undoTo(all[choice.n - 1], type, ctx);
  say(r.ok ? st.yellow(r.message) : st.red(r.message));
}
