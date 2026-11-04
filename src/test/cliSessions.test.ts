import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { SessionStore, sessionHtml } from '../sessions/sessionStore';
import { cliDataDir, cliSessionsDir, cliWorkspaceDir } from '../sessions/cliStorage';
import { ageLabel, findSession, historyEntry, newestFirst, resumeBanner, sessionRows } from '../cli/sessions';
import { SessionSummary } from '../types';

const log = vscode.window.createOutputChannel('LocalPilot test', { log: true });
const plain = { bold: String, dim: String, red: String, green: String, yellow: String, amber: String, cyan: String };

async function storeAt(dir: string, setup?: (s: SessionStore) => void): Promise<SessionStore> {
  const store = new SessionStore({ storageUri: vscode.Uri.file(dir) } as vscode.ExtensionContext, log);
  setup?.(store);
  await store.load();
  return store;
}

const row = (id: string, updatedAt: number, extra: Partial<SessionSummary> = {}): SessionSummary => ({ id, title: id, createdAt: updatedAt, updatedAt, model: 'm', mode: 'agent', messageCount: 2, ...extra });

suite('CLI sessions shared with VS Code history', () => {
  test('the CLI folder of a workspace is stable and honours LOCALPILOT_DATA_DIR', async () => {
    const ws = await fs.mkdtemp(path.join(os.tmpdir(), 'lp-cli-ws-'));
    try {
      const a = cliWorkspaceDir(ws, '/data');
      assert.strictEqual(a, cliWorkspaceDir(`${ws}${path.sep}`, '/data'), 'a trailing separator hashes the same');
      assert.strictEqual(a, cliWorkspaceDir(path.join(ws, 'sub', '..'), '/data'));
      assert.match(path.basename(a), /^[0-9a-f]{16}$/);
      assert.strictEqual(path.dirname(a), path.join(path.resolve('/data'), 'workspaces'));
      assert.strictEqual(cliSessionsDir(ws, '/data'), path.join(a, 'sessions'));
      assert.strictEqual(cliDataDir(undefined, { LOCALPILOT_DATA_DIR: '/tmp/lp-data' }), path.resolve('/tmp/lp-data'));
      assert.strictEqual(cliDataDir('/x', { LOCALPILOT_DATA_DIR: '/tmp/lp-data' }), path.resolve('/x'), '--data-dir wins over the environment');
      assert.strictEqual(cliDataDir(undefined, {}), path.join(os.homedir(), '.localpilot'));
    } finally {
      await fs.rm(ws, { recursive: true, force: true });
    }
  });

  test('VS Code lists CLI chats read-only; continuing one saves it here; the newer copy wins; delete removes both', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lp-cli-hist-'));
    const cliDir = path.join(root, 'cli');
    const vsDir = path.join(root, 'vscode');
    const cliSessions = vscode.Uri.file(path.join(cliDir, 'sessions'));
    const cli = await storeAt(cliDir, (s) => {
      s.idPrefix = 'cli-';
      s.origin = 'cli';
    });
    let vs: SessionStore | undefined;
    try {
      const a = cli.create('ollama/x');
      a.messages.push({ role: 'user', content: 'from the terminal' }, { role: 'assistant', content: 'ok' });
      cli.save(a);
      await cli.flush(a);
      assert.ok(a.id.startsWith('cli-') && a.origin === 'cli');

      vs = await storeAt(vsDir, (s) => (s.extraDirs = [cliSessions]));
      const listed = vs.list().find((s) => s.id === a.id);
      assert.ok(listed, 'the CLI chat is in the history');
      assert.strictEqual(listed.origin, 'cli');
      assert.ok(vs.isExternal(a.id));
      assert.strictEqual(vs.get(a.id)?.messages[0].content, 'from the terminal', 'its transcript reads from the CLI folder');

      // A chat the CLI saves later shows up on refresh, without a reload.
      const b = cli.create('ollama/x');
      b.messages.push({ role: 'user', content: 'second one' });
      cli.save(b);
      await cli.flush(b);
      assert.ok(await vs.refreshExternal());
      assert.ok(vs.has(b.id));
      // Retention never prunes another tool's chats.
      assert.strictEqual(await vs.prune(1), 0);

      // Continued in VS Code: written to VS Code's folder, the CLI file is left alone.
      const s = vs.get(a.id)!;
      s.messages.push({ role: 'user', content: 'continued in the editor' });
      vs.save(s);
      await vs.flush(s);
      assert.ok(!vs.isExternal(a.id));
      const own = JSON.parse(await fs.readFile(path.join(vsDir, 'sessions', `${a.id}.json`), 'utf8'));
      assert.strictEqual(own.messages.length, 3);
      assert.strictEqual(JSON.parse(await fs.readFile(path.join(cliSessions.fsPath, `${a.id}.json`), 'utf8')).messages.length, 2);
      vs.dispose();

      // Reloaded: the newer (VS Code) copy is the one listed.
      vs = await storeAt(vsDir, (x) => (x.extraDirs = [cliSessions]));
      assert.strictEqual(vs.get(a.id)?.messages.length, 3);
      assert.ok(!vs.isExternal(a.id));

      await vs.delete(a.id);
      await assert.rejects(fs.stat(path.join(vsDir, 'sessions', `${a.id}.json`)));
      await assert.rejects(fs.stat(path.join(cliSessions.fsPath, `${a.id}.json`)), 'the CLI copy goes too, or it would come back');

      // Deleted by the CLI: gone from the list on the next refresh.
      await cli.delete(b.id);
      await vs.refreshExternal();
      assert.ok(!vs.has(b.id));
    } finally {
      cli.dispose();
      vs?.dispose();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test('a fork records its parent; the HTML export is a standalone, escaped page', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lp-fork-'));
    const store = await storeAt(dir);
    try {
      const src = store.create('m');
      src.messages.push({ role: 'user', content: 'Fix <script>alert(1)</script> in a & b' }, { role: 'assistant', content: 'done' });
      store.save(src);
      const f = store.fork(src.id)!;
      assert.strictEqual(f.parentId, src.id);
      assert.strictEqual(f.parentTitle, src.title);
      assert.strictEqual(store.list().find((s) => s.id === f.id)?.parentId, src.id, 'the history row carries the lineage');
      const html = await store.exportHtml(src.id);
      assert.ok(html.startsWith('<!DOCTYPE html>'));
      assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;') && html.includes('a &amp; b'));
      assert.ok(!/<script/i.test(html.replace(/&lt;script/g, '')), 'no live script');
      assert.ok(/default-src 'none'/.test(html), 'nothing external loads');
      assert.strictEqual(await store.exportHtml('missing'), '');
      assert.ok(sessionHtml('<t>', 'x').includes('<title>&lt;t&gt;</title>'));
    } finally {
      store.dispose();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test('resume picks a session by list number, id or unique prefix; rows and JSON describe it', () => {
    const now = Date.UTC(2026, 0, 10);
    const list = newestFirst([row('cli-aaa1', now - 7_200_000), row('cli-bbb2', now - 60_000, { parentId: 'cli-aaa1', parentTitle: 'first' }), row('cli-aab3', now - 3 * 86_400_000)]);
    assert.deepStrictEqual(list.map((s) => s.id), ['cli-bbb2', 'cli-aaa1', 'cli-aab3']);
    assert.strictEqual(findSession(list, '1').session?.id, 'cli-bbb2');
    assert.strictEqual(findSession(list, '3').session?.id, 'cli-aab3');
    assert.strictEqual(findSession(list, 'cli-aaa1').session?.id, 'cli-aaa1');
    assert.strictEqual(findSession(list, 'cli-b').session?.id, 'cli-bbb2');
    assert.strictEqual(findSession(list, 'cli-aa').ambiguous?.length, 2);
    assert.deepStrictEqual(findSession(list, '9'), {});
    const rows = sessionRows(list, plain, { now, current: 'cli-aaa1' });
    assert.match(rows[0], /^ {2}1\. cli-bbb2 {2}1 min ago · 2 messages · m · forked from first · cli-bbb2$/);
    assert.match(rows[1], /\(current\)/);
    assert.match(rows[2], /3 d ago/);
    assert.strictEqual(ageLabel(now - 10_000, now), 'just now');
    assert.strictEqual(ageLabel(now - 40 * 86_400_000, now), '2025-12-01');
    const j = historyEntry({ ...list[0], origin: 'cli' });
    assert.deepStrictEqual(Object.keys(j), ['id', 'title', 'createdAt', 'updatedAt', 'messages', 'model', 'mode', 'origin', 'parentId', 'parentTitle']);
    assert.strictEqual(j.updatedAt, new Date(now - 60_000).toISOString());
  });

  test('the resume banner shows the last thing said on each side', () => {
    const text = resumeBanner({ ...row('cli-x', 0), title: 'Rename', messages: [{ role: 'user', content: 'rename foo' }, { role: 'assistant', content: 'Renamed foo\nto bar.' }, { role: 'user', content: 'hidden', meta: { hidden: true } }], contextTokens: 0, compactions: 0, attachments: [] }, plain);
    assert.match(text, /Resumed Rename · 3 messages · cli-x/);
    assert.match(text, /you: rename foo/);
    assert.match(text, /agent: Renamed foo to bar\./);
  });
});
