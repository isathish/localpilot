/**
 * Fake toolchains for the self-healing end-to-end tests: tiny node programs that print real-format tsc / jest output
 * depending on file contents, so no compiler or test runner is needed. Each program is a self-contained function that
 * is serialised into the fixture with its config baked in (absolute paths as the test sees them, so the classifier's
 * workspace-relative paths match even where the temp folder is a symlink). Every run appends one JSON line to a log
 * outside the workspace: tool, arguments, start/end time, status and per-suite results.
 */

export interface ToolRun {
  tool: string;
  args: string[];
  pid: number;
  start: number;
  end?: number;
  status?: 'pass' | 'fail';
  results?: Record<string, 'pass' | 'fail'>;
}

export interface TscConfig {
  dir: string;
  log: string;
  /** Files (relative to `dir`) checked for the token `BUG`. */
  files: string[];
}

/** `tsc --noEmit`: every line with `BUG` is a TS2345 error at that position. */
export function fakeTsc(cfg: TscConfig): void {
  const fs = require('fs') as typeof import('fs');
  const path = require('path') as typeof import('path');
  const start = Date.now();
  const out: string[] = [];
  for (const rel of cfg.files) {
    let text = '';
    try {
      text = fs.readFileSync(path.join(cfg.dir, rel), 'utf8');
    } catch {
      continue;
    }
    text.split('\n').forEach((line, i) => {
      const col = line.indexOf('BUG');
      if (col >= 0) {
        out.push(`${path.join(cfg.dir, rel)}(${i + 1},${col + 1}): error TS2345: Argument of type 'string' is not assignable to parameter of type 'number'.`);
      }
    });
  }
  const failed = out.length > 0;
  if (failed) {
    process.stdout.write(`${out.join('\n')}\n\nFound ${out.length} error${out.length === 1 ? '' : 's'}.\n`);
  }
  fs.appendFileSync(cfg.log, `${JSON.stringify({ tool: 'tsc', args: process.argv.slice(2), pid: process.pid, start, end: Date.now(), status: failed ? 'fail' : 'pass' })}\n`);
  process.exit(failed ? 2 : 0);
}

export interface JestSuite {
  /** Test file, relative to the fixture folder. */
  test: string;
  /** Source files whose change makes this suite "related" (`--findRelatedTests`). */
  impl: string[];
  /** `describe › test` as jest prints it. */
  name: string;
  /** The suite passes when `file` matches the `pass` regex. */
  file: string;
  pass: string;
  message: string;
  expected?: string;
  received?: string;
  /** Stack frames `file:line:col`, relative to the fixture folder. */
  frames: string[];
}

export interface JestConfig {
  dir: string;
  log: string;
  suites: JestSuite[];
  /** Keeps the process alive this long, so overlapping runs would show in the log. */
  holdMs: number;
}

/** `jest` / `jest --findRelatedTests <files>` with jest's FAIL / ● output; absolute paths like `--rootDir` absolute. */
export function fakeJest(cfg: JestConfig): void {
  const fs = require('fs') as typeof import('fs');
  const path = require('path') as typeof import('path');
  const start = Date.now();
  const args = process.argv.slice(2);
  const at = args.indexOf('--findRelatedTests');
  const related = at >= 0 ? args.slice(at + 1).map((f) => f.replace(/\\/g, '/').replace(/^\.\//, '')) : undefined;
  const suites = cfg.suites.filter((s) => !related || related.some((f) => f === s.test || s.impl.includes(f)));
  const results: Record<string, 'pass' | 'fail'> = {};
  const out: string[] = [];
  let failed = 0;
  for (const s of suites) {
    let text = '';
    try {
      text = fs.readFileSync(path.join(cfg.dir, s.file), 'utf8');
    } catch {
      text = '';
    }
    const ok = new RegExp(s.pass).test(text);
    results[s.name] = ok ? 'pass' : 'fail';
    const abs = path.join(cfg.dir, s.test);
    if (ok) {
      out.push(`PASS ${abs}`);
      continue;
    }
    failed++;
    out.push(`FAIL ${abs}`, `  ● ${s.name}`, '', `    ${s.message}`, '');
    if (s.expected !== undefined) {
      out.push(`    Expected: ${s.expected}`, `    Received: ${s.received ?? ''}`, '');
    }
    for (const f of s.frames) {
      out.push(`      at Object.<anonymous> (${path.join(cfg.dir, f)})`);
    }
    out.push('');
  }
  out.push(`Tests:       ${failed ? `${failed} failed, ` : ''}${suites.length - failed} passed, ${suites.length} total`);
  setTimeout(() => {
    process.stdout.write(`${out.join('\n')}\n`);
    fs.appendFileSync(cfg.log, `${JSON.stringify({ tool: 'jest', args, pid: process.pid, start, end: Date.now(), status: failed ? 'fail' : 'pass', results })}\n`);
    process.exit(failed ? 1 : 0);
  }, cfg.holdMs);
}

export interface RequireTestConfig {
  dir: string;
  log: string;
  /** Module under test and its test file (relative to `dir`). */
  module: string;
  test: string;
}

/** Loads the module under test; a missing package fails the way jest reports "Test suite failed to run". */
export function fakeRequireTest(cfg: RequireTestConfig): void {
  const fs = require('fs') as typeof import('fs');
  const path = require('path') as typeof import('path');
  const start = Date.now();
  let failure: string | undefined;
  try {
    require(path.join(cfg.dir, cfg.module));
  } catch (e) {
    const m = /Cannot find module '([^']+)'/.exec(e instanceof Error ? e.message : String(e));
    failure = m ? `Cannot find module '${m[1]}' from '${cfg.module}'` : String(e);
  }
  if (failure) {
    process.stdout.write([`FAIL ${path.join(cfg.dir, cfg.test)}`, '  ● Test suite failed to run', '', `    ${failure}`, '', `      at Object.<anonymous> (${path.join(cfg.dir, cfg.module)}:1:18)`, '', 'Tests:       0 total', ''].join('\n'));
  } else {
    process.stdout.write(`PASS ${path.join(cfg.dir, cfg.test)}\nTests:       1 passed, 1 total\n`);
  }
  fs.appendFileSync(cfg.log, `${JSON.stringify({ tool: 'require-test', args: process.argv.slice(2), pid: process.pid, start, end: Date.now(), status: failure ? 'fail' : 'pass' })}\n`);
  process.exit(failure ? 1 : 0);
}

export interface PassConfig {
  log: string;
  tool: string;
}

/** A check that always passes (the regression suite of the TypeScript fixture). */
export function fakePass(cfg: PassConfig): void {
  const fs = require('fs') as typeof import('fs');
  const start = Date.now();
  process.stdout.write('  1 passing (3ms)\n');
  fs.appendFileSync(cfg.log, `${JSON.stringify({ tool: cfg.tool, args: process.argv.slice(2), pid: process.pid, start, end: Date.now(), status: 'pass' })}\n`);
  process.exit(0);
}

export interface SlowConfig {
  log: string;
  pidFile: string;
  seconds: number;
}

/** A check that takes far longer than the test waits: it records its pid, then sleeps. */
export function fakeSlow(cfg: SlowConfig): void {
  const fs = require('fs') as typeof import('fs');
  const start = Date.now();
  fs.appendFileSync(cfg.log, `${JSON.stringify({ tool: 'slow', args: process.argv.slice(2), pid: process.pid, start })}\n`);
  fs.writeFileSync(cfg.pidFile, String(process.pid));
  setTimeout(() => {
    fs.appendFileSync(cfg.log, `${JSON.stringify({ tool: 'slow', args: process.argv.slice(2), pid: process.pid, start, end: Date.now(), status: 'pass' })}\n`);
    process.exit(0);
  }, cfg.seconds * 1000);
}

/** A node script (with shebang, for `node_modules/.bin`) that runs `program` with its config. */
export function script<T>(program: (cfg: T) => void, cfg: T): string {
  return `#!/usr/bin/env node\n'use strict';\n(${program.toString()})(${JSON.stringify(cfg)});\n`;
}
