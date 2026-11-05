import { excerpt, finish, isPackageSpecifier, lines, make, packageName, stackFrames, type ParsedFailure } from './common';

const NODE_ERROR = /^(?:Uncaught )?((?:[A-Z]\w*)?Error)(?: \[(\w+)\])?: (.*)$/;
const DATA_FILE = /\.(?:db|sqlite3?|db3|mdb|ldb|parquet|avro|orc|arrow|feather|h5|hdf5|npy|npz|pkl|pickle|jsonl|ndjson|csv|tsv|dat|bin|wal|journal|frm|ibd|rdb|aof)\b|\b(?:database|datafile|data file|table|index|wal|sstable|snapshot|backup)\b/i;
const CORRUPT = /checksum mismatch|database disk image is malformed|\bmalformed\b|\bcorrupt(?:ed|ion)?\b|bad magic number|unexpected end of (?:archive|file)/i;
const DB_MISSING = /relation "([^"]+)" does not exist|no such table:? (\S+)|Table '([^']+)' doesn't exist|table "?([\w.]+)"? does not exist|no such column:? (\S+)|column "([^"]+)" (?:of relation "[^"]+" )?does not exist/i;
const MIGRATION = /\b(?:migrat(?:e|ion|ions))\b.*\b(?:fail(?:ed|ure)?|error|pending|conflict|out of (?:sync|order)|not applied)\b|\b(?:fail(?:ed|ure)?|error)\b.*\bmigrat(?:e|ion|ions)\b/i;

/** A line without path-like tokens (`src/migrations/001.ts`, `migration.test.ts`), for keyword matching. */
const withoutPaths = (t: string) => t.replace(/\S*[\\/]\S*/g, ' ').replace(/\S+\.[a-z]{1,5}\b\S*/g, ' ');

/** npm/pip/yarn install errors, EADDRINUSE, Node stack traces, database/migration errors, data corruption. */
export function parseGeneric(text: string, root: string): ParsedFailure[] {
  const ls = lines(text);
  const out: ParsedFailure[] = [];
  for (let i = 0; i < ls.length; i++) {
    const l = ls[i];
    const t = l.trim();
    if (!t) {
      continue;
    }
    // npm (v6-v10: "npm ERR!", v10+: "npm error").
    const npm404 = /^npm (?:ERR!|error) 404\s+(?:Not Found - \w+ \S+?\/((?:@[^/\s]+(?:\/|%2[fF]))?[^/\s-][^/\s]*?)(?: - .*)?$|'?((?:@[^/\s]+\/)?[^@\s']+)(?:@[^\s']*)?'? is not in (?:the|this) (?:npm )?registry)/.exec(t);
    if (npm404) {
      const pkg = decodeURIComponent(npm404[1] ?? npm404[2] ?? '');
      out.push(make('dependency', { code: 'E404', message: t.replace(/^npm (?:ERR!|error)\s*/, ''), symbol: pkg || undefined, evidence: excerpt(ls, i, i + 4) }, root));
      continue;
    }
    const npmCode = /^npm (?:ERR!|error) code (E404|ERESOLVE|ETARGET|ENOVERSIONS|E401|E403)\b/.exec(t);
    if (npmCode) {
      // One npm report is a block of "npm ERR!" lines: one failure.
      let j = i + 1;
      while (j < ls.length && /^npm (?:ERR!|error\b)/.test(ls[j].trim())) {
        j++;
      }
      const block = ls.slice(i, j).map((x) => x.trim());
      const detail = block.slice(1).find((x) => /^npm (?:ERR!|error) (?:ERESOLVE|404 Not Found|404 .*is not in|notarget|Could not resolve|Conflicting peer|No matching version)/i.test(x)) ?? t;
      const joined = block.join('\n');
      const nf = /404 Not Found - \w+ \S+?\/((?:@[^/\s]+(?:\/|%2[fF]))?[^/\s]+?)(?: - |\s*$)/m.exec(joined)?.[1] ?? /'((?:@[^/\s]+\/)?[^@\s']+)(?:@[^\s']*)?' is not in (?:the|this) (?:npm )?registry/.exec(joined)?.[1];
      const symbol = nf ? decodeURIComponent(nf)
        : /No matching version found for ((?:@[^/\s]+\/)?[^@\s]+)/.exec(joined)?.[1] ?? /Could not resolve dependency:\s*\n?.*?peer ((?:@[^/\s]+\/)?[^@\s]+)@/.exec(joined)?.[1];
      out.push(make('dependency', { code: npmCode[1], message: detail.replace(/^npm (?:ERR!|error)\s*/, ''), symbol, evidence: excerpt(ls, i, Math.min(j, i + 14)) }, root));
      i = j - 1;
      continue;
    }
    const pip = /^ERROR: (?:No matching distribution found for|Could not find a version that satisfies the requirement) ([^\s(;]+)/.exec(t);
    if (pip) {
      // pip prints "Could not find a version…" and "No matching distribution…" for one requirement.
      const symbol = pip[1].replace(/[<>=!~].*$/, '');
      if (!out.some((f) => f.code === 'pip_no_distribution' && f.symbol === symbol)) {
        out.push(make('dependency', { code: 'pip_no_distribution', message: t.replace(/^ERROR:\s*/, ''), symbol, evidence: excerpt(ls, i, i + 3) }, root));
      }
      continue;
    }
    const yarn = /^(?:error|ERR_PNPM_\w+)\b.*?(?:Couldn't find package "([^"]+)"|404 Not Found.*?\/((?:@[^/\s]+\/)?[^/\s]+)$|No matching version found for ((?:@[^/\s]+\/)?[^@\s]+))/.exec(t);
    if (yarn) {
      out.push(make('dependency', { code: 'E404', message: t, symbol: yarn[1] ?? yarn[2] ?? yarn[3], evidence: excerpt(ls, i, i + 3) }, root));
      continue;
    }
    if (/\bEADDRINUSE\b|address already in use/i.test(t)) {
      const port = /:(\d{2,5})\b(?!.*:\d)/.exec(t)?.[1] ?? /port (\d{2,5})/i.exec(t)?.[1];
      out.push(make('runtime', { code: 'EADDRINUSE', message: t.replace(/^(?:Error|OSError):\s*/, ''), cls: 'environmental', symbol: port, evidence: excerpt(ls, i, i + 4) }, root));
      continue;
    }
    const db = DB_MISSING.exec(t);
    if (db) {
      out.push(make('database', { code: /column/i.test(db[0]) ? 'missing_column' : 'missing_table', message: t, symbol: db.slice(1).find(Boolean)?.replace(/[;,]$/, ''), evidence: excerpt(ls, i, i + 4) }, root));
      continue;
    }
    if (CORRUPT.test(t) && DATA_FILE.test(t) && !/\bmalformed (?:json|request|url|header|input|expression|argument|response)\b/i.test(t)) {
      out.push(make('data_corruption', { code: /checksum/i.test(t) ? 'checksum_mismatch' : 'corrupt', message: t, evidence: excerpt(ls, i, i + 4) }, root));
      continue;
    }
    const words = withoutPaths(t);
    if (MIGRATION.test(words) && /error|fail/i.test(words)) {
      out.push(make('database', { code: 'migration', message: t, evidence: excerpt(ls, i, i + 6) }, root));
      continue;
    }
    // Node: "TypeError: x is not a function" followed by "    at …" frames.
    const err = NODE_ERROR.exec(t);
    if (err && ls.slice(i + 1, i + 6).some((x) => /^\s+at /.test(x) || /^Require stack:/.test(x.trim()))) {
      let j = i + 1;
      while (j < ls.length && j - i < 40 && /^\s+at |^Require stack:|^\s*- \S/.test(ls[j])) {
        j++;
      }
      const block = ls.slice(i, j).join('\n');
      const required = /^\s*- (\S.*)$/m.exec(block)?.[1];
      const frame = stackFrames(block, root)[0];
      const missing = /Cannot find (?:module|package) '([^']+)'/.exec(err[3]);
      if (missing && isPackageSpecifier(missing[1])) {
        out.push(make('dependency', { code: 'MODULE_NOT_FOUND', message: err[3], file: frame?.file ?? required, line: frame?.line, symbol: packageName(missing[1]), evidence: excerpt(ls, i, j) }, root));
      } else {
        out.push(make('runtime', { code: err[2] ?? err[1], message: `${err[1]}: ${err[3]}`, file: frame?.file, line: frame?.line, evidence: excerpt(ls, i, j) }, root));
      }
      i = j - 1;
    }
  }
  return finish(out, root);
}
