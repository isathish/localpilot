import * as assert from 'assert';
import * as vscode from 'vscode';
import { AgentRunner } from '../agent/agentLoop';
import { deniedResultText, effectiveApproval, isDenialText, parseApprovalAnswer, toDecision } from '../agent/approvalLevel';
import { SkillManager } from '../agent/skills';
import { WorkspaceContext } from '../context/workspaceContext';
import { ProviderRegistry } from '../providers/registry';
import { ToolRegistry } from '../tools/registry';
import { ApprovalDecision, ChatMessage, ChatRequestOptions, LLMProvider, ModelInfo, Session, StreamEvent, Tool } from '../types';
import { autoApproveState, autoApproveSummary } from '../ui/autoApproveBar';
import { shouldNotify, shouldRingBell } from '../ui/notifyPolicy';

const log = vscode.window.createOutputChannel('LocalPilot approvals test', { log: true });
const model: ModelInfo = { id: 'fake/m', providerId: 'fake', modelId: 'm', name: 'm', contextWindow: 16384, maxOutputTokens: 1024, supportsTools: true, supportsVision: false };

/** A provider that makes the scripted tool calls one step at a time, then answers in text; it keeps every request. */
function scriptedProvider(calls: { name: string; args?: Record<string, unknown> }[], requests: ChatMessage[][]): LLMProvider {
  let step = 0;
  return {
    id: 'fake',
    type: 'openai',
    displayName: 'Fake',
    baseUrl: 'http://127.0.0.1:9',
    listModels: async () => [model],
    complete: async () => '',
    healthCheck: async () => true,
    async *chat(opts: ChatRequestOptions): AsyncIterable<StreamEvent> {
      requests.push(opts.messages.map((m) => ({ ...m })));
      const c = calls[step++];
      if (c) {
        yield { type: 'tool_call', call: { id: `call${step}`, name: c.name, arguments: JSON.stringify(c.args ?? {}) } };
        yield { type: 'done', finishReason: 'tool_calls' };
        return;
      }
      yield { type: 'text', text: 'Understood, I will do that instead.' };
      yield { type: 'done', finishReason: 'stop' };
    },
  };
}

function runnerWith(provider: LLMProvider, tools: Tool[]): { runner: AgentRunner; dispose: () => void } {
  const registry = new ToolRegistry();
  registry.registerAll(tools);
  const providers = new ProviderRegistry(log);
  Object.assign(providers, {
    route: async () => ({ provider, model }),
    residentModels: async () => new Set<string>(),
    markUnresponsive: () => undefined,
  });
  const runner = new AgentRunner(providers, registry, new SkillManager(log), new WorkspaceContext(log), log);
  return { runner, dispose: () => (providers.dispose(), registry.dispose()) };
}

function session(): Session {
  const now = Date.now();
  return { id: `t-${now.toString(36)}`, title: 'test', createdAt: now, updatedAt: now, model: model.id, mode: 'agent', messageCount: 0, messages: [], contextTokens: 0, compactions: 0, attachments: [], todos: [], workingSet: [] };
}

/** A tool that asks for approval of `kind` and refuses with its own fixed text when denied. */
function asking(name: string, kind: NonNullable<Tool['approvalKind']>, ran: string[]): Tool {
  return {
    approvalKind: kind,
    definition: { name, description: name, parameters: { type: 'object', properties: {} } },
    async execute(_args, ctx) {
      if (!(await ctx.requestApproval(`Do ${name}`, '', kind))) {
        return { content: 'User declined the deletion.', isError: true };
      }
      ran.push(name);
      return { content: 'done' };
    },
  };
}

suite('Approvals: deny with feedback, live auto-approve, safe commands, notifications', () => {
  const cfg = () => vscode.workspace.getConfiguration('localpilot');
  const keys = ['approvals.delete', 'approvals.terminal', 'autoMode.enabled', 'approvals.dangerousAlwaysAsk'];
  const saved: Record<string, unknown> = {};
  suiteSetup(() => keys.forEach((k) => (saved[k] = cfg().inspect(k)?.globalValue)));
  suiteTeardown(async () => {
    for (const k of keys) {
      await cfg().update(k, saved[k], vscode.ConfigurationTarget.Global);
    }
  });

  test('a denial reason reaches the model in place of the fixed refusal', async function () {
    this.timeout(20_000);
    await cfg().update('approvals.delete', 'ask', vscode.ConfigurationTarget.Global);
    await cfg().update('autoMode.enabled', false, vscode.ConfigurationTarget.Global);
    const requests: ChatMessage[][] = [];
    const ran: string[] = [];
    const { runner, dispose } = runnerWith(scriptedProvider([{ name: 'remove_thing' }], requests), [asking('remove_thing', 'delete', ran)]);
    const events: { type: string; payload?: unknown }[] = [];
    try {
      await runner.run({
        session: session(),
        userMessage: { role: 'user', content: 'Delete src/a.ts with remove_thing.' },
        emit: (e) => events.push(e),
        signal: new AbortController().signal,
        requestApproval: async (): Promise<ApprovalDecision> => ({ ok: false, feedback: 'edit src/b.ts instead' }),
        unattended: true,
        scratch: true,
        maxIterations: 3,
      });
      assert.deepStrictEqual(ran, [], 'the tool did not run');
      assert.ok(requests.length >= 2, 'the model was called again after the denial');
      const tool = requests[1].find((m) => m.role === 'tool' || /<tool_result/.test(m.content));
      assert.ok(tool && /The user denied this action: edit src\/b\.ts instead/.test(tool.content), JSON.stringify(requests[1].slice(-2)));
      const end = events.find((e) => e.type === 'tool_end')?.payload as { denied?: boolean; isError?: boolean } | undefined;
      assert.ok(end?.isError && end.denied, 'the step is marked denied for the chat');
    } finally {
      dispose();
    }
  });

  test('switching Commands to Always during a run auto-approves the next command of that run', async function () {
    this.timeout(20_000);
    await cfg().update('approvals.terminal', 'ask', vscode.ConfigurationTarget.Global);
    await cfg().update('autoMode.enabled', false, vscode.ConfigurationTarget.Global);
    const requests: ChatMessage[][] = [];
    const ran: string[] = [];
    let asked = 0;
    const { runner, dispose } = runnerWith(scriptedProvider([{ name: 'cmd_one' }, { name: 'cmd_two' }], requests), [asking('cmd_one', 'terminal', ran), asking('cmd_two', 'terminal', ran)]);
    try {
      await runner.run({
        session: session(),
        userMessage: { role: 'user', content: 'Run cmd_one, then cmd_two.' },
        emit: () => undefined,
        signal: new AbortController().signal,
        requestApproval: async () => {
          asked++;
          await cfg().update('approvals.terminal', 'always', vscode.ConfigurationTarget.Global);
          return true;
        },
        unattended: true,
        scratch: true,
        maxIterations: 4,
      });
      assert.deepStrictEqual(ran, ['cmd_one', 'cmd_two']);
      assert.strictEqual(asked, 1, 'the second command ran without a prompt');
    } finally {
      dispose();
    }
  });

  test('decisions, result text and the CLI answer', () => {
    assert.deepStrictEqual(toDecision(true), { ok: true });
    assert.deepStrictEqual(toDecision(false), { ok: false });
    assert.deepStrictEqual(toDecision({ ok: false, feedback: '  use b.ts ' }), { ok: false, feedback: 'use b.ts' });
    assert.deepStrictEqual(toDecision({ ok: true, feedback: 'ignored' }), { ok: true });
    assert.strictEqual(deniedResultText('User declined the edit.', ''), 'User declined the edit.');
    assert.ok(deniedResultText('User declined the edit.', 'not now').startsWith('The user denied this action: not now'));
    assert.ok(isDenialText('The user denied this action: x') && isDenialText('User declined the fetch.') && !isDenialText('Error: x'));
    assert.deepStrictEqual(parseApprovalAnswer('n edit src/b.ts instead'), { choice: 'no', feedback: 'edit src/b.ts instead' });
    assert.deepStrictEqual(parseApprovalAnswer('No, Use B'), { choice: 'no', feedback: 'Use B' });
    assert.deepStrictEqual(parseApprovalAnswer('n'), { choice: 'no' });
    assert.deepStrictEqual(parseApprovalAnswer('Y'), { choice: 'yes' });
    assert.deepStrictEqual(parseApprovalAnswer('a'), { choice: 'always' });
    assert.deepStrictEqual(parseApprovalAnswer('maybe'), { choice: 'no' });
  });

  test('safe level, destructive commands and requires_approval', () => {
    assert.deepStrictEqual(effectiveApproval('safe', { safeCommand: true }, true), { mode: 'always', mustAsk: false });
    assert.deepStrictEqual(effectiveApproval('safe', { safeCommand: false }, true), { mode: 'ask', mustAsk: false });
    assert.deepStrictEqual(effectiveApproval('always', { dangerous: true }, true), { mode: 'ask', mustAsk: true });
    assert.deepStrictEqual(effectiveApproval('always', { dangerous: true }, false), { mode: 'always', mustAsk: false });
    assert.deepStrictEqual(effectiveApproval('always', { confirm: true }, false), { mode: 'ask', mustAsk: true });
    assert.deepStrictEqual(effectiveApproval('safe', { safeCommand: true, confirm: true }, true), { mode: 'ask', mustAsk: true });
    assert.deepStrictEqual(effectiveApproval('never', { confirm: true }, true), { mode: 'never', mustAsk: false });
    assert.deepStrictEqual(effectiveApproval('always', undefined, true), { mode: 'always', mustAsk: false });
  });

  test('the auto-approve bar names what runs without asking and reads the settings', async () => {
    assert.strictEqual(autoApproveSummary([{ key: 'write', value: 'always' }, { key: 'terminal', value: 'ask' }, { key: 'network', value: 'always' }, { key: 'autoMode', value: 'off' }]), 'Edit, Web');
    assert.strictEqual(autoApproveSummary([{ key: 'terminal', value: 'safe' }, { key: 'autoMode', value: 'on' }]), 'Safe commands, Auto Mode');
    assert.strictEqual(autoApproveSummary([{ key: 'write', value: 'ask' }]), 'none');
    await cfg().update('approvals.terminal', 'safe', vscode.ConfigurationTarget.Global);
    const s = autoApproveState(log);
    assert.deepStrictEqual(s.items.map((i) => i.key), ['write', 'delete', 'terminal', 'network', 'mcp', 'autoMode']);
    assert.strictEqual(s.items.find((i) => i.key === 'terminal')?.value, 'safe');
    assert.ok(s.items.find((i) => i.key === 'terminal')?.values.includes('safe'));
  });

  test('notifications fire when the chat is hidden or the window unfocused; the CLI bell after 10 s on a TTY', () => {
    assert.strictEqual(shouldNotify('whenHidden', true, true), false);
    assert.strictEqual(shouldNotify('whenHidden', false, true), true);
    assert.strictEqual(shouldNotify('whenHidden', true, false), true);
    assert.strictEqual(shouldNotify('always', true, true), true);
    assert.strictEqual(shouldNotify('off', false, false), false);
    assert.strictEqual(shouldRingBell('whenHidden', true, 12_000), true);
    assert.strictEqual(shouldRingBell('whenHidden', true, 5_000), false);
    assert.strictEqual(shouldRingBell('whenHidden', false, 60_000), false);
    assert.strictEqual(shouldRingBell('off', true, 60_000), false);
  });

  test('settings: safe, dangerousAlwaysAsk and notifications are contributed', () => {
    const props = vscode.extensions.getExtension('localpilot.localpilot-agent')!.packageJSON.contributes.configuration.properties;
    assert.deepStrictEqual(props['localpilot.approvals.terminal'].enum, ['always', 'safe', 'ask', 'never']);
    assert.strictEqual(props['localpilot.approvals.dangerousAlwaysAsk'].default, true);
    assert.strictEqual(props['localpilot.approvals.dangerousAlwaysAsk'].scope, 'application');
    assert.strictEqual(props['localpilot.notifications'].default, 'whenHidden');
  });
});
