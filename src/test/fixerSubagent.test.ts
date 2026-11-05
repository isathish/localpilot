import * as assert from 'assert';
import { builtinAgents, resolveAgentName, routeSubagent } from '../agent/builtinAgents';
import { ChildWrites, HealingSyntheticContext, childEventOrigin, childMutated, childRecovery, verificationLine } from '../agent/childEvents';
import { createAgentTools } from '../agent/subagents';
import { AgentEvent, Tool, ToolContext } from '../types';

type RunOpts = { userMessage: { content: string }; healingRole?: string; emit: (e: AgentEvent) => void };

function parallelTool(play: (o: RunOpts) => Promise<string>): { tool: Tool; events: AgentEvent[]; opts: RunOpts[] } {
  const events: AgentEvent[] = [];
  const opts: RunOpts[] = [];
  const agents = builtinAgents();
  const skills = { allAgents: agents, allSkills: [], enabledSkills: [], getAgent: (n: string) => agents.find((a) => a.name === n), getSkill: () => undefined, resolveSkill: () => undefined, similarSkillNames: () => [], loadSkillBody: async () => undefined } as unknown as Parameters<typeof createAgentTools>[1];
  const runner = {
    run: (o: RunOpts) => {
      opts.push(o);
      return play(o);
    },
  } as unknown as Parameters<typeof createAgentTools>[0];
  const tools = createAgentTools(runner, skills, (e) => events.push(e), async () => true);
  return { tool: tools.find((t) => t.definition.name === 'run_parallel_subagents')!, events, opts };
}

function ctx(extra: Partial<HealingSyntheticContext> = {}): ToolContext {
  return { ...extra, sessionId: 'parent', signal: new AbortController().signal, depth: 0, modelRef: 'fake/model', progress: () => undefined, trackChange: async () => undefined, requestApproval: async () => true } as unknown as ToolContext;
}

const ev = (type: AgentEvent['type'], payload: unknown): AgentEvent => ({ sessionId: 'child', type, payload });

suite('Fixer subagent and healing child events', () => {
  test('ships a fixer persona with the narrow tool set and the Root cause / Blocked contract', () => {
    const agents = builtinAgents();
    const fixer = agents.find((a) => a.name === 'fixer')!;
    assert.ok(fixer, 'fixer exists');
    assert.deepStrictEqual([...fixer.tools!].sort(), ['apply_patch', 'edit_file', 'file_search', 'get_diagnostics', 'grep_search', 'list_dir', 'read_file', 'run_command', 'write_file']);
    assert.match(fixer.systemPrompt, /Root cause:/);
    assert.match(fixer.systemPrompt, /Blocked:/);
    assert.match(fixer.systemPrompt, /package\.json scripts/);
    assert.match(fixer.systemPrompt, /# Report/);
    assert.strictEqual(routeSubagent(fixer, undefined, 'ollama/big', { enabled: true }).role, 'agent');
    const names = agents.map((a) => a.name);
    assert.strictEqual(resolveAgentName('fixer', names), 'fixer');
    assert.strictEqual(resolveAgentName('fix', names), 'debugger', 'the old alias still points at the debugger');
  });

  test('the tool schema does not offer origin to the model', () => {
    const { tool } = parallelTool(async () => 'ok');
    assert.ok(!JSON.stringify(tool.definition.parameters).includes('origin'));
  });

  test('a plain model call with origin healing gets an ordinary worker', async () => {
    const { tool, events, opts } = parallelTool(async () => 'Root cause: x\nFiles: a.ts\nDone');
    const r = await tool.execute({ tasks: [{ agent: 'fixer', prompt: 'fix TS2345', origin: 'healing' }] }, ctx());
    assert.ok(!r.isError, r.content);
    assert.strictEqual(opts[0].healingRole, undefined);
    assert.strictEqual((events.find((e) => e.type === 'subagent_start')!.payload as { origin?: string }).origin, undefined);
  });

  test('on the engine synthetic call only healing-origin tasks get healingRole fixer, and the origin reaches subagent_start', async () => {
    const { tool, events, opts } = parallelTool(async () => 'Root cause: x\nFiles: a.ts\nDone');
    const r = await tool.execute({ tasks: [{ agent: 'fixer', prompt: 'fix TS2345', origin: 'healing' }, { agent: 'coder', prompt: 'add a flag' }, { agent: 'coder', prompt: 'other', origin: 'user' }] }, ctx({ healingSynthetic: true }));
    assert.ok(!r.isError, r.content);
    const byPrompt = (p: string) => opts.find((o) => o.userMessage.content === p)!;
    assert.strictEqual(byPrompt('fix TS2345').healingRole, 'fixer');
    assert.strictEqual(byPrompt('add a flag').healingRole, undefined);
    assert.strictEqual(byPrompt('other').healingRole, undefined);
    const starts = events.filter((e) => e.type === 'subagent_start').map((e) => e.payload as { prompt: string; origin?: string });
    assert.strictEqual(starts.find((s) => s.prompt === 'fix TS2345')!.origin, 'healing');
    assert.strictEqual(starts.find((s) => s.prompt === 'add a flag')!.origin, undefined);
  });

  test('a worker report gains a Verification line and subagent_end carries the recovery object', async () => {
    const { tool, events } = parallelTool(async (o) => {
      o.emit(ev('tool_end', { name: 'edit_file' }));
      o.emit(ev('turn_end', { completed: true, recovery: { healthy: false, failures: [{ code: 'TS2345', message: 'bad arg', file: 'src/a.ts', line: 4 }] } }));
      return 'Root cause: wrong type\nFiles: src/a.ts\nDone';
    });
    const r = await tool.execute({ tasks: [{ agent: 'fixer', prompt: 'fix it', origin: 'healing' }] }, ctx({ healingSynthetic: true }));
    assert.match(r.content, /Verification: 1 failure remains: TS2345 \(src\/a\.ts:4\)\./);
    const end = events.find((e) => e.type === 'subagent_end')!.payload as { recovery?: { healthy: boolean } };
    assert.strictEqual(end.recovery?.healthy, false);
  });

  test('files a child wrote reach subagent_end.payload.writtenFiles and the tool result data', async () => {
    const { tool, events } = parallelTool(async (o) => {
      o.emit(ev('tool_start', { id: 'c1', name: 'edit_file', args: { path: 'src/a.ts' } }));
      o.emit(ev('tool_end', { id: 'c1', name: 'edit_file', data: { path: '/ws/src/a.ts', line: 3 } }));
      o.emit(ev('tool_start', { id: 'c2', name: 'delete_path', args: { path: 'src/old.ts' } }));
      o.emit(ev('tool_end', { id: 'c2', name: 'delete_path' }));
      o.emit(ev('tool_start', { id: 'c3', name: 'write_file', args: { path: 'src/no.ts' } }));
      o.emit(ev('tool_end', { id: 'c3', name: 'write_file', isError: true }));
      o.emit(ev('tool_end', { id: 'c4', name: 'run_subagent', isError: true, data: { writtenFiles: ['/ws/src/nested.ts'] } }));
      o.emit(ev('turn_end', { completed: true }));
      return 'Root cause: x\nFiles: src/a.ts\nDone';
    });
    const r = await tool.execute({ tasks: [{ agent: 'coder', prompt: 'edit it' }] }, ctx({ workspaceRoot: '/ws' }));
    const expected = ['/ws/src/a.ts', '/ws/src/old.ts', '/ws/src/nested.ts'];
    assert.deepStrictEqual((events.find((e) => e.type === 'subagent_end')!.payload as { writtenFiles?: string[] }).writtenFiles, expected);
    assert.deepStrictEqual((r.data as { writtenFiles?: string[] }).writtenFiles, expected);
  });

  test('ChildWrites ignores wrapped grandchild events and healing-origin calls', () => {
    const w = new ChildWrites('/ws');
    w.note(ev('tool_end', { childId: 'g', agent: 'coder', inner: 'tool_end', data: { name: 'edit_file', data: { path: '/ws/x.ts' } } }));
    w.note(ev('tool_end', { id: 'h', name: 'edit_file', origin: 'healing', data: { path: '/ws/y.ts' } }));
    w.note(ev('tool_end', { id: 'p', name: 'apply_patch', data: { paths: ['/ws/p1.ts', '/ws/p2.ts'] } }));
    assert.deepStrictEqual(w.list(), ['/ws/p1.ts', '/ws/p2.ts']);
  });

  test('no recovery object: report and subagent_end are unchanged', async () => {
    const { tool, events } = parallelTool(async (o) => {
      o.emit(ev('tool_end', { name: 'edit_file' }));
      o.emit(ev('turn_end', { completed: true }));
      return 'changed it';
    });
    const r = await tool.execute({ tasks: [{ agent: 'coder', prompt: 'do it' }] }, ctx());
    assert.ok(!/Verification:/.test(r.content), r.content);
    const end = events.find((e) => e.type === 'subagent_end')!.payload as { recovery?: unknown; writtenFiles?: unknown };
    assert.strictEqual(end.recovery, undefined);
    assert.strictEqual(end.writtenFiles, undefined, 'a tool_end without a path or start args records nothing');
  });

  test('a healing verification run does not count as the worker changing something', async () => {
    const { tool } = parallelTool(async (o) => {
      o.emit(ev('tool_end', { name: 'run_command', origin: 'healing' }));
      o.emit(ev('turn_end', { completed: true }));
      return 'I fixed the bug.';
    });
    const r = await tool.execute({ tasks: [{ agent: 'coder', prompt: 'fix the bug' }] }, ctx());
    assert.match(r.content, /made no file edits/);
  });

  test('origin and recovery are read from the child payload or the wrapped payload.data', () => {
    const own = ev('tool_end', { name: 'run_command', origin: 'healing' });
    const nested = ev('tool_end', { childId: 'c', agent: 'coder', inner: 'tool_end', data: { name: 'run_command', origin: 'healing' } });
    assert.strictEqual(childEventOrigin(own), 'healing');
    assert.strictEqual(childEventOrigin(nested), 'healing');
    const mutating = new Set(['run_command', 'edit_file']);
    assert.strictEqual(childMutated(own, mutating), false);
    assert.strictEqual(childMutated(nested, mutating), false);
    assert.strictEqual(childMutated(ev('tool_end', { name: 'run_command' }), mutating), true);
    assert.strictEqual(childMutated(ev('tool_end', { name: 'edit_file', isError: true }), mutating), false);
    assert.strictEqual(childMutated(ev('tool_start', { name: 'edit_file' }), mutating), false);
    assert.deepStrictEqual(childRecovery({ data: { recovery: { healthy: true } } }), { healthy: true });
    assert.strictEqual(childRecovery({ completed: true }), undefined);
  });

  test('verificationLine formats healthy, failing, summary and empty recoveries', () => {
    assert.strictEqual(verificationLine(undefined), undefined);
    assert.strictEqual(verificationLine({ healthy: true, failures: [] }), 'Verification: scoped checks pass.');
    assert.strictEqual(verificationLine({ healthy: false, failures: ['a', 'b', 'c', 'd'] }), 'Verification: 4 failures remain: a; b; c (+1 more).');
    assert.strictEqual(verificationLine({ healthy: false }), 'Verification: checks still failing.');
    assert.strictEqual(verificationLine({ report: 'Verified: typecheck ✓' }), 'Verification: Verified: typecheck ✓');
    assert.strictEqual(verificationLine({ outcome: 'completed_unverified' }), 'Verification: completed unverified.');
    assert.strictEqual(verificationLine({}), undefined);
  });
});
