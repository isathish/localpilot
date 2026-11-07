// Projects (design §4.3): a workspace folder is a project, matched across devices and moves by fingerprints, in this
// order: git remote + root commit (the same repository anywhere gets the same id), then the path hash on this device,
// then the folder name — only as a suggestion, never automatically. A project whose folder moved but whose git
// fingerprint matches is re-pointed silently. Ids follow DATA's `projectIdFor` so migrated chats keep their project.
// Pure Node: no vscode.
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { normalizeWorkspacePath } from '../../sessions/cliStorage';
import type { FileEventLog } from '../data/eventLog';
import type { IndexClient } from '../data/index/indexClient';
import { normalizeGitRemote, pathHash, projectFields, projectIdFor } from './payloads';

export interface ProjectRef {
  id: string;
  name: string;
  /** The folder on this device. */
  path: string;
}

export interface ProjectInfo extends ProjectRef {
  gitRemote?: string;
  rootCommit?: string;
  /** False when the folder on this device no longer exists (moved or deleted). */
  exists: boolean;
}

export type GitRunner = (cwd: string, args: string[]) => Promise<string | undefined>;

export const runGit: GitRunner = (cwd, args) =>
  new Promise((resolve) => {
    execFile('git', ['-C', cwd, ...args], { timeout: 5000, windowsHide: true }, (err, stdout) => resolve(err ? undefined : String(stdout).trim().split('\n')[0] || undefined));
  });

interface Row {
  id: string;
  name: string;
  git_remote?: string | null;
  root_commit?: string | null;
  path?: string | null;
  paths?: string | null;
}

export class ProjectResolver {
  private readonly cache = new Map<string, Promise<ProjectRef>>();
  private readonly known = new Map<string, ProjectRef>();
  private readonly git: GitRunner;

  constructor(private readonly o: { log: FileEventLog; index?: IndexClient; ready?: Promise<unknown>; git?: GitRunner; now?: () => number }) {
    this.git = o.git ?? runGit;
  }

  /** The project of a folder (cached per process); emits the project entity the first time it is seen here. */
  resolve(folder: string): Promise<ProjectRef> {
    const norm = normalizeWorkspacePath(folder);
    let hit = this.cache.get(norm);
    if (!hit) {
      hit = this.resolveUncached(folder, norm).then((r) => {
        this.known.set(norm, r);
        return r;
      });
      this.cache.set(norm, hit);
    }
    return hit;
  }

  /** The project of a folder when it was already resolved in this process (no git, no index). */
  peek(folder: string): ProjectRef | undefined {
    return this.known.get(normalizeWorkspacePath(folder));
  }

  private async fingerprint(folder: string): Promise<{ gitRemote?: string; rootCommit?: string }> {
    if (!fs.existsSync(path.join(folder, '.git'))) {
      return {};
    }
    const remote = await this.git(folder, ['config', '--get', 'remote.origin.url']);
    const rootCommit = await this.git(folder, ['rev-list', '--max-parents=0', 'HEAD']);
    return { gitRemote: remote ? normalizeGitRemote(remote) : undefined, rootCommit };
  }

  private async lookup(name: 'projectByGit' | 'projectByPathHash', params: Record<string, unknown>): Promise<Row | undefined> {
    if (!this.o.index) {
      return undefined;
    }
    try {
      await this.o.ready;
      return (await this.o.index.query<Row>(name, params))[0];
    } catch {
      return undefined;
    }
  }

  private async resolveUncached(folder: string, norm: string): Promise<ProjectRef> {
    const fp = await this.fingerprint(folder);
    const hash = pathHash(norm);
    const device = this.o.log.device.deviceId;
    const name = path.basename(norm) || norm;
    // 1. The same repository (remote + first commit) wherever it is.
    const byGit = fp.gitRemote && fp.rootCommit ? await this.lookup('projectByGit', { gitRemote: fp.gitRemote, rootCommit: fp.rootCommit }) : undefined;
    // 2. This folder on this device.
    const byPath = byGit ? undefined : await this.lookup('projectByPathHash', { pathHash: hash });
    const id = byGit?.id ?? byPath?.id ?? projectIdFor({ ...fp, pathHash: hash });
    const known = byGit ?? byPath;
    if (!known || known.path !== folder) {
      // New here, or moved (re-pointed silently: the git fingerprint matched): record this device's path.
      const f = projectFields({ name: known?.name ?? name, path: folder, normalizedPath: norm, deviceId: device, gitRemote: fp.gitRemote, rootCommit: fp.rootCommit, createdAt: (this.o.now ?? Date.now)() });
      if (known) {
        this.o.log.append('project', id, 'patch', { paths: f.paths, fingerprints: f.fingerprints });
      } else {
        this.o.log.append('project', id, 'create', f);
      }
    }
    return { id, name: known?.name ?? name, path: folder };
  }

  /** "This is the same project": points a project at a folder on this device (a moved folder without git). */
  async repoint(projectId: string, folder: string): Promise<void> {
    const norm = normalizeWorkspacePath(folder);
    const device = this.o.log.device.deviceId;
    this.o.log.append('project', projectId, 'patch', { paths: { [device]: folder }, fingerprints: { pathHash: { [device]: pathHash(norm) } } }, { durable: true });
    const name = path.basename(norm) || norm;
    const ref = { id: projectId, name, path: folder };
    this.cache.set(norm, Promise.resolve(ref));
    this.known.set(norm, ref);
  }

  /** Every project the index knows, with whether its folder exists on this device. */
  async list(): Promise<ProjectInfo[]> {
    if (!this.o.index) {
      return [];
    }
    await this.o.ready;
    const rows = await this.o.index.query<Row>('projects', {});
    return rows.map((r) => ({ id: r.id, name: r.name, path: r.path ?? '', gitRemote: r.git_remote ?? undefined, rootCommit: r.root_commit ?? undefined, exists: !!r.path && fs.existsSync(r.path) }));
  }

  /**
   * Projects that may be this folder under an old path: same folder name, and their folder is gone on this device.
   * Only suggestions — the user confirms with "This is the same project".
   */
  async suggestions(folder: string): Promise<ProjectInfo[]> {
    const name = path.basename(normalizeWorkspacePath(folder)).toLowerCase();
    const mine = this.peek(folder)?.id;
    return (await this.list()).filter((p) => p.id !== mine && !p.exists && p.name.toLowerCase() === name);
  }
}
