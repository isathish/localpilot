/**
 * Deterministic structured-output repair (design §5.6). Fixes the common ways a model mangles JSON (fences and
 * prose around it, trailing commas, smart or single quotes, raw newlines in strings, bare keys) without asking the
 * model again. Truncation repairs only close what was opened and drop a trailing incomplete member; they never
 * invent a value, and a cut inside a string is never repaired. Pure: no vscode import.
 */

export interface RepairResult {
  ok: boolean;
  value?: unknown;
  /** The repaired JSON text, when ok. */
  text?: string;
  fixes: string[];
  /** The input ended before its outermost value closed. */
  truncated: boolean;
}

export const MUTATING_TOOL_NAMES: readonly string[] = [
  'write_file',
  'edit_file',
  'apply_patch',
  'run_command',
  'notebook_edit',
  'delete_path',
  'git_commit',
  'git_push',
  'pull_request',
  'create_directory',
  'schedule',
  'team_board',
];

/** Denylisted for truncation repair whatever the registry says; every `mcp_*` tool counts as mutating. */
export function isMutatingToolName(name: string): boolean {
  return MUTATING_TOOL_NAMES.includes(name) || name.startsWith('mcp_');
}

const OPEN_DQ = new Set(['"', '“', '”']);
const OPEN_SQ = new Set(["'", '‘', '’']);
const SMART = /[‘’“”]/;

function tryParse(s: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(s) };
  } catch {
    return { ok: false };
  }
}

/** The JSON value inside fences/prose: from the first `{`/`[` to its matching close (or the end, or a ``` fence). */
function extractValue(raw: string, fixes: string[]): string {
  let s = raw.trim();
  const start = s.search(/[{[]/);
  if (start < 0) {
    return s;
  }
  const fence = /```[\w-]*[^\S\n]*\n?/.exec(s.slice(0, start));
  if (fence) {
    fixes.push('fence');
  }
  if ((fence ? s.slice(0, fence.index) : s.slice(0, start)).trim()) {
    fixes.push('prose');
  }
  const stack: string[] = [];
  let quote: '' | 'dq' | 'smart' | 'sq' = '';
  let end = s.length;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (quote) {
      if (ch === '\\') {
        i++;
      } else if (stringEnds(quote, s, i)) {
        quote = '';
      }
      continue;
    }
    if (ch === '"') {
      quote = 'dq';
    } else if (OPEN_DQ.has(ch)) {
      quote = 'smart';
    } else if (OPEN_SQ.has(ch)) {
      quote = 'sq';
    } else if (ch === '{' || ch === '[') {
      stack.push(ch === '{' ? '}' : ']');
    } else if (ch === '}' || ch === ']') {
      stack.pop();
      if (!stack.length) {
        end = i + 1;
        break;
      }
    } else if (s.startsWith('```', i)) {
      end = i;
      break;
    }
  }
  const tail = s.slice(end).trim();
  if (tail && !/^```\s*$/.test(tail) && !fixes.includes('prose')) {
    fixes.push('prose');
  }
  s = s.slice(start, end).trimEnd();
  return s;
}

function stringEnds(kind: 'dq' | 'smart' | 'sq', s: string, i: number): boolean {
  const ch = s[i];
  return kind === 'dq' ? ch === '"' : kind === 'smart' ? OPEN_DQ.has(ch) : OPEN_SQ.has(ch) && closesSingle(s, i);
}

/** A single quote at `i` ends the string when what follows is structural (`,` `:` `}` `]` or the end). */
function closesSingle(s: string, i: number): boolean {
  const rest = s.slice(i + 1).replace(/^[^\S\n]+/, '');
  return rest === '' || /^[,:}\]\n]/.test(rest);
}

function escapeChar(ch: string): string {
  switch (ch) {
    case '\n':
      return '\\n';
    case '\r':
      return '\\r';
    case '\t':
      return '\\t';
    default:
      return ch < ' ' ? `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}` : ch;
  }
}

/** Rewrites one value's text into strict JSON tokens, recording which deterministic fixes it needed. */
function normalize(s: string, fixes: Set<string>): string {
  let out = '';
  let i = 0;
  const readString = (kind: 'dq' | 'smart' | 'sq'): void => {
    out += '"';
    i++;
    while (i < s.length) {
      const ch = s[i];
      if (ch === '\\') {
        const next = s[i + 1];
        if (next === undefined) {
          out += '\\';
          i++;
          return;
        }
        if (kind === 'sq' && next === "'") {
          out += "'";
        } else {
          out += ch + next;
        }
        i += 2;
        continue;
      }
      if (stringEnds(kind, s, i)) {
        out += '"';
        i++;
        return;
      }
      if (ch < ' ') {
        fixes.add('control_chars');
        out += escapeChar(ch);
      } else if (ch === '"' && kind !== 'dq') {
        out += '\\"';
      } else {
        out += ch;
      }
      i++;
    }
  };
  while (i < s.length) {
    const ch = s[i];
    if (ch === '"') {
      readString('dq');
    } else if (ch === '“' || ch === '”') {
      fixes.add('smart_quotes');
      readString('smart');
    } else if (OPEN_SQ.has(ch)) {
      fixes.add(SMART.test(ch) ? 'smart_quotes' : 'single_quotes');
      readString('sq');
    } else if (ch === '}' || ch === ']') {
      const trimmed = out.replace(/\s+$/, '');
      if (trimmed.endsWith(',')) {
        fixes.add('trailing_comma');
        out = trimmed.slice(0, -1);
      }
      out += ch;
      i++;
    } else if (/[A-Za-z_$]/.test(ch)) {
      const word = /^[A-Za-z_$][\w$-]*/.exec(s.slice(i))![0];
      const after = s.slice(i + word.length).replace(/^\s+/, '');
      if (after.startsWith(':')) {
        fixes.add('bare_keys');
        out += JSON.stringify(word);
      } else {
        out += word;
      }
      i += word.length;
    } else {
      out += ch;
      i++;
    }
  }
  return out;
}

interface Token {
  kind: 'open' | 'close' | 'comma' | 'colon' | 'string' | 'scalar';
  start: number;
  end: number;
  ch: string;
}

/** Tokenizes normalized JSON text; `unterminated` when it ends inside a string. */
function tokenize(s: string): { tokens: Token[]; unterminated: boolean } {
  const tokens: Token[] = [];
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (/\s/.test(ch)) {
      i++;
    } else if (ch === '"') {
      let j = i + 1;
      while (j < s.length && s[j] !== '"') {
        j += s[j] === '\\' ? 2 : 1;
      }
      if (j >= s.length) {
        return { tokens, unterminated: true };
      }
      tokens.push({ kind: 'string', start: i, end: j + 1, ch });
      i = j + 1;
    } else if (ch === '{' || ch === '[') {
      tokens.push({ kind: 'open', start: i, end: i + 1, ch });
      i++;
    } else if (ch === '}' || ch === ']') {
      tokens.push({ kind: 'close', start: i, end: i + 1, ch });
      i++;
    } else if (ch === ',' || ch === ':') {
      tokens.push({ kind: ch === ',' ? 'comma' : 'colon', start: i, end: i + 1, ch });
      i++;
    } else {
      const m = /^[^\s{}[\],:"]+/.exec(s.slice(i))!;
      tokens.push({ kind: 'scalar', start: i, end: i + m[0].length, ch: m[0] });
      i += m[0].length;
    }
  }
  return { tokens, unterminated: false };
}

/** Closers still needed after `tokens` (innermost last), or undefined when the nesting is inconsistent. */
function openStack(tokens: Token[]): string[] | undefined {
  const stack: string[] = [];
  for (const t of tokens) {
    if (t.kind === 'open') {
      stack.push(t.ch === '{' ? '}' : ']');
    } else if (t.kind === 'close' && stack.pop() !== t.ch) {
      return undefined;
    }
  }
  return stack;
}

/** Drops trailing incomplete members and closes open containers. Undefined when that is not safe. */
function closeTruncated(s: string): string | undefined {
  const { tokens, unterminated } = tokenize(s);
  if (unterminated) {
    return undefined;
  }
  const inObject = (n: number): boolean => openStack(tokens.slice(0, n))?.at(-1) === '}';
  for (;;) {
    const last = tokens.at(-1);
    if (!last) {
      return undefined;
    }
    const prev = tokens.at(-2);
    if (last.kind === 'comma') {
      tokens.pop();
    } else if (last.kind === 'colon') {
      tokens.pop();
      if (tokens.at(-1)?.kind === 'string') {
        tokens.pop();
      }
    } else if (last.kind === 'string' && inObject(tokens.length - 1) && (prev?.kind === 'open' || prev?.kind === 'comma')) {
      // A key with no value yet.
      tokens.pop();
    } else if (last.kind === 'scalar' && last.end === s.trimEnd().length && !/^(true|false|null)$/.test(last.ch)) {
      // A trailing number may have been cut short (`12` of `120`), a partial literal certainly was.
      tokens.pop();
      if (prev?.kind === 'colon') {
        tokens.pop();
        if (tokens.at(-1)?.kind === 'string') {
          tokens.pop();
        }
      }
    } else {
      break;
    }
  }
  const stack = openStack(tokens);
  if (!stack) {
    return undefined;
  }
  return s.slice(0, tokens.at(-1)!.end) + stack.reverse().join('');
}

/**
 * Repairs `raw` into JSON. Strict JSON is returned untouched; deterministic fixes apply only when it does not
 * parse. Truncation repairs need `allowTruncation`.
 */
export function repairJson(raw: string, opts: { allowTruncation?: boolean } = {}): RepairResult {
  const direct = tryParse(raw.trim());
  if (direct.ok) {
    return { ok: true, value: direct.value, text: raw.trim(), fixes: [], truncated: false };
  }
  const extracted: string[] = [];
  const body = extractValue(raw, extracted);
  const fixSet = new Set<string>(extracted);
  const normalized = normalize(body, fixSet);
  const fixes = (): string[] => [...fixSet];
  const parsed = tryParse(normalized);
  if (parsed.ok) {
    return { ok: true, value: parsed.value, text: normalized, fixes: fixes(), truncated: false };
  }
  const { tokens, unterminated } = tokenize(normalized);
  const stack = openStack(tokens);
  const truncated = unterminated || (!!stack && stack.length > 0);
  if (!truncated || !opts.allowTruncation) {
    return { ok: false, fixes: fixes(), truncated };
  }
  const closed = closeTruncated(normalized);
  const reparsed = closed === undefined ? { ok: false as const } : tryParse(closed);
  if (!reparsed.ok) {
    return { ok: false, fixes: fixes(), truncated };
  }
  fixSet.add('truncation');
  return { ok: true, value: reparsed.value, text: closed, fixes: fixes(), truncated };
}

export interface RepairToolCallOptions {
  knownToolNames: ReadonlySet<string> | readonly string[];
  /** The stream's finish reason; `'length'` cut-offs are never repaired here. */
  finish?: string;
  requiredParams: (tool: string) => string[];
  /** JSON-schema primitive types of the tool's parameters, when known. */
  paramTypes?: (tool: string) => Record<string, string> | undefined;
  /** Whether the tool has no side effects (registry `readOnly`/`approvalKind`). Truncation repair is only ever
   *  applied to tools this accepts; without it no truncated call is repaired. */
  isReadOnly?: (tool: string) => boolean;
}

export interface RepairedToolCall {
  name: string;
  arguments: Record<string, unknown>;
  /** `arguments` serialized, as a ToolCall carries it. */
  argumentsJson: string;
  fixes: string[];
  truncated: boolean;
  /** The block that was repaired, as it appeared in the text. */
  block: string;
  /** The text with that block replaced by a well-formed ```tool_call fence. */
  text: string;
}

interface Block {
  start: number;
  end: number;
  body: string;
}

/**
 * Every candidate tool-call block: ```tool_call fences and <tool_call> tags first (by position), then bare
 * {"name": …} objects that do not sit inside one of those or inside an earlier bare candidate.
 */
function findBlocks(text: string): Block[] {
  const explicit: Block[] = [];
  const marked = (open: RegExp, closeTag: string): void => {
    for (let m = open.exec(text); m; m = open.exec(text)) {
      const from = m.index + m[0].length;
      const close = text.indexOf(closeTag, from);
      const end = close < 0 ? text.length : close + closeTag.length;
      explicit.push({ start: m.index, end, body: text.slice(from, close < 0 ? text.length : close) });
      open.lastIndex = end;
    }
  };
  marked(/```tool_call[^\S\n]*\n?/g, '```');
  marked(/<tool_call>/g, '</tool_call>');
  explicit.sort((a, b) => a.start - b.start);
  const bare: Block[] = [];
  const covered = (i: number): boolean => [...explicit, ...bare].some((b) => i >= b.start && i < b.end);
  const re = /\{\s*["'“]?name["'”]?\s*:/g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (covered(m.index)) {
      continue;
    }
    const body = extractValue(text.slice(m.index), []);
    let start = m.index;
    let end = m.index + body.length;
    // Inside a ```json fence: replace the whole fence, not just the object.
    const open = /```(?:json)?\s*$/.exec(text.slice(0, start));
    const close = /^\s*```/.exec(text.slice(end));
    if (open && (close || end === text.length)) {
      start = open.index;
      end += close ? close[0].length : 0;
    }
    bare.push({ start, end, body });
  }
  return [...explicit, ...bare];
}

function typeMatches(value: unknown, type: string): boolean {
  switch (type) {
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number';
    case 'integer':
      return Number.isInteger(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'array':
      return Array.isArray(value);
    case 'object':
      return !!value && typeof value === 'object' && !Array.isArray(value);
    default:
      return true;
  }
}

/**
 * Repairs the first tool call written as text. Undefined when there is none, the output was cut off by the
 * length limit, or no candidate block survives: a truncated call is only repaired for a read-only tool, and the
 * repaired arguments must have every required parameter and the right primitive types. The caller then falls
 * back to the repair nudge.
 */
export function repairToolCallText(text: string, opts: RepairToolCallOptions): RepairedToolCall | undefined {
  if (opts.finish === 'length') {
    return undefined;
  }
  for (const block of findBlocks(text)) {
    const call = repairBlock(text, block, opts);
    if (call) {
      return call;
    }
  }
  return undefined;
}

function repairBlock(text: string, block: Block, opts: RepairToolCallOptions): RepairedToolCall | undefined {
  const known = (name: string): boolean =>
    Array.isArray(opts.knownToolNames) ? opts.knownToolNames.includes(name) : (opts.knownToolNames as ReadonlySet<string>).has(name);
  const mayTruncate = (name: string): boolean => known(name) && !isMutatingToolName(name) && !!opts.isReadOnly?.(name);
  let result = repairJson(block.body);
  if (!result.ok && result.truncated) {
    const name = /["'“]?name["'”]?\s*:\s*["'“]([\w.-]+)["'”]/.exec(block.body)?.[1];
    if (!name || !mayTruncate(name)) {
      return undefined;
    }
    result = repairJson(block.body, { allowTruncation: true });
  }
  if (!result.ok) {
    return undefined;
  }
  const obj = result.value as { name?: unknown; arguments?: unknown; parameters?: unknown } | null;
  if (!obj || typeof obj !== 'object' || Array.isArray(obj) || typeof obj.name !== 'string' || !known(obj.name)) {
    return undefined;
  }
  const name = obj.name;
  if (result.truncated && !mayTruncate(name)) {
    return undefined;
  }
  let args: unknown = obj.arguments ?? obj.parameters ?? {};
  if (typeof args === 'string') {
    const inner = repairJson(args);
    if (!inner.ok) {
      return undefined;
    }
    args = inner.value;
    result.fixes.push(...inner.fixes.filter((f) => !result.fixes.includes(f)));
  }
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    return undefined;
  }
  const record = args as Record<string, unknown>;
  if (opts.requiredParams(name).some((p) => record[p] === undefined || record[p] === null)) {
    return undefined;
  }
  const types = opts.paramTypes?.(name) ?? {};
  if (Object.entries(record).some(([k, v]) => types[k] !== undefined && v !== null && !typeMatches(v, types[k]))) {
    return undefined;
  }
  const argumentsJson = JSON.stringify(record);
  const canonical = '```tool_call\n' + JSON.stringify({ name, arguments: record }) + '\n```';
  return {
    name,
    arguments: record,
    argumentsJson,
    fixes: result.fixes,
    truncated: result.truncated,
    block: text.slice(block.start, block.end),
    text: text.slice(0, block.start) + canonical + text.slice(block.end),
  };
}
