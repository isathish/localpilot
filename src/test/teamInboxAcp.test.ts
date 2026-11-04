import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PassThrough } from 'stream';
import { acpApprovalOverrides, AcpHost, serveAcp } from '../cli/acp';
import { RunControl } from '../agent/runControl';
import { BoardMailbox } from '../agent/teamBoard';
import { watchInbox } from '../tools/teamBoard';
import { getConfig } from '../config';
import { Session } from '../types';

const tmp = (p: string) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const until = async (ok: () => boolean, ms = 2000) => {
  for (let t = 0; t < ms && !ok(); t += 10) {
    await new Promise((r) => setTimeout(r, 10));
  }
};

suite('Team inbox watchers and ACP approvals', () => {
  test('RunControl: dispose ends the run, so steering is refused and end listeners fire once', () => {
    const c = new RunControl('s_end');
    let ended = 0;
    c.onEnd(() => ended++);
    assert.ok(c.steer({ role: 'user', content: 'x' }));
    c.dispose();
    assert.strictEqual(ended, 1);
    assert.ok(c.ended);
    assert.strictEqual(c.steer({ role: 'user', content: 'y' }), false);
    c.close();
    assert.strictEqual(ended, 1);
    let late = 0;
    c.onEnd(() => late++);
    assert.strictEqual(late, 1);
  });

  test('watchInbox: stops when a subagent-style run is disposed; the next run with the same owner gets the messages', async () => {
    const root = tmp('lp-inbox-');
    const me = 'me@here · session inbox001';
    try {
      const upstream = new AbortController();
      const first = new RunControl('s_inbox001', undefined, upstream.signal);
      watchInbox(root, me, first, upstream.signal, 20);
      first.dispose(); // finished without aborting, as subagents and ACP prompts do
      const mail = new BoardMailbox(root);
      await mail.send('lead', 'inbox001', 'first note');
      await new Promise((r) => setTimeout(r, 80));
      assert.strictEqual(first.pendingSteers().length, 0);
      // Nothing was consumed by the dead watcher.
      assert.strictEqual((await mail.inbox(me, [], { peek: true })).length, 1);
      const second = new RunControl('s_inbox001b', undefined, upstream.signal);
      watchInbox(root, me, second, upstream.signal, 20);
      await until(() => second.pendingSteers().length > 0);
      assert.match(second.pendingSteers()[0]?.content ?? '', /first note/);
      second.close();
      assert.strictEqual((await mail.inbox(me)).length, 0);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('BoardMailbox: peekInbox leaves messages unread until markRead, and the cursor never moves back', async () => {
    const root = tmp('lp-inbox-');
    try {
      const mail = new BoardMailbox(root);
      await mail.send('lead', 'bob', 'one');
      const a = await mail.peekInbox('bob');
      assert.strictEqual(a.messages.length, 1);
      assert.strictEqual((await mail.peekInbox('bob')).messages.length, 1);
      await mail.send('lead', 'bob', 'two');
      const b = await mail.peekInbox('bob');
      await mail.markRead('bob', b.seen);
      await mail.markRead('bob', a.seen);
      assert.strictEqual((await mail.inbox('bob')).length, 0);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('ACP without --yes: default settings send a write_file approval to the client', async () => {
    const overrides = acpApprovalOverrides(getConfig().approvals);
    assert.deepStrictEqual(acpApprovalOverrides({ terminal: 'safe', write: 'always', delete: 'ask', network: 'always', mcp: 'never' }), { 'autoMode.enabled': false, 'approvals.terminal': 'ask', 'approvals.write': 'ask', 'approvals.delete': 'ask', 'approvals.network': 'ask', 'approvals.mcp': 'never' });
    const input = new PassThrough();
    const output = new PassThrough();
    const lines: Record<string, unknown>[] = [];
    let buf = '';
    const session: Session = { id: 'cli-acp2', title: 'New chat', createdAt: 1, updatedAt: 1, model: '', mode: 'agent', messageCount: 0, messages: [], contextTokens: 0, compactions: 0, attachments: [] };
    const host: AcpHost = {
      version: '1.0.0',
      newSession: async () => session,
      loadSession: async () => undefined,
      models: async () => [],
      defaultModel: () => '',
      run: async (r) => {
        r.emit({ sessionId: session.id, type: 'tool_start', payload: { id: 'w1', name: 'write_file', args: { path: 'a.txt' } } });
        // The runner's gate: a kind configured `always` goes ahead without asking.
        const ok = overrides['approvals.write'] === 'always' ? true : await r.requestApproval('Write a.txt', 'hello', 'write');
        r.emit({ sessionId: session.id, type: 'tool_end', payload: { id: 'w1', name: 'write_file', isError: ok !== true, content: 'done' } });
        return { text: '', completed: true };
      },
    };
    const { done } = serveAcp(host, input, output);
    output.on('data', (b: Buffer) => {
      buf += b.toString();
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const m = JSON.parse(buf.slice(0, nl)) as Record<string, unknown>;
        buf = buf.slice(nl + 1);
        lines.push(m);
        if (m.method === 'session/request_permission') {
          input.write(`${JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { outcome: { outcome: 'selected', optionId: 'allow_once' } } })}\n`);
        }
      }
    });
    input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1 } })}\n`);
    input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'session/new', params: { cwd: '/repo', mcpServers: [] } })}\n`);
    await until(() => lines.some((m) => m.id === 2));
    input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'session/prompt', params: { sessionId: 'cli-acp2', prompt: [{ type: 'text', text: 'write a.txt' }] } })}\n`);
    await until(() => lines.some((m) => m.id === 3 && !m.method));
    assert.ok(lines.some((m) => m.method === 'session/request_permission'), 'write_file asked the client');
    input.end();
    await done;
  });
});
