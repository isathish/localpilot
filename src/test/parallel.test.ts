import * as assert from 'assert';
import * as vscode from 'vscode';
import { isImplementPlanRequest } from '../agent/agentLoop';
import { builtinAgents } from '../agent/builtinAgents';
import { manageTodosTool } from '../agent/memory';
import { balancedShards, nextWave, ParallelPool } from '../agent/parallel';
import { createAgentTools } from '../agent/subagents';
import { formatAnalysis, summarizeManifest, summarizeWorkspace } from '../tools/workspace';
import { AgentEvent, TodoItem, Tool, ToolContext } from '../types';

suite('Parallel execution: dependency waves, sharding and plan handoff', () => {
  test('nextWave releases independent items first, dependents after, and blocks on failures', () => {
    const items = [
      { id: '1' },
      { id: '2', dependsOn: ['1'] },
      { id: '3' },
      { id: '4', dependsOn: ['2', '3'] },
      { id: '5', dependsOn: ['9'] }, // 9 is not in the set and not satisfied: waits for someone else
    ];
    const satisfied = new Set<string>();
    const failed = new Set<string>();
    let w = nextWave(items, satisfied, failed);
    assert.deepStrictEqual(w.ready.map((i) => i.id), ['1', '3']);
    assert.deepStrictEqual(w.blocked, []);
    satisfied.add('1');
    satisfied.add('3');
    w = nextWave(items.filter((i) => !satisfied.has(i.id)), satisfied, failed);
    assert.deepStrictEqual(w.ready.map((i) => i.id), ['2']);
    failed.add('2');
    w = nextWave(items.filter((i) => !satisfied.has(i.id) && i.id !== '2'), satisfied, failed);
    assert.deepStrictEqual(w.ready, []);
    assert.deepStrictEqual(w.blocked.map((i) => i.id), ['4'], 'an item whose prerequisite failed is blocked');
    assert.deepStrictEqual(w.cyclic, [], 'waiting on an outside id is not a cycle');
  });

  test('nextWave reports cycles instead of deadlocking', () => {
    const w = nextWave([{ id: 'a', dependsOn: ['b'] }, { id: 'b', dependsOn: ['a'] }], new Set(), new Set());
    assert.deepStrictEqual(w.ready, []);
    assert.deepStrictEqual(w.cyclic.map((i) => i.id).sort(), ['a', 'b']);
    const self = nextWave([{ id: 'a', dependsOn: ['a'] }], new Set(), new Set());
    assert.deepStrictEqual(self.ready.map((i) => i.id), ['a'], 'a self-dependency is ignored');
  });

  test('balancedShards keeps items whole and balances weight', () => {
    const items = [{ p: 'src', n: 50 }, { p: 'docs', n: 10 }, { p: 'test', n: 20 }, { p: 'media', n: 15 }, { p: 'scripts', n: 5 }];
    const shards = balancedShards(items, (i) => i.n, 3);
    assert.strictEqual(shards.length, 3);
    assert.strictEqual(shards.flat().length, items.length, 'every item lands in exactly one shard');
    const weights = shards.map((s) => s.reduce((a, i) => a + i.n, 0));
    assert.deepStrictEqual(weights, [50, 25, 25]);
    assert.strictEqual(balancedShards(items, (i) => i.n, 10).length, items.length, 'never more shards than items');
    assert.deepStrictEqual(balancedShards([], () => 1, 3), []);
  });

  test('summarizeWorkspace counts languages/tests per folder and proposes shards', () => {
    const paths = [
      ...Array.from({ length: 30 }, (_, i) => `src/agent/a${i}.ts`),
      ...Array.from({ length: 30 }, (_, i) => `src/ui/u${i}.ts`),
      ...Array.from({ length: 12 }, (_, i) => `src/test/t${i}.test.ts`),
      ...Array.from({ length: 10 }, (_, i) => `docs/d${i}.md`),
      ...Array.from({ length: 6 }, (_, i) => `media/m${i}.css`),
      'package.json',
      'README.md',
    ];
    const a = summarizeWorkspace('/ws', paths, 4);
    assert.strictEqual(a.files, paths.length);
    assert.strictEqual(a.languages[0].name, 'TypeScript');
    assert.strictEqual(a.testFiles, 12);
    assert.strictEqual(a.folders[0].path, 'src/');
    assert.strictEqual(a.folders[0].tests, 12);
    assert.deepStrictEqual(a.rootFiles, ['README.md', 'package.json']);
    assert.ok(a.shards.length >= 2 && a.shards.length <= 4, `shards: ${a.shards.length}`);
    assert.strictEqual(a.shards.reduce((n, s) => n + s.files, 0), paths.length, 'shards cover every file');
    assert.ok(a.shards.some((s) => s.paths.includes('src/agent')), 'a big top-level folder is split by subfolder');
    const text = formatAnalysis(a);
    assert.match(text, /Suggested shards for a parallel analysis/);
    assert.match(text, /run_parallel_subagents/);
  });

  test('summarizeManifest never quotes the manifest, just the shape', () => {
    const pkg = JSON.stringify({ name: 'demo', version: '1.2.3', scripts: { build: 'tsc', test: 'vitest' }, dependencies: { a: '1', b: '2' }, devDependencies: { c: '3' } });
    assert.strictEqual(summarizeManifest('package.json', pkg), 'demo@1.2.3 · 2 deps, 1 dev deps · scripts: build, test');
    assert.strictEqual(summarizeManifest('go.mod', 'module example.com/x\n\nrequire (\n\tgithub.com/a/b v1.0.0\n\tgithub.com/c/d v2.1.0\n)\n'), 'example.com/x · 2 requirements');
    assert.strictEqual(summarizeManifest('Dockerfile', 'FROM node:22-alpine\nRUN npm ci\n'), 'base: node:22-alpine');
    assert.strictEqual(summarizeManifest('Makefile', 'build:\n\tgo build\ntest:\n\tgo test\n'), 'targets: build, test');
  });

  test('isImplementPlanRequest recognises plan-execution requests only', () => {
    for (const t of ['implement the plan', 'Implement the plan now', 'go ahead and run the checklist', 'execute the todos', 'proceed', 'do it', 'go ahead with the plan please', 'start the tasks']) {
      assert.ok(isImplementPlanRequest(t), t);
    }
    for (const t of ['what is the plan?', 'explain the plan', 'add a test for the parser', 'run the tests', 'fix the login bug']) {
      assert.ok(!isImplementPlanRequest(t), t);
    }
  });

  test('manage_todos keeps dependsOn (dropping self and unknown ids) and reports delegable items', async () => {
    let todos: TodoItem[] = [];
    const ctx = fakeCtx({ get: () => todos, set: (t) => (todos = t) });
    const r = await manageTodosTool.execute(
      {
        todos: [
          { id: '1', title: 'Explore', status: 'pending', agent: 'explore', prompt: 'look' },
          { id: '2', title: 'Implement', status: 'pending', agent: 'coder', prompt: 'do', dependsOn: ['1', '2', 'nope'] },
          { id: '3', title: 'Integrate', status: 'pending' },
        ],
      },
      ctx
    );
    assert.deepStrictEqual(todos[1].dependsOn, ['1']);
    assert.strictEqual(todos[0].dependsOn, undefined);
    assert.match(r.content, /2 items can run as subagents/);
    assert.match(r.content, /2\. Implement → coder \(after 1\)/);
    // A later update without dependsOn keeps the earlier value; an explicit empty list clears it.
    await manageTodosTool.execute({ todos: [{ id: '1', title: 'Explore', status: 'done' }, { id: '2', title: 'Implement', status: 'pending' }] }, ctx);
    assert.deepStrictEqual(todos[1].dependsOn, ['1']);
    assert.strictEqual(todos[1].agent, 'coder');
    await manageTodosTool.execute({ todos: [{ id: '2', title: 'Implement', status: 'pending', dependsOn: [] }] }, ctx);
    assert.strictEqual(todos[0].dependsOn, undefined);
  });

  test('run_todos_parallel runs the checklist in dependency waves and hands reports to dependents', async function () {
    this.timeout(20_000);
    const prevConc = vscode.workspace.getConfiguration('localpilot').get<number>('parallel.maxConcurrency');
    await vscode.workspace.getConfiguration('localpilot').update('parallel.maxConcurrency', 4, vscode.ConfigurationTarget.Global);
    try {
      const starts: string[] = [];
      const prompts = new Map<string, string>();
      let active = 0;
      let peak = 0;
      const { tool, events } = fanOutTool(async (prompt) => {
        const id = /checklist item (\S+) \(/.exec(prompt)![1];
        starts.push(id);
        prompts.set(id, prompt);
        active++;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 120));
        active--;
        if (id === 'x') {
          throw new Error('boom');
        }
        return `report-${id}`;
      });
      let todos: TodoItem[] = [
        { id: '1', title: 'Explore the code', status: 'pending', agent: 'explore', prompt: 'look around' },
        { id: '2', title: 'Implement the change', status: 'pending', agent: 'coder', prompt: 'change it', dependsOn: ['1'] },
        { id: '3', title: 'Write docs', status: 'pending', agent: 'docs', prompt: 'document it' },
        { id: '4', title: 'Test everything', status: 'pending', agent: 'tester', dependsOn: ['2', '3'] },
        { id: '5', title: 'Integrate (main agent)', status: 'pending' },
        { id: 'x', title: 'Flaky item', status: 'pending', agent: 'coder', prompt: 'fail' },
        { id: 'y', title: 'Depends on the flaky item', status: 'pending', agent: 'coder', prompt: 'never', dependsOn: ['x'] },
        { id: 'z', title: 'Waits for the main agent', status: 'pending', agent: 'coder', prompt: 'later', dependsOn: ['5'] },
      ];
      const ctx = fakeCtx({ get: () => todos, set: (t) => (todos = t) });
      const r = await tool.execute({}, ctx);
      // Wave 1: 1, 3, x together; wave 2: 2; wave 3: 4.
      assert.deepStrictEqual(starts.slice(0, 3).sort(), ['1', '3', 'x'], `wave 1: ${starts.join(',')}`);
      assert.deepStrictEqual(starts.slice(3), ['2', '4'], `later waves: ${starts.join(',')}`);
      assert.ok(peak >= 2, `independent items ran concurrently (peak ${peak})`);
      assert.match(prompts.get('2')!, /Reports from the prerequisite items[\s\S]*### Item 1\nreport-1/, 'dependent gets its prerequisite report');
      assert.match(prompts.get('4')!, /### Item 2\nreport-2[\s\S]*### Item 3\nreport-3/);
      assert.match(prompts.get('4')!, /Carry out checklist item 4: "Test everything"/, 'an item without a prompt gets one from its title');
      const byId = Object.fromEntries(todos.map((t) => [t.id, t.status]));
      assert.deepStrictEqual(byId, { '1': 'done', '2': 'done', '3': 'done', '4': 'done', '5': 'pending', x: 'skipped', y: 'skipped', z: 'pending' });
      assert.match(todos.find((t) => t.id === 'y')!.result ?? '', /prerequisite x failed/);
      assert.match(r.content, /4\/7 items completed in 3 waves/);
      assert.match(r.content, /Not started: z \(waiting for 5/);
      assert.match(r.content, /## y\. Depends on the flaky item \(coder\) — FAILED/);
      assert.ok(!r.isError, 'partial success is not an error');
      assert.ok(events.some((e) => e.type === 'status' && /wave 1/.test(String(e.payload))), 'the UI is told about each wave');
      assert.ok(events.filter((e) => e.type === 'subagent_start').length === 5, 'one child per executed item');
    } finally {
      await vscode.workspace.getConfiguration('localpilot').update('parallel.maxConcurrency', prevConc, vscode.ConfigurationTarget.Global);
    }
  });

  test('run_todos_parallel accepts the work inline as "tasks": items are created, run and ticked off', async function () {
    this.timeout(20_000);
    const starts: string[] = [];
    const { tool } = fanOutTool(async (prompt) => {
      const id = /checklist item (\S+) \(/.exec(prompt)![1];
      starts.push(id);
      await new Promise((r) => setTimeout(r, 60));
      return `report-${id}`;
    });
    let todos: TodoItem[] = [{ id: '1', title: 'Already there', status: 'done' }];
    const ctx = fakeCtx({ get: () => todos, set: (t) => (todos = t) });
    const r = await tool.execute({ tasks: [{ title: 'Create alpha', agent: 'coder', prompt: 'make alpha.txt' }, { title: 'Create beta', agent: 'coder', prompt: 'make beta.txt' }, { title: 'Verify both', agent: 'tester', prompt: 'check both files', dependsOn: ['Create alpha', 'Create beta'] }] }, ctx);
    assert.ok(!r.isError, r.content);
    assert.deepStrictEqual(todos.map((t) => `${t.id}:${t.title}:${t.status}`), ['1:Already there:done', '2:Create alpha:done', '3:Create beta:done', '4:Verify both:done'], JSON.stringify(todos));
    assert.deepStrictEqual(todos[3].dependsOn, ['2', '3'], 'dependsOn by title resolved to the new ids');
    assert.deepStrictEqual(starts.slice(0, 2).sort(), ['2', '3'], `independent inline tasks first: ${starts.join(',')}`);
    assert.strictEqual(starts[2], '4', 'dependent inline task after its prerequisites');
    assert.match(r.content, /report-2[\s\S]*report-3[\s\S]*report-4/);
  });

  test('run_todos_parallel refuses in read-only modes and when nothing is delegable', async () => {
    const { tool } = fanOutTool(async () => 'ok');
    let todos: TodoItem[] = [{ id: '1', title: 'Do it', status: 'pending', agent: 'coder', prompt: 'x' }];
    const ro = await tool.execute({}, { ...fakeCtx({ get: () => todos, set: (t) => (todos = t) }), readOnly: true });
    assert.ok(ro.isError && /Agent mode/.test(ro.content));
    assert.strictEqual(todos[0].status, 'pending');
    todos = [{ id: '1', title: 'Main agent item', status: 'pending' }];
    const none = await tool.execute({}, fakeCtx({ get: () => todos, set: (t) => (todos = t) }));
    assert.ok(none.isError && /Nothing to run/.test(none.content));
  });

  test('ParallelPool bounds concurrency and preserves order', async () => {
    const pool = new ParallelPool(2);
    let active = 0;
    let peak = 0;
    const out = await pool.map([30, 10, 20, 5], async (ms) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, ms));
      active--;
      return ms;
    });
    assert.strictEqual(peak, 2);
    assert.deepStrictEqual(out.map((r) => (r.status === 'fulfilled' ? r.value : -1)), [30, 10, 20, 5]);
  });
});

function fakeCtx(todos: ToolContext['todos']): ToolContext {
  return {
    sessionId: 'parent',
    signal: new AbortController().signal,
    depth: 0,
    modelRef: 'fake/model',
    progress: () => undefined,
    trackChange: async () => undefined,
    requestApproval: async () => true,
    todos,
  };
}

/** createAgentTools with a fake runner: `answer(prompt)` plays the subagent. */
function fanOutTool(answer: (prompt: string) => Promise<string>): { tool: Tool; events: AgentEvent[] } {
  const events: AgentEvent[] = [];
  const agents = builtinAgents();
  const skills = { allAgents: agents, allSkills: [], getAgent: (n: string) => agents.find((a) => a.name === n), loadSkillBody: async () => undefined } as unknown as Parameters<typeof createAgentTools>[1];
  const runner = { run: (o: { userMessage: { content: string } }) => answer(o.userMessage.content) } as unknown as Parameters<typeof createAgentTools>[0];
  const tools = createAgentTools(runner, skills, (e) => events.push(e), async () => true);
  return { tool: tools.find((t) => t.definition.name === 'run_todos_parallel')!, events };
}
