// Is this machine online? Drives the chat's offline banner, the status-bar indicator and the router's offline fallback
// (cloud models are skipped while a local one exists). Pure Node, no vscode: the checks are injectable for tests.
//
// How it decides, cheapest first, and never by contacting anything the user did not configure:
// 1. No network interface besides loopback and link-local addresses: offline (Wi-Fi off, cable out, airplane mode).
// 2. With cloud providers configured and no proxy in the way, their host names are resolved against the DNS servers
//    directly (no OS cache). A server that answers, even "no such name", means online; when every lookup times out or
//    is refused, the machine is offline. Two failed checks in a row are needed, so one slow lookup does not flap it.
// Without cloud providers only step 1 runs: local models work either way.
import * as dns from 'dns';
import * as os from 'os';
import type { ProviderConfig } from '../types';
import { isCloudProvider, isRemoteUrl } from './cloud';

export interface ConnectivityState {
  offline: boolean;
  /** When the current state began (epoch ms). */
  since: number;
}

export interface ConnectivityDeps {
  interfaces?: () => NodeJS.Dict<os.NetworkInterfaceInfo[]>;
  /** Resolves `host` against the DNS servers; rejects with the resolver's error (its `code`). */
  resolve?: (host: string) => Promise<unknown>;
  /** Cloud providers whose hosts may be looked up. */
  providers?: () => ProviderConfig[];
  /** A proxy is configured (env or `http.proxy`): DNS may legitimately fail, so only interfaces count. */
  proxy?: () => boolean;
  now?: () => number;
}

/** Resolver errors that mean the DNS servers could not be reached at all. */
const UNREACHABLE = new Set(['ETIMEOUT', 'ETIMEDOUT', 'ECONNREFUSED', 'ENETUNREACH', 'EHOSTUNREACH', 'ENETDOWN', 'EAI_AGAIN', 'ECONNRESET', 'ECANCELLED']);

/** Model errors that suggest the network went away (a check is due), as opposed to a server that answered badly. */
export const NETWORK_ERROR_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH', 'ENETDOWN', 'ETIMEDOUT', 'ECONNRESET']);

/** True when some interface has an address other than loopback and link-local (169.254/16, fe80::/10). */
export function hasExternalInterface(ifaces: NodeJS.Dict<os.NetworkInterfaceInfo[]>): boolean {
  for (const list of Object.values(ifaces)) {
    for (const a of list ?? []) {
      if (a.internal) {
        continue;
      }
      const addr = a.address.toLowerCase();
      if ((a.family === 'IPv4' || (a.family as unknown) === 4) ? !addr.startsWith('169.254.') : !addr.startsWith('fe80:')) {
        return true;
      }
    }
  }
  return false;
}

/** Host names of the enabled cloud providers with a URL (VS Code's language models have none to look up). */
export function probeHosts(providers: ProviderConfig[]): string[] {
  const hosts = new Set<string>();
  for (const p of providers) {
    if (p.enabled === false || p.type === 'vscode-lm' || !isCloudProvider(p)) {
      continue;
    }
    const url = p.baseUrl || (p.type === 'anthropic' ? 'https://api.anthropic.com' : '');
    if (!url || !isRemoteUrl(url)) {
      continue;
    }
    try {
      const host = new URL(url).hostname.replace(/^\[|\]$/g, '');
      if (host && !/^[\d.]+$/.test(host) && !host.includes(':')) {
        hosts.add(host);
      }
    } catch {
      /* not a URL: nothing to look up */
    }
  }
  return [...hosts].slice(0, 3);
}

/** One check: false only when the machine is clearly offline. */
export async function checkOnline(deps: Required<Pick<ConnectivityDeps, 'interfaces' | 'resolve' | 'providers' | 'proxy'>>): Promise<boolean> {
  let ifaces: NodeJS.Dict<os.NetworkInterfaceInfo[]>;
  try {
    ifaces = deps.interfaces();
  } catch {
    return true;
  }
  if (!hasExternalInterface(ifaces)) {
    return false;
  }
  const hosts = deps.proxy() ? [] : probeHosts(deps.providers());
  if (!hosts.length) {
    return true;
  }
  const results = await Promise.all(hosts.map((h) => deps.resolve(h).then(() => true, (e: unknown) => !UNREACHABLE.has(String((e as { code?: unknown })?.code ?? '')))));
  return results.some(Boolean);
}

function defaultResolve(host: string): Promise<unknown> {
  const r = new dns.promises.Resolver({ timeout: 3000, tries: 1 });
  return r.resolve(host);
}

export function proxyConfigured(setting?: string): boolean {
  return !!(setting || process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy || process.env.ALL_PROXY || process.env.all_proxy);
}

/** Polls (30 s online, 5 s offline) and on demand; `onChange` fires when the state flips. */
export class ConnectivityMonitor {
  private state: ConnectivityState;
  private timer?: ReturnType<typeof setTimeout>;
  private running?: Promise<ConnectivityState>;
  private failures = 0;
  private disposed = false;
  private readonly listeners = new Set<(s: ConnectivityState) => void>();
  private readonly deps: Required<ConnectivityDeps>;

  static readonly ONLINE_POLL_MS = 30_000;
  static readonly OFFLINE_POLL_MS = 5_000;

  constructor(deps: ConnectivityDeps = {}) {
    this.deps = {
      interfaces: deps.interfaces ?? (() => os.networkInterfaces()),
      resolve: deps.resolve ?? defaultResolve,
      providers: deps.providers ?? (() => []),
      proxy: deps.proxy ?? (() => proxyConfigured()),
      now: deps.now ?? Date.now,
    };
    this.state = { offline: false, since: this.deps.now() };
  }

  get current(): ConnectivityState {
    return this.state;
  }

  onChange(cb: (s: ConnectivityState) => void): { dispose(): void } {
    this.listeners.add(cb);
    return { dispose: () => this.listeners.delete(cb) };
  }

  /** Starts polling; the first check runs at once. */
  start(): void {
    void this.check();
  }

  /** Checks now (a running check is shared) and reschedules the next poll. */
  check(): Promise<ConnectivityState> {
    if (this.disposed) {
      return Promise.resolve(this.state);
    }
    this.running ??= (async () => {
      try {
        const online = await checkOnline(this.deps);
        // Interfaces gone is certain at once; a failed lookup needs a second one in a row.
        const definite = !online && !hasExternalInterfaceSafe(this.deps.interfaces);
        this.failures = online ? 0 : this.failures + 1;
        const offline = online ? false : definite || this.failures >= 2 ? true : this.state.offline;
        this.set(offline);
      } finally {
        this.running = undefined;
        this.schedule();
      }
      return this.state;
    })();
    return this.running;
  }

  /**
   * A hint that the network changed (the webview's online/offline events, a model call that failed with a network
   * error): check now, and right away again for "offline" so the second confirming lookup does not wait a poll.
   */
  hint(online: boolean): void {
    void this.check().then(() => {
      if (!online && !this.state.offline && this.failures === 1) {
        void this.check();
      }
    });
  }

  private set(offline: boolean): void {
    if (offline === this.state.offline) {
      return;
    }
    this.state = { offline, since: this.deps.now() };
    for (const cb of this.listeners) {
      try {
        cb(this.state);
      } catch {
        /* a listener's failure must not stop the others */
      }
    }
  }

  private schedule(): void {
    clearTimeout(this.timer);
    if (this.disposed) {
      return;
    }
    this.timer = setTimeout(() => void this.check(), this.state.offline || this.failures ? ConnectivityMonitor.OFFLINE_POLL_MS : ConnectivityMonitor.ONLINE_POLL_MS);
    // Never keeps the process (CLI, tests) alive on its own.
    (this.timer as { unref?: () => void }).unref?.();
  }

  dispose(): void {
    this.disposed = true;
    clearTimeout(this.timer);
    this.listeners.clear();
  }
}

function hasExternalInterfaceSafe(interfaces: () => NodeJS.Dict<os.NetworkInterfaceInfo[]>): boolean {
  try {
    return hasExternalInterface(interfaces());
  } catch {
    return true;
  }
}
