// Shapes shared by the SessionStore and continuity's SessionBridge (pure: no vscode).
import type { ChatMessage, Session } from '../types';

/** Why a chat's messages changed in a way that is not a plain append (continuity: the reason of the new branch). */
export type SaveHint = 'edit' | 'regenerate' | 'continue' | 'restore-version' | 'manual';

/** What a save looked like: message ids in order, a content fingerprint per message, and the summary fields. */
export interface SavedShape {
  ids: (string | undefined)[];
  hashes: string[];
  title: string;
  pinned: boolean;
  model: string;
}

/**
 * Continuity's hooks into the store (1.7, design §9.1). All optional; without a bridge the store behaves as in 1.6.
 * `prepare` runs synchronously on every save (stable message ids), `saved` just before the JSON is written (the log
 * goes first), `removing` decides what a delete means: a trashed or archived chat leaves this cache but stays in the
 * log; `delete` is the 1.6 removal (files, archive, checkpoints via onDidDelete).
 */
export interface SessionStoreBridge {
  prepare(s: Session): void;
  saved(s: Session, previous: SavedShape | undefined): void;
  removing(id: string, why: 'delete' | 'prune'): Promise<'trash' | 'archive' | 'delete'>;
}

/** Cheap content fingerprint of a message: length and tail of each part, so streaming growth and edits show. */
export function messageHash(m: ChatMessage): string {
  const c = m.content ?? '';
  const t = m.thinking ?? '';
  let h = 2166136261;
  const tail = c.slice(-256) + t.slice(-64);
  for (let i = 0; i < tail.length; i++) {
    h = Math.imul(h ^ tail.charCodeAt(i), 16777619);
  }
  const meta = m.meta ? JSON.stringify(m.meta).length : 0;
  const calls = (m.toolCalls ?? []).reduce((n, tc) => n + (tc.arguments?.length ?? 0) + tc.name.length, 0);
  return `${c.length}.${t.length}.${(h >>> 0).toString(36)}.${m.toolCalls?.length ?? 0}.${calls}.${m.images?.length ?? 0}.${meta}`;
}

