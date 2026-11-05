import { relativePath } from '../signature';
import { excerpt, finish, lines, looksIntegration, make, stackFrames, type ParsedFailure } from './common';

const MYPY = /^(\S+\.pyi?):(\d+):(?:(\d+):)? error: (.*?)(?:\s+\[([\w-]+)\])?\s*$/;
const EXC_LINE = /^([A-Za-z_][\w.]*[A-Z]\w*)(?::\s*(.*))?$/;
const CORRUPT = /database disk image is malformed|file is (?:encrypted or is )?not a database|database (?:file )?is corrupt/i;
const MIGRATION = /(django\.db\.migrations\.exceptions\.\w+|alembic(?:\.util)?(?:\.exc)?\.\w*Error|sqlalchemy\.exc\.(?:OperationalError|ProgrammingError)|django\.db\.utils\.(?:OperationalError|ProgrammingError))(?::\s*(.*))?/;

const shortName = (exc: string) => exc.split('.').pop()!;

/** A Python exception line -> category, code and symbol. */
function classifyException(exc: string, msg: string): { category: 'dependency' | 'compile' | 'data_corruption' | 'database' | 'runtime'; code: string; symbol?: string } {
  const name = shortName(exc);
  const missing = /No module named '?([\w.]+)'?/.exec(msg);
  if ((name === 'ModuleNotFoundError' || name === 'ImportError') && missing) {
    return { category: 'dependency', code: 'ModuleNotFoundError', symbol: missing[1].split('.')[0] };
  }
  if (name === 'ImportError') {
    return { category: 'compile', code: 'ImportError' };
  }
  if (name === 'SyntaxError' || name === 'IndentationError' || name === 'TabError') {
    return { category: 'compile', code: name };
  }
  if (CORRUPT.test(msg)) {
    return { category: 'data_corruption', code: 'SQLITE_CORRUPT' };
  }
  if (MIGRATION.test(exc) || (/OperationalError|ProgrammingError/.test(name) && /no such table|does not exist|no such column|migrat/i.test(msg))) {
    return { category: 'database', code: name };
  }
  return { category: 'runtime', code: name };
}

/** pytest, mypy, tracebacks (runtime/import/syntax), sqlite corruption and migration errors. */
export function parsePython(text: string, root: string): ParsedFailure[] {
  const ls = lines(text);
  const out: ParsedFailure[] = [];
  const isPytest = ls.some((l) => /^=+ (?:test session starts|FAILURES|ERRORS|short test summary info) =+$/.test(l.trim()));

  // pytest failure sections: "____ test_name ____" ... "file.py:12: AssertionError".
  const sections = new Map<string, { from: number; to: number; file?: string; line?: number; message?: string }>();
  if (isPytest) {
    let cur: { name: string; from: number } | undefined;
    const closeSection = (to: number) => {
      if (!cur) {
        return;
      }
      const body = ls.slice(cur.from + 1, to);
      let file: string | undefined;
      let line: number | undefined;
      for (const l of body) {
        const loc = /^(\S+\.py):(\d+): (?:\w+)/.exec(l);
        if (loc) {
          file = loc[1];
          line = Number(loc[2]);
        }
      }
      const e = body.find((l) => /^E\s{2,}/.test(l));
      sections.set(cur.name, { from: cur.from, to, file, line, message: e?.replace(/^E\s+/, '').trim() });
      cur = undefined;
    };
    for (let i = 0; i < ls.length; i++) {
      const h = /^_{3,} (.+?) _{3,}$/.exec(ls[i].trim());
      if (h) {
        closeSection(i);
        cur = { name: h[1].replace(/^ERROR (?:collecting|at \w+ of) /, ''), from: i };
        continue;
      }
      if (/^=+ .* =+$/.test(ls[i].trim())) {
        closeSection(i);
      }
    }
    closeSection(ls.length);
  }

  const summarised = new Set<string>();
  for (let i = 0; i < ls.length; i++) {
    const l = ls[i];
    const failed = /^(FAILED|ERROR) (\S+?)(?:::(\S+?))?(?: - (.*))?\s*$/.exec(l);
    if (isPytest && failed) {
      const [, kind, file, test, rest] = failed;
      const name = test?.split('::').pop() ?? file;
      const sec = sections.get(name) ?? sections.get(test?.replace(/::/g, '.') ?? '') ?? sections.get(file);
      const message = rest ?? sec?.message ?? (kind === 'ERROR' ? 'collection error' : 'test failed');
      const exc = /^([\w.]+(?:Error|Exception)):?\s*(.*)$/.exec(message);
      const evidence = sec ? excerpt(ls, sec.from, Math.min(sec.to, sec.from + 60)) : l;
      summarised.add(name);
      if (exc) {
        const c = classifyException(exc[1], exc[2]);
        if (c.category !== 'runtime') {
          out.push(make(c.category, { code: c.code, message, file, line: sec?.file && relativePath(sec.file, root) === relativePath(file, root) ? sec.line : undefined, test, symbol: c.symbol, evidence }, root));
          continue;
        }
      }
      const fileMatches = sec?.file && relativePath(sec.file, root) === relativePath(file, root);
      const category = looksIntegration(file, test) || /ConnectionRefused|ECONNREFUSED|status(?:_code)? == [1-5]\d\d/.test(evidence) ? 'integration_test' : 'unit_test';
      const code = exc ? shortName(exc[1]) : /^assert\b/.test(message) ? 'AssertionError' : undefined;
      out.push(make(category, { code, message, file, line: fileMatches ? sec!.line : undefined, test, evidence }, root));
      continue;
    }
    const mypy = MYPY.exec(l);
    if (mypy) {
      out.push(make('compile', { file: mypy[1], line: Number(mypy[2]), column: mypy[3] ? Number(mypy[3]) : undefined, message: mypy[4], code: mypy[5] ?? 'mypy', evidence: l }, root));
      continue;
    }
  }

  // pytest sections without a summary line (-rN, older pytest).
  if (isPytest) {
    for (const [name, sec] of sections) {
      if (summarised.has(name) || !/^test/.test(name.split('.').pop() ?? '')) {
        continue;
      }
      const evidence = excerpt(ls, sec.from, Math.min(sec.to, sec.from + 60));
      out.push(make(looksIntegration(sec.file, name) ? 'integration_test' : 'unit_test', { message: sec.message ?? 'test failed', file: sec.file, line: sec.line, test: name, evidence }, root));
    }
  }

  // Tracebacks and bare exception lines (outside pytest, whose report already covers them).
  if (!isPytest) {
    for (let i = 0; i < ls.length; i++) {
      if (!/^Traceback \(most recent call last\):/.test(ls[i].trim()) && !/^\s*File "[^"]+", line \d+\s*$/.test(ls[i])) {
        continue;
      }
      // A SyntaxError report starts at a lone `File "x", line N` (no traceback header).
      const start = i;
      let j = i + 1;
      while (j < ls.length && (/^\s/.test(ls[j]) || !ls[j].trim() || /^Traceback|^During handling|^The above exception/.test(ls[j]))) {
        j++;
      }
      const exLine = ls[j]?.trim() ?? '';
      const m = EXC_LINE.exec(exLine);
      if (!m) {
        i = j;
        continue;
      }
      const block = ls.slice(start, j + 1).join('\n');
      const c = classifyException(m[1], m[2] ?? '');
      const frames = stackFrames(block, root);
      // SyntaxError: the reported location is the last `File` line, also when it is outside the project.
      const lastFile = [...block.matchAll(/File "([^"]+)", line (\d+)/g)].pop();
      const at = c.code === 'SyntaxError' || c.code === 'IndentationError' || c.code === 'TabError' ? (lastFile ? { file: lastFile[1], line: Number(lastFile[2]) } : frames[0]) : frames[0];
      out.push(make(c.category, { code: c.code, message: exLine, file: at?.file, line: at?.line, symbol: c.symbol, evidence: excerpt(ls, start, j + 1) }, root));
      i = j;
    }
  }

  // Corruption and migration errors printed without a traceback (CLIs, logs).
  for (const l of ls) {
    const t = l.trim();
    if (CORRUPT.test(t) && /sqlite|database/i.test(t) && !out.some((f) => f.category === 'data_corruption')) {
      out.push(make('data_corruption', { code: 'SQLITE_CORRUPT', message: t, evidence: t }, root));
    }
    const mig = MIGRATION.exec(t);
    if (mig && !out.some((f) => f.category === 'database')) {
      out.push(make('database', { code: shortName(mig[1]), message: t, evidence: t }, root));
    }
  }
  return finish(out, root);
}
