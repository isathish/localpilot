/**
 * Corrects misspelled file names and code identifiers in a user's request against the names that actually exist in
 * the workspace ("dicee.py" → "dice.py", "rollDise" → "rollDice"), so the agent's searches and reads hit the right
 * target on the first try. Only name-like tokens are touched — a file name with an extension (corrected only to a file
 * with the same extension, so "Next.js" never becomes "next.ts"), snake_case, camelCase or names with digits. Plain
 * words are left alone: the model reads ordinary typos fine, while "correcting" English against a code vocabulary would
 * turn "form" into "from".
 *
 * It stays out of the way when a name is clearly meant as written: inside code fences, backtick or quoted spans, URLs and
 * pasted error/stack-trace lines; a name being created or renamed to ("create users.py", "rename rollDice to rollDie");
 * a case-only difference; a numbered variant of an existing name ("main2.py"); or a candidate the message already
 * mentions. Long pastes (over 4000 characters) are returned unchanged.
 */

export interface NameVocabulary {
  /** File base names in the workspace (`dice.py`, `chatController.ts`). */
  files: ReadonlySet<string>;
  /** Identifiers seen in open documents and file stems (`rollDice`, `roll_dice`, `ChatController`). */
  identifiers: ReadonlySet<string>;
}

export interface PromptFix {
  from: string;
  to: string;
}

const URL = /\b[a-z][a-z0-9+.-]*:\/\/\S+/gi;
/** Name-like tokens: optional path, then a name with `.ext`, `_`, an inner capital, or a digit run. */
const TOKEN = /(?<![\w@./-])((?:[\w-]+\/)*)([A-Za-z_][\w-]*(?:\.[A-Za-z0-9]{1,8})?)(?![\w/-])/g;

/** Damerau–Levenshtein (optimal string alignment) distance, or `max + 1` as soon as it must exceed `max`. */
export function editDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) {
    return max + 1;
  }
  let prev2: number[] = [];
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        v = Math.min(v, prev2[j - 2] + 1);
      }
      cur.push(v);
      rowMin = Math.min(rowMin, v);
    }
    if (rowMin > max) {
      return max + 1;
    }
    prev2 = prev;
    prev = cur;
  }
  return prev[b.length];
}

/** How many edits a name of this length may be away from the real one: short names must be nearly exact. */
function allowance(len: number): number {
  return len < 5 ? 0 : len < 10 ? 1 : 2;
}

function isFileLike(name: string): boolean {
  return /\.[A-Za-z0-9]{1,8}$/.test(name);
}

function isIdentifierLike(name: string): boolean {
  return name.includes('_') || /[a-z][A-Z]/.test(name) || /[A-Za-z]\d/.test(name);
}

function extensionOf(name: string): string {
  return name.slice(name.lastIndexOf('.') + 1).toLowerCase();
}

interface Entry {
  name: string;
  lower: string;
}

const MAX_TEXT = 4000;
const MAX_TOKENS = 200;
const FENCE = /```[\s\S]*?(?:```|$)/g;
const INLINE_CODE = /`[^`\n]*`/g;
const QUOTED = /"[^"\n]*"|(?<!\w)'[^'\n]*'(?!\w)/g;
const ERROR_LINE =
  /^\s*at\s|^\s*(?:\w+(?:Error|Exception)|error(?:\s+TS\d+)?)\s*:|\(\d+,\d+\):|^\s*Traceback \(most recent|cannot find (?:name|module)|did you mean/i;
const INTENT =
  /\b(create|creating|new|add|make|write|generate|named|called|rename\b.*\bto|move\b.*\bto)\s+(?:(?:a|an|the|file|function|class|method|module|component|test)\s+){0,2}$/i;

/** The single closest name within the allowance, or undefined when there is none or two are equally close. */
function closest(token: string, names: readonly Entry[]): string | undefined {
  const max = allowance(token.length);
  if (!max) {
    return undefined;
  }
  const lower = token.toLowerCase();
  let best: Entry | undefined;
  let bestD = max + 1;
  let tie = false;
  for (const n of names) {
    const d = editDistance(lower, n.lower, max);
    if (d < bestD) {
      best = n;
      bestD = d;
      tie = false;
    } else if (d === bestD && d <= max && best?.lower !== n.lower) {
      tie = true;
    }
  }
  return best && bestD <= max && !tie ? best.name : undefined;
}

/** `main2.py` → `main.py`, `userId2` → `userId`. */
function withoutVersion(name: string): string {
  return name.replace(/\d+((?:\.[A-Za-z0-9]{1,8})?)$/, '$1').toLowerCase();
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function correctPromptNames(text: string, vocab: NameVocabulary): { text: string; fixes: PromptFix[] } {
  if ((!vocab.files.size && !vocab.identifiers.size) || text.length > MAX_TEXT) {
    return { text, fixes: [] };
  }
  const group = <K>(map: Map<K, Entry[]>, key: K, name: string) => {
    const entry = { name, lower: name.toLowerCase() };
    const bucket = map.get(key);
    if (bucket) {
      bucket.push(entry);
    } else {
      map.set(key, [entry]);
    }
  };
  const fileNamesLower = new Set([...vocab.files].map((f) => f.toLowerCase()));
  const filesByExt = new Map<string, Entry[]>();
  for (const name of vocab.files) {
    group(filesByExt, extensionOf(name), name);
  }
  const idsByLength = new Map<number, Entry[]>();
  for (const name of vocab.identifiers) {
    group(idsByLength, name.length, name);
  }
  const skip: [number, number][] = [];
  for (const re of [URL, FENCE, INLINE_CODE, QUOTED]) {
    for (const m of text.matchAll(re)) {
      skip.push([m.index!, m.index! + m[0].length]);
    }
  }
  for (const m of text.matchAll(/^.*$/gm)) {
    if (ERROR_LINE.test(m[0])) {
      skip.push([m.index!, m.index! + m[0].length]);
    }
  }
  const inside = (i: number) => skip.some(([a, b]) => i >= a && i < b);
  const memo = new Map<string, string | undefined>();
  const lookup = (name: string): string | undefined => {
    if (memo.has(name)) {
      return memo.get(name);
    }
    let to: string | undefined;
    if (isFileLike(name)) {
      if (!fileNamesLower.has(name.toLowerCase())) {
        to = closest(name, filesByExt.get(extensionOf(name)) ?? []);
      }
    } else if (isIdentifierLike(name) && !vocab.identifiers.has(name)) {
      const max = allowance(name.length);
      const near: Entry[] = [];
      for (let len = name.length - max; len <= name.length + max; len++) {
        near.push(...(idsByLength.get(len) ?? []));
      }
      to = closest(name, near);
    }
    if (
      to &&
      (to.toLowerCase() === name.toLowerCase() ||
        withoutVersion(name) === to.toLowerCase() ||
        withoutVersion(to) === name.toLowerCase() ||
        new RegExp(`(?<![\\w-])${escapeRegExp(to)}(?![\\w-])`).test(text))
    ) {
      to = undefined;
    }
    memo.set(name, to);
    return to;
  };
  const fixes: PromptFix[] = [];
  let candidates = 0;
  const out = text.replace(TOKEN, (whole, dir: string, name: string, offset: number) => {
    if (inside(offset) || (!isFileLike(name) && !isIdentifierLike(name)) || ++candidates > MAX_TOKENS) {
      return whole;
    }
    const lineStart = text.lastIndexOf('\n', offset - 1) + 1;
    if (INTENT.test(text.slice(Math.max(lineStart, offset - 40), offset))) {
      return whole;
    }
    const to = lookup(name);
    if (!to || to === name) {
      return whole;
    }
    fixes.push({ from: name, to });
    return `${dir}${to}`;
  });
  return { text: out, fixes };
}

/** Identifiers worth matching against: at least five characters and name-like (see `correctPromptNames`). */
export function identifiersIn(source: string, into: Set<string>, limit = 20_000): void {
  for (const m of source.matchAll(/\b[A-Za-z_][A-Za-z0-9_]{4,63}\b/g)) {
    if (into.size >= limit) {
      return;
    }
    const id = m[0];
    if (id.includes('_') || /[a-z][A-Z]/.test(id) || /^[A-Z][a-z]+[A-Z]/.test(id)) {
      into.add(id);
    }
  }
}
