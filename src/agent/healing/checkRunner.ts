import { createHash, randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { globToRegExp } from '../permissions';
import { fastSpecs, isInCheckScope } from './checks';
import type { ClassifyInput } from './classifier';
import { UNKNOWN_CHANGES } from './patchManager';
import { semaphoreKey } from './scheduler';
import { affectedTests, fillScoped, type TestMapGraph } from './testMap';
import type { CheckCacheEntry, CheckEcosystem, CheckResult, CheckSpec, ExecResult, Failure } from './types';

/** Runs CheckSpecs through an injected executor: stage order, fail fast, time budgets, fingerprint cache (design §2.4-2.5). */

export type CheckStage = 'build' | 'lint' | 'scoped_test' | 'test' | 'security';

export const STAGE_ORDER: readonly CheckStage[] = ['build', 'lint', 'scoped_test', 'test', 'security'];

export const SKIP_WORKTREE_DEPS = 'dependencies not installed in worktree';
export const SKIP_BUDGET = 'check time budget exhausted';
export const SKIP_DEADLINE = 'recovery deadline reached';
export const SKIP_NO_SCANNER = 'security scan unavailable';

export type CheckExec = (spec: CheckSpec, signal: AbortSignal) => Promise<ExecResult>;
/** In-process security stage over the changed files (workspace-relative). */
export type SecurityScan = (root: string, files: string[], signal: AbortSignal) => Promise<Failure[]>;
export type Fingerprint = (root: string, files: string[]) => Promise<string>;

export interface CheckRunnerOptions {
  exec: CheckExec;
  securityScan?: SecurityScan;
  semaphore: { acquire(root: string, signal?: AbortSignal): Promise<() => void> };
  classify: (input: ClassifyInput) => Failure[];
  now?: () => number;
  fingerprint?: Fingerprint;
  /** The main workspace root when checks may run in a worktree of it. */
  mainRoot?: string;
  /** One-hop importers for scoped test mapping, per check folder (absolute). */
  graph?: (cwdRoot: string) => TestMapGraph | undefined;
}

export interface RunStagesOptions {
  specs: CheckSpec[];
  root: string;
  /** Absolute or relative to `root`; `*` = unknown changes (everything in scope, no cache). */
  changedFiles: string[];
  /** Run the scoped form of test checks first (affected tests only). */
  scoped: boolean;
  /** Also run the full test checks after the scoped ones (regression); default true. */
  fullTests?: boolean;
  budgetMs: number;
  deadlineAt?: number;
  signal: AbortSignal;
  /** `RecoveryState.checks`; read for reuse and updated in place. */
  cache: Record<string, CheckCacheEntry>;
  /** Skip the stages before this one. */
  stagesFrom?: CheckStage;
}

export interface StagesResult {
  results: CheckResult[];
  failures: Failure[];
  /** The stage whose required check failed (fail fast). */
  stoppedAt?: CheckStage;
  budgetExhausted: boolean;
  /** No changed file is in the scope of any check. */
  outOfScope?: boolean;
  /** Checks were skipped for missing worktree dependencies: rerun against the main root after the worktree is applied. */
  runAgainstMain?: boolean;
  fingerprint?: string;
}

export interface RunBaselineOptions {
  specs: CheckSpec[];
  root: string;
  mode: 'fast' | 'all';
  /** Whole-tree key (`treeSnapshot.wholeTreeKey`). */
  key: string;
  signal: AbortSignal;
  budgetMs?: number;
  deadlineAt?: number;
}

export interface BaselineResult {
  results: CheckResult[];
  failures: Failure[];
  signatures: string[];
  fingerprint: string;
  budgetExhausted: boolean;
  runAgainstMain?: boolean;
  /** Served from the in-memory baseline cache. */
  cached?: boolean;
}

/** Dependency / toolchain folders per ecosystem, compared between a worktree and the main root. */
export const DEPENDENCY_DIRS: Record<CheckEcosystem, string[]> = {
  node: ['node_modules'],
  python: ['.venv', 'venv'],
  rust: ['target'],
  go: ['vendor'],
  gradle: ['.gradle'],
  dotnet: ['bin', 'obj'],
  maven: ['target'],
  make: ['node_modules', '.venv', 'venv', 'target', 'vendor', '.gradle', 'bin', 'obj'],
  custom: ['node_modules', '.venv', 'venv', 'target', 'vendor', '.gradle', 'bin', 'obj'],
};

const MANIFESTS = [
  'package.json', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb', 'tsconfig.json',
  'pyproject.toml', 'setup.cfg', 'setup.py', 'requirements.txt', 'go.mod', 'go.sum', 'Cargo.toml', 'Cargo.lock',
  'pom.xml', 'build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts', 'Makefile',
];

const MAX_OUTPUT = 256 * 1024;
/** setTimeout's ceiling (about 24.8 days). */
const MAX_TIMER_MS = 2 ** 31 - 1;
const SCOPED_SUFFIX = '#scoped';

const slash = (p: string) => p.replace(/\\/g, '/').replace(/^\.\//, '');
const sha1 = (s: string) => createHash('sha1').update(s).digest('hex');

async function statKey(abs: string): Promise<string> {
  try {
    const st = await fs.promises.stat(abs);
    return `${st.size}\0${st.mtimeMs}`;
  } catch {
    return 'missing';
  }
}

/** sha1 of the sorted path+size+mtimeMs of `files` plus the mtimes of the manifests at the root, in their folders and up to the root. */
export async function treeFingerprint(root: string, files: string[]): Promise<string> {
  if (files.includes(UNKNOWN_CHANGES)) {
    return `unknown:${randomUUID()}`;
  }
  const rel = [...new Set(files.map((f) => slash(path.isAbsolute(f) ? path.relative(root, f) : f)))].sort();
  const dirs = new Set<string>(['']);
  for (const f of rel) {
    for (let d = path.posix.dirname(f); d && d !== '.' && !d.startsWith('..'); d = path.posix.dirname(d)) {
      dirs.add(d);
    }
  }
  const manifests = [...dirs].flatMap((d) => MANIFESTS.map((m) => (d ? `${d}/${m}` : m)));
  manifests.push('.localpilot/checks.json');
  const parts: string[] = [];
  for (const f of rel) {
    parts.push(`f\0${f}\0${await statKey(path.join(root, f))}`);
  }
  for (const m of [...new Set(manifests)].sort()) {
    const k = await statKey(path.join(root, m));
    if (k !== 'missing') {
      parts.push(`m\0${m}\0${k}`);
    }
  }
  return sha1(parts.join('\n'));
}

export function stageOf(spec: Pick<CheckSpec, 'kind'>): Exclude<CheckStage, 'scoped_test'> {
  switch (spec.kind) {
    case 'build':
    case 'typecheck':
      return 'build';
    case 'lint':
      return 'lint';
    case 'security':
      return 'security';
    default:
      return 'test';
  }
}

const isSecurity = (s: CheckSpec) => s.kind === 'security' && !s.command;

function inScope(spec: CheckSpec, file: string): boolean {
  if (spec.when?.length) {
    return spec.when.some((g) => globToRegExp(slash(g)).test(file));
  }
  return isInCheckScope(file, [spec.kind === 'security' ? { ...spec, kind: 'custom', ecosystem: 'custom' } : spec]);
}

export function skipReasonOf(skipped: NonNullable<ExecResult['skipped']>): string {
  if (skipped.deniedByUser) {
    return 'denied by user';
  }
  switch (skipped.blockedBy) {
    case 'policy':
      return 'blocked by managed policy';
    case 'rule':
      return 'blocked by a permission rule';
    case 'hook':
      return 'blocked by a hook';
    case 'setting':
      return 'blocked by a setting';
    case 'unattended':
      return 'approval needed (unattended run)';
    case 'stopped':
      return 'stopped';
    default:
      return 'not run';
  }
}

function abortError(): Error {
  const err = new Error('Checks cancelled');
  err.name = 'AbortError';
  return err;
}

interface Planned {
  /** What the executor runs (a scoped test carries the filled template as its command). */
  spec: CheckSpec;
  stage: CheckStage;
  /** `CheckResult.checkId` and cache key: the spec id, `#scoped` for the affected-tests run. */
  resultId: string;
  /** In-scope changed files (workspace-relative). */
  files: string[];
  /** Dependency folders missing in the worktree that the main root has. */
  missingDeps?: string[];
}

interface Clock {
  start: number;
  budgetMs: number;
  deadlineAt?: number;
}

export class CheckRunner {
  private readonly now: () => number;
  private readonly fingerprint: Fingerprint;
  private readonly baselines = new Map<string, BaselineResult>();

  constructor(private readonly opts: CheckRunnerOptions) {
    this.now = opts.now ?? Date.now;
    this.fingerprint = opts.fingerprint ?? treeFingerprint;
  }

  /** Gate run: build/typecheck -> lint -> scoped test -> full test -> security; stops after a stage whose required check failed. */
  async runStages(o: RunStagesOptions): Promise<StagesResult> {
    const changed = [...new Set(o.changedFiles.map((f) => (f === UNKNOWN_CHANGES ? f : slash(path.isAbsolute(f) ? path.relative(o.root, f) : f))))]
      .filter((f) => f && (f === UNKNOWN_CHANGES || (!f.startsWith('../') && !path.isAbsolute(f))));
    const unknown = changed.includes(UNKNOWN_CHANGES);
    const files = changed.filter((f) => f !== UNKNOWN_CHANGES);
    const relevant = new Map<CheckSpec, string[]>();
    for (const spec of o.specs) {
      const hits = files.filter((f) => inScope(spec, f));
      if (hits.length || (unknown && !spec.when?.length)) {
        relevant.set(spec, hits);
      }
    }
    if (!relevant.size) {
      return { results: [], failures: [], budgetExhausted: false, outOfScope: true };
    }
    const scopedFiles = [...new Set([...relevant.values()].flat())].sort();
    const fp = await this.fingerprint(o.root, unknown ? [UNKNOWN_CHANGES, ...scopedFiles] : scopedFiles);

    const plan: Planned[] = [];
    for (const [spec, hits] of relevant) {
      const stage = stageOf(spec);
      if (stage === 'test' && o.scoped && spec.scoped) {
        const cwdRoot = path.join(o.root, spec.cwd ?? '');
        const affected = await affectedTests(hits.map((f) => path.join(o.root, f)), cwdRoot, spec.ecosystem, this.opts.graph?.(cwdRoot));
        const command = fillScoped(spec.scoped, affected);
        if (command) {
          plan.push({ spec: { ...spec, command }, stage: 'scoped_test', resultId: spec.id + SCOPED_SUFFIX, files: hits });
          if (o.fullTests === false) {
            continue;
          }
        }
      }
      plan.push({ spec, stage, resultId: spec.id, files: hits });
    }
    const from = o.stagesFrom ? STAGE_ORDER.indexOf(o.stagesFrom) : 0;
    const ordered = plan.filter((p) => STAGE_ORDER.indexOf(p.stage) >= from).sort((a, b) => STAGE_ORDER.indexOf(a.stage) - STAGE_ORDER.indexOf(b.stage));
    const missing = this.markMissingDeps(o.root, ordered);

    const clock: Clock = { start: this.now(), budgetMs: o.budgetMs, deadlineAt: o.deadlineAt };
    const out: StagesResult = { results: [], failures: [], budgetExhausted: false, fingerprint: fp };
    let halted: string | undefined;
    for (const stage of STAGE_ORDER) {
      let failedRequired = false;
      for (const p of ordered.filter((x) => x.stage === stage)) {
        let r: CheckResult;
        const hit = o.cache[p.resultId];
        if (halted) {
          r = this.skipped(p, halted, fp);
        } else if (p.missingDeps) {
          r = this.skipped(p, SKIP_WORKTREE_DEPS, fp);
          out.runAgainstMain = true;
        } else if (!unknown && hit && hit.fingerprint === fp && hit.status === 'passed') {
          r = { checkId: p.resultId, status: 'passed', exitCode: 0, durationMs: 0, output: '', failures: [], fingerprint: fp };
        } else {
          r = await this.runOne(p, o.root, unknown ? files : p.files, clock, o.signal, fp, missing);
          if (r.status === 'passed' || r.status === 'failed') {
            o.cache[p.resultId] = { fingerprint: fp, status: r.status, at: this.now(), signatures: r.failures.map((f) => f.signature) };
          } else {
            delete o.cache[p.resultId];
          }
          if (this.budgetHalt(r, clock)) {
            out.budgetExhausted = true;
            halted = this.deadlinePassed(clock) ? SKIP_DEADLINE : SKIP_BUDGET;
          }
        }
        out.results.push(r);
        out.failures.push(...r.failures);
        failedRequired ||= r.status === 'failed' && p.spec.required;
      }
      if (failedRequired) {
        out.stoppedAt = stage;
        break;
      }
    }
    return out;
  }

  /** Checks before the first edit of a turn: `fast` = typecheck + lint only; `all` = every non-security check. Cached by whole-tree key. */
  async runBaseline(o: RunBaselineOptions): Promise<BaselineResult> {
    const picked = (o.mode === 'fast' ? fastSpecs(o.specs) : o.specs).filter((s) => s.kind !== 'security' && !s.when?.length);
    const cacheKey = sha1([semaphoreKey(o.root), o.mode, o.key, ...picked.map((s) => `${s.id}\0${s.cwd ?? ''}\0${s.command}`).sort()].join('\n'));
    const prior = this.baselines.get(cacheKey);
    if (prior) {
      return { ...prior, cached: true };
    }
    const ordered: Planned[] = picked
      .map((spec) => ({ spec, stage: stageOf(spec) as CheckStage, resultId: spec.id, files: [] }))
      .sort((a, b) => STAGE_ORDER.indexOf(a.stage) - STAGE_ORDER.indexOf(b.stage));
    const missing = this.markMissingDeps(o.root, ordered);
    const clock: Clock = { start: this.now(), budgetMs: o.budgetMs ?? Number.POSITIVE_INFINITY, deadlineAt: o.deadlineAt };
    const out: BaselineResult = { results: [], failures: [], signatures: [], fingerprint: o.key, budgetExhausted: false };
    let halted: string | undefined;
    for (const p of ordered) {
      let r: CheckResult;
      if (halted) {
        r = this.skipped(p, halted, o.key);
      } else if (p.missingDeps) {
        r = this.skipped(p, SKIP_WORKTREE_DEPS, o.key);
        out.runAgainstMain = true;
      } else {
        r = await this.runOne(p, o.root, [], clock, o.signal, o.key, missing);
        if (this.budgetHalt(r, clock)) {
          out.budgetExhausted = true;
          halted = this.deadlinePassed(clock) ? SKIP_DEADLINE : SKIP_BUDGET;
        }
      }
      out.results.push(r);
      out.failures.push(...r.failures);
    }
    out.signatures = [...new Set(out.failures.map((f) => f.signature))].sort();
    if (!out.budgetExhausted && out.results.every((r) => r.status === 'passed' || r.status === 'failed')) {
      this.baselines.set(cacheKey, out);
    }
    return out;
  }

  /** Dependency folders the main root has and `root` (a worktree) lacks, for the check folder of `spec`. */
  missingDependencies(root: string, spec: Pick<CheckSpec, 'ecosystem' | 'cwd'>): string[] {
    const main = this.opts.mainRoot;
    if (!main || semaphoreKey(main) === semaphoreKey(root)) {
      return [];
    }
    const cwd = spec.cwd ?? '';
    return DEPENDENCY_DIRS[spec.ecosystem].filter((d) => !isDir(path.join(root, cwd, d)) && isDir(path.join(main, cwd, d)));
  }

  private markMissingDeps(root: string, plan: Planned[]): boolean {
    let any = false;
    for (const p of plan) {
      if (isSecurity(p.spec)) {
        continue;
      }
      const m = this.missingDependencies(root, p.spec);
      if (m.length) {
        p.missingDeps = m;
        any = true;
      }
    }
    return any;
  }

  private remainingMs(c: Clock): number {
    const t = this.now();
    const budget = c.budgetMs - (t - c.start);
    return c.deadlineAt === undefined ? budget : Math.min(budget, c.deadlineAt - t);
  }

  private deadlinePassed(c: Clock): boolean {
    return c.deadlineAt !== undefined && this.now() >= c.deadlineAt;
  }

  private exhausted(c: Clock): boolean {
    return this.remainingMs(c) <= 0;
  }

  /** A check that timed out with the budget spent, or was never started because it ran out. */
  private budgetHalt(r: CheckResult, c: Clock): boolean {
    return (r.status === 'timeout' && this.exhausted(c)) || (r.status === 'skipped' && (r.skipReason === SKIP_BUDGET || r.skipReason === SKIP_DEADLINE));
  }

  private budgetSkip(p: Pick<Planned, 'resultId'>, c: Clock, fingerprint: string): CheckResult {
    return this.skipped(p, this.deadlinePassed(c) ? SKIP_DEADLINE : SKIP_BUDGET, fingerprint);
  }

  private skipped(p: Pick<Planned, 'resultId'>, skipReason: string, fingerprint: string): CheckResult {
    return { checkId: p.resultId, status: 'skipped', skipReason, exitCode: null, durationMs: 0, output: '', failures: [], fingerprint };
  }

  private async runOne(p: Planned, root: string, files: string[], clock: Clock, signal: AbortSignal, fingerprint: string, worktreeMissingDeps: boolean): Promise<CheckResult> {
    if (signal.aborted) {
      throw abortError();
    }
    const waitMs = this.remainingMs(clock);
    if (waitMs <= 0) {
      return this.budgetSkip(p, clock, fingerprint);
    }
    // worktrees get their own lane; a gate rerun against the main root passes root = mainRoot
    const waitLimit = waitMs < MAX_TIMER_MS ? AbortSignal.timeout(Math.max(1, waitMs)) : undefined;
    let release: () => void;
    try {
      release = await this.opts.semaphore.acquire(root, waitLimit ? AbortSignal.any([signal, waitLimit]) : signal);
    } catch (e) {
      if (signal.aborted) {
        throw abortError();
      }
      if (waitLimit?.aborted) {
        return this.budgetSkip(p, clock, fingerprint);
      }
      throw e;
    }
    // a referenced timer (AbortSignal.timeout is unref'd): a hung check keeps the process alive until it is killed
    const kill = new AbortController();
    let handle: NodeJS.Timeout | undefined;
    try {
      const remaining = this.remainingMs(clock);
      const started = this.now();
      if (remaining <= 0) {
        return this.budgetSkip(p, clock, fingerprint);
      }
      const specMs = p.spec.timeoutSeconds > 0 ? p.spec.timeoutSeconds * 1000 : MAX_TIMER_MS;
      const limitMs = Math.max(1, Math.min(specMs, remaining, MAX_TIMER_MS));
      handle = setTimeout(() => kill.abort(), limitMs);
      const timer = kill.signal;
      const combined = AbortSignal.any([signal, timer]);
      const spec: CheckSpec = { ...p.spec, timeoutSeconds: Math.max(1, Math.ceil(limitMs / 1000)) };
      if (isSecurity(spec)) {
        return await this.runSecurity(spec, root, files, combined, timer, signal, started, fingerprint);
      }
      let res: ExecResult;
      try {
        res = await raceAbort(this.opts.exec(spec, combined), combined);
      } catch (e) {
        if (signal.aborted) {
          throw abortError();
        }
        if (timer.aborted) {
          return this.timedOut(p, root, '', this.now() - started, fingerprint, worktreeMissingDeps);
        }
        res = { exitCode: null, output: e instanceof Error ? e.message : String(e) };
      }
      const durationMs = this.now() - started;
      if (res.skipped) {
        if (signal.aborted && res.skipped.blockedBy === 'stopped') {
          throw abortError();
        }
        return { ...this.skipped(p, skipReasonOf(res.skipped), fingerprint), durationMs };
      }
      if (res.timedOut || res.detached || (timer.aborted && res.exitCode !== 0)) {
        return this.timedOut(p, root, res.output, durationMs, fingerprint, worktreeMissingDeps);
      }
      const failures = res.exitCode === 0 ? [] : this.opts.classify({ kind: 'check', spec, outcome: res, worktreeMissingDeps, root });
      if (res.exitCode !== 0 && !failures.length && worktreeMissingDeps) {
        return { ...this.skipped(p, SKIP_WORKTREE_DEPS, fingerprint), exitCode: res.exitCode, durationMs, output: clipOutput(res.output) };
      }
      return { checkId: p.resultId, status: res.exitCode === 0 ? 'passed' : 'failed', exitCode: res.exitCode, durationMs, output: clipOutput(res.output), failures, fingerprint };
    } finally {
      clearTimeout(handle);
      release();
    }
  }

  private async runSecurity(spec: CheckSpec, root: string, files: string[], combined: AbortSignal, timer: AbortSignal, signal: AbortSignal, started: number, fingerprint: string): Promise<CheckResult> {
    if (!this.opts.securityScan) {
      return this.skipped({ resultId: spec.id }, SKIP_NO_SCANNER, fingerprint);
    }
    try {
      const found = await raceAbort(this.opts.securityScan(root, files, combined), combined);
      const failures = found.filter((f) => f.severity !== 'info');
      return {
        checkId: spec.id, status: failures.length ? 'failed' : 'passed', exitCode: failures.length ? 1 : 0, durationMs: this.now() - started,
        output: found.map((f) => `${f.file ?? ''}${f.line ? `:${f.line}` : ''} ${f.message}`.trim()).join('\n'), failures, fingerprint,
      };
    } catch (e) {
      if (signal.aborted) {
        throw abortError();
      }
      if (timer.aborted) {
        return this.timedOut({ spec, stage: 'security', resultId: spec.id, files }, root, '', this.now() - started, fingerprint, false);
      }
      return this.skipped({ resultId: spec.id }, `security scan failed: ${e instanceof Error ? e.message : String(e)}`, fingerprint);
    }
  }

  private timedOut(p: Planned, root: string, output: string, durationMs: number, fingerprint: string, worktreeMissingDeps: boolean): CheckResult {
    const outcome: ExecResult = { exitCode: null, output, timedOut: true };
    const failures = this.opts.classify({ kind: 'check', spec: p.spec, outcome, worktreeMissingDeps, root });
    return { checkId: p.resultId, status: 'timeout', exitCode: null, durationMs, output: clipOutput(output), failures, fingerprint };
  }
}

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function clipOutput(s: string): string {
  return s.length > MAX_OUTPUT ? s.slice(-MAX_OUTPUT) : s;
}

/** Rejects as soon as `signal` aborts, even when the executor ignores it. */
function raceAbort<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(abortError());
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal.addEventListener('abort', onAbort, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener('abort', onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener('abort', onAbort);
        reject(e);
      },
    );
  });
}
