/** One property of a JSONC object, by offsets into the text. */
interface Prop {
  key: string;
  start: number;
  valueStart: number;
  valueEnd: number;
  /** Offset of the comma after the value, when there is one. */
  comma?: number;
  value: Node;
}

interface Node {
  start: number;
  end: number;
  props?: Prop[];
}

function skipBlank(text: string, i: number): number {
  while (i < text.length) {
    const c = text[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '﻿') {
      i++;
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') {
        i++;
      }
    } else if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      if (end < 0) {
        throw new Error('unterminated comment');
      }
      i = end + 2;
    } else {
      break;
    }
  }
  return i;
}

function parseString(text: string, i: number): { value: string; end: number } {
  let j = i + 1;
  while (j < text.length && text[j] !== '"') {
    j += text[j] === '\\' ? 2 : 1;
  }
  if (j >= text.length) {
    throw new Error('unterminated string');
  }
  return { value: JSON.parse(text.slice(i, j + 1)) as string, end: j + 1 };
}

function parseValue(text: string, at: number): Node {
  const i = skipBlank(text, at);
  const c = text[i];
  if (c === '"') {
    return { start: i, end: parseString(text, i).end };
  }
  if (c === '{' || c === '[') {
    const close = c === '{' ? '}' : ']';
    const props: Prop[] = [];
    let j = skipBlank(text, i + 1);
    while (text[j] !== close) {
      if (j >= text.length) {
        throw new Error('unterminated object');
      }
      let prop: Prop | undefined;
      let value: Node;
      if (c === '{') {
        if (text[j] !== '"') {
          throw new Error(`unexpected ${text[j]} at ${j}`);
        }
        const key = parseString(text, j);
        const colon = skipBlank(text, key.end);
        if (text[colon] !== ':') {
          throw new Error(`expected : at ${colon}`);
        }
        value = parseValue(text, colon + 1);
        prop = { key: key.value, start: j, valueStart: value.start, valueEnd: value.end, value };
        props.push(prop);
      } else {
        value = parseValue(text, j);
      }
      j = skipBlank(text, value.end);
      if (text[j] === ',') {
        if (prop) {
          prop.comma = j;
        }
        j = skipBlank(text, j + 1);
      } else if (text[j] !== close) {
        throw new Error(`expected , or ${close} at ${j}`);
      }
    }
    return { start: i, end: j + 1, props: c === '{' ? props : undefined };
  }
  const m = /^(?:true|false|null|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(text.slice(i, i + 64));
  if (!m) {
    throw new Error(`unexpected ${c ?? 'end of file'} at ${i}`);
  }
  return { start: i, end: i + m[0].length };
}

/** The object at `path` (the last property of a repeated key, as JSON.parse reads it). */
function objectAt(text: string, path: string[]): Node {
  let node = parseValue(text, 0);
  for (const key of path) {
    const prop = node.props?.filter((p) => p.key === key).pop();
    if (!prop) {
      throw new Error(`no "${key}" object`);
    }
    node = prop.value;
  }
  if (!node.props) {
    throw new Error(`"${path.join('.')}" is not an object`);
  }
  return node;
}

/** `text` without the property: the whole line when it stands on its own line, else just the property and its comma. */
function removeProp(text: string, props: Prop[], index: number): string {
  const p = props[index];
  if (p.comma !== undefined) {
    let from = p.start;
    let to = p.comma + 1;
    const lineStart = text.lastIndexOf('\n', from - 1) + 1;
    const after = /^[ \t]*\r?\n/.exec(text.slice(to));
    if (/^[ \t]*$/.test(text.slice(lineStart, from)) && after) {
      from = lineStart;
      to += after[0].length;
    }
    return text.slice(0, from) + text.slice(to);
  }
  const prev = props[index - 1];
  if (prev?.comma !== undefined) {
    return text.slice(0, prev.comma) + text.slice(p.valueEnd);
  }
  return text.slice(0, p.start) + text.slice(p.valueEnd);
}

/**
 * Sets `disabled` on the object at `path` of a JSONC text and drops its `enabled`, leaving every comment and the
 * formatting of the rest as written. Throws when the text is not JSONC it can read.
 */
export function setJsoncDisabled(text: string, path: string[], disabled: boolean): string {
  // Stale switches go first, one at a time (offsets move with each removal).
  for (;;) {
    const props = objectAt(text, path).props!;
    const index = props.findIndex((p) => p.key === 'enabled' || (!disabled && p.key === 'disabled'));
    if (index < 0) {
      break;
    }
    text = removeProp(text, props, index);
  }
  if (!disabled) {
    return text;
  }
  const obj = objectAt(text, path);
  const props = obj.props!;
  const existing = props.filter((p) => p.key === 'disabled').pop();
  if (existing) {
    return text.slice(0, existing.valueStart) + 'true' + text.slice(existing.valueEnd);
  }
  const last = props[props.length - 1];
  if (!last) {
    return `${text.slice(0, obj.start)}{ "disabled": true }${text.slice(obj.end)}`;
  }
  const lineStart = text.lastIndexOf('\n', last.start - 1) + 1;
  const indent = text.slice(lineStart, last.start);
  const sep = /^[ \t]*$/.test(indent) && lineStart > obj.start ? `\n${indent}` : ' ';
  if (last.comma !== undefined) {
    // A trailing comma already follows the last value.
    return `${text.slice(0, last.comma + 1)}${sep}"disabled": true,${text.slice(last.comma + 1)}`;
  }
  return `${text.slice(0, last.valueEnd)},${sep}"disabled": true${text.slice(last.valueEnd)}`;
}
