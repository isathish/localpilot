/**
 * Smoke checks (bundled into scripts/smoke.ts) for the continuity MEMORY module: memory types and their rules, the
 * MemoryBridge (write / delete / hand edit / notes already on disk -> events; remote write-back with the hash guard
 * and a conflict on mismatch; git-tracked notes skipped), the MemoryManager (create, move between types, flags,
 * versions, task expiry with an injected clock, conversation memory follows a purge), the memory tools (`type`,
 * `global` alias, `memory_search`), promptSection's budget, `#memory:` mentions, the conversation / task memory hooks
 * and auto memory's pitfalls as agent lessons. Temp dirs only; no network.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { Continuity } from '../src/continuity/continuity';
import { memorySecretBox } from '../src/continuity/data/crypto/secretBox';
import { createMemoryTools, MemoryNote, MemoryScope, MemoryStore, TypedMemory } from '../src/agent/memory';
import { createMemoryHooks, parseMemoryNotes, saveRunMemories, summarizeConversation } from '../src/agent/autoMemory';
import { bodyHash } from '../src/continuity/memory/memoryBridge';
import { isExpired, normalizeType, promptRule, scopeKey, taskExpiry, TYPE_INFO } from '../src/continuity/memory/memoryTypes';
import { memoryItemId } from '../src/continuity/conversation/payloads';
import type { LLMProvider, Session, ToolContext } from '../src/types';

type Check = (name: string, cond: boolean, detail?: unknown) => void;
const tmp = (p: string) => fs.mkdtempSync(path.join(os.tmpdir(), `lp-mem-${p}-`));
const quiet = { info: () => undefined, warn: () => undefined, error: () => undefined };
const log = { ...quiet, debug: () => undefined, trace: () => undefined } as unknown as vscode.LogOutputChannel;
const settings = () => ({ dataDir: '', trashRetentionDays: 30, historyDays: 90, indexMaxMB: 256, backup: { enabled: false, intervalDays: 7, keep: 4 } });
const DAY = 86_400_000;

/**
 * A MemoryStore over real folders with node fs (the smoke vscode stub has no working workspace.fs): same `onChange`
 * contract (note stem, scope, op, body, path) as the real store.
 */
export class DiskMemory extends MemoryStore {
  constructor(private readonly dirs: { project?: string; global: string }) {
    super(vscode.Uri.file(dirs.global), log);
  }
  folder(scope: MemoryScope): string | undefined {
    return scope === 'global' ? this.dirs.global : this.dirs.project;
  }
  private file(name: string, scope: MemoryScope): string {
    return path.join(this.folder(scope)!, `${name.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '')}.md`);
  }
  async list(): Promise<MemoryNote[]> {
    const out: MemoryNote[] = [];
    for (const scope of ['project', 'global'] as MemoryScope[]) {
      const dir = this.folder(scope);
      for (const f of dir && fs.existsSync(dir) ? fs.readdirSync(dir).filter((x) => x.endsWith('.md')) : []) {
        const text = fs.readFileSync(path.join(dir!, f), 'utf8');
        out.push({ name: f.slice(0, -3), scope, summary: text.split('\n').find(Boolean) ?? '', updatedAt: fs.statSync(path.join(dir!, f)).mtimeMs, chars: text.length });
      }
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt);
  }
  async read(name: string, scope?: MemoryScope): Promise<string | undefined> {
    for (const s of scope ? [scope] : (['project', 'global'] as MemoryScope[])) {
      if (this.folder(s) && fs.existsSync(this.file(name, s))) {
        return fs.readFileSync(this.file(name, s), 'utf8');
      }
    }
    return undefined;
  }
  async write(name: string, content: string, scope: MemoryScope, mode: 'replace' | 'append' = 'replace', source?: 'user' | 'agent' | 'auto') {
    const f = this.file(name, scope);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    const text = mode === 'append' && fs.existsSync(f) ? `${fs.readFileSync(f, 'utf8').trimEnd()}\n\n${content.trim()}\n` : `${content.trim()}\n`;
    fs.writeFileSync(f, text);
    this.onChange?.(path.basename(f, '.md'), scope, 'write', text, { path: f, source });
    return { path: f, unchanged: false, duplicateLines: 0, droppedBlocks: 0, pruned: [] };
  }
  async delete(name: string, scope: MemoryScope): Promise<boolean> {
    const f = this.file(name, scope);
    if (!fs.existsSync(f)) {
      return false;
    }
    fs.rmSync(f);
    this.onChange?.(path.basename(f, '.md'), scope, 'delete', undefined, { path: f });
    return true;
  }
}

async function open(root: string, writer: 'cli' | 'vscode', now?: () => number): Promise<Continuity> {
  const c = await Continuity.open({ dataDir: root, writer, appVersion: 'test', secrets: memorySecretBox(), log: quiet, settings, wasmPath: process.env.LOCALPILOT_SQLJS_WASM ?? '', workerPath: '', inProcessIndex: true, schedules: false, autoMigrate: false, flushMs: 5, now });
  await c.ready;
  return c;
}

/** Tool context stub: approvals granted, the chat id given. */
const toolCtx = (sessionId = 's_test') => ({ sessionId, requestApproval: async () => true }) as unknown as ToolContext;

/** A provider that answers every chat request with `reply`. */
const fakeProvider = (reply: string, calls: string[] = []): LLMProvider =>
  ({
    async *chat(r: { messages: { content: unknown }[] }) {
      calls.push(String(r.messages[r.messages.length - 1]?.content ?? ''));
      yield { type: 'text', text: reply };
    },
  }) as unknown as LLMProvider;

export async function memorySmoke(check: Check): Promise<void> {
  console.log('\n[continuity: memory — types, bridge, manager, tools, prompt]');

  // ---- types
  check('type alias: global (and user) = developer; unknown types rejected', normalizeType('global') === 'developer' && normalizeType('USER') === 'developer' && normalizeType('knowledge') === 'knowledge' && normalizeType('notes') === undefined);
  check('six types; project and developer are file-backed, the rest live in the log', Object.keys(TYPE_INFO).length === 6 && TYPE_INFO.project.fileBacked && TYPE_INFO.developer.fileBacked && !TYPE_INFO.knowledge.fileBacked && !TYPE_INFO.agent.fileBacked);
  check('scope keys: project notes per project, developer per user, conversation per chat, task per project+task', scopeKey('project', { projectId: 'prj_a' }) === 'prj_a' && scopeKey('developer', { projectId: 'prj_a' }) === 'user' && scopeKey('conversation', { conversationId: 's_1' }) === 's_1' && scopeKey('task', { projectId: 'prj_a', taskRef: 'todos:s_1' }) === 'prj_a:todos:s_1');
  check('the migration id of a developer note equals the bridge id (same entity everywhere)', memoryItemId('global', 'user', 'prefs') === memoryItemId('developer', scopeKey('developer', {}), 'prefs'));
  const ctx = { conversationId: 's_1', projectId: 'prj_a', taskRefs: ['todos:s_1'], now: 1000 };
  check('prompt rules: conversation only in its chat, task while on it, agent as an index line, knowledge never', promptRule({ type: 'conversation', conversationId: 's_1' }, ctx) === 'inline' && promptRule({ type: 'conversation', conversationId: 's_2' }, ctx) === undefined && promptRule({ type: 'task', taskRef: 'todos:s_1', projectId: 'prj_a' }, ctx) === 'inline' && promptRule({ type: 'task', taskRef: 'todos:s_9', projectId: 'prj_a' }, ctx) === undefined && promptRule({ type: 'agent' }, ctx) === 'index' && promptRule({ type: 'knowledge' }, ctx) === undefined && promptRule({ type: 'task', taskRef: 'todos:s_1', expiresAt: 500 }, ctx) === undefined);
  check('task expiry: none while a todo is open; days after all are done', taskExpiry([{ status: 'done' }, { status: 'pending' }], 0, 14) === undefined && taskExpiry([{ status: 'done' }, { status: 'skipped' }], 1000, 14) === 1000 + 14 * DAY && isExpired({ expiresAt: 5 }, 5) && !isExpired({}, 5));

  // ---- bridge: write / delete / hand edit / notes on disk before attach
  const root = tmp('root');
  const folder = tmp('proj');
  const projDir = path.join(folder, '.localpilot', 'memory');
  const devDir = tmp('dev');
  fs.mkdirSync(projDir, { recursive: true });
  fs.writeFileSync(path.join(projDir, 'old-note.md'), '# Old\n- written before 1.7 saw this folder\n');
  let clock = Date.parse('2026-03-01T10:00:00Z');
  const now = () => clock;
  const a = await open(root, 'cli', now);
  const store = new DiskMemory({ project: projDir, global: devDir });
  const tracked = new Set<string>();
  const att = a.attachMemoryStore(store, { developerDir: devDir, projectFolders: () => [folder], watch: false, gitTracked: async (_r, f) => tracked.has(f), now });
  await att.refreshFolders();
  const mgr = a.memory!;
  await mgr.sync();
  const projectId = (await a.projectResolver().resolve(folder)).id;
  let rows = await mgr.list({});
  check('attach logs notes that were already on disk (a folder the 1.6 import never saw)', rows.some((r) => r.name === 'old-note' && r.type === 'project' && r.projectId === projectId), rows.map((r) => r.name));

  await store.write('build-and-test', '- `npm test` runs the suite', 'project', 'replace', 'agent');
  await mgr.sync();
  const buildId = memoryItemId('project', projectId, 'build-and-test');
  let it = await mgr.get(buildId);
  check('a MemoryStore write becomes a memory event (project type, body, file, agent source)', !!it && it.body.includes('npm test') && it.file === 'build-and-test.md' && it.source === 'agent', it);
  const pm = await a.index.query<{ memory_id: string; content_hash: string }>('projectMemory', { projectId });
  check('project_memory.content_hash is the hash of the logged body', pm.some((r) => r.memory_id === buildId && r.content_hash === bodyHash(it!.body)), pm);

  fs.writeFileSync(path.join(projDir, 'build-and-test.md'), '- `npm test` runs the suite\n- `npm run lint` checks style\n');
  await a.memoryBridge!.scan(projDir);
  await mgr.sync();
  it = await mgr.get(buildId);
  check('a hand edit (watcher scan) is logged with source file', !!it && it.body.includes('npm run lint') && it.source === 'file', it?.body);
  const nVersions = (await mgr.versions(buildId)).length;
  await a.memoryBridge!.scan(projDir);
  await mgr.sync();
  check('a rescan of unchanged files writes nothing', (await mgr.versions(buildId)).length === nVersions, nVersions);

  await store.delete('build-and-test', 'project');
  await mgr.sync();
  it = await mgr.get(buildId, { includeTrash: true });
  check('a MemoryStore delete moves the item to Trash', !!it?.trashedAt);
  await mgr.restore([buildId]);
  check('restore from Trash puts the note file back', fs.existsSync(path.join(projDir, 'build-and-test.md')) && !(await mgr.get(buildId))?.trashedAt);
  fs.rmSync(path.join(projDir, 'old-note.md'));
  await a.memoryBridge!.scan(projDir);
  await mgr.sync();
  check('a note file deleted by hand goes to Trash', !!(await mgr.get(memoryItemId('project', projectId, 'old-note'), { includeTrash: true }))?.trashedAt);

  // ---- remote write-back: another process with another developer folder (VS Code vs the CLI)
  const dev2 = tmp('dev2');
  const b = await open(root, 'vscode', now);
  const store2 = new DiskMemory({ global: dev2 });
  const att2 = b.attachMemoryStore(store2, { developerDir: dev2, projectFolders: () => [], watch: false, now });
  await att2.refreshFolders();
  await store2.write('prefs', '- answer briefly', 'global', 'replace', 'user');
  await b.memory!.sync();
  const prefsId = memoryItemId('developer', 'user', 'prefs');
  await a.index.catchUp();
  let wb = await a.memoryBridge!.applyRemote([prefsId]);
  const devFile = path.join(devDir, 'prefs.md');
  check('a remote developer note is written to this machine\'s folder', fs.existsSync(devFile) && fs.readFileSync(devFile, 'utf8').includes('answer briefly'), wb);
  clock += 60_000;
  await store2.write('prefs', '- answer briefly\n- prefer pnpm', 'global', 'replace', 'user');
  await b.memory!.sync();
  await a.index.catchUp();
  wb = await a.memoryBridge!.applyRemote([prefsId]);
  check('an unchanged local file follows the remote change (hash guard passes)', fs.readFileSync(devFile, 'utf8').includes('prefer pnpm'), wb);
  fs.writeFileSync(devFile, '- answer briefly\n- local edit not logged yet\n');
  clock += 60_000;
  await store2.write('prefs', '- answer in detail', 'global', 'replace', 'user');
  await b.memory!.sync();
  await a.index.catchUp();
  wb = await a.memoryBridge!.applyRemote([prefsId]);
  await a.log.flush();
  await a.index.catchUp();
  const conflicts = await a.index.query<{ entity: string; kind: string; entity_id: string }>('conflicts', {});
  check('a file edited here while it changed elsewhere is kept and a text-merge conflict is recorded', fs.readFileSync(devFile, 'utf8').includes('local edit') && wb.conflicts === 1 && conflicts.some((x) => x.entity_id === prefsId && x.kind === 'text-merge'), { wb, conflicts });

  // git-tracked project notes are never written by a remote change
  const trackedFile = path.join(projDir, 'conventions.md');
  await store.write('conventions', '- tabs', 'project', 'replace', 'user');
  await mgr.sync();
  tracked.add(trackedFile);
  const convId = memoryItemId('project', projectId, 'conventions');
  b.log.append('memory', convId, 'patch', { body: '- spaces\n', summary: 'spaces' }, { durable: true });
  await b.log.flush();
  await a.index.catchUp();
  wb = await a.memoryBridge!.applyRemote([convId]);
  check('git-tracked project notes are skipped (git moves them)', fs.readFileSync(trackedFile, 'utf8').includes('tabs') && wb.skipped === 1, wb);

  // ---- manager: log-only types, move, flags, versions
  const kId = await mgr.create('knowledge', { name: 'Deploy steps', body: '- kubectl rollout restart deploy/api' });
  check('knowledge items live in the log (no file)', !!(await mgr.get(kId)) && !fs.readdirSync(devDir).some((f) => f.startsWith('deploy')));
  await mgr.update(kId, { body: '- kubectl rollout restart deploy/api\n- then watch the logs' });
  const vs = await mgr.versions(kId);
  await mgr.restoreVersion(kId, vs[vs.length - 1].hlc);
  check('versions keep each body; restoring an earlier one puts its text back', vs.length >= 2 && !(await mgr.get(kId))!.body.includes('watch the logs') && (await mgr.versions(kId)).length === vs.length + 1, vs.map((v) => v.op));
  await mgr.pin([kId], true);
  await mgr.setLocalOnly([kId], true);
  it = await mgr.get(kId);
  check('pin and local only are flags on the item', !!it?.pinned && !!it.localOnly);
  const agentId = await mgr.moveType(kId, 'agent');
  check('move to type: a new item of the new type, the old one in Trash, flags kept', agentId !== kId && (await mgr.get(agentId))?.type === 'agent' && !!(await mgr.get(agentId))?.localOnly && !!(await mgr.get(kId, { includeTrash: true }))?.trashedAt);
  const devMoved = await mgr.moveType(agentId, 'developer');
  check('moving to developer writes the note file', fs.existsSync(path.join(devDir, 'deploy-steps.md')) && (await mgr.get(devMoved))?.type === 'developer');

  // ---- tools: type, global alias, memory_search
  store.typed = a.memory!.typed();
  const tools = Object.fromEntries(createMemoryTools(store).map((t) => [t.definition.name, t]));
  check('memory tools: the four 1.6 tools plus memory_search', ['memory_save', 'memory_read', 'memory_list', 'memory_delete', 'memory_search'].every((n) => !!tools[n]));
  const saved = await tools.memory_save.execute({ name: 'editor', content: '- vim keys', scope: 'global' }, toolCtx());
  check('scope "global" still writes a developer note file', !saved.isError && fs.existsSync(path.join(devDir, 'editor.md')), saved.content);
  const savedK = await tools.memory_save.execute({ name: 'release-checklist', content: '- bump the version\n- tag the commit', type: 'knowledge' }, toolCtx());
  const savedC = await tools.memory_save.execute({ name: 'decision', content: '- we keep REST, not gRPC', type: 'conversation' }, toolCtx('s_chat1'));
  check('type knowledge / conversation go to the log', !savedK.isError && !savedC.isError && (await mgr.list({ type: 'conversation' })).some((r) => r.conversationId === 's_chat1'), [savedK.content, savedC.content]);
  const found = await tools.memory_search.execute({ query: 'tag commit' }, toolCtx());
  check('memory_search finds a knowledge note by words (FTS)', !found.isError && found.content.includes('release-checklist'), found.content);
  const hidden = await tools.memory_search.execute({ query: 'gRPC' }, toolCtx('s_other'));
  check('another chat does not see this chat\'s conversation memory', !hidden.content.includes('decision'), hidden.content);
  const read = await tools.memory_read.execute({ name: 'release-checklist' }, toolCtx());
  check('memory_read without a type reaches the other types by name', read.content.includes('bump the version'), read.content);
  const noTask = await tools.memory_save.execute({ name: 'x', content: 'some note text here', type: 'task' }, toolCtx('s_none'));
  check('task memory needs a running plan or todo list', !!noTask.isError, noTask.content);
  const listed = await tools.memory_list.execute({ type: 'knowledge' }, toolCtx());
  check('memory_list by type', listed.content.includes('release-checklist') && !listed.content.includes('editor'), listed.content);
  const delK = await tools.memory_delete.execute({ name: 'release-checklist', type: 'knowledge' }, toolCtx());
  check('memory_delete with a type moves a log item to Trash', !delK.isError && !!(await mgr.list({ trash: true })).some((r) => r.name === 'release-checklist'));
  const bare = new DiskMemory({ global: tmp('bare') });
  const bareTools = Object.fromEntries(createMemoryTools(bare).map((t) => [t.definition.name, t]));
  const noTyped = await bareTools.memory_save.execute({ name: 'k', content: 'some text', type: 'knowledge' }, toolCtx());
  await bareTools.memory_save.execute({ name: 'build', content: '- make all builds it', scope: 'global' }, toolCtx());
  const bareSearch = await bareTools.memory_search.execute({ query: 'make all' }, toolCtx());
  check('without continuity: log-only types say so; memory_search falls back to the note files', !!noTyped.isError && bareSearch.content.includes('build'), [noTyped.content, bareSearch.content]);

  // ---- task memory with an injected clock
  const todos = [{ id: '1', title: 'Write the parser', status: 'done' as const }, { id: '2', title: 'Add tests', status: 'in_progress' as const }];
  const taskId = (await mgr.taskProgress({ sessionId: 's_task', todos }))!;
  check('a running todo list becomes a task item without an expiry', !!(await mgr.get(taskId)) && !(await mgr.get(taskId))!.expiresAt && (await mgr.get(taskId))!.body.includes('[>] Add tests'));
  const ts = await tools.memory_save.execute({ name: 'parser-notes', content: '- the lexer is hand-written', type: 'task' }, toolCtx('s_task'));
  check('memory_save type task attaches to the chat\'s running task', !ts.isError && (await mgr.list({ type: 'task' })).some((r) => r.name === 'parser-notes' && r.taskRef === 'todos:s_task'), ts.content);
  await mgr.taskProgress({ sessionId: 's_task', todos: todos.map((t) => ({ ...t, status: 'done' as const })) });
  const exp = (await mgr.get(taskId))!.expiresAt;
  check('when every todo is done the task expires taskExpiryDays (14) later', exp === clock + 14 * DAY, { exp, clock });
  check('nothing expires before that', (await mgr.expireTasks(clock + 13 * DAY)) === 0);
  check('the task\'s other notes share its expiry', (await mgr.list({ type: 'task' })).find((r) => r.name === 'parser-notes')?.expiresAt === exp);
  check('expired task items go to Trash', (await mgr.expireTasks(clock + 15 * DAY)) === 2 && !!(await mgr.get(taskId, { includeTrash: true }))?.trashedAt);

  // ---- prompt items and promptSection's budget
  const pi = await mgr.promptItems('s_chat1', projectId);
  check('prompt items: this chat\'s conversation note inline, agent lessons as index lines', pi.inline.some((r) => r.name === 'decision') && !pi.inline.some((r) => r.type === 'knowledge'), pi);
  class FixedNotes extends MemoryStore {
    constructor(private readonly notes: { name: string; scope: MemoryScope; body: string }[]) {
      super(vscode.Uri.file(tmp('fixed')), log);
    }
    async list(): Promise<MemoryNote[]> {
      return this.notes.map((n, i) => ({ name: n.name, scope: n.scope, summary: n.body.split('\n')[0], updatedAt: 1000 - i, chars: n.body.length }));
    }
    async read(name: string): Promise<string | undefined> {
      return this.notes.find((n) => n.name === name)?.body;
    }
  }
  const fixed = new FixedNotes([{ name: 'build', scope: 'project', body: '- make check\n' }, { name: 'style', scope: 'global', body: '- short answers\n' }]);
  const before = await fixed.promptSection(2000);
  const extras: TypedMemory = { ...store.typed!, prompt: async () => ({ inline: [{ type: 'conversation', name: 'Conversation summary', summary: 'Goal: parser', body: '- Goal: parser\n- Decided: REST' }], index: [{ type: 'agent', name: 'fix: build ENOENT', summary: 'run npm ci first' }] }) };
  fixed.typed = extras;
  const after = await fixed.promptSection(2000, { sessionId: 's_chat1' });
  check('promptSection: the notes\' part is unchanged with the new types added after it', after.startsWith(before.split('\n\n')[0]) && after.includes(before.split('\n\n')[1] ?? '') && after.includes('(conversation): Goal: parser') && after.includes('- fix: build ENOENT (agent): run npm ci first'), after);
  const tight = await fixed.promptSection(before.length + 10, { sessionId: 's_chat1' });
  check('promptSection never exceeds its budget (the new types get only what the notes left)', tight.length <= before.length + 10 && tight.startsWith(before.split('\n')[0]), tight.length);
  fixed.typed = undefined;
  check('without the new types promptSection is exactly as in 1.6', (await fixed.promptSection(2000)) === before);
  const ment = await store.mention('editor');
  const mentK = await store.mention('decision', 's_chat1');
  const miss = await store.mention('nope');
  check('#memory:<name> resolves a note file, or reports a missing name', ment.includes('<memory_note name="editor" type="developer">') && ment.includes('vim keys') && miss.includes('error="not found"') && !mentK.includes('error'), [ment, mentK, miss]);

  // ---- conversation memory follows a purge
  await mgr.conversationSummary('s_gone', '- goal: remove me');
  check('a conversation summary is a conversation item and the conversation\'s summary field', (await mgr.list({ type: 'conversation', conversationId: 's_gone' })).length === 1);
  await mgr.purgeConversation('s_gone');
  await mgr.sync();
  check('purging a conversation purges its conversation memory', (await mgr.list({ type: 'conversation', conversationId: 's_gone', trash: false })).length === 0 && !(await a.index.memory({ conversationId: 's_gone', includeTrash: true })).length);

  // ---- hooks: conversation summaries, task checklists
  const got: string[] = [];
  const tasks: string[] = [];
  const hooks = createMemoryHooks({ conversationSummary: async (_id, s) => void got.push(s), taskProgress: async (o) => void tasks.push(o.sessionId) });
  const sess = { id: 's_h', messages: Array.from({ length: 6 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `message ${i}` })) } as unknown as Session;
  const calls: string[] = [];
  const base = { provider: fakeProvider('- Goal: test\n- State: done', calls), model: 'm', contextWindow: 8192, signal: new AbortController().signal };
  await hooks.afterTurn!({ session: sess, ...base });
  check('no summary before 20 messages', !got.length && !calls.length);
  await hooks.afterTurn!({ session: sess, ...base, compaction: '<conversation_summary>Compacted: goal X</conversation_summary>' });
  check('after a compaction its summary is kept (no extra request)', got[0] === 'Compacted: goal X' && !calls.length, got);
  sess.messages.push(...Array.from({ length: 20 }, (_, i) => ({ role: 'user' as const, content: `more ${i}` })));
  await hooks.afterTurn!({ session: sess, ...base });
  check('every 20 messages one request to the same model writes the summary', got[1]?.includes('Goal: test') && calls.length === 1, got);
  hooks.onTodos!(sess, [{ id: '1', title: 't', status: 'pending' }]);
  await new Promise((r) => setTimeout(r, 10));
  check('todo changes reach task memory', tasks[0] === 's_h');
  check('a summary with a credential is dropped', (await summarizeConversation({ ...base, provider: fakeProvider('- key AKIAIOSFODNN7EXAMPLQ') }, sess.messages)) === ''); // localpilot-scan: ignore (test fixture)

  // ---- auto memory: pitfalls become agent lessons
  const notes = parseMemoryNotes('{"notes":[{"name":"build-enoent","content":"- `npm ci` before the build fixes ENOENT","kind":"pitfall"},{"name":"test-cmd","content":"- `npm test` runs the suite","kind":"fact"}]}');
  check('auto memory reads the note kind', notes[0].kind === 'pitfall' && notes[1].kind === undefined);
  const savedAuto = await saveRunMemories(store, { provider: fakeProvider('{"notes":[{"name":"build-enoent","content":"- `npm ci` before the build fixes ENOENT","kind":"pitfall"},{"name":"test-cmd","content":"- `npm test` runs the whole suite","kind":"fact"}]}'), model: 'm', contextWindow: 8192 }, 'Request: build');
  await mgr.sync();
  check('pitfalls become agent items, facts stay project notes', savedAuto.length === 2 && (await mgr.list({ type: 'agent' })).some((r) => r.name === 'build-enoent' && r.source === 'auto') && fs.existsSync(path.join(projDir, 'test-cmd.md')), savedAuto);
  const fixId = await mgr.recordFix({ category: 'build', signature: 'sig', message: "Cannot find module 'x'", strategy: 'install the missing dependency', ecosystem: 'node', successes: 2, failures: 0 });
  check('a healing fix that worked becomes an agent lesson', (await mgr.get(fixId!))?.type === 'agent' && (await mgr.get(fixId!))!.body.includes('install the missing dependency'));
  check('bodyHash ignores CRLF', bodyHash('a\r\nb\n') === bodyHash('a\nb\n'));

  att2.dispose();
  att.dispose();
  await b.dispose();
  await a.dispose();
}
