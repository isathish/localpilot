// Real-looking 1.6 data for the continuity migration tests (smoke and Mocha): a VS Code profile with two workspaces
// (one whose folder no longer exists), chats with a compaction archive, images, tool calls, checkpoints, run traces, a
// recovery state, project and global memory, plus CLI chats, CLI memory and custom commands. Paths via path.join only.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { ChatMessage, Session } from '../../types';
import type { RunTrace } from '../../telemetry/runTrace';
import type { MigrationSources } from '../../continuity/data/migration';

export const EXTENSION_ID = 'localpilot.localpilot-agent';
/** 1x1 transparent PNG. */
export const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

export interface Fixture {
  base: string;
  sources: MigrationSources;
  /** Every source file with its content at creation (to prove migration never writes them). */
  originals: Map<string, Buffer>;
  projectFolder: string;
  goneFolder: string;
  ids: { vscodeChat: string; archivedChat: string; cliChat: string; goneChat: string; emptyChat: string };
  /** Messages each chat should have after migration (archive + current, copies not doubled). */
  expectedMessages: Record<string, number>;
}

function session(id: string, title: string, messages: ChatMessage[], extra: Partial<Session> = {}): Session {
  return {
    id,
    title,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_500_000,
    model: 'ollama/qwen3-coder',
    mode: 'agent',
    messageCount: messages.length,
    messages,
    contextTokens: 0,
    compactions: 0,
    attachments: [],
    ...extra,
  };
}

function write(file: string, data: string | Buffer, originals: Map<string, Buffer>): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, data);
  originals.set(file, fs.readFileSync(file));
}

export function makeFixture(): Fixture {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'lp-cont-fx-'));
  const originals = new Map<string, Buffer>();
  const userDir = path.join(base, 'Code', 'User');
  const globalStorage = path.join(userDir, 'globalStorage', EXTENSION_ID);
  const projectFolder = path.join(base, 'projects', 'api');
  const goneFolder = path.join(base, 'projects', 'deleted-app');
  fs.mkdirSync(path.join(projectFolder, '.localpilot', 'memory'), { recursive: true });
  // Workspace 1 (exists): storage hash abc123.
  const ws1 = path.join(userDir, 'workspaceStorage', 'abc123');
  const ws1Storage = path.join(ws1, EXTENSION_ID);
  write(path.join(ws1, 'workspace.json'), JSON.stringify({ folder: `file://${process.platform === 'win32' ? '/' : ''}${projectFolder.replace(/\\/g, '/')}` }), originals);
  const vscodeChat = 's_01HVSCODE0000000000000000';
  const archivedChat = 's_01HARCHIVED00000000000000';
  write(
    path.join(ws1Storage, 'sessions', `${vscodeChat}.json`),
    JSON.stringify(
      session(vscodeChat, 'Fix ECONNREFUSED in the api client', [
        { role: 'user', content: 'The client fails with ECONNREFUSED 127.0.0.1:5432', images: [PNG_1PX], meta: { timestamp: 1_700_000_001_000 } },
        { role: 'assistant', content: '', toolCalls: [{ id: 'call_1', name: 'run_command', arguments: '{"command":"npm test"}' }], meta: { timestamp: 1_700_000_002_000 } },
        { role: 'tool', content: 'Error: connect ECONNREFUSED 127.0.0.1:5432\n    at TCPConnectWrap', toolCallId: 'call_1', toolName: 'run_command', meta: { failed: true, timestamp: 1_700_000_003_000 } },
        { role: 'assistant', content: 'Postgres was not running. Start it with:\n```sh\ndocker compose up -d db\n```', meta: { timestamp: 1_700_000_004_000, model: 'ollama/qwen3-coder' } },
      ], { folder: projectFolder, pinned: true, checkpoints: { latest: 1, history: [{ run: 1, createdAt: 1_700_000_001_500, kind: 'commit', outcome: 'head_clean', ref: `refs/localpilot/checkpoints/${vscodeChat}/1`, sha: 'a'.repeat(40), root: projectFolder }] } })
    ),
    originals
  );
  // A compacted chat: 3 archived messages, then a summary and the verbatim copy of the last archived one plus a new one.
  const arch = [
    { seq: 0, compaction: 1, at: 1, message: { role: 'user', content: 'Refactor the parser', meta: { archived: 0 } } },
    { seq: 1, compaction: 1, at: 2, message: { role: 'assistant', content: 'Done: split tokenizer.ts', meta: { archived: 1 } } },
    { seq: 2, compaction: 1, at: 3, message: { role: 'user', content: 'Now add tests', meta: { archived: 2 } } },
  ];
  write(path.join(ws1Storage, 'sessions', `${archivedChat}.archive.jsonl`), arch.map((r) => JSON.stringify(r)).join('\n') + '\n', originals);
  write(
    path.join(ws1Storage, 'sessions', `${archivedChat}.json`),
    JSON.stringify(
      session(archivedChat, 'Refactor the parser', [
        { role: 'user', content: 'Summary of the conversation so far: split the tokenizer.', meta: { summary: true } },
        { role: 'user', content: 'Now add tests', meta: { archived: 2 } },
        { role: 'assistant', content: 'Added parser.test.ts', meta: { timestamp: 1_700_000_100_000 } },
      ], { compactions: 1 })
    ),
    originals
  );
  // An empty "New chat": skipped.
  const emptyChat = 's_01HEMPTY00000000000000000';
  write(path.join(ws1Storage, 'sessions', `${emptyChat}.json`), JSON.stringify(session(emptyChat, 'New chat', [])), originals);
  // A corrupt chat file: recorded as failed.
  write(path.join(ws1Storage, 'sessions', 's_corrupt.json'), '{"id": "s_corrupt", "messages": [', originals);
  // A run trace and a recovery state.
  const trace: RunTrace = {
    version: 1, id: 'tr_1', sessionId: vscodeChat, title: 'The client fails', mode: 'agent', startedAt: 1_700_000_001_000, durationMs: 4000, outcome: 'ok', model: 'ollama/qwen3-coder',
    entries: [
      { kind: 'model', name: 'qwen3-coder', start: 0, end: 900, status: 'ok' },
      { kind: 'tool', name: 'run_command', start: 900, end: 2000, status: 'error', detail: 'npm test' },
    ],
  };
  write(path.join(ws1Storage, 'traces', `${vscodeChat}.json`), JSON.stringify([trace]), originals);
  write(path.join(ws1Storage, 'recovery', `${vscodeChat}.json`), JSON.stringify({ version: 1, rev: 3, sessionId: vscodeChat, turnKey: 1, phase: 'repairing', startedAt: 1_700_000_001_000, updatedAt: 1_700_000_002_000, owner: { pid: 1, host: 'h', kind: 'vscode' }, baseline: undefined, checks: {}, changedFiles: ['src/db.ts'], agentWrites: {}, approvals: [], acceptedRisks: [], attempts: [{ category: 'test_failure' }], perCategory: {}, seen: {} }), originals);
  // Workspace 2: folder gone.
  const ws2 = path.join(userDir, 'workspaceStorage', 'def456');
  write(path.join(ws2, 'workspace.json'), JSON.stringify({ folder: `file://${process.platform === 'win32' ? '/' : ''}${goneFolder.replace(/\\/g, '/')}` }), originals);
  const goneChat = 's_01HGONE000000000000000000';
  write(path.join(ws2, EXTENSION_ID, 'sessions', `${goneChat}.json`), JSON.stringify(session(goneChat, 'Old app setup', [{ role: 'user', content: 'Set up the old app' }, { role: 'assistant', content: 'Created the scaffold' }])), originals);
  // Memory: project + VS Code global.
  write(path.join(projectFolder, '.localpilot', 'memory', 'build.md'), '# Build\n- npm run build\n- npm test needs Postgres (docker compose up -d db)\n', originals);
  write(path.join(globalStorage, 'memory', 'style.md'), '# Style\nPrefer small functions.\n', originals);
  // CLI: data dir with a chat for the project, global memory and a custom command in ~/.localpilot.
  const cliData = path.join(base, 'home', '.localpilot');
  const cliChat = 'cli-01HCLI000000000000000000';
  write(path.join(cliData, 'workspaces', '0123456789abcdef', 'sessions', `${cliChat}.json`), JSON.stringify(session(cliChat, 'Migrate the database', [{ role: 'user', content: 'Write a migration for users.email' }, { role: 'assistant', content: 'Added migrations/0004_email.sql' }], { origin: 'cli', folder: projectFolder })), originals);
  write(path.join(cliData, 'memory', 'tools.md'), 'Use pnpm, not npm.\n', originals);
  write(path.join(cliData, 'commands', 'review.md'), '---\ndescription: Review the staged changes\n---\nReview `git diff --staged` for bugs.\n', originals);
  return {
    base,
    sources: { vscodeStorage: ws1Storage, workspaceFolders: [projectFolder], vscodeGlobalStorage: globalStorage, extensionId: EXTENSION_ID, cliDataDir: cliData, home: cliData },
    originals,
    projectFolder,
    goneFolder,
    ids: { vscodeChat, archivedChat, cliChat, goneChat, emptyChat },
    expectedMessages: { [vscodeChat]: 4, [archivedChat]: 5, [cliChat]: 2, [goneChat]: 2 },
  };
}

/** True when every source file still has exactly its original bytes. */
export function originalsUntouched(fx: Fixture): string[] {
  const changed: string[] = [];
  for (const [file, buf] of fx.originals) {
    try {
      if (!fs.readFileSync(file).equals(buf)) {
        changed.push(file);
      }
    } catch {
      changed.push(file);
    }
  }
  return changed;
}
