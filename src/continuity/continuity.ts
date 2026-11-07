// Composition root of continuity (design §2.1): opens the data root, the event log, the index (worker), blobs,
// migration, retention and backups, and hands them to the feature modules. Used by extension.ts and cli/main.ts.
// `Continuity.open` never throws: a data root that cannot be used yields a degraded instance and every 1.6 feature
// keeps working from the SessionStore. Pure Node (no vscode import), so the CLI and the smoke tests run it as is.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { cliDataDir } from '../sessions/cliStorage';
import { BlobStore } from './data/blobs';
import type { SecretBox } from './data/crypto/secretBox';
import { DataManager } from './data/dataManager';
import { DeviceInfo, FileEventLog, LogLike } from './data/eventLog';
import { createIndexClient, IndexClient, LocalIndexClient } from './data/index/indexClient';
import { Migration, MigrationSources } from './data/migration';
import { PurgeHook, Retention } from './data/retention';
import type { SessionStore } from '../sessions/sessionStore';
import { ConversationManager } from './conversation/conversationManager';
import { ProjectResolver } from './conversation/projects';
import { SessionBridge } from './conversation/sessionBridge';
import type { ConversationFields } from './events';
import type { MemoryStore } from '../agent/memory';
import { GitTracked, MemoryBridge, NoteFolder, WatchFactory } from './memory/memoryBridge';
import { MemoryManager } from './memory/memoryManager';
import { ContextService } from './context/contextService';
import { SessionManager } from './session/sessionManager';
import type { CaptureMode } from './session/runBridge';
import { SyncEngine, SyncEngineOptions, SyncSettings } from './sync/syncEngine';
import { CheckpointContentsExtra, PreferenceAccess, PreferencesExtra, PromptsExtra } from './sync/extras';

export interface ContinuitySettings {
  /** Empty = default (`~/.localpilot/continuity`, or `$LOCALPILOT_DATA_DIR/continuity`). */
  dataDir: string;
  trashRetentionDays: number;
  historyDays: number;
  indexMaxMB: number;
  backup: { enabled: boolean; intervalDays: number; keep: number };
  /** CONTEXT: offer related earlier conversations for a new chat (`localpilot.continuity.relatedConversations`). */
  relatedConversations?: boolean;
  /** SESSION: what of a tool's output a run's execution events keep (`localpilot.continuity.captureToolOutput`). */
  captureToolOutput?: CaptureMode;
}

export const DEFAULT_CONTINUITY_SETTINGS: ContinuitySettings = {
  dataDir: '',
  trashRetentionDays: 30,
  historyDays: 90,
  indexMaxMB: 256,
  backup: { enabled: true, intervalDays: 7, keep: 4 },
  relatedConversations: true,
  captureToolOutput: 'summary',
};

export interface ContinuityOptions {
  dataDir: string;
  writer: 'vscode' | 'cli';
  appVersion: string;
  secrets: SecretBox;
  log: LogLike;
  settings: () => ContinuitySettings;
  /** dist/sqljs/sql-wasm.wasm, resolved by the caller. */
  wasmPath: string;
  /** dist/continuityWorker.js; missing file = the index runs in this thread. */
  workerPath: string;
  now?: () => number;
  /** What the first run imports (§11); absent = nothing to migrate. */
  migration?: MigrationSources;
  /** Start the migration once the index is ready (default true). */
  autoMigrate?: boolean;
  /** Retention and automatic backups on timers (default true; the CLI's one-shot commands turn them off). */
  schedules?: boolean;
  /** Tests: run the index in this thread. */
  inProcessIndex?: boolean;
  /** Tests: stream buffering. */
  flushMs?: number;
}

/** Where continuity keeps its data: the setting, else LOCALPILOT_CONTINUITY_DIR, else `<CLI data dir>/continuity`. */
export function continuityDataDir(setting?: string, env: NodeJS.ProcessEnv = process.env): string {
  const s = (setting ?? '').trim();
  if (s) {
    return path.resolve(s.replace(/^~(?=$|[\\/])/, os.homedir()));
  }
  if (env.LOCALPILOT_CONTINUITY_DIR) {
    return path.resolve(env.LOCALPILOT_CONTINUITY_DIR);
  }
  return path.join(cliDataDir(undefined, env), 'continuity');
}

export class ContinuityDegradedError extends Error {
  constructor(reason: string) {
    super(`Continuity is off: ${reason}`);
    this.name = 'ContinuityDegradedError';
  }
}

export interface Disposable {
  dispose(): unknown;
}

interface Parts {
  log: FileEventLog;
  index: IndexClient;
  blobs: BlobStore;
  migration: Migration;
  retention: Retention;
  data: DataManager;
}

export class Continuity implements Disposable {
  /** Index caught up (UI falls back to the SessionStore until then). Rejects never; check `indexFailed`. */
  readonly ready: Promise<void>;
  /** Why continuity is off (unwritable dir, corrupt device.json…). Every other member throws when set. */
  readonly degraded?: string;
  readonly dataDir: string;
  /** Milliseconds `open` spent on the calling thread (activation budget §12). */
  readonly openMs: number;
  /** Set when the index could not start (search falls back to the SessionStore). */
  indexFailed?: string;
  /** Settles when the automatic 1.6 import is over (or was not needed); the SessionBridge waits for it. */
  migrated: Promise<void> = Promise.resolve();
  // Filled in by the feature modules as they land (CONVERSATION, MEMORY, CONTEXT, SESSION, SYNC).
  /** Set by `attachSessionStore` (CONVERSATION). */
  conversations?: ConversationManager;
  /** The SessionStore bridge of this process (CONVERSATION). */
  bridge?: SessionBridge;
  projects?: ProjectResolver;
  /** Set by `attachMemoryStore` (MEMORY). */
  memory?: MemoryManager;
  memoryBridge?: MemoryBridge;
  /** Set by `attachContext` (CONTEXT): snapshots, the context library, related conversations, the policy. */
  context?: ContextService;
  /** Set by `attachSessions` (SESSION): agent sessions, execution events, checkpoints, model sessions, drafts. */
  sessions?: SessionManager;
  /** Set by `attachSync` (SYNC): the sync engine (remote, keys, cycles, conflicts, devices). */
  sync?: SyncEngine;
  private readonly parts?: Parts;
  private secrets?: SecretBox;
  private writer: 'vscode' | 'cli' = 'vscode';
  private appVersion = '0.0.0';
  private readonly disposables: Disposable[] = [];
  private disposed = false;
  /** Timers (retention, backups, task expiry) run; off for the CLI's one-shot commands. */
  private schedules = true;
  private settingsOf: () => ContinuitySettings = () => DEFAULT_CONTINUITY_SETTINGS;
  private nowFn?: () => number;

  private constructor(dataDir: string, openMs: number, parts?: Parts, degraded?: string, ready?: Promise<void>) {
    this.dataDir = dataDir;
    this.openMs = openMs;
    this.parts = parts;
    this.degraded = degraded;
    this.ready = ready ?? Promise.resolve();
  }

  private need(): Parts {
    if (!this.parts) {
      throw new ContinuityDegradedError(this.degraded ?? 'not opened');
    }
    return this.parts;
  }

  get log(): FileEventLog {
    return this.need().log;
  }
  get index(): IndexClient {
    return this.need().index;
  }
  get blobs(): BlobStore {
    return this.need().blobs;
  }
  get data(): DataManager {
    return this.need().data;
  }
  get migration(): Migration {
    return this.need().migration;
  }
  get retention(): Retention {
    return this.need().retention;
  }
  get device(): DeviceInfo {
    return this.need().log.device;
  }

  /** Cleanup for permanently deleted entities (files outside the log). */
  onPurge(hook: PurgeHook): Disposable {
    return this.need().retention.onPurge(hook);
  }

  /**
   * Connects a SessionStore (CONVERSATION, §9.1): its saves become conversation events, deletes go to Trash,
   * retention archives; `conversations` is the manager the navigator and the CLI use. Never throws; a degraded
   * continuity leaves the store as in 1.6.
   */
  attachSessionStore(store: SessionStore, o: { defaultFolder?: () => string | undefined; origin?: ConversationFields['origin']; summarize?: (prompt: string, text: string) => Promise<string>; warn?: (m: string) => void } = {}): Disposable {
    if (!this.parts) {
      return { dispose: () => undefined };
    }
    const { log, index, blobs, retention } = this.parts;
    const healthy = () => !this.disposed && !this.indexFailed;
    const projects = this.projectResolver();
    // Chats are logged once the 1.6 import settled (so a chat being imported is not written twice concurrently).
    const bridge = new SessionBridge({ log, index, blobs, ready: Promise.all([this.ready, this.migrated]), healthy, projects, defaultFolder: o.defaultFolder, origin: o.origin, hint: (id) => store.takeHint(id), peek: (id) => (store.has(id) ? store.get(id) : undefined), warn: o.warn });
    const manager = new ConversationManager({ log, index, blobs, retention, store, bridge, projects, root: this.dataDir, defaultFolder: o.defaultFolder, summarize: o.summarize, warn: o.warn });
    store.bridge = bridge;
    this.bridge = bridge;
    this.projects = projects;
    this.conversations = manager;
    const folder = o.defaultFolder?.();
    if (folder) {
      void projects.resolve(folder).catch(() => undefined);
    }
    // Chats saved before continuity was open (it opens after the store, never blocking start-up).
    for (const s of store.takeUnbridged()) {
      bridge.prepare(s);
      bridge.saved(s, undefined);
    }
    const purge = retention.onPurge(async (ent, id) => {
      if (ent === 'conversation') {
        await manager.cleanupPurged(id);
      }
    });
    // Chats changed while this process was away (another window, the CLI, a restored backup) are reloaded.
    void Promise.all([this.ready, this.migrated])
      .then(async () => {
        if (healthy()) {
          await manager.refreshStale();
          await manager.adoptRemote();
          await bridge.reconcile(store.list(), (id) => (store.has(id) ? store.get(id) : undefined));
        }
      })
      .catch((e) => o.warn?.(`continuity: ${String(e)}`));
    const d = {
      dispose: () => {
        purge.dispose();
        manager.dispose();
        if (store.bridge === bridge) {
          store.bridge = undefined;
        }
      },
    };
    return this.track(d);
  }

  /** The project resolver of this process (shared by conversations and memory). */
  projectResolver(): ProjectResolver {
    const { log, index } = this.need();
    this.projects ??= new ProjectResolver({ log, index, ready: this.ready });
    return this.projects;
  }

  /**
   * Connects a MemoryStore (MEMORY, §9.2): note writes, deletes and hand edits become memory events, remote changes
   * are written back to the files (hash-guarded, never git-tracked project notes), the store's tools and prompt reach
   * the 1.7 types through `memory`. Never throws; a degraded continuity leaves the store as in 1.6.
   */
  attachMemoryStore(store: MemoryStore, o: { developerDir?: string; projectFolders?: () => string[]; watch?: WatchFactory | false; gitTracked?: GitTracked; taskExpiryDays?: () => number; now?: () => number; warn?: (m: string) => void } = {}): Disposable & { refreshFolders(): Promise<void> } {
    if (!this.parts) {
      return { dispose: () => undefined, refreshFolders: async () => undefined };
    }
    const { log, index, retention } = this.parts;
    const projects = this.projectResolver();
    const healthy = () => !this.disposed && !this.indexFailed;
    const bridge = new MemoryBridge({ log, index, root: this.dataDir, ready: Promise.all([this.ready, this.migrated]), healthy, watch: o.watch, gitTracked: o.gitTracked, now: o.now, warn: o.warn });
    const folders = () => (o.projectFolders?.() ?? []).filter(Boolean);
    const project = async () => {
      const f = folders()[0];
      return f ? (await projects.resolve(f)).id : undefined;
    };
    const files = {
      write: (name: string, body: string, scope: 'project' | 'global', mode: 'replace' | 'append' = 'replace', source?: 'user' | 'agent' | 'auto') => store.write(name, body, scope, mode, source),
      delete: (name: string, scope: 'project' | 'global') => store.delete(name, scope),
      read: (name: string, scope: 'project' | 'global') => store.read(name, scope),
      folder: (scope: 'project' | 'global') => store.folder(scope),
    };
    const manager = new MemoryManager({ log, index, bridge, retention, files, project, taskExpiryDays: o.taskExpiryDays, now: o.now, warn: o.warn });
    const prevChange = store.onChange;
    store.onChange = (note, scope, op, body, info) => {
      prevChange?.(note, scope, op, body, info);
      void bridge.noteChanged({ type: scope === 'global' ? 'developer' : 'project', name: note, file: info.path, op, body, source: info.source });
    };
    // A chat's project is the conversation's (another folder of a multi-root window), else this process's.
    store.typed = manager.typed({ projectOf: async (sid) => (sid && healthy() ? (await index.conversation(sid).catch(() => undefined))?.projectId : undefined) });
    this.memory = manager;
    this.memoryBridge = bridge;
    const refreshFolders = async () => {
      const list: NoteFolder[] = [];
      const dev = o.developerDir ?? store.folder('global');
      if (dev) {
        list.push({ type: 'developer', dir: dev });
      }
      for (const f of folders()) {
        const p = await projects.resolve(f).catch(() => undefined);
        if (p) {
          list.push({ type: 'project', dir: path.join(f, '.localpilot', 'memory'), projectId: p.id, root: f });
        }
      }
      await bridge.setFolders(list);
    };
    void Promise.all([this.ready, this.migrated])
      .then(() => (healthy() ? refreshFolders() : undefined))
      .catch((e) => o.warn?.(`memory: ${String(e)}`));
    const purge = retention.onPurge(async (ent, id) => {
      if (ent === 'conversation') {
        await manager.purgeConversation(id);
      }
    });
    if (this.schedules) {
      void Promise.all([this.ready, this.migrated]).then(() => healthy() && manager.start());
    }
    return this.track({
      refreshFolders,
      dispose: () => {
        purge.dispose();
        manager.dispose();
        bridge.dispose();
        if (store.typed && this.memory === manager) {
          store.typed = undefined;
        }
        store.onChange = prevChange;
      },
    });
  }

  /**
   * Starts the CONTEXT module (§8): context snapshots, the context library, related conversations and the context
   * policy. Uses the conversation manager when one is attached (earlier chats' bodies); `defaultFolder` is this
   * process's project. Never throws; a degraded continuity returns undefined and chats work as in 1.6.
   */
  attachContext(o: { defaultFolder?: () => string | undefined } = {}): ContextService | undefined {
    if (!this.parts || this.disposed) {
      return undefined;
    }
    if (this.context) {
      return this.context;
    }
    const { log, index, retention } = this.parts;
    const projects = this.projectResolver();
    const projectOf = async (sid?: string): Promise<string | undefined> => {
      const row = sid && !this.indexFailed ? await index.conversation(sid).catch(() => undefined) : undefined;
      if (row?.projectId) {
        return row.projectId;
      }
      const f = o.defaultFolder?.();
      return f ? (projects.peek(f) ?? (await projects.resolve(f).catch(() => undefined)))?.id : undefined;
    };
    const service = new ContextService({
      log,
      index,
      retention,
      projectOf,
      load: async (id) => (await this.conversations?.materialize(id).catch(() => undefined))?.session,
    });
    this.context = service;
    this.track({ dispose: () => (this.context === service ? (this.context = undefined) : undefined) });
    return service;
  }

  /**
   * Starts the SESSION module (§9.3): agent runs become agent sessions with their execution events, checkpoints and
   * model sessions; streaming answers leave drafts; runs a crash cut off are marked interrupted. The host connects
   * `sessions.bridge` to the runner (`sessionHooks`), CheckpointService, RecoveryStore and TraceStore
   * (src/ui/sessionHost.ts). Never throws; a degraded continuity returns undefined and runs work as in 1.6.
   */
  attachSessions(o: { modelInfo?: (modelId: string) => { local?: boolean; window?: number } | undefined; draftIntervalMs?: number; warn?: (m: string) => void } = {}): SessionManager | undefined {
    if (!this.parts || this.disposed) {
      return undefined;
    }
    if (this.sessions) {
      return this.sessions;
    }
    const { log, index, blobs } = this.parts;
    const projects = this.projectResolver();
    const mgr = new SessionManager({
      log,
      index,
      blobs,
      root: this.dataDir,
      ready: Promise.all([this.ready, this.migrated]),
      capture: () => ({ ...DEFAULT_CONTINUITY_SETTINGS, ...this.settingsOf() }).captureToolOutput ?? 'summary',
      now: this.nowFn,
      modelInfo: o.modelInfo,
      projectOf: (root) => projects.peek(root)?.id,
      draftIntervalMs: o.draftIntervalMs,
      warn: o.warn,
    });
    this.sessions = mgr;
    this.track({
      dispose: () => {
        mgr.dispose();
        if (this.sessions === mgr) {
          this.sessions = undefined;
        }
      },
    });
    // Runs a crash or a closed window cut off (their writer is gone) become `interrupted`.
    if (!this.indexFailed) {
      void Promise.all([this.ready, this.migrated]).then(() => (this.disposed || this.indexFailed ? undefined : mgr.recoverInterrupted()));
    }
    return mgr;
  }

  /**
   * Starts the SYNC module (§14): the engine that moves this device's streams to the configured remote and other
   * devices' streams back, end-to-end encrypted. Cycles run only when `settings().enabled` and the remote is set up.
   * Never throws; a degraded continuity (or a failed index) returns undefined and everything stays local as in 1.6.
   */
  attachSync(o: { settings: () => SyncSettings; start?: boolean; startDelayMs?: number; preferences?: PreferenceAccess; promptsDir?: string } & Partial<Pick<SyncEngineOptions, 'fetch' | 'gitPath' | 'backend' | 'kdfN' | 'effects' | 'passphraseHint' | 'warn' | 'info' | 'blobBudgetBytes'>>): SyncEngine | undefined {
    if (!this.parts || this.disposed) {
      return undefined;
    }
    if (this.sync) {
      return this.sync;
    }
    const { log, index, blobs } = this.parts;
    const engine = new SyncEngine({
      log,
      index,
      blobs,
      root: this.dataDir,
      secrets: this.secrets!,
      settings: o.settings,
      writer: this.writer,
      appVersion: this.appVersion,
      now: this.nowFn,
      fetch: o.fetch,
      gitPath: o.gitPath,
      backend: o.backend,
      kdfN: o.kdfN,
      warn: o.warn,
      info: o.info,
      passphraseHint: o.passphraseHint,
      blobBudgetBytes: o.blobBudgetBytes,
      extras: [
        new PromptsExtra({ log, index, root: this.dataDir, dir: o.promptsDir, warn: o.warn }),
        new CheckpointContentsExtra({ log, index, blobs, warn: o.warn }),
        ...(o.preferences ? [new PreferencesExtra({ log, index, root: this.dataDir, access: o.preferences })] : []),
      ],
      // A resolution changes memory files and chat branches through their managers when they are attached.
      effects:
        o.effects ??
        (() => ({
          setMemoryText: async (id, text) => {
            const it = await this.memory?.get(id, { includeTrash: true });
            if (it?.path && fs.existsSync(it.path)) {
              // A note file on this machine: write it, then log it through the memory bridge (hash-checked).
              const body = text.endsWith('\n') ? text : `${text}\n`;
              const tmp = `${it.path}.tmp-${process.pid}`;
              fs.writeFileSync(tmp, body);
              fs.renameSync(tmp, it.path);
              await this.memoryBridge?.noteChanged({ type: it.type === 'project' ? 'project' : 'developer', name: it.name, file: it.path, op: 'write', body, source: 'user' }).catch(() => undefined);
            } else if (this.memory) {
              await this.memory.update(id, { body: text });
            } else {
              log.append('memory', id, 'patch', { body: text }, { durable: true, base: log.peekHlc() });
            }
          },
          ...(this.memory
            ? {
                trashMemory: async (id: string) => void (await this.memory?.trash([id])),
                restoreMemory: async (id: string) => void (await this.memory?.restore([id])),
              }
            : {}),
          // Without a conversation manager here, the conflict service writes the log events itself.
          ...(this.conversations
            ? {
                switchBranch: async (cid: string, bid: string) => void (await this.conversations?.switchBranch(cid, bid)),
                trashConversation: async (id: string) => void (await this.conversations?.trash([id])),
              }
            : {}),
        })),
    });
    this.sync = engine;
    this.track({
      dispose: () => {
        engine.dispose();
        if (this.sync === engine) {
          this.sync = undefined;
        }
      },
    });
    if (o.start !== false && this.schedules && !this.indexFailed) {
      void this.ready.then(() => (this.disposed || this.indexFailed ? undefined : engine.start(o.startDelayMs)));
    }
    return engine;
  }

  /** Registers something to dispose with continuity (feature modules' bridges). */
  track<T extends Disposable>(d: T): T {
    this.disposables.push(d);
    return d;
  }

  static async open(o: ContinuityOptions): Promise<Continuity> {
    const t0 = performance.now();
    const root = path.resolve(o.dataDir);
    let log: FileEventLog;
    try {
      log = FileEventLog.open({ root, writer: o.writer, log: o.log, now: o.now, flushMs: o.flushMs });
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      o.log.warn(`continuity: off (${reason}); chats keep working as before`);
      return new Continuity(root, performance.now() - t0, undefined, reason);
    }
    const blobs = new BlobStore(root, o.now);
    const s = () => ({ ...DEFAULT_CONTINUITY_SETTINGS, ...o.settings() });
    const clientOpts = {
      root,
      wasmPath: o.wasmPath,
      deviceId: log.device.deviceId,
      ownStream: log.stream,
      maxMB: s().indexMaxMB,
      watch: true,
      log: (level: 'info' | 'warn' | 'error', m: string) => o.log[level](m),
    };
    const index = o.inProcessIndex ? new LocalIndexClient({ ...clientOpts, now: o.now }) : createIndexClient(o.workerPath, clientOpts);
    const migration = new Migration({ root, log, blobs, sources: o.migration ?? {}, logger: o.log, now: o.now });
    const retention = new Retention({ log, index, blobs, settings: () => s(), now: o.now, logger: o.log });
    const data = new DataManager({ root, log, index, blobs, migration, retention, backup: () => s().backup, appVersion: o.appVersion, now: o.now, logger: o.log });
    const ready = index.ready.then(
      () => undefined,
      (e: unknown) => {
        c.indexFailed = e instanceof Error ? e.message : String(e);
        o.log.warn(`continuity: index unavailable (${c.indexFailed}); history search uses the chat files`);
      }
    );
    const c = new Continuity(root, performance.now() - t0, { log, index, blobs, migration, retention, data }, undefined, ready);
    c.schedules = o.schedules !== false;
    c.secrets = o.secrets;
    c.writer = o.writer;
    c.appVersion = o.appVersion;
    c.settingsOf = o.settings;
    c.nowFn = o.now;
    // Own appends reach the index within ~300 ms (other processes' through the worker's watcher).
    let poke: NodeJS.Timeout | undefined;
    c.track(
      log.onAppend(() => {
        if (!poke) {
          poke = setTimeout(() => {
            poke = undefined;
            void index.catchUp().catch(() => 0);
          }, 300);
          poke.unref?.();
        }
      })
    );
    if (o.autoMigrate !== false && migration.needed()) {
      c.migrated = ready.then(async () => {
        if (c.disposed) {
          return;
        }
        const p = await migration.run();
        if (p.state === 'done') {
          o.log.info(`continuity: imported ${p.total} file(s) from 1.6${p.failed ? `, ${p.failed} could not be read` : ''}`);
        }
        await index.catchUp().catch(() => 0);
      }).catch((e: unknown) => o.log.warn(`continuity: import from 1.6: ${String(e)}`));
    }
    if (o.schedules !== false) {
      retention.start();
      data.start();
    }
    return c;
  }

  /** Flushes the log, persists the index, releases leases. */
  async dispose(): Promise<void> {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    for (const d of this.disposables.splice(0)) {
      try {
        await d.dispose();
      } catch {
        // keep going
      }
    }
    if (!this.parts) {
      return;
    }
    this.parts.retention.dispose();
    this.parts.data.dispose();
    await this.parts.log.flush();
    await this.parts.index.dispose().catch(() => undefined);
    await this.parts.log.dispose();
  }
}
