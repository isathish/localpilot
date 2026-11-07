// The index engine (design §6): owns the sql.js database, catches up from the event log, rebuilds, persists and answers
// queries. Runs in a worker thread in the extension and the CLI (indexWorker.ts) and in-process in tests. Only the
// holder of `index/index.lease.json` writes `index.sqlite`; other processes keep their own in-memory copy and tail the
// streams. Pure Node + sql.js.
import * as fs from 'fs';
import * as path from 'path';
import type { SqlJsStatic } from 'sql.js';
import type { EntityKind, EventEnvelope, EventLoc } from '../../events';
import { Lease } from '../lease';
import { listSegments, readStreamDir } from '../segment';
import { streamLastSeq } from '../eventLog';
import { Applier } from './apply';
import { Db } from './db';
import * as Q from './queries';
import { createSchema, FtsKind, probeFts, SCHEMA_VERSION, userVersion } from './schema';

export type IndexState = 'loading' | 'catching-up' | 'rebuilding' | 'ready' | 'failed';

export interface IndexStatus {
  state: IndexState;
  progress?: number;
  events: number;
  bytes: number;
  fts: FtsKind;
  persisted?: number;
  error?: string;
  /** This process writes index.sqlite. */
  holder: boolean;
  skipped: number;
}

export interface AppliedNotice {
  events: number;
  /** Conversations touched by events from other processes or devices (remote changes). */
  remoteConversations: string[];
  remoteMemory: string[];
  remoteEntities: number;
  conflicts: number;
}

export interface EngineOptions {
  root: string;
  wasmPath?: string;
  deviceId: string;
  /** The stream this process writes (its events are not "remote"). */
  ownStream?: string;
  maxMB?: number;
  persistIntervalMs?: number;
  pollMs?: number;
  batch?: number;
  now?: () => number;
  log?: (level: 'info' | 'warn' | 'error', message: string) => void;
  onProgress?: (s: { state: IndexState; progress?: number; events: number }) => void;
  onApplied?: (n: AppliedNotice) => void;
  /** Watch the streams for other writers (fs.watch + poll). */
  watch?: boolean;
  sqlJs?: SqlJsStatic;
}

let sqlJsPromise: Promise<SqlJsStatic> | undefined;
/** Loads sql.js once per thread, with its wasm from `wasmPath` (dist/sqljs/sql-wasm.wasm in the packaged extension). */
export function loadSqlJs(wasmPath?: string): Promise<SqlJsStatic> {
  if (!sqlJsPromise) {
    const init = require('sql.js') as (o: { locateFile?: (f: string) => string; wasmBinary?: Uint8Array }) => Promise<SqlJsStatic>;
    const file = wasmPath || process.env.LOCALPILOT_SQLJS_WASM;
    sqlJsPromise = init(file ? { wasmBinary: fs.readFileSync(file) } : {});
    sqlJsPromise.catch(() => (sqlJsPromise = undefined));
  }
  return sqlJsPromise;
}

const DAY = 86_400_000;

export class IndexEngine {
  db!: Db;
  fts: FtsKind = 'fts4';
  state: IndexState = 'loading';
  private SQL!: SqlJsStatic;
  private readonly file: string;
  private readonly lease: Lease;
  private dirty = false;
  private lastPersist = 0;
  private progress?: number;
  private error?: string;
  private timer?: NodeJS.Timeout;
  private watcher?: fs.FSWatcher;
  private signature = '';
  private busy = false;
  private again = false;
  private skipped = 0;
  private readonly now: () => number;

  constructor(private readonly o: EngineOptions) {
    this.file = path.join(o.root, 'index', 'index.sqlite');
    this.lease = new Lease(path.join(o.root, 'index', 'index.lease.json'), { kind: 'index', now: o.now });
    this.now = o.now ?? Date.now;
  }

  private log(level: 'info' | 'warn' | 'error', m: string): void {
    this.o.log?.(level, m);
  }

  private setState(state: IndexState, progress?: number): void {
    this.state = state;
    this.progress = progress;
    this.o.onProgress?.({ state, progress, events: this.eventCount() });
  }

  async init(): Promise<void> {
    try {
      this.SQL = this.o.sqlJs ?? (await loadSqlJs(this.o.wasmPath));
      const probe = new Db(new this.SQL.Database());
      this.fts = probeFts(probe);
      probe.close();
      this.lease.tryClaim();
      if (!this.load()) {
        this.fresh();
        this.rebuildFromLogs();
      } else {
        this.catchUp();
      }
      this.setState('ready');
      this.persist(true);
      if (this.o.watch) {
        this.startWatching();
      }
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      this.log('error', `continuity index failed: ${this.error}`);
      this.setState('failed');
      throw e;
    }
  }

  /** Loads index.sqlite when it is valid and consistent with the logs; false = rebuild. */
  private load(): boolean {
    let buf: Buffer;
    try {
      buf = fs.readFileSync(this.file);
    } catch {
      return false;
    }
    try {
      const db = new Db(new this.SQL.Database(buf));
      const ok = db.raw.exec('PRAGMA quick_check')[0]?.values[0]?.[0] === 'ok';
      if (!ok || userVersion(db) !== SCHEMA_VERSION) {
        this.log('warn', `continuity index: ${ok ? `schema ${userVersion(db)} != ${SCHEMA_VERSION}` : 'integrity check failed'}; rebuilding from the log`);
        db.close();
        return false;
      }
      const fts = db.get<{ value: string }>("SELECT value FROM meta WHERE key = 'fts'")?.value;
      // A cursor ahead of its stream means the log was replaced or compacted under this index.
      for (const c of db.all<{ stream: string; last_seq: number }>('SELECT stream, last_seq FROM stream_cursors')) {
        if (streamLastSeq(path.join(this.o.root, 'streams', c.stream)) < c.last_seq) {
          this.log('warn', `continuity index: stream ${c.stream} is behind the index; rebuilding`);
          db.close();
          return false;
        }
      }
      this.db = db;
      this.fts = (fts as FtsKind) || this.fts;
      return true;
    } catch (e) {
      this.log('warn', `continuity index: ${String(e)}; rebuilding from the log`);
      return false;
    }
  }

  private fresh(): void {
    this.db?.close();
    this.db = new Db(new this.SQL.Database());
    createSchema(this.db, this.fts);
    this.dirty = true;
  }

  private streamDirs(): string[] {
    const dir = path.join(this.o.root, 'streams');
    try {
      return fs.readdirSync(dir).filter((s) => /^dev_[\w-]+\.\d+$/.test(s));
    } catch {
      return [];
    }
  }

  private eventCount(): number {
    try {
      return Number(this.db?.get<{ n: number }>('SELECT count(*) AS n FROM entity_events')?.n ?? 0);
    } catch {
      return 0;
    }
  }

  /**
   * Applies every event the index has not seen, all streams merged in HLC order, in transactions of `batch` events.
   * Returns how many were applied. Re-entrant calls are coalesced.
   */
  catchUp(): number {
    if (this.busy) {
      this.again = true;
      return 0;
    }
    this.busy = true;
    try {
      let total = 0;
      do {
        this.again = false;
        total += this.catchUpOnce();
      } while (this.again);
      return total;
    } finally {
      this.busy = false;
    }
  }

  private catchUpOnce(): number {
    const cursors = new Map(this.db.all<{ stream: string; last_seq: number }>('SELECT stream, last_seq FROM stream_cursors').map((r) => [r.stream, Number(r.last_seq)]));
    type Head = { it: Generator<{ e: EventEnvelope; loc: EventLoc }>; cur?: { e: EventEnvelope; loc: EventLoc }; stream: string };
    const heads: Head[] = [];
    let remaining = 0;
    for (const s of this.streamDirs()) {
      const dir = path.join(this.o.root, 'streams', s);
      const from = (cursors.get(s) ?? 0) + 1;
      const last = streamLastSeq(dir);
      if (last < from) {
        continue;
      }
      remaining += last - from + 1;
      const it = readStreamDir(dir, from);
      const h: Head = { it, stream: s };
      const n = it.next();
      if (!n.done) {
        h.cur = n.value;
        heads.push(h);
      }
    }
    if (!heads.length) {
      return 0;
    }
    const rebuilding = this.state === 'rebuilding';
    if (!rebuilding) {
      this.setState('catching-up', 0);
    }
    const batch = this.o.batch ?? 5000;
    const applier = new Applier(this.db, this.o.deviceId);
    let done = 0;
    const notice: AppliedNotice = { events: 0, remoteConversations: [], remoteMemory: [], remoteEntities: 0, conflicts: 0 };
    const remoteConvs = new Set<string>();
    const remoteMem = new Set<string>();
    const lastSeq = new Map<string, { seq: number; device: string }>();
    while (heads.length) {
      this.db.tx(() => {
        for (let i = 0; i < batch && heads.length; i++) {
          // The head with the lowest HLC goes next (per-stream order is kept: HLCs grow within a stream).
          let k = 0;
          for (let j = 1; j < heads.length; j++) {
            if (heads[j].cur!.e.hlc < heads[k].cur!.e.hlc) {
              k = j;
            }
          }
          const h = heads[k];
          const { e, loc } = h.cur!;
          try {
            applier.apply(e, loc);
          } catch (err) {
            this.skipped++;
            this.log('warn', `continuity index: skipped ${e.id}: ${String(err)}`);
          }
          if (e.stream !== this.o.ownStream) {
            notice.remoteEntities++;
            const conv = e.ent === 'conversation' ? e.eid : (e.p as { conversationId?: unknown }).conversationId;
            if (typeof conv === 'string' && (e.ent === 'conversation' || e.ent === 'message' || e.ent === 'branch')) {
              remoteConvs.add(conv);
            }
            if (e.ent === 'memory') {
              remoteMem.add(e.eid);
            }
          }
          lastSeq.set(h.stream, { seq: e.seq, device: e.dev });
          done++;
          const n = h.it.next();
          if (n.done) {
            heads.splice(k, 1);
          } else {
            h.cur = n.value;
          }
        }
        applier.flush();
        for (const [stream, v] of lastSeq) {
          this.db.run('INSERT OR REPLACE INTO stream_cursors (stream, device, last_seq, own) VALUES (?, ?, ?, ?)', [stream, v.device, v.seq, stream === this.o.ownStream ? 1 : 0]);
        }
      });
      this.dirty = true;
      const progress = remaining ? Math.min(1, done / remaining) : 1;
      this.o.onProgress?.({ state: rebuilding ? 'rebuilding' : 'catching-up', progress, events: done });
    }
    this.skipped += applier.stats.skipped;
    notice.events = done;
    notice.conflicts = applier.stats.conflicts;
    notice.remoteConversations = [...remoteConvs];
    notice.remoteMemory = [...remoteMem];
    if (!rebuilding) {
      this.setState('ready');
    }
    this.enforceCap();
    this.o.onApplied?.(notice);
    this.persist(false);
    return done;
  }

  private rebuildFromLogs(): void {
    this.setState('rebuilding', 0);
    const t0 = this.now();
    const n = this.catchUp();
    this.log('info', `continuity index rebuilt from the log: ${n} events in ${this.now() - t0} ms`);
  }

  /** Drops everything and replays every stream from seq 1. */
  rebuild(): void {
    this.fresh();
    this.rebuildFromLogs();
    this.setState('ready');
    this.persist(true);
  }

  /** Bytes of the database (page_count * page_size). */
  bytes(): number {
    try {
      const pc = Number(this.db.raw.exec('PRAGMA page_count')[0]?.values[0]?.[0] ?? 0);
      const ps = Number(this.db.raw.exec('PRAGMA page_size')[0]?.values[0]?.[0] ?? 0);
      return pc * ps;
    } catch {
      return 0;
    }
  }

  /**
   * The size cap (§12): past `maxMB`, searchable message text of archived and trashed conversations older than 180 days
   * is dropped (titles and summaries stay searchable).
   */
  enforceCap(maxMB = this.o.maxMB): number {
    if (!maxMB || this.bytes() <= maxMB * 1024 * 1024) {
      return 0;
    }
    const cutoff = this.now() - 180 * DAY;
    const ids = this.db.all<{ id: string }>('SELECT id FROM conversations WHERE text_dropped = 0 AND (archived = 1 OR trashed_at IS NOT NULL) AND updated_at < ?', [cutoff]).map((r) => r.id);
    if (!ids.length) {
      return 0;
    }
    this.db.tx(() => {
      for (const id of ids) {
        this.db.run('DELETE FROM message_fts WHERE rowid IN (SELECT rowid FROM messages WHERE conversation_id = ?)', [id]);
        this.db.run('UPDATE conversations SET text_dropped = 1 WHERE id = ?', [id]);
      }
    });
    try {
      this.db.exec('VACUUM');
    } catch {
      // not inside a transaction; best effort
    }
    this.dirty = true;
    this.log('info', `continuity index over ${maxMB} MB: older archived chats are searchable by title only (${ids.length})`);
    return ids.length;
  }

  /** Writes index.sqlite (tmp + rename) when this process holds the index lease. */
  persist(force: boolean): boolean {
    if (!this.dirty || this.state !== 'ready') {
      return false;
    }
    if (!force && this.now() - this.lastPersist < (this.o.persistIntervalMs ?? 60_000)) {
      return false;
    }
    if (!this.lease.isHeld && !this.lease.tryClaim()) {
      return false;
    }
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp-${process.pid}`;
      fs.writeFileSync(tmp, this.db.export());
      fs.renameSync(tmp, this.file);
      this.dirty = false;
      this.lastPersist = this.now();
      return true;
    } catch (e) {
      this.log('warn', `continuity index: could not save: ${String(e)}`);
      return false;
    }
  }

  private streamSignature(): string {
    return this.streamDirs()
      .map((s) => {
        const segs = listSegments(path.join(this.o.root, 'streams', s));
        const last = segs[segs.length - 1];
        let size = 0;
        try {
          size = last ? fs.statSync(last.file).size : 0;
        } catch {
          // vanished
        }
        return `${s}:${last?.segment ?? 0}:${size}`;
      })
      .join('|');
  }

  private startWatching(): void {
    this.signature = this.streamSignature();
    const poke = () => {
      const sig = this.streamSignature();
      if (sig !== this.signature) {
        this.signature = sig;
        try {
          this.catchUp();
        } catch (e) {
          this.log('warn', `continuity index catch-up: ${String(e)}`);
        }
      }
      this.persist(false);
    };
    this.timer = setInterval(poke, this.o.pollMs ?? 2000);
    this.timer.unref?.();
    try {
      let pending: NodeJS.Timeout | undefined;
      this.watcher = fs.watch(path.join(this.o.root, 'streams'), { recursive: true }, () => {
        if (!pending) {
          pending = setTimeout(() => {
            pending = undefined;
            poke();
          }, 100);
          pending.unref?.();
        }
      });
      this.watcher.on('error', () => this.watcher?.close());
      this.watcher.unref?.();
    } catch {
      // recursive watch unsupported here: the poll covers it
    }
  }

  status(): IndexStatus {
    return { state: this.state, progress: this.progress, events: this.eventCount(), bytes: this.bytes(), fts: this.fts, persisted: this.lastPersist || undefined, error: this.error, holder: this.lease.isHeld, skipped: this.skipped };
  }

  // ---- queries
  history(q: Q.IndexHistoryQuery): Q.IndexHistoryPage {
    return Q.history(this.db, q);
  }
  counts(projectId?: string): Q.NavCounts {
    return Q.counts(this.db, projectId);
  }
  search(q: Q.SearchQuery | string): Q.SearchHit[] {
    return Q.search(this.db, this.fts, q);
  }
  searchMemory(text: string, o: { projectId?: string; limit?: number } = {}): Q.SearchHit[] {
    return Q.searchMemory(this.db, this.fts, text, o);
  }
  conversation(id: string): Q.ConversationRow | undefined {
    return Q.conversation(this.db, id);
  }
  messages(conversationId: string, branchId?: string): Q.MessageRow[] {
    return Q.messages(this.db, conversationId, branchId);
  }
  branches(conversationId: string): Q.BranchRow[] {
    return Q.branches(this.db, conversationId);
  }
  memory(q: Q.MemoryQuery): Q.MemoryRow[] {
    return Q.memory(this.db, q);
  }
  versions(ent: EntityKind, id: string): Q.VersionRow[] {
    return Q.versions(this.db, ent, id);
  }
  query(name: Q.NamedQuery, params: Record<string, unknown>): unknown[] {
    if (!(Q.NAMED_QUERIES as readonly string[]).includes(name)) {
      throw new Error(`unknown query ${name}`);
    }
    return Q.named(this.db, name, params, this.fts);
  }
  /** Records a sync activity row (kept: last 500). */
  syncEvent(row: { at: number; kind: string; remote?: string; uploaded?: number; downloaded?: number; bytes?: number; error?: string }): void {
    this.db.run('INSERT INTO sync_events (at, kind, remote, uploaded, downloaded, bytes, error) VALUES (?, ?, ?, ?, ?, ?, ?)', [row.at, row.kind, row.remote ?? null, row.uploaded ?? null, row.downloaded ?? null, row.bytes ?? null, row.error ?? null]);
    this.db.run('DELETE FROM sync_events WHERE id <= (SELECT max(id) - 500 FROM sync_events)');
    this.dirty = true;
  }
  /** Removes version-history rows older than `days` (the window, §10). */
  pruneVersions(days: number): number {
    const cutoff = this.now() - days * DAY;
    const before = this.eventCount();
    // Keep each entity's newest row so a lone old version still points at its body.
    this.db.run('DELETE FROM entity_events WHERE at < ? AND hlc < (SELECT max(e2.hlc) FROM entity_events e2 WHERE e2.id = entity_events.id)', [cutoff]);
    this.dirty = true;
    return before - this.eventCount();
  }

  dispose(): void {
    clearInterval(this.timer);
    this.watcher?.close();
    try {
      if (this.state === 'ready') {
        this.persist(true);
      }
    } finally {
      this.lease.release();
      try {
        this.db?.close();
      } catch {
        // closed
      }
    }
  }
}
