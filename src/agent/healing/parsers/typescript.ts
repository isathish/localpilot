import { excerpt, finish, isPackageSpecifier, lines, make, packageName, type ParsedFailure } from './common';

const PAREN = /^\s*(.+?)\((\d+),(\d+)\): error (TS\d+): (.*)$/;
const PRETTY = /^\s*(.+?):(\d+):(\d+) - error (TS\d+): (.*)$/;
const BARE = /^\s*error (TS\d+): (.*)$/;
const SYNTAX = new Set(['TS1005', 'TS1128']);

/** tsc output (`file(l,c): error TSxxxx:` and `--pretty` `file:l:c - error TSxxxx:`). */
export function parseTypescript(text: string, root: string): ParsedFailure[] {
  const ls = lines(text);
  const out: ParsedFailure[] = [];
  for (let i = 0; i < ls.length; i++) {
    const m = PAREN.exec(ls[i]) ?? PRETTY.exec(ls[i]);
    const bare = m ? undefined : BARE.exec(ls[i]);
    if (!m && !bare) {
      continue;
    }
    // Continuation lines (indented elaboration, code frame) belong to this error.
    let end = i + 1;
    while (end < ls.length && end - i < 12 && !PAREN.test(ls[end]) && !PRETTY.test(ls[end]) && !BARE.test(ls[end]) && (/^\s/.test(ls[end]) || !ls[end].trim()) && !/^Found \d+ errors?/.test(ls[end].trim())) {
      end++;
    }
    const evidence = excerpt(ls, i, end);
    if (bare) {
      out.push(make('typescript', { code: bare[1], message: bare[2], evidence }, root));
      continue;
    }
    const [, file, line, col, code, message] = m!;
    const spec = code === 'TS2307' || code === 'TS2792' ? /'([^']+)'/.exec(message)?.[1] : undefined;
    const category = spec && isPackageSpecifier(spec) ? 'dependency' : SYNTAX.has(code) ? 'compile' : 'typescript';
    out.push(make(category, { code, message, file, line: Number(line), column: Number(col), evidence, symbol: category === 'dependency' ? packageName(spec!) : undefined }, root));
  }
  return finish(out, root);
}
