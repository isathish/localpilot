// Full text of tool outputs that were cut to fit the context, so the model can read the rest with read_file.

export const CACHE_SCHEME = 'lp-cache://';
export const CACHE_EXPIRED = 'Cache expired. Make a new tool call; DO NOT repeat side-effecting commands.';

interface Entry {
  sid: string;
  id: string;
  text: string;
  bytes: number;
  /** The session iteration in which the entry was stored or last read. */
  seen: number;
}

/**
 * Per-session LRU of cut tool outputs. A session keeps at most `maxBytes`; an entry not read for `idleIterations`
 * agent iterations of its session expires. Sessions that stop iterating are bounded by a global cap of four sessions' worth.
 */
export class ToolResultCache {
  /** Insertion order is recency order: a read moves the entry to the end. */
  private readonly entries = new Map<string, Entry>();
  private readonly iteration = new Map<string, number>();
  private next = 1;

  constructor(
    private readonly maxBytes = 16 * 1024 * 1024,
    private readonly idleIterations = 5
  ) {}

  /** Stores `text` and returns its `lp-cache://<sid>/<id>.txt` reference. */
  put(sid: string, text: string): string {
    const safe = sid.replace(/[^\w.-]/g, '_') || 'session';
    const id = (this.next++).toString(36);
    const bytes = text.length * 2;
    if (bytes > this.maxBytes) {
      text = text.slice(0, Math.floor(this.maxBytes / 2));
    }
    this.entries.set(`${safe}/${id}`, { sid: safe, id, text, bytes: Math.min(bytes, this.maxBytes), seen: this.iteration.get(safe) ?? 0 });
    this.evict(safe);
    return `${CACHE_SCHEME}${safe}/${id}.txt`;
  }

  /** The stored text for a reference (or `<sid>/<id>` path), marking it used; undefined when unknown or expired. */
  get(ref: string): string | undefined {
    const key = parseCacheRef(ref);
    const e = key ? this.entries.get(key) : undefined;
    if (!e) {
      return undefined;
    }
    this.entries.delete(key!);
    e.seen = this.iteration.get(e.sid) ?? 0;
    this.entries.set(key!, e);
    return e.text;
  }

  /** Advances a session by one agent iteration and drops its entries idle for too long. */
  tick(sid: string): void {
    const safe = sid.replace(/[^\w.-]/g, '_') || 'session';
    const now = (this.iteration.get(safe) ?? 0) + 1;
    this.iteration.set(safe, now);
    for (const [k, e] of this.entries) {
      if (e.sid === safe && now - e.seen > this.idleIterations) {
        this.entries.delete(k);
      }
    }
  }

  /** Bytes held for a session (or in total). */
  size(sid?: string): number {
    let n = 0;
    for (const e of this.entries.values()) {
      if (sid === undefined || e.sid === sid) {
        n += e.bytes;
      }
    }
    return n;
  }

  clear(): void {
    this.entries.clear();
    this.iteration.clear();
  }

  private evict(sid: string): void {
    for (const [scope, cap] of [[sid, this.maxBytes], [undefined, this.maxBytes * 4]] as const) {
      let used = this.size(scope);
      for (const [k, e] of this.entries) {
        if (used <= cap) {
          break;
        }
        if (scope === undefined || e.sid === scope) {
          this.entries.delete(k);
          used -= e.bytes;
        }
      }
    }
  }
}

/** `<sid>/<id>` for an `lp-cache://<sid>/<id>.txt` reference; undefined for anything else. */
export function parseCacheRef(ref: string): string | undefined {
  const m = /^lp-cache:\/\/+([\w.-]+)\/([0-9a-z]+)(?:\.txt)?\/?$/i.exec(ref.trim());
  return m ? `${m[1]}/${m[2].toLowerCase()}` : undefined;
}

export function isCacheRef(p: string): boolean {
  return /^lp-cache:\/\//i.test(p.trim());
}

/** Shared by every run in this process (the VS Code extension host, or one CLI session). */
export const toolResultCache = new ToolResultCache();
