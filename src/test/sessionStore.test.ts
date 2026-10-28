import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { isEmptySession, SessionStore } from '../sessions/sessionStore';

const log = vscode.window.createOutputChannel('LocalPilot test', { log: true });

async function freshStore(): Promise<{ store: SessionStore; dir: string }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lp-sessions-'));
  const store = new SessionStore({ storageUri: vscode.Uri.file(dir) } as vscode.ExtensionContext, log);
  await store.load();
  return { store, dir };
}

suite('session store (chat history)', () => {
  test('title comes from the user\'s own words, not the attachment blocks the UI prepends', async () => {
    const { store, dir } = await freshStore();
    try {
      const s = store.create('ollama/x');
      s.messages.push({ role: 'user', content: '<attachment path="src/a.ts">\nconst a = 1;\n</attachment>\n\n  Rename   getUser to fetchUser\n\n[1 image attached]' });
      store.save(s);
      assert.strictEqual(s.title, 'Rename getUser to fetchUser');
      const hidden = store.create('ollama/x');
      hidden.messages.push({ role: 'user', content: 'Skills that may apply…', meta: { hidden: true } }, { role: 'user', content: 'ship it' });
      store.save(hidden);
      assert.strictEqual(hidden.title, 'ship it', 'hidden steering messages never become the title');
    } finally {
      store.dispose();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test('untouched empty chats are dropped on load; pinned or planned ones survive', async () => {
    const { store, dir } = await freshStore();
    try {
      const empty = store.create('m');
      const pinnedEmpty = store.create('m');
      pinnedEmpty.pinned = true;
      store.save(pinnedEmpty, true);
      const used = store.create('m');
      used.messages.push({ role: 'user', content: 'hello' });
      store.save(used, true);
      await Promise.all([store.flush(empty), store.flush(pinnedEmpty), store.flush(used)]);
      assert.ok(isEmptySession(empty) && !isEmptySession(pinnedEmpty) && !isEmptySession(used));
      store.dispose();
      const again = new SessionStore({ storageUri: vscode.Uri.file(dir) } as vscode.ExtensionContext, log);
      await again.load();
      const ids = again.list().map((s) => s.id).sort();
      assert.deepStrictEqual(ids, [pinnedEmpty.id, used.id].sort());
      again.dispose();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test('search finds chats by what was said and returns the matching line, newest first', async () => {
    const { store, dir } = await freshStore();
    try {
      const a = store.create('m');
      a.messages.push({ role: 'user', content: 'fix the auth redirect loop' }, { role: 'assistant', content: 'Done.\nThe proxy stripped the Authorization header, so I forwarded it.' });
      a.updatedAt = 1000;
      const b = store.create('m');
      b.messages.push({ role: 'user', content: '<git>\nM src/x.ts\n</git>\n\ntidy the CSS' }, { role: 'tool', toolCallId: 't', content: 'authorization appears only in tool output' }, { role: 'user', content: 'hidden authorization note', meta: { hidden: true } });
      b.updatedAt = 2000;
      const hits = store.search('authorization');
      assert.deepStrictEqual(
        hits.map((h) => [h.id, h.role]),
        [[a.id, 'assistant']],
        `tool output and hidden messages do not count: ${JSON.stringify(hits)}`
      );
      assert.ok(/proxy stripped the Authorization header/.test(hits[0].snippet), hits[0].snippet);
      assert.strictEqual(store.search('css')[0]?.id, b.id, 'user text is searched without its context blocks');
      assert.deepStrictEqual(store.search('a'), [], 'single characters are not searched');
      const byTitle = store.search('REDIRECT');
      assert.deepStrictEqual(byTitle.map((h) => h.id), [a.id], 'case-insensitive; title matches count too');
      assert.ok(/redirect loop/.test(byTitle[0].snippet), 'the matching line is still reported for a title match');
    } finally {
      store.dispose();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test('only recently used transcripts stay in memory; the rest load from disk when asked for', async () => {
    const { store, dir } = await freshStore();
    try {
      store.maxInMemory = () => 3;
      const ids: string[] = [];
      for (let i = 0; i < 6; i++) {
        const s = store.create('m');
        s.messages.push({ role: 'user', content: `topic ${i} zebra${i}` });
        store.save(s, true);
        await store.flush(s);
        ids.push(s.id);
      }
      assert.strictEqual(store.loadedCount, 3, 'older transcripts were dropped from memory');
      assert.strictEqual(store.list().length, 6, 'every chat stays in the list');
      assert.strictEqual(store.list().find((s) => s.id === ids[0])?.messageCount, 1, 'list rows keep their counts');
      const cold = store.get(ids[0]);
      assert.strictEqual(cold?.messages[0].content, 'topic 0 zebra0', 'a dropped chat is read back from disk');
      assert.strictEqual(store.loadedCount, 3, 'reading one back drops another');
      assert.strictEqual(store.search('zebra1')[0]?.id, ids[1], 'search covers chats that are not in memory');
      assert.strictEqual(store.loadedCount, 3, 'search does not pull every chat into memory');

      store.inUse = (id) => id === ids[1];
      const live = store.get(ids[1]);
      for (const id of ids.slice(2)) {
        store.get(id);
      }
      assert.strictEqual(store.get(ids[1]), live, 'a chat in use keeps its live object');
      assert.strictEqual((await store.stats()).inMemory, 3);

      const doomed = store.get(ids[5])!;
      await store.delete(ids[5]);
      doomed.messages.push({ role: 'assistant', content: 'late' });
      store.save(doomed);
      assert.ok(!store.list().some((s) => s.id === ids[5]), 'a late save cannot bring a deleted chat back');
      await assert.rejects(fs.stat(path.join(dir, 'sessions', `${ids[5]}.json`)));

      // A fresh start reads every chat for the list but keeps only the newest transcripts.
      const again = new SessionStore({ storageUri: vscode.Uri.file(dir) } as vscode.ExtensionContext, log);
      again.maxInMemory = () => 2;
      await again.load();
      try {
        assert.strictEqual(again.list().length, 5, 'every chat is listed after a restart');
        assert.strictEqual(again.loadedCount, 2, 'start-up holds only the newest transcripts');
        assert.strictEqual(again.get(ids[0])?.messages[0].content, 'topic 0 zebra0', 'older ones still open');
      } finally {
        again.dispose();
      }
    } finally {
      store.dispose();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
