import * as assert from 'assert';
import { assessRequest, clarificationSteer, hasContextBlocks, userText } from '../agent/clarify';
import { builtinAgents, resolveAgentName } from '../agent/builtinAgents';

suite('Request clarification heuristics', () => {
  const unclear = (text: string, opts?: Parameters<typeof assessRequest>[1]) => {
    const r = assessRequest(text, opts);
    assert.strictEqual(r.clear, false, `expected "${text}" to be flagged, got clear`);
    assert.ok(r.reasons.length > 0);
    return r;
  };
  const clear = (text: string, opts?: Parameters<typeof assessRequest>[1]) => {
    const r = assessRequest(text, opts);
    assert.strictEqual(r.clear, true, `expected "${text}" to be clear, got: ${r.reasons.join('; ')}`);
  };

  test('flags terse requests with an unnamed target', () => {
    unclear('fix this');
    unclear('make it faster');
    unclear('fix');
    unclear('refactor');
    unclear('clean up the code');
    unclear('tests');
    unclear('why is the error happening');
    unclear('improve it');
  });

  test('accepts requests whose verb has a concrete object', () => {
    clear('write tests for the parser');
    clear('run the tests');
    clear('update the README');
    clear('add error handling');
    clear('remove unused imports');
    clear('write a function that reverses a string');
    clear('Please fix the bug in the login flow where the token is not refreshed');
  });

  test('accepts requests that name a file, symbol, selection or attachment', () => {
    clear('fix this', { hasSelection: true });
    clear('make this component responsive', { hasSelection: true });
    clear('fix the null check in src/agent/agentLoop.ts');
    clear('rename getUser to fetchUser everywhere');
    clear('add a `--quiet` flag to the CLI');
    clear('fix this', { hasAttachments: true });
    clear('what is wrong here?', { hasImages: true });
    clear('<attachment path="a.ts">\ncode\n</attachment>\n\nfix this', { hasAttachments: hasContextBlocks('<attachment path="a.ts">\ncode\n</attachment>\n\nfix this') });
    clear('explain how the compaction in ContextManager decides what to prune');
    clear('fix line 42');
    clear('look at #123');
  });

  test('accepts questions, greetings, slash commands and error dumps', () => {
    clear('hi');
    clear('thanks!');
    clear('/skills');
    clear('How does the agent loop decide when to compact the conversation?');
    clear('TypeError: Cannot read properties of undefined (reading "map")\n    at run (/x/agentLoop.ts:120:5)\n');
    clear('Error: ENOENT no such file\n at foo');
  });

  test('treats short follow-ups inside a conversation as clear', () => {
    clear('do it', { hasHistory: true });
    clear('go ahead', { hasHistory: true });
    clear('implement the plan', { hasHistory: true });
    clear('fix this', { hasHistory: true });
    unclear('do it', {});
  });

  test('still flags vague goals mid-conversation', () => {
    unclear('please make the whole thing nicer and faster', { hasHistory: true });
  });

  test('userText strips UI context blocks and image markers', () => {
    const content = '<attachment path="a.ts">\nconst x = 1;\n</attachment>\n\n<git>\n M a.ts\n</git>\n\nfix the types\n\n[1 image attached]';
    assert.strictEqual(userText(content), 'fix the types');
    assert.ok(hasContextBlocks(content));
    assert.ok(!hasContextBlocks('plain request'));
    // The global regex must not carry state between calls.
    assert.ok(hasContextBlocks(content));
  });

  test('clarificationSteer embeds the reasons and the snapshot', () => {
    const steer = clarificationSteer({ clear: false, reasons: ['it is only 2 words long'] }, '## Editor\nActive file: src/a.ts');
    assert.ok(steer.includes('it is only 2 words long'));
    assert.ok(steer.includes('Active file: src/a.ts'));
    assert.ok(steer.includes('Understood as'));
    assert.ok(steer.includes('ask_user'));
  });
});

suite('Built-in subagents', () => {
  const agents = builtinAgents();
  const names = agents.map((a) => a.name);

  test('ship the expected roster with unique names and non-empty prompts', () => {
    for (const n of ['clarifier', 'explore', 'planner', 'coder', 'tester', 'debugger', 'reviewer', 'docs', 'researcher']) {
      assert.ok(names.includes(n), `missing ${n}`);
    }
    assert.strictEqual(new Set(names).size, names.length);
    for (const a of agents) {
      assert.strictEqual(a.source, 'builtin');
      assert.ok(a.description.length > 20, `${a.name} description`);
      assert.ok(a.systemPrompt.includes('# Report'), `${a.name} lacks report rules`);
    }
  });

  test('read-only agents cannot edit or run commands', () => {
    for (const n of ['clarifier', 'explore', 'planner']) {
      const tools = agents.find((a) => a.name === n)!.tools!;
      assert.ok(tools.includes('gather_context'), `${n} should be able to gather context`);
      for (const forbidden of ['edit_file', 'write_file', 'run_command', 'delete_path']) {
        assert.ok(!tools.includes(forbidden), `${n} must not have ${forbidden}`);
      }
    }
    assert.ok(agents.find((a) => a.name === 'reviewer')!.tools!.includes('run_command'));
    assert.strictEqual(agents.find((a) => a.name === 'coder')!.tools, undefined);
  });

  test('resolveAgentName handles exact, case, alias, suffix and prefix matches', () => {
    assert.strictEqual(resolveAgentName('coder', names), 'coder');
    assert.strictEqual(resolveAgentName('Explore', names), 'explore');
    assert.strictEqual(resolveAgentName('review', names), 'reviewer');
    assert.strictEqual(resolveAgentName('debug', names), 'debugger');
    assert.strictEqual(resolveAgentName('test', names), 'tester');
    assert.strictEqual(resolveAgentName('explore agent', names), 'explore');
    assert.strictEqual(resolveAgentName('reviewer_subagent', names), 'reviewer');
    assert.strictEqual(resolveAgentName('plan', names), 'planner');
    assert.strictEqual(resolveAgentName('resear', names), 'researcher');
    assert.strictEqual(resolveAgentName('nonsense', names), undefined);
    assert.strictEqual(resolveAgentName('', names), undefined);
    // Custom agents win over aliases that would otherwise map elsewhere.
    assert.strictEqual(resolveAgentName('review', [...names, 'review']), 'review');
  });
});
