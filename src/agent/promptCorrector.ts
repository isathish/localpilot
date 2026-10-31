/**
 * Corrects misspelled file names and code identifiers in a user's request against the names that actually exist in
 * the workspace ("dicee.py" → "dice.py", "rollDise" → "rollDice"), so the agent's searches and reads hit the right
 * target on the first try. Only name-like tokens are touched — a file name with an extension (corrected only to a file
 * with the same extension, so "Next.js" never becomes "next.ts"), snake_case, camelCase or names with digits. Plain
 * words are left alone: the model reads ordinary typos fine, while "correcting" English against a code vocabulary would
 * turn "form" into "from".
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

/** The single closest name within the allowance, or undefined when there is none or two are equally close. */
function closest(token: string, names: ReadonlySet<string>): string | undefined {
  const max = allowance(token.length);
  if (!max) {
    return undefined;
  }
  const lower = token.toLowerCase();
  let best: string | undefined;
  let bestD = max + 1;
  let tie = false;
  for (const n of names) {
    const d = editDistance(lower, n.toLowerCase(), max);
    if (d < bestD) {
      best = n;
      bestD = d;
      tie = false;
    } else if (d === bestD && d <= max && best?.toLowerCase() !== n.toLowerCase()) {
      tie = true;
    }
  }
  return best && bestD <= max && !tie ? best : undefined;
}

export function correctPromptNames(text: string, vocab: NameVocabulary): { text: string; fixes: PromptFix[] } {
  if (!vocab.files.size && !vocab.identifiers.size) {
    return { text, fixes: [] };
  }
  const fileNamesLower = new Set([...vocab.files].map((f) => f.toLowerCase()));
  const skip: [number, number][] = [...text.matchAll(URL)].map((m) => [m.index!, m.index! + m[0].length]);
  const inside = (ranges: [number, number][], i: number) => ranges.some(([a, b]) => i >= a && i < b);
  const fixes: PromptFix[] = [];
  const out = text.replace(TOKEN, (whole, dir: string, name: string, offset: number) => {
    if (inside(skip, offset)) {
      return whole;
    }
    let to: string | undefined;
    if (isFileLike(name)) {
      if (!fileNamesLower.has(name.toLowerCase())) {
        const ext = extensionOf(name);
        to = closest(name, new Set([...vocab.files].filter((f) => extensionOf(f) === ext)));
      }
    } else if (isIdentifierLike(name) && !vocab.identifiers.has(name)) {
      to = closest(name, vocab.identifiers);
    }
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
