import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { builtinAgents } from '../agent/builtinAgents';
import { classifyTask } from '../agent/taskRouter';
import { agentTemplate, APPROVAL_SETTING, buildAgentMap, MapInputs, MapNode, ROLE_SETTING, routePath, routeTarget, skillTemplate, slugName, toolGroup } from '../ui/agentMapData';
import { parseFrontMatter } from '../agent/frontMatter';

/** A fake configuration and registry snapshot: what AgentMapPanel.collect() reads from settings, SkillManager, the tool registry and McpManager. */
export function fakeInputs(over: Partial<MapInputs> = {}): MapInputs {
  return {
    defaultModel: 'ollama/qwen2.5-coder:14b',
    routing: { enabled: true, reasoning: 'ollama/gpt-oss:20b', fast: undefined, coding: undefined, vision: undefined },
    localOnly: false,
    resolved: { agent: 'ollama/qwen2.5-coder:14b', reasoning: 'ollama/gpt-oss:20b', fast: 'ollama/qwen3:4b', coding: 'ollama/qwen2.5-coder:14b', vision: 'ollama/gemma3:12b' },
    models: [{ id: 'ollama/qwen2.5-coder:14b', name: 'qwen2.5-coder:14b' }, { id: 'ollama/gpt-oss:20b', name: 'gpt-oss:20b' }, { id: 'ollama/qwen3:4b', name: 'qwen3:4b' }, { id: 'openai/gpt-5', name: 'gpt-5', remote: true }],
    agents: [
      ...builtinAgents().map((a) => ({ name: a.name, description: a.description, source: a.source, tools: a.tools, model: a.model, skills: a.skills })),
      { name: 'migrator', description: 'Moves code to the new API.', source: 'workspace', tools: ['read_file', 'edit_file', 'load_skill'], skills: ['deploy'], file: '/ws/.localpilot/agents/migrator.md' },
      { name: 'docs-bot', description: 'Answers from the docs.', source: 'user', tools: ['read_file', 'grep_search'], model: 'ollama/qwen3:4b', file: '/home/.claude/agents/docs-bot.md', plugin: true },
    ],
    skills: [
      { name: 'review', description: 'Review a diff', source: 'builtin', path: '/ext/skills/review/SKILL.md' },
      { name: 'deploy', description: 'Ship it', source: 'workspace', path: '/ws/.localpilot/skills/deploy/SKILL.md' },
      { name: 'old-style', description: 'Legacy', source: 'user', disabled: true, path: '/home/.localpilot/skills/old-style/SKILL.md' },
      { name: 'security-baseline', description: 'Org rules', source: 'managed', alwaysEnabled: true, path: '/etc/lp/skills/security-baseline/SKILL.md' },
      { name: 'lint-fix', description: 'From a plugin', source: 'user', plugin: true, path: '/home/.localpilot/plugins/p/skills/lint-fix/SKILL.md' },
    ],
    skillUse: { deploy: { count: 3, last: Date.UTC(2026, 10, 1) } },
    tools: [
      { name: 'read_file', description: 'Read a file.' },
      { name: 'grep_search', description: 'Search.' },
      { name: 'edit_file', description: 'Edit.', approvalKind: 'write' },
      { name: 'write_file', description: 'Write.', approvalKind: 'write' },
      { name: 'delete_path', description: 'Delete.', approvalKind: 'delete' },
      { name: 'run_command', description: 'Run.', approvalKind: 'terminal' },
      { name: 'web_search', description: 'Search the web.', approvalKind: 'network' },
      { name: 'browser_screenshot', description: 'Screenshot.', approvalKind: 'network' },
      { name: 'run_subagent', description: 'Delegate.' },
      { name: 'run_parallel_subagents', description: 'Delegate many.' },
      { name: 'load_skill', description: 'Load a skill.' },
      { name: 'mcp_github_create_issue', description: 'MCP tool.', approvalKind: 'mcp' },
    ],
    disabledTools: ['browser_*'],
    approvals: { terminal: 'ask', write: 'always', delete: 'ask', network: 'always', mcp: 'ask' },
    mcp: [
      { name: 'github', state: 'connected', tools: 12, source: 'user', transport: 'http' },
      { name: 'postgres', state: 'error', tools: 0, error: 'spawn ENOENT', source: 'workspace' },
      { name: 'org-search', state: 'disabled', tools: 0, source: 'plugin' },
    ],
    hasFolder: true,
    ...over,
  };
}

const node = (nodes: MapNode[], id: string) => {
  const n = nodes.find((x) => x.id === id);
  assert.ok(n, `missing node ${id}`);
  return n!;
};

suite('Agent map: graph model', () => {
  test('nodes: Auto, every model role, mode, specialist, subagent, skill, tool group and MCP server', () => {
    const m = buildAgentMap(fakeInputs());
    const ids = m.nodes.map((n) => n.id);
    for (const id of ['auto', 'role:agent', 'role:reasoning', 'role:fast', 'role:coding', 'role:vision']) {
      assert.ok(ids.includes(id), id);
    }
    for (const mode of ['ask', 'agent', 'plan', 'debug', 'multitask']) {
      assert.strictEqual(node(m.nodes, `mode:${mode}`).col, 1);
    }
    for (const s of ['architect', 'review', 'test', 'refactor', 'explain', 'terminal', 'project']) {
      assert.strictEqual(node(m.nodes, `spec:${s}`).kind, 'specialist');
    }
    for (const a of ['clarifier', 'explore', 'planner', 'coder', 'tester', 'debugger', 'reviewer', 'docs', 'researcher', 'migrator', 'docs-bot']) {
      assert.strictEqual(node(m.nodes, `agent:${a}`).col, 2, a);
    }
    assert.deepStrictEqual(m.nodes.filter((n) => n.kind === 'tools').map((n) => n.id), ['tools:read', 'tools:write', 'tools:delete', 'tools:terminal', 'tools:network', 'tools:delegate']);
    assert.deepStrictEqual(m.nodes.filter((n) => n.kind === 'mcp').map((n) => n.id), ['mcp:github', 'mcp:org-search', 'mcp:postgres']);
    // MCP tools belong to their server, not to a tool group.
    assert.ok(!m.nodes.some((n) => n.items?.some((t) => t.name.startsWith('mcp_'))));
    // Layers only ever increase from Auto to the tools, which is what the layered layout draws.
    assert.deepStrictEqual([...new Set(m.nodes.map((n) => n.col))], [0, 1, 2, 3, 4]);
    // Deterministic: same inputs, same model.
    assert.deepStrictEqual(buildAgentMap(fakeInputs()), m);
  });

  test('counts match the inputs', () => {
    const m = buildAgentMap(fakeInputs());
    assert.deepStrictEqual(m.counts, { modes: 5, specialists: 7, subagents: builtinAgents().length + 2, customAgents: 2, skills: 5, skillsOn: 4, tools: 11, toolsOff: 1, mcp: 3, mcpConnected: 1 });
  });

  test('sources, models and states are the live ones', () => {
    const m = buildAgentMap(fakeInputs());
    assert.strictEqual(node(m.nodes, 'agent:migrator').source, 'workspace');
    assert.strictEqual(node(m.nodes, 'agent:docs-bot').source, 'plugin');
    assert.strictEqual(node(m.nodes, 'agent:docs-bot').model, 'ollama/qwen3:4b', 'a model in the agent file wins');
    assert.strictEqual(node(m.nodes, 'agent:explore').role, 'fast', 'read-only subagents use the fast role');
    assert.strictEqual(node(m.nodes, 'agent:coder').role, 'coding', 'writers use the coding role');
    assert.strictEqual(node(m.nodes, 'mode:plan').role, 'reasoning');
    assert.strictEqual(node(m.nodes, 'mode:plan').model, 'ollama/gpt-oss:20b');
    assert.strictEqual(node(m.nodes, 'role:fast').sub, 'Auto → qwen3:4b', 'an empty role shows what it resolves to');
    assert.strictEqual(node(m.nodes, 'role:reasoning').sub, 'gpt-oss:20b');
    assert.deepStrictEqual(node(m.nodes, 'mode:ask').can, { reads: 'Yes', edits: 'No', runs: 'Read-only commands' });
    assert.deepStrictEqual(node(m.nodes, 'mode:multitask').can, { reads: 'Yes', edits: 'Through its workers', runs: 'Yes' });
    assert.strictEqual(node(m.nodes, 'skill:old-style').status, 'off');
    assert.strictEqual(node(m.nodes, 'skill:lint-fix').source, 'plugin');
    assert.match(node(m.nodes, 'skill:deploy').sub!, /used 3×/);
    assert.strictEqual(node(m.nodes, 'mcp:postgres').status, 'error');
    assert.strictEqual(node(m.nodes, 'mcp:org-search').status, 'off');
    const net = node(m.nodes, 'tools:network');
    assert.strictEqual(net.items!.find((t) => t.name === 'browser_screenshot')!.on, false, 'disabledTools globs switch tools off');
    assert.ok(net.items!.find((t) => t.name === 'browser_screenshot')!.action!.kind === 'toggle');
    assert.strictEqual(toolGroup({ name: 'load_skill', description: '' }), 'delegate');
    // Routing off: the roles say so.
    const off = buildAgentMap(fakeInputs({ routing: { enabled: false } }));
    assert.strictEqual(node(off.nodes, 'role:fast').status, 'off');
    assert.strictEqual(off.routingEnabled, false);
  });

  test('edges: Auto → modes and specialists, specialist → playbook, mode → subagents, agent → skills, tools and roles', () => {
    const m = buildAgentMap(fakeInputs());
    const has = (from: string, to: string, kind?: string) => m.edges.some((e) => e.from === from && e.to === to && (!kind || e.kind === kind));
    assert.ok(has('auto', 'mode:debug', 'route'));
    assert.ok(has('auto', 'spec:review', 'route'));
    assert.ok(has('auto', 'mode:multitask', 'route'));
    assert.ok(has('spec:review', 'agent:reviewer', 'playbook'));
    assert.ok(has('spec:refactor', 'agent:coder', 'playbook'));
    assert.ok(!m.edges.some((e) => e.from === 'spec:terminal' && e.kind === 'playbook'), 'Terminal has no playbook agent');
    assert.ok(has('mode:agent', 'agent:coder', 'delegate'));
    assert.ok(has('mode:ask', 'agent:migrator', 'delegate'));
    assert.strictEqual(m.edges.find((e) => e.from === 'mode:ask' && e.to === 'agent:coder')!.label, 'read-only');
    assert.ok(has('agent:migrator', 'skill:deploy', 'preload'));
    assert.ok(has('agent:migrator', 'skill:review', 'skill'), 'load_skill in its tools: it can load skills');
    assert.ok(!has('agent:docs-bot', 'skill:review', 'skill'), 'no load_skill: no skills');
    assert.ok(!m.edges.some((e) => e.to === 'skill:old-style' && e.kind === 'skill'), 'nobody loads a disabled skill');
    assert.ok(has('agent:migrator', 'tools:write', 'tool'));
    assert.ok(!has('agent:migrator', 'tools:terminal', 'tool'));
    assert.ok(!has('agent:migrator', 'mcp:github'), 'a restricted agent without MCP tools gets no server');
    assert.ok(has('agent:coder', 'mcp:github'), 'no tool list: every server');
    assert.ok(has('mode:agent', 'tools:delete') && !has('mode:ask', 'tools:delete') && !has('mode:multitask', 'tools:write'));
    assert.ok(has('mode:plan', 'role:reasoning', 'model') && has('agent:explore', 'role:fast', 'model') && has('agent:coder', 'role:coding', 'model'));
    assert.ok(!m.edges.some((e) => e.from === 'agent:docs-bot' && e.kind === 'model'), 'a pinned model has no role');
    for (const e of m.edges) {
      assert.ok(m.nodes.some((n) => n.id === e.from) && m.nodes.some((n) => n.id === e.to), `dangling edge ${e.from} → ${e.to}`);
    }
    // run_subagent switched off: nobody can start a subagent.
    const noDelegation = buildAgentMap(fakeInputs({ disabledTools: ['run_subagent', 'run_parallel_subagents'] }));
    assert.ok(!noDelegation.edges.some((e) => e.kind === 'delegate'));
  });

  test('Auto routing path for sample messages', () => {
    const m = buildAgentMap(fakeInputs());
    const go = (text: string) => {
      const r = classifyTask({ text, hasFolder: true });
      const p = routePath(r);
      p.forEach((id) => node(m.nodes, id));
      return { label: routeTarget(r), path: p };
    };
    assert.deepStrictEqual(go('TypeError: cannot read properties of undefined in checkout.ts'), { label: 'Debug', path: ['auto', 'mode:debug', 'role:agent'] });
    assert.deepStrictEqual(go('Review my changes before I open the PR'), { label: 'Review', path: ['auto', 'spec:review', 'mode:ask', 'agent:reviewer', 'role:reasoning'] });
    assert.deepStrictEqual(go('Is this function pure?'), { label: 'Ask', path: ['auto', 'mode:ask', 'role:fast'] });
    assert.deepStrictEqual(go('Plan how we should add OAuth login'), { label: 'Plan', path: ['auto', 'mode:plan', 'role:reasoning'] });
    assert.deepStrictEqual(go('Run npm install and start the dev server'), { label: 'Terminal', path: ['auto', 'spec:terminal', 'mode:agent', 'role:agent'] });
    // Every kind Auto knows lands on a node of the map.
    for (const r of m.routes) {
      node(m.nodes, r.target);
      assert.ok(m.edges.some((e) => e.from === 'auto' && e.to === r.target && e.kind === 'route'));
    }
  });

  test('actions map to the right setting keys', () => {
    const m = buildAgentMap(fakeInputs());
    const act = (id: string, aid: string) => node(m.nodes, id).actions.find((a) => a.id === aid)!;
    for (const [role, key] of Object.entries(ROLE_SETTING)) {
      const a = act(`role:${role}`, 'setRole');
      assert.strictEqual(a.kind === 'select' && a.setting, key);
    }
    assert.deepStrictEqual(ROLE_SETTING, { agent: 'defaultModel', reasoning: 'routing.reasoning', fast: 'routing.fast', coding: 'routing.coding', vision: 'routing.vision' });
    const fast = act('role:fast', 'setRole');
    assert.ok(fast.kind === 'select' && fast.options.some((o) => o.value === 'session') && fast.options.some((o) => o.value === 'openai/gpt-5'));
    assert.ok(fast.kind === 'select' && fast.value === '', 'an empty role shows Automatic');
    const skill = act('skill:deploy', 'toggleSkill');
    assert.ok(skill.kind === 'toggle' && skill.setting === 'skills.disabled' && skill.on);
    const off = act('skill:old-style', 'toggleSkill');
    assert.ok(off.kind === 'toggle' && !off.on);
    const locked = act('skill:security-baseline', 'toggleSkill');
    assert.ok(locked.kind === 'toggle' && locked.locked, 'always-on skills cannot be switched off');
    assert.strictEqual(act('skill:deploy', 'openFile').kind === 'button' && act('skill:deploy', 'openFile').arg, '/ws/.localpilot/skills/deploy/SKILL.md');
    for (const [g, kind] of [['tools:write', 'write'], ['tools:delete', 'delete'], ['tools:terminal', 'terminal'], ['tools:network', 'network']] as const) {
      const a = act(g, 'setApproval');
      assert.ok(a.kind === 'select' && a.setting === APPROVAL_SETTING[kind] && a.setting === `approvals.${kind}`, g);
    }
    const term = act('tools:terminal', 'setApproval');
    assert.ok(term.kind === 'select' && term.value === 'ask' && term.options.map((o) => o.value).join() === 'always,safe,ask,never');
    assert.strictEqual(node(m.nodes, 'tools:read').actions.length, 0, 'read tools never ask');
    const tool = node(m.nodes, 'tools:write').items![0].action!;
    assert.ok(tool.kind === 'toggle' && tool.setting === 'disabledTools');
    const mcp = act('mcp:github', 'toggleMcp');
    assert.ok(mcp.kind === 'toggle' && mcp.on && !mcp.locked);
    assert.ok(act('mcp:org-search', 'toggleMcp').kind === 'toggle' && (act('mcp:org-search', 'toggleMcp') as { locked?: string }).locked, 'plugin servers are switched with their plugin');
    assert.strictEqual(act('mcp:github', 'setApproval').kind === 'select' && (act('mcp:github', 'setApproval') as { setting: string }).setting, 'approvals.mcp');
    assert.ok(act('agent:migrator', 'openAgent'), 'custom agents open their file');
    assert.ok(act('agent:coder', 'copyAgent'), 'built-ins can be copied into the workspace');
  });

  test('templates are files the loaders accept', () => {
    assert.strictEqual(slugName('  My Release Helper! '), 'my-release-helper');
    const agent = parseFrontMatter(agentTemplate('release-helper'));
    assert.strictEqual(agent.meta.name, 'release-helper');
    assert.ok(String(agent.meta.description).length > 10);
    assert.strictEqual(agent.meta.tools, undefined, 'no tools line: the starter gets every tool');
    const copy = parseFrontMatter(agentTemplate('coder', { description: 'x', tools: ['read_file', 'edit_file'], systemPrompt: 'Body' }));
    assert.strictEqual(copy.meta.tools, 'read_file, edit_file');
    assert.strictEqual(copy.body.trim(), 'Body');
    assert.strictEqual(parseFrontMatter(skillTemplate('ship-it')).meta.name, 'ship-it');
  });

  test('the webview, its stylesheet and the command are wired and packaged', () => {
    const root = path.resolve(__dirname, '../..');
    const read = (f: string) => fs.readFileSync(path.join(root, f), 'utf8');
    const pkg = JSON.parse(read('package.json'));
    assert.ok(pkg.contributes.commands.some((c: { command: string }) => c.command === 'localpilot.openAgentMap'));
    assert.ok(pkg.contributes.menus['view/title'].some((m: { command: string; when: string }) => m.command === 'localpilot.openAgentMap' && /agentsView/.test(m.when)));
    const html = read('src/ui/agentMap.ts');
    assert.match(html, /script-src 'nonce-\$\{nonce\}'/);
    assert.match(html, /media\('agentMap\.js'\)/);
    assert.match(html, /media\('agentMap\.css'\)/);
    const js = read('media/agentMap.js');
    assert.doesNotMatch(js, /\bon(click|change)=["']/, 'no inline handlers (CSP)');
    assert.match(js, /role', 'radio'/);
    const css = read('media/agentMap.css');
    assert.match(css, /prefers-reduced-motion/);
    assert.doesNotMatch(read('.vscodeignore'), /^media\/(\*\*\/?)?(\*|agentMap\.\w+)?$/m, 'media/agentMap.* ships in the VSIX');
  });
});
