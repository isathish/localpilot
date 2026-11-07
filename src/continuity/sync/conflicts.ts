// Conflicts (design §14.4). The reducer finds them while it applies events (every device computes the same records,
// with the same ids); the memory bridge records the ones of note files edited here while they changed elsewhere. They
// are listed from the index (`sync_conflicts`); a resolution is written to the log as a `conflict` entity (so it syncs
// and clears the conflict on every device) together with the change it chose (a field patch, a text, a branch switch,
// a trash). Pure Node.
import type { ConflictFields, ConflictKind, EntityKind } from '../events';
import type { FileEventLog } from '../data/eventLog';
import type { IndexClient } from '../data/index/indexClient';

export type Resolution = 'ours' | 'theirs' | 'both' | 'merged' | 'keep-applied';

export interface ConflictSide {
  value: unknown;
  hlc: string;
  device: string;
  name?: string;
}

export interface ConflictRow {
  id: string;
  entity: EntityKind;
  entityId: string;
  field: string;
  kind: ConflictKind;
  ours: ConflictSide;
  theirs: ConflictSide;
  applied: ConflictFields['applied'];
  createdAt: number;
  resolvedAt?: number;
  resolution?: Resolution;
  /** What the UI shows: the entity's title or name when the index knows it. */
  label?: string;
}

/** Changes a resolution may need from the feature modules (memory files, branch switches). */
export interface ConflictEffects {
  /** Writes a memory note's text (its file when it has one here, else the log). */
  setMemoryText?(id: string, text: string): Promise<void>;
  trashMemory?(id: string): Promise<void>;
  restoreMemory?(id: string): Promise<void>;
  switchBranch?(conversationId: string, branchId: string): Promise<void>;
  trashConversation?(id: string): Promise<void>;
}

interface RawRow {
  id: string;
  entity: string;
  entity_id: string;
  field: string | null;
  kind: string;
  ours: string | null;
  theirs: string | null;
  applied: string | null;
  created_at: number;
  resolved_at: number | null;
  resolution: string | null;
}

const parseSide = (s: string | null): ConflictSide => {
  try {
    const v = s ? (JSON.parse(s) as ConflictSide) : undefined;
    return v && typeof v === 'object' ? { value: v.value, hlc: String(v.hlc ?? ''), device: String(v.device ?? ''), ...(v.name ? { name: String(v.name) } : {}) } : { value: undefined, hlc: '', device: '' };
  } catch {
    return { value: undefined, hlc: '', device: '' };
  }
};

export function conflictRow(r: RawRow): ConflictRow {
  return {
    id: r.id,
    entity: r.entity as EntityKind,
    entityId: r.entity_id,
    field: r.field ?? '',
    kind: r.kind as ConflictKind,
    ours: parseSide(r.ours),
    theirs: parseSide(r.theirs),
    applied: (r.applied ?? 'theirs') as ConflictFields['applied'],
    createdAt: r.created_at,
    ...(r.resolved_at ? { resolvedAt: r.resolved_at } : {}),
    ...(r.resolution ? { resolution: r.resolution as Resolution } : {}),
  };
}

/** Kinds that need nothing but an acknowledgement. */
export const INFO_KINDS: readonly ConflictKind[] = ['remote-damaged', 'clock-skew'];

/** The text a text-merge resolution keeps. */
export function chosenText(c: ConflictRow, r: Resolution, merged?: string): string | undefined {
  const a = typeof c.ours.value === 'string' ? c.ours.value : '';
  const b = typeof c.theirs.value === 'string' ? c.theirs.value : '';
  switch (r) {
    case 'ours':
      return a;
    case 'theirs':
      return b;
    case 'both':
      return `${a.replace(/\s+$/, '')}\n\n${b.replace(/^\s+/, '')}`;
    case 'merged':
      return merged;
    default:
      return undefined;
  }
}

export class ConflictService {
  constructor(private readonly o: { log: FileEventLog; index: IndexClient; effects?: () => ConflictEffects; now?: () => number }) {}

  private get now(): number {
    return (this.o.now ?? Date.now)();
  }

  async list(o: { all?: boolean } = {}): Promise<ConflictRow[]> {
    const rows = await this.o.index.query<RawRow>('conflicts', o.all ? { all: true } : {});
    const out = rows.map(conflictRow);
    // Labels: conversation titles and memory names, so the list says what changed.
    for (const c of out) {
      if (c.entity === 'conversation') {
        c.label = (await this.o.index.conversation(c.entityId).catch(() => undefined))?.title;
      } else if (c.entity === 'memory') {
        c.label = c.theirs.name ?? (await this.o.index.memory({ id: c.entityId, includeTrash: true }).catch(() => []))[0]?.name;
      }
    }
    return out;
  }

  async count(): Promise<number> {
    return (await this.o.index.query('conflicts', {}).catch(() => [])).length;
  }

  async get(id: string): Promise<ConflictRow | undefined> {
    return (await this.list({ all: true })).find((c) => c.id === id);
  }

  /**
   * Resolves a conflict: applies the chosen side and records the resolution (durable). `merged` is the edited text of
   * a text-merge. Returns false when the conflict is unknown or already resolved.
   */
  async resolve(id: string, resolution: Resolution, merged?: string): Promise<boolean> {
    await this.o.index.catchUp().catch(() => 0);
    const c = await this.get(id);
    if (!c || c.resolvedAt) {
      return false;
    }
    const fx = this.o.effects?.() ?? {};
    const log = this.o.log;
    const base = log.peekHlc();
    switch (c.kind) {
      case 'field': {
        // The applied value is the newer one; keeping the older one writes it again (it then wins everywhere).
        if (resolution === 'ours' && c.applied !== 'ours') {
          log.append(c.entity, c.entityId, 'patch', { [c.field]: c.ours.value ?? null }, { base, durable: true });
        } else if (resolution === 'theirs' && c.applied === 'ours') {
          log.append(c.entity, c.entityId, 'patch', { [c.field]: c.theirs.value ?? null }, { base, durable: true });
        }
        break;
      }
      case 'text-merge': {
        const text = chosenText(c, resolution, merged);
        if (text !== undefined && resolution !== 'keep-applied') {
          if (c.entity === 'memory' && fx.setMemoryText) {
            await fx.setMemoryText(c.entityId, text);
          } else {
            log.append(c.entity, c.entityId, 'patch', { [c.field || 'body']: text }, { base, durable: true });
          }
        }
        break;
      }
      case 'branch-split': {
        if (resolution === 'theirs' && typeof c.theirs.value === 'string') {
          if (fx.switchBranch) {
            await fx.switchBranch(c.entityId, c.theirs.value);
          } else {
            log.append('conversation', c.entityId, 'patch', { activeBranchId: c.theirs.value }, { base, durable: true });
          }
        }
        break;
      }
      case 'trash-vs-edit': {
        if (resolution === 'theirs') {
          // Move to Trash again.
          if (c.entity === 'memory' && fx.trashMemory) {
            await fx.trashMemory(c.entityId);
          } else if (c.entity === 'conversation' && fx.trashConversation) {
            await fx.trashConversation(c.entityId);
          } else {
            log.append(c.entity, c.entityId, 'trash', { at: this.now, reason: 'conflict' }, { base, durable: true });
          }
        } else if (c.entity === 'memory') {
          // Keep it: restored, with this machine's text when the note file was edited here.
          await fx.restoreMemory?.(c.entityId);
          if (typeof c.ours.value === 'string' && c.ours.value && fx.setMemoryText) {
            await fx.setMemoryText(c.entityId, c.ours.value);
          }
        }
        break;
      }
      default:
        break;
    }
    const fields: ConflictFields = {
      entity: c.entity,
      entityId: c.entityId,
      field: c.field,
      kind: c.kind,
      ours: { value: c.ours.value, hlc: c.ours.hlc, device: c.ours.device },
      theirs: { value: c.theirs.value, hlc: c.theirs.hlc, device: c.theirs.device },
      applied: c.applied,
      resolvedAt: this.now,
      resolution,
    };
    // A resolution of a damaged object or a clock warning stays on this device (they are about this device's view).
    log.append('conflict', c.id, 'create', fields, { durable: true, base, ...(INFO_KINDS.includes(c.kind) ? { local: true } : {}) });
    await log.flush();
    await this.o.index.catchUp().catch(() => 0);
    return true;
  }

  /** Records a problem only this device sees (a damaged remote object, a clock far ahead): never synced. */
  report(kind: 'remote-damaged' | 'clock-skew', entityId: string, detail: { value: unknown; device: string }): void {
    const id = `cf_${kind}_${entityId.replace(/[^\w.-]/g, '_')}`.slice(0, 120);
    const now = this.now;
    const hlc = this.o.log.peekHlc();
    this.o.log.append(
      'conflict',
      id,
      'create',
      { entity: 'device', entityId, field: kind, kind, ours: { value: null, hlc, device: this.o.log.device.deviceId }, theirs: { value: detail.value, hlc, device: detail.device }, applied: 'ours', createdAt: now } as ConflictFields,
      { local: true }
    );
  }
}
