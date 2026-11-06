// Installing, configuring and starting colibri (github.com/JustVugg/colibri) for `LocalPilot: Start colibri`.
// Everything here is free of VS Code so it can be tested: finding the launcher, building the commands colibri's own
// tooling expects (`coli setup` does detection, the engine build or download, the model download and the run config;
// rerunning it starts what is set up without downloading or building again), checking prerequisites, telling a
// running colibri apart from another server on its port, and ranking catalog models against this machine.
import * as cp from 'child_process';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { COLIBRI_DEFAULT_PORT, COLIBRI_MODELS, COLIBRI_OWNER, COLIBRI_REPO_URL, colibriRoot, ColibriSpec } from './colibri';

export const COLIBRI_GIT_URL = COLIBRI_REPO_URL;

/** Where `Install colibri` clones to when the user does not pick a folder. */
export const DEFAULT_CHECKOUT = () => path.join(os.homedir(), 'colibri');

/** colibri's own default model folder (`coli setup --dir`). */
export const DEFAULT_MODELS_DIR = () => path.join(os.homedir(), 'colibri-models');

export type ColibriBackend = 'auto' | 'cpu' | 'vulkan' | 'cuda';

/**
 * How to run `coli`: the executable and the arguments that come before the subcommand.
 * - `checkout`: a git clone (`<dir>/c/coli`, a Python script; on Windows run with `py -3`).
 * - `release`: an unpacked release archive (`<dir>/coli`, or `<dir>/coli.cmd` on Windows).
 * - `path`: `coli` found on PATH.
 */
export interface ColiLauncher {
  kind: 'checkout' | 'release' | 'path';
  command: string;
  prefix: string[];
  /** Folder to run in (the checkout or release root); undefined for PATH. */
  folder?: string;
}

export interface FindOptions {
  /** `localpilot.colibri.path`. */
  configured?: string;
  platform?: NodeJS.Platform;
  exists?: (p: string) => boolean;
  /** Absolute path of an executable on PATH, or undefined. */
  which?: (name: string) => string | undefined;
  home?: string;
}

/** The launcher inside a folder, if it is a colibri checkout or release. */
export function launcherIn(folder: string, platform: NodeJS.Platform = process.platform, exists: (p: string) => boolean = fs.existsSync): ColiLauncher | undefined {
  const root = folder.replace(/[\\/]+$/, '');
  const j = (...p: string[]) => (platform === 'win32' ? path.win32.join(root, ...p) : path.posix.join(root, ...p));
  if (exists(j('c', 'coli'))) {
    return platform === 'win32' ? { kind: 'checkout', command: 'py', prefix: ['-3', j('c', 'coli')], folder: root } : { kind: 'checkout', command: j('c', 'coli'), prefix: [], folder: root };
  }
  if (platform === 'win32' && exists(j('coli.cmd'))) {
    return { kind: 'release', command: j('coli.cmd'), prefix: [], folder: root };
  }
  if (platform !== 'win32' && exists(j('coli'))) {
    return { kind: 'release', command: j('coli'), prefix: [], folder: root };
  }
  return undefined;
}

/** The configured folder, then `coli` on PATH, then a checkout in the default place (`~/colibri`). */
export function findColibri(o: FindOptions = {}): ColiLauncher | undefined {
  const platform = o.platform ?? process.platform;
  const exists = o.exists ?? fs.existsSync;
  if (o.configured) {
    return launcherIn(expandHome(o.configured, o.home), platform, exists);
  }
  const onPath = (o.which ?? which)(platform === 'win32' ? 'coli.cmd' : 'coli');
  if (onPath) {
    return { kind: 'path', command: onPath, prefix: [] };
  }
  // The target platform's separator, not the host's: the same code answers for a Windows user from any machine.
  return launcherIn((platform === 'win32' ? path.win32 : path.posix).join(o.home ?? os.homedir(), 'colibri'), platform, exists);
}

export function expandHome(p: string, home = os.homedir()): string {
  return p === '~' ? home : p.replace(/^~(?=[\\/])/, home);
}

export function which(name: string): string | undefined {
  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  const exts = process.platform === 'win32' ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';').map((e) => e.toLowerCase()).concat('') : [''];
  for (const d of dirs) {
    for (const e of exts) {
      const f = path.join(d, name.toLowerCase().endsWith(e) ? name : name + e);
      try {
        if (fs.statSync(f).isFile()) {
          return f;
        }
      } catch {
        /* not here */
      }
    }
  }
  return undefined;
}

export interface SetupOptions {
  port?: number;
  /** A catalog id (`qwen3-coder-30b`) or a folder with a model already on disk. */
  model?: string;
  /** Folder for downloaded models (`--dir`); empty = colibri's default (`~/colibri-models`). */
  modelsDir?: string;
  backend?: ColibriBackend;
  /** Pick a different model even though a setup is complete. */
  reconfigure?: boolean;
  /** Write the configuration without starting the server. */
  noStart?: boolean;
  exists?: (p: string) => boolean;
}

/** True when `model` names a folder rather than a catalog id. */
export function isModelFolder(model: string, exists: (p: string) => boolean = fs.existsSync): boolean {
  return /[\\/]/.test(model) || model.startsWith('~') || exists(model);
}

/**
 * Arguments for `coli setup`, which installs on first use and afterwards just starts what is set up. Never interactive
 * and never opens a browser; the server runs in the foreground of the terminal it is started in.
 */
export function setupArgs(o: SetupOptions = {}): string[] {
  const args = ['setup', '--yes', '--no-browser', '--host', '127.0.0.1', '--port', String(o.port || COLIBRI_DEFAULT_PORT)];
  if (o.model) {
    args.push(...(isModelFolder(o.model, o.exists) ? ['--model-dir', expandHome(o.model)] : ['--model', o.model]));
  }
  if (o.modelsDir) {
    args.push('--dir', expandHome(o.modelsDir));
  }
  if (o.backend && o.backend !== 'auto') {
    args.push('--backend', o.backend);
  }
  if (o.reconfigure) {
    args.push('--reconfigure');
  }
  if (o.noStart) {
    args.push('--no-start');
  }
  return args;
}

/** Shell-safe quoting for one argument (POSIX shells, or PowerShell on Windows). */
export function shellQuote(s: string, platform: NodeJS.Platform = process.platform): string {
  if (/^[\w./:@=+,-]+$/.test(s)) {
    return s;
  }
  return platform === 'win32' ? `'${s.replace(/'/g, "''")}'` : `'${s.replace(/'/g, `'\\''`)}'`;
}

/** One terminal command line running `coli <args>` with the given launcher. */
export function coliCommand(l: ColiLauncher, args: string[], platform: NodeJS.Platform = process.platform): string {
  const parts = [l.command, ...l.prefix, ...args].map((a) => shellQuote(a, platform));
  // PowerShell runs a quoted executable path only through the call operator.
  return platform === 'win32' && parts[0].startsWith("'") ? `& ${parts.join(' ')}` : parts.join(' ');
}

/**
 * Clone colibri and run its setup in one terminal line: on Windows (PowerShell) with `py -3 c\coli`, elsewhere with
 * the checkout's `c/coli`. `git clone --depth 1` keeps the download small.
 */
export function installCommand(folder: string, setup: string[], platform: NodeJS.Platform = process.platform): string {
  const launcher: ColiLauncher = platform === 'win32' ? { kind: 'checkout', command: 'py', prefix: ['-3', path.win32.join(folder, 'c', 'coli')] } : { kind: 'checkout', command: path.posix.join(folder, 'c', 'coli'), prefix: [] };
  const clone = `git clone --depth 1 ${COLIBRI_GIT_URL} ${shellQuote(folder, platform)}`;
  const run = coliCommand(launcher, setup, platform);
  return platform === 'win32' ? `${clone}; if ($?) { ${run} }` : `${clone} && ${run}`;
}

export interface Prereqs {
  git: boolean;
  python: boolean;
  compiler: boolean;
  /** What to install, as a command the user can run (empty when nothing is missing). */
  missing: string[];
  hint?: string;
}

/**
 * git and Python are required to clone and drive colibri's setup. A C compiler with OpenMP is optional: without one,
 * setup downloads a prebuilt engine.
 */
export function checkPrereqs(platform: NodeJS.Platform = process.platform, find: (name: string) => string | undefined = which): Prereqs {
  const git = !!find('git');
  const python = platform === 'win32' ? !!(find('py') || find('python')) : !!find('python3');
  const compiler = platform === 'win32' ? true : !!(find('cc') || find('gcc') || find('clang'));
  const missing = [!git ? 'git' : '', !python ? 'Python 3' : ''].filter(Boolean);
  const hint = !missing.length
    ? undefined
    : platform === 'darwin'
      ? 'xcode-select --install && brew install libomp git python'
      : platform === 'win32'
        ? 'winget install Git.Git Python.Python.3.12'
        : 'sudo apt install git python3 build-essential   # Debian/Ubuntu; other distros: the same packages';
  return { git, python, compiler, missing, hint };
}

export type PortState = 'colibri' | 'other' | 'free';

/** What answers on `port`: a colibri server (owned_by colibri, or its /health), another server, or nothing. */
export async function probePort(port: number, host = '127.0.0.1', signal?: AbortSignal): Promise<PortState> {
  const base = `http://${host}:${port}`;
  const get = async (p: string) => {
    try {
      const res = await fetch(`${base}${p}`, { signal: signal ?? AbortSignal.timeout(2500) });
      return { ok: res.ok, status: res.status, body: await res.text().catch(() => '') };
    } catch {
      return undefined;
    }
  };
  const models = await get('/v1/models');
  if (models?.ok && models.body.includes(`"${COLIBRI_OWNER}"`)) {
    return 'colibri';
  }
  const health = await get('/health');
  if (health?.ok && /"(kv_slots|arch|scheduler)"/.test(health.body)) {
    return 'colibri';
  }
  if (models || health) {
    return 'other';
  }
  return (await portInUse(port, host)) ? 'other' : 'free';
}

/** Something accepts TCP connections on the port (a server that does not speak HTTP still blocks it). */
export function portInUse(port: number, host = '127.0.0.1'): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect({ port, host });
    const done = (v: boolean) => {
      s.destroy();
      resolve(v);
    };
    s.setTimeout(1000, () => done(false));
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
  });
}

/** The first port from `start` on that nothing listens on. */
export async function freePort(start: number, host = '127.0.0.1', tries = 50): Promise<number | undefined> {
  for (let p = start; p < start + tries && p <= 65535; p++) {
    if (!(await portInUse(p, host))) {
      return p;
    }
  }
  return undefined;
}

/** True when the OpenAI endpoint of colibri on `port` lists a model (the server finished loading). */
export async function colibriReady(port: number, host = '127.0.0.1'): Promise<boolean> {
  try {
    const res = await fetch(`http://${host}:${port}/v1/models`, { signal: AbortSignal.timeout(2500) });
    if (!res.ok) {
      return false;
    }
    const j = (await res.json()) as { data?: unknown[] };
    return Array.isArray(j.data) && j.data.length > 0;
  } catch {
    return false;
  }
}

/** colibri's dashboard for a server on `port`. */
export const dashboardUrl = (port: number) => `${colibriRoot(`http://127.0.0.1:${port}/v1`)}/`;

/** Models that `coli setup --model` installs by itself; the rest need a manual conversion (colibri's README). */
const MANUAL = new Set(['olmoe', 'qwen38-27b', 'glm-5.3-flash', 'deepseek-v4.1-flash']);

export interface ModelChoice {
  spec: ColibriSpec;
  /** Fits: the whole model fits in RAM (fast). Streams: the resident part fits, experts stream from disk (slow). */
  fit: 'ram' | 'streams' | 'too-big';
  enoughDisk: boolean;
  note: string;
}

/** Catalog models colibri's setup can install, ranked for this machine: fits in RAM, then streams from disk, then too big. */
export function modelChoices(ramGb: number, freeDiskGb: number | undefined): ModelChoice[] {
  const order = { ram: 0, streams: 1, 'too-big': 2 } as const;
  return COLIBRI_MODELS.filter((s) => !MANUAL.has(s.name) && s.tools)
    .map((spec) => {
      const fit: ModelChoice['fit'] = spec.diskGb <= ramGb * 0.8 ? 'ram' : spec.ramMinGb <= ramGb ? 'streams' : 'too-big';
      const enoughDisk = freeDiskGb === undefined || spec.diskGb + 2 <= freeDiskGb;
      const note = [
        fit === 'ram' ? 'runs from RAM' : fit === 'streams' ? 'experts stream from disk: slow, best for Plan mode' : `needs ${spec.ramMinGb} GB RAM`,
        `${spec.diskGb} GB download`,
        enoughDisk ? '' : `only ${Math.floor(freeDiskGb ?? 0)} GB free`,
      ].filter(Boolean).join(' · ');
      return { spec, fit, enoughDisk, note };
    })
    .sort((a, b) => order[a.fit] - order[b.fit] || Number(b.enoughDisk) - Number(a.enoughDisk) || a.spec.diskGb - b.spec.diskGb);
}

/** Free space kept on top of a download (colibri writes temporary files while it converts and verifies). */
export const DISK_HEADROOM_GB = 2;

export interface DiskPreflight {
  /** True when the download fits, nothing is downloaded (a model folder, a model already there) or the space is unknown. */
  ok: boolean;
  /** The free space could not be read (the check was skipped). */
  unknown?: boolean;
  dir: string;
  freeGb?: number;
  /** Download plus headroom; 0 when nothing is downloaded. */
  needGb: number;
  shortGb: number;
  /** The catalog model the check is for (for `recommended`, the smallest one colibri could pick on this machine). */
  spec?: ColibriSpec;
  /** Catalog models that fit both this machine's RAM and the free space, best first. */
  smaller: ColibriSpec[];
  /** One plain sentence: what is short and by how much. Empty when ok. */
  message: string;
}

/**
 * Before `coli setup` downloads a model into `dir`: does it fit on that disk? `model` is a catalog id, `recommended`
 * (colibri picks; the smallest model that fits this machine is the least it can need), or a folder (nothing to
 * download). `present`: the model is already in `dir`, so setup only starts it.
 */
export function diskPreflight(o: { model?: string; dir: string; freeGb: number | undefined; ramGb: number; present?: boolean; exists?: (p: string) => boolean }): DiskPreflight {
  const choices = modelChoices(o.ramGb, o.freeGb).filter((c) => c.fit !== 'too-big');
  const smaller = choices.filter((c) => c.enoughDisk).map((c) => c.spec);
  const base = { dir: o.dir, ...(o.freeGb !== undefined ? { freeGb: o.freeGb } : {}), smaller };
  const recommended = !o.model || o.model === 'recommended';
  if (!recommended && isModelFolder(o.model!, o.exists)) {
    return { ...base, ok: true, needGb: 0, shortGb: 0, message: '' };
  }
  const spec = recommended ? [...choices].sort((a, b) => a.spec.diskGb - b.spec.diskGb)[0]?.spec : COLIBRI_MODELS.find((m) => m.name === o.model);
  if (!spec || o.present) {
    return { ...base, ok: true, needGb: 0, shortGb: 0, ...(spec ? { spec } : {}), message: '' };
  }
  const needGb = spec.diskGb + DISK_HEADROOM_GB;
  if (o.freeGb === undefined) {
    return { ...base, ok: true, unknown: true, needGb, shortGb: 0, spec, message: '' };
  }
  const shortGb = Math.max(0, Math.ceil(needGb - o.freeGb));
  if (!shortGb) {
    return { ...base, ok: true, needGb, shortGb: 0, spec, message: '' };
  }
  const free = Math.floor(o.freeGb);
  const what = recommended ? `Even the smallest model colibri can pick for this machine (${spec.name}) needs about ${needGb} GB` : `${spec.name} needs about ${needGb} GB (a ${spec.diskGb} GB download plus ${DISK_HEADROOM_GB} GB to work in)`;
  return { ...base, ok: false, needGb, shortGb, spec, message: `${what}, but the disk that holds ${o.dir} has ${free} GB free: ${shortGb} GB short.` };
}

/**
 * Whether `spec` already seems to be downloaded into `dir`: a non-empty entry whose name matches the model. colibri
 * resumes an interrupted download, so a partial folder counts too (setup will only fetch the rest).
 */
export function modelPresent(dir: string, spec: ColibriSpec | undefined): boolean {
  if (!spec) {
    return false;
  }
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).some((e) => spec.match.test(e.name) && (!e.isDirectory() || fs.readdirSync(path.join(dir, e.name)).length > 0));
  } catch {
    return false;
  }
}

/** Free space in GB on the volume that holds `dir` (or its nearest existing parent). */
export function freeDiskGb(dir: string): number | undefined {
  let d = path.resolve(dir);
  while (!fs.existsSync(d)) {
    const up = path.dirname(d);
    if (up === d) {
      return undefined;
    }
    d = up;
  }
  try {
    const s = fs.statfsSync(d);
    return (s.bavail * s.bsize) / 1024 ** 3;
  } catch {
    return undefined;
  }
}

/** Runs `coli <args>` and returns its stdout (best effort: undefined when it fails or times out). */
export function runColi(l: ColiLauncher, args: string[], timeoutMs = 20_000, env?: NodeJS.ProcessEnv): Promise<string | undefined> {
  return new Promise((resolve) => {
    const opts: cp.ExecFileOptions = { cwd: l.folder, timeout: timeoutMs, env: { ...process.env, ...env }, windowsHide: true, maxBuffer: 4 * 1024 * 1024 };
    const done = (err: Error | null, stdout: string | Buffer) => resolve(err ? undefined : String(stdout));
    try {
      if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(l.command)) {
        // Node refuses to spawn .cmd/.bat without a shell (EINVAL); the arguments are fixed literals.
        const line = [l.command, ...l.prefix, ...args].map((a) => `"${a}"`).join(' ');
        cp.execFile(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', `"${line}"`], { ...opts, windowsVerbatimArguments: true }, done);
      } else {
        cp.execFile(l.command, [...l.prefix, ...args], opts, done);
      }
    } catch {
      resolve(undefined);
    }
  });
}

/**
 * A progress line from `coli status --json`, whatever its exact shape: the first percentage-like field and the first
 * state/phase string found anywhere in it. Undefined when there is nothing useful.
 */
export function statusProgress(json: string | undefined): string | undefined {
  if (!json) {
    return undefined;
  }
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    return undefined;
  }
  let pct: number | undefined;
  let phase: string | undefined;
  const walk = (v: unknown, key = '', depth = 0): void => {
    if (depth > 5 || v === null) {
      return;
    }
    if (typeof v === 'number' && pct === undefined && /progress|percent|pct/i.test(key)) {
      pct = v <= 1 ? v * 100 : v;
    } else if (typeof v === 'string' && phase === undefined && /^(state|phase|stage|step|status)$/i.test(key) && v.length < 60) {
      phase = v;
    } else if (typeof v === 'object') {
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
        walk(x, k, depth + 1);
      }
    }
  };
  walk(data);
  if (pct === undefined && !phase) {
    return undefined;
  }
  return [phase, pct !== undefined ? `${Math.max(0, Math.min(100, Math.round(pct)))}%` : ''].filter(Boolean).join(' · ');
}
