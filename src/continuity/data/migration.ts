// Migration of 1.6 data into the event log (design §11). Runs in the background after Continuity.open, under a lease,
// once per data root; resumable (per-file progress in migration/state.json, deterministic ids, idempotent creates) and
// non-destructive: every source file is copied to migration/legacy-backup/<date>/ before it is read, and source files
// are never written. A file that cannot be read is recorded as failed (Settings / CLI offer Retry).
// Pure Node: no vscode.
import { execFile } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { ChatMessage, Session } from '../../types';
import type { RunTrace } from '../../telemetry/runTrace';
import { normalizeWorkspacePath } from '../../sessions/cliStorage';
import { isTerminalPhase } from '../../agent/healing/types';
import type { RecoveryState } from '../../agent/healing/types';
import {
  agentSessionFromTrace, agentSessionId, checkpointFields, checkpointId, conversationFields, executionEventFromTrace, executionEventId, legacyMessageId, memoryItemId, memoryNoteFields,
  messageFields, normalizeGitRemote, pathHash, projectFields, projectIdFor, promptTemplateFields, promptTemplateId,
} from '../conversation/payloads';
import { hash26, mainBranchId, stableId } from '../ids';
import type { BlobStore } from './blobs';
import { Emitter, FileEventLog, LogLike } from './eventLog';
import { Lease } from './lease';

/** Bump to add sources in a later release: an older completed state then runs again for the new sources only. */
export const MIGRATION_VERSION = 1;

export type SourceKind = 'vscode-session' | 'cli-session' | 'trace' | 'recovery' | 'memory-developer' | 'memory-project' | 'command';

export interface SourceRecord {
  kind: SourceKind;
  path: string;
  size: number;
  mtime: number;
  sha256: string;
  done: boolean;
  events: number;
  error?: string;
  at: number;
}

export interface MigrationState {
  v: 1;
  version: number;
  startedAt?: number;
  completedAt?: number;
  backupDir?: string;
  sources: Record<string, SourceRecord>;
  /**
   * Source groups already imported (`vscode:<global storage>`, `cli:<data dir>`, `home:<~/.localpilot>`), so a VS Code
   * window still imports its profile when the CLI ran 1.7 first, and the other way round.
   */
  groups?: Record<string, number>;
}

export interface MigrationSources {
  /** The current VS Code workspace's extension storage (`context.storageUri.fsPath`). */
  vscodeStorage?: string;
  /** The current workspace's folders (project memory and the project of chats without a folder). */
  workspaceFolders?: string[];
  /** `context.globalStorageUri.fsPath`: global (developer) memory, and the way to other workspaces' storage. */
  vscodeGlobalStorage?: string;
  /** Extension id (`publisher.name`), the folder name of its storage under workspaceStorage/<hash>/. */
  extensionId?: string;
  /** CLI data root (`~/.localpilot` or LOCALPILOT_DATA_DIR): workspaces/<hash>/sessions. */
  cliDataDir?: string;
  /** `~/.localpilot`: CLI global memory (memory/), recovery/, commands/. */
  home?: string;
}

export interface MigrationProgress {
  state: 'idle' | 'running' | 'done' | 'busy' | 'failed';
  done: number;
  total: number;
  failed: number;
  current?: string;
}

export interface MigrationStatus {
  state: 'not-started' | 'running' | 'done' | 'partial';
  version: number;
  completedAt?: number;
  sources: number;
  events: number;
  failed: { path: string; kind: SourceKind; error: string }[];
  backupDir?: string;
  backupBytes: number;
}

interface Source {
  kind: SourceKind;
  file: string;
  /** Path under legacy-backup/<date>/. */
  label: string;
  /** The project folder the source belongs to (chats without `folder`, project memory). */
  folder?: string;
  origin?: 'cli' | 'vscode';
  /** Which source group it belongs to (see MigrationState.groups). */
  group: string;
}

const read = (f: string) => fs.readFileSync(f);
const sha = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');
const ls = (d: string) => {
  try {
    return fs.readdirSync(d);
  } catch {
    return [];
  }
};
const isDir = (d: string) => {
  try {
    return fs.statSync(d).isDirectory();
  } catch {
    return false;
  }
};

function fileUriToPath(uri: string): string | undefined {
  try {
    const u = new URL(uri);
    if (u.protocol !== 'file:') {
      return undefined;
    }
    let p = decodeURIComponent(u.pathname);
    if (/^\/[a-zA-Z]:/.test(p)) {
      p = p.slice(1);
    }
    return path.normalize(p);
  } catch {
    return undefined;
  }
}

/** The folder a VS Code workspace storage hash belongs to (`workspaceStorage/<hash>/workspace.json`). */
export function workspaceFolderOf(wsStorageHashDir: string): string | undefined {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(wsStorageHashDir, 'workspace.json'), 'utf8')) as { folder?: string; workspace?: string };
    return j.folder ? fileUriToPath(j.folder) : j.workspace ? path.dirname(fileUriToPath(j.workspace) ?? '') || undefined : undefined;
  } catch {
    return undefined;
  }
}

/** The source groups a process can see. */
export function sourceGroups(s: MigrationSources): { vscode?: string; cli?: string; home?: string } {
  const vs = s.vscodeGlobalStorage ?? s.vscodeStorage;
  return {
    ...(vs ? { vscode: `vscode:${path.resolve(vs)}` } : {}),
    ...(s.cliDataDir ? { cli: `cli:${path.resolve(s.cliDataDir)}` } : {}),
    ...(s.home ? { home: `home:${path.resolve(s.home)}` } : {}),
  };
}

/** Every 1.6 source file, in migration order (§11). */
export function discoverSources(s: MigrationSources): Source[] {
  const g = sourceGroups(s);
  const out: Source[] = [];
  const seen = new Set<string>();
  const add = (x: Source) => {
    const key = path.resolve(x.file);
    if (!seen.has(key)) {
      seen.add(key);
      out.push(x);
    }
  };
  const storageDirs: { dir: string; folder?: string; label: string; origin: 'vscode' | 'cli' }[] = [];
  const groupOf = (origin: 'vscode' | 'cli') => (origin === 'cli' ? g.cli : g.vscode) ?? '';
  if (s.vscodeStorage) {
    storageDirs.push({ dir: s.vscodeStorage, folder: s.workspaceFolders?.[0], label: `vscode/${path.basename(path.dirname(s.vscodeStorage))}`, origin: 'vscode' });
  }
  if (s.vscodeGlobalStorage && s.extensionId) {
    const wsRoot = path.join(s.vscodeGlobalStorage, '..', '..', 'workspaceStorage');
    for (const h of ls(wsRoot)) {
      const dir = path.join(wsRoot, h, s.extensionId);
      if (isDir(dir)) {
        storageDirs.push({ dir, folder: workspaceFolderOf(path.join(wsRoot, h)), label: `vscode/${h}`, origin: 'vscode' });
      }
    }
    // Chats of the empty window (no folder) live in global storage.
    storageDirs.push({ dir: s.vscodeGlobalStorage, label: 'vscode/global', origin: 'vscode' });
  }
  if (s.cliDataDir) {
    const ws = path.join(s.cliDataDir, 'workspaces');
    for (const h of ls(ws)) {
      let folder: string | undefined;
      try {
        folder = (JSON.parse(fs.readFileSync(path.join(ws, h, 'workspace.json'), 'utf8')) as { folder?: string }).folder;
      } catch {
        // chats carry their own folder
      }
      storageDirs.push({ dir: path.join(ws, h), folder, label: `cli/${h}`, origin: 'cli' });
    }
  }
  // 1-2. chats
  for (const d of storageDirs) {
    const sessions = path.join(d.dir, 'sessions');
    for (const n of ls(sessions).filter((n) => n.endsWith('.json')).sort()) {
      add({ kind: d.origin === 'cli' ? 'cli-session' : 'vscode-session', file: path.join(sessions, n), label: `${d.label}/sessions/${n}`, folder: d.folder, origin: d.origin, group: groupOf(d.origin) });
    }
  }
  // 3. traces
  for (const d of storageDirs) {
    const traces = path.join(d.dir, 'traces');
    for (const n of ls(traces).filter((n) => n.endsWith('.json')).sort()) {
      add({ kind: 'trace', file: path.join(traces, n), label: `${d.label}/traces/${n}`, folder: d.folder, origin: d.origin, group: groupOf(d.origin) });
    }
  }
  // 5. recovery states (4, checkpoints, come with their chats)
  const recoveryDirs = [...storageDirs.map((d) => ({ dir: path.join(d.dir, 'recovery'), label: `${d.label}/recovery`, group: groupOf(d.origin) })), ...(s.home ? [{ dir: path.join(s.home, 'recovery'), label: 'cli/recovery', group: g.home ?? '' }] : [])];
  for (const r of recoveryDirs) {
    for (const n of ls(r.dir).filter((n) => n.endsWith('.json') && n !== 'interventions.json').sort()) {
      add({ kind: 'recovery', file: path.join(r.dir, n), label: `${r.label}/${n}`, group: r.group });
    }
  }
  // 6. memory
  const devDirs = [...(s.vscodeGlobalStorage ? [{ dir: path.join(s.vscodeGlobalStorage, 'memory'), label: 'memory/vscode-global', group: g.vscode ?? '' }] : []), ...(s.home ? [{ dir: path.join(s.home, 'memory'), label: 'memory/cli-global', group: g.home ?? '' }] : [])];
  for (const m of devDirs) {
    for (const n of ls(m.dir).filter((n) => n.endsWith('.md')).sort()) {
      add({ kind: 'memory-developer', file: path.join(m.dir, n), label: `${m.label}/${n}`, group: m.group });
    }
  }
  const folders = new Set<string>([...(s.workspaceFolders ?? []), ...storageDirs.map((d) => d.folder).filter((f): f is string => !!f)]);
  for (const f of folders) {
    const dir = path.join(f, '.localpilot', 'memory');
    for (const n of ls(dir).filter((n) => n.endsWith('.md')).sort()) {
      add({ kind: 'memory-project', file: path.join(dir, n), label: `memory/project-${hash26(f).slice(0, 10)}/${n}`, folder: f, group: g.vscode ?? g.cli ?? g.home ?? '' });
    }
  }
  // 7. custom commands
  if (s.home) {
    const dir = path.join(s.home, 'commands');
    for (const n of ls(dir).filter((n) => n.endsWith('.md')).sort()) {
      add({ kind: 'command', file: path.join(dir, n), label: `commands/${n}`, group: g.home ?? '' });
    }
  }
  return out;
}

const git = (cwd: string, args: string[]): Promise<string | undefined> =>
  new Promise((resolve) => {
    execFile('git', ['-C', cwd, ...args], { timeout: 5000, windowsHide: true }, (err, stdout) => resolve(err ? undefined : String(stdout).trim().split('\n')[0] || undefined));
  });

export interface MigrationOptions {
  root: string;
  log: FileEventLog;
  blobs: BlobStore;
  sources: MigrationSources;
  logger?: LogLike;
  now?: () => number;
  /** Tests: throw after this many files (an interrupted run). */
  failAfter?: number;
}

export class Migration {
  readonly dir: string;
  private readonly stateFile: string;
  private readonly progressEmitter = new Emitter<MigrationProgress>();
  readonly onProgress = this.progressEmitter.event;
  private readonly now: () => number;
  private projects = new Map<string, string>();
  private running?: Promise<MigrationProgress>;
  progress: MigrationProgress = { state: 'idle', done: 0, total: 0, failed: 0 };

  constructor(private readonly o: MigrationOptions) {
    this.dir = path.join(o.root, 'migration');
    this.stateFile = path.join(this.dir, 'state.json');
    this.now = o.now ?? Date.now;
  }

  readState(): MigrationState {
    try {
      const s = JSON.parse(fs.readFileSync(this.stateFile, 'utf8')) as MigrationState;
      if (s?.v === 1 && s.sources && typeof s.sources === 'object') {
        return s;
      }
    } catch {
      // first run
    }
    return { v: 1, version: 0, sources: {} };
  }

  private writeState(s: MigrationState): void {
    fs.mkdirSync(this.dir, { recursive: true });
    const tmp = `${this.stateFile}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(s, null, 1));
    fs.renameSync(tmp, this.stateFile);
  }

  /** Whether the migration still has work (never ran, interrupted, or an older migration version). */
  needed(): boolean {
    const s = this.readState();
    if (!s.completedAt || s.version < MIGRATION_VERSION) {
      return true;
    }
    return Object.values(sourceGroups(this.o.sources)).some((g) => !s.groups?.[g]);
  }

  /** Groups of this process's sources not imported yet. */
  private pendingGroups(s: MigrationState): Set<string> {
    const all = Object.values(sourceGroups(this.o.sources));
    return new Set(s.version < MIGRATION_VERSION || !s.completedAt ? all : all.filter((g) => !s.groups?.[g]));
  }

  /** Runs (or resumes) the migration; `retry` re-tries failed files of a completed run. Never throws. */
  run(o: { retry?: boolean; force?: boolean } = {}): Promise<MigrationProgress> {
    this.running ??= this.runOnce(o).finally(() => (this.running = undefined));
    return this.running;
  }

  private emit(p: Partial<MigrationProgress>): void {
    this.progress = { ...this.progress, ...p };
    this.progressEmitter.fire(this.progress);
  }

  private async runOnce(o: { retry?: boolean; force?: boolean }): Promise<MigrationProgress> {
    let state = this.readState();
    const failedOnly = !!o.retry && !!state.completedAt && state.version >= MIGRATION_VERSION;
    if (!o.force && !o.retry && !this.needed()) {
      this.emit({ state: 'done', done: 0, total: 0, failed: Object.values(state.sources).filter((r) => !r.done).length });
      return this.progress;
    }
    const lease = new Lease(path.join(this.dir, 'lease.json'), { kind: 'migration', now: this.now });
    fs.mkdirSync(this.dir, { recursive: true });
    if (!lease.tryClaim()) {
      this.emit({ state: 'busy' });
      return this.progress;
    }
    try {
      // Another process may have finished while we waited for the lease.
      state = this.readState();
      state.startedAt ??= this.now();
      const stamp = new Date(state.startedAt).toISOString().slice(0, 10).replace(/-/g, '');
      state.backupDir ??= path.join(this.dir, 'legacy-backup', stamp);
      let sources = discoverSources(this.o.sources);
      const pending = this.pendingGroups(state);
      if (!o.force && !failedOnly) {
        sources = sources.filter((x) => pending.has(x.group));
      }
      if (failedOnly) {
        sources = sources.filter((s) => state.sources[path.resolve(s.file)] && !state.sources[path.resolve(s.file)].done);
      }
      this.emit({ state: 'running', done: 0, total: sources.length, failed: 0 });
      let done = 0;
      let failed = 0;
      for (const src of sources) {
        const key = path.resolve(src.file);
        this.emit({ current: src.label });
        let buf: Buffer;
        let st: fs.Stats;
        try {
          st = fs.statSync(src.file);
          buf = read(src.file);
        } catch (e) {
          // Vanished since discovery: nothing to migrate.
          this.o.logger?.warn(`continuity migration: ${src.file}: ${String(e)}`);
          done++;
          continue;
        }
        const hash = sha(buf);
        const prev = state.sources[key];
        if (prev?.done && prev.sha256 === hash) {
          done++;
          this.emit({ done });
          continue;
        }
        if (this.o.failAfter !== undefined && done >= this.o.failAfter) {
          throw new Error('migration interrupted (test)');
        }
        const rec: SourceRecord = { kind: src.kind, path: src.file, size: st.size, mtime: st.mtimeMs, sha256: hash, done: false, events: 0, at: this.now() };
        try {
          this.backup(buf, state.backupDir, src.label);
          rec.events = await this.migrate(src, buf);
          rec.events += this.marker(src, hash, rec.events);
          await this.o.log.flush();
          rec.done = true;
        } catch (e) {
          rec.error = e instanceof Error ? e.message : String(e);
          failed++;
          this.o.logger?.warn(`continuity migration: could not import ${src.file}: ${rec.error}`);
        }
        state.sources[key] = rec;
        this.writeState(state);
        done++;
        this.emit({ done, failed });
      }
      state.version = MIGRATION_VERSION;
      state.completedAt = this.now();
      state.groups ??= {};
      for (const g of Object.values(sourceGroups(this.o.sources))) {
        state.groups[g] ??= this.now();
      }
      this.writeState(state);
      this.emit({ state: 'done', current: undefined, failed: Object.values(state.sources).filter((r) => !r.done).length });
      return this.progress;
    } catch (e) {
      await this.o.log.flush();
      this.writeState(state);
      this.o.logger?.error(`continuity migration stopped: ${String(e)}`);
      this.emit({ state: 'failed', current: undefined });
      return this.progress;
    } finally {
      lease.release();
    }
  }

  private backup(buf: Buffer, dir: string, label: string): void {
    const dest = path.join(dir, ...label.split('/'));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    try {
      if (sha(fs.readFileSync(dest)) === sha(buf)) {
        return;
      }
    } catch {
      // not copied yet
    }
    fs.writeFileSync(dest, buf);
  }

  /** One `migration` entity per source file: where the data came from. */
  private marker(src: Source, hash: string, events: number): number {
    this.o.log.append('migration', `mig_${hash26(path.resolve(src.file))}`, 'create', { source: src.kind, path: src.label, sha256: hash, events, at: this.now() }, { cause: 'migration' });
    return 1;
  }

  private async project(folder: string | undefined): Promise<string | undefined> {
    if (!folder) {
      return undefined;
    }
    const norm = normalizeWorkspacePath(folder);
    const hit = this.projects.get(norm);
    if (hit) {
      return hit;
    }
    let gitRemote: string | undefined;
    let rootCommit: string | undefined;
    if (fs.existsSync(path.join(folder, '.git'))) {
      const remote = await git(folder, ['config', '--get', 'remote.origin.url']);
      gitRemote = remote ? normalizeGitRemote(remote) : undefined;
      rootCommit = await git(folder, ['rev-list', '--max-parents=0', 'HEAD']);
    }
    const id = projectIdFor({ gitRemote, rootCommit, pathHash: pathHash(norm) });
    this.o.log.append('project', id, 'create', projectFields({ name: path.basename(norm) || norm, path: folder, normalizedPath: norm, deviceId: this.o.log.device.deviceId, gitRemote, rootCommit, createdAt: this.now() }), { cause: 'migration' });
    this.projects.set(norm, id);
    return id;
  }

  /** Emits the events of one source file; returns how many. */
  private async migrate(src: Source, buf: Buffer): Promise<number> {
    const log = this.o.log;
    let n = 0;
    const append = (...a: Parameters<FileEventLog['append']>) => {
      const [ent, eid, op, p, opts] = a;
      log.append(ent, eid, op, p, { ...opts, cause: 'migration' });
      n++;
    };
    switch (src.kind) {
      case 'vscode-session':
      case 'cli-session': {
        const s = JSON.parse(buf.toString('utf8')) as Session;
        if (!s?.id || !Array.isArray(s.messages)) {
          throw new Error('not a LocalPilot chat file');
        }
        if (!s.messages.length && !s.pinned && !s.plan) {
          return 0; // an empty "New chat"
        }
        const projectId = await this.project(s.folder ?? src.folder);
        const convId = s.id;
        const branch = mainBranchId(convId);
        append('conversation', convId, 'create', conversationFields(s, { projectId, origin: src.origin === 'cli' ? 'cli' : (s.origin ?? 'vscode') }));
        append('branch', branch, 'create', { conversationId: convId, createdAt: s.createdAt ?? this.now() });
        // The full transcript: archived messages first (compaction folded them away), then the current ones.
        const archived = this.readArchive(path.join(path.dirname(src.file), `${convId}.archive.jsonl`));
        const list: { m: ChatMessage; index: number }[] = [
          ...archived.map((r) => ({ m: r.message.meta?.archived === undefined ? { ...r.message, meta: { ...r.message.meta, archived: r.seq } } : r.message, index: -1 })),
          ...s.messages.map((m, index) => ({ m, index })).filter((x) => x.m.meta?.archived === undefined || !archived.some((r) => r.seq === x.m.meta?.archived)),
        ];
        // A compaction summary keeps the archived messages the chat still shows verbatim after it (CONVERSATION's
        // view of the log: [summary, ...kept, ...newer]).
        const keepsOf = new Map<number, string[]>();
        s.messages.forEach((m, i) => {
          if (!m.meta?.summary) {
            return;
          }
          const kept: string[] = [];
          for (let j = i + 1; j < s.messages.length && s.messages[j].meta?.archived !== undefined && archived.some((r) => r.seq === s.messages[j].meta?.archived); j++) {
            kept.push(legacyMessageId(convId, s.messages[j], j));
          }
          keepsOf.set(i, kept);
        });
        let parent: string | undefined;
        let last = s.createdAt ?? this.now();
        for (const { m, index } of list) {
          const id = legacyMessageId(convId, m, index);
          last = m.meta?.timestamp ?? last;
          const p = messageFields(convId, branch, parent, m, { blobs: this.o.blobs, createdAt: last });
          if (keepsOf.has(index)) {
            (p.fields as { keeps?: string[] }).keeps = keepsOf.get(index);
          }
          for (const a of p.attachments) {
            append('attachment', a.id, 'create', a.fields);
          }
          append('message', id, 'create', p.fields);
          parent = id;
        }
        if (parent) {
          append('branch', branch, 'patch', { headId: parent });
        }
        for (const cp of s.checkpoints?.history ?? []) {
          append('checkpoint', checkpointId(convId, cp.run), 'create', checkpointFields(cp, convId, log.device.deviceId, projectId));
        }
        return n;
      }
      case 'trace': {
        const list = JSON.parse(buf.toString('utf8')) as RunTrace[];
        if (!Array.isArray(list)) {
          throw new Error('not a trace file');
        }
        for (const t of list) {
          if (!t?.id || !t.sessionId || !Array.isArray(t.entries)) {
            continue;
          }
          const asId = agentSessionId(t.id);
          append('agent_session', asId, 'create', agentSessionFromTrace(t, t.sessionId, log.stream));
          t.entries.forEach((e, i) => append('execution_event', executionEventId(asId, i + 1), 'create', executionEventFromTrace(t, e, i + 1, t.sessionId, asId)));
        }
        return n;
      }
      case 'recovery': {
        const st = JSON.parse(buf.toString('utf8')) as RecoveryState;
        if (st?.version !== 1 || typeof st.sessionId !== 'string' || typeof st.phase !== 'string') {
          return 0; // other files in the folder (attempt snapshots index, memory)
        }
        if (isTerminalPhase(st.phase)) {
          return 0;
        }
        const last = st.attempts?.[st.attempts.length - 1] as { category?: string } | undefined;
        append('agent_session', stableId('as', 'recovery', st.sessionId, String(st.turnKey)), 'create', {
          conversationId: st.sessionId,
          run: st.turnKey,
          mode: 'agent',
          startedAt: st.startedAt,
          outcome: 'interrupted',
          writer: log.stream,
          recovery: { phase: st.phase, attempt: st.attempts?.length ?? 0, ...(last?.category ? { category: last.category } : {}) },
          filesTouched: st.changedFiles ?? [],
        });
        return n;
      }
      case 'memory-developer':
      case 'memory-project': {
        const name = path.basename(src.file, '.md');
        const body = buf.toString('utf8');
        const projectId = src.kind === 'memory-project' ? await this.project(src.folder) : undefined;
        const type = src.kind === 'memory-project' ? 'project' : 'developer';
        const st = fs.statSync(src.file);
        append('memory', memoryItemId(type, projectId ?? 'user', name), 'create', memoryNoteFields({ type, name, body, projectId, file: `${name}.md`, source: 'migration', createdAt: Math.round(st.birthtimeMs || st.mtimeMs) }));
        return n;
      }
      case 'command': {
        const name = path.basename(src.file, '.md');
        append('prompt_template', promptTemplateId('user', 'user', name), 'create', promptTemplateFields({ name, text: buf.toString('utf8'), scope: 'user', file: `${name}.md` }));
        return n;
      }
    }
  }

  private readArchive(file: string): { seq: number; message: ChatMessage }[] {
    let text: string;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      return [];
    }
    const out: { seq: number; message: ChatMessage }[] = [];
    for (const line of text.split('\n')) {
      try {
        const r = JSON.parse(line) as { seq: number; message: ChatMessage };
        if (typeof r?.seq === 'number' && r.message) {
          out.push(r);
        }
      } catch {
        // a torn line
      }
    }
    return out.sort((a, b) => a.seq - b.seq);
  }

  status(): MigrationStatus {
    const s = this.readState();
    const recs = Object.values(s.sources);
    const failed = recs.filter((r) => !r.done).map((r) => ({ path: r.path, kind: r.kind, error: r.error ?? 'not finished' }));
    return {
      state: this.progress.state === 'running' ? 'running' : !s.startedAt ? 'not-started' : s.completedAt && !failed.length ? 'done' : 'partial',
      version: s.version,
      completedAt: s.completedAt,
      sources: recs.length,
      events: recs.reduce((a, r) => a + (r.events || 0), 0),
      failed,
      backupDir: s.backupDir && fs.existsSync(s.backupDir) ? s.backupDir : undefined,
      backupBytes: dirSize(path.join(this.dir, 'legacy-backup')),
    };
  }

  /** Deletes the copies of the 1.6 files (only on request: Settings or `localpilot data migrate --remove-backup`). */
  removeBackup(): number {
    const dir = path.join(this.dir, 'legacy-backup');
    const bytes = dirSize(dir);
    fs.rmSync(dir, { recursive: true, force: true });
    return bytes;
  }
}

export function dirSize(dir: string): number {
  let total = 0;
  const walk = (d: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        walk(p);
      } else {
        try {
          total += fs.statSync(p).size;
        } catch {
          // vanished
        }
      }
    }
  };
  walk(dir);
  return total;
}
