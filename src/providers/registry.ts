import * as vscode from 'vscode';
import { Telemetry } from '../telemetry/telemetry';
import { forgetModel, getConfig, onConfigChange } from '../config';
import { LLMProvider, ModelInfo, ProviderConfig } from '../types';
import { effectiveContextWindow } from '../context/contextManager';
import { lookupCatalog, ModelRole, modelFootprintGb } from './catalog';
import { streamsFromDisk } from './colibri';
import { AnthropicProvider } from './anthropic';
import { isCloudProvider, isRemoteUrl, onSecretsChanged, resolveApiKey } from './cloud';
import { getManagedPolicy, providerAllowed } from '../agent/managedPolicy';
import { OllamaProvider } from './ollama';
import { OpenAICompatProvider } from './openaiCompat';
import { getSystemProfile, parameterSizeB, SystemProfile } from './system';

export interface RouteRequest {
  /** What the model is needed for. Defaults to `agent`. */
  role?: ModelRole;
  /** Explicit `provider/model` from the session or caller; wins unless routing has to override it (e.g. images). */
  modelRef?: string;
  /** Re-read Ollama's installed list first (cheap, local) so a model pulled or removed seconds ago is routed correctly. */
  fresh?: boolean;
  /** The turn carries images: route to a vision model when the chosen one cannot see. */
  needsVision?: boolean;
  /**
   * Current load, for spreading parallel work across models: how many runs are assigned to each model id right
   * now, and which model ids are known to answer one request at a time (see AgentRunner).
   */
  load?: ModelLoad;
  /**
   * The caller did not insist on this exact model (Auto, or a worker that merely inherited its parent's model):
   * when the chosen model is saturated, a comparable idle model that fits in memory alongside may answer instead.
   */
  spread?: boolean;
}

export interface ModelLoad {
  /** Runs currently assigned to each model id — a live view, so two requests routed in the same tick see each other. */
  assigned: ReadonlyMap<string, number>;
  /** Model ids observed to serve one request at a time (Ollama's default); others are assumed to take `slots`. */
  serial: ReadonlySet<string>;
  /** Parallel requests a model is assumed to take unless it is known to be serial (what LocalPilot asks Ollama for). */
  slots: number;
  /** Called synchronously with the decision, before `route()` returns, so concurrent callers cannot all pick the same model. */
  reserve?(modelId: string): void;
}

/**
 * Learned adjustment to a model's role score from how it actually performed on this machine (see usageAdvisor):
 * positive for models that finished their runs quickly and reliably, negative for ones that failed or crawled.
 */
export type UsageBonus = (m: ModelInfo, role: ModelRole) => number;

export interface Route {
  provider: LLMProvider;
  model: ModelInfo;
  /** Set when the router picked something other than the requested/default model, for the UI. */
  reason?: string;
  /** True when the requested model was unavailable (offline/disabled) and a substitute was chosen for good. */
  fallback?: boolean;
  /** True when the model was chosen only because the intended one was busy: the next run should route again. */
  spread?: boolean;
}

/** Builds providers from settings, discovers models, resolves `provider/model` ids and routes work to the best fitting model. */
export class ProviderRegistry implements vscode.Disposable {
  private providers = new Map<string, LLMProvider>();
  /** Serialized config each provider was built from, so unchanged providers (and their model-info caches) survive a settings change. */
  private providerConfigs = new Map<string, string>();
  private modelCache: ModelInfo[] = [];
  /** Providers whose health check passed in the last discovery. */
  private reachable = new Set<string>();
  /** Local-only provider health metrics for the dashboard. */
  telemetry?: Pick<Telemetry, 'record'>;
  /** Learned per-model adjustments from local usage, applied to automatic picks (never to explicit choices). */
  usageBonus?: UsageBonus;
  /**
   * Starts a configured local model server that is installed but not running (Ollama), resolving true once it
   * answers. Set by the extension and the CLI; without it a stopped server is reported, not started.
   */
  startLocalServer?: (provider: ProviderConfig) => Promise<boolean>;
  private readonly starting = new Map<string, Promise<boolean>>();
  private readonly startFailedAt = new Map<string, number>();
  private lastRefresh = 0;
  /** Bumped when the provider set changes, so a discovery round started before the change cannot fill the cache with the old providers' models. */
  private generation = 0;
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;
  /** Model ids that are gone from their server (removed outside LocalPilot too); settings pointing at them were cleared. */
  private readonly _onDidRemoveModels = new vscode.EventEmitter<string[]>();
  readonly onDidRemoveModels = this._onDidRemoveModels.event;
  /** Fallback notices already logged for the current model list, so every route() does not repeat them. */
  private readonly noted = new Set<string>();
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly log: vscode.LogOutputChannel) {
    this.rebuild();
    this.disposables.push(
      onConfigChange(() => this.rebuild()),
      // A key entered or loaded from secret storage: rebuild the affected providers and list their models again.
      onSecretsChanged(() => {
        this.rebuild();
        this.invalidate();
      })
    );
  }

  /** Providers left out because of the organisation policy (logged once each). */
  private readonly policyBlocked = new Set<string>();

  private rebuild(): void {
    const next = new Map<string, LLMProvider>();
    const nextConfigs = new Map<string, string>();
    const managed = getManagedPolicy(this.log);
    for (const cfg of getConfig().providers) {
      // Organisation policy: a provider it does not permit is never built, so nothing can route to it.
      const allowed = providerAllowed(managed, cfg.baseUrl, isCloudProvider(cfg));
      if (!allowed.ok) {
        if (!this.policyBlocked.has(cfg.id)) {
          this.policyBlocked.add(cfg.id);
          this.log.warn(`provider ${cfg.id} not loaded: ${allowed.reason}`);
        }
        continue;
      }
      // The resolved key is part of the identity, so a changed environment variable or stored secret takes effect.
      const key = `${JSON.stringify(cfg)}\0${resolveApiKey(cfg) ?? ''}`;
      nextConfigs.set(cfg.id, key);
      const existing = this.providers.get(cfg.id);
      if (existing && this.providerConfigs.get(cfg.id) === key) {
        next.set(cfg.id, existing);
        continue;
      }
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
    this.providerConfigs = nextConfigs;
    if (!same) {
      this.modelCache = [];
      this.lastRefresh = 0;
      this.generation++;
      this.discovery = undefined;
    }
    this._onDidChange.fire();
  }

  get all(): LLMProvider[] {
    return [...this.providers.values()];
  }

  get(id: string): LLMProvider | undefined {
    return this.providers.get(id);
  }

  private autoRefreshTimer?: ReturnType<typeof setInterval>;

  /**
   * Re-discovers models in the background so models pulled, removed or served from a server started outside
   * LocalPilot show up on their own. Only while `active()` (e.g. the window is focused); polls faster while no
   * model is found yet, so starting Ollama/LM Studio after VS Code is picked up within seconds.
   */
  startAutoRefresh(active: () => boolean = () => true, intervalMs = 45_000, idleIntervalMs = 10_000): vscode.Disposable {
    this.stopAutoRefresh();
    const tickMs = Math.min(intervalMs, idleIntervalMs);
    this.autoRefreshTimer = setInterval(() => {
      if (this.discovery || !this.providers.size || !active()) {
        return;
      }
      const due = this.modelCache.length ? intervalMs : idleIntervalMs;
      if (Date.now() - this.lastRefresh >= due) {
        void this.startDiscovery().catch((e) => this.log.debug(`auto-refresh: ${e instanceof Error ? e.message : String(e)}`));
      }
    }, tickMs);
    (this.autoRefreshTimer as { unref?: () => void }).unref?.();
    return { dispose: () => this.stopAutoRefresh() };
  }

  private stopAutoRefresh(): void {
    if (this.autoRefreshTimer) {
      clearInterval(this.autoRefreshTimer);
      this.autoRefreshTimer = undefined;
    }
  }

  /** How old the model list may be before a `fresh` route re-reads Ollama's installed models. */
  freshnessMs = 3_000;

  /** True when a reachable Ollama server now lists different models than the cache (pulled/removed outside LocalPilot). */
  private async installedChanged(): Promise<boolean> {
    if (this.discovery || !this.lastRefresh || Date.now() - this.lastRefresh < this.freshnessMs) {
      return false;
    }
    const ids = (list: ModelInfo[]) => list.map((m) => m.id).sort().join('\n');
    const checks = await Promise.allSettled(
      this.all.filter((p) => p.type === 'ollama' && this.reachable.has(p.id)).map(async (p) => ids(await p.listModels()) !== ids(this.modelCache.filter((m) => m.providerId === p.id)))
    );
    return checks.some((r) => r.status === 'fulfilled' && r.value);
  }

  /** Forget cached discovery so the next `listModels` hits the servers (after a pull/remove). */
  invalidate(): void {
    this.modelCache = [];
    this.lastRefresh = 0;
  }

  /** Enabled models from the last discovery without touching the network (empty before the first one). */
  cachedModels(): ModelInfo[] {
    const disabled = new Set(getConfig().disabledModels);
    return this.modelCache.filter((m) => !disabled.has(m.id));
  }

  /** Lists enabled models from all reachable providers (cached for 30s). */
  async listModels(force = false): Promise<ModelInfo[]> {
    const all = await this.listAllModels(force);
    return all.filter((m) => !m.disabled);
  }

  /** Every discovered model including disabled ones (flagged), for the model manager UI. */
  async listAllModels(force = false): Promise<ModelInfo[]> {
    // An empty result is cached briefly too, so a machine with no server up is not re-probed by every caller
    // (chat boot, status bar, completions, settings) within the same few seconds.
    const ttl = this.modelCache.length ? 30_000 : 10_000;
    if (force) {
      // A forced refresh must observe servers as they are now; if a round is already running, probe again after it.
      await (this.discovery ? this.discovery.then(() => this.startDiscovery()) : this.startDiscovery());
    } else if (Date.now() - this.lastRefresh >= ttl) {
      // Concurrent callers share one discovery round instead of each probing every server.
      await (this.discovery ?? this.startDiscovery());
    }
    // The provider set changed while the round ran: its result was dropped, so list the current providers.
    for (let i = 0; i < 3 && !this.lastRefresh; i++) {
      await (this.discovery ?? this.startDiscovery());
    }
    const disabled = new Set(getConfig().disabledModels);
    return this.modelCache.map((m) => ({ ...m, disabled: disabled.has(m.id) || undefined }));
  }

  private discovery?: Promise<void>;

  private startDiscovery(): Promise<void> {
    const p = this.discover().finally(() => {
      if (this.discovery === p) {
        this.discovery = undefined;
      }
    });
    this.discovery = p;
    return p;
  }

  private async discover(): Promise<void> {
    const generation = this.generation;
    const reachable = new Set<string>();
    const listed = new Map<string, ModelInfo[]>();
    const probed = this.all;
    const results = await Promise.allSettled(
      probed.map(async (p) => {
        const started = Date.now();
        if (!(await p.healthCheck())) {
          this.telemetry?.record({ type: 'health', provider: p.id, ok: false, durationMs: Date.now() - started, error: 'unreachable' });
          return [];
        }
        reachable.add(p.id);
        try {
          const list = await p.listModels();
          listed.set(p.id, list);
          this.telemetry?.record({ type: 'health', provider: p.id, ok: true, durationMs: Date.now() - started, models: list.length });
          return list;
        } catch (e) {
          this.telemetry?.record({ type: 'health', provider: p.id, ok: false, durationMs: Date.now() - started, error: e instanceof Error ? e.message : String(e) });
          throw e;
        }
      })
    );
    if (generation !== this.generation) {
      return; // the providers changed meanwhile; these results describe servers that may no longer be configured
    }
    const models: ModelInfo[] = [];
    results.forEach((r, i) => {
      if (r.status === 'fulfilled') {
        models.push(...r.value);
      } else {
        this.log.warn(`listModels failed for ${probed[i].id}: ${String(r.reason)}`);
      }
    });
    const sig = (m: ModelInfo) => `${m.id}|${m.supportsTools}|${m.supportsVision}|${m.contextWindow}|${m.sizeBytes ?? ''}`;
    const changed = models.length !== this.modelCache.length || models.some((m, i) => !this.modelCache[i] || sig(m) !== sig(this.modelCache[i]));
    const gone = this.vanished(listed, this.modelCache);
    this.modelCache = models;
    this.reachable = reachable;
    this.lastRefresh = Date.now();
    if (changed) {
      this.noted.clear();
      this.residentAt = 0;
      // Pulled/removed/started models show up everywhere (chat picker, status bar, settings) without a manual refresh.
      this._onDidChange.fire();
    }
    if (gone.length) {
      void this.forget(gone);
    }
  }

  /**
   * Models no longer on their server: ones that dropped out of an Ollama listing, plus settings that name a model the
   * Ollama server does not have (e.g. `ollama rm` while VS Code was closed). OpenAI-style servers may list only loaded
   * models, so absence there proves nothing.
   */
  private vanished(listed: Map<string, ModelInfo[]>, previous: ModelInfo[]): string[] {
    const authoritative = (pid: string) => (this.providers.get(pid)?.type === 'ollama' ? listed.get(pid) : undefined);
    const has = (list: ModelInfo[], ref: string) => list.some((m) => m.id === ref || m.id === `${ref}:latest`);
    const out = new Set<string>();
    for (const m of previous) {
      const now = authoritative(m.providerId);
      if (now && !has(now, m.id)) {
        out.add(m.id);
      }
    }
    const cfg = getConfig();
    for (const ref of [cfg.defaultModel, cfg.inlineCompletion.model, cfg.routing.vision, cfg.routing.reasoning]) {
      const slash = ref ? ref.indexOf('/') : -1;
      const now = ref && slash > 0 ? authoritative(ref.slice(0, slash)) : undefined;
      if (ref && now?.length && !has(now, ref)) {
        out.add(ref);
      }
    }
    return [...out];
  }

  private async forget(ids: string[]): Promise<void> {
    for (const id of ids) {
      const cleared = await forgetModel(id).catch(() => [] as string[]);
      this.log.info(`models: ${id} is no longer installed${cleared.length ? ` — cleared ${cleared.join(', ')} (back to automatic)` : ''}`);
    }
    this._onDidRemoveModels.fire(ids);
  }

  /** Resolves a `provider/model` id (or bare model name) to a provider + model info. */
  async resolve(modelRef?: string): Promise<{ provider: LLMProvider; model: ModelInfo }> {
    return this.route({ modelRef });
  }

  /** Models warmed recently, so focusing the composer repeatedly does not hammer the server. */
  private readonly warmed = new Map<string, number>();

  private resident: ReadonlySet<string> = new Set();
  /** Memory each resident model takes as its server reports it (GB, context cache included). */
  private residentGb: ReadonlyMap<string, number> = new Map();
  private residentAt = 0;
  private residentProbe?: Promise<ReadonlySet<string>>;

  /**
   * Model ids loaded in memory right now on servers that report it (Ollama `/api/ps`), cached for a few seconds.
   * A resident model answers without a weight load, so automatic picks prefer it among comparable ones.
   */
  async residentModels(maxAgeMs = 5_000): Promise<ReadonlySet<string>> {
    if (Date.now() - this.residentAt < maxAgeMs) {
      return this.resident;
    }
    this.residentProbe ??= (async () => {
      const out = new Set<string>();
      const sizes = new Map<string, number>();
      await Promise.all(
        this.all
          .filter((p) => p.loadedModels && (this.reachable.has(p.id) || !this.lastRefresh))
          .map(async (p) => {
            try {
              for (const m of await p.loadedModels!()) {
                out.add(`${p.id}/${m.id}`);
                if (m.bytes) {
                  sizes.set(`${p.id}/${m.id}`, m.bytes / 1024 ** 3);
                }
              }
            } catch {
              /* unknown — treat as nothing loaded */
            }
          })
      );
      this.resident = out;
      this.residentGb = sizes;
      this.residentAt = Date.now();
      return out;
    })().finally(() => {
      this.residentProbe = undefined;
    });
    return this.residentProbe;
  }

  /**
   * Loads the model a request is about to use so the first token is not preceded by a weight load (often 5–30 s for a
   * local model). Best effort: throttled per model, silent on failure, and a no-op for providers without a load API.
   */
  async warm(modelRef: string | undefined, role: ModelRole = 'agent', signal?: AbortSignal): Promise<void> {
    let route: Route;
    try {
      route = await this.route({ modelRef, role });
    } catch {
      return;
    }
    const { provider, model } = route;
    // Cloud models have nothing to load locally; a warm-up request would only cost tokens.
    if (!provider.warm || model.remote) {
      return;
    }
    const last = this.warmed.get(model.id) ?? 0;
    // Throttled per model — unless the server says it is no longer loaded (evicted by another model, or keep_alive ran out).
    if (Date.now() - last < 4 * 60_000 && (!provider.loadedModels || (await this.residentModels(0)).has(model.id))) {
      return;
    }
    this.warmed.set(model.id, Date.now());
    const startedAt = Date.now();
    const cfg = getConfig();
    try {
      await provider.warm(model.modelId, { keepAlive: cfg.keepAlive || undefined, contextWindow: effectiveContextWindow(model, cfg.contextWindow) }, signal);
      this.residentAt = 0;
      this.log.debug(`warm: ${model.id} ready in ${Date.now() - startedAt} ms`);
    } catch (e) {
      this.warmed.delete(model.id);
      this.log.debug(`warm: ${model.id} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /**
   * Picks the model for a piece of work. Order: an explicit/session model → the role override / configured
   * default → the best model for the role on this machine. With routing enabled, image turns are redirected to
   * a vision model and an offline or disabled default falls back to the best available one instead of failing.
   */
  /** Models that stalled or could not be reached recently: skipped by the automatic picks until the entry expires. */
  private readonly unresponsive = new Map<string, number>();

  /**
   * The configured local Ollama a pick needs that did not answer the last discovery: the wanted model's own provider,
   * or (for Auto, or a wanted model nobody serves) the first one when no local model is available at all.
   */
  private stoppedLocalServer(wanted: string | undefined, models: ModelInfo[]): ProviderConfig | undefined {
    const providers = getConfig().providers;
    const stopped = providers.filter((p) => p.enabled !== false && p.type === 'ollama' && !isRemoteUrl(p.baseUrl) && !this.reachable.has(p.id));
    if (!stopped.length) {
      return undefined;
    }
    const pid = wanted && wanted.includes('/') ? wanted.slice(0, wanted.indexOf('/')) : undefined;
    const own = pid ? stopped.find((p) => p.id === pid) : undefined;
    if (own) {
      return own;
    }
    if (pid && providers.some((p) => p.id === pid && this.reachable.has(p.id))) {
      return undefined; // the wanted model's provider is up; it just does not have that model
    }
    return models.some((m) => !m.remote) ? undefined : stopped[0];
  }

  /**
   * When no local model is available because a configured local server is stopped, starts it and lists again.
   * For the places that list models for the user (`localpilot models`, the model picker); routing does this itself.
   */
  async listModelsStartingLocal(): Promise<ModelInfo[]> {
    const models = await this.listModels();
    const stopped = this.stoppedLocalServer(undefined, models);
    return stopped && (await this.startServer(stopped)) ? this.listModels(true) : models;
  }

  /** Starts a stopped local server once at a time; after a failure it is not tried again for a minute. */
  private startServer(p: ProviderConfig): Promise<boolean> {
    const start = this.startLocalServer;
    if (!start) {
      return Promise.resolve(false);
    }
    const failedAt = this.startFailedAt.get(p.id);
    if (failedAt && Date.now() - failedAt < 60_000) {
      return Promise.resolve(false);
    }
    let run = this.starting.get(p.id);
    if (!run) {
      this.log.info(`route: ${p.id} (${p.baseUrl}) is not answering — starting it`);
      run = start(p)
        .catch((e: unknown) => {
          this.log.warn(`route: could not start ${p.id}: ${e instanceof Error ? e.message : String(e)}`);
          return false;
        })
        .then((ok) => {
          this.starting.delete(p.id);
          if (ok) {
            this.startFailedAt.delete(p.id);
            this.invalidate();
          } else {
            this.startFailedAt.set(p.id, Date.now());
          }
          return ok;
        });
      this.starting.set(p.id, run);
    }
    return run;
  }

  /** Keep the router away from `modelId` for a while (a subagent fell back from it). Explicit choices still work. */
  markUnresponsive(modelId: string, ms = 10 * 60_000): void {
    this.unresponsive.set(modelId, Date.now() + ms);
    this.log.warn(`route: ${modelId} marked unresponsive for ${Math.round(ms / 60_000)} min — automatic picks skip it`);
  }

  private responsive(models: ModelInfo[]): ModelInfo[] {
    const now = Date.now();
    for (const [id, until] of this.unresponsive) {
      if (until <= now) {
        this.unresponsive.delete(id);
      }
    }
    return this.unresponsive.size ? models.filter((m) => !this.unresponsive.has(m.id)) : models;
  }

  async route(req: RouteRequest): Promise<Route> {
    const cfg = getConfig();
    const role = req.role ?? 'agent';
    let models = await this.listModels(req.fresh && (await this.installedChanged()));
    const roleOverride =
      role === 'completion' ? cfg.inlineCompletion.model : role === 'vision' ? cfg.routing.vision : role === 'reasoning' ? cfg.routing.reasoning : role === 'fast' && cfg.routing.fast !== 'session' ? cfg.routing.fast : undefined;
    const wanted = req.modelRef || roleOverride || cfg.defaultModel;
    // A local server that is installed but stopped is started, rather than failing the run or quietly falling back
    // to another model, which may be a cloud one.
    if (!models.some((m) => m.id === wanted || m.modelId === wanted)) {
      const stopped = this.stoppedLocalServer(wanted, models);
      if (stopped && (await this.startServer(stopped))) {
        models = await this.listModels(true);
      }
    }
    const healthy = this.responsive(models);
    const [profile, resident] = await Promise.all([getSystemProfile().catch(() => undefined), cfg.routing.enabled ? this.residentModels() : Promise.resolve(new Set<string>() as ReadonlySet<string>)]);
    const usage = cfg.routing.enabled ? this.usageBonus : undefined;
    // Among comparable models an automatic pick takes one already in memory: no weight load before the first token.
    const bonus: UsageBonus | undefined = cfg.routing.enabled ? (m, r) => (usage ? clampBonus(usage(m, r)) : 0) + (resident.has(m.id) ? RESIDENT_BONUS : 0) : undefined;
    const find = (ref?: string) => (ref ? models.find((m) => m.id === ref || m.modelId === ref) : undefined);

    let model = find(wanted);
    let reason: string | undefined;
    let fallback = false;

    if (!model && wanted && wanted.includes('/')) {
      // A reachable provider that lists no models (no /models endpoint) may still serve the referenced model;
      // one that lists models but not this one, or that is offline, does not — fall back below instead.
      const providerId = wanted.slice(0, wanted.indexOf('/'));
      const listsModels = models.some((m) => m.providerId === providerId);
      const unlisted = listsModels || !this.reachable.has(providerId) ? undefined : this.unlisted(wanted, cfg.contextWindow > 0 ? cfg.contextWindow : 32768, cfg.maxOutputTokens);
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
        const vision = find(cfg.routing.vision) ?? pickForRole(models, 'vision', profile, false, bonus);
        if (vision?.supportsVision) {
          reason = `${model.name} cannot see images — using ${vision.name} for this turn`;
          model = vision;
        }
      } else if (role === 'completion' && !req.modelRef && !roleOverride) {
        // No explicit completion model: prefer a small FIM model over the (usually larger) default.
        const fim = pickForRole(models, 'completion', profile, false, bonus);
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
        // Read-only subagents: a small tool-capable model answers faster and leaves memory for the main model —
        // unless it is not loaded and would not fit next to what is, then the model in memory does the job.
        const small = pickForRole(healthy, 'fast', profile, false, bonus);
        const fast = small && preferResident(small, healthy, 'fast', resident, profile, bonus, this.residentGb);
        if (fast && fast.id !== model.id && fast.supportsTools) {
          reason = fast === small ? `Read-only subagent — using ${fast.name}` : `Read-only subagent — using ${fast.name}, already in memory (${small.name} would not fit alongside)`;
          model = fast;
        }
      }
    }
    if (!model && role === 'fast') {
      const small = pickForRole(healthy, 'fast', profile, false, bonus);
      model = small && preferResident(small, healthy, 'fast', resident, profile, bonus, this.residentGb);
    }
    if (!model) {
      model = pickForRole(healthy, role, profile, req.needsVision, bonus) ?? pickForRole(healthy, 'agent', profile, false, bonus) ?? pickForRole(models, 'agent', profile, false, bonus);
    }
    if (!model) {
      throw new Error(
        'No local models found. Run "LocalPilot: Set up models automatically", start Ollama (`ollama serve`), LM Studio, llama.cpp or vLLM, or configure `localpilot.providers`.'
      );
    }
    // A model on this machine was asked for: when its server is down, falling back to a cloud model would send the
    // code off the machine without the user choosing that. Say what is wrong instead.
    const wantedPid = wanted && wanted.includes('/') ? wanted.slice(0, wanted.indexOf('/')) : undefined;
    const wantedCfg = wantedPid ? cfg.providers.find((p) => p.id === wantedPid) : undefined;
    if (fallback && model.remote && wantedCfg && !isCloudProvider(wantedCfg)) {
      const failed = this.startFailedAt.has(wantedCfg.id);
      throw new Error(
        `${wanted.slice(wantedPid!.length + 1)} runs on ${wantedCfg.displayName ?? wantedCfg.id} (${wantedCfg.baseUrl}), which is not ${failed ? 'running and could not be started' : 'answering'}. Start it, or pick another model — LocalPilot does not switch a local model to a cloud one on its own.`
      );
    }
    // Parallel work: a saturated model makes every extra run queue behind the others, so Auto picks and workers
    // that only inherited a model move to a comparable idle one that fits in memory alongside (the user's
    // explicit choice for a chat is never second-guessed — callers pass `spread` only when it was not one).
    let spread = false;
    if (cfg.routing.enabled && cfg.routing.parallelModels !== false && req.spread && req.load) {
      const alt = pickAlternative(healthy, model, role, req.load, profile, req.needsVision, bonus, resident, this.residentGb);
      if (alt) {
        const n = req.load.assigned.get(model.id) ?? 0;
        reason = `${model.name} is busy with ${n} other request${n === 1 ? '' : 's'} — running this on ${alt.name} alongside`;
        model = alt;
        spread = true;
      }
    }
    const provider = this.providers.get(model.providerId);
    if (!provider) {
      throw new Error(`Provider ${model.providerId} not configured`);
    }
    req.load?.reserve?.(model.id);
    const key = `${role}|${reason}`;
    if (reason && !(fallback && this.noted.has(key))) {
      this.log.info(`route(${role}): ${reason}`);
      if (fallback) {
        this.noted.add(key);
      }
    }
    return { provider, model, reason, fallback, spread };
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
    this.stopAutoRefresh();
    this.disposables.forEach((d) => d.dispose());
    this._onDidChange.dispose();
    this._onDidRemoveModels.dispose();
  }
}

export function createProvider(cfg: ProviderConfig): LLMProvider {
  return cfg.type === 'ollama' ? new OllamaProvider(cfg) : cfg.type === 'anthropic' ? new AnthropicProvider(cfg) : new OpenAICompatProvider(cfg);
}

/**
 * Scores a model for a role on this machine. Capability and family matter most; among comparable models the
 * one that fits in memory wins, and for completions smaller is better (latency).
 */
export function scoreForRole(m: ModelInfo, role: ModelRole, profile?: SystemProfile, bonus?: UsageBonus): number {
  const n = m.modelId.toLowerCase();
  if (/embed|rerank|whisper/.test(n)) {
    return -100;
  }
  return baseScore(m, n, role, profile) + (bonus ? clampBonus(bonus(m, role)) : 0);
}

/** Learned usage never outweighs a hard capability (tools, vision, FIM): those terms are 20–60 points. */
const MAX_USAGE_BONUS = 12;
/**
 * Score points for a model already loaded in memory: enough to break ties between comparable models, too little to
 * keep Auto on a small resident model when a clearly better one fits (a 7B vs 32B differs by ~3 points on size alone).
 */
const RESIDENT_BONUS = 1.5;
function clampBonus(b: number): number {
  return Number.isFinite(b) ? Math.max(-MAX_USAGE_BONUS, Math.min(MAX_USAGE_BONUS, b)) : 0;
}

/** Enough that any usable local model outranks a cloud one, small enough that a cloud model still beats "nothing" (-50). */
const REMOTE_PENALTY = 30;

function baseScore(m: ModelInfo, n: string, role: ModelRole, profile?: SystemProfile): number {
  const cat = lookupCatalog(m);
  const gb = modelFootprintGb(m);
  const fit = profile && gb !== undefined ? (gb <= profile.modelBudgetGb ? 1 : gb <= profile.modelBudgetGb * 1.25 ? 0 : -1) : 0.5;
  let s = fit * 8;
  // Automatic picks keep code on this machine: a cloud model is chosen only when no comparable local one is available
  // (selecting it explicitly, as the default or in the picker, always works).
  s -= m.remote ? REMOTE_PENALTY : 0;
  // colibri streaming experts from disk: minutes of prefill and ~1 tok/s decode. Worth it for one careful answer
  // (Plan mode), too slow for agent loops, chatty read-only subagents and ghost text.
  if (streamsFromDisk(m, profile?.modelBudgetGb)) {
    s += role === 'reasoning' ? 2 : role === 'agent' || role === 'vision' ? -6 : -40;
  }
  if (role === 'vision') {
    s += m.supportsVision ? 30 : -50;
    // A vision model that can also call tools keeps the agent loop going after it looks at a screenshot.
    s += m.supportsTools ? 5 : 0;
    s += /gemma4|gemma-4|nemotron-3\.5-bolt/.test(n) ? 3 : 0;
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
    s += /coder|devstral|codestral|qwen2\.5|qwen3|llama3|mistral|gemma|phi|nemotron/.test(n) ? 3 : 0;
    s -= /base$|-base\b|:.*base/.test(n) ? 15 : 0;
    s -= /r1|reason|think|vl|llava|vision|embed/.test(n) ? 10 : 0;
  }
  if (role === 'agent' || role === 'reasoning') {
    s += m.supportsTools ? 10 : 0;
    s += /coder|devstral|codestral|gpt-oss|qwen3|mistral-small/.test(n) ? 4 : 0;
    // Frontier-class models (tools + vision + thinking) beat older coder tunes of the same size. Recognised by
    // capability as well as by name, so a newer family (qwen3.x with vision, …) is not outranked by a smaller one.
    s += /gemma4|gemma-4|nemotron-3\.5-bolt/.test(n) || (m.supportsTools && m.supportsVision) ? 7 : 0;
    s += /qwen|llama|mistral|gemma|deepseek|phi|gpt-oss|nemotron/.test(n) ? 2 : 0;
    s -= /base$|-base\b|:.*base/.test(n) ? 8 : 0;
    s -= /vl|llava|vision/.test(n) ? 4 : 0;
    // Bigger is better for agent quality as long as it fits.
    const b = m.remote ? 32 : cat?.variant.paramsB ?? (gb !== undefined ? gb / 0.72 : 7);
    s += Math.min(b, 32) / 8;
    if (role === 'reasoning') {
      s += /r1|qwen3|gpt-oss|gemma4|gemma-4|nemotron-3\.5|think|reason/.test(n) ? 6 : 0;
    }
  }
  return s;
}

/** Best enabled model for a role, or undefined when nothing meets the hard constraints (e.g. no vision model). */
export function pickForRole(models: ModelInfo[], role: ModelRole, profile?: SystemProfile, needsVision?: boolean, bonus?: UsageBonus): ModelInfo | undefined {
  const pool = needsVision || role === 'vision' ? models.filter((m) => m.supportsVision) : models;
  const score = new Map(pool.map((m) => [m, scoreForRole(m, role, profile, bonus)]));
  const best = (list: ModelInfo[]) => {
    const top = [...list].sort((a, b) => score.get(b)! - score.get(a)!)[0];
    return top && score.get(top)! > -50 ? top : undefined;
  };
  // Automatic picks keep code on this machine: any usable local model wins, and a cloud one is chosen only when
  // there is none. A rule, not a score: on a small machine a tight local model lost its memory points and a cloud
  // model (which needs no memory here) gained them, enough to cancel REMOTE_PENALTY.
  return best(pool.filter((m) => !m.remote)) ?? best(pool.filter((m) => m.remote));
}

/**
 * Helper roles (read-only subagents, the auto-mode reviewer): when `pick` is not in memory and loading it next to the
 * models that are would exceed this machine's model budget, use the best resident model that can do the job. Loading
 * a second model there means swapping, which costs far more time than the smaller model saves.
 */
export function preferResident(pick: ModelInfo, models: ModelInfo[], role: ModelRole, resident: ReadonlySet<string>, profile?: SystemProfile, bonus?: UsageBonus, residentGb: ReadonlyMap<string, number> = new Map()): ModelInfo {
  if (!profile || !resident.size || resident.has(pick.id)) {
    return pick;
  }
  const loaded = models.filter((m) => resident.has(m.id));
  // What the server reports for a loaded model (context cache included) beats the estimate from its weights.
  const loadedGb = [...resident].reduce((sum, id) => sum + (residentGb.get(id) ?? modelFootprintGb(models.find((m) => m.id === id) ?? ({} as ModelInfo)) ?? 0), 0);
  const gb = modelFootprintGb(pick);
  if (gb === undefined || loadedGb + gb <= profile.modelBudgetGb) {
    return pick;
  }
  return pickForRole(loaded.filter((m) => !pick.supportsTools || m.supportsTools), role, profile, false, bonus) ?? pick;
}

/** A model is saturated when as many runs are assigned to it as it can serve at once (one, if it is known to be serial). */
export function isSaturated(model: ModelInfo, load: ModelLoad): boolean {
  const n = load.assigned.get(model.id) ?? 0;
  const capacity = model.parallelSlots ?? (load.serial.has(model.id) ? 1 : load.slots);
  return n >= Math.max(1, capacity);
}

/** Within this many score points of the intended model a candidate counts as comparable for the role. */
const COMPARABLE_SCORE_GAP = 8;
/** …and, when sizes are known, at least this fraction of its parameters: the score's size term is too flat to keep a 1B model away from a 32B one. */
const COMPARABLE_SIZE_RATIO = 1 / 3;

function paramsB(m: ModelInfo): number | undefined {
  return lookupCatalog(m)?.variant.paramsB ?? (m.parameterSize ? parameterSizeB(m.parameterSize) : undefined) ?? parameterSizeB(m.modelId);
}

/**
 * When `chosen` is saturated, the best comparable model that is not: same hard capabilities (tools, vision when
 * needed), a role score within a few points of the intended one, the fewest runs already on it, and — when
 * footprints are known — small enough to sit in memory next to the models already in use, so a second model does
 * not evict the first and make both slower. Undefined when nothing qualifies: the caller then queues as before.
 */
export function pickAlternative(
  models: ModelInfo[],
  chosen: ModelInfo,
  role: ModelRole,
  load: ModelLoad,
  profile?: SystemProfile,
  needsVision?: boolean,
  bonus?: UsageBonus,
  resident: ReadonlySet<string> = new Set(),
  residentGb: ReadonlyMap<string, number> = new Map()
): ModelInfo | undefined {
  if (!isSaturated(chosen, load)) {
    return undefined;
  }
  const scoreOf = (m: ModelInfo) => scoreForRole(m, role, profile, bonus);
  const floor = scoreOf(chosen) - COMPARABLE_SCORE_GAP;
  const chosenB = paramsB(chosen);
  // Memory already committed: every model loaded right now (at the size its server reports, context cache included)
  // and every model with a run on it, the chosen one included.
  const sizeOf = (id: string) => residentGb.get(id) ?? modelFootprintGb(models.find((m) => m.id === id) ?? ({} as ModelInfo)) ?? 0;
  const committed = new Set([chosen.id, ...resident, ...models.filter((m) => (load.assigned.get(m.id) ?? 0) > 0).map((m) => m.id)]);
  const committedGb = [...committed].reduce((sum, id) => sum + sizeOf(id), 0);
  const candidates = models
    .filter((m) => m.id !== chosen.id && !isSaturated(m, load))
    .filter((m) => (!chosen.supportsTools || m.supportsTools) && (!needsVision || m.supportsVision))
    .filter((m) => scoreOf(m) >= floor && scoreOf(m) > -50)
    .filter((m) => {
      const b = paramsB(m);
      return chosenB === undefined || b === undefined || b >= chosenB * COMPARABLE_SIZE_RATIO;
    })
    .filter((m) => {
      if (!profile) {
        return true; // no machine profile to judge by
      }
      // A loaded model adds no weights, but it still has to fit: two big models answering at once on a machine that
      // is already over its budget is what runs it out of memory (Ollama dies mid-request). Then the run queues.
      const extra = committed.has(m.id) ? 0 : residentGb.get(m.id) ?? modelFootprintGb(m);
      return extra === undefined || committedGb + extra <= profile.modelBudgetGb * 1.1;
    });
  // Fewest runs first; then a model already in memory (starts answering at once), then the better score.
  const loaded = (m: ModelInfo) => (resident.has(m.id) ? 1 : 0);
  return candidates.sort((a, b) => (load.assigned.get(a.id) ?? 0) - (load.assigned.get(b.id) ?? 0) || loaded(b) - loaded(a) || scoreOf(b) - scoreOf(a))[0];
}
