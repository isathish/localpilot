// Content-addressed blob store (design §5.7): `blobs/sha256/<2>/<64>`, immutable, written tmp + rename. Images,
// attachments, tool outputs over 64 KiB and checkpoint contents live here; events reference them by sha256.
// Pure Node.
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

export const sha256 = (b: Uint8Array | string): string => crypto.createHash('sha256').update(b).digest('hex');
const isSha = (s: string) => /^[0-9a-f]{64}$/.test(s);

export class BlobStore {
  readonly dir: string;

  constructor(root: string, private readonly now: () => number = Date.now) {
    this.dir = path.join(root, 'blobs', 'sha256');
  }

  pathOf(sha: string): string {
    if (!isSha(sha)) {
      throw new Error(`not a sha256: ${sha}`);
    }
    return path.join(this.dir, sha.slice(0, 2), sha);
  }

  has(sha: string): boolean {
    return isSha(sha) && fs.existsSync(this.pathOf(sha));
  }

  /** Stores the bytes (no-op when present) and returns their sha256. */
  put(data: Uint8Array | string): string {
    const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data);
    const sha = sha256(buf);
    const file = this.pathOf(sha);
    if (fs.existsSync(file)) {
      return sha;
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
    fs.writeFileSync(tmp, buf);
    try {
      fs.renameSync(tmp, file);
    } catch (e) {
      fs.rmSync(tmp, { force: true });
      if (!fs.existsSync(file)) {
        throw e;
      }
    }
    return sha;
  }

  /** The bytes, verified against their name; undefined when absent or damaged. */
  get(sha: string): Buffer | undefined {
    try {
      const buf = fs.readFileSync(this.pathOf(sha));
      return sha256(buf) === sha ? buf : undefined;
    } catch {
      return undefined;
    }
  }

  /** Every stored blob with its size and age. */
  list(): { sha: string; bytes: number; mtimeMs: number }[] {
    const out: { sha: string; bytes: number; mtimeMs: number }[] = [];
    let shards: string[];
    try {
      shards = fs.readdirSync(this.dir);
    } catch {
      return out;
    }
    for (const s of shards) {
      let names: string[];
      try {
        names = fs.readdirSync(path.join(this.dir, s));
      } catch {
        continue;
      }
      for (const n of names) {
        const file = path.join(this.dir, s, n);
        if (isSha(n)) {
          try {
            const st = fs.statSync(file);
            out.push({ sha: n, bytes: st.size, mtimeMs: st.mtimeMs });
          } catch {
            // vanished
          }
        } else if (/\.tmp-/.test(n)) {
          // A tmp file left by a crashed writer.
          try {
            if (this.now() - fs.statSync(file).mtimeMs > 3600_000) {
              fs.rmSync(file, { force: true });
            }
          } catch {
            // ignore
          }
        }
      }
    }
    return out;
  }

  /** Removes blobs nothing references that are older than `olderThanDays`. Returns what was removed. */
  gc(referenced: ReadonlySet<string>, olderThanDays = 7): { removed: number; bytes: number } {
    const cutoff = this.now() - olderThanDays * 86_400_000;
    let removed = 0;
    let bytes = 0;
    for (const b of this.list()) {
      if (!referenced.has(b.sha) && b.mtimeMs < cutoff) {
        try {
          fs.rmSync(this.pathOf(b.sha), { force: true });
          removed++;
          bytes += b.bytes;
        } catch {
          // ignore
        }
      }
    }
    return { removed, bytes };
  }
}
