// The reducer (design §5.5, §9.4): event -> entity state, shared by the index, sync and materialisation. Pure and
// order-independent: applying the same set of events in any interleaving that keeps each stream's order gives the same
// state, and applying an event twice changes nothing.
//
// - Plain fields: last writer wins per field (by HLC). `rules.objectFields` are split into one LWW field per key
//   (`fingerprints.gitRemote`), `rules.mapFields` are merged per key (`tags.release`).
// - trash / restore: an LWW register on `trashedAt`. A conversation edited concurrently with its trash (a message
//   written without having seen the trash) is revived (`trash-vs-edit`).
// - purge: terminal; the state keeps only its id and the tombstone, later events are ignored.
// - `rules.textFields` (memory, prompt and instruction bodies): every version is kept (bounded) and the value is a fold
//   over them in HLC order with a 3-way line merge for concurrent edits (`text-merge` conflict on overlap).
// - `rules.conflictFields`: concurrent writes with two non-default values report a `field` conflict (the later applies).
import { ConflictFields, ConflictKind, EntityKind, EventEnvelope, isKnown, isWithheld, upgradePayload } from '../events';
import { Hlc } from '../hlc';
import { stableId } from '../ids';
import { merge3 } from './textMerge';

export interface TextVersion {
  hlc: string;
  /** What the writer had seen: a version is concurrent with every later one whose base is below it. */
  base: string;
  value: string;
}

export interface EditMark {
  hlc: string;
  base: string;
}

export interface EntityState {
  ent: EntityKind;
  id: string;
  fields: Record<string, unknown>;
  /** HLC of the event that last set each field (dotted paths for object and map fields). */
  clocks: Record<string, string>;
  /** `base` of the event that last set each conflict-checked field (defaults to its own HLC). */
  bases?: Record<string, string>;
  /** HLC of the first create seen ('' while only patches arrived). */
  created: string;
  /** HLC of the trash in effect (absent when not trashed or revived). */
  trashed?: string;
  purged?: string;
  /** Highest HLC applied. */
  version: string;
  texts?: Record<string, TextVersion[]>;
  /** Conversations: messages appended to them (for trash-vs-edit). */
  edits?: EditMark[];
}

export interface ReduceResult {
  state: EntityState;
  /** Top-level fields whose value changed (plus 'trashed' / 'purged' for lifecycle changes). */
  changed: string[];
  conflicts: (ConflictFields & { id: string })[];
}

export interface MergeRules {
  objectFields: Partial<Record<EntityKind, string[]>>;
  mapFields: Partial<Record<EntityKind, string[]>>;
  textFields: Partial<Record<EntityKind, string[]>>;
  conflictFields: Partial<Record<EntityKind, string[]>>;
  /** Versions kept per text field (older ones fold into the oldest kept). */
  maxTextVersions: number;
  /** Edit marks kept per conversation. */
  maxEdits: number;
}

export const DEFAULT_RULES: MergeRules = {
  objectFields: { project: ['fingerprints'] },
  mapFields: { conversation: ['tags'], memory: ['tags'], project: ['paths', 'fingerprints.pathHash'], device: ['appVersions'] },
  textFields: { memory: ['body'], prompt_template: ['body'], instruction_file: ['body'] },
  conflictFields: { conversation: ['title'], context_item: ['items'] },
  maxTextVersions: 30,
  maxEdits: 50,
};

const DEFAULT_VALUES = new Set<unknown>([undefined, null, '', 'New chat']);
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const same = (a: unknown, b: unknown) => a === b || JSON.stringify(a) === JSON.stringify(b);

function getPath(o: Record<string, unknown>, p: string): unknown {
  let cur: unknown = o;
  for (const k of p.split('.')) {
    if (!isObj(cur)) {
      return undefined;
    }
    cur = cur[k];
  }
  return cur;
}

function setPath(o: Record<string, unknown>, p: string, v: unknown): void {
  const keys = p.split('.');
  let cur = o;
  for (const k of keys.slice(0, -1)) {
    if (!isObj(cur[k])) {
      cur[k] = {};
    }
    cur = cur[k] as Record<string, unknown>;
  }
  const last = keys[keys.length - 1];
  if (v === undefined) {
    delete cur[last];
  } else {
    cur[last] = v;
  }
}

const deviceOf = (h: string) => Hlc.device(h);
const maxHlc = (a: string, b: string) => (a > b ? a : b);

function clone(s: EntityState): EntityState {
  return {
    ...s,
    fields: structuredClone(s.fields),
    clocks: { ...s.clocks },
    ...(s.bases ? { bases: { ...s.bases } } : {}),
    ...(s.texts ? { texts: Object.fromEntries(Object.entries(s.texts).map(([k, v]) => [k, [...v]])) } : {}),
    ...(s.edits ? { edits: [...s.edits] } : {}),
  };
}

export function emptyState(ent: EntityKind, id: string): EntityState {
  return { ent, id, fields: {}, clocks: {}, created: '', version: '' };
}

function conflictId(ent: EntityKind, id: string, field: string, a: string, b: string): string {
  return stableId('cf', ent, id, field, a < b ? a : b, a < b ? b : a);
}

function conflict(ent: EntityKind, id: string, field: string, kind: ConflictKind, older: { value: unknown; hlc: string }, newer: { value: unknown; hlc: string }, applied: ConflictFields['applied']): ConflictFields & { id: string } {
  return {
    id: conflictId(ent, id, field, older.hlc, newer.hlc),
    entity: ent,
    entityId: id,
    field,
    kind,
    ours: { value: older.value, hlc: older.hlc, device: deviceOf(older.hlc) },
    theirs: { value: newer.value, hlc: newer.hlc, device: deviceOf(newer.hlc) },
    applied,
  };
}

/** Recomputes a text field from its versions (HLC order, 3-way merge for concurrent ones). */
function foldText(versions: TextVersion[], trigger?: string): { value: string | undefined; conflicts: { older: TextVersion; newer: TextVersion; current: string }[] } {
  let value: string | undefined;
  let clock = '';
  const computed: { hlc: string; value: string }[] = [];
  const conflicts: { older: TextVersion; newer: TextVersion; current: string }[] = [];
  for (const x of versions) {
    if (value === undefined || x.base >= clock) {
      value = x.value;
    } else {
      const baseText = [...computed].reverse().find((c) => c.hlc <= x.base)?.value ?? '';
      const m = merge3(baseText, value, x.value);
      if (m.conflict && (trigger === undefined || x.hlc === trigger || computed[computed.length - 1]?.hlc === trigger)) {
        conflicts.push({ older: versions.find((v) => v.hlc === clock) ?? x, newer: x, current: value });
      }
      value = m.text;
    }
    clock = x.hlc;
    computed.push({ hlc: x.hlc, value });
  }
  return { value, conflicts };
}

/** Whether a trash at `trash` (written having seen `trashBase`) and an edit are concurrent. */
function concurrentWithTrash(trash: string, trashBase: string, edit: EditMark): boolean {
  return edit.base < trash && trashBase < edit.hlc;
}

/** Sets `state.trashed` from the register and the edit marks; reports a revival caused by `trigger`. */
function settleTrash(s: EntityState, trigger?: string): (ConflictFields & { id: string }) | undefined {
  const at = s.fields.trashedAt;
  const clock = s.clocks.trashedAt;
  if (at === undefined || at === null || !clock) {
    delete s.trashed;
    return undefined;
  }
  const tb = s.bases?.trashedAt ?? clock;
  const reviver = (s.edits ?? []).find((m) => concurrentWithTrash(clock, tb, m));
  if (reviver) {
    delete s.trashed;
    if (trigger && (trigger === clock || trigger === reviver.hlc)) {
      return conflict(s.ent, s.id, 'trashedAt', 'trash-vs-edit', { value: at, hlc: clock }, { value: 'edited', hlc: reviver.hlc }, 'theirs');
    }
    return undefined;
  }
  s.trashed = clock;
  return undefined;
}

/**
 * Applies one event. Unknown entities or newer schema versions leave the state as it was (`changed` empty).
 */
export function reduce(prev: EntityState | undefined, e: EventEnvelope, rules: MergeRules = DEFAULT_RULES): ReduceResult {
  const base0 = prev ?? emptyState(e.ent, e.eid);
  if (base0.purged || !isKnown(e) || isWithheld(e)) {
    return { state: base0, changed: [], conflicts: [] };
  }
  const p = upgradePayload(e.ent, e.sv, e.p as Record<string, unknown>);
  if (!p) {
    return { state: base0, changed: [], conflicts: [] };
  }
  const s = clone(base0);
  const changed = new Set<string>();
  const conflicts: (ConflictFields & { id: string })[] = [];
  s.version = maxHlc(s.version, e.hlc);

  if (e.op === 'purge') {
    return { state: { ent: s.ent, id: s.id, fields: {}, clocks: {}, created: s.created, purged: e.hlc, version: s.version }, changed: ['purged'], conflicts: [] };
  }

  if (e.op === 'trash' || e.op === 'restore') {
    const wasTrashed = s.trashed;
    if (!s.clocks.trashedAt || e.hlc > s.clocks.trashedAt) {
      setPath(s.fields, 'trashedAt', e.op === 'trash' ? (typeof p.at === 'number' ? p.at : Hlc.physical(e.hlc)) : undefined);
      s.clocks.trashedAt = e.hlc;
      (s.bases ??= {}).trashedAt = e.base ?? e.hlc;
    }
    const c = settleTrash(s, e.hlc);
    if (c) {
      conflicts.push(c);
    }
    if (wasTrashed !== s.trashed) {
      changed.add('trashed');
    }
    return { state: s, changed: [...changed], conflicts };
  }

  if (e.op === 'create' && (!s.created || e.hlc < s.created)) {
    s.created = e.hlc;
  }
  const clocksIn = isObj(p.__clocks) ? (p.__clocks as Record<string, string>) : {};
  const basesIn = isObj(p.__bases) ? (p.__bases as Record<string, string>) : {};
  const objectFields = new Set(rules.objectFields[e.ent] ?? []);
  const mapFields = new Set(rules.mapFields[e.ent] ?? []);
  const textFields = new Set(rules.textFields[e.ent] ?? []);
  const conflictFields = new Set(rules.conflictFields[e.ent] ?? []);
  const top = (path: string) => path.split('.')[0];

  const lww = (path: string, value: unknown) => {
    const hlc = clocksIn[path] ?? e.hlc;
    const ebase = basesIn[path] ?? e.base ?? hlc;
    const cur = s.clocks[path];
    if (conflictFields.has(path) && cur && cur !== hlc) {
      const curBase = s.bases?.[path] ?? cur;
      // Neither writer had seen the other's value.
      const concurrent = ebase < cur && curBase < hlc;
      const curVal = getPath(s.fields, path);
      if (concurrent && deviceOf(cur) !== deviceOf(hlc) && !DEFAULT_VALUES.has(curVal) && !DEFAULT_VALUES.has(value) && !same(curVal, value)) {
        const older = hlc < cur ? { value, hlc } : { value: curVal, hlc: cur };
        const newer = hlc < cur ? { value: curVal, hlc: cur } : { value, hlc };
        conflicts.push(conflict(s.ent, s.id, path, 'field', older, newer, 'theirs'));
      }
    }
    if (!cur || hlc > cur) {
      if (!same(getPath(s.fields, path), value)) {
        changed.add(top(path));
      }
      setPath(s.fields, path, value === null ? undefined : value);
      s.clocks[path] = hlc;
      if (conflictFields.has(path) || path === 'trashedAt') {
        (s.bases ??= {})[path] = ebase;
      }
    }
  };

  const text = (path: string, value: unknown) => {
    if (typeof value !== 'string') {
      lww(path, value);
      return;
    }
    const hlc = clocksIn[path] ?? e.hlc;
    const versions = ((s.texts ??= {})[path] ??= []);
    if (versions.some((v) => v.hlc === hlc)) {
      return;
    }
    versions.push({ hlc, base: basesIn[path] ?? e.base ?? hlc, value });
    versions.sort((a, b) => (a.hlc < b.hlc ? -1 : 1));
    while (versions.length > rules.maxTextVersions) {
      // Fold the two oldest into one baseline that "saw everything" before it.
      const [a, b] = versions;
      const merged = foldText([a, b]).value ?? b.value;
      versions.splice(0, 2, { hlc: b.hlc, base: b.hlc, value: merged });
    }
    const before = getPath(s.fields, path);
    const r = foldText(versions, hlc);
    for (const c of r.conflicts) {
      conflicts.push(conflict(s.ent, s.id, path, 'text-merge', { value: c.current, hlc: c.older.hlc }, { value: c.newer.value, hlc: c.newer.hlc }, 'merged'));
    }
    setPath(s.fields, path, r.value);
    s.clocks[path] = versions[versions.length - 1].hlc;
    if (before !== r.value) {
      changed.add(top(path));
    }
  };

  const walk = (obj: Record<string, unknown>, prefix: string) => {
    for (const [k, v] of Object.entries(obj)) {
      if (!prefix && (k === '__clocks' || k === '__bases' || k === '__edits')) {
        continue;
      }
      const path = prefix ? `${prefix}.${k}` : k;
      if (objectFields.has(path) && isObj(v)) {
        walk(v, path);
      } else if (mapFields.has(path) && isObj(v)) {
        for (const [mk, mv] of Object.entries(v)) {
          lww(`${path}.${mk}`, mv);
        }
        if (!isObj(getPath(s.fields, path))) {
          setPath(s.fields, path, {});
        }
      } else if (textFields.has(path)) {
        text(path, v);
      } else {
        lww(path, v);
      }
    }
  };
  walk(p, '');

  // Compacted bases carry the conversation's edit marks.
  if (Array.isArray(p.__edits)) {
    for (const m of p.__edits as EditMark[]) {
      addEdit(s, m, rules);
    }
  }
  if ('trashedAt' in p || Array.isArray(p.__edits)) {
    const wasTrashed = s.trashed;
    const c = settleTrash(s, e.hlc);
    if (c) {
      conflicts.push(c);
    }
    if (wasTrashed !== s.trashed) {
      changed.add('trashed');
    }
  }
  return { state: s, changed: [...changed], conflicts };
}

function addEdit(s: EntityState, m: EditMark, rules: MergeRules): boolean {
  const edits = (s.edits ??= []);
  if (edits.some((x) => x.hlc === m.hlc)) {
    return false;
  }
  edits.push(m);
  edits.sort((a, b) => (a.hlc < b.hlc ? -1 : 1));
  if (edits.length > rules.maxEdits) {
    edits.splice(0, edits.length - rules.maxEdits);
  }
  return true;
}

/**
 * A message was appended to a conversation (`e` is the message's create event): records the edit mark and revives the
 * conversation when the message was written concurrently with its trash (`trash-vs-edit`).
 */
export function noteEdit(prev: EntityState | undefined, convId: string, e: Pick<EventEnvelope, 'hlc' | 'base'>, rules: MergeRules = DEFAULT_RULES): ReduceResult {
  const s = clone(prev ?? emptyState('conversation', convId));
  if (s.purged) {
    return { state: s, changed: [], conflicts: [] };
  }
  if (!addEdit(s, { hlc: e.hlc, base: e.base ?? e.hlc }, rules)) {
    return { state: s, changed: [], conflicts: [] };
  }
  s.version = maxHlc(s.version, e.hlc);
  const was = s.trashed;
  const c = settleTrash(s, e.hlc);
  return { state: s, changed: was !== s.trashed ? ['trashed'] : [], conflicts: c ? [c] : [] };
}

/** Effective trash time of an entity (undefined when not trashed, revived, or purged). */
export function trashedAt(s: EntityState | undefined): number | undefined {
  return s?.trashed && typeof s.fields.trashedAt === 'number' ? s.fields.trashedAt : undefined;
}

/**
 * Branch split (§9.4): of two messages appended after the same parent on the same branch by different devices, the one
 * with the later HLC keeps the branch; the other starts a device branch. Returns the loser.
 */
export function branchSplitLoser<T extends { hlc: string }>(a: T, b: T): T {
  return a.hlc > b.hlc ? b : a;
}

/** Deterministic id of the branch a split's losing message moves to. */
export function deviceBranchId(branchId: string, firstMessageId: string): string {
  return stableId('br', branchId, firstMessageId);
}
