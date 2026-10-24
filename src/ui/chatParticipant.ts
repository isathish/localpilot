import * as vscode from 'vscode';
import { getConfig } from '../config';
import { ChatController } from './chatController';
import { ALL_MODES, Session } from '../types';

/**
 * Registers `@localpilot` in the built-in VS Code Chat view so users can reach the local agent from the
 * standard chat UI as well. Each VS Code chat thread is mapped to a LocalPilot session.
 */
export function registerChatParticipant(ctx: vscode.ExtensionContext, controller: ChatController): void {
  const threadToSession = new Map<string, string>();

  const handler: vscode.ChatRequestHandler = async (request, chatCtx, stream, token) => {
    // Derive a stable key for this VS Code chat thread from the first turn's prompt.
    const first = chatCtx.history.find((h) => h instanceof vscode.ChatRequestTurn) as vscode.ChatRequestTurn | undefined;
    const key = first ? `${first.prompt}|${first.command ?? ''}` : `${request.prompt}|${Date.now()}`;
    let sessionId = threadToSession.get(key);
    if (!sessionId || !controller.store.get(sessionId)) {
      const mode = (ALL_MODES as readonly string[]).includes(request.command ?? '') ? (request.command as Session['mode']) : 'agent';
      const s = controller.store.create(getConfig().defaultModel, mode);
      s.title = `[chat] ${request.prompt.slice(0, 50)}`;
      sessionId = s.id;
      threadToSession.set(key, sessionId);
    }
    const session = controller.store.get(sessionId)!;
    if (request.command && (ALL_MODES as readonly string[]).includes(request.command)) {
      session.mode = request.command as typeof session.mode;
    }

    const attachments: string[] = [];
    for (const ref of request.references) {
      const v = ref.value;
      if (v instanceof vscode.Uri) {
        attachments.push(vscode.workspace.asRelativePath(v));
      } else if (v instanceof vscode.Location) {
        attachments.push(`${vscode.workspace.asRelativePath(v.uri)}#L${v.range.start.line + 1}-L${v.range.end.line + 1}`);
      }
    }

    const sink = {
      post: (m: import('./chatController').ToWebview) => {
        if (m.type !== 'event' || m.event.sessionId !== sessionId) {
          return;
        }
        const e = m.event;
        switch (e.type) {
          case 'assistant_delta':
            stream.markdown(String(e.payload));
            break;
          case 'tool_start': {
            const p = e.payload as { name: string; args: Record<string, unknown> };
            stream.progress(`${p.name} ${summarise(p.args)}`);
            break;
          }
          case 'tool_end': {
            const p = e.payload as { name: string; isError?: boolean; data?: { path?: string } };
            if (p.data?.path) {
              stream.reference(vscode.Uri.file(p.data.path));
            }
            break;
          }
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
            const md = new vscode.MarkdownString(`\n\n> $(warning) ${String(e.payload)}`);
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
    } finally {
      cancel.dispose();
      detach.dispose();
    }
    return { metadata: { sessionId } };
  };

  const participant = vscode.chat.createChatParticipant('localpilot.agent', handler);
  participant.iconPath = vscode.Uri.joinPath(ctx.extensionUri, 'media', 'icon.svg');
  participant.followupProvider = {
    provideFollowups: () => [
      { prompt: 'Run the tests and fix any failures', label: 'Test & fix' },
      { prompt: 'Review the changes you just made for bugs', label: 'Review changes' },
    ],
  };
  ctx.subscriptions.push(participant);
}

function summarise(args: Record<string, unknown>): string {
  const v = args.path ?? args.query ?? args.command ?? args.pattern ?? args.url ?? '';
  return typeof v === 'string' ? v.slice(0, 60) : '';
}
