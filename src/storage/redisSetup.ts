// "LocalPilot: Set Up Redis Storage": connects an existing Redis or starts Redis Stack (Docker / Homebrew), then turns
// on `localpilot.storage.redis.enabled`. Everything it runs is shown in a terminal; nothing is installed silently.
import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { getConfig } from '../config';
import { parseRedisUrl, redactRedisUrl } from './redis';
import { RedisProbe, RedisTelemetry } from './redisTelemetry';

const CONTAINER = 'localpilot-redis';
const IMAGE = 'redis/redis-stack-server:latest';
const DOCS = 'https://isathish.github.io/localpilot/docs/configuration/#telemetry--storage';

interface Logger {
  info(m: string): void;
  warn(m: string): void;
}

export async function probeRedis(url: string): Promise<RedisProbe> {
  let r: RedisTelemetry;
  try {
    r = new RedisTelemetry(url);
  } catch (e) {
    return { ok: false, timeseries: false, error: e instanceof Error ? e.message : String(e) };
  }
  try {
    return await r.probe();
  } finally {
    r.dispose();
  }
}

function docker(args: string[], timeout = 15_000): Promise<string> {
  return run('docker', args, timeout);
}

function run(cmd: string, args: string[], timeout = 15_000, cwd?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    cp.execFile(cmd, args, { timeout, windowsHide: true, cwd }, (err, stdout, stderr) => (err ? reject(new Error(String(stderr || err.message).trim())) : resolve(String(stdout).trim())));
  });
}

/** True when `cmd` is on PATH and runs. */
const has = (cmd: string, args = ['--version']): Promise<boolean> => run(cmd, args, 5000).then(() => true, () => false);

/** True when an executable `bin` is on PATH, without running it (the redis-stack-server wrapper rejects `--version`). */
async function onPath(bin: string): Promise<boolean> {
  for (const p of (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
    if (await fs.promises.access(path.join(p, bin), fs.constants.X_OK).then(() => true, () => false)) {
      return true;
    }
  }
  return false;
}

/** Docker Desktop's app on this machine, when installed (its CLI may not be on PATH until it has run once). */
function dockerDesktopApp(): string | undefined {
  const candidates =
    process.platform === 'darwin'
      ? ['/Applications/Docker.app', path.join(process.env.HOME ?? '', 'Applications', 'Docker.app')]
      : process.platform === 'win32'
        ? [path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Docker', 'Docker', 'Docker Desktop.exe')]
        : ['/opt/docker-desktop/bin/com.docker.backend'];
  return candidates.find((p) => fs.existsSync(p));
}

/** The daemon is up but this user may not talk to its socket (Linux, not in the docker group). */
const DOCKER_GROUP_FIX = 'sudo usermod -aG docker $USER, then log out and back in (or restart VS Code)';
const DOCKER_DENIED = /permission denied|docker\.sock|docker API/i;

/** `running`: daemon answers · `denied`: daemon refuses this user · `stopped`: Docker is installed but its engine is not up · `missing`: no Docker at all. */
export async function dockerState(): Promise<'running' | 'denied' | 'stopped' | 'missing'> {
  const err = await docker(['version', '--format', '{{.Server.Version}}'], 5000).then(() => undefined, (e: Error) => e.message);
  if (err === undefined) {
    return 'running';
  }
  if (DOCKER_DENIED.test(err)) {
    return 'denied';
  }
  return (await has('docker')) || dockerDesktopApp() ? 'stopped' : 'missing';
}

/** Launches Docker Desktop (or the Linux engine) and waits until the daemon answers. */
async function startDocker(): Promise<boolean> {
  if (process.platform === 'darwin') {
    await run('open', ['-a', 'Docker']).catch(() => undefined);
  } else if (process.platform === 'win32') {
    const exe = dockerDesktopApp();
    if (exe) {
      cp.spawn(exe, [], { detached: true, stdio: 'ignore', windowsHide: true }).on('error', () => undefined).unref();
    }
  } else if (dockerDesktopApp()) {
    await run('systemctl', ['--user', 'start', 'docker-desktop']).catch(() => undefined);
  } else {
    // The Linux engine is a system service; starting it needs sudo, which only the user can type.
    const term = vscode.window.createTerminal({ name: 'LocalPilot · Redis' });
    term.show(true);
    term.sendText('sudo systemctl start docker');
  }
  return vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Starting Docker…', cancellable: true }, async (_p, token) => {
    const started = Date.now();
    while (!token.isCancellationRequested && Date.now() - started < 3 * 60_000) {
      const err = await docker(['info', '--format', '{{.ServerVersion}}'], 5000).then(() => undefined, (e: Error) => e.message);
      if (err === undefined) {
        return true;
      }
      if (DOCKER_DENIED.test(err)) {
        return false;
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
    return false;
  });
}

/** `docker run` for a local Redis Stack: loopback only, memory-capped, data in a named volume. */
export function dockerRunCommand(port: number): string {
  return `docker run -d --name ${CONTAINER} --restart unless-stopped -p 127.0.0.1:${port}:6379 -v ${CONTAINER}:/data -e "REDIS_ARGS=--maxmemory 256mb --maxmemory-policy noeviction --appendonly yes" ${IMAGE}`;
}

async function enable(url: string, p: RedisProbe, log: Logger): Promise<void> {
  const cfg = vscode.workspace.getConfiguration('localpilot');
  if (getConfig().storage.redis.url !== url) {
    await cfg.update('storage.redis.url', url, vscode.ConfigurationTarget.Global);
  }
  await cfg.update('storage.redis.enabled', true, vscode.ConfigurationTarget.Global);
  log.info(`Redis storage on: ${redactRedisUrl(url)} (Redis ${p.version ?? '?'}, time series ${p.timeseries ? 'on' : 'off'})`);
  const extra = p.timeseries ? ' Metrics are also kept as time series (RedisTimeSeries).' : ' This Redis has no RedisTimeSeries module — use Redis Stack for time-series charts.';
  const pick = await vscode.window.showInformationMessage(`LocalPilot telemetry now goes to Redis ${p.version ?? ''} at ${redactRedisUrl(url)}.${extra}`, 'Open Dashboard');
  if (pick) {
    void vscode.commands.executeCommand('localpilot.openDashboard');
  }
}

/** Polls until Redis answers (or the user cancels / it times out), with a progress notification. */
async function waitFor(url: string, title: string, timeoutMs: number): Promise<RedisProbe | undefined> {
  return vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title, cancellable: true }, async (_p, token) => {
    const started = Date.now();
    while (!token.isCancellationRequested && Date.now() - started < timeoutMs) {
      const p = await probeRedis(url);
      if (p.ok) {
        return p;
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
    return undefined;
  });
}

export async function setupRedis(log: Logger): Promise<void> {
  const { url, enabled } = getConfig().storage.redis;
  const current = await probeRedis(url);
  let port = 6379;
  let local = true;
  try {
    const t = parseRedisUrl(url);
    port = t.port;
    local = ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(t.host);
  } catch {
    local = false;
  }
  // A server already answering takes the port, so the install options are pointless; the user only confirms it.
  const [dockerNow, brew, apt, dnf, wsl, winget] = local && !current.ok
    ? await Promise.all([
        dockerState(),
        process.platform === 'darwin' ? has('brew') : false,
        process.platform === 'linux' ? has('apt-get') : false,
        process.platform === 'linux' ? has('dnf') : false,
        process.platform === 'win32' ? has('wsl', ['--status']) : false,
        process.platform === 'win32' ? has('winget') : false,
      ])
    : (['missing', false, false, false, false, false] as const);
  type Item = vscode.QuickPickItem & { id: string };
  const sep = (label: string): Item => ({ id: '', label, kind: vscode.QuickPickItemKind.Separator });
  const native: Item[] = [
    ...(brew ? [{ id: 'brew', label: '$(package) Install Redis Stack with Homebrew', description: 'time series included', detail: 'brew tap redis-stack/redis-stack && brew install redis-stack-server' }] : []),
    ...(apt && port === 6379 ? [{ id: 'apt', label: '$(package) Install Redis with apt', description: 'no time series · needs Redis 6.2+ (distro packages may be older)', detail: 'sudo apt-get install -y redis-server — you type your password in the terminal' }] : []),
    ...(!apt && dnf && port === 6379 ? [{ id: 'dnf', label: '$(package) Install Redis with dnf', description: 'no time series · needs Redis 6.2+ (distro packages may be older)', detail: 'sudo dnf install -y redis — you type your password in the terminal' }] : []),
    ...(wsl && port === 6379 ? [{ id: 'wsl', label: '$(terminal-linux) Install Redis in WSL (Ubuntu)', description: 'no time series · needs Redis 6.2+ (distro packages may be older)', detail: 'Runs redis-server inside WSL; Windows reaches it on localhost' }] : []),
    ...(winget && port === 6379 ? [{ id: 'memurai', label: '$(package) Install Memurai (Redis for Windows)', description: 'no time series', detail: 'winget install Memurai.MemuraiDeveloper — runs as a Windows service' }] : []),
  ];
  const getDocker: Item[] =
    dockerNow === 'missing' && local && !current.ok
      ? [{ id: 'getDocker', label: '$(cloud-download) Install Docker Desktop first', detail: brew ? 'brew install --cask docker — then run this command again for Redis Stack' : winget ? 'winget install -e --id Docker.DockerDesktop — then run this command again for Redis Stack' : 'Opens the Docker download page — then run this command again for Redis Stack' }]
      : [];
  const items: Item[] = [
    ...(current.ok
      ? [{ id: 'use', label: `$(check) Use the Redis at ${redactRedisUrl(url)}`, description: `Redis ${current.version ?? '?'} · time series ${current.timeseries ? 'yes' : 'no'}`, detail: 'LocalPilot writes localpilot:* streams there — a dedicated db (redis://host:port/15) keeps them apart from app data' }]
      : []),
    ...(dockerNow === 'running' ? [{ id: 'docker', label: '$(vm) Start Redis Stack in Docker', description: 'recommended', detail: `${IMAGE} on 127.0.0.1:${port} · capped at 256 MB · data kept in the "${CONTAINER}" volume` }] : []),
    ...(dockerNow === 'stopped' ? [{ id: 'startDocker', label: '$(debug-start) Start Docker, then Redis Stack', description: 'recommended', detail: 'Docker is installed but not running — LocalPilot starts it and waits for it' }] : []),
    ...(dockerNow === 'denied' ? [{ id: 'dockerDenied', label: '$(warning) Docker is running but this user cannot reach it', detail: DOCKER_GROUP_FIX }] : []),
    ...(native.length ? [sep('Without Docker'), ...native] : []),
    ...getDocker,
    sep('Other'),
    { id: 'url', label: '$(plug) Connect to an existing Redis…', detail: 'redis://[user:password@]host:port[/db] — Redis Stack adds time series' },
    ...(enabled ? [{ id: 'off', label: '$(circle-slash) Turn Redis storage off', detail: 'Telemetry goes back to daily files in ~/.localpilot/telemetry' }] : [{ id: 'files', label: '$(check) Keep using local files', detail: 'Nothing to install. Chat memory is already capped without Redis (localpilot.storage.sessionsInMemory)' }]),
    { id: 'docs', label: '$(book) What does this do?', detail: 'Optional: moves telemetry history and logs out of VS Code\u2019s memory' },
  ];
  const why = !local || dockerNow === 'running' ? '' : dockerNow === 'stopped' ? ' Docker is installed but not running.' : dockerNow === 'denied' ? ' Docker is running but access is denied.' : ' Docker is not installed.';
  const pick = await vscode.window.showQuickPick(items, {
    title: 'LocalPilot: Redis storage (optional)',
    placeHolder: current.ok
      ? `A Redis is already answering at ${redactRedisUrl(url)}. Use it for LocalPilot telemetry?`
      : `${current.error && /too old/i.test(current.error) ? current.error : `No Redis answering at ${redactRedisUrl(url)}.`}${why} How should LocalPilot get one?`,
    matchOnDetail: true,
  });
  if (!pick || !pick.id) {
    return;
  }
  const cfg = vscode.workspace.getConfiguration('localpilot');
  const terminal = (cmd: string) => {
    const term = vscode.window.createTerminal({ name: 'LocalPilot · Redis' });
    term.show(true);
    term.sendText(cmd);
  };
  const installAndWait = async (cmd: string, what: string) => {
    terminal(cmd);
    const p = await waitFor(url, `Installing ${what}… (follow the "LocalPilot · Redis" terminal)`, 15 * 60_000);
    if (p) {
      await enable(url, p, log);
    } else {
      void vscode.window.showWarningMessage(`${what} is not answering at ${redactRedisUrl(url)} yet. When the install in the terminal finishes, run "LocalPilot: Set Up Redis Storage" again.`);
    }
  };
  switch (pick.id) {
    case 'use':
      await enable(url, current, log);
      return;
    case 'docs':
      void vscode.env.openExternal(vscode.Uri.parse(DOCS));
      return;
    case 'files':
      return;
    case 'dockerDenied':
      void vscode.window.showInformationMessage(`Docker is running, but this user cannot reach it. Run: ${DOCKER_GROUP_FIX}. Then run "LocalPilot: Set Up Redis Storage" again.`);
      return;
    case 'off':
      await cfg.update('storage.redis.enabled', false, vscode.ConfigurationTarget.Global);
      void vscode.window.showInformationMessage('LocalPilot telemetry is back on local files.');
      return;
    case 'url': {
      const next = await vscode.window.showInputBox({
        title: 'Redis URL',
        value: url,
        prompt: 'redis://[user:password@]host:port[/db] (rediss:// for TLS)',
        ignoreFocusOut: true,
        validateInput: (v) => {
          try {
            parseRedisUrl(v);
            return undefined;
          } catch (e) {
            return e instanceof Error ? e.message : String(e);
          }
        },
      });
      if (!next) {
        return;
      }
      const p = await probeRedis(next);
      if (!p.ok) {
        void vscode.window.showErrorMessage(`Cannot connect to ${redactRedisUrl(next)}: ${p.error ?? 'no answer'}`);
        return;
      }
      await enable(next, p, log);
      return;
    }
    case 'startDocker':
    case 'docker': {
      if (pick.id === 'startDocker' && !(await startDocker())) {
        void vscode.window.showWarningMessage('Docker did not start. Start Docker Desktop yourself, then run "LocalPilot: Set Up Redis Storage" again — or pick one of the options without Docker.');
        return;
      }
      const state = await docker(['ps', '-a', '--filter', `name=^/${CONTAINER}$`, '--format', '{{.State}}']).catch(() => '');
      if (state) {
        await docker(['start', CONTAINER]).catch((e) => log.warn(`docker start ${CONTAINER}: ${String(e)}`));
      } else {
        terminal(dockerRunCommand(port));
      }
      const p = await waitFor(url, state ? 'Starting Redis Stack…' : 'Starting Redis Stack (the first run downloads the image)…', 5 * 60_000);
      if (p) {
        await enable(url, p, log);
      } else {
        void vscode.window.showWarningMessage(`Redis did not come up at ${redactRedisUrl(url)}. Check the "LocalPilot · Redis" terminal, then run this command again.`);
      }
      return;
    }
    case 'brew':
      return installAndWait(`brew tap redis-stack/redis-stack && brew install redis-stack-server && redis-stack-server --daemonize yes --port ${port}`, 'Redis Stack');
    case 'apt':
      return installAndWait('sudo apt-get update && sudo apt-get install -y redis-server && sudo systemctl enable --now redis-server', 'Redis');
    case 'dnf':
      return installAndWait('sudo dnf install -y redis && sudo systemctl enable --now redis', 'Redis');
    case 'wsl':
      return installAndWait('wsl -e sh -c "sudo apt-get update && sudo apt-get install -y redis-server && redis-server --daemonize yes"', 'Redis (WSL)');
    case 'memurai':
      return installAndWait('winget install -e --id Memurai.MemuraiDeveloper', 'Memurai');
    case 'getDocker':
      if (brew) {
        terminal('brew install --cask docker && open -a Docker');
      } else if (winget) {
        terminal('winget install -e --id Docker.DockerDesktop');
      } else {
        void vscode.env.openExternal(vscode.Uri.parse('https://docs.docker.com/get-started/get-docker/'));
      }
      void vscode.window.showInformationMessage('When Docker Desktop is installed and running, run "LocalPilot: Set Up Redis Storage" again to start Redis Stack.');
      return;
  }
}

/**
 * Background restart for the supervisor: brings back a local Redis that was set up before — the LocalPilot Docker
 * container, or a native `redis-stack-server` / `redis-server` as a daemon. Never installs anything; returns whether
 * Redis answers afterwards. Remote URLs are left alone.
 */
export async function restartRedis(url: string, log: Logger): Promise<boolean> {
  let port: number;
  try {
    const t = parseRedisUrl(url);
    if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(t.host)) {
      return false;
    }
    port = t.port;
  } catch {
    return false;
  }
  let started = false;
  if ((await dockerState()) === 'running' && (await docker(['ps', '-a', '--filter', `name=^/${CONTAINER}$`, '--format', '{{.State}}']).catch(() => ''))) {
    started = await docker(['start', CONTAINER]).then(() => true, (e) => (log.warn(`supervisor: docker start ${CONTAINER}: ${String(e)}`), false));
  }
  const native = started || process.platform === 'win32' ? [] : ['redis-stack-server', 'redis-server'];
  const dir = path.join(os.homedir(), '.localpilot', 'redis');
  if (native.length) {
    await fs.promises.mkdir(dir, { recursive: true });
  }
  for (const bin of native) {
    if (await onPath(bin)) {
      // A data dir of its own: from cwd `/` BGSAVE fails and Redis then refuses writes (MISCONF).
      started = await run(bin, ['--daemonize', 'yes', '--port', String(port), '--dir', dir, '--logfile', path.join(dir, 'redis.log')], 15_000, dir).then(() => true, (e) => (log.warn(`supervisor: ${bin}: ${String(e)}`), false));
      break;
    }
  }
  if (!started) {
    return false;
  }
  for (let i = 0; i < 30; i++) {
    if ((await probeRedis(url)).ok) {
      return true;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}
