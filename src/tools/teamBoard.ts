import * as vscode from 'vscode';
import { BoardMailbox, formatBoard, formatMail, LEASE_MS, TeamBoard, whoAmI } from '../agent/teamBoard';
import { RunControl } from '../agent/runControl';
import { onAbort } from '../agent/resilience';
import { Tool, ToolContext } from '../types';

/** The identity a chat works under on the board; `localpilot work` claims tasks under the same one for its chats. */
export const boardOwner = (sessionId: string) => whoAmI(`session ${sessionId.slice(-8)}`);

// The board is shared: an isolated run uses the real checkout's board, not its worktree's copy.
const rootOf = (ctx: ToolContext) => ctx.mainRoot ?? ctx.workspaceRoot ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

/** Lease renewals of claims held by running agents, keyed by `root|task|owner`. */
const renewals = new Map<string, () => void>();

function stopRenewing(root: string, id: string, me: string): void {
  renewals.get(`${root}|${id}|${me}`)?.();
}

/** Keeps a claim alive while the agent works on it; stops when the run ends or the claim is gone. */
function keepRenewing(board: TeamBoard, root: string, id: string, me: string, signal: AbortSignal): void {
  const key = `${root}|${id}|${me}`;
  renewals.get(key)?.();
  let off = () => {};
  const stop = () => {
    clearInterval(timer);
    off();
    if (renewals.get(key) === stop) {
      renewals.delete(key);
    }
  };
  const renew = async () => {
    const t = await board.get(id);
    if (t?.status !== 'claimed' || t.owner !== me || (await board.update(id, me, { renew: true })).error) {
      stop();
    }
  };
  const timer = setInterval(() => void renew().catch(stop), LEASE_MS / 3);
  timer.unref?.();
  renewals.set(key, stop);
  off = onAbort(signal, stop);
}

/** How often a running agent's inbox is checked for messages to hand it. */
export const MAIL_POLL_MS = 5_000;

/** Inbox watchers of running agents, keyed by `root|owner`. */
const watchers = new Map<string, () => void>();

/** Ids of the tasks `me` holds (messages to a task id reach its holder). */
async function heldBy(board: TeamBoard, me: string): Promise<string[]> {
  return (await board.list()).filter((t) => t.status === 'claimed' && t.owner === me).map((t) => t.id);
}

/**
 * Once an agent uses the board, messages sent to it (or to its tasks, or to everyone) reach it while it runs: each
 * poll's new ones are handed to the run as a steering message. Stops when the run ends.
 */
export function watchInbox(root: string, me: string, control: RunControl, signal: AbortSignal, pollMs = MAIL_POLL_MS): void {
  const key = `${root}|${me}`;
  if (watchers.has(key) || signal.aborted || control.ended) {
    return;
  }
  const board = new TeamBoard(root);
  const mail = new BoardMailbox(root);
  let busy = false;
  const poll = async () => {
    if (busy) {
      return;
    }
    busy = true;
    try {
      // Peek first: the cursor moves only once the run has taken the messages, so a run that just ended leaves them unread.
      const { messages: msgs, seen } = await mail.peekInbox(me, await heldBy(board, me));
      if (!msgs.length) {
        await mail.markRead(me, seen);
        return;
      }
      if (!control.steer({ role: 'user', content: `Team message${msgs.length === 1 ? '' : 's'} from the shared board (reply with team_board send if needed):\n${formatMail(msgs)}`, meta: { steer: true } })) {
        stop();
        return;
      }
      await mail.markRead(me, seen);
    } finally {
      busy = false;
    }
  };
  const timer = setInterval(() => void poll().catch(() => undefined), pollMs);
  timer.unref?.();
  let off = () => {};
  let offEnd = () => {};
  const stop = () => {
    clearInterval(timer);
    off();
    offEnd();
    if (watchers.get(key) === stop) {
      watchers.delete(key);
    }
  };
  watchers.set(key, stop);
  off = onAbort(signal, stop);
  offEnd = control.onEnd(stop);
}

export const teamBoardTool: Tool = {
  definition: {
    name: 'team_board',
    description:
      "The team's shared task board in this repository (.localpilot/board), used by people and by other agents working at the same time. " +
      '"list" shows every task with its state and owner; "show" one task with its brief and notes. "add" puts new work on it (title, a self-contained brief, priority 1 = first, depends_on ids). ' +
      '"claim" takes a task (or the next free one) so nobody else works on it; "note" leaves a progress or handoff note on any task; "complete" (with a summary of what changed and how it was verified), "fail" (with why) or "release" (back to open, with a note on what is left) end your claim. ' +
      'Split large work into board tasks that others can take in parallel; never work on a task someone else has claimed. ' +
      'Mailbox: "send" a message to one teammate ("to": an owner as shown by list, the last characters of their session, or a task id to reach whoever holds it), "broadcast" to everyone, "inbox" reads yours. While you run, new messages for you also arrive on their own.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'show', 'add', 'claim', 'note', 'complete', 'fail', 'release', 'send', 'broadcast', 'inbox'] },
        to: { type: 'string', description: 'send: owner, session suffix or task id of the recipient' },
        id: { type: 'string', description: 'Task id (show, claim, note, complete, fail, release)' },
        title: { type: 'string', description: 'add: short title' },
        brief: { type: 'string', description: 'add: what to do, the files involved, how to verify — enough for someone with no other context' },
        priority: { type: 'integer', description: 'add: 1 (first) to 9, default 5' },
        depends_on: { type: 'array', items: { type: 'string' }, description: 'add: ids that must be done first' },
        text: { type: 'string', description: 'note/complete/fail/release: the note, summary or reason; send/broadcast: the message' },
      },
      required: ['action'],
    },
  },
  async execute(args, ctx) {
    const root = rootOf(ctx);
    if (!root) {
      return { content: 'No workspace folder open.', isError: true };
    }
    const board = new TeamBoard(root);
    const me = boardOwner(ctx.sessionId);
    const id = typeof args.id === 'string' ? args.id.trim() : '';
    const text = typeof args.text === 'string' ? args.text.trim() : '';
    if (ctx.control) {
      watchInbox(root, me, ctx.control, ctx.signal);
    }
    switch (String(args.action ?? 'list')) {
      case 'send':
      case 'broadcast': {
        const to = args.action === 'broadcast' ? '*' : typeof args.to === 'string' ? args.to.trim() : '';
        if (!to || !text) {
          return { content: args.action === 'send' ? 'send needs "to" (an owner from list, a session suffix or a task id) and "text".' : 'broadcast needs "text".', isError: true };
        }
        const m = await new BoardMailbox(root).send(me, to, text);
        const holder = to !== '*' ? (await board.get(to))?.owner : undefined;
        return { content: to === '*' ? 'Sent to everyone on the board.' : `Sent to ${holder ? `${holder} (holder of "${to}")` : m.to}.` };
      }
      case 'inbox': {
        const msgs = await new BoardMailbox(root).inbox(me, await heldBy(board, me));
        return { content: msgs.length ? `${msgs.length} new message${msgs.length === 1 ? '' : 's'} (you are ${me}):\n${formatMail(msgs)}` : `No new messages for ${me}.` };
      }
      case 'list':
        return { content: formatBoard(await board.list()) };
      case 'show': {
        const t = id ? await board.get(id) : undefined;
        if (!t) {
          return { content: `No task "${id}".`, isError: true };
        }
        return { content: `${t.id}: ${t.title} [${t.status}${t.owner ? `, ${t.owner}` : ''}] priority ${t.priority}${t.dependsOn.length ? `, after ${t.dependsOn.join(', ')}` : ''}\n\n${t.brief}${t.notes.length ? `\n\nNotes:\n${t.notes.map((n) => `- ${n.at.slice(0, 16).replace('T', ' ')} ${n.by}: ${n.text}`).join('\n')}` : ''}${t.result ? `\n\nResult: ${t.result}` : ''}` };
      }
      case 'add': {
        const title = String(args.title ?? '').trim();
        const brief = String(args.brief ?? '').trim();
        if (!title || !brief) {
          return { content: 'add needs a title and a brief.', isError: true };
        }
        const t = await board.add({ title, brief, priority: Number(args.priority) || undefined, dependsOn: Array.isArray(args.depends_on) ? args.depends_on.map(String) : undefined }, me);
        return { content: `Added "${t.id}" to the board (priority ${t.priority}${t.dependsOn.length ? `, after ${t.dependsOn.join(', ')}` : ''}).` };
      }
      case 'claim': {
        const t = await board.claim(me, id || undefined);
        if (t) {
          keepRenewing(board, root, t.id, me, ctx.signal);
        }
        return t ? { content: `Claimed "${t.id}": ${t.title}\n\n${t.brief}${t.notes.length > 1 ? `\n\nEarlier notes:\n${t.notes.slice(0, -1).map((n) => `- ${n.by}: ${n.text}`).join('\n')}` : ''}\n\nWhen finished call team_board complete with id "${t.id}".` } : { content: id ? `"${id}" cannot be claimed: it is taken, finished, or waits for unfinished tasks.` : 'No free task on the board right now.' };
      }
      case 'note':
      case 'complete':
      case 'fail':
      case 'release': {
        if (!id) {
          return { content: 'id is required.', isError: true };
        }
        const a = String(args.action);
        if (a !== 'note' && !text) {
          return { content: `${a} needs text: ${a === 'complete' ? 'what changed and how it was verified' : a === 'fail' ? 'why it cannot be done' : 'what is done and what is left'}.`, isError: true };
        }
        // A note on your own claim also renews its lease (a note on someone else's claim must not).
        const mine = a === 'note' && (await board.get(id).then((t) => t?.status === 'claimed' && t.owner === me).catch(() => false));
        const r = await board.update(id, me, a === 'note' ? { note: text, renew: mine || undefined } : { note: a === 'complete' ? 'completed' : a === 'fail' ? `failed: ${text}` : `released: ${text}`, status: a === 'complete' ? 'done' : a === 'fail' ? 'failed' : 'open', result: a === 'release' ? undefined : text });
        if (!r.error && a !== 'note') {
          stopRenewing(root, id, me);
        }
        return r.error ? { content: r.error, isError: true } : { content: `${a === 'note' ? 'Noted on' : a === 'complete' ? 'Completed' : a === 'fail' ? 'Marked failed:' : 'Released'} "${id}".` };
      }
    }
    return { content: `Unknown action "${String(args.action)}".`, isError: true };
  },
};
