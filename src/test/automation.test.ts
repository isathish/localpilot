import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PassThrough } from 'stream';
import * as vscode from 'vscode';
import { AcpHost, serveAcp } from '../cli/acp';
import { parseCron, ScheduleStore } from '../cli/schedule';
import { RunControl } from '../agent/runControl';
import { BoardMailbox, TeamBoard } from '../agent/teamBoard';
import { findImportable, importInto, readImport } from '../sessions/importers';
import { SessionStore } from '../sessions/sessionStore';
import { createScheduleTool } from '../tools/schedule';
import { teamBoardTool, watchInbox } from '../tools/teamBoard';
import { Session, ToolContext } from '../types';
import { writeTranscriptHome } from './fixtures/agentTranscripts';

const log = vscode.window.createOutputChannel('LocalPilot test', { log: true });

function ctx(root: string, over: Partial<ToolContext> = {}): ToolContext {
  const ac = new AbortController();
  return { sessionId: 's_test1234', workspaceRoot: root, signal: ac.signal, requestApproval: async () => true, progress: () => undefined, trackChange: async () => undefined, depth: 0, ...over };
}

const tmp = (p: string) => fs.mkdtempSync(path.join(os.tmpdir(), p));

suite('Automation and interop', () => {
  test('ACP over stdio: initialize, session/new, prompt with a permission round trip', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const lines: Record<string, unknown>[] = [];
    let buf = '';
    const session: Session = { id: 'cli-acp1', title: 'New chat', createdAt: 1, updatedAt: 1, model: '', mode: 'agent', messageCount: 0, messages: [], contextTokens: 0, compactions: 0, attachments: [] };
    const host: AcpHost = {
      version: '1.0.0',
      newSession: async () => session,
      loadSession: async () => undefined,
      models: async () => [{ id: 'stub/model', name: 'Stub' }],
      defaultModel: () => 'stub/model',
      run: async (r) => {
        r.emit({ sessionId: session.id, type: 'tool_start', payload: { id: 'c1', name: 'write_file', args: { path: 'a.txt' } } });
        const ok = await r.requestApproval('Write a.txt', 'hello', 'write');
        r.emit({ sessionId: session.id, type: 'tool_end', payload: { id: 'c1', name: 'write_file', isError: ok !== true, content: ok === true ? 'written' : 'denied' } });
        r.emit({ sessionId: session.id, type: 'assistant_delta', payload: ok === true ? 'Wrote it.' : 'Not allowed.' });
        return { text: '', completed: true };
      },
    };
    const { done } = serveAcp(host, input, output);
    const waitFor = async (pred: (m: Record<string, unknown>) => boolean) => {
      for (let i = 0; i < 200; i++) {
        const hit = lines.find(pred);
        if (hit) {
          return hit;
        }
        await new Promise((r) => setTimeout(r, 5));
      }
      throw new Error('timed out');
    };
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
    const created = (await waitFor((m) => m.id === 2 && !m.method)) as { result: { sessionId: string } };
    assert.strictEqual(created.result.sessionId, 'cli-acp1');
    input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'session/prompt', params: { sessionId: 'cli-acp1', prompt: [{ type: 'text', text: 'write a.txt' }] } })}\n`);
    const res = (await waitFor((m) => m.id === 3 && !m.method)) as { result: { stopReason: string } };
    assert.strictEqual(res.result.stopReason, 'end_turn');
    const perm = lines.find((m) => m.method === 'session/request_permission') as { params: { toolCall: { toolCallId: string; kind: string } } };
    assert.strictEqual(perm.params.toolCall.toolCallId, 'c1');
    assert.strictEqual(perm.params.toolCall.kind, 'edit');
    const texts = lines.filter((m) => m.method === 'session/update').map((m) => JSON.stringify(m.params));
    assert.ok(texts.some((t) => t.includes('"sessionUpdate":"tool_call"') && t.includes('"locations":[{"path":"a.txt"}]')));
    assert.ok(texts.some((t) => t.includes('Wrote it.')));
    input.end();
    await done;
  });

  test('schedule tool: list needs no approval, create asks and refuses in Plan mode', async () => {
    const home = tmp('lp-sched-tool-');
    const prev = process.env.LOCALPILOT_SCHEDULER;
    process.env.LOCALPILOT_SCHEDULER = 'off';
    try {
      const store = new ScheduleStore(home);
      const tool = createScheduleTool(() => ({ command: '/bin/localpilot', args: [] }), () => store);
      let asked = 0;
      const c = ctx(home, { requestApproval: async () => (asked++, true) });
      assert.strictEqual((await tool.execute({ action: 'list' }, c)).content, 'No schedules yet.');
      const made = await tool.execute({ action: 'create', name: 'nightly', cron: '0 3 * * 1-5', prompt: 'run the tests' }, c);
      assert.ok(!made.isError, made.content);
      assert.strictEqual(asked, 1);
      assert.strictEqual(store.get('nightly')?.cwd, path.resolve(home));
      assert.ok(parseCron(store.get('nightly')!.cron).dow);
      assert.match((await tool.execute({ action: 'list' }, c)).content, /nightly/);
      const ro = await tool.execute({ action: 'delete', name: 'nightly' }, ctx(home, { readOnly: true, mode: 'plan' }));
      assert.ok(ro.isError);
      const denied = await tool.execute({ action: 'delete', name: 'nightly' }, ctx(home, { requestApproval: async () => false }));
      assert.ok(denied.isError && store.get('nightly'));
      assert.ok(!(await tool.execute({ action: 'delete', name: 'nightly' }, c)).isError);
      assert.strictEqual(store.list().length, 0);
    } finally {
      if (prev === undefined) {
        delete process.env.LOCALPILOT_SCHEDULER;
      } else {
        process.env.LOCALPILOT_SCHEDULER = prev;
      }
      fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  });

  test('importers: fixture transcripts land in the history with their origin', async () => {
    const home = tmp('lp-import-');
    const ws = path.join(home, 'repo');
    const data = tmp('lp-import-store-');
    try {
      writeTranscriptHome(home, ws);
      const found = findImportable(ws, { home });
      assert.deepStrictEqual(found.map((c) => c.source), ['codex', 'claude-code']);
      const store = new SessionStore({ storageUri: vscode.Uri.file(data) } as vscode.ExtensionContext, log);
      await store.load();
      for (const c of found) {
        assert.ok((await importInto(store, readImport(c))).created);
      }
      assert.ok(!(await importInto(store, readImport(found[0]))).created, 'a second import is skipped');
      const list = store.list();
      assert.strictEqual(list.length, 2);
      const claude = store.get(list.find((s) => s.origin === 'claude-code')!.id)!;
      assert.strictEqual(claude.title, 'Fix add in math.ts');
      assert.deepStrictEqual(claude.messages.map((m) => m.role), ['user', 'assistant', 'tool', 'assistant']);
      store.dispose();
      const reopened = new SessionStore({ storageUri: vscode.Uri.file(data) } as vscode.ExtensionContext, log);
      await reopened.load();
      assert.deepStrictEqual(reopened.list().map((s) => s.origin).sort(), ['claude-code', 'codex']);
      reopened.dispose();
    } finally {
      fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
      fs.rmSync(data, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  });

  test('team_board mailbox: send, inbox, and messages steered into a running agent', async () => {
    const root = tmp('lp-board-mail-');
    try {
      const board = new TeamBoard(root);
      const task = await board.add({ title: 'Fix login', brief: 'Make login work' });
      const worker = ctx(root, { sessionId: 's_worker99' });
      assert.match((await teamBoardTool.execute({ action: 'claim', id: task.id }, worker)).content, /Claimed/);
      const lead = ctx(root, { sessionId: 's_lead0001' });
      assert.match((await teamBoardTool.execute({ action: 'send', to: task.id, text: 'the API changed: use /v2' }, lead)).content, /holder of "fix-login"/);
      assert.match((await teamBoardTool.execute({ action: 'broadcast', text: 'freeze at 5' }, lead)).content, /everyone/);
      const inbox = (await teamBoardTool.execute({ action: 'inbox' }, worker)).content;
      assert.match(inbox, /2 new messages/);
      assert.match(inbox, /use \/v2/);
      assert.match((await teamBoardTool.execute({ action: 'inbox' }, worker)).content, /No new messages/);
      // A message sent while the worker runs is handed to it as a steer.
      const watched = new RunControl('s_watch001');
      watchInbox(root, 'me@here · session watch001', watched, watched.signal, 20);
      await new BoardMailbox(root).send('lead', 'watch001', 'please also update the docs');
      for (let i = 0; i < 100 && !watched.pendingSteers().length; i++) {
        await new Promise((r) => setTimeout(r, 10));
      }
      assert.match(watched.pendingSteers()[0]?.content ?? '', /please also update the docs/);
      watched.stop();
    } finally {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  });
});
