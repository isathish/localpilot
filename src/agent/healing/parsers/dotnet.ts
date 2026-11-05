import { excerpt, finish, lines, looksIntegration, make, type ParsedFailure } from './common';

const COMPILE = /^\s*(.+?\.(?:cs|vb|fs|razor|cshtml|xaml))\((\d+),(\d+)(?:,\d+,\d+)?\): error ([A-Z]+\d+): (.*?)(?: \[[^\]]+\])?\s*$/;
const NUGET = /^\s*(?:(.+?) : )?error (NU1\d{3}): (.*?)(?: \[[^\]]+\])?\s*$/;
const MSBUILD = /^\s*(?:(.+?) : )?error (MSB\d+): (.*?)(?: \[[^\]]+\])?\s*$/;
const FAILED = /^\s*Failed (\S+)(?: \[[^\]]*\])?\s*$/;

/** dotnet build (`file(l,c): error CSxxxx:`), NuGet restore (NU1101/NU1102), MSBuild and `dotnet test` failures. */
export function parseDotnet(text: string, root: string): ParsedFailure[] {
  const ls = lines(text);
  const out: ParsedFailure[] = [];
  for (let i = 0; i < ls.length; i++) {
    const l = ls[i];
    const c = COMPILE.exec(l);
    if (c) {
      out.push(make('compile', { file: c[1], line: Number(c[2]), column: Number(c[3]), code: c[4], message: c[5], evidence: l.trim() }, root));
      continue;
    }
    const n = NUGET.exec(l);
    if (n) {
      const pkg = /(?:Unable to find package|Unable to find a stable package|Package) ([\w.-]+)/.exec(n[3])?.[1];
      const category = /^NU11\d\d$/.test(n[2]) ? 'dependency' : 'build';
      out.push(make(category, { code: n[2], message: n[3], file: n[1], symbol: category === 'dependency' ? pkg?.replace(/\.$/, '') : undefined, evidence: l.trim() }, root));
      continue;
    }
    const b = MSBUILD.exec(l);
    if (b) {
      out.push(make('build', { code: b[2], message: b[3], file: b[1], evidence: l.trim() }, root));
      continue;
    }
    const f = FAILED.exec(l);
    if (f && /^\s*(?:Error Message:|Stack Trace:)/.test(ls[i + 1] ?? '')) {
      let j = i + 1;
      while (j < ls.length && j - i < 50 && !FAILED.test(ls[j]) && !/^\s*(?:Passed|Skipped) \S/.test(ls[j]) && !/^(?:Failed!|Passed!|Total tests:|Test Run)/.test(ls[j].trim())) {
        j++;
      }
      const body = ls.slice(i + 1, j);
      const msgAt = body.findIndex((x) => /^\s*Error Message:/.test(x));
      const message = (msgAt >= 0 ? body.slice(msgAt + 1).find((x) => x.trim())?.trim() : undefined) ?? `${f[1]} failed`;
      const loc = body.map((x) => /^\s+at .* in (.+?):line (\d+)\s*$/.exec(x)).find(Boolean);
      const name = f[1];
      const exc = /^([\w.]+(?:Exception|Failure))\b/.exec(message)?.[1].split('.').pop();
      out.push(make(looksIntegration(name, loc?.[1]) ? 'integration_test' : 'unit_test', { code: exc, message, file: loc?.[1], line: loc ? Number(loc[2]) : undefined, test: name, evidence: excerpt(ls, i, j) }, root));
      i = j - 1;
    }
  }
  return finish(out, root);
}
