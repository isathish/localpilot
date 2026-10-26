import * as cp from 'child_process';
import * as os from 'os';

/** What the machine can run: used to rank catalog entries and to route work to models that fit in memory. */
export interface SystemProfile {
  platform: NodeJS.Platform;
  arch: string;
  cpuCores: number;
  /** Physical RAM in GB. */
  ramGb: number;
  /** Dedicated GPU memory in GB (0 when unknown / integrated). Apple Silicon reports unified memory as RAM, not here. */
  vramGb: number;
  gpu?: string;
  /** True on Apple Silicon: the GPU shares system RAM, so RAM is the budget. */
  unifiedMemory: boolean;
  /** Largest model footprint (weights + KV cache headroom) that should run comfortably, in GB. */
  modelBudgetGb: number;
  /** Rough class of machine, drives default picks. */
  tier: 'tiny' | 'small' | 'medium' | 'large' | 'xl';
  /** Human-readable one-liner for the UI. */
  summary: string;
}

function run(cmd: string, args: string[], timeoutMs = 2500): Promise<string> {
  return new Promise((resolve) => {
    let out = '';
    let settled = false;
    const finish = (v: string) => {
      if (!settled) {
        settled = true;
        resolve(v);
      }
    };
    let child: cp.ChildProcess;
    try {
      child = cp.spawn(cmd, args, { stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      return finish('');
    }
    const timer = setTimeout(() => {
      child.kill();
      finish(out);
    }, timeoutMs);
    child.stdout?.on('data', (d) => (out += String(d)));
    child.on('error', () => {
      clearTimeout(timer);
      finish('');
    });
    child.on('close', () => {
      clearTimeout(timer);
      finish(out);
    });
  });
}

/** Dedicated GPU memory, best effort: NVIDIA via nvidia-smi, AMD via rocm-smi, Windows via WMI. */
async function detectGpu(platform: NodeJS.Platform): Promise<{ vramGb: number; name?: string }> {
  const nv = await run('nvidia-smi', ['--query-gpu=memory.total,name', '--format=csv,noheader,nounits']);
  if (nv.trim()) {
    let total = 0;
    let name: string | undefined;
    for (const line of nv.trim().split('\n')) {
      const [mem, ...rest] = line.split(',');
      const mb = Number(mem.trim());
      if (Number.isFinite(mb)) {
        total += mb / 1024;
        name = name ?? rest.join(',').trim();
      }
    }
    if (total > 0) {
      return { vramGb: Math.round(total * 10) / 10, name: name ? `${name}${nv.trim().split('\n').length > 1 ? ` ×${nv.trim().split('\n').length}` : ''}` : 'NVIDIA GPU' };
    }
  }
  if (platform === 'linux') {
    const amd = await run('rocm-smi', ['--showmeminfo', 'vram', '--csv']);
    const m = /(\d{6,})/.exec(amd);
    if (m) {
      return { vramGb: Math.round((Number(m[1]) / 1024 ** 3) * 10) / 10, name: 'AMD GPU (ROCm)' };
    }
  }
  if (platform === 'win32') {
    const wmi = await run('powershell', ['-NoProfile', '-Command', '(Get-CimInstance Win32_VideoController | Select-Object Name,AdapterRAM | ConvertTo-Json -Compress)'], 4000);
    try {
      const parsed = JSON.parse(wmi.trim() || '[]') as { Name?: string; AdapterRAM?: number } | { Name?: string; AdapterRAM?: number }[];
      const list = Array.isArray(parsed) ? parsed : [parsed];
      const best = list.filter((g) => g.AdapterRAM).sort((a, b) => (b.AdapterRAM ?? 0) - (a.AdapterRAM ?? 0))[0];
      if (best?.AdapterRAM && best.AdapterRAM > 1024 ** 3) {
        return { vramGb: Math.round((best.AdapterRAM / 1024 ** 3) * 10) / 10, name: best.Name };
      }
    } catch {
      /* no WMI */
    }
  }
  return { vramGb: 0 };
}

/** Pure part of profiling so it can be unit-tested with synthetic inputs. */
export function buildProfile(input: { platform: NodeJS.Platform; arch: string; cpuCores: number; ramGb: number; vramGb: number; gpu?: string }): SystemProfile {
  const unifiedMemory = input.platform === 'darwin' && /arm64|aarch64/i.test(input.arch);
  // Apple Silicon: the OS lets the GPU use roughly 2/3–3/4 of unified memory. Dedicated GPUs: the VRAM minus
  // runtime overhead. CPU-only: keep half the RAM for the OS, editor and the agent's own work.
  let modelBudgetGb: number;
  if (unifiedMemory) {
    modelBudgetGb = input.ramGb <= 8 ? input.ramGb * 0.5 : input.ramGb <= 16 ? input.ramGb * 0.6 : input.ramGb * 0.7;
  } else if (input.vramGb >= 4) {
    // Ollama / llama.cpp can spill layers to RAM, so a GPU + lots of RAM allows a bit more than VRAM alone.
    modelBudgetGb = Math.max(input.vramGb - 1, Math.min(input.vramGb * 1.5, input.ramGb * 0.5));
  } else {
    modelBudgetGb = input.ramGb * 0.5;
  }
  modelBudgetGb = Math.max(1, Math.round(modelBudgetGb * 10) / 10);
  const tier: SystemProfile['tier'] = modelBudgetGb < 4 ? 'tiny' : modelBudgetGb < 9 ? 'small' : modelBudgetGb < 18 ? 'medium' : modelBudgetGb < 40 ? 'large' : 'xl';
  const gpuText = unifiedMemory ? `${input.gpu ?? 'Apple Silicon'} · unified memory` : input.vramGb ? `${input.gpu ?? 'GPU'} · ${input.vramGb} GB VRAM` : 'no dedicated GPU detected';
  const summary = `${input.ramGb} GB RAM · ${input.cpuCores} cores · ${gpuText}`;
  return { ...input, unifiedMemory, modelBudgetGb, tier, summary };
}

let cached: Promise<SystemProfile> | undefined;

/** Pins the detected profile (tests: routing decisions must not depend on the runner's RAM); undefined re-detects. */
export function overrideSystemProfile(profile: SystemProfile | undefined): void {
  cached = profile ? Promise.resolve(profile) : undefined;
}

/** Detects the machine once per session (GPU probing shells out, so it is memoised). */
export function getSystemProfile(force = false): Promise<SystemProfile> {
  if (!cached || force) {
    cached = (async () => {
      const platform = process.platform;
      const arch = process.arch;
      const ramGb = Math.round((os.totalmem() / 1024 ** 3) * 10) / 10;
      const cpuCores = os.cpus().length || 1;
      let gpu: string | undefined;
      let vramGb = 0;
      if (platform === 'darwin' && /arm64/i.test(arch)) {
        const chip = await run('sysctl', ['-n', 'machdep.cpu.brand_string']);
        gpu = chip.trim() || 'Apple Silicon';
      } else {
        const g = await detectGpu(platform);
        vramGb = g.vramGb;
        gpu = g.name;
      }
      return buildProfile({ platform, arch, cpuCores, ramGb, vramGb, gpu });
    })();
  }
  return cached;
}

/** Parses "7b", "1.5B", "32b" out of a model name; undefined when the size is not in the name. */
export function parameterSizeB(name: string): number | undefined {
  const m = /(\d+(?:\.\d+)?)\s*[bB](?![a-zA-Z])/.exec(name);
  return m ? parseFloat(m[1]) : undefined;
}

/** Approximate memory a quantised (Q4) model needs at runtime, in GB, from its parameter count. */
export function estimateModelGb(paramsB: number): number {
  // ~0.6 GB per billion params for Q4_K_M weights plus ~20% for KV cache and runtime buffers.
  return Math.round(paramsB * 0.6 * 1.2 * 10) / 10;
}

/** True when a model of the given footprint should run comfortably on this machine. */
export function fits(profile: SystemProfile, gb: number): boolean {
  return gb <= profile.modelBudgetGb;
}
