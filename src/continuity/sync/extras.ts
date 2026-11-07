// What sync carries besides the stores that log themselves (design §14.2 categories):
// - prompts: user-level custom commands (`~/.localpilot/commands/*.md`) as `prompt_template` entities, written back
//   to the files when a remote change arrives and the file still holds what this machine last saw (otherwise a
//   `text-merge` conflict, file untouched);
// - preferences: an allow-list of settings (default model, plan-mode model, thinking level, approval levels, Auto
//   mode, favorite models) as `preference` entities; never API keys, endpoints or credentials;
// - checkpointContents: a git bundle (≤ 50 MB) of each of this device's git checkpoints, as a blob, so another device
//   can restore it.
// Each runs before the push (logs local changes) and after the pull (applies remote ones). Pure Node.
import { execFile } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { promptTemplateFields, promptTemplateId } from '../conversation/payloads';
import type { BlobStore } from '../data/blobs';
import type { FileEventLog } from '../data/eventLog';
import type { IndexClient } from '../data/index/indexClient';
import { stableId } from '../ids';
import type { SyncCategory } from './merge';

export interface SyncExtra {
  readonly category: SyncCategory;
  /** Logs what changed here since the last cycle. */
  beforePush(): Promise<void>;
  /** Applies what other devices changed. */
  afterPull(): Promise<void>;
}

const sha = (s: string) => crypto.createHash('sha256').update(s.replace(/\r\n?/g, '\n')).digest('hex');

/** `<dataRoot>/sync/<name>.json`: what this machine last saw, per file or key (shared by its processes). */
class Seen {
  private readonly file: string;
  constructor(root: string, name: string) {
    this.file = path.join(root, 'sync', `${name}.json`);
  }
  read(): Record<string, string> {
    try {
      return JSON.parse(fs.readFileSync(this.file, 'utf8')) as Record<string, string>;
    } catch {
      return {};
    }
  }
  write(v: Record<string, string>): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(v, null, 1));
    fs.renameSync(tmp, this.file);
  }
}

function writeAtomic(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(3).toString('hex')}`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

// ------------------------------------------------------------------------------------------------ prompts

export class PromptsExtra implements SyncExtra {
  readonly category = 'prompts' as const;
  private readonly seen: Seen;
  /** `~/.localpilot/commands` (the prompt library's user scope). */
  readonly dir: string;

  constructor(private readonly o: { log: FileEventLog; index: IndexClient; root: string; dir?: string; warn?: (m: string) => void }) {
    this.seen = new Seen(o.root, 'prompts-seen');
    this.dir = o.dir ?? path.join(os.homedir(), '.localpilot', 'commands');
  }

  private files(): string[] {
    try {
      return fs.readdirSync(this.dir).filter((n) => n.endsWith('.md') && !n.startsWith('.')).sort();
    } catch {
      return [];
    }
  }

  async beforePush(): Promise<void> {
    const seen = this.seen.read();
    const rows = new Map((await this.o.index.query<{ id: string; body: string | null; trashed_at: number | null }>('promptTemplates', { scope: 'user' })).map((r) => [r.id, r]));
    let changed = false;
    const here = new Set<string>();
    for (const n of this.files()) {
      const name = n.slice(0, -3);
      const file = path.join(this.dir, n);
      const text = fs.readFileSync(file, 'utf8');
      const h = sha(text);
      here.add(file);
      const id = promptTemplateId('user', 'user', name);
      const row = rows.get(id);
      if (seen[file] === h && row && !row.trashed_at) {
        continue;
      }
      if (row && !row.trashed_at && sha(row.body ?? '') === h) {
        seen[file] = h; // already logged (another process, or the import)
        changed = true;
        continue;
      }
      this.o.log.append('prompt_template', id, row ? 'patch' : 'create', row ? { body: text, description: promptTemplateFields({ name, text, scope: 'user' }).description, trashedAt: null } : promptTemplateFields({ name, text, scope: 'user', file: n }), { base: this.o.log.peekHlc() });
      seen[file] = h;
      changed = true;
    }
    // A file this machine had that is gone: deleted here.
    for (const file of Object.keys(seen)) {
      if (!here.has(file) && path.dirname(file) === this.dir) {
        const id = promptTemplateId('user', 'user', path.basename(file, '.md'));
        if (rows.get(id) && !rows.get(id)!.trashed_at) {
          this.o.log.append('prompt_template', id, 'trash', { at: Date.now(), reason: 'deleted' });
        }
        delete seen[file];
        changed = true;
      }
    }
    if (changed) {
      this.seen.write(seen);
    }
  }

  async afterPull(): Promise<void> {
    const seen = this.seen.read();
    let changed = false;
    for (const r of await this.o.index.query<{ id: string; name: string; body: string | null; file: string | null; trashed_at: number | null }>('promptTemplates', { scope: 'user' })) {
      const name = (r.file ?? `${r.name}.md`).replace(/[\\/]/g, '_');
      if (!/^[\w.@ -]+\.md$/.test(name) || name.includes('..')) {
        continue;
      }
      const file = path.join(this.dir, name);
      const cur = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : undefined;
      const curHash = cur === undefined ? undefined : sha(cur);
      if (r.trashed_at) {
        if (cur !== undefined && curHash === seen[file]) {
          fs.rmSync(file, { force: true });
          delete seen[file];
          changed = true;
        }
        continue;
      }
      const body = r.body ?? '';
      const want = sha(body);
      if (curHash === want) {
        if (seen[file] !== want) {
          seen[file] = want;
          changed = true;
        }
        continue;
      }
      if (cur === undefined || curHash === seen[file]) {
        writeAtomic(file, body);
        seen[file] = want;
        changed = true;
      } else {
        // Edited here and elsewhere: keep the file, record a conflict (Sync manager → Conflicts).
        const here = this.o.log.device.deviceId;
        this.o.log.append('conflict', stableId('cf', 'prompt', r.id, curHash ?? '', want), 'create', { entity: 'prompt_template', entityId: r.id, field: 'body', kind: 'text-merge', ours: { value: cur, hlc: this.o.log.peekHlc(), device: here }, theirs: { value: body, hlc: '', device: 'remote', name: r.name }, applied: 'ours' }, { durable: true });
        this.o.warn?.(`sync: prompt "${r.name}" changed here and elsewhere; kept this machine's file and recorded a conflict`);
      }
    }
    if (changed) {
      this.seen.write(seen);
    }
  }
}

// ------------------------------------------------------------------------------------------------ preferences

/** The settings that sync (never keys, endpoints or anything with credentials). */
export const PREFERENCE_KEYS = ['defaultModel', 'routing.reasoning', 'thinking', 'approvals.terminal', 'approvals.write', 'approvals.delete', 'approvals.network', 'approvals.mcp', 'autoMode.enabled'] as const;
export const FAVORITES_KEY = 'favoriteModels';

export interface PreferenceAccess {
  read(key: string): unknown;
  write(key: string, value: unknown): Promise<void>;
}

export class PreferencesExtra implements SyncExtra {
  readonly category = 'preferences' as const;
  private readonly seen: Seen;

  constructor(private readonly o: { log: FileEventLog; index: IndexClient; root: string; access: PreferenceAccess; keys?: readonly string[] }) {
    this.seen = new Seen(o.root, 'preferences-seen');
  }

  private get keys(): readonly string[] {
    return this.o.keys ?? [...PREFERENCE_KEYS, FAVORITES_KEY];
  }

  async beforePush(): Promise<void> {
    const seen = this.seen.read();
    let changed = false;
    for (const key of this.keys) {
      const v = this.o.access.read(key);
      if (v === undefined) {
        continue;
      }
      const j = JSON.stringify(v);
      if (seen[key] === j) {
        continue;
      }
      this.o.log.append('preference', stableId('pref', key), 'create', { key, value: v });
      seen[key] = j;
      changed = true;
    }
    if (changed) {
      this.seen.write(seen);
    }
  }

  async afterPull(): Promise<void> {
    const seen = this.seen.read();
    let changed = false;
    const allowed = new Set(this.keys);
    for (const r of await this.o.index.query<{ key: string; value: string | null }>('preferences', {})) {
      if (!allowed.has(r.key) || r.value === null) {
        continue;
      }
      if (seen[r.key] === r.value) {
        continue;
      }
      const local = this.o.access.read(r.key);
      const lj = local === undefined ? undefined : JSON.stringify(local);
      // Changed here since the last sync: this device's value goes out next and wins by time.
      if (seen[r.key] !== undefined && lj !== seen[r.key]) {
        continue;
      }
      try {
        await this.o.access.write(r.key, JSON.parse(r.value));
        seen[r.key] = r.value;
        changed = true;
      } catch {
        // a setting that cannot be written here (policy): skip
      }
    }
    if (changed) {
      this.seen.write(seen);
    }
  }
}

// ------------------------------------------------------------------------------------------------ checkpoint contents

export const CHECKPOINT_BUNDLE_MAX = 50 * 1024 * 1024;

function git(cwd: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, maxBuffer: 8 * 1024 * 1024, windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' } }, (err, stdout, stderr) =>
      resolve({ code: err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : 1) : 0, stdout: String(stdout), stderr: String(stderr) })
    );
  });
}

export class CheckpointContentsExtra implements SyncExtra {
  readonly category = 'checkpointContents' as const;
  /** Over 50 MB (or not bundlable): not tried again by this process. */
  private readonly skipped = new Set<string>();

  constructor(private readonly o: { log: FileEventLog; index: IndexClient; blobs: BlobStore; perCycle?: number; warn?: (m: string) => void }) {}

  /** Bundles this device's newest git checkpoints that have no content blob yet (a few per cycle). */
  async beforePush(): Promise<void> {
    const rows = await this.o.index.query<{ id: string; ref: string; sha: string | null; root: string | null }>('checkpointsWithoutContent', { device: this.o.log.device.deviceId, limit: (this.o.perCycle ?? 3) + this.skipped.size });
    for (const r of rows.filter((x) => !this.skipped.has(x.id)).slice(0, this.o.perCycle ?? 3)) {
      if (!r.root || !fs.existsSync(path.join(r.root, '.git')) || !/^refs\/localpilot\//.test(r.ref)) {
        continue;
      }
      const tmp = path.join(os.tmpdir(), `lp-cp-${process.pid}-${crypto.randomBytes(4).toString('hex')}.bundle`);
      try {
        // The checkpoint commit and what it adds over the commit it was taken on (that one is in the repository).
        const parent = await git(r.root, ['rev-parse', '--verify', '-q', `${r.ref}^1`]);
        const args = ['bundle', 'create', tmp, r.ref, ...(parent.code ? [] : [`^${parent.stdout.trim()}`])];
        const b = await git(r.root, args);
        if (b.code || !fs.existsSync(tmp)) {
          this.skipped.add(r.id);
          continue;
        }
        if (fs.statSync(tmp).size > CHECKPOINT_BUNDLE_MAX) {
          this.skipped.add(r.id);
          continue;
        }
        const blob = this.o.blobs.put(fs.readFileSync(tmp));
        this.o.log.append('checkpoint', r.id, 'patch', { contentBlob: blob });
      } finally {
        fs.rmSync(tmp, { force: true });
      }
    }
  }

  async afterPull(): Promise<void> {
    // Contents are fetched with the blobs; restoring imports them (importCheckpointBundle).
  }
}

/**
 * Makes a checkpoint taken on another device restorable here: its synced bundle is fetched into the local repository
 * under the same ref. Returns false when there is no bundle (or git refuses it: the commit it was taken on is missing).
 */
export async function importCheckpointBundle(o: { blobs: BlobStore; fetchBlob?: (sha: string) => Promise<boolean> }, contentBlob: string, ref: string, root: string): Promise<{ ok: boolean; message?: string }> {
  // The ref comes from synced data: only ever (force-)update LocalPilot's own checkpoint refs, never a branch or tag.
  if (!/^refs\/localpilot\/[\w./-]+$/.test(ref) || ref.includes('..') || ref.endsWith('.lock')) {
    return { ok: false, message: `not a LocalPilot checkpoint ref (${ref})` };
  }
  if (!o.blobs.has(contentBlob) && !(await o.fetchBlob?.(contentBlob))) {
    return { ok: false, message: 'the checkpoint contents have not been downloaded yet' };
  }
  const data = o.blobs.get(contentBlob);
  if (!data) {
    return { ok: false, message: 'the checkpoint contents are damaged' };
  }
  const tmp = path.join(os.tmpdir(), `lp-cp-in-${process.pid}-${crypto.randomBytes(4).toString('hex')}.bundle`);
  fs.writeFileSync(tmp, data);
  try {
    const v = await git(root, ['bundle', 'verify', tmp]);
    if (v.code) {
      return { ok: false, message: `this repository lacks the commit the checkpoint was taken on (${v.stderr.trim().split('\n').pop() ?? 'git bundle verify failed'})` };
    }
    const f = await git(root, ['fetch', '-q', tmp, `+${ref}:${ref}`]);
    return f.code ? { ok: false, message: f.stderr.trim() } : { ok: true };
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}
