// Installing and starting the local gateways LocalPilot knows (OmniRoute, LiteLLM) for `LocalPilot: Start gateway`.
// Free of VS Code so it can be tested: the commands each gateway expects, prerequisite checks, and reading what a
// running gateway can actually route to. Gateways run on this machine but forward prompts to cloud models, so their
// providers are marked `cloud` and they are always bound to 127.0.0.1, never to every interface.
import * as cp from 'child_process';
import { shellQuote, which } from './colibriSetup';

export type GatewayId = 'omniroute' | 'litellm';

export interface GatewaySpec {
  id: GatewayId;
  label: string;
  /** Executable on PATH once installed. */
  bin: string;
  defaultPort: number;
  docs: string;
  /** Dashboard for connecting providers and creating keys, relative to the server root. */
  dashboardPath?: string;
}

export const GATEWAYS: Record<GatewayId, GatewaySpec> = {
  omniroute: { id: 'omniroute', label: 'OmniRoute', bin: 'omniroute', defaultPort: 20128, docs: 'https://github.com/diegosouzapw/OmniRoute', dashboardPath: '/' },
  litellm: { id: 'litellm', label: 'LiteLLM proxy', bin: 'litellm', defaultPort: 4000, docs: 'https://docs.litellm.ai/docs/simple_proxy', dashboardPath: '/ui' },
};

export interface StartOptions {
  port: number;
  /** Absolute path of the gateway executable (so the terminal does not depend on its own PATH). */
  exe: string;
  /** LiteLLM: the proxy config file listing its models. */
  config?: string;
  platform?: NodeJS.Platform;
}

/**
 * The terminal command that starts a gateway in the foreground, on 127.0.0.1 only.
 * - OmniRoute: `omniroute --port N --no-open --non-interactive`; the bind address comes from `OMNIROUTE_SERVER_HOST`
 *   (see gatewayEnv), because its default is every interface.
 * - LiteLLM: `litellm --host 127.0.0.1 --port N --config FILE`.
 */
export function startCommand(id: GatewayId, o: StartOptions): string {
  const platform = o.platform ?? process.platform;
  const q = (s: string) => shellQuote(s, platform);
  const exe = q(o.exe);
  const call = platform === 'win32' && exe.startsWith("'") ? `& ${exe}` : exe;
  if (id === 'omniroute') {
    return `${call} --port ${o.port} --no-open --non-interactive`;
  }
  return `${call} --host 127.0.0.1 --port ${o.port}${o.config ? ` --config ${q(o.config)}` : ''}`;
}

/** Environment for the gateway's terminal. */
export function gatewayEnv(id: GatewayId): Record<string, string> {
  return id === 'omniroute' ? { OMNIROUTE_SERVER_HOST: '127.0.0.1' } : {};
}

/** The install command for a gateway, or undefined when it cannot be installed from here. */
export function installCommand(id: GatewayId, platform: NodeJS.Platform = process.platform): string {
  if (id === 'omniroute') {
    return 'npm install -g omniroute';
  }
  return platform === 'win32' ? "py -3 -m pip install --user 'litellm[proxy]'" : "python3 -m pip install --user 'litellm[proxy]'";
}

/** Install then start, in the syntax of the terminal's shell (Windows PowerShell 5.1 has no `&&`). */
export function installAndStartCommand(id: GatewayId, port: number, platform: NodeJS.Platform = process.platform): string {
  const install = installCommand(id, platform);
  const start = startCommand(id, { port, exe: GATEWAYS[id].bin, platform });
  return platform === 'win32' ? `${install}; if ($?) { ${start} }` : `${install} && ${start}`;
}

/** Shell for the gateway/colibri terminals: the commands use PowerShell syntax on Windows, whatever the default shell. */
export function terminalShell(platform: NodeJS.Platform = process.platform): { shellPath?: string; shellArgs?: string[] } {
  return platform === 'win32' ? { shellPath: 'powershell.exe', shellArgs: ['-NoLogo', '-ExecutionPolicy', 'Bypass'] } : {};
}

export interface GatewayPrereqs {
  ok: boolean;
  /** What is missing or too old, for the message. */
  problem?: string;
  /** How to fix it. */
  hint?: string;
}

/** OmniRoute needs Node.js 22.22.2+ on 22, or 24–26 (its package engines), plus npm. */
export function nodeVersionOk(version: string): boolean {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
  if (!m) {
    return false;
  }
  const [maj, min, pat] = m.slice(1).map(Number);
  if (maj === 22) {
    return min > 22 || (min === 22 && pat >= 2);
  }
  return maj >= 24 && maj < 27;
}

export function checkGatewayPrereqs(id: GatewayId, find: (n: string) => string | undefined = which, nodeVersion?: string, platform: NodeJS.Platform = process.platform): GatewayPrereqs {
  if (id === 'omniroute') {
    if (!find('node') || !find('npm')) {
      return { ok: false, problem: 'Node.js and npm are not installed', hint: 'Install Node.js 24 LTS from https://nodejs.org (or `brew install node` / your package manager).' };
    }
    if (nodeVersion !== undefined && !nodeVersionOk(nodeVersion)) {
      return { ok: false, problem: `Node.js ${nodeVersion.trim()} is too old for OmniRoute (it needs 22.22.2+ or 24–26)`, hint: 'Install Node.js 24 LTS from https://nodejs.org, or switch with nvm: `nvm install 24`.' };
    }
    return { ok: true };
  }
  const py = platform === 'win32' ? find('py') || find('python') : find('python3');
  return py ? { ok: true } : { ok: false, problem: 'Python 3 is not installed', hint: platform === 'darwin' ? '`brew install python`' : platform === 'win32' ? '`winget install Python.Python.3.12`' : '`sudo apt install python3 python3-pip`' };
}

/** `node --version` as the user's shell would see it (undefined when node is missing or does not answer). */
export function nodeVersion(): Promise<string | undefined> {
  return new Promise((resolve) => cp.execFile('node', ['--version'], { timeout: 5000, windowsHide: true }, (err, out) => resolve(err ? undefined : out.trim())));
}

/** What a gateway's `/v1/models` says about where it can route. */
export interface GatewayModels {
  /** Every model id it lists. */
  ids: string[];
  /** Routes the gateway resolves itself (OmniRoute's `auto`, `auto/coding`… and combos). */
  routes: string[];
  /** Concrete provider models (`openai/gpt-5.4`, `glm/glm-5.2`…). */
  models: string[];
}

/** Splits a gateway's model list into its own routes and concrete provider models. */
export function classifyGatewayModels(ids: string[]): GatewayModels {
  const isRoute = (id: string) => /^auto(\/|$)/i.test(id) || /^combo[/:-]/i.test(id);
  return { ids, routes: ids.filter(isRoute), models: ids.filter((id) => !isRoute(id)) };
}

/**
 * True when a gateway is up but cannot answer yet: OmniRoute lists only its `auto` routes until a provider is
 * connected, and LiteLLM lists nothing without a config.
 */
export function needsProviders(m: GatewayModels): boolean {
  return m.models.length === 0;
}

/** Reads a gateway's `/v1/models` (OmniRoute never gates this endpoint with a key). */
export async function gatewayModels(port: number, key?: string, host = '127.0.0.1'): Promise<GatewayModels | undefined> {
  try {
    const res = await fetch(`http://${host}:${port}/v1/models`, { headers: key ? { authorization: `Bearer ${key}` } : {}, signal: AbortSignal.timeout(4000) });
    if (!res.ok) {
      return undefined;
    }
    const j = (await res.json()) as { data?: { id?: string }[] };
    return classifyGatewayModels((j.data ?? []).map((m) => String(m.id ?? '')).filter(Boolean));
  } catch {
    return undefined;
  }
}

/** The gateway's dashboard. */
export const gatewayDashboard = (id: GatewayId, port: number) => `http://127.0.0.1:${port}${GATEWAYS[id].dashboardPath ?? '/'}`;
