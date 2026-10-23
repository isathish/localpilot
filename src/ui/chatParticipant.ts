import * as vscode from 'vscode';
import { getConfig } from '../config';
import { ChatController } from './chatController';

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
      const mode = request.command === 'ask' ? 'ask' : request.command === 'plan' ? 'plan' : 'agent';
      const s = controller.store.create(getConfig().defaultModel, mode);
      s.title = `[chat] ${request.prompt.slice(0, 50)}`;
      sessionId = s.id;
      threadToSession.set(key, sessionId);
    }
    const session = controller.store.get(sessionId)!;
    if (request.command && ['agent', 'ask', 'plan'].includes(request.command)) {
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
            const p = e.payload as { agent: string; prompt: string };
            stream.progress(`Subagent ${p.agent}: ${p.prompt.slice(0, 60)}…`);
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
