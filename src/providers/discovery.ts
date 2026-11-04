import * as cp from 'child_process';
import * as vscode from 'vscode';
import { DEFAULT_PROVIDERS, editableProviders } from '../config';
import { ProviderConfig } from '../types';
import { isRemoteUrl, missingKeyReason, resolveApiKey } from './cloud';
import { COLIBRI_DEFAULT_PORT } from './colibri';
import { createProvider } from './registry';

/** Well-known local endpoints beyond the shipped defaults; probed (never written) unless they answer. */
export const KNOWN_ENDPOINTS: ProviderConfig[] = [
  ...DEFAULT_PROVIDERS,
  { id: 'docker', type: 'openai', baseUrl: 'http://localhost:12434/engines/v1', displayName: 'Docker Model Runner' },
  { id: 'jan', type: 'openai', baseUrl: 'http://localhost:1337/v1', displayName: 'Jan' },
  { id: 'sglang', type: 'openai', baseUrl: 'http://localhost:30000/v1', displayName: 'SGLang' },
  { id: 'koboldcpp', type: 'openai', baseUrl: 'http://localhost:5001/v1', displayName: 'KoboldCpp' },
  // Gateways run locally but forward prompts to cloud models: marked so automatic picks keep preferring local models.
  { id: 'omniroute', type: 'openai', baseUrl: 'http://localhost:20128/v1', displayName: 'OmniRoute', cloud: true },
  { id: 'litellm', type: 'openai', baseUrl: 'http://localhost:4000/v1', displayName: 'LiteLLM', cloud: true },
];

export interface ProbeResult {
  id: string;
  displayName: string;
  type: ProviderConfig['type'];
  baseUrl: string;
  configured: boolean;
  enabled: boolean;
  ok: boolean;
  latencyMs: number;
  models: { id: string; name: string; contextWindow: number; supportsTools: boolean; supportsVision: boolean; supportsFim?: boolean }[];
  error?: string;
  /** Where the candidate came from (Docker container name for container-hosted servers). */
  source?: 'settings' | 'known' | 'docker';
  /** Engine the server identified itself as (colibri answers on vLLM's port, :8000). */
  engine?: 'colibri';
}

/** Health-check one provider and list its models, with a hard timeout so an unreachable host never hangs the UI. */
export async function probeProvider(cfg: ProviderConfig, configured: boolean, source?: ProbeResult['source']): Promise<ProbeResult> {
  const base: ProbeResult = { id: cfg.id, displayName: cfg.displayName || cfg.id, type: cfg.type, baseUrl: cfg.baseUrl, configured, enabled: cfg.enabled !== false, ok: false, latencyMs: 0, models: [], source };
  if (!/^https?:\/\//i.test(cfg.baseUrl)) {
    return { ...base, error: 'Base URL must start with http:// or https://' };
  }
  const started = Date.now();
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 4000);
  try {
    const provider = createProvider(cfg);
    const remote = isRemoteUrl(cfg.baseUrl);
    // Cloud URLs and Claude's API always need a key; a local gateway may not.
    if ((remote || cfg.type === 'anthropic') && !resolveApiKey(cfg)) {
      return { ...base, error: missingKeyReason(cfg) };
    }
    // A cloud API is always up; skipping the bare health check surfaces its real error (invalid key, no access).
    const ok = remote || (await provider.healthCheck(ctl.signal));
    if (!ok) {
      return { ...base, latencyMs: Date.now() - started, error: 'No response — is the server running?' };
    }
    const models = await provider.listModels(ctl.signal);
    return {
      ...base,
      displayName: provider.displayName,
      engine: models.some((m) => m.runtime === 'colibri') ? 'colibri' : undefined,
      ok: true,
      latencyMs: Date.now() - started,
      models: models.map((m) => ({ id: m.id, name: m.name, contextWindow: m.contextWindow, supportsTools: m.supportsTools, supportsVision: m.supportsVision, supportsFim: m.supportsFim })),
    };
  } catch (e) {
    return { ...base, latencyMs: Date.now() - started, error: e instanceof Error ? e.message : String(e) };
  } finally {
    clearTimeout(timer);
  }
}

/** Recommend a default model for setup: tool-capable coder models first, then by size hint in the name. */
export function recommendModel(models: ProbeResult['models']): string | undefined {
  const score = (m: ProbeResult['models'][number]) => {
    const n = m.name.toLowerCase();
    const size = /(\d+(?:\.\d+)?)b/.exec(n);
    const b = size ? parseFloat(size[1]) : 7;
    return (m.supportsTools ? 10 : 0) + (/coder|devstral|codestral/.test(n) ? 5 : 0) + (/qwen|llama|mistral|gemma|deepseek|gpt-oss/.test(n) ? 2 : 0) + Math.min(b, 32) / 8 - (b > 40 ? 3 : 0) - (/embed|rerank|vision|vl|llava|whisper/.test(n) ? 20 : 0);
  };
  return [...models].sort((a, b) => score(b) - score(a))[0]?.id;
}

// ------------------------------------------------------------------ Docker

interface DockerImageRule {
  match: RegExp;
  label: string;
  type: ProviderConfig['type'];
  /** Port the server listens on inside the container. */
  port: number;
  path: string;
}

/** Container images that serve models; matched against `docker ps` image names. */
const DOCKER_IMAGES: DockerImageRule[] = [
  { match: /ollama/i, label: 'Ollama', type: 'ollama', port: 11434, path: '' },
  { match: /colibri/i, label: 'colibri', type: 'openai', port: 8000, path: '/v1' },
  { match: /vllm/i, label: 'vLLM', type: 'openai', port: 8000, path: '/v1' },
  { match: /llama\.?cpp|ggml|ggerganov/i, label: 'llama.cpp', type: 'openai', port: 8080, path: '/v1' },
  { match: /localai/i, label: 'LocalAI', type: 'openai', port: 8080, path: '/v1' },
  { match: /text-generation-inference|\/tgi/i, label: 'TGI', type: 'openai', port: 80, path: '/v1' },
  { match: /sglang/i, label: 'SGLang', type: 'openai', port: 30000, path: '/v1' },
  { match: /model-runner/i, label: 'Docker Model Runner', type: 'openai', port: 12434, path: '/engines/v1' },
  { match: /koboldcpp/i, label: 'KoboldCpp', type: 'openai', port: 5001, path: '/v1' },
  { match: /lmstudio|lm-studio/i, label: 'LM Studio', type: 'openai', port: 1234, path: '/v1' },
  { match: /open-webui/i, label: 'Open WebUI', type: 'openai', port: 8080, path: '/api' },
];

interface DockerPs {
  Image: string;
  Names: string;
  Ports: string;
}

function exec(cmd: string, args: string[], timeoutMs: number): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve) => {
    let out = '';
    let done = false;
    const child = cp.spawn(cmd, args, { stdio: ['ignore', 'pipe', 'ignore'] });
    const timer = setTimeout(() => {
      if (!done) {
        child.kill();
        resolve({ ok: false, out });
      }
    }, timeoutMs);
    child.stdout.on('data', (d) => (out += String(d)));
    child.on('error', () => {
      done = true;
      clearTimeout(timer);
      resolve({ ok: false, out });
    });
    child.on('close', (code) => {
      done = true;
      clearTimeout(timer);
      resolve({ ok: code === 0, out });
    });
  });
}

/** Parses the `Ports` column of `docker ps` into container-port → host-port. */
export function parseDockerPorts(ports: string): Map<number, number> {
  const map = new Map<number, number>();
  const re = /(?:[\d.]+|\[[^\]]*\]|):(\d+)->(\d+)\/tcp/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(ports))) {
    const host = Number(m[1]);
    const container = Number(m[2]);
    if (!map.has(container)) {
      map.set(container, host);
    }
  }
  return map;
}

/** Turns `docker ps` rows into provider candidates for containers running known model servers. */
export function providersFromContainers(rows: DockerPs[]): ProviderConfig[] {
  const out: ProviderConfig[] = [];
  for (const row of rows) {
    const rule = DOCKER_IMAGES.find((r) => r.match.test(row.Image));
    if (!rule) {
      continue;
    }
    const ports = parseDockerPorts(row.Ports ?? '');
    const host = ports.get(rule.port) ?? [...ports.values()][0];
    if (!host) {
      continue;
    }
    const name = String(row.Names ?? '').split(',')[0].replace(/^\//, '');
    const id = `docker-${name}`.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/-+$/, '');
    out.push({ id, type: rule.type, baseUrl: `http://localhost:${host}${rule.path}`, displayName: `${rule.label} (Docker · ${name})` });
  }
  return out;
}

/** Running containers that look like model servers, mapped to their published host ports. Empty when Docker is absent. */
export async function discoverDockerProviders(): Promise<ProviderConfig[]> {
  const r = await exec('docker', ['ps', '--format', '{{json .}}'], 3000);
  if (!r.ok || !r.out.trim()) {
    return [];
  }
  const rows: DockerPs[] = [];
  for (const line of r.out.split('\n')) {
    try {
      rows.push(JSON.parse(line) as DockerPs);
    } catch {
      /* skip */
    }
  }
  return providersFromContainers(rows);
}

export type DockerModelRunnerState = 'absent' | 'stopped' | 'no-tcp' | 'ready';

/** Docker Desktop's built-in Model Runner: present but only reachable from containers unless TCP access is enabled. */
export async function dockerModelRunnerState(tcpReachable: boolean | Promise<boolean>): Promise<DockerModelRunnerState> {
  // `docker model status` can block for a long time while the runner restarts, so cap it and run it alongside the probes.
  const status = exec('docker', ['model', 'status'], 2500);
  if (await tcpReachable) {
    return 'ready';
  }
  const r = await status;
  if (!r.ok) {
    return 'absent';
  }
  return /running/i.test(r.out) ? 'no-tcp' : 'stopped';
}

// ------------------------------------------------------------------ Auto-detect

export interface DetectionReport {
  results: ProbeResult[];
  /** Reachable servers that were not in settings and have now been added. */
  added: ProviderConfig[];
  dockerModelRunner: DockerModelRunnerState;
  recommended?: string;
}

/** Identity of a server URL: loopback aliases, default ports and a trailing `/v1` or `/engines/v1` compare equal. */
export function endpointKey(u: string): string {
  try {
    const url = new URL(u);
    let host = url.hostname.toLowerCase();
    if (['127.0.0.1', '[::1]', '::1', '0.0.0.0'].includes(host)) {
      host = 'localhost';
    }
    const port = url.port || (url.protocol === 'https:' ? '443' : '80');
    const path = url.pathname.replace(/\/+$/, '').replace(/(?:\/engines)?\/v1$/i, '');
    return `${url.protocol}//${host}:${port}${path}`;
  } catch {
    return u.replace(/\/+$/, '').toLowerCase();
  }
}

/**
 * Probes configured providers, well-known endpoints and Docker containers; merges every reachable
 * server that is not configured yet into `localpilot.providers`. Never removes or edits user entries.
 */
export async function autoDetectProviders(log: vscode.LogOutputChannel, opts: { write?: boolean } = {}): Promise<DetectionReport> {
  const cfg = vscode.workspace.getConfiguration('localpilot');
  const configured = cfg.get<ProviderConfig[]>('providers', DEFAULT_PROVIDERS);
  const seen = new Set(configured.map((p) => endpointKey(p.baseUrl)));
  const ids = new Set(configured.map((p) => p.id));

  const docker = discoverDockerProviders();
  const candidates: { cfg: ProviderConfig; configured: boolean; source: ProbeResult['source'] }[] = configured.map((c) => ({ cfg: c, configured: true, source: 'settings' as const }));
  const colibriPort = cfg.get<number>('colibri.port', COLIBRI_DEFAULT_PORT);
  const known = colibriPort && colibriPort !== COLIBRI_DEFAULT_PORT ? [...KNOWN_ENDPOINTS, { id: 'colibri', type: 'openai' as const, baseUrl: `http://localhost:${colibriPort}/v1`, displayName: 'colibri' }] : KNOWN_ENDPOINTS;
  for (const k of known) {
    if (!seen.has(endpointKey(k.baseUrl))) {
      seen.add(endpointKey(k.baseUrl));
      candidates.push({ cfg: k, configured: false, source: 'known' });
    }
  }
  const staticResults = Promise.all(candidates.map((c) => probeProvider(c.cfg, c.configured, c.source)));
  const dmrState = dockerModelRunnerState(staticResults.then((rs) => rs.some((r) => r.ok && /:12434\//.test(r.baseUrl))));

  const dockerCandidates: typeof candidates = [];
  for (const d of await docker) {
    if (!seen.has(endpointKey(d.baseUrl))) {
      seen.add(endpointKey(d.baseUrl));
      dockerCandidates.push({ cfg: d, configured: false, source: 'docker' });
    }
  }
  const results = [...(await staticResults), ...(await Promise.all(dockerCandidates.map((c) => probeProvider(c.cfg, c.configured, c.source))))];
  candidates.push(...dockerCandidates);
  const dockerModelRunner = await dmrState;

  const added: ProviderConfig[] = [];
  for (const r of results) {
    if (!r.ok || r.configured) {
      continue;
    }
    const found = candidates.find((x) => x.cfg.baseUrl === r.baseUrl)!.cfg;
    // A well-known port answered by colibri (vLLM's :8000, or the configured colibri port) is labelled for what it is.
    const c = r.engine === 'colibri' && r.source !== 'docker' ? { ...found, id: 'colibri', displayName: 'colibri' } : found;
    let id = c.id;
    for (let n = 2; ids.has(id); n++) {
      id = `${c.id}-${n}`;
    }
    ids.add(id);
    added.push({ ...c, id });
  }
  if (added.length && opts.write !== false) {
    // Probing takes seconds: merge into the list as it is now, so a provider added meanwhile (Settings, Start
    // Gateway, setup) is kept, and a server that was added meanwhile is not added twice.
    const { list: current, target } = editableProviders();
    const urls = new Set(current.map((p) => endpointKey(p.baseUrl)));
    const taken = new Set(current.map((p) => p.id));
    const fresh = added.filter((a) => !urls.has(endpointKey(a.baseUrl))).map((a) => {
      let id = a.id;
      for (let n = 2; taken.has(id); n++) {
        id = `${a.id.replace(/-\d+$/, '')}-${n}`;
      }
      taken.add(id);
      return { ...a, id };
    });
    added.splice(0, added.length, ...fresh);
    if (fresh.length && target !== vscode.ConfigurationTarget.Global) {
      // A workspace list overrides the user one: leave the workspace file alone.
      log.info(`auto-detect: found ${fresh.map((a) => `${a.id} (${a.baseUrl})`).join(', ')} but this workspace defines localpilot.providers; not adding`);
      added.splice(0);
    } else if (fresh.length) {
      await vscode.workspace.getConfiguration('localpilot').update('providers', [...current, ...fresh], target);
      log.info(`auto-detect: added ${fresh.map((a) => `${a.id} (${a.baseUrl})`).join(', ')}`);
    }
  }
  const recommended = recommendModel(results.filter((r) => r.ok && r.enabled).flatMap((r) => r.models));
  return { results, added, dockerModelRunner, recommended };
}
