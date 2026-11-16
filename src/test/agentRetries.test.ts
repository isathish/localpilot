import * as assert from 'assert';
import * as vscode from 'vscode';
import { AgentRunner, RESUME_NUDGE } from '../agent/agentLoop';
import { modelRetryDelayMs } from '../agent/resilience';
import { SkillManager } from '../agent/skills';
import { WorkspaceContext } from '../context/workspaceContext';
import { HttpError } from '../providers/http';
import { ProviderRegistry } from '../providers/registry';
import { ToolRegistry } from '../tools/registry';
import { AgentEvent, ChatMessage, ChatRequestOptions, LLMProvider, ModelInfo, Session, StreamEvent, Tool } from '../types';

const log = vscode.window.createOutputChannel('LocalPilot retries test', { log: true });
const model: ModelInfo = { id: 'fake/m', providerId: 'fake', modelId: 'm', name: 'm', contextWindow: 16384, maxOutputTokens: 1024, supportsTools: true, supportsVision: false };

function provider(chat: (opts: ChatRequestOptions, call: number) => AsyncIterable<StreamEvent>): LLMProvider & { calls: ChatRequestOptions[] } {
  const calls: ChatRequestOptions[] = [];
  return {
    calls,
    id: 'fake',
    type: 'openai',
    displayName: 'Fake',
    baseUrl: 'http://127.0.0.1:9',
    listModels: async () => [model],
    complete: async () => '',
    healthCheck: async () => true,
    chat(opts: ChatRequestOptions) {
      calls.push({ ...opts, messages: opts.messages.slice() });
      return chat(opts, calls.length);
    },
  };
}

async function run(p: LLMProvider, tools: Tool[] = [], maxIterations?: number): Promise<{ session: Session; events: AgentEvent[]; error?: unknown }> {
  const registry = new ToolRegistry();
  registry.registerAll(tools);
  const providers = new ProviderRegistry(log);
  Object.assign(providers, { route: async () => ({ provider: p, model }), residentModels: async () => new Set<string>(), markUnresponsive: () => undefined });
  const runner = new AgentRunner(providers, registry, new SkillManager(log), new WorkspaceContext(log), log);
  const now = Date.now();
  const session: Session = { id: `r-${now.toString(36)}-${Math.random().toString(36).slice(2, 6)}`, title: 'test', createdAt: now, updatedAt: now, model: model.id, mode: 'agent', messageCount: 0, messages: [], contextTokens: 0, compactions: 0, attachments: [], todos: [], workingSet: [] };
  const events: AgentEvent[] = [];
  let error: unknown;
  try {
    await runner.run({ session, userMessage: { role: 'user', content: 'Explain the module.' }, emit: (e) => events.push(e), signal: new AbortController().signal, requestApproval: async () => true, unattended: true, scratch: true, ...(maxIterations ? { maxIterations } : {}) });
  } catch (e) {
    error = e;
  } finally {
    providers.dispose();
    registry.dispose();
  }
  return { session, events, error };
}

const text = (m: ChatMessage | undefined) => (typeof m?.content === 'string' ? m.content : '');

suite('Agent loop: model retries and resuming a dropped answer', function () {
  this.timeout(60_000);
  const cfg = () => vscode.workspace.getConfiguration('localpilot');
  let prev: { retries: unknown; iters: unknown; healing: unknown };
  suiteSetup(async () => {
    prev = { retries: cfg().inspect('agent.modelRetries')?.globalValue, iters: cfg().inspect('maxIterations')?.globalValue, healing: cfg().inspect('healing.enabled')?.globalValue };
    // The plain retry path (self-healing's own policies are tested elsewhere).
    await cfg().update('healing.enabled', false, vscode.ConfigurationTarget.Global);
  });
  suiteTeardown(async () => {
    await cfg().update('agent.modelRetries', prev.retries, vscode.ConfigurationTarget.Global);
    await cfg().update('maxIterations', prev.iters, vscode.ConfigurationTarget.Global);
    await cfg().update('healing.enabled', prev.healing, vscode.ConfigurationTarget.Global);
  });

  test('backoff doubles from 0.8 s up to 20 s and honours Retry-After', () => {
    assert.deepStrictEqual([1, 2, 3, 4, 5, 6, 8].map((a) => modelRetryDelayMs('network', new Error('x'), a)), [800, 1600, 3200, 6400, 12800, 20000, 20000]);
    const asked = new HttpError(503, 'busy', 'x', new Headers({ 'retry-after': '7' }));
    assert.strictEqual(modelRetryDelayMs('server', asked, 1), 7000, 'the server says how long');
    assert.strictEqual(modelRetryDelayMs('server', new HttpError(503, 'busy', 'x', new Headers({ 'retry-after': '600' })), 1), 60000, 'capped at a minute');
    assert.strictEqual(modelRetryDelayMs('ratelimit', new HttpError(429, '', 'x'), 1), 5000, 'a rate limit without Retry-After waits 5 s');
    assert.strictEqual(modelRetryDelayMs('ratelimit', new HttpError(429, '', 'x'), 6), 20000);
  });

  test('a connection that drops mid-answer is resumed from the partial text, once, and the answer is joined', async () => {
    const p = provider(async function* (_o, call) {
      if (call === 1) {
        yield { type: 'text', text: 'The module parses the config, ' };
        throw new Error('fetch failed: socket hang up');
      }
      yield { type: 'text', text: 'then validates it and returns the result.' };
      yield { type: 'done', finishReason: 'stop' };
    });
    const { session, events, error } = await run(p);
    assert.strictEqual(error, undefined, String(error));
    assert.strictEqual(p.calls.length, 2);
    const second = p.calls[1].messages;
    const nudge = second[second.length - 1];
    assert.strictEqual(text(nudge), RESUME_NUDGE, 'the resume request asks to continue');
    assert.strictEqual(second[second.length - 2].role, 'assistant');
    assert.strictEqual(text(second[second.length - 2]), 'The module parses the config, ', 'the partial answer is in the transcript the model sees');
    const assistants = session.messages.filter((m) => m.role === 'assistant');
    assert.strictEqual(assistants.length, 1, 'one answer, not a partial plus a full one');
    assert.strictEqual(text(assistants[0]), 'The module parses the config, then validates it and returns the result.');
    assert.ok(!session.messages.some((m) => text(m) === RESUME_NUDGE), 'the hidden request is gone after joining');
    assert.ok(events.some((e) => e.type === 'retry' && (e.payload as { resume?: boolean }).resume), 'the chat is told it resumes');
  });

  test('a second drop while resuming is reported, the partial answer stays in the transcript', async () => {
    await cfg().update('agent.modelRetries', 1, vscode.ConfigurationTarget.Global);
    const p = provider(async function* (_o, call) {
      yield { type: 'text', text: call === 1 ? 'First part. ' : 'Second part' };
      throw new Error('fetch failed: ECONNRESET');
    });
    const { session, error } = await run(p);
    assert.ok(error, 'the run fails after the one resume');
    assert.strictEqual(p.calls.length, 2, 'resumed once, not again');
    assert.ok(session.messages.some((m) => m.role === 'assistant' && text(m) === 'First part. '), 'the partial answer is kept');
    await cfg().update('agent.modelRetries', undefined, vscode.ConfigurationTarget.Global);
  });

  test('localpilot.agent.modelRetries sets how often a failed request is retried (0 = never)', async () => {
    const failing = () =>
      provider(async function* () {
        yield* [];
        throw new Error('fetch failed: ECONNREFUSED');
      });
    await cfg().update('agent.modelRetries', 0, vscode.ConfigurationTarget.Global);
    const none = failing();
    assert.ok((await run(none)).error);
    assert.strictEqual(none.calls.length, 1, '0: no retry');
    await cfg().update('agent.modelRetries', 2, vscode.ConfigurationTarget.Global);
    const two = failing();
    assert.ok((await run(two)).error);
    assert.strictEqual(two.calls.length, 3, '2: the request plus two retries');
    await cfg().update('agent.modelRetries', undefined, vscode.ConfigurationTarget.Global);
  });

  test('localpilot.maxIterations caps the steps of a run', async () => {
    let n = 0;
    const tick: Tool = { readOnly: true, definition: { name: 'tick', description: 'tick', parameters: { type: 'object', properties: { n: { type: 'number' } } } }, execute: async () => ({ content: `tick ${++n}` }) };
    const p = provider(async function* (_o, call) {
      yield { type: 'tool_call', call: { id: `c${call}`, name: 'tick', arguments: JSON.stringify({ n: call }) } };
      yield { type: 'done', finishReason: 'tool_calls' };
    });
    await cfg().update('maxIterations', 6, vscode.ConfigurationTarget.Global);
    await run(p, [tick]);
    assert.ok(p.calls.length >= 6 && p.calls.length <= 7, `stopped at the setting (${p.calls.length} requests)`);
    assert.strictEqual(vscode.workspace.getConfiguration('localpilot').inspect('maxIterations')?.defaultValue, 40, 'declared in package.json with default 40');
    await cfg().update('maxIterations', undefined, vscode.ConfigurationTarget.Global);
  });
});

suite('Agent loop: tool calls with arguments that are not valid JSON', function () {
  this.timeout(30_000);

  test('repairable arguments run, and the transcript keeps the repaired JSON; broken ones get a clear error and are not run', async () => {
    const seen: Record<string, unknown>[] = [];
    const echo: Tool = { readOnly: true, definition: { name: 'echo_path', description: 'echo', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }, execute: async (a) => (seen.push(a), { content: `path=${String(a.path)}` }) };
    const p = provider(async function* (_o, call) {
      if (call === 1) {
        yield { type: 'tool_call', call: { id: 'c1', name: 'echo_path', arguments: "{'path': 'src/a.ts',}" } };
        yield { type: 'tool_call', call: { id: 'c2', name: 'echo_path', arguments: '{"path": "src/b.ts" "x"' } };
        yield { type: 'done', finishReason: 'tool_calls' };
        return;
      }
      yield { type: 'text', text: 'Done.' };
      yield { type: 'done', finishReason: 'stop' };
    });
    const { session } = await run(p, [echo]);
    assert.deepStrictEqual(seen, [{ path: 'src/a.ts' }], 'the repaired call ran, the broken one did not');
    const bad = session.messages.find((m) => m.role === 'tool' && m.toolCallId === 'c2');
    assert.match(text(bad), /were not valid JSON/);
    assert.doesNotMatch(text(bad), /Missing required/);
    const replay = p.calls[1].messages.find((m) => m.role === 'assistant' && m.toolCalls?.length);
    for (const c of replay?.toolCalls ?? []) {
      assert.doesNotThrow(() => JSON.parse(c.arguments), `stored arguments of ${c.id} are JSON: ${c.arguments}`);
    }
    assert.deepStrictEqual(JSON.parse(replay!.toolCalls!.find((c) => c.id === 'c1')!.arguments), { path: 'src/a.ts' });
  });
});
