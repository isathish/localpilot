/**
 * Test helpers that poll instead of sleeping a fixed time, so slow CI machines (file watcher latency, a busy Extension
 * Host) wait longer and fast ones do not wait at all.
 */

/** Resolves once `condition` is truthy; rejects with `what` after `timeoutMs`. */
export async function waitFor(condition: () => unknown | Promise<unknown>, timeoutMs = 5_000, what = 'condition', intervalMs = 25): Promise<void> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    if (await condition()) {
      return;
    }
    if (Date.now() > end) {
      throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}`);
    }
    await sleep(intervalMs);
  }
}

/** For "nothing else happens" checks only: waiting a fixed time is the point there. */
export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
