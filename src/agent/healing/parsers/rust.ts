import { excerpt, finish, lines, looksIntegration, make, type ParsedFailure } from './common';

const ERROR = /^error(?:\[(E\d{4})\])?: (.*)$/;
const ARROW = /^\s*--> (.+?):(\d+):(\d+)\s*$/;
const NOISE = /^(?:aborting due to|could not compile|Could not compile|build failed|test failed, to rerun|\d+ previous errors?)/;
/** Panic location: `panicked at src/x.rs:1:2:` (1.73+) or `panicked at 'msg', src/x.rs:1:2`. */
const PANIC = /^thread '([^']+)' panicked at (?:'(.*)', )?(.+?\.rs):(\d+):(\d+):?\s*$/;
const LOCAL_ROOTS = new Set(['crate', 'self', 'super', 'std', 'core', 'alloc']);

function panicMessage(ls: readonly string[], i: number, inline?: string): string {
  if (inline) {
    return inline;
  }
  const next = ls[i + 1]?.trim();
  return next && !/^note: /.test(next) ? next : 'panicked';
}

/** cargo/rustc: `error[E0308]` + `--> file:l:c`, `test x ... FAILED` with its stdout section, panics, missing crates. */
export function parseRust(text: string, root: string): ParsedFailure[] {
  const ls = lines(text);
  const out: ParsedFailure[] = [];
  const failedTests = new Set<string>();
  const inTestSection = new Set<number>();
  for (const l of ls) {
    const t = /^test (\S+) \.\.\. FAILED\s*$/.exec(l);
    if (t) {
      failedTests.add(t[1]);
    }
  }
  for (let i = 0; i < ls.length; i++) {
    const sec = /^---- (\S+) stdout ----\s*$/.exec(ls[i]);
    if (!sec) {
      continue;
    }
    let j = i + 1;
    while (j < ls.length && !/^---- \S+ stdout ----/.test(ls[j]) && !/^failures:\s*$/.test(ls[j]) && !/^test result:/.test(ls[j])) {
      inTestSection.add(j);
      j++;
    }
    const name = sec[1];
    let message = ls.slice(i + 1, j).find((x) => x.trim() && !/^note: /.test(x.trim()))?.trim() ?? 'test failed';
    let file: string | undefined;
    let line: number | undefined;
    for (let k = i + 1; k < j; k++) {
      const p = PANIC.exec(ls[k]);
      if (p) {
        message = panicMessage(ls, k, p[2]);
        file = p[3];
        line = Number(p[4]);
        break;
      }
    }
    failedTests.delete(name);
    out.push(make(looksIntegration(name, file) || /^tests\//.test(file ?? '') ? 'integration_test' : 'unit_test', { message, file, line, test: name, evidence: excerpt(ls, i, j) }, root));
    i = j - 1;
  }
  // FAILED tests without a captured stdout section (--nocapture).
  for (const name of failedTests) {
    out.push(make(looksIntegration(name) ? 'integration_test' : 'unit_test', { message: `${name} failed`, test: name, evidence: `test ${name} ... FAILED` }, root));
  }

  for (let i = 0; i < ls.length; i++) {
    if (inTestSection.has(i)) {
      continue;
    }
    const noCrate = /^error: no matching package named `([^`]+)` found/.exec(ls[i]);
    if (noCrate) {
      out.push(make('dependency', { code: 'no_matching_package', message: ls[i].replace(/^error: /, ''), symbol: noCrate[1], evidence: excerpt(ls, i, i + 4) }, root));
      continue;
    }
    const e = ERROR.exec(ls[i]);
    if (e) {
      const [, code, message] = e;
      if (NOISE.test(message)) {
        continue;
      }
      let j = i + 1;
      while (j < ls.length && j - i < 40 && !/^(?:error|warning)(?:\[\w+\])?: |^(?:For more information|Some errors have)|^\s*(?:Compiling|Finished|Running) /.test(ls[j])) {
        j++;
      }
      const block = ls.slice(i, j).join('\n');
      const loc = ls.slice(i + 1, j).map((x) => ARROW.exec(x)).find(Boolean);
      const unresolved = /unresolved import `([\w:]+)`|failed to resolve: use of (?:undeclared|unresolved) (?:crate or module|module or unlinked crate) `(\w+)`/.exec(message);
      const crate = /can't find crate for `(\w+)`/.exec(message)?.[1]
        ?? (unresolved && /undeclared crate|missing crate|unlinked crate|extern crate/.test(block) ? (unresolved[1] ?? unresolved[2]).split('::')[0] : undefined);
      const isDep = !!crate && !LOCAL_ROOTS.has(crate);
      out.push(make(isDep ? 'dependency' : 'compile', { code, message, file: loc?.[1], line: loc ? Number(loc[2]) : undefined, column: loc ? Number(loc[3]) : undefined, symbol: isDep ? crate : undefined, evidence: excerpt(ls, i, j) }, root));
      i = j - 1;
      continue;
    }
    const p = PANIC.exec(ls[i]);
    if (p) {
      out.push(make('runtime', { code: 'panic', message: panicMessage(ls, i, p[2]), file: p[3], line: Number(p[4]), column: Number(p[5]), evidence: excerpt(ls, i, i + 6) }, root));
      continue;
    }
  }
  return finish(out, root);
}
