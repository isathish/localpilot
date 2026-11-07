/**
 * Smoke checks (bundled into scripts/smoke.ts) for the continuity CONTEXT module: the context policy (local-only
 * blocks stripped for cloud models only, the local-only conversation tag, the local -> cloud notice), snapshot items
 * and file hashes, snapshots recorded by the real agent loop per turn and on both sides of a compaction, restoration
 * of a reopened chat with "changed since", the context library (CRUD, `#context:` resolution, globs, Trash), related
 * conversations (ranking, threshold, Trash excluded), `#chat:` and the history tools' caps, memory notes marked local
 * only kept out of a cloud prompt, the model-switch window notice. Temp dirs and a local fake model server only.
 */
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { AgentRunner } from '../src/agent/agentLoop';
import { SkillManager } from '../src/agent/skills';
import { applyPolicy, blockReason, cloudNotice, stripLocalOnly } from '../src/continuity/context/contextPolicy';
import { changedNote, changedSince, hashFiles, restoreInto, snapshotItems, type ContextSnapshot } from '../src/continuity/context/contextSnapshots';
import { cleanItems, expandGlob, globRegExp, slugName } from '../src/continuity/context/contextLibrary';
import { CHAT_REF_TOKENS, capTokens, historyTools, keywords, READ_MAX_MESSAGES, READ_TOTAL_CHARS, scoreRelated } from '../src/continuity/context/relatedContext';
import { estimateTokens } from '../src/context/tokenizer';
import { WorkspaceContext } from '../src/context/workspaceContext';
import { ProviderRegistry } from '../src/providers/registry';
import { ToolRegistry } from '../src/tools/registry';
import type { AgentEvent, ChatMessage, ModelInfo, Session, ToolContext } from '../src/types';
import { attachContext, modelSwitchNotice } from '../src/ui/contextHost';
import { ContextService } from '../src/continuity/context/contextService';
import { openRig } from './smokeConversation';
import { DiskMemory } from './smokeMemory';

type Check = (name: string, cond: boolean, detail?: unknown) => void;
const tmp = (p: string) => fs.mkdtempSync(path.join(os.tmpdir(), `lp-ctx-${p}-`));
const log = { info() {}, warn() {}, error() {}, debug() {}, trace() {} } as unknown as vscode.LogOutputChannel;
const say = (role: ChatMessage['role'], content: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({ role, content, meta: { timestamp: Date.now() }, ...extra });
const toolCtx = (sessionId: string) => ({ sessionId, requestApproval: async () => true, signal: new AbortController().signal, depth: 0 }) as unknown as ToolContext;

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((r) => {
    let b = '';
    req.on('data', (d) => (b += d));
    req.on('end', () => r(b));
  });
}

export async function contextSmoke(check: Check): Promise<void> {
  console.log('\n[continuity: context — policy, snapshots, restoration, library, related, history tools]');

  // ---- policy (pure)
  const userMsg = say('user', 'Deploy it.\n<memory_note name="prod-secrets" type="knowledge" local-only="true">\nDB password lives in vault path secret/prod\n</memory_note>\n<memory_note name="style" type="developer">\nshort answers\n</memory_note>');
  const local = applyPolicy([userMsg], { remote: false });
  const cloud = applyPolicy([userMsg], { remote: true });
  check('policy: a local model gets local-only blocks unchanged (same array)', local.messages[0] === userMsg && !local.excluded.length);
  check('policy: a cloud model gets a placeholder instead, the other notes stay, the chat history is not changed', !cloud.messages[0].content.includes('vault path') && cloud.messages[0].content.includes('short answers') && cloud.messages[0].content.includes('excluded ref="memory:prod-secrets"') && userMsg.content.includes('vault path'), cloud.messages[0].content);
  check('policy: the stripped block is listed as excluded (localOnly)', cloud.excluded.length === 1 && cloud.excluded[0].ref === 'memory:prod-secrets' && cloud.excluded[0].reason === 'localOnly', cloud.excluded);
  check('policy: nested sets: a local-only set goes whole, a note inside a shared set alone', !stripLocalOnly('<context_set name="ops" local-only="true"><file path="a">A</file></context_set>').includes('<file') && stripLocalOnly('<context_set name="ops"><memory_note name="k" local-only="true">K</memory_note><file path="b">B</file></context_set>').includes('<file path="b">B</file>'));
  check('policy: a conversation tagged local-only is never sent to a cloud model; untagged or local is fine', !!blockReason({ remote: true, tags: ['work', 'Local-Only'], model: 'gpt' }) && !blockReason({ remote: false, tags: ['local-only'], model: 'qwen' }) && !blockReason({ remote: true, tags: ['work'], model: 'gpt' }));
  check('notice: once, only when a chat that ran locally first goes to a cloud model', !!cloudNotice({ remote: true, model: 'gpt', provider: 'oai', earlierRemote: false, earlierLocal: true, shown: false, excluded: [] }) && !cloudNotice({ remote: true, model: 'gpt', provider: 'oai', earlierRemote: true, earlierLocal: true, shown: false, excluded: [] }) && !cloudNotice({ remote: true, model: 'gpt', provider: 'oai', earlierRemote: false, earlierLocal: false, shown: false, excluded: [] }) && !cloudNotice({ remote: false, model: 'q', provider: 'o', earlierRemote: false, earlierLocal: true, shown: false, excluded: [] }));
  check('notice: names what is kept back', /Kept on this machine: memory:prod-secrets/.test(cloudNotice({ remote: true, model: 'gpt', provider: 'oai', earlierRemote: false, earlierLocal: true, shown: false, excluded: cloud.excluded }) ?? ''));

  // ---- snapshot items, hashes, restoration (pure)
  const root = tmp('ws');
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'a.ts'), 'export const a = 1;\n');
  fs.writeFileSync(path.join(root, 'src', 'b.ts'), 'export const b = 2;\n');
  const history: ChatMessage[] = [
    say('user', 'summary of earlier work', { meta: { summary: true } }),
    say('user', `<attachment path="src/a.ts">\nexport const a = 1;\n</attachment>\n<context_set name="release">\n<file path="docs/x.md">x</file>\n</context_set>\nFix a`),
    say('assistant', '', { toolCalls: [{ id: 'c1', name: 'read_file', arguments: JSON.stringify({ path: 'src/b.ts' }) }] }),
    say('tool', 'export const b = 2;\n'.repeat(30), { toolCallId: 'c1', toolName: 'read_file' }),
  ];
  const items = snapshotItems({ messages: history, memorySection: '- build (project): npm test\n\n<memory name="build" scope="project">\nnpm test\n</memory>', rules: '<!-- AGENTS.md -->\nUse tabs\n\n<!-- .localpilot/rules/api.md -->\n## api\nREST only', ruleLabels: ['.localpilot/rules/api.md'] });
  const kinds = new Set(items.map((i) => i.kind));
  check('snapshot items: files, context sets, summary, tool output (named after its call), memory and rules, with token estimates', ['file', 'library', 'summary', 'tool', 'memory', 'rule'].every((k) => kinds.has(k as never)) && items.some((i) => i.kind === 'tool' && i.ref === 'read_file src/b.ts') && items.some((i) => i.ref === '#context:release') && items.some((i) => i.kind === 'rule' && i.ref === 'AGENTS.md') && items.every((i) => i.tokens >= 0) && items[0].tokens >= items[items.length - 1].tokens, items);
  const hashes = hashFiles(root, ['src/a.ts', 'src/b.ts', 'missing.ts', '@git']);
  check('file hashes: sha256 of each file read; missing files and mentions skipped', Object.keys(hashes).length === 2 && /^[0-9a-f]{64}$/.test(hashes['src/a.ts']), hashes);
  fs.writeFileSync(path.join(root, 'src', 'a.ts'), 'export const a = 42;\n');
  fs.rmSync(path.join(root, 'src', 'b.ts'));
  const ch = changedSince(root, hashes);
  check('changed since: an edited file and a deleted one are marked', ch.length === 2 && ch.some((c) => c.path === 'src/a.ts' && c.state === 'changed') && ch.some((c) => c.path === 'src/b.ts' && c.state === 'deleted'), ch);
  check('changed since: the next turn is told which files to read again', /src\/a\.ts/.test(changedNote(ch) ?? '') && /src\/b\.ts \(deleted\)/.test(changedNote(ch) ?? '') && changedNote([]) === undefined);
  const bare: Session = { id: 's_r', title: 'x', createdAt: 0, updatedAt: 0, model: '', messageCount: 0, messages: [], contextTokens: 0, compactions: 0, mode: 'agent', attachments: [] };
  const snapFields = { id: 'ctx_1', conversationId: 's_r', model: 'm', provider: 'p', window: 8192, usedTokens: 900, items: [], attachments: ['file:///x'], workingSet: ['src/a.ts', 'src/b.ts'], todos: [{ id: '1', title: 'Fix a', status: 'pending' as const }], createdAt: 1, fileHashes: hashes, breakdown: { system: 1, rules: 0, memory: 0, tools: 0, mcpTools: 0, conversation: 1, files: 0, toolResults: 0, summary: 0 } } satisfies ContextSnapshot;
  const r0 = restoreInto(bare, snapFields, root);
  check('restoration: working set, todos, attachments and breakdown come back on a chat with no live state; changed files marked', r0?.workingSet === 2 && r0.todos === 1 && r0.attachments === 1 && r0.breakdown && bare.workingSet?.length === 2 && bare.todos?.[0].title === 'Fix a' && r0.changed.length === 2, r0);
  const live: Session = { ...bare, id: 's_live', workingSet: ['other.ts'], todos: [{ id: '9', title: 'live', status: 'done' }], attachments: [] };
  restoreInto(live, snapFields, undefined);
  check('restoration: live state always wins', live.workingSet?.[0] === 'other.ts' && live.todos?.[0].title === 'live');

  // ---- related ranking (pure)
  check('keywords: stop words out, identifiers and long words first', keywords('Why does the build fail with ECONNREFUSED on port 5432 when postgres starts?').slice(0, 3).join(',') === 'econnrefused,5432,postgres', keywords('Why does the build fail with ECONNREFUSED on port 5432 when postgres starts?'));
  const terms = ['econnrefused', 'postgres', 'docker'];
  const hits = [
    { term: 'econnrefused', id: 'a', title: 'DB down', updated_at: 5 }, { term: 'postgres', id: 'a', title: 'DB down', updated_at: 5 }, { term: 'docker', id: 'a', title: 'DB down', updated_at: 5 },
    { term: 'docker', id: 'b', title: 'Docker images', updated_at: 9 },
    { term: 'postgres', id: 'c', title: 'Schema', updated_at: 7 }, { term: 'docker', id: 'c', title: 'Schema', updated_at: 7 },
  ];
  const ranked = scoreRelated(terms, hits, 20);
  check('related: ranked by the weight of the request words they share; one shared word is not enough', ranked[0]?.id === 'a' && !ranked.some((r) => r.id === 'b') && ranked.length <= 3, ranked);
  check('related: the score threshold keeps weak matches out', scoreRelated(terms, hits, 20, { minScore: 0.99 }).length === 1 && scoreRelated(['x', 'y'], [], 5).length === 0);
  check('library: glob patterns (**, *, ?, {a,b})', globRegExp('src/**/*.ts').test('src/a/b/c.ts') && globRegExp('src/**/*.ts').test('src/c.ts') && !globRegExp('src/*.ts').test('src/a/c.ts') && globRegExp('docs/{a,b}.md').test('docs/b.md') && globRegExp('f?.js').test('f1.js'));
  check('library: items are cleaned (unknown kinds and empty refs dropped, snippets keep text)', cleanItems([{ kind: 'file', ref: ' a.ts ' }, { kind: 'bogus', ref: 'x' }, { kind: 'file', ref: '' }, { kind: 'snippet', ref: '', text: 'hello' }]).length === 2 && slugName('Release Process!') === 'release-process');
  check('#chat: blocks are capped at about 1,500 tokens', estimateTokens(capTokens('word '.repeat(5000), CHAT_REF_TOKENS)) <= CHAT_REF_TOKENS + 10);

  // ---- with a data root: library, related, history tools, memory policy, agent loop snapshots
  const dataRoot = tmp('root');
  const folder = tmp('proj');
  fs.mkdirSync(path.join(folder, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(folder, 'docs', 'release.md'), '# Release\n1. bump\n2. tag\n');
  fs.writeFileSync(path.join(folder, 'docs', 'notes.md'), 'notes');
  fs.writeFileSync(path.join(folder, 'package.json'), '{"name":"x"}');
  const rig = await openRig(dataRoot, tmp('store'), folder);
  const { c, store } = rig;
  const devDir = tmp('dev');
  const memory = new DiskMemory({ project: path.join(folder, '.localpilot', 'memory'), global: devDir });
  const att = c.attachMemoryStore(memory, { developerDir: devDir, projectFolders: () => [folder], watch: false });
  await att.refreshFolders();
  const workspace = new WorkspaceContext(log);
  const tools = new ToolRegistry();
  const runner = { contextHooks: undefined } as unknown as AgentRunner;
  const posted: { type: string; [k: string]: unknown }[] = [];
  const ctxD = attachContext(c, { runner, workspace, memory, tools, sink: { post: (m) => posted.push(m as never) }, defaultFolder: () => folder, log });
  const svc = c.context!;
  check('attachContext sets continuity.context, the agent hooks, the #context:/#chat: resolvers and the history tools', !!svc && !!runner.contextHooks?.beforeRequest && workspace.mentionResolvers.has('context') && workspace.mentionResolvers.has('chat') && !!tools.get('history_search') && !!tools.get('history_read'));

  // Library CRUD + resolution.
  const relId = await svc.library.create({ name: 'Release process', description: 'how we ship', projectId: await svc.projectOf(), items: [{ kind: 'file', ref: 'docs/release.md' }, { kind: 'glob', ref: 'docs/*.md' }, { kind: 'snippet', ref: 'checklist', text: 'run the smoke tests first' }, { kind: 'url', ref: 'https://example.invalid/runbook' }] });
  let sets = await svc.library.list({ projectId: await svc.projectOf() });
  check('library: a set is created (context_item entity) and listed for this project', sets.length === 1 && sets[0].id === relId && sets[0].items.length === 4, sets);
  let dup = '';
  await svc.library.create({ name: 'release process', items: [] }).catch((e: Error) => (dup = e.message));
  check('library: names are unique (case-insensitive)', /exists already/.test(dup), dup);
  const block = await workspace.readAttachment('#context:release-process');
  check('#context:<name> resolves through the workspace mention: files read, globs expanded, snippets inline, URLs not fetched', block.startsWith('<context_set name="Release process"') && block.includes('1. bump') && block.includes('<file path="docs/notes.md">') && block.includes('run the smoke tests first') && block.includes('not fetched') && !block.includes('local-only'), block.slice(0, 400));
  check('library: a glob expands to the matching files only', expandGlob(folder, 'docs/*.md').join() === 'docs/notes.md,docs/release.md' && expandGlob(folder, '**/*.json').join() === 'package.json');
  await svc.library.update(relId, { localOnly: true, items: [{ kind: 'file', ref: 'docs/release.md' }] });
  const block2 = await workspace.readAttachment('#context:release-process');
  check('library: edits apply; a local-only set is marked for the policy (and stripped for a cloud model)', block2.includes('local-only="true"') && !block2.includes('notes.md') && !applyPolicy([say('user', block2)], { remote: true }).messages[0].content.includes('1. bump'), block2.slice(0, 200));
  const missing = await workspace.readAttachment('#context:nope');
  check('#context: an unknown name says so (no crash)', /error="not found"/.test(missing));
  await svc.library.trash([relId]);
  sets = await svc.library.list({});
  const trashed = await svc.library.list({ trash: 'only' });
  check('library: Trash hides a set (and #context: no longer finds it); Restore brings it back', !sets.length && trashed.length === 1 && /not found/.test(await workspace.readAttachment('#context:release-process')));
  await svc.library.restore([relId]);
  check('library: restored', (await svc.library.list({})).length === 1);
  const versions = await c.index.versions('context_item', relId);
  check('library: every change is a version (create, patch, trash, restore)', versions.length >= 4 && ['create', 'patch', 'trash', 'restore'].every((op) => versions.some((v) => v.op === op)), versions.map((v) => v.op));

  // Earlier conversations: related suggestions, #chat:, history tools.
  const mk = async (title: string, msgs: ChatMessage[], tags?: string[]) => {
    const s = store.create('ollama/qwen', 'agent');
    s.title = title;
    s.messages.push(...msgs);
    store.save(s);
    await rig.settle(s);
    if (tags) {
      await c.conversations!.setTags([s.id], tags);
    }
    return s;
  };
  const dbChat = await mk('Postgres refuses connections', [say('user', 'The API fails with ECONNREFUSED 127.0.0.1:5432 after docker compose up'), say('assistant', 'Postgres was not listening: the postgres container exited. Restart it with docker compose up -d postgres.')]);
  const cssChat = await mk('Button colours', [say('user', 'Make the primary button amber'), say('assistant', 'Changed the CSS variable --primary to amber.')]);
  const secretChat = await mk('Production credentials', [say('user', 'Where is the postgres password for production? ECONNREFUSED again'), say('assistant', 'It is in the vault under secret/prod/postgres; docker reads it at start.')], ['local-only']);
  const longChat = await mk('Long investigation', Array.from({ length: 30 }, (_, i) => say(i % 2 ? 'assistant' : 'user', `step ${i} ${'detail '.repeat(400)}`)));
  const trashChat = await mk('Old postgres outage', [say('user', 'ECONNREFUSED postgres docker compose outage'), say('assistant', 'postgres docker restart fixed it')]);
  await c.conversations!.trash([trashChat.id]);
  await c.log.flush();
  await c.index.catchUp();
  const projectId = await svc.projectOf();
  const rel = await svc.related.suggest(projectId, 'Our API again says ECONNREFUSED when docker starts postgres', 'none');
  check('related: the conversation about the same failure comes first; unrelated ones are not offered', rel[0]?.id === dbChat.id && !rel.some((r) => r.id === cssChat.id) && rel.length <= 3, rel);
  check('related: conversations in Trash are never offered', !rel.some((r) => r.id === trashChat.id), rel.map((r) => r.title));
  check('related: a snippet shows where it matched', !!rel[0]?.snippet, rel[0]);
  check('related: nothing for a request with too few words', (await svc.related.suggest(projectId, 'hello', 'none')).length === 0);
  const chatBlk = await workspace.readAttachment(`#chat:${dbChat.id}`);
  check('#chat:<id> gives the first request and the last answer of that chat', chatBlk.includes('First request:') && chatBlk.includes('docker compose up -d postgres') && chatBlk.includes(`title="Postgres refuses connections"`), chatBlk);
  const bySlug = await workspace.readAttachment('#chat:button-colours');
  check('#chat:<title slug> finds the chat by its title', bySlug.includes('amber'), bySlug.slice(0, 200));
  const longBlk = await svc.related.chatBlock(longChat.id);
  check('#chat: a long chat is cut to about 1,500 tokens', estimateTokens(longBlk) <= CHAT_REF_TOKENS + 80 && /cut to fit/.test(longBlk), estimateTokens(longBlk));
  check('#chat: a chat tagged local-only is marked for the policy', (await svc.related.chatBlock(secretChat.id)).includes('local-only="true"'));
  const hsearch = tools.get('history_search')!;
  const hread = tools.get('history_read')!;
  const sres = await hsearch.execute({ query: 'ECONNREFUSED' }, toolCtx(cssChat.id));
  check('history_search: snippets with conversation ids; Trash left out', sres.content.includes(dbChat.id) && !sres.content.includes(trashChat.id) && /history_read/.test(sres.content), sres.content);
  check('history_search: hits of a local-only chat are marked (a cloud model gets a placeholder)', sres.content.includes(`<chat_hit id="${secretChat.id}"`) && !applyPolicy([say('tool', sres.content)], { remote: true }).messages[0].content.includes('secret/prod'), sres.content);
  const rres = await hread.execute({ conversation_id: longChat.id, from: 1, to: 40 }, toolCtx(cssChat.id));
  const shown = (rres.content.match(/^\[\d+\] /gm) ?? []).length;
  check(`history_read: at most ${READ_MAX_MESSAGES} messages and ${READ_TOTAL_CHARS.toLocaleString('en')} characters, with where to continue`, shown <= READ_MAX_MESSAGES && rres.content.length <= READ_TOTAL_CHARS + 2000 && /follow \(from: /.test(rres.content), { shown, len: rres.content.length });
  const rres2 = await hread.execute({ conversation_id: 'button-colours' }, toolCtx(dbChat.id));
  check('history_read: by title, requests and answers only', /\[1\] user/.test(rres2.content) && rres2.content.includes('amber'), rres2.content);
  check('history tools: read-only (offered in Ask and Plan mode)', !!hsearch.readOnly && !!hread.readOnly && !hsearch.approvalKind);

  // Memory marked local only stays out of a cloud prompt; the budget is unchanged for a local one.
  await memory.write('prod-access', 'ssh bastion.internal with the ops key', 'project');
  await memory.write('style', 'answer briefly', 'global');
  await c.memory!.sync();
  const note = (await c.memory!.list({})).find((r) => r.name === 'prod-access');
  await c.memory!.setLocalOnly([note!.id], true);
  await c.memory!.sync();
  const before = await memory.promptSection(4000);
  const sameLocal = await memory.promptSection(4000, { cloud: false });
  const excluded: { ref: string; reason: string }[] = [];
  const forCloud = await memory.promptSection(4000, { cloud: true, excluded });
  check('memory policy: a local model\'s memory section is byte-for-byte the same', before === sameLocal && before.includes('bastion'));
  check('memory policy: a cloud model\'s memory section has no local-only note, which is listed as excluded', !forCloud.includes('bastion') && forCloud.includes('answer briefly') && excluded.some((e) => e.ref === 'memory:prod-access' && e.reason === 'localOnly'), { forCloud, excluded });
  const mention = await workspace.readAttachment('#memory:prod-access').catch(() => '');
  check('#memory: of a local-only note is marked for the policy', mention.includes('local-only="true"') || !workspace.mentionResolvers.has('memory'), mention.slice(0, 120));

  // ---- the agent loop: snapshots per turn and around a compaction, the policy on the wire, the block, restoration
  const bodies: { model: string; text: string }[] = [];
  const srv = http.createServer(async (req, res) => {
    if (req.url?.endsWith('/models')) {
      return res.end(JSON.stringify({ data: [{ id: 'm1' }] }));
    }
    const body = JSON.parse(await readBody(req)) as { model: string; messages: { content: unknown }[] };
    bodies.push({ model: `${req.url?.split('/')[1]}/${body.model}`, text: JSON.stringify(body.messages) });
    res.setHeader('content-type', 'text/event-stream');
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Done.' } }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 50, completion_tokens: 2 } })}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
  const prevConfig = process.env.LP_CONFIG;
  process.env.LP_CONFIG = JSON.stringify({ providers: [{ id: 'loc', type: 'openai', baseUrl: `${url}/loc/v1` }, { id: 'cld', type: 'openai', baseUrl: `${url}/cld/v1`, cloud: true }], 'webSearch.enabled': false, 'memory.enabled': false, contextWindow: 4096, compactionThreshold: 0.5, 'compaction.strategy': 'basic' });
  const providers = new ProviderRegistry(log);
  try {
    const realRunner = new AgentRunner(providers, new ToolRegistry(), new SkillManager(log), workspace, log);
    realRunner.contextHooks = runner.contextHooks;
    const run = async (s: Session, text: string) => {
      const events: AgentEvent[] = [];
      const out = await realRunner.run({ session: s, userMessage: say('user', text), emit: (e) => events.push(e), signal: new AbortController().signal, workspaceRoot: folder, requestApproval: async () => true }).catch((e: Error) => `THREW ${e.message}`);
      store.save(s);
      await rig.settle(s);
      return { out, events };
    };
    const s1 = store.create('loc/m1', 'agent');
    s1.workingSet = ['docs/release.md'];
    s1.todos = [{ id: '1', title: 'Ship it', status: 'in_progress' }];
    const t1 = await run(s1, 'Tag the release please');
    let snaps = await svc.snapshots.list(s1.id);
    check('agent loop: one snapshot per turn (the last request), with model, window, items and the answer\'s id', t1.out === 'Done.' && snaps.length === 1 && snaps[0].phase === 'turn' && snaps[0].model === 'loc/m1' && snaps[0].window > 0 && snaps[0].remote === false && !!snaps[0].messageId && snaps[0].messageId === s1.messages[s1.messages.length - 1].meta?.id, { out: t1.out, snaps });
    check('agent loop: the snapshot keeps the working set, todos and file hashes', snaps[0].workingSet.includes('docs/release.md') && snaps[0].todos?.[0].title === 'Ship it' && !!snaps[0].fileHashes?.['docs/release.md']);
    check('the ring card gets the turn\'s items', posted.some((m) => m.type === 'contextItems' && m.sessionId === s1.id));
    const forMsg = await svc.snapshots.forMessage(snaps[0].messageId!, s1.id);
    check('"What did the model see?" finds the snapshot of an answer', forMsg?.id === snaps[0].id);

    // A long chat on a 4k window: compaction before the request -> snapshots before and after it.
    const s2 = store.create('loc/m1', 'agent');
    for (let i = 0; i < 12; i++) {
      s2.messages.push(say('user', `question ${i} ${'context '.repeat(120)}`), say('assistant', `answer ${i} ${'details '.repeat(120)}`));
    }
    store.save(s2);
    await rig.settle(s2);
    await run(s2, 'and now?');
    snaps = await svc.snapshots.list(s2.id);
    const phases = snaps.map((x) => x.phase);
    check('agent loop: a compaction records the context before and after it, plus the turn', phases.includes('before-compaction') && phases.includes('after-compaction') && phases.includes('turn'), phases);
    const pre = snaps.find((x) => x.phase === 'before-compaction')!;
    const post = snaps.find((x) => x.phase === 'after-compaction')!;
    check('compaction snapshots carry the compaction details; the after side is smaller', !!pre?.compaction && !!post?.compaction && post.usedTokens < pre.usedTokens, { pre: pre?.usedTokens, post: post?.usedTokens });

    // Policy on the wire: a local-only note attached, the chat switched to a cloud model.
    s1.model = 'cld/m1';
    bodies.length = 0;
    posted.length = 0;
    const secret = '<memory_note name="prod-access" type="project" local-only="true">\nssh bastion.internal\n</memory_note>';
    const realSend = await run(s1, `${secret}\nDeploy`);
    const sent = bodies.find((b) => b.model.startsWith('cld/'));
    check('cloud model: the local-only block never reaches the request (a placeholder does)', !!sent && !sent.text.includes('bastion.internal') && sent.text.includes('local only') && realSend.out === 'Done.', sent?.text.slice(0, 300));
    check('cloud model: the chat keeps its own copy of the message', s1.messages.some((m) => m.content.includes('bastion.internal')));
    check('local -> cloud: the notice is posted once for the chat', posted.filter((m) => m.type === 'contextNotice' && m.kind === 'cloud').length === 1, posted.map((m) => m.type));
    snaps = await svc.snapshots.list(s1.id);
    check('the cloud turn\'s snapshot lists what was excluded and is marked remote', snaps[0].remote === true && !!snaps[0].excluded?.some((e) => e.ref === 'memory:prod-access'), snaps[0].excluded);
    posted.length = 0;
    await run(s1, 'and again');
    check('the notice is not repeated', !posted.some((m) => m.type === 'contextNotice'));
    // A local model gets everything.
    s1.model = 'loc/m1';
    bodies.length = 0;
    await run(s1, `${secret}\nDeploy locally`);
    check('local model: the same block is sent as is', bodies.some((b) => b.model.startsWith('loc/') && b.text.includes('bastion.internal')));
    // A conversation tagged local-only is refused for a cloud model.
    await c.conversations!.setTags([s1.id], ['local-only']);
    svc.forgetTags([s1.id]);
    s1.model = 'cld/m1';
    bodies.length = 0;
    const blocked = await run(s1, 'Deploy from the cloud');
    check('a conversation tagged local-only is never sent to a cloud model (the turn reports why)', /THREW .*tagged "local-only"/.test(blocked.out) && !bodies.some((b) => b.model.startsWith('cld/')) && blocked.events.some((e) => e.type === 'error'), blocked.out);

    // Restoration: a chat re-materialised from the log gets its context back; files changed since are marked.
    fs.writeFileSync(path.join(folder, 'docs', 'release.md'), '# Release\n1. bump\n2. tag\n3. announce\n');
    const mat = await c.conversations!.materialize(s1.id);
    check('restoration (materialise): working set and todos come back from the latest snapshot', !!mat && (mat.session.workingSet ?? []).includes('docs/release.md') && mat.session.todos?.[0]?.title === 'Ship it', mat?.session.workingSet);
    const fresh = { ...mat!.session, workingSet: [], todos: undefined };
    // A new process (VS Code restarted): its own ContextService has not seen the chat run.
    const later = new ContextService({ log: c.log, index: c.index, retention: c.retention, load: async (id) => (await c.conversations!.materialize(id))?.session, projectOf: () => svc.projectOf() });
    const restored = await later.restore(fresh, folder);
    check('restoration (reopen): files changed since the last run are marked', !!restored && restored.changed.some((x) => x.path === 'docs/release.md' && x.state === 'changed'), restored);
    check('restoration: the next turn hears about them once', /docs\/release\.md/.test(later.turnNote(s1.id) ?? '') && later.turnNote(s1.id) === undefined);

    // Model switch: a smaller window means a compaction before the next request.
    const big = { ...s1, contextTokens: 30_000 };
    const small = { id: 'loc/tiny', name: 'Tiny', contextWindow: 8192 } as ModelInfo;
    check('model switch: a context bigger than the new window is announced (compacted before the next request)', /compact|summarised/i.test(modelSwitchNotice(big, small) ?? '') && modelSwitchNotice({ ...s1, contextTokens: 100 }, small) === undefined);

    // Purge: what the model saw in a conversation goes with it.
    await c.conversations!.trash([s2.id]);
    await c.conversations!.purge([s2.id]);
    await c.log.flush();
    await c.index.catchUp();
    check('purging a conversation removes its context snapshots from the index', (await svc.snapshots.list(s2.id)).length === 0);
  } finally {
    providers.dispose();
    srv.close();
    if (prevConfig === undefined) {
      delete process.env.LP_CONFIG;
    } else {
      process.env.LP_CONFIG = prevConfig;
    }
    ctxD.dispose();
    att.dispose();
    await rig.dispose();
  }
}
