import * as assert from 'assert';
import * as vscode from 'vscode';
import { AgentRunner } from '../agent/agentLoop';
import { SkillManager } from '../agent/skills';
import { WorkspaceContext } from '../context/workspaceContext';
import { ProviderRegistry } from '../providers/registry';
import { ToolRegistry } from '../tools/registry';
import { AgentEvent, ApprovalDecision, ChatRequestOptions, LLMProvider, ModelInfo, Session, StreamEvent, Tool } from '../types';

const log = vscode.window.createOutputChannel('LocalPilot denial test', { log: true });
const model: ModelInfo = { id: 'fake/m', providerId: 'fake', modelId: 'm', name: 'm', contextWindow: 16384, maxOutputTokens: 1024, supportsTools: true, supportsVision: false };

/** A provider that keeps calling remove_thing (with new arguments each step, so no identical-call refusal applies). */
function retryingProvider(steps: number): LLMProvider {
  let step = 0;
  return {
    id: 'fake',
    type: 'openai',
    displayName: 'Fake',
    baseUrl: 'http://127.0.0.1:9',
    listModels: async () => [model],
    complete: async () => '',
    healthCheck: async () => true,
    async *chat(_opts: ChatRequestOptions): AsyncIterable<StreamEvent> {
      if (step < steps) {
        step++;
        yield { type: 'tool_call', call: { id: `call${step}`, name: 'remove_thing', arguments: JSON.stringify({ n: step }) } };
        yield { type: 'done', finishReason: 'tool_calls' };
        return;
      }
      yield { type: 'text', text: 'Giving up.' };
      yield { type: 'done', finishReason: 'stop' };
    },
  };
}

const removeThing: Tool = {
  approvalKind: 'delete',
  definition: { name: 'remove_thing', description: 'remove_thing', parameters: { type: 'object', properties: { n: { type: 'number' } } } },
  async execute(_args, ctx) {
    if (!(await ctx.requestApproval('Remove thing', '', 'delete'))) {
      return { content: 'User declined the deletion.', isError: true };
    }
    return { content: 'done' };
  },
};

async function run(requestApproval: () => Promise<boolean | ApprovalDecision>): Promise<AgentEvent[]> {
  const registry = new ToolRegistry();
  registry.registerAll([removeThing]);
  const providers = new ProviderRegistry(log);
  const provider = retryingProvider(6);
  Object.assign(providers, { route: async () => ({ provider, model }), residentModels: async () => new Set<string>(), markUnresponsive: () => undefined });
  const runner = new AgentRunner(providers, registry, new SkillManager(log), new WorkspaceContext(log), log);
  const now = Date.now();
  const session: Session = { id: `d-${now.toString(36)}`, title: 'test', createdAt: now, updatedAt: now, model: model.id, mode: 'agent', messageCount: 0, messages: [], contextTokens: 0, compactions: 0, attachments: [], todos: [], workingSet: [] };
  const events: AgentEvent[] = [];
  try {
    await runner.run({ session, userMessage: { role: 'user', content: 'Remove the thing.' }, emit: (e) => events.push(e), signal: new AbortController().signal, requestApproval, unattended: true, scratch: true, maxIterations: 8 });
  } finally {
    providers.dispose();
    registry.dispose();
  }
  return events;
}

const toolEnds = (events: AgentEvent[]) => events.filter((e) => e.type === 'tool_end').map((e) => e.payload as { isError?: boolean; denied?: boolean });
const mistakeLimit = (events: AgentEvent[]) => events.some((e) => e.type === 'error' && (e.payload as { kind?: string } | undefined)?.kind === 'mistake_limit');

suite('Approvals: only a person’s answer is a denial', () => {
  const cfg = () => vscode.workspace.getConfiguration('localpilot');
  const keys = ['approvals.delete', 'autoMode.enabled', 'maxConsecutiveMistakes'];
  const saved: Record<string, unknown> = {};
  suiteSetup(async () => {
    keys.forEach((k) => (saved[k] = cfg().inspect(k)?.globalValue));
    await cfg().update('autoMode.enabled', false, vscode.ConfigurationTarget.Global);
    await cfg().update('maxConsecutiveMistakes', 2, vscode.ConfigurationTarget.Global);
  });
  suiteTeardown(async () => {
    for (const k of keys) {
      await cfg().update(k, saved[k], vscode.ConfigurationTarget.Global);
    }
  });

  test('a `never` setting is a failed call, not a denial, and counts toward the mistake limit', async function () {
    this.timeout(20_000);
    await cfg().update('approvals.delete', 'never', vscode.ConfigurationTarget.Global);
    let asked = 0;
    const events = await run(async () => (asked++, true));
    const ends = toolEnds(events);
    assert.strictEqual(asked, 0, 'nobody was asked');
    assert.ok(ends.length >= 1 && ends.every((e) => e.isError && !e.denied), JSON.stringify(ends));
    assert.ok(mistakeLimit(events), 'the run stopped at the mistake limit');
    assert.strictEqual(ends.length, 2, 'it stopped after maxConsecutiveMistakes failed steps');
  });

  test('a non-interactive refusal (bare false) is not a denial either', async function () {
    this.timeout(20_000);
    await cfg().update('approvals.delete', 'ask', vscode.ConfigurationTarget.Global);
    const events = await run(async () => false);
    const ends = toolEnds(events);
    assert.ok(ends.length >= 1 && ends.every((e) => e.isError && !e.denied), JSON.stringify(ends));
    assert.ok(mistakeLimit(events));
  });

  test('a person’s denial is marked denied and does not count as a mistake', async function () {
    this.timeout(20_000);
    await cfg().update('approvals.delete', 'ask', vscode.ConfigurationTarget.Global);
    const events = await run(async () => ({ ok: false }));
    const ends = toolEnds(events);
    assert.ok(ends.length > 2 && ends.every((e) => e.isError && e.denied), JSON.stringify(ends));
    assert.ok(!mistakeLimit(events));
  });
});
