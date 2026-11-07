// Minimal typings for the parts of sql.js (https://sql.js.org) the continuity index uses. sql.js ships no types and
// @types/sql.js is not a dependency (the only new dependency of 1.7 is sql.js itself).
declare module 'sql.js' {
  export type SqlValue = number | string | Uint8Array | null;
  export type BindParams = SqlValue[] | Record<string, SqlValue>;
  export interface QueryExecResult {
    columns: string[];
    values: SqlValue[][];
  }
  export interface Statement {
    bind(values?: BindParams): boolean;
    step(): boolean;
    get(params?: BindParams): SqlValue[];
    getAsObject(params?: BindParams): Record<string, SqlValue>;
    getColumnNames(): string[];
    run(values?: BindParams): void;
    reset(): boolean;
    free(): boolean;
  }
  export interface Database {
    run(sql: string, params?: BindParams): Database;
    exec(sql: string, params?: BindParams): QueryExecResult[];
    prepare(sql: string, params?: BindParams): Statement;
    export(): Uint8Array;
    close(): void;
    getRowsModified(): number;
  }
  export interface SqlJsStatic {
    Database: new (data?: ArrayLike<number> | Buffer | null) => Database;
  }
  export interface InitOptions {
    locateFile?: (file: string) => string;
    wasmBinary?: ArrayBuffer | Uint8Array;
  }
  function initSqlJs(config?: InitOptions): Promise<SqlJsStatic>;
  export default initSqlJs;
}
