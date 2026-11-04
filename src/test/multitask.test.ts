import * as assert from 'assert';
import * as cp from 'child_process';
import * as fs from 'fs/promises';
import * as http from 'http';
import { AddressInfo } from 'net';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import type { LocalPilotApi } from '../extension';

/**
 * Every way LocalPilot runs agents side by side, end to end in the extension host against a scripted
 * OpenAI-compatible model: Run Tasks in Parallel, Best of N, the task queue (parallel and dependent), Multitask mode
 * (a coordinator and its workers), parallel subagents and checklist fan-out in Agent mode, and `--multitask` in the
 * CLI. The model answers by markers in the conversation and holds each answer briefly, so the test can see how many
 * requests really overlapped, which model served which agent, and what each one wrote where.
 *
 * Prompt markers:  `WRITE file=<name> text=<text>` → write_file, then "DONE <name>".
 *                  `COORD <a> <b>`  → run_parallel_subagents with a coder writing each file, then "COORD-DONE".
 *                  `TODOS <a> <b>`  → run_todos_parallel with inline tasks writing each file, then "TODOS-DONE".
 */

interface Req {
  model: string;
  /** The first user message: which agent this request belongs to. */
  prompt: string;
  start: number;
  end: number;
}

type Msg = { role: string; content?: unknown; tool_call_id?: string; name?: string };

const text = (c: unknown): string => (typeof c === 'string' ? c : Array.isArray(c) ? c.map((p) => (p as { text?: string }).text ?? '').join('') : '');

function scriptedModel(delayMs = 350) {
  const reqs: Req[] = [];
  let inflight = 0;
  let peak = 0;
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      if (req.url?.startsWith('/v1/models')) {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ object: 'list', data: ['m-one', 'm-two'].map((id) => ({ id, object: 'model', owned_by: 'mt', context_length: 32768 })) }));
        return;
      }
      if (req.url !== '/v1/chat/completions') {
        res.statusCode = 404;
        res.end();
        return;
      }
      const j = JSON.parse(body) as { model: string; messages: Msg[]; tools?: unknown[] };
      const users = j.messages.filter((m) => m.role === 'user').map((m) => text(m.content));
      const prompt = users.find((u) => /\b(WRITE file=|COORD |TODOS )/.test(u)) ?? users[0] ?? '';
      const toolsDone = j.messages.filter((m) => m.role === 'tool').length;
      const r: Req = { model: j.model, prompt, start: Date.now(), end: 0 };
      reqs.push(r);
      inflight++;
      peak = Math.max(peak, inflight);
      let reply: { text: string } | { tool: string; args: Record<string, unknown> };
      const w = /WRITE file=(\S+) text=(\S+)/.exec(prompt);
      const fan = /\b(COORD|TODOS) (\S+) (\S+)/.exec(prompt);
      if (!j.tools?.length) {
        reply = { text: 'Parallel work' }; // helper requests (titles, summaries) carry no tools
      } else if (w) {
        // Best of N: each model writes its own name, so the results differ.
        const content = w[2] === 'MODEL' ? j.model : w[2];
        reply = toolsDone ? { text: `DONE ${w[1]}` } : { tool: 'write_file', args: { path: w[1], content } };
      } else if (fan) {
        const files = [fan[2], fan[3]];
        reply = toolsDone
          ? { text: `${fan[1]}-DONE` }
          : fan[1] === 'COORD'
            ? { tool: 'run_parallel_subagents', args: { tasks: files.map((f) => ({ agent: 'coder', prompt: `WRITE file=${f} text=from-${f}` })) } }
            : { tool: 'run_todos_parallel', args: { tasks: files.map((f) => ({ title: `Create ${f}`, agent: 'coder', prompt: `WRITE file=${f} text=from-${f}` })) } };
      } else {
        reply = { text: 'OK' };
      }
      setTimeout(() => {
        res.setHeader('content-type', 'text/event-stream');
        if ('tool' in reply) {
          res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: `call_${reqs.length}`, type: 'function', function: { name: reply.tool, arguments: JSON.stringify(reply.args) } }] } }] })}\n\n`);
          res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })}\n\n`);
        } else {
          res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: reply.text } }] })}\n\n`);
          res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
        }
        res.end('data: [DONE]\n\n');
        r.end = Date.now();
        inflight--;
      }, delayMs);
    });
  });
  return new Promise<{ url: string; port: number; reqs: Req[]; peak(): number; reset(): void; close(): void }>((resolve) =>
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as AddressInfo).port;
      resolve({
        url: `http://127.0.0.1:${port}/v1`,
        port,
        reqs,
        peak: () => peak,
        reset: () => {
          reqs.length = 0;
          peak = inflight;
        },
        close: () => srv.close(),
      });
    })
  );
}

/** Largest number of the given requests that were in flight at the same moment. */
function overlap(reqs: Req[]): number {
  const ev = reqs.flatMap((r) => [[r.start, 1], [r.end || Date.now(), -1]] as const).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let n = 0;
  let max = 0;
  for (const [, d] of ev) {
    n += d;
    max = Math.max(max, n);
  }
  return max;
}

suite('Multitasking: every parallel mode end to end (scripted model)', function () {
  this.timeout(180_000);
  let api: LocalPilotApi;
  let root = '';
  let mock: Awaited<ReturnType<typeof scriptedModel>>;
  const keys = ['providers', 'defaultModel', 'worktrees.mode', 'approvals.write', 'approvals.terminal', 'autoClarify', 'prompts.autoCorrect', 'clarify.questions', 'queue.concurrency', 'skills.autoInstall', 'routing.enabled', 'routing.parallelModels', 'parallel.maxConcurrency', 'hooks.enabled', 'memory.enabled'];
  const saved: Record<string, unknown> = {};
  const set = (k: string, v: unknown) => vscode.workspace.getConfiguration('localpilot').update(k, v, vscode.ConfigurationTarget.Global);
  const sh = (cmd: string) => cp.execSync(cmd, { cwd: root, stdio: 'pipe' }).toString();
  const exists = (p: string) => fs.stat(p).then(() => true, () => false);

  const waitIdle = (ids: string[], timeoutMs = 90_000) =>
    new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        sub.dispose();
        ids.forEach((id) => api.stop(id));
        reject(new Error(`still running after ${timeoutMs} ms: ${ids.filter((id) => api.runningSessionIds.includes(id)).join(', ')}`));
      }, timeoutMs);
      const check = () => {
        if (!ids.some((id) => api.runningSessionIds.includes(id))) {
          clearTimeout(timer);
          sub.dispose();
          resolve();
        }
      };
      const sub = api.onDidChangeRuns(check);
      check();
    });
  const lastText = (id: string) => [...(api.getSession(id)?.messages ?? [])].reverse().find((m) => m.role === 'assistant' && m.content.trim())?.content ?? '';
  const transcript = (id: string) => JSON.stringify((api.getSession(id)?.messages ?? []).map((m) => ({ role: m.role, tool: m.toolName, calls: m.toolCalls?.map((c) => c.name), content: m.content.slice(0, 160) })));

  suiteSetup(async function () {
    api = await vscode.extensions.getExtension<LocalPilotApi>('localpilot.localpilot-agent')!.activate();
    root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
    if (!root) {
      this.skip();
    }
    const cfg = vscode.workspace.getConfiguration('localpilot');
    for (const k of keys) {
      saved[k] = cfg.inspect(k)?.globalValue;
    }
    mock = await scriptedModel();
    await set('providers', [{ id: 'mt', type: 'openai', baseUrl: mock.url, displayName: 'Scripted' }]);
    await set('defaultModel', 'mt/m-one');
    await set('worktrees.mode', 'parallel');
    await set('approvals.write', 'always');
    await set('approvals.terminal', 'always');
    await set('autoClarify', false);
    await set('prompts.autoCorrect', false);
    await set('clarify.questions', 'minimal');
    await set('skills.autoInstall', 'off');
    await set('routing.enabled', false);
    await set('routing.parallelModels', false);
    await set('parallel.maxConcurrency', 4);
    await set('hooks.enabled', false);
    await set('memory.enabled', false);
    if (!(await exists(path.join(root, '.git')))) {
      sh('git init -q && git config user.email mt@localpilot && git config user.name mt');
    }
    await fs.writeFile(path.join(root, 'README.md'), '# multitask\n');
    sh('git add -A && git commit -q -m mt-base --allow-empty');
    // The provider list changed: wait until the scripted models are listed.
    for (let i = 0; i < 40 && !(await api.listModels()).some((m) => m.id === 'mt/m-two'); i++) {
      await new Promise((r) => setTimeout(r, 250));
    }
    const ids = (await api.listModels()).map((m) => m.id);
    assert.ok(ids.includes('mt/m-two'), `the scripted models are listed: ${ids.join(', ')}`);
  });

  suiteTeardown(async () => {
    for (const k of keys) {
      await set(k, saved[k]);
    }
    mock?.close();
  });

  setup(() => mock.reset());

  test('Run Tasks in Parallel: one isolated agent per task, running at the same time; Apply brings one result over', async () => {
    const ids = await api.runParallel(['WRITE file=par-a.txt text=alpha', 'WRITE file=par-b.txt text=beta', 'WRITE file=par-c.txt text=gamma'], 'agent');
    assert.strictEqual(ids.length, 3);
    await waitIdle(ids);
    const sessions = ids.map((id) => api.getSession(id)!);
    const group = sessions[0].group;
    assert.ok(group && group.kind === 'batch' && group.size === 3 && sessions.every((s) => s.group?.id === group.id), 'one batch group');
    assert.ok(overlap(mock.reqs.filter((r) => /par-/.test(r.prompt))) >= 2, `the agents' requests overlapped (peak ${mock.peak()}): ${transcript(ids[0])} model=${sessions[0].model} default=${vscode.workspace.getConfiguration('localpilot').get('defaultModel')}`);
    for (const [i, s] of sessions.entries()) {
      const [file, want] = [['par-a.txt', 'alpha'], ['par-b.txt', 'beta'], ['par-c.txt', 'gamma']][i];
      assert.ok(s.worktree, `agent ${i} worked in its own worktree: ${transcript(s.id)}`);
      assert.strictEqual((await fs.readFile(path.join(s.worktree!.path, file), 'utf8')).trim(), want, `${file} in its worktree`);
      assert.ok(!(await exists(path.join(root, file))), `${file} is not in the workspace before Apply`);
      assert.match(lastText(s.id), new RegExp(`DONE ${file}`));
    }
    assert.strictEqual(new Set(sessions.map((s) => s.worktree!.path)).size, 3, 'three separate worktrees');
    const res = await api.applyWorktree(ids[1]);
    assert.ok(res && res.files === 1 && !res.conflicts.length, `apply: ${JSON.stringify(res)}`);
    assert.strictEqual((await fs.readFile(path.join(root, 'par-b.txt'), 'utf8')).trim(), 'beta');
    for (const id of ids) {
      await api.discardWorktree(id);
    }
    await fs.rm(path.join(root, 'par-b.txt'), { force: true });
  });

  test('Best of N: the same task on each picked model at once; apply the winner, discard the rest', async () => {
    const ids = await api.runBestOfN('WRITE file=bon.txt text=MODEL', ['mt/m-one', 'mt/m-two', 'mt/m-one'], 'agent');
    assert.strictEqual(ids.length, 2, 'duplicate model picks are dropped');
    await waitIdle(ids);
    const sessions = ids.map((id) => api.getSession(id)!);
    assert.ok(sessions.every((s) => s.group?.kind === 'bestOf' && s.group.size === 2 && s.group.id === sessions[0].group!.id), 'one Best-of-N group');
    assert.deepStrictEqual(new Set(mock.reqs.filter((r) => /bon\.txt/.test(r.prompt)).map((r) => r.model)), new Set(['m-one', 'm-two']), 'each attempt ran on its own model');
    assert.ok(overlap(mock.reqs.filter((r) => /bon\.txt/.test(r.prompt))) >= 2, 'the attempts ran at the same time');
    const results = await Promise.all(sessions.map((s) => fs.readFile(path.join(s.worktree!.path, 'bon.txt'), 'utf8')));
    assert.deepStrictEqual(results.map((r) => r.trim()).sort(), ['m-one', 'm-two'], 'each worktree holds its own model\'s result');
    const winner = sessions.find((s) => s.model === 'mt/m-two')!;
    await api.applyWorktree(winner.id);
    for (const s of sessions) {
      await api.discardWorktree(s.id);
    }
    assert.strictEqual((await fs.readFile(path.join(root, 'bon.txt'), 'utf8')).trim(), 'm-two', 'the picked result is in the workspace');
    assert.ok(sessions.every((s) => !api.getSession(s.id)!.worktree), 'every attempt\'s worktree is gone');
    await fs.rm(path.join(root, 'bon.txt'), { force: true });
  });

  test('Task queue: queue.concurrency tasks run side by side; a dependent task starts only after its prerequisite succeeds', async () => {
    await set('queue.concurrency', 2);
    const q = api.queue;
    q.setPaused(true);
    const a = q.add({ prompt: 'WRITE file=q-a.txt text=qa', mode: 'agent' });
    const b = q.add({ prompt: 'WRITE file=q-b.txt text=qb', mode: 'agent', model: 'mt/m-two' });
    const c = q.add({ prompt: 'WRITE file=q-c.txt text=qc', mode: 'agent', dependsOn: [a.id] });
    const done = new Promise<void>((resolve) => {
      const sub = q.onDidChange(() => {
        if ([a, b, c].every((t) => ['done', 'failed', 'blocked', 'cancelled'].includes(q.list.find((x) => x.id === t.id)?.status ?? 'done'))) {
          sub.dispose();
          resolve();
        }
      });
    });
    q.setPaused(false);
    await Promise.race([done, new Promise((_, rej) => setTimeout(() => rej(new Error(`queue did not finish: ${JSON.stringify(q.list.map((t) => [t.prompt, t.status, t.error]))}`)), 90_000))]);
    const [ta, tb, tc] = [a, b, c].map((t) => q.list.find((x) => x.id === t.id)!);
    assert.deepStrictEqual([ta.status, tb.status, tc.status], ['done', 'done', 'done'], JSON.stringify([ta, tb, tc].map((t) => t.error)));
    assert.ok(tc.startedAt! >= ta.endedAt!, 'the dependent task started after its prerequisite finished');
    assert.ok(ta.startedAt! < tb.endedAt! && tb.startedAt! < ta.endedAt!, 'the two independent tasks ran at the same time');
    assert.ok(mock.reqs.filter((r) => /q-b\.txt/.test(r.prompt)).every((r) => r.model === 'm-two'), 'a task runs on the model it was queued with');
    for (const t of [ta, tb, tc]) {
      const s = api.getSession(t.sessionId!)!;
      assert.ok(s.worktree, 'with concurrency above 1 each task works in its own worktree');
      assert.ok(await exists(path.join(s.worktree!.path, `q-${t.prompt.match(/q-(\w)/)![1]}.txt`)), `${t.prompt}: file in its worktree`);
      await api.discardWorktree(s.id);
      q.remove(t.id);
    }
    await set('queue.concurrency', 1);
  });

  test('Multitask mode: the coordinator delegates to workers that run at the same time and only they edit', async () => {
    await set('worktrees.mode', 'off');
    try {
      const id = await api.runPrompt('COORD mt-w1.txt mt-w2.txt', 'multitask');
      await waitIdle([id]);
      assert.match(lastText(id), /COORD-DONE/, transcript(id));
      const s = api.getSession(id)!;
      const calls = s.messages.flatMap((m) => m.toolCalls?.map((c) => c.name) ?? []);
      assert.ok(calls.includes('run_parallel_subagents') && !calls.includes('write_file'), `the coordinator delegated: ${calls.join(', ')}`);
      const workers = mock.reqs.filter((r) => /WRITE file=mt-w/.test(r.prompt) && !/COORD/.test(r.prompt));
      assert.ok(overlap(workers) >= 2, `the workers ran at the same time (${workers.length} requests)`);
      for (const f of ['mt-w1.txt', 'mt-w2.txt']) {
        assert.strictEqual((await fs.readFile(path.join(root, f), 'utf8')).trim(), `from-${f}`, `${f} written by its worker`);
        await fs.rm(path.join(root, f));
      }
    } finally {
      await set('worktrees.mode', 'parallel');
    }
  });

  test('Agent mode: run_todos_parallel turns inline tasks into checklist items, runs them concurrently and ticks them off', async () => {
    await set('worktrees.mode', 'off');
    try {
      const id = await api.runPrompt('TODOS td-1.txt td-2.txt', 'agent');
      await waitIdle([id]);
      assert.match(lastText(id), /TODOS-DONE/, transcript(id));
      const todos = api.getSession(id)!.todos ?? [];
      assert.ok(todos.length === 2 && todos.every((t) => t.status === 'done'), `both items done: ${JSON.stringify(todos)}`);
      assert.ok(overlap(mock.reqs.filter((r) => /WRITE file=td-/.test(r.prompt) && !/TODOS/.test(r.prompt))) >= 2, 'the items ran at the same time');
      for (const f of ['td-1.txt', 'td-2.txt']) {
        assert.strictEqual((await fs.readFile(path.join(root, f), 'utf8')).trim(), `from-${f}`);
        await fs.rm(path.join(root, f));
      }
    } finally {
      await set('worktrees.mode', 'parallel');
    }
  });

  test('/skill and /agent run their task in the same run: started at once, shown as typed, skill preloaded', async () => {
    await set('worktrees.mode', 'off');
    const dir = path.join(root, '.localpilot', 'skills', 'greet');
    try {
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, 'SKILL.md'), '---\nname: greet\ndescription: Say hello in the house style\n---\n# Greet\n\nReply with the single word OK.\n', 'utf8');
      await vscode.commands.executeCommand('localpilot.reloadSkills');
      const id = await api.runPrompt('/skill greet say hello', 'agent');
      assert.ok(api.runningSessionIds.includes(id), 'the run is registered when runPrompt returns, not dropped or deferred');
      await waitIdle([id]);
      const msgs = api.getSession(id)!.messages;
      const user = msgs.find((m) => m.role === 'user' && !m.meta?.hidden);
      assert.strictEqual(user?.meta?.display, '/skill greet say hello', `the chat shows the command as typed: ${transcript(id)}`);
      assert.match(user!.content, /Use the "greet" skill for this task: say hello/);
      assert.ok(msgs.some((m) => m.role === 'user' && m.meta?.hidden && /<skill name="greet"/.test(m.content)), `skill preloaded: ${transcript(id)}`);
      assert.match(lastText(id), /OK/);

      const id2 = await api.runPrompt('/agent explore list the files', 'agent');
      assert.ok(api.runningSessionIds.includes(id2), 'the /agent run starts at once too');
      await waitIdle([id2]);
      const u2 = api.getSession(id2)!.messages.find((m) => m.role === 'user' && !m.meta?.hidden);
      assert.strictEqual(u2?.meta?.display, '/agent explore list the files');
      assert.match(u2!.content, /Delegate this to the "explore" subagent via run_subagent/);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
      await set('worktrees.mode', 'parallel');
    }
  });

  (process.platform === 'win32' ? test.skip : test)('CLI --multitask: the same coordinator and workers from the terminal', async () => {
    const cli = path.join(vscode.extensions.getExtension('localpilot.localpilot-agent')!.extensionPath, 'dist', 'cli.js');
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'lp-mt-home-'));
    const ws = path.join(home, 'ws');
    await fs.mkdir(path.join(home, '.localpilot'), { recursive: true });
    await fs.mkdir(ws);
    await fs.writeFile(path.join(home, '.localpilot', 'config.json'), JSON.stringify({ providers: [{ id: 'mt', type: 'openai', baseUrl: mock.url }], defaultModel: 'mt/m-one', 'routing.enabled': false, autoClarify: false, 'prompts.autoCorrect': false, 'clarify.questions': 'minimal', 'skills.autoInstall': 'off' }));
    try {
      const out = await new Promise<{ code: number | null; out: string }>((resolve) => {
        const child = cp.spawn(process.execPath, [cli, '-y', '-p', '--no-mcp', '--multitask', '-m', 'mt/m-one', 'COORD cli-1.txt cli-2.txt'], { cwd: ws, env: { ...process.env, HOME: home, USERPROFILE: home, NO_COLOR: '1' } });
        let o = '';
        child.stdout.on('data', (d) => (o += d));
        child.stderr.on('data', (d) => (o += d));
        child.stdin.end();
        const t = setTimeout(() => child.kill('SIGKILL'), 90_000);
        child.on('close', (code) => {
          clearTimeout(t);
          resolve({ code, out: o });
        });
      });
      assert.strictEqual(out.code, 0, out.out);
      assert.match(out.out, /COORD-DONE/);
      for (const f of ['cli-1.txt', 'cli-2.txt']) {
        assert.strictEqual((await fs.readFile(path.join(ws, f), 'utf8')).trim(), `from-${f}`, `${f}: ${out.out.slice(-800)}`);
      }
      assert.ok(overlap(mock.reqs.filter((r) => /WRITE file=cli-/.test(r.prompt) && !/COORD/.test(r.prompt))) >= 2, 'the CLI workers ran at the same time');
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });
});
