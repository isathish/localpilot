import * as cp from 'child_process';
import * as vscode from 'vscode';
import { DEFAULT_PROVIDERS, getConfig } from '../config';
import { ProviderConfig } from '../types';
import { CatalogPick, InstallTarget, installId, starterPlan } from './catalog';
import { createProvider, ProviderRegistry } from './registry';
import { getSystemProfile, SystemProfile } from './system';

export interface RuntimeStatus {
  target: InstallTarget;
  label: string;
  /** The CLI / app is installed on this machine. */
  installed: boolean;
  /** A server is answering, so models can be pulled and used right away. */
  running: boolean;
  /** Provider id that serves this runtime's models, when configured. */
  providerId?: string;
  baseUrl?: string;
  /** Models can be removed through LocalPilot. */
  canRemove: boolean;
  /** How to get it running when it is not. */
  hint?: string;
}

export type JobKind = 'pull' | 'remove' | 'start' | 'install-runtime' | 'setup';
export type JobStatus = 'running' | 'done' | 'error' | 'cancelled';

export interface ModelJob {
  id: string;
  kind: JobKind;
  target: InstallTarget;
  /** Model reference on the runtime (`qwen2.5-coder:7b`, `ai/qwen3`, HF repo) or a label for runtime jobs. */
  model: string;
  status: JobStatus;
  /** 0..1, or -1 when indeterminate. */
  progress: number;
  detail: string;
  error?: string;
  startedAt: number;
  finishedAt?: number;
}

export type AutoSetupResult =
  | { status: 'already'; models: number }
  | { status: 'installed'; target: InstallTarget; agent: string; completion?: string; vision?: string }
  | { status: 'needs-runtime'; runtimes: RuntimeStatus[] }
  | { status: 'cancelled' }
  | { status: 'error'; error: string };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function which(cmd: string, args: string[] = ['--version'], timeoutMs = 4000): Promise<boolean> {
  return new Promise((resolve) => {
    let child: cp.ChildProcess;
    try {
      child = cp.spawn(cmd, args, { stdio: 'ignore', shell: process.platform === 'win32' });
    } catch {
      return resolve(false);
    }
    const t = setTimeout(() => {
      child.kill();
      resolve(false);
    }, timeoutMs);
    child.on('error', () => {
      clearTimeout(t);
      resolve(false);
    });
    child.on('close', (code) => {
      clearTimeout(t);
      resolve(code === 0);
    });
  });
}

/** Platform install command for Ollama, run in a visible terminal so the user sees what happens. */
export function ollamaInstallCommand(platform: NodeJS.Platform = process.platform): { command: string; note: string } {
  if (platform === 'darwin') {
    return { command: 'brew install --cask ollama || (echo "Homebrew not found — download Ollama from https://ollama.com/download"; open https://ollama.com/download)', note: 'Uses Homebrew when available, otherwise opens the download page.' };
  }
  if (platform === 'win32') {
    return { command: 'winget install --id Ollama.Ollama -e --accept-source-agreements --accept-package-agreements', note: 'Uses winget (Windows 10/11).' };
  }
  return { command: 'curl -fsSL https://ollama.com/install.sh | sh', note: 'Official install script (asks for sudo).' };
}

/**
 * Installs, removes and auto-provisions local models across runtimes, and keeps a job list for the UI.
 * Ollama is driven through its HTTP API; Docker Model Runner and LM Studio through their CLIs.
 */
export class ModelManager implements vscode.Disposable {
  private readonly jobs = new Map<string, ModelJob>();
  private readonly aborts = new Map<string, AbortController>();
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;
  private setupRunning = false;

  constructor(private readonly registry: ProviderRegistry, private readonly log: vscode.LogOutputChannel) {}

  get allJobs(): ModelJob[] {
    return [...this.jobs.values()].sort((a, b) => b.startedAt - a.startedAt);
  }

  get activeJobs(): ModelJob[] {
    return this.allJobs.filter((j) => j.status === 'running');
  }

  clearFinished(): void {
    for (const [id, j] of this.jobs) {
      if (j.status !== 'running') {
        this.jobs.delete(id);
      }
    }
    this._onDidChange.fire();
  }

  cancel(jobId: string): void {
    this.aborts.get(jobId)?.abort();
  }

  // ------------------------------------------------------------------ runtimes

  /** Which runtimes exist on this machine and whether they are serving. */
  async detectRuntimes(): Promise<RuntimeStatus[]> {
    const cfg = getConfig();
    const providers = [...cfg.providers];
    const ollamaCfg = providers.find((p) => p.type === 'ollama' && p.enabled !== false) ?? DEFAULT_PROVIDERS.find((p) => p.type === 'ollama')!;
    const dockerCfg = providers.find((p) => /:12434\//.test(p.baseUrl) || p.id === 'docker');
    const lmsCfg = providers.find((p) => /:1234\//.test(p.baseUrl) || p.id === 'lmstudio');
    const health = (c?: ProviderConfig) => (c ? createProvider(c).healthCheck().catch(() => false) : Promise.resolve(false));
    const [ollamaBin, ollamaUp, dockerModel, dockerUp, lms, lmsUp] = await Promise.all([
      which('ollama'),
      health(ollamaCfg),
      which('docker', ['model', 'version']),
      health(dockerCfg),
      which('lms'),
      health(lmsCfg),
    ]);
    const plat = process.platform;
    return [
      {
        target: 'ollama',
        label: 'Ollama',
        installed: ollamaBin || ollamaUp,
        running: ollamaUp,
        providerId: ollamaCfg.id,
        baseUrl: ollamaCfg.baseUrl,
        canRemove: true,
        hint: ollamaUp ? undefined : ollamaBin ? 'Installed but not running — LocalPilot can start it.' : `Not installed — ${plat === 'darwin' ? 'brew install --cask ollama' : plat === 'win32' ? 'winget install Ollama.Ollama' : 'curl -fsSL https://ollama.com/install.sh | sh'}`,
      },
      {
        target: 'docker',
        label: 'Docker Model Runner',
        installed: dockerModel || dockerUp,
        running: dockerUp,
        providerId: dockerCfg?.id,
        baseUrl: dockerCfg?.baseUrl,
        canRemove: true,
        hint: dockerUp ? undefined : dockerModel ? 'Enable host access: docker desktop enable model-runner --tcp=12434' : 'Needs Docker Desktop 4.40+ (or docker model install-runner).',
      },
      {
        target: 'lmstudio',
        label: 'LM Studio',
        installed: lms || lmsUp,
        running: lmsUp,
        providerId: lmsCfg?.id,
        baseUrl: lmsCfg?.baseUrl,
        canRemove: false,
        hint: lmsUp ? undefined : lms ? 'Start the server: lms server start' : 'Install LM Studio and run it once to get the lms CLI.',
      },
    ];
  }

  // ------------------------------------------------------------------ jobs

  private start(kind: JobKind, target: InstallTarget, model: string, detail = 'Starting…'): ModelJob {
    const job: ModelJob = { id: `${kind}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, kind, target, model, status: 'running', progress: -1, detail, startedAt: Date.now() };
    this.jobs.set(job.id, job);
    this.aborts.set(job.id, new AbortController());
    this._onDidChange.fire();
    return job;
  }

  private update(job: ModelJob, patch: Partial<ModelJob>): void {
    Object.assign(job, patch);
    this._onDidChange.fire();
  }

  private finish(job: ModelJob, status: JobStatus, error?: string): ModelJob {
    this.update(job, { status, error, finishedAt: Date.now(), detail: status === 'done' ? 'Done' : status === 'cancelled' ? 'Cancelled' : error ?? 'Failed', progress: status === 'done' ? 1 : job.progress });
    this.aborts.delete(job.id);
    this.log.info(`model job ${job.kind} ${job.target}/${job.model}: ${status}${error ? ` — ${error}` : ''}`);
    if (status === 'done' && (job.kind === 'pull' || job.kind === 'remove')) {
      this.registry.invalidate();
      void this.registry.listModels(true).then(() => this._onDidChange.fire());
    }
    return job;
  }

  /** Runs a CLI, streaming stdout/stderr lines into the job's detail and percentage when present. */
  private runCli(job: ModelJob, cmd: string, args: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
      const signal = this.aborts.get(job.id)!.signal;
      let child: cp.ChildProcess;
      try {
        child = cp.spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32' });
      } catch (e) {
        return reject(e);
      }
      let lastErr = '';
      const onData = (d: Buffer) => {
        // Progress bars use \r; take the last fragment of the chunk.
        const text = String(d).replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
        const line = text.split(/[\r\n]/).map((s) => s.trim()).filter(Boolean).pop();
        if (!line) {
          return;
        }
        lastErr = line;
        const pct = /(\d{1,3}(?:\.\d+)?)\s*%/.exec(line);
        this.update(job, { detail: line.slice(0, 160), progress: pct ? Math.min(1, Number(pct[1]) / 100) : job.progress });
      };
      child.stdout?.on('data', onData);
      child.stderr?.on('data', onData);
      const onAbort = () => child.kill();
      signal.addEventListener('abort', onAbort, { once: true });
      child.on('error', (e) => {
        signal.removeEventListener('abort', onAbort);
        reject(e);
      });
      child.on('close', (code) => {
        signal.removeEventListener('abort', onAbort);
        if (signal.aborted) {
          return reject(new Error('cancelled'));
        }
        code === 0 ? resolve() : reject(new Error(lastErr || `${cmd} exited with code ${code}`));
      });
    });
  }

  private ollamaBase(providerId?: string): { id: string; baseUrl: string; headers: Record<string, string> } {
    const cfg = getConfig();
    const c = (providerId ? cfg.providers.find((p) => p.id === providerId && p.type === 'ollama') : undefined) ?? cfg.providers.find((p) => p.type === 'ollama') ?? DEFAULT_PROVIDERS.find((p) => p.type === 'ollama')!;
    return { id: c.id, baseUrl: c.baseUrl.replace(/\/+$/, ''), headers: c.apiKey ? { authorization: `Bearer ${c.apiKey}` } : {} };
  }

  /** Downloads a model onto a runtime. Resolves with the finished job (status tells success). */
  async pull(target: InstallTarget, model: string, providerId?: string): Promise<ModelJob> {
    const dup = this.activeJobs.find((j) => j.kind === 'pull' && j.target === target && j.model === model);
    if (dup) {
      return dup;
    }
    const job = this.start('pull', target, model, 'Connecting…');
    try {
      if (target === 'ollama') {
        await this.ollamaPull(job, providerId);
      } else if (target === 'docker') {
        await this.runCli(job, 'docker', ['model', 'pull', model]);
      } else {
        await this.runCli(job, 'lms', ['get', model, '--yes']);
      }
      return this.finish(job, 'done');
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return this.finish(job, /cancel|abort/i.test(msg) ? 'cancelled' : 'error', /cancel|abort/i.test(msg) ? undefined : msg);
    }
  }

  private async ollamaPull(job: ModelJob, providerId?: string): Promise<void> {
    const { baseUrl, headers } = this.ollamaBase(providerId);
    const signal = this.aborts.get(job.id)!.signal;
    const res = await fetch(`${baseUrl}/api/pull`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ model: job.model, stream: true }), signal });
    if (!res.ok || !res.body) {
      throw new Error(`Ollama answered HTTP ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    const layers = new Map<string, { total: number; completed: number }>();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      buf += dec.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) {
          continue;
        }
        let msg: { status?: string; digest?: string; total?: number; completed?: number; error?: string };
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.error) {
          throw new Error(msg.error);
        }
        if (msg.digest && msg.total) {
          layers.set(msg.digest, { total: msg.total, completed: msg.completed ?? 0 });
        }
        let total = 0;
        let completed = 0;
        for (const l of layers.values()) {
          total += l.total;
          completed += l.completed;
        }
        const gb = (n: number) => `${(n / 1024 ** 3).toFixed(2)} GB`;
        this.update(job, {
          progress: total ? completed / total : -1,
          detail: total && msg.digest ? `${msg.status ?? 'downloading'} · ${gb(completed)} / ${gb(total)}` : msg.status ?? 'working…',
        });
      }
    }
  }

  /** Deletes a model from a runtime (Ollama and Docker Model Runner only). */
  async remove(target: InstallTarget, model: string, providerId?: string): Promise<ModelJob> {
    const job = this.start('remove', target, model, 'Removing…');
    try {
      if (target === 'ollama') {
        const { baseUrl, headers } = this.ollamaBase(providerId);
        const res = await fetch(`${baseUrl}/api/delete`, { method: 'DELETE', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ model }), signal: this.aborts.get(job.id)!.signal });
        if (!res.ok) {
          throw new Error(`Ollama answered HTTP ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
        }
      } else if (target === 'docker') {
        await this.runCli(job, 'docker', ['model', 'rm', model]);
      } else {
        throw new Error('LM Studio models are removed from the LM Studio app (My Models). You can disable the model here instead.');
      }
      return this.finish(job, 'done');
    } catch (e) {
      return this.finish(job, 'error', e instanceof Error ? e.message : String(e));
    }
  }

  // ------------------------------------------------------------------ Ollama lifecycle

  /** Starts the Ollama server (menu-bar app on macOS/Windows, `ollama serve` otherwise) and waits until it answers. */
  async startOllama(): Promise<ModelJob> {
    const job = this.start('start', 'ollama', 'Ollama', 'Starting Ollama…');
    const { baseUrl } = this.ollamaBase();
    const up = () => createProvider({ id: 'probe', type: 'ollama', baseUrl }).healthCheck().catch(() => false);
    try {
      if (await up()) {
        return this.finish(job, 'done');
      }
      let launched = false;
      if (process.platform === 'darwin') {
        launched = await which('open', ['-a', 'Ollama'], 6000);
      } else if (process.platform === 'win32') {
        launched = await which('cmd', ['/c', 'start', '', 'ollama', 'app'], 6000);
      }
      if (!launched) {
        try {
          const child = cp.spawn('ollama', ['serve'], { detached: true, stdio: 'ignore', shell: process.platform === 'win32' });
          child.on('error', () => undefined);
          child.unref();
          launched = true;
        } catch {
          launched = false;
        }
      }
      if (!launched) {
        throw new Error('Could not launch Ollama. Install it from https://ollama.com/download');
      }
      for (let i = 0; i < 40; i++) {
        if (this.aborts.get(job.id)?.signal.aborted) {
          return this.finish(job, 'cancelled');
        }
        await sleep(500);
        if (await up()) {
          return this.finish(job, 'done');
        }
        this.update(job, { detail: `Waiting for Ollama at ${baseUrl}… (${((i + 1) / 2).toFixed(0)}s)` });
      }
      throw new Error(`Ollama did not answer at ${baseUrl} within 20s`);
    } catch (e) {
      return this.finish(job, 'error', e instanceof Error ? e.message : String(e));
    }
  }

  /**
   * Opens a terminal running the platform's Ollama installer and waits (up to 10 minutes) for the binary to
   * appear, then starts the server. The user watches and confirms any sudo/UAC prompts.
   */
  async installOllama(): Promise<ModelJob> {
    const job = this.start('install-runtime', 'ollama', 'Ollama', 'Installing in the terminal…');
    const { command } = ollamaInstallCommand();
    const term = vscode.window.createTerminal({ name: 'LocalPilot · install Ollama' });
    term.show(true);
    term.sendText(command);
    try {
      for (let i = 0; i < 200; i++) {
        if (this.aborts.get(job.id)?.signal.aborted) {
          return this.finish(job, 'cancelled');
        }
        await sleep(3000);
        if (await which('ollama')) {
          this.update(job, { detail: 'Installed — starting the server…' });
          const started = await this.startOllama();
          if (started.status !== 'done') {
            throw new Error(started.error ?? 'Ollama installed but failed to start');
          }
          return this.finish(job, 'done');
        }
        this.update(job, { detail: `Waiting for the installer to finish… (${((i + 1) * 3) | 0}s)` });
      }
      throw new Error('Gave up waiting for the Ollama installer. Run it manually and try again.');
    } catch (e) {
      return this.finish(job, 'error', e instanceof Error ? e.message : String(e));
    }
  }

  // ------------------------------------------------------------------ auto-setup

  /** Starter picks for this machine, as runtime-specific ids. */
  async plan(target?: InstallTarget): Promise<{ profile: SystemProfile; target: InstallTarget; agent: CatalogPick; completion?: CatalogPick; vision?: CatalogPick }> {
    const profile = await getSystemProfile();
    const p = starterPlan(profile);
    return { profile, target: target ?? 'ollama', ...p };
  }

  /**
   * Gets the machine from "no models" to "working agent" with the smallest sensible models:
   * pick a running runtime (start Ollama if installed; ask to install it otherwise), pull the starter plan, and
   * set the default + completion models. Idempotent — already-installed models are skipped.
   */
  async autoSetup(opts: { installRuntime?: boolean; target?: InstallTarget; force?: boolean } = {}): Promise<AutoSetupResult> {
    if (this.setupRunning) {
      return { status: 'error', error: 'Setup is already running' };
    }
    this.setupRunning = true;
    const job = this.start('setup', opts.target ?? 'ollama', 'Starter models', 'Checking installed models…');
    try {
      const existing = await this.registry.listModels(true);
      if (existing.length && !opts.force) {
        this.finish(job, 'done');
        return { status: 'already', models: existing.length };
      }
      this.update(job, { detail: 'Looking for Ollama, Docker Model Runner and LM Studio…' });
      let runtimes = await this.detectRuntimes();
      let target: InstallTarget | undefined = opts.target && runtimes.find((r) => r.target === opts.target && r.running) ? opts.target : undefined;
      target ??= runtimes.find((r) => r.target === 'ollama' && r.running)?.target ?? runtimes.find((r) => r.running && r.target !== 'lmstudio')?.target;
      if (!target) {
        const ollama = runtimes.find((r) => r.target === 'ollama')!;
        if (ollama.installed) {
          this.update(job, { detail: 'Starting Ollama…' });
          const started = await this.startOllama();
          if (started.status === 'done') {
            target = 'ollama';
          }
        } else if (opts.installRuntime) {
          this.update(job, { detail: 'Installing Ollama…' });
          const inst = await this.installOllama();
          if (inst.status === 'done') {
            target = 'ollama';
          } else if (inst.status === 'cancelled') {
            this.finish(job, 'cancelled');
            return { status: 'cancelled' };
          } else {
            throw new Error(inst.error ?? 'Ollama installation failed');
          }
        }
      }
      target ??= runtimes.find((r) => r.target === 'lmstudio' && r.running)?.target;
      if (!target) {
        this.finish(job, 'done');
        runtimes = await this.detectRuntimes();
        return { status: 'needs-runtime', runtimes };
      }
      await this.ensureProvider(target, runtimes);
      const plan = await this.plan(target);
      const providerId = runtimes.find((r) => r.target === target)?.providerId ?? (await this.detectRuntimes()).find((r) => r.target === target)?.providerId;
      const installed = await this.registry.listModels(true);
      const has = (ref: string) => installed.some((m) => m.providerId === providerId && (m.modelId === ref || m.modelId === `${ref}:latest` || m.modelId.endsWith(`/${ref}`) || m.modelId.endsWith(`/${ref}:latest`) || m.modelId.toLowerCase().includes(ref.split('/').pop()!.toLowerCase().replace(/-gguf$/, ''))));
      const steps: { role: 'agent' | 'completion' | 'vision'; pick: CatalogPick }[] = [{ role: 'agent', pick: plan.agent }];
      if (plan.completion) {
        steps.push({ role: 'completion', pick: plan.completion });
      }
      if (plan.vision) {
        steps.push({ role: 'vision', pick: plan.vision });
      }
      const result: Extract<AutoSetupResult, { status: 'installed' }> = { status: 'installed', target, agent: '' };
      for (const [i, step] of steps.entries()) {
        if (this.aborts.get(job.id)?.signal.aborted) {
          this.finish(job, 'cancelled');
          return { status: 'cancelled' };
        }
        const ref = installId(step.pick, target) ?? installId(step.pick, 'ollama')!;
        const label = `${step.pick.entry.name} ${step.pick.variant.tag}`;
        if (!has(ref)) {
          this.update(job, { detail: `Downloading ${label} (${step.pick.variant.gb} GB) — ${i + 1}/${steps.length}`, progress: -1 });
          const pulled = await this.pull(target, ref, providerId);
          if (pulled.status === 'cancelled') {
            this.finish(job, 'cancelled');
            return { status: 'cancelled' };
          }
          if (pulled.status !== 'done') {
            if (step.role === 'agent') {
              throw new Error(pulled.error ?? `Failed to download ${label}`);
            }
            this.log.warn(`auto-setup: optional ${step.role} model ${ref} failed: ${pulled.error}`);
            continue;
          }
        }
        const fresh = await this.registry.listModels(true);
        const info = fresh.find((m) => m.providerId === providerId && (m.modelId === ref || m.modelId === `${ref}:latest` || m.modelId.endsWith(`/${ref}`) || m.modelId.endsWith(`/${ref}:latest`))) ?? fresh.find((m) => has(ref) && m.modelId.toLowerCase().includes(ref.split('/').pop()!.toLowerCase().replace(/-gguf$/, '')));
        const id = info?.id ?? `${providerId}/${ref}`;
        if (step.role === 'agent') {
          result.agent = id;
        } else if (step.role === 'completion') {
          result.completion = id;
        } else {
          result.vision = id;
        }
      }
      const cfg = vscode.workspace.getConfiguration('localpilot');
      const current = cfg.get<string>('defaultModel', '');
      const all = await this.registry.listModels(true);
      if (!current || !all.some((m) => m.id === current)) {
        await cfg.update('defaultModel', result.agent, vscode.ConfigurationTarget.Global);
      }
      if (result.completion && !cfg.get<string>('inlineCompletion.model', '')) {
        await cfg.update('inlineCompletion.model', result.completion, vscode.ConfigurationTarget.Global);
      }
      if (result.vision && !cfg.get<string>('routing.vision', '')) {
        await cfg.update('routing.vision', result.vision, vscode.ConfigurationTarget.Global);
      }
      this.finish(job, 'done');
      return result;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.finish(job, 'error', msg);
      return { status: 'error', error: msg };
    } finally {
      this.setupRunning = false;
    }
  }

  /** Makes sure the runtime we are about to pull onto has an enabled provider entry so its models show up. */
  private async ensureProvider(target: InstallTarget, runtimes: RuntimeStatus[]): Promise<void> {
    const rt = runtimes.find((r) => r.target === target)!;
    const cfg = vscode.workspace.getConfiguration('localpilot');
    const list = cfg.get<ProviderConfig[]>('providers', DEFAULT_PROVIDERS);
    const existing = rt.providerId ? list.find((p) => p.id === rt.providerId) : undefined;
    if (existing && existing.enabled !== false) {
      return;
    }
    const next = existing ? list.map((p) => (p.id === existing.id ? { ...p, enabled: undefined } : p)) : [...list, target === 'ollama' ? DEFAULT_PROVIDERS.find((p) => p.type === 'ollama')! : target === 'docker' ? { id: 'docker', type: 'openai' as const, baseUrl: 'http://localhost:12434/engines/v1', displayName: 'Docker Model Runner' } : DEFAULT_PROVIDERS.find((p) => p.id === 'lmstudio')!];
    await cfg.update('providers', next.map((p) => (p.enabled === undefined ? Object.fromEntries(Object.entries(p).filter(([, v]) => v !== undefined)) : p)), vscode.ConfigurationTarget.Global);
    // Let the registry pick up the new provider before we list models.
    await sleep(50);
  }

  dispose(): void {
    for (const a of this.aborts.values()) {
      a.abort();
    }
    this._onDidChange.dispose();
  }
}
