// What sync carries (design §14.2): every event belongs to one category the user can switch off, and the blobs an
// event refers to belong to the category of their content. Merging itself is the DATA reducer's (field-level LWW,
// per-key maps, 3-way text merge, branch split, trash vs edit, §9.4): sync only moves events, every device reduces them
// the same way. Pure.
import type { EntityKind, EventEnvelope } from '../events';

export type SyncCategory = 'conversations' | 'memory' | 'attachments' | 'agentState' | 'checkpointContents' | 'prompts' | 'preferences' | 'approvals';
export const SYNC_CATEGORIES: readonly SyncCategory[] = ['conversations', 'memory', 'attachments', 'agentState', 'checkpointContents', 'prompts', 'preferences', 'approvals'];
export type SyncCategories = Record<SyncCategory, boolean>;
/** Approval levels are opt-in: loosening them on one device would loosen them on every device. */
export const DEFAULT_CATEGORIES: SyncCategories = { conversations: true, memory: true, attachments: true, agentState: true, checkpointContents: false, prompts: true, preferences: true, approvals: false };

export const CATEGORY_LABELS: Record<SyncCategory, string> = {
  conversations: 'Conversations',
  memory: 'Memory and context sets',
  attachments: 'Attachments (images, files)',
  agentState: 'Agent runs and checkpoints',
  checkpointContents: 'Checkpoint contents',
  prompts: 'Custom commands',
  preferences: 'Preferences (models, thinking level, Auto mode)',
  approvals: 'Approval levels (loosening them on one device loosens them on all)',
};

/** The category of an entity's events; `system` always syncs (projects, devices, conflicts, import markers). */
export function categoryOfEntity(ent: EntityKind): SyncCategory | 'system' {
  switch (ent) {
    case 'conversation':
    case 'branch':
    case 'message':
    case 'attachment':
    case 'context_snapshot':
    case 'model_session':
      return 'conversations';
    case 'memory':
    case 'context_item':
      return 'memory';
    case 'agent_session':
    case 'execution_event':
    case 'checkpoint':
      return 'agentState';
    case 'prompt_template':
    case 'instruction_file':
      return 'prompts';
    case 'preference':
      return 'preferences';
    default:
      return 'system';
  }
}

/** Why an event is not uploaded as it is (`local`, or its category is off); undefined = upload it. */
export function withholdReason(e: EventEnvelope, cats: SyncCategories): string | undefined {
  if (e.local) {
    return 'local';
  }
  const c = categoryOfEvent(e);
  return c !== 'system' && !cats[c] ? c : undefined;
}

/** Preference keys that are approval levels (their own, opt-in category). */
export const isApprovalKey = (key: unknown): boolean => typeof key === 'string' && key.startsWith('approvals.');

/** The category of one event: its entity's, except approval-level preferences (`approvals`). */
export function categoryOfEvent(e: Pick<EventEnvelope, 'ent' | 'p'>): SyncCategory | 'system' {
  if (e.ent === 'preference' && isApprovalKey((e.p as { key?: unknown })?.key)) {
    return 'approvals';
  }
  return categoryOfEntity(e.ent);
}

export interface BlobRef {
  sha: string;
  category: SyncCategory;
}

const isSha = (s: unknown): s is string => typeof s === 'string' && /^[0-9a-f]{64}$/.test(s);

/**
 * Blobs an event refers to: an attachment's file (attachments), a long message part (conversations), a step's full
 * output (agentState), a checkpoint's content (checkpointContents).
 */
export function blobRefs(e: EventEnvelope): BlobRef[] {
  const p = e.p as Record<string, unknown>;
  const out: BlobRef[] = [];
  if (e.ent === 'attachment' && isSha(p.blob)) {
    out.push({ sha: p.blob, category: 'attachments' });
  }
  if (e.ent === 'message' && Array.isArray(p.parts)) {
    for (const part of p.parts as { blob?: unknown }[]) {
      if (isSha(part?.blob)) {
        out.push({ sha: part.blob, category: 'conversations' });
      }
    }
  }
  if (e.ent === 'execution_event' && isSha(p.outputBlob)) {
    out.push({ sha: p.outputBlob, category: 'agentState' });
  }
  if (e.ent === 'checkpoint' && isSha(p.contentBlob)) {
    out.push({ sha: p.contentBlob, category: 'checkpointContents' });
  }
  return out;
}

/** Normalises a settings object (unknown keys dropped, missing ones defaulted). */
export function normalizeCategories(v: unknown): SyncCategories {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  const out = { ...DEFAULT_CATEGORIES };
  for (const c of SYNC_CATEGORIES) {
    if (typeof o[c] === 'boolean') {
      out[c] = o[c] as boolean;
    }
  }
  return out;
}
