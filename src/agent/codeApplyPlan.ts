/**
 * What "Apply" on a chat code block does to its target file. Pure, so the chat and the tests share one definition.
 *
 * - The file does not exist: the block becomes a new file (`create`).
 * - The block looks like the whole file: it replaces it (`replace`).
 * - The block looks like a fragment (a function out of a longer file): it replaces the matching region when its first
 *   line names exactly one place in the file (`merge`), otherwise the caller asks what to do (`partial`).
 * - The block already matches the file: nothing to do (`same`).
 *
 * The result is always shown in a diff before anything is written, so a heuristic merge is checked by the user.
 */

export type CodeApplyPlan =
  | { kind: 'create'; text: string }
  | { kind: 'replace'; text: string }
  /** Lines `from`..`to` (0-based, inclusive) of the current file were replaced by the block. */
  | { kind: 'merge'; text: string; from: number; to: number }
  | { kind: 'partial' }
  | { kind: 'same' };

/** A block with fewer non-blank lines than this share of the file's is treated as a fragment. */
const WHOLE_FILE_SHARE = 0.6;

const indentOf = (l: string): number => (/^[ \t]*/.exec(l)?.[0] ?? '').replace(/\t/g, '    ').length;
const blank = (l: string): boolean => !l.trim();

export function planCodeApply(current: string | undefined, code: string): CodeApplyPlan {
  if (current === undefined) {
    return { kind: 'create', text: withFinalNewline(code, '\n') };
  }
  const eol = current.includes('\r\n') ? '\r\n' : '\n';
  const cur = current.replace(/^\uFEFF/, '').split(/\r?\n/);
  const block = code.replace(/\r\n/g, '\n').replace(/\n+$/, '').split('\n');
  const finalNl = /\r?\n$/.test(current) || !current;
  const join = (lines: string[]): string => lines.join(eol) + (finalNl ? eol : '');
  if (!current.trim()) {
    return { kind: 'replace', text: join(block) };
  }
  if (trimEnd(cur).join('\n') === trimEnd(block).join('\n')) {
    return { kind: 'same' };
  }
  const curBody = cur.filter((l) => !blank(l));
  const blockBody = block.filter((l) => !blank(l));
  const sameEnds = curBody.length > 0 && blockBody.length > 0 && curBody[0].trim() === blockBody[0].trim() && curBody[curBody.length - 1].trim() === blockBody[blockBody.length - 1].trim();
  if (sameEnds || blockBody.length >= WHOLE_FILE_SHARE * curBody.length) {
    return { kind: 'replace', text: join(block) };
  }
  const merged = mergeFragment(cur.slice(0, finalNl ? -1 : undefined), block);
  if (!merged) {
    return { kind: 'partial' };
  }
  const text = join(merged.lines);
  return text === current ? { kind: 'same' } : { kind: 'merge', text, from: merged.from, to: merged.to };
}

/**
 * Replaces the region of `file` the fragment stands for. The fragment's first non-blank line must occur exactly once in
 * the file (ignoring indentation). The region ends at the fragment's last line at the same relative indentation (a
 * closing brace), or, for indentation-scoped languages, where the block that starts at the anchor ends.
 */
export function mergeFragment(file: string[], block: string[]): { lines: string[]; from: number; to: number } | undefined {
  const first = block.findIndex((l) => !blank(l));
  if (first < 0) {
    return undefined;
  }
  let last = block.length - 1;
  while (last > first && blank(block[last])) {
    last--;
  }
  const head = block[first].trim();
  // Too generic to locate anything: a lone brace, `else:`, a one-word line.
  if (head.length < 6 || !/[A-Za-z_$]/.test(head)) {
    return undefined;
  }
  const hits = file.map((l, i) => (l.trim() === head ? i : -1)).filter((i) => i >= 0);
  if (hits.length !== 1) {
    return undefined;
  }
  const from = hits[0];
  const baseIndent = indentOf(file[from]);
  const shift = baseIndent - indentOf(block[first]);
  // The fragment is often shown dedented (a method without its class): move it to the anchor's indentation.
  const pad = shift > 0 ? (file[from].startsWith('\t') ? '\t'.repeat(Math.max(1, Math.round(shift / 4))) : ' '.repeat(shift)) : '';
  const body = block.slice(first, last + 1).map((l) => (blank(l) ? '' : shift > 0 ? pad + l : shift < 0 ? l.slice(Math.min(-shift, (/^[ \t]*/.exec(l) ?? [''])[0].length)) : l));
  let to = -1;
  if (last > first) {
    const tail = block[last].trim();
    const rel = indentOf(block[last]) - indentOf(block[first]);
    for (let k = from + 1; k < file.length; k++) {
      if (file[k].trim() === tail && indentOf(file[k]) - baseIndent === rel) {
        to = k;
        break;
      }
      // Left the anchor's block (a line indented at or left of the anchor that is not part of the fragment's shape).
      if (!blank(file[k]) && indentOf(file[k]) < baseIndent) {
        break;
      }
    }
    if (to < 0 && block.slice(first + 1, last + 1).every((l) => blank(l) || indentOf(l) > indentOf(block[first]))) {
      // Python-style block: it runs until the next non-blank line indented at or left of the anchor.
      to = from;
      for (let k = from + 1; k < file.length; k++) {
        if (!blank(file[k]) && indentOf(file[k]) <= baseIndent) {
          break;
        }
        if (!blank(file[k])) {
          to = k;
        }
      }
    }
  } else {
    to = from;
  }
  if (to < from) {
    return undefined;
  }
  return { lines: [...file.slice(0, from), ...body, ...file.slice(to + 1)], from, to };
}

function trimEnd(lines: string[]): string[] {
  const out = lines.map((l) => l.replace(/\s+$/, ''));
  while (out.length && !out[out.length - 1]) {
    out.pop();
  }
  return out;
}

function withFinalNewline(text: string, eol: string): string {
  const t = text.replace(/\r\n/g, '\n');
  return (t.endsWith('\n') ? t : `${t}\n`).replace(/\n/g, eol);
}
