/** Recovery when a reply stops at the output-token limit (`finishReason: 'length'`). */

/** Cut-off tool calls retried in a row before the run gives up. */
export const MAX_LENGTH_RETRIES = 3;

export const LENGTH_NUDGE = 'Your reply was cut off at the output limit. Be concise; split large write_file content into several edit_file calls.';

export const CONTINUE_NUDGE = 'Your reply was cut off at the output limit. Continue exactly where you stopped — do not repeat what you already wrote, do not start over.';

export type LengthAction = 'none' | 'retry' | 'continue' | 'give_up';

/**
 * What to do with a finished reply. A cut-off tool call (native, or a text-protocol call that no longer parses) is
 * retried with a nudge up to MAX_LENGTH_RETRIES times in a row; cut-off prose is continued once and joined.
 */
export function lengthAction(o: { finish?: string; truncatedCall: boolean; text: string; retries: number; continuing: boolean }): LengthAction {
  if (o.finish !== 'length') {
    return 'none';
  }
  if (o.truncatedCall) {
    return o.retries >= MAX_LENGTH_RETRIES ? 'give_up' : 'retry';
  }
  return o.text.trim() && !o.continuing ? 'continue' : 'none';
}

export function lengthGiveUpMessage(maxOutputTokens: number, times: number): string {
  return `The reply was cut off at the ${maxOutputTokens}-token output limit ${times} times in a row, so nothing was executed. Raise localpilot.maxOutputTokens or ask for the change in smaller steps.`;
}

/** The reply that answered CONTINUE_NUDGE, glued onto the cut-off one (no separator: it resumes mid-sentence or mid-line). */
export function joinContinuation(before: string, after: string): string {
  if (!before) {
    return after;
  }
  // Models often restate the last few words; drop an exact overlap of up to 200 characters.
  const max = Math.min(200, before.length, after.length);
  for (let n = max; n >= 8; n--) {
    if (before.endsWith(after.slice(0, n))) {
      return before + after.slice(n);
    }
  }
  return before + after;
}

/**
 * True when a text-protocol tool call was cut off before it ended: an open `<tool_call>` without its closing tag, an
 * unclosed ``` fence that starts a `{"name": "<known tool>"` object, or such a bare object whose braces never close.
 */
export function hasUnterminatedToolCall(text: string, known: ReadonlySet<string>): boolean {
  if ((text.match(/<tool_call>/g) ?? []).length > (text.match(/<\/tool_call>/g) ?? []).length) {
    return true;
  }
  const head = /\{\s*"name"\s*:\s*"([^"\\]+)"/g;
  const fences = text.split('```');
  if (fences.length % 2 === 0) {
    const open = fences[fences.length - 1].replace(/^(tool_call|json)?\s*/, '');
    head.lastIndex = 0;
    const m = head.exec(open);
    if (m && m.index === 0 && known.has(m[1])) {
      return true;
    }
  }
  head.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = head.exec(text))) {
    if (known.has(m[1]) && !closes(text, m.index)) {
      return true;
    }
  }
  return false;
}

/** Whether the `{` at `from` has a matching `}` (string-aware). */
function closes(text: string, from: number): boolean {
  let depth = 0;
  let inStr = false;
  for (let i = from; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (ch === '\\') {
        i++;
      } else if (ch === '"') {
        inStr = false;
      }
    } else if (ch === '"') {
      inStr = true;
    } else if (ch === '{') {
      depth++;
    } else if (ch === '}' && --depth === 0) {
      return true;
    }
  }
  return false;
}
