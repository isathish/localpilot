import { excerpt, finish, lines, looksIntegration, make, type ParsedFailure } from './common';

const MAVEN_JAVAC = /^\[ERROR\]\s+(?:COMPILATION ERROR\s*:\s*)?(\S+?\.(?:java|kt|scala|groovy)):\[(\d+),(\d+)\]\s+(?:error:\s*)?(.*)$/;
const JAVAC = /^(\S+?\.java):(\d+): error: (.*)$/;
const KOTLIN_OLD = /^e: (?:file:\/\/)?(\S+?\.kts?): \((\d+), (\d+)\): (.*)$/;
const KOTLIN_NEW = /^e: (?:file:\/\/)?(\S+?\.kts?):(\d+):(\d+):? (.*)$/;
const SUREFIRE_NEW = /^\[ERROR\]\s+([\w.$]+)\.(\w+)(?:\(.*?\))?\s+--\s+Time elapsed:.*<<< (FAILURE|ERROR)!/;
const SUREFIRE_OLD = /^\[ERROR\]\s+(\w+)\(([\w.$]+)\)\s+Time elapsed:.*<<< (FAILURE|ERROR)!/;
const GRADLE_TEST = /^([\w.$]+) > (.+?) FAILED\s*$/;
const FRAME = /^\s*at ([\w.$<>]+)\(([\w$]+\.(?:java|kt|scala|groovy)):(\d+)\)/;

/** javac/maven/gradle/kotlinc compile errors, surefire/gradle test failures, unresolved dependencies, uncaught exceptions. */
export function parseJvm(text: string, root: string): ParsedFailure[] {
  const ls = lines(text);
  const out: ParsedFailure[] = [];
  const testBody = (from: number) => {
    let j = from;
    while (j < ls.length && j - from < 40 && ls[j].trim() && !/^\[(?:INFO|ERROR|WARNING)\]\s*(?:Tests run|$|[\w.$]+\.\w+.*Time elapsed|\w+\(.*\)\s+Time elapsed)/.test(ls[j]) && !GRADLE_TEST.test(ls[j])) {
      j++;
    }
    return j;
  };
  for (let i = 0; i < ls.length; i++) {
    const l = ls[i];
    const c = MAVEN_JAVAC.exec(l) ?? KOTLIN_OLD.exec(l) ?? KOTLIN_NEW.exec(l);
    if (c) {
      out.push(make('compile', { message: c[4], file: c[1], line: Number(c[2]), column: Number(c[3]), evidence: excerpt(ls, i, i + 3) }, root));
      continue;
    }
    const j = JAVAC.exec(l);
    if (j) {
      out.push(make('compile', { message: j[3], file: j[1], line: Number(j[2]), evidence: excerpt(ls, i, i + 3) }, root));
      continue;
    }
    const sNew = SUREFIRE_NEW.exec(l);
    const sOld = sNew ? undefined : SUREFIRE_OLD.exec(l);
    const g = sNew || sOld ? undefined : GRADLE_TEST.exec(l);
    if (sNew || sOld || g) {
      const cls = sNew ? sNew[1] : sOld ? sOld[2] : g![1];
      const method = sNew ? sNew[2] : sOld ? sOld[1] : g![2];
      const end = testBody(i + 1);
      const body = ls.slice(i + 1, end);
      const message = body.find((b) => b.trim() && !FRAME.test(b))?.trim() ?? `${method} failed`;
      const simple = cls.split('.').pop()!;
      const exc = /^([\w.$]+(?:Error|Exception|Failure))\b/.exec(message)?.[1].split('.').pop();
      const category = looksIntegration(cls, method) || /IT$/.test(simple) ? 'integration_test' : 'unit_test';
      out.push(make(category, { code: exc, message, test: `${cls}.${method}`.replace(/\(\)$/, ''), evidence: excerpt(ls, i, Math.max(end, i + 1)) }, root));
      i = end - 1;
      continue;
    }
    const dep = /Could not resolve dependencies for project|Could not resolve all (?:files|dependencies|artifacts) for configuration|Could not find artifact (\S+)|Could not find ([\w.-]+:[\w.-]+:[\w.-]+)\.?$|Failed to collect dependencies/.exec(l);
    if (dep) {
      const artifact = dep[1] ?? dep[2] ?? /(?:artifact|find) ([\w.-]+:[\w.-]+(?::[\w.-]+)*)/.exec(ls.slice(i, i + 4).join('\n'))?.[1];
      out.push(make('dependency', { code: 'unresolved_dependency', message: l.replace(/^\[ERROR\]\s*/, '').replace(/^>\s*/, '').trim(), symbol: artifact, evidence: excerpt(ls, i, i + 6) }, root));
      continue;
    }
    const ex = /^Exception in thread "([^"]+)" ([\w.$]+)(?::\s*(.*))?$/.exec(l);
    if (ex && FRAME.test(ls[i + 1] ?? '')) {
      let k = i + 1;
      while (k < ls.length && k - i < 40 && (/^\s+at /.test(ls[k]) || /^\s*\.\.\. \d+ more/.test(ls[k]) || /^Caused by:/.test(ls[k]))) {
        k++;
      }
      // JVM frames name the class and file, not the source path: the class is the symbol, the evidence keeps the line.
      const frame = FRAME.exec(ls[i + 1])!;
      out.push(make('runtime', { code: ex[2].split('.').pop(), message: `${ex[2]}${ex[3] ? `: ${ex[3]}` : ''}`, symbol: frame[1], evidence: excerpt(ls, i, k) }, root));
      i = k - 1;
    }
  }
  return finish(out, root);
}
