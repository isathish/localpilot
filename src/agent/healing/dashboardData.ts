import { recoveryRate } from '../../telemetry/telemetry';
import type { RecoverySummary as TelemetryRecoverySummary } from '../../telemetry/telemetry';
import type { FailureMemory } from './failureMemory';
import { DEFAULT_POLICIES } from './policy';
import { rootSessionId } from './recoveryStore';
import type { RecoveryStore } from './recoveryStore';
import { humanKey } from './signature';
import type {
  AcceptedRisk,
  ApprovalRecord,
  AttemptResult,
  EscalationReason,
  FailureCategory,
  FixMode,
  HealingSettings,
  NextAction,
  RecoveryPhase,
  RecoveryState,
  RecoveryStrategy,
  RetryPolicy,
  Severity,
  TaskOutcome,
} from './types';
import { FAILURE_CATEGORIES, isTerminalPhase } from './types';

/**
 * Data side of the Self-healing & recovery dashboard (design §9.3): the telemetry summary's `recovery` block joined
 * with the RecoveryStore states of the range. Telemetry only carries signature hashes; the human keys
 * (`TS2345@src/api/user.ts`) are resolved here from the states (and failure memory) and fall back to the short hash.
 * Every list is bounded and the result is plain JSON.
 */

const DAY_MS = 86_400_000;
const MAX_HISTORY = 200;
const MAX_RCA = 100;
const MAX_TASKS = 50;
const MAX_TASK_ATTEMPTS = 20;
const MAX_TASK_APPROVALS = 20;
const MAX_PATCHES = 200;
const MAX_PREVIEW = 4000;
const MAX_REGRESSION = 50;
const MAX_REGRESSION_KEYS = 20;
const MAX_INTERVENTIONS = 50;
const MAX_TOP_SIGNATURES = 10;
const MAX_TEXT = 500;
const MAX_EVIDENCE = 2000;

export interface RunningSession {
  sessionId: string;
  title?: string;
}

export interface RecoveryDashboardInput {
  store: RecoveryStore;
  /** Telemetry summary `recovery` block (or the whole summary); undefined when telemetry is off. */
  summary?: TelemetryRecoverySummary | { recovery?: TelemetryRecoverySummary };
  memory?: FailureMemory;
  config: Pick<HealingSettings, 'enabled' | 'autoDetect' | 'autoRetry' | 'autoFix' | 'regressionRequired' | 'maxRepairAttempts'> & Partial<Pick<HealingSettings, 'policies'>>;
  /** Effective policies (`effectivePolicies(cfg.healing)`). */
  policies: Record<FailureCategory, RetryPolicy>;
  /** Sessions with a live run, by id. */
  running: readonly (string | RunningSession)[];
  days: number;
  now?: number;
}

export interface Pctl {
  p50: number;
  p90: number;
}

export interface DashboardCurrent {
  sessionId: string;
  title?: string;
  phase: RecoveryPhase;
  attempt: number;
  max: number;
  category?: FailureCategory;
  signature?: string;
  key?: string;
  updatedAt: number;
}

export interface DashboardHistoryRow {
  t: number;
  sessionId: string;
  category: string;
  severity?: Severity;
  signature?: string;
  key: string;
  outcome: string;
  source: 'store' | 'telemetry';
}

export interface DashboardRcaRow {
  sessionId: string;
  attempt: number;
  category: FailureCategory;
  signature: string;
  key: string;
  failure: string;
  rootCause?: string;
  strategy: RecoveryStrategy;
  mode: FixMode;
  result?: AttemptResult;
  memoryUsed?: string;
  t: number;
}

export interface DashboardTask {
  sessionId: string;
  taskId?: string;
  turnKey: number;
  phase: RecoveryPhase;
  outcome?: TaskOutcome;
  startedAt: number;
  recoveryStartedAt?: number;
  updatedAt: number;
  attempts: {
    n: number;
    category: FailureCategory;
    key: string;
    strategy: RecoveryStrategy;
    mode: FixMode;
    startedAt: number;
    endedAt?: number;
    durationMs?: number;
    result?: AttemptResult;
    adjust: string[];
    patches: number;
  }[];
  /** Attempts used per category (retries included). */
  perCategory: { category: FailureCategory; count: number }[];
  approvals: ApprovalRecord[];
  acceptedRisks: (AcceptedRisk & { keys: string[] })[];
}

export interface DashboardPatch {
  sessionId: string;
  attempt: number;
  file: string;
  added: number;
  removed: number;
  result?: 'kept' | 'rolled_back';
  diffHash: string;
  preview: string;
  t: number;
}

export interface DashboardRetryConfig {
  category: FailureCategory;
  cls: RetryPolicy['cls'];
  strategy: RecoveryStrategy;
  attempts: number;
  defaultAttempts: number;
  backoffMs: number[];
  exponential: boolean;
  timeoutSeconds?: number;
  overridden: boolean;
}

export interface DashboardRegression {
  sessionId: string;
  attempt: number;
  t: number;
  before: number;
  after: number;
  fixed: string[];
  introduced: string[];
  preexisting: string[];
  foreign: string[];
  durationMs: number;
}

export interface DashboardIntervention {
  id: string;
  sessionId: string;
  taskId?: string;
  reason: EscalationReason;
  category?: FailureCategory;
  title: string;
  rootCause?: string;
  evidence?: string;
  attemptsSummary: string;
  patches: number;
  nextActions: NextAction[];
  createdAt: number;
}

export interface RecoveryDashboard {
  days: number;
  generatedAt: number;
  tiles: { enabled: boolean; detected: number; recovered: number; pendingIntervention: number; rate: number; mttrP50: number };
  config: { autoDetect: boolean; autoRetry: boolean; autoFix: boolean; regressionRequired: boolean; securityBypass: false; maxRepairAttempts: number };
  current: DashboardCurrent[];
  failureHistory: DashboardHistoryRow[];
  /** Categories present in `failureHistory`, for the filter. */
  categories: string[];
  rca: DashboardRcaRow[];
  attempts: DashboardTask[];
  patches: DashboardPatch[];
  retryConfig: DashboardRetryConfig[];
  regression: DashboardRegression[];
  interventions: DashboardIntervention[];
  analytics: {
    rateByCategory: { category: string; detected: number; recovered: number; rate: number }[];
    /** Recovery episodes by the number of attempts they took. */
    attemptsDistribution: { attempts: number; tasks: number }[];
    mttr: Pctl;
    topSignatures: { signature: string; key: string; count: number; recovered: number }[];
    memory: { suggested: number; succeeded: number; hitRate: number };
    acceptedRisks: number;
    /** Where the counters came from: telemetry when available, else the store states. */
    source: 'telemetry' | 'store';
  };
}

const clip = (s: string | undefined, max = MAX_TEXT): string | undefined => (s === undefined ? undefined : s.length > max ? `${s.slice(0, max - 1)}…` : s);
const shortHash = (h: string) => h.slice(0, 8);
const finite = (n: number | undefined) => (typeof n === 'number' && Number.isFinite(n) ? n : 0);

function pctl(values: number[]): Pctl {
  if (!values.length) {
    return { p50: 0, p90: 0 };
  }
  const v = [...values].sort((a, b) => a - b);
  const at = (q: number) => v[Math.min(v.length - 1, Math.max(0, Math.ceil(q * v.length) - 1))];
  return { p50: Math.round(at(0.5)), p90: Math.round(at(0.9)) };
}

function recoverySummary(s: RecoveryDashboardInput['summary']): TelemetryRecoverySummary | undefined {
  if (!s) {
    return undefined;
  }
  return 'recovery' in s ? s.recovery : (s as TelemetryRecoverySummary);
}

/** Hash -> human key from the states' failures, contracts and the failure memory. */
class KeyResolver {
  private readonly keys = new Map<string, string>();
  private readonly severities = new Map<string, Severity>();
  private readonly messages = new Map<string, string>();

  addState(s: RecoveryState): void {
    for (const f of s.active ?? []) {
      this.keys.set(f.signature, humanKey(f));
      this.severities.set(f.signature, f.severity);
      this.messages.set(f.signature, f.message);
    }
    for (const u of s.contract?.unresolved ?? []) {
      this.severities.set(u.signature, this.severities.get(u.signature) ?? u.severity);
    }
  }

  addMemory(entries: { signature: string; category: FailureCategory; code?: string; files: string[] }[]): void {
    for (const e of entries) {
      if (!this.keys.has(e.signature)) {
        this.keys.set(e.signature, humanKey({ category: e.category, code: e.code, file: e.files[0] }));
      }
    }
  }

  key(hash: string | undefined): string {
    return hash ? (this.keys.get(hash) ?? shortHash(hash)) : '';
  }

  severity(hash: string): Severity | undefined {
    return this.severities.get(hash);
  }

  message(hash: string): string | undefined {
    return this.messages.get(hash);
  }
}

function adjustLabel(a: NonNullable<RecoveryState['attempts'][number]['adjust']>[number]): string {
  switch (a.kind) {
    case 'halve_context':
      return `context ${a.contextWindow}`;
    case 'reroute':
      return `model ${a.model}`;
    default:
      return a.kind;
  }
}

/** Store-derived episode outcome of a state: undefined while it is still running or never failed. */
function episodeOutcome(s: RecoveryState): 'recovered' | 'escalated' | 'exhausted' | 'blocked' | undefined {
  if (s.recoveryStartedAt === undefined && !s.attempts.length) {
    return undefined;
  }
  switch (s.outcome ?? (isTerminalPhase(s.phase) ? s.phase : undefined)) {
    case 'completed':
      return s.attempts.some((a) => a.result === 'fixed') || !s.active.length ? 'recovered' : 'escalated';
    case 'completed_unverified':
      // Done but not proven: never counts as recovered (design §6).
      return 'escalated';
    case 'blocked':
      return 'blocked';
    case 'incomplete':
    case 'failed':
      return s.intervention?.reason === 'exhausted' ? 'exhausted' : 'escalated';
    default:
      return undefined;
  }
}

function recoveredAfterMs(s: RecoveryState): number | undefined {
  const fixed = [...s.attempts].reverse().find((a) => a.result === 'fixed' && a.endedAt !== undefined);
  const start = s.recoveryStartedAt ?? s.attempts[0]?.startedAt;
  return fixed?.endedAt !== undefined && start !== undefined ? Math.max(0, fixed.endedAt - start) : undefined;
}

export async function recoveryDashboard(input: RecoveryDashboardInput): Promise<RecoveryDashboard> {
  const now = input.now ?? Date.now();
  const days = Math.max(1, Math.floor(finite(input.days) || 1));
  const since = now - days * DAY_MS;
  const tele = recoverySummary(input.summary);
  const { store, config, policies } = input;

  const states = await store.listStates({ since });
  const open = await store.listInterventions();
  const keys = new KeyResolver();
  for (const s of states) {
    keys.addState(s);
  }
  if (input.memory?.enabled) {
    try {
      keys.addMemory(await input.memory.list());
    } catch {
      // An unreadable memory file only costs the key resolution.
    }
  }

  // ---- Current recovery (per running session) ----
  const current: DashboardCurrent[] = [];
  const seenRunning = new Set<string>();
  for (const r of input.running) {
    const run = typeof r === 'string' ? { sessionId: r } : r;
    const root = rootSessionId(run.sessionId);
    if (seenRunning.has(root)) {
      continue;
    }
    seenRunning.add(root);
    const s = states.find((x) => rootSessionId(x.sessionId) === root) ?? (await store.load(root));
    if (!s || s.phase === 'idle' || isTerminalPhase(s.phase)) {
      continue;
    }
    const last = s.attempts[s.attempts.length - 1];
    const top = s.active[0];
    const category = last?.category ?? top?.category;
    const signature = last?.signature ?? top?.signature;
    keys.addState(s);
    current.push({
      sessionId: s.sessionId,
      title: run.title,
      phase: s.phase,
      attempt: s.activeScope?.attempt ?? last?.n ?? 0,
      max: category ? policies[category]?.attempts ?? config.maxRepairAttempts : config.maxRepairAttempts,
      category,
      signature,
      key: signature ? keys.key(signature) : undefined,
      updatedAt: s.updatedAt,
    });
  }

  // ---- Failure history ----
  const history: DashboardHistoryRow[] = [];
  const covered = new Set<string>();
  for (const s of states) {
    const outcome = s.outcome ?? s.phase;
    const ended = s.outcome ?? (isTerminalPhase(s.phase) || s.phase === 'interrupted' ? s.phase : undefined);
    const bySig = new Map<string, DashboardHistoryRow>();
    for (const a of s.attempts) {
      const row = bySig.get(a.signature);
      const result = a.result ?? (a.endedAt === undefined ? (ended ?? 'in progress') : 'not_fixed');
      if (row) {
        row.outcome = result;
        continue;
      }
      bySig.set(a.signature, {
        t: s.seen[a.signature]?.firstAt ?? a.startedAt,
        sessionId: s.sessionId,
        category: a.category,
        severity: keys.severity(a.signature),
        signature: a.signature,
        key: keys.key(a.signature),
        outcome: result,
        source: 'store',
      });
    }
    for (const f of s.active) {
      if (!bySig.has(f.signature)) {
        bySig.set(f.signature, {
          t: s.seen[f.signature]?.firstAt ?? s.recoveryStartedAt ?? s.updatedAt,
          sessionId: s.sessionId,
          category: f.category,
          severity: f.severity,
          signature: f.signature,
          key: keys.key(f.signature),
          outcome: isTerminalPhase(outcome) ? outcome : 'unresolved',
          source: 'store',
        });
      }
    }
    for (const row of bySig.values()) {
      covered.add(`${rootSessionId(row.sessionId)}|${row.signature}`);
      history.push(row);
    }
  }
  const finalAction = new Map<string, string>();
  for (const e of [...(tele?.recent ?? [])].sort((a, b) => a.t - b.t)) {
    if (e.signature && e.action !== 'detected') {
      finalAction.set(`${rootSessionId(e.sid)}|${e.signature}`, e.action);
    }
  }
  for (const e of tele?.recent ?? []) {
    if (e.action !== 'detected' || e.t < since) {
      continue;
    }
    const id = `${rootSessionId(e.sid)}|${e.signature ?? `t${e.t}`}`;
    if (covered.has(id)) {
      continue;
    }
    covered.add(id);
    history.push({
      t: e.t,
      sessionId: e.sid,
      category: e.category,
      severity: e.signature ? keys.severity(e.signature) : undefined,
      signature: e.signature,
      key: e.signature ? keys.key(e.signature) : e.category,
      outcome: (e.signature && finalAction.get(id)) ?? 'detected',
      source: 'telemetry',
    });
  }
  history.sort((a, b) => b.t - a.t);
  const failureHistory = history.slice(0, MAX_HISTORY);

  // ---- RCA, attempts timeline, patches, regression ----
  const rca: DashboardRcaRow[] = [];
  const tasks: DashboardTask[] = [];
  const patches: DashboardPatch[] = [];
  const regression: DashboardRegression[] = [];
  const mttrSamples: number[] = [];
  const attemptCounts = new Map<number, number>();
  const episodes = { recovered: 0, escalated: 0, exhausted: 0, blocked: 0, detected: 0 };
  const byCat = new Map<string, { detected: number; recovered: number; escalated: number; exhausted: number; blocked: number }>();
  let memorySuggested = 0;
  let memorySucceeded = 0;
  let acceptedRisks = 0;
  for (const s of states) {
    for (const a of s.attempts) {
      rca.push({
        sessionId: s.sessionId,
        attempt: a.n,
        category: a.category,
        signature: a.signature,
        key: keys.key(a.signature),
        failure: clip(keys.message(a.signature)) ?? keys.key(a.signature),
        rootCause: clip(a.rootCause),
        strategy: a.strategy,
        mode: a.mode,
        result: a.result,
        memoryUsed: a.memoryUsed,
        t: a.startedAt,
      });
      if (a.memoryUsed) {
        memorySuggested++;
        if (a.result === 'fixed') {
          memorySucceeded++;
        }
      }
      for (const p of a.patches) {
        patches.push({ sessionId: s.sessionId, attempt: a.n, file: p.file, added: p.added, removed: p.removed, result: p.result, diffHash: p.diffHash, preview: clip(p.preview, MAX_PREVIEW) ?? '', t: a.endedAt ?? a.startedAt });
      }
      if (a.regression) {
        const r = a.regression;
        const list = (xs: string[]) => xs.slice(0, MAX_REGRESSION_KEYS).map((h) => keys.key(h));
        regression.push({
          sessionId: s.sessionId,
          attempt: a.n,
          t: a.endedAt ?? a.startedAt,
          before: r.before.length,
          after: r.after.length,
          fixed: list(r.fixed),
          introduced: list(r.introduced),
          preexisting: list(r.preexisting),
          foreign: list(r.foreign ?? []),
          durationMs: finite(r.durationMs),
        });
      }
    }
    if (s.attempts.length || s.recoveryStartedAt !== undefined || s.approvals.length || s.acceptedRisks.length) {
      tasks.push({
        sessionId: s.sessionId,
        taskId: s.taskId,
        turnKey: s.turnKey,
        phase: s.phase,
        outcome: s.outcome,
        startedAt: s.startedAt,
        recoveryStartedAt: s.recoveryStartedAt,
        updatedAt: s.updatedAt,
        attempts: s.attempts.slice(-MAX_TASK_ATTEMPTS).map((a) => ({
          n: a.n,
          category: a.category,
          key: keys.key(a.signature),
          strategy: a.strategy,
          mode: a.mode,
          startedAt: a.startedAt,
          endedAt: a.endedAt,
          durationMs: a.endedAt !== undefined ? Math.max(0, a.endedAt - a.startedAt) : undefined,
          result: a.result,
          adjust: (a.adjust ?? []).map(adjustLabel),
          patches: a.patches.length,
        })),
        perCategory: FAILURE_CATEGORIES.filter((c) => (s.perCategory[c] ?? 0) > 0).map((c) => ({ category: c, count: s.perCategory[c] ?? 0 })),
        approvals: s.approvals.slice(-MAX_TASK_APPROVALS).map((a) => ({ ...a, command: clip(a.command) })),
        acceptedRisks: s.acceptedRisks.map((r) => ({ ...r, signatures: [...r.signatures], keys: r.signatures.map((h) => keys.key(h)) })),
      });
    }
    acceptedRisks += s.acceptedRisks.length;
    const ep = episodeOutcome(s);
    if (s.recoveryStartedAt !== undefined || s.attempts.length) {
      episodes.detected++;
      const cat = s.attempts[0]?.category ?? s.active[0]?.category ?? 'unknown';
      const c = byCat.get(cat) ?? { detected: 0, recovered: 0, escalated: 0, exhausted: 0, blocked: 0 };
      c.detected++;
      if (ep) {
        c[ep]++;
      }
      byCat.set(cat, c);
    }
    if (ep) {
      episodes[ep]++;
      attemptCounts.set(s.attempts.length, (attemptCounts.get(s.attempts.length) ?? 0) + 1);
      const ms = ep === 'recovered' ? recoveredAfterMs(s) : undefined;
      if (ms !== undefined) {
        mttrSamples.push(ms);
      }
    }
  }
  rca.sort((a, b) => b.t - a.t);
  tasks.sort((a, b) => b.updatedAt - a.updatedAt);
  patches.sort((a, b) => b.t - a.t);
  regression.sort((a, b) => b.t - a.t);

  // ---- Retry configuration ----
  const retryConfig: DashboardRetryConfig[] = FAILURE_CATEGORIES.map((c) => {
    const p = policies[c] ?? DEFAULT_POLICIES[c];
    return {
      category: c,
      cls: p.cls,
      strategy: p.strategy,
      attempts: p.attempts,
      defaultAttempts: DEFAULT_POLICIES[c].attempts,
      backoffMs: [...p.backoffMs],
      exponential: !!p.exponential,
      timeoutSeconds: p.timeoutSeconds,
      overridden: !!config.policies?.[c],
    };
  });

  // ---- Interventions ----
  const interventions: DashboardIntervention[] = open.slice(0, MAX_INTERVENTIONS).map((i) => ({
    id: i.id,
    sessionId: i.sessionId,
    taskId: i.taskId,
    reason: i.reason,
    category: i.category,
    title: clip(i.title) ?? '',
    rootCause: clip(i.rootCause),
    evidence: clip(i.evidence, MAX_EVIDENCE),
    attemptsSummary: clip(i.attemptsSummary) ?? '',
    patches: i.patches.length,
    nextActions: i.nextActions.map((a) => ({ ...a })),
    createdAt: i.createdAt,
  }));

  // ---- Counters: telemetry when present, else the store episodes ----
  // Per-category rates and MTTR always come from the range's store episodes: telemetry has no per-category ended
  // outcomes, and one MTTR source keeps the tile and the analytics percentiles in agreement.
  const fromStore = !tele;
  const counts = tele ?? { ...episodes, rate: recoveryRate(episodes) };
  const mttr = pctl(mttrSamples);
  const rateByCategory = [...byCat.entries()]
    .map(([category, c]) => ({ category, detected: c.detected, recovered: c.recovered, rate: recoveryRate(c) }))
    .sort((a, b) => b.detected - a.detected || b.recovered - a.recovered);
  const topSignatures = tele
    ? tele.topSignatures.slice(0, MAX_TOP_SIGNATURES).map((t) => ({ signature: t.signature, key: keys.key(t.signature), count: t.count, recovered: t.recovered }))
    : topFromHistory(history, keys);
  const memory = tele ? { suggested: tele.memory.suggested, succeeded: tele.memory.succeeded } : { suggested: memorySuggested, succeeded: memorySucceeded };

  return {
    days,
    generatedAt: now,
    tiles: {
      enabled: !!config.enabled,
      detected: counts.detected,
      recovered: counts.recovered,
      pendingIntervention: open.length,
      rate: recoveryRate(counts),
      mttrP50: mttr.p50,
    },
    config: {
      autoDetect: !!config.autoDetect,
      autoRetry: !!config.autoRetry,
      autoFix: !!config.autoFix,
      regressionRequired: !!config.regressionRequired,
      securityBypass: false,
      maxRepairAttempts: config.maxRepairAttempts,
    },
    current,
    failureHistory,
    categories: [...new Set(failureHistory.map((r) => r.category))].sort(),
    rca: rca.slice(0, MAX_RCA),
    attempts: tasks.slice(0, MAX_TASKS),
    patches: patches.slice(0, MAX_PATCHES),
    retryConfig,
    regression: regression.slice(0, MAX_REGRESSION),
    interventions,
    analytics: {
      rateByCategory,
      attemptsDistribution: [...attemptCounts.entries()].sort((a, b) => a[0] - b[0]).map(([attempts, n]) => ({ attempts, tasks: n })),
      mttr,
      topSignatures,
      memory: { ...memory, hitRate: memory.suggested ? Math.round((memory.succeeded / memory.suggested) * 1000) / 10 : 0 },
      acceptedRisks: tele ? Math.max(tele.acceptedRisks, acceptedRisks) : acceptedRisks,
      source: fromStore ? 'store' : 'telemetry',
    },
  };
}

function topFromHistory(history: DashboardHistoryRow[], keys: KeyResolver): RecoveryDashboard['analytics']['topSignatures'] {
  const m = new Map<string, { signature: string; key: string; count: number; recovered: number }>();
  for (const r of history) {
    if (!r.signature) {
      continue;
    }
    const e = m.get(r.signature) ?? { signature: r.signature, key: keys.key(r.signature), count: 0, recovered: 0 };
    e.count++;
    if (r.outcome === 'fixed' || r.outcome === 'recovered') {
      e.recovered++;
    }
    m.set(r.signature, e);
  }
  return [...m.values()].sort((a, b) => b.count - a.count || b.recovered - a.recovered).slice(0, MAX_TOP_SIGNATURES);
}
