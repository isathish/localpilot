import * as vscode from 'vscode';
import { getConfig, onConfigChange } from '../config';
import { LLMProvider, ModelInfo, ProviderConfig } from '../types';
import { OllamaProvider } from './ollama';
import { OpenAICompatProvider } from './openaiCompat';

/** Builds providers from settings, discovers models, resolves `provider/model` ids. */
export class ProviderRegistry implements vscode.Disposable {
  private providers = new Map<string, LLMProvider>();
  private modelCache: ModelInfo[] = [];
  private lastRefresh = 0;
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly log: vscode.LogOutputChannel) {
    this.rebuild();
    this.disposables.push(onConfigChange(() => this.rebuild()));
  }

  private rebuild(): void {
    this.providers.clear();
    for (const cfg of getConfig().providers) {
      try {
        this.providers.set(cfg.id, createProvider(cfg));
      } catch (e) {
        this.log.error(`Failed to create provider ${cfg.id}: ${String(e)}`);
      }
    }
    this.modelCache = [];
    this.lastRefresh = 0;
    this._onDidChange.fire();
  }

  get all(): LLMProvider[] {
    return [...this.providers.values()];
  }

  get(id: string): LLMProvider | undefined {
    return this.providers.get(id);
  }

  /** Lists models from all reachable providers (cached for 30s). */
  async listModels(force = false): Promise<ModelInfo[]> {
    if (!force && this.modelCache.length && Date.now() - this.lastRefresh < 30_000) {
      return this.modelCache;
    }
    const results = await Promise.allSettled(
      this.all.map(async (p) => {
        if (!(await p.healthCheck())) {
          return [];
        }
        return p.listModels();
      })
    );
    const models: ModelInfo[] = [];
    results.forEach((r, i) => {
      if (r.status === 'fulfilled') {
        models.push(...r.value);
      } else {
        this.log.warn(`listModels failed for ${this.all[i].id}: ${String(r.reason)}`);
      }
    });
    this.modelCache = models;
    this.lastRefresh = Date.now();
    return models;
  }

  /** Resolves a `provider/model` id (or bare model name) to a provider + model info. */
  async resolve(modelRef?: string): Promise<{ provider: LLMProvider; model: ModelInfo }> {
    const models = await this.listModels();
    const ref = modelRef || getConfig().defaultModel;
    let model = ref ? models.find((m) => m.id === ref || m.modelId === ref) : undefined;
    if (!model && ref && ref.includes('/')) {
      // Allow referencing a model not in discovery (e.g. provider with no /models endpoint).
      const slash = ref.indexOf('/');
      const providerId = ref.slice(0, slash);
      const provider = this.providers.get(providerId);
      if (provider) {
        const cfg = getConfig();
        model = {
          id: ref,
          providerId,
          modelId: ref.slice(slash + 1),
          name: ref.slice(slash + 1),
          contextWindow: cfg.contextWindow,
          maxOutputTokens: cfg.maxOutputTokens,
          supportsTools: true,
          supportsVision: false,
        };
      }
    }
    if (!model) {
      model = pickDefault(models);
    }
    if (!model) {
      throw new Error(
        'No local models found. Start Ollama (`ollama serve`), LM Studio server, llama.cpp or vLLM, or configure `localpilot.providers`.'
      );
    }
    const provider = this.providers.get(model.providerId);
    if (!provider) {
      throw new Error(`Provider ${model.providerId} not configured`);
    }
    return { provider, model };
  }

  dispose(): void {
    this.disposables.forEach((d) => d.dispose());
    this._onDidChange.dispose();
  }
}

export function createProvider(cfg: ProviderConfig): LLMProvider {
  return cfg.type === 'ollama' ? new OllamaProvider(cfg) : new OpenAICompatProvider(cfg);
}

/** Prefer tool-capable coder models when no default is configured. */
function pickDefault(models: ModelInfo[]): ModelInfo | undefined {
  const score = (m: ModelInfo) =>
    (m.supportsTools ? 10 : 0) + (/coder|code|qwen|llama|mistral|devstral|gemma|phi|deepseek/i.test(m.modelId) ? 2 : 0) + (/coder|devstral|codestral/i.test(m.modelId) ? 3 : 0);
  return [...models].sort((a, b) => score(b) - score(a))[0];
}
