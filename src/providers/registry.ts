import * as vscode from 'vscode';
import { getConfig, onConfigChange } from '../config';
import { LLMProvider, ModelInfo, ProviderConfig } from '../types';
import { lookupCatalog, ModelRole, modelFootprintGb } from './catalog';
import { OllamaProvider } from './ollama';
import { OpenAICompatProvider } from './openaiCompat';
import { getSystemProfile, SystemProfile } from './system';

export interface RouteRequest {
  /** What the model is needed for. Defaults to `agent`. */
  role?: ModelRole;
  /** Explicit `provider/model` from the session or caller; wins unless routing has to override it (e.g. images). */
  modelRef?: string;
  /** The turn carries images: route to a vision model when the chosen one cannot see. */
  needsVision?: boolean;
}

export interface Route {
  provider: LLMProvider;
  model: ModelInfo;
  /** Set when the router picked something other than the requested/default model, for the UI. */
  reason?: string;
  /** True when the requested model was unavailable (offline/disabled) and a substitute was chosen for good. */
  fallback?: boolean;
}

/** Builds providers from settings, discovers models, resolves `provider/model` ids and routes work to the best fitting model. */
export class ProviderRegistry implements vscode.Disposable {
  private providers = new Map<string, LLMProvider>();
  private modelCache: ModelInfo[] = [];
  /** Providers whose health check passed in the last discovery. */
  private reachable = new Set<string>();
  private lastRefresh = 0;
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly log: vscode.LogOutputChannel) {
    this.rebuild();
    this.disposables.push(onConfigChange(() => this.rebuild()));
  }

  private rebuild(): void {
    const next = new Map<string, LLMProvider>();
    for (const cfg of getConfig().providers) {
      try {
        next.set(cfg.id, createProvider(cfg));
      } catch (e) {
        this.log.error(`Failed to create provider ${cfg.id}: ${String(e)}`);
      }
    }
    // Only drop the discovery cache when the provider set actually changed — toggling a model or the default
    // must not force every server to be re-probed.
    const same = next.size === this.providers.size && [...next.keys()].every((id) => this.providers.get(id)?.baseUrl === next.get(id)!.baseUrl && this.providers.get(id)?.type === next.get(id)!.type);
    this.providers = next;
    if (!same) {
      this.modelCache = [];
      this.lastRefresh = 0;
    }
    this._onDidChange.fire();
  }

  get all(): LLMProvider[] {
    return [...this.providers.values()];
  }

  get(id: string): LLMProvider | undefined {
    return this.providers.get(id);
  }

  /** Forget cached discovery so the next `listModels` hits the servers (after a pull/remove). */
  invalidate(): void {
    this.modelCache = [];
    this.lastRefresh = 0;
  }

  /** Lists enabled models from all reachable providers (cached for 30s). */
  async listModels(force = false): Promise<ModelInfo[]> {
    const all = await this.listAllModels(force);
    return all.filter((m) => !m.disabled);
  }

  /** Every discovered model including disabled ones (flagged), for the model manager UI. */
  async listAllModels(force = false): Promise<ModelInfo[]> {
    if (force || !this.modelCache.length || Date.now() - this.lastRefresh >= 30_000) {
      const reachable = new Set<string>();
      const results = await Promise.allSettled(
        this.all.map(async (p) => {
          if (!(await p.healthCheck())) {
            return [];
          }
          reachable.add(p.id);
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
      const changed = models.length !== this.modelCache.length || models.some((m, i) => m.id !== this.modelCache[i]?.id);
      this.modelCache = models;
      this.reachable = reachable;
      this.lastRefresh = Date.now();
      if (changed) {
        // Pulled/removed/started models show up everywhere (chat picker, status bar, settings) without a manual refresh.
        this._onDidChange.fire();
      }
    }
    const disabled = new Set(getConfig().disabledModels);
    return this.modelCache.map((m) => ({ ...m, disabled: disabled.has(m.id) || undefined }));
  }

  /** Resolves a `provider/model` id (or bare model name) to a provider + model info. */
  async resolve(modelRef?: string): Promise<{ provider: LLMProvider; model: ModelInfo }> {
    return this.route({ modelRef });
  }

  /**
   * Picks the model for a piece of work. Order: an explicit/session model → the role override / configured
   * default → the best model for the role on this machine. With routing enabled, image turns are redirected to
   * a vision model and an offline or disabled default falls back to the best available one instead of failing.
   */
  async route(req: RouteRequest): Promise<Route> {
    const cfg = getConfig();
    const role = req.role ?? 'agent';
    const models = await this.listModels();
    const profile = await getSystemProfile().catch(() => undefined);
    const find = (ref?: string) => (ref ? models.find((m) => m.id === ref || m.modelId === ref) : undefined);

    const roleOverride =
      role === 'completion' ? cfg.inlineCompletion.model : role === 'vision' ? cfg.routing.vision : role === 'reasoning' ? cfg.routing.reasoning : role === 'fast' && cfg.routing.fast !== 'session' ? cfg.routing.fast : undefined;
    const wanted = req.modelRef || roleOverride || cfg.defaultModel;
    let model = find(wanted);
    let reason: string | undefined;
    let fallback = false;

    if (!model && wanted && wanted.includes('/')) {
      // A reachable provider that lists no models (no /models endpoint) may still serve the referenced model;
      // one that lists models but not this one, or that is offline, does not — fall back below instead.
      const providerId = wanted.slice(0, wanted.indexOf('/'));
      const listsModels = models.some((m) => m.providerId === providerId);
      const unlisted = listsModels || !this.reachable.has(providerId) ? undefined : this.unlisted(wanted, cfg.contextWindow, cfg.maxOutputTokens);
      if (unlisted && !cfg.disabledModels.includes(unlisted.id)) {
        model = unlisted;
      }
    }
    if (!model && wanted && models.length) {
      reason = `${wanted.split('/').pop()} is not available — using the best model that is`;
      fallback = true;
    }
    if (model && cfg.routing.enabled) {
      if (req.needsVision && !model.supportsVision) {
        const vision = find(cfg.routing.vision) ?? pickForRole(models, 'vision', profile);
        if (vision?.supportsVision) {
          reason = `${model.name} cannot see images — using ${vision.name} for this turn`;
          model = vision;
        }
      } else if (role === 'completion' && !req.modelRef && !roleOverride) {
        // No explicit completion model: prefer a small FIM model over the (usually larger) default.
        const fim = pickForRole(models, 'completion', profile);
        if (fim && fim.id !== model.id && (fim.supportsFim || !model.supportsFim)) {
          model = fim;
        }
      } else if (role === 'reasoning' && cfg.routing.reasoning) {
        const r = find(cfg.routing.reasoning);
        if (r && r.id !== model.id) {
          reason = `Plan mode — using ${r.name} for reasoning`;
          model = r;
        }
      } else if (role === 'fast' && !req.modelRef && !roleOverride && cfg.routing.fast !== 'session') {
        // Read-only subagents: a small tool-capable model answers faster and leaves memory for the main model.
        const fast = pickForRole(models, 'fast', profile);
        if (fast && fast.id !== model.id && fast.supportsTools) {
          reason = `Read-only subagent — using ${fast.name}`;
          model = fast;
        }
      }
    }
    if (!model) {
      model = pickForRole(models, role, profile, req.needsVision) ?? pickForRole(models, 'agent', profile);
    }
    if (!model) {
      throw new Error(
        'No local models found. Run "LocalPilot: Set up models automatically", start Ollama (`ollama serve`), LM Studio, llama.cpp or vLLM, or configure `localpilot.providers`.'
      );
    }
    const provider = this.providers.get(model.providerId);
    if (!provider) {
      throw new Error(`Provider ${model.providerId} not configured`);
    }
    if (reason) {
      this.log.info(`route(${role}): ${reason}`);
    }
    return { provider, model, reason, fallback };
  }

  /** Allow referencing a model not in discovery (e.g. provider with no /models endpoint). */
  private unlisted(ref: string, contextWindow: number, maxOutputTokens: number): ModelInfo | undefined {
    const slash = ref.indexOf('/');
    const providerId = ref.slice(0, slash);
    if (!this.providers.get(providerId)) {
      return undefined;
    }
    return { id: ref, providerId, modelId: ref.slice(slash + 1), name: ref.slice(slash + 1), contextWindow, maxOutputTokens, supportsTools: true, supportsVision: false };
  }

  dispose(): void {
    this.disposables.forEach((d) => d.dispose());
    this._onDidChange.dispose();
  }
}

export function createProvider(cfg: ProviderConfig): LLMProvider {
  return cfg.type === 'ollama' ? new OllamaProvider(cfg) : new OpenAICompatProvider(cfg);
}

/**
 * Scores a model for a role on this machine. Capability and family matter most; among comparable models the
 * one that fits in memory wins, and for completions smaller is better (latency).
 */
export function scoreForRole(m: ModelInfo, role: ModelRole, profile?: SystemProfile): number {
  const n = m.modelId.toLowerCase();
  if (/embed|rerank|whisper/.test(n)) {
    return -100;
  }
  const cat = lookupCatalog(m);
  const gb = modelFootprintGb(m);
  const fit = profile && gb !== undefined ? (gb <= profile.modelBudgetGb ? 1 : gb <= profile.modelBudgetGb * 1.25 ? 0 : -1) : 0.5;
  let s = fit * 8;
  if (role === 'vision') {
    s += m.supportsVision ? 30 : -50;
  }
  if (role === 'completion') {
    s += m.supportsFim ? 20 : -20;
    // Snappy ghost text: prefer the smallest FIM model, and base models over instruct ones.
    s += gb !== undefined ? Math.max(0, 12 - gb) : 0;
    s += /base/.test(n) ? 3 : 0;
    s -= /r1|reason|think|vl|vision/.test(n) ? 10 : 0;
  }
  if (role === 'fast') {
    // Must call tools; among those, smaller and coder-tuned wins. Reasoning/vision models are slow for this.
    s += m.supportsTools ? 25 : -60;
    s += gb !== undefined ? Math.max(0, 16 - gb) : 0;
    s += /coder|devstral|codestral|qwen2\.5|qwen3|llama3|mistral|gemma|phi/.test(n) ? 3 : 0;
    s -= /base$|-base\b|:.*base/.test(n) ? 15 : 0;
    s -= /r1|reason|think|vl|llava|vision|embed/.test(n) ? 10 : 0;
  }
  if (role === 'agent' || role === 'reasoning') {
    s += m.supportsTools ? 10 : 0;
    s += /coder|devstral|codestral|gpt-oss|qwen3|mistral-small/.test(n) ? 4 : 0;
    s += /qwen|llama|mistral|gemma|deepseek|phi|gpt-oss/.test(n) ? 2 : 0;
    s -= /base$|-base\b|:.*base/.test(n) ? 8 : 0;
    s -= /vl|llava|vision/.test(n) ? 4 : 0;
    // Bigger is better for agent quality as long as it fits.
    const b = cat?.variant.paramsB ?? (gb !== undefined ? gb / 0.72 : 7);
    s += Math.min(b, 32) / 8;
    if (role === 'reasoning') {
      s += /r1|qwen3|gpt-oss|think|reason/.test(n) ? 6 : 0;
    }
  }
  return s;
}

/** Best enabled model for a role, or undefined when nothing meets the hard constraints (e.g. no vision model). */
export function pickForRole(models: ModelInfo[], role: ModelRole, profile?: SystemProfile, needsVision?: boolean): ModelInfo | undefined {
  const pool = needsVision || role === 'vision' ? models.filter((m) => m.supportsVision) : models;
  const ranked = [...pool].sort((a, b) => scoreForRole(b, role, profile) - scoreForRole(a, role, profile));
  const best = ranked[0];
  return best && scoreForRole(best, role, profile) > -50 ? best : undefined;
}
