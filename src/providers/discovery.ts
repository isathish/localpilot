import * as cp from 'child_process';
import * as vscode from 'vscode';
import { DEFAULT_PROVIDERS } from '../config';
import { ProviderConfig } from '../types';
import { createProvider } from './registry';

/** Well-known local endpoints beyond the shipped defaults; probed (never written) unless they answer. */
export const KNOWN_ENDPOINTS: ProviderConfig[] = [
  ...DEFAULT_PROVIDERS,
  { id: 'docker', type: 'openai', baseUrl: 'http://localhost:12434/engines/v1', displayName: 'Docker Model Runner' },
  { id: 'jan', type: 'openai', baseUrl: 'http://localhost:1337/v1', displayName: 'Jan' },
  { id: 'sglang', type: 'openai', baseUrl: 'http://localhost:30000/v1', displayName: 'SGLang' },
  { id: 'koboldcpp', type: 'openai', baseUrl: 'http://localhost:5001/v1', displayName: 'KoboldCpp' },
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
    const ok = await provider.healthCheck(ctl.signal);
    if (!ok) {
      return { ...base, latencyMs: Date.now() - started, error: 'No response — is the server running?' };
    }
    const models = await provider.listModels(ctl.signal);
    return {
      ...base,
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
  const r = await exec('docker', ['ps', '--format', '{{json .}}'], 4000);
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
export async function dockerModelRunnerState(tcpReachable: boolean): Promise<DockerModelRunnerState> {
  if (tcpReachable) {
    return 'ready';
  }
  const r = await exec('docker', ['model', 'status'], 5000);
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

/**
 * Probes configured providers, well-known endpoints and Docker containers; merges every reachable
 * server that is not configured yet into `localpilot.providers`. Never removes or edits user entries.
 */
export async function autoDetectProviders(log: vscode.LogOutputChannel, opts: { write?: boolean } = {}): Promise<DetectionReport> {
  const cfg = vscode.workspace.getConfiguration('localpilot');
  const configured = cfg.get<ProviderConfig[]>('providers', DEFAULT_PROVIDERS);
  const norm = (u: string) => u.replace(/\/+$/, '').toLowerCase();
  const seen = new Set(configured.map((p) => norm(p.baseUrl)));
  const ids = new Set(configured.map((p) => p.id));

  const docker = await discoverDockerProviders();
  const candidates: { cfg: ProviderConfig; configured: boolean; source: ProbeResult['source'] }[] = configured.map((c) => ({ cfg: c, configured: true, source: 'settings' as const }));
  for (const k of KNOWN_ENDPOINTS) {
    if (!seen.has(norm(k.baseUrl))) {
      seen.add(norm(k.baseUrl));
      candidates.push({ cfg: k, configured: false, source: 'known' });
    }
  }
  for (const d of docker) {
    if (!seen.has(norm(d.baseUrl))) {
      seen.add(norm(d.baseUrl));
      candidates.push({ cfg: d, configured: false, source: 'docker' });
    }
  }

  const results = await Promise.all(candidates.map((c) => probeProvider(c.cfg, c.configured, c.source)));
  const dmrReachable = results.some((r) => r.ok && /:12434\//.test(r.baseUrl));
  const dockerModelRunner = await dockerModelRunnerState(dmrReachable);

  const added: ProviderConfig[] = [];
  for (const r of results) {
    if (!r.ok || r.configured) {
      continue;
    }
    const c = candidates.find((x) => x.cfg.baseUrl === r.baseUrl)!.cfg;
    let id = c.id;
    for (let n = 2; ids.has(id); n++) {
      id = `${c.id}-${n}`;
    }
    ids.add(id);
    added.push({ ...c, id });
  }
  if (added.length && opts.write !== false) {
    await cfg.update('providers', [...configured, ...added], vscode.ConfigurationTarget.Global);
    log.info(`auto-detect: added ${added.map((a) => `${a.id} (${a.baseUrl})`).join(', ')}`);
  }
  const recommended = recommendModel(results.filter((r) => r.ok && r.enabled).flatMap((r) => r.models));
  return { results, added, dockerModelRunner, recommended };
}
