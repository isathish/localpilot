import { finish, lines, make, type ParsedFailure } from './common';

const STYLISH_ROW = /^\s+(\d+):(\d+)\s+(error|warning)\s+(.+?)(?:\s{2,}(@?[\w-]+(?:\/[\w-]+)*))?\s*$/;
/** An absolute or nested path with spaces (`/Users/me/My Projects/app/src/a.ts`). */
const STYLISH_SPACED_HEADER = /^(?:[A-Za-z]:)?[\\/]?[^:]*?[\\/][^:\\/]*\.[A-Za-z]\w*$/;
const UNIX = /^(.+?):(\d+):(\d+): (.+?) \[(Error|Warning)(?:\/(@?[\w-]+(?:\/[\w-]+)*))?\]\s*$/;
const COMPACT = /^(.+?): line (\d+), col (\d+), (Error|Warning) - (.+?)(?: \((@?[\w-]+(?:\/[\w-]+)*)\))?\s*$/;

/** ESLint stylish (default), unix and compact formats; errors only (warnings do not fail a lint run). */
export function parseEslint(text: string, root: string): ParsedFailure[] {
  const ls = lines(text);
  const out: ParsedFailure[] = [];
  let file: string | undefined;
  for (const raw of ls) {
    const unix = UNIX.exec(raw);
    if (unix) {
      if (unix[5] === 'Error') {
        out.push(make('lint', { file: unix[1], line: Number(unix[2]), column: Number(unix[3]), message: unix[4], code: unix[6], evidence: raw }, root));
      }
      continue;
    }
    const compact = COMPACT.exec(raw);
    if (compact) {
      if (compact[4] === 'Error') {
        out.push(make('lint', { file: compact[1], line: Number(compact[2]), column: Number(compact[3]), message: compact[5], code: compact[6], evidence: raw }, root));
      }
      continue;
    }
    const row = file ? STYLISH_ROW.exec(raw) : null;
    if (row) {
      if (row[3] === 'error') {
        out.push(make('lint', { file, line: Number(row[1]), column: Number(row[2]), message: row[4], code: row[5], evidence: `${file}\n${raw}` }, root));
      }
      continue;
    }
    const t = raw.trim();
    // A stylish file header: an unindented path line.
    if (t && !/^\s/.test(raw) && (/^(?:[A-Za-z]:)?[^\s:]*[\\/]?[^\s:]+\.[A-Za-z]\w*$/.test(t) || STYLISH_SPACED_HEADER.test(t))) {
      file = t;
    } else if (!t || /^[✖×]/.test(t)) {
      file = t ? undefined : file;
    }
  }
  return finish(out, root);
}
