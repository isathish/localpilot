// Secure share (design §15): a conversation exported to a `.lpshare` file sealed with a random key. The key travels
// separately as a 52-character share code (base32 of 32 bytes), shown once. Before sealing, the text is scanned for
// secrets (`scanText(…, { secrets: true })`) and the user chooses Redact or Keep. Opening needs the file and the code.
// Pure Node.
import * as crypto from 'crypto';
import type { Session } from '../../types';
import { scanText } from '../../security/scan';
import { open as openSealed, seal, SealError } from '../data/crypto/envelope';
import type { DataKey } from '../data/crypto/keyring';
import { ConversationExport, exportJson, parseExport } from './export';

export const SHARE_MAGIC = 'LPSH1\n';
const OBJECT_KEY = 'localpilot-share';
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export class WrongShareCodeError extends Error {
  constructor() {
    super('This code does not open the shared conversation (check that it was copied completely).');
    this.name = 'WrongShareCodeError';
  }
}

export function base32(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const b of buf) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    out += B32[(value << (5 - bits)) & 31];
  }
  return out;
}

export function fromBase32(s: string): Buffer {
  const clean = s.toUpperCase().replace(/[\s-]/g, '').replace(/=+$/, '');
  const bytes: number[] = [];
  let bits = 0;
  let value = 0;
  for (const ch of clean) {
    const v = B32.indexOf(ch);
    if (v < 0) {
      throw new WrongShareCodeError();
    }
    value = (value << 5) | v;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

function keyOf(raw: Buffer): DataKey {
  return { keyId: crypto.createHash('sha256').update(raw).digest('hex').slice(0, 32), dek: raw };
}

/** Groups of four for reading aloud / copying (`ABCD-EFGH-…`); the parser ignores the dashes. */
export function formatCode(code: string): string {
  return code.match(/.{1,4}/g)!.join('-');
}

export interface SecretHit {
  line: number;
  title: string;
}

/** Secrets in a conversation's text (what Redact would remove). */
export function findSecrets(s: Session): SecretHit[] {
  const text = s.messages.map((m) => `${m.content ?? ''}\n${(m.toolCalls ?? []).map((t) => t.arguments).join('\n')}`).join('\n');
  return scanText('conversation.txt', text, { secrets: true, code: false }).map((f) => ({ line: f.line ?? 0, title: f.title }));
}

const TOKENISH = /[A-Za-z0-9_\-+/=.]{16,}/g;

/** Masks secret-looking values on lines the scanner flagged (the rest of the text is kept). */
export function redactSecrets(s: Session): { session: Session; redacted: number } {
  let redacted = 0;
  const fix = (text: string): string => {
    const hits = scanText('conversation.txt', text, { secrets: true, code: false });
    if (!hits.length) {
      return text;
    }
    const lines = text.split('\n');
    for (const h of hits) {
      const i = (h.line ?? 1) - 1;
      if (lines[i] !== undefined) {
        lines[i] = lines[i].replace(TOKENISH, () => {
          redacted++;
          return '[REDACTED]';
        });
      }
    }
    return lines.join('\n');
  };
  const session: Session = {
    ...s,
    messages: s.messages.map((m) => ({ ...m, content: fix(m.content ?? ''), ...(m.toolCalls ? { toolCalls: m.toolCalls.map((t) => ({ ...t, arguments: fix(t.arguments ?? '') })) } : {}) })),
  };
  return { session, redacted };
}

/** Seals a conversation: the file bytes and the share code (shown once; not stored anywhere). */
export function createShare(s: Session, o: { now?: number } = {}): { data: Buffer; code: string } {
  const raw = crypto.randomBytes(32);
  const json = exportJson({ ...s, worktree: undefined, runningSince: undefined }, { now: o.now });
  const sealed = seal(keyOf(raw), OBJECT_KEY, json);
  return { data: Buffer.concat([Buffer.from(SHARE_MAGIC, 'ascii'), sealed]), code: base32(raw) };
}

export function isShareFile(data: Uint8Array): boolean {
  return Buffer.from(data.subarray(0, SHARE_MAGIC.length)).toString('ascii') === SHARE_MAGIC;
}

/** Opens a `.lpshare` with its code; throws WrongShareCodeError for a wrong or mistyped code. */
export function openShare(data: Uint8Array, code: string): ConversationExport {
  if (!isShareFile(data)) {
    throw new Error('not a LocalPilot share file (.lpshare)');
  }
  const raw = fromBase32(code);
  if (raw.length !== 32) {
    throw new WrongShareCodeError();
  }
  let plain: Buffer;
  try {
    plain = openSealed([keyOf(raw)], OBJECT_KEY, Buffer.from(data).subarray(SHARE_MAGIC.length));
  } catch (e) {
    if (e instanceof SealError) {
      throw new WrongShareCodeError();
    }
    throw e;
  }
  return parseExport(plain.toString('utf8'));
}
