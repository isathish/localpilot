/**
 * Turns a rule or command file on or off by editing its front matter in place: `disabled: true` is added (with a new
 * front-matter block when the file has none) or removed together with a legacy `enabled: false`. The BOM, the line
 * endings, the body and every other key are kept byte for byte. Front matter that cannot be read safely is refused.
 */

export class FrontMatterError extends Error {}

const OPEN = /^---[ \t]*\r?\n/;
const CLOSE = /(^|\r?\n)---(?=[ \t]*(?:\r?\n|$))/;

/** `lines` without the `key:` entries `drop` selects (a value continued on indented lines goes with its key). */
function withoutKey(lines: string[], key: string, drop: (line: string) => boolean = () => true): string[] {
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (new RegExp(`^${key}:(\\s|$)`).test(lines[i]) && drop(lines[i])) {
      while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1])) {
        i++;
      }
      continue;
    }
    out.push(lines[i]);
  }
  return out;
}

export function setDisabled(raw: string, disabled: boolean): string {
  const bom = raw.startsWith('\uFEFF') ? '\uFEFF' : '';
  const text = raw.slice(bom.length);
  // The file's own line ending, from its first line.
  const eol = /^[^\n]*\r\n/.test(text) ? '\r\n' : '\n';
  const open = OPEN.exec(text);
  if (!open) {
    return disabled ? `${bom}---${eol}disabled: true${eol}---${eol}${text}` : raw;
  }
  const rest = text.slice(open[0].length);
  const close = CLOSE.exec(rest);
  if (!close) {
    throw new FrontMatterError('The front matter is not closed with a "---" line.');
  }
  const block = rest.slice(0, close.index);
  // From the end of the closing `---`: its line ending, then the body.
  const after = rest.slice(close.index + close[0].length);
  const lines = block ? block.split(/\r?\n/) : [];
  for (const l of lines) {
    if (l.trim() && !/^\s/.test(l) && !/^#/.test(l) && !/^-\s/.test(l) && !/^[A-Za-z0-9_-]+:(\s|$)/.test(l)) {
      throw new FrontMatterError(`The front matter has a line that is not "key: value": ${l.trim().slice(0, 60)}`);
    }
  }
  let next = withoutKey(lines, 'disabled');
  if (disabled) {
    next.push('disabled: true');
  } else {
    next = withoutKey(next, 'enabled', (l) => /^enabled:\s*['"]?(false|no)['"]?\s*$/i.test(l));
  }
  if (!next.some((l) => l.trim())) {
    // Nothing left in the block: drop it, as if it had never been there.
    return `${bom}${after.replace(/^[ \t]*\r?\n?/, '')}`;
  }
  return `${bom}---${eol}${next.join(eol)}${eol}---${after}`;
}
