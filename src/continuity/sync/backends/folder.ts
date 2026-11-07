// Folder backend (design §14.5): any directory, typically one a cloud drive keeps in step (iCloud Drive, Dropbox,
// OneDrive, Google Drive for desktop) or a network share. Objects are files under `<folder>/localpilot-sync/`, written
// to a temporary name and renamed into place, so a reader (or the cloud client) never sees half an object. Copies the
// providers make on their own ("x (conflicted copy).lpe", "x-conflict-…", "x (1).lpe") and iCloud placeholders of files
// not downloaded yet (".x.icloud") are ignored. Pure Node.
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { BackendError, checkKey, CheckResult, PutOptions, reasonOf, RemoteEntry, SyncBackend } from './backend';

export const ROOT_DIR = 'localpilot-sync';

/** Names cloud drives give their own copies of a file both sides changed. */
export function isProviderCopy(name: string): boolean {
  return /\(conflicted copy[^)]*\)/i.test(name) || /-conflict-/i.test(name) || /\s\(\d+\)(\.[^.]+)*$/.test(name) || /\sconflict\s/i.test(name) || /\.tmp-[\w-]+$/.test(name);
}

/** `.name.icloud`: a file iCloud has not downloaded yet. */
export function icloudPlaceholder(name: string): string | undefined {
  const m = /^\.(.+)\.icloud$/.exec(name);
  return m ? m[1] : undefined;
}

export class FolderBackend implements SyncBackend {
  readonly kind = 'folder' as const;
  readonly label: string;
  readonly root: string;
  /** Keys iCloud lists but has not downloaded yet (seen by the last `list`); retried next cycle. */
  readonly notDownloaded = new Set<string>();

  constructor(folder: string, rootName = ROOT_DIR) {
    this.root = path.join(path.resolve(folder), rootName);
    this.label = path.resolve(folder);
  }

  private file(key: string): string {
    return path.join(this.root, ...checkKey(key).split('/'));
  }

  async check(): Promise<CheckResult> {
    const base = path.dirname(this.root);
    try {
      const st = await fs.promises.stat(base);
      if (!st.isDirectory()) {
        return { ok: false, reason: 'not-found', message: `${base} is not a folder` };
      }
      await fs.promises.mkdir(this.root, { recursive: true });
      const probe = path.join(this.root, `.probe-${crypto.randomBytes(4).toString('hex')}`);
      await fs.promises.writeFile(probe, 'ok');
      await fs.promises.rm(probe, { force: true });
      return { ok: true };
    } catch (e) {
      const reason = reasonOf(e);
      return { ok: false, reason, message: reason === 'not-found' ? `The folder ${base} does not exist` : reason === 'forbidden' ? `LocalPilot cannot write to ${base}` : String((e as Error).message ?? e) };
    }
  }

  async list(prefix: string, after?: string): Promise<RemoteEntry[]> {
    // Walk the folder that holds the prefix (keys are few levels deep: devices/x, streams/<id>/y, blobs/z).
    const slash = prefix.lastIndexOf('/');
    const dirKey = slash >= 0 ? prefix.slice(0, slash) : '';
    const out: RemoteEntry[] = [];
    const walk = async (dir: string, keyPrefix: string): Promise<void> => {
      let names: fs.Dirent[];
      try {
        names = await fs.promises.readdir(dir, { withFileTypes: true });
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
          return;
        }
        throw new BackendError(reasonOf(e), `cannot read ${dir}: ${(e as Error).message}`);
      }
      for (const d of names) {
        const ph = icloudPlaceholder(d.name);
        if (ph) {
          const key = `${keyPrefix}${ph}`;
          if (key.startsWith(prefix)) {
            this.notDownloaded.add(key);
          }
          continue;
        }
        if (d.name.startsWith('.') || isProviderCopy(d.name)) {
          continue;
        }
        const key = `${keyPrefix}${d.name}`;
        if (d.isDirectory()) {
          if (key.startsWith(prefix) || prefix.startsWith(`${key}/`)) {
            await walk(path.join(dir, d.name), `${key}/`);
          }
          continue;
        }
        if (!key.startsWith(prefix) || (after && key <= after)) {
          continue;
        }
        try {
          const st = await fs.promises.stat(path.join(dir, d.name));
          out.push({ key, size: st.size, etag: `${st.size}-${Math.floor(st.mtimeMs)}`, modified: st.mtimeMs });
        } catch {
          // removed while listing
        }
      }
    };
    this.notDownloaded.clear();
    await walk(dirKey ? this.file(dirKey) : this.root, dirKey ? `${dirKey}/` : '');
    return out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  }

  async get(key: string): Promise<Uint8Array | undefined> {
    try {
      return await fs.promises.readFile(this.file(key));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
        return undefined;
      }
      throw new BackendError(reasonOf(e), `cannot read ${key}: ${(e as Error).message}`);
    }
  }

  async head(key: string): Promise<RemoteEntry | undefined> {
    try {
      const st = await fs.promises.stat(this.file(key));
      return { key, size: st.size, etag: `${st.size}-${Math.floor(st.mtimeMs)}`, modified: st.mtimeMs };
    } catch {
      return undefined;
    }
  }

  async put(key: string, body: Uint8Array, o: PutOptions = {}): Promise<{ etag?: string }> {
    const target = this.file(key);
    try {
      await fs.promises.mkdir(path.dirname(target), { recursive: true });
      const tmp = `${target}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
      await fs.promises.writeFile(tmp, body);
      try {
        if (o.ifAbsent) {
          // link() fails when the target exists: an atomic create-if-absent on every local file system.
          try {
            await fs.promises.link(tmp, target);
          } catch (e) {
            const code = (e as NodeJS.ErrnoException).code;
            if (code === 'EEXIST') {
              throw new BackendError('precondition', `${key} exists`);
            }
            // File systems without hard links (some network shares, FAT): exclusive create instead.
            const fh = await fs.promises.open(target, 'wx').catch((e2: NodeJS.ErrnoException) => {
              throw e2.code === 'EEXIST' ? new BackendError('precondition', `${key} exists`) : e2;
            });
            try {
              await fh.writeFile(body);
            } finally {
              await fh.close();
            }
          }
        } else {
          if (o.ifMatch) {
            const cur = await this.head(key);
            if (cur?.etag !== o.ifMatch) {
              throw new BackendError('precondition', `${key} changed`);
            }
          }
          await fs.promises.rename(tmp, target);
          // Compare-and-swap on a folder: re-read and verify what landed is ours (another writer may have raced).
          if (o.ifMatch) {
            const back = await fs.promises.readFile(target);
            if (!back.equals(Buffer.from(body))) {
              throw new BackendError('precondition', `${key} changed`);
            }
          }
        }
      } finally {
        await fs.promises.rm(tmp, { force: true });
      }
      const st = await fs.promises.stat(target);
      return { etag: `${st.size}-${Math.floor(st.mtimeMs)}` };
    } catch (e) {
      if (e instanceof BackendError) {
        throw e;
      }
      throw new BackendError(reasonOf(e), `cannot write ${key}: ${(e as Error).message}`);
    }
  }

  async delete(key: string): Promise<void> {
    await fs.promises.rm(this.file(key), { force: true });
  }

  dispose(): void {
    // nothing to release
  }
}
