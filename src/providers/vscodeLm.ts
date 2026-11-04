import * as vscode from 'vscode';
import { ChatRequestOptions, CompletionRequestOptions, LLMProvider, ModelInfo, ProviderConfig, StreamEvent } from '../types';
import { completeViaChat } from './cloud';
import { isOwnVendor, lmIdsChangeGate, lmModelInfo, LmTurn, toLmTurns, VSCODE_LM_BASE_URL } from './vscodeLmMessages';

/** VS Code's Language Model API is there (absent in the CLI, whose shim only lets extensions register). */
export function vscodeLmAvailable(): boolean {
  return typeof (vscode.lm as Partial<typeof vscode.lm> | undefined)?.selectChatModels === 'function';
}

/** Chat models other extensions contribute (Copilot and the like), LocalPilot's own vendor excluded. */
export async function selectLmModels(selector: vscode.LanguageModelChatSelector = {}): Promise<vscode.LanguageModelChat[]> {
  if (!vscodeLmAvailable()) {
    return [];
  }
  return (await vscode.lm.selectChatModels(selector)).filter((m) => !isOwnVendor(m.vendor));
}

/**
 * Calls `onChange` when the set of non-LocalPilot chat models changes. VS Code also reports LocalPilot's own
 * vendor refreshing its list, which must not trigger another rediscovery (that would loop).
 */
export function onLmModelsChanged(onChange: () => void): vscode.Disposable {
  if (!vscodeLmAvailable() || typeof vscode.lm.onDidChangeChatModels !== 'function') {
    return { dispose: () => undefined };
  }
  const changed = lmIdsChangeGate();
  const check = () => selectLmModels().then((ms) => {
    if (changed(ms.map((m) => `${m.vendor}/${m.id}`))) {
      onChange();
    }
  }, () => undefined);
  void check();
  return vscode.lm.onDidChangeChatModels(() => void check());
}

function toMessages(turns: LmTurn[]): vscode.LanguageModelChatMessage[] {
  return turns.map((t) => {
    if (t.role === 'assistant') {
      return vscode.LanguageModelChatMessage.Assistant(
        t.parts.map((p) => (p.kind === 'call' ? new vscode.LanguageModelToolCallPart(p.callId, p.name, p.input) : new vscode.LanguageModelTextPart('text' in p ? p.text : '')))
      );
    }
    return vscode.LanguageModelChatMessage.User(
      t.parts.map((p) => (p.kind === 'result' ? new vscode.LanguageModelToolResultPart(p.callId, [new vscode.LanguageModelTextPart(p.text)]) : new vscode.LanguageModelTextPart('text' in p ? p.text : '')))
    );
  });
}

/** A readable message for the Language Model API's errors (consent refused, quota, model gone). */
function lmError(e: unknown, model: string): Error {
  if (e instanceof vscode.LanguageModelError) {
    const why = e.code === vscode.LanguageModelError.NoPermissions.name ? `VS Code did not grant LocalPilot access to ${model}` : e.code === vscode.LanguageModelError.NotFound.name ? `${model} is no longer available in VS Code` : e.message;
    return new Error(why);
  }
  return e instanceof Error ? e : new Error(String(e));
}

/**
 * Language models VS Code offers through `vscode.lm` (GitHub Copilot and other extensions). Consent is asked by VS
 * Code on the first request; usage is billed by that extension, so no price or cost is ever reported.
 */
export class VscodeLmProvider implements LLMProvider {
  readonly id: string;
  readonly type = 'vscode-lm' as const;
  readonly displayName: string;
  readonly baseUrl: string;
  private readonly only?: Set<string>;

  constructor(cfg: ProviderConfig) {
    this.id = cfg.id;
    this.displayName = cfg.displayName || 'VS Code language models';
    this.baseUrl = cfg.baseUrl || VSCODE_LM_BASE_URL;
    this.only = cfg.models?.length ? new Set(cfg.models) : undefined;
  }

  private async models(): Promise<vscode.LanguageModelChat[]> {
    const all = await selectLmModels();
    return this.only ? all.filter((m) => this.only!.has(m.id) || this.only!.has(m.family)) : all;
  }

  async listModels(): Promise<ModelInfo[]> {
    const seen = new Set<string>();
    return (await this.models()).filter((m) => !seen.has(m.id) && seen.add(m.id)).map((m) => lmModelInfo(this.id, m));
  }

  async healthCheck(): Promise<boolean> {
    return vscodeLmAvailable() && (await this.models().catch(() => [])).length > 0;
  }

  private async model(id: string): Promise<vscode.LanguageModelChat> {
    const [m] = await selectLmModels({ id });
    if (!m) {
      throw new Error(`${id} is not available from VS Code's language models (is the extension that provides it installed and signed in?)`);
    }
    return m;
  }

  async *chat(opts: ChatRequestOptions): AsyncIterable<StreamEvent> {
    const model = await this.model(opts.model);
    const cts = new vscode.CancellationTokenSource();
    const onAbort = () => cts.cancel();
    opts.signal?.addEventListener('abort', onAbort);
    try {
      if (opts.signal?.aborted) {
        throw new Error('aborted');
      }
      const tools: vscode.LanguageModelChatTool[] | undefined = opts.tools?.length
        ? opts.tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.parameters }))
        : undefined;
      let response: vscode.LanguageModelChatResponse;
      try {
        response = await model.sendRequest(
          toMessages(toLmTurns(opts.messages)),
          { justification: 'LocalPilot uses this model for the chat you started.', tools, toolMode: tools ? vscode.LanguageModelChatToolMode.Auto : undefined },
          cts.token
        );
      } catch (e) {
        throw lmError(e, model.name);
      }
      let calls = 0;
      try {
        for await (const part of response.stream) {
          if (part instanceof vscode.LanguageModelTextPart) {
            if (part.value) {
              yield { type: 'text', text: part.value };
            }
          } else if (part instanceof vscode.LanguageModelToolCallPart) {
            calls++;
            yield { type: 'tool_call', call: { id: part.callId || `call_${calls}`, name: part.name, arguments: JSON.stringify(part.input ?? {}) } };
          }
        }
      } catch (e) {
        if (opts.signal?.aborted) {
          throw new Error('aborted');
        }
        throw lmError(e, model.name);
      }
      yield { type: 'done', finishReason: calls ? 'tool_calls' : 'stop' };
    } finally {
      opts.signal?.removeEventListener('abort', onAbort);
      cts.dispose();
    }
  }

  complete(opts: CompletionRequestOptions): Promise<string> {
    return completeViaChat(this, opts);
  }
}
