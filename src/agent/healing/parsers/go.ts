import { excerpt, finish, lines, looksIntegration, make, stackFrames, type ParsedFailure } from './common';

const COMPILE = /^(?:\.\/)?(\S+?\.go):(\d+):(\d+): (.*)$/;
const MISSING = /no required module provides package (\S+?)(?:;|$)|cannot find package "([^"]+)"|cannot find module providing package (\S+)|module (\S+): reading .*: 404/;

/** go build/vet/test: compile errors, `--- FAIL: TestX`, panics with goroutine dumps, missing modules. */
export function parseGo(text: string, root: string): ParsedFailure[] {
  const ls = lines(text);
  const out: ParsedFailure[] = [];
  for (let i = 0; i < ls.length; i++) {
    const l = ls[i];
    const missing = MISSING.exec(l);
    if (missing) {
      const pkg = missing[1] ?? missing[2] ?? missing[3] ?? missing[4];
      const loc = COMPILE.exec(l);
      out.push(make('dependency', { code: 'missing_module', message: loc ? loc[4] : l.trim(), file: loc?.[1], line: loc ? Number(loc[2]) : undefined, symbol: pkg, evidence: excerpt(ls, i, i + 3) }, root));
      continue;
    }
    const c = COMPILE.exec(l);
    if (c) {
      out.push(make('compile', { message: c[4], file: c[1], line: Number(c[2]), column: Number(c[3]), evidence: l }, root));
      continue;
    }
    const fail = /^(\s*)--- FAIL: (\S+)(?: \([\d.]+s\))?/.exec(l);
    if (fail) {
      const indent = fail[1].length;
      let j = i + 1;
      while (j < ls.length && ls[j].trim() && !/^\s*--- (?:FAIL|PASS|SKIP):/.test(ls[j]) && !/^(?:FAIL|ok|PASS)\b/.test(ls[j]) && (ls[j].length - ls[j].trimStart().length > indent)) {
        j++;
      }
      // Subtest parents (TestA when TestA/b failed) repeat the child: skip a parent whose next FAIL is its subtest.
      const nextFail = /^\s*--- FAIL: (\S+)/.exec(ls[j] ?? '');
      if (nextFail && nextFail[1].startsWith(`${fail[2]}/`) && j === i + 1) {
        continue;
      }
      const body = ls.slice(i + 1, j);
      const loc = body.map((b) => /^\s+(\S+?\.go):(\d+): (.*)$/.exec(b)).find(Boolean);
      const message = loc?.[3] ?? body.find((b) => b.trim())?.trim() ?? `${fail[2]} failed`;
      out.push(make(looksIntegration(fail[2], loc?.[1]) ? 'integration_test' : 'unit_test', { message, file: loc?.[1], line: loc ? Number(loc[2]) : undefined, test: fail[2], evidence: excerpt(ls, i, Math.max(j, i + 1)) }, root));
      continue;
    }
    const panic = /^panic: (.*)$/.exec(l);
    if (panic) {
      let j = i + 1;
      while (j < ls.length && j - i < 60 && !/^(?:exit status \d+|FAIL\b|ok\b)/.test(ls[j])) {
        j++;
      }
      const block = ls.slice(i, j).join('\n');
      if (!/goroutine \d+ \[/.test(block)) {
        continue;
      }
      const frame = stackFrames(block, root)[0];
      out.push(make('runtime', { code: 'panic', message: panic[1].replace(/\s*\[recovered\]$/, ''), file: frame?.file, line: frame?.line, evidence: excerpt(ls, i, j) }, root));
      i = j - 1;
    }
  }
  return finish(out, root);
}
