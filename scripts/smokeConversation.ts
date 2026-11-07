/**
 * Smoke checks (bundled into scripts/smoke.ts) for the continuity CONVERSATION module: the SessionBridge's diffing
 * (append, finalise, rewind -> branch, edit -> branch, compaction keeps, trash, retention -> archive), materialise
 * round trips, projects after a moved folder, export formats and JSON re-import, secure share (seal/open, wrong code,
 * redaction), merge, navigator counts. Temp dirs only, a real SessionStore over the vscode stub; no network.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { execFileSync } from 'child_process';
import { Continuity } from '../src/continuity/continuity';
import { memorySecretBox } from '../src/continuity/data/crypto/secretBox';
import { SessionStore } from '../src/sessions/sessionStore';
import type { ChatMessage, Session } from '../src/types';
import type { EventEnvelope } from '../src/continuity/events';
import { viewOfPath } from '../src/continuity/conversation/sessionBridge';
import { exportAs, exportFileName, parseExport } from '../src/continuity/conversation/export';
import { createShare, findSecrets, formatCode, openShare, redactSecrets, WrongShareCodeError } from '../src/continuity/conversation/share';
import { extractSummary, mergeSessions } from '../src/continuity/conversation/merge';
import { ProjectResolver } from '../src/continuity/conversation/projects';
import { legacyMessageId } from '../src/continuity/conversation/payloads';
import { Migration } from '../src/continuity/data/migration';
import { makeFixture } from '../src/test/fixtures/continuityFixtures';

type Check = (name: string, cond: boolean, detail?: unknown) => void;
const tmp = (p: string) => fs.mkdtempSync(path.join(os.tmpdir(), `lp-conv-${p}-`));
const quiet = { info: () => undefined, warn: () => undefined, error: () => undefined };
const log = { ...quiet, debug: () => undefined, trace: () => undefined } as unknown as import('vscode').LogOutputChannel;
const settings = () => ({ dataDir: '', trashRetentionDays: 30, historyDays: 90, indexMaxMB: 256, backup: { enabled: false, intervalDays: 7, keep: 4 } });

export interface Rig {
  c: Continuity;
  store: SessionStore;
  /** Writes pending saves, lets the bridge log them, and brings the index up to date. */
  settle(...sessions: Session[]): Promise<void>;
  dispose(): Promise<void>;
}

export async function openRig(root: string, storage: string, folder?: string, beforeAttach?: (c: Continuity) => Promise<void>): Promise<Rig> {
  const c = await Continuity.open({ dataDir: root, writer: 'cli', appVersion: 'test', secrets: memorySecretBox(), log: quiet, settings, wasmPath: process.env.LOCALPILOT_SQLJS_WASM ?? '', workerPath: '', inProcessIndex: true, schedules: false, autoMigrate: false, flushMs: 5 });
  await c.ready;
  await beforeAttach?.(c);
  const store = new SessionStore({ storageUri: vscode.Uri.file(storage) } as unknown as import('vscode').ExtensionContext, log);
  await store.load();
  c.attachSessionStore(store, { defaultFolder: () => folder });
  const settle = async (...sessions: Session[]) => {
    for (const s of sessions) {
      if (store.has(s.id)) {
        await store.flush(store.get(s.id)!);
      }
    }
    await c.bridge!.settle();
    for (const s of sessions) {
      if (store.has(s.id)) {
        await store.flush(store.get(s.id)!);
      }
    }
    await c.log.flush();
    await c.index.catchUp();
  };
  return { c, store, settle, dispose: async () => { store.dispose(); await c.dispose(); } };
}

const say = (role: ChatMessage['role'], content: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({ role, content, meta: { timestamp: Date.now() }, ...extra });
const ids = (s: Session) => s.messages.map((m) => m.meta?.id);

export async function conversationSmoke(check: Check): Promise<void> {
  console.log('\n[continuity: conversations — bridge, branches, materialise]');
  const root = tmp('root');
  const folder = tmp('proj');
  const r = await openRig(root, tmp('ws'), folder);
  const { c, store } = r;
  const mgr = c.conversations!;
  check('attachSessionStore sets the manager and the store bridge', !!mgr && !!store.bridge);

  // Append + finalise.
  const s = store.create('ollama/qwen', 'agent');
  s.messages.push(say('user', 'Why does the build fail with ECONNREFUSED?'));
  store.save(s);
  await r.settle(s);
  s.messages.push(say('assistant', 'Partial'));
  store.save(s);
  await r.settle(s);
  s.messages[1].content = 'Postgres is not running. Start it with `docker compose up -d db`.';
  store.save(s);
  await r.settle(s);
  let row = await c.index.conversation(s.id);
  let path1 = await c.index.messages(s.id);
  check('append: the conversation and both messages are in the index', !!row && path1.length === 2 && path1.map((m) => m.id).join() === ids(s).join(), { row, path1 });
  check('every message got a stable id (m_…)', s.messages.every((m) => /^m_/.test(m.meta?.id ?? '')));
  check('the JSON carries the log clock (meta.lastHlc)', !!s.meta?.lastHlc);
  const mat1 = await mgr.materialize(s.id);
  check('finalise: the patched answer is what materialise reads back', mat1?.session.messages[1].content === s.messages[1].content, mat1?.session.messages[1].content);
  const hits = await mgr.search('docker');
  check('search finds the finalised answer', hits.some((h) => h.conversationId === s.id && /docker/.test(h.snippet)), hits);

  // Regenerate: rewind the answer and answer again -> new branch, old kept.
  const firstAnswer = s.messages[1].meta!.id!;
  s.messages = s.messages.slice(0, 1);
  store.hint(s.id, 'regenerate');
  store.save(s);
  await r.settle(s);
  s.messages.push(say('assistant', 'Another answer: the database container is stopped.'));
  store.save(s);
  await r.settle(s);
  let br = await mgr.branches(s.id);
  const regen = br.branches.find((b) => b.reason === 'regenerate');
  check('rewind + new answer: a regenerate branch, the old branch kept', br.branches.length === 2 && !!regen && br.active === regen.id, br);
  const sib = br.siblings[s.messages[1].meta!.id!];
  check('the switcher sees 2 answers to the same request (2/2)', !!sib && sib.total === 2 && sib.index === 2 && sib.ids.includes(firstAnswer), sib);
  const cmp = await mgr.compare(s.id, s.messages[1].meta!.id!);
  check('compare returns both answers with their text', cmp.length === 2 && cmp.some((x) => x.text.includes('Postgres')) && cmp.some((x) => x.current), cmp);

  // Switch back to the first branch: the live chat shows it, no new branch.
  const back = await mgr.stepSibling(s.id, s.messages[1].meta!.id!, -1);
  await r.settle(s);
  br = await mgr.branches(s.id);
  check('stepping the switcher switches branch in place (no new branch)', back?.messages[1].meta?.id === firstAnswer && br.branches.length === 2 && br.active !== regen?.id, { br, ids: back && ids(back) });

  // Edit the prompt -> an edit branch.
  const live = store.get(s.id)!;
  live.messages = [say('user', 'Why does the build fail with ECONNRESET?')];
  store.hint(s.id, 'edit');
  store.save(live);
  live.messages.push(say('assistant', 'A peer closed the connection.'));
  store.save(live);
  await r.settle(live);
  br = await mgr.branches(s.id);
  check('edit: a third branch with reason edit; the first user message has a sibling', br.branches.length === 3 && br.branches.some((b) => b.reason === 'edit') && !!br.siblings[live.messages[0].meta!.id!], br);
  const roundTrip = await mgr.materialize(s.id);
  check('materialise round trip: same ids, roles and text as the live chat', JSON.stringify(roundTrip?.session.messages.map((m) => [m.meta?.id, m.role, m.content])) === JSON.stringify(live.messages.map((m) => [m.meta?.id, m.role, m.content])), roundTrip?.session.messages);

  // Compaction: [summary, kept…, new] — the log keeps everything, the view matches the chat.
  const c2 = store.create('ollama/qwen', 'agent');
  for (let i = 0; i < 4; i++) {
    c2.messages.push(say('user', `step ${i}`), say('assistant', `done ${i}`));
  }
  store.save(c2);
  await r.settle(c2);
  const kept = c2.messages.slice(6).map((m) => ({ ...m, meta: { ...m.meta, archived: 6 } }));
  c2.messages = [say('user', '<conversation_summary>\nsteps 0-2 done\n</conversation_summary>', { meta: { summary: true, timestamp: Date.now() } }), ...kept];
  store.save(c2);
  await r.settle(c2);
  c2.messages.push(say('user', 'step 4'));
  store.save(c2);
  await r.settle(c2);
  const full = await c.index.messages(c2.id);
  const m2 = await mgr.materialize(c2.id);
  check('compaction: the log path keeps all 8 originals plus the summary and the new message', full.length === 10, full.length);
  check('compaction: the materialised view is [summary, kept, new] like the chat', JSON.stringify(m2?.session.messages.map((m) => m.meta?.id)) === JSON.stringify(ids(c2)), { mat: m2?.session.messages.map((m) => m.content), live: c2.messages.map((m) => m.content) });
  check('viewOfPath: no keeps = the path', viewOfPath(['a', 'b'], new Map()).join() === 'a,b' && viewOfPath(['a', 'b', 'S', 'c'], new Map([['S', ['b']]])).join() === 'S,b,c');

  // Trash, counts, restore.
  let counts = await mgr.counts();
  const before = counts.all;
  await mgr.trash([c2.id]);
  counts = await mgr.counts();
  check('trash: the chat leaves the store and All, Trash counts it', !store.has(c2.id) && counts.trash === 1 && counts.all === before - 1, counts);
  const trashPage = await mgr.list({ view: 'trash' });
  check('the Trash view lists it', trashPage.rows.some((x) => x.id === c2.id));
  await mgr.restore([c2.id]);
  counts = await mgr.counts();
  check('restore: back in the store with every message, Trash empty', store.has(c2.id) && store.get(c2.id)!.messages.length === c2.messages.length && counts.trash === 0, { counts, n: store.get(c2.id)?.messages.length });

  // Flags and tags.
  await mgr.setFlags([s.id], { favorite: true });
  await mgr.setTags([s.id], ['Bug Fix', 'db']);
  counts = await mgr.counts();
  row = await c.index.conversation(s.id);
  check('favorite + tags: counts and row', counts.favorites === 1 && !!row?.favorite && row.tags.includes('bug-fix') && row.tags.includes('db'), { counts, row });
  const tagged = await mgr.list({ tag: 'db' });
  check('list by tag', tagged.rows.length === 1 && tagged.rows[0].id === s.id);
  const inline = await mgr.search('is:favorite tag:db');
  check('inline filters search (is:favorite tag:db)', inline.some((h) => h.conversationId === s.id), inline);
  // A save of the chat afterwards must not reset the navigator's fields.
  const again = store.get(s.id)!;
  again.title = 'Renamed by the chat';
  store.save(again);
  await r.settle(again);
  row = await c.index.conversation(s.id);
  check('a later save keeps favorite and tags (the chat owns only its own fields)', !!row?.favorite && row.tags.length === 2 && row.title === 'Renamed by the chat', row);

  // Versions: restore the old title.
  const v = await mgr.versions(s.id);
  const firstTitle = [...v.versions].reverse().find((x) => x.fields && typeof x.fields.title === 'string');
  await mgr.restoreVersion(s.id, firstTitle!.hlc);
  row = await c.index.conversation(s.id);
  check('restoreVersion puts the earlier title back as a new patch', row?.title === firstTitle?.fields?.title && (await mgr.versions(s.id)).versions.length > v.versions.length, { row: row?.title, want: firstTitle?.fields?.title });

  // Duplicate and continue-from.
  const dup = await mgr.duplicate(s.id, store.get(s.id)!.messages[0].meta!.id);
  await r.settle(dup!);
  check('duplicate: a new chat with copies (new ids, copiedFrom)', !!dup && dup.messages.length === 1 && dup.messages[0].meta?.id !== store.get(s.id)!.messages[0].meta?.id && dup.messages[0].meta?.copiedFrom === store.get(s.id)!.messages[0].meta?.id && dup.parentId === s.id);
  const firstMsg = store.get(s.id)!.messages[0].meta!.id!;
  const cont = await mgr.continueFrom(s.id, firstMsg);
  await r.settle(cont!);
  br = await mgr.branches(s.id);
  check('continue from a message: a continue branch, the chat shows the path up to it', cont?.messages.length === 1 && br.branches.some((b) => b.reason === 'continue' && b.id === br.active), { n: cont?.messages.length, br });

  // Retention archives instead of deleting.
  const olds: Session[] = [];
  for (let i = 0; i < 3; i++) {
    const o = store.create('m', 'ask');
    o.messages.push(say('user', `old question ${i}`));
    store.save(o);
    olds.push(o);
  }
  await r.settle(...olds);
  const n = await store.prune(1, [s.id, c2.id, dup!.id]);
  await r.settle();
  counts = await mgr.counts();
  check('retention: the oldest idle chats go to Archived, not away', n >= 2 && counts.archived >= 2 && counts.trash === 0, { n, counts });
  const reopened = await mgr.load(olds[0].id);
  check('an archived chat opens again from the log', !!reopened && reopened.messages[0].content === 'old question 0');

  // Purge: gone from the index, the cleanup ran.
  await mgr.trash([olds[1].id]);
  await mgr.purge([olds[1].id]);
  counts = await mgr.counts();
  check('purge: gone everywhere', !(await c.index.conversation(olds[1].id)) && counts.trash === 0, counts);

  // Undo of a delete through the controller path (store.delete).
  await store.delete(dup!.id);
  await r.settle();
  check('store.delete goes to Trash (not gone)', (await mgr.counts()).trash === 1);
  await mgr.restore([dup!.id]);
  check('Undo brings it back', store.has(dup!.id));

  // Merge.
  const mg = await mgr.merge(s.id, c2.id);
  await r.settle(mg!);
  const mrow = await c.index.conversation(mg!.id);
  check('merge: a new chat with A, a summary of B, mergedFrom', !!mg && mg.messages.some((m) => /merged_conversation/.test(m.content)) && !!mrow, mrow);
  check('extractSummary uses B\'s request and outcome', /Request: step 0/.test(extractSummary(c2)) || /steps 0-2 done/.test(extractSummary(c2)), extractSummary(c2));
  const ms = mergeSessions(store.get(s.id)!, c2, 'SUM');
  check('mergeSessions copies A (new ids, copiedFrom)', ms.messages.slice(0, -2).every((m) => !m.meta?.id && !!m.meta?.copiedFrom) && ms.mergedFrom.length === 2);

  // Migrated chat saved again by the bridge: no duplicate messages.
  console.log('\n[continuity: conversations — migration ids, projects, export, share]');
  const legacy: Session = { id: 's_legacy1', title: 'From 1.6', createdAt: 1, updatedAt: 2, model: 'm', mode: 'ask', messageCount: 2, messages: [say('user', 'hello'), say('assistant', 'hi')], contextTokens: 0, compactions: 0, attachments: [] };
  for (const [i, m] of legacy.messages.entries()) {
    c.log.append('message', legacyMessageId(legacy.id, m, i), 'create', { conversationId: legacy.id, branchId: `br_${legacy.id}`, ...(i ? { parentId: legacyMessageId(legacy.id, legacy.messages[0], 0) } : {}), role: m.role, parts: [{ kind: 'text', text: m.content }], meta: {}, createdAt: 1 });
  }
  c.log.append('conversation', legacy.id, 'create', { title: 'From 1.6', model: 'm', mode: 'ask', pinned: false, favorite: true, archived: false, tags: { kept: true }, activeBranchId: `br_${legacy.id}`, createdAt: 1 });
  c.log.append('branch', `br_${legacy.id}`, 'create', { conversationId: legacy.id, createdAt: 1 });
  await c.log.flush();
  await c.index.catchUp();
  store.importRemote(structuredClone({ ...legacy, meta: undefined }));
  const lg = store.get(legacy.id)!;
  lg.meta = undefined;
  lg.messages.push(say('user', 'and now?'));
  store.save(lg);
  await r.settle(lg);
  const lpath = await c.index.messages(legacy.id);
  const lrow = await c.index.conversation(legacy.id);
  check('a 1.6 chat saved again keeps its migrated message ids (no duplicates)', lpath.length === 3 && lpath[0].id === legacyMessageId(legacy.id, legacy.messages[0], 0) && (lrow?.messageCount ?? 0) === 3, lpath.map((x) => x.id));
  check('…and its favorite and tags from the log', !!lrow?.favorite && lrow.tags.includes('kept'), lrow);

  // A migrated compacted chat (summary + kept copy) saved again: no new branch, the same messages.
  {
    const fx = makeFixture();
    const mroot = tmp('mig');
    const ws = tmp('migws');
    fs.cpSync(path.join(fx.sources.vscodeStorage!, 'sessions'), path.join(ws, 'sessions'), { recursive: true });
    // In the product the bridge waits for the automatic import (Continuity.migrated); here the import runs first.
    const mr = await openRig(mroot, ws, fx.projectFolder, async (c0) => {
      await new Migration({ root: mroot, log: c0.log, blobs: c0.blobs, sources: fx.sources, logger: quiet }).run();
      await c0.log.flush();
      await c0.index.catchUp();
    });
    await mr.c.bridge!.settle();
    const before = (await mr.c.index.messages(fx.ids.archivedChat)).length;
    const ch = mr.store.get(fx.ids.archivedChat)!;
    ch.messages.push(say('user', 'one more'));
    mr.store.save(ch);
    await mr.settle(ch);
    const mb = await mr.c.conversations!.branches(fx.ids.archivedChat);
    const after = await mr.c.index.messages(fx.ids.archivedChat);
    check('a migrated compacted chat saved again: one branch, one new message, ids kept', mb.branches.length === 1 && after.length === before + 1 && ch.messages[1].meta?.id === after[2].id, { branches: mb.branches.length, before, after: after.length });
    const view = await mr.c.conversations!.materialize(fx.ids.archivedChat);
    check('…and it materialises as [summary, kept, …] (migration recorded the keeps)', JSON.stringify(view?.session.messages.map((m) => m.meta?.id)) === JSON.stringify(ids(ch)), view?.session.messages.map((m) => m.content));
    await mr.dispose();
  }

  // Projects: a moved git repository keeps its project.
  const repo = path.join(tmp('repo'), 'api');
  fs.mkdirSync(repo, { recursive: true });
  let gitOk = true;
  try {
    const g = (...a: string[]) => execFileSync('git', ['-C', repo, ...a], { stdio: 'ignore' });
    g('init', '-q');
    g('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--allow-empty', '-q', '-m', 'root');
    g('remote', 'add', 'origin', 'https://user:token@GitHub.com/Org/Api.git');
  } catch {
    gitOk = false;
  }
  const pr = new ProjectResolver({ log: c.log, index: c.index, ready: c.ready });
  const p1 = await pr.resolve(repo);
  await c.log.flush();
  await c.index.catchUp();
  const moved = path.join(tmp('moved'), 'api-renamed');
  fs.renameSync(repo, moved);
  const pr2 = new ProjectResolver({ log: c.log, index: c.index, ready: c.ready });
  const p2 = await pr2.resolve(moved);
  if (gitOk) {
    check('projects: a moved git repo (same remote + root commit) is the same project, re-pointed', p1.id === p2.id && p2.path === moved, { p1, p2 });
  } else {
    check('projects: (git unavailable) a moved folder gets a new project until "This is the same project"', p1.id !== p2.id);
  }
  const plain = tmp('plain');
  const q1 = await pr.resolve(plain);
  await c.log.flush();
  await c.index.catchUp();
  const plainMoved = path.join(tmp('plainmv'), path.basename(plain));
  fs.renameSync(plain, plainMoved);
  const q2 = await new ProjectResolver({ log: c.log, index: c.index, ready: c.ready }).resolve(plainMoved);
  await c.log.flush();
  await c.index.catchUp();
  const sugg = await pr2.suggestions(plainMoved);
  check('projects: a moved folder without git is only suggested (same name, folder gone)', q1.id !== q2.id && sugg.some((x) => x.id === q1.id), { q1, q2, sugg });
  await pr2.repoint(q1.id, plainMoved);
  await c.log.flush();
  await c.index.catchUp();
  const after = (await pr2.list()).find((x) => x.id === q1.id);
  check('repoint: "This is the same project" points the old project at the new folder', after?.path === plainMoved, after);

  // Export formats and JSON re-import.
  const ex = await mgr.exportText(s.id, 'json');
  const doc = parseExport(ex!.text);
  check('export JSON: schema, session and other branches', doc.schema === 'localpilot-conversation/v1' && doc.session.messages.length > 0 && (doc.branches?.length ?? 0) >= 1, { branches: doc.branches?.length });
  const md = await mgr.exportText(s.id, 'markdown');
  const html = await mgr.exportText(s.id, 'html');
  const pdf = await mgr.exportText(s.id, 'pdf');
  check('export Markdown / HTML / print-ready HTML', /^# /.test(md!.text) && /<!DOCTYPE html>/.test(html!.text) && /@media print/.test(pdf!.text) && pdf!.ext === 'print.html');
  check('export file names are safe and unique', exportFileName('a/b:c', 'md', new Set(['a-b-c.md'])) === 'a-b-c-2.md');
  const imported = mgr.importText(ex!.text);
  await r.settle(imported);
  check('JSON re-import: a new chat (new id), messages logged with new ids', imported.id !== s.id && imported.messages.length === doc.session.messages.length && !!(await c.index.conversation(imported.id)) && imported.messages.every((m) => !!m.meta?.copiedFrom), imported.id);

  // Share.
  const secretChat: Session = { ...structuredClone(store.get(s.id)!), messages: [say('user', 'my key is AKIAIOSFODNN7EXAMPLE and ghp_abcdefghijklmnopqrstuvwxyz0123456789 ok')] };
  const found = findSecrets(secretChat);
  const red = redactSecrets(secretChat);
  check('share: secrets are found and redacted', found.length >= 1 && red.redacted >= 1 && !/ghp_abcdef/.test(red.session.messages[0].content), { found, text: red.session.messages[0].content });
  const sh = createShare(red.session);
  check('share code: 52 base32 chars', /^[A-Z2-7]{52}$/.test(sh.code), sh.code);
  const opened = openShare(sh.data, formatCode(sh.code).toLowerCase());
  check('openShare with the code (dashes, any case) gives the conversation back', opened.session.messages[0].content === red.session.messages[0].content);
  let wrong = false;
  try {
    openShare(sh.data, sh.code.replace(/^./, sh.code[0] === 'A' ? 'B' : 'A'));
  } catch (e) {
    wrong = e instanceof WrongShareCodeError;
  }
  check('a wrong share code is refused', wrong);
  const fromShare = mgr.importDoc(opened, 'share');
  await r.settle(fromShare);
  await new Promise((res) => setTimeout(res, 50));
  await r.settle();
  check('a share opens as a new chat with origin share', (await c.index.conversation(fromShare.id))?.origin === 'share');

  // Export of a markdown helper stays the same as 1.6.
  check('exportAs markdown equals SessionStore.exportMarkdown', exportAs('markdown', store.get(s.id)!).text === (await store.exportMarkdown(s.id)));

  // Remote change: another process (a second rig on the same data root) continues the chat.
  console.log('\n[continuity: conversations — remote change from another process]');
  const other = await openRig(root, tmp('ws2'), folder);
  const remoteSeen: string[] = [];
  mgr.onRemoteChange((ch) => remoteSeen.push(`${ch.id}:${ch.applied}`));
  const theirs = await other.c.conversations!.load(c2.id);
  theirs!.messages.push(say('assistant', 'continued in the CLI'));
  other.store.save(theirs!);
  await other.settle(theirs!);
  await c.index.catchUp();
  for (let i = 0; i < 40 && !remoteSeen.length; i++) {
    await new Promise((res) => setTimeout(res, 50));
  }
  check('a chat continued by another process is reloaded here (not in use)', remoteSeen.includes(`${c2.id}:true`) && store.get(c2.id)!.messages.at(-1)?.content === 'continued in the CLI', remoteSeen);
  await other.dispose();
  await r.dispose();
  await crossDevice(check);
}

/** What sync does, without a backend: this device's own streams copied into the other device's log. */
async function ship(from: Rig, to: Rig): Promise<void> {
  await from.c.log.flush();
  for (const st of await from.c.log.streams()) {
    if (st.own) {
      const evs: EventEnvelope[] = [];
      for await (const e of from.c.log.read(st.id)) {
        evs.push(e);
      }
      await to.c.log.importRemote(st.id, evs);
    }
  }
  await to.c.index.catchUp();
  // What a window or `localpilot history` does on start; also what the index notice triggers on its own.
  await to.c.conversations!.refreshStale();
  await to.c.conversations!.adoptRemote();
}

/**
 * Two devices (own data roots and device ids), the same git repository cloned at different paths: a chat started on
 * one is listed and continued on the other, and Trash, Restore and Delete on either reach the other's chat list.
 */
async function crossDevice(check: Check): Promise<void> {
  console.log('\n[continuity: conversations — continue on another device]');
  const repoA = path.join(tmp('devA'), 'app');
  const repoB = path.join(tmp('devB'), 'app-clone');
  try {
    fs.mkdirSync(repoA, { recursive: true });
    const g = (cwd: string, ...a: string[]) => execFileSync('git', ['-C', cwd, ...a], { stdio: 'ignore' });
    g(repoA, 'init', '-q');
    g(repoA, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--allow-empty', '-q', '-m', 'root');
    g(repoA, 'remote', 'add', 'origin', 'https://github.com/example/app.git');
    execFileSync('git', ['clone', '-q', repoA, repoB], { stdio: 'ignore' });
    g(repoB, 'remote', 'set-url', 'origin', 'https://github.com/example/app.git');
  } catch {
    check('cross-device: git is available for the fixture', false);
    return;
  }
  const a = await openRig(tmp('rootA'), tmp('wsA'), repoA);
  const b = await openRig(tmp('rootB'), tmp('wsB'), repoB);
  try {
    check('cross-device: two devices', a.c.log.device.deviceId !== b.c.log.device.deviceId);
    const s = a.store.create('ollama/qwen', 'ask');
    s.messages.push(say('user', 'Reply with the code word'), say('assistant', 'PELICAN'));
    a.store.save(s);
    await a.settle(s);
    check('a chat saved once before its project was resolved still gets the project', !!(await a.c.index.conversation(s.id))?.projectId);
    await ship(a, b);
    check('a chat started on another device is in this chat list (same repo, other path)', b.store.has(s.id) && b.store.get(s.id)!.messages.length === 2, b.store.list().map((x) => x.id));
    const onB = b.store.get(s.id)!;
    onB.messages.push(say('user', 'And again?'), say('assistant', 'PELICAN again'));
    b.store.save(onB);
    await b.settle(onB);
    await ship(b, a);
    check('continuing it there updates the chat here', a.store.get(s.id)?.messages.at(-1)?.content === 'PELICAN again', a.store.get(s.id)?.messages.map((m) => m.content));
    await a.c.conversations!.trash([s.id]);
    await a.settle();
    await ship(a, b);
    check('Trash on one device takes the chat out of the other chat list', !b.store.has(s.id) && !!(await b.c.index.conversation(s.id))?.trashedAt);
    await b.c.conversations!.restore([s.id]);
    await b.settle();
    check('Restore there brings it back to that chat list', b.store.has(s.id) && b.store.get(s.id)!.messages.length === 4);
    await ship(b, a);
    check('and to this one', a.store.has(s.id) && a.store.get(s.id)!.messages.length === 4);
    await a.c.conversations!.purge([s.id]);
    await a.settle();
    await ship(a, b);
    check('Delete for good on one device removes it from the other', !b.store.has(s.id) && !(await b.c.index.conversation(s.id)));
    const fresh = b.store.create('ollama/qwen', 'ask');
    fresh.messages.push(say('user', 'not indexed yet'));
    b.store.save(fresh);
    await b.c.conversations!.refreshStale();
    check('a local chat the index has not caught up with is left alone', b.store.has(fresh.id));
  } finally {
    await a.dispose();
    await b.dispose();
  }
}
