// Starting a local Ollama that is installed but not running. Shared by the extension (ModelManager, the router, the
// background supervisor) and the CLI, so it is free of VS Code: find the binary or app, launch it the way the
// platform expects, and wait until it answers.
import * as cp from 'child_process';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

/** Where LocalPilot installs Ollama itself when no package manager / root is available (user-space, no sudo). */
export const USER_OLLAMA_DIR = path.join(os.homedir(), '.local', 'share', 'localpilot', 'ollama');

export const OLLAMA_LOCATIONS: Record<string, string[]> = {
  win32: [
    `${process.env['LOCALAPPDATA'] ?? ''}\\Programs\\Ollama\\ollama.exe`,
    `${process.env['PROGRAMFILES'] ?? 'C:\\Program Files'}\\Ollama\\ollama.exe`,
  ],
  darwin: ['/usr/local/bin/ollama', '/opt/homebrew/bin/ollama', '/Applications/Ollama.app/Contents/Resources/ollama', path.join(os.homedir(), 'Applications/Ollama.app/Contents/Resources/ollama')],
  linux: ['/usr/local/bin/ollama', '/usr/bin/ollama', '/snap/bin/ollama', path.join(USER_OLLAMA_DIR, 'bin', 'ollama')],
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Runs `cmd args` quietly; true when it exits 0 within the timeout (also how "is it installed" is asked). */
export function runQuiet(cmd: string, args: string[] = ['--version'], timeoutMs = 4000): Promise<boolean> {
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

/** `ollama` on PATH, or its well-known install location (a just-installed binary is not on this process's PATH yet). */
export async function findOllamaBinary(): Promise<string | undefined> {
  if (await runQuiet('ollama')) {
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
export async function findOllamaTrayApp(): Promise<string | undefined> {
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

/** Folders Ollama keeps models in: `OLLAMA_MODELS`, the user's `~/.ollama/models`, and the Linux service user's. */
export function ollamaModelDirs(): string[] {
  const dirs = [process.env['OLLAMA_MODELS'], path.join(os.homedir(), '.ollama', 'models')];
  if (process.platform === 'linux') {
    dirs.push('/usr/share/ollama/.ollama/models', '/var/lib/ollama/.ollama/models');
  }
  return dirs.filter((d): d is string => !!d);
}

/**
 * Whether Ollama has at least one model downloaded on this machine, read from its manifest folders (no server
 * needed). A stopped Ollama with models is one the user works with, so LocalPilot starts it instead of reporting
 * "no models".
 */
export async function ollamaModelsOnDisk(dirs = ollamaModelDirs()): Promise<boolean> {
  const hasFile = async (dir: string, depth: number): Promise<boolean> => {
    let entries: import('fs').Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return false;
    }
    for (const e of entries) {
      if (e.isFile() && !e.name.startsWith('.')) {
        return true;
      }
    }
    for (const e of entries) {
      if (e.isDirectory() && depth > 0 && (await hasFile(path.join(dir, e.name), depth - 1))) {
        return true;
      }
    }
    return false;
  };
  for (const d of dirs) {
    // manifests/<registry>/<namespace>/<model>/<tag>
    if (await hasFile(path.join(d, 'manifests'), 4)) {
      return true;
    }
  }
  return false;
}

/** Environment for an Ollama server LocalPilot starts: parallel request slots, flash attention and its KV cache type. */
export function ollamaServerEnv(o: { maxConcurrency: number; flashAttention: boolean; kvCacheType: string }): Record<string, string> {
  return {
    OLLAMA_NUM_PARALLEL: String(ollamaParallelSlots(o.maxConcurrency)),
    OLLAMA_FLASH_ATTENTION: o.flashAttention ? '1' : '0',
    ...(o.flashAttention ? { OLLAMA_KV_CACHE_TYPE: o.kvCacheType } : {}),
  };
}

/** Parallel slots to ask Ollama for: the configured subagent concurrency, clamped to what a local machine can hold. */
export function ollamaParallelSlots(maxConcurrency: number): number {
  return Math.max(1, Math.min(4, Math.round(maxConcurrency || 1)));
}

export interface LaunchOptions {
  /** The server's base URL, for messages. */
  baseUrl: string;
  /** Health check: resolves true once the server answers. */
  up: () => Promise<boolean>;
  /** Extra environment for the server (parallel slots, flash attention…). */
  env?: Record<string, string>;
  signal?: AbortSignal;
  /** Called about once a second while waiting for the server to answer. */
  onWait?: (seconds: number) => void;
}

export interface LaunchResult {
  ok: boolean;
  cancelled?: boolean;
  error?: string;
  /** pid of an `ollama serve` this call spawned itself (undefined when the app owns the server). */
  pid?: number;
}

/** The systemd unit file of a Linux service install of Ollama, if there is one. */
export async function ollamaSystemdUnit(): Promise<string | undefined> {
  for (const f of ['/etc/systemd/system/ollama.service', '/usr/lib/systemd/system/ollama.service', '/lib/systemd/system/ollama.service']) {
    try {
      await fs.access(f);
      return f;
    } catch {
      // not here
    }
  }
  return undefined;
}

/**
 * Starts Ollama the way each platform expects and waits until it answers: the menu-bar app on macOS (falling back to
 * `ollama serve` for a Homebrew/CLI-only install), the tray app on Windows, `ollama serve` elsewhere. A server that
 * already answers is left alone.
 */
export async function launchOllama(o: LaunchOptions): Promise<LaunchResult> {
  try {
    if (await o.up()) {
      return { ok: true };
    }
    // A stopped systemd service is a deliberate state: a per-user `ollama serve` would use another model store and block the unit.
    if (process.platform === 'linux' && (await ollamaSystemdUnit())) {
      return { ok: false, error: 'Ollama is installed as a systemd service that is stopped. Run: sudo systemctl start ollama' };
    }
    const extra = o.env ?? {};
    const env = { ...process.env, ...extra };
    const bin = await findOllamaBinary();
    let launched = false;
    let pid: number | undefined;
    if (process.platform === 'darwin') {
      // The menu-bar app reads its environment from launchd, not from `open`.
      for (const [k, v] of Object.entries(extra)) {
        await runQuiet('launchctl', ['setenv', k, v], 4000);
      }
      launched = await runQuiet('open', ['-a', 'Ollama'], 6000);
    } else if (process.platform === 'win32') {
      // The tray app owns the server on Windows. Prefer it even when `ollama` is on PATH — a bare `ollama serve`
      // next to a running tray app fails with "address already in use" and leaves a console window behind.
      const app = (bin && bin !== 'ollama' ? path.join(path.dirname(bin), 'ollama app.exe') : undefined) ?? (await findOllamaTrayApp());
      if (app) {
        launched = await fs.access(app).then(
          () => {
            const child = cp.spawn(app, [], { detached: true, stdio: 'ignore', env, windowsHide: true });
            child.on('error', () => undefined);
            child.unref();
            return true;
          },
          () => false
        );
      }
    }
    if (!launched && bin) {
      try {
        const child = cp.spawn(bin, ['serve'], { detached: true, stdio: 'ignore', env, shell: process.platform === 'win32' && bin === 'ollama', windowsHide: true });
        child.on('error', () => undefined);
        child.unref();
        pid = child.pid;
        launched = true;
      } catch {
        launched = false;
      }
    }
    if (!launched) {
      return { ok: false, error: bin ? 'Could not launch Ollama.' : 'Ollama is not installed. Install it from https://ollama.com/download' };
    }
    // A first launch on Windows unpacks runtimes and may show a welcome window before the server listens.
    const waitMs = process.platform === 'win32' ? 90_000 : 30_000;
    const deadline = Date.now() + waitMs;
    for (let i = 0; Date.now() < deadline; i++) {
      if (o.signal?.aborted) {
        return { ok: false, cancelled: true, pid };
      }
      await sleep(500);
      if (await o.up()) {
        return { ok: true, pid };
      }
      if (i % 2 === 1) {
        o.onWait?.((i + 1) / 2);
      }
    }
    return {
      ok: false,
      pid,
      error: `Ollama did not answer at ${o.baseUrl} within ${waitMs / 1000}s${process.platform === 'win32' ? ' — check the Ollama tray icon; if a welcome window is open, close it and try Start again' : ''}`,
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
