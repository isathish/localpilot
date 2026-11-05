import { createHash } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  attemptCap, checkSemaphore, discoverChecks, effectivePolicies, FailureMemory, HealingService, PROJECT_MEMORY_FILE, RecoveryStore, recoveryBus,
  type HealingEngineConfig, type RecoveryState,
} from '../agent/healing';
import { changedFilesScan, lastWriter, osvDependencyScan, providerProbe, repoGraphView, type ProbeTarget } from '../agent/healing/hostAdapters';
import { buildRepoGraph } from '../context/repoGraph';
import type { TelemetryInput } from '../telemetry/telemetry';

/**
 * The CLI's self-healing service (design §1, §7, §8): recovery state in `~/.localpilot/recovery`, failure memory per
 * folder (or the project's shared file when the workspace is trusted), and the CLI's own providers, MCP servers and
 * change tracker behind the engine's injected dependencies (the host adapters shared with the extension).
 */

export interface CliHealingDeps {
  cwd: string;
  /** `~/.localpilot` (tests pass a temp folder). */
  home?: string;
  config: () => HealingEngineConfig;
  log: { info(msg: string): void; warn(msg: string): void };
  telemetry?: { record(e: TelemetryInput): void };
  /** Workspace trust (the shim's flag): `checks.json` and the project memory are read only when true. */
  isTrusted: () => boolean;
  /** Network approval for the OSV dependency check (`securityCheck: 'full'`). */
  approve: (title: string, detail: string, kind: string) => Promise<boolean>;
  mcpRestart?: (server: string) => Promise<unknown>;
  /** The provider behind a provider id or `provider/model`, for the health probe. */
  provider?: (id: string) => ProbeTarget | undefined | Promise<ProbeTarget | undefined>;
  settle?: (sessionId: string) => void | Promise<void>;
  /** The change tracker's pending changes (who wrote which file when), for foreign-failure attribution. */
  writers?: () => readonly { sessionId: string; fsPath: string; changedAt: number }[];
  audit?: (event: Record<string, unknown>) => void;
}

export interface CliHealing {
  service: HealingService;
  store: RecoveryStore;
  /** Root sessions with a run in progress in this process (foreign-writer attribution). */
  live: Set<string>;
}

/** `~/.localpilot/recovery/<sha1(cwd) 12 hex>/memory.json`: the `workspace` failure memory of one folder. */
export function workspaceMemoryFile(recoveryDir: string, cwd: string): string {
  return path.join(recoveryDir, createHash('sha1').update(path.resolve(cwd)).digest('hex').slice(0, 12), 'memory.json');
}

/** M in "attempt N/M": the budget of the state's current category (or the overall per-category cap). */
export function attemptBudget(cfg: HealingEngineConfig, s: Pick<RecoveryState, 'attempts' | 'active'>): number {
  const category = s.attempts[s.attempts.length - 1]?.category ?? s.active[0]?.category;
  return category ? Math.min(effectivePolicies(cfg)[category].attempts, attemptCap(category, cfg.maxRepairAttempts)) : cfg.maxRepairAttempts;
}

/** Restores a file the way the change tracker does: undefined = it did not exist before, so it is removed. */
export async function restoreFile(fsPath: string, content: string | undefined): Promise<void> {
  if (content === undefined) {
    await fs.promises.rm(fsPath, { force: true });
    return;
  }
  await fs.promises.mkdir(path.dirname(fsPath), { recursive: true });
  await fs.promises.writeFile(fsPath, content, 'utf8');
}

export function createCliHealing(d: CliHealingDeps): CliHealing {
  const dir = path.join(d.home ?? path.join(os.homedir(), '.localpilot'), 'recovery');
  const live = new Set<string>();
  const store = new RecoveryStore(dir, { owner: { kind: 'cli' }, log: d.log, maxAttempts: (s) => attemptBudget(d.config(), s) });
  const memories = new Map<string, FailureMemory>();
  const memory = (root: string): FailureMemory | undefined => {
    const scope = d.config().memory;
    const file = scope === 'workspace' ? workspaceMemoryFile(dir, d.cwd) : scope === 'project' ? path.join(root, PROJECT_MEMORY_FILE) : undefined;
    if (!file) {
      return undefined;
    }
    // A shared project file is prompt input written by others: read only in a trusted workspace (§8).
    const readable = scope !== 'project' || d.isTrusted();
    const key = `${file}\0${readable}`;
    let m = memories.get(key);
    if (!m) {
      m = new FailureMemory(file, { readable, log: (msg) => d.log.warn(msg) });
      memories.set(key, m);
    }
    return m;
  };
  const service = new HealingService({
    store,
    memory,
    config: d.config,
    telemetry: d.telemetry,
    log: d.log,
    bus: recoveryBus,
    semaphore: checkSemaphore,
    discover: (root, opts) => discoverChecks(root, opts),
    isTrusted: d.isTrusted,
    repoGraph: async (root) => repoGraphView(await buildRepoGraph(root)),
    securityScan: changedFilesScan(),
    dependencyScan: osvDependencyScan(
      (root) => d.approve('Check dependencies for known vulnerabilities (OSV.dev)', `Self-healing security check (healing.securityCheck: full)\nSends the package names and versions in the lockfiles of ${root} to api.osv.dev`, 'network').catch(() => false),
      { log: (m) => d.log.warn(m) },
    ),
    mcpRestart: d.mcpRestart,
    probe: d.provider ? providerProbe(d.provider) : undefined,
    restoreFile,
    settle: d.settle,
    foreignWriter: (fsPath) => lastWriter(d.writers?.() ?? [], live, fsPath),
    audit: d.audit,
    owner: 'cli',
  });
  return { service, store, live };
}
