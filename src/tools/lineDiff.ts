// A small unified line diff for tool results (no vscode, so smoke tests can load it).

/**
 * Unified diff (`@@ -a,b +c,d @@` hunks with `context` lines around each change) of two texts, cut to `maxLines`
 * lines. Common leading and trailing lines are skipped before the line-by-line comparison, so an edit in a large
 * file costs only the size of the edit. Empty when the texts are equal.
 */
export function unifiedDiff(before: string, after: string, opts: { context?: number; maxLines?: number } = {}): string {
  const context = opts.context ?? 3;
  const maxLines = opts.maxLines ?? 200;
  const a = before.replace(/\r\n/g, '\n').split('\n');
  const b = after.replace(/\r\n/g, '\n').split('\n');
  // A final newline in both texts is not a line of its own.
  if (a.length > 1 && b.length > 1 && a[a.length - 1] === '' && b[b.length - 1] === '') {
    a.pop();
    b.pop();
  }
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) {
    pre++;
  }
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) {
    suf++;
  }
  const midA = a.slice(pre, a.length - suf);
  const midB = b.slice(pre, b.length - suf);
  if (!midA.length && !midB.length) {
    return '';
  }
  // Each row: [op, line]; ' ' rows are unchanged.
  type Row = [' ' | '-' | '+', string];
  const rows: Row[] = [];
  for (let i = Math.max(0, pre - context); i < pre; i++) {
    rows.push([' ', a[i]]);
  }
  if (midA.length * midB.length > 4_000_000) {
    rows.push(...midA.map((l): Row => ['-', l]), ...midB.map((l): Row => ['+', l]));
  } else {
    // Longest common subsequence table, filled from the end.
    const n = midA.length;
    const m = midB.length;
    const lcs: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        lcs[i][j] = midA[i] === midB[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && midA[i] === midB[j]) {
        rows.push([' ', midA[i++]]);
        j++;
      } else if (i < n && (j >= m || lcs[i + 1][j] >= lcs[i][j + 1])) {
        rows.push(['-', midA[i++]]);
      } else {
        rows.push(['+', midB[j++]]);
      }
    }
  }
  for (let i = a.length - suf; i < Math.min(a.length, a.length - suf + context); i++) {
    rows.push([' ', a[i]]);
  }
  // Split into hunks wherever more than 2 × context unchanged lines separate two changes.
  const out: string[] = [];
  let lineA = Math.max(0, pre - context) + 1;
  let lineB = lineA;
  let k = 0;
  while (k < rows.length) {
    let end = k;
    let gap = 0;
    while (end < rows.length) {
      gap = rows[end][0] === ' ' ? gap + 1 : 0;
      if (gap > 2 * context && rows.slice(end + 1).some((r) => r[0] !== ' ')) {
        break;
      }
      end++;
    }
    const hunkEnd = end < rows.length ? end - gap + context + 1 : rows.length;
    const hunk = rows.slice(k, hunkEnd);
    const countA = hunk.filter((r) => r[0] !== '+').length;
    const countB = hunk.filter((r) => r[0] !== '-').length;
    out.push(`@@ -${lineA},${countA} +${lineB},${countB} @@`, ...hunk.map(([op, l]) => `${op}${l}`));
    // Skip the unchanged lines between this hunk and the next one's leading context.
    let next = end;
    while (next < rows.length && rows[next][0] === ' ') {
      next++;
    }
    const skipTo = end < rows.length ? next - context : rows.length;
    const skipped = rows.slice(k, skipTo);
    lineA += skipped.filter((r) => r[0] !== '+').length;
    lineB += skipped.filter((r) => r[0] !== '-').length;
    k = skipTo;
  }
  if (out.length > maxLines) {
    return `${out.slice(0, maxLines).join('\n')}\n… (${out.length - maxLines} more diff lines)`;
  }
  return out.join('\n');
}

/** write_file's approval detail: the diff against the current file, or the first `maxLines` lines of a new one. */
export function writePreview(before: string | undefined, after: string, maxLines = 200): string {
  if (before !== undefined) {
    return unifiedDiff(before, after, { maxLines }) || '(no changes: the content is the same as the file)';
  }
  const lines = after.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n');
  const shown = lines.slice(0, maxLines).map((l) => `+${l}`);
  return lines.length > maxLines ? `${shown.join('\n')}\n… ${(lines.length - maxLines).toLocaleString()} more lines` : shown.join('\n');
}
