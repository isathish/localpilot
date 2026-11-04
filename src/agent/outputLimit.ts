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
