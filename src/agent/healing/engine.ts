import { createHash } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { AgentEvent, ApprovalOptions, TodoItem, ToolCall, ToolCallDecision, ToolResult } from '../../types';
import type { TelemetryInput, TelemetrySummary } from '../../telemetry/telemetry';
import { isSafeHealingCheck } from '../commandGuard';
import { classifyModelError, retryDelayMs, type ModelFailure } from '../resilience';
import { checkDefiningEdit } from './checkDefining';
import { CheckRunner, STAGE_ORDER, type CheckStage, type Fingerprint, type SecurityScan } from './checkRunner';
import { checkDefiningFiles, definitionBodies, isInCheckScope, type DiscoverOptions } from './checks';
import { classify, groupFailures, type FailureGroup } from './classifier';
import { recoveryDashboard, type RecoveryDashboard } from './dashboardData';
import { buildIntervention, outcomeFor, report as escalationReport, type EscalationContext } from './escalation';
import { isMemoryPath, type FailureMemory, type MemorySuggestion } from './failureMemory';
import { PatchManager, UNKNOWN_CHANGES, type RollbackResult } from './patchManager';
import { attemptCap, effectivePolicies } from './policy';
import { buildContract, detectChecksModified, evaluate, formatReport, type AttemptWrite, type GateContract } from './qualityGate';
import { buildEvidence, dependencyInfo, fixBrief, fixPrompt, hypothesis, inferEcosystem, parseReply, resolverCommands, type FixPromptMessage, type PackageManager, type ResolverCommand } from './rca';
import type { RecoveryStore, UnfinishedSummary } from './recoveryStore';
import { attribute, compare, isWorse } from './regression';
import { backoffMs, decide, type AdjustmentPlan, type RerouteRequirement, type RetryDecision } from './retryController';
import { rootSessionId, type RecoveryBus } from './scheduler';
import { humanKey } from './signature';
import { wholeTreeKey } from './treeSnapshot';
import {
  isTerminalPhase,
  type AcceptedRisk, type ApprovalRecord, type AttemptRecord, type AttemptResult, type CheckResult, type CheckSpec, type CompletionContract,
  type EscalationReason, type ExecResult, type Failure, type FailureCategory, type FixMode, type HealingSettings, type ObserveResult, type PolicyOverride,
  type RecoveryEventPayload, type RecoveryPhase, type RecoveryState, type RecoverySummary, type RegressionReport, type ResourceAdjustment,
  type ResumeInfo, type RetryPolicy, type TaskOutcome,
} from './types';

/**
 * The self-healing state machine (design §4-7, §10): one HealingEngine per agent run, created by the per-process
 * HealingService. Every transition is persisted first, then emitted as a `recovery` event, then recorded in telemetry
 * (signature hashes only), and only then is its side effect (fix prompt, install, rollback) carried out.
 */

const ALLOWANCE_TTL_MS = 30 * 60_000;
const MAX_APPROVALS = 200;
const SECTION_FILES = /(?:^|\/)(?:package\.json|pyproject\.toml|setup\.cfg)$/;
const RECOVERY_PHASES: readonly RecoveryPhase[] = ['diagnosing', 'fixing', 'validating', 'rolling_back', 'resolving', 'retrying'];

// ---- Injected dependencies ----

export interface HealingLog {
  info?(msg: string): void;
  warn(msg: string): void;
}

/** What the engine needs from `buildRepoGraph`: neighbours (importers + imports) and direct import edges. */
export interface RepoGraphView {
  neighbours(file: string): readonly string[];
  importEdge(a: string, b: string): boolean;
}

/** `getConfig().healing` (HealingConfig) or the engine's own HealingSettings. */
export type HealingEngineConfig = Omit<HealingSettings, 'checks' | 'policies'> & { checks: unknown[]; policies: Partial<Record<string, PolicyOverride>> };

export interface HealingServiceOptions {
  store: RecoveryStore;
  memory: (root: string) => FailureMemory | undefined;
  config: () => HealingEngineConfig;
  telemetry?: { record(e: TelemetryInput): void };
  log: HealingLog;
  bus: RecoveryBus;
  semaphore: { acquire(root: string, signal?: AbortSignal): Promise<() => void> };
  /** `discoverChecks`; the service passes trust, the setting checks and whether to add the security stage. */
  discover: (root: string, opts: DiscoverOptions) => Promise<CheckSpec[] & { timeBudgetSeconds?: number }>;
  isTrusted: () => boolean;
  repoGraph?: (root: string) => RepoGraphView | undefined | Promise<RepoGraphView | undefined>;
  securityScan?: SecurityScan;
  /** `securityCheck: 'full'`: dependency advisories (network approval through the approval gate). */
  dependencyScan?: (root: string, signal: AbortSignal) => Promise<Failure[]>;
  mcpRestart?: (server: string) => Promise<unknown>;
  /** Provider health check before a model/routing retry; false = still down. */
  probe?: (target: string, signal?: AbortSignal) => Promise<boolean>;
  restoreFile?: (fsPath: string, content: string | undefined) => Promise<void>;
  settle?: (sessionId: string) => void | Promise<void>;
  /** Live session that last wrote `fsPath` (ChangeTracker), if any. */
  foreignWriter?: (fsPath: string) => string | undefined;
  audit?: (event: Record<string, unknown>) => void;
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  random?: () => number;
  /** Whole-tree baseline key (default `treeSnapshot.wholeTreeKey`). */
  treeKey?: (root: string, signal?: AbortSignal) => Promise<string>;
  /** Changed-file fingerprint for the check cache (default `treeFingerprint`). */
  fingerprint?: Fingerprint;
  owner?: 'vscode' | 'cli';
}

/** Flags of one synthetic `run_command` (design §2.5); `runSyntheticCommand` maps them onto `ToolContext.healingExec`. */
export interface HealingExecFlags {
  kind: 'check' | 'install';
  /** The command is exactly a configured check (computed by the engine, never taken from model args). */
  checkSpecMatch: boolean;
  timeoutSeconds: number;
  /** Installs: the prompt is mandatory. */
  requiresApproval?: boolean;
  /** Checks: the turn-scoped allowance for `gateApproval`. */
  allowance?: NonNullable<ApprovalOptions['healingAllowance']>;
}

export type HealingExec = (spec: CheckSpec, signal: AbortSignal, flags: HealingExecFlags) => Promise<ExecResult>;

/** One fixer brief of a delegated attempt (synthetic `run_parallel_subagents` call). */
export interface FixerTask {
  agent: 'fixer';
  prompt: string;
  origin: 'healing';
}

export type HealingDelegate = (tasks: FixerTask[], signal: AbortSignal) => Promise<{ ok: boolean; content?: string; writtenFiles?: string[] }>;

export interface HealingRunContext {
  session: { id: string };
  depth: number;
  mode: string;
  role?: 'fixer';
  root?: string;
  signal: AbortSignal;
  control?: { waitWhilePaused?(): Promise<void> };
  emit: (e: AgentEvent) => void;
  unattended?: boolean;
  exec: HealingExec;
  injectHidden: (msg: FixPromptMessage) => void;
  delegate?: HealingDelegate;
  contextWindow?: number;
  resume?: boolean;
  scratch?: boolean;
  /** User message index (checkpoint key). */
  turnKey?: number;
  taskId?: string;
  /** `parallel.maxConcurrency` (delegated fixes need > 1). */
  maxConcurrency?: number;
  /** Main checkout when the run works in a worktree of it. */
  mainRoot?: string;
}

export interface CompleteInput {
  todos?: readonly Pick<TodoItem, 'status' | 'title'>[];
  finalText: string;
  request: string;
}

export type GateDecision =
  | { action: 'continue'; grantSteps: number }
  | { action: 'complete'; outcome: TaskOutcome; contract?: CompletionContract; report?: string };

/** `resumeEntry`: `proceed` = nothing to verify, run the model as usual. */
export type ResumeDecision = GateDecision | { action: 'proceed' };

export interface ModelFailureContext {
  /** Text or tool calls already streamed: never replayed. */
  streamed: boolean;
  modelName?: string;
  /** `provider/model` or provider id for the health probe. */
  target?: string;
  thinking?: boolean;
  contextWindow?: number;
  /** max(model minimum, measured system prompt + tool schemas + reserve). */
  contextFloor?: number;
  serial?: boolean;
  reroute?: RerouteRequirement;
}

export interface ModelFailureResult {
  decision: RetryDecision;
  failure?: Failure;
  /** Resource change to apply before the retry (overload / last-attempt reroute). */
  adjust?: AdjustmentPlan;
  /** Already waited (injected sleep) before returning. */
  delayMs?: number;
  /** Health probe result before the retry, when one ran. */
  healthy?: boolean;
}

export interface EscalateExtra extends Partial<Omit<EscalationContext, 'now'>> {
  input?: CompleteInput;
}

export type WorkerVerdict = { healthy: boolean; failures: Failure[] };

// ---- Helpers ----

/** The first failure's evidence (else the end of the output) of a failed check, at most 600 characters. */
function checkExcerpt(r: CheckResult): string {
  const text = (r.failures[0]?.evidence || r.output.split('\n').slice(-12).join('\n')).trim();
  return text.length > 600 ? `${text.slice(0, 599)}…` : text;
}

const sha1 = (s: string) => createHash('sha1').update(s).digest('hex');
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e ?? ''));
const slash = (p: string) => p.replace(/\\/g, '/').replace(/^\.\//, '');

const CATEGORY_LABEL: Partial<Record<FailureCategory, string>> = {
  typescript: 'TypeScript', compile: 'Compile error', build: 'Build', lint: 'Lint', dependency: 'Missing dependency', unit_test: 'Test',
  integration_test: 'Integration test', runtime: 'Runtime error', database: 'Database', data_corruption: 'Data corruption', mcp: 'MCP',
  git_conflict: 'Git conflict', security: 'Security', model_timeout: 'Model timeout', model_unavailable: 'Model unavailable',
  model_overload: 'Model overload', model_output: 'Model output', permission: 'Permission', check_timeout: 'Check timeout', loop: 'Loop',
};

function titleOf(f: Failure | undefined): string {
  if (!f) {
    return 'Verification';
  }
  const where = f.file ? ` in ${f.file}${f.line ? `:${f.line}` : ''}` : f.test ? ` in ${f.test}` : '';
  return `${CATEGORY_LABEL[f.category] ?? f.category}${f.code && !f.code.includes(':') ? ` ${f.code}` : ''}${where}`;
}

const realSleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (ms <= 0 || signal?.aborted) {
      resolve();
      return;
    }
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });

function freshState(sid: string, turnKey: number, now: number, kind: 'vscode' | 'cli', taskId?: string): RecoveryState {
  return {
    version: 1, rev: 0, sessionId: rootSessionId(sid), turnKey, ...(taskId ? { taskId } : {}), phase: 'idle', startedAt: now, updatedAt: now,
    owner: { pid: process.pid, host: os.hostname(), kind }, baseline: undefined, checks: {}, changedFiles: [], agentWrites: {}, approvals: [],
    acceptedRisks: [], attempts: [], perCategory: {}, seen: {}, active: [], extraStepsUsed: 0,
  };
}

function packageManagerOf(lockfiles: readonly string[]): PackageManager {
  const names = lockfiles.map((l) => path.basename(l));
  if (names.includes('pnpm-lock.yaml')) {
    return 'pnpm';
  }
  if (names.includes('yarn.lock')) {
    return 'yarn';
  }
  if (names.includes('bun.lock') || names.includes('bun.lockb')) {
    return 'bun';
  }
  return 'npm';
}

function readText(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

interface ActiveFix {
  n: number;
  category: FailureCategory;
  signature: string;
  failure: Failure;
  attempt: number;
  max: number;
  mode: FixMode;
  /** Attributable failures before the attempt. */
  before: Failure[];
  stages: Record<string, CheckResult['status'] | undefined>;
  memoryUsed?: string;
}

/** Escalation for a fatal/policy failure when auto-fix is off (detect and report only). */
function stopReason(f: Failure): EscalationReason {
  switch (f.category) {
    case 'security':
    case 'git_conflict':
    case 'data_corruption':
    case 'loop':
      return f.category;
    case 'permission':
      return f.code === 'auth' || f.code === 'quota' || f.source.kind === 'model' ? 'credentials' : 'approval_needed';
    default:
      return 'exhausted';
  }
}

// ---- Engine ----

export class HealingEngine {
  readonly sessionId: string;
  readonly rootSid: string;
  readonly root: string;
  /** full = depth 0 write modes; detect = ask/plan; worker = engine-started fixer. */
  readonly kind: 'full' | 'detect' | 'worker';
  readonly recoveryId: string;
  private state: RecoveryState;
  private pm: PatchManager;
  private runner: CheckRunner;
  private readonly ready: Promise<void>;
  private graph?: RepoGraphView;
  private persisted = false;
  private owned = false;
  private readonlyWarned = false;
  /** A fresh full engine replaces the previous task's state on its first owned save (attempts, open intervention). */
  private replacePrior = false;
  private disposed = false;
  private fix?: ActiveFix;
  private specsCache?: CheckSpec[] & { timeBudgetSeconds?: number };
  private results = new Map<string, CheckResult>();
  private relevant: CheckSpec[] = [];
  private outOfScope = false;
  private budgetOut = false;
  private regression?: RegressionReport;
  private readonly checksModified: AttemptWrite[] = [];
  private readonly newThisTurn = new Set<string>();
  private readonly sectionBefore = new Map<number, Map<string, string | null>>();
  private readonly ignored = new Set<string>();
  private readonly pendingMemory: { rec: AttemptRecord; failure: Failure }[] = [];
  private readonly adjustments: ResourceAdjustment[] = [];
  private readonly mcpRetries = new Map<string, number>();
  private readonly workerResults = new Map<string, WorkerVerdict>();
  private worseNote?: string;
  private approvalBlock?: 'declined' | 'pending';
  private delegations = 0;
  private failedDelegations = 0;
  private baselineDone = false;
  private request = '';
  private finished?: { outcome: TaskOutcome; contract?: CompletionContract; report?: string };
  private verdict?: WorkerVerdict;
  private unsubscribe?: () => void;

  constructor(
    private readonly svc: HealingService,
    private readonly opts: HealingServiceOptions,
    private readonly ctx: HealingRunContext,
    kind: 'full' | 'detect' | 'worker',
  ) {
    this.sessionId = ctx.session.id;
    this.rootSid = rootSessionId(ctx.session.id);
    this.root = path.resolve(ctx.root!);
    this.kind = kind;
    const turnKey = ctx.turnKey ?? 0;
    this.recoveryId = `rec_${sha1(`${this.sessionId}|${turnKey}|${this.now()}`).slice(0, 12)}`;
    this.state = freshState(this.sessionId, turnKey, this.now(), opts.owner ?? 'vscode', ctx.taskId);
    this.pm = this.makePatchManager();
    this.runner = this.makeRunner();
    if (kind !== 'worker') {
      this.unsubscribe = opts.bus.subscribe(this.rootSid, (msg, from) => this.onBus(msg, from));
    }
    this.ready = this.init().catch((e) => opts.log.warn(`Self-healing: could not initialise recovery state: ${errText(e)}`));
  }

  private now(): number {
    return (this.opts.now ?? Date.now)();
  }

  private cfg(): HealingEngineConfig {
    return this.opts.config();
  }

  private sleep(ms: number): Promise<void> {
    return (this.opts.sleep ?? realSleep)(ms, this.ctx.signal);
  }

  private get store(): RecoveryStore {
    return this.opts.store;
  }

  private async init(): Promise<void> {
    if (this.opts.repoGraph) {
      try {
        this.graph = await this.opts.repoGraph(this.root);
      } catch {
        this.graph = undefined;
      }
    }
    if (this.kind === 'worker') {
      return;
    }
    if (this.ctx.resume) {
      const prior = await this.store.load(this.rootSid);
      if (prior && (prior.phase === 'interrupted' || !isTerminalPhase(prior.phase) || prior.outcome === 'incomplete' || prior.outcome === 'blocked')) {
        this.state = prior;
        this.state.turnKey = this.ctx.turnKey ?? prior.turnKey;
        if (this.ctx.taskId) {
          this.state.taskId = this.ctx.taskId;
        }
        this.persisted = true;
        this.pm = this.makePatchManager(prior);
        for (const a of prior.attempts) {
          await this.pm.restoreFromDisk(this.rootSid, a.n);
        }
        if (prior.activeScope) {
          this.pm.openScope(prior.activeScope.attempt);
        }
      } else {
        this.replacePrior = this.kind === 'full';
      }
    } else if (this.kind === 'full') {
      this.replacePrior = true;
    }
  }

  /** Runs once the owner lock is ours: the previous task's open intervention is resolved before its state is overwritten. */
  private async dropPrior(): Promise<void> {
    this.replacePrior = false;
    const prior = await this.store.load(this.rootSid).catch(() => undefined);
    if (prior?.intervention && !prior.intervention.resolvedAt) {
      await this.store.resolveIntervention(prior.intervention.id, this.now()).catch(() => false);
    }
    await this.store.removeAttempts(this.rootSid);
  }

  private makePatchManager(prior?: RecoveryState): PatchManager {
    const storeRel = path.relative(this.root, this.store.dir).split(path.sep).join('/');
    const storeInside = storeRel && !storeRel.startsWith('..') && !path.isAbsolute(storeRel);
    const options = {
      root: this.root,
      sessionId: this.rootSid,
      persistDir: this.kind === 'worker' ? undefined : (n: number, sid?: string) => this.store.attemptDir(sid ?? this.rootSid, n),
      restoreFile: this.opts.restoreFile,
      settle: () => this.opts.settle?.(this.sessionId),
      now: () => this.now(),
      isExcluded: (rel: string) => isMemoryPath(rel) || (!!storeInside && (rel === storeRel || rel.startsWith(`${storeRel}/`))),
    };
    return prior ? PatchManager.restore({ changedFiles: prior.changedFiles, agentWrites: prior.agentWrites, activeScope: prior.activeScope }, options) : new PatchManager(options);
  }

  private makeRunner(): CheckRunner {
    const scan = this.opts.securityScan;
    const securityScan: SecurityScan | undefined = scan
      ? async (root, files, signal) => {
          const found = await scan(root, files, signal);
          if (this.cfg().securityCheck === 'full' && this.opts.dependencyScan) {
            found.push(...(await this.opts.dependencyScan(root, signal)));
          }
          return found;
        }
      : undefined;
    return new CheckRunner({
      exec: (spec, signal) => this.ctx.exec(spec, signal, this.checkFlags(spec)),
      securityScan,
      semaphore: this.opts.semaphore,
      classify,
      now: () => this.now(),
      fingerprint: this.opts.fingerprint,
      mainRoot: this.ctx.mainRoot,
      graph: (cwdRoot) => (this.graph && path.resolve(cwdRoot) === this.root ? { importers: (f: string) => this.graph!.neighbours(f) } : undefined),
    });
  }

  private checkFlags(spec: CheckSpec): HealingExecFlags {
    const specs = this.specsCache ?? [];
    const prefix = (t: string) => t.slice(0, t.indexOf('{') < 0 ? t.length : t.indexOf('{'));
    const match = isSafeHealingCheck(
      spec.command,
      specs.map((s) => ({ command: s.command, scopedFilled: s.id === spec.id && s.scoped && spec.command.startsWith(prefix(s.scoped)) ? [spec.command] : undefined })),
    );
    return { kind: 'check', checkSpecMatch: match, timeoutSeconds: spec.timeoutSeconds, allowance: this.allowanceFor(this.gateCommands()) };
  }

  private gateCommands(): string[] {
    return (this.specsCache ?? []).filter((s) => s.command).flatMap((s) => (s.scoped ? [s.command, s.scoped] : [s.command]));
  }

  private onBus(msg: Parameters<Parameters<RecoveryBus['subscribe']>[1]>[0], from: string): void {
    if (from === this.sessionId) {
      return;
    }
    if (msg.type === 'worker_result') {
      this.workerResults.set(msg.childId, { healthy: msg.healthy, failures: msg.failures });
    } else if (msg.type === 'child_write') {
      void (msg.phase === 'before' ? Promise.all(msg.paths.map((p) => this.pm.beforeWrite(p, msg.childId))) : this.pm.afterWrite(msg.paths, msg.childId)).catch(() => undefined);
    }
  }

  // ---- Persistence, events, telemetry ----

  private syncPatches(): void {
    const s = this.pm.serialise();
    this.state.changedFiles = s.changedFiles;
    this.state.agentWrites = s.agentWrites;
    this.state.activeScope = s.activeScope;
  }

  private async save(): Promise<boolean> {
    if (this.kind === 'worker') {
      return false;
    }
    this.syncPatches();
    if (!this.owned) {
      if ((await this.store.acquire(this.rootSid)) === 'readonly') {
        if (!this.readonlyWarned) {
          this.readonlyWarned = true;
          this.opts.log.warn(`Self-healing: recovery of ${this.rootSid} is running in another window; state is read-only here`);
        }
        return false;
      }
      this.owned = true;
      if (this.replacePrior) {
        await this.dropPrior();
      }
    }
    this.persisted = true;
    const ok = await this.store.save(this.state);
    this.svc.noteState(this.state);
    return ok;
  }

  private emitRecovery(extra: Partial<RecoveryEventPayload> = {}): void {
    const f = this.fix?.failure ?? this.state.active.find((x) => !x.preexisting && !x.foreign);
    const payload: RecoveryEventPayload = {
      id: this.recoveryId,
      phase: this.state.phase,
      title: titleOf(f),
      ...(this.fix ? { attempt: this.fix.attempt, max: this.fix.max } : {}),
      ...(f ? { category: f.category, severity: f.severity, signature: humanKey(f) } : {}),
      // A failed check carries the start of its first failure, so the card's chip can expand to show it.
      checks: [...this.results.values()].map((r) => ({ id: r.checkId, status: r.status, ms: r.durationMs, ...(r.status === 'failed' || r.status === 'timeout' ? { excerpt: checkExcerpt(r) } : {}) })),
      patches: this.state.attempts.flatMap((a) => a.patches.map((p) => ({ file: p.file, added: p.added, removed: p.removed, result: p.result }))),
      ...(this.kind === 'worker' ? { childId: this.sessionId } : {}),
      ...extra,
    };
    try {
      this.ctx.emit({ sessionId: this.sessionId, type: 'recovery', payload });
    } catch (e) {
      this.opts.log.warn(`Self-healing: recovery event failed: ${errText(e)}`);
    }
  }

  private tele(action: Extract<TelemetryInput, { type: 'recovery' }>['action'], f?: Pick<Failure, 'category'> & Partial<Pick<Failure, 'severity' | 'signature'>>, extra: Partial<Extract<TelemetryInput, { type: 'recovery' }>> = {}): void {
    this.opts.telemetry?.record({
      type: 'recovery', sid: this.rootSid, action, category: f?.category ?? 'unknown',
      ...(f?.severity ? { severity: f.severity } : {}), ...(f?.signature ? { signature: f.signature } : {}), depth: this.ctx.depth, ...extra,
    });
  }

  /** Persist, then emit, then telemetry; the caller performs the side effect afterwards. */
  private async transition(phase: RecoveryPhase, event: Partial<RecoveryEventPayload> = {}, tele?: () => void): Promise<boolean> {
    this.state.phase = phase;
    const ok = await this.save();
    this.emitRecovery(event);
    tele?.();
    return ok;
  }

  /** Another process owns this session's recovery: no fix, install or rollback may run here. */
  private elsewhere(): boolean {
    return this.kind !== 'worker' && this.store.isReadonly(this.rootSid);
  }

  /** Ends the gate without side effects or an intervention while another window owns the recovery. */
  private yieldToOwner(input: CompleteInput): GateDecision {
    if (this.fix) {
      const rec = this.state.attempts.find((a) => a.n === this.fix!.n);
      if (rec && !rec.result) {
        rec.result = 'not_fixed';
        rec.endedAt = this.now();
      }
      this.pm.closeScope();
      this.fix = undefined;
    }
    const outcome: TaskOutcome = 'completed_unverified';
    const contract = this.contract(input);
    const report = 'Recovery of this task is running in another window; no fix was applied here.';
    this.state.outcome = outcome;
    this.state.phase = outcome;
    this.finished = { outcome, contract, report };
    this.emitRecovery({ outcome, contract, decision: 'running in another window' });
    return { action: 'complete', outcome, contract, report };
  }

  // ---- Write tracking ----

  async beforeWrite(fsPath: string, writer?: string): Promise<void> {
    await this.ready;
    const rel = this.pm.relOf(fsPath);
    if (rel) {
      const abs = path.join(this.root, rel);
      const existing = readText(abs);
      if (existing === null && !fs.existsSync(abs)) {
        this.newThisTurn.add(rel);
      }
      if (this.fix && SECTION_FILES.test(rel)) {
        const m = this.sectionBefore.get(this.fix.n) ?? new Map<string, string | null>();
        if (!m.has(rel)) {
          m.set(rel, existing);
        }
        this.sectionBefore.set(this.fix.n, m);
      }
    }
    await this.pm.beforeWrite(fsPath, writer);
    if (this.kind === 'worker') {
      await this.svc.forRoot(this.rootSid)?.beforeWrite(fsPath, writer ?? this.sessionId);
    }
  }

  async afterWrite(paths: readonly string[], writer?: string): Promise<void> {
    await this.ready;
    await this.pm.afterWrite(paths, writer);
    if (this.kind === 'worker') {
      await this.svc.forRoot(this.rootSid)?.afterWrite(paths, writer ?? this.sessionId);
    } else if (this.persisted) {
      await this.save();
    }
  }

  async noteCommandChanges(files: readonly string[]): Promise<void> {
    await this.ready;
    await this.pm.noteCommandChanges(files);
    if (this.persisted && this.kind !== 'worker') {
      await this.save();
    }
  }

  changedFiles(): string[] {
    return this.pm.changedFiles();
  }

  inRecovery(): boolean {
    return !!this.fix || RECOVERY_PHASES.includes(this.state.phase);
  }

  deadlineHit(): boolean {
    return this.inRecovery() && this.state.deadlineAt !== undefined && this.now() >= this.state.deadlineAt;
  }

  recordApproval(entry: ApprovalRecord): void {
    this.state.approvals.push({ ...entry });
    if (this.state.approvals.length > MAX_APPROVALS) {
      this.state.approvals.splice(0, this.state.approvals.length - MAX_APPROVALS);
    }
    if (this.persisted && this.kind !== 'worker') {
      void this.save();
    }
  }

  /** Turn-scoped allowance for the check commands; the hash covers the commands and the bodies that define them. */
  allowanceFor(commands: readonly string[]): NonNullable<ApprovalOptions['healingAllowance']> {
    const known = this.specsCache ?? [];
    const specs: Pick<CheckSpec, 'command' | 'scoped' | 'cwd' | 'ecosystem' | 'kind'>[] = commands.map(
      (c) => known.find((s) => s.command === c || s.scoped === c) ?? { command: c, kind: 'custom', ecosystem: 'custom' },
    );
    const hash = sha1(`${[...commands].sort().join('\n')}\n${definitionBodies(specs, this.root)}`);
    const a = this.state.checkAllowance;
    const granted = !!a && a.commandsHash === hash && a.turnKey === this.state.turnKey && this.now() - a.at < ALLOWANCE_TTL_MS;
    return {
      commandsHash: hash,
      granted,
      grant: () => {
        this.state.checkAllowance = { commandsHash: hash, turnKey: this.state.turnKey, at: this.now() };
        if (this.persisted && this.kind !== 'worker') {
          void this.save();
        }
      },
    };
  }

  // ---- Checks ----

  private async specs(): Promise<CheckSpec[] & { timeBudgetSeconds?: number }> {
    const cfg = this.cfg();
    const found = await this.opts.discover(this.root, {
      changedFiles: this.pm.changedFiles().filter((f) => f !== UNKNOWN_CHANGES),
      settingChecks: cfg.checks,
      trusted: this.opts.isTrusted(),
      security: cfg.securityCheck !== 'off' && !!this.opts.securityScan && this.kind !== 'worker',
    });
    const timeouts = found.map((s) => (s.source === 'discovered' && s.kind !== 'security' ? { ...s, timeoutSeconds: s.kind === 'test' ? cfg.checkTimeoutSeconds * 2 : cfg.checkTimeoutSeconds } : { ...s }));
    const specs = (this.kind === 'worker' ? timeouts.filter((s) => s.kind === 'typecheck' || s.kind === 'build' || (s.kind === 'test' && !!s.scoped)) : timeouts) as CheckSpec[] & { timeBudgetSeconds?: number };
    if (found.timeBudgetSeconds !== undefined) {
      specs.timeBudgetSeconds = found.timeBudgetSeconds;
    }
    this.specsCache = specs;
    return specs;
  }

  private isForeign = (f: Pick<Failure, 'file'>): boolean => {
    if (!f.file || !this.opts.foreignWriter) {
      return false;
    }
    const writer = this.opts.foreignWriter(path.resolve(this.root, f.file));
    return !!writer && rootSessionId(writer) !== this.rootSid;
  };

  private baselineSigs(): string[] {
    return this.state.baseline?.signatures ?? [];
  }

  private attributed(list: readonly Failure[]): Failure[] {
    return attribute(list, this.baselineSigs(), this.isForeign);
  }

  private accepted(sig: string): boolean {
    return this.state.acceptedRisks.some((r) => r.signatures.includes(sig));
  }

  private specOf(checkId: string | undefined): CheckSpec | undefined {
    const id = checkId?.replace(/#scoped$/, '');
    return (this.specsCache ?? []).find((s) => s.id === id);
  }

  /** Runs the gate stages; a stage that stopped only on preexisting/foreign failures does not hide the later ones. */
  private async runGate(): Promise<void> {
    const cfg = this.cfg();
    const specs = await this.specs();
    const worker = this.kind === 'worker';
    const budgetMs = (specs.timeBudgetSeconds ?? cfg.checkTimeBudgetSeconds) * 1000;
    let run = specs;
    let from: CheckStage | undefined;
    let results: CheckResult[] = [];
    this.outOfScope = false;
    this.budgetOut = false;
    for (let pass = 0; pass < STAGE_ORDER.length + 1; pass++) {
      const r = await this.runner.runStages({
        specs: run, root: this.root, changedFiles: this.pm.changedFiles(), scoped: worker || cfg.scopeTests, fullTests: !worker,
        budgetMs, deadlineAt: this.inRecovery() ? this.state.deadlineAt : undefined, signal: this.ctx.signal, cache: this.state.checks, stagesFrom: from,
      });
      const mine = r.results.map((x) => ({ ...x, failures: this.attributed(x.failures) }));
      results = [...results.filter((x) => !mine.some((m) => m.checkId === x.checkId)), ...mine];
      if (r.outOfScope && pass === 0) {
        this.outOfScope = true;
        break;
      }
      this.budgetOut ||= r.budgetExhausted;
      const timedOut = mine.filter((x) => x.status === 'timeout');
      const timeoutPolicy = effectivePolicies(cfg).check_timeout;
      if (timedOut.length && !r.budgetExhausted && (this.state.perCategory.check_timeout ?? 0) < timeoutPolicy.attempts) {
        this.state.perCategory.check_timeout = (this.state.perCategory.check_timeout ?? 0) + 1;
        const ids = new Set(timedOut.map((x) => x.checkId.replace(/#scoped$/, '')));
        run = run.map((s) => (ids.has(s.id) ? { ...s, timeoutSeconds: s.timeoutSeconds * 2 } : s)) as typeof specs;
        from = undefined;
        continue;
      }
      if (!r.stoppedAt || r.budgetExhausted) {
        break;
      }
      const stopped = mine.filter((x) => x.status === 'failed' && this.specOf(x.checkId)?.required !== false);
      if (stopped.some((x) => x.failures.some((f) => !f.preexisting && !f.foreign && !this.accepted(f.signature)) || !x.failures.length)) {
        break;
      }
      const next = STAGE_ORDER[STAGE_ORDER.indexOf(r.stoppedAt) + 1];
      if (!next) {
        break;
      }
      from = next;
    }
    this.results = new Map(results.map((x) => [x.checkId, x]));
    const changed = this.pm.changedFiles();
    const unknown = changed.includes(UNKNOWN_CHANGES);
    this.relevant = this.outOfScope
      ? []
      : specs.filter((s) => unknown || this.results.has(s.id) || changed.some((f) => f !== UNKNOWN_CHANGES && (s.when?.length ? false : isInCheckScope(f, [s.kind === 'security' ? { ...s, kind: 'custom', ecosystem: 'custom' } : s]))));
    this.state.active = results.flatMap((x) => x.failures);
  }

  /** Attributable failures of required checks that the engine should act on. */
  private blocking(): Failure[] {
    const out = new Map<string, Failure>();
    for (const r of this.results.values()) {
      if (r.status !== 'failed' && r.status !== 'timeout') {
        continue;
      }
      if (this.specOf(r.checkId)?.required === false) {
        continue;
      }
      for (const f of r.failures) {
        if (f.preexisting || f.foreign || f.category === 'check_timeout' || this.ignored.has(f.signature) || this.accepted(f.signature) || out.has(f.signature)) {
          continue;
        }
        out.set(f.signature, f);
      }
    }
    return [...out.values()];
  }

  private stageStatuses(): Record<string, CheckResult['status'] | undefined> {
    return Object.fromEntries([...this.results.values()].map((r) => [r.checkId, r.status]));
  }

  /** Baseline before the first file-changing call of the turn: `fast` = typecheck + lint, cached by whole-tree key. */
  async ensureBaseline(): Promise<void> {
    await this.ready;
    const cfg = this.cfg();
    if (this.baselineDone || this.kind !== 'full' || cfg.baseline === 'off' || this.ctx.signal.aborted) {
      return;
    }
    this.baselineDone = true;
    try {
      const key = await (this.opts.treeKey ?? ((root, signal) => wholeTreeKey(root, undefined, signal)))(this.root, this.ctx.signal);
      if (this.state.baseline?.fingerprint === key) {
        return;
      }
      const cached = this.svc.cachedBaseline(this.root, cfg.baseline, key);
      if (cached) {
        this.state.baseline = { signatures: cached, fingerprint: key, at: this.now() };
        return;
      }
      const specs = await this.specs();
      const res = await this.runner.runBaseline({ specs, root: this.root, mode: cfg.baseline, key, signal: this.ctx.signal, budgetMs: (specs.timeBudgetSeconds ?? cfg.checkTimeBudgetSeconds) * 1000 });
      this.state.baseline = { signatures: res.signatures, fingerprint: key, at: this.now() };
      if (!res.budgetExhausted && res.results.every((r) => r.status === 'passed' || r.status === 'failed')) {
        this.svc.cacheBaseline(this.root, cfg.baseline, key, res.signatures);
      }
      await this.save();
    } catch (e) {
      if (!this.ctx.signal.aborted) {
        this.opts.log.warn(`Self-healing: baseline checks failed to run: ${errText(e)}`);
      }
    }
  }

  // ---- Model failures and tool observation ----

  async onModelFailure(kind: ModelFailure | string, error: unknown, attempt: number, ctx: ModelFailureContext): Promise<ModelFailureResult> {
    await this.ready;
    const cfg = this.cfg();
    const f = classify({ kind: 'model', failure: kind, error, modelName: ctx.modelName ?? '', root: this.root })[0];
    const reasonOf = (x?: Failure): EscalationReason => (x?.category === 'permission' ? 'credentials' : 'model_unavailable');
    if (!f || ctx.streamed || this.ctx.signal.aborted) {
      return { decision: this.ctx.signal.aborted ? { action: 'cancel' } : { action: 'escalate', reason: reasonOf(f) }, failure: f };
    }
    if (!cfg.autoRetry && f.cls !== 'deterministic') {
      return { decision: { action: 'escalate', reason: reasonOf(f) }, failure: f };
    }
    const policy = effectivePolicies(cfg)[f.category];
    const view: RecoveryState = {
      ...this.state,
      perCategory: { [f.category]: Math.max(0, attempt - 1) },
      seen: {},
      attempts: this.adjustments.length ? [{ n: 0, category: 'model_overload', signature: f.signature, strategy: 'adjust_resources', mode: 'inline', patches: [], startedAt: 0, adjust: [...this.adjustments] }] : [],
    };
    const decision = decide(view, f, policy, {
      now: this.now(), deadlineAt: this.state.deadlineAt, recoveryActive: this.inRecovery(), totalCap: Number.POSITIVE_INFINITY, delegateAllowed: false,
      independentGroups: 1, signal: this.ctx.signal, required: true, random: this.opts.random, modelFailure: kind as ModelFailure, error,
      thinking: ctx.thinking, contextWindow: ctx.contextWindow, contextFloor: ctx.contextFloor, serial: ctx.serial, reroute: ctx.reroute,
    });
    if (decision.action !== 'retry') {
      return { decision, failure: f };
    }
    const adjust = decision.adjust;
    if (adjust) {
      this.adjustments.push(adjust.kind === 'reroute' ? { kind: 'reroute', model: '' } : adjust);
    }
    const label = adjust ? (adjust.kind === 'halve_context' ? `context ${adjust.contextWindow}` : adjust.kind) : undefined;
    this.emitRecovery({ phase: 'retrying', title: titleOf(f), category: f.category, severity: f.severity, attempt, max: policy.attempts, decision: `retry in ${Math.round(decision.delayMs / 100) / 10}s${label ? ` (${label})` : ''}` });
    this.tele('retry', f, { attempt, max: policy.attempts, ...(label ? { adjust: [adjust!.kind] } : {}) });
    await this.sleep(decision.delayMs);
    let healthy: boolean | undefined;
    if (f.category === 'model_unavailable' && this.opts.probe && ctx.target && !this.ctx.signal.aborted) {
      healthy = await this.opts.probe(ctx.target, this.ctx.signal).catch(() => false);
    }
    return { decision, failure: f, adjust, delayMs: decision.delayMs, ...(healthy !== undefined ? { healthy } : {}) };
  }

  /** Tool step results: stops on data corruption / git conflicts, replays MCP calls proven not executed. */
  async observe(calls: readonly ToolCall[], perCall: readonly { toolCallId?: string; content: string }[], failedIds: ReadonlySet<string>, decisions?: ReadonlyMap<string, ToolCallDecision>): Promise<ObserveResult> {
    await this.ready;
    const cfg = this.cfg();
    if (!cfg.autoDetect) {
      return {};
    }
    const out: ObserveResult = {};
    const found: Failure[] = [];
    for (const call of calls) {
      const msg = perCall.find((m) => m.toolCallId === call.id);
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(call.arguments || '{}') as Record<string, unknown>;
      } catch {
        args = {};
      }
      const result: ToolResult | undefined = msg ? { content: msg.content, isError: failedIds.has(call.id) } : undefined;
      const fs_ = classify({ kind: 'tool', name: call.name, args, result, decision: decisions?.get(call.id), callId: call.id, root: this.root });
      for (const f of fs_) {
        found.push(f);
        if (f.category === 'mcp' && f.notExecuted && !out.retryCalls?.includes(call)) {
          const server = f.symbol ?? /^mcp_(.+?)__/.exec(call.name)?.[1] ?? '';
          const policy = effectivePolicies(cfg).mcp;
          const used = this.mcpRetries.get(server) ?? 0;
          if (this.opts.mcpRestart && cfg.autoRetry && used < policy.attempts) {
            this.mcpRetries.set(server, used + 1);
            this.tele('retry', f, { attempt: used + 1, max: policy.attempts });
            await this.sleep(backoffMs(policy, used + 1, this.opts.random));
            try {
              await this.opts.mcpRestart(server);
              (out.retryCalls ??= []).push(call);
            } catch (e) {
              this.opts.log.warn(`Self-healing: could not restart MCP server ${server}: ${errText(e)}`);
            }
          }
        }
      }
    }
    if (!found.length) {
      return out;
    }
    for (const f of found) {
      const seen = (this.state.seen[f.signature] ??= { count: 0, afterFix: 0, firstAt: this.now() });
      if (seen.count++ === 0) {
        this.tele('detected', f);
      }
    }
    const fatal = found.find((f) => f.category === 'data_corruption') ?? found.find((f) => f.category === 'git_conflict');
    if (fatal && this.kind !== 'worker') {
      this.state.active = [fatal, ...this.state.active.filter((x) => x.signature !== fatal.signature)];
      this.state.recoveryStartedAt ??= this.now();
      const reason: EscalationReason = fatal.category === 'data_corruption' ? 'data_corruption' : 'git_conflict';
      // Every conflicted file the check found, so the card can offer each one in the merge editor.
      const files = [...new Set(found.filter((f) => f.category === fatal.category && f.file).map((f) => f.file!))];
      const message = await this.escalate(reason, { failure: fatal, files: files.length ? files : undefined });
      out.stop = { reason, message };
    }
    return out;
  }

  // ---- Completion gate ----

  async beforeComplete(input: CompleteInput): Promise<GateDecision> {
    await this.ready;
    this.request = input.request;
    if (this.finished) {
      return { action: 'complete', ...this.finished };
    }
    if (this.ctx.signal.aborted) {
      return { action: 'complete', outcome: 'cancelled' };
    }
    if (this.kind === 'detect') {
      return { action: 'complete', outcome: 'completed' };
    }
    try {
      return await this.verify(input);
    } catch (e) {
      if (this.ctx.signal.aborted) {
        return { action: 'complete', outcome: 'cancelled' };
      }
      throw e;
    }
  }

  private async verify(input: CompleteInput): Promise<GateDecision> {
    if (this.fix) {
      const settled = await this.settleAttempt(input);
      if (settled) {
        return settled;
      }
    } else {
      if (!this.pm.changedFiles().length) {
        return this.complete(input, 'completed');
      }
      await this.transition('verifying', { decision: 'running checks' });
      await this.runGate();
      if (this.outOfScope) {
        return this.complete(input);
      }
    }
    return this.next(input);
  }

  /** Decide on the blocking failures until a fix starts or the task completes/escalates. */
  private async next(input: CompleteInput): Promise<GateDecision> {
    const cfg = this.cfg();
    for (let guard = 0; guard < 64; guard++) {
      if (this.ctx.signal.aborted) {
        return { action: 'complete', outcome: 'cancelled' };
      }
      await this.ctx.control?.waitWhilePaused?.();
      const failures = this.blocking();
      if (!failures.length) {
        return this.complete(input);
      }
      if (this.state.recoveryStartedAt === undefined) {
        this.state.recoveryStartedAt = this.now();
        if (cfg.taskDeadlineMinutes > 0) {
          this.state.deadlineAt = this.state.recoveryStartedAt + cfg.taskDeadlineMinutes * 60_000;
        }
      }
      for (const f of failures) {
        const seen = (this.state.seen[f.signature] ??= { count: 0, afterFix: 0, firstAt: this.now() });
        if (seen.count++ === 0) {
          this.tele('detected', f);
        }
      }
      if (!cfg.autoFix) {
        const stop = failures.find((f) => f.cls === 'fatal' || f.cls === 'policy');
        return stop ? this.escalateComplete(stopReason(stop), input, { failure: stop, command: this.specOf(stop.source.checkId)?.command }) : this.complete(input);
      }
      const groups = groupFailures(failures, this.root);
      const primary = groups[0].lead;
      const resolver = primary.category === 'dependency' ? this.resolverFor(primary) : undefined;
      const d = this.decideFor(primary, groups, resolver?.command);
      await this.transition('classifying', { title: titleOf(primary), category: primary.category, severity: primary.severity, signature: humanKey(primary), decision: d.action });
      switch (d.action) {
        case 'cancel':
          return { action: 'complete', outcome: 'cancelled' };
        case 'escalate':
          return this.escalateComplete(d.reason, input, { failure: primary, command: this.specOf(primary.source.checkId)?.command, budget: d.reason === 'exhausted' ? this.capOf(primary) : undefined, installCommand: resolver?.command });
        case 'ignore':
          this.ignored.add(primary.signature);
          continue;
        case 'resolve': {
          if (d.kind === 'mcp') {
            this.ignored.add(primary.signature);
            continue;
          }
          const r = await this.resolveDependency(primary, resolver, input);
          if (r) {
            return r;
          }
          continue;
        }
        case 'retry':
          this.state.perCategory[primary.category] = (this.state.perCategory[primary.category] ?? 0) + 1;
          await this.transition('retrying', { decision: `rerun checks in ${Math.round(d.delayMs / 1000)}s` }, () => this.tele('retry', primary));
          await this.sleep(d.delayMs);
          await this.runGate();
          continue;
        case 'rollback_then_fix':
        case 'rollback_then_escalate': {
          const last = this.state.attempts[this.state.attempts.length - 1];
          if (last) {
            await this.rollbackFixes(last.n);
          }
          if (d.action === 'rollback_then_escalate') {
            return this.escalateComplete('exhausted', input, { failure: primary });
          }
          continue;
        }
        case 'fix':
          if (this.elsewhere()) {
            return this.yieldToOwner(input);
          }
          if (d.mode === 'delegate' && this.ctx.delegate) {
            const r = await this.delegateFix(groups, d, input);
            if (r) {
              return r;
            }
            continue;
          }
          return this.startFix(primary, groups[0].failures, d, input);
      }
    }
    return this.escalateComplete('loop', input);
  }

  private capOf(f: Failure): number {
    const cfg = this.cfg();
    return Math.min(effectivePolicies(cfg)[f.category].attempts, attemptCap(f.category, cfg.maxRepairAttempts));
  }

  private policyFor(f: Failure): RetryPolicy {
    const p = effectivePolicies(this.cfg())[f.category];
    return this.kind === 'worker' ? { ...p, attempts: Math.min(p.attempts, 1) } : p;
  }

  private decideFor(f: Failure, groups: FailureGroup[], resolveCommand?: string): RetryDecision {
    const cfg = this.cfg();
    const delegateAllowed = cfg.delegateFixes && this.kind === 'full' && this.ctx.depth === 0 && (this.ctx.maxConcurrency ?? 1) > 1 && !!this.ctx.delegate && !/^(ask|plan)$/.test(this.ctx.mode);
    return decide(this.state, f, this.policyFor(f), {
      now: this.now(), deadlineAt: this.state.deadlineAt, recoveryActive: this.state.recoveryStartedAt !== undefined,
      totalCap: this.kind === 'worker' ? 1 : cfg.maxTotalAttempts, delegateAllowed, independentGroups: delegateAllowed ? this.independent(groups).length : 1,
      signal: this.ctx.signal, required: true, maxRepairAttempts: cfg.maxRepairAttempts, random: this.opts.random, resolveCommand,
    });
  }

  /** Groups with disjoint files and no import edge to any group picked before them (greedy, in priority order). */
  private independent(groups: FailureGroup[]): FailureGroup[] {
    const picked: FailureGroup[] = [];
    for (const g of groups) {
      if (!g.files.length) {
        continue;
      }
      const clash = picked.some((p) => p.files.some((a) => g.files.some((b) => a === b || !!this.graph?.importEdge(a, b) || !!this.graph?.importEdge(b, a))));
      if (!clash) {
        picked.push(g);
      }
    }
    return picked;
  }

  private grant(): number {
    const cfg = this.cfg();
    const left = Math.max(0, cfg.extraSteps - this.state.extraStepsUsed);
    const per = Math.max(2, Math.ceil(cfg.extraSteps / Math.max(1, cfg.maxRepairAttempts)));
    const g = Math.min(left, per);
    this.state.extraStepsUsed += g;
    return g;
  }

  private ecosystemOf(f: Failure): string {
    return inferEcosystem(f) ?? this.specOf(f.source.checkId)?.ecosystem ?? 'custom';
  }

  private async suggestions(f: Failure, suppress: boolean): Promise<MemorySuggestion[]> {
    const mem = this.opts.memory(this.root);
    if (!mem?.enabled) {
      return [];
    }
    try {
      const used = new Set(this.state.attempts.filter((a) => a.signature === f.signature && a.memoryUsed).map((a) => a.memoryUsed!));
      const list = await mem.suggest(f, this.ecosystemOf(f), 2);
      return suppress ? list.filter((s) => !used.has(s.entry.id)) : list;
    } catch (e) {
      this.opts.log.warn(`Self-healing: failure memory unavailable: ${errText(e)}`);
      return [];
    }
  }

  private async openAttempt(primary: Failure, d: Extract<RetryDecision, { action: 'fix' }>, mode: FixMode, memoryUsed?: string): Promise<AttemptRecord> {
    const n = this.state.attempts.reduce((m, a) => Math.max(m, a.n), 0) + 1;
    const rec: AttemptRecord = { n, category: primary.category, signature: primary.signature, strategy: this.policyFor(primary).strategy, mode, patches: [], startedAt: this.now(), ...(memoryUsed ? { memoryUsed } : {}) };
    this.state.attempts.push(rec);
    this.pm.openScope(n);
    this.fix = {
      n, category: primary.category, signature: primary.signature, failure: d.raiseSeverity ? { ...primary, severity: d.raiseSeverity } : primary,
      attempt: d.attempt, max: d.max, mode, before: this.blockingAll(), stages: this.stageStatuses(), memoryUsed,
    };
    return rec;
  }

  /** Every attributable current failure (blocking or not) for before/after comparisons. */
  private blockingAll(): Failure[] {
    return [...this.results.values()].flatMap((r) => r.failures).filter((f) => !f.preexisting && !f.foreign);
  }

  private previousAttempts(sig: string) {
    return this.state.attempts
      .filter((a) => a.signature === sig && a.result && a.result !== 'fixed')
      .map((a) => ({ n: a.n, rootCause: a.rootCause, strategy: a.strategy, result: a.result, summary: a.patches.map((p) => `${p.file} +${p.added} -${p.removed}`).join(', ') }));
  }

  private async evidenceFor(group: readonly Failure[], memory: MemorySuggestion[]) {
    const files = [...new Set(group.map((f) => f.file).filter((f): f is string => !!f))];
    return buildEvidence({
      group, root: this.root, patchDiff: (await this.pm.diffFor(files)) || undefined, memory, neighbours: this.graph ? (f) => this.graph!.neighbours(f) : undefined,
      previousAttempts: this.previousAttempts(group[0].signature), contextWindow: this.ctx.contextWindow, changedFiles: this.pm.changedFiles().filter((f) => f !== UNKNOWN_CHANGES),
    });
  }

  private async startFix(primary: Failure, group: Failure[], d: Extract<RetryDecision, { action: 'fix' }>, input: CompleteInput): Promise<GateDecision> {
    const memory = await this.suggestions(primary, !!d.raiseSeverity);
    const ev = await this.evidenceFor(group, memory);
    const last = [...this.state.attempts].reverse().find((a) => a.signature === primary.signature && a.result);
    const duplicateNote = d.raiseSeverity
      ? `your previous fix did not change this error${last?.patches.length ? ` (previous patch: ${last.patches.map((p) => `${p.file} +${p.added} -${p.removed}`).join(', ')})` : ''}; try a different approach.`
      : undefined;
    const msg = fixPrompt(ev, { attempt: d.attempt, max: d.max, category: primary.category, code: primary.code, duplicateNote, worseNote: this.worseNote });
    const memoryUsed = memory[0]?.entry.id;
    await this.openAttempt(primary, d, 'inline', memoryUsed);
    const used = this.state.extraStepsUsed;
    const grantSteps = this.grant();
    const saved = await this.transition('fixing', { attempt: d.attempt, max: d.max, rootCause: ev.hypothesis, decision: 'fixing' }, () => {
      this.tele('fix_attempt', this.fix!.failure, { attempt: d.attempt, max: d.max });
      if (memoryUsed) {
        this.tele('memory_hit', primary);
      }
    });
    if (!saved && this.elsewhere()) {
      this.state.extraStepsUsed = used;
      return this.yieldToOwner(input);
    }
    this.worseNote = undefined;
    this.ctx.injectHidden(msg);
    return { action: 'continue', grantSteps };
  }

  private async delegateFix(groups: FailureGroup[], d: Extract<RetryDecision, { action: 'fix' }>, input: CompleteInput): Promise<GateDecision | undefined> {
    const picked = this.independent(groups).slice(0, Math.max(1, this.ctx.maxConcurrency ?? 1));
    const primary = picked[0]?.lead ?? groups[0].lead;
    const briefs: FixerTask[] = [];
    for (const g of picked) {
      const ev = await this.evidenceFor(g.failures, await this.suggestions(g.lead, !!d.raiseSeverity));
      briefs.push({ agent: 'fixer', prompt: fixBrief(ev), origin: 'healing' });
    }
    await this.openAttempt(primary, d, 'delegate');
    const saved = await this.transition('fixing', { attempt: d.attempt, max: d.max, decision: `delegating ${briefs.length} fixes` }, () => this.tele('fix_attempt', primary, { attempt: d.attempt, max: d.max, delegated: true }));
    if (!saved && this.elsewhere()) {
      return this.yieldToOwner(input);
    }
    this.delegations++;
    let content = '';
    try {
      const res = await this.ctx.delegate!(briefs, this.ctx.signal);
      content = res.content ?? '';
      if (!res.ok) {
        this.failedDelegations++;
      }
      if (res.writtenFiles?.length) {
        await this.pm.afterWrite(res.writtenFiles.map((f) => path.resolve(this.root, f)), 'fixer');
      }
    } catch (e) {
      if (this.ctx.signal.aborted) {
        return { action: 'complete', outcome: 'cancelled' };
      }
      this.failedDelegations++;
      this.opts.log.warn(`Self-healing: delegated fix failed: ${errText(e)}`);
    }
    return this.settleAttempt({ ...input, finalText: content });
  }

  /** Records the end of the active attempt (counters, scope, memory outcome). */
  private async finishAttempt(rec: AttemptRecord, result: AttemptResult, survived: boolean): Promise<void> {
    const fix = this.fix!;
    rec.result = result;
    rec.endedAt = this.now();
    this.state.perCategory[rec.category] = (this.state.perCategory[rec.category] ?? 0) + 1;
    if (survived) {
      const seen = (this.state.seen[rec.signature] ??= { count: 1, afterFix: 0, firstAt: rec.startedAt });
      seen.afterFix++;
    }
    this.pm.closeScope();
    this.fix = undefined;
    const mem = this.opts.memory(this.root);
    if (fix.memoryUsed && mem?.enabled && result !== 'blocked') {
      await mem.markOutcome(fix.memoryUsed, result === 'fixed').catch(() => undefined);
    }
    if (result === 'fixed') {
      this.pendingMemory.push({ rec, failure: fix.failure });
    } else if (mem?.enabled && result !== 'blocked' && rec.patches.length) {
      await mem
        .record(fix.failure, { rootCause: rec.rootCause ?? hypothesis(fix.failure, this.root), strategy: rec.strategy, patchSummary: rec.patches.map((p) => p.preview).join('\n'), files: rec.patches.map((p) => p.file), success: false, ecosystem: this.ecosystemOf(fix.failure) })
        .catch(() => undefined);
    }
    await this.transition('diagnosing', { attempt: fix.attempt, max: fix.max, decision: result.replace(/_/g, ' ') }, () =>
      this.tele(result === 'duplicate' ? 'duplicate' : result === 'rolled_back' ? 'rolled_back' : 'validated', fix.failure, { attempt: fix.attempt, max: fix.max, outcome: result, delegated: fix.mode === 'delegate' || undefined }),
    );
  }

  private detectMods(n: number, files: string[]): AttemptWrite[] {
    const specs = this.specsCache ?? [];
    const before = this.sectionBefore.get(n);
    const found = detectChecksModified({
      attemptWrites: files.filter((f) => f !== UNKNOWN_CHANGES).map((file) => ({ file, attempt: n })),
      definingFiles: checkDefiningFiles(specs, this.root),
      newThisTurn: this.newThisTurn,
      requestText: this.request,
      scriptsChanged: (file) => {
        const rel = slash(file);
        if (!before?.has(rel)) {
          return true;
        }
        return checkDefiningEdit(rel, before.get(rel) ?? null, readText(path.join(this.root, rel))) !== undefined;
      },
    });
    for (const m of found) {
      if (!this.checksModified.some((c) => c.file === m.file)) {
        this.checksModified.push(m);
      }
    }
    return found;
  }

  /** The model (or the fixers) ended a fix attempt: settle it without a rerun when nothing (new) changed, else validate. */
  private async settleAttempt(input: CompleteInput): Promise<GateDecision | undefined> {
    const fix = this.fix!;
    const rec = this.state.attempts.find((a) => a.n === fix.n)!;
    const reply = parseReply(input.finalText);
    rec.rootCause = reply.rootCause ?? rec.rootCause ?? hypothesis(fix.failure, this.root);
    if (reply.blocked) {
      rec.patches = await this.pm.patches(fix.n);
      await this.finishAttempt(rec, 'blocked', false);
      return this.escalateComplete('model_blocked', input, { detail: reply.blocked, failure: fix.failure });
    }
    const files = this.pm.changedFiles(fix.n);
    const patches = files.length ? await this.pm.patches(fix.n) : [];
    if (!files.length || (!patches.length && !files.includes(UNKNOWN_CHANGES))) {
      await this.finishAttempt(rec, 'not_fixed', true);
      return undefined;
    }
    const earlier = new Set(this.state.attempts.filter((a) => a.n !== fix.n).flatMap((a) => a.patches.map((p) => p.diffHash)));
    if (patches.length && patches.every((p) => earlier.has(p.diffHash))) {
      if (!(await this.transition('rolling_back', { decision: 'identical patch refused' })) && this.elsewhere()) {
        return this.yieldToOwner(input);
      }
      await this.pm.rollback(fix.n);
      rec.patches = await this.pm.patches(fix.n);
      await this.finishAttempt(rec, 'duplicate', true);
      return undefined;
    }
    rec.patches = patches;
    const mods = this.detectMods(fix.n, files);
    await this.transition('validating', { attempt: fix.attempt, max: fix.max, rootCause: rec.rootCause, decision: 'rerunning checks' });
    const started = this.now();
    await this.runGate();
    const after = this.blockingAll();
    const required = (this.specsCache ?? []).filter((s) => s.required).flatMap((s) => [s.id, `${s.id}#scoped`]);
    const comparison = compare(fix.before, [...this.results.values()].flatMap((r) => r.failures), this.baselineSigs(), this.isForeign, this.now() - started);
    const { still: _still, ...report } = comparison;
    void _still;
    rec.regression = report;
    this.regression = report;
    if (isWorse(fix.before, after, this.baselineSigs(), this.isForeign, { before: fix.stages, after: this.stageStatuses(), required })) {
      this.state.pendingAction = { kind: 'rollback', status: 'started', at: this.now() };
      if (!(await this.transition('rolling_back', { decision: 'rolling back: the fix made it worse' })) && this.elsewhere()) {
        this.state.pendingAction = undefined;
        return this.yieldToOwner(input);
      }
      const rb = await this.pm.rollback(fix.n);
      this.state.pendingAction = { kind: 'rollback', status: 'done', at: this.now() };
      const userEdited = rb.skipped.filter((s) => s.reason === 'user_edited').map((s) => s.file);
      rec.patches = await this.pm.patches(fix.n);
      if (userEdited.length) {
        await this.finishAttempt(rec, 'worse', true);
        return this.escalateComplete('user_edit_conflict', input, { files: userEdited, failure: fix.failure });
      }
      await this.finishAttempt(rec, 'rolled_back', true);
      const introduced = after.filter((f) => report.introduced.includes(f.signature)).slice(0, 3).map((f) => titleOf(f));
      this.worseNote = `the previous attempt made it worse${introduced.length ? ` (new: ${introduced.join('; ')})` : ''}; it was reverted.`;
      this.results = new Map([...this.results].map(([id, r]) => [id, { ...r, failures: r.failures.filter((f) => !report.introduced.includes(f.signature)) }]));
      for (const f of fix.before) {
        const r = f.source.checkId ? this.results.get(f.source.checkId) : undefined;
        if (r && !r.failures.some((x) => x.signature === f.signature)) {
          r.failures.push(f);
          r.status = 'failed';
        }
      }
      return undefined;
    }
    const targetGone = !after.some((f) => f.signature === fix.signature);
    // A new failure of the same kind, from the same check, in the same file replaced the target rather than fixing it.
    const t = fix.failure;
    const replaced = after.some((f) => report.introduced.includes(f.signature) && f.category === t.category && f.source.checkId === t.source.checkId && f.file === t.file);
    const result: AttemptResult = targetGone && !replaced && !mods.length ? 'fixed' : 'not_fixed';
    await this.finishAttempt(rec, result, !targetGone);
    return undefined;
  }

  private resolverFor(f: Failure): ResolverCommand | undefined {
    const info = dependencyInfo(this.root, f);
    const eco = info.ecosystem ?? inferEcosystem(f) ?? this.specOf(f.source.checkId)?.ecosystem;
    return resolverCommands(f, eco, packageManagerOf(info.lockfiles), { declared: info.declared, manifest: info.manifest, lockfile: info.lockfiles.length > 0 })[0];
  }

  /** Dependency resolution: journaled before execution, mandatory approval, never in unattended runs or with `never`. */
  private async resolveDependency(f: Failure, cmd: ResolverCommand | undefined, input: CompleteInput): Promise<GateDecision | undefined> {
    const cfg = this.cfg();
    if (cfg.dependencyInstall === 'never') {
      this.approvalBlock = 'pending';
      return this.escalateComplete('approval_needed', input, { failure: f, installCommand: cmd?.command, next: `dependency installs are disabled (healing.dependencyInstall: never); install ${f.symbol ?? 'it'} yourself, then "Resume".` });
    }
    if (!cmd) {
      this.approvalBlock = 'pending';
      return this.escalateComplete('approval_needed', input, { failure: f, next: `install ${f.symbol ?? 'the missing dependency'} yourself, then "Resume".` });
    }
    if (this.ctx.unattended) {
      this.approvalBlock = 'pending';
      return this.escalateComplete('approval_needed', input, { failure: f, installCommand: cmd.command, unattended: true });
    }
    if (this.elsewhere()) {
      return this.yieldToOwner(input);
    }
    const n = this.state.attempts.reduce((m, a) => Math.max(m, a.n), 0) + 1;
    const rec: AttemptRecord = { n, category: 'dependency', signature: f.signature, strategy: 'install', mode: 'inline', patches: [], startedAt: this.now(), rootCause: hypothesis(f, this.root) };
    this.state.attempts.push(rec);
    this.state.pendingAction = { kind: 'install', command: cmd.command, status: 'proposed', at: this.now() };
    await this.transition('resolving', { title: titleOf(f), decision: `install: ${cmd.command} (needs approval)` }, () => this.tele('fix_attempt', f, { attempt: 1, max: this.capOf(f) }));
    this.state.pendingAction = { ...this.state.pendingAction, status: 'started', at: this.now() };
    if (!(await this.save()) && this.elsewhere()) {
      this.state.attempts = this.state.attempts.filter((a) => a !== rec);
      this.state.pendingAction = undefined;
      return this.yieldToOwner(input);
    }
    const spec: CheckSpec = { id: `install:${cmd.template}`, kind: 'custom', command: cmd.command, ...(cmd.cwd ? { cwd: cmd.cwd } : {}), timeoutSeconds: 600, required: false, source: 'discovered', ecosystem: (this.specOf(f.source.checkId)?.ecosystem ?? 'custom') };
    let res: ExecResult;
    try {
      res = await this.ctx.exec(spec, this.ctx.signal, { kind: 'install', checkSpecMatch: false, timeoutSeconds: spec.timeoutSeconds, requiresApproval: true });
    } catch (e) {
      res = { exitCode: null, output: errText(e) };
    }
    rec.endedAt = this.now();
    this.state.perCategory.dependency = (this.state.perCategory.dependency ?? 0) + 1;
    if (res.skipped) {
      if (this.ctx.signal.aborted) {
        return { action: 'complete', outcome: 'cancelled' };
      }
      rec.result = 'blocked';
      this.state.pendingAction = { ...this.state.pendingAction, status: 'declined', at: this.now() };
      this.approvalBlock = 'declined';
      return this.escalateComplete('approval_needed', input, { failure: f, installCommand: cmd.command, unattended: res.skipped.blockedBy === 'unattended' });
    }
    this.state.pendingAction = { ...this.state.pendingAction, status: 'done', at: this.now() };
    await this.transition('validating', { decision: res.exitCode === 0 ? 'installed; rerunning checks' : `install exited with ${res.exitCode}` });
    await this.runGate();
    const gone = !this.blocking().some((x) => x.signature === f.signature);
    rec.result = gone ? 'fixed' : 'not_fixed';
    if (!gone) {
      const seen = (this.state.seen[f.signature] ??= { count: 1, afterFix: 0, firstAt: rec.startedAt });
      seen.afterFix++;
    }
    await this.transition('diagnosing', { decision: rec.result.replace(/_/g, ' ') }, () => this.tele('validated', f, { outcome: rec.result }));
    return undefined;
  }

  private contract(input: CompleteInput, extra: { modelBlocked?: string; reason?: EscalationReason } = {}): GateContract {
    const cfg = this.cfg();
    const changed = this.pm.changedFiles().length;
    const fixAttempts = this.state.attempts.some((a) => a.strategy !== 'install');
    return buildContract({
      results: [...this.results.values()], specs: this.relevant, outOfScope: this.outOfScope || changed === 0, regression: this.regression,
      regressionRequired: cfg.regressionRequired, regressionNeeded: fixAttempts, todos: input.todos, finalText: input.finalText, request: input.request,
      changedFiles: changed, delegations: this.delegations, approvals: this.state.approvals, pendingRequired: this.approvalBlock === 'pending',
      declinedRequired: this.approvalBlock === 'declined', unresolved: this.state.active.filter((f) => f.category !== 'check_timeout'),
      outstandingRecovery: !!this.fix, failedDelegations: this.failedDelegations, budgetExhausted: this.budgetOut || extra.reason === 'deadline' || extra.reason === 'loop' || extra.reason === 'exhausted',
      checksModified: this.checksModified, acceptedRisks: this.state.acceptedRisks, modelBlocked: extra.modelBlocked,
      credentialsMissing: extra.reason === 'credentials', gitConflict: extra.reason === 'git_conflict', securityNeedsUser: extra.reason === 'security',
    });
  }

  /** Terminal gate result: contract, outcome, memory, telemetry, footer. */
  private async complete(input: CompleteInput, forced?: TaskOutcome): Promise<GateDecision> {
    const contract = this.contract(input);
    const outcome = forced ?? evaluate(contract);
    const fixed = this.state.attempts.filter((a) => a.result === 'fixed');
    if (this.kind === 'worker') {
      this.verdict = { healthy: outcome === 'completed' || outcome === 'completed_unverified', failures: this.blocking() };
      this.opts.bus.publish(this.sessionId, { type: 'worker_result', childId: this.sessionId, healthy: this.verdict.healthy, failures: this.verdict.failures });
    }
    if (outcome === 'completed' && this.pendingMemory.length) {
      const mem = this.opts.memory(this.root);
      for (const { rec, failure } of this.pendingMemory.splice(0)) {
        await mem
          ?.record(failure, {
            rootCause: rec.rootCause ?? hypothesis(failure, this.root), strategy: rec.strategy, patchSummary: rec.patches.map((p) => p.preview).join('\n'),
            files: rec.patches.map((p) => p.file), success: true, ecosystem: this.ecosystemOf(failure),
            validation: { checks: [...this.results.keys()], passed: true, regressionClean: !this.regression?.introduced.length },
          })
          .catch(() => undefined);
      }
    }
    const last = [...this.state.attempts].reverse().find((a) => a.rootCause);
    const reportText = this.pm.changedFiles().length || this.state.attempts.length
      ? formatReport(contract, outcome, { results: [...this.results.values()], specs: this.relevant, regression: this.regression, attempts: this.state.attempts.length || undefined, rootCause: last?.rootCause })
      : undefined;
    this.state.outcome = outcome;
    this.state.contract = contract;
    this.finished = { outcome, contract, ...(reportText ? { report: reportText } : {}) };
    const recovered = fixed.length > 0 && (outcome === 'completed' || outcome === 'completed_unverified');
    if (this.persisted || this.pm.changedFiles().length) {
      const first = this.state.attempts[0];
      await this.transition(outcome, { outcome, contract, decision: recovered ? `recovered after ${this.state.attempts.length} attempt${this.state.attempts.length === 1 ? '' : 's'}` : undefined }, () => {
        if (recovered && first && outcome === 'completed') {
          const f = { category: first.category, signature: first.signature };
          this.tele('recovered', f, { attempt: this.state.attempts.length, durationMs: this.now() - (this.state.recoveryStartedAt ?? first.startedAt), outcome: fixed.some((a) => a.memoryUsed) ? 'memory' : outcome });
        }
      });
    } else {
      this.state.phase = outcome;
    }
    return { action: 'complete', outcome, contract, ...(reportText ? { report: reportText } : {}) };
  }

  private async escalateComplete(reason: EscalationReason, input: CompleteInput, extra: EscalateExtra = {}): Promise<GateDecision> {
    const text = await this.escalate(reason, { ...extra, input });
    if (this.kind === 'worker') {
      return this.complete(input, 'incomplete');
    }
    return { action: 'complete', ...this.finished!, report: text };
  }

  /** Escalation Manager: intervention record + outcome persisted before anything else; returns the report text. */
  async escalate(reason: EscalationReason, extra: EscalateExtra = {}): Promise<string> {
    await this.ready;
    const cfg = this.cfg();
    const { input, ...ctx } = extra;
    if (this.fix) {
      const rec = this.state.attempts.find((a) => a.n === this.fix!.n);
      if (rec && !rec.result) {
        rec.patches = await this.pm.patches(this.fix.n);
        rec.result = 'not_fixed';
        rec.endedAt = this.now();
      }
      this.pm.closeScope();
      this.fix = undefined;
    }
    const intervention = buildIntervention(this.state, reason, {
      now: this.now(), maxTotalAttempts: cfg.maxTotalAttempts, deadlineMinutes: cfg.taskDeadlineMinutes || undefined, unattended: this.ctx.unattended, ...ctx,
    });
    const outcome = outcomeFor(reason);
    const contract = input ? this.contract(input, { reason, modelBlocked: reason === 'model_blocked' ? ctx.detail ?? 'blocked' : undefined }) : this.state.contract;
    this.state.intervention = intervention;
    this.state.outcome = outcome;
    if (contract) {
      this.state.contract = contract;
    }
    const text = escalationReport(this.state, intervention, { next: ctx.next, installCommand: ctx.installCommand });
    this.finished = { outcome, ...(contract ? { contract } : {}), report: text };
    const f = ctx.failure ?? this.state.active[0];
    const action = reason === 'exhausted' ? 'exhausted' : outcome === 'blocked' ? 'blocked' : 'escalated';
    if (this.kind === 'worker') {
      this.state.phase = outcome;
      return text;
    }
    const next = ctx.next ?? (intervention as { next?: string }).next;
    await this.transition(outcome, { outcome, contract, intervention: { id: intervention.id, reason, nextActions: intervention.nextActions, ...(ctx.files?.length ? { files: ctx.files.slice(0, 50) } : {}), ...(next ? { next } : {}) }, decision: `needs you: ${reason.replace(/_/g, ' ')}` }, () =>
      this.tele(action, f ?? { category: intervention.category ?? 'unknown' }, { attempt: this.state.attempts.length || undefined, outcome }),
    );
    if (!(await this.store.addIntervention(intervention))) {
      this.opts.log.warn('Self-healing: could not record the intervention');
    }
    return text;
  }

  // ---- Resume, rollback, dispose ----

  /** Resume turn: restore patches, re-run the verifying stages first (never replay a started install), then inject/complete/escalate. */
  async resumeEntry(input?: Partial<CompleteInput>): Promise<ResumeDecision> {
    await this.ready;
    if (this.kind !== 'full') {
      return { action: 'proceed' };
    }
    const full: CompleteInput = { todos: input?.todos, finalText: input?.finalText ?? '', request: input?.request ?? '' };
    this.request = full.request;
    const s = this.state;
    if (s.deadlineAt !== undefined) {
      // Time the task was down (closed window, queued overnight) does not count against the recovery deadline.
      const down = Math.max(0, this.now() - s.updatedAt);
      s.deadlineAt += down;
      if (s.recoveryStartedAt !== undefined) {
        s.recoveryStartedAt += down;
      }
    }
    if (s.intervention && !s.intervention.resolvedAt) {
      s.intervention.resolvedAt = this.now();
      await this.store.resolveIntervention(s.intervention.id, s.intervention.resolvedAt).catch(() => false);
    }
    s.outcome = undefined;
    this.finished = undefined;
    if (s.pendingAction?.status === 'started') {
      this.opts.log.info?.(`Self-healing: "${s.pendingAction.command ?? s.pendingAction.kind}" was started before the restart; not rerun, the checks show whether it took effect`);
    }
    const open = [...s.attempts].reverse().find((a) => !a.result);
    if (open && open.strategy !== 'install') {
      const failure = s.active.find((f) => f.signature === open.signature) ?? s.active[0];
      if (failure) {
        if (this.pm.activeAttempt() !== open.n) {
          this.pm.openScope(open.n);
        }
        const cap = this.capOf(failure);
        this.fix = {
          n: open.n, category: open.category, signature: open.signature, failure, attempt: (s.perCategory[open.category] ?? 0) + 1, max: cap, mode: open.mode,
          before: s.active.filter((f) => !f.preexisting && !f.foreign), stages: Object.fromEntries(Object.entries(s.checks).map(([id, c]) => [id, c.status])), memoryUsed: open.memoryUsed,
        };
      } else {
        open.result = 'not_fixed';
        open.endedAt = this.now();
      }
    } else if (open) {
      open.result = 'not_fixed';
      open.endedAt = this.now();
    }
    if (!this.fix && !this.pm.changedFiles().length) {
      await this.transition('executing', { decision: 'resumed' }, () => this.tele('resumed', s.active[0]));
      return { action: 'proceed' };
    }
    await this.transition('verifying', { decision: 'resumed: rerunning checks' }, () => this.tele('resumed', this.fix?.failure ?? s.active[0], { attempt: s.attempts.length || undefined }));
    if (!this.fix) {
      await this.runGate();
      if (this.outOfScope) {
        return this.complete(full);
      }
      return this.next(full);
    }
    return this.verify(full);
  }

  /** Rolls back attempt `attempt` and every later one (all when omitted), newest first; user edits are never touched. */
  async rollbackFixes(attempt?: number): Promise<RollbackResult> {
    await this.ready;
    const phase = this.state.phase;
    this.state.pendingAction = { kind: 'rollback', status: 'started', at: this.now() };
    if (!(await this.transition('rolling_back', { decision: 'rolling back fixes' })) && this.elsewhere()) {
      this.state.pendingAction = undefined;
      this.state.phase = phase;
      this.opts.log.warn(`Self-healing: recovery of ${this.rootSid} is running in another window; nothing rolled back here`);
      return { restored: [], skipped: [] };
    }
    const res = await this.pm.rollback(attempt);
    for (const a of this.state.attempts.filter((x) => attempt === undefined || x.n >= attempt)) {
      a.patches = await this.pm.patches(a.n);
      if (a.patches.some((p) => p.result === 'rolled_back')) {
        a.result = a.result === 'fixed' || !a.result ? 'rolled_back' : a.result;
      }
    }
    this.fix = undefined;
    this.state.pendingAction = { kind: 'rollback', status: 'done', at: this.now() };
    await this.transition(isTerminalPhase(this.state.outcome) ? this.state.outcome : 'executing', { decision: `rolled back ${res.restored.length} file${res.restored.length === 1 ? '' : 's'}` }, () =>
      this.tele('rolled_back', this.state.active[0]),
    );
    return res;
  }

  /** Closes the open intervention of this live task (false when there is none, or another window owns the recovery). */
  async dismissIntervention(): Promise<boolean> {
    await this.ready;
    const iv = this.state.intervention;
    if (!iv || iv.resolvedAt || this.elsewhere()) {
      return false;
    }
    iv.resolvedAt = this.now();
    await this.store.resolveIntervention(iv.id, iv.resolvedAt).catch(() => false);
    await this.save();
    return true;
  }

  /** Records a user's risk acceptance (security findings only). */
  async acceptRisk(by: 'user'): Promise<AcceptedRisk | undefined> {
    await this.ready;
    const sigs = [...new Set([
      ...this.state.active.filter((f) => f.category === 'security').map((f) => f.signature),
      ...(this.state.contract?.unresolved ?? []).filter((u) => u.category === 'security').map((u) => u.signature),
    ])];
    if (!sigs.length) {
      return undefined;
    }
    return this.svc.recordRisk(this.state, by, sigs, () => this.save());
  }

  /** The turn's recovery summary (turn_end.payload.recovery); workers add their verdict. */
  summary(): (RecoverySummary & Partial<WorkerVerdict>) | undefined {
    if (!this.state.attempts.length && !this.results.size && !this.finished?.report) {
      return this.verdict ? { id: this.recoveryId, phase: this.state.phase, attempts: 0, categories: [], rootCauses: [], patches: [], updatedAt: this.now(), ...this.verdict } : undefined;
    }
    return {
      id: this.recoveryId,
      phase: this.state.phase,
      ...(this.state.outcome ? { outcome: this.state.outcome } : {}),
      attempts: this.state.attempts.length,
      categories: [...new Set(this.state.attempts.map((a) => a.category))],
      rootCauses: this.state.attempts.map((a) => a.rootCause).filter((r): r is string => !!r),
      patches: this.state.attempts.flatMap((a) => a.patches.map((p) => ({ file: p.file, added: p.added, removed: p.removed, attempt: p.attempt, result: p.result }))),
      ...(this.state.intervention ? { interventionId: this.state.intervention.id } : {}),
      ...(this.finished?.report ? { report: this.finished.report } : {}),
      updatedAt: this.state.updatedAt,
      ...(this.verdict ?? {}),
    };
  }

  /** The terminal result once the gate completed or an escalation ended the task. */
  result(): { outcome: TaskOutcome; contract?: CompletionContract; report?: string } | undefined {
    return this.finished ? { ...this.finished } : undefined;
  }

  /** Worker verdicts received over the bus, by child session id. */
  workers(): ReadonlyMap<string, WorkerVerdict> {
    return this.workerResults;
  }

  /** Read-only view of the persisted state (tests, UI). */
  snapshot(): RecoveryState {
    this.syncPatches();
    return JSON.parse(JSON.stringify(this.state)) as RecoveryState;
  }

  /** `shutdown` -> interrupted (owner released); a user stop -> cancelled; releases the lock and the registry entry. */
  async dispose(stopReason?: string): Promise<void> {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    await this.ready;
    this.unsubscribe?.();
    this.svc.unregister(this);
    if (this.kind === 'worker') {
      return;
    }
    const terminal = isTerminalPhase(this.state.phase);
    try {
      if (stopReason === 'shutdown') {
        if (this.persisted && !terminal) {
          this.syncPatches();
          await this.store.markInterrupted(this.rootSid, this.state);
          this.svc.noteState(this.state);
        }
      } else if ((stopReason || this.ctx.signal.aborted) && this.persisted && !terminal) {
        this.state.outcome = 'cancelled';
        this.fix = undefined;
        this.pm.closeScope();
        await this.transition('cancelled', { outcome: 'cancelled' });
      }
      const outcome = this.state.outcome;
      if (this.owned && isTerminalPhase(this.state.phase) && outcome && outcome !== 'incomplete' && outcome !== 'blocked') {
        await this.store.removeAttempts(this.rootSid);
      }
    } finally {
      await this.store.release(this.rootSid);
    }
  }
}

// ---- Service ----

export class HealingService {
  private readonly live = new Map<string, HealingEngine>();
  private readonly index = new Map<string, ResumeInfo>();
  private readonly baselines = new Map<string, string[]>();

  constructor(private readonly opts: HealingServiceOptions) {}

  private now(): number {
    return (this.opts.now ?? Date.now)();
  }

  private sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return (this.opts.sleep ?? realSleep)(ms, signal);
  }

  /** Marks dead-owner states interrupted and fills the synchronous resume index (await before `TaskQueue.load()`). */
  async scanUnfinished(): Promise<UnfinishedSummary[]> {
    const found = await this.opts.store.scanUnfinished();
    for (const u of found) {
      this.index.set(rootSessionId(u.sid), { phase: u.phase, attempt: u.attempt, max: u.max, ...(u.category ? { category: u.category } : {}) });
    }
    return found;
  }

  resumeInfo(sid: string): ResumeInfo | undefined {
    return this.index.get(rootSessionId(sid));
  }

  interrupted(): (ResumeInfo & { sid: string })[] {
    return [...this.index].filter(([, i]) => i.phase === 'interrupted').map(([sid, i]) => ({ sid, ...i }));
  }

  /** Keeps the resume index current; called on every engine save. */
  noteState(s: RecoveryState): void {
    const sid = rootSessionId(s.sessionId);
    if (isTerminalPhase(s.phase) || s.phase === 'idle') {
      this.index.delete(sid);
      return;
    }
    const last = s.attempts[s.attempts.length - 1];
    const category = last?.category ?? s.active[0]?.category;
    const cfg = this.opts.config();
    const max = category ? Math.min(effectivePolicies(cfg)[category].attempts, attemptCap(category, cfg.maxRepairAttempts)) : cfg.maxRepairAttempts;
    const attempt = last ? (s.perCategory[last.category] ?? 0) + (last.result ? 0 : 1) : 0;
    this.index.set(sid, { phase: s.phase, attempt, max: Math.max(max, attempt), ...(category ? { category } : {}) });
  }

  cachedBaseline(root: string, mode: string, key: string): string[] | undefined {
    return this.baselines.get(`${path.resolve(root)}\0${mode}\0${key}`);
  }

  cacheBaseline(root: string, mode: string, key: string, sigs: string[]): void {
    this.baselines.set(`${path.resolve(root)}\0${mode}\0${key}`, sigs);
  }

  /**
   * Routing retry before an engine exists ("Ollama unavailable"): transient failures are retried by `policy` with
   * backoff through the injected sleep; the provider health probe runs before each retry.
   */
  async routeRetry<T>(policy: RetryPolicy, routeFn: () => Promise<T>, probe?: string | ((signal?: AbortSignal) => Promise<boolean>), signal?: AbortSignal, sid?: string): Promise<T> {
    const transient = new Set<ModelFailure>(['network', 'unroutable', 'server', 'stall', 'ratelimit', 'overload']);
    for (let attempt = 1; ; attempt++) {
      let err: unknown;
      try {
        return await routeFn();
      } catch (e) {
        err = e;
      }
      const kind = classifyModelError(err);
      if (signal?.aborted || !this.opts.config().autoRetry || !transient.has(kind) || attempt > policy.attempts) {
        throw err;
      }
      let delay = backoffMs(policy, attempt, this.opts.random);
      if (kind === 'ratelimit') {
        delay = retryDelayMs('ratelimit', err, attempt, [delay]);
      }
      if (sid) {
        this.opts.telemetry?.record({ type: 'recovery', sid: rootSessionId(sid), action: 'retry', category: 'model_unavailable', attempt, max: policy.attempts });
      }
      await this.sleep(delay, signal);
      if (signal?.aborted) {
        throw err;
      }
      if (probe) {
        const ok = await (typeof probe === 'string' ? this.opts.probe?.(probe, signal) ?? Promise.resolve(true) : probe(signal)).catch(() => false);
        if (!ok && attempt >= policy.attempts) {
          throw err;
        }
      }
    }
  }

  /** The final model failure is about to throw: persist the outcome and intervention (no turn_end follows). */
  async escalateRun(sid: string, reason: EscalationReason, error: unknown): Promise<string> {
    const live = this.live.get(rootSessionId(sid));
    if (live) {
      return live.escalate(reason, { detail: errText(error) });
    }
    const store = this.opts.store;
    const prior = await store.load(sid);
    const state = prior && !isTerminalPhase(prior.phase) ? prior : freshState(sid, prior?.turnKey ?? 0, this.now(), this.opts.owner ?? 'vscode');
    const intervention = buildIntervention(state, reason, { now: this.now(), detail: errText(error) });
    const outcome = outcomeFor(reason);
    state.intervention = intervention;
    state.outcome = outcome;
    state.phase = outcome;
    const wasOwned = store.isOwned(sid);
    const owned = (await store.acquire(sid)) === 'owned';
    try {
      if (owned) {
        await store.save(state);
        await store.addIntervention(intervention);
      }
    } finally {
      if (!wasOwned) {
        await store.release(sid);
      }
    }
    this.noteState(state);
    this.opts.telemetry?.record({ type: 'recovery', sid: rootSessionId(sid), action: outcome === 'blocked' ? 'blocked' : 'escalated', category: reason === 'credentials' ? 'permission' : 'model_unavailable', outcome });
    return escalationReport(state, intervention);
  }

  forRoot(rootSid: string): HealingEngine | undefined {
    return this.live.get(rootSessionId(rootSid));
  }

  /**
   * Engine for one run, or undefined: disabled, scratch, no workspace, or a depth > 0 child that is not an
   * engine-started fixer (those route writes to the root engine). Ask/Plan get a detection-only engine.
   */
  begin(ctx: HealingRunContext): HealingEngine | undefined {
    const cfg = this.opts.config();
    if (!cfg.enabled || ctx.scratch || !ctx.root) {
      return undefined;
    }
    if (ctx.depth > 0 && ctx.role !== 'fixer') {
      return undefined;
    }
    const kind = ctx.depth > 0 ? 'worker' : /^(ask|plan)$/.test(ctx.mode) ? 'detect' : 'full';
    const engine = new HealingEngine(this, this.opts, ctx, kind);
    if (kind === 'full') {
      this.live.set(engine.rootSid, engine);
    }
    return engine;
  }

  unregister(engine: HealingEngine): void {
    if (this.live.get(engine.rootSid) === engine) {
      this.live.delete(engine.rootSid);
    }
  }

  private async withState<T>(sid: string, fn: (s: RecoveryState, save: () => Promise<boolean>) => Promise<T>): Promise<T | undefined> {
    const store = this.opts.store;
    const state = await store.load(sid);
    if (!state) {
      return undefined;
    }
    const wasOwned = store.isOwned(sid);
    if ((await store.acquire(sid)) === 'readonly') {
      this.opts.log.warn(`Self-healing: recovery of ${rootSessionId(sid)} is running in another window`);
      await store.release(sid);
      return undefined;
    }
    try {
      return await fn(state, async () => {
        const ok = await store.save(state);
        this.noteState(state);
        return ok;
      });
    } finally {
      if (!wasOwned) {
        await store.release(sid);
      }
    }
  }

  /** "Rollback fixes": live engine, or the persisted attempt snapshots of a finished/interrupted task in `root`. */
  async rollback(sid: string, attempt?: number, root?: string): Promise<RollbackResult> {
    const live = this.live.get(rootSessionId(sid));
    if (live) {
      return live.rollbackFixes(attempt);
    }
    const out = await this.withState(sid, async (state, save) => {
      if (!root) {
        this.opts.log.warn(`Self-healing: cannot roll back ${rootSessionId(sid)} without its workspace folder`);
        return { restored: [], skipped: [] } as RollbackResult;
      }
      const pm = PatchManager.restore(
        { changedFiles: state.changedFiles, agentWrites: state.agentWrites },
        { root, sessionId: rootSessionId(sid), persistDir: (n, s) => this.opts.store.attemptDir(s ?? sid, n), restoreFile: this.opts.restoreFile, settle: () => this.opts.settle?.(sid), now: () => this.now() },
      );
      for (const a of state.attempts) {
        await pm.restoreFromDisk(rootSessionId(sid), a.n);
      }
      state.pendingAction = { kind: 'rollback', status: 'started', at: this.now() };
      await save();
      const res = await pm.rollback(attempt);
      for (const a of state.attempts.filter((x) => attempt === undefined || x.n >= attempt)) {
        const restored = new Set(res.restored);
        a.patches = a.patches.map((p) => (restored.has(p.file) ? { ...p, result: 'rolled_back' } : p));
        if (a.patches.some((p) => p.result === 'rolled_back') && (a.result === 'fixed' || !a.result)) {
          a.result = 'rolled_back';
        }
      }
      state.agentWrites = pm.serialise().agentWrites;
      state.pendingAction = { kind: 'rollback', status: 'done', at: this.now() };
      await save();
      this.opts.telemetry?.record({ type: 'recovery', sid: rootSessionId(sid), action: 'rolled_back', category: state.attempts[0]?.category ?? 'unknown' });
      return res;
    });
    return out ?? { restored: [], skipped: [] };
  }

  /** Closes an intervention / interrupted state without resuming. */
  async dismiss(sid: string): Promise<boolean> {
    const live = this.live.get(rootSessionId(sid));
    if (live) {
      return live.dismissIntervention();
    }
    const done = await this.withState(sid, async (state, save) => {
      if (state.intervention && !state.intervention.resolvedAt) {
        state.intervention.resolvedAt = this.now();
        await this.opts.store.resolveIntervention(state.intervention.id, state.intervention.resolvedAt);
      }
      if (!isTerminalPhase(state.phase)) {
        state.outcome = state.outcome ?? 'cancelled';
        state.phase = state.outcome;
      }
      await save();
      return true;
    });
    this.index.delete(rootSessionId(sid));
    return !!done;
  }

  /** Records `{ by: 'user', at, signatures }`, resolves the security intervention, telemetry `accept_risk` and audit. */
  async acceptRisk(sid: string, by: 'user'): Promise<AcceptedRisk | undefined> {
    if (by !== 'user') {
      return undefined;
    }
    const live = this.live.get(rootSessionId(sid));
    if (live) {
      return live.acceptRisk(by);
    }
    const res = await this.withState(sid, async (state, save) => {
      const sigs = [...new Set([
        ...state.active.filter((f) => f.category === 'security').map((f) => f.signature),
        ...(state.contract?.unresolved ?? []).filter((u) => u.category === 'security').map((u) => u.signature),
      ])];
      return sigs.length ? this.recordRisk(state, by, sigs, save) : undefined;
    });
    return res ?? undefined;
  }

  /** Shared by live and persisted accept-risk paths. */
  async recordRisk(state: RecoveryState, by: 'user', signatures: string[], save: () => Promise<boolean>): Promise<AcceptedRisk> {
    const risk: AcceptedRisk = { by, at: this.now(), signatures };
    state.acceptedRisks.push(risk);
    if (state.intervention && state.intervention.reason === 'security' && !state.intervention.resolvedAt) {
      state.intervention.resolvedAt = risk.at;
    }
    await save();
    if (state.intervention?.reason === 'security') {
      await this.opts.store.resolveIntervention(state.intervention.id, risk.at).catch(() => false);
    }
    for (const signature of signatures) {
      this.opts.telemetry?.record({ type: 'recovery', sid: rootSessionId(state.sessionId), action: 'accept_risk', category: 'security', signature });
    }
    try {
      this.opts.audit?.({ event: 'recovery_accept_risk', sessionId: rootSessionId(state.sessionId), by, at: risk.at, signatures });
    } catch (e) {
      this.opts.log.warn(`Self-healing: audit failed: ${errText(e)}`);
    }
    return risk;
  }

  /** Dashboard data: store states + telemetry summary over `days`. */
  async dashboard(days: number, summary?: TelemetrySummary | TelemetrySummary['recovery'], root?: string): Promise<RecoveryDashboard> {
    const cfg = this.opts.config();
    return recoveryDashboard({
      store: this.opts.store, summary, memory: root ? this.opts.memory(root) : undefined, config: cfg, policies: effectivePolicies(cfg),
      running: [...this.live.keys()], days, now: this.now(),
    });
  }
}
