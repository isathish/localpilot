// A thin synchronous wrapper over a sql.js database: cached prepared statements (dropped on export, which frees them),
// row objects, transactions. Used only inside the index engine (worker thread or tests). Pure.
import type { BindParams, Database, SqlValue, Statement } from 'sql.js';

export type Row = Record<string, SqlValue>;

export class Db {
  private stmts = new Map<string, Statement>();
  private depth = 0;

  constructor(public raw: Database) {}

  private stmt(sql: string): Statement {
    let s = this.stmts.get(sql);
    if (!s) {
      s = this.raw.prepare(sql);
      this.stmts.set(sql, s);
    }
    return s;
  }

  run(sql: string, params?: BindParams): void {
    const s = this.stmt(sql);
    try {
      s.run(params);
    } finally {
      s.reset();
    }
  }

  all<T = Row>(sql: string, params?: BindParams): T[] {
    const s = this.stmt(sql);
    const out: T[] = [];
    try {
      if (params) {
        s.bind(params);
      }
      while (s.step()) {
        out.push(s.getAsObject() as T);
      }
    } finally {
      s.reset();
    }
    return out;
  }

  get<T = Row>(sql: string, params?: BindParams): T | undefined {
    const s = this.stmt(sql);
    try {
      if (params) {
        s.bind(params);
      }
      return s.step() ? (s.getAsObject() as T) : undefined;
    } finally {
      s.reset();
    }
  }

  exec(sql: string): void {
    this.raw.exec(sql);
  }

  tx<T>(fn: () => T): T {
    if (this.depth > 0) {
      return fn();
    }
    this.depth++;
    this.raw.exec('BEGIN');
    try {
      const r = fn();
      this.raw.exec('COMMIT');
      return r;
    } catch (e) {
      try {
        this.raw.exec('ROLLBACK');
      } catch {
        // already rolled back
      }
      throw e;
    } finally {
      this.depth--;
    }
  }

  /** Frees cached statements (before export or close). */
  reset(): void {
    for (const s of this.stmts.values()) {
      try {
        s.free();
      } catch {
        // freed already
      }
    }
    this.stmts.clear();
  }

  export(): Uint8Array {
    this.reset();
    return this.raw.export();
  }

  close(): void {
    this.reset();
    this.raw.close();
  }
}
