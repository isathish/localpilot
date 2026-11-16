// Loads sql.js once per thread. Shared by the continuity index and the secret store (src/secrets/store.ts), so the
// wasm is compiled once even when both are open.
import * as fs from 'fs';
import type { SqlJsStatic } from 'sql.js';

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
