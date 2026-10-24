import * as vscode from 'vscode';
import { getConfig } from '../config';
import { ProviderRegistry } from '../providers/registry';

const CACHE_TTL_MS = 5 * 60_000;
const CACHE_MAX = 200;

/**
 * Ghost-text completions powered by a local FIM-capable model (qwen2.5-coder, codestral, starcoder2,
 * deepseek-coder…). Uses Ollama's native `suffix` support or the OpenAI `/completions` endpoint; falls
 * back to a prompt-templated FIM when the server has no suffix support.
 *
 * Only one request is ever in flight: a new keystroke cancels the pending debounce *and* aborts the
 * request the previous keystroke started, so a slow local model never queues up work for cursor
 * positions that no longer exist.
 */
export class InlineCompletionProvider implements vscode.InlineCompletionItemProvider, vscode.Disposable {
  private generation = 0;
  private debounceTimer: ReturnType<typeof setTimeout> | undefined;
  private inflight: AbortController | undefined;
  private readonly cache = new Map<string, { text: string; at: number }>();
  /** Last seen length per document, to recognise deletions (backspace, cut) which should not trigger. */
  private readonly lastLength = new Map<string, number>();

  constructor(private readonly providers: ProviderRegistry, private readonly log: vscode.LogOutputChannel) {}

  dispose(): void {
    clearTimeout(this.debounceTimer);
    this.inflight?.abort();
    this.cache.clear();
    this.lastLength.clear();
  }

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
    const docKey = document.uri.toString();
    const length = document.getText().length;
    const shrank = (this.lastLength.get(docKey) ?? length) > length;
    this.lastLength.set(docKey, length);

    const line = document.lineAt(position.line).text;
    const linePrefix = line.slice(0, position.character);
    const lineSuffix = line.slice(position.character);
    if (context.triggerKind === vscode.InlineCompletionTriggerKind.Automatic && !shouldTrigger(linePrefix, lineSuffix, shrank)) {
      return;
    }

    // Supersede whatever the previous keystroke started, then debounce.
    const gen = ++this.generation;
    clearTimeout(this.debounceTimer);
    this.inflight?.abort();
    this.inflight = undefined;
    await new Promise<void>((resolve) => {
      this.debounceTimer = setTimeout(resolve, cfg.debounceMs);
    });
    if (token.isCancellationRequested || gen !== this.generation) {
      return;
    }

    const prefixRange = new vscode.Range(new vscode.Position(Math.max(0, position.line - 120), 0), position);
    const suffixRange = new vscode.Range(position, new vscode.Position(Math.min(document.lineCount - 1, position.line + 40), 0));
    const prefix = document.getText(prefixRange);
    const suffix = document.getText(suffixRange);
    const key = `${docKey}:${document.languageId}:${prefix.slice(-600)}|${suffix.slice(0, 300)}`;
    let completion = this.cached(key);

    if (completion === undefined) {
      const abort = new AbortController();
      this.inflight = abort;
      const sub = token.onCancellationRequested(() => abort.abort());
      try {
        // Routing picks the configured completion model, else the smallest FIM-capable model that fits this machine.
        const { provider, model } = await this.providers.route({ role: 'completion' });
        if (abort.signal.aborted || gen !== this.generation) {
          return;
        }
        const header = `// File: ${vscode.workspace.asRelativePath(document.uri)} (${document.languageId})\n`;
        const raw = await provider.complete({
          model: model.modelId,
          prompt: header + prefix,
          suffix,
          // Mid-line requests only ever show one line, so do not pay for more.
          maxTokens: lineSuffix.trim() ? Math.min(cfg.maxTokens, 48) : cfg.maxTokens,
          temperature: 0.1,
          stop: ['\n\n\n', '<|endoftext|>', '<|fim_pad|>', '<|file_sep|>', '</s>'],
          signal: abort.signal,
        });
        completion = postProcess(raw, lineSuffix);
        this.remember(key, completion);
      } catch (e) {
        if (!abort.signal.aborted && !token.isCancellationRequested) {
          this.log.debug(`inline completion failed: ${String(e)}`);
        }
        return;
      } finally {
        sub.dispose();
        if (this.inflight === abort) {
          this.inflight = undefined;
        }
      }
    }
    if (!completion || token.isCancellationRequested || gen !== this.generation) {
      return;
    }
    return [new vscode.InlineCompletionItem(completion, new vscode.Range(position, position))];
  }

  private cached(key: string): string | undefined {
    const hit = this.cache.get(key);
    if (!hit) {
      return undefined;
    }
    if (Date.now() - hit.at > CACHE_TTL_MS) {
      this.cache.delete(key);
      return undefined;
    }
    // Refresh recency so the LRU eviction below keeps hot entries.
    this.cache.delete(key);
    this.cache.set(key, hit);
    return hit.text;
  }

  private remember(key: string, text: string): void {
    this.cache.set(key, { text, at: Date.now() });
    while (this.cache.size > CACHE_MAX) {
      const oldest = this.cache.keys().next();
      if (oldest.done) {
        break;
      }
      this.cache.delete(oldest.value);
    }
  }
}

/**
 * Cheap pre-flight for automatic triggers. Every request costs a model round-trip on the user's own machine,
 * so positions where a completion is almost never accepted are skipped outright.
 */
export function shouldTrigger(linePrefix: string, lineSuffix: string, deleting: boolean): boolean {
  if (deleting) {
    return false;
  }
  // Cursor inside an identifier ("fo|o") — the model would just repeat the rest of the word.
  if (/\w$/.test(linePrefix) && /^\w/.test(lineSuffix)) {
    return false;
  }
  return true;
}

export function postProcess(text: string, lineSuffix: string): string {
  let t = text.replace(/\r/g, '');
  // Strip FIM sentinel tokens some servers echo back.
  t = t.replace(/<\|(?:fim_(?:prefix|suffix|middle|pad)|endoftext|file_sep|repo_name)\|>/g, '').replace(/<(?:PRE|SUF|MID|EOT)>/g, '');
  const after = lineSuffix.trim();
  if (after) {
    // Mid-line: ghost text is a single line, and must not repeat what already follows the cursor —
    // either verbatim ("foo(|)" → "bar)") or as an overlapping tail ("foo(|)" → "bar(x))").
    t = t.split('\n')[0];
    let overlap = 0;
    for (let k = Math.min(t.length, after.length); k > 0; k--) {
      if (t.endsWith(after.slice(0, k))) {
        overlap = k;
        break;
      }
    }
    if (overlap) {
      t = t.slice(0, t.length - overlap);
    } else {
      const idx = t.indexOf(after);
      if (idx >= 0) {
        t = t.slice(0, idx);
      }
    }
  }
  // Cap at a reasonable number of lines for ghost text.
  const lines = t.split('\n');
  if (lines.length > 12) {
    t = lines.slice(0, 12).join('\n');
  }
  return t.replace(/\s+$/, '');
}
