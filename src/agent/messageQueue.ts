/** A message the user asked to send once the current turn ends (as opposed to a steer, which the running loop reads). */
export interface QueuedMessage {
  id: string;
  text: string;
  attachments: string[];
  images?: string[];
}

/** One row of the queue banner: a pending steer of the running turn, or a message waiting for the turn to end. */
export interface QueueRow {
  id: string;
  kind: 'steer' | 'after';
  text: string;
}

/** Per-session FIFO of messages to send after the turn in flight; each one starts its own turn, exactly once. */
export class MessageQueue {
  private readonly bySession = new Map<string, QueuedMessage[]>();
  private seq = 0;

  add(sessionId: string, msg: Omit<QueuedMessage, 'id'>, front = false): QueuedMessage {
    const item: QueuedMessage = { ...msg, id: `q_${Date.now().toString(36)}${(this.seq++).toString(36)}` };
    const list = this.bySession.get(sessionId) ?? [];
    if (front) {
      list.unshift(item);
    } else {
      list.push(item);
    }
    this.bySession.set(sessionId, list);
    return item;
  }

  list(sessionId: string): readonly QueuedMessage[] {
    return this.bySession.get(sessionId) ?? [];
  }

  remove(sessionId: string, id: string): QueuedMessage | undefined {
    const list = this.bySession.get(sessionId);
    const i = list ? list.findIndex((m) => m.id === id) : -1;
    if (!list || i < 0) {
      return undefined;
    }
    const [removed] = list.splice(i, 1);
    if (!list.length) {
      this.bySession.delete(sessionId);
    }
    return removed;
  }

  /** Takes the oldest message for the next turn; it is gone from the queue afterwards, so it can only run once. */
  shift(sessionId: string): QueuedMessage | undefined {
    const list = this.bySession.get(sessionId);
    const next = list?.shift();
    if (list && !list.length) {
      this.bySession.delete(sessionId);
    }
    return next;
  }

  clear(sessionId: string): void {
    this.bySession.delete(sessionId);
  }
}

/** Banner label, e.g. "2 queued · 1 steering"; empty when nothing waits. */
export function queueLabel(rows: readonly QueueRow[]): string {
  const after = rows.filter((r) => r.kind === 'after').length;
  const steering = rows.length - after;
  return [after ? `${after} queued` : '', steering ? `${steering} steering` : ''].filter(Boolean).join(' · ');
}

/**
 * Splits a CLI line typed during a run: `>> text` waits for the turn to end, `/queue` and `/queue rm N` manage the
 * queue, anything else steers the running agent.
 */
export function parseRunLine(line: string): { kind: 'steer'; text: string } | { kind: 'after'; text: string } | { kind: 'list' } | { kind: 'remove'; index: number } | { kind: 'queueUsage' } {
  const t = line.trim();
  if (t.startsWith('>>')) {
    return { kind: 'after', text: t.slice(2).trim() };
  }
  const q = /^\/queue(?:\s+(.*))?$/.exec(t);
  if (q) {
    const arg = (q[1] ?? '').trim();
    if (!arg || arg === 'list' || arg === 'ls') {
      return { kind: 'list' };
    }
    const rm = /^(?:rm|remove|del)\s+(\d+)$/.exec(arg);
    return rm ? { kind: 'remove', index: Number(rm[1]) } : { kind: 'queueUsage' };
  }
  return { kind: 'steer', text: t };
}
