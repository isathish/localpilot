import * as vscode from 'vscode';
import { getConfig } from '../config';
import { ProviderRegistry } from '../providers/registry';

/**
 * Ghost-text completions powered by a local FIM-capable model (qwen2.5-coder, codestral, starcoder2,
 * deepseek-coder…). Uses Ollama's native `suffix` support or the OpenAI `/completions` endpoint; falls
 * back to a prompt-templated FIM when the server has no suffix support.
 */
export class InlineCompletionProvider implements vscode.InlineCompletionItemProvider {
  private lastRequest = 0;
  private cache = new Map<string, string>();

  constructor(private readonly providers: ProviderRegistry, private readonly log: vscode.LogOutputChannel) {}

  async provideInlineCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    context: vscode.InlineCompletionContext,
    token: vscode.CancellationToken
  ): Promise<vscode.InlineCompletionItem[] | undefined> {
    const cfg = getConfig().inlineCompletion;
    if (!cfg.enabled || document.uri.scheme === 'output') {
      return;
    }
    // Debounce: wait for typing to settle.
    const now = Date.now();
    this.lastRequest = now;
    await new Promise((r) => setTimeout(r, cfg.debounceMs));
    if (token.isCancellationRequested || this.lastRequest !== now) {
      return;
    }

    const prefixRange = new vscode.Range(new vscode.Position(Math.max(0, position.line - 120), 0), position);
    const suffixRange = new vscode.Range(position, new vscode.Position(Math.min(document.lineCount - 1, position.line + 40), 0));
    const prefix = document.getText(prefixRange);
    const suffix = document.getText(suffixRange);
    const lineSuffix = document.lineAt(position.line).text.slice(position.character);
    const key = `${document.uri.toString()}:${prefix.slice(-400)}|${suffix.slice(0, 200)}`;
    let completion = this.cache.get(key);

    if (completion === undefined) {
      try {
        // Routing picks the configured completion model, else the smallest FIM-capable model that fits this machine.
        const { provider, model } = await this.providers.route({ role: 'completion' });
        const abort = new AbortController();
        const sub = token.onCancellationRequested(() => abort.abort());
        const header = `// File: ${vscode.workspace.asRelativePath(document.uri)} (${document.languageId})\n`;
        try {
          completion = await provider.complete({
            model: model.modelId,
            prompt: header + prefix,
            suffix,
            maxTokens: cfg.maxTokens,
            temperature: 0.1,
            stop: ['\n\n\n', '<|endoftext|>', '<|fim_pad|>', '<|file_sep|>', '</s>'],
            signal: abort.signal,
          });
        } finally {
          sub.dispose();
        }
        completion = postProcess(completion, lineSuffix);
        this.cache.set(key, completion);
        if (this.cache.size > 200) {
          this.cache.delete(this.cache.keys().next().value!);
        }
      } catch (e) {
        if (!token.isCancellationRequested) {
          this.log.debug(`inline completion failed: ${String(e)}`);
        }
        return;
      }
    }
    if (!completion || token.isCancellationRequested) {
      return;
    }
    return [new vscode.InlineCompletionItem(completion, new vscode.Range(position, position))];
  }
}

function postProcess(text: string, lineSuffix: string): string {
  let t = text.replace(/\r/g, '');
  // Strip FIM sentinel tokens some servers echo back.
  t = t.replace(/<\|(?:fim_(?:prefix|suffix|middle|pad)|endoftext|file_sep|repo_name)\|>/g, '').replace(/<(?:PRE|SUF|MID|EOT)>/g, '');
  // Avoid duplicating text that already follows the cursor.
  if (lineSuffix.trim() && t.includes(lineSuffix.trim())) {
    t = t.slice(0, t.indexOf(lineSuffix.trim()));
  }
  // Cap at a reasonable number of lines for ghost text.
  const lines = t.split('\n');
  if (lines.length > 12) {
    t = lines.slice(0, 12).join('\n');
  }
  return t.replace(/\s+$/, '');
}
