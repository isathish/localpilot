# Continuity architecture: conversations, memory, context, sessions, sync

Status: design for LocalPilot 1.7.0. Builders implement it in six modules (DATA, CONVERSATION, MEMORY, CONTEXT, SESSION,
SYNC, in that order). Where this document and the code disagree after a module lands, the builder updates this document.
The user-facing page is `docs/docs/continuity.md`.

Decisions taken by the user, not revisited here:

- Append-only per-device **event logs** (JSONL segments) are the source of truth. An **SQLite index built with sql.js**
  (WebAssembly, no native module) serves search and queries and is always rebuildable from the logs.
- Conversation history, project memory, model context and agent execution state are **separate entities linked by
  stable IDs**.
- Existing chats and memory **migrate automatically and non-destructively**; originals are kept as a backup until the user
  removes them.
- Sync backends: **Folder, Git, S3-compatible (SigV4 over fetch), WebDAV**. No LocalPilot server.
- Synced data is **always end-to-end encrypted**: AES-256-GCM, key derived from a passphrase with scrypt, key kept in
  SecretStorage (VS Code) or the CLI key file; storage only sees ciphertext.
- Ships as **1.7.0**. Only new dependency: `sql.js`.

---

## 1. What exists today and how it is reused

| Today | File | Role after this work |
|---|---|---|
| One JSON per chat, debounced atomic saves (tmp + rename), pin, rename, delete, fork (`parentId`), `folder`, LRU of transcripts, CLI chats read from `~/.localpilot/workspaces/<hash>/sessions` | `src/sessions/sessionStore.ts` | Unchanged public API. Becomes a **writer of events** (through `SessionBridge`) and stays the fast **materialised cache** of this workspace's chats. Its JSON files are a cache: the log wins when they disagree. |
| History search and filters | `src/sessions/historyQuery.ts` | Kept as the fallback when the index is not ready; the index answers the same `HistoryQuery` (plus new filters) once ready. |
| Transcript archive across compaction (`<id>.archive.jsonl`) | `src/sessions/transcriptArchive.ts` | Archived messages are already messages with ids in the log; the archive file stays as a cache for rewind. |
| Import of Claude Code / Codex sessions | `src/sessions/importers.ts` | Imports go through `SessionStore`, so they emit events automatically. |
| Export Markdown / HTML | `SessionStore.exportMarkdown/exportHtml`, `sessionHtml()` | Reused by the new export (JSON, Markdown, HTML, PDF via print-ready HTML). |
| Memory notes (`project`: `<ws>/.localpilot/memory/*.md`, `global`: `<globalStorage>/memory/*.md`) | `src/agent/memory.ts` | Files stay the editable surface for **project** and **developer** memory; `MemoryBridge` emits events on every write/delete and on external edits. |
| Auto memory | `src/agent/autoMemory.ts` | Writes through `MemoryStore`; gains a `type` (project / agent). |
| Context breakdown, compaction details | `src/context/contextBreakdown.ts`, `src/context/contextManager.ts` | Source of `context_snapshot` events. |
| Checkpoints (git refs `refs/localpilot/checkpoints/<session>/<run>`, file snapshots) | `src/agent/checkpoints.ts`, `src/agent/changeTracker.ts` | Each `CheckpointEntry` becomes a `checkpoint` entity (metadata); content stays in git / snapshot folders. |
| Recovery store (`<sid>.json`, locks, interventions) | `src/agent/healing/recoveryStore.ts` | Its lock semantics (`pid`, `host`, `at`, 30 s refresh, 120 s stale) are reused for log stream leases. Its state is mirrored into `agent_session` events. |
| Run traces (`traces/<sid>.json`, 20 per chat) | `src/telemetry/runTrace.ts`, `traceStore.ts` | A finished `RunTrace` becomes an `agent_session` + its `execution_event`s. `TraceStore` stays for the Trace card. |
| `session.runningSince` + "Run interrupted" card | `chatController.ts` | Gains "What ran" (execution events) and the partial-changes list. |
| Prompt library (custom commands) | `src/agent/promptLibrary.ts` | User-scope commands become `prompt_template` entities (files stay the surface). |
| CLI storage root `~/.localpilot` (or `LOCALPILOT_DATA_DIR`) | `src/sessions/cliStorage.ts` | The continuity data root lives under it so VS Code and the CLI share one log and one index per machine. |
| CLI secrets `~/.localpilot/keys.json` (0600) | `src/cli/vscodeShim.ts` | Holds the sync data key and backend credentials for the CLI. |

The messages in `Session.messages` have no id today. This design adds `ChatMessage.meta.id` (see §3).

---

## 2. Module boundaries

All new code lives in `src/continuity/` (no `vscode` import except in `*Host.ts` files and the composition root, so the CLI
and the smoke tests run it in plain Node through `src/cli/vscodeShim.ts` / `scripts/vscode-stub.js`).

```
src/continuity/
  ids.ts                ULID-based ids, prefixes, deterministic ids for migration
  hlc.ts                hybrid logical clock
  events.ts             envelope + payload types per entity, schema versions, validation
  continuity.ts         composition root: Continuity.open(opts) wires everything; used by extension.ts and cli/main.ts
  data/                 DATA module
    eventLog.ts         streams, leases, append, read, tail, crash repair
    segment.ts          segment file format, rotation
    compaction.ts       per-stream compaction, snapshots, redaction of purged entities
    blobs.ts            content-addressed blob store (images, attachments, large tool output)
    reducer.ts          pure: event -> entity state (field-level LWW); shared by index and sync
    index/indexWorker.ts    worker_threads entry: owns the sql.js database
    index/indexClient.ts    RPC client used on the main thread (IndexClient)
    index/schema.ts         DDL, user_version, FTS probe
    index/apply.ts          reducer output -> SQL upserts
    index/queries.ts        typed queries (history, search, counts, versions)
    crypto/envelope.ts      seal/open (AES-256-GCM), object format
    crypto/keyring.ts       scrypt KEK, DEK wrap/unwrap, passphrase change, key rotation
    migration.ts        legacy -> events, idempotent and resumable
    backup.ts           backup / restore files
    retention.ts        trash purge, version-history window, blob GC
    dataManager.ts      DataManager facade (stats, backup, restore, rebuild, migration backup removal)
  conversation/         CONVERSATION module
    conversationManager.ts, sessionBridge.ts, materialize.ts, export.ts, share.ts, merge.ts, projects.ts
  memory/               MEMORY module
    memoryManager.ts, memoryBridge.ts, memoryTypes.ts
  context/              CONTEXT module (named contextLibrary to avoid clashing with src/context/)
    contextSnapshots.ts, contextLibrary.ts, relatedContext.ts, contextPolicy.ts
  session/              SESSION module
    sessionManager.ts, runBridge.ts, drafts.ts, crashRecovery.ts
  sync/                 SYNC module
    syncEngine.ts, protocol.ts, merge.ts, conflicts.ts, devices.ts, scheduler.ts
    backends/backend.ts, folder.ts, git.ts, s3.ts, sigv4.ts, webdav.ts
src/ui/continuityHost.ts      webview message handling for the navigator and manager pages (split out of chatController)
src/ui/continuitySettings.ts  Settings section host side
media/continuity.js / .css    manager pages (Memory manager, Context library, Checkpoints, Sync manager, Trash, Versions, Conflicts)
src/cli/continuityCmd.ts      CLI subcommands: history (extended), memory, sync, data
```

Dependency direction (no cycles): `ids/hlc/events` <- `data` <- `conversation, memory, context, session` <- `sync` <-
`continuity.ts` <- `extension.ts / cli/main.ts / ui`. `sync` depends only on `data` (log, reducer, crypto, blobs) and on
the managers' `onRemoteChange` hooks, never on UI.

### 2.1 Composition root

```ts
// src/continuity/continuity.ts
export interface ContinuityOptions {
  dataDir: string;                       // default: path.join(cliDataDir(), 'continuity'); setting localpilot.continuity.dataDir
  writer: 'vscode' | 'cli';
  appVersion: string;
  secrets: SecretBox;                    // SecretStorage (VS Code) or keys.json (CLI)
  log: { info(m: string): void; warn(m: string): void; error(m: string): void };
  settings: () => ContinuitySettings;    // from src/config.ts getConfig().continuity
  wasmPath: string;                      // dist/sqljs/sql-wasm.wasm resolved by the caller
  workerPath: string;                    // dist/continuityWorker.js
  now?: () => number;                    // tests
}

export class Continuity implements Disposable {
  static open(o: ContinuityOptions): Promise<Continuity>;   // never throws: a failed open yields a degraded instance
  readonly ready: Promise<void>;                            // index caught up (UI falls back to SessionStore until then)
  readonly degraded?: string;                               // why continuity is off (unwritable dir, corrupt device.json...)
  readonly device: DeviceInfo;
  readonly log: EventLog;
  readonly index: IndexClient;
  readonly data: DataManager;
  readonly conversations: ConversationManager;
  readonly memory: MemoryManager;
  readonly context: ContextService;
  readonly sessions: SessionManager;
  readonly sync: SyncEngine;
  attachSessionStore(store: SessionStore, project: ProjectRef): Disposable;
  attachMemoryStore(store: MemoryStore, project: ProjectRef | undefined): Disposable;
  dispose(): Promise<void>;                                 // flushes log, persists index, releases leases
}
```

`extension.ts` calls `Continuity.open` after `SessionStore.load()` without awaiting `ready` (activation budget §12).
A degraded instance keeps every existing feature working exactly as in 1.6 and shows one warning in the navigator.

---

## 3. Stable IDs

Format: `<prefix>_<ULID>` (26 chars Crockford base32, 48-bit ms time + 80-bit random, monotonic within a ms). Sortable by
creation time, unique without coordination, safe in file names and git ref names.

| Entity | Prefix | Notes |
|---|---|---|
| conversation | `s_` | **Kept**: existing session ids (`s_…`, `cli-…`, imported) are conversation ids, so checkpoint refs, traces, recovery files and worktrees keep working. New ones keep `SessionStore.idPrefix`. |
| message | `m_` | Stored in `ChatMessage.meta.id`; assigned when a message is first saved. Migration: `m_` + base32(sha256(conversationId + '\0' + index + '\0' + role + '\0' + content))[0..26] (deterministic, so re-running migration is idempotent). |
| branch | `br_` | The main branch of a conversation is `br_<conversationId>` (deterministic). |
| project | `prj_` | Assigned on first sight of a folder; matched by fingerprints (§4.3). |
| memory item | `mem_` | Notes from files: `mem_` + hash(type + scope key + note name), so the same note on two devices is the same entity. |
| context snapshot | `ctx_` | |
| context library item | `cxl_` | |
| attachment / blob | `att_` | Blob content key is `sha256` of the plaintext; the attachment entity references it. |
| agent session | `as_` | = the `RunTrace.id` when there is a trace, else new. |
| execution event | `ex_` | |
| checkpoint | `cp_` | Deterministic: `cp_<conversationId>_<run>`. |
| model session | `ms_` | |
| prompt template | `pt_` | From files: `pt_` + hash(scope + name). |
| instruction file | `ins_` | hash(project or user scope + relative path). |
| preference | `pref_` | One per key: `pref_<key>`. |
| device | `dev_` | Created once per data root (`device.json`). |
| stream | `<deviceId>.<n>` | One per writing process (§5.2). |
| conflict | `cf_` | |
| event | `<streamId>:<seq>` | Unique and deterministic; dedup key everywhere. |

`src/continuity/ids.ts`:

```ts
export type IdPrefix = 'm' | 'br' | 'prj' | 'mem' | 'ctx' | 'cxl' | 'att' | 'as' | 'ex' | 'cp' | 'ms' | 'pt' | 'ins' | 'pref' | 'dev' | 'cf';
export function newId(prefix: IdPrefix, now?: number): string;
export function stableId(prefix: IdPrefix, ...parts: string[]): string;   // sha256 -> base32, 26 chars
export function idTime(id: string): number | undefined;                  // ULID timestamp, undefined for stable ids
export function isEntityId(id: string): boolean;                         // /^[\w.-]{1,120}$/ and no leading dot
```

---

## 4. Entity model

Every entity is a set of fields; every field carries the HLC of the event that last set it (field-level LWW, §9.4).
Links are ids, never paths or array indexes.

```
project 1─* conversation 1─* branch 1─* message 1─* message_part
                    │            (message.parentId forms a tree; branch.headId picks a path)
                    ├─* agent_session 1─* execution_event
                    │        ├─* checkpoint (taken before the run)
                    │        └─* context_snapshot (what the model saw)
                    ├─* model_session (contiguous use of one provider/model)
                    └─* memory_item (type 'conversation' / 'task')
project 1─* memory_item (type 'project'), instruction_file
user    1─* memory_item (types 'developer', 'knowledge', 'agent'), prompt_template, preference, context_library item
message *─* attachment (blob)
```

### 4.1 Entities and fields

```ts
// src/continuity/events.ts (payload shapes; every field optional in a patch)
export interface ConversationFields {
  title: string; projectId?: string; folder?: string;           // folder: absolute path on the device that set it
  model: string; mode: string; specialist?: string; autoMode?: boolean; think?: string;
  pinned: boolean; favorite: boolean; archived: boolean;
  trashedAt?: number;                                            // set by op 'trash', cleared by 'restore'
  tags: Record<string, boolean>;                                 // map-as-set, LWW per key
  activeBranchId: string;
  parentId?: string; parentMessageId?: string; parentTitle?: string;   // fork / duplicate / continue-from
  mergedFrom?: string[];                                         // conversation merge
  origin?: 'cli' | 'claude-code' | 'codex' | 'vscode' | 'import' | 'share';
  summary?: string; summaryAt?: number;
  group?: { id: string; kind: 'bestOf' | 'batch'; prompt: string; size: number };
  plan?: { file: string; title: string; summary: string };
  usage?: SessionUsage;                                          // as today
  createdAt: number;
}
export interface BranchFields {
  conversationId: string; label?: string;
  forkedFromMessageId?: string;     // undefined for the main branch
  headId?: string;                  // last message on this branch
  reason?: 'edit' | 'regenerate' | 'continue' | 'device-split' | 'restore-version' | 'manual';
  createdAt: number;
}
export interface MessageFields {
  conversationId: string; branchId: string; parentId?: string;   // previous message on its path
  role: 'system' | 'user' | 'assistant' | 'tool';
  parts: MessagePart[];
  meta: ChatMessage['meta'];         // minus images (moved to parts) and minus ids already stored here
  supersedes?: string;               // edit or regenerate: the message this one replaces on a new branch
  model?: string; provider?: string; agentSessionId?: string;
  partial?: boolean;                 // generation cut off (laptop off, crash)
  createdAt: number;
}
export type MessagePart =
  | { kind: 'text'; text: string }
  | { kind: 'thinking'; text: string }
  | { kind: 'image'; attachmentId: string; mime: string }
  | { kind: 'tool_call'; callId: string; name: string; args: string }
  | { kind: 'tool_result'; callId: string; name: string; text: string; isError?: boolean; blob?: string; truncated?: boolean };
export interface ProjectFields {
  name: string;
  fingerprints: { gitRemote?: string; rootCommit?: string; pathHash: Record<string /*deviceId*/, string> };
  paths: Record<string /*deviceId*/, string>;    // last known absolute path per device (encrypted when synced)
  createdAt: number;
}
export type MemoryType = 'conversation' | 'project' | 'developer' | 'task' | 'knowledge' | 'agent';
export interface MemoryItemFields {
  type: MemoryType; name: string; body: string; summary: string;
  projectId?: string; conversationId?: string; taskRef?: string;   // scope links per type (§7)
  source: 'user' | 'agent' | 'auto' | 'file' | 'migration';
  file?: string;                     // project/developer notes: path relative to the memory folder
  localOnly?: boolean;               // never sent to cloud providers (§8.3)
  expiresAt?: number; pinned?: boolean; tags: Record<string, boolean>;
  trashedAt?: number; createdAt: number;
}
export interface ContextSnapshotFields {
  conversationId: string; agentSessionId?: string; messageId?: string;
  model: string; provider: string; window: number; usedTokens: number;
  breakdown: ContextBreakdown;                    // from src/context/contextBreakdown.ts
  items: { kind: 'file' | 'selection' | 'memory' | 'rule' | 'summary' | 'library' | 'history' | 'tool'; ref: string; tokens: number; hash?: string }[];
  excluded?: { ref: string; reason: 'localOnly' | 'budget' | 'ignored' }[];
  compaction?: CompactionDetails;
  attachments: string[]; workingSet: string[]; todos?: TodoItem[];
  createdAt: number;
}
export interface ContextLibraryFields {
  name: string; description?: string; projectId?: string;
  items: { kind: 'file' | 'glob' | 'snippet' | 'memory' | 'conversation' | 'url'; ref: string; text?: string }[];
  createdAt: number; trashedAt?: number;
}
export interface AttachmentFields { blob: string /*sha256*/; mime: string; bytes: number; name?: string; conversationId?: string; createdAt: number }
export interface AgentSessionFields {
  conversationId: string; messageId?: string /*user turn*/; run: number;
  mode: string; specialist?: string; model?: string; provider?: string;
  startedAt: number; endedAt?: number;
  outcome: 'running' | 'ok' | 'error' | 'stopped' | 'interrupted';
  writer: string /*streamId*/; worktree?: WorktreeInfo;
  recovery?: { phase: string; attempt: number; category?: string };
  filesTouched?: string[]; promptTokens?: number; completionTokens?: number; costUsd?: number;
}
export interface ExecutionEventFields {
  agentSessionId: string; conversationId: string; seq: number;
  kind: TraceKind | 'approval_answer' | 'file_edit' | 'command_output';
  name: string; status?: TraceStatus; start: number; end?: number;
  detail?: string; error?: string; output?: string; outputBlob?: string; depth?: number; agent?: string;
}
export interface CheckpointFields {
  conversationId: string; agentSessionId?: string; messageId?: string; run: number;
  kind: CheckpointKind; outcome: CheckpointOutcome; ref?: string; sha?: string; root?: string; projectId?: string;
  files?: { path: string; status: 'A' | 'M' | 'D' }[];
  contentBlob?: string;               // git bundle / snapshot tarball when "Checkpoint contents" sync is on
  device: string; createdAt: number; restoredAt?: number;
}
export interface ModelSessionFields {
  conversationId: string; provider: string; model: string; local: boolean; window?: number;
  fromMessageId: string; toMessageId?: string; startedAt: number; endedAt?: number;
  promptTokens: number; completionTokens: number; costUsd?: number; reason?: 'user' | 'auto' | 'fallback' | 'provider-down';
}
export interface PromptTemplateFields { name: string; description: string; body: string; scope: 'user' | 'workspace'; projectId?: string; file?: string; trashedAt?: number }
export interface InstructionFileFields { scope: 'user' | 'project'; projectId?: string; path: string; body: string; gitTracked: boolean }
export interface PreferenceFields { key: string; value: unknown }       // allow-listed keys only, never secrets
export interface DeviceFields { name: string; platform: string; appVersions: Record<'vscode' | 'cli', string>; lastSeen: number; revokedAt?: number; streams: string[] }
export interface ConflictFields {
  entity: EntityKind; entityId: string; field: string;
  kind: 'field' | 'branch-split' | 'trash-vs-edit' | 'text-merge' | 'remote-damaged' | 'clock-skew';
  ours: { value: unknown; hlc: string; device: string }; theirs: { value: unknown; hlc: string; device: string };
  applied: 'ours' | 'theirs' | 'both' | 'merged';
  resolvedAt?: number; resolution?: 'keep-applied' | 'ours' | 'theirs' | 'both' | 'merged';
}
```

### 4.2 Branches, edits, regenerations, versions

- Messages form a tree through `parentId`; a branch is a named head. The `Session.messages` array of the SessionStore is
  the path from the root to `conversation.activeBranchId`'s head (plus the compaction summary messages as today).
- **Edit a prompt**: new user message with `supersedes = old.id`, `parentId = old.parentId`, on a new branch
  (`reason: 'edit'`); the old branch stays. The chat shows a `< 1/2 >` switcher on the message.
- **Regenerate** (optionally with another model): new assistant message with `supersedes`, new branch (`reason: 'regenerate'`).
  **Compare responses** shows sibling messages (same `parentId`) side by side; Best-of-N groups keep working as today.
- **Continue from any message** = a branch inside the conversation (`reason: 'continue'`). **Duplicate** = a new
  conversation with `parentId`/`parentMessageId` and copies of the messages (new message ids, `meta.copiedFrom`).
- **Restore an earlier version** never rewrites: it creates a branch at that message (`reason: 'restore-version'`) or emits
  a patch that sets the old field values (titles, flags, memory bodies).

### 4.3 Projects

A project is identified by `prj_` id and matched by fingerprints in this order: (1) normalized git remote URL
(`git config remote.origin.url`, scheme/creds stripped, `.git` removed, lower-cased host) **and** root commit
(`git rev-list --max-parents=0 HEAD`, first line); (2) `pathHash[device]` = sha256(`normalizeWorkspacePath(path)`)
(same function as `cliWorkspaceDir`); (3) the folder name only as a suggestion, never automatically. A project whose
path is gone but whose git fingerprint matches the opened folder is re-pointed silently (`paths[device]` patch). Multi-root
workspaces: each folder is a project; a conversation's `projectId` follows `Session.folder` (or the first folder).

---

## 5. Event log (DATA)

### 5.1 Envelope

```ts
export const ENVELOPE_VERSION = 1;
export type EntityKind = 'conversation' | 'branch' | 'message' | 'project' | 'memory' | 'context_snapshot' | 'context_item'
  | 'attachment' | 'agent_session' | 'execution_event' | 'checkpoint' | 'model_session' | 'prompt_template'
  | 'instruction_file' | 'preference' | 'device' | 'conflict' | 'migration';
export type Op = 'create' | 'patch' | 'trash' | 'restore' | 'purge';
export interface EventEnvelope<P = Record<string, unknown>> {
  v: 1;              // envelope schema version
  id: string;        // `${stream}:${seq}`
  stream: string;    // `<deviceId>.<n>`
  seq: number;       // 1-based, gapless per stream
  hlc: string;       // §5.4
  dev: string;       // deviceId
  ent: EntityKind;
  eid: string;       // entity id
  op: Op;
  sv: number;        // payload schema version for `ent` (starts at 1)
  p: P;              // create: all fields; patch: changed fields; trash/restore/purge: { reason?, at }
  base?: string;     // highest HLC of the entity this writer had applied when it wrote (concurrency detection)
  cause?: string;    // event id that caused this one (regenerate -> its source message event, sync resolution -> conflict)
  local?: true;      // never synced (drafts, local-only diagnostics)
}
```

Rules: one line per event, UTF-8 JSON, no pretty printing, max 1 MiB per line (bigger payloads go to blobs:
tool outputs > 64 KiB, images always, file snapshots always). Unknown `ent` or a higher `sv` than this build knows:
kept in the log, skipped by the reducer, counted as "needs a newer LocalPilot" in the Sync manager. Readers ignore
unknown payload fields; writers never remove a field from a schema without bumping `sv` and adding an upgrade function
in `events.ts` (`upgradePayload(ent, sv, p)`).

### 5.2 Streams and on-disk layout

Data root: setting `localpilot.continuity.dataDir`, default `path.join(cliDataDir(), 'continuity')`
(`~/.localpilot/continuity`, honours `LOCALPILOT_DATA_DIR`). VS Code and the CLI share it.

```
<root>/
  device.json                     { v:1, deviceId, name, platform, createdAt }   written once (O_EXCL)
  streams/
    dev_A.1/                      a stream: one writer process at a time
      lease.json                  { pid, host, kind:'vscode'|'cli', at }  refreshed every 30 s, stale after 120 s
      000000000001.jsonl          sealed segment (first seq in the name, 12 digits)
      000000004213.jsonl          active segment (the highest-numbered file)
      compact-000000004212.jsonl  optional compacted base covering seq 1..4212 (§5.6)
    dev_B.1/                      streams pulled from other devices (read-only here)
  blobs/sha256/ab/<sha256>        content-addressed, immutable, written tmp + rename
  index/index.sqlite              sql.js export, written only by the index lease holder
  index/index.lease.json
  drafts/<conversationId>.json    local-only partial answers (§13)
  backups/<yyyymmdd-hhmmss>.lpbackup
  migration/state.json            per-source progress (§11)
  migration/legacy-backup/<yyyymmdd>/...   copies of the original files
  sync/state.json                 remote id, cursors, upload ranges, backoff
  sync/git/<remoteId>/            git backend working clone
```

Stream allocation: a process takes the lowest `n` whose `lease.json` is absent, stale (older than 120 s), or owned by a
dead pid on this host (`isPidAlive` from recoveryStore). Lease is created with `O_EXCL` on `lease.json.tmp-<pid>` then
renamed; after rename it re-reads and checks it owns it (same pattern as `RecoveryStore.claimLock`). Streams are never
deleted while they hold unsynced events. Two VS Code windows plus a CLI = three streams; that is expected.

### 5.3 Append, durability, crash repair

```ts
export interface EventLog {
  readonly device: DeviceInfo;
  readonly stream: string;                       // this process's stream
  append<E extends EntityKind>(ent: E, eid: string, op: Op, p: object, o?: { base?: string; cause?: string; durable?: boolean; local?: boolean }): EventEnvelope;
  flush(): Promise<void>;                        // writes buffered lines, fdatasync
  read(stream: string, fromSeq?: number): AsyncIterable<EventEnvelope>;
  readAt(loc: EventLoc): Promise<EventEnvelope>; // random access for materialisation
  streams(): Promise<StreamInfo[]>;              // { id, device, lastSeq, own }
  onAppend: Event<EventEnvelope[]>;              // fired after the batch is on disk
  importRemote(stream: string, events: EventEnvelope[]): Promise<void>; // sync: verify gapless, append to the local copy of a remote stream
  observeHlc(hlc: string): void;                 // advance the local clock on received events
  dispose(): Promise<void>;
}
export interface EventLoc { stream: string; segment: number; offset: number; length: number }
```

- `append` is synchronous on the main thread (assigns seq + hlc, pushes to a buffer, < 0.2 ms), the buffer is written
  with one `fs.appendFile` every 250 ms or immediately when `durable` (message finalised, run start/end, trash, purge,
  conflict resolution), followed by `fdatasync`.
- Opening a stream reads the active segment's tail: a last line without `\n` or that fails `JSON.parse` is truncated
  (`ftruncate` to the last good newline) and logged; `seq` continues from the last good event. A gap in sequence inside a
  segment is impossible for own streams; for remote streams `importRemote` rejects a batch that does not start at
  `lastSeq + 1`.
- Rotation: the active segment is sealed when it exceeds 8 MiB or when it is 24 h old; the next file is named by its first seq.

### 5.4 Hybrid logical clock

`hlc = <physical ms, 12 hex digits>-<logical counter, 4 hex>-<deviceId>`; lexical order = causal-consistent total order.
Local tick: `pt = max(now, last.pt)`, counter resets when `pt` advances. Receive: standard HLC max rule, except a remote
`pt` more than 10 minutes in the future does not move the local clock beyond `now + 10 min`; the event is still applied
and a `clock-skew` conflict record (info level, auto-resolved) names the device.

```ts
export class Hlc { constructor(deviceId: string, now?: () => number); tick(): string; observe(remote: string): void; static compare(a: string, b: string): number; static physical(h: string): number }
```

### 5.5 Reducer (shared by index, sync and materialisation)

```ts
export interface EntityState { ent: EntityKind; id: string; fields: Record<string, unknown>; clocks: Record<string, string>; created: string; trashed?: string; purged?: string; version: string /* max hlc */ }
export interface ReduceResult { state: EntityState; changed: string[]; conflicts: ConflictFields[] }
export function reduce(prev: EntityState | undefined, e: EventEnvelope, rules: MergeRules): ReduceResult;  // pure
```

`create` on an existing entity merges fields by clock (idempotent re-application, migration re-runs). `patch` sets each
field whose incoming HLC is greater than the field's clock; map fields (`tags`, `paths`, `fingerprints.pathHash`) are
merged per key. `trash`/`restore` are a LWW register `trashedAt`. `purge` is terminal: state keeps only id, `purged`,
and a tombstone; later events for it are ignored. The same event applied twice changes nothing. Applying a set of
events in any interleaving that respects per-stream order gives the same state (tested by property test, §17).

### 5.6 Compaction, snapshots, redaction

Per own stream only (single writer, so no coordination): when sealed segments older than
`localpilot.continuity.historyDays` (default 90) exist, write `compact-<lastSeq>.jsonl` containing, for every entity
touched in those segments, one `create` event with its reduced fields **as of** the cut (original `hlc` of each field kept
in `p.__clocks`), plus tombstones for purged entities, then delete the covered segments. Version history older than the
window is therefore lost by design (setting documented). Purged entities: compaction drops their payloads even inside the
window; payloads of purged entities in other devices' streams are dropped by those devices when they compact. Remote
copies follow (§14.6).

### 5.7 Blobs

`blobs/sha256/<2>/<64>`; written tmp + rename; reference-counted by the index (`attachments`, `execution_events.output_blob`,
`checkpoints.content_blob`); GC removes unreferenced blobs older than 7 days. Images in `ChatMessage.images` (base64)
become blobs on save; the SessionStore JSON cache keeps base64 as today (no change to its readers).

---

## 6. sql.js index (DATA)

### 6.1 Runtime

- Runs in a `worker_threads` Worker (`dist/continuityWorker.js`, a third esbuild entry from
  `src/continuity/data/index/indexWorker.ts`) so FTS and rebuilds never block the extension host. RPC: `IndexClient`
  (request id + structured clone; methods below). The worker loads `sql-wasm.wasm` from `dist/sqljs/` via
  `initSqlJs({ locateFile: () => wasmPath })`.
- Persistence: the process holding `index/index.lease.json` writes `db.export()` to `index.sqlite.tmp` then renames, at most
  every 60 s when dirty and on dispose. Other processes keep their own in-memory copy and tail all streams (fs.watch on
  `streams/` plus a 2 s poll fallback). Startup: load `index.sqlite` (if `user_version` matches), then catch up from
  `stream_cursors`. Mismatch or corrupt file: full rebuild from logs in the worker, with progress events.
- FTS: probe `CREATE VIRTUAL TABLE temp.p USING fts5(x)` at start; if it fails, use FTS4 with the same column layout
  (`MATCH` syntax subset common to both; ranking falls back to `matchinfo`-free recency order). **Recorded (DATA):
  sql.js 1.15.2 (SQLite 3.54.0) provides FTS3/FTS4 only, no FTS5, so the index uses FTS4** with the enhanced query
  syntax (`NOT` keyword, `column:term`); see §20.

```ts
export interface IndexClient {
  ready: Promise<void>;
  status(): Promise<{ state: 'loading' | 'catching-up' | 'rebuilding' | 'ready' | 'failed'; progress?: number; events: number; bytes: number; fts: 'fts5' | 'fts4' }>;
  history(q: IndexHistoryQuery): Promise<IndexHistoryPage>;     // superset of HistoryQuery
  counts(projectId?: string): Promise<NavCounts>;               // All / Pinned / Favorites / Archived / Trash / per project
  search(q: SearchQuery): Promise<SearchHit[]>;
  conversation(id: string): Promise<ConversationRow | undefined>;
  messages(conversationId: string, branchId?: string): Promise<MessageRow[]>;   // path with EventLoc for bodies
  memory(q: MemoryQuery): Promise<MemoryRow[]>;
  versions(ent: EntityKind, id: string): Promise<VersionRow[]>;
  query<T>(name: NamedQuery, params: Record<string, unknown>): Promise<T[]>;    // allow-listed named queries only, no raw SQL from callers
  rebuild(): Promise<void>;
  dispose(): Promise<void>;
}
export interface SearchQuery {
  text: string;                         // FTS syntax subset: words, "phrases", prefix*, -exclude
  in?: ('title' | 'messages' | 'responses' | 'code' | 'errors' | 'memory')[];
  projectId?: string | 'all'; role?: 'user' | 'assistant'; model?: string; tag?: string; mode?: string;
  after?: number; before?: number; includeArchived?: boolean; includeTrash?: boolean; limit?: number; offset?: number;
}
export interface SearchHit { conversationId: string; messageId?: string; memoryId?: string; field: string; snippet: string; score: number; at: number; projectId?: string }
```

The query parser (`queries.ts`) also understands inline filters typed in the search box: `in:code`, `in:errors`,
`from:user`, `from:assistant`, `project:<name>`, `tag:<name>`, `model:<id>`, `is:pinned|favorite|archived|trashed`,
`before:YYYY-MM-DD`, `after:YYYY-MM-DD`.

### 6.2 Schema (`PRAGMA user_version = 1`)

```sql
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE stream_cursors (stream TEXT PRIMARY KEY, device TEXT NOT NULL, last_seq INTEGER NOT NULL, own INTEGER NOT NULL);
CREATE TABLE entity_clocks (id TEXT PRIMARY KEY, ent TEXT NOT NULL, clocks TEXT NOT NULL, version TEXT NOT NULL);  -- field HLCs (JSON) for incremental reduce
CREATE TABLE entity_events (id TEXT NOT NULL, hlc TEXT NOT NULL, op TEXT NOT NULL, stream TEXT NOT NULL, seq INTEGER NOT NULL,
  segment INTEGER NOT NULL, offset INTEGER NOT NULL, length INTEGER NOT NULL, fields TEXT, PRIMARY KEY (id, hlc));   -- version history + locators
CREATE INDEX entity_events_stream ON entity_events (stream, seq);

CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, git_remote TEXT, root_commit TEXT, path TEXT,  -- path on THIS device
  created_at INTEGER, updated_at INTEGER);
CREATE INDEX projects_remote ON projects (git_remote, root_commit);
CREATE TABLE project_paths (project_id TEXT NOT NULL, device TEXT NOT NULL, path_hash TEXT NOT NULL, path TEXT, PRIMARY KEY (project_id, device));
CREATE INDEX project_paths_hash ON project_paths (path_hash);

CREATE TABLE conversations (id TEXT PRIMARY KEY, project_id TEXT, folder TEXT, title TEXT NOT NULL, model TEXT, mode TEXT, specialist TEXT,
  pinned INTEGER NOT NULL DEFAULT 0, favorite INTEGER NOT NULL DEFAULT 0, archived INTEGER NOT NULL DEFAULT 0, trashed_at INTEGER, purged INTEGER NOT NULL DEFAULT 0,
  active_branch_id TEXT, parent_id TEXT, parent_message_id TEXT, origin TEXT, summary TEXT, message_count INTEGER NOT NULL DEFAULT 0,
  tokens INTEGER, cost_usd REAL, bytes INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, last_device TEXT, group_id TEXT);
CREATE INDEX conv_list ON conversations (project_id, trashed_at, archived, pinned DESC, updated_at DESC);
CREATE INDEX conv_fav ON conversations (favorite, updated_at DESC);
CREATE INDEX conv_updated ON conversations (updated_at DESC);
CREATE TABLE conversation_tags (conversation_id TEXT NOT NULL, tag TEXT NOT NULL, PRIMARY KEY (conversation_id, tag));
CREATE INDEX conversation_tags_tag ON conversation_tags (tag);
CREATE TABLE conversation_branches (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, label TEXT, forked_from_message_id TEXT, head_id TEXT,
  reason TEXT, created_at INTEGER NOT NULL);
CREATE INDEX branches_conv ON conversation_branches (conversation_id, created_at);

CREATE TABLE messages (rowid INTEGER PRIMARY KEY, id TEXT UNIQUE NOT NULL, conversation_id TEXT NOT NULL, branch_id TEXT NOT NULL, parent_id TEXT,
  role TEXT NOT NULL, created_at INTEGER NOT NULL, model TEXT, provider TEXT, agent_session_id TEXT, supersedes TEXT, partial INTEGER NOT NULL DEFAULT 0,
  summary INTEGER NOT NULL DEFAULT 0, hidden INTEGER NOT NULL DEFAULT 0, tokens INTEGER, has_code INTEGER NOT NULL DEFAULT 0, has_error INTEGER NOT NULL DEFAULT 0,
  loc_stream TEXT NOT NULL, loc_segment INTEGER NOT NULL, loc_offset INTEGER NOT NULL, loc_length INTEGER NOT NULL);
CREATE INDEX messages_conv ON messages (conversation_id, created_at);
CREATE INDEX messages_parent ON messages (parent_id);
CREATE TABLE message_parts (message_id TEXT NOT NULL, idx INTEGER NOT NULL, kind TEXT NOT NULL, tool_name TEXT, call_id TEXT, is_error INTEGER,
  attachment_id TEXT, chars INTEGER, PRIMARY KEY (message_id, idx));            -- shape only; text lives in the log, searchable text in message_text
CREATE INDEX message_parts_tool ON message_parts (tool_name);
CREATE TABLE message_text (rowid INTEGER PRIMARY KEY, prose TEXT, code TEXT, errors TEXT);   -- rowid = messages.rowid; external content for FTS
CREATE VIRTUAL TABLE message_fts USING fts5(prose, code, errors, content='message_text', content_rowid='rowid', tokenize='unicode61 remove_diacritics 2');
CREATE VIRTUAL TABLE conversation_fts USING fts5(title, summary, tags, content='', tokenize='unicode61');  -- rowid = conversations.rowid

CREATE TABLE attachments (id TEXT PRIMARY KEY, blob TEXT NOT NULL, mime TEXT, bytes INTEGER, name TEXT, conversation_id TEXT, created_at INTEGER, present INTEGER NOT NULL DEFAULT 1);
CREATE INDEX attachments_blob ON attachments (blob);

CREATE TABLE memory_items (rowid INTEGER PRIMARY KEY, id TEXT UNIQUE NOT NULL, type TEXT NOT NULL, name TEXT NOT NULL, summary TEXT, body TEXT,
  project_id TEXT, conversation_id TEXT, task_ref TEXT, source TEXT, file TEXT, local_only INTEGER NOT NULL DEFAULT 0, pinned INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER, trashed_at INTEGER, created_at INTEGER, updated_at INTEGER, chars INTEGER);
CREATE INDEX memory_scope ON memory_items (type, project_id, trashed_at, updated_at DESC);
CREATE TABLE project_memory (project_id TEXT NOT NULL, memory_id TEXT NOT NULL, file TEXT NOT NULL, content_hash TEXT, PRIMARY KEY (project_id, memory_id));
CREATE VIRTUAL TABLE memory_fts USING fts5(name, body, content='memory_items', content_rowid='rowid');

CREATE TABLE context_snapshots (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, agent_session_id TEXT, message_id TEXT, model TEXT, provider TEXT,
  window INTEGER, used_tokens INTEGER, breakdown TEXT, items TEXT, excluded TEXT, compaction TEXT, created_at INTEGER NOT NULL);
CREATE INDEX ctx_conv ON context_snapshots (conversation_id, created_at DESC);
CREATE TABLE context_library (id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT, project_id TEXT, items TEXT NOT NULL, trashed_at INTEGER, created_at INTEGER, updated_at INTEGER);

CREATE TABLE agent_sessions (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, message_id TEXT, run INTEGER, mode TEXT, model TEXT, provider TEXT,
  started_at INTEGER NOT NULL, ended_at INTEGER, outcome TEXT NOT NULL, writer TEXT, files_touched TEXT, prompt_tokens INTEGER, completion_tokens INTEGER, cost_usd REAL, recovery TEXT);
CREATE INDEX as_conv ON agent_sessions (conversation_id, started_at DESC);
CREATE INDEX as_outcome ON agent_sessions (outcome);
CREATE TABLE execution_events (id TEXT PRIMARY KEY, agent_session_id TEXT NOT NULL, conversation_id TEXT NOT NULL, seq INTEGER NOT NULL, kind TEXT NOT NULL,
  name TEXT, status TEXT, start INTEGER, end INTEGER, detail TEXT, error TEXT, output_blob TEXT, depth INTEGER, agent TEXT);
CREATE INDEX ex_session ON execution_events (agent_session_id, seq);
CREATE INDEX ex_errors ON execution_events (status) WHERE status = 'error';
CREATE TABLE checkpoints (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, agent_session_id TEXT, message_id TEXT, run INTEGER, kind TEXT, outcome TEXT,
  ref TEXT, sha TEXT, root TEXT, project_id TEXT, files TEXT, content_blob TEXT, device TEXT, created_at INTEGER NOT NULL, restored_at INTEGER);
CREATE INDEX cp_conv ON checkpoints (conversation_id, created_at DESC);
CREATE INDEX cp_project ON checkpoints (project_id, created_at DESC);
CREATE TABLE model_sessions (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, provider TEXT, model TEXT, local INTEGER, window INTEGER,
  from_message_id TEXT, to_message_id TEXT, started_at INTEGER, ended_at INTEGER, prompt_tokens INTEGER, completion_tokens INTEGER, cost_usd REAL, reason TEXT);
CREATE INDEX ms_conv ON model_sessions (conversation_id, started_at);
CREATE TABLE prompt_templates (id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT, body TEXT, scope TEXT, project_id TEXT, file TEXT, trashed_at INTEGER, updated_at INTEGER);
CREATE TABLE instruction_files (id TEXT PRIMARY KEY, scope TEXT, project_id TEXT, path TEXT, body_hash TEXT, git_tracked INTEGER, updated_at INTEGER);
CREATE TABLE preferences (key TEXT PRIMARY KEY, value TEXT, updated_at INTEGER);

CREATE TABLE sync_devices (id TEXT PRIMARY KEY, name TEXT, platform TEXT, app_versions TEXT, last_seen INTEGER, revoked_at INTEGER, streams TEXT, this_device INTEGER NOT NULL DEFAULT 0);
CREATE TABLE sync_events (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, kind TEXT NOT NULL, remote TEXT, uploaded INTEGER, downloaded INTEGER,
  bytes INTEGER, error TEXT);                       -- local activity log of the sync engine (not domain events), last 500 kept
CREATE TABLE sync_conflicts (id TEXT PRIMARY KEY, entity TEXT NOT NULL, entity_id TEXT NOT NULL, field TEXT, kind TEXT NOT NULL, ours TEXT, theirs TEXT,
  applied TEXT, created_at INTEGER NOT NULL, resolved_at INTEGER, resolution TEXT);
CREATE INDEX conflicts_open ON sync_conflicts (resolved_at, created_at DESC);
```

`message_text` holds searchable text only: prose (user text, assistant text, thinking excluded), fenced code blocks and
tool call arguments in `code`, and error text (tool results with `isError`, `error` execution events, diagnostics lines
matching `/error|exception|traceback|failed/i`) in `errors`, each truncated to 32 KiB per message (tool results to
2 KiB). Bodies are read from the log through `loc_*`. Rebuild = drop all tables, replay every stream from seq 1 in
HLC-merged order, commit every 5,000 events, report progress.

---

## 7. Memory types (MEMORY)

| Type | Scope link | Stored | Lifetime | Who writes | In the prompt |
|---|---|---|---|---|---|
| conversation | `conversationId` | log only | with the conversation (trash/purge follow it) | auto summary after compaction or 20 messages; user "Remember in this chat" | only in that conversation |
| project | `projectId` | `<ws>/.localpilot/memory/<name>.md` (as today) + log | until deleted | agent `memory_save`, auto memory, user | every chat of the project (current index rules) |
| developer | user | `<globalStorage>/memory/<name>.md` (today's `global`) + log | until deleted | user, agent when asked | every chat |
| task | `taskRef` (plan file or todo list id) + `projectId` | log only | `expiresAt` = 14 days after the task's todos are all done (setting) | agent while a plan/todo list runs | chats working on that task |
| knowledge | user, optional `projectId` | log only | until deleted | user (Memory manager, "Save to knowledge" on a message) | on demand: `memory_search` tool and `#memory:<name>` |
| agent | user, optional `projectId` | log only | until deleted, max 200 | autoMemory "pitfalls", healing outcomes (what fixed which failure) | index line only; body via `memory_read` |

`global` stays accepted as an alias of `developer` in tools, settings and the CLI. The memory tools gain an optional
`type` argument and a new `memory_search` tool (FTS over `memory_fts`, current project + user scope). Notes flagged
`localOnly` are never sent to a cloud provider (§8.3).

---

## 8. Context (CONTEXT)

### 8.1 Context snapshots
One `context_snapshot` per agent session (the last model request of the turn) plus one before and after every compaction.
Built from what `agentLoop` already computes (`contextBreakdown`, attachments, working set, todos, compaction details)
plus the list of items with token estimates. Powers: the Context inspector (the context ring's card gains "Items" and
"Excluded" tabs), **context restoration** (reopening a chat after a restart or on another device restores attachments,
working set and todos from the latest snapshot; files whose hash changed are marked "changed since"), and "What did the
model see?" on any assistant message.

### 8.2 Context library
Named, reusable context sets (files, globs, snippets, memory items, excerpts of earlier conversations, URLs) attached with
`#context:<name>` or from the Context library page. Stored as `context_item` entities; synced.

### 8.3 Smart context selection and policy
- `relatedContext.ts`: when a new conversation starts or the user sends the first message, FTS over this project's earlier
  conversations' `prose`+`errors` (top 3, score threshold, excluding trashed) offers a "Related: <title> · Add" chip;
  nothing is added without a click. `#chat:<title>` mention adds a summary (conversation summary, else first user message
  + last assistant message, capped at 1,500 tokens). Setting `localpilot.continuity.relatedConversations` (default on).
- The agent gets a `history_search` tool (read-only, current project by default, `all_projects: true` to widen) returning
  snippets with conversation ids, and `history_read` (a message range of one conversation, capped).
- `contextPolicy.ts`: before each request to a non-local provider, items marked `localOnly` (memory items, library items,
  conversations tagged `local-only`) are removed and listed in the snapshot's `excluded`.

### 8.4 Model switching and window changes
Switching model (picker, fallback, `switchModelAndRetry`) closes the open `model_session` and opens a new one. If the new
window is smaller than the current context, the existing compaction runs before the next request (archive keeps the full
transcript). Switching from a local to a cloud provider shows a one-time-per-conversation notice listing what will now be
sent (and what is excluded by policy).

---

## 9. Writers: how existing stores emit events without API changes

### 9.1 SessionBridge (CONVERSATION)
`attachSessionStore(store, project)` wraps `SessionStore` with hooks the store calls; the public API stays identical.

- New `SessionStore` members (additive): `onDidSave: Event<{ session: Session; previous?: SavedShape }>` fired in `flush`
  **before** the JSON write; `onDidRename/onDidTogglePin` are covered by `onDidSave`; `onDidDelete` exists.
  `lastSavedShape(id)` keeps per session: message ids in order, per-message content hash, and summary fields.
- On save: assign `meta.id` to messages lacking one; diff against the previous shape:
  appended messages -> `message.create` (+ `branch.patch headId`); a changed prefix (rewind, `editAndRegenerate`,
  `clearSession`) -> new branch from the divergence point (`reason` from a hint set by the controller:
  `store.hint(id, 'edit' | 'regenerate' | 'continue' | 'restore-version')`), old branch kept; a message whose content changed
  in place (streaming finalised, tool result filled) -> `message.patch` only while it is the last message, else treated as a
  new version; summary field changes -> `conversation.patch`.
- Compaction summary messages are messages (`meta.summary`), so the log has the full transcript plus summaries without
  reading the archive file.
- `delete(id)` -> `conversation.trash` (the JSON cache file is removed as today, the conversation stays in the index under
  Trash). `clearAll/clearExcept/prune` -> trash. Purge happens only from Trash or retention.
- Writes are ordered: events appended (durable for finalised messages) -> JSON written. On load, if
  `conversation.version` in the index is newer than the JSON's `meta.lastHlc` (new field on `Session`), the conversation
  is re-materialised from the log (`materialize.ts`) and the JSON rewritten.
- Remote changes: `ConversationManager.onRemoteChange(ids)` re-materialises conversations of this workspace's projects;
  if a conversation is in use (running or on screen) it is not replaced: a banner "Updated on <device>" with "Reload" appears
  and the reload happens after the run ends.

### 9.2 MemoryBridge (MEMORY)
`MemoryStore.write/delete` gain an optional `onChange` callback (constructor option); the bridge emits
`memory.create/patch/trash` with the full body (notes are capped at `memory.maxNoteChars`). A `FileSystemWatcher` (VS Code)
or `fs.watch` (CLI) on both memory folders picks up edits made by hand or by git (`source: 'file'`). Remote memory changes
are written back to the files only when the file's current hash equals the `project_memory.content_hash` last seen;
otherwise a `text-merge` conflict is created (§14.4). Project memory files tracked by git are **not** written by sync
(git already moves them); their events are still logged for search.

### 9.3 RunBridge (SESSION)
- Run start (`runningSince` set): `agent_session.create` (durable).
- `AgentEvent` stream: `tool_start/tool_end`, `model_request`, `error`, `compaction`, approvals, retries/fallbacks ->
  `execution_event.create` (output kept per `localpilot.continuity.captureToolOutput`: `errors` | `summary` (default, first
  2 KiB) | `full` (blob)). Deltas are not logged.
- Run end (`turn_end`, stop, error): `agent_session.patch` with outcome, tokens, files touched (from `ChangeTracker`).
- `RunTraceRecorder` finished trace -> `agent_session.patch { traceId }` (TraceStore unchanged).
- `CheckpointService.snapshot` -> `checkpoint.create` (id `cp_<sid>_<run>`); restore -> `checkpoint.patch { restoredAt }`.
- `RecoveryStore.save` -> `agent_session.patch { recovery }` (throttled to phase changes).
- Model switches -> `model_session` create/patch.

### 9.4 Merge rules per entity (used by the reducer and sync)

| Entity / field | Rule | User-visible conflict? |
|---|---|---|
| conversation: pinned, favorite, archived, model, mode, think, folder | LWW per field | no |
| conversation: title | LWW | yes if concurrent and both values non-default (info, "keep applied" default) |
| conversation: tags | per-tag LWW | no |
| conversation: trashedAt vs new messages | messages written without having seen the trash (`base` < trash HLC) restore the conversation | yes (`trash-vs-edit`, info) |
| branch.headId on the same branch | concurrent appends with the same `parentId` from two devices: later HLC keeps the branch, the other device's messages move to a new branch "<device> · <time>" | yes (`branch-split`), actions: Keep both / Switch / Merge |
| message | immutable after final; patches only by its writer stream while it is the last message | never |
| memory body | 3-way line merge (base = version at `base` HLC from `entity_events`); clean merge applied silently; overlap -> later HLC applied, other kept in versions | yes (`text-merge`) on overlap |
| memory flags, tags | LWW | no |
| context library items | LWW whole list | yes if concurrent |
| prompt template body, instruction file body | same as memory body | yes on overlap |
| preferences | LWW per key | no |
| checkpoints, execution events, agent sessions, context snapshots, model sessions | single writer (their stream) | never |
| device | written only by that device; revocation by any device is LWW | no |
| purge | wins over everything, terminal | no |

Concurrency test: an incoming patch is concurrent with the current field value when `incoming.base < clocks[field]`
and the current value's device differs.

---

## 10. Trash, retention, backup, restore, version history (DATA)

- **Trash**: delete anywhere (history row, multi-select, CLI) -> `trash`. Toast "Moved to Trash · Undo" for 10 s. Trash view
  lists conversations, memory items, library items, prompt templates. **Restore** -> `restore`. **Delete permanently** ->
  `purge` (confirmation). Purge removes the JSON cache, archive file, traces file, drafts, blobs no longer referenced, and
  deletes `refs/localpilot/checkpoints/<id>/*` (same code as today's delete with "delete checkpoints").
- **Retention**: `localpilot.continuity.trashRetentionDays` (default 30, 0 = never purge automatically) runs at startup and
  every 24 h. `localpilot.sessions.retention` (existing, default 50) now moves the oldest idle chats beyond the limit to
  **Archived** instead of deleting them (changed behaviour, CHANGELOG "Changed"); 0 keeps everything as today.
- **Version history**: `entity_events` rows within `historyDays` (default 90). Versions view per conversation (title,
  flags, branches with their head message) and per memory item (full bodies, diff against current). "Restore this version"
  emits a patch or a branch, never rewrites.
- **Backup**: `DataManager.backup({ passphrase? })` writes `backups/<stamp>.lpbackup`: a gzip of a JSONL stream
  `{ kind: 'header', v, deviceId, createdAt, streams }`, then every event of every stream, then `{ kind: 'blob', sha, b64 }`
  records. With a passphrase (or the sync key when sync is set up) the whole file is sealed with the §15 format.
  Automatic weekly backup when `localpilot.continuity.backup.enabled` (default on), keep `backup.keep` (default 4).
  `restore(file)` imports events through `importRemote` semantics (dedup by event id, gapless per stream; a stream already
  ahead locally is skipped) — restore merges, it never deletes newer data.
- **Migration backup**: removed only by "Remove migration backup" (Settings, CLI `localpilot data migrate --remove-backup`).

---

## 11. Migration (DATA, run once per data root, re-runnable)

Runs in the background after `Continuity.open`, under a lease `migration/lease.json`; the UI shows "Importing your
history… n/m" in the navigator and everything keeps working from the SessionStore meanwhile.

Sources, in order:
1. VS Code workspace chats: `<storageUri>/sessions/*.json` (+ `.archive.jsonl` messages emitted as messages of the main
   branch before the compaction summary; `meta.archived` kept). The current workspace first; then every other workspace
   of this VS Code profile, found by walking `path.join(globalStorageUri.fsPath, '..', '..', 'workspaceStorage', '*',
   <extension id>, 'sessions')` and reading the sibling `workspace.json` (`folder` / `workspace` URI) to resolve the project.
   A workspace whose folder no longer exists is still imported (project matched by path hash only, listed under Projects
   with its last path).
2. CLI chats: `~/.localpilot/workspaces/*/sessions/*.json` (all of them; the project is resolved from the chat's `folder`
   or the workspace hash mapping in `workspaces/<hash>/workspace.json` when present).
3. Traces `traces/<sid>.json` -> agent sessions + execution events.
4. Checkpoint metadata in `session.checkpoints.history` -> checkpoints.
5. Recovery states -> `agent_session.recovery` for unfinished ones.
6. Memory: project memory of each opened workspace, global memory -> developer memory.
7. User custom commands `~/.localpilot/commands` -> prompt templates.

Rules: originals copied first to `migration/legacy-backup/<date>/<source>/...` (copy, not move; the SessionStore keeps
using its files). `state.json` records per source file `{ path, size, mtime, sha256, done, events }`; a file whose
`sha256` matches a done record is skipped; a partially migrated file is simply re-emitted (ids are deterministic, `create`
is idempotent). Events go to the process's own stream with `p.origin = 'migration'`. A corrupt file is recorded as
`failed` with the error and skipped (shown in Settings with "Retry"). Migration never writes to the source files.
Version gate: `meta.migrationVersion` in the index; a later release can add sources by bumping it.

---

## 12. Performance budgets

| Budget | Target | How |
|---|---|---|
| Added activation time (extension host main thread) | ≤ 50 ms | `Continuity.open` reads `device.json`, claims a lease, opens the active segment tail; worker and index load are async |
| History list available | immediately (SessionStore, as today); index-backed within 1 s of activation for ≤ 50 MB index | |
| Index load from `index.sqlite` | ≤ 300 ms for 50 MB (worker) | |
| Catch-up | ≥ 20,000 events/s in the worker | batch transactions of 5,000 |
| Full rebuild | 1,000,000 events ≤ 60 s, UI responsive throughout | worker, progress in the navigator |
| Search (FTS) | p95 ≤ 50 ms at 100,000 messages for the first 50 hits | external-content FTS, truncation (§6.2), `LIMIT` + snippet only for the page |
| History page / counts | ≤ 20 ms | `conv_list` index |
| Append | ≤ 0.2 ms main thread per event; disk write batched every 250 ms | |
| Index size | ≤ 35% of log size; hard cap `localpilot.continuity.indexMaxMB` (default 256) | past the cap, `message_text` of archived and trashed conversations older than 180 days is dropped (title/summary stay searchable); the navigator says "Older archived chats are searchable by title only" |
| Worker memory | ≤ index size + 40 MB | sql.js in-memory DB |
| Log growth | ~1.2x the JSON size of the same history; compaction keeps ≤ 2x the materialised size beyond `historyDays` | |
| Sync cycle with nothing new | ≤ 1 request per device + 1 list (S3/WebDAV); ≤ 2 s | heads in `devices/<id>.json.enc` |

Big histories stay fast because the main thread never parses the whole history (SessionStore keeps its LRU), bodies stay
in the log (index holds metadata + truncated searchable text), and every list is a paged indexed query.

---

## 13. Failure scenarios (exact behaviour)

| Scenario | Behaviour |
|---|---|
| VS Code crashes during an agent task | Log has every event up to ≤ 250 ms before the crash (finalised messages and run start are durable). On restart the stream lease is stale -> taken over; `crashRecovery.ts` finds `agent_session.outcome = 'running'` whose writer stream has no live lease -> patches `interrupted`. The chat shows the existing "Run interrupted" card with Resume / Restore checkpoint / Dismiss, plus "What ran" (execution events) and "Changed files" (from `filesTouched` + ChangeTracker) with Keep / Review diff / Restore checkpoint. |
| Laptop off during generation | Streaming text is written every 2 s to `drafts/<conversationId>.json` (local only, tmp + rename). On restart a draft newer than the last message becomes an assistant message with `partial: true`, shown as "Interrupted — partial answer" with Continue (asks the model to continue from the partial text) and Regenerate. |
| Network loss during sync | Chunk uploads are all-or-nothing (§14.5); cursors advance only after success; the cycle stops, status "Offline — n changes waiting", retry with backoff 5 s, 15 s, 1 min, 5 min, 15 min; `netHint` online event triggers an immediate retry. Nothing local is blocked. |
| Provider down | Existing resilience/fallback runs; the switch is recorded as a `model_session` with `reason: 'provider-down'`; the conversation and its context snapshot are intact so "Switch model and retry" continues from the same point. |
| Context window exceeded | Existing compaction; a context snapshot before and after; the full transcript stays in the log and archive; the Context inspector shows what was folded. |
| Switching local -> cloud LLM | New `model_session`; one-time notice listing what will be sent and what `localOnly` policy excludes; smaller window -> compaction first. |
| Same conversation open on two devices | Each device appends to its own stream; on sync, concurrent appends after the same message split into a device branch (`branch-split` conflict, "Keep both" default). The open chat shows a banner "Continued on <device> too · View" and the branch switcher. No message is lost or rewritten. |
| Project folder moved | Path no longer matches; git fingerprint (remote + root commit) matches -> project re-pointed, chats appear as before. Not a git repo -> the navigator shows "Chats from <old path>" under Projects with "This is the same project" (re-points) / "Ignore". |
| Accidental delete | Trash + Undo toast; Trash keeps it `trashRetentionDays`; even after purge a backup (weekly) can restore it. |
| Storage provider down / credentials expired / bucket gone | Status "Sync paused: <reason>" with "Fix…" opening the Settings section; local work unaffected; queue = unsynced seq ranges. Remote objects that fail authentication (tamper or corruption) are skipped and reported as a `remote-damaged` conflict; for own streams, "Re-upload from this device" rewrites them. |
| Partially completed code changes | Covered by the crash row: files changed by the interrupted run listed with Keep / Review / Restore checkpoint; the checkpoint taken before the run is linked by id. |
| Restoring an earlier conversation version | Versions view -> "Restore": creates a branch at that message (or patches old field values); the current branch remains in the switcher. |
| Wrong or forgotten passphrase | Wrong: "This passphrase does not unlock <remote>" (GCM check fails), nothing written. Forgotten: remote data cannot be read; local data is intact; "Start over with a new passphrase" re-initialises the remote from this device (other devices must re-join). |
| Disk full / unwritable data dir | `Continuity` degraded with the reason; SessionStore JSON keeps working as in 1.6; banner in the navigator. |
| Index corrupt | Detected at load (`PRAGMA integrity_check` quick on open failing, or exception) -> rebuild from logs automatically. |
| Clock wrong on a device | HLC prevents reordering; skew > 10 min is reported (`clock-skew`). |

---

## 14. Sync protocol (SYNC)

### 14.1 Remote layout (same for every backend; keys are `/`-separated)

```
<base>/localpilot-sync/
  format.json                        plaintext { format:'localpilot-sync', v:1, createdAt }
  keyring.json                       plaintext JSON, contains only wrapped keys + KDF params (§15)
  devices/<deviceId>.json.lpe        encrypted DeviceFields + heads { [streamId]: lastUploadedSeq } + compaction bases
  streams/<streamId>/<from12>-<to12>.lpe          encrypted chunk: gzip(JSONL events from..to)
  streams/<streamId>/base-<to12>.lpe              encrypted compacted base (replaces chunks <= to)
  blobs/<hmac>.lpe                   encrypted blob; hmac = HMAC-SHA256(blobKey, sha256(plaintext)) so storage cannot test for known content
```

Every path has exactly one writer (the device owning the stream or the device file), so there are no remote write
conflicts and no remote locks. `format.json` and `keyring.json` are written once (`ifAbsent`); key rotation writes
`keyring.json` with a compare (ETag/If-Match on S3/WebDAV, git push rejection, folder: rename + re-read verify) and
retries.

### 14.2 Cycle

```
1. push:  for each own stream: events in (heads[stream], lastSeq] excluding local:true, cut into chunks of <= 2 MiB
          plaintext / 5,000 events; chunk boundaries persisted in sync/state.json before upload so a retry uploads the
          identical object; put chunk; then blobs referenced by those events (category- and size-filtered);
          finally put devices/<me>.json.lpe with new heads and lastSeen.
2. pull:  get devices/*.json.lpe (S3/WebDAV: one list + n gets; folder: readdir; git: after fetch, local read);
          for each remote stream with head > local cursor: list streams/<id>/ after the cursor key, get chunks in order,
          open, verify gapless seq, log.importRemote(); blobs fetched lazily when an attachment is opened (or eagerly
          when "Download attachments" is on).
3. apply: index catches up (it tails streams); reducer emits conflicts -> conflict entities (they sync too, so a
          resolution on one device clears it everywhere); managers' onRemoteChange fire.
4. housekeeping (daily): replace own old chunks by a base (after local compaction), delete superseded own chunks;
          never delete other devices' objects.
```

Triggers: startup (+10 s), every `localpilot.sync.intervalMinutes` (default 5), 15 s after the last local durable event
(debounced), window focus, "Sync now". One cycle at a time per data root (lease `sync/lease.json`, so a CLI and a VS Code
window do not both sync; the other process just reads the updated streams).

Offline queue = the unsynced seq ranges per own stream + pending blobs; it survives restarts because it is derived from
the log and `sync/state.json`. Categories (Sync manager, `localpilot.sync.categories`): conversations (incl. branches,
summaries, model sessions, context snapshots), memory, attachments (`localpilot.sync.maxAttachmentMB`, default 20),
agentState (agent sessions, execution events, checkpoint metadata), checkpointContents (default off; git bundle of the
checkpoint commit, ≤ 50 MB), prompts (templates, custom commands, untracked instruction files), preferences (allow-listed:
favorite models, default model per mode, thinking level, approval level; never API keys or endpoints with credentials).
Events of a disabled category are not uploaded (they stay in the queue only if the category is re-enabled: the cursor
skips but `state.json` remembers skipped ranges per category so enabling later uploads them).

### 14.3 Device registry
`devices/<id>.json.lpe`: name (editable, default `os.hostname()`), platform, app versions, `lastSeen`, streams, heads,
`revokedAt`. "Remove device" sets `revokedAt` (its data stays; we stop listing it as active) and offers "Rotate key" so it
cannot read future data. Storage credentials are not managed by LocalPilot; the docs tell users to revoke them at the
provider too.

### 14.4 Conflicts
Detected by the reducer (§9.4). Stored as `conflict` entities, listed in Sync manager -> Conflicts with a badge on the
navigator item. Resolution UI per kind:
- `field`: two values side by side, "Keep this" on each; default applied value pre-selected.
- `text-merge` (memory, prompts, instructions): opens VS Code's diff editor (`vscode.diff` on two virtual documents
  `localpilot-version:` scheme) with "Keep mine / Keep theirs / Keep both (append) / Edit merged…"; CLI prints a unified diff
  and takes `--keep mine|theirs|both`.
- `branch-split`: in the chat banner and in the list: "Keep both" (default, dismiss), "Use <device>'s branch", "Merge"
  (conversation merge: new branch whose context gets a summary of the other branch).
- `trash-vs-edit`: "Keep restored" / "Move to Trash again".
- `remote-damaged`, `clock-skew`: informational with the actions in §13.

### 14.5 Backend interface

```ts
export interface RemoteEntry { key: string; size: number; etag?: string; modified?: number }
export interface SyncBackend {
  readonly kind: 'folder' | 'git' | 's3' | 'webdav';
  readonly label: string;                                   // shown in the UI, no credentials
  check(): Promise<{ ok: true } | { ok: false; reason: 'auth' | 'not-found' | 'offline' | 'forbidden' | 'other'; message: string }>;
  list(prefix: string, after?: string): Promise<RemoteEntry[]>;     // lexical order, complete (handles pagination)
  get(key: string): Promise<Uint8Array | undefined>;                // undefined = absent
  put(key: string, body: Uint8Array, o?: { ifAbsent?: boolean; ifMatch?: string }): Promise<{ etag?: string }>;  // atomic
  delete(key: string): Promise<void>;
  begin?(): Promise<void>;                                          // git: pull
  commit?(message: string): Promise<void>;                          // git: commit + push (retry on non-fast-forward)
  dispose(): void;
}
export function createBackend(cfg: SyncBackendConfig, secrets: SecretBox, opts: { fetch?: typeof fetch; gitPath?: string; workDir: string }): SyncBackend;
```

- **Folder** (`folder.ts`): any directory (iCloud Drive, Dropbox, OneDrive, Google Drive for desktop, SMB/NFS share).
  `put` writes `<key>.tmp-<device>-<rand>` then `rename` (ifAbsent: `link` + unlink, falling back to `open(wx)`); `list`
  ignores tmp files, provider conflict copies (`* (conflicted copy*`, `*-conflict-*`, `* (1).*`), and iCloud placeholders
  (`.<name>.icloud` -> reported as "not downloaded yet", retried next cycle). Paths built with `path.join`; keys never contain
  `\`.
- **Git** (`git.ts`): a dedicated repository (refuses the current project's own repository and any repo with a working tree
  outside `sync/git/<remoteId>`); branch `localpilot-sync`; uses the system `git` with the user's credential helper;
  `begin` = `fetch` + `reset --hard origin/<branch>` (safe: every path is single-writer and our own files are re-written
  from the log), `commit` = add, commit (`LocalPilot sync from <device name>`, author `LocalPilot <localpilot@localhost>`),
  push; on non-fast-forward: fetch, rebase (no file conflicts possible), push, max 3 tries. Large blobs: git is not ideal;
  attachments over 5 MB are skipped on the git backend with a notice.
- **S3-compatible** (`s3.ts`, `sigv4.ts`): AWS S3, Cloudflare R2, MinIO, Backblaze B2, Wasabi. Config: endpoint, region,
  bucket, prefix, path-style (default on for custom endpoints), access key id in settings, secret key in SecretStorage.
  SigV4 implemented with `crypto.createHmac`/`createHash` and `fetch`: canonical request, `x-amz-content-sha256` with the
  payload hash, `x-amz-date`; ListObjectsV2 (`list-type=2`, `prefix`, `start-after`, continuation tokens, XML parsed with
  a minimal tag reader), GET, PUT (`If-None-Match: *` for ifAbsent; on 501/400 "not implemented" fall back to HEAD then PUT),
  DELETE. Requires HTTPS except `localhost`/`127.0.0.1`.
- **WebDAV** (`webdav.ts`): Nextcloud, ownCloud, Synology, Apache mod_dav. `PROPFIND Depth: 1` (list; directories walked for
  `streams/<id>/`), `GET`, `PUT` to `<key>.tmp-<rand>` then `MOVE` with `Overwrite: F` for ifAbsent / `T` otherwise, `DELETE`,
  `MKCOL` for missing folders. Basic auth (password in SecretStorage) or bearer token; HTTPS required except localhost.

Errors map to `check()` reasons; 401/403 -> "Sync paused: sign-in failed" with "Update credentials…".

### 14.6 Version history across devices
Remote keeps every chunk until its owner compacts (same `historyDays`), so a new device gets the same version window.
Purge events propagate; owners redact purged payloads from their compacted bases.

---

## 15. Encryption

- **KEK** = scrypt(passphrase NFKC-normalised, salt 16 random bytes, N = 2^17, r = 8, p = 1, dkLen = 32,
  maxmem = 256 MiB). Takes ~0.3–0.6 s; run off the main thread (`crypto.scrypt` is async/libuv).
- **DEK**: random 32 bytes per key id (`keyId` = 16 random bytes hex). Derived sub-keys with HKDF-SHA256 from the DEK:
  `enc` (AES-256-GCM objects) and `blob` (HMAC for blob names).
- **keyring.json**: `{ v:1, kdf: { alg:'scrypt', N, r, p, salt }, current: keyId, keys: [{ keyId, iv, ct, tag, createdAt }] }`;
  each DEK wrapped with AES-256-GCM(KEK) with AAD `localpilot-keyring/v1/<keyId>`. A wrong passphrase fails the GCM tag.
- **Object format** (`.lpe`): `magic 'LPE1' (4) | keyId (16) | iv (12) | ciphertext | tag (16)`, AAD = `LPE1/<object key>`
  (binds ciphertext to its path: a chunk cannot be swapped or replayed under another name). Plaintext = gzip(payload).
  IV random 96-bit per object (objects are immutable and keys never encrypt more than 2^32 objects).
- **Key storage**: DEK (not the passphrase) in SecretStorage `localpilot.sync.<remoteId>.key.<keyId>`; CLI: `~/.localpilot/keys.json`
  (0600, existing mechanism) entry `sync:<remoteId>:<keyId>`, or `LOCALPILOT_SYNC_PASSPHRASE` for headless use.
- **Passphrase change**: unlock with the old one, new salt, re-wrap all DEKs, write keyring (compare-and-swap); objects unchanged.
  Other devices keep working (they hold the DEK).
- **Key rotation** ("Remove device and rotate key" or "Rotate key"): new DEK + keyId, new objects use it; old keys stay
  wrapped so history stays readable; optional "Re-encrypt history" rewrites own objects (each device rewrites its own).
- **New device join**: choose the same backend -> `format.json` found -> passphrase -> unwrap -> store DEKs -> register device
  -> pull. Optional local backup of the user's own data first.
- **Visible to storage**: object names (random device/stream ids, seq numbers), sizes, counts, upload times, number of
  devices, KDF parameters. **Not visible**: titles, messages, code, project names and paths, device names, memory, tags,
  timestamps inside events, which blobs are equal to known files.
- Local data at rest is not encrypted by LocalPilot (same as 1.6; rely on OS disk encryption); backups can be.
- Secure share (`share.ts`): a conversation (or a branch) exported to `.lpshare` sealed with a random key; the share code
  (base32 key, 52 chars, shown once) travels separately. Before sealing, `scanText(..., { secrets: true })` from
  `src/security/scan.ts` flags secrets and the user chooses Redact / Keep. Import of `.lpshare` asks for the code and creates
  a conversation with `origin: 'share'`.

---

## 16. UI

Rules from `.claude/skills/vscode-extension-ui/SKILL.md` apply: theme tokens only, 300/360/480 px container queries, CSP
with nonce, keyboard and screen reader support, screenshots at 300 and 480 (chat) / 480 and 1100 (Settings) in light, dark,
hc. The preview harnesses (`scripts/ui-preview.html`, `scripts/settings-preview.html`) get the same markup.

### 16.1 Navigator (replaces the history popover's content)
Opened by the history button (and `localpilot.continuity.openNavigator`). Layout top to bottom:
1. **New conversation** (primary button) and the search field ("Search conversations, code, errors…", inline filters §6.1).
2. **Views** with counts: All · Pinned · Favorites · Archived · Trash, then **Projects** (collapsible, each project with its
   count; the current project first, "This project" filter on by default; "All projects" toggle for cross-project search).
3. **Recent conversations**: rows with title, relative date, project name (when not the current project), badges (pinned,
   favorite, CLI, forked/branches count, running, synced-from device). Row actions (existing menu extended): Open, Rename,
   Pin, Favorite, Tags…, Archive, Duplicate, Export ▸ (JSON, Markdown, HTML, PDF), Share securely…, Merge with…, Versions,
   Move to Trash. Multi-select keeps today's behaviour with Archive / Tag / Export / Trash.
4. **Knowledge & continuity**: Memory manager, Context library, Checkpoints, Sync manager (status dot: synced / syncing /
   offline / paused / conflicts n), Settings (opens the Settings panel at the Continuity section).

Narrow widths: < 360 px the Views row becomes one "Show: All (128) ▾" menu button and Projects collapse into it;
Knowledge & continuity is a collapsed disclosure at the bottom. 360–479: Views as a wrapping chip row. ≥ 480: as listed;
in an editor tab ≥ 800 px a two-pane layout (views left 220 px, list right). Search results show the matched snippet with
the match highlighted and the part it came from (message, code, error, memory).

### 16.2 Manager pages (in the chat webview, `media/continuity.js`, Back returns to the navigator)
- **Memory manager**: type tabs (Conversation, Project, Developer, Task, Knowledge, Agent) as a select under 360 px; list
  with name, summary, scope, updated, flags (local only, pinned, expires); actions Open (editor for file-backed notes,
  inline editor otherwise), Edit, Move to type…, Local only, Pin, Versions, Move to Trash; New note; search.
- **Context library**: list of sets, New set (from current chat's attachments, or empty), edit items, "Attach to chat";
  plus "Context of this chat": latest snapshot (breakdown bars reuse the context ring card), items, excluded.
- **Checkpoints**: per project, newest first: time, chat title, run, files changed count, device, kind; actions View
  changes, Restore (task / workspace / both — existing `restoreCheckpoint`), Open chat. Checkpoints from another device show
  "Content on <device>" unless checkpoint contents sync is on.
- **Sync manager**: status line, last sync, queue (n changes, m attachments waiting), Sync now, Pause/Resume, Conflicts list
  (§14.4), Devices (this device editable name; others with last seen, Remove), Activity (last `sync_events`), "Set up sync…"
  / "Sync settings…" opening Settings.
- **Trash** and **Versions** pages as described in §10.
- Chat surface additions: branch switcher `< 2/3 >` on edited/regenerated messages; "Regenerate with…" (model menu) and
  "Compare" on assistant messages; "Continue from here" / "Branch from here" / "Duplicate from here" / "Save to knowledge" /
  "What did the model see?" in the message menu; banners "Updated on <device>", "Continued on <device> too",
  "Interrupted — partial answer"; Related conversations chip on new chats.

### 16.3 Settings section "Continuity & sync" (group Data & system)
Storage (data folder, size of logs/index/blobs/backups, Rebuild index, Open folder), Migration (status, failed items with
Retry, Remove migration backup + size), Trash & history (retention days, history days, Empty Trash), Backups (auto on/off,
keep, Back up now, Restore from file…), Sync (backend picker with forms per backend, Test connection, passphrase set/enter,
Change passphrase, Rotate key, categories, interval, attachment cap, device name, Turn off sync), Context (related
conversations, tool output capture). Under 480 px forms stack; at 1100 px two columns.

### 16.4 Webview messages (additions to the unions in `chatController.ts`; handled in `src/ui/continuityHost.ts`)

```ts
// FromWebview
| { type: 'nav'; seq: number; view: NavView; projectId?: string | 'all'; query?: string; offset?: number; limit?: number; sort?: HistorySort }
| { type: 'convAction'; ids: string[]; action: 'favorite' | 'unfavorite' | 'archive' | 'unarchive' | 'trash' | 'restore' | 'purge' | 'duplicate' | 'merge'; uptoMessageId?: string }
| { type: 'setTags'; ids: string[]; add?: string[]; remove?: string[] }
| { type: 'exportConversations'; ids: string[]; format: 'json' | 'markdown' | 'html' | 'pdf' }
| { type: 'importConversations' } | { type: 'shareConversation'; id: string; branchId?: string }
| { type: 'branch'; sessionId: string; action: 'switch' | 'continueFrom' | 'rename'; branchId?: string; messageId?: string; label?: string }
| { type: 'regenerateWith'; sessionId: string; messageId: string; model?: string } | { type: 'compareVersions'; sessionId: string; messageId: string }
| { type: 'versions'; ent: 'conversation' | 'memory'; id: string } | { type: 'restoreVersion'; ent: 'conversation' | 'memory'; id: string; hlc: string }
| { type: 'continuityPage'; page: 'memory' | 'context' | 'checkpoints' | 'sync' | 'trash'; params?: Record<string, unknown> }
| { type: 'memoryAction'; action: 'create' | 'update' | 'move' | 'trash' | 'restore' | 'open' | 'localOnly' | 'pin'; id?: string; fields?: Partial<MemoryItemFields> }
| { type: 'contextAction'; action: 'create' | 'update' | 'trash' | 'attach' | 'inspect' | 'addRelated'; id?: string; sessionId?: string; fields?: Partial<ContextLibraryFields> }
| { type: 'syncAction'; action: 'now' | 'pause' | 'resume' | 'setup' | 'renameDevice' | 'removeDevice' | 'rotateKey'; deviceId?: string; name?: string }
| { type: 'resolveConflict'; id: string; resolution: 'ours' | 'theirs' | 'both' | 'merged' | 'keep-applied' }
| { type: 'resumeDraft'; sessionId: string; action: 'continue' | 'regenerate' | 'discard' }
// ToWebview
| { type: 'navPage'; seq: number; page: NavPage; counts: NavCounts; projects: NavProject[]; indexState: string }
| { type: 'continuityPage'; page: string; data: unknown }
| { type: 'syncStatus'; state: 'off' | 'idle' | 'syncing' | 'offline' | 'paused' | 'error'; pending: number; conflicts: number; lastSync?: number; reason?: string }
| { type: 'branches'; sessionId: string; branches: BranchRow[]; active: string; siblings: Record<string /*messageId*/, { index: number; total: number; ids: string[] }> }
| { type: 'remoteUpdate'; sessionId: string; device: string; kind: 'updated' | 'continued' }
| { type: 'related'; sessionId: string; items: { id: string; title: string; snippet: string }[] }
| { type: 'versionsList'; ent: string; id: string; versions: VersionRow[] }
```

Every message has host behaviour; existing `listSessions/sessionPage` keep working (the navigator falls back to them while
the index is not ready).

---

## 17. Commands, settings, CLI

### 17.1 Commands (package.json `contributes.commands`, palette category "LocalPilot")
`localpilot.continuity.openNavigator`, `.openMemoryManager`, `.openContextLibrary`, `.openCheckpoints`, `.openTrash`,
`.rebuildIndex`, `.backupNow`, `.restoreBackup`, `.exportConversations`, `.importConversations`,
`localpilot.sync.setup`, `localpilot.sync.now`, `localpilot.sync.openManager`, `localpilot.sync.showConflicts`,
`localpilot.sync.changePassphrase`, `localpilot.sync.rotateKey`, `localpilot.sync.turnOff`.

### 17.2 Settings (package.json, `src/config.ts` `continuity`/`sync` blocks, `vscodeShim.ts` defaults, Settings `SETTING_KEYS`/`FIELD_INDEX`, docs/docs/configuration.md)

| Key | Type / default |
|---|---|
| `localpilot.continuity.dataDir` | string, `""` (= `~/.localpilot/continuity`) |
| `localpilot.continuity.trashRetentionDays` | number, 30, min 0 |
| `localpilot.continuity.historyDays` | number, 90, min 7 |
| `localpilot.continuity.indexMaxMB` | number, 256, min 32 |
| `localpilot.continuity.captureToolOutput` | enum `errors` / `summary` / `full`, `summary` |
| `localpilot.continuity.relatedConversations` | boolean, true |
| `localpilot.continuity.backup.enabled` | boolean, true |
| `localpilot.continuity.backup.intervalDays` | number, 7, min 1 |
| `localpilot.continuity.backup.keep` | number, 4, min 1 |
| `localpilot.memory.taskExpiryDays` | number, 14, min 1 |
| `localpilot.sync.enabled` | boolean, false |
| `localpilot.sync.backend` | enum `folder` / `git` / `s3` / `webdav`, `folder` |
| `localpilot.sync.folder.path` | string |
| `localpilot.sync.git.url`, `localpilot.sync.git.branch` | string, `localpilot-sync` |
| `localpilot.sync.s3.endpoint`, `.region`, `.bucket`, `.prefix`, `.accessKeyId`, `.pathStyle` | strings / boolean (secret key in SecretStorage) |
| `localpilot.sync.webdav.url`, `.username` | string (password in SecretStorage) |
| `localpilot.sync.intervalMinutes` | number, 5, min 1 |
| `localpilot.sync.categories` | object `{ conversations, memory, attachments, agentState, checkpointContents, prompts, preferences }`, all true except `checkpointContents` |
| `localpilot.sync.maxAttachmentMB` | number, 20 |
| `localpilot.sync.deviceName` | string, `""` (= host name) |

Changed: `localpilot.sessions.retention` description ("moves the oldest idle chats to Archived").

### 17.3 CLI (`src/cli/continuityCmd.ts`, wired in `main.ts` next to `history`/`recovery`)

```
localpilot history [list] [--all-projects] [--view all|pinned|favorites|archived|trash] [--tag t] [--json]
localpilot history search <query> [--in code,errors,...] [--all-projects] [--json]
localpilot history show <id> [--branch b] | export <id...> --format json|md|html|pdf [-o file] | import <file|claude|codex>
localpilot history pin|favorite|archive|trash|restore|purge <id...> | tag <id> +a -b | rename <id> <title>
localpilot history versions <id> | branches <id> | duplicate <id> [--from <messageId>] | merge <id> <id>
localpilot history share <id> [-o file] | open-share <file>         (code read from stdin / prompt)
localpilot memory list [--type t] | show <id|name> | add --type t <name> [text|-] | edit <id> | rm <id> | search <q>
localpilot sync setup --backend folder|git|s3|webdav [backend flags]  (passphrase from prompt or LOCALPILOT_SYNC_PASSPHRASE)
localpilot sync status|now|pause|resume|devices|conflicts [--json] | resolve <conflictId> --keep mine|theirs|both
localpilot sync passphrase | rotate-key | remove-device <id> | off
localpilot data stats | backup [-o file] [--encrypt] | restore <file> | rebuild-index | migrate [--status|--retry|--remove-backup] | gc
```
Slash commands in the interactive CLI: `/history` (exists) gains `search`, `/memory`, `/sync`, `/trash`, `/branch`.
`pdf` export in the CLI writes the print-ready HTML and says how to save it as PDF.

---

## 18. Build and packaging

- `npm i sql.js` (exact version pinned in package.json `dependencies`, like `mammoth`). Bundle its JS (`sql.js/dist/sql-wasm.js`)
  into the worker; copy `node_modules/sql.js/dist/sql-wasm.wasm` to `dist/sqljs/sql-wasm.wasm` in `scripts/assets.js`
  `copyAssets`, add `'sqljs/sql-wasm.wasm'` to `EXPECTED`, add its licence to `THIRD_PARTY_NOTICES.txt`.
- `esbuild.js`: third entry `src/continuity/data/index/indexWorker.ts` -> `dist/continuityWorker.js` (cjs, node18).
- Runtime paths: extension `path.join(ctx.extensionPath, 'dist', ...)`; CLI `path.join(__dirname, ...)` (dist/cli.js sits in
  dist/); tests and smoke: env `LOCALPILOT_SQLJS_WASM` / resolve from node_modules.
- `.vscodeignore` already ships `dist/**` and excludes `node_modules/**`: verify with `npx vsce ls | grep sql-wasm` that the
  VSIX contains `dist/sqljs/sql-wasm.wasm` and `dist/continuityWorker.js`.

---

## 19. Test plan

No real network: fake S3 and WebDAV servers on `127.0.0.1:0`, a local bare git repo (`git init --bare` in a temp dir), temp
folders. Paths via `path.join`; no POSIX literals in expectations; no SIGTERM reliance; no deadlines computed at file load.

Pure / smoke (`scripts/smoke.ts` sections, run by `npm run smoke`) and Mocha unit suites (`src/test/continuity*.test.ts`):
- ids: format, monotonic ULID, deterministic `stableId`, migration message ids stable across runs.
- HLC: tick monotonic under a clock going backwards, observe, skew clamp, ordering.
- Envelope: validation, unknown entity/sv kept and skipped, payload upgrade.
- Segment: append/read round trip; truncated last line repaired; rotation at size; lease takeover of a dead pid; two
  writers get different streams.
- Reducer: LWW per field; map fields; trash/restore; purge terminal; idempotent re-apply; **property test**: random events
  from 3 streams, 200 random interleavings respecting per-stream order -> identical states.
- Merge rules: each row of §9.4 including branch-split and trash-vs-edit and 3-way text merge clean/overlap.
- Index: schema creation, FTS probe and fallback, incremental == rebuild (same rows after random events), search filters
  and inline syntax, counts, size cap behaviour, worker RPC round trip, load from persisted file, corrupt file -> rebuild.
- Crypto: known-answer test for scrypt + AES-GCM with a fixed salt/iv, wrong passphrase, tampered byte, AAD path swap,
  passphrase change keeps DEK, key rotation keeps old objects readable.
- Migration: fixture sessions (VS Code + CLI + archive + traces + checkpoints + memory + commands) -> expected entities;
  interrupted after k files (injected throw) then resumed -> no duplicates; re-run -> no new events; originals untouched,
  backup copies present; corrupt file recorded as failed.
- Retention/backup: trash then purge after N days (injected clock), blob GC, backup -> restore into an empty root yields
  the same index rows, restore into a newer root does not lose newer data.
- Sync protocol with an in-memory backend and two data roots (A, B): create on A -> appears on B; concurrent title edits ->
  conflict record on both; concurrent appends -> branch split; trash vs edit; offline (backend throws) -> queue -> recovers
  with identical result; retried chunk upload uploads the identical object; categories filter; device revoke + key rotation.
- Backends: folder (temp dir, conflict-copy files ignored, `.icloud` placeholder), git (local bare repo, two clones,
  non-fast-forward retry), S3 (fake server verifies SigV4 with the same secret; AWS documentation test vector for the
  signer; pagination with continuation tokens; If-None-Match fallback), WebDAV (fake server: PROPFIND, MOVE Overwrite, MKCOL,
  401 mapping).
- VS Code suites (snapshot runner): activation with continuity on a fixture workspace (migration runs, history lists the
  same chats), navigator messages (`nav`, `convAction` trash/restore/purge, favorites/archive counts), branch switcher after
  `editAndRegenerate`, Memory manager CRUD reaches `MemoryStore` files, Sync manager with the folder backend in a temp dir
  between two Continuity instances, Settings section keys present in `SETTING_KEYS`, every new command registered.
- CLI e2e (`scripts/cli-e2e.mjs`): `history search`, `memory add/list`, `sync setup --backend folder` with
  `LOCALPILOT_SYNC_PASSPHRASE` for two `LOCALPILOT_DATA_DIR`s and `sync now` moving a chat between them, `data backup/restore`.
- Packaging check: `scripts/check-assets.js` requires `sqljs/sql-wasm.wasm`; the CLI finds the wasm from `dist/`.


---

## 20. As built: DATA module (1.7.0)

What the DATA builder changed or added relative to §1–§19. Later modules build on these APIs.

### 20.1 Files

`src/continuity/{ids,hlc,events,continuity}.ts`; `src/continuity/data/{lease,segment,eventLog,reducer,textMerge,blobs,
compaction,retention,backup,migration,dataManager}.ts`; `data/index/{schema,db,apply,queries,engine,rpc,indexWorker,
indexClient,sqljs.d.ts}.ts`; `data/crypto/{keyring,envelope,secretBox}.ts`; `src/continuity/conversation/payloads.ts`
(builders shared with the SessionBridge); VS Code side `src/ui/continuityData.ts`; CLI `src/cli/continuityCmd.ts`. No
file under `src/continuity/` imports `vscode` (continuity.ts included: the VS Code adapters live in `src/ui/`).

### 20.2 Composition root

- `Continuity.open` never throws. When degraded, `degraded` is set and the getters `log`, `index`, `data`, `blobs`,
  `migration`, `retention`, `device` throw `ContinuityDegradedError`: check `degraded` first.
- Feature slots `conversations`, `memory`, `context`, `sessions`, `sync` are `unknown` until their module sets them.
  `attachSessionStore` / `attachMemoryStore` are not implemented yet: CONVERSATION and MEMORY add them (use
  `continuity.track(disposable)` to register what must be disposed with continuity, and `continuity.onPurge(hook)` for
  file cleanup of purged entities).
- Extra options: `migration` (sources, §20.6), `autoMigrate`, `schedules` (retention + backup timers; the CLI's one-shot
  `data` commands pass false), `inProcessIndex`, `flushMs`.
- Data root resolution `continuityDataDir(setting)`: setting, else `LOCALPILOT_CONTINUITY_DIR`, else
  `<cliDataDir()>/continuity`. Extension tests (ExtensionMode.Test) without either use a temp folder and never read the
  developer's CLI chats unless `LOCALPILOT_DATA_DIR` is set.
- VS Code opens continuity after `controller.loaded` without awaiting it; `api.continuity` (extension API) resolves to
  the instance. Measured main-thread cost of `open`: ~1 ms (smoke and VS Code suite assert < 50 ms).
- CLI: chat runs open it in the background (`core.continuity`); `localpilot data …` opens it without schedules.

### 20.3 Event log

- Leases (`data/lease.ts`) carry a random `token`; ownership is by token, so two holders in one process are told apart.
  Stale = older than 120 s or a dead pid on this host (RecoveryStore's `isPidAlive`). A stale lease is renamed aside
  before the exclusive create, so one racer wins.
- `FileEventLog` extras: `locOf(e)` (location known at append time; rotation is decided in `append`), `readWithLoc`,
  `lastSequence`, `flushSync()` (also on process `exit`), `importBase(stream, cut, events)` for compacted bases,
  `ownStreamDir`, `peekHlc`. `importRemote` returns `{ imported, skipped }`, dedups by seq and refuses a stream with a
  live lease on this machine; for the process's own stream it only accepts events it already has.
- Migration events carry `cause: 'migration'` instead of `p.origin = 'migration'` (that would clash with
  `ConversationFields.origin`). One `migration` entity (`mig_<hash>`) per imported source file records where data came
  from.
- Compacted bases (`compact-<cut>.jsonl`): every event has `seq = cut` and `id = <stream>:<cut>.<i>`, sorted by HLC,
  `p.__clocks` / `p.__bases` / `p.__edits` carry the reducer bookkeeping. After a compaction the index is rebuilt
  (bodies moved). Redaction of purged entities rewrites their lines (and those of their conversation's children) in place
  as `{…, p: { redacted: true }}` padded with spaces to the same byte length, so index locations stay valid.

### 20.4 Reducer

- `EntityState` gains `bases` (writer's `base` per conflict-checked field), `texts` (bounded versions of text fields)
  and `edits` (messages appended to a conversation: `{hlc, base}`); a missing `base` means "saw everything before".
- Text fields fold their versions in HLC order: a version whose base is below the current clock is 3-way merged
  (`data/textMerge.ts`, later side wins overlaps), which makes the result independent of arrival order.
- Trash-vs-edit: `noteEdit(convState, convId, msgEvent)` (called by the index for every `message.create`); a trash and an
  edit are concurrent when `edit.base < trashHlc && trashBase < edit.hlc`; the conversation is then not trashed
  (`state.trashed` undefined) and a `trash-vs-edit` conflict is reported.
- Conflict records: `ours` = the older write, `theirs` = the newer, `applied` = `theirs` (LWW), `merged` (text) or `both`
  (branch split); ids are deterministic (`cf_` + hash of entity, field and both HLCs), so every device computes the same.
- Branch split is resolved in the index (`apply.ts`): `messages.declared_branch` keeps the writer's branch,
  `messages.branch_id` the effective one; the loser's subtree moves to `deviceBranchId(branch, loserId)` with a
  `device-split` branch row and a `branch-split` conflict.
- Property tests (smoke): 200 random interleavings of three streams for conversation fields, memory bodies, and the
  trash register against appended messages.

### 20.5 Index

- FTS4 (see §6.1). FTS tables hold their own text (no `message_text` table): `message_fts(prose, code, errors)` with
  `rowid = messages.rowid`, `conversation_fts(title, summary, tags)` with `rowid = conversations.rowid` (conversations
  gained an explicit `rowid INTEGER PRIMARY KEY`), `memory_fts(name, body)`. Snippets mark matches with `\u0002…\u0003`.
- Schema additions: `entity_clocks.state` (reduced state JSON, message parts stripped), `entity_events.ent/at`,
  `conversations.parent_title/text_dropped`, `messages.declared_branch/hlc`, `message_parts.blob`,
  `agent_sessions.trace_id/title`, `execution_events.output`.
- `IndexClient` additions: `onProgress`, `onApplied` (after each catch-up: counts plus ids of conversations and memory
  items changed by other processes or devices, the hook for `onRemoteChange`), `branches`, `searchMemory`, `catchUp`,
  `persist`, `pruneVersions`, `syncEvent`. Named queries: `referencedBlobs, trashedBefore, streamCursors,
  conversationIds, runningAgentSessions, agentSessions, executionEvents, checkpoints, conflicts, branches, siblings,
  projectByPathHash, projectByGit, latestContextSnapshot, syncEvents, sizes`.
- `IndexHistoryQuery` = `{ view, projectId, query (title substring), tag, mode, folder, origin, sort, offset, limit }`;
  `search()` accepts a `SearchQuery` or a string with inline filters (`parseInlineFilters`).
- `LocalIndexClient` runs the same engine in-process (tests; fallback when `dist/continuityWorker.js` is missing). The
  worker is ref'ed only while a call is pending, so it never keeps the CLI alive.
- A loaded `index.sqlite` is discarded and rebuilt when `quick_check` fails, `user_version` differs, or a stream cursor is
  ahead of its stream (log replaced or compacted underneath).

### 20.6 Migration

- Sources are grouped (`vscode:<global storage>`, `cli:<CLI data dir>`, `home:<~/.localpilot>`) and each group is
  imported once per data root (`state.groups`), so VS Code still imports its profile when the CLI ran 1.7 first.
- Message ids: `legacyMessageId(convId, msg, index)` in `payloads.ts`: `meta.id` if present; archived messages
  `stableId('m', convId, 'archived', <archive seq>, role, content)`; others `stableId('m', convId, <index in
  Session.messages>, role, content)`. **The SessionBridge must use the same function for messages without `meta.id`**,
  so a migrated chat saved again keeps its ids.
- Projects: `projectIdFor` = `stableId('prj', 'git', remote, rootCommit)` when both are known (same id on every device),
  else `stableId('prj', 'path', sha256(normalizeWorkspacePath))`. CONVERSATION's `projects.ts` should keep these ids.
- Agent sessions from traces: id = the trace id when it is `as_…`, else `stableId('as', traceId)`; execution events
  `stableId('ex', asId, seq)`; interrupted recovery states become `agent_session`s with `outcome: 'interrupted'` and id
  `stableId('as', 'recovery', sid, turnKey)`.
- Project memory of folders a process cannot see (a CLI cwd opened later) is not migrated: the MemoryBridge must emit
  events for existing note files when it attaches.

### 20.7 Crypto and backups

- `SecretBox` adds `dataKeyName(remoteId, keyId)`; adapters `secretStorageBox`, `cliKeysBox`, `memorySecretBox`,
  helpers `storeDataKeys` / `loadDataKeys`.
- Sealed backup: `LPBK1\n` + KDF params JSON + `\n` + an LPE1 object (object key `localpilot-backup`) whose data key is
  the scrypt output and whose key id is `sha256(salt)[0..32 hex]`. Compacted bases travel as one `{ kind: 'base' }` line
  per stream. The passphrase for the CLI comes from a hidden prompt or `LOCALPILOT_BACKUP_PASSPHRASE`.

### 20.8 Commands and settings

- Commands: `localpilot.continuity.rebuildIndex`, `.backupNow`, `.restoreBackup`, plus `.openDataFolder` (used by
  Settings → Continuity & sync → Open folder).
- Settings: `localpilot.continuity.dataDir` (machine scope), `.trashRetentionDays`, `.historyDays`, `.indexMaxMB`,
  `.backup.enabled/.intervalDays/.keep` in package.json, `config.ts` (`getConfig().continuity`), the CLI shim defaults,
  Settings `SETTING_KEYS`/`FIELD_INDEX`, configuration.md.
- Settings webview messages: `continuityLoad`, `continuityAction { action }` -> `continuity { view, message? }`. The
  Continuity & sync section (`secContinuity` in media/settings.js) is where SYNC adds its Sync subsection.

---

## 21. As built: CONVERSATION module (1.7.0)

What the CONVERSATION builder changed or added relative to §1–§20.

### 21.1 Files

`src/continuity/conversation/{projects,sessionBridge,materialize,conversationManager,export,share,merge}.ts` (with DATA's
`payloads.ts`); `src/sessions/{sessionShape,sessionExport}.ts` (pure helpers split out of `sessionStore.ts` so the bridge
and the exports never import vscode); VS Code side `src/ui/continuityHost.ts` and `src/ui/continuityMessages.ts` (the
webview message types); `media/continuity.js` / `media/continuity.css`; CLI `src/cli/conversationsCmd.ts`. `share.ts`
uses `scanText` from `src/security/scan.ts`, which reaches vscode-dependent modules through `tools/git`: it runs in the
extension and in the CLI (shim), not in a bare Node process.

### 21.2 SessionStore hooks (additive)

- `bridge?: SessionStoreBridge` with `prepare(s)` (sync, every `save` and `archive`: message ids), `saved(s, previous)`
  (in `flush` before the JSON write, and in `dispose` for pending saves) and `removing(id, 'delete' | 'prune')`
  (async: `trash` / `archive` / `delete`). Also `onDidSave`, `onDidTrash`, `lastSavedShape`, `hint` / `takeHint`,
  `importRemote(session)` (writes the cache file; refused while the chat is in use or has a write pending), `purge(id)`
  (the 1.6 delete: file, transcript archive, `onDidDelete` → checkpoints, traces, recovery state, command logs) and
  `takeUnbridged()` (chats saved before the bridge attached; logged on attach).
- With a bridge, `delete` means **Trash**: the cache file goes, the transcript archive and everything `onDidDelete` cleans
  stay until purge (`onDidTrash` fires instead). `prune` (retention) means **Archive** (`archived: true`) and also drops
  the cache file; the chat reopens from the log. Without a healthy index (`indexFailed`, degraded) the 1.6 delete runs.
- `Session.meta.lastHlc`; `ChatMessage.meta.copiedFrom` and `meta.partial`.

### 21.3 SessionBridge

- **Ids.** A chat without `meta.lastHlc` that this process has not seen keeps the deterministic ids of migration
  (`legacyMessageId`); ids copied from another chat (fork, duplicate, merge, import) are replaced with `copiedFrom` set;
  later new messages get `newId('m')`. `legacyMessageId` for an archived message is now
  `stableId('m', conv, 'archived', seq, role)` **without the content** (the verbatim copy a compaction keeps may be
  pruned and must still be the same message).
- **First sight.** The first save of a chat in a process waits (≤ 5 s) for the index and reads what the log holds
  (`messageIds`, the active branch's path, summaries' `keeps`); saves meanwhile coalesce. Without an index everything is
  (re-)emitted: creates are idempotent, and the conversation `create` carries only the chat's own fields so a migrated
  conversation's favorite / archived / tags survive.
- **View vs path.** The log path of a branch is the full transcript in append order. A compaction appends the summary
  after the head with `keeps` (ids of earlier messages the chat still shows verbatim after it); `viewOfPath` turns a path
  into `Session.messages`: `[last summary, …kept, …newer]`. Migration now writes `keeps` on summary messages too.
  New messages are parented on the view prefix's element with the highest path position.
- **Diff rules.** Append → `message.create` on the active branch. A prefix that changes → a new branch at the divergence
  (`reason` from the store hint, else `edit` for a user message, `regenerate` otherwise; `supersedes` set when the role
  matches); a pure truncation waits for the next new message (a retry that never started puts the same ids back and
  nothing is logged); known messages of another branch on screen → `activeBranchId` patch. A message changed in place →
  `message.patch` (parts + meta); pruned compaction copies only patch their meta. While a run streams, its last
  assistant message is logged once something follows it or the run ends (no O(n²) patches). Usage-only conversation
  patches are throttled to one per 30 s during a run.
- **Fields.** The chat owns `title, projectId, folder, model, mode, specialist, autoMode, think, pinned, parentId,
  parentTitle, group, plan, usage`; the navigator owns `favorite, archived, tags, mergedFrom, parentMessageId, origin`
  (share) — a save never writes the latter.
- **Reconcile.** On attach (after `ready`) chats whose file is newer than their log row are logged (a process that ended
  before continuity opened); `refreshStale` reloads chats whose log is newer than their `lastHlc` (another process or
  device). The CLI waits up to 4 s for the bridge before exiting a run.

### 21.4 Manager, index additions

- Named queries added: `messageIds`, `entityStates` (reduced states for materialisation), `attachments`,
  `conversationVersions` (newest HLC over a conversation, its branches and messages), `children` (siblings per parent;
  roots — edited first prompts — are siblings of each other, `parent_id = ''`), `projects`.
- `materialize` builds the active (or any) branch from `index.messages` + `entityStates` + `readAt` bodies + blob images.
- Branch switching (`switchBranch`, `stepSibling`, `continueFrom`, `restoreVersion` to an earlier `activeBranchId`) patches
  `activeBranchId` and replaces the chat's messages in place when it is in use (the bridge is reset to the target
  branch first, so no new branch is logged), else through `importRemote`.
- `restoreVersion` folds the conversation's version rows up to the chosen HLC and patches back title / pinned /
  favorite / archived / tags; an earlier active branch is switched to. It never creates a branch for field-only versions.
- `merge` = a new chat: copies of A's messages, then a user message with B's summary (model-written through the chat's
  provider when reachable — `quickPrompt` — else B's first request and last answer) and an acknowledgement;
  `mergedFrom: [a, b]`.
- Remote changes: `index.onApplied.remoteConversations` → reload chats of this store that are not in use; in-use ones wait
  for **Reload** (`remoteReload`). The device is shown as "another window or the CLI" for this machine and as a short
  device id otherwise (device names come with SYNC's registry). `continued` is reported when a `device-split` branch
  appeared in the last day.

### 21.5 Webview and commands

- The navigator lives in the existing history popover (`media/chat.js`): `nav` → `navPage`; views, counts, projects
  (`This project` default, `All projects`, each project, `(moved?)` with `repoint`), tag chips, index search with
  snippets. "All · This project" with no query keeps the 1.6 store list (running and unsaved chats); everything else is
  index-backed. Added messages beyond §16.4: `navChanged`, `openNavigator`, `openContinuityPage`, `compare`,
  `remoteReload`, a `branches` request, and `convAction` actions `open`, `rename`, `pin`, `unpin`, `emptyTrash`, `repoint`.
- Pages (`media/continuity.js`, overlay with Back/Esc): Trash, Versions, Compare, and read-only Memory, Context,
  Checkpoints (Open chat) and Sync (Set up → Settings) pages with real index data until their modules land.
- **Regenerate with…** is offered on the latest answer only (it reuses `retry`); **Compare** works on any answer with
  siblings. PDF export writes `<title>.print.html` (print CSS, no script) and opens it in the browser.
- Commands: `localpilot.continuity.openNavigator`, `.openTrash`, `.exportConversations`, `.importConversations`.

---

## 22. As built: MEMORY module (1.7.0)

What the MEMORY builder changed or added relative to §1–§21.

### 22.1 Files

`src/continuity/memory/{memoryTypes,memoryBridge,memoryManager}.ts` (pure Node); VS Code side `src/ui/memoryHost.ts`
(`attachMemory` glue used by the extension **and** the CLI, `vscodeWatch`, the `memoryAction` handler and Memory manager
page data); CLI `src/cli/memoryCmd.ts`; Memory manager page in `media/continuity.js` / `.css`; tests
`scripts/smokeMemory.ts`, `src/test/continuityMemory.test.ts`.

### 22.2 Composition

- `Continuity.attachMemoryStore(store, { developerDir?, projectFolders, watch?, gitTracked?, taskExpiryDays?, now?, warn? })`
  returns a disposable with `refreshFolders()` (re-resolves the folders' projects, re-registers watchers, rescans). It sets
  `continuity.memory` (MemoryManager) and `continuity.memoryBridge`. `projectResolver()` is shared with conversations.
- MemoryStore (additive): `onChange(note, scope, op, body, { path, source })` (constructor option and settable property,
  fired after write, delete and prune), `typed?: TypedMemory` (the 1.7 types, set by continuity), `folder(scope)`,
  `write(…, source?)`, `promptSection(maxChars, { sessionId? })`, `mention(name, sessionId?)`.
- AgentRunner: `memoryHooks?: MemoryTurnHooks` (`onTodos`, `afterTurn`) from `createMemoryHooks` in `autoMemory.ts`.
  Healing: module-level `failureMemoryListeners` in `failureMemory.ts`; successful fixes become `agent` items.
- WorkspaceContext: `mentionResolvers` map for `#<kind>:<arg>` attachments (`memory` registered here; CONTEXT adds
  `context` and `chat`). The webview sends `#memory:<name>` as the attachment `memory:<name>`; the block is
  `<memory_note name=… type=…>`, shown as a chip. The CLI's `atRefs` picks `#memory:` up too.

### 22.3 Ids, scopes, prompt

- Ids: `memoryItemId(type, scopeKey(type, refs), name)`; `scopeKey`: project → projectId, developer → `user`,
  conversation → conversationId, task → `<projectId>:<taskRef>`, knowledge/agent → projectId if given else `user`. Note
  files use the file stem as name (same as migration), so migrated, bridged and remote copies are one entity.
- `taskRef` = `plan:<file>` or `todos:<sessionId>`; the checklist item is named `checklist` in its scope. When every todo
  is done, the checklist **and every other item with that taskRef** get `expiresAt`; reopening clears it (`null`, since
  `undefined` is dropped by JSON). `expireTasks` trashes due items at start and every 24 h.
- Prompt: `promptSection` keeps the 1.6 output byte-for-byte when there are no extra items; otherwise the conversation and
  task items (inline) and agent items (index line) are added only within what the notes left of `maxChars`.
  `localOnly` is stored and shown, **not yet applied to requests**: CONTEXT's `contextPolicy` must filter
  `TypedMemory.prompt` items (and file notes flagged localOnly) for cloud providers.
- Conversation summaries: a compaction's summary is reused (no request); otherwise one request every 20 messages per
  process (counter in memory, so the first turn after a restart of a long chat summarises once). The conversation
  `summary` field is patched only when the index knows the conversation (no ghost rows).
- Agent items are capped at 200 (least recently updated, unpinned, to Trash). Purging a conversation purges its
  conversation items (retention purge hook).

### 22.4 Bridge details (changes to §9.2)

- **Seen hashes are per machine, not in the index.** `project_memory.content_hash` is now the sha256 (LF) of the latest
  logged body (set by `apply.ts`, new named query `projectMemory`), but the write-back guard needs "what this machine last
  logged or wrote for this file", which can differ from the log's latest. It lives in `<dataRoot>/memory/seen.json`, keyed
  by absolute file path, shared by the machine's processes (read-merge-write of changed keys; a lost race only causes a
  re-log or a spurious conflict).
- Logging: a file whose hash equals the seen hash or the index body is not logged (watcher echoes, other windows on the
  same folder). Hand-deleted files are trashed only if this machine had seen them (a note missing here because it only
  exists on another device or in another developer folder is not trashed).
- Write-back happens on `IndexClient.onApplied.remoteMemory` (other processes and devices). Developer notes go to this
  process's developer folder, so VS Code's global-storage notes and the CLI's `~/.localpilot/memory` converge (they are one
  user scope). Project notes go to the open folder of their project unless git tracks the file. Mismatch → a `conflict`
  entity (`text-merge`, or `trash-vs-edit` for a remote trash of a locally edited file), file untouched. Missing notes are
  written only on a remote change, not on attach (SYNC may add a "materialise missing notes" pass).
- Watchers: VS Code `FileSystemWatcher` on `RelativePattern(dir, '*.md')`; CLI `fs.watch` plus a 3 s signature poll.

### 22.5 UI and messages

- `memoryAction` (FromWebview): `create | update | move | trash | restore | purge | open | openFolder | localOnly | pin |
  versions | restoreVersion | remember | saveKnowledge | suggest`; ToWebview `memoryVersions`, `memorySuggest`,
  `memoryDone`. `continuityPage {page:'memory'}` works without the conversation manager. The Trash page's data gains
  `memory` (trashed items); Empty Trash counts them.
- Command `localpilot.continuity.openMemoryManager` (optional type argument). Setting `localpilot.memory.taskExpiryDays`.

---

## 23. As built: CONTEXT module (1.7.0)

What the CONTEXT builder changed or added relative to §1–§22.

### 23.1 Files

`src/continuity/context/{contextPolicy,contextSnapshots,contextLibrary,relatedContext,contextService}.ts` (pure Node;
`contextService.ts` is the `Continuity.context` facade); `src/agent/contextHooks.ts` (the agent loop's optional hooks,
types only); host glue shared by VS Code and the CLI in `src/ui/contextHost.ts` (`attachContext`, `createContextHooks`,
page data, `contextAction`, restoration on chat open, the model-switch notice); Context library and "Context of this
chat" in `media/continuity.js` / `.css`; ring-card tabs, related row, notices and `#context:` / `#chat:` in
`media/chat.js` / `.css`; tests `scripts/smokeContext.ts`, `src/test/continuityContext.test.ts`.

### 23.2 Composition and hooks

- `Continuity.attachContext({ defaultFolder })` creates the `ContextService` (after `attachSessionStore`, whose manager
  materialises earlier chats). `attachContext(c, …)` in `contextHost.ts` also sets `AgentRunner.contextHooks`,
  registers `history_search` / `history_read` in the ToolRegistry (only while continuity is open, so no dead tools),
  and the `context` / `chat` entries of `WorkspaceContext.mentionResolvers`. The CLI wires the same (notices to stderr,
  `#context:` / `#chat:` parsed by `atRefs`).
- Agent loop (`ContextTurnHooks`): `beforeRequest` before **every** model request at every depth (policy; notice and
  block only at depth 0), `turnNote` once per turn (files changed since), `snapshot` for the turn's last request
  (recorded after `turn_end`) and on both sides of each compaction (both compaction paths). Subagent and scratch runs
  record nothing. `promptSection` is now called with `{ sessionId, cloud, excluded }`: **the 1.6/MEMORY call passed no
  session id, so conversation and task notes never reached the prompt; fixed here.** With no local-only notes the
  section is byte-for-byte unchanged.
- History tools are gated by `toolRelevance.ts` (words about earlier work, `#chat:`) like the other situational tools,
  to keep their schemas out of every prompt.

### 23.3 Snapshots (changes to §8.1)

- `ContextSnapshotFields` gained `phase` (`turn` | `before-compaction` | `after-compaction`), `remote`, `root` and
  `fileHashes` (sha256 of up to 60 working-set and attached files ≤ 5 MB, read from disk when the snapshot is taken;
  an attachment block may hold an excerpt, so hashing the block would not compare with the file). Item hashes come
  from the same map. Items are capped at 80 (largest first).
- The index table has no columns for todos / working set: named queries `contextSnapshots` / `contextSnapshot` join
  `entity_clocks.state` for the full fields. `messageId` is the turn's last assistant message, given its id by calling
  the SessionBridge's `prepare` at record time; `forMessage` falls back to the first turn snapshot at or after the
  message's time (answers in the middle of a turn).
- Purging a conversation deletes its snapshots in the index (`purgeMessages`), and redacted snapshot events are skipped.

### 23.4 Restoration (§8.1)

- `materialize()` fills `workingSet`, `todos`, `attachments` and `contextBreakdown` from the latest snapshot when the
  rebuilt Session has none (remote reloads, other projects, branch switches keep live state).
- On chat activation (`ContinuityHost` → `onChatOpened`), once per process and chat, not while running: the same
  restore plus `changedSince(root, fileHashes)`; the webview gets `contextRestored` (banner) and `contextItems` (ring
  card). The changed list becomes a `# Changed since this chat last ran` section of the next turn context, once.

### 23.5 Policy (§8.3)

- Mechanism: every resolver or tool that emits a local-only item writes `local-only="true"` on its block
  (`<memory_note>`, `<memory>` from memory_read / memory_search, `<context_set>`, `<chat_ref>`, `<chat_hit>`).
  `applyPolicy` replaces those blocks with `<excluded ref=… reason="local only">` in copies of the outgoing messages
  for a remote model (`ModelInfo.remote`), anywhere in the history, so an attachment from an earlier local turn
  cannot leak later. The memory section filters local-only notes itself (budget reused) and reports them as excluded.
- File notes' local-only flag lives in the index (`MemoryQuery.localOnly`, `TypedMemory.localOnly()`), cached 5 s.
- A conversation tagged `local-only` (case-insensitive) is refused for a remote model with an error turn; tags are
  cached 10 s and dropped on `setTags`.
- The local → cloud notice: once per chat and process, when the chat has earlier snapshots that were all local; the
  first remote snapshot makes it permanent across processes (no extra state).

### 23.6 Library and related (§8.2, §8.3)

- `context_item` gained `localOnly`; names are unique per scope (case-insensitive), `#context:` uses a slug of the
  name. Edits carry `base` (the version seen), so a concurrent `items` edit from another device is a conflict as §9.4
  says. Resolution caps: 24,000 characters per file, 40 files per glob, 80,000 per set; URLs are not fetched.
- Related ranking (FTS4 has no bm25): up to 8 keywords (stop words removed, identifiers first); named query
  `relatedTerms` returns, per keyword, the project's non-trashed conversations whose message prose / errors or title /
  summary contain it; the score is the IDF-weighted share of the keywords a conversation contains; at least two shared
  keywords and a score ≥ 0.34; top 3. Suggestions are requested by the webview while the first message is typed
  (700 ms debounce, ≥ 12 characters); **Add** inserts `#chat:<id>`.
- `history_read`: 20 messages, 2,000 characters per message, 12,000 per call; tool output and hidden messages left out.

### 23.7 Model switching (§8.4)

The agent loop already budgets every request against the model that answers it, so a smaller window compacts before
the next request without new code; CONTEXT adds `ChatController.onDidChangeModel` and a `contextNotice` (`window`)
when `contextTokens` exceeds the new effective window × threshold. SESSION can record `model_session`s from the same
event.

### 23.8 Messages

FromWebview `contextAction { action: create | update | trash | restore | purge | attach | inspect | related |
addRelated | suggest }`; ToWebview `related`, `contextSuggest`, `contextItems`, `contextRestored`, `contextNotice
{ kind: cloud | window }`, `contextDone`. `continuityPage {page:'context', params: { view: library | chat, sessionId,
snapshotId, all }}`. The Trash page's data gains `contextSets`. Command `localpilot.continuity.openContextLibrary`.
Setting `localpilot.continuity.relatedConversations`.

---

## 24. As built: SESSION module (1.7.0)

What the SESSION builder changed or added relative to §1–§23.

### 24.1 Files

`src/continuity/session/{runBridge,drafts,crashRecovery,sessionManager}.ts` (pure Node); the agent loop's hook types
`src/agent/sessionHooks.ts`; host glue shared by VS Code and the CLI `src/ui/sessionHost.ts` (`attachSessions`,
`chatSessionRuns`, `runDetails`, `checkpointsPageData`); CLI `src/cli/sessionsCmd.ts` (`recovery runs`, `history show
--runs`); the Checkpoints page in `media/continuity.js` / `.css`; the extended Run interrupted card and the partial-answer
card in `media/chat.js` / `.css`; tests `scripts/smokeSession.ts`, `src/test/continuitySession.test.ts`.

### 24.2 Composition and hooks (changes to §9.3)

- `Continuity.attachSessions({ modelInfo?, draftIntervalMs?, warn? })` sets `continuity.sessions` (SessionManager: `bridge`
  = RunBridge, `drafts`, `runs`, `events`, `checkpoints`, `modelSessions`, `interrupted`, `interruptedRun`, `takePartial`,
  `recoverInterrupted`, `onRemoteChange`). `attachSessions(c, deps)` in `sessionHost.ts` wires the hooks; all optional,
  no API removed:
  - `AgentRunner.sessionHooks` (`start(info) → RunHandle { userMessage, event, end }`), top level and non-scratch only. The
    loop wraps `emit` for the run, calls `userMessage` after `onUserMessage`, and `end` in `run()`'s `finally` with the
    outcome (a stop whose reason is `shutdown` = `interrupted`), tokens and `filesTouched` from
    `ChangeTracker.turnOriginals(session, meta.checkpoint)` (A/M/D, relative with `/`).
  - `AgentRunOptions.traceId` (the chat's RunTraceRecorder id): the agent session id is `agentSessionId(traceId)`, the
    same derivation migration uses, so a migrated trace and a live run never clash. The CLI has no traces: `newId('as')`.
  - `CheckpointService.onSnapshot(session, entry)`, `onRestore(sessionId, run)` (fired by `restoreWorkspace` for git
    checkpoints, parsing the ref) and `noteRestored(sessionId, run)` (called by `ChatController.rewindTo` for file-snapshot
    restores). `RecoveryStore.onSave(state)`. `TraceStore.onAdd(trace)` (instead of a recorder hook: only stored traces
    get `traceId`).
  - `ChatController.sessionRuns` (`details`, `takePartial`) and `redrawInterrupted(id)`; `ContinuityHost` forwards
    `onDidChangeModel` to `bridge.modelChanged` (reason `user`).
- Execution events: one per model request, tool call (created `running` at `tool_start`, patched at `tool_end`, so a
  crash shows the step that was running), retry, fallback (`route`), compaction, approval request, steer, nudge, error,
  and subagent start/end (depth 1; a subagent's inner events are not logged). `captureToolOutput`: `errors` keeps only
  `error` (2 KiB) of failed steps; `summary` keeps `output` (2 KiB); `full` adds `outputBlob` for longer output (also for
  errors). Steps still open at `end` are patched `cancelled`.
- Model sessions: the first `model_request` of a model starts one; the open one of a conversation is read from the index
  after a restart (named query `modelSessions`). The reason is captured when the request is seen (a `route` fallback just
  before it: `provider-down` when the model was unavailable, else `fallback`; a user switch: `user`; else `user` when the
  model is the chat's own and `auto` otherwise). Tokens are added at `turn_end`.

### 24.3 Checkpoints (changes to §3 and §9.3)

- Id `cp_<conversationId>_<run>` as designed (`checkpointId`). A turn retaken after a rewind reuses the id; its `create`
  carries `restoredAt: null`, so the newer create resets it. The run's end patches `files` (from `filesTouched`).
- A restore of a checkpoint taken before 1.7 (no entity) creates it from `session.checkpoints` first, then patches
  `restoredAt`.
- `checkpointContents` (git bundle blobs) is left to SYNC: `contentBlob` is never set here; the page shows **Content on
  <device>** for other devices' checkpoints without it.
- Page data (`checkpointsPageData`): `available` only when the chat is in this window's store and still has a user
  message with `meta.checkpoint === run` (else `why`). Actions (`checkpointAction { action: view | restore | open,
  sessionId, run, restoreType }`) select the chat and go through the controller's existing `viewChanges` (new optional
  `run`) and `restoreCheckpoint` (a modal confirmation first). Command `localpilot.continuity.openCheckpoints`.

### 24.4 Crash recovery and drafts (changes to §13)

- `writerGone(row)`: no writer → gone; this process's stream → gone unless the run is active here (a stream taken over
  after a crash has the dead writer's id); another stream of this device → its lease is free (stale or dead pid); another
  device → never judged here. `recoverInterrupted()` catches the index up first and runs at attach and on every card or
  CLI request (shared while in flight), not once per process: another window may die later.
- Drafts (`<root>/drafts/<conversationId>.json`, written every 2 s by tmp + rename, never in the log): one per current model
  response (a new `model_request` starts a new one), reset on `nudge`, removed at a normal end and **kept at an
  `interrupted` end** (written at once). `takePartial` turns a draft into `meta.partial` when it is newer than the chat's
  last message, its text is not already in the last answer, and its `afterMessageId` is still in the chat; the draft is
  removed once read. A draft whose writer is alive (this process running the chat, or another stream with a live lease) is
  never taken. `messageFields` now maps `meta.partial` to `MessageFields.partial`.
- The Run interrupted card (`RunInterruptedState`) gains `ran`, `ranMore`, `changed`, `checkpoint`, `partial`; it is posted
  first as in 1.6 and again with the details. When the chat's last answer is partial it becomes "Interrupted — partial
  answer" with `resumeDraft { action: continue | regenerate | discard }` (continue = `CONTINUE_PARTIAL_PROMPT`, regenerate
  = the existing `retry`). The CLI puts the partial answer back on `-c` / `-r`.

### 24.5 Index

Named queries `modelSessions`, `interruptedAgentSessions`. `apply.ts` deletes agent sessions, execution events,
checkpoints and model sessions that are purged or redacted (no `conversationId`), and `purgeMessages` removes a purged
conversation's rows from those tables. Setting `localpilot.continuity.captureToolOutput` (Settings → Continuity & sync →
Runs and checkpoints, with **Open Checkpoints**).
