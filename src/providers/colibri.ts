// colibri (github.com/JustVugg/colibri): a pure-C engine that runs very large mixture-of-experts models by keeping the
// dense part in RAM and streaming the routed experts from disk. `coli serve` exposes an OpenAI-compatible API on :8000.
// What LocalPilot needs to know about it: which models fit by their *resident* RAM (not the 20–1500 GB download), which
// ones stream from disk (slow prefill, ~1 tok/s decode), and how many KV slots the server decodes at once.
import { ModelInfo } from '../types';
import { getJson, withTimeout } from './http';

export const COLIBRI_OWNER = 'colibri';
export const COLIBRI_DEFAULT_PORT = 8000;
export const COLIBRI_REPO_URL = 'https://github.com/JustVugg/colibri';

export interface ColibriSpec {
  /** colibri's `--model` name. */
  name: string;
  /** Matched against the served model id (`--model-id`, or the model folder name colibri falls back to). */
  match: RegExp;
  /** Total parameters, billions. */
  paramsB: number;
  /** Parameters active per token, billions (what decode speed depends on). */
  activeB?: number;
  /** Download / on-disk size in GB. */
  diskGb: number;
  /** Minimum RAM in GB: the resident dense part plus the smallest expert cache colibri accepts. */
  ramMinGb: number;
  /** RAM in GB at which colibri runs it comfortably (a larger expert cache). */
  ramGoodGb: number;
  tools: boolean;
  vision?: boolean;
  thinking?: boolean;
  /** Code-tuned (Qwen3-Coder). */
  coder?: boolean;
}

/** Engines and sizes from colibri's "Which model for my machine" table (RAM is minimum / comfortable). */
export const COLIBRI_MODELS: ColibriSpec[] = [
  { name: 'qwen3-coder-30b', match: /qwen3[-_.]?coder[-_.]?30b|qwen3[-_.]?coder(?!.*\d{3}b)/i, paramsB: 30, activeB: 3, diskGb: 19, ramMinGb: 8, ramGoodGb: 18, tools: true, coder: true },
  { name: 'qwen36-35b', match: /qwen3?[-_.]?6[-_.]?35b|qwen36/i, paramsB: 35, activeB: 3, diskGb: 23, ramMinGb: 10, ramGoodGb: 20, tools: true, thinking: true },
  { name: 'qwen38-27b', match: /qwen3?[-_.]?8[-_.]?27b/i, paramsB: 27, diskGb: 51, ramMinGb: 20, ramGoodGb: 30, tools: true, vision: true },
  { name: 'qwen38-flash-next', match: /qwen3?[-_.]?8[-_.]?flash/i, paramsB: 125, diskGb: 186, ramMinGb: 24, ramGoodGb: 32, tools: true, vision: true },
  { name: 'deepseek-v4-flash-reap', match: /deepseek[-_.]?v4[-_.]?flash[-_.]?reap/i, paramsB: 150, diskGb: 85, ramMinGb: 16, ramGoodGb: 32, tools: true },
  { name: 'deepseek-v4.1-flash', match: /deepseek[-_.]?v4[-_.]?1[-_.]?flash/i, paramsB: 552, diskGb: 510, ramMinGb: 18, ramGoodGb: 25, tools: true, vision: true },
  { name: 'deepseek-v4-flash', match: /deepseek[-_.]?v4[-_.]?flash/i, paramsB: 284, diskGb: 167, ramMinGb: 16, ramGoodGb: 32, tools: true },
  { name: 'mimo-v2.6-pro', match: /mimo[-_.]?v?2[-_.]?6[-_.]?pro/i, paramsB: 1020, diskGb: 564, ramMinGb: 54, ramGoodGb: 64, tools: true, vision: true },
  { name: 'mimo-v2.6-flash', match: /mimo/i, paramsB: 309, diskGb: 172, ramMinGb: 32, ramGoodGb: 52, tools: true, vision: true },
  { name: 'glm-5.3-flash', match: /glm[-_.]?5[-_.]?3[-_.]?flash/i, paramsB: 321, diskGb: 195, ramMinGb: 25, ramGoodGb: 25, tools: true, vision: true },
  { name: 'glm-5.3', match: /glm[-_.]?5[-_.]?3/i, paramsB: 744, diskGb: 419, ramMinGb: 16, ramGoodGb: 24, tools: true, thinking: true },
  { name: 'glm-5.2', match: /glm/i, paramsB: 744, diskGb: 429, ramMinGb: 16, ramGoodGb: 24, tools: true, thinking: true },
  { name: 'inkling', match: /inkling/i, paramsB: 975, diskGb: 514, ramMinGb: 25, ramGoodGb: 128, tools: true },
  { name: 'kimi-k3', match: /kimi/i, paramsB: 2800, diskGb: 1600, ramMinGb: 32, ramGoodGb: 64, tools: true },
  { name: 'olmoe', match: /olmoe/i, paramsB: 7, activeB: 1, diskGb: 7, ramMinGb: 8, ramGoodGb: 8, tools: false },
];

export function colibriSpec(modelId: string): ColibriSpec | undefined {
  return COLIBRI_MODELS.find((s) => s.match.test(modelId));
}

export function isColibri(m: Pick<ModelInfo, 'runtime'>): boolean {
  return m.runtime === 'colibri';
}

/**
 * True when the model's experts do not all fit in this machine's model budget, so colibri streams them from disk:
 * prefill runs at a few tokens per second and decode at about one, which is fine for one careful answer and far too
 * slow for many-step agent loops or ghost text.
 */
export function streamsFromDisk(m: Pick<ModelInfo, 'runtime' | 'diskGb'>, budgetGb: number | undefined): boolean {
  if (!isColibri(m) || m.diskGb === undefined) {
    return false;
  }
  return budgetGb === undefined ? m.diskGb > 32 : m.diskGb > budgetGb;
}

/** `/health` as `coli serve` reports it (scheduler and slots only when the request is authorised). */
export interface ColibriHealth {
  status?: string;
  arch?: string;
  kv_slots?: number;
  input_modalities?: string[];
  capabilities?: string[];
  scheduler?: { active?: number; queued?: number; capacity?: number; max_queue?: number; queue_timeout_seconds?: number };
}

/** The server root (where `/health` lives) for an OpenAI base URL such as `http://localhost:8000/v1`. */
export function colibriRoot(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '').replace(/\/v1$/i, '');
}

export async function colibriHealth(baseUrl: string, headers: Record<string, string>, signal?: AbortSignal): Promise<ColibriHealth | undefined> {
  try {
    return await getJson<ColibriHealth>(`${colibriRoot(baseUrl)}/health`, headers, withTimeout(2500, signal));
  } catch {
    return undefined;
  }
}

/** Requests colibri decodes together: its KV slots (each request on its own slot); 1 when it did not say. */
export function colibriSlots(h: ColibriHealth | undefined): number {
  const n = h?.scheduler?.capacity ?? h?.kv_slots;
  return typeof n === 'number' && n >= 1 ? Math.min(16, Math.floor(n)) : 1;
}

/** The `coli` launcher inside a colibri checkout, per platform. */
export function coliLauncher(folder: string, platform: NodeJS.Platform = process.platform): string {
  const sep = platform === 'win32' ? '\\' : '/';
  const root = folder.replace(/[\\/]+$/, '');
  return platform === 'win32' ? `${root}${sep}c${sep}coli.cmd` : `${root}${sep}c${sep}coli`;
}

/** Shell-safe quoting for a terminal command argument. */
function quote(s: string, platform: NodeJS.Platform): string {
  if (/^[\w./:@=+-]+$/.test(s)) {
    return s;
  }
  return platform === 'win32' ? `"${s.replace(/"/g, '""')}"` : `'${s.replace(/'/g, `'\\''`)}'`;
}

export interface ColibriServeOptions {
  /** colibri checkout folder; empty = `coli` on PATH. */
  folder?: string;
  /** `--model` value: a model name from the table or a model folder; empty = the one colibri's setup installed. */
  model?: string;
  port?: number;
  /** `--kv-slots`: conversations decoded together (parallel agents each get one). */
  kvSlots?: number;
  platform?: NodeJS.Platform;
}

/** The terminal command that starts `coli serve` on localhost. */
export function colibriServeCommand(o: ColibriServeOptions): string {
  const platform = o.platform ?? process.platform;
  const exe = o.folder ? quote(coliLauncher(o.folder, platform), platform) : 'coli';
  const args = ['serve', '--host', '127.0.0.1', '--port', String(o.port || COLIBRI_DEFAULT_PORT)];
  if (o.model) {
    args.push('--model', quote(o.model, platform));
  }
  if (o.kvSlots && o.kvSlots > 1) {
    args.push('--kv-slots', String(Math.min(16, Math.floor(o.kvSlots))));
  }
  // PowerShell needs the call operator to run a quoted path.
  return `${platform === 'win32' && exe.startsWith('"') ? '& ' : ''}${exe} ${args.join(' ')}`;
}
