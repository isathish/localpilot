import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parseFrontMatter } from './frontMatter';

/**
 * A task board shared by everyone (people and agents) working in a repository: `.localpilot/board/<id>.md`, one
 * Markdown file per task with its state in front matter and its brief and handoff notes below. Commit the folder and
 * the board travels with the code; reviewers read it like any other file.
 *
 * Several workers (`localpilot work` in other terminals or on machines sharing the folder, agents calling the
 * team_board tool) take tasks from it at once. A claim is made under an exclusive lock file and holds a lease that the
 * worker renews while it works; a task whose lease ran out (the worker crashed or was closed) can be claimed again.
 */

export type BoardStatus = 'open' | 'claimed' | 'done' | 'failed';

export interface BoardTask {
  id: string;
  title: string;
  status: BoardStatus;
  /** Lower runs first. */
  priority: number;
  dependsOn: string[];
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  /** Who holds it (`user@host · worker`), while claimed or after finishing. */
  owner?: string;
  leaseUntil?: string;
  /** What to do: written for whoever picks it up, with nothing else to go on. */
  brief: string;
  /** Handoff and progress notes, oldest first. */
  notes: { at: string; by: string; text: string }[];
  /** Outcome when done or failed. */
  result?: string;
}

export const LEASE_MS = 10 * 60_000;

export function whoAmI(worker?: string): string {
  let user = 'someone';
  try {
    user = os.userInfo().username;
  } catch {
    /* no user database */
  }
  return `${user}@${os.hostname().replace(/\.local$/, '')}${worker ? ` · ${worker}` : ''}`;
}

export function boardDir(root: string): string {
  return path.join(root, '.localpilot', 'board');
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'task';

/** Pure: a task as its Markdown file. */
export function serializeTask(t: BoardTask): string {
  const q = (v: string) => JSON.stringify(v);
  const fm = [
    `id: ${t.id}`,
    `title: ${q(t.title)}`,
    `status: ${t.status}`,
    `priority: ${t.priority}`,
    `dependsOn: [${t.dependsOn.join(', ')}]`,
    `createdBy: ${q(t.createdBy)}`,
    `createdAt: ${t.createdAt}`,
    `updatedAt: ${t.updatedAt}`,
    ...(t.owner ? [`owner: ${q(t.owner)}`] : []),
    ...(t.leaseUntil ? [`leaseUntil: ${t.leaseUntil}`] : []),
  ];
  const notes = t.notes.map((n) => `- ${n.at} · ${n.by}: ${n.text.replace(/\n+/g, ' ')}`).join('\n');
  return `---\n${fm.join('\n')}\n---\n${t.brief.trim()}\n${t.notes.length ? `\n## Notes\n${notes}\n` : ''}${t.result ? `\n## Result\n${t.result.trim()}\n` : ''}`;
}

/** Pure: a task from its Markdown file (tolerates hand edits; unknown status becomes open). */
export function parseTask(id: string, text: string): BoardTask {
  const { meta, body } = parseFrontMatter(text);
  const str = (v: unknown) => (typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v));
  const unq = (v: unknown) => {
    const s = str(v).trim();
    try {
      return s.startsWith('"') ? (JSON.parse(s) as string) : s;
    } catch {
      return s;
    }
  };
  const sections = body.split(/^## /m);
  const brief = sections[0].trim();
  const notesSec = sections.find((s) => s.startsWith('Notes')) ?? '';
  const resultSec = sections.find((s) => s.startsWith('Result'));
  const notes = [...notesSec.matchAll(/^- (\S+) · ([^:]+): (.*)$/gm)].map((m) => ({ at: m[1], by: m[2].trim(), text: m[3].trim() }));
  const deps = Array.isArray(meta.dependsOn) ? meta.dependsOn.map(String) : str(meta.dependsOn).replace(/[[\]]/g, '').split(',').map((s) => s.trim()).filter(Boolean);
  const status = str(meta.status) as BoardStatus;
  return {
    id: str(meta.id) || id,
    title: unq(meta.title) || brief.split('\n')[0].slice(0, 80) || id,
    status: ['open', 'claimed', 'done', 'failed'].includes(status) ? status : 'open',
    priority: Number.isFinite(Number(meta.priority)) ? Number(meta.priority) : 5,
    dependsOn: deps,
    createdBy: unq(meta.createdBy),
    createdAt: str(meta.createdAt),
    updatedAt: str(meta.updatedAt),
    owner: unq(meta.owner) || undefined,
    leaseUntil: str(meta.leaseUntil) || undefined,
    brief,
    notes,
    result: resultSec ? resultSec.replace(/^Result\s*/, '').trim() : undefined,
  };
}

/** Pure: whether a task can be taken now (open, or claimed with an expired lease) and its prerequisites are done. */
export function claimable(t: BoardTask, all: BoardTask[], now = Date.now()): boolean {
  const free = t.status === 'open' || (t.status === 'claimed' && (!t.leaseUntil || Date.parse(t.leaseUntil) < now));
  return free && t.dependsOn.every((d) => all.find((x) => x.id === d)?.status === 'done');
}

/** Pure: the next task to take — lowest priority number, then oldest. */
export function nextTask(all: BoardTask[], now = Date.now()): BoardTask | undefined {
  return all.filter((t) => claimable(t, all, now)).sort((a, b) => a.priority - b.priority || a.createdAt.localeCompare(b.createdAt))[0];
}

export class TeamBoard {
  constructor(readonly root: string) {}

  private file(id: string): string {
    return path.join(boardDir(this.root), `${id}.md`);
  }

  async list(): Promise<BoardTask[]> {
    let names: string[];
    try {
      names = (await fs.promises.readdir(boardDir(this.root))).filter((f) => f.endsWith('.md'));
    } catch {
      return [];
    }
    const out: BoardTask[] = [];
    for (const n of names) {
      try {
        out.push(parseTask(n.slice(0, -3), await fs.promises.readFile(path.join(boardDir(this.root), n), 'utf8')));
      } catch {
        /* unreadable entry */
      }
    }
    return out.sort((a, b) => a.priority - b.priority || a.createdAt.localeCompare(b.createdAt));
  }

  async get(id: string): Promise<BoardTask | undefined> {
    try {
      return parseTask(id, await fs.promises.readFile(this.file(id), 'utf8'));
    } catch {
      return undefined;
    }
  }

  private async write(t: BoardTask): Promise<void> {
    await fs.promises.mkdir(boardDir(this.root), { recursive: true });
    // Write beside and rename, so a reader never sees half a file.
    const tmp = `${this.file(t.id)}.${process.pid}.tmp`;
    await fs.promises.writeFile(tmp, serializeTask(t));
    await fs.promises.rename(tmp, this.file(t.id));
  }

  /** Runs `fn` holding the task's lock; false when another worker holds it (it does not wait). */
  private async locked<T>(id: string, fn: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false }> {
    await fs.promises.mkdir(boardDir(this.root), { recursive: true });
    const lock = `${this.file(id)}.lock`;
    let fh: fs.promises.FileHandle;
    try {
      fh = await fs.promises.open(lock, 'wx');
    } catch {
      // A lock left by a crashed process (older than a minute) is broken once.
      const st = await fs.promises.stat(lock).catch(() => undefined);
      if (st && Date.now() - st.mtimeMs > 60_000) {
        await fs.promises.rm(lock, { force: true });
        return this.locked(id, fn);
      }
      return { ok: false };
    }
    try {
      await fh.writeFile(`${process.pid} ${whoAmI()}`);
      return { ok: true, value: await fn() };
    } finally {
      await fh.close();
      await fs.promises.rm(lock, { force: true });
    }
  }

  async add(input: { title: string; brief: string; priority?: number; dependsOn?: string[] }, by = whoAmI()): Promise<BoardTask> {
    const existing = new Set((await this.list()).map((t) => t.id));
    let id = slug(input.title);
    for (let n = 2; existing.has(id); n++) {
      id = `${slug(input.title)}-${n}`;
    }
    const now = new Date().toISOString();
    const t: BoardTask = { id, title: input.title.trim().slice(0, 120), status: 'open', priority: input.priority ?? 5, dependsOn: (input.dependsOn ?? []).filter((d) => existing.has(d)), createdBy: by, createdAt: now, updatedAt: now, brief: input.brief.trim(), notes: [] };
    await this.write(t);
    return t;
  }

  /** Takes `id` (or the next claimable task) for `owner`; undefined when nothing could be taken. */
  async claim(owner: string, id?: string, leaseMs = LEASE_MS): Promise<BoardTask | undefined> {
    const all = await this.list();
    const candidates = id ? all.filter((t) => t.id === id) : all.filter((t) => claimable(t, all)).sort((a, b) => a.priority - b.priority || a.createdAt.localeCompare(b.createdAt));
    for (const c of candidates) {
      const r = await this.locked(c.id, async () => {
        // Re-read under the lock: another worker may have taken it since the listing.
        const fresh = await this.get(c.id);
        if (!fresh || !claimable(fresh, await this.list())) {
          return undefined;
        }
        const now = new Date();
        const t: BoardTask = { ...fresh, status: 'claimed', owner, leaseUntil: new Date(now.getTime() + leaseMs).toISOString(), updatedAt: now.toISOString(), notes: [...fresh.notes, { at: now.toISOString(), by: owner, text: fresh.status === 'claimed' ? `took over (the previous lease of ${fresh.owner} had expired)` : 'claimed' }] };
        await this.write(t);
        return t;
      });
      if (r.ok && r.value) {
        return r.value;
      }
    }
    return undefined;
  }

  /** Changes a task under its lock; `owner` must hold it for anything but a note (anyone can leave a note). */
  async update(id: string, by: string, change: { note?: string; status?: 'done' | 'failed' | 'open'; result?: string; renew?: boolean }): Promise<{ task?: BoardTask; error?: string }> {
    const r = await this.locked(id, async () => {
      const t = await this.get(id);
      if (!t) {
        return { error: `No task "${id}" on the board.` };
      }
      if ((change.status || change.renew) && t.status === 'claimed' && t.owner !== by) {
        return { error: `"${id}" is claimed by ${t.owner}; leave a note instead, or wait for its lease (until ${t.leaseUntil}).` };
      }
      const now = new Date().toISOString();
      const next: BoardTask = { ...t, updatedAt: now, notes: change.note ? [...t.notes, { at: now, by, text: change.note.trim() }] : t.notes };
      if (change.renew) {
        next.leaseUntil = new Date(Date.now() + LEASE_MS).toISOString();
      }
      if (change.status) {
        next.status = change.status;
        next.leaseUntil = undefined;
        if (change.status === 'open') {
          next.owner = undefined;
        }
        if (change.result) {
          next.result = change.result;
        }
      }
      await this.write(next);
      return { task: next };
    });
    return r.ok ? r.value : { error: `"${id}" is being changed by another worker right now; try again.` };
  }
}

/** Pure: the board as text for the agent and `/board`. */
export function formatBoard(all: BoardTask[], now = Date.now()): string {
  if (!all.length) {
    return 'The shared board is empty. Add tasks with team_board action "add" (or create .localpilot/board/<id>.md).';
  }
  const label = (t: BoardTask) => (t.status === 'claimed' && t.leaseUntil && Date.parse(t.leaseUntil) < now ? 'claimed (lease expired)' : t.status);
  const waiting = (t: BoardTask) => t.status === 'open' && t.dependsOn.some((d) => all.find((x) => x.id === d)?.status !== 'done');
  return all
    .map((t) => `${t.id} [${label(t)}${waiting(t) ? `, waits for ${t.dependsOn.join(', ')}` : ''}] p${t.priority} ${t.title}${t.owner ? ` — ${t.owner}` : ''}${t.notes.length ? ` · ${t.notes.length} note${t.notes.length === 1 ? '' : 's'}` : ''}`)
    .join('\n');
}
