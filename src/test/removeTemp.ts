import * as fs from 'fs';
import * as path from 'path';

/**
 * Removes a test's temporary folder. On Windows git writes its object files read-only and a process that just exited
 * can still hold a handle for a moment; neither should fail a test, so files are made writable, the removal is
 * retried, and a folder that still cannot go is left for the OS to clean up.
 */
export function removeTemp(dir: string): void {
  const rm = () => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  try {
    rm();
  } catch {
    try {
      const writable = (p: string): void => {
        for (const e of fs.readdirSync(p, { withFileTypes: true })) {
          const f = path.join(p, e.name);
          fs.chmodSync(f, 0o777);
          if (e.isDirectory()) {
            writable(f);
          }
        }
      };
      writable(dir);
      rm();
    } catch {
      /* left for the OS temp cleanup */
    }
  }
}
