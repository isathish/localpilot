/** Index of the next character that is not whitespace or inside a comment, starting at `i`. */
function skipBlank(text: string, i: number): number {
  while (i < text.length) {
    const c = text[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      i++;
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') {
        i++;
      }
    } else if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end < 0 ? text.length : end + 2;
    } else {
      break;
    }
  }
  return i;
}

/** JSONC → JSON text: drops `//` and `/* *\/` comments and trailing commas outside strings; string contents are copied verbatim. */
export function stripJsonc(text: string): string {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  let out = '';
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '"') {
      let j = i + 1;
      while (j < src.length && src[j] !== '"') {
        j += src[j] === '\\' ? 2 : 1;
      }
      out += src.slice(i, j + 1);
      i = j + 1;
    } else if (c === '/' && (src[i + 1] === '/' || src[i + 1] === '*')) {
      const end = skipBlank(src, i);
      // Keep line breaks so JSON.parse error positions stay roughly meaningful.
      out += src.slice(i, end).includes('\n') ? '\n' : ' ';
      i = end;
    } else if (c === ',') {
      const next = src[skipBlank(src, i + 1)];
      if (next !== '}' && next !== ']') {
        out += c;
      }
      i++;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

/** JSON with `//` and `/* *\/` comments and trailing commas (settings files are hand-edited). */
export function parseJsonc(text: string): unknown {
  return JSON.parse(stripJsonc(text));
}
