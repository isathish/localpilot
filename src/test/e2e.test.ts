import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as http from 'http';
import * as path from 'path';
import * as vscode from 'vscode';
import type { LocalPilotApi } from '../extension';

/**
 * Real end-to-end runs against a local model server (Ollama on :11434).
 * Skipped automatically when no server / tool-capable model is available, so CI stays green.
 * Set LOCALPILOT_E2E_MODEL to force a specific model id (e.g. ollama/qwen2.5-coder:1.5b).
 */
suite('LocalPilot end-to-end (real local model)', () => {
  let api: LocalPilotApi;
  let root: string;
  let model = '';

  const ollamaUp = () =>
    new Promise<boolean>((resolve) => {
      const req = http.get('http://localhost:11434/api/version', (res) => {
        res.resume();
        resolve(res.statusCode === 200);
      });
      req.on('error', () => resolve(false));
      req.setTimeout(1500, () => {
        req.destroy();
        resolve(false);
      });
    });

  const waitForRun = (id: string, timeoutMs: number) =>
    new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        sub.dispose();
        reject(new Error(`session ${id} still running after ${timeoutMs} ms`));
      }, timeoutMs);
      const check = () => {
        if (!api.runningSessionIds.includes(id)) {
          clearTimeout(timer);
          sub.dispose();
          resolve();
        }
      };
      const sub = api.onDidChangeRuns(check);
      check();
    });

  const transcript = (id: string) =>
    JSON.stringify(
      (api.getSession(id)?.messages ?? []).map((m) => ({ role: m.role, tool: m.toolName, calls: m.toolCalls?.map((c) => `${c.name}(${c.arguments})`), content: m.content.slice(0, 300) })),
      null,
      1
    );

  suiteSetup(async function () {
    this.timeout(60_000);
    const ext = vscode.extensions.getExtension<LocalPilotApi>('localpilot.localpilot-agent');
    assert.ok(ext);
    api = await ext.activate();
    root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
    assert.ok(root, 'tests need a workspace folder (see .vscode-test.mjs)');

    if (!(await ollamaUp())) {
      this.skip();
    }
    const models = await api.listModels();
    const forced = process.env.LOCALPILOT_E2E_MODEL;
    // Prefer the largest tool-capable Ollama model (parameter count parsed from the tag, e.g. ":7b").
    const size = (id: string) => Number(/(\d+(?:\.\d+)?)b\b/i.exec(id)?.[1] ?? 0);
    const candidates = models.filter((m) => m.providerId === 'ollama').sort((a, b) => Number(b.supportsTools) - Number(a.supportsTools) || size(b.id) - size(a.id));
    const pick = forced ? models.find((m) => m.id === forced) : candidates[0];
    if (!pick) {
      this.skip();
    }
    model = pick!.id;
    const cfg = vscode.workspace.getConfiguration('localpilot');
    await cfg.update('defaultModel', model, vscode.ConfigurationTarget.Global);
    await cfg.update('approvals.write', 'always', vscode.ConfigurationTarget.Global);
    await cfg.update('showWelcomeOnStartup', false, vscode.ConfigurationTarget.Global);
  });

  test('api exposes the real extension version', () => {
    const ext = vscode.extensions.getExtension('localpilot.localpilot-agent')!;
    assert.strictEqual(api.version, ext.packageJSON.version);
    assert.match(api.version, /^\d+\.\d+\.\d+/);
  });

  test('agent executes a real tool call: the model writes a file into the workspace', async function () {
    this.timeout(180_000);
    const file = 'e2e-hello.txt';
    const id = await api.runPrompt(`Use the write_file tool to create ${file} in the workspace root containing exactly the text: hello from localpilot\nThen reply "done".`, 'agent');
    await waitForRun(id, 170_000);

    const session = api.getSession(id)!;
    assert.ok(session, 'session exists');
    const toolMsgs = session.messages.filter((m) => m.role === 'tool');
    assert.ok(toolMsgs.length >= 1, `expected at least one executed tool, transcript: ${transcript(id)}`);
    const content = await fs.readFile(path.join(root, file), 'utf8').catch((e) => {
      throw new Error(`${e.message}\ntranscript: ${transcript(id)}`);
    });
    assert.match(content, /hello from localpilot/i);
  });

  test('parallel sessions run concurrently and each completes its own task', async function () {
    this.timeout(300_000);
    const tasks = ['e2e-alpha.txt', 'e2e-beta.txt'].map((f) => `Use the write_file tool to create ${f} in the workspace root containing exactly: ${f.replace('.txt', '')}\nThen reply "done".`);
    const ids = await api.runParallel(tasks, 'agent');
    assert.strictEqual(ids.length, 2);
    // Both runs are in flight at the same time (not serialised by the extension).
    assert.ok(ids.every((id) => api.runningSessionIds.includes(id)), `running: ${api.runningSessionIds.join(',')}`);

    await Promise.all(ids.map((id) => waitForRun(id, 290_000)));
    for (const [i, f] of ['e2e-alpha.txt', 'e2e-beta.txt'].entries()) {
      const s = api.getSession(ids[i])!;
      assert.ok(s.messages.some((m) => m.role === 'tool'), `${f}: no tool executed, transcript: ${transcript(ids[i])}`);
      const txt = await fs.readFile(path.join(root, f), 'utf8').catch((e) => {
        throw new Error(`${e.message}\ntranscript: ${transcript(ids[i])}`);
      });
      assert.match(txt, new RegExp(f.replace('.txt', ''), 'i'));
    }
  });

  test('stop() aborts a running session promptly', async function () {
    this.timeout(60_000);
    const id = await api.runPrompt('Write a 2000 word essay about the history of compilers. Do not use any tools.', 'ask');
    await new Promise((r) => setTimeout(r, 1500));
    const t0 = Date.now();
    api.stop(id);
    await waitForRun(id, 15_000);
    assert.ok(Date.now() - t0 < 15_000);
    assert.ok(!api.runningSessionIds.includes(id));
  });
});
