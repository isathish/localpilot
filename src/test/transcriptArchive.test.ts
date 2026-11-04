import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { ContextManager } from '../context/contextManager';
import { SessionStore } from '../sessions/sessionStore';
import { archiveCompaction, carryArchiveMarks, messagesToArchive, rebuildBefore } from '../sessions/transcriptArchive';
import { ChatMessage, LLMProvider, ModelInfo } from '../types';

const log = vscode.window.createOutputChannel('LocalPilot test', { log: true });
const model: ModelInfo = { id: 'p/m', providerId: 'p', modelId: 'm', name: 'm', contextWindow: 8192, maxOutputTokens: 1024, supportsTools: true, supportsVision: false };
const noModel = { id: 'p', type: 'ollama', async *chat() { throw new Error('basic compaction must not call the model'); } } as unknown as LLMProvider;

function turn(i: number): ChatMessage[] {
  return [
    { role: 'user', content: `request ${i}` },
    { role: 'assistant', content: '', toolCalls: [{ id: `c${i}`, name: 'read_file', arguments: JSON.stringify({ path: `file${i}.ts` }) }] },
    { role: 'tool', toolCallId: `c${i}`, toolName: 'read_file', content: `original body of file${i} ${'x'.repeat(600)}` },
    { role: 'assistant', content: `done with ${i}` },
  ];
}

suite('Transcript archive (compaction keeps the originals)', () => {
  test('archive marks follow pruned copies and the archive rebuilds what came before', () => {
    const before = [...turn(1), ...turn(2)];
    const fresh = messagesToArchive(before);
    assert.strictEqual(fresh.length, 8);
    fresh.forEach((m, i) => (m.meta = { ...m.meta, archived: i }));
    const after: ChatMessage[] = [{ role: 'user', content: 'summary', meta: { summary: true } }, { ...before[6], meta: { ...before[6].meta } }, before[7]];
    delete after[1].meta!.archived;
    carryArchiveMarks(before, after);
    assert.deepStrictEqual(after.map((m) => m.meta?.archived), [undefined, 6, 7]);
    const records = before.map((m, i) => ({ seq: i, compaction: 0, at: 0, message: m }));
    assert.deepStrictEqual(rebuildBefore(records, 4)?.map((m) => m.content), before.slice(0, 4).map((m) => m.content));
    assert.strictEqual(rebuildBefore(records.slice(1), 4), undefined, 'a gap means the summary has to do');
    assert.strictEqual(rebuildBefore([], 4), undefined);
  });

  test('editing a message from before a compaction brings the original messages back; delete removes the archive', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lp-archive-'));
    const store = new SessionStore({ storageUri: vscode.Uri.file(dir) } as vscode.ExtensionContext, log);
    await store.load();
    try {
      const s = store.create('m');
      for (let i = 1; i <= 6; i++) {
        s.messages.push(...turn(i));
      }
      const original = structuredClone(s.messages);
      const cm = new ContextManager({ compactionThreshold: 0.5, maxToolOutputChars: 1000, keepRecent: 4, strategy: 'basic' });
      const pruned = cm.pruneToolOutputs(s.messages, 0).messages;
      const res = await cm.compact(pruned, noModel, model);
      assert.ok(res.removed > 0);
      archiveCompaction(store, s.id, s.compactions, s.messages, res.messages);
      s.messages = res.messages;
      s.compactions++;
      s.messages.push(...turn(7));

      // The tail kept verbatim is marked; turn 6's request sits right after the summary.
      const idx = s.messages.findIndex((m) => m.content === 'request 6');
      assert.ok(idx > 0 && s.messages[idx].meta?.archived === 20, JSON.stringify(s.messages[idx].meta));
      const rebuilt = await store.historyBefore(s, idx);
      assert.deepStrictEqual(rebuilt.map((m) => m.content), original.slice(0, 20).map((m) => m.content), 'the model sees turns 1–5 as they were');
      assert.ok(!rebuilt.some((m) => m.meta?.summary));
      assert.ok(rebuilt.find((m) => m.toolCallId === 'c3')?.content.startsWith('original body of file3'), 'tool outputs unpruned');
      assert.strictEqual((await store.loadArchive(s.id)).length, 20, 'records from the rewound message on are dropped');

      // A message added after the compaction rewinds normally, summary and all.
      const later = s.messages.findIndex((m) => m.content === 'request 7');
      assert.strictEqual(await store.historyBefore(s, later).then((h) => h.length), later);

      const file = path.join(dir, 'sessions', `${s.id}.archive.jsonl`);
      await fs.access(file);
      await store.flush(s);
      const stats = await store.stats();
      const json = (await fs.stat(path.join(dir, 'sessions', `${s.id}.json`))).size;
      assert.ok(stats.bytes >= json + (await fs.stat(file)).size, 'the archive counts towards storage');
      await store.delete(s.id);
      await assert.rejects(fs.access(file));
    } finally {
      store.dispose();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  async function compactInto(store: SessionStore, s: { id: string; messages: ChatMessage[]; compactions: number }): Promise<void> {
    const cm = new ContextManager({ compactionThreshold: 0.5, maxToolOutputChars: 1000, keepRecent: 4, strategy: 'basic' });
    const res = await cm.compact(cm.pruneToolOutputs(s.messages, 0).messages, noModel, model);
    assert.ok(res.removed > 0);
    archiveCompaction(store, s.id, s.compactions, s.messages, res.messages);
    s.messages = res.messages;
    s.compactions++;
  }

  test('a cleared chat starts a new archive: rewinding never brings the cleared conversation back', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lp-archive-'));
    const store = new SessionStore({ storageUri: vscode.Uri.file(dir) } as vscode.ExtensionContext, log);
    await store.load();
    try {
      const s = store.create('m');
      for (let i = 1; i <= 6; i++) {
        s.messages.push(...turn(i));
      }
      await compactInto(store, s);
      s.messages = [];
      s.compactions = 0;
      await store.clearArchive(s.id);
      assert.deepStrictEqual(await store.loadArchive(s.id), []);
      for (let i = 101; i <= 106; i++) {
        s.messages.push(...turn(i));
      }
      await compactInto(store, s);
      s.messages.push(...turn(107));
      const idx = s.messages.findIndex((m) => m.content === 'request 106');
      assert.strictEqual(s.messages[idx].meta?.archived, 20);
      const rebuilt = await store.historyBefore(s, idx);
      assert.strictEqual(rebuilt.length, 20);
      assert.ok(!rebuilt.some((m) => /^(request|done with) [1-6]$/.test(m.content)), 'nothing from before the clear');
    } finally {
      store.dispose();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test('a fork keeps the archive up to the fork point, so compacting and rewinding inside it rebuilds its own history', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lp-archive-'));
    const store = new SessionStore({ storageUri: vscode.Uri.file(dir) } as vscode.ExtensionContext, log);
    await store.load();
    try {
      const parent = store.create('m');
      for (let i = 1; i <= 6; i++) {
        parent.messages.push(...turn(i));
      }
      const original = structuredClone(parent.messages);
      await compactInto(store, parent);
      parent.messages.push(...turn(7));
      const child = store.fork(parent.id)!;
      const other = store.fork(parent.id)!;
      const copied = other.messages.findIndex((m) => m.content === 'request 6');
      assert.strictEqual(other.messages[copied].meta?.archived, 20);
      assert.deepStrictEqual((await store.historyBefore(other, copied)).map((m) => m.content), original.slice(0, 20).map((m) => m.content));
      for (let i = 8; i <= 12; i++) {
        child.messages.push(...turn(i));
      }
      const full = [...original, ...turn(7), ...[8, 9, 10, 11, 12].flatMap(turn)];
      await compactInto(store, child);
      // The parent goes on independently: its archive is not the fork's.
      parent.messages.push(...turn(50), ...turn(51));
      await compactInto(store, parent);

      const later = child.messages.findIndex((m) => m.content === 'request 12');
      assert.strictEqual(child.messages[later].meta?.archived, 44);
      const fromFork = await store.historyBefore(child, later);
      assert.deepStrictEqual(fromFork.map((m) => m.content), full.slice(0, 44).map((m) => m.content), 'turns 1–11 as they were');
      assert.strictEqual((await store.loadArchive(child.id)).length, 44);
    } finally {
      store.dispose();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test('chats the store does not hold (subagents) are not archived', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lp-archive-'));
    const store = new SessionStore({ storageUri: vscode.Uri.file(dir) } as vscode.ExtensionContext, log);
    await store.load();
    try {
      const msgs = turn(1);
      store.archive('sub-1', msgs, { compactionIndex: 0 });
      assert.ok(msgs.every((m) => m.meta?.archived === undefined));
      assert.deepStrictEqual(await store.loadArchive('sub-1'), []);
    } finally {
      store.dispose();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
