import * as vscode from 'vscode';
import { formatBoard, TeamBoard, whoAmI } from '../agent/teamBoard';
import { Tool, ToolContext } from '../types';

/** The identity a chat works under on the board; `localpilot work` claims tasks under the same one for its chats. */
export const boardOwner = (sessionId: string) => whoAmI(`session ${sessionId.slice(-8)}`);

const rootOf = (ctx: ToolContext) => ctx.workspaceRoot ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

export const teamBoardTool: Tool = {
  definition: {
    name: 'team_board',
    description:
      "The team's shared task board in this repository (.localpilot/board), used by people and by other agents working at the same time. " +
      '"list" shows every task with its state and owner; "show" one task with its brief and notes. "add" puts new work on it (title, a self-contained brief, priority 1 = first, depends_on ids). ' +
      '"claim" takes a task (or the next free one) so nobody else works on it; "note" leaves a progress or handoff note on any task; "complete" (with a summary of what changed and how it was verified), "fail" (with why) or "release" (back to open, with a note on what is left) end your claim. ' +
      'Split large work into board tasks that others can take in parallel; never work on a task someone else has claimed.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'show', 'add', 'claim', 'note', 'complete', 'fail', 'release'] },
        id: { type: 'string', description: 'Task id (show, claim, note, complete, fail, release)' },
        title: { type: 'string', description: 'add: short title' },
        brief: { type: 'string', description: 'add: what to do, the files involved, how to verify — enough for someone with no other context' },
        priority: { type: 'integer', description: 'add: 1 (first) to 9, default 5' },
        depends_on: { type: 'array', items: { type: 'string' }, description: 'add: ids that must be done first' },
        text: { type: 'string', description: 'note/complete/fail/release: the note, summary or reason' },
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
    switch (String(args.action ?? 'list')) {
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
        const r = await board.update(id, me, a === 'note' ? { note: text } : { note: a === 'complete' ? 'completed' : a === 'fail' ? `failed: ${text}` : `released: ${text}`, status: a === 'complete' ? 'done' : a === 'fail' ? 'failed' : 'open', result: a === 'release' ? undefined : text });
        return r.error ? { content: r.error, isError: true } : { content: `${a === 'note' ? 'Noted on' : a === 'complete' ? 'Completed' : a === 'fail' ? 'Marked failed:' : 'Released'} "${id}".` };
      }
    }
    return { content: `Unknown action "${String(args.action)}".`, isError: true };
  },
};
