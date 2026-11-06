// Keeps the last run traces of each chat (src/telemetry/runTrace.ts) in `<storage>/traces/<sessionId>.json`, next to
// the sessions folder, so "Trace" under an answer still works after a reload. Local only. Pure Node: no vscode.
import * as fs from 'fs';
import * as path from 'path';
import type { RunTrace } from './runTrace';

/** Traces kept per chat: older runs drop off. */
export const TRACES_PER_CHAT = 20;

export class TraceStore {
  private readonly cache = new Map<string, RunTrace[]>();
  private readonly chains = new Map<string, Promise<void>>();

  /** `dir` undefined: memory only (virtual workspaces, tests). */
  constructor(private readonly dir: string | undefined, private readonly perChat = TRACES_PER_CHAT) {}

  private file(sessionId: string): string | undefined {
    // Session ids are generated (`s_…`), but never let one name a path outside the folder.
    return this.dir && /^[\w.-]+$/.test(sessionId) && !sessionId.startsWith('.') ? path.join(this.dir, `${sessionId}.json`) : undefined;
  }

  private async read(sessionId: string): Promise<RunTrace[]> {
    const hit = this.cache.get(sessionId);
    if (hit) {
      return hit;
    }
    const f = this.file(sessionId);
    let list: RunTrace[] = [];
    if (f) {
      try {
        const raw = JSON.parse(await fs.promises.readFile(f, 'utf8')) as unknown;
        list = Array.isArray(raw) ? (raw as RunTrace[]).filter((t) => t && typeof t.id === 'string' && Array.isArray(t.entries)) : [];
      } catch {
        list = [];
      }
    }
    // A save may have filled the cache while the file was read.
    const now = this.cache.get(sessionId);
    if (now) {
      return now;
    }
    this.cache.set(sessionId, list);
    return list;
  }

  /** Adds (or replaces, by id) a finished trace and writes the chat's file. */
  async add(trace: RunTrace): Promise<void> {
    const list = await this.read(trace.sessionId);
    const i = list.findIndex((t) => t.id === trace.id);
    if (i >= 0) {
      list[i] = trace;
    } else {
      list.push(trace);
    }
    if (list.length > this.perChat) {
      list.splice(0, list.length - this.perChat);
    }
    await this.write(trace.sessionId);
  }

  private write(sessionId: string): Promise<void> {
    const f = this.file(sessionId);
    if (!f) {
      return Promise.resolve();
    }
    const prev = this.chains.get(sessionId) ?? Promise.resolve();
    const next = prev.then(async () => {
      const list = this.cache.get(sessionId);
      if (!list) {
        return;
      }
      await fs.promises.mkdir(path.dirname(f), { recursive: true });
      const tmp = `${f}.${process.pid}.tmp`;
      await fs.promises.writeFile(tmp, JSON.stringify(list), 'utf8');
      await fs.promises.rename(tmp, f);
    }).catch(() => undefined);
    this.chains.set(sessionId, next);
    return next;
  }

  async get(sessionId: string, traceId: string): Promise<RunTrace | undefined> {
    return (await this.read(sessionId)).find((t) => t.id === traceId);
  }

  /** The chat's traces, newest last. */
  async list(sessionId: string): Promise<RunTrace[]> {
    return [...(await this.read(sessionId))];
  }

  /** The chat was deleted: its traces go with it. */
  async forget(sessionId: string): Promise<void> {
    this.cache.delete(sessionId);
    await this.chains.get(sessionId);
    this.chains.delete(sessionId);
    const f = this.file(sessionId);
    if (f) {
      await fs.promises.rm(f, { force: true }).catch(() => undefined);
    }
  }
}
