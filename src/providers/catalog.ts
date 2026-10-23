import { ModelInfo } from '../types';
import { estimateModelGb, fits, parameterSizeB, SystemProfile } from './system';

/** What a model is routed to. `agent` is the default chat/agent model. */
export type ModelRole = 'agent' | 'completion' | 'vision' | 'reasoning';

/** Where a catalog model can be installed from LocalPilot. */
export type InstallTarget = 'ollama' | 'docker' | 'lmstudio';

export interface CatalogVariant {
  /** Size label shown in the UI, e.g. `7b`. */
  tag: string;
  paramsB: number;
  /** Approximate download / runtime footprint (Q4) in GB. */
  gb: number;
  /** Ollama model tag (`ollama pull <ollama>`). */
  ollama?: string;
  /** Docker Model Runner reference (`docker model pull <docker>`). */
  docker?: string;
  /** LM Studio download id — a Hugging Face GGUF repo for `lms get`. */
  lmstudio?: string;
}

export interface CatalogEntry {
  key: string;
  name: string;
  vendor: string;
  description: string;
  roles: ModelRole[];
  supportsTools: boolean;
  supportsFim: boolean;
  supportsVision: boolean;
  variants: CatalogVariant[];
  /** Index into `variants` that is the family's "sensible default" (used for runtimes that only publish one size). */
  defaultVariant?: number;
}

const q = (n: number) => Math.round(n * 10) / 10;

/**
 * Curated local models. Sizes are Q4-class footprints; the UI compares them against the machine's budget.
 * Only runtimes with a known id are offered for a given size — anything else can still be pulled by hand.
 */
export const MODEL_CATALOG: CatalogEntry[] = [
  {
    key: 'qwen2.5-coder',
    name: 'Qwen2.5 Coder',
    vendor: 'Alibaba',
    description: 'Best all-round coding family: native tool calling and fill-in-the-middle. The 7b is the recommended starter; 1.5b makes a snappy completion model.',
    roles: ['agent', 'completion'],
    supportsTools: true,
    supportsFim: true,
    supportsVision: false,
    defaultVariant: 3,
    variants: [
      { tag: '0.5b', paramsB: 0.5, gb: 0.4, ollama: 'qwen2.5-coder:0.5b', lmstudio: 'Qwen/Qwen2.5-Coder-0.5B-Instruct-GGUF' },
      { tag: '1.5b', paramsB: 1.5, gb: 1.0, ollama: 'qwen2.5-coder:1.5b', lmstudio: 'Qwen/Qwen2.5-Coder-1.5B-Instruct-GGUF' },
      { tag: '3b', paramsB: 3, gb: 1.9, ollama: 'qwen2.5-coder:3b', lmstudio: 'Qwen/Qwen2.5-Coder-3B-Instruct-GGUF' },
      { tag: '7b', paramsB: 7, gb: 4.7, ollama: 'qwen2.5-coder:7b', docker: 'ai/qwen2.5-coder', lmstudio: 'Qwen/Qwen2.5-Coder-7B-Instruct-GGUF' },
      { tag: '14b', paramsB: 14, gb: 9.0, ollama: 'qwen2.5-coder:14b', lmstudio: 'Qwen/Qwen2.5-Coder-14B-Instruct-GGUF' },
      { tag: '32b', paramsB: 32, gb: 20, ollama: 'qwen2.5-coder:32b', lmstudio: 'Qwen/Qwen2.5-Coder-32B-Instruct-GGUF' },
    ],
  },
  {
    key: 'qwen3',
    name: 'Qwen3',
    vendor: 'Alibaba',
    description: 'Strong general + coding model with tool calling and optional thinking. Great agent model from 4b up; 30b-a3b is a fast MoE for 24 GB+ machines.',
    roles: ['agent', 'reasoning'],
    supportsTools: true,
    supportsFim: false,
    supportsVision: false,
    defaultVariant: 3,
    variants: [
      { tag: '0.6b', paramsB: 0.6, gb: 0.5, ollama: 'qwen3:0.6b', lmstudio: 'Qwen/Qwen3-0.6B-GGUF' },
      { tag: '1.7b', paramsB: 1.7, gb: 1.4, ollama: 'qwen3:1.7b', lmstudio: 'Qwen/Qwen3-1.7B-GGUF' },
      { tag: '4b', paramsB: 4, gb: 2.6, ollama: 'qwen3:4b', lmstudio: 'Qwen/Qwen3-4B-GGUF' },
      { tag: '8b', paramsB: 8, gb: 5.2, ollama: 'qwen3:8b', docker: 'ai/qwen3', lmstudio: 'Qwen/Qwen3-8B-GGUF' },
      { tag: '14b', paramsB: 14, gb: 9.3, ollama: 'qwen3:14b', lmstudio: 'Qwen/Qwen3-14B-GGUF' },
      { tag: '30b-a3b', paramsB: 30, gb: 19, ollama: 'qwen3:30b-a3b', lmstudio: 'Qwen/Qwen3-30B-A3B-GGUF' },
      { tag: '32b', paramsB: 32, gb: 20, ollama: 'qwen3:32b', lmstudio: 'Qwen/Qwen3-32B-GGUF' },
    ],
  },
  {
    key: 'devstral',
    name: 'Devstral Small',
    vendor: 'Mistral AI',
    description: 'Purpose-built agentic coding model (SWE-bench leader among open weights). Needs ~16 GB.',
    roles: ['agent'],
    supportsTools: true,
    supportsFim: false,
    supportsVision: false,
    variants: [{ tag: '24b', paramsB: 24, gb: 14, ollama: 'devstral', lmstudio: 'lmstudio-community/Devstral-Small-2507-GGUF' }],
  },
  {
    key: 'gpt-oss',
    name: 'gpt-oss',
    vendor: 'OpenAI',
    description: 'Open-weight reasoning model with tool calling and adjustable effort. 20b runs on 16 GB; 120b wants 64 GB+.',
    roles: ['agent', 'reasoning'],
    supportsTools: true,
    supportsFim: false,
    supportsVision: false,
    variants: [
      { tag: '20b', paramsB: 20, gb: 14, ollama: 'gpt-oss:20b', docker: 'ai/gpt-oss', lmstudio: 'lmstudio-community/gpt-oss-20b-GGUF' },
      { tag: '120b', paramsB: 120, gb: 65, ollama: 'gpt-oss:120b', lmstudio: 'lmstudio-community/gpt-oss-120b-GGUF' },
    ],
  },
  {
    key: 'llama3.2',
    name: 'Llama 3.2',
    vendor: 'Meta',
    description: 'Tiny instruction models with tool calling — the lightest usable agent models for 8 GB machines.',
    roles: ['agent'],
    supportsTools: true,
    supportsFim: false,
    supportsVision: false,
    defaultVariant: 1,
    variants: [
      { tag: '1b', paramsB: 1, gb: 1.3, ollama: 'llama3.2:1b', lmstudio: 'lmstudio-community/Llama-3.2-1B-Instruct-GGUF' },
      { tag: '3b', paramsB: 3, gb: 2.0, ollama: 'llama3.2:3b', docker: 'ai/llama3.2', lmstudio: 'lmstudio-community/Llama-3.2-3B-Instruct-GGUF' },
    ],
  },
  {
    key: 'llama3.1',
    name: 'Llama 3.1',
    vendor: 'Meta',
    description: 'Solid general-purpose 8b with tool calling and 128k context.',
    roles: ['agent'],
    supportsTools: true,
    supportsFim: false,
    supportsVision: false,
    variants: [{ tag: '8b', paramsB: 8, gb: 4.9, ollama: 'llama3.1:8b', docker: 'ai/llama3.1', lmstudio: 'lmstudio-community/Meta-Llama-3.1-8B-Instruct-GGUF' }],
  },
  {
    key: 'gemma3',
    name: 'Gemma 3',
    vendor: 'Google',
    description: 'Multimodal (text + images) from 4b up, 128k context. Good vision model for screenshots; tools via prompt fallback.',
    roles: ['vision'],
    supportsTools: false,
    supportsFim: false,
    supportsVision: true,
    defaultVariant: 1,
    variants: [
      { tag: '1b', paramsB: 1, gb: 0.8, ollama: 'gemma3:1b', lmstudio: 'lmstudio-community/gemma-3-1b-it-GGUF' },
      { tag: '4b', paramsB: 4, gb: 3.3, ollama: 'gemma3:4b', docker: 'ai/gemma3', lmstudio: 'lmstudio-community/gemma-3-4b-it-GGUF' },
      { tag: '12b', paramsB: 12, gb: 8.1, ollama: 'gemma3:12b', lmstudio: 'lmstudio-community/gemma-3-12b-it-GGUF' },
      { tag: '27b', paramsB: 27, gb: 17, ollama: 'gemma3:27b', lmstudio: 'lmstudio-community/gemma-3-27b-it-GGUF' },
    ],
  },
  {
    key: 'qwen2.5vl',
    name: 'Qwen2.5 VL',
    vendor: 'Alibaba',
    description: 'Vision-language model that reads UI screenshots, diagrams and documents accurately.',
    roles: ['vision'],
    supportsTools: false,
    supportsFim: false,
    supportsVision: true,
    defaultVariant: 1,
    variants: [
      { tag: '3b', paramsB: 3, gb: 3.2, ollama: 'qwen2.5vl:3b' },
      { tag: '7b', paramsB: 7, gb: 6.0, ollama: 'qwen2.5vl:7b' },
      { tag: '32b', paramsB: 32, gb: 21, ollama: 'qwen2.5vl:32b' },
    ],
  },
  {
    key: 'mistral-small3.2',
    name: 'Mistral Small 3.2',
    vendor: 'Mistral AI',
    description: '24b with tool calling and vision in one model — a single do-everything model for 24 GB+ machines.',
    roles: ['agent', 'vision'],
    supportsTools: true,
    supportsFim: false,
    supportsVision: true,
    variants: [{ tag: '24b', paramsB: 24, gb: 15, ollama: 'mistral-small3.2', lmstudio: 'lmstudio-community/Mistral-Small-3.2-24B-Instruct-2506-GGUF' }],
  },
  {
    key: 'deepseek-r1',
    name: 'DeepSeek-R1',
    vendor: 'DeepSeek',
    description: 'Reasoning distills for planning and hard problems; enable extended thinking. No native tools.',
    roles: ['reasoning'],
    supportsTools: false,
    supportsFim: false,
    supportsVision: false,
    defaultVariant: 2,
    variants: [
      { tag: '1.5b', paramsB: 1.5, gb: 1.1, ollama: 'deepseek-r1:1.5b', lmstudio: 'lmstudio-community/DeepSeek-R1-Distill-Qwen-1.5B-GGUF' },
      { tag: '7b', paramsB: 7, gb: 4.7, ollama: 'deepseek-r1:7b', lmstudio: 'lmstudio-community/DeepSeek-R1-Distill-Qwen-7B-GGUF' },
      { tag: '8b', paramsB: 8, gb: 5.2, ollama: 'deepseek-r1:8b', docker: 'ai/deepseek-r1-distill-llama', lmstudio: 'lmstudio-community/DeepSeek-R1-Distill-Llama-8B-GGUF' },
      { tag: '14b', paramsB: 14, gb: 9.0, ollama: 'deepseek-r1:14b', lmstudio: 'lmstudio-community/DeepSeek-R1-Distill-Qwen-14B-GGUF' },
      { tag: '32b', paramsB: 32, gb: 20, ollama: 'deepseek-r1:32b', lmstudio: 'lmstudio-community/DeepSeek-R1-Distill-Qwen-32B-GGUF' },
    ],
  },
  {
    key: 'codestral',
    name: 'Codestral',
    vendor: 'Mistral AI',
    description: '22b code model with excellent fill-in-the-middle for inline completions on bigger machines.',
    roles: ['completion', 'agent'],
    supportsTools: true,
    supportsFim: true,
    supportsVision: false,
    variants: [{ tag: '22b', paramsB: 22, gb: 13, ollama: 'codestral', lmstudio: 'lmstudio-community/Codestral-22B-v0.1-GGUF' }],
  },
  {
    key: 'starcoder2',
    name: 'StarCoder2',
    vendor: 'BigCode',
    description: 'Completion-only base models — lean, fast fill-in-the-middle for ghost text.',
    roles: ['completion'],
    supportsTools: false,
    supportsFim: true,
    supportsVision: false,
    variants: [
      { tag: '3b', paramsB: 3, gb: 1.7, ollama: 'starcoder2:3b' },
      { tag: '7b', paramsB: 7, gb: 4.0, ollama: 'starcoder2:7b' },
      { tag: '15b', paramsB: 15, gb: 9.1, ollama: 'starcoder2:15b' },
    ],
  },
  {
    key: 'phi4-mini',
    name: 'Phi-4 mini',
    vendor: 'Microsoft',
    description: '3.8b with function calling and 128k context; a capable small agent model.',
    roles: ['agent'],
    supportsTools: true,
    supportsFim: false,
    supportsVision: false,
    variants: [{ tag: '3.8b', paramsB: 3.8, gb: 2.5, ollama: 'phi4-mini', lmstudio: 'lmstudio-community/Phi-4-mini-instruct-GGUF' }],
  },
  {
    key: 'smollm2',
    name: 'SmolLM2',
    vendor: 'Hugging Face',
    description: 'Sub-2b models with tool calling for very constrained machines and quick experiments.',
    roles: ['agent'],
    supportsTools: true,
    supportsFim: false,
    supportsVision: false,
    defaultVariant: 2,
    variants: [
      { tag: '135m', paramsB: 0.135, gb: 0.3, ollama: 'smollm2:135m' },
      { tag: '360m', paramsB: 0.36, gb: 0.7, ollama: 'smollm2:360m' },
      { tag: '1.7b', paramsB: 1.7, gb: 1.8, ollama: 'smollm2:1.7b', docker: 'ai/smollm2', lmstudio: 'lmstudio-community/SmolLM2-1.7B-Instruct-GGUF' },
    ],
  },
];

export interface CatalogPick {
  entry: CatalogEntry;
  variant: CatalogVariant;
}

/** Identifier used to install the pick on a runtime, if the catalog knows one. */
export function installId(pick: CatalogPick, target: InstallTarget): string | undefined {
  return pick.variant[target];
}

/**
 * Smallest-first starter set for a machine: a tool-capable coder model that leaves headroom, plus a tiny
 * completion model when both fit at once. Bigger models are an explicit upgrade from the catalog.
 */
export function starterPlan(profile: SystemProfile): { agent: CatalogPick; completion?: CatalogPick; vision?: CatalogPick } {
  const coder = MODEL_CATALOG.find((e) => e.key === 'qwen2.5-coder')!;
  const pick = (e: CatalogEntry, tag: string): CatalogPick => ({ entry: e, variant: e.variants.find((v) => v.tag === tag)! });
  // Starter agent model by budget. Keep ~40% headroom so the OS, editor and KV cache fit alongside it.
  const budget = profile.modelBudgetGb;
  let agent: CatalogPick;
  if (budget >= 8) {
    agent = pick(coder, '7b');
  } else if (budget >= 3.5) {
    agent = pick(coder, '3b');
  } else if (budget >= 1.8) {
    agent = pick(coder, '1.5b');
  } else {
    agent = pick(coder, '0.5b');
  }
  const out: { agent: CatalogPick; completion?: CatalogPick; vision?: CatalogPick } = { agent };
  const small = pick(coder, '1.5b');
  if (agent.variant.gb + small.variant.gb <= budget && agent.variant.tag !== '1.5b' && agent.variant.tag !== '0.5b') {
    out.completion = small;
  }
  const gemma = MODEL_CATALOG.find((e) => e.key === 'gemma3')!;
  const vision = pick(gemma, '4b');
  if (budget >= 16 && agent.variant.gb + (out.completion?.variant.gb ?? 0) + vision.variant.gb <= budget) {
    out.vision = vision;
  }
  return out;
}

export interface CatalogRow extends CatalogPick {
  /** Runs comfortably within the machine's model budget. */
  fits: boolean;
  /** Could run but will be tight (up to 25% over budget — Ollama/llama.cpp can offload layers to RAM). */
  tight: boolean;
  /** Best fitting size of this family for each of its roles. */
  recommendedFor: ModelRole[];
  /** Installed as `provider/model` ids, when a reachable provider lists it. */
  installed: string[];
}

/** Every catalog size annotated for the machine and the models already installed. */
export function catalogForSystem(profile: SystemProfile, installed: ModelInfo[]): CatalogRow[] {
  const rows: CatalogRow[] = [];
  for (const entry of MODEL_CATALOG) {
    const fitting = entry.variants.filter((v) => fits(profile, v.gb));
    // Recommend the largest size that fits but stays under ~60% of the budget, so there is room for a second model
    // (completion / vision) and the context cache. Fall back to the largest fitting size.
    const comfortable = fitting.filter((v) => v.gb <= profile.modelBudgetGb * 0.6);
    const best = (comfortable.length ? comfortable : fitting).slice(-1)[0];
    for (const variant of entry.variants) {
      const pick = { entry, variant };
      rows.push({
        ...pick,
        fits: fits(profile, variant.gb),
        tight: !fits(profile, variant.gb) && variant.gb <= profile.modelBudgetGb * 1.25,
        recommendedFor: variant === best ? entry.roles : [],
        installed: installed.filter((m) => matchesCatalog(m, pick)).map((m) => m.id),
      });
    }
  }
  return rows;
}

/** True when an installed model is this catalog size (by Ollama tag, Docker ref or LM Studio repo name). */
export function matchesCatalog(m: ModelInfo, pick: CatalogPick): boolean {
  const id = m.modelId.toLowerCase();
  const v = pick.variant;
  if (v.ollama && (id === v.ollama.toLowerCase() || id === `${v.ollama.toLowerCase()}:latest` || (!v.ollama.includes(':') && id === `${v.ollama.toLowerCase()}:latest`))) {
    return true;
  }
  if (v.docker && (id === v.docker.toLowerCase() || id.endsWith(`/${v.docker.toLowerCase()}`) || id.endsWith(`/${v.docker.toLowerCase()}:latest`) || id === `${v.docker.toLowerCase()}:latest`)) {
    return true;
  }
  if (v.lmstudio) {
    const repo = v.lmstudio.split('/').pop()!.toLowerCase().replace(/-gguf$/, '');
    if (id.includes(repo)) {
      return true;
    }
  }
  return false;
}

/** Finds the catalog family + size for an installed model, if any. */
export function lookupCatalog(m: ModelInfo): CatalogPick | undefined {
  for (const entry of MODEL_CATALOG) {
    for (const variant of entry.variants) {
      if (matchesCatalog(m, { entry, variant })) {
        return { entry, variant };
      }
    }
  }
  return undefined;
}

/** Runtime footprint of an installed model in GB: reported size, catalog size, or an estimate from its name. */
export function modelFootprintGb(m: ModelInfo): number | undefined {
  if (m.sizeBytes) {
    return q((m.sizeBytes / 1024 ** 3) * 1.2);
  }
  const cat = lookupCatalog(m);
  if (cat) {
    return cat.variant.gb;
  }
  const b = (m.parameterSize && parameterSizeB(m.parameterSize)) || parameterSizeB(m.modelId);
  return b ? estimateModelGb(b) : undefined;
}
