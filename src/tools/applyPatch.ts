// The `*** Begin Patch` format (Codex / GPT models): parser and applier, without vscode so smoke tests can load it.

export interface PatchLine {
  op: ' ' | '-' | '+';
  text: string;
  /** A bare empty line read as empty context (its leading space was lost). */
  bare?: boolean;
}

export interface PatchHunk {
  /** `@@ text` lines in front of the hunk: each is found in turn, and the hunk is searched after the last. */
  anchors: string[];
  lines: PatchLine[];
  /** `*** End of File`: the hunk's old lines end the file. */
  eof: boolean;
}

export type PatchOp =
  | { type: 'add'; path: string; content: string }
  | { type: 'delete'; path: string }
  | { type: 'update'; path: string; moveTo?: string; hunks: PatchHunk[] };

/** How loosely context had to be matched: 0 exactly, 1 ignoring trailing whitespace, 2 ignoring surrounding whitespace. */
export type Fuzz = 0 | 1 | 2;

export class PatchError extends Error {}

const HEADER = /^\*\*\* (Add|Delete|Update) File:\s*(.+?)\s*$/;
const MOVE = /^\*\*\* Move to:\s*(.+?)\s*$/;
const UNIFIED_AT = /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@ ?(.*)$/;

/** The patch text without the wrappers models put around it: code fences, `%%bash`, `apply_patch <<"EOF"` … `EOF`. */
export function unwrapPatch(raw: string): string {
  let lines = raw.replace(/\r\n?/g, '\n').split('\n');
  const trimEnds = () => {
    while (lines.length && !lines[0].trim()) {
      lines.shift();
    }
    while (lines.length && !lines[lines.length - 1].trim()) {
      lines.pop();
    }
  };
  trimEnds();
  if (lines.length && /^```/.test(lines[0].trim()) && /^```\s*$/.test(lines[lines.length - 1].trim())) {
    lines = lines.slice(1, -1);
    trimEnds();
  }
  if (lines.length && /^%%bash\s*$/.test(lines[0].trim())) {
    lines.shift();
    trimEnds();
  }
  const heredoc = lines.length ? /^(?:apply_patch|applypatch)\s+<<\s*(['"]?)(\w+)\1\s*$/.exec(lines[0].trim()) : null;
  if (heredoc) {
    lines.shift();
    const end = lines.map((l) => l.trim()).lastIndexOf(heredoc[2]);
    if (end >= 0) {
      lines = lines.slice(0, end);
    }
    trimEnds();
  }
  return lines.join('\n');
}

/** Parses a patch into file operations. Throws a PatchError that names the offending line. */
export function parsePatch(raw: string): PatchOp[] {
  const lines = unwrapPatch(raw).split('\n');
  let i = lines.findIndex((l) => l.trim() === '*** Begin Patch');
  if (i < 0) {
    // Lenient: a patch that starts straight with a file header.
    i = lines.findIndex((l) => HEADER.test(l.trim()));
    if (i < 0) {
      throw new PatchError('The patch must start with "*** Begin Patch" followed by "*** Add File:", "*** Update File:" or "*** Delete File:" sections.');
    }
  } else {
    i++;
  }
  let end = lines.findIndex((l, n) => n >= i && l.trim() === '*** End Patch');
  if (end < 0) {
    end = lines.length;
  }
  const ops: PatchOp[] = [];
  const seen = new Set<string>();
  const claim = (p: string, at: number) => {
    if (seen.has(p)) {
      throw new PatchError(`Line ${at + 1}: ${p} appears more than once in the patch; put all changes to a file in one section.`);
    }
    seen.add(p);
  };
  while (i < end) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    const h = HEADER.exec(line.trim());
    if (!h) {
      throw new PatchError(`Line ${i + 1}: expected "*** Add File:", "*** Update File:" or "*** Delete File:", got: ${line.slice(0, 120)}`);
    }
    const [, kind, file] = h;
    claim(file, i);
    i++;
    if (kind === 'Delete') {
      ops.push({ type: 'delete', path: file });
      continue;
    }
    if (kind === 'Add') {
      const body: { text: string; explicit: boolean }[] = [];
      while (i < end && !HEADER.test(lines[i].trim())) {
        const l = lines[i];
        if (l.startsWith('+')) {
          body.push({ text: l.slice(1), explicit: true });
        } else if (!l.trim()) {
          // Models drop the "+" on empty lines.
          body.push({ text: '', explicit: false });
        } else {
          throw new PatchError(`Line ${i + 1}: every line of an added file must start with "+", got: ${l.slice(0, 120)}`);
        }
        i++;
      }
      // Blank lines before the next section belong to no file.
      while (body.length && !body[body.length - 1].explicit) {
        body.pop();
      }
      ops.push({ type: 'add', path: file, content: body.length ? `${body.map((b) => b.text).join('\n')}\n` : '' });
      continue;
    }
    let moveTo: string | undefined;
    const mv = i < end ? MOVE.exec(lines[i].trim()) : null;
    if (mv) {
      moveTo = mv[1];
      claim(moveTo, i);
      i++;
    }
    const hunks: PatchHunk[] = [];
    let cur: PatchHunk | undefined;
    const start = () => {
      if (!cur || cur.lines.length) {
        cur = { anchors: [], lines: [], eof: false };
        hunks.push(cur);
      }
      return cur;
    };
    while (i < end && !HEADER.test(lines[i].trim())) {
      const l = lines[i];
      if (l.startsWith('@@')) {
        const u = UNIFIED_AT.exec(l);
        const anchor = u ? u[1].trim() : l.slice(2).trim();
        const hk = start();
        if (anchor) {
          hk.anchors.push(anchor);
        }
      } else if (l.trim() === '*** End of File') {
        (cur ?? start()).eof = true;
        cur = undefined;
      } else if (l.startsWith(' ') || l.startsWith('-') || l.startsWith('+')) {
        const hk = cur ?? start();
        hk.lines.push({ op: l[0] as PatchLine['op'], text: l.slice(1) });
      } else if (!l.trim()) {
        // An empty context line whose leading space was lost.
        (cur ?? start()).lines.push({ op: ' ', text: '', bare: true });
      } else if (/^(---|\+\+\+) /.test(l) || /^diff --git /.test(l)) {
        // Unified diff file headers carry nothing the section header did not.
      } else {
        throw new PatchError(`Line ${i + 1}: in ${file}, every line must start with " " (context), "-" (remove), "+" (add) or "@@", got: ${l.slice(0, 120)}`);
      }
      i++;
    }
    // Blank lines between sections are not context.
    for (const hk of hunks) {
      while (hk.lines.length && hk.lines[hk.lines.length - 1].bare) {
        hk.lines.pop();
      }
    }
    const real = hunks.filter((hk) => hk.lines.length || hk.anchors.length);
    if (!real.some((hk) => hk.lines.some((l) => l.op !== ' ')) && !moveTo) {
      throw new PatchError(`${file}: the Update File section has no "-" or "+" lines.`);
    }
    ops.push({ type: 'update', path: file, moveTo, hunks: real.filter((hk) => hk.lines.length) });
  }
  if (!ops.length) {
    throw new PatchError('The patch contains no file sections.');
  }
  return ops;
}

const norm = [(s: string) => s, (s: string) => s.trimEnd().normalize('NFC'), (s: string) => s.trim().normalize('NFC')];

/** First index at or after `from` where `pattern` matches `lines`, with the fuzz it took; `eof` tries the file's end first. */
export function seekLines(lines: string[], pattern: string[], from: number, eof = false): { at: number; fuzz: Fuzz } | undefined {
  if (!pattern.length) {
    return { at: from, fuzz: 0 };
  }
  if (pattern.length > lines.length) {
    return undefined;
  }
  for (let fuzz = 0; fuzz < norm.length; fuzz++) {
    const f = norm[fuzz];
    const want = pattern.map(f);
    const matchesAt = (s: number) => want.every((p, k) => f(lines[s + k]) === p);
    const last = lines.length - pattern.length;
    if (eof && last >= from && matchesAt(last)) {
      return { at: last, fuzz: fuzz as Fuzz };
    }
    for (let s = from; s <= last; s++) {
      if (matchesAt(s)) {
        return { at: s, fuzz: fuzz as Fuzz };
      }
    }
  }
  return undefined;
}

/**
 * `original` with the hunks applied. The file's line endings (CRLF or LF) and its final newline are kept; the
 * patch's own text is converted to match. Throws a PatchError when a hunk's context cannot be found.
 */
export function applyHunks(original: string, hunks: PatchHunk[], file = 'the file'): { content: string; fuzz: Fuzz } {
  const crlf = original.includes('\r\n');
  const text = original.replace(/\r\n/g, '\n');
  const finalNewline = text === '' || text.endsWith('\n');
  const lines = text === '' ? [] : (finalNewline ? text.slice(0, -1) : text).split('\n');
  const repl: { at: number; del: number; add: string[] }[] = [];
  let pos = 0;
  let fuzz: Fuzz = 0;
  for (const hk of hunks) {
    for (const a of hk.anchors) {
      const hit = seekLines(lines, [a], pos);
      if (!hit) {
        throw new PatchError(`${file}: the "@@ ${a}" line was not found${pos ? ' after the previous hunk' : ''}. Re-read the file and retry with exact context.`);
      }
      fuzz = Math.max(fuzz, hit.fuzz) as Fuzz;
      pos = hit.at + 1;
    }
    let used = hk.lines;
    let old = used.filter((l) => l.op !== '+').map((l) => l.text);
    if (!old.length) {
      // Pure addition: after the anchor, else at the end of the file.
      repl.push({ at: hk.anchors.length ? pos : lines.length, del: 0, add: used.map((l) => l.text) });
      continue;
    }
    let hit = seekLines(lines, old, pos, hk.eof);
    if (!hit && old[old.length - 1] === '') {
      // A trailing empty line in the hunk often stands for the end of the file.
      const ops = used.map((l) => l.op);
      const lastOld = Math.max(ops.lastIndexOf('-'), ops.lastIndexOf(' '));
      used = used.filter((_, n) => n !== lastOld);
      old = old.slice(0, -1);
      hit = seekLines(lines, old, pos, hk.eof);
    }
    if (!hit) {
      const shown = old.slice(0, 8).map((l) => `  ${l}`).join('\n');
      throw new PatchError(`${file}: these lines were not found${pos ? ' after the previous hunk' : ''}:\n${shown}${old.length > 8 ? '\n  …' : ''}\nRe-read the file and retry with the exact current text.`);
    }
    fuzz = Math.max(fuzz, hit.fuzz) as Fuzz;
    // Context lines stay as they are in the file (a loose match must not rewrite their whitespace).
    const add: string[] = [];
    let k = hit.at;
    for (const l of used) {
      if (l.op === ' ') {
        add.push(lines[k++]);
      } else if (l.op === '-') {
        k++;
      } else {
        add.push(l.text);
      }
    }
    repl.push({ at: hit.at, del: old.length, add });
    pos = hit.at + old.length;
  }
  const out = [...lines];
  // Bottom-up; at equal positions the later hunk goes first, so an insert lands before a replacement at that line.
  const order = [...repl.keys()].sort((a, b) => repl[b].at - repl[a].at || b - a);
  for (const n of order) {
    out.splice(repl[n].at, repl[n].del, ...repl[n].add);
  }
  let content = out.join('\n');
  if (out.length && finalNewline) {
    content += '\n';
  }
  return { content: crlf ? content.replace(/\n/g, '\r\n') : content, fuzz };
}

export interface PlannedFile {
  /** Path as written in the patch. */
  path: string;
  kind: 'add' | 'update' | 'delete' | 'move';
  moveTo?: string;
  /** Current content; undefined when the file does not exist. */
  before?: string;
  /** Content after the patch (of `moveTo` for a move); undefined for a delete. */
  after?: string;
  fuzz: Fuzz;
}

/**
 * What each operation does to the files `read` returns (undefined = missing). All problems are collected and thrown
 * together as one PatchError, so nothing is applied when any part of the patch is wrong.
 */
export function planPatch(ops: PatchOp[], read: (path: string) => string | undefined): PlannedFile[] {
  const out: PlannedFile[] = [];
  const errors: string[] = [];
  for (const op of ops) {
    const before = read(op.path);
    if (op.type === 'add') {
      out.push({ path: op.path, kind: 'add', before, after: before !== undefined && before.includes('\r\n') ? op.content.replace(/\n/g, '\r\n') : op.content, fuzz: 0 });
      continue;
    }
    if (before === undefined) {
      errors.push(`${op.path} does not exist${op.type === 'update' ? '; use "*** Add File:" to create it' : ''}.`);
      continue;
    }
    if (op.type === 'delete') {
      out.push({ path: op.path, kind: 'delete', before, fuzz: 0 });
      continue;
    }
    if (op.moveTo && read(op.moveTo) !== undefined) {
      errors.push(`${op.moveTo} already exists; the file cannot be moved there.`);
      continue;
    }
    try {
      const r = applyHunks(before, op.hunks, op.path);
      out.push({ path: op.path, kind: op.moveTo ? 'move' : 'update', moveTo: op.moveTo, before, after: r.content, fuzz: r.fuzz });
    } catch (e) {
      errors.push(e instanceof Error ? e.message : String(e));
    }
  }
  if (errors.length) {
    throw new PatchError(errors.join('\n\n'));
  }
  return out;
}

/** The patch text from a tool call's arguments: the first non-empty of `input`, `patch`, `diff`, `content`. */
export function patchArg(args: Record<string, unknown>): string | undefined {
  return [args.input, args.patch, args.diff, args.content].find((v) => typeof v === 'string' && v.trim()) as string | undefined;
}

/** Every path a patch names (sources and move targets), without parsing it strictly; never throws. */
export function patchPaths(raw: unknown): string[] {
  if (typeof raw !== 'string') {
    return [];
  }
  return [...raw.matchAll(/^\s*\*\*\* (?:(?:Add|Delete|Update) File|Move to):\s*(.+?)\s*$/gm)].map((m) => m[1]);
}

/** The files a patch names, for labels ("a.ts, b.ts"). */
export function patchSummary(raw: unknown): string {
  const files = patchPaths(raw);
  return files.length ? files.join(', ') : 'files';
}
