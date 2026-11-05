import { finish, lines, make, type ParsedFailure } from './common';

const STATUS_CODES: Record<string, string> = {
  UU: 'both modified', AA: 'both added', DD: 'both deleted', AU: 'added by us', UA: 'added by them', DU: 'deleted by us', UD: 'deleted by them',
};

/** git merge/rebase/cherry-pick conflicts: `CONFLICT (…)`, `Automatic merge failed`, unmerged status lines. */
export function parseGit(text: string, root: string): ParsedFailure[] {
  const ls = lines(text);
  const out: ParsedFailure[] = [];
  let unmerged = false;
  for (const l of ls) {
    if (/^Unmerged paths:/.test(l)) {
      unmerged = true;
      continue;
    }
    if (unmerged && l.trim() && !/^\s/.test(l)) {
      unmerged = false;
    }
    const c = /^CONFLICT \(([^)]+)\): (.*)$/.exec(l.trim());
    if (c) {
      const file = /Merge conflict in (.+?)\s*$/.exec(c[2])?.[1] ?? /^(\S+) deleted in /.exec(c[2])?.[1] ?? /(?:added in|in) \S+ and .*?: (\S+)/.exec(c[2])?.[1];
      out.push(make('git_conflict', { code: 'CONFLICT', message: `CONFLICT (${c[1]}): ${c[2]}`.replace(/Merge conflict in .+$/, 'Merge conflict'), file, evidence: l.trim() }, root));
      continue;
    }
    const s = /^(UU|AA|DD|AU|UA|DU|UD) (.+)$/.exec(l);
    if (s) {
      out.push(make('git_conflict', { code: 'CONFLICT', message: `Unmerged path (${STATUS_CODES[s[1]]})`, file: s[2].trim().replace(/^"(.*)"$/, '$1'), evidence: l }, root));
      continue;
    }
    const long = unmerged && /^\s+(both modified|both added|both deleted|added by us|added by them|deleted by us|deleted by them):\s+(.+)$/.exec(l);
    if (long) {
      out.push(make('git_conflict', { code: 'CONFLICT', message: `Unmerged path (${long[1]})`, file: long[2].trim(), evidence: l.trim() }, root));
    }
  }
  if (!out.length) {
    const failed = ls.find((l) => /^(?:Automatic merge failed|error: could not apply [0-9a-f]+|hint: (?:Resolve all conflicts manually|fix conflicts)|Resolve all conflicts manually|fix conflicts and then commit)/.test(l));
    if (failed) {
      out.push(make('git_conflict', { code: 'CONFLICT', message: failed.trim(), evidence: failed.trim() }, root));
    }
  }
  // Several reports (CONFLICT + status) of one file are one conflict.
  const byFile = new Map<string, ParsedFailure>();
  for (const f of out) {
    const key = f.file ?? f.message;
    if (!byFile.has(key)) {
      byFile.set(key, f);
    }
  }
  return finish([...byFile.values()], root);
}

/** Conflict markers left in a file's text (`<<<<<<< ` … `>>>>>>> `). */
export function parseConflictMarkers(content: string, file: string, root: string): ParsedFailure[] {
  const ls = lines(content);
  const start = ls.findIndex((l) => /^<<<<<<< /.test(l) || l === '<<<<<<<');
  if (start < 0 || !ls.slice(start + 1).some((l) => /^>>>>>>> /.test(l) || l === '>>>>>>>') || !ls.slice(start + 1).some((l) => l === '=======')) {
    return [];
  }
  return [make('git_conflict', { code: 'CONFLICT', message: 'Conflict markers in file', file, line: start + 1, evidence: ls.slice(start, start + 12).join('\n') }, root)];
}
