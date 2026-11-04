import * as assert from 'assert';
import * as vscode from 'vscode';
import { getConfig } from '../config';
import { AgentRunner } from '../agent/agentLoop';
import { buildSystemPrompt, languageInstruction } from '../agent/prompts';
import { SkillManager } from '../agent/skills';
import { WorkspaceContext } from '../context/workspaceContext';
import { ProviderRegistry } from '../providers/registry';
import { ToolRegistry } from '../tools/registry';
import { ModelInfo, Tool } from '../types';

const log = vscode.window.createOutputChannel('LocalPilot test', { log: true });
const model: ModelInfo = { id: 'p/m', providerId: 'p', modelId: 'm', name: 'm', contextWindow: 8192, maxOutputTokens: 1024, supportsTools: true, supportsVision: false };

function stub(name: string, approvalKind?: Tool['approvalKind']): Tool {
  return { approvalKind, definition: { name, description: name, parameters: { type: 'object', properties: {} } }, async execute() { return { content: 'ok' }; } };
}

suite('Agent settings: web access, response language, compaction strategy', () => {
  const cfg = () => vscode.workspace.getConfiguration('localpilot');
  const keys = ['webSearch.enabled', 'preferredLanguage', 'compaction.strategy'];
  const saved: Record<string, unknown> = {};
  suiteSetup(() => keys.forEach((k) => (saved[k] = cfg().inspect(k)?.globalValue)));
  suiteTeardown(async () => {
    for (const k of keys) {
      await cfg().update(k, saved[k], vscode.ConfigurationTarget.Global);
    }
  });

  test('defaults: agentic compaction, web on, no language instruction', async () => {
    for (const k of keys) {
      await cfg().update(k, undefined, vscode.ConfigurationTarget.Global);
    }
    const c = getConfig();
    assert.strictEqual(c.compactionStrategy, 'agentic');
    assert.strictEqual(c.webEnabled, true);
    assert.strictEqual(c.preferredLanguage, 'auto');
    await cfg().update('compaction.strategy', 'basic', vscode.ConfigurationTarget.Global);
    assert.strictEqual(getConfig().compactionStrategy, 'basic');
  });

  test('webSearch.enabled = false removes web and browser tools from the definitions; Plan keeps run_command only for reading', async () => {
    const tools = new ToolRegistry();
    tools.registerAll([stub('read_file'), stub('web_search', 'network'), stub('web_fetch', 'network'), stub('browser_screenshot', 'network'), stub('run_command', 'terminal'), stub('write_file', 'write')]);
    const providers = new ProviderRegistry(log);
    const runner = new AgentRunner(providers, tools, new SkillManager(log), new WorkspaceContext(log), log);
    const select = (mode: string) => (runner as unknown as { selectTools(mode: string): Tool[] }).selectTools(mode).map((t) => t.definition.name);
    try {
      await cfg().update('webSearch.enabled', true, vscode.ConfigurationTarget.Global);
      assert.ok(select('agent').includes('web_search') && select('agent').includes('browser_screenshot'));
      await cfg().update('webSearch.enabled', false, vscode.ConfigurationTarget.Global);
      const names = select('agent');
      assert.ok(!names.some((n) => /^(web_|browser_)/.test(n)), names.join());
      assert.ok(names.includes('read_file') && names.includes('run_command'));
      const plan = select('plan');
      assert.ok(plan.includes('run_command') && !plan.includes('write_file'), plan.join());
    } finally {
      providers.dispose();
      tools.dispose();
    }
  });

  test('preferredLanguage adds one instruction line, and none for auto', async () => {
    assert.strictEqual(languageInstruction('auto'), '');
    assert.strictEqual(languageInstruction(undefined), '');
    assert.strictEqual(languageInstruction('Japanese'), 'Always respond in Japanese. Keep code, identifiers and commands in their original form.');
    const base = { mode: 'ask' as const, model, toolsEnabled: true, skills: new SkillManager(log), workspace: new WorkspaceContext(log), project: false };
    const withLang = await buildSystemPrompt({ ...base, preferredLanguage: 'German' });
    const without = await buildSystemPrompt({ ...base, preferredLanguage: 'auto' });
    assert.ok(withLang.includes('Always respond in German.'));
    assert.ok(!without.includes('Always respond in'));
    const offline = await buildSystemPrompt({ ...base, canSearchWeb: false });
    assert.ok(/Web access is turned off/.test(offline) && !/call web_search/.test(offline));
  });
});
