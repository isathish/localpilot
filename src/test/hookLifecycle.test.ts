import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { AgentRunner } from '../agent/agentLoop';
import { HookRunInfo, HookRunner } from '../agent/hooks';
import { loadProjectSettings } from '../agent/settings';
import { SkillManager } from '../agent/skills';
import { WorkspaceContext } from '../context/workspaceContext';
import { ProviderRegistry } from '../providers/registry';
import { ToolRegistry } from '../tools/registry';
import { AgentEvent, ChatMessage, LLMProvider, ModelInfo, Session, StreamEvent, Tool } from '../types';
import { createItem, listCustomizations, setItemEnabled } from '../ui/customize';

const log = vscode.window.createOutputChannel('LocalPilot hook lifecycle test', { log: true });
const quiet = { info() {}, warn() {}, debug() {} };
const model: ModelInfo = { id: 'fake/m', providerId: 'fake', modelId: 'm', name: 'm', contextWindow: 16384, maxOutputTokens: 1024, supportsTools: true, supportsVision: false };
const unix = process.platform !== 'win32';

function provider(chat: () => AsyncIterable<StreamEvent>): LLMProvider {
  return { id: 'fake', type: 'openai', displayName: 'Fake', baseUrl: 'http://127.0.0.1:9', listModels: async () => [model], complete: async () => '', healthCheck: async () => true, chat };
}

/** Answers with text right away. */
const answering = () =>
  provider(async function* () {
    yield { type: 'text', text: 'Done.' };
    yield { type: 'done', finishReason: 'stop' };
  });

/** A workspace whose `.localpilot/hooks` holds `scripts` (name → shell body); each script is executable. */
async function workspaceWith(scripts: Record<string, string>): Promise<{ root: string; hooks: HookRunner }> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'lp-hl-home-'));
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lp-hl-root-'));
  const dir = path.join(root, '.localpilot', 'hooks');
  await fs.mkdir(dir, { recursive: true });
  for (const [name, body] of Object.entries(scripts)) {
    await fs.writeFile(path.join(dir, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  }
  const settings = await loadProjectSettings([root], { home });
  return { root, hooks: new HookRunner(() => settings, quiet) };
}

function runnerWith(p: LLMProvider, hooks: HookRunner, tools: Tool[] = []): { runner: AgentRunner; dispose: () => void } {
  const registry = new ToolRegistry();
  registry.registerAll(tools);
  const providers = new ProviderRegistry(log);
  Object.assign(providers, { route: async () => ({ provider: p, model }), residentModels: async () => new Set<string>(), markUnresponsive: () => undefined });
  const runner = new AgentRunner(providers, registry, new SkillManager(log), new WorkspaceContext(log), log);
  runner.hooks = hooks;
  return { runner, dispose: () => (providers.dispose(), registry.dispose()) };
}

let seq = 0;
function session(messages: ChatMessage[] = []): Session {
  const now = Date.now();
  return { id: `hl-${now.toString(36)}-${++seq}`, title: 'test', createdAt: now, updatedAt: now, model: model.id, mode: 'agent', messageCount: messages.length, messages, contextTokens: 0, compactions: 0, attachments: [], todos: [], workingSet: [] };
}

const lines = async (file: string) => (await fs.readFile(file, 'utf8').catch(() => '')).split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
const exists = (file: string) => fs.stat(file).then(() => true, () => false);

suite('Hooks in the agent loop: session start and resume, cancel and error, hook rows', function () {
  this.timeout(30_000);
  suiteSetup(function () {
    if (!unix) {
      this.skip();
    }
  });

  test('a TaskResume script runs once on the first prompt of a reopened chat; TaskStart on a new one', async () => {
    const { root, hooks } = await workspaceWith({
      'TaskResume.sh': 'cat >> "$LOCALPILOT_PROJECT_DIR/resume.jsonl"; echo >> "$LOCALPILOT_PROJECT_DIR/resume.jsonl"',
      'TaskStart.sh': 'cat >> "$LOCALPILOT_PROJECT_DIR/start.jsonl"; echo >> "$LOCALPILOT_PROJECT_DIR/start.jsonl"',
    });
    const { runner, dispose } = runnerWith(answering(), hooks);
    const run = (s: Session, text: string) => runner.run({ session: s, userMessage: { role: 'user', content: text }, emit: () => undefined, signal: new AbortController().signal, requestApproval: async () => true, unattended: true, workspaceRoot: root, maxIterations: 2 });
    try {
      const reopened = session([
        { role: 'user', content: 'Earlier question', meta: { timestamp: Date.now() - 60_000 } },
        { role: 'assistant', content: 'Earlier answer', meta: { timestamp: Date.now() - 59_000 } },
      ]);
      await run(reopened, 'Go on.');
      await run(reopened, 'And again.');
      const resumed = await lines(path.join(root, 'resume.jsonl'));
      assert.strictEqual(resumed.length, 1, 'resume fires once per reopened chat');
      assert.strictEqual(resumed[0].hook_event_name, 'SessionStart');
      assert.strictEqual(resumed[0].source, 'resume');
      assert.strictEqual(resumed[0].session_id, reopened.id);
      assert.deepStrictEqual(await lines(path.join(root, 'start.jsonl')), [], 'TaskStart is for new chats only');

      const fresh = session();
      await run(fresh, 'Hello.');
      await run(fresh, 'Next.');
      const started = await lines(path.join(root, 'start.jsonl'));
      assert.strictEqual(started.length, 1);
      assert.strictEqual(started[0].source, 'startup');
      assert.strictEqual((await lines(path.join(root, 'resume.jsonl'))).length, 1, 'a chat started in this runner is not resumed on its second prompt');
    } finally {
      dispose();
    }
  });

  test('a stopped top-level run fires TaskCancel; a scratch run does not', async () => {
    const { root, hooks } = await workspaceWith({ 'TaskCancel.sh': 'cat > "$LOCALPILOT_PROJECT_DIR/cancel.json"' });
    let ac = new AbortController();
    const stopping = provider(async function* () {
      ac.abort();
      yield { type: 'text', text: '' };
      throw Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
    });
    const { runner, dispose } = runnerWith(stopping, hooks);
    const events: AgentEvent[] = [];
    const run = (scratch: boolean) =>
      runner.run({ session: session(), userMessage: { role: 'user', content: 'Work.' }, emit: (e) => events.push(e), signal: ac.signal, requestApproval: async () => true, unattended: true, workspaceRoot: root, scratch, maxIterations: 2 }).catch(() => '');
    try {
      await run(true);
      await runner.hooksSettled();
      assert.ok(!(await exists(path.join(root, 'cancel.json'))), 'no TaskCancel for a scratch run');

      ac = new AbortController();
      await run(false);
      assert.ok(await runner.hooksSettled(), 'the hook was still running when the run returned');
      const input = JSON.parse(await fs.readFile(path.join(root, 'cancel.json'), 'utf8')) as Record<string, unknown>;
      assert.strictEqual(input.hook_event_name, 'TaskCancel');
      const rows = events.filter((e) => e.type === 'hook').map((e) => e.payload as HookRunInfo);
      assert.deepStrictEqual(rows.map((r) => [r.event, r.status]), [['TaskCancel', 'running'], ['TaskCancel', 'ok']]);
    } finally {
      dispose();
    }
  });

  test('a failed run fires TaskError with the error in its input', async () => {
    const { root, hooks } = await workspaceWith({ 'TaskError.sh': 'cat > "$LOCALPILOT_PROJECT_DIR/error.json"' });
    const failing = provider(async function* () {
      yield { type: 'text', text: '' };
      throw new Error('HTTP 400 from fake: model exploded');
    });
    const { runner, dispose } = runnerWith(failing, hooks);
    try {
      await assert.rejects(runner.run({ session: session(), userMessage: { role: 'user', content: 'Work.' }, emit: () => undefined, signal: new AbortController().signal, requestApproval: async () => true, unattended: true, workspaceRoot: root, maxModelRetries: 0, maxIterations: 2 }));
      await runner.hooksSettled();
      const input = JSON.parse(await fs.readFile(path.join(root, 'error.json'), 'utf8')) as Record<string, unknown>;
      assert.strictEqual(input.hook_event_name, 'TaskError');
      assert.match(String(input.error), /model exploded/);
    } finally {
      dispose();
    }
  });

  test('PreToolUse and Stop hooks emit a hook event pair: running, then the result with its time', async () => {
    const { root, hooks } = await workspaceWith({ 'PreToolUse.sh': 'cat > /dev/null; exit 0', 'Stop.sh': 'cat > /dev/null; exit 0' });
    let step = 0;
    const calling = provider(async function* () {
      if (step++ === 0) {
        yield { type: 'tool_call', call: { id: 'c1', name: 'noop_tool', arguments: '{}' } };
        yield { type: 'done', finishReason: 'tool_calls' };
        return;
      }
      yield { type: 'text', text: 'Finished.' };
      yield { type: 'done', finishReason: 'stop' };
    });
    const ran: string[] = [];
    const noop: Tool = { definition: { name: 'noop_tool', description: 'does nothing', parameters: { type: 'object', properties: {} } }, async execute() { ran.push('noop'); return { content: 'ok' }; } };
    const { runner, dispose } = runnerWith(calling, hooks, [noop]);
    const events: AgentEvent[] = [];
    try {
      await runner.run({ session: session(), userMessage: { role: 'user', content: 'Call noop_tool.' }, emit: (e) => events.push(e), signal: new AbortController().signal, requestApproval: async () => true, unattended: true, workspaceRoot: root, maxIterations: 4 });
      assert.deepStrictEqual(ran, ['noop']);
      const rows = events.filter((e) => e.type === 'hook').map((e) => e.payload as HookRunInfo);
      for (const event of ['PreToolUse', 'Stop']) {
        const pair = rows.filter((r) => r.event === event);
        assert.deepStrictEqual(pair.map((r) => r.status), ['running', 'ok'], `${event}: ${JSON.stringify(rows)}`);
        assert.strictEqual(pair[0].id, pair[1].id);
        assert.strictEqual(pair[0].name, `${event}.sh`);
        assert.ok(typeof pair[1].ms === 'number');
      }
      assert.strictEqual(rows.find((r) => r.event === 'PreToolUse')?.tool, 'noop_tool');
    } finally {
      dispose();
    }
  });
});

suite('Customize: a hook named .disabled never runs; the switch renames it on Windows', () => {
  test('a .disabled script is listed off and not run; switching it on renames it', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'lp-hl-home-'));
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lp-hl-root-'));
    const off = path.join(root, '.localpilot', 'hooks', 'Stop.ps1.disabled');
    await fs.mkdir(path.dirname(off), { recursive: true });
    await fs.writeFile(off, 'exit 0\n', { mode: 0o755 });
    const listed = (await listCustomizations([root], home)).hooks.find((h) => h.file === off);
    assert.ok(listed?.disabled && !listed.notRun && listed.description === 'Stop hook script', JSON.stringify(listed));
    assert.ok(!(await loadProjectSettings([root], { home })).hooks.Stop, 'a .disabled script does not run');
    await setItemEnabled('hook', off, true, [root], home, [], 'win32');
    const on = off.slice(0, -'.disabled'.length);
    assert.ok(await exists(on) && !(await exists(off)));
    assert.ok((await loadProjectSettings([root], { home })).hooks.Stop?.length);
    await setItemEnabled('hook', on, false, [root], home, [], 'win32');
    assert.ok(await exists(off) && !(await exists(on)));
  });

  test('on Windows a new hook script is created as <Event>.ps1.disabled, and found again on the next create', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'lp-hl-home-'));
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lp-hl-root-'));
    const r = await createItem('hook', 'Notification.ps1', 'workspace', [root], home, 'win32');
    assert.ok(r.created && r.file.endsWith(`${path.sep}Notification.ps1.disabled`), r.file);
    assert.match(await fs.readFile(r.file, 'utf8'), /Created switched off/);
    const again = await createItem('hook', 'Notification.ps1', 'workspace', [root], home, 'linux');
    assert.deepStrictEqual(again, { file: r.file, created: false });
  });
});
