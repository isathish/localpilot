import * as path from 'path';
import * as vscode from 'vscode';
import { getConfig } from '../config';
import { ChatController } from './chatController';
import { ALL_MODES, Session } from '../types';

const REVIEW_CMD = 'localpilot.chat.reviewChanges';
const UNDO_CMD = 'localpilot.chat.undoChanges';

/**
 * Registers `@localpilot` in the built-in VS Code Chat view so users can reach the local agent from the
 * standard chat UI as well. Each VS Code chat thread runs one LocalPilot session, whose id is carried in the response
 * metadata and read back from the thread history on the next turn.
 */
export function registerChatParticipant(ctx: vscode.ExtensionContext, controller: ChatController): void {
  const handler: vscode.ChatRequestHandler = async (request, chatCtx, stream, token) => {
    const prev = [...chatCtx.history].reverse().find((h): h is vscode.ChatResponseTurn => h instanceof vscode.ChatResponseTurn && typeof (h.result.metadata as { sessionId?: unknown } | undefined)?.sessionId === 'string');
    let sessionId = (prev?.result.metadata as { sessionId?: string } | undefined)?.sessionId;
    if (!sessionId || !controller.store.get(sessionId)) {
      const mode = (ALL_MODES as readonly string[]).includes(request.command ?? '') ? (request.command as Session['mode']) : 'agent';
      const s = controller.store.create(getConfig().defaultModel, mode);
      s.title = `[chat] ${request.prompt.slice(0, 50)}`;
      sessionId = s.id;
    }
    const session = controller.store.get(sessionId)!;
    if (request.command && (ALL_MODES as readonly string[]).includes(request.command)) {
      session.mode = request.command as typeof session.mode;
    }

    const attachments: string[] = [];
    let droppedBinary = false;
    for (const ref of request.references) {
      const v = ref.value;
      if (isBinaryReference(v)) {
        droppedBinary = true;
      } else if (v instanceof vscode.Uri) {
        attachments.push(vscode.workspace.asRelativePath(v));
      } else if (v instanceof vscode.Location) {
        attachments.push(`${vscode.workspace.asRelativePath(v.uri)}#L${v.range.start.line + 1}-L${v.range.end.line + 1}`);
      }
    }
    if (droppedBinary) {
      stream.progress('Images are not passed through @localpilot yet; attach them in the LocalPilot chat');
    }

    /** Answer text streamed so far (to tell whether the self-healing footer still has to be shown). */
    let streamed = '';
    const sink = {
      // Approvals and ask_user cannot be shown in the VS Code chat stream; they use native dialogs instead.
      handlesPrompts: (sid: string) => sid === sessionId,
      post: (m: import('./chatController').ToWebview) => {
        if (m.type !== 'event' || m.event.sessionId !== sessionId) {
          return;
        }
        const e = m.event;
        // Worker events arrive under this session wrapped as { childId, agent, inner, data }; only tool starts are surfaced.
        const sub = e.payload as { childId?: string; agent?: string; data?: { name?: string; args?: Record<string, unknown> } } | undefined;
        if (sub && typeof sub === 'object' && 'childId' in sub) {
          if (e.type === 'tool_start' && sub.data?.name) {
            stream.progress(`${sub.agent ?? 'subagent'}: ${sub.data.name} ${summarise(sub.data.args)}`);
          }
          return;
        }
        switch (e.type) {
          case 'assistant_delta':
            streamed += String(e.payload);
            stream.markdown(String(e.payload));
            break;
          case 'turn_end': {
            // The self-healing footer (Verified / Not verified / Incomplete) is appended to the answer, not streamed.
            const report = (e.payload as { recovery?: { report?: string } } | undefined)?.recovery?.report;
            if (report && !streamed.includes(report)) {
              stream.markdown(`\n\n${report}`);
            }
            break;
          }
          case 'tool_start': {
            const p = e.payload as { name?: string; args?: unknown } | undefined;
            if (p?.name) {
              stream.progress(`${p.name} ${summarise(p.args)}`);
            }
            break;
          }
          case 'tool_end': {
            const inner = e.payload as { name?: string; isError?: boolean; data?: { path?: string } } | undefined;
            if (inner?.data?.path) {
              stream.reference(vscode.Uri.file(inner.data.path));
            }
            break;
          }
          case 'approval_request':
            stream.progress('Waiting for your approval…');
            break;
          case 'status':
            if (typeof e.payload === 'string') {
              stream.progress(e.payload);
            }
            break;
          case 'subagent_start': {
            const p = e.payload as { agent: string; prompt: string; label?: string };
            stream.progress(`Subagent ${p.agent}: ${p.label || `${p.prompt.slice(0, 60)}…`}`);
            break;
          }
          case 'nudge': {
            const p = e.payload as { reason?: string };
            stream.progress(p.reason === 'stale' ? 'The workers already finished — asking the model for their results…' : p.reason === 'malformed' ? 'The tool call did not parse — asking the model to resend it…' : 'The reply claimed an action no tool performed — asking the model to act…');
            break;
          }
          case 'recovery': {
            const p = e.payload as { phase?: string; title?: string; attempt?: number; max?: number; decision?: string } | undefined;
            if (p?.phase) {
              stream.progress(`Self-healing: ${p.phase.replace(/_/g, ' ')}${p.attempt && p.max ? ` · attempt ${p.attempt}/${p.max}` : ''}${p.title ? ` · ${p.title}` : ''}${p.decision ? ` · ${p.decision}` : ''}`);
            }
            break;
          }
          case 'clarify': {
            const p = e.payload as { reasons?: string[] };
            stream.progress(`Request looks ambiguous (${(p.reasons ?? []).join('; ')}) — interpreting it from the editor, errors and git changes…`);
            break;
          }
          case 'skill_suggestions': {
            const p = e.payload as { skills?: { name: string }[]; preloaded?: { name: string }[]; create?: { slug: string; count: number } };
            if (p.preloaded?.length) {
              stream.progress(`Using skill${p.preloaded.length === 1 ? '' : 's'}: ${p.preloaded.map((s) => s.name).join(', ')}`);
            }
            if (p.skills?.length) {
              stream.progress(`Skills that may apply: ${p.skills.map((s) => s.name).join(', ')}`);
            }
            if (p.create) {
              stream.button({ command: 'localpilot.createSkill', arguments: [p.create], title: `Create "${p.create.slug}" skill (${p.create.count}× requested)` });
            }
            break;
          }
          case 'error': {
            const p = e.payload as { message?: string } | string;
            const md = new vscode.MarkdownString(`\n\n> $(warning) ${typeof p === 'object' && p ? String(p.message ?? '') : String(p)}`);
            md.supportThemeIcons = true;
            stream.markdown(md);
            break;
          }
        }
      },
    };
    const detach = controller.attach(sink);
    const cancel = token.onCancellationRequested(() => controller.stop(sessionId!));
    try {
      await controller.send(sessionId, request.prompt, attachments);
    } catch (err) {
      const md = new vscode.MarkdownString(`\n\n> $(warning) ${err instanceof Error ? err.message : String(err)}`);
      md.supportThemeIcons = true;
      stream.markdown(md);
    } finally {
      cancel.dispose();
      detach.dispose();
    }
    const changed = controller.tracker.forSession(sessionId);
    if (changed.length) {
      const n = changed.length;
      stream.button(n > 1 ? { command: REVIEW_CMD, arguments: [sessionId], title: `Review ${n} changed files` } : { command: 'localpilot.showDiff', arguments: [sessionId, changed[0].fsPath], title: `Review ${path.basename(changed[0].fsPath)}` });
      stream.button({ command: UNDO_CMD, arguments: [sessionId], title: `Undo ${n} file change${n > 1 ? 's' : ''}` });
    }
    stream.button({ command: 'localpilot.openSession', arguments: [sessionId], title: 'Open in LocalPilot' });
    return { metadata: { sessionId, mode: controller.store.get(sessionId)?.mode ?? session.mode } };
  };

  const participant = vscode.chat.createChatParticipant('localpilot.agent', handler);
  participant.iconPath = vscode.Uri.joinPath(ctx.extensionUri, 'media', 'icon.svg');
  participant.followupProvider = {
    provideFollowups: (result) => {
      const mode = (result.metadata as { mode?: string } | undefined)?.mode ?? 'agent';
      if (mode === 'plan') {
        return [{ prompt: 'Build this plan', command: 'agent', label: 'Build it' }];
      }
      if (mode === 'agent' || mode === 'debug' || mode === 'multitask') {
        return [
          { prompt: 'Run the tests and fix any failures', label: 'Test & fix' },
          { prompt: 'Review the changes you just made for bugs', label: 'Review changes' },
        ];
      }
      return [];
    },
  };
  // Internal (not contributed, so hidden from the palette): the buttons outlive their turn in the chat history, so
  // review opens every tracked file and undo re-counts and confirms before reverting the whole chat's edits.
  ctx.subscriptions.push(
    participant,
    vscode.commands.registerCommand(REVIEW_CMD, (id: unknown) => typeof id === 'string' && controller.handle({ type: 'viewChanges', sessionId: id, scope: 'session' })),
    vscode.commands.registerCommand(UNDO_CMD, async (id: unknown) => {
      if (typeof id !== 'string') {
        return;
      }
      const count = controller.tracker.forSession(id).length;
      if (!count) {
        void vscode.window.showInformationMessage('LocalPilot: nothing left to undo');
        return;
      }
      const ok = await vscode.window.showWarningMessage(`Revert ${count === 1 ? 'the file' : `${count} files`} changed in this chat?`, { modal: true }, 'Revert');
      if (ok === 'Revert') {
        const reverted = await controller.tracker.undo(id);
        vscode.window.setStatusBarMessage(`LocalPilot: reverted ${reverted} file${reverted === 1 ? '' : 's'}`, 2500);
      }
    }),
  );
}

/** `vscode.ChatReferenceBinaryData` (pasted images) is not in every typings version, so it is looked up at runtime. */
function isBinaryReference(v: unknown): boolean {
  const ctor = (vscode as unknown as { ChatReferenceBinaryData?: abstract new (...args: never[]) => unknown }).ChatReferenceBinaryData;
  if (ctor && v instanceof ctor) {
    return true;
  }
  return !!v && typeof v === 'object' && typeof (v as { mimeType?: unknown }).mimeType === 'string' && typeof (v as { data?: unknown }).data === 'function';
}

function summarise(args: unknown): string {
  if (!args || typeof args !== 'object') {
    return '';
  }
  const a = args as Record<string, unknown>;
  const v = a.path ?? a.query ?? a.command ?? a.pattern ?? a.url ?? '';
  return typeof v === 'string' ? v.slice(0, 60) : '';
}
