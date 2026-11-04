/**
 * Consecutive-mistake limit: a step whose tool calls all failed, or a tool call that had to be repaired, counts as a
 * mistake; any successful tool call resets the count. Small models can otherwise burn a whole run retrying a dead end.
 */
export class MistakeCounter {
  count = 0;
  latest = '';

  /** `limit` 0 (or less) turns the limit off; the count is still kept. */
  constructor(readonly limit: number) {}

  /** One executed step: true when the limit has just been reached. */
  recordStep(results: { isError: boolean; content: string }[]): boolean {
    if (!results.length) {
      return false;
    }
    if (results.some((r) => !r.isError)) {
      this.reset();
      return false;
    }
    return this.add(results[results.length - 1].content);
  }

  /** A tool call that did not parse and was handed back for repair. */
  recordRepair(reason: string): boolean {
    return this.add(`invalid tool call (${reason})`);
  }

  reset(): void {
    this.count = 0;
    this.latest = '';
  }

  get reached(): boolean {
    return this.limit > 0 && this.count >= this.limit;
  }

  private add(reason: string): boolean {
    this.count++;
    this.latest = mistakeReason(reason);
    return this.reached;
  }
}

/** The first meaningful line of a failed result, without the text-protocol wrapper, kept short for the error row. */
export function mistakeReason(content: string): string {
  const line = content
    .replace(/<\/?tool_result[^>]*>/g, '')
    .split('\n')
    .map((l) => l.trim())
    .find(Boolean) ?? 'unknown error';
  return line.length > 200 ? `${line.slice(0, 199)}…` : line;
}

export function mistakeLimitMessage(count: number, latest: string): string {
  return `LocalPilot ran into ${count} errors in a row and stopped. Latest: ${latest || 'unknown error'}. Send a message to guide it and continue.`;
}
