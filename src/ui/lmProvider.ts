import * as vscode from 'vscode';
import { estimateTokens } from '../context/tokenizer';
import { ProviderRegistry } from '../providers/registry';
import { ChatMessage, ModelInfo, ToolDefinition } from '../types';

/**
 * Exposes every discovered local model to VS Code's Language Model API, so they show up in the
 * model picker of Copilot Chat / other extensions ("bring your own model").
 */
export class LocalModelChatProvider implements vscode.LanguageModelChatProvider {
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeLanguageModelChatInformation = this._onDidChange.event;

  constructor(private readonly providers: ProviderRegistry, private readonly log: vscode.LogOutputChannel) {
    providers.onDidChange(() => this._onDidChange.fire());
  }

  async provideLanguageModelChatInformation(_options: { silent: boolean }, token: vscode.CancellationToken): Promise<vscode.LanguageModelChatInformation[]> {
    const models = await this.providers.listModels().catch(() => [] as ModelInfo[]);
    if (token.isCancellationRequested) {
      return [];
    }
    return models.map((m) => ({
      id: m.id,
      name: `${m.name} (${m.providerId})`,
      family: m.family ?? m.providerId,
      version: '1.0.0',
      maxInputTokens: Math.max(1024, m.contextWindow - m.maxOutputTokens),
      maxOutputTokens: m.maxOutputTokens,
      tooltip: `Local model served by ${m.providerId}`,
      detail: m.providerId,
      capabilities: { imageInput: m.supportsVision, toolCalling: m.supportsTools },
    }));
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
    try {
      const stream = provider.chat({
        model: info.modelId,
        messages: messages.map(convertMessage),
        tools: info.supportsTools ? tools : undefined,
        contextWindow: info.contextWindow,
        temperature: (options.modelOptions?.temperature as number | undefined) ?? 0.2,
        maxTokens: (options.modelOptions?.max_tokens as number | undefined) ?? info.maxOutputTokens,
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
    return text.content.reduce<number>((n, p) => n + (p instanceof vscode.LanguageModelTextPart ? estimateTokens(p.value) : 32), 4);
  }
}

function convertMessage(m: vscode.LanguageModelChatRequestMessage): ChatMessage {
  const role = m.role === vscode.LanguageModelChatMessageRole.User ? 'user' : 'assistant';
  let text = '';
  const toolCalls: ChatMessage['toolCalls'] = [];
  const images: string[] = [];
  let toolResult: ChatMessage | undefined;
  for (const part of m.content) {
    if (part instanceof vscode.LanguageModelTextPart) {
      text += part.value;
    } else if (isDataPart(part)) {
      // LanguageModelDataPart (VS Code ≥1.105) — forwarded to vision models as base64 images.
      if (part.mimeType.startsWith('image/')) {
        images.push(Buffer.from(part.data).toString('base64'));
      } else {
        text += `\n[attachment ${part.mimeType}: ${Buffer.from(part.data).toString('utf8').slice(0, 20_000)}]`;
      }
    } else if (part instanceof vscode.LanguageModelToolCallPart) {
      toolCalls.push({ id: part.callId, name: part.name, arguments: JSON.stringify(part.input ?? {}) });
    } else if (part instanceof vscode.LanguageModelToolResultPart) {
      const content = part.content.map((c) => (c instanceof vscode.LanguageModelTextPart ? c.value : JSON.stringify(c))).join('\n');
      toolResult = { role: 'tool', content, toolCallId: part.callId };
    }
  }
  if (toolResult) {
    return toolResult;
  }
  return { role, content: text, toolCalls: toolCalls.length ? toolCalls : undefined, images: images.length ? images : undefined };
}

function isDataPart(part: unknown): part is { mimeType: string; data: Uint8Array } {
  const p = part as { mimeType?: unknown; data?: unknown };
  return typeof p?.mimeType === 'string' && p.data instanceof Uint8Array;
}
