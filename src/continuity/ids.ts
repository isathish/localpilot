// Stable ids for continuity entities (design §3). ULIDs for new entities (sortable by creation time, unique without
// coordination, safe in file names and git ref names) and deterministic ids for entities derived from existing data
// (migration, notes from files), so the same input always yields the same id on every device and every re-run.
// Pure Node: no vscode.
import * as crypto from 'crypto';

export type IdPrefix = 'm' | 'br' | 'prj' | 'mem' | 'ctx' | 'cxl' | 'att' | 'as' | 'ex' | 'cp' | 'ms' | 'pt' | 'ins' | 'pref' | 'dev' | 'cf';

/** Crockford base32, upper case: ULIDs. */
const ULID_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
/** Same alphabet in lower case for deterministic ids, so `idTime` can tell the two apart. */
const STABLE_ALPHABET = ULID_ALPHABET.toLowerCase();

let lastTime = -1;
let lastRandom: number[] = [];

function encodeTime(ms: number): string {
  let out = '';
  let t = Math.max(0, Math.floor(ms));
  for (let i = 0; i < 10; i++) {
    out = ULID_ALPHABET[t % 32] + out;
    t = Math.floor(t / 32);
  }
  return out;
}

/** 16 base32 digits of randomness; within one millisecond the previous value plus one (monotonic). */
function randomDigits(ms: number): number[] {
  if (ms === lastTime && lastRandom.length) {
    const next = [...lastRandom];
    for (let i = next.length - 1; i >= 0; i--) {
      if (next[i] < 31) {
        next[i]++;
        break;
      }
      next[i] = 0;
    }
    lastRandom = next;
    return next;
  }
  const bytes = crypto.randomBytes(16);
  lastTime = ms;
  lastRandom = [...bytes].map((b) => b & 31);
  // Keep headroom for increments within the same millisecond.
  lastRandom[0] &= 15;
  return lastRandom;
}

/** A 26-character ULID (10 time digits + 16 random digits). */
export function ulid(now = Date.now()): string {
  const ms = Math.floor(now);
  return encodeTime(ms) + randomDigits(ms).map((d) => ULID_ALPHABET[d]).join('');
}

/** `<prefix>_<ULID>`. */
export function newId(prefix: IdPrefix, now?: number): string {
  return `${prefix}_${ulid(now ?? Date.now())}`;
}

/** sha256 of the parts (joined with NUL) as 26 lower-case base32 digits. */
export function hash26(...parts: string[]): string {
  const digest = crypto.createHash('sha256').update(parts.join('\0')).digest();
  let bits = 0;
  let value = 0;
  let out = '';
  for (const b of digest) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5 && out.length < 26) {
      out += STABLE_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
    value &= (1 << bits) - 1;
    if (out.length >= 26) {
      break;
    }
  }
  return out;
}

/** `<prefix>_<hash26(parts)>`: the same parts give the same id everywhere. */
export function stableId(prefix: IdPrefix, ...parts: string[]): string {
  return `${prefix}_${hash26(...parts)}`;
}

/** Creation time of a ULID-based id; undefined for deterministic ids and anything else. */
export function idTime(id: string): number | undefined {
  const m = /_([0-9A-HJKMNP-TV-Z]{26})$/.exec(id);
  if (!m) {
    return undefined;
  }
  let t = 0;
  for (const ch of m[1].slice(0, 10)) {
    t = t * 32 + ULID_ALPHABET.indexOf(ch);
  }
  return t;
}

/** Safe as an entity id and inside file names: word characters, dots and dashes, no leading dot, at most 120 chars. */
export function isEntityId(id: unknown): id is string {
  return typeof id === 'string' && /^[\w.-]{1,120}$/.test(id) && !id.startsWith('.');
}

/** The id of a conversation's main branch (deterministic, design §3). */
export function mainBranchId(conversationId: string): string {
  return `br_${conversationId}`;
}
