import type { RecoveryDashboard } from '../agent/healing/dashboardData';
import type { RecoveryActionKind } from '../agent/healing/types';

/**
 * Settings → Dashboard → Self-healing & recovery, host side: the messages the webview may send and how the range is
 * turned into the data service's day count. No VS Code imports, so it is testable on its own.
 */

/** Actions the Human Intervention Queue may run. `retryWithGuidance` needs a typed instruction and lives on the chat card. */
export const DASHBOARD_RECOVERY_ACTIONS: ReadonlySet<RecoveryActionKind> = new Set<RecoveryActionKind>([
  'resume', 'approveInstall', 'installManually', 'rollback', 'restoreCheckpoint', 'openMergeEditor', 'acceptRisk', 'setApiKey', 'pickModel',
  'startServer', 'retry', 'inspect', 'openChat', 'dismiss',
]);

/** The "All" range (0 days) as a day count the data service accepts: ten years. */
const ALL_DAYS = 3650;

export interface RecoveryActionRequest {
  sessionId: string;
  action: RecoveryActionKind;
  /** Intervention id, when the action comes from a queue item. */
  id?: string;
}

export interface MemoryReuseRequest {
  id: string;
  allowed: boolean;
}

const str = (v: unknown, max = 200): string | undefined => (typeof v === 'string' && v.length > 0 && v.length <= max && !/[\0\r\n]/.test(v) ? v : undefined);

export function parseRecoveryAction(m: { sessionId?: unknown; action?: unknown; id?: unknown }): RecoveryActionRequest | undefined {
  const sessionId = str(m.sessionId);
  const action = typeof m.action === 'string' && DASHBOARD_RECOVERY_ACTIONS.has(m.action as RecoveryActionKind) ? (m.action as RecoveryActionKind) : undefined;
  if (!sessionId || !action) {
    return undefined;
  }
  const id = str(m.id);
  return id ? { sessionId, action, id } : { sessionId, action };
}

export function parseMemoryReuse(m: { id?: unknown; allowed?: unknown }): MemoryReuseRequest | undefined {
  const id = str(m.id);
  return id && typeof m.allowed === 'boolean' ? { id, allowed: m.allowed } : undefined;
}

export function recoveryDays(days: number): number {
  return Number.isFinite(days) && days > 0 ? Math.floor(days) : ALL_DAYS;
}

/** The recovery block of a dashboard reply: the data, an error line, or nothing when no provider is wired. */
export async function loadRecovery(provider: ((days: number) => Promise<RecoveryDashboard>) | undefined, days: number): Promise<{ recovery?: RecoveryDashboard; recoveryError?: string }> {
  if (!provider) {
    return {};
  }
  try {
    return { recovery: await provider(recoveryDays(days)) };
  } catch (e) {
    return { recoveryError: e instanceof Error ? e.message : String(e) };
  }
}

export const RECOVERY_ACTION_DONE: Partial<Record<RecoveryActionKind, string>> = {
  resume: 'Resuming the task in its chat',
  rollback: 'Rolled back the fixes',
  dismiss: 'Dismissed',
  approveInstall: 'Install approved',
  acceptRisk: 'Risk accepted and recorded in the audit log',
};

export interface OpenRecoveryDiffRequest {
  sessionId: string;
  attempt: number;
  file: string;
}

export function parseOpenRecoveryDiff(m: { sessionId?: unknown; attempt?: unknown; file?: unknown }): OpenRecoveryDiffRequest | undefined {
  const sessionId = str(m.sessionId);
  const file = str(m.file, 1000);
  const attempt = typeof m.attempt === 'number' && Number.isInteger(m.attempt) && m.attempt > 0 ? m.attempt : undefined;
  return sessionId && file && attempt ? { sessionId, attempt, file } : undefined;
}

export type RecoveryToast = { type: 'toast'; level: 'info' | 'warn' | 'error'; text: string };

/** The host's recovery hooks plus the risk confirmation (a modal in the panel), passed in so the handlers stay testable. */
export interface RecoveryHooks {
  onRecoveryAction?: (sessionId: string, action: RecoveryActionKind, interventionId?: string) => Promise<boolean | void>;
  onMemoryReuse?: (id: string, allowed: boolean) => Promise<boolean>;
  openRecoveryDiff?: (sessionId: string, attempt: number, file: string) => Promise<void>;
  /** true when the user confirms keeping a security finding; asked here, so no wiring of the hook can skip it. */
  confirmRisk: () => Promise<boolean>;
}

/** A Human Intervention Queue click. Always refreshes afterwards (also after a failure or a declined risk): the queue's
 *  buttons were disabled on click and come back with the fresh data. */
export async function handleRecoveryAction(m: { sessionId?: unknown; action?: unknown; id?: unknown }, hooks: RecoveryHooks, post: (t: RecoveryToast) => void, refresh: () => Promise<void>): Promise<void> {
  const r = parseRecoveryAction(m);
  if (!r) {
    post({ type: 'toast', level: 'error', text: 'Unknown recovery action' });
    return refresh();
  }
  if (!hooks.onRecoveryAction) {
    post({ type: 'toast', level: 'error', text: 'Self-healing is not available in this window' });
    return refresh();
  }
  try {
    if (r.action === 'acceptRisk' && !(await hooks.confirmRisk())) {
      return;
    }
    const ok = await hooks.onRecoveryAction(r.sessionId, r.action, r.id);
    const done = RECOVERY_ACTION_DONE[r.action];
    if (done && ok !== false) {
      post({ type: 'toast', level: 'info', text: done });
    }
  } catch (e) {
    post({ type: 'toast', level: 'error', text: `Could not ${r.action === 'acceptRisk' ? 'accept the risk' : 'run that action'}: ${e instanceof Error ? e.message : String(e)}` });
  } finally {
    await refresh();
  }
}

/** "Don't suggest again" / "Suggest again"; the refresh brings the stored value back to the webview either way. */
export async function handleMemoryReuse(m: { id?: unknown; allowed?: unknown }, hooks: RecoveryHooks, post: (t: RecoveryToast) => void, refresh: () => Promise<void>): Promise<void> {
  const r = parseMemoryReuse(m);
  if (!r || !hooks.onMemoryReuse) {
    post({ type: 'toast', level: 'error', text: r ? 'Failure memory is not available in this window' : 'Unknown memory entry' });
    return refresh();
  }
  try {
    const ok = await hooks.onMemoryReuse(r.id, r.allowed);
    post({ type: 'toast', level: ok ? 'info' : 'warn', text: ok ? (r.allowed ? 'This fix will be suggested again' : 'This fix will not be suggested again') : 'That memory entry no longer exists' });
  } catch (e) {
    post({ type: 'toast', level: 'error', text: `Could not update the memory entry: ${e instanceof Error ? e.message : String(e)}` });
  } finally {
    await refresh();
  }
}

/** "Open diff" on an applied patch: the attempt's snapshot against the file as it is now. */
export async function handleOpenRecoveryDiff(m: { sessionId?: unknown; attempt?: unknown; file?: unknown }, hooks: RecoveryHooks, post: (t: RecoveryToast) => void): Promise<void> {
  const r = parseOpenRecoveryDiff(m);
  if (!r || !hooks.openRecoveryDiff) {
    post({ type: 'toast', level: 'error', text: r ? 'Opening recovery diffs is not available in this window' : 'Unknown patch' });
    return;
  }
  try {
    await hooks.openRecoveryDiff(r.sessionId, r.attempt, r.file);
  } catch (e) {
    post({ type: 'toast', level: 'error', text: `Could not open the diff: ${e instanceof Error ? e.message : String(e)}` });
  }
}
