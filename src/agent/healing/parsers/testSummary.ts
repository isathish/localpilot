import { parseDotnet } from './dotnet';
import { parseGo } from './go';
import { parseJsTest } from './jsTest';
import { parseJvm } from './jvm';
import { parsePython } from './python';
import { parseRust } from './rust';
import { lines, type ParsedFailure } from './common';

/** One failing test as the chat lists it: name, where (workspace-relative) and the first line of the error. */
export interface TestFailureRow {
  name: string;
  file?: string;
  line?: number;
  message: string;
}

/** Counts of a test run read from the runner's summary line, with the failing tests the healing parsers found. */
export interface TestSummary {
  passed: number;
  failed: number;
  skipped: number;
  /** The runner the summary came from (jest, vitest, mocha, pytest, go, cargo, dotnet, junit, node). */
  runner: string;
  failures: TestFailureRow[];
}

const MAX_ROWS = 20;
const num = (s: string | undefined): number => (s ? Number(s.replace(/,/g, '')) || 0 : 0);

/** Counts from the last summary line any of the common runners print, or undefined when the output has none. */
function counts(text: string): Omit<TestSummary, 'failures'> | undefined {
  const ls = lines(text);
  let found: Omit<TestSummary, 'failures'> | undefined;
  for (const l of ls) {
    const t = l.trim();
    let m: RegExpExecArray | null;
    // Jest: "Tests:       1 failed, 2 skipped, 6 passed, 9 total"; vitest: "Tests  1 failed | 6 passed (7)".
    if ((m = /^Tests:?\s+(.*?)(?:,\s*\d+ total|\s*\(\d+\))?\s*$/.exec(t)) && /\b(passed|failed)\b/.test(m[1])) {
      const p = /(\d+) passed/.exec(m[1]), f = /(\d+) failed/.exec(m[1]), s = /(\d+) (?:skipped|todo|pending)/.exec(m[1]);
      found = { passed: num(p?.[1]), failed: num(f?.[1]), skipped: num(s?.[1]), runner: /\|/.test(m[1]) ? 'vitest' : 'jest' };
      continue;
    }
    // pytest: "===== 1 failed, 6 passed, 2 skipped in 0.12s =====" or a bare "6 passed in 0.12s".
    if ((m = /^=*\s*((?:\d+ (?:passed|failed|skipped|xfailed|xpassed|errors?|deselected|warnings?)(?:, )?)+) in [\d.]+s/.exec(t))) {
      const p = /(\d+) passed/.exec(m[1]), f = /(\d+) failed/.exec(m[1]), e = /(\d+) errors?/.exec(m[1]), s = /(\d+) skipped/.exec(m[1]);
      found = { passed: num(p?.[1]), failed: num(f?.[1]) + num(e?.[1]), skipped: num(s?.[1]), runner: 'pytest' };
      continue;
    }
    // mocha: "6 passing (12ms)", "1 failing", "2 pending" on separate lines.
    if ((m = /^(\d+) passing\b/.exec(t))) {
      found = { passed: num(m[1]), failed: 0, skipped: 0, runner: 'mocha' };
      continue;
    }
    if (found?.runner === 'mocha' && (m = /^(\d+) (failing|pending)\b/.exec(t))) {
      if (m[2] === 'failing') {
        found.failed = num(m[1]);
      } else {
        found.skipped = num(m[1]);
      }
      continue;
    }
    // cargo: "test result: FAILED. 6 passed; 1 failed; 0 ignored; …" (one per test binary: summed).
    if ((m = /^test result: \w+\. (\d+) passed; (\d+) failed; (\d+) ignored/.exec(t))) {
      const prev = found?.runner === 'cargo' ? found : { passed: 0, failed: 0, skipped: 0, runner: 'cargo' };
      found = { passed: prev.passed + num(m[1]), failed: prev.failed + num(m[2]), skipped: prev.skipped + num(m[3]), runner: 'cargo' };
      continue;
    }
    // dotnet: "Failed!  - Failed:     1, Passed:     6, Skipped:     0, Total:     7".
    if ((m = /(?:Passed|Failed)!\s*-\s*Failed:\s*(\d+),\s*Passed:\s*(\d+),\s*Skipped:\s*(\d+)/.exec(t))) {
      found = { passed: num(m[2]), failed: num(m[1]), skipped: num(m[3]), runner: 'dotnet' };
      continue;
    }
    // Maven/Gradle surefire: "Tests run: 7, Failures: 1, Errors: 0, Skipped: 0" (the last one is the total).
    if ((m = /Tests run: (\d+), Failures: (\d+), Errors: (\d+), Skipped: (\d+)/.exec(t))) {
      const run = num(m[1]), failed = num(m[2]) + num(m[3]), skipped = num(m[4]);
      found = { passed: Math.max(0, run - failed - skipped), failed, skipped, runner: 'junit' };
      continue;
    }
    // node:test spec / TAP: "ℹ pass 6", "# fail 1", "# skipped 0".
    if ((m = /^(?:ℹ|#)\s*(pass|fail|skipped|todo)\s+(\d+)$/.exec(t))) {
      const cur = found?.runner === 'node' ? found : { passed: 0, failed: 0, skipped: 0, runner: 'node' };
      if (m[1] === 'pass') {
        cur.passed = num(m[2]);
      } else if (m[1] === 'fail') {
        cur.failed = num(m[2]);
      } else {
        cur.skipped += num(m[2]);
      }
      found = cur;
    }
  }
  if (found) {
    return found;
  }
  // go test: count "--- PASS/FAIL/SKIP:" lines (only printed with -v, or for failures).
  let pass = 0, fail = 0, skip = 0;
  for (const l of ls) {
    const m = /^\s*--- (PASS|FAIL|SKIP): /.exec(l);
    if (m) {
      if (m[1] === 'PASS') {
        pass++;
      } else if (m[1] === 'FAIL') {
        fail++;
      } else {
        skip++;
      }
    }
  }
  return pass + fail + skip ? { passed: pass, failed: fail, skipped: skip, runner: 'go' } : undefined;
}

const PARSERS: Record<string, (text: string, root: string) => ParsedFailure[]> = { jest: parseJsTest, vitest: parseJsTest, mocha: parseJsTest, node: parseJsTest, pytest: parsePython, go: parseGo, cargo: parseRust, dotnet: parseDotnet, junit: parseJvm };

/**
 * A test run's result for the chat's command row: "6 passed · 1 failed" and the failing tests first. Undefined when
 * the output has no test summary (a build, a script, a server). Pure: no vscode, no I/O.
 */
export function summarizeTests(output: string, root: string, command = ''): TestSummary | undefined {
  if (!output || output.length > 2_000_000) {
    return undefined;
  }
  const c = counts(output);
  if (!c || (!c.passed && !c.failed && !c.skipped)) {
    return undefined;
  }
  // `go test` without -v prints only failures; a plain "ok  pkg" line still means the package passed.
  if (c.runner === 'go' && !c.passed && /(^|\s)go test\b/.test(command)) {
    c.passed = lines(output).filter((l) => /^ok\s+\S+/.test(l)).length;
  }
  let failures: TestFailureRow[] = [];
  if (c.failed) {
    try {
      failures = (PARSERS[c.runner] ?? parseJsTest)(output, root)
        .filter((f) => f.category === 'unit_test' || f.category === 'integration_test' || !!f.test)
        .slice(0, MAX_ROWS)
        .map((f) => ({ name: f.test || f.message, ...(f.file ? { file: f.file } : {}), ...(f.line ? { line: f.line } : {}), message: f.message }));
    } catch {
      failures = [];
    }
  }
  return { ...c, failures };
}
