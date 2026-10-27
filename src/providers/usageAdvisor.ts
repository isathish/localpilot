// Learns from local telemetry which installed models actually work best on this machine, per routing role: how
// often their runs finished, how fast they generate, how often they errored, and (for completions) how often their
// suggestions were accepted. Pure: no vscode, no network — the extension and tests feed it events and models.
import { ModelInfo } from '../types';
import { TelemetryEvent } from '../telemetry/telemetry';
import { ModelRole } from './catalog';
import { pickForRole, scoreForRole, UsageBonus } from './registry';
import { SystemProfile } from './system';

/** Roles that map to a setting the advisor can tune. `coding` routes like `agent` but has its own setting. */
export type TuneRole = 'agent' | 'reasoning' | 'fast' | 'coding' | 'completion' | 'vision';
export const TUNE_ROLES: TuneRole[] = ['agent', 'reasoning', 'coding', 'fast', 'completion', 'vision'];

/** `localpilot.*` setting each role writes. */
export const TUNE_SETTINGS: Record<TuneRole, string> = {
  agent: 'defaultModel',
  reasoning: 'routing.reasoning',
  coding: 'routing.coding',
  fast: 'routing.fast',
  completion: 'inlineCompletion.model',
  vision: 'routing.vision',
};

export const TUNE_LABELS: Record<TuneRole, string> = {
  agent: 'Chat & agent',
  reasoning: 'Plan mode',
  coding: 'Coding subagents',
  fast: 'Read-only subagents',
  completion: 'Inline completions',
  vision: 'Images',
};

const routerRole = (r: TuneRole): ModelRole => (r === 'coding' ? 'agent' : r);

/** Read-only builtin personas: their runs are evidence for the `fast` role. */
const FAST_AGENTS = /^(explore|clarifier|researcher)$/i;

/** The role a recorded run was routed for; older events without `role` are inferred from mode, depth and persona. */
export function runRole(e: Extract<TelemetryEvent, { type: 'run' }>): TuneRole {
  if (e.role && (TUNE_ROLES as string[]).includes(e.role)) {
    return e.role as TuneRole;
  }
  if (e.depth > 0) {
    return e.agent && FAST_AGENTS.test(e.agent) ? 'fast' : 'coding';
  }
  return e.mode === 'plan' ? 'reasoning' : 'agent';
}

export interface RoleEvidence {
  /** Recency-weighted counts (a run from a week ago counts half). */
  done: number;
  failed: number;
  stopped: number;
  /** Unweighted number of runs, for confidence. */
  runs: number;
}

export interface ModelUsage {
  /** `provider/model`. */
  id: string;
  calls: number;
  errors: number;
  completionTokens: number;
  /** Generation time (after the first token) behind `completionTokens`, ms. */
  genMs: number;
  ttft: number[];
  roles: Partial<Record<TuneRole, RoleEvidence>>;
  completions: { shown: number; accepted: number; latency: number[] };
  last: number;
}

export interface UsageProfile {
  models: Map<string, ModelUsage>;
  /** Median generation speed across measured models (tok/s), the yardstick for "fast" and "slow". */
  medianTokPerSec: number;
  runs: number;
  calls: number;
}

export interface AnalyzeOptions {
  now?: number;
  /** A run this many days old weighs half as much as one from today. */
  halfLifeDays?: number;
}

const median = (xs: number[]): number => {
  if (!xs.length) {
    return 0;
  }
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

export function tokPerSec(u: ModelUsage): number {
  return u.genMs > 0 ? (u.completionTokens / u.genMs) * 1000 : 0;
}

/** Aggregates telemetry events into per-model evidence. Model ids are `provider/model` throughout. */
export function analyzeUsage(events: TelemetryEvent[], opts: AnalyzeOptions = {}): UsageProfile {
  const now = opts.now ?? Date.now();
  const halfLife = (opts.halfLifeDays ?? 7) * 86400_000;
  const weight = (t: number) => Math.pow(0.5, Math.max(0, now - t) / halfLife);
  const models = new Map<string, ModelUsage>();
  const get = (id: string) => {
    let u = models.get(id);
    if (!u) {
      u = { id, calls: 0, errors: 0, completionTokens: 0, genMs: 0, ttft: [], roles: {}, completions: { shown: 0, accepted: 0, latency: [] }, last: 0 };
      models.set(id, u);
    }
    return u;
  };
  let runs = 0;
  let calls = 0;
  for (const e of events) {
    switch (e.type) {
      case 'model': {
        if (e.outcome === 'aborted' || e.outcome === 'retry') {
          // Aborted = the user stopped it; a retry is followed by its own event. Neither says much about the model.
          if (e.outcome === 'retry') {
            get(`${e.provider}/${e.model}`).errors += 0.5;
          }
          break;
        }
        const u = get(`${e.provider}/${e.model}`);
        u.calls++;
        calls++;
        u.last = Math.max(u.last, e.t);
        if (e.outcome === 'error') {
          u.errors++;
          break;
        }
        if (e.ttftMs !== undefined) {
          u.ttft.push(e.ttftMs);
        }
        if (e.completionTokens) {
          u.completionTokens += e.completionTokens;
          u.genMs += Math.max(1, e.ttftMs !== undefined ? e.durationMs - e.ttftMs : e.durationMs);
        }
        break;
      }
      case 'run': {
        if (!e.model) {
          break;
        }
        const u = get(e.model);
        const role = runRole(e);
        const r = (u.roles[role] ??= { done: 0, failed: 0, stopped: 0, runs: 0 });
        r[e.outcome] += weight(e.t);
        r.runs++;
        runs++;
        u.last = Math.max(u.last, e.t);
        break;
      }
      case 'completion': {
        if (!e.model) {
          break;
        }
        const u = get(e.model);
        if (e.action === 'shown' || e.action === 'cached') {
          u.completions.shown++;
          if (e.action === 'shown' && e.durationMs !== undefined) {
            u.completions.latency.push(e.durationMs);
          }
        } else if (e.action === 'accepted') {
          u.completions.accepted++;
        } else if (e.action === 'error') {
          u.errors++;
          u.calls++;
        }
        break;
      }
    }
  }
  const speeds = [...models.values()].filter((u) => u.completionTokens >= 50).map(tokPerSec).filter((x) => x > 0);
  return { models, medianTokPerSec: median(speeds), runs, calls };
}

// ------------------------------------------------------------------ scoring

/** Prior success rate a model starts from; a few runs move it, one failure does not sink it. */
const PRIOR_RATE = 0.8;
const PRIOR_WEIGHT = 4;

/** Runs that count as evidence for a role: its own, else the model's runs in related roles at half weight. */
function roleEvidence(u: ModelUsage, role: TuneRole): RoleEvidence | undefined {
  const own = u.roles[role];
  if (own && own.runs >= 2) {
    return own;
  }
  const related: TuneRole[] = role === 'completion' ? [] : role === 'vision' ? ['agent'] : (['agent', 'coding', 'reasoning', 'fast'] as TuneRole[]).filter((r) => r !== role);
  const acc: RoleEvidence = { done: own?.done ?? 0, failed: own?.failed ?? 0, stopped: own?.stopped ?? 0, runs: own?.runs ?? 0 };
  for (const r of related) {
    const e = u.roles[r];
    if (e) {
      acc.done += e.done / 2;
      acc.failed += e.failed / 2;
      acc.stopped += e.stopped / 2;
      acc.runs += e.runs / 2;
    }
  }
  return acc.runs > 0 ? acc : undefined;
}

/** Smoothed share of runs that finished; a stopped run counts as a quarter failure (the user gave up on it, or changed their mind). */
export function successRate(e: RoleEvidence | undefined): number {
  if (!e) {
    return PRIOR_RATE;
  }
  return (e.done + PRIOR_RATE * PRIOR_WEIGHT) / (e.done + e.failed + e.stopped * 0.25 + PRIOR_WEIGHT);
}

/** How many observations back a role judgement (runs, or completions shown). */
export function evidenceCount(u: ModelUsage | undefined, role: TuneRole): number {
  if (!u) {
    return 0;
  }
  return role === 'completion' ? u.completions.shown : Math.round(roleEvidence(u, role)?.runs ?? 0);
}

const SPEED_WEIGHT: Record<TuneRole, number> = { agent: 1, coding: 1, fast: 2, reasoning: 0.4, vision: 0.5, completion: 0 };

/**
 * Score points a model earns or loses for a role from measured usage. Roughly −15…+8; the router clamps it so a
 * learned preference never overrides a hard capability (tools, vision, fill-in-the-middle).
 */
export function usageBonus(u: ModelUsage | undefined, role: TuneRole, profile: Pick<UsageProfile, 'medianTokPerSec'>): number {
  if (!u) {
    return 0;
  }
  let b = 0;
  if (role === 'completion') {
    const c = u.completions;
    if (c.shown >= 5) {
      const accept = (c.accepted + 0.25 * 8) / (c.shown + 8);
      b += (accept - 0.25) * 24;
    }
    const p50 = median(c.latency);
    if (c.latency.length >= 5) {
      b += p50 > 2500 ? -5 : p50 > 1500 ? -3 : p50 < 400 ? 2 : 0;
    }
  } else {
    const ev = roleEvidence(u, role);
    if (ev) {
      b += (successRate(ev) - PRIOR_RATE) * 30;
    }
    const tps = tokPerSec(u);
    if (tps > 0 && profile.medianTokPerSec > 0 && u.completionTokens >= 50) {
      b += Math.max(-4, Math.min(4, Math.log2(tps / profile.medianTokPerSec) * 2.5)) * SPEED_WEIGHT[role];
    }
    const ttft = median(u.ttft);
    if (u.ttft.length >= 3 && role !== 'reasoning') {
      b -= ttft > 180_000 ? 4 : ttft > 60_000 ? 2 : 0;
    }
  }
  if (u.calls >= 3) {
    b -= (u.errors / u.calls) * 12;
  }
  return b;
}

/** A router hook that applies learned bonuses (the router clamps them). */
export function bonusFromUsage(usage: UsageProfile): UsageBonus {
  return (m, role) => usageBonus(usage.models.get(m.id), role as TuneRole, usage);
}

/** Bonus for one tune role regardless of the router role it maps to (coding is routed as agent but judged on its own runs). */
function roleBonus(usage: UsageProfile, role: TuneRole): UsageBonus {
  return (m) => usageBonus(usage.models.get(m.id), role, usage);
}

// ------------------------------------------------------------------ suggestions

export interface TuneSuggestion {
  role: TuneRole;
  /** `localpilot.*` key the suggestion writes. */
  setting: string;
  /** Model the role uses today (explicit setting, or what routing picks without usage data). */
  current?: string;
  /** True when `current` comes from the setting rather than from automatic routing. */
  currentIsSetting: boolean;
  suggested: string;
  /** Score gap between the suggestion and the current model (with usage). */
  margin: number;
  /** Observations behind the suggestion: the suggested model's evidence, or the current one's when it is failing. */
  evidence: number;
  confidence: 'low' | 'medium' | 'high';
  /** One line for the UI: why this model. */
  reason: string;
  /**
   * `setting`: worth writing to the setting. `routing`: the setting is empty and Auto routing already follows the
   * usage data, so nothing needs writing — shown for transparency.
   */
  kind: 'setting' | 'routing';
  /** The current model has measured problems for this role (low success or many errors). */
  currentStruggling: boolean;
}

/** Below this score gap the current model stays: switching back and forth on noise is worse than either choice. */
export const MIN_MARGIN = 3;

export interface CurrentSettings {
  defaultModel?: string;
  routing: { reasoning?: string; coding?: string; fast?: string; vision?: string };
  completionModel?: string;
}

function currentSetting(role: TuneRole, s: CurrentSettings): string | undefined {
  switch (role) {
    case 'agent':
      return s.defaultModel || undefined;
    case 'reasoning':
      return s.routing.reasoning || undefined;
    case 'coding':
      return s.routing.coding || undefined;
    case 'fast':
      return s.routing.fast || undefined;
    case 'completion':
      return s.completionModel || undefined;
    case 'vision':
      return s.routing.vision || undefined;
  }
}

const pctOf = (x: number) => `${Math.round(x * 100)}%`;
const fmtTps = (x: number) => (x >= 10 ? Math.round(x) : Math.round(x * 10) / 10);

/** Human-readable evidence for one model in one role. */
export function describeEvidence(u: ModelUsage | undefined, role: TuneRole, usage: UsageProfile): string {
  if (!u) {
    return 'not used yet';
  }
  const parts: string[] = [];
  if (role === 'completion') {
    const c = u.completions;
    if (c.shown) {
      parts.push(`${pctOf(c.accepted / c.shown)} of ${c.shown} suggestions accepted`);
    }
    if (c.latency.length) {
      parts.push(`${Math.round(median(c.latency))} ms median`);
    }
  } else {
    const ev = roleEvidence(u, role);
    if (ev && ev.runs) {
      const finished = ev.done / Math.max(1e-9, ev.done + ev.failed + ev.stopped);
      parts.push(`${pctOf(finished)} of ${Math.round(ev.runs)} run${Math.round(ev.runs) === 1 ? '' : 's'} finished`);
    }
    const tps = tokPerSec(u);
    if (tps > 0) {
      const rel = usage.medianTokPerSec > 0 ? tps / usage.medianTokPerSec : 1;
      parts.push(`${fmtTps(tps)} tok/s${rel >= 1.3 ? ` (${rel.toFixed(1)}× median)` : rel <= 0.7 ? ' (slower than median)' : ''}`);
    }
  }
  if (u.calls >= 3 && u.errors / u.calls >= 0.15) {
    parts.push(`${pctOf(u.errors / u.calls)} of requests errored`);
  }
  return parts.join(' · ') || 'little data yet';
}

const shortName = (id?: string) => (id ? id.slice(id.indexOf('/') + 1) : 'none');

/**
 * Ranks the installed (enabled) models for every role from capability, fit and measured usage, and proposes a change
 * where another installed model is measurably better than what the role uses now.
 */
export function suggestModels(models: ModelInfo[], usage: UsageProfile, settings: CurrentSettings, profile?: SystemProfile): TuneSuggestion[] {
  const out: TuneSuggestion[] = [];
  const implicitAgent = pickForRole(models, 'agent', profile);
  const find = (id?: string) => (id ? models.find((m) => m.id === id || m.modelId === id) : undefined);
  const agentCurrent = find(settings.defaultModel) ?? implicitAgent;

  for (const role of TUNE_ROLES) {
    const rr = routerRole(role);
    const bonus = roleBonus(usage, role);
    const setting = currentSetting(role, settings);
    if (role === 'fast' && setting === 'session') {
      continue; // the user pinned read-only subagents to the session model
    }
    const pool = models.filter((m) => (role === 'vision' ? m.supportsVision : role === 'completion' ? true : m.supportsTools));
    if (!pool.length) {
      continue;
    }
    const explicit = find(setting);
    // Plan mode and coding subagents follow the session model when their setting is empty.
    const current = explicit ?? (role === 'reasoning' || role === 'coding' ? agentCurrent : pickForRole(pool, rr, profile));
    const best = pickForRole(pool, rr, profile, role === 'vision', bonus);
    if (!best || !current || best.id === current.id) {
      continue;
    }
    const bestScore = scoreForRole(best, rr, profile, bonus);
    const curScore = scoreForRole(current, rr, profile, bonus);
    const margin = bestScore - curScore;
    if (margin < MIN_MARGIN) {
      continue;
    }
    const bestUsage = usage.models.get(best.id);
    const curUsage = usage.models.get(current.id);
    const bestEvidence = evidenceCount(bestUsage, role);
    const curEvidence = evidenceCount(curUsage, role);
    const curBonus = usageBonus(curUsage, role, usage);
    const currentStruggling = curEvidence >= 3 && curBonus <= -4;
    // Switch towards a model with a record, or away from one that is measurably failing — never on the static score
    // alone: that is what Auto routing already does without anyone writing settings.
    if (bestEvidence < 3 && !currentStruggling) {
      continue;
    }
    const evidence = Math.max(bestEvidence, currentStruggling ? curEvidence : 0);
    const confidence: TuneSuggestion['confidence'] = evidence >= 10 && margin >= 5 ? 'high' : evidence >= 4 ? 'medium' : 'low';
    const kind: TuneSuggestion['kind'] = explicit || role === 'reasoning' || role === 'coding' ? 'setting' : 'routing';
    out.push({
      role,
      setting: TUNE_SETTINGS[role],
      current: current.id,
      currentIsSetting: !!explicit,
      suggested: best.id,
      margin: Math.round(margin * 10) / 10,
      evidence,
      confidence,
      kind,
      currentStruggling,
      reason: `${shortName(best.id)}: ${describeEvidence(bestUsage, role, usage)} — ${shortName(current.id)}: ${describeEvidence(curUsage, role, usage)}`,
    });
  }
  return out;
}

/** Per-role ranking of every installed model, best first, for the dashboard. */
export function rankModels(models: ModelInfo[], usage: UsageProfile, role: TuneRole, profile?: SystemProfile, limit = 5): { id: string; score: number; bonus: number; evidence: number; detail: string }[] {
  const rr = routerRole(role);
  const pool = models.filter((m) => (role === 'vision' ? m.supportsVision : role === 'completion' ? true : m.supportsTools));
  const bonus = roleBonus(usage, role);
  return pool
    .map((m) => ({
      id: m.id,
      score: Math.round(scoreForRole(m, rr, profile, bonus) * 10) / 10,
      bonus: Math.round(Math.max(-12, Math.min(12, usageBonus(usage.models.get(m.id), role, usage))) * 10) / 10,
      evidence: evidenceCount(usage.models.get(m.id), role),
      detail: describeEvidence(usage.models.get(m.id), role, usage),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}
