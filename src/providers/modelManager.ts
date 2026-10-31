import * as cp from 'child_process';
import { createWriteStream } from 'fs';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { Readable, Transform } from 'stream';
import { pipeline } from 'stream/promises';
import * as vscode from 'vscode';
import { DEFAULT_PROVIDERS, forgetModel, getConfig } from '../config';
import { ProviderConfig } from '../types';
import { CatalogPick, InstallTarget, installId, starterPlan } from './catalog';
import { withTimeout } from './http';
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
      child = cp.spawn(cmd, args, { stdio: 'ignore', shell: process.platform === 'win32', windowsHide: true });
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

/** Where LocalPilot installs Ollama itself when no package manager / root is available (user-space, no sudo). */
export const USER_OLLAMA_DIR = path.join(os.homedir(), '.local', 'share', 'localpilot', 'ollama');

const OLLAMA_LOCATIONS: Record<string, string[]> = {
  win32: [
    `${process.env['LOCALAPPDATA'] ?? ''}\\Programs\\Ollama\\ollama.exe`,
    `${process.env['PROGRAMFILES'] ?? 'C:\\Program Files'}\\Ollama\\ollama.exe`,
  ],
  darwin: ['/usr/local/bin/ollama', '/opt/homebrew/bin/ollama', '/Applications/Ollama.app/Contents/Resources/ollama', path.join(os.homedir(), 'Applications/Ollama.app/Contents/Resources/ollama')],
  linux: ['/usr/local/bin/ollama', '/usr/bin/ollama', '/snap/bin/ollama', path.join(USER_OLLAMA_DIR, 'bin', 'ollama')],
};

/** Streams a download to disk with byte progress; follows redirects (ollama.com → GitHub releases). */
async function downloadFile(url: string, dest: string, onProgress: (done: number, total?: number) => void, signal?: AbortSignal): Promise<void> {
  const res = await fetch(url, { signal, redirect: 'follow' });
  if (!res.ok || !res.body) {
    throw new Error(`Download failed: HTTP ${res.status} for ${url}`);
  }
  const total = Number(res.headers.get('content-length')) || undefined;
  let done = 0;
  await fs.mkdir(path.dirname(dest), { recursive: true });
  const counter = new Transform({
    transform(chunk, _enc, cb) {
      done += (chunk as Buffer).length;
      onProgress(done, total);
      cb(null, chunk);
    },
  });
  await pipeline(Readable.fromWeb(res.body as import('stream/web').ReadableStream), counter, createWriteStream(dest));
}

function runProcess(cmd: string, args: string[], opts: { timeoutMs?: number; signal?: AbortSignal; cwd?: string } = {}): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve, reject) => {
    let out = '';
    let child: cp.ChildProcess;
    try {
      child = cp.spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], cwd: opts.cwd, windowsHide: true });
    } catch (e) {
      return reject(e);
    }
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`${path.basename(cmd)} timed out`));
    }, opts.timeoutMs ?? 10 * 60_000);
    const onAbort = () => child.kill();
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout?.on('data', (d) => (out += String(d)));
    child.stderr?.on('data', (d) => (out += String(d)));
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      resolve({ code, out });
    });
  });
}

/** `ollama` on PATH, or its well-known install location (a just-installed binary is not on this process's PATH yet). */
export async function findOllamaBinary(): Promise<string | undefined> {
  if (await which('ollama')) {
    return 'ollama';
  }
  for (const p of OLLAMA_LOCATIONS[process.platform] ?? OLLAMA_LOCATIONS.linux) {
    try {
      await fs.access(p);
      return p;
    } catch {
      /* next */
    }
  }
  return undefined;
}

/** Windows tray app ("ollama app.exe") that owns the server; looked up next to each known CLI location, PATH or not. */
async function findOllamaTrayApp(): Promise<string | undefined> {
  if (process.platform !== 'win32') {
    return undefined;
  }
  for (const p of OLLAMA_LOCATIONS.win32) {
    const app = path.join(path.dirname(p), 'ollama app.exe');
    try {
      await fs.access(app);
      return app;
    } catch {
      /* next */
    }
  }
  return undefined;
}

/**
 * `localhost` resolves to `::1` first on many Windows machines while Ollama listens on 127.0.0.1 only; a health
 * check that fails on the configured URL is retried on the IPv4 loopback so a running server is not reported down.
 */
export async function ollamaUp(baseUrl: string): Promise<boolean> {
  const probe = (url: string) => createProvider({ id: 'probe', type: 'ollama', baseUrl: url }).healthCheck().catch(() => false);
  if (await probe(baseUrl)) {
    return true;
  }
  return /\/\/localhost[:/]/i.test(baseUrl) ? probe(baseUrl.replace(/\/\/localhost/i, '//127.0.0.1')) : false;
}

/** Platform install command for Ollama, run in a visible terminal so the user sees what happens. */
export interface InstallScript {
  /** Script to run in a fresh terminal; prints a final "LocalPilot: Ollama ready" / "failed" line. */
  command: string;
  /** Shell to run it in (platform-appropriate, never the user's exotic default shell). */
  shellPath: string;
  shellArgs?: string[];
  note: string;
}

/**
 * Unattended Ollama installer per platform. Each script tries the package manager first and falls back to the
 * official download, so it completes on a fresh machine without any extra setup:
 * - macOS: Homebrew cask → else download Ollama-darwin.zip into /Applications; then launch the app (starts the server).
 * - Windows: winget → else download OllamaSetup.exe and run it silently; the installer starts the tray app.
 * - Linux: official install.sh via curl or wget (asks for sudo in the terminal); starts `ollama serve` if there is no systemd.
 */
export function ollamaInstallCommand(platform: NodeJS.Platform = process.platform, parallelSlots = 1): InstallScript {
  const slots = Math.max(1, Math.min(4, Math.round(parallelSlots || 1)));
  if (platform === 'darwin') {
    const script = [
      'set +e',
      'echo "LocalPilot: installing Ollama…"',
      'if command -v brew >/dev/null 2>&1; then brew install --cask ollama; fi',
      'if [ ! -d /Applications/Ollama.app ] && [ ! -d "$HOME/Applications/Ollama.app" ]; then',
      '  echo "LocalPilot: Homebrew not available or failed — downloading the official build"',
      '  curl -fL --progress-bar https://ollama.com/download/Ollama-darwin.zip -o /tmp/Ollama-darwin.zip && ditto -x -k /tmp/Ollama-darwin.zip /Applications && rm -f /tmp/Ollama-darwin.zip',
      'fi',
      `launchctl setenv OLLAMA_NUM_PARALLEL ${slots} 2>/dev/null || true`,
      'if [ -d /Applications/Ollama.app ] || [ -d "$HOME/Applications/Ollama.app" ]; then open -a Ollama && echo "LocalPilot: Ollama ready"; else echo "LocalPilot: Ollama install failed — download it from https://ollama.com/download"; fi',
    ].join('\n');
    return { command: script, shellPath: '/bin/bash', note: 'Homebrew cask when available, otherwise the official download into /Applications.' };
  }
  if (platform === 'win32') {
    const script = [
      '$ErrorActionPreference = "Continue"; Write-Host "LocalPilot: installing Ollama..."',
      '$ok = $false',
      'if (Get-Command winget -ErrorAction SilentlyContinue) { winget install --id Ollama.Ollama -e --accept-source-agreements --accept-package-agreements --silent --disable-interactivity; if ($LASTEXITCODE -eq 0 -or $LASTEXITCODE -eq -1978335189) { $ok = $true } }',
      'if (-not $ok) { Write-Host "LocalPilot: winget not available or failed - downloading the official installer"; $f = Join-Path $env:TEMP "OllamaSetup.exe"; Invoke-WebRequest -Uri "https://ollama.com/download/OllamaSetup.exe" -OutFile $f -UseBasicParsing; Start-Process -FilePath $f -ArgumentList "/VERYSILENT","/NORESTART","/SP-","/SUPPRESSMSGBOXES","/CLOSEAPPLICATIONS" -Wait; Remove-Item $f -ErrorAction SilentlyContinue }',
      '$ok = (Test-Path (Join-Path $env:LOCALAPPDATA "Programs\\Ollama\\ollama.exe")) -or (Test-Path (Join-Path $env:ProgramFiles "Ollama\\ollama.exe"))',
      `$env:OLLAMA_NUM_PARALLEL = "${slots}"; [Environment]::SetEnvironmentVariable("OLLAMA_NUM_PARALLEL", "${slots}", "User")`,
      '$app = Join-Path $env:LOCALAPPDATA "Programs\\Ollama\\ollama app.exe"; if (-not (Test-Path $app)) { $app = Join-Path $env:ProgramFiles "Ollama\\ollama app.exe" }; if ($ok -and (Test-Path $app)) { Start-Process -FilePath $app }',
      'if ($ok) { Write-Host "LocalPilot: Ollama ready" } else { Write-Host "LocalPilot: Ollama install failed - download it from https://ollama.com/download" }',
    ].join('; ');
    return { command: script, shellPath: 'powershell.exe', shellArgs: ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass'], note: 'winget when available, otherwise the official silent installer.' };
  }
  const script = [
    'set +e',
    'echo "LocalPilot: installing Ollama (the official script asks for sudo)…"',
    'if command -v curl >/dev/null 2>&1; then curl -fsSL https://ollama.com/install.sh | sh; elif command -v wget >/dev/null 2>&1; then wget -qO- https://ollama.com/install.sh | sh; else echo "LocalPilot: need curl or wget"; fi',
    'if command -v ollama >/dev/null 2>&1 || [ -x /usr/local/bin/ollama ]; then',
    `  if ! (command -v systemctl >/dev/null 2>&1 && systemctl is-active --quiet ollama 2>/dev/null); then (OLLAMA_NUM_PARALLEL=${slots} nohup ollama serve >/tmp/ollama.log 2>&1 &) ; fi`,
    '  echo "LocalPilot: Ollama ready"',
    'else echo "LocalPilot: Ollama install failed — see https://ollama.com/download/linux"; fi',
  ].join('\n');
  return { command: script, shellPath: '/bin/bash', note: 'Official install script (asks for sudo); starts the server when there is no systemd (e.g. WSL).' };
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
    const [ollamaBin, ollamaIsUp, dockerModel, dockerUp, lms, lmsUp] = await Promise.all([
      findOllamaBinary().then((b) => !!b),
      ollamaUp(ollamaCfg.baseUrl.replace(/\/+$/, '')),
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
        installed: ollamaBin || ollamaIsUp,
        running: ollamaIsUp,
        providerId: ollamaCfg.id,
        baseUrl: ollamaCfg.baseUrl,
        canRemove: true,
        hint: ollamaIsUp ? undefined : ollamaBin ? 'Installed but not running — LocalPilot can start it.' : `Not installed — ${plat === 'darwin' ? 'brew install --cask ollama' : plat === 'win32' ? 'winget install Ollama.Ollama' : 'curl -fsSL https://ollama.com/install.sh | sh'}`,
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
    if (status === 'done' && job.kind === 'pull') {
      // `remove` refreshes discovery itself before finishing.
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
        // `name` is what Ollama servers before 0.1.33 expect; newer ones read `model`.
        const res = await fetch(`${baseUrl}/api/delete`, { method: 'DELETE', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ model, name: model }), signal: withTimeout(30_000, this.aborts.get(job.id)!.signal) });
        if (res.status === 404) {
          this.update(job, { detail: 'Already removed' });
        } else if (!res.ok) {
          throw new Error(`Ollama answered HTTP ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
        }
      } else if (target === 'docker') {
        await this.runCli(job, 'docker', ['model', 'rm', model]);
      } else {
        throw new Error('LM Studio models are removed from the LM Studio app (My Models). You can disable the model here instead.');
      }
      // Real clean-up: the model is gone from the server, so nothing may keep pointing at it — default / completions /
      // routing choices and the disabled list are cleared, and discovery is refreshed before anyone reads the list again.
      const pid = providerId ?? this.providerIdFor(target);
      const cleared = pid ? await forgetModel(`${pid}/${model}`).catch(() => [] as string[]) : [];
      this.update(job, { detail: 'Refreshing model list…' });
      this.registry.invalidate();
      await this.registry.listModels(true).catch(() => []);
      const where = target === 'ollama' ? 'Ollama' : target === 'docker' ? 'Docker Model Runner' : target;
      void vscode.window.showInformationMessage(`Deleted ${model} from ${where}.${cleared.length ? ` It was your ${cleared.join(', ')} — switched back to automatic.` : ''}`);
      return this.finish(job, 'done');
    } catch (e) {
      return this.finish(job, 'error', e instanceof Error ? e.message : String(e));
    }
  }

  /** Provider id a runtime's models are listed under (for the `${provider}/${model}` ids used in settings). */
  private providerIdFor(target: InstallTarget): string | undefined {
    const providers = getConfig().providers;
    return target === 'ollama' ? providers.find((p) => p.type === 'ollama')?.id : target === 'docker' ? providers.find((p) => /:12434\//.test(p.baseUrl) || p.id === 'docker')?.id : providers.find((p) => /:1234\//.test(p.baseUrl) || p.id === 'lmstudio')?.id;
  }

  // ------------------------------------------------------------------ Ollama lifecycle

  /**
   * Environment for an Ollama server started by LocalPilot. Ollama answers one request per model at a time
   * unless `OLLAMA_NUM_PARALLEL` says otherwise, which would make parallel subagents queue behind each other.
   * Flash attention and a quantised KV cache (`localpilot.ollama.*`) shrink the cache, so the large windows agent
   * work needs load faster and stay on the GPU instead of spilling to the CPU. Ollama only quantises the cache with
   * flash attention on, so without it the cache type is left to the server.
   */
  static ollamaServerEnv(): Record<string, string> {
    const { flashAttention, kvCacheType } = getConfig().ollama;
    return {
      OLLAMA_NUM_PARALLEL: String(ModelManager.ollamaParallelSlots()),
      OLLAMA_FLASH_ATTENTION: flashAttention ? '1' : '0',
      ...(flashAttention ? { OLLAMA_KV_CACHE_TYPE: kvCacheType } : {}),
    };
  }

  /** Parallel slots to ask Ollama for: the configured subagent concurrency, clamped to what a local machine can hold. */
  static ollamaParallelSlots(): number {
    return Math.max(1, Math.min(4, Math.round(getConfig().parallel.maxConcurrency || 1)));
  }

  /** Starts the Ollama server (menu-bar app on macOS/Windows, `ollama serve` otherwise) with parallel slots and waits until it answers. */
  async startOllama(): Promise<ModelJob> {
    const job = this.start('start', 'ollama', 'Ollama', 'Starting Ollama…');
    const { baseUrl } = this.ollamaBase();
    const up = () => ollamaUp(baseUrl);
    try {
      if (await up()) {
        return this.finish(job, 'done');
      }
      const env = { ...process.env, ...ModelManager.ollamaServerEnv() };
      const bin = await findOllamaBinary();
      let launched = false;
      if (process.platform === 'darwin') {
        // The menu-bar app reads its environment from launchd, not from `open`.
        for (const [k, v] of Object.entries(ModelManager.ollamaServerEnv())) {
          await which('launchctl', ['setenv', k, v], 4000);
        }
        launched = await which('open', ['-a', 'Ollama'], 6000);
      } else if (process.platform === 'win32') {
        // The tray app owns the server on Windows. Prefer it even when `ollama` is on PATH — a bare `ollama serve`
        // next to a running tray app fails with "address already in use" and leaves a console window behind.
        const app = (bin && bin !== 'ollama' ? path.join(path.dirname(bin), 'ollama app.exe') : undefined) ?? (await findOllamaTrayApp());
        if (app) {
          launched = await fs.access(app).then(() => {
            const child = cp.spawn(app, [], { detached: true, stdio: 'ignore', env, windowsHide: true });
            child.on('error', () => undefined);
            child.unref();
            return true;
          }, () => false);
        }
      }
      if (!launched && bin) {
        try {
          const child = cp.spawn(bin, ['serve'], { detached: true, stdio: 'ignore', env, shell: process.platform === 'win32' && bin === 'ollama', windowsHide: true });
          child.on('error', () => undefined);
          child.unref();
          this.servePid = child.pid;
          launched = true;
        } catch {
          launched = false;
        }
      }
      if (!launched) {
        throw new Error('Could not launch Ollama. Install it from https://ollama.com/download');
      }
      // A first launch on Windows unpacks runtimes and may show a welcome window before the server listens.
      const waitMs = process.platform === 'win32' ? 90_000 : 30_000;
      for (let i = 0; i * 500 < waitMs; i++) {
        if (this.aborts.get(job.id)?.signal.aborted) {
          return this.finish(job, 'cancelled');
        }
        await sleep(500);
        if (await up()) {
          return this.finish(job, 'done');
        }
        this.update(job, { detail: `Waiting for Ollama at ${baseUrl}… (${((i + 1) / 2).toFixed(0)}s)` });
      }
      throw new Error(`Ollama did not answer at ${baseUrl} within ${waitMs / 1000}s${process.platform === 'win32' ? ' — check the Ollama tray icon; if a welcome window is open, close it and try Start again' : ''}`);
    } catch (e) {
      return this.finish(job, 'error', e instanceof Error ? e.message : String(e));
    }
  }

  /** pid of an `ollama serve` LocalPilot spawned itself, so it can be restarted with new settings. */
  private servePid?: number;

  /**
   * Restarts a local Ollama so it picks up `OLLAMA_NUM_PARALLEL` (parallel subagents otherwise queue behind each
   * other). Stops the server LocalPilot started, the macOS/Windows app, or a plain `ollama serve`; a systemd-managed
   * Ollama on Linux cannot be reconfigured from here and gets instructions instead.
   */
  async restartOllamaWithParallelSlots(): Promise<ModelJob> {
    const { baseUrl } = this.ollamaBase();
    if (!/localhost|127\.0\.0\.1|\[::1\]/.test(baseUrl)) {
      const job = this.start('start', 'ollama', 'Ollama', 'Restarting Ollama…');
      return this.finish(job, 'error', `Ollama at ${baseUrl} is not on this machine — set OLLAMA_NUM_PARALLEL=${ModelManager.ollamaParallelSlots()} in its environment and restart it there.`);
    }
    if (process.platform === 'linux' && (await which('systemctl', ['is-active', '--quiet', 'ollama'], 3000))) {
      const job = this.start('start', 'ollama', 'Ollama', 'Restarting Ollama…');
      return this.finish(
        job,
        'error',
        `Ollama runs as a systemd service. Run: sudo systemctl edit ollama  → add  [Service]\\nEnvironment="OLLAMA_NUM_PARALLEL=${ModelManager.ollamaParallelSlots()}"  → sudo systemctl restart ollama`
      );
    }
    const up = () => createProvider({ id: 'probe', type: 'ollama', baseUrl }).healthCheck().catch(() => false);
    if (this.servePid) {
      try {
        process.kill(this.servePid);
      } catch {
        /* already gone */
      }
      this.servePid = undefined;
    } else if (process.platform === 'darwin') {
      await which('osascript', ['-e', 'tell application "Ollama" to quit'], 6000);
      await which('pkill', ['-x', 'ollama'], 4000);
    } else if (process.platform === 'win32') {
      await which('taskkill', ['/F', '/IM', 'ollama app.exe'], 6000);
      await which('taskkill', ['/F', '/IM', 'ollama.exe'], 6000);
    } else {
      await which('pkill', ['-x', 'ollama'], 4000);
    }
    for (let i = 0; i < 20 && (await up()); i++) {
      await sleep(500);
    }
    return this.startOllama();
  }

  /**
   * Installs Ollama in the background — no terminal, no sudo/UAC — using the official builds:
   * macOS: `Ollama-darwin.zip` → /Applications (or ~/Applications); Windows: `OllamaSetup.exe /VERYSILENT` (per-user);
   * Linux: `ollama-linux-<arch>.tgz` → ~/.local/share/localpilot/ollama (user space). Then starts the server.
   * Falls back to the interactive terminal script only if the background path fails.
   */
  async installOllama(): Promise<ModelJob> {
    const job = this.start('install-runtime', 'ollama', 'Ollama', 'Preparing download…');
    const signal = this.aborts.get(job.id)!.signal;
    const mb = (n: number) => `${(n / 1048576).toFixed(0)} MB`;
    const onProgress = (what: string) => (done: number, total?: number) => this.update(job, { progress: total ? done / total : -1, detail: `${what} · ${mb(done)}${total ? ` / ${mb(total)}` : ''}` });
    try {
      if (await findOllamaBinary()) {
        this.update(job, { detail: 'Ollama is already installed — starting it…' });
      } else if (process.platform === 'darwin') {
        const zip = path.join(os.tmpdir(), `Ollama-darwin-${Date.now()}.zip`);
        await downloadFile('https://ollama.com/download/Ollama-darwin.zip', zip, onProgress('Downloading Ollama for macOS'), signal);
        this.update(job, { progress: -1, detail: 'Installing Ollama.app…' });
        let dest = '/Applications';
        let r = await runProcess('ditto', ['-x', '-k', zip, dest], { signal });
        if (r.code !== 0) {
          dest = path.join(os.homedir(), 'Applications');
          await fs.mkdir(dest, { recursive: true });
          r = await runProcess('ditto', ['-x', '-k', zip, dest], { signal });
        }
        await fs.unlink(zip).catch(() => undefined);
        if (r.code !== 0) {
          throw new Error(`Could not unpack Ollama.app: ${r.out.trim().split('\n').pop() ?? ''}`);
        }
        // Clear the quarantine flag so Gatekeeper does not block the first launch of a downloaded app.
        await runProcess('xattr', ['-dr', 'com.apple.quarantine', path.join(dest, 'Ollama.app')], { signal }).catch(() => undefined);
      } else if (process.platform === 'win32') {
        await this.installOllamaWindows(job, signal, onProgress);
      } else {
        await this.installOllamaLinuxUserSpace(job, signal, onProgress);
      }
      if (signal.aborted) {
        return this.finish(job, 'cancelled');
      }
      this.update(job, { progress: -1, detail: 'Installed — starting the server…' });
      const started = await this.startOllama();
      if (started.status !== 'done') {
        throw new Error(started.error ?? 'Ollama installed but failed to start');
      }
      return this.finish(job, 'done');
    } catch (e) {
      if (signal.aborted) {
        return this.finish(job, 'cancelled');
      }
      this.log.warn(`background Ollama install failed: ${e instanceof Error ? e.message : String(e)} — falling back to the terminal installer`);
      return this.installOllamaInTerminal(job, e instanceof Error ? e.message : String(e));
    }
  }

  /**
   * Windows without a terminal or UAC prompt. `winget` first (signed package, handles proxies and SmartScreen),
   * otherwise the official Inno Setup installer run silently per-user. Either way the install is verified by the
   * presence of `ollama.exe` rather than trusting the exit code, and the installer's output is kept for the error.
   */
  private async installOllamaWindows(job: ModelJob, signal: AbortSignal, onProgress: (what: string) => (done: number, total?: number) => void): Promise<void> {
    const installed = async () => (await findOllamaBinary()) ?? (await findOllamaTrayApp());
    const tail = (s: string) => s.trim().split(/\r?\n/).filter(Boolean).slice(-3).join(' · ').slice(0, 300);
    let wingetOut = '';
    if (await which('winget', ['--version'], 8000)) {
      this.update(job, { progress: -1, detail: 'Installing Ollama with winget…' });
      try {
        const r = await runProcess('winget', ['install', '--id', 'Ollama.Ollama', '-e', '--silent', '--disable-interactivity', '--accept-source-agreements', '--accept-package-agreements'], { signal, timeoutMs: 20 * 60_000 });
        wingetOut = r.out;
        // 0 = installed, 0x8A15002B = already installed; anything else falls through to the direct installer.
        if ((r.code === 0 || r.code === -1978335189) && (await installed())) {
          return;
        }
        this.log.warn(`winget install Ollama.Ollama exited ${r.code}: ${tail(r.out)}`);
      } catch (e) {
        this.log.warn(`winget failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    if (signal.aborted) {
      return;
    }
    const exe = path.join(os.tmpdir(), `OllamaSetup-${Date.now()}.exe`);
    await downloadFile('https://ollama.com/download/OllamaSetup.exe', exe, onProgress('Downloading Ollama for Windows'), signal);
    this.update(job, { progress: -1, detail: 'Running the installer silently (per-user, no admin rights needed)…' });
    const r = await runProcess(exe, ['/VERYSILENT', '/NORESTART', '/SP-', '/SUPPRESSMSGBOXES', '/CLOSEAPPLICATIONS', '/RESTARTAPPLICATIONS', '/NOCANCEL'], { signal, timeoutMs: 15 * 60_000 });
    await fs.unlink(exe).catch(() => undefined);
    // Inno Setup can return before the files are visible to a second process; give the filesystem a moment.
    for (let i = 0; i < 20 && !(await installed()); i++) {
      await sleep(500);
    }
    if (!(await installed())) {
      const why = r.code === 0 ? 'the installer finished but ollama.exe was not found under %LOCALAPPDATA%\\Programs\\Ollama or Program Files' : `the installer exited with code ${r.code}`;
      throw new Error(`${why}${tail(r.out) ? ` — ${tail(r.out)}` : ''}${wingetOut ? ` (winget: ${tail(wingetOut)})` : ''}`);
    }
  }

  /**
   * Linux without root: the official release archive (`.tar.zst`, or `.tgz` for older builds) unpacked into
   * ~/.local/share/localpilot/ollama. zstd is decoded by Node itself when available (22.15+/24), else the `zstd` CLI.
   */
  private async installOllamaLinuxUserSpace(job: ModelJob, signal: AbortSignal, onProgress: (what: string) => (done: number, total?: number) => void): Promise<void> {
    const arch = process.arch === 'arm64' ? 'arm64' : 'amd64';
    const base = `https://ollama.com/download/ollama-linux-${arch}`;
    const zlib = await import('zlib');
    const nodeZstd = typeof (zlib as { createZstdDecompress?: unknown }).createZstdDecompress === 'function';
    const cliZstd = await which('zstd', ['--version']);
    const zstAvailable = await fetch(`${base}.tar.zst`, { method: 'HEAD', redirect: 'follow', signal }).then((r) => r.ok, () => false);
    await fs.mkdir(USER_OLLAMA_DIR, { recursive: true });
    let archive: string;
    let extract: string[];
    if (zstAvailable && (nodeZstd || cliZstd)) {
      archive = path.join(os.tmpdir(), `ollama-linux-${arch}-${Date.now()}.tar.zst`);
      await downloadFile(`${base}.tar.zst`, archive, onProgress(`Downloading Ollama for Linux (${arch})`), signal);
      if (nodeZstd) {
        // Decompress in-process, then hand the plain tar to tar(1).
        this.update(job, { progress: -1, detail: 'Decompressing…' });
        const tar = archive.replace(/\.zst$/, '');
        const { createReadStream } = await import('fs');
        await pipeline(createReadStream(archive), (zlib as unknown as { createZstdDecompress(): Transform }).createZstdDecompress(), createWriteStream(tar));
        await fs.unlink(archive).catch(() => undefined);
        archive = tar;
        extract = ['-xf', archive, '-C', USER_OLLAMA_DIR];
      } else {
        extract = ['--use-compress-program=unzstd', '-xf', archive, '-C', USER_OLLAMA_DIR];
      }
    } else {
      archive = path.join(os.tmpdir(), `ollama-linux-${arch}-${Date.now()}.tgz`);
      await downloadFile(`${base}.tgz`, archive, onProgress(`Downloading Ollama for Linux (${arch})`), signal);
      extract = ['-xzf', archive, '-C', USER_OLLAMA_DIR];
    }
    this.update(job, { progress: -1, detail: `Unpacking into ${USER_OLLAMA_DIR}…` });
    const r = await runProcess('tar', extract, { signal });
    await fs.unlink(archive).catch(() => undefined);
    if (r.code !== 0) {
      throw new Error(`Could not unpack Ollama: ${r.out.trim().split('\n').pop() ?? ''}`);
    }
    await fs.chmod(path.join(USER_OLLAMA_DIR, 'bin', 'ollama'), 0o755).catch(() => undefined);
  }

  /** Interactive fallback: runs the platform installer script in a visible terminal and waits for the server. */
  private async installOllamaInTerminal(job: ModelJob, reason: string): Promise<ModelJob> {
    this.update(job, { progress: -1, detail: `Background install failed (${reason}) — running the installer in a terminal…` });
    const script = ollamaInstallCommand(process.platform, ModelManager.ollamaParallelSlots());
    const term = vscode.window.createTerminal({ name: 'LocalPilot · install Ollama', shellPath: script.shellPath, shellArgs: script.shellArgs });
    term.show(true);
    // Give the shell a moment to start before pasting the script (PowerShell in particular drops early input).
    await sleep(process.platform === 'win32' ? 1500 : 400);
    term.sendText(script.command, true);
    try {
      for (let i = 0; i < 200; i++) {
        if (this.aborts.get(job.id)?.signal.aborted) {
          return this.finish(job, 'cancelled');
        }
        await sleep(3000);
        if (await ollamaUp(this.ollamaBase().baseUrl)) {
          return this.finish(job, 'done');
        }
        if (await findOllamaBinary()) {
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
