import { promises as fs } from 'fs';

/**
 * `fs.rename` that rides out Windows sharing violations: replacing a file another handle has open (a concurrent
 * load, an antivirus or indexer scan) fails with EPERM/EACCES/EBUSY for a moment. Retried with a short backoff
 * (about 3 s in total), as graceful-fs does; other errors and other platforms fail at once.
 */
export async function renameWithRetry(from: string, to: string, rename: (a: string, b: string) => Promise<void> = fs.rename, platform: NodeJS.Platform = process.platform): Promise<void> {
  for (let i = 0; ; i++) {
    try {
      return await rename(from, to);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException)?.code;
      if (platform !== 'win32' || i >= 12 || (code !== 'EPERM' && code !== 'EACCES' && code !== 'EBUSY')) {
        throw e;
      }
      await new Promise((r) => setTimeout(r, Math.min(10 * 2 ** i, 400)));
    }
  }
}
