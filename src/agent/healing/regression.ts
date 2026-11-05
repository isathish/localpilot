import { failureScore } from './patchManager';
import type { CheckStatus, Failure, RegressionReport } from './types';

/** Regression Engine (design §5.5): failure sets before and after a fix, attributed against the baseline. */

export type RegressionFailure = Pick<Failure, 'signature' | 'severity'> & Partial<Pick<Failure, 'file' | 'preexisting' | 'foreign' | 'category'>>;

/** Report plus the failures that were there before the fix and are still there. */
export interface RegressionComparison extends RegressionReport {
  still: string[];
}

type Baseline = Iterable<string> | undefined;

const toSet = (baseline: Baseline) => (baseline instanceof Set ? (baseline as Set<string>) : new Set(baseline ?? []));

function uniq<T extends RegressionFailure>(list: readonly T[]): T[] {
  const seen = new Map<string, T>();
  for (const f of list) {
    if (!seen.has(f.signature)) {
      seen.set(f.signature, f);
    }
  }
  return [...seen.values()];
}

/** Copies of `list` with `preexisting` (matched the baseline) and `foreign` (another live session's file) set. */
export function attribute<T extends RegressionFailure>(list: readonly T[], baseline?: Baseline, foreign?: (f: T) => boolean): T[] {
  const base = toSet(baseline);
  return list.map((f) => ({
    ...f,
    preexisting: f.preexisting || base.has(f.signature) || undefined,
    foreign: f.foreign || (foreign ? foreign(f) : false) || undefined,
  }));
}

/**
 * Compares the failures of the stages that ran before and after a fix. Baseline matches are `preexisting`, failures
 * located only in files another live session wrote are `foreign` (never `introduced`), failures that were already
 * there are `still`, and the rest are `introduced`. `fixed` lists every signature of `before` that is gone.
 */
export function compare<T extends RegressionFailure>(
  before: readonly T[],
  after: readonly T[],
  baseline?: Baseline,
  foreign?: (f: T) => boolean,
  durationMs = 0,
): RegressionComparison {
  const b = uniq(before);
  const a = attribute(uniq(after), baseline, foreign);
  const beforeSigs = new Set(b.map((f) => f.signature));
  const afterSigs = new Set(a.map((f) => f.signature));
  const report: RegressionComparison = {
    before: [...beforeSigs],
    after: [...afterSigs],
    fixed: b.filter((f) => !afterSigs.has(f.signature)).map((f) => f.signature),
    introduced: [],
    preexisting: [],
    foreign: [],
    still: [],
    durationMs,
  };
  for (const f of a) {
    if (f.preexisting) {
      report.preexisting.push(f.signature);
    } else if (f.foreign) {
      report.foreign.push(f.signature);
    } else if (beforeSigs.has(f.signature)) {
      report.still.push(f.signature);
    } else {
      report.introduced.push(f.signature);
    }
  }
  return report;
}

/** Stage statuses keyed by check id, with the ids of the required checks. */
export interface StageStatuses {
  before: Record<string, CheckStatus | undefined>;
  after: Record<string, CheckStatus | undefined>;
  required: Iterable<string>;
}

/**
 * The fix made things worse (rollback rule, §5.4): the severity score of attributable failures grew, or a required
 * stage that passed before the attempt now fails. Preexisting and foreign failures never count.
 */
export function isWorse<T extends RegressionFailure>(
  before: readonly T[],
  after: readonly T[],
  baseline?: Baseline,
  foreign?: (f: T) => boolean,
  stages?: StageStatuses,
): boolean {
  const score = (list: readonly T[]) => failureScore(attribute(uniq(list), baseline, foreign).map((f) => ({ severity: f.severity, preexisting: f.preexisting, foreign: f.foreign })));
  if (score(after) > score(before)) {
    return true;
  }
  if (stages) {
    for (const id of stages.required) {
      if (stages.before[id] === 'passed' && stages.after[id] === 'failed') {
        return true;
      }
    }
  }
  return false;
}
