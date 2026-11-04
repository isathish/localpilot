import * as vscode from 'vscode';
import { getConfig } from '../config';
import { effectiveContextWindow } from '../context/contextManager';
import { estimateTokens } from '../context/tokenizer';
import { ProviderRegistry } from '../providers/registry';
import { ChatMessage, ModelInfo, ToolDefinition } from '../types';

/**
 * Exposes every discovered model (local, and cloud ones labelled as such) to VS Code's Language Model API, so they show up in the
 * model picker of Copilot Chat / other extensions ("bring your own model").
 */
export class LocalModelChatProvider implements vscode.LanguageModelChatProvider, vscode.Disposable {
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeLanguageModelChatInformation = this._onDidChange.event;
  private readonly sub: vscode.Disposable;

  constructor(private readonly providers: ProviderRegistry, private readonly log: vscode.LogOutputChannel) {
    this.sub = vscode.Disposable.from(
      providers.onDidChange(() => this._onDidChange.fire()),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('localpilot.contextWindow') || e.affectsConfiguration('localpilot.maxOutputTokens')) {
          this._onDidChange.fire();
        }
      })
    );
  }

  dispose(): void {
    this.sub.dispose();
    this._onDidChange.dispose();
  }

  async provideLanguageModelChatInformation(_options: { silent: boolean }, token: vscode.CancellationToken): Promise<vscode.LanguageModelChatInformation[]> {
    const models = await this.providers.listModels().catch(() => [] as ModelInfo[]);
    if (token.isCancellationRequested) {
      return [];
    }
    // Models LocalPilot itself takes from VS Code (`vscode-lm`) are not offered back to it.
    return models.filter((m) => this.providers.get(m.providerId)?.type !== 'vscode-lm').map((m) => {
      const { win, out } = tokenBudget(m);
      return {
        id: m.id,
        name: `${m.name} (${m.providerId}${m.remote ? ', cloud' : ''})`,
        family: m.family ?? m.providerId,
        version: '1.0.0',
        maxInputTokens: Math.max(1024, win - out),
        maxOutputTokens: out,
        // Other extensions see which models send prompts off the machine (and bill the user's key).
        tooltip: m.remote ? `Cloud model from ${m.providerId}: prompts are sent to that provider and billed to your key` : `Local model served by ${m.providerId}`,
        detail: m.remote ? `${m.providerId} · cloud` : m.providerId,
        capabilities: { imageInput: m.supportsVision, toolCalling: m.supportsTools },
      };
    });
  }

  async provideLanguageModelChatResponse(
    model: vscode.LanguageModelChatInformation,
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    options: vscode.ProvideLanguageModelChatResponseOptions,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken
  ): Promise<void> {
    const { provider, model: info } = await this.providers.resolve(model.id);
    const abort = new AbortController();
    const sub = token.onCancellationRequested(() => abort.abort());
    const tools: ToolDefinition[] | undefined = options.tools?.map((t) => ({
      name: t.name,
      description: t.description,
      parameters: (t.inputSchema as ToolDefinition['parameters']) ?? { type: 'object', properties: {} },
    }));
    const { out } = tokenBudget(info);
    const requested = options.modelOptions?.max_tokens as number | undefined;
    try {
      const stream = provider.chat({
        model: info.modelId,
        messages: messages.flatMap(convertMessage),
        tools: info.supportsTools ? tools : undefined,
        // Same window (num_ctx) as LocalPilot's own requests, so a model loaded for chat is not reloaded for this one.
        contextWindow: effectiveContextWindow(info, getConfig().contextWindow),
        keepAlive: getConfig().keepAlive || undefined,
        temperature: options.modelOptions?.temperature as number | undefined,
        maxTokens: Math.min(requested ?? out, out),
        signal: abort.signal,
      });
      for await (const ev of stream) {
        if (ev.type === 'text') {
          progress.report(new vscode.LanguageModelTextPart(ev.text));
        } else if (ev.type === 'tool_call') {
          let args: object = {};
          try {
            args = JSON.parse(ev.call.arguments);
          } catch {
            args = { input: ev.call.arguments };
          }
          progress.report(new vscode.LanguageModelToolCallPart(ev.call.id, ev.call.name, args));
        }
      }
    } catch (e) {
      this.log.error(`LM provider error: ${String(e)}`);
      throw e;
    } finally {
      sub.dispose();
    }
  }

  async provideTokenCount(_model: vscode.LanguageModelChatInformation, text: string | vscode.LanguageModelChatRequestMessage): Promise<number> {
    if (typeof text === 'string') {
      return estimateTokens(text);
    }
    return text.content.reduce<number>((n, p) => n + partTokens(p), 4);
  }
}

/** The window the model really runs with (num_ctx for local models) and the share of it reserved for output. */
function tokenBudget(m: ModelInfo): { win: number; out: number } {
  const win = m.remote ? m.contextWindow : effectiveContextWindow(m, getConfig().contextWindow);
  return { win, out: Math.max(1, Math.min(m.maxOutputTokens, Math.floor(win / 4))) };
}

function partTokens(p: unknown): number {
  if (p instanceof vscode.LanguageModelTextPart) {
    return estimateTokens(p.value);
  }
  if (p instanceof vscode.LanguageModelToolCallPart) {
    return estimateTokens(p.name + JSON.stringify(p.input ?? {}));
  }
  if (p instanceof vscode.LanguageModelToolResultPart) {
    return p.content.reduce<number>((n, c) => n + partTokens(c), 4);
  }
  if (isDataPart(p)) {
    return p.mimeType.startsWith('image/') ? 256 : estimateTokens(Buffer.from(p.data).toString('utf8'));
  }
  return 32;
}

/** Converts one LM API message; tool results become one 'tool' message each, followed by any remaining user text/images. */
export function convertMessage(m: vscode.LanguageModelChatRequestMessage): ChatMessage[] {
  // System (3) is not in the stable typings, so anything that is neither User nor Assistant is treated as system.
  const role = m.role === vscode.LanguageModelChatMessageRole.User ? 'user' : m.role === vscode.LanguageModelChatMessageRole.Assistant ? 'assistant' : 'system';
  let text = '';
  const toolCalls: ChatMessage['toolCalls'] = [];
  const images: string[] = [];
  const toolResults: ChatMessage[] = [];
  for (const part of m.content) {
    if (part instanceof vscode.LanguageModelTextPart) {
      text += part.value;
    } else if (isDataPart(part)) {
      // LanguageModelDataPart (VS Code ≥1.105) — images go to vision models as base64; internal markers (cache_control…) are skipped.
      if (part.mimeType.startsWith('image/')) {
        images.push(Buffer.from(part.data).toString('base64'));
      } else if (isTextMime(part.mimeType)) {
        text += `\n[attachment ${part.mimeType}: ${Buffer.from(part.data).toString('utf8').slice(0, 20_000)}]`;
      }
    } else if (part instanceof vscode.LanguageModelToolCallPart) {
      toolCalls.push({ id: part.callId, name: part.name, arguments: JSON.stringify(part.input ?? {}) });
    } else if (part instanceof vscode.LanguageModelToolResultPart) {
      toolResults.push({ role: 'tool', content: toolResultText(part.content), toolCallId: part.callId });
    }
  }
  const message: ChatMessage = { role, content: text, toolCalls: toolCalls.length ? toolCalls : undefined, images: images.length ? images : undefined };
  if (!toolResults.length) {
    return [message];
  }
  return text || images.length ? [...toolResults, { ...message, role: 'user', toolCalls: undefined }] : toolResults;
}

function toolResultText(content: readonly unknown[]): string {
  return content
    .map((c) => {
      if (c instanceof vscode.LanguageModelTextPart) {
        return c.value;
      }
      if (c instanceof vscode.LanguageModelPromptTsxPart) {
        return typeof c.value === 'string' ? c.value : JSON.stringify(c.value);
      }
      if (isDataPart(c)) {
        return isTextMime(c.mimeType) ? Buffer.from(c.data).toString('utf8') : c.mimeType.startsWith('image/') ? '[image omitted]' : `[${c.mimeType}]`;
      }
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

function isTextMime(mime: string): boolean {
  return mime.startsWith('text/') || mime.includes('json');
}

function isDataPart(part: unknown): part is { mimeType: string; data: Uint8Array } {
  const p = part as { mimeType?: unknown; data?: unknown };
  return typeof p?.mimeType === 'string' && p.data instanceof Uint8Array;
}
