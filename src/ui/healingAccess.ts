import { rootSessionId, type HealingService, type RecoveryState, type RecoveryStore, type ResumeInfo } from '../agent/healing';

/**
 * The service members the chat needs beyond its public API: the persisted state of a chat (for the Recovery
 * interrupted card) and dropping a deleted chat's state. Public `state` / `forget` win when the service has them.
 */
type ServiceInternals = {
  state?: (sid: string) => Promise<RecoveryState | undefined>;
  forget?: (sid: string) => Promise<void>;
  opts?: { store?: Pick<RecoveryStore, 'load' | 'deleteSession'> };
  index?: Map<string, ResumeInfo>;
};

const internals = (healing: HealingService) => healing as unknown as ServiceInternals;

/** The chat's persisted recovery state (undefined when it has none or the store cannot be read). */
export async function recoveryStateOf(healing: HealingService, sid: string): Promise<RecoveryState | undefined> {
  const h = internals(healing);
  if (typeof h.state === 'function') {
    return h.state.call(healing, sid);
  }
  return h.opts?.store?.load(sid);
}

/** A deleted chat: out of the resume index (Agents view, dashboard) and its persisted state and snapshots removed. */
export async function forgetRecovery(healing: HealingService, sid: string): Promise<void> {
  const h = internals(healing);
  if (typeof h.forget === 'function') {
    return h.forget.call(healing, sid);
  }
  h.index?.delete(rootSessionId(sid));
  await h.opts?.store?.deleteSession(sid);
}

/** The phase a state was in before the shutdown overwrote it with `interrupted` (when it can still be told). */
export function phaseBeforeInterrupt(s: RecoveryState): string | undefined {
  const own = (s as { lastPhase?: unknown }).lastPhase;
  if (typeof own === 'string' && own && own !== 'interrupted') {
    return own;
  }
  if (s.phase !== 'interrupted') {
    return s.phase;
  }
  const last = s.attempts[s.attempts.length - 1];
  if (last && !last.result) {
    return 'fixing';
  }
  const pending = s.pendingAction;
  if (pending && pending.status !== 'done' && pending.status !== 'declined') {
    return pending.kind === 'rollback' ? 'rolling_back' : 'resolving';
  }
  return undefined;
}

/** How many interventions wait for the user (the welcome screen's "N tasks need you"); 0 when the store cannot say. */
export async function openInterventionCount(healing: HealingService): Promise<number> {
  const store = (healing as unknown as { opts?: { store?: Partial<Pick<RecoveryStore, 'listInterventions'>> } }).opts?.store;
  try {
    return typeof store?.listInterventions === 'function' ? (await store.listInterventions()).length : 0;
  } catch {
    return 0;
  }
}
